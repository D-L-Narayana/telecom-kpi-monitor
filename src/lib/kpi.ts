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

/** Per-interval network series (for sparklines / charts). */
export function seriesByInterval(samples: KpiSample[], kpi: KpiKey): { t: number; v: number | null }[] {
  const buckets = new Map<string, { vals: (number | null)[]; w: number[] }>();
  for (const s of samples) {
    const b = buckets.get(s.timestamp) ?? { vals: [], w: [] };
    b.vals.push(s[kpi]);
    b.w.push(s.activeUsers);
    buckets.set(s.timestamp, b);
  }
  return [...buckets.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([ts, b]) => ({ t: Date.parse(ts), v: mean(b.vals, b.w) }));
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

export interface Detection {
  kind: "outage" | "congestion" | "latency" | "drops";
  cellId: string;
  siteId: string;
  technology: Technology;
  intervals: number;
  firstSeen: string;
  lastSeen: string;
  detail: string;
}

/**
 * Rule-based fault / congestion detection over the window:
 *  - outage: >= 2 consecutive intervals with no counters (null KPIs)
 *  - congestion: >= 3 intervals with PRB utilization above the critical threshold
 *  - latency: >= 2 intervals with latency above the critical threshold
 *  - drops: >= 3 intervals with call drop rate above the critical threshold
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
    const push = (kind: Detection["kind"], hits: KpiSample[], min: number, detail: string) => {
      if (hits.length >= min) out.push({ kind, cellId, siteId: cell.siteId, technology: cell.technology, intervals: hits.length, firstSeen: hits[0].timestamp, lastSeen: hits[hits.length - 1].timestamp, detail });
    };
    const down = rows.filter((r) => r.prbUtilizationPct === null);
    // consecutive check for outage
    let run = 0;
    let maxRun = 0;
    for (const r of rows) {
      run = r.prbUtilizationPct === null ? run + 1 : 0;
      maxRun = Math.max(maxRun, run);
    }
    if (maxRun >= 2) push("outage", down, 2, `${down.length} intervals without counters (${(down.length * 15) / 60} h)`);
    const prbTh = thresholdFor(thresholds, "prbUtilizationPct", cell.technology)!;
    const cong = rows.filter((r) => (r.prbUtilizationPct ?? 0) > prbTh.critical);
    push("congestion", cong, 3, `PRB > ${prbTh.critical}% in ${cong.length} intervals; max ${Math.max(...cong.map((r) => r.prbUtilizationPct ?? 0)).toFixed(1)}%`);
    const latTh = thresholdFor(thresholds, "latencyMs", cell.technology)!;
    const lat = rows.filter((r) => (r.latencyMs ?? 0) > latTh.critical);
    push("latency", lat, 2, `latency > ${latTh.critical} ms in ${lat.length} intervals; max ${Math.max(...lat.map((r) => r.latencyMs ?? 0)).toFixed(0)} ms`);
    const cdrTh = thresholdFor(thresholds, "callDropRatePct", cell.technology)!;
    const drops = rows.filter((r) => (r.callDropRatePct ?? 0) > cdrTh.critical);
    push("drops", drops, 3, `CDR > ${cdrTh.critical}% in ${drops.length} intervals; max ${Math.max(...drops.map((r) => r.callDropRatePct ?? 0)).toFixed(2)}%`);
  }
  return out.sort((a, b) => (a.kind === "outage" ? -1 : b.kind === "outage" ? 1 : b.intervals - a.intervals));
}

export function fmt(v: number | null | undefined, decimals = 1): string {
  return v === null || v === undefined || Number.isNaN(v) ? "–" : v.toFixed(decimals);
}
