import { useMemo, useState, type ChangeEvent, type DragEvent } from "react";
import { Drawer, Notice, fmtTime } from "./ui";
import { downloadText } from "../lib/csv";
import { classifyImportFile, importDataset, sampleKpiCsv, type ImportFileKind, type ImportIssue, type ImportResult, type ImportSummary } from "../lib/importers";
import type { Dataset } from "../lib/synthetic";

export interface DataSourceSummary { kind: "synthetic" | "imported"; label: string; rows: number; cellCount: number; siteCount: number; alarmCount: number }
export interface DataSourceDrawerProps {
  open: boolean;
  onClose(): void;
  /** Receives the validated dataset, a label (the KPI file name) and the human-readable warnings. */
  onLoad(ds: Dataset, label: string, warnings: string[]): void;
  onReset(): void;
  source: DataSourceSummary;
}

/** Per-file size guard; the importer additionally caps the KPI file at MAX_IMPORT_ROWS rows. */
export const MAX_IMPORT_FILE_BYTES = 100 * 1024 * 1024;
export const DATA_SCHEMA_URL = "https://github.com/D-L-Narayana/telecom-kpi-monitor/blob/main/docs/DATA_SCHEMA.md";

interface SelectedFile { name: string; size: number; kind: ImportFileKind; text?: string; problem?: string }

const KIND_LABEL: Record<ImportFileKind, string> = { kpi: "KPI CSV", cells: "cells", sites: "sites", alarms: "alarms", unknown: "skipped" };
/** Separator between inline summary parts: space, middle dot (U+00B7), space; built from the code point so the source stays ASCII. */
const SEP = ` ${String.fromCharCode(0xb7)} `;
const fmtInt = (n: number) => n.toLocaleString("en-US");
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} kB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);
const plural = (n: number, word: string) => `${fmtInt(n)} ${word}${n === 1 ? "" : "s"}`;
const looksLikeJson = (text: string) => /^[[{]/.test(text.trimStart());

async function readFile(f: File): Promise<SelectedFile> {
  const base = { name: f.name, size: f.size };
  if (f.size > MAX_IMPORT_FILE_BYTES) return { ...base, kind: "unknown", problem: `${f.name}: too large (${fmtBytes(f.size)}); the limit is ${fmtBytes(MAX_IMPORT_FILE_BYTES)} per file` };
  let text: string;
  try {
    text = await f.text();
  } catch (e) {
    return { ...base, kind: "unknown", problem: `${f.name}: could not be read (${(e as Error).message})` };
  }
  const kind = classifyImportFile(f.name, text);
  if (kind === "unknown") return { ...base, kind, problem: `${f.name}: not a recognised file (expected the KPI CSV, cells.json/.csv, sites.json or alarms.csv/.json)` };
  return { ...base, kind, text };
}

/** Newly chosen files replace an earlier file of the same kind or the same name, so companions can be added one at a time. */
function mergeFiles(prev: SelectedFile[], added: SelectedFile[]): SelectedFile[] {
  const kept = prev.filter((p) => !added.some((a) => a.name === p.name || (a.kind !== "unknown" && a.kind === p.kind)));
  return [...kept, ...added];
}

function formatIssue(issue: ImportIssue, files: SelectedFile[]): string {
  const file = files.find((f) => f.kind === issue.file && f.text !== undefined);
  const name = file?.name ?? issue.file ?? "import";
  const unit = file && /\.json$/i.test(file.name) ? "entry" : "line";
  return `${name}${issue.row !== undefined ? `, ${unit} ${issue.row}` : ""}: ${issue.message}`;
}

function summaryFields(s: ImportSummary): [string, string][] {
  const fields: [string, string][] = [["Rows", fmtInt(s.rows)], ["Cells", fmtInt(s.cells)], ["Sites", fmtInt(s.sites)], ["Alarms", fmtInt(s.alarms)]];
  fields.push(["Interval", s.intervalMin === null ? "unknown (fewer than two timestamps)" : `${s.intervalMin} min`]);
  if (s.start && s.end) fields.push(["Window", `${fmtTime(s.start)} to ${fmtTime(s.end)} IST`]);
  return fields;
}

/** Body of the Data drawer: file selection, validation summary, issues and the load / reset actions. */
export function DataSourceForm({ source, onLoad, onReset, onClose }: Omit<DataSourceDrawerProps, "open">) {
  const [files, setFiles] = useState<SelectedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const result = useMemo<ImportResult | null>(() => {
    const pick = (kind: ImportFileKind) => files.find((f) => f.kind === kind && f.text !== undefined);
    const kpi = pick("kpi");
    if (!kpi || kpi.text === undefined) return null;
    const cells = pick("cells");
    const sites = pick("sites");
    const alarms = pick("alarms");
    const json = (f: SelectedFile | undefined) => (f?.text !== undefined && looksLikeJson(f.text) ? f.text : undefined);
    const csv = (f: SelectedFile | undefined) => (f?.text !== undefined && !looksLikeJson(f.text) ? f.text : undefined);
    return importDataset(
      { kpiCsv: kpi.text, cellsJson: json(cells), cellsCsv: csv(cells), sitesJson: sites?.text, alarmsJson: json(alarms), alarmsCsv: csv(alarms) },
      { label: kpi.name },
    );
  }, [files]);

  const problems = files.flatMap((f) => (f.problem ? [f.problem] : []));
  const issueErrors = result?.issues.filter((i) => i.level === "error").length ?? 0;
  const warningIssues = result?.issues.filter((i) => i.level === "warning") ?? [];
  const errorCount = issueErrors + problems.length;
  const canUse = result?.ok === true && result.dataset !== undefined && problems.length === 0;
  const hasReadable = files.some((f) => f.text !== undefined);
  const needsKpi = !busy && hasReadable && result === null;

  const addFiles = async (list: ArrayLike<File> | null | undefined) => {
    const incoming = list ? Array.from(list) : [];
    if (incoming.length === 0) return;
    setBusy(true);
    try {
      const read = await Promise.all(incoming.map(readFile));
      setFiles((prev) => mergeFiles(prev, read));
    } finally {
      setBusy(false);
    }
  };
  const onInput = (e: ChangeEvent<HTMLInputElement>) => {
    void addFiles(e.target.files);
    e.target.value = ""; // allow re-selecting the same file after a Clear
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    void addFiles(e.dataTransfer?.files);
  };
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!dragging) setDragging(true);
  };
  const use = () => {
    if (!canUse || !result?.dataset) return;
    onLoad(result.dataset, result.label, warningIssues.map((i) => formatIssue(i, files)));
    onClose();
  };
  const reset = () => {
    onReset();
    onClose();
  };

  return (
    <div>
      <p>
        Current source: {source.kind === "synthetic" ? "synthetic dataset" : `imported dataset "${source.label}"`} &mdash; {fmtInt(source.rows)} rows &middot; {fmtInt(source.cellCount)} cells &middot; {fmtInt(source.siteCount)} sites &middot; {fmtInt(source.alarmCount)} alarms
      </p>
      <p className="muted small-text">
        Load the files <code>npm run gen:data</code> writes: the 15-minute KPI CSV (required) plus optional <code>cells.json</code>/<code>.csv</code>, <code>sites.json</code> and <code>alarms.csv</code>/<code>.json</code>.
        Files are parsed in this browser and nothing is uploaded; an imported dataset stays in memory until the page is reloaded.
      </p>

      <div className={dragging ? "dropzone active" : "dropzone"} role="group" aria-label="Import files" onDragOver={onDragOver} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
        <label className="btn file">
          Choose files
          <input type="file" multiple accept=".csv,.json" onChange={onInput} />
        </label>
        <span className="muted small-text">or drop them here (CSV / JSON, up to {fmtBytes(MAX_IMPORT_FILE_BYTES)} each)</span>
      </div>

      {files.length > 0 && (
        <ul className="file-list" aria-label="Selected files">
          {files.map((f) => (
            <li key={f.name}>
              <span className="file-name">{f.name}</span> <span className="muted small-text">{KIND_LABEL[f.kind]} &middot; {fmtBytes(f.size)}</span>
            </li>
          ))}
        </ul>
      )}
      {busy && <p className="muted small-text" role="status">Reading files&hellip;</p>}
      {needsKpi && <Notice kind="info">Add the KPI CSV (kpi_15min.csv) to continue; cells, sites and alarms files are optional companions.</Notice>}
      {errorCount > 0 && (
        <Notice kind="error">{plural(errorCount, "error")}, {plural(warningIssues.length, "warning")} &mdash; fix the errors to use this dataset.</Notice>
      )}
      {canUse && <Notice kind="success">Ready to use{warningIssues.length > 0 ? ` with ${plural(warningIssues.length, "warning")}` : ""}.</Notice>}
      {result && (
        <dl className="import-summary" aria-label="Import summary">
          {summaryFields(result.summary).map(([label, value]) => (
            <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
          ))}
        </dl>
      )}
      {(problems.length > 0 || (result?.issues.length ?? 0) > 0) && (
        <ul className="issue-list">
          {problems.map((p) => <li key={p} className="error">{p}</li>)}
          {result?.issues.map((i, k) => <li key={k} className={i.level}>{formatIssue(i, files)}</li>)}
        </ul>
      )}

      <div className="card-actions">
        <button type="button" className="btn primary" disabled={!canUse} onClick={use}>Use dataset</button>
        {files.length > 0 && <button type="button" className="btn" onClick={() => setFiles([])}>Clear</button>}
        {source.kind === "imported" && <button type="button" className="btn" onClick={reset}>Back to synthetic</button>}
      </div>
      <p className="muted small-text">
        <a href={DATA_SCHEMA_URL} target="_blank" rel="noreferrer">Data schema (docs/DATA_SCHEMA.md)</a>
        {SEP}
        <button type="button" className="btn small" onClick={() => downloadText("kpi_sample.csv", sampleKpiCsv())}>Download sample CSV</button>
      </p>
    </div>
  );
}

/** Right-hand "Data" drawer: lets the analyst replace the synthetic dataset with their own files. */
export function DataSourceDrawer({ open, onClose, onLoad, onReset, source }: DataSourceDrawerProps) {
  return (
    <Drawer open={open} onClose={onClose} title="Data source" width={520}>
      <DataSourceForm source={source} onLoad={onLoad} onReset={onReset} onClose={onClose} />
    </Drawer>
  );
}
