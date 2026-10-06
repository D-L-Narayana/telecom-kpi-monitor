import { describe, expect, it } from "vitest";
import {
  callDropRatePct, successPct, prbUtilizationPct, mean, aggregateByCell, detectIssues, inWindow,
  availabilityPct, compareDetections, deltaPct, percentile, seriesByInterval, DETECTION_KPI, RANGE_MS, type Detection,
} from "../src/lib/kpi";
import { DEFAULT_THRESHOLDS, classify } from "../src/lib/thresholds";
import { generateDataset, DATASET_END, DAYS, INTERVALS_PER_DAY } from "../src/lib/synthetic";
import type { Cell, KpiSample, Technology } from "../src/types/telecom";

describe("KPI formulas", () => {
  it("computes ratio KPIs", () => {
    expect(callDropRatePct(2, 98)).toBeCloseTo(2);
    expect(callDropRatePct(0, 0)).toBe(0);
    expect(successPct(97, 100)).toBeCloseTo(97);
    expect(prbUtilizationPct(75, 100)).toBeCloseTo(75);
  });
  it("weighted mean ignores nulls", () => {
    expect(mean([1, null, 3])).toBeCloseTo(2);
    expect(mean([1, 3], [1, 3])).toBeCloseTo(2.5);
    expect(mean([null, null])).toBeNull();
  });
  it("classifies against thresholds in both directions", () => {
    expect(classify(0.5, DEFAULT_THRESHOLDS.callDropRatePct)).toBe("ok");
    expect(classify(1.5, DEFAULT_THRESHOLDS.callDropRatePct)).toBe("warning");
    expect(classify(2.5, DEFAULT_THRESHOLDS.callDropRatePct)).toBe("critical");
    expect(classify(94.5, DEFAULT_THRESHOLDS.rrcSetupSuccessPct)).toBe("critical");
    expect(classify(null, DEFAULT_THRESHOLDS.latencyMs)).toBe("ok");
  });
});

describe("synthetic dataset", () => {
  const data = generateDataset();
  const cells = new Map(data.cells.map((c) => [c.cellId, c]));
  it("has the documented shape and is deterministic", () => {
    expect(data.sites).toHaveLength(12);
    expect(data.cells).toHaveLength(48);
    expect(data.samples).toHaveLength(DAYS * INTERVALS_PER_DAY * 48);
    expect(data.alarms).toHaveLength(300);
    expect(generateDataset().samples[1234]).toEqual(data.samples[1234]);
  });
  it("detects the injected incidents over 7 days", () => {
    const win = inWindow(data.samples, DATASET_END, 7 * 24 * 3600e3);
    const det = detectIssues(win, cells, DEFAULT_THRESHOLDS);
    expect(det.find((d) => d.kind === "outage" && d.cellId === "VSKP-004-L2")?.intervals).toBe(24);
    expect(det.find((d) => d.kind === "congestion" && d.cellId === "VSKP-007-N1")).toBeTruthy();
    expect(det.filter((d) => d.kind === "latency" && d.siteId === "VSKP-010")).toHaveLength(4);
    const agg24 = aggregateByCell(inWindow(data.samples, DATASET_END, 24 * 3600e3), cells, DEFAULT_THRESHOLDS);
    expect(agg24.find((a) => a.cellId === "VSKP-002-L1")?.worstLevel).toBe("critical"); // handover success ~88 % (VSWR fault)
  });
});

/* ---------- crafted-row helpers for the detection / series tests ---------- */

const T0 = Date.UTC(2026, 8, 20, 0, 0, 0);
/** ISO timestamp of the i-th 15-minute interval after T0. */
const ts = (i: number) => new Date(T0 + i * 15 * 60e3).toISOString();

function cellOf(cellId: string, technology: Technology = "LTE"): Cell {
  return { cellId, siteId: cellId.slice(0, cellId.lastIndexOf("-")), technology, band: technology === "NR" ? "n78" : "B3", bandwidthMHz: 20, azimuthDeg: 0 };
}
function cellMap(...ids: string[]): Map<string, Cell> {
  return new Map(ids.map((id) => [id, cellOf(id)]));
}
/** Healthy interval (no threshold breached) with optional overrides. */
function up(cellId: string, i: number, patch: Partial<KpiSample> = {}): KpiSample {
  return {
    cellId, timestamp: ts(i), callDropRatePct: 0.5, rrcSetupSuccessPct: 99, handoverSuccessPct: 98.5, dlThroughputMbps: 30, ulThroughputMbps: 8,
    latencyMs: 20, prbUtilizationPct: 30, rsrpAvgDbm: -90, sinrAvgDb: 10, activeUsers: 50, ...patch,
  };
}
/** Interval without counters (cell down). */
function down(cellId: string, i: number): KpiSample {
  return {
    cellId, timestamp: ts(i), callDropRatePct: null, rrcSetupSuccessPct: null, handoverSuccessPct: null, dlThroughputMbps: null, ulThroughputMbps: null,
    latencyMs: null, prbUtilizationPct: null, rsrpAvgDbm: null, sinrAvgDb: null, activeUsers: 0,
  };
}
const range = (n: number, from = 0) => Array.from({ length: n }, (_, k) => from + k);

/** Asserts the documented detection order: outage first, then intervals desc, then cellId asc. */
function expectOrdered(det: Detection[]): void {
  for (let i = 1; i < det.length; i++) {
    const a = det[i - 1];
    const b = det[i];
    const ao = a.kind === "outage" ? 0 : 1;
    const bo = b.kind === "outage" ? 0 : 1;
    expect(ao, `outage-first violated at ${i}: ${a.kind}:${a.cellId} before ${b.kind}:${b.cellId}`).toBeLessThanOrEqual(bo);
    if (ao === bo) {
      expect(a.intervals, `intervals desc violated at ${i}`).toBeGreaterThanOrEqual(b.intervals);
      if (a.intervals === b.intervals) expect(a.cellId <= b.cellId, `cellId asc violated at ${i}: ${a.cellId} before ${b.cellId}`).toBe(true);
    }
  }
}

describe("detection ordering and outage runs", () => {
  it("reports only the longest consecutive run without counters", () => {
    const id = "SITE-A-L1";
    const rows = [
      ...range(2).map((i) => down(id, i)), // run of 2
      ...range(3, 2).map((i) => up(id, i)),
      ...range(3, 5).map((i) => down(id, i)), // run of 3 (the longest)
      ...range(2, 8).map((i) => up(id, i)),
    ];
    const det = detectIssues(rows, cellMap(id), DEFAULT_THRESHOLDS);
    const outage = det.filter((d) => d.kind === "outage");
    expect(outage).toHaveLength(1);
    expect(outage[0].intervals).toBe(3);
    expect(outage[0].firstSeen).toBe(ts(5));
    expect(outage[0].lastSeen).toBe(ts(7));
    expect(outage[0].detail).toMatch(/3 consecutive intervals/);
  });

  it("sorts outage first, then intervals desc, then cellId asc, independent of input order", () => {
    const A = "SITE-A-L1"; // outage run of 3
    const B = "SITE-B-L1"; // outage run of 5
    const C = "SITE-C-L1"; // latency 6 intervals
    const D = "SITE-D-L1"; // latency 6 intervals (tie with C -> cellId asc)
    const E = "SITE-E-L1"; // congestion 8 intervals
    const rows = [
      ...range(10).map((i) => (i < 3 ? down(A, i) : up(A, i))),
      ...range(10).map((i) => (i >= 2 && i <= 6 ? down(B, i) : up(B, i))),
      ...range(10).map((i) => up(C, i, { latencyMs: i < 6 ? 100 : 20 })),
      ...range(10).map((i) => up(D, i, { latencyMs: i < 6 ? 100 : 20 })),
      ...range(10).map((i) => up(E, i, { prbUtilizationPct: i < 8 ? 90 : 30 })),
    ];
    const cells = cellMap(A, B, C, D, E);
    const det = detectIssues(rows, cells, DEFAULT_THRESHOLDS);
    expect(det.map((d) => `${d.kind}:${d.cellId}`)).toEqual([`outage:${B}`, `outage:${A}`, `congestion:${E}`, `latency:${C}`, `latency:${D}`]);
    expect(detectIssues([...rows].reverse(), cells, DEFAULT_THRESHOLDS)).toEqual(det);
    expectOrdered(det);
  });

  it("comparator is consistent on the synthetic 7-day window (sort twice / reversed input)", () => {
    const data = generateDataset();
    const cells = new Map(data.cells.map((c) => [c.cellId, c]));
    const win = inWindow(data.samples, DATASET_END, RANGE_MS["7d"]);
    const det = detectIssues(win, cells, DEFAULT_THRESHOLDS);
    expect(det.length).toBeGreaterThan(4);
    expect([...det].sort(compareDetections)).toEqual(det);
    expect([...det].reverse().sort(compareDetections)).toEqual(det);
    expect(detectIssues([...win].reverse(), cells, DEFAULT_THRESHOLDS)).toEqual(det);
    expectOrdered(det);
    // the comparator is antisymmetric for every pair (signs cancel; a pair of equal items gives 0 + 0)
    for (const a of det) for (const b of det) expect(Math.sign(compareDetections(a, b)) + Math.sign(compareDetections(b, a))).toBe(0);
    // and transitive over the whole set
    for (const a of det) for (const b of det) for (const c of det) {
      if (compareDetections(a, b) < 0 && compareDetections(b, c) < 0) expect(compareDetections(a, c)).toBeLessThan(0);
    }
  });
});

describe("sleeping cell detection", () => {
  it("flags >= 4 consecutive intervals with counters present and almost no users", () => {
    const S = "SITE-S-L1"; // 6 intervals, 1 user -> sleeping (6)
    const T = "SITE-T-L1"; // 6 intervals, 50 users -> healthy
    const U = "SITE-U-L1"; // 100 users, then 3 users for 5 intervals, then 100 again -> sleeping (5)
    const V = "SITE-V-L1"; // no counters at all -> outage, never sleeping
    const W = "SITE-W-L1"; // two low-user runs of 3 -> below the 4-interval minimum
    const rows = [
      ...range(6).map((i) => up(S, i, { activeUsers: 1 })),
      ...range(6).map((i) => up(T, i, { activeUsers: 50 })),
      ...range(20).map((i) => up(U, i, { activeUsers: i >= 10 && i <= 14 ? 3 : 100 })),
      ...range(6).map((i) => down(V, i)),
      ...range(7).map((i) => up(W, i, { activeUsers: i === 3 ? 50 : 1 })),
    ];
    const det = detectIssues(rows, cellMap(S, T, U, V, W), DEFAULT_THRESHOLDS);
    const sleeping = det.filter((d) => d.kind === "sleeping");
    expect(sleeping.map((d) => d.cellId).sort()).toEqual([S, U]);
    const s = sleeping.find((d) => d.cellId === S)!;
    expect(s.intervals).toBe(6);
    expect(s.firstSeen).toBe(ts(0));
    expect(s.lastSeen).toBe(ts(5));
    expect(s.siteId).toBe("SITE-S");
    const u = sleeping.find((d) => d.cellId === U)!;
    expect(u.intervals).toBe(5);
    expect(u.firstSeen).toBe(ts(10));
    expect(u.lastSeen).toBe(ts(14));
    expect(det.find((d) => d.kind === "outage" && d.cellId === V)?.intervals).toBe(6);
    expect(det.filter((d) => d.cellId === T || d.cellId === W)).toHaveLength(0);
  });

  it("produces no sleeping detections on the synthetic 7-day window", () => {
    const data = generateDataset();
    const cells = new Map(data.cells.map((c) => [c.cellId, c]));
    const det = detectIssues(inWindow(data.samples, DATASET_END, RANGE_MS["7d"]), cells, DEFAULT_THRESHOLDS);
    expect(det.filter((d) => d.kind === "sleeping")).toHaveLength(0);
  });

  it("maps every detection kind to the KPI to open", () => {
    expect(DETECTION_KPI).toEqual({ outage: "dlThroughputMbps", congestion: "prbUtilizationPct", latency: "latencyMs", drops: "callDropRatePct", sleeping: "prbUtilizationPct" });
    expect(DETECTION_KPI.sleeping).toBe("prbUtilizationPct");
  });
});

describe("bucketed series", () => {
  const A = "SITE-A-L1";
  const B = "SITE-B-L1";
  const rows = [
    up(A, 0, { latencyMs: 10, activeUsers: 1 }),
    up(A, 1, { latencyMs: 20, activeUsers: 1 }),
    up(A, 2, { latencyMs: 30, activeUsers: 1 }),
    up(A, 3, { latencyMs: 40, activeUsers: 5 }),
    up(A, 4, { latencyMs: 70, activeUsers: 2 }), // next hour
    up(B, 0, { latencyMs: null, activeUsers: 100 }), // null is ignored, even with a large weight
  ];
  it("keeps one point per interval when no bucket is given", () => {
    const s = seriesByInterval(rows, "latencyMs");
    expect(s.map((p) => p.t)).toEqual(range(5).map((i) => T0 + i * 15 * 60e3));
    expect(s.map((p) => p.v)).toEqual([10, 20, 30, 40, 70]);
  });
  it("collapses four 15-min points into one user-weighted hourly mean", () => {
    const s = seriesByInterval(rows, "latencyMs", 3600e3);
    // (10*1 + 20*1 + 30*1 + 40*5) / (1+1+1+5) = 260 / 8 = 32.5
    expect(s).toEqual([{ t: T0, v: 32.5 }, { t: T0 + 3600e3, v: 70 }]);
  });
  it("returns a null point for a bucket without values", () => {
    const s = seriesByInterval([up(B, 0, { latencyMs: null }), up(B, 1, { latencyMs: null })], "latencyMs", 3600e3);
    expect(s).toEqual([{ t: T0, v: null }]);
  });
});

describe("availability, percentile and delta helpers", () => {
  it("availabilityPct = intervals with counters / intervals", () => {
    const id = "SITE-A-L1";
    expect(availabilityPct([])).toBeNull();
    expect(availabilityPct([up(id, 0), down(id, 1), up(id, 2), down(id, 3)])).toBe(50);
    expect(availabilityPct([up(id, 0), up(id, 1)])).toBe(100);
    expect(availabilityPct([down(id, 0)])).toBe(0);
  });
  it("percentile interpolates linearly and ignores nulls", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 25)).toBe(1.75);
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([3, null, 1, undefined], 0)).toBe(1);
    expect(percentile([3, null, 1, undefined], 100)).toBe(3);
    expect(percentile([5], 90)).toBe(5);
    expect(percentile([], 50)).toBeNull();
    expect(percentile([null, undefined], 50)).toBeNull();
  });
  it("deltaPct is relative to |previous| and null when undefined", () => {
    expect(deltaPct(110, 100)).toBe(10);
    expect(deltaPct(50, 100)).toBe(-50);
    expect(deltaPct(-5, -10)).toBe(50);
    expect(deltaPct(1, 0)).toBeNull();
    expect(deltaPct(null, 100)).toBeNull();
    expect(deltaPct(100, null)).toBeNull();
  });
});
