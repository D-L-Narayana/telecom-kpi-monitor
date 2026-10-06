import type { Cell, KpiKey, KpiSample, Technology } from "../types/telecom";
import type { Thresholds } from "./thresholds";
import { classify, thresholdFor } from "./thresholds";

export const KPI_META: Record<KpiKey, { label: string; unit: string; decimals: number; higherIsBetter: boolean }> = {
  callDropRatePct: { label: "Call drop rate", unit: "%", decimals: 2, higherIsBetter: false },
  rrcSetupSuccessPct: { label: "RRC setup success", unit: "%", decimals: 2, higherIsBetter: true },
  handoverSuccessPct: { label: "Handover success", unit: "%", decimals: 2, higherIsBetter: true },
  dlThroughputMbps: { label: "DL throughput", unit: "Mbps", decimals: 1, higherIsBetter: true },
  ulThroughputMbps: { label: "UL throughput", unit: "Mbps", decimals: 1, higherIsBetter: true },
  latencyMs: { label: "Latency (RTT)", unit: "ms", decimals: 1, higherIsBetter: false },
  prbUtilizationPct: { label: "PRB utilization", unit: "%", decimals: 1, higherIsBetter: false },
  rsrpAvgDbm: { label: "RSRP", unit: "dBm", decimals: 1, higherIsBetter: true },
  sinrAvgDb: { label: "SINR", unit: "dB", decimals: 1, higherIsBetter: true },
};
export const CORE_KPIS: KpiKey[] = ["callDropRatePct", "rrcSetupSuccessPct", "handoverSuccessPct", "dlThroughputMbps", "ulThroughputMbps", "latencyMs", "prbUtilizationPct"];

/** Ratio KPIs from raw counters (PLAN.md formulas). */
export const callDropRatePct = (dropped: number, completed: number) => (dropped + completed === 0 ? 0 : (dropped / (dropped + completed)) * 100);
export const successPct = (success: number, attempts: number) => (attempts === 0 ? 0 : (success / attempts) * 100);
export const prbUtilizationPct = (used: number, available: number) => (available === 0 ? 0 : (used / available) * 100);

/** Mean of non-null values, weighted by active users when weights are given (traffic-weighted network KPI). */
export function mean(values: (number | null | undefined)[], weights?: number[]): number | null {
  let s = 0;
  let w = 0;
  values.forEach((v, i) => {
    if (v === null || v === undefined || Number.isNaN(v)) return;
    const wi = weights ? Math.max(weights[i], 1) : 1;
    s += v * wi;
    w += wi;
  });
  return w === 0 ? null : s / w;
}

/**
 * Percentile with linear interpolation between ranks (the "R-7" method used by spreadsheets and NumPy's default).
 * Null, undefined and non-finite values are ignored; `p` is clamped to 0..100. Returns null when nothing is left.
 */
export function percentile(values: (number | null | undefined)[], p: number): number | null {
  const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const pos = ((xs.length - 1) * Math.min(100, Math.max(0, p))) / 100;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? xs[lo] : xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}

/** Relative change in percent, `(current - previous) / |previous| * 100`; null when either side is missing or previous is 0. */
export function deltaPct(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0 || !Number.isFinite(current) || !Number.isFinite(previous)) return null;
  return ((current - previous) * 100) / Math.abs(previous);
}

/** Share (0..100) of intervals that reported counters (`prbUtilizationPct` not null); null when there are no rows. */
export function availabilityPct(rows: KpiSample[]): number | null {
  if (rows.length === 0) return null;
  let up = 0;
  for (const r of rows) if (r.prbUtilizationPct !== null) up++;
  return (up * 100) / rows.length;
}

export type TimeRange = "1h" | "6h" | "24h" | "7d";
export const RANGE_MS: Record<TimeRange, number> = { "1h": 3600e3, "6h": 6 * 3600e3, "24h": 24 * 3600e3, "7d": 7 * 24 * 3600e3 };

export function inWindow(samples: KpiSample[], end: number, rangeMs: number): KpiSample[] {
  const startIso = new Date(end - rangeMs).toISOString();
  const endIso = new Date(end).toISOString();
  return samples.filter((s) => s.timestamp > startIso && s.timestamp <= endIso);
}

export function filterTech(samples: KpiSample[], cells: Map<string, Cell>, tech: Technology | "All"): KpiSample[] {
  return tech === "All" ? samples : samples.filter((s) => cells.get(s.cellId)?.technology === tech);
}

/** Network-wide value of a KPI over a set of samples (user-weighted, except throughput which is a plain mean per cell). */
export function networkKpi(samples: KpiSample[], kpi: KpiKey): number | null {
  const weighted = kpi === "callDropRatePct" || kpi === "rrcSetupSuccessPct" || kpi === "handoverSuccessPct" || kpi === "latencyMs";
  return mean(samples.map((s) => s[kpi]), weighted ? samples.map((s) => s.activeUsers) : undefined);
}

/**
 * Network series for sparklines / charts: one user-weighted point per reporting interval, or — when `bucketMs` is
 * given — one point per bucket of `floor(t / bucketMs) * bucketMs` (e.g. 3600e3 collapses four 15-minute intervals
 * into an hourly point). Points are sorted by time; a bucket whose values are all null yields `v: null`.
 */
export function seriesByInterval(samples: KpiSample[], kpi: KpiKey, bucketMs?: number): { t: number; v: number | null }[] {
  const useBucket = bucketMs !== undefined && Number.isFinite(bucketMs) && bucketMs > 0;
  const buckets = new Map<number, { vals: (number | null)[]; w: number[] }>();
  for (const s of samples) {
    const t = Date.parse(s.timestamp);
    if (!Number.isFinite(t)) continue;
    const key = useBucket ? Math.floor(t / bucketMs) * bucketMs : t;
    const b = buckets.get(key) ?? { vals: [], w: [] };
    b.vals.push(s[kpi]);
    b.w.push(s.activeUsers);
    buckets.set(key, b);
  }
  return [...buckets.entries()].sort(([a], [b]) => a - b).map(([t, b]) => ({ t, v: mean(b.vals, b.w) }));
}

export interface CellAggregate {
  cellId: string;
  siteId: string;
  technology: Technology;
  samples: number;
  downIntervals: number;
  values: Record<KpiKey, number | null>;
  worstLevel: "ok" | "warning" | "critical";
  breaches: number;
}

/** Aggregate every KPI per cell over the given samples and classify against thresholds. */
export function aggregateByCell(samples: KpiSample[], cells: Map<string, Cell>, thresholds: Thresholds): CellAggregate[] {
  const groups = new Map<string, KpiSample[]>();
  for (const s of samples) {
    const g = groups.get(s.cellId);
    if (g) g.push(s);
    else groups.set(s.cellId, [s]);
  }
  const out: CellAggregate[] = [];
  for (const [cellId, rows] of groups) {
    const cell = cells.get(cellId);
    if (!cell) continue;
    const values = {} as Record<KpiKey, number | null>;
    let worst: CellAggregate["worstLevel"] = "ok";
    let breaches = 0;
    (Object.keys(KPI_META) as KpiKey[]).forEach((k) => {
      values[k] = mean(rows.map((r) => r[k]));
      const lvl = classify(values[k], thresholdFor(thresholds, k, cell.technology));
      if (lvl !== "ok") breaches++;
      if (lvl === "critical" || (lvl === "warning" && worst === "ok")) worst = lvl;
    });
    out.push({ cellId, siteId: cell.siteId, technology: cell.technology, samples: rows.length, downIntervals: rows.filter((r) => r.prbUtilizationPct === null).length, values, worstLevel: worst, breaches });
  }
  return out;
}

export type DetectionKind = "outage" | "congestion" | "latency" | "drops" | "sleeping";

/** KPI to open in the analysis page for each detection kind. */
export const DETECTION_KPI: Record<DetectionKind, KpiKey> = {
  outage: "dlThroughputMbps",
  congestion: "prbUtilizationPct",
  latency: "latencyMs",
  drops: "callDropRatePct",
  sleeping: "prbUtilizationPct",
};

export interface Detection {
  kind: DetectionKind;
  cellId: string;
  siteId: string;
  technology: Technology;
  intervals: number;
  firstSeen: string;
  lastSeen: string;
  detail: string;
}

/** Minimum number of consecutive low-traffic intervals before a cell counts as sleeping. */
const SLEEPING_MIN_RUN = 4;
/** A cell is sleeping when its active users stay at or below max(this floor, 10 % of its window median). */
const SLEEPING_USER_FLOOR = 2;

const KIND_RANK: Record<DetectionKind, number> = { outage: 0, congestion: 1, latency: 2, drops: 3, sleeping: 4 };

/**
 * Total order for detections: outages first, then longer detections first, then by cell id; detections of the same
 * length on the same cell are ordered by kind. Being a strict total order it is safe for `Array.prototype.sort`
 * (the same input always sorts the same way, whatever its initial order).
 */
export function compareDetections(a: Detection, b: Detection): number {
  const outage = (a.kind === "outage" ? 0 : 1) - (b.kind === "outage" ? 0 : 1);
  if (outage !== 0) return outage;
  if (a.intervals !== b.intervals) return b.intervals - a.intervals;
  if (a.cellId !== b.cellId) return a.cellId < b.cellId ? -1 : 1;
  return KIND_RANK[a.kind] - KIND_RANK[b.kind];
}

/** Longest run of consecutive rows (in the given order) matching `pred`: start index and length (first run wins ties). */
function longestRun<T>(rows: T[], pred: (r: T) => boolean): { start: number; length: number } {
  let best = { start: 0, length: 0 };
  let start = 0;
  let run = 0;
  rows.forEach((r, i) => {
    if (pred(r)) {
      if (run === 0) start = i;
      run++;
      if (run > best.length) best = { start, length: run };
    } else {
      run = 0;
    }
  });
  return best;
}

/**
 * Rule-based fault / congestion detection over the window:
 *  - outage: >= 2 consecutive intervals with no counters (null KPIs); the longest such run is reported
 *  - congestion: >= 3 intervals with PRB utilization above the critical threshold
 *  - latency: >= 2 intervals with latency above the critical threshold
 *  - drops: >= 3 intervals with call drop rate above the critical threshold
 *  - sleeping: >= 4 consecutive intervals that report counters but at most max(2, 10 % of the cell's window median)
 *    active users (a cell that is "up" yet carries no traffic); the longest such run is reported
 * At most one detection per kind and cell; the result is sorted with `compareDetections`.
 */
export function detectIssues(samples: KpiSample[], cells: Map<string, Cell>, thresholds: Thresholds): Detection[] {
  const byCell = new Map<string, KpiSample[]>();
  for (const s of samples) {
    const g = byCell.get(s.cellId);
    if (g) g.push(s);
    else byCell.set(s.cellId, [s]);
  }
  const out: Detection[] = [];
  for (const [cellId, rowsUnsorted] of byCell) {
    const cell = cells.get(cellId);
    if (!cell) continue;
    const rows = [...rowsUnsorted].sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
    const push = (kind: DetectionKind, hits: KpiSample[], min: number, detail: string) => {
      if (hits.length >= min) out.push({ kind, cellId, siteId: cell.siteId, technology: cell.technology, intervals: hits.length, firstSeen: hits[0].timestamp, lastSeen: hits[hits.length - 1].timestamp, detail });
    };

    const isDown = (r: KpiSample) => r.prbUtilizationPct === null;
    const downRun = longestRun(rows, isDown);
    if (downRun.length >= 2) {
      const run = rows.slice(downRun.start, downRun.start + downRun.length);
      const totalDown = rows.filter(isDown).length;
      const extra = totalDown > run.length ? `; ${totalDown} intervals down in total` : "";
      push("outage", run, 2, `${run.length} consecutive intervals without counters (${(run.length * 15) / 60} h)${extra}`);
    }

    const prbTh = thresholdFor(thresholds, "prbUtilizationPct", cell.technology)!;
    const cong = rows.filter((r) => (r.prbUtilizationPct ?? 0) > prbTh.critical);
    push("congestion", cong, 3, `PRB > ${prbTh.critical}% in ${cong.length} intervals; max ${Math.max(...cong.map((r) => r.prbUtilizationPct ?? 0)).toFixed(1)}%`);
    const latTh = thresholdFor(thresholds, "latencyMs", cell.technology)!;
    const lat = rows.filter((r) => (r.latencyMs ?? 0) > latTh.critical);
    push("latency", lat, 2, `latency > ${latTh.critical} ms in ${lat.length} intervals; max ${Math.max(...lat.map((r) => r.latencyMs ?? 0)).toFixed(0)} ms`);
    const cdrTh = thresholdFor(thresholds, "callDropRatePct", cell.technology)!;
    const drops = rows.filter((r) => (r.callDropRatePct ?? 0) > cdrTh.critical);
    push("drops", drops, 3, `CDR > ${cdrTh.critical}% in ${drops.length} intervals; max ${Math.max(...drops.map((r) => r.callDropRatePct ?? 0)).toFixed(2)}%`);

    // sleeping cell: counters present, but (almost) no users for a sustained run; the median is taken over the
    // intervals that reported counters so that down intervals (0 users by construction) do not distort it
    const upRows = rows.filter((r) => !isDown(r));
    const median = percentile(upRows.map((r) => r.activeUsers), 50);
    if (median !== null) {
      const limit = Math.max(SLEEPING_USER_FLOOR, 0.1 * median);
      const sleepRun = longestRun(rows, (r) => !isDown(r) && r.activeUsers <= limit);
      if (sleepRun.length >= SLEEPING_MIN_RUN) {
        const run = rows.slice(sleepRun.start, sleepRun.start + sleepRun.length);
        push("sleeping", run, SLEEPING_MIN_RUN, `counters present but ≤ ${limit.toFixed(1)} active users for ${run.length} consecutive intervals (cell median ${median.toFixed(0)})`);
      }
    }
  }
  return out.sort(compareDetections);
}

export function fmt(v: number | null | undefined, decimals = 1): string {
  return v === null || v === undefined || Number.isNaN(v) ? "–" : v.toFixed(decimals);
}
