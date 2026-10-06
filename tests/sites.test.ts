import { describe, expect, it } from "vitest";
import { aggregateByRegion, aggregateBySite, projectSites } from "../src/lib/sites";
import { RANGE_MS, detectIssues, filterTech, inWindow, networkKpi } from "../src/lib/kpi";
import { DEFAULT_THRESHOLDS } from "../src/lib/thresholds";
import { DATASET_END, generateDataset } from "../src/lib/synthetic";
import type { Cell, KpiSample } from "../src/types/telecom";

const data = generateDataset();
const cells = new Map(data.cells.map((c) => [c.cellId, c]));
const win24 = inWindow(data.samples, DATASET_END, RANGE_MS["24h"]);
const win7d = inWindow(data.samples, DATASET_END, RANGE_MS["7d"]);

describe("aggregateBySite (synthetic dataset)", () => {
  const agg24 = aggregateBySite(win24, cells, data.sites, DEFAULT_THRESHOLDS, data.alarms);
  const agg7d = aggregateBySite(win7d, cells, data.sites, DEFAULT_THRESHOLDS, data.alarms);

  it("returns one aggregate per site, sorted by site id, with its cells and technologies", () => {
    expect(agg24).toHaveLength(12);
    expect(agg24.map((s) => s.siteId)).toEqual([...data.sites.map((s) => s.siteId)].sort());
    const s1 = agg24.find((s) => s.siteId === "VSKP-001")!;
    expect(s1.name).toBe("Gajuwaka");
    expect(s1.region).toBe("VSKP-North");
    expect(s1.lat).toBe(data.sites[0].lat);
    expect(s1.lon).toBe(data.sites[0].lon);
    expect(s1.cellIds).toEqual(["VSKP-001-L1", "VSKP-001-L2", "VSKP-001-L3", "VSKP-001-N1"]);
    expect(s1.technologies).toEqual(["LTE", "NR"]);
    // the window is half-open (end - 24h, end] and the last sample is at end - 15 min: 95 intervals × 4 cells
    expect(s1.samples).toBe(4 * 95);
    expect(s1.samples).toBe(win24.filter((r) => r.cellId.startsWith("VSKP-001-")).length);
    expect(agg24.reduce((n, s) => n + s.samples, 0)).toBe(win24.length);
  });

  it("derives availability and down intervals from intervals without counters", () => {
    const s4 = agg7d.find((s) => s.siteId === "VSKP-004")!;
    expect(s4.samples).toBe(4 * 671); // the window is half-open: (end - 7d, end]
    expect(s4.downIntervals).toBe(24);
    expect(s4.availabilityPct).toBeLessThan(100);
    expect(s4.availabilityPct).toBeCloseTo(((s4.samples - 24) / s4.samples) * 100, 9);
    const s1 = agg7d.find((s) => s.siteId === "VSKP-001")!;
    expect(s1.downIntervals).toBe(0);
    expect(s1.availabilityPct).toBe(100);
  });

  it("uses the network KPI (user-weighted where applicable) over the site's samples as site values", () => {
    const s7 = agg24.find((s) => s.siteId === "VSKP-007")!;
    const rows = win24.filter((r) => r.cellId.startsWith("VSKP-007-"));
    expect(s7.values.callDropRatePct).toBeCloseTo(networkKpi(rows, "callDropRatePct")!, 9);
    expect(s7.values.latencyMs).toBeCloseTo(networkKpi(rows, "latencyMs")!, 9);
    expect(s7.values.prbUtilizationPct).toBeCloseTo(networkKpi(rows, "prbUtilizationPct")!, 9);
    expect(s7.values.rsrpAvgDbm).not.toBeNull();
    expect(Object.keys(s7.values)).toHaveLength(9);
  });

  it("rolls up the worst cell level, breaches and detections per site", () => {
    const s2 = agg24.find((s) => s.siteId === "VSKP-002")!;
    expect(s2.worstLevel).toBe("critical"); // VSKP-002-L1 handover success ~88 % (VSWR fault)
    expect(s2.breaches).toBeGreaterThan(0);
    const s4 = agg7d.find((s) => s.siteId === "VSKP-004")!;
    expect(s4.detections.some((d) => d.kind === "outage" && d.cellId === "VSKP-004-L2")).toBe(true);
    const s7 = agg7d.find((s) => s.siteId === "VSKP-007")!;
    expect(s7.detections.some((d) => d.kind === "congestion" && d.cellId === "VSKP-007-N1")).toBe(true);
    const all = detectIssues(win7d, cells, DEFAULT_THRESHOLDS);
    expect(agg7d.flatMap((s) => s.detections)).toHaveLength(all.length);
    for (const s of agg7d) for (const d of s.detections) expect(d.siteId).toBe(s.siteId);
  });

  it("counts non-cleared alarms per site (none when alarms are omitted)", () => {
    const s7 = agg24.find((s) => s.siteId === "VSKP-007")!;
    expect(s7.activeAlarms).toBe(data.alarms.filter((a) => a.siteId === "VSKP-007" && a.state !== "cleared").length);
    expect(s7.activeAlarms).toBeGreaterThanOrEqual(1); // ALM-000002 (High PRB utilization) is active
    expect(agg24.reduce((n, s) => n + s.activeAlarms, 0)).toBe(data.alarms.filter((a) => a.state !== "cleared").length);
    const noAlarms = aggregateBySite(win24, cells, data.sites, DEFAULT_THRESHOLDS);
    expect(noAlarms).toHaveLength(12);
    expect(noAlarms.every((s) => s.activeAlarms === 0)).toBe(true);
  });

  it("follows a technology-filtered sample set", () => {
    const nr = aggregateBySite(filterTech(win24, cells, "NR"), cells, data.sites, DEFAULT_THRESHOLDS);
    expect(nr).toHaveLength(12);
    expect(nr.every((s) => s.cellIds.length === 1 && s.cellIds[0].endsWith("-N1"))).toBe(true);
    expect(nr.every((s) => s.technologies.length === 1 && s.technologies[0] === "NR")).toBe(true);
  });

  it("returns nothing for an empty window and skips samples of unknown cells", () => {
    expect(aggregateBySite([], cells, data.sites, DEFAULT_THRESHOLDS)).toEqual([]);
    const stray: KpiSample = { ...win24[0], cellId: "NOPE-999-L1" };
    expect(aggregateBySite([stray], cells, data.sites, DEFAULT_THRESHOLDS)).toEqual([]);
  });

  it("keeps cells whose site is missing from the site list under a placeholder site", () => {
    const cell: Cell = { cellId: "XTRA-001-L1", siteId: "XTRA-001", technology: "LTE", band: "B3", bandwidthMHz: 20, azimuthDeg: 0 };
    const rows = win24.filter((r) => r.cellId === "VSKP-001-L1").map((r) => ({ ...r, cellId: cell.cellId }));
    const agg = aggregateBySite(rows, new Map([[cell.cellId, cell]]), data.sites, DEFAULT_THRESHOLDS);
    expect(agg).toHaveLength(1);
    expect(agg[0].siteId).toBe("XTRA-001");
    expect(agg[0].name).toBe("XTRA-001");
    expect(agg[0].region).toBe("Unassigned");
    expect(Number.isNaN(agg[0].lat)).toBe(true);
    expect(agg[0].samples).toBe(rows.length);
    expect(agg[0].samples).toBe(95);
  });
});

describe("aggregateByRegion (synthetic dataset)", () => {
  const agg7d = aggregateBySite(win7d, cells, data.sites, DEFAULT_THRESHOLDS, data.alarms);
  const regions = aggregateByRegion(agg7d);

  it("has three regions, sorted by name, covering all 12 sites and 48 cells", () => {
    expect(regions.map((r) => r.region)).toEqual(["VSKP-Central", "VSKP-North", "VSKP-South"]);
    expect(regions.find((r) => r.region === "VSKP-North")!.siteIds).toEqual(["VSKP-001", "VSKP-004", "VSKP-007", "VSKP-010"]);
    expect(regions.reduce((n, r) => n + r.cellCount, 0)).toBe(48);
    expect(regions.reduce((n, r) => n + r.siteIds.length, 0)).toBe(12);
  });

  it("rolls up active alarms, down cells and the worst level", () => {
    expect(regions.reduce((n, r) => n + r.activeAlarms, 0)).toBe(agg7d.reduce((n, s) => n + s.activeAlarms, 0));
    expect(regions.find((r) => r.region === "VSKP-North")!.downCells).toBe(1); // VSKP-004-L2 outage
    expect(regions.find((r) => r.region === "VSKP-Central")!.downCells).toBe(0);
    expect(regions.find((r) => r.region === "VSKP-South")!.downCells).toBe(0);
    const regions24 = aggregateByRegion(aggregateBySite(win24, cells, data.sites, DEFAULT_THRESHOLDS));
    expect(regions24.find((r) => r.region === "VSKP-Central")!.worstLevel).toBe("critical"); // VSKP-002
    expect(regions24.find((r) => r.region === "VSKP-Central")!.activeAlarms).toBe(0);
  });

  it("region values stay within the range of the site values they roll up", () => {
    expect(regions).toHaveLength(3);
    for (const r of regions) {
      const sites = agg7d.filter((s) => s.region === r.region);
      const cdrs = sites.map((s) => s.values.callDropRatePct!);
      expect(r.values.callDropRatePct).toBeGreaterThanOrEqual(Math.min(...cdrs) - 1e-9);
      expect(r.values.callDropRatePct).toBeLessThanOrEqual(Math.max(...cdrs) + 1e-9);
      expect(r.values.prbUtilizationPct).not.toBeNull();
    }
    expect(aggregateByRegion([])).toEqual([]);
  });
});

describe("projectSites", () => {
  const W = 600;
  const H = 400;
  const PAD = 16;

  it("keeps every synthetic site inside the padded box, north up and west left", () => {
    const pts = projectSites(data.sites, W, H, PAD);
    expect(pts).toHaveLength(12);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(PAD - 1e-9);
      expect(p.x).toBeLessThanOrEqual(W - PAD + 1e-9);
      expect(p.y).toBeGreaterThanOrEqual(PAD - 1e-9);
      expect(p.y).toBeLessThanOrEqual(H - PAD + 1e-9);
    }
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    // the aspect ratio is preserved, so exactly one axis fills the inner box and the other is centred
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    expect(Math.abs(spanX - (W - 2 * PAD)) < 1e-6 || Math.abs(spanY - (H - 2 * PAD)) < 1e-6).toBe(true);
    const north = data.sites.reduce((a, b) => (b.lat > a.lat ? b : a));
    const west = data.sites.reduce((a, b) => (b.lon < a.lon ? b : a));
    expect(pts.find((p) => p.siteId === north.siteId)!.y).toBeCloseTo(Math.min(...ys), 9);
    expect(pts.find((p) => p.siteId === west.siteId)!.x).toBeCloseTo(Math.min(...xs), 9);
  });

  it("applies the cos(mean latitude) correction to longitude", () => {
    const sites = [{ siteId: "A", lat: 60, lon: 0 }, { siteId: "B", lat: 60, lon: 1 }, { siteId: "C", lat: 61, lon: 0 }];
    const pts = projectSites(sites, 100, 100, 0);
    const by = Object.fromEntries(pts.map((p) => [p.siteId, p]));
    const k = Math.cos((181 / 3) * (Math.PI / 180)); // mean latitude 60.333°
    expect(by.C.y).toBeCloseTo(0, 9); // northernmost at the top
    expect(by.A.y).toBeCloseTo(100, 9);
    expect(by.B.x - by.A.x).toBeCloseTo(100 * k, 6); // 1° of longitude is shorter than 1° of latitude
    expect(by.A.x).toBeCloseTo((100 - 100 * k) / 2, 6); // centred horizontally
  });

  it("skips non-finite coordinates, centres a single site and handles empty input", () => {
    const pts = projectSites([...data.sites.slice(0, 3), { siteId: "NAN", lat: Number.NaN, lon: 83 }, { siteId: "INF", lat: 17, lon: Number.POSITIVE_INFINITY }], W, H, PAD);
    expect(pts.map((p) => p.siteId)).toEqual(["VSKP-001", "VSKP-002", "VSKP-003"]);
    expect(projectSites([data.sites[0]], W, H)).toEqual([{ siteId: "VSKP-001", x: W / 2, y: H / 2 }]);
    expect(projectSites([{ siteId: "NAN", lat: Number.NaN, lon: 83 }], W, H)).toEqual([]);
    expect(projectSites([], W, H)).toEqual([]);
    const same = projectSites([{ siteId: "A", lat: 17, lon: 83 }, { siteId: "B", lat: 17, lon: 83 }], W, H);
    expect(same).toHaveLength(2);
    expect(same.every((p) => p.x === W / 2 && p.y === H / 2)).toBe(true);
  });
});
