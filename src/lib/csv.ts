/**
 * CSV helpers: an RFC 4180 writer with a spreadsheet formula guard, a streaming RFC 4180 reader,
 * and a browser download trigger.
 */

export interface ToCsvOptions {
  /** Prepend a UTF-8 byte-order mark (helps Excel detect UTF-8). Default false. */
  bom?: boolean;
  /**
   * Prefix text cells that a spreadsheet would evaluate (`=`, `+`, `-`, `@`, tab, CR) with an apostrophe
   * so an exported value such as `=CMD()` cannot execute when the file is opened. Default true.
   * Numbers and numeric strings (`-92.14`) are never altered.
   */
  guardFormulas?: boolean;
}

export interface ParsedCsv {
  header: string[];
  rows: string[][];
  /** Human-readable problems: ragged rows (padded/truncated), unterminated quotes, row limit. */
  issues: string[];
  /** True when `maxRows` stopped the parse before the end of the text. */
  truncated: boolean;
}

export interface ParseCsvOptions {
  /** Stop after this many data rows (header excluded) and report the truncation. */
  maxRows?: number;
}

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\n\r]/;
/** UTF-8 byte-order mark (U+FEFF), built from its code so the source stays ASCII. */
const BOM = String.fromCharCode(0xfeff);

function isNumericString(s: string): boolean {
  return s.trim() !== "" && Number.isFinite(Number(s));
}

/** Keys of all rows in first-seen order - identical to the first row's keys when every row shares them. */
function unionColumns(rows: Record<string, unknown>[]): string[] {
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        cols.push(k);
      }
    }
  }
  return cols;
}

/** Rows -> CSV text (CRLF line ends, no trailing newline, RFC 4180 quoting). Empty input -> "". */
export function toCsv(rows: Record<string, unknown>[], columns?: string[], opts: ToCsvOptions = {}): string {
  if (rows.length === 0) return "";
  const cols = columns ?? unionColumns(rows);
  const guard = opts.guardFormulas !== false;
  const esc = (v: unknown): string => {
    let s = v === null || v === undefined ? "" : String(v);
    if (guard && typeof v === "string" && FORMULA_TRIGGER.test(s) && !isNumericString(s)) s = `'${s}`;
    return NEEDS_QUOTES.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\r\n");
  return opts.bom ? BOM + text : text;
}

/** Called once per record with the 1-based line number where the record starts; return `false` to stop. */
export type CsvRecordHandler = (fields: string[], line: number) => boolean | void;

const COMMA = 44;
const QUOTE = 34;
const LF = 10;
const CR = 13;

/**
 * Streams the records of an RFC 4180 text without materialising them: handles CRLF / LF / lone CR line ends,
 * quoted fields with `""` escapes and embedded newlines, and a leading BOM. Blank lines are skipped.
 * Returns parser issues (unterminated quoted fields).
 */
export function scanCsv(text: string, onRecord: CsvRecordHandler): string[] {
  const issues: string[] = [];
  const n = text.length;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let recordLine = 1;
  let fields: string[] = [];
  let sawQuote = false;

  const endRecord = (): boolean => {
    const blank = fields.length === 1 && fields[0] === "" && !sawQuote;
    const keepGoing = blank || onRecord(fields, recordLine) !== false;
    fields = [];
    sawQuote = false;
    recordLine = line;
    return keepGoing;
  };

  while (pos < n) {
    let c = text.charCodeAt(pos);
    let value: string;
    if (c === QUOTE) {
      sawQuote = true;
      const fieldLine = line;
      pos++;
      let buf = "";
      let start = pos;
      for (;;) {
        const q = text.indexOf('"', pos);
        if (q < 0) {
          buf += text.slice(start);
          issues.push(`Unterminated quoted field starting on line ${fieldLine}`);
          pos = n;
          break;
        }
        if (text.charCodeAt(q + 1) === QUOTE) {
          buf += text.slice(start, q + 1); // escaped quote: keep one of the pair
          pos = q + 2;
          start = pos;
          continue;
        }
        buf += text.slice(start, q);
        pos = q + 1;
        break;
      }
      for (let i = 0; i < buf.length; i++) {
        const ch = buf.charCodeAt(i);
        if (ch === LF || (ch === CR && buf.charCodeAt(i + 1) !== LF)) line++;
      }
      value = buf;
      // Tolerate stray characters between the closing quote and the next delimiter by appending them.
      const extraStart = pos;
      while (pos < n) {
        c = text.charCodeAt(pos);
        if (c === COMMA || c === LF || c === CR) break;
        pos++;
      }
      if (pos > extraStart) value += text.slice(extraStart, pos);
    } else {
      const start = pos;
      while (pos < n) {
        c = text.charCodeAt(pos);
        if (c === COMMA || c === LF || c === CR) break;
        pos++;
      }
      value = text.slice(start, pos);
    }
    fields.push(value);
    if (pos >= n) break;
    if (c === COMMA) {
      pos++;
      if (pos >= n) fields.push(""); // trailing comma at end of text -> final empty field
      continue;
    }
    pos++;
    if (c === CR && text.charCodeAt(pos) === LF) pos++;
    line++;
    if (!endRecord()) return issues;
  }
  if (fields.length > 0) endRecord();
  return issues;
}

const MAX_RAGGED_ISSUES = 50;

/**
 * RFC 4180 parse into header + rows. Header names are trimmed. Ragged rows are padded with "" or truncated
 * to the header width and reported with their line number (the header is line 1).
 */
export function parseCsv(text: string, opts: ParseCsvOptions = {}): ParsedCsv {
  const state: { header: string[] | null } = { header: null };
  const rows: string[][] = [];
  const issues: string[] = [];
  let truncated = false;
  let ragged = 0;
  const scanIssues = scanCsv(text, (fields, line) => {
    if (state.header === null) {
      state.header = fields.map((h) => h.trim());
      return;
    }
    if (opts.maxRows !== undefined && rows.length >= opts.maxRows) {
      truncated = true;
      issues.push(`Row limit of ${opts.maxRows.toLocaleString("en-US")} data rows exceeded; parsing stopped at line ${line}`);
      return false;
    }
    const width = state.header.length;
    let row = fields;
    if (fields.length !== width) {
      ragged++;
      if (ragged <= MAX_RAGGED_ISSUES) issues.push(`Line ${line}: expected ${width} fields, found ${fields.length} (${fields.length < width ? "padded" : "truncated"})`);
      row = fields.length < width ? [...fields, ...new Array<string>(width - fields.length).fill("")] : fields.slice(0, width);
    }
    rows.push(row);
  });
  if (ragged > MAX_RAGGED_ISSUES) issues.push(`${ragged - MAX_RAGGED_ISSUES} more ragged rows not listed`);
  return { header: state.header ?? [], rows, issues: [...scanIssues, ...issues], truncated };
}

export function downloadText(filename: string, text: string, mime = "text/csv;charset=utf-8"): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
