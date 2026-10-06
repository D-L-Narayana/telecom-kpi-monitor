/**
 * Alarm ↔ KPI correlation: does the KPI implied by an alarm's probable cause degrade while the alarm is raised?
 *
 * Three windows around the alarm are compared — baseline [raise − 2 h, raise), during [raise, clearedAt ?? dataset now]
 * and after (clear, clear + 2 h] — on the samples of the affected cell (or every cell of the site for site-level alarms).
 * Direction is taken from KPI_META: a positive `deltaPct` always means "worse". dB-scale KPIs (RSRP, SINR) are compared as
 * power ratios so that a 3 dB loss reads as a 50 % loss rather than a 3 % change of the dBm figure.
 */
import type { Alarm, Cell, KpiKey, KpiSample } from "../types/telecom";
import { KPI_META, detectIssues, mean, type Detection } from "./kpi";
import { classify, thresholdFor, type Thresholds } from "./thresholds";

const HOUR_MS = 3600e3;

/** Probable cause → the KPI that should react if the alarm is genuine. */
export const CAUSE_KPI: Record<string, KpiKey> = {
  "Cell down": "dlThroughputMbps",
  "High PRB utilization": "prbUtilizationPct",
  "Transmission link degraded": "latencyMs",
  "VSWR high": "rsrpAvgDbm",
  "Sleeping cell suspected": "prbUtilizationPct",
  "RRC setup success degraded": "rrcSetupSuccessPct",
  "Handover success degraded": "handoverSuccessPct",
  "Packet loss on backhaul": "latencyMs",
};

/** Keyword fallbacks for free-text causes from imported alarm feeds; first match wins. */
const CAUSE_KEYWORDS: [RegExp, KpiKey][] = [
  [/\b(down|outage|unavailable|throughput)\b/i, "dlThroughputMbps"],
  [/\b(prb|congest\w*|sleep\w*|overload\w*)\b/i, "prbUtilizationPct"],
  [/\b(latency|transmission|backhaul|delay|jitter|packet loss)\b/i, "latencyMs"],
  [/\b(vswr|antenna|rsrp|coverage)\b/i, "rsrpAvgDbm"],
  [/\b(sinr|interference)\b/i, "sinrAvgDb"],
  [/\b(handover|ho)\b/i, "handoverSuccessPct"],
  [/\b(rrc|accessibility|setup)\b/i, "rrcSetupSuccessPct"],
  [/\bdrop\w*\b/i, "callDropRatePct"],
];

export function kpiForCause(cause: string): KpiKey {
  const exact = CAUSE_KPI[cause];
  if (exact && KPI_META[exact]) return exact;
  const lower = cause.toLowerCase();
  for (const [key, kpi] of Object.entries(CAUSE_KPI)) if (key.toLowerCase() === lower) return kpi;
  for (const [re, kpi] of CAUSE_KEYWORDS) if (re.test(cause)) return kpi;
  return "callDropRatePct";
}

export type CorrelationVerdict = "strong" | "weak" | "none" | "insufficient";

export interface AlarmCorrelation {
  alarmId: string;
  kpi: KpiKey;
  cellIds: string[];
  /** Mean KPI over [raise − 2 h, raise). */
  baseline: number | null;
  /** Mean KPI over [raise, clearedAt ?? dataset now]. */
  during: number | null;
  /** Mean KPI over (clear, clear + 2 h]; null while the alarm is not cleared. */
  after: number | null;
  /** Worst hourly mean within the impact horizon after the raise (direction-aware). */
  peak: number | null;
  /** Relative worsening baseline → during in %, positive = worse. */
  deltaPct: number | null;
  /** Relative worsening baseline → peak in %, positive = worse. */
  peakDeltaPct: number | null;
  /** Share of measured "during" samples whose KPI breaches the warning or critical threshold (0 when the KPI has none). */
  breachFraction: number;
  /** "During" samples without counters (cell down). */
  downIntervals: number;
  /** 0.6 × clamp(peakDeltaPct / 50) + 0.4 × breachFraction; 1 when downIntervals ≥ 2. */
  score: number;
  verdict: CorrelationVerdict;
  /** Rule-based detections over the "during" samples of the affected cells. */
  detections: Detection[];
}

export interface CorrelationOptions {
  /** Length of the baseline window before the raise (default 2 h). */
  baselineMs?: number;
  /** Length of the recovery window after clearance (default 2 h). */
  afterMs?: number;
  /** How long after the raise the peak is searched for (default 2 h); the "during" mean always spans the whole alarm. */
  peakHorizonMs?: number;
  /** Bucket used for the peak search, aligned to the raise instant (default 1 h). */
  peakBucketMs?: number;
}

export const DEFAULT_CORRELATION_OPTIONS: Required<CorrelationOptions> = { baselineMs: 2 * HOUR_MS, afterMs: 2 * HOUR_MS, peakHorizonMs: 2 * HOUR_MS, peakBucketMs: HOUR_MS };

const DB_KPIS: ReadonlySet<KpiKey> = new Set<KpiKey>(["rsrpAvgDbm", "sinrAvgDb"]);
const toLinear = (kpi: KpiKey, v: number): number => (DB_KPIS.has(kpi) ? Math.pow(10, v / 10) : v);

/** Relative worsening from `reference` to `value` in %, positive = worse for this KPI; null when undefined. */
export function worseningPct(kpi: KpiKey, reference: number | null, value: number | null): number | null {
  if (reference === null || value === null || !Number.isFinite(reference) || !Number.isFinite(value)) return null;
  const r = toLinear(kpi, reference);
  const v = toLinear(kpi, value);
  if (r === 0) return null;
  const change = ((v - r) / Math.abs(r)) * 100;
  return KPI_META[kpi].higherIsBetter ? -change : change;
}

/** Groups samples per cell, each group sorted by timestamp ascending. */
export function indexSamplesByCell(samples: KpiSample[]): Map<string, KpiSample[]> {
  const groups = new Map<string, KpiSample[]>();
  for (const s of samples) {
    const g = groups.get(s.cellId);
    if (g) g.push(s);
    else groups.set(s.cellId, [s]);
  }
  for (const [cellId, rows] of groups) {
    groups.set(cellId, rows.map((r) => [Date.parse(r.timestamp), r] as const).sort((a, b) => a[0] - b[0]).map(([, r]) => r));
  }
  return groups;
}

/** First index whose timestamp is >= t (rows sorted ascending). */
function lowerBound(rows: KpiSample[], t: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (Date.parse(rows[mid].timestamp) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose timestamp is > t (rows sorted ascending). */
function upperBound(rows: KpiSample[], t: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (Date.parse(rows[mid].timestamp) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface WindowRow { t: number; cell: Cell; sample: KpiSample }

function affectedCells(alarm: Alarm, cells: Map<string, Cell>): Cell[] {
  if (alarm.cellId) {
    const c = cells.get(alarm.cellId);
    return c ? [c] : [];
  }
  return [...cells.values()].filter((c) => c.siteId === alarm.siteId).sort((a, b) => (a.cellId < b.cellId ? -1 : a.cellId > b.cellId ? 1 : 0));
}

function collect(byCell: Map<string, KpiSample[]>, targets: Cell[], from: number, to: number, fromInclusive: boolean, toInclusive: boolean): WindowRow[] {
  const out: WindowRow[] = [];
  if (!(from <= to)) return out;
  for (const cell of targets) {
    const rows = byCell.get(cell.cellId);
    if (!rows || rows.length === 0) continue;
    const start = fromInclusive ? lowerBound(rows, from) : upperBound(rows, from);
    const end = toInclusive ? upperBound(rows, to) : lowerBound(rows, to);
    for (let i = start; i < end; i++) out.push({ t: Date.parse(rows[i].timestamp), cell, sample: rows[i] });
  }
  return out;
}

const windowMean = (kpi: KpiKey, rows: WindowRow[]): number | null => mean(rows.map((r) => r.sample[kpi]));

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

export function correlateAlarm(alarm: Alarm, byCell: Map<string, KpiSample[]>, cells: Map<string, Cell>, thresholds: Thresholds, datasetNowIso: string, options: CorrelationOptions = {}): AlarmCorrelation {
  const opts = { ...DEFAULT_CORRELATION_OPTIONS, ...options };
  const kpi = kpiForCause(alarm.probableCause);
  const targets = affectedCells(alarm, cells);
  const raise = Date.parse(alarm.timestamp);
  const clear = alarm.clearedAt ? Date.parse(alarm.clearedAt) : null;
  const datasetNow = Date.parse(datasetNowIso);
  const duringEnd = clear ?? datasetNow;

  const baselineRows = collect(byCell, targets, raise - opts.baselineMs, raise, true, false);
  const duringRows = collect(byCell, targets, raise, duringEnd, true, true);
  const afterRows = clear === null ? [] : collect(byCell, targets, clear, clear + opts.afterMs, false, true);

  const baseline = windowMean(kpi, baselineRows);
  const during = windowMean(kpi, duringRows);
  const after = clear === null ? null : windowMean(kpi, afterRows);

  // peak: worst bucket mean (buckets aligned to the raise) within the impact horizon
  const buckets = new Map<number, (number | null)[]>();
  const horizonEnd = raise + opts.peakHorizonMs;
  for (const r of duringRows) {
    if (r.t > horizonEnd) continue;
    const key = Math.floor((r.t - raise) / opts.peakBucketMs);
    const b = buckets.get(key);
    if (b) b.push(r.sample[kpi]);
    else buckets.set(key, [r.sample[kpi]]);
  }
  let peak: number | null = null;
  const higherIsBetter = KPI_META[kpi].higherIsBetter;
  for (const vals of buckets.values()) {
    const m = mean(vals);
    if (m === null) continue;
    if (peak === null || (higherIsBetter ? m < peak : m > peak)) peak = m;
  }

  let measured = 0;
  let breached = 0;
  let downIntervals = 0;
  for (const r of duringRows) {
    if (r.sample.prbUtilizationPct === null) downIntervals++;
    const v = r.sample[kpi];
    if (v === null) continue;
    measured++;
    if (classify(v, thresholdFor(thresholds, kpi, r.cell.technology)) !== "ok") breached++;
  }
  const breachFraction = measured === 0 ? 0 : breached / measured;

  const deltaPct = worseningPct(kpi, baseline, during);
  const peakDeltaPct = worseningPct(kpi, baseline, peak);
  const score = downIntervals >= 2 ? 1 : 0.6 * clamp01((peakDeltaPct ?? 0) / 50) + 0.4 * breachFraction;
  const noEvidence = downIntervals < 2 && (baseline === null || measured === 0);
  const verdict: CorrelationVerdict = noEvidence ? "insufficient" : score >= 0.5 ? "strong" : score >= 0.2 ? "weak" : "none";

  const detections = duringRows.length ? detectIssues(duringRows.map((r) => r.sample), cells, thresholds) : [];

  return { alarmId: alarm.alarmId, kpi, cellIds: targets.map((c) => c.cellId), baseline, during, after, peak, deltaPct, peakDeltaPct, breachFraction, downIntervals, score, verdict, detections };
}
