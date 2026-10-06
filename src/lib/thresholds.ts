/**
 * KPI thresholds: defaults, presets, validation, JSON import/export and browser persistence.
 *
 * Every threshold set that enters the app from outside (localStorage, an imported JSON file, the editor in the
 * threshold drawer) goes through `validateThresholds`, which always yields a usable `Thresholds` object: fields
 * that are not finite numbers or that are ordered the wrong way round fall back to the defaults for that KPI,
 * unknown keys are dropped and missing keys are filled in. The breach direction is a property of the KPI and is
 * never taken from the input.
 */
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

/** localStorage key of the persisted threshold set. */
export const THRESHOLDS_KEY = "tkm.thresholds.v1";
/** Threshold rows in display order. */
export const THRESHOLD_KEYS = Object.keys(DEFAULT_THRESHOLDS) as (keyof Thresholds)[];
/** Display labels (with units) for the editor and validation messages. */
export const THRESHOLD_LABELS: Record<keyof Thresholds, string> = {
  callDropRatePct: "Call drop rate (%)",
  rrcSetupSuccessPct: "RRC setup success (%)",
  handoverSuccessPct: "Handover success (%)",
  latencyMs: "Latency (ms)",
  dlThroughputMbps: "DL throughput LTE (Mbps)",
  dlThroughputMbpsNR: "DL throughput NR (Mbps)",
  ulThroughputMbps: "UL throughput (Mbps)",
  prbUtilizationPct: "PRB utilization (%)",
};

/**
 * One validation problem. `key` names the KPI row (or `"all"` when the whole input is unusable), `field` the
 * offending value: `warning` / `critical` for a non-numeric value, `order` when the pair is the wrong way round
 * for the KPI's breach direction, `input` for a problem with the document itself (not an object, invalid JSON).
 */
export interface ThresholdIssue { key: keyof Thresholds | "all"; field: "warning" | "critical" | "order" | "input"; message: string }
export interface ThresholdValidation { ok: boolean; value: Thresholds; issues: ThresholdIssue[] }

/** Tighter and looser variants of the defaults; `strict` moves every threshold towards "worse sooner", `lenient` the other way. */
export const THRESHOLD_PRESETS: Record<"default" | "strict" | "lenient", Thresholds> = {
  default: DEFAULT_THRESHOLDS,
  strict: {
    callDropRatePct: { warning: 0.7, critical: 1.5, direction: "above" },
    rrcSetupSuccessPct: { warning: 98.5, critical: 97, direction: "below" },
    handoverSuccessPct: { warning: 98, critical: 96, direction: "below" },
    latencyMs: { warning: 30, critical: 45, direction: "above" },
    dlThroughputMbps: { warning: 20, critical: 12, direction: "below" },
    dlThroughputMbpsNR: { warning: 120, critical: 60, direction: "below" },
    ulThroughputMbps: { warning: 5, critical: 3, direction: "below" },
    prbUtilizationPct: { warning: 60, critical: 75, direction: "above" },
  },
  lenient: {
    callDropRatePct: { warning: 1.5, critical: 3, direction: "above" },
    rrcSetupSuccessPct: { warning: 97, critical: 93, direction: "below" },
    handoverSuccessPct: { warning: 95, critical: 92, direction: "below" },
    latencyMs: { warning: 50, critical: 80, direction: "above" },
    dlThroughputMbps: { warning: 10, critical: 5, direction: "below" },
    dlThroughputMbpsNR: { warning: 60, critical: 30, direction: "below" },
    ulThroughputMbps: { warning: 3, critical: 1.5, direction: "below" },
    prbUtilizationPct: { warning: 80, critical: 92, direction: "above" },
  },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** A detached copy of one default row (callers may edit the result in place). */
function defaultRow(key: keyof Thresholds): Threshold {
  return { ...DEFAULT_THRESHOLDS[key] };
}

/** True when the pair is ordered correctly for the breach direction: warning is reached before critical. */
export function isOrdered(warning: number, critical: number, direction: Threshold["direction"]): boolean {
  return direction === "above" ? warning < critical : warning > critical;
}

/**
 * Validate an untrusted threshold set. The returned `value` is always complete and consistent: a KPI row with any
 * problem is replaced by its default row, unknown keys are dropped, missing keys are filled from the defaults and
 * `direction` is taken from the defaults. `ok` is false when at least one issue was found.
 */
export function validateThresholds(t: unknown): ThresholdValidation {
  const issues: ThresholdIssue[] = [];
  const value = {} as Thresholds;
  if (!isRecord(t)) {
    issues.push({ key: "all", field: "input", message: "Thresholds must be a JSON object mapping each KPI to { warning, critical }; the defaults are used." });
    for (const key of THRESHOLD_KEYS) value[key] = defaultRow(key);
    return { ok: false, value, issues };
  }
  for (const key of THRESHOLD_KEYS) {
    const label = THRESHOLD_LABELS[key];
    const direction = DEFAULT_THRESHOLDS[key].direction;
    const row = t[key];
    if (row === undefined) {
      value[key] = defaultRow(key); // missing: silently filled in
      continue;
    }
    const before = issues.length;
    const entry: Record<string, unknown> = isRecord(row) ? row : {};
    if (!isFiniteNumber(entry.warning)) issues.push({ key, field: "warning", message: `${label}: warning must be a finite number.` });
    if (!isFiniteNumber(entry.critical)) issues.push({ key, field: "critical", message: `${label}: critical must be a finite number.` });
    if (issues.length === before) {
      const warning = entry.warning as number;
      const critical = entry.critical as number;
      if (!isOrdered(warning, critical, direction)) {
        issues.push({
          key, field: "order",
          message: direction === "above"
            ? `${label}: warning must be below critical because this KPI breaches above the threshold (got warning ${warning}, critical ${critical}).`
            : `${label}: warning must be above critical because this KPI breaches below the threshold (got warning ${warning}, critical ${critical}).`,
        });
      }
    }
    value[key] = issues.length === before ? { warning: entry.warning as number, critical: entry.critical as number, direction } : defaultRow(key);
  }
  return { ok: issues.length === 0, value, issues };
}

/** Pretty-printed JSON, suitable for a downloaded file. */
export function thresholdsToJson(t: Thresholds): string {
  return `${JSON.stringify(t, null, 2)}\n`;
}

/** Parse and validate a JSON document; invalid JSON yields the defaults with a single `input` issue. */
export function thresholdsFromJson(text: string): ThresholdValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const r = validateThresholds(undefined);
    return { ok: false, value: r.value, issues: [{ key: "all", field: "input", message: `Not valid JSON: ${(e as Error).message}` }] };
  }
  return validateThresholds(parsed);
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage access can throw when disabled by browser policy
  }
}

/** Stored thresholds are untrusted input: whatever is in localStorage is validated and sanitised. */
export function loadThresholds(): Thresholds {
  const s = storage();
  if (!s) return DEFAULT_THRESHOLDS;
  try {
    const raw = s.getItem(THRESHOLDS_KEY);
    if (raw) return validateThresholds(JSON.parse(raw)).value;
  } catch { /* corrupt JSON or unavailable storage */ }
  return DEFAULT_THRESHOLDS;
}
export function saveThresholds(t: Thresholds): void {
  try {
    storage()?.setItem(THRESHOLDS_KEY, JSON.stringify(t));
  } catch { /* storage full or unavailable: the in-memory thresholds still apply for this session */ }
}
export function resetThresholds(): Thresholds {
  try {
    storage()?.removeItem(THRESHOLDS_KEY);
  } catch { /* nothing to remove */ }
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
