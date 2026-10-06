/**
 * Bring-your-own data: KPI CSV (+ optional cells / sites / alarms files) -> Dataset with validation issues.
 * The accepted schema is exactly what `npm run gen:data` writes to data/ (see docs/DATA_SCHEMA.md).
 */
import type { Alarm, AlarmState, Cell, KpiKey, KpiSample, Severity, Site, Technology } from "../types/telecom";
import type { Dataset } from "./synthetic";
import { parseCsv, scanCsv, toCsv } from "./csv";

export interface ImportIssue {
  level: "error" | "warning";
  /** Logical source: "kpi" | "cells" | "sites" | "alarms". */
  file?: string;
  /** CSV: 1-based line number in the file (the header is line 1). JSON: 1-based position in the array. */
  row?: number;
  message: string;
}
export interface ImportFiles { kpiCsv: string; cellsJson?: string; cellsCsv?: string; sitesJson?: string; alarmsCsv?: string; alarmsJson?: string }
export interface ImportSummary { rows: number; cells: number; sites: number; alarms: number; start: string; end: string; intervalMin: number | null }
export interface ImportResult { ok: boolean; dataset?: Dataset; label: string; issues: ImportIssue[]; summary: ImportSummary }
export interface ImportOptions {
  label?: string;
  packets?: Pick<Dataset, "packetStats" | "conversations" | "tcpSummary">;
  /** Override the KPI row limit (default MAX_IMPORT_ROWS). */
  maxRows?: number;
}
export type ImportFileKind = "kpi" | "cells" | "sites" | "alarms" | "unknown";

/** Header of data/kpi_15min.csv; every column is required (order is free, extra columns are ignored). */
export const KPI_CSV_COLUMNS: readonly string[] = [
  "cellId", "timestamp", "callDropRatePct", "rrcSetupSuccessPct", "handoverSuccessPct", "dlThroughputMbps",
  "ulThroughputMbps", "latencyMs", "prbUtilizationPct", "rsrpAvgDbm", "sinrAvgDb", "activeUsers",
];
export const MAX_IMPORT_ROWS = 500_000;
/** Individual issues reported per import; the rest is summarised in one closing warning. */
export const MAX_IMPORT_ISSUES = 200;

const KPI_VALUE_COLUMNS: readonly KpiKey[] = ["callDropRatePct", "rrcSetupSuccessPct", "handoverSuccessPct", "dlThroughputMbps", "ulThroughputMbps", "latencyMs", "prbUtilizationPct", "rsrpAvgDbm", "sinrAvgDb"];
const PCT_COLUMNS: ReadonlySet<string> = new Set(["callDropRatePct", "rrcSetupSuccessPct", "handoverSuccessPct", "prbUtilizationPct"]);
const KPI_COLUMN_SET: ReadonlySet<string> = new Set(KPI_CSV_COLUMNS);
/** Cell values (lower-cased) that mean "no counters" besides the empty string. */
const NULL_TOKENS: ReadonlySet<string> = new Set(["", "null", "nan", "na", "n/a", "none", "-"]);
/** Drops a leading UTF-8 byte-order mark (U+FEFF). */
const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
const ZONE_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const EPOCH_RE = /^\d{9,14}$/;
const CELL_ID_RE = /^(.+)-([LN])(\d+)$/;
const LTE_BANDS = ["B3", "B40", "B1"];
const SEVERITIES: readonly Severity[] = ["Critical", "Major", "Minor", "Warning"];
const STATES: readonly AlarmState[] = ["active", "acknowledged", "cleared"];
const MAX_LISTED_RANGE_WARNINGS = 20;

type Rec = Record<string, unknown>;

const fmtInt = (n: number) => n.toLocaleString("en-US");

/** Collects issues for one logical file with a cap, counting errors even when they are no longer listed. */
class IssueLog {
  readonly issues: ImportIssue[] = [];
  errorCount = 0;
  private dropped = 0;
  constructor(private readonly file: string) {}
  add(level: ImportIssue["level"], message: string, row?: number): void {
    if (level === "error") this.errorCount++;
    if (this.issues.length >= MAX_IMPORT_ISSUES) {
      this.dropped++;
      return;
    }
    const issue: ImportIssue = { level, file: this.file, message };
    if (row !== undefined) issue.row = row;
    this.issues.push(issue);
  }
  error(message: string, row?: number): void { this.add("error", message, row); }
  warn(message: string, row?: number): void { this.add("warning", message, row); }
  done(): ImportIssue[] {
    if (this.dropped > 0) {
      this.issues.push({ level: "warning", file: this.file, message: `${fmtInt(this.dropped)} more issues not shown` });
      this.dropped = 0;
    }
    return this.issues;
  }
}

function str(v: unknown): string | undefined {
  if (typeof v === "string") {
    const s = v.trim();
    return s === "" ? undefined : s;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}
function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
function normaliseTech(raw: string): Technology | undefined {
  const u = raw.toUpperCase();
  return u === "LTE" ? "LTE" : u === "NR" ? "NR" : undefined;
}
/** `""`/null tokens -> null; non-numeric -> undefined. */
function parseNullableNumber(raw: string): number | null | undefined {
  const s = raw.trim();
  if (NULL_TOKENS.has(s.toLowerCase())) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : undefined;
}

/**
 * ISO 8601 (any offset; values without a zone designator are read in the local time zone),
 * epoch seconds (< 1e11) or epoch milliseconds -> UTC ms. Returns null when unparseable.
 */
export function parseTimestamp(raw: string): number | null {
  const s = raw.trim();
  if (s === "") return null;
  if (EPOCH_RE.test(s)) {
    const v = Number(s);
    return v < 1e11 ? v * 1000 : v;
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/** Cell attributes from the id pattern `<SITE>-L<n>` (LTE B3/B40/B1 by n, 20 MHz) or `<SITE>-N<n>` (NR n78, 100 MHz). */
function inferCellFromId(cellId: string): { cell: Cell; matched: boolean } {
  const m = CELL_ID_RE.exec(cellId);
  if (m) {
    const siteId = m[1];
    if (m[2] === "N") return { cell: { cellId, siteId, technology: "NR", band: "n78", bandwidthMHz: 100, azimuthDeg: 0 }, matched: true };
    const k = (Math.max(1, Number(m[3])) - 1) % 3;
    return { cell: { cellId, siteId, technology: "LTE", band: LTE_BANDS[k], bandwidthMHz: 20, azimuthDeg: k * 120 }, matched: true };
  }
  const dash = cellId.lastIndexOf("-");
  const siteId = dash > 0 ? cellId.slice(0, dash) : cellId;
  return { cell: { cellId, siteId, technology: "LTE", band: "unknown", bandwidthMHz: 0, azimuthDeg: 0 }, matched: false };
}

/** Streams the KPI CSV into typed samples. Timestamps are normalised to UTC ISO strings. */
export function parseKpiCsv(text: string, opts: { maxRows?: number } = {}): { samples: KpiSample[]; issues: ImportIssue[] } {
  const maxRows = opts.maxRows ?? MAX_IMPORT_ROWS;
  const log = new IssueLog("kpi");
  const samples: KpiSample[] = [];
  let index: Map<string, number> | null = null;
  let unzoned = 0;
  let outOfRange = 0;

  const scanIssues = scanCsv(text, (fields, line) => {
    if (index === null) {
      const idx = new Map<string, number>();
      fields.forEach((raw, i) => {
        const h = raw.trim();
        if (idx.has(h)) log.warn(`Duplicate column "${h}" ignored`, line);
        else idx.set(h, i);
        if (!KPI_COLUMN_SET.has(h)) log.warn(`Unknown column "${h}" ignored`, line);
      });
      for (const c of KPI_CSV_COLUMNS) if (!idx.has(c)) log.error(`Missing required column "${c}"`, line);
      index = idx;
      return;
    }
    if (samples.length >= maxRows) {
      log.error(`More than ${fmtInt(maxRows)} data rows (limit ${fmtInt(maxRows)}); parsing stopped at line ${line}`, line);
      return false;
    }
    const idx = index;
    const get = (name: string): string => {
      const i = idx.get(name);
      return i === undefined || i >= fields.length ? "" : fields[i];
    };
    const cellId = get("cellId").trim();
    if (cellId === "") {
      log.error("Missing cellId", line);
      return;
    }
    const tsRaw = get("timestamp").trim();
    const ms = parseTimestamp(tsRaw);
    if (ms === null) {
      log.error(`Invalid timestamp "${tsRaw}"`, line);
      return;
    }
    if (!EPOCH_RE.test(tsRaw) && !ZONE_RE.test(tsRaw)) unzoned++;
    const sample: KpiSample = {
      cellId, timestamp: new Date(ms).toISOString(), callDropRatePct: null, rrcSetupSuccessPct: null, handoverSuccessPct: null, dlThroughputMbps: null,
      ulThroughputMbps: null, latencyMs: null, prbUtilizationPct: null, rsrpAvgDbm: null, sinrAvgDb: null, activeUsers: 0,
    };
    for (const k of KPI_VALUE_COLUMNS) {
      const raw = get(k);
      const v = parseNullableNumber(raw);
      if (v === undefined) {
        log.error(`Column ${k} is not a number: "${raw.trim()}"`, line);
        return;
      }
      if (v !== null && PCT_COLUMNS.has(k) && (v < 0 || v > 100)) {
        outOfRange++;
        if (outOfRange <= MAX_LISTED_RANGE_WARNINGS) log.warn(`${k} = ${v} is outside 0..100`, line);
      }
      sample[k] = v;
    }
    const usersRaw = get("activeUsers");
    const users = parseNullableNumber(usersRaw);
    if (users === undefined) {
      log.error(`Column activeUsers is not a number: "${usersRaw.trim()}"`, line);
      return;
    }
    sample.activeUsers = users ?? 0;
    samples.push(sample);
  });

  for (const m of scanIssues) log.error(m);
  if (index === null) log.error("Empty file: no header row found");
  else if (samples.length === 0 && log.errorCount === 0) log.error("No data rows found");
  if (outOfRange > MAX_LISTED_RANGE_WARNINGS) log.warn(`${fmtInt(outOfRange - MAX_LISTED_RANGE_WARNINGS)} more percentage values outside 0..100 not listed`);
  if (unzoned > 0) log.warn(`${fmtInt(unzoned)} timestamp(s) have no time-zone designator and were interpreted in this browser's local time zone`);
  return { samples, issues: log.done() };
}

/** Cells for every distinct cellId in first-seen order, attributes inferred from the id pattern (warning when it does not match). */
export function inferCells(samples: KpiSample[]): { cells: Cell[]; issues: ImportIssue[] } {
  const log = new IssueLog("kpi");
  const seen = new Set<string>();
  const cells: Cell[] = [];
  for (const s of samples) {
    if (seen.has(s.cellId)) continue;
    seen.add(s.cellId);
    const { cell, matched } = inferCellFromId(s.cellId);
    if (!matched) log.warn(`Cell id "${s.cellId}" does not follow <SITE>-L<n> / <SITE>-N<n>; assumed LTE on site "${cell.siteId}"`);
    cells.push(cell);
  }
  return { cells, issues: log.done() };
}

/** Provided sites first (de-duplicated), then a placeholder (NaN coordinates, region "imported") for every other site referenced by a cell. */
export function inferSites(cells: Cell[], sites: Site[] = []): Site[] {
  const out: Site[] = [];
  const have = new Set<string>();
  for (const s of sites) {
    if (have.has(s.siteId)) continue;
    have.add(s.siteId);
    out.push(s);
  }
  for (const c of cells) {
    if (have.has(c.siteId)) continue;
    have.add(c.siteId);
    out.push({ siteId: c.siteId, name: c.siteId, lat: NaN, lon: NaN, region: "imported" });
  }
  return out;
}

function parseJsonArray(text: string, log: IssueLog): Rec[] | null {
  let value: unknown;
  try {
    value = JSON.parse(stripBom(text));
  } catch (e) {
    log.error(`Invalid JSON: ${(e as Error).message}`);
    return null;
  }
  if (!Array.isArray(value)) {
    log.error("Expected a JSON array of objects");
    return null;
  }
  return value as Rec[];
}

function csvRecords(text: string, log: IssueLog, required: string[]): { recs: Rec[]; lines: number[]; header: string[] } | null {
  const parsed = parseCsv(text);
  for (const m of parsed.issues) log.warn(m);
  if (parsed.header.length === 0) {
    log.error("Empty file: no header row found");
    return null;
  }
  const missing = required.filter((c) => !parsed.header.includes(c));
  if (missing.length > 0) {
    for (const c of missing) log.error(`Missing required column "${c}"`, 1);
    return null;
  }
  // parseCsv skips blank lines but keeps records in order; recover the line of each record by re-scanning.
  const lines: number[] = [];
  let first = true;
  scanCsv(text, (_fields, line) => {
    if (first) first = false;
    else lines.push(line);
  });
  const recs = parsed.rows.map((row) => Object.fromEntries(parsed.header.map((h, i) => [h, row[i]])) as Rec);
  return { recs, lines, header: parsed.header };
}

function toCell(rec: unknown, row: number, log: IssueLog): Cell | null {
  if (typeof rec !== "object" || rec === null || Array.isArray(rec)) {
    log.error("Entry is not an object", row);
    return null;
  }
  const r = rec as Rec;
  const cellId = str(r.cellId);
  if (!cellId) {
    log.error("Missing cellId", row);
    return null;
  }
  const inferred = inferCellFromId(cellId).cell;
  let technology = inferred.technology;
  const techRaw = str(r.technology);
  if (techRaw !== undefined) {
    const t = normaliseTech(techRaw);
    if (t) technology = t;
    else log.warn(`Unknown technology "${techRaw}" for ${cellId} (expected LTE or NR); using ${inferred.technology}`, row);
  }
  const bandwidth = num(r.bandwidthMHz);
  if (r.bandwidthMHz !== undefined && r.bandwidthMHz !== "" && bandwidth === undefined) log.warn(`Invalid bandwidthMHz for ${cellId}; using ${inferred.bandwidthMHz}`, row);
  const azimuth = num(r.azimuthDeg);
  if (r.azimuthDeg !== undefined && r.azimuthDeg !== "" && azimuth === undefined) log.warn(`Invalid azimuthDeg for ${cellId}; using ${inferred.azimuthDeg}`, row);
  return {
    cellId, siteId: str(r.siteId) ?? inferred.siteId, technology, band: str(r.band) ?? inferred.band,
    bandwidthMHz: bandwidth ?? inferred.bandwidthMHz, azimuthDeg: azimuth ?? inferred.azimuthDeg,
  };
}

function dedupeCells(cells: Cell[], log: IssueLog, rows: number[]): Cell[] {
  const seen = new Set<string>();
  const out: Cell[] = [];
  cells.forEach((c, i) => {
    if (seen.has(c.cellId)) log.warn(`Duplicate cell "${c.cellId}" ignored`, rows[i]);
    else {
      seen.add(c.cellId);
      out.push(c);
    }
  });
  return out;
}

export function parseCellsJson(text: string): { cells: Cell[]; issues: ImportIssue[] } {
  const log = new IssueLog("cells");
  const arr = parseJsonArray(text, log);
  if (!arr) return { cells: [], issues: log.done() };
  const cells: Cell[] = [];
  const rows: number[] = [];
  arr.forEach((rec, i) => {
    const c = toCell(rec, i + 1, log);
    if (c) {
      cells.push(c);
      rows.push(i + 1);
    }
  });
  return { cells: dedupeCells(cells, log, rows), issues: log.done() };
}

export function parseCellsCsv(text: string): { cells: Cell[]; issues: ImportIssue[] } {
  const log = new IssueLog("cells");
  const table = csvRecords(text, log, ["cellId"]);
  if (!table) return { cells: [], issues: log.done() };
  const cells: Cell[] = [];
  const rows: number[] = [];
  table.recs.forEach((rec, i) => {
    const c = toCell(rec, table.lines[i], log);
    if (c) {
      cells.push(c);
      rows.push(table.lines[i]);
    }
  });
  return { cells: dedupeCells(cells, log, rows), issues: log.done() };
}

export function parseSitesJson(text: string): { sites: Site[]; issues: ImportIssue[] } {
  const log = new IssueLog("sites");
  const arr = parseJsonArray(text, log);
  if (!arr) return { sites: [], issues: log.done() };
  const sites: Site[] = [];
  const seen = new Set<string>();
  arr.forEach((rec, i) => {
    const row = i + 1;
    if (typeof rec !== "object" || rec === null || Array.isArray(rec)) {
      log.error("Entry is not an object", row);
      return;
    }
    const siteId = str(rec.siteId);
    if (!siteId) {
      log.error("Missing siteId", row);
      return;
    }
    if (seen.has(siteId)) {
      log.warn(`Duplicate site "${siteId}" ignored`, row);
      return;
    }
    seen.add(siteId);
    const lat = num(rec.lat ?? rec.latitude);
    const lon = num(rec.lon ?? rec.lng ?? rec.longitude);
    if (lat === undefined || lon === undefined) log.warn(`Site "${siteId}" has no valid coordinates (lat/lon); it will not be drawn on the map`, row);
    sites.push({ siteId, name: str(rec.name) ?? siteId, lat: lat ?? NaN, lon: lon ?? NaN, region: str(rec.region) ?? "imported" });
  });
  return { sites, issues: log.done() };
}

function toAlarm(rec: unknown, row: number, log: IssueLog, cells?: Map<string, Cell>): Alarm | null {
  if (typeof rec !== "object" || rec === null || Array.isArray(rec)) {
    log.error("Entry is not an object", row);
    return null;
  }
  const r = rec as Rec;
  const alarmId = str(r.alarmId);
  if (!alarmId) {
    log.error("Missing alarmId", row);
    return null;
  }
  const tsRaw = str(r.timestamp) ?? "";
  const ms = parseTimestamp(tsRaw);
  if (ms === null) {
    log.error(`Invalid timestamp "${tsRaw}" for alarm ${alarmId}`, row);
    return null;
  }
  const cellId = str(r.cellId);
  let siteId = str(r.siteId);
  if (!siteId) {
    if (!cellId) {
      log.error(`Missing siteId for alarm ${alarmId}`, row);
      return null;
    }
    siteId = cells?.get(cellId)?.siteId ?? inferCellFromId(cellId).cell.siteId;
  }
  const sevRaw = str(r.severity);
  const severity = sevRaw ? SEVERITIES.find((s) => s.toLowerCase() === sevRaw.toLowerCase()) : undefined;
  if (!severity) log.warn(`Unknown severity "${sevRaw ?? ""}" for alarm ${alarmId}; using Warning`, row);
  const stateRaw = str(r.state);
  const state = stateRaw ? STATES.find((s) => s === stateRaw.toLowerCase()) : undefined;
  if (!state) log.warn(`Unknown state "${stateRaw ?? ""}" for alarm ${alarmId}; using active`, row);
  const alarm: Alarm = { alarmId, timestamp: new Date(ms).toISOString(), siteId, severity: severity ?? "Warning", probableCause: str(r.probableCause) ?? "", state: state ?? "active" };
  if (cellId) alarm.cellId = cellId;
  const techRaw = str(r.technology);
  if (techRaw !== undefined) {
    const t = normaliseTech(techRaw);
    if (t) alarm.technology = t;
    else log.warn(`Unknown technology "${techRaw}" for alarm ${alarmId} ignored`, row);
  } else if (cellId) {
    const t = cells?.get(cellId)?.technology;
    if (t) alarm.technology = t;
  }
  const clearedRaw = str(r.clearedAt);
  if (clearedRaw !== undefined) {
    const c = parseTimestamp(clearedRaw);
    if (c === null) log.warn(`Invalid clearedAt "${clearedRaw}" for alarm ${alarmId} ignored`, row);
    else alarm.clearedAt = new Date(c).toISOString();
  }
  return alarm;
}

function dedupeAlarms(alarms: Alarm[], log: IssueLog, rows: number[]): Alarm[] {
  const seen = new Set<string>();
  const out: Alarm[] = [];
  alarms.forEach((a, i) => {
    if (seen.has(a.alarmId)) log.warn(`Duplicate alarm "${a.alarmId}" ignored`, rows[i]);
    else {
      seen.add(a.alarmId);
      out.push(a);
    }
  });
  return out;
}

export function parseAlarmsCsv(text: string, cells?: Map<string, Cell>): { alarms: Alarm[]; issues: ImportIssue[] } {
  const log = new IssueLog("alarms");
  const table = csvRecords(text, log, ["alarmId", "timestamp"]);
  if (!table) return { alarms: [], issues: log.done() };
  if (!table.header.includes("siteId") && !table.header.includes("cellId")) {
    log.error('Missing required column "siteId" (or "cellId")', 1);
    return { alarms: [], issues: log.done() };
  }
  for (const c of ["severity", "probableCause", "state"]) if (!table.header.includes(c)) log.warn(`Column "${c}" missing; defaults applied`, 1);
  const alarms: Alarm[] = [];
  const rows: number[] = [];
  table.recs.forEach((rec, i) => {
    const a = toAlarm(rec, table.lines[i], log, cells);
    if (a) {
      alarms.push(a);
      rows.push(table.lines[i]);
    }
  });
  return { alarms: dedupeAlarms(alarms, log, rows), issues: log.done() };
}

export function parseAlarmsJson(text: string, cells?: Map<string, Cell>): { alarms: Alarm[]; issues: ImportIssue[] } {
  const log = new IssueLog("alarms");
  const arr = parseJsonArray(text, log);
  if (!arr) return { alarms: [], issues: log.done() };
  const alarms: Alarm[] = [];
  const rows: number[] = [];
  arr.forEach((rec, i) => {
    const a = toAlarm(rec, i + 1, log, cells);
    if (a) {
      alarms.push(a);
      rows.push(i + 1);
    }
  });
  return { alarms: dedupeAlarms(alarms, log, rows), issues: log.done() };
}

/** Which schema a dropped/selected file follows, judged from its content (header or first object) with the file name as fallback. */
export function classifyImportFile(name: string, text: string): ImportFileKind {
  const head = stripBom(text.slice(0, 4096)).trimStart();
  const lower = name.toLowerCase();
  const byName = (): ImportFileKind => (/alarm/.test(lower) ? "alarms" : /cell/.test(lower) ? "cells" : /site/.test(lower) ? "sites" : /kpi/.test(lower) ? "kpi" : "unknown");
  if (head.startsWith("[") || head.startsWith("{")) {
    const firstObject = /\{[^{}]*\}/.exec(head)?.[0] ?? "";
    if (/"alarmId"\s*:/.test(firstObject)) return "alarms";
    if (/"cellId"\s*:/.test(firstObject)) return "cells";
    if (/"siteId"\s*:/.test(firstObject) || /"lat"\s*:/.test(firstObject)) return "sites";
    return byName();
  }
  const headerLine = head.split(/\r\n|\n|\r/, 1)[0];
  const cols = new Set(headerLine.split(",").map((c) => c.trim().replace(/^"(.*)"$/, "$1")));
  if (cols.has("alarmId")) return "alarms";
  if (cols.has("cellId") && cols.has("timestamp")) return "kpi";
  if (cols.has("cellId")) return "cells";
  return byName();
}

/** Median gap between consecutive distinct timestamps, in minutes (2 decimals); null with fewer than two timestamps. */
function medianIntervalMin(sortedMs: number[]): number | null {
  if (sortedMs.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < sortedMs.length; i++) gaps.push(sortedMs[i] - sortedMs[i - 1]);
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median = gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return Math.round((median / 60000) * 100) / 100;
}

const EMPTY_PACKETS: Pick<Dataset, "packetStats" | "conversations" | "tcpSummary"> = {
  packetStats: [], conversations: [], tcpSummary: { packets: 0, retransmissions: 0, retransmissionPct: 0, rttAvgMs: 0, rttP95Ms: 0 },
};

/** Validates and assembles a Dataset. `ok` is false (and `dataset` absent) when any issue is an error. */
export function importDataset(files: ImportFiles, opts: ImportOptions = {}): ImportResult {
  const issues: ImportIssue[] = [];
  const label = opts.label ?? "Imported dataset";

  const kpi = parseKpiCsv(files.kpiCsv, { maxRows: opts.maxRows });
  issues.push(...kpi.issues);

  let provided: Cell[] = [];
  if (files.cellsJson !== undefined) {
    const r = parseCellsJson(files.cellsJson);
    provided = r.cells;
    issues.push(...r.issues);
    if (files.cellsCsv !== undefined) issues.push({ level: "warning", file: "cells", message: "Both a cells JSON and a cells CSV were given; the CSV was ignored" });
  } else if (files.cellsCsv !== undefined) {
    const r = parseCellsCsv(files.cellsCsv);
    provided = r.cells;
    issues.push(...r.issues);
  }
  const known = new Set(provided.map((c) => c.cellId));
  const inferred = inferCells(known.size === 0 ? kpi.samples : kpi.samples.filter((s) => !known.has(s.cellId)));
  if (provided.length > 0 && inferred.cells.length > 0) {
    issues.push({ level: "warning", file: "cells", message: `${fmtInt(inferred.cells.length)} cell(s) in the KPI file are not in the cells file; technology and band were inferred from the cell id: ${inferred.cells.slice(0, 5).map((c) => c.cellId).join(", ")}${inferred.cells.length > 5 ? ", ..." : ""}` });
  }
  issues.push(...inferred.issues);
  const cells = [...provided, ...inferred.cells];

  let providedSites: Site[] = [];
  if (files.sitesJson !== undefined) {
    const r = parseSitesJson(files.sitesJson);
    providedSites = r.sites;
    issues.push(...r.issues);
  }
  const sites = inferSites(cells, providedSites);

  const cellMap = new Map(cells.map((c) => [c.cellId, c]));
  let alarms: Alarm[] = [];
  if (files.alarmsJson !== undefined) {
    const r = parseAlarmsJson(files.alarmsJson, cellMap);
    alarms = r.alarms;
    issues.push(...r.issues);
    if (files.alarmsCsv !== undefined) issues.push({ level: "warning", file: "alarms", message: "Both an alarms JSON and an alarms CSV were given; the CSV was ignored" });
  } else if (files.alarmsCsv !== undefined) {
    const r = parseAlarmsCsv(files.alarmsCsv, cellMap);
    alarms = r.alarms;
    issues.push(...r.issues);
  }

  const stamps = new Set<string>();
  for (const s of kpi.samples) stamps.add(s.timestamp);
  const sortedMs = [...stamps].map((t) => Date.parse(t)).sort((a, b) => a - b);
  const summary: ImportSummary = {
    rows: kpi.samples.length, cells: cells.length, sites: sites.length, alarms: alarms.length,
    start: sortedMs.length ? new Date(sortedMs[0]).toISOString() : "",
    end: sortedMs.length ? new Date(sortedMs[sortedMs.length - 1]).toISOString() : "",
    intervalMin: medianIntervalMin(sortedMs),
  };
  const ok = kpi.samples.length > 0 && issues.every((i) => i.level !== "error");
  const packets = opts.packets ?? EMPTY_PACKETS;
  const dataset: Dataset = {
    sites, cells, samples: kpi.samples, alarms, packetStats: packets.packetStats, conversations: packets.conversations, incidents: [], tcpSummary: packets.tcpSummary,
  };
  return ok ? { ok, dataset, label, issues, summary } : { ok, label, issues, summary };
}

/** A small, valid KPI CSV (two cells, three intervals, one interval without counters) for download from the Data drawer. */
export function sampleKpiCsv(): string {
  const rows: KpiSample[] = [
    { cellId: "SITE-001-L1", timestamp: "2026-09-23T06:15:00.000Z", callDropRatePct: 0.61, rrcSetupSuccessPct: 99.02, handoverSuccessPct: 98.15, dlThroughputMbps: 33.4, ulThroughputMbps: 10.3, latencyMs: 30.8, prbUtilizationPct: 35.2, rsrpAvgDbm: -92.1, sinrAvgDb: 7.4, activeUsers: 64 },
    { cellId: "SITE-001-N1", timestamp: "2026-09-23T06:15:00.000Z", callDropRatePct: 0.58, rrcSetupSuccessPct: 99.1, handoverSuccessPct: 98.3, dlThroughputMbps: 301.5, ulThroughputMbps: 54.2, latencyMs: 18.6, prbUtilizationPct: 31.9, rsrpAvgDbm: -92.6, sinrAvgDb: 12.1, activeUsers: 131 },
    { cellId: "SITE-001-L1", timestamp: "2026-09-23T06:30:00.000Z", callDropRatePct: null, rrcSetupSuccessPct: null, handoverSuccessPct: null, dlThroughputMbps: null, ulThroughputMbps: null, latencyMs: null, prbUtilizationPct: null, rsrpAvgDbm: null, sinrAvgDb: null, activeUsers: 0 },
    { cellId: "SITE-001-N1", timestamp: "2026-09-23T06:30:00.000Z", callDropRatePct: 0.6, rrcSetupSuccessPct: 99.08, handoverSuccessPct: 98.25, dlThroughputMbps: 297.2, ulThroughputMbps: 53.6, latencyMs: 18.9, prbUtilizationPct: 33.1, rsrpAvgDbm: -92.5, sinrAvgDb: 12, activeUsers: 135 },
    { cellId: "SITE-001-L1", timestamp: "2026-09-23T06:45:00.000Z", callDropRatePct: 0.7, rrcSetupSuccessPct: 98.9, handoverSuccessPct: 98.05, dlThroughputMbps: 32.3, ulThroughputMbps: 9.9, latencyMs: 32, prbUtilizationPct: 38.8, rsrpAvgDbm: -92.2, sinrAvgDb: 7.3, activeUsers: 72 },
    { cellId: "SITE-001-N1", timestamp: "2026-09-23T06:45:00.000Z", callDropRatePct: 0.62, rrcSetupSuccessPct: 99.04, handoverSuccessPct: 98.2, dlThroughputMbps: 293, ulThroughputMbps: 53, latencyMs: 19.2, prbUtilizationPct: 34.4, rsrpAvgDbm: -92.7, sinrAvgDb: 11.9, activeUsers: 140 },
  ];
  return toCsv(rows as unknown as Record<string, unknown>[], [...KPI_CSV_COLUMNS]);
}
