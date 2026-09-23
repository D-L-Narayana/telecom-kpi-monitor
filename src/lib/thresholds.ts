import type { KpiKey, Technology } from "../types/telecom";

/** "higher is worse" KPIs breach when value > threshold; "lower is worse" breach when value < threshold. */
export interface Threshold { warning: number; critical: number; direction: "above" | "below" }
export type Thresholds = Record<Exclude<KpiKey, "rsrpAvgDbm" | "sinrAvgDb"> | "dlThroughputMbpsNR", Threshold>;

export const DEFAULT_THRESHOLDS: Thresholds = {
  callDropRatePct: { warning: 1.0, critical: 2.0, direction: "above" },
  rrcSetupSuccessPct: { warning: 98, critical: 95, direction: "below" },
  handoverSuccessPct: { warning: 97, critical: 94, direction: "below" },
  latencyMs: { warning: 40, critical: 60, direction: "above" },
  dlThroughputMbps: { warning: 15, critical: 8, direction: "below" }, // LTE
  dlThroughputMbpsNR: { warning: 80, critical: 40, direction: "below" }, // NR
  ulThroughputMbps: { warning: 4, critical: 2, direction: "below" },
  prbUtilizationPct: { warning: 70, critical: 85, direction: "above" },
};

const KEY = "tkm.thresholds.v1";

export function loadThresholds(): Thresholds {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_THRESHOLDS, ...(JSON.parse(raw) as Partial<Thresholds>) };
  } catch { /* ignore */ }
  return DEFAULT_THRESHOLDS;
}
export function saveThresholds(t: Thresholds): void {
  localStorage.setItem(KEY, JSON.stringify(t));
}
export function resetThresholds(): Thresholds {
  localStorage.removeItem(KEY);
  return DEFAULT_THRESHOLDS;
}

export function thresholdFor(t: Thresholds, kpi: KpiKey, tech: Technology | "All"): Threshold | undefined {
  if (kpi === "rsrpAvgDbm" || kpi === "sinrAvgDb") return undefined;
  if (kpi === "dlThroughputMbps" && tech === "NR") return t.dlThroughputMbpsNR;
  return t[kpi];
}

export type Level = "ok" | "warning" | "critical";
export function classify(value: number | null | undefined, th: Threshold | undefined): Level {
  if (value === null || value === undefined || !th) return "ok";
  if (th.direction === "above") return value > th.critical ? "critical" : value > th.warning ? "warning" : "ok";
  return value < th.critical ? "critical" : value < th.warning ? "warning" : "ok";
}
