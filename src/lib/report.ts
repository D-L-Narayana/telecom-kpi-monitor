/**
 * Shift handover report: a snapshot of the current analysis window — network KPIs with previous-window
 * deltas and threshold levels, rule-based detections, the worst cells, alarm counts and the alarms raised
 * or cleared inside the window — rendered as Markdown or as CSV sections.
 *
 * Everything in this module is pure. `buildShiftReport` takes the dataset clock (`now`) from its input and
 * never reads the wall clock, so the same input always yields the same report, Markdown text and file names.
 * Times in the Markdown and CSV output are the ISO 8601 UTC strings stored in the dataset; only the file
 * name stamps the window end in IST (UTC+05:30), the zone the dashboard displays.
 */
import type { Alarm, Cell, KpiKey, KpiSample, Severity, Site, Technology } from "../types/telecom";
import { CORE_KPIS, KPI_META, RANGE_MS, aggregateByCell, deltaPct, detectIssues, fmt, networkKpi, type CellAggregate, type Detection, type TimeRange } from "./kpi";
import { classify, thresholdFor, type Level, type Thresholds } from "./thresholds";
import { toCsv } from "./csv";

export interface ShiftReportInput {
  /** Dataset clock (ms since epoch): the end of the window and the report's generation time. */
  now: number;
  range: TimeRange;
  tech: Technology | "All";
  /** Samples of the current window, already filtered by technology. */
  samples: KpiSample[];
  /** Samples of the window of the same length that precedes the current one. */
  prevSamples: KpiSample[];
  cells: Map<string, Cell>;
  sites: Site[];
  /** All alarms of the dataset (with operator overrides applied); the report filters them by technology and window. */
  alarms: Alarm[];
  thresholds: Thresholds;
  source: { kind: string; label: string };
  notes?: string;
}

export interface ShiftReportKpi {
  kpi: KpiKey;
  label: string;
  unit: string;
  value: number | null;
  previous: number | null;
  deltaPct: number | null;
  level: Level;
}

export interface ShiftReportAlarms {
  /** Alarms currently in the `active` state (whole dataset, technology-filtered). */
  active: number;
  /** Alarms currently acknowledged but not cleared. */
  acknowledged: number;
  /** Unresolved (active + acknowledged) alarms per severity; every severity is present. */
  bySeverity: Record<Severity, number>;
  /** Alarms raised inside the window (inclusive boundaries), newest first. */
  raisedInWindow: Alarm[];
  /** Alarms whose clearance falls inside the window (inclusive boundaries), most recently cleared first. */
  clearedInWindow: Alarm[];
}

export interface ShiftReport {
  generatedAt: string;
  window: { start: string; end: string; range: TimeRange; tech: Technology | "All" };
  source: { kind: string; label: string };
  kpis: ShiftReportKpi[];
  detections: Detection[];
  worstCells: CellAggregate[];
  alarms: ShiftReportAlarms;
  notes: string;
}

export interface ReportCsvSection { name: string; csv: string }

/** localStorage key for the operator's handover notes (kept per browser, independent of the dataset). */
export const REPORT_NOTES_KEY = "tkm.report.notes.v1";
/** Alarm rows listed per Markdown list before the "… and N more" line. CSV sections are never truncated. */
export const MAX_ALARM_LINES = 25;
/** Cells in the "worst cells" table — the ranking used by the Overview page. */
export const WORST_CELLS = 10;

const SEVERITIES: readonly Severity[] = ["Critical", "Major", "Minor", "Warning"];
const IST_OFFSET_MS = 5.5 * 3600e3;
const LEVEL_LABEL: Record<Level, string> = { ok: "OK", warning: "Warning", critical: "Critical" };
const DASH = "–";

const KPI_COLUMNS = ["kpi", "label", "unit", "value", "previous", "deltaPct", "level"];
const DETECTION_COLUMNS = ["kind", "cellId", "siteId", "technology", "intervals", "firstSeen", "lastSeen", "detail"];
const WORST_CELL_COLUMNS = ["rank", "cellId", "siteId", "technology", "worstLevel", "breaches", "downIntervals", "samples", ...(Object.keys(KPI_META) as KpiKey[])];
const ALARM_COLUMNS = ["alarmId", "timestamp", "clearedAt", "siteId", "cellId", "technology", "severity", "probableCause", "state"];

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Worst first: highest mean call drop rate (cells without counters rank first), then most breaches, then cell id. */
function compareWorstCells(a: CellAggregate, b: CellAggregate): number {
  const cdr = (c: CellAggregate) => c.values.callDropRatePct ?? 99;
  return cdr(b) - cdr(a) || b.breaches - a.breaches || compareIds(a.cellId, b.cellId);
}

/** Newest first by the given time, alarm id as the tiebreaker so the order never depends on the input order. */
function newestFirst(time: (a: Alarm) => string): (a: Alarm, b: Alarm) => number {
  return (a, b) => {
    const ta = time(a);
    const tb = time(b);
    return ta === tb ? compareIds(a.alarmId, b.alarmId) : ta < tb ? 1 : -1;
  };
}

export function buildShiftReport(input: ShiftReportInput): ShiftReport {
  const { now, range, tech, samples, prevSamples, cells, thresholds } = input;
  const startMs = now - RANGE_MS[range];
  const end = new Date(now).toISOString();
  const start = new Date(startMs).toISOString();

  // The previous window is only comparable when it holds at least half as many samples (the Overview rule).
  const comparable = prevSamples.length >= samples.length / 2;
  const kpis = CORE_KPIS.map((kpi): ShiftReportKpi => {
    const value = networkKpi(samples, kpi);
    const previous = comparable ? networkKpi(prevSamples, kpi) : null;
    const { label, unit } = KPI_META[kpi];
    return { kpi, label, unit, value, previous, deltaPct: deltaPct(value, previous), level: classify(value, thresholdFor(thresholds, kpi, tech)) };
  });

  const detections = detectIssues(samples, cells, thresholds);
  const worstCells = aggregateByCell(samples, cells, thresholds).sort(compareWorstCells).slice(0, WORST_CELLS);

  // Site-level alarms carry no technology and stay visible under an LTE / NR filter.
  const alarms = input.alarms.filter((a) => tech === "All" || !a.technology || a.technology === tech);
  const bySeverity: Record<Severity, number> = { Critical: 0, Major: 0, Minor: 0, Warning: 0 };
  let active = 0;
  let acknowledged = 0;
  for (const a of alarms) {
    if (a.state === "active") active++;
    else if (a.state === "acknowledged") acknowledged++;
    if (a.state !== "cleared" && a.severity in bySeverity) bySeverity[a.severity]++;
  }
  const inWindow = (iso: string | undefined): boolean => {
    if (!iso) return false;
    const t = Date.parse(iso);
    return Number.isFinite(t) && t >= startMs && t <= now;
  };
  const raisedInWindow = alarms.filter((a) => inWindow(a.timestamp)).sort(newestFirst((a) => a.timestamp));
  const clearedInWindow = alarms.filter((a) => inWindow(a.clearedAt)).sort(newestFirst((a) => a.clearedAt ?? ""));

  return {
    generatedAt: end,
    window: { start, end, range, tech },
    source: { kind: input.source.kind, label: input.source.label },
    kpis,
    detections,
    worstCells,
    alarms: { active, acknowledged, bySeverity, raisedInWindow, clearedInWindow },
    notes: input.notes ?? "",
  };
}

/* ---------- Markdown ---------- */

type MdCell = string | number | null | undefined;

/** Table cell text: a dash for missing values, line breaks flattened, pipes escaped so the table stays intact. */
function mdCell(v: MdCell): string {
  if (v === null || v === undefined || v === "") return DASH;
  return String(v).replace(/\r\n|\r|\n/g, " ").replace(/\|/g, "\\|");
}

function mdTable(header: string[], rows: MdCell[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map((r) => line(r.map(mdCell)))].join("\n");
}

/** KPI value with its unit and the KPI's display precision (e.g. `0.84 %`), or a dash when missing. */
export function fmtKpiValue(v: number | null, kpi: KpiKey): string {
  const { decimals, unit } = KPI_META[kpi];
  return v === null || Number.isNaN(v) ? DASH : `${fmt(v, decimals)} ${unit}`;
}

/** Signed relative change with one decimal, e.g. `+12.3` or `-4.0`. */
export function fmtDelta(d: number | null): string {
  return d === null || Number.isNaN(d) ? DASH : `${d > 0 ? "+" : ""}${d.toFixed(1)}`;
}

function alarmTable(list: Alarm[], cleared: boolean): string {
  if (list.length === 0) return cleared ? "No alarms cleared in this window." : "No alarms raised in this window.";
  const shown = list.slice(0, MAX_ALARM_LINES);
  const header = ["Alarm", "Severity", "Site", "Cell", "Cause", "Raised", cleared ? "Cleared" : "State"];
  const rows = shown.map((a) => [a.alarmId, a.severity, a.siteId, a.cellId, a.probableCause, a.timestamp, cleared ? a.clearedAt : a.state]);
  const more = list.length > shown.length ? `\n\n… and ${list.length - shown.length} more` : "";
  return mdTable(header, rows) + more;
}

/** Markdown rendering of a report. Pure: identical reports give identical text. Times are ISO 8601 UTC. */
export function reportToMarkdown(r: ShiftReport): string {
  const { window: w, alarms: al } = r;
  const parts: string[] = [
    "# Shift handover report",
    "## Window",
    mdTable(["Field", "Value"], [
      ["Start", w.start], ["End", w.end], ["Range", w.range], ["Technology", w.tech],
      ["Source", `${r.source.label} (${r.source.kind})`], ["Generated at", r.generatedAt],
    ]),
    "All times are ISO 8601 (UTC).",
    "## KPIs",
    mdTable(["KPI", "Value", "Previous", "Δ %", "Status"], r.kpis.map((k) => [k.label, fmtKpiValue(k.value, k.kpi), fmtKpiValue(k.previous, k.kpi), fmtDelta(k.deltaPct), LEVEL_LABEL[k.level]])),
    "## Detections",
    r.detections.length === 0
      ? "No rule-based detections in this window."
      : mdTable(["Kind", "Cell", "Site", "Tech", "Intervals", "First seen", "Last seen", "Detail"], r.detections.map((d) => [d.kind, d.cellId, d.siteId, d.technology, d.intervals, d.firstSeen, d.lastSeen, d.detail])),
    "## Worst cells",
    r.worstCells.length === 0
      ? "No cells reported samples in this window."
      : mdTable(
        ["#", "Cell", "Site", "Tech", "Status", "CDR %", "RRC %", "HO %", "DL Mbps", "UL Mbps", "Latency ms", "PRB %", "Breaches", "Down intervals"],
        r.worstCells.map((c, i) => [
          i + 1, c.cellId, c.siteId, c.technology, LEVEL_LABEL[c.worstLevel],
          fmt(c.values.callDropRatePct, 2), fmt(c.values.rrcSetupSuccessPct, 2), fmt(c.values.handoverSuccessPct, 2),
          fmt(c.values.dlThroughputMbps, 1), fmt(c.values.ulThroughputMbps, 1), fmt(c.values.latencyMs, 1), fmt(c.values.prbUtilizationPct, 1),
          c.breaches, c.downIntervals,
        ]),
      ),
    "## Alarms",
    mdTable(["Alarms", "Count"], [
      ["Active", al.active], ["Acknowledged", al.acknowledged],
      ...SEVERITIES.map((s): MdCell[] => [`Unresolved ${s}`, al.bySeverity[s] ?? 0]),
    ]),
    `### Raised in window (${al.raisedInWindow.length})`,
    alarmTable(al.raisedInWindow, false),
    `### Cleared in window (${al.clearedInWindow.length})`,
    alarmTable(al.clearedInWindow, true),
    "## Notes",
    r.notes.trim() === "" ? "(none)" : r.notes.trim(),
  ];
  return `${parts.join("\n\n")}\n`;
}

/* ---------- CSV ---------- */

/** `toCsv` yields "" for no rows; a section always keeps its header so an empty export is still a valid file. */
function csvSection(rows: Record<string, unknown>[], columns: string[]): string {
  return rows.length === 0 ? columns.join(",") : toCsv(rows, columns);
}

function alarmRow(a: Alarm): Record<string, unknown> {
  return {
    alarmId: a.alarmId, timestamp: a.timestamp, clearedAt: a.clearedAt ?? "", siteId: a.siteId, cellId: a.cellId ?? "",
    technology: a.technology ?? "", severity: a.severity, probableCause: a.probableCause, state: a.state,
  };
}

/** CSV sections (`kpis`, `detections`, `worst_cells`, `alarms_raised`, `alarms_cleared`) with explicit columns; never truncated. */
export function reportToCsvSections(r: ShiftReport): ReportCsvSection[] {
  return [
    { name: "kpis", csv: csvSection(r.kpis.map((k) => ({ ...k })), KPI_COLUMNS) },
    { name: "detections", csv: csvSection(r.detections.map((d) => ({ ...d })), DETECTION_COLUMNS) },
    {
      name: "worst_cells",
      csv: csvSection(r.worstCells.map((c, i) => ({
        rank: i + 1, cellId: c.cellId, siteId: c.siteId, technology: c.technology, worstLevel: c.worstLevel,
        breaches: c.breaches, downIntervals: c.downIntervals, samples: c.samples, ...c.values,
      })), WORST_CELL_COLUMNS),
    },
    { name: "alarms_raised", csv: csvSection(r.alarms.raisedInWindow.map(alarmRow), ALARM_COLUMNS) },
    { name: "alarms_cleared", csv: csvSection(r.alarms.clearedInWindow.map(alarmRow), ALARM_COLUMNS) },
  ];
}

/* ---------- file names ---------- */

/** `shift-report_<YYYYMMDD-HHMM>_<range>_<tech>[_<section>].<ext>`; the stamp is the window end in IST (UTC+05:30). */
export function reportFilename(r: ShiftReport, ext: "md" | "csv", section?: string): string {
  const ist = new Date(Date.parse(r.window.end) + IST_OFFSET_MS);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const stamp = `${ist.getUTCFullYear()}${p2(ist.getUTCMonth() + 1)}${p2(ist.getUTCDate())}-${p2(ist.getUTCHours())}${p2(ist.getUTCMinutes())}`;
  return `shift-report_${stamp}_${r.window.range}_${r.window.tech}${section ? `_${section}` : ""}.${ext}`;
}
