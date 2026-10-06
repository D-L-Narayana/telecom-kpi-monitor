import { describe, expect, it } from "vitest";
import { CAUSE_KPI, correlateAlarm, indexSamplesByCell, kpiForCause, worseningPct } from "../src/lib/correlation";
import { DEFAULT_THRESHOLDS } from "../src/lib/thresholds";
import { DATASET_END, generateDataset } from "../src/lib/synthetic";
import type { Alarm, Cell, KpiSample } from "../src/types/telecom";

const data = generateDataset();
const cells = new Map(data.cells.map((c) => [c.cellId, c]));
const byCell = indexSamplesByCell(data.samples);
const nowIso = new Date(DATASET_END).toISOString();
const INCIDENT_ALARMS = ["ALM-000001", "ALM-000002", "ALM-000003", "ALM-000004"];
const alarmById = (id: string): Alarm => {
  const a = data.alarms.find((x) => x.alarmId === id);
  if (!a) throw new Error(`missing ${id}`);
  return a;
};

// crafted single-cell dataset: 25 samples at 15-min spacing; the alarm is raised at sample 8 and cleared at sample 16,
// so baseline = samples 0..7, during = samples 8..16, after = samples 17..24
const STEP = 15 * 60e3;
const T0 = Date.UTC(2026, 8, 20, 6, 0, 0);
const CELL: Cell = { cellId: "X-001-L1", siteId: "X-001", technology: "LTE", band: "B3", bandwidthMHz: 20, azimuthDeg: 0 };
const craftedCells = new Map([[CELL.cellId, CELL]]);
const RAISE = T0 + 8 * STEP;
const CLEAR = T0 + 16 * STEP;
const craftedAlarm = (cause: string, patch: Partial<Alarm> = {}): Alarm => ({ alarmId: "ALM-X", timestamp: new Date(RAISE).toISOString(), clearedAt: new Date(CLEAR).toISOString(), siteId: CELL.siteId, cellId: CELL.cellId, technology: "LTE", severity: "Major", probableCause: cause, state: "cleared", ...patch });

function sample(t: number, patch: Partial<KpiSample> = {}): KpiSample {
  return { cellId: CELL.cellId, timestamp: new Date(t).toISOString(), callDropRatePct: 1.0, rrcSetupSuccessPct: 99, handoverSuccessPct: 98, dlThroughputMbps: 40, ulThroughputMbps: 10, latencyMs: 30, prbUtilizationPct: 50, rsrpAvgDbm: -95, sinrAvgDb: 12, activeUsers: 100, ...patch };
}
function crafted(patchDuring: Partial<KpiSample>): Map<string, KpiSample[]> {
  const rows: KpiSample[] = [];
  for (let i = 0; i < 25; i++) rows.push(sample(T0 + i * STEP, i >= 8 && i <= 16 ? patchDuring : {}));
  // feed the samples out of order to prove the index sorts them
  return indexSamplesByCell([...rows].reverse());
}
const DOWN: Partial<KpiSample> = { callDropRatePct: null, rrcSetupSuccessPct: null, handoverSuccessPct: null, dlThroughputMbps: null, ulThroughputMbps: null, latencyMs: null, prbUtilizationPct: null, rsrpAvgDbm: null, sinrAvgDb: null, activeUsers: 0 };

describe("cause → KPI mapping", () => {
  it("maps known causes, sends sleeping cells to PRB and falls back to call drop rate", () => {
    expect(CAUSE_KPI["Sleeping cell suspected"]).toBe("prbUtilizationPct");
    expect(CAUSE_KPI["Cell down"]).toBe("dlThroughputMbps");
    expect(kpiForCause("Cell down")).toBe("dlThroughputMbps");
    expect(kpiForCause("VSWR high")).toBe("rsrpAvgDbm");
    expect(kpiForCause("unknown")).toBe("callDropRatePct");
  });
});

describe("indexSamplesByCell", () => {
  it("groups the synthetic samples per cell in ascending time order", () => {
    expect(byCell.size).toBe(48);
    const rows = byCell.get("VSKP-004-L2") ?? [];
    expect(rows).toHaveLength(672);
    for (let i = 1; i < rows.length; i++) expect(rows[i].timestamp > rows[i - 1].timestamp).toBe(true);
    const reversed = crafted({}).get(CELL.cellId) ?? [];
    expect(reversed.map((r) => r.timestamp)).toEqual([...reversed].map((r) => r.timestamp).sort());
  });
});

describe("correlateAlarm on the synthetic incidents", () => {
  it("rates the cell outage strong through down intervals (ALM-000001)", () => {
    const c = correlateAlarm(alarmById("ALM-000001"), byCell, cells, DEFAULT_THRESHOLDS, nowIso);
    expect(c.kpi).toBe("dlThroughputMbps");
    expect(c.cellIds).toEqual(["VSKP-004-L2"]);
    expect(c.downIntervals).toBe(24);
    expect(c.score).toBe(1);
    expect(c.verdict).toBe("strong");
    expect(c.baseline).not.toBeNull();
    expect(c.detections.some((d) => d.kind === "outage" && d.cellId === "VSKP-004-L2")).toBe(true);
  });
  it("rates the evening congestion strong with a positive PRB delta and breaches (ALM-000002)", () => {
    const c = correlateAlarm(alarmById("ALM-000002"), byCell, cells, DEFAULT_THRESHOLDS, nowIso);
    expect(c.kpi).toBe("prbUtilizationPct");
    expect(c.verdict).toBe("strong");
    // the congestion only bites in the evenings, so the mean over the 3-day alarm is diluted while the first-hours peak is not
    expect(c.deltaPct ?? 0).toBeGreaterThan(0);
    expect(c.peakDeltaPct ?? 0).toBeGreaterThan(50);
    expect(c.peakDeltaPct ?? 0).toBeGreaterThanOrEqual(c.deltaPct ?? 0);
    expect(c.breachFraction).toBeGreaterThan(0.2);
    expect(c.score).toBeGreaterThanOrEqual(0.5);
    expect(c.after).toBeNull(); // still active
    expect(c.detections.some((d) => d.kind === "congestion" && d.cellId === "VSKP-007-N1")).toBe(true);
  });
  it("rates the site-level transmission fault strong across the site's four cells and sees the recovery (ALM-000003)", () => {
    const c = correlateAlarm(alarmById("ALM-000003"), byCell, cells, DEFAULT_THRESHOLDS, nowIso);
    expect(c.kpi).toBe("latencyMs");
    expect(c.cellIds).toHaveLength(4);
    expect(c.cellIds.every((id) => id.startsWith("VSKP-010-"))).toBe(true);
    expect(c.verdict).toBe("strong");
    expect(c.breachFraction).toBeGreaterThan(0.5);
    expect(c.after ?? Infinity).toBeLessThan(c.during ?? 0);
    expect(c.detections.filter((d) => d.kind === "latency")).toHaveLength(4);
  });
  it("rates the antenna fault strong from the RSRP drop alone — RSRP has no threshold (ALM-000004)", () => {
    const c = correlateAlarm(alarmById("ALM-000004"), byCell, cells, DEFAULT_THRESHOLDS, nowIso);
    expect(c.kpi).toBe("rsrpAvgDbm");
    expect(c.breachFraction).toBe(0);
    expect(c.deltaPct ?? 0).toBeGreaterThan(40);
    expect(c.verdict).toBe("strong");
  });
  it("leaves at least 80 % of the remaining 296 alarms below strong", () => {
    const others = data.alarms.filter((a) => !INCIDENT_ALARMS.includes(a.alarmId));
    expect(others).toHaveLength(296);
    const verdicts = others.map((a) => correlateAlarm(a, byCell, cells, DEFAULT_THRESHOLDS, nowIso).verdict);
    const notStrong = verdicts.filter((v) => v !== "strong").length;
    expect(notStrong / others.length).toBeGreaterThanOrEqual(0.8);
    expect(verdicts.every((v) => ["strong", "weak", "none", "insufficient"].includes(v))).toBe(true);
  });
  it("is deterministic and does not mutate its inputs", () => {
    const rows = byCell.get("VSKP-007-N1") ?? [];
    const before = rows.map((r) => r.timestamp).join();
    const a = correlateAlarm(alarmById("ALM-000002"), byCell, cells, DEFAULT_THRESHOLDS, nowIso);
    const b = correlateAlarm(alarmById("ALM-000002"), byCell, cells, DEFAULT_THRESHOLDS, nowIso);
    expect(a).toEqual(b);
    expect(rows.map((r) => r.timestamp).join()).toBe(before);
  });
});

describe("correlateAlarm on crafted data", () => {
  it("scores an outage with an all-null during window strong via downIntervals", () => {
    const c = correlateAlarm(craftedAlarm("Cell down"), crafted(DOWN), craftedCells, DEFAULT_THRESHOLDS, nowIso);
    expect(c.during).toBeNull();
    expect(c.peak).toBeNull();
    expect(c.deltaPct).toBeNull();
    expect(c.downIntervals).toBe(9);
    expect(c.score).toBe(1);
    expect(c.verdict).toBe("strong");
    expect(c.baseline).toBeCloseTo(40, 5);
    expect(c.after).toBeCloseTo(40, 5);
  });
  it("is direction-aware: a handover success drop from 98 to 88 is a positive (worse) delta with full breaches", () => {
    const c = correlateAlarm(craftedAlarm("Handover success degraded"), crafted({ handoverSuccessPct: 88 }), craftedCells, DEFAULT_THRESHOLDS, nowIso);
    expect(c.kpi).toBe("handoverSuccessPct");
    expect(c.baseline).toBeCloseTo(98, 5);
    expect(c.during).toBeCloseTo(88, 5);
    expect(c.peak).toBeCloseTo(88, 5);
    expect(c.deltaPct).toBeCloseTo((10 / 98) * 100, 3);
    expect(c.peakDeltaPct).toBeCloseTo((10 / 98) * 100, 3);
    expect(c.breachFraction).toBe(1);
    expect(c.verdict).toBe("strong");
  });
  it("reports an improvement as a negative delta and verdict none", () => {
    const c = correlateAlarm(craftedAlarm("Battery on discharge"), crafted({ callDropRatePct: 0.5 }), craftedCells, DEFAULT_THRESHOLDS, nowIso);
    expect(c.kpi).toBe("callDropRatePct");
    expect(c.deltaPct).toBeCloseTo(-50, 5);
    expect(c.breachFraction).toBe(0);
    expect(c.score).toBe(0);
    expect(c.verdict).toBe("none");
  });
  it("treats dB-scale KPIs as power ratios: a 3 dB RSRP drop halves the power (+50 % worse), a 3 dB gain doubles it", () => {
    const worse = correlateAlarm(craftedAlarm("VSWR high"), crafted({ rsrpAvgDbm: -98 }), craftedCells, DEFAULT_THRESHOLDS, nowIso);
    expect(worse.deltaPct).toBeCloseTo((1 - Math.pow(10, -0.3)) * 100, 3); // ≈ 49.9
    expect(worse.verdict).toBe("strong");
    const better = correlateAlarm(craftedAlarm("VSWR high"), crafted({ rsrpAvgDbm: -92 }), craftedCells, DEFAULT_THRESHOLDS, nowIso);
    expect(better.deltaPct).toBeCloseTo(-(Math.pow(10, 0.3) - 1) * 100, 3); // ≈ -99.5
    expect(better.verdict).toBe("none");
    // a plain dBm difference would have read the 12 dB antenna fault as a ~13 % change; the power ratio makes it ~94 %
    expect(worseningPct("rsrpAvgDbm", -95, -107)).toBeCloseTo((1 - Math.pow(10, -1.2)) * 100, 3);
    expect(worseningPct("latencyMs", 30, 45)).toBeCloseTo(50, 5);
    expect(worseningPct("latencyMs", 0, 45)).toBeNull();
  });
  it("returns insufficient when there is no baseline and no outage evidence", () => {
    const early = correlateAlarm(craftedAlarm("Door open", { timestamp: new Date(T0).toISOString(), clearedAt: new Date(T0 + 4 * STEP).toISOString() }), crafted({}), craftedCells, DEFAULT_THRESHOLDS, nowIso);
    expect(early.baseline).toBeNull();
    expect(early.downIntervals).toBe(0);
    expect(early.verdict).toBe("insufficient");
    const unknownCell = correlateAlarm(craftedAlarm("Door open", { cellId: "NOPE" }), crafted({}), craftedCells, DEFAULT_THRESHOLDS, nowIso);
    expect(unknownCell.cellIds).toEqual([]);
    expect(unknownCell.verdict).toBe("insufficient");
  });
  it("uses the dataset clock as the end of the during window for alarms that are still active", () => {
    const stillActive = craftedAlarm("Packet loss on backhaul", { state: "active", clearedAt: undefined });
    const c = correlateAlarm(stillActive, crafted({ latencyMs: 150 }), craftedCells, DEFAULT_THRESHOLDS, new Date(CLEAR).toISOString());
    expect(c.during).toBeCloseTo(150, 5);
    expect(c.after).toBeNull();
    expect(c.breachFraction).toBe(1);
    expect(c.verdict).toBe("strong");
  });
});
