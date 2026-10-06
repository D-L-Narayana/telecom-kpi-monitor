import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KPI_CSV_COLUMNS,
  MAX_IMPORT_ROWS,
  classifyImportFile,
  importDataset,
  inferCells,
  inferSites,
  parseAlarmsCsv,
  parseCellsJson,
  parseKpiCsv,
  parseSitesJson,
  parseTimestamp,
  sampleKpiCsv,
  type ImportIssue,
} from "../src/lib/importers";
import { toCsv } from "../src/lib/csv";
import { aggregateByCell, detectIssues, inWindow } from "../src/lib/kpi";
import { DEFAULT_THRESHOLDS } from "../src/lib/thresholds";
import type { Cell, KpiSample } from "../src/types/telecom";

// vitest runs from the repository root; jsdom rewrites import.meta.url, so resolve fixtures from the cwd.
const fixture = (name: string) => readFileSync(resolve(process.cwd(), "tests/fixtures/import", name), "utf8");
const dataFile = (name: string) => readFileSync(resolve(process.cwd(), "data", name), "utf8");
const KPI_HEADER = "cellId,timestamp,callDropRatePct,rrcSetupSuccessPct,handoverSuccessPct,dlThroughputMbps,ulThroughputMbps,latencyMs,prbUtilizationPct,rsrpAvgDbm,sinrAvgDb,activeUsers";
const errors = (issues: ImportIssue[]) => issues.filter((i) => i.level === "error");
const warnings = (issues: ImportIssue[]) => issues.filter((i) => i.level === "warning");

describe("KPI CSV schema", () => {
  it("KPI_CSV_COLUMNS is exactly the header of data/kpi_15min.csv", () => {
    const header = dataFile("kpi_15min.csv").split(/\r?\n/, 1)[0];
    expect([...KPI_CSV_COLUMNS]).toEqual(header.split(","));
    expect(KPI_CSV_COLUMNS).toHaveLength(12);
  });

  it("exposes the row limit", () => {
    expect(MAX_IMPORT_ROWS).toBe(500_000);
  });
});

describe("parseKpiCsv", () => {
  it("parses the small fixture: numbers typed, empty cells become null, empty activeUsers becomes 0", () => {
    const { samples, issues } = parseKpiCsv(fixture("kpi_small.csv"));
    expect(errors(issues)).toEqual([]);
    expect(samples).toHaveLength(32);
    const first = samples[0];
    expect(first).toEqual({
      cellId: "DEMO-001-L1", timestamp: "2026-09-23T06:15:00.000Z", callDropRatePct: 0.61, rrcSetupSuccessPct: 99.02, handoverSuccessPct: 98.15,
      dlThroughputMbps: 33.4, ulThroughputMbps: 10.3, latencyMs: 30.8, prbUtilizationPct: 35.2, rsrpAvgDbm: -92.1, sinrAvgDb: 7.4, activeUsers: 64,
    });
    expect(Object.keys(first)).toEqual([...KPI_CSV_COLUMNS]);
    const down = samples.find((s) => s.cellId === "DEMO-002-L1" && s.timestamp === "2026-09-23T07:00:00.000Z");
    expect(down).toBeDefined();
    for (const k of ["callDropRatePct", "rrcSetupSuccessPct", "handoverSuccessPct", "dlThroughputMbps", "ulThroughputMbps", "latencyMs", "prbUtilizationPct", "rsrpAvgDbm", "sinrAvgDb"] as const) {
      expect(down?.[k]).toBeNull();
    }
    expect(down?.activeUsers).toBe(0);
  });

  it("normalises timestamps to UTC ISO strings and accepts any column order", () => {
    const csv = [
      "timestamp,activeUsers,cellId,callDropRatePct,rrcSetupSuccessPct,handoverSuccessPct,dlThroughputMbps,ulThroughputMbps,latencyMs,prbUtilizationPct,rsrpAvgDbm,sinrAvgDb",
      "2026-09-23T06:15:00Z,,X-001-L1,0.5,99,98,30,10,30,40,-90,10",
      "2026-09-23T11:45:00+05:30,7,X-001-L1,0.5,99,98,30,10,30,40,-90,10",
      "1790145900,8,X-001-L1,0.5,99,98,30,10,30,40,-90,10",
      "1790146800000,9,X-001-L1,0.5,99,98,30,10,30,40,-90,10",
    ].join("\n");
    const { samples, issues } = parseKpiCsv(csv);
    expect(errors(issues)).toEqual([]);
    expect(samples.map((s) => s.timestamp)).toEqual([
      "2026-09-23T06:15:00.000Z", "2026-09-23T06:15:00.000Z", "2026-09-23T06:45:00.000Z", "2026-09-23T07:00:00.000Z",
    ]);
    expect(samples.map((s) => s.activeUsers)).toEqual([0, 7, 8, 9]);
    expect(Object.keys(samples[0])).toEqual([...KPI_CSV_COLUMNS]);
  });

  it("reports the problems in kpi_bad.csv with line numbers and still parses the valid rows", () => {
    const { samples, issues } = parseKpiCsv(fixture("kpi_bad.csv"));
    const errs = errors(issues);
    expect(errs).toHaveLength(2);
    expect(errs[0]).toMatchObject({ level: "error", row: 1 });
    expect(errs[0].message).toMatch(/missing required column "latencyMs"/i);
    expect(errs[1]).toMatchObject({ level: "error", row: 3 });
    expect(errs[1].message).toMatch(/invalid timestamp "not-a-timestamp"/i);
    const warns = warnings(issues);
    expect(warns.some((w) => w.row === 4 && /prbUtilizationPct.*120\.5.*0.*100/.test(w.message))).toBe(true);
    expect(samples).toHaveLength(2);
    expect(samples.every((s) => s.latencyMs === null)).toBe(true);
  });

  it("rejects non-numeric values, empty cell ids and an empty file", () => {
    const bad = parseKpiCsv(`${KPI_HEADER}\nX-001-L1,2026-09-23T06:15:00Z,abc,99,98,30,10,30,40,-90,10,5\n,2026-09-23T06:30:00Z,0.5,99,98,30,10,30,40,-90,10,5`);
    expect(bad.samples).toEqual([]);
    expect(errors(bad.issues).map((e) => e.row)).toEqual([2, 3]);
    expect(errors(bad.issues)[0].message).toMatch(/callDropRatePct.*"abc"/);
    expect(errors(bad.issues)[1].message).toMatch(/cellId/);
    const empty = parseKpiCsv("");
    expect(errors(empty.issues)).toHaveLength(1);
    expect(errors(empty.issues)[0].message).toMatch(/header/i);
    const headerOnly = parseKpiCsv(KPI_HEADER);
    expect(errors(headerOnly.issues)[0].message).toMatch(/no data rows/i);
  });

  it("warns about unknown columns and accepts null tokens", () => {
    const r = parseKpiCsv(`${KPI_HEADER},extra\nX-001-L1,2026-09-23T06:15:00Z,NULL,NA,n/a,NaN,,30,40,-90,10,5,ignored`);
    expect(errors(r.issues)).toEqual([]);
    expect(warnings(r.issues).some((w) => /unknown column "extra"/i.test(w.message))).toBe(true);
    expect(r.samples[0]).toMatchObject({ callDropRatePct: null, rrcSetupSuccessPct: null, handoverSuccessPct: null, dlThroughputMbps: null, ulThroughputMbps: null, latencyMs: 30 });
  });

  it("stops at the row limit with an error (same code path as the 500,000-row default)", () => {
    const rows = Array.from({ length: 12 }, (_, i) => `X-001-L1,2026-09-23T0${Math.floor(i / 4) + 6}:${String((i % 4) * 15).padStart(2, "0")}:00Z,0.5,99,98,30,10,30,40,-90,10,5`);
    const r = parseKpiCsv([KPI_HEADER, ...rows].join("\n"), { maxRows: 10 });
    expect(r.samples).toHaveLength(10);
    const errs = errors(r.issues);
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toMatch(/More than 10 data rows \(limit 10\)/);
    expect(errs[0].row).toBe(12); // header + 10 accepted rows + the first rejected row
    expect(errors(parseKpiCsv([KPI_HEADER, ...rows.slice(0, 10)].join("\n"), { maxRows: 10 }).issues)).toEqual([]);
  });
});

describe("parseTimestamp", () => {
  it("accepts ISO strings, epoch seconds and epoch milliseconds", () => {
    expect(parseTimestamp("2026-09-23T06:15:00Z")).toBe(Date.UTC(2026, 8, 23, 6, 15));
    expect(parseTimestamp("2026-09-23T11:45:00+05:30")).toBe(Date.UTC(2026, 8, 23, 6, 15));
    expect(parseTimestamp("1790145300")).toBe(Date.UTC(2026, 8, 23, 6, 35));
    expect(parseTimestamp("1790145300000")).toBe(Date.UTC(2026, 8, 23, 6, 35));
    expect(parseTimestamp("")).toBeNull();
    expect(parseTimestamp("yesterday")).toBeNull();
  });
});

describe("inferCells / inferSites", () => {
  const sample = (cellId: string): KpiSample => ({
    cellId, timestamp: "2026-09-23T06:15:00.000Z", callDropRatePct: 0, rrcSetupSuccessPct: 99, handoverSuccessPct: 98, dlThroughputMbps: 30,
    ulThroughputMbps: 10, latencyMs: 30, prbUtilizationPct: 40, rsrpAvgDbm: -90, sinrAvgDb: 10, activeUsers: 5,
  });

  it("derives technology, band and site from the cell id pattern", () => {
    const { cells, issues } = inferCells(["VSKP-004-L2", "VSKP-004-L1", "VSKP-004-L3", "VSKP-004-L4", "VSKP-004-N1", "VSKP-004-L2", "odd"].map(sample));
    expect(cells.map((c) => c.cellId)).toEqual(["VSKP-004-L2", "VSKP-004-L1", "VSKP-004-L3", "VSKP-004-L4", "VSKP-004-N1", "odd"]);
    expect(cells[0]).toEqual({ cellId: "VSKP-004-L2", siteId: "VSKP-004", technology: "LTE", band: "B40", bandwidthMHz: 20, azimuthDeg: 120 });
    expect(cells[1]).toMatchObject({ technology: "LTE", band: "B3", azimuthDeg: 0 });
    expect(cells[2]).toMatchObject({ technology: "LTE", band: "B1", azimuthDeg: 240 });
    expect(cells[3]).toMatchObject({ technology: "LTE", band: "B3" });
    expect(cells[4]).toEqual({ cellId: "VSKP-004-N1", siteId: "VSKP-004", technology: "NR", band: "n78", bandwidthMHz: 100, azimuthDeg: 0 });
    expect(cells[5]).toMatchObject({ cellId: "odd", siteId: "odd", technology: "LTE" });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: "warning" });
    expect(issues[0].message).toMatch(/"odd"/);
  });

  it("creates placeholder sites with NaN coordinates and keeps provided ones", () => {
    const cells: Cell[] = [
      { cellId: "A-1-L1", siteId: "A-1", technology: "LTE", band: "B3", bandwidthMHz: 20, azimuthDeg: 0 },
      { cellId: "B-2-N1", siteId: "B-2", technology: "NR", band: "n78", bandwidthMHz: 100, azimuthDeg: 0 },
      { cellId: "A-1-L2", siteId: "A-1", technology: "LTE", band: "B40", bandwidthMHz: 20, azimuthDeg: 120 },
    ];
    const inferred = inferSites(cells);
    expect(inferred).toEqual([
      { siteId: "A-1", name: "A-1", lat: NaN, lon: NaN, region: "imported" },
      { siteId: "B-2", name: "B-2", lat: NaN, lon: NaN, region: "imported" },
    ]);
    const given = inferSites(cells, [{ siteId: "B-2", name: "Beta", lat: 17.7, lon: 83.3, region: "West" }]);
    expect(given).toEqual([
      { siteId: "B-2", name: "Beta", lat: 17.7, lon: 83.3, region: "West" },
      { siteId: "A-1", name: "A-1", lat: NaN, lon: NaN, region: "imported" },
    ]);
  });
});

describe("cells / sites / alarms files", () => {
  it("parses cells.json and reports structural problems", () => {
    expect(parseCellsJson(fixture("cells.json")).cells).toHaveLength(4);
    expect(parseCellsJson(fixture("cells.json")).cells[0]).toMatchObject({ cellId: "DEMO-001-L1", band: "B20", bandwidthMHz: 10 });
    expect(errors(parseCellsJson("{ not json").issues)[0].message).toMatch(/JSON/);
    expect(errors(parseCellsJson('{"cellId":"x"}').issues)[0].message).toMatch(/array/i);
    const partial = parseCellsJson('[{"cellId":"X-001-N1"},{"siteId":"no-id"},{"cellId":"X-001-L1","technology":"5G"}]');
    expect(partial.cells).toHaveLength(2);
    expect(partial.cells[0]).toEqual({ cellId: "X-001-N1", siteId: "X-001", technology: "NR", band: "n78", bandwidthMHz: 100, azimuthDeg: 0 });
    expect(errors(partial.issues)).toHaveLength(1);
    expect(errors(partial.issues)[0]).toMatchObject({ row: 2 });
    expect(warnings(partial.issues).some((w) => /technology/.test(w.message) && w.row === 3)).toBe(true);
    expect(partial.cells[1].technology).toBe("LTE");
  });

  it("parses sites.json and warns about missing coordinates", () => {
    expect(parseSitesJson(fixture("sites.json")).sites).toEqual([
      { siteId: "DEMO-001", name: "Harbour", lat: 17.6868, lon: 83.2185, region: "DEMO-East" },
      { siteId: "DEMO-002", name: "Hill View", lat: 17.7231, lon: 83.3012, region: "DEMO-West" },
    ]);
    const r = parseSitesJson('[{"siteId":"S-1"},{"name":"nameless"}]');
    expect(r.sites).toEqual([{ siteId: "S-1", name: "S-1", lat: NaN, lon: NaN, region: "imported" }]);
    expect(errors(r.issues)).toHaveLength(1);
    expect(warnings(r.issues).some((w) => /coordinates/i.test(w.message))).toBe(true);
  });

  it("parses alarms.csv with quoted causes and optional fields", () => {
    const { alarms, issues } = parseAlarmsCsv(fixture("alarms.csv"));
    expect(errors(issues)).toEqual([]);
    expect(alarms).toHaveLength(3);
    expect(alarms[0]).toEqual({
      alarmId: "ALM-D-0001", timestamp: "2026-09-23T06:58:12.000Z", clearedAt: "2026-09-23T07:14:40.000Z", siteId: "DEMO-002", cellId: "DEMO-002-L1",
      technology: "LTE", severity: "Critical", probableCause: "Cell down", state: "cleared",
    });
    expect(alarms[2]).toEqual({ alarmId: "ALM-D-0003", timestamp: "2026-09-23T05:10:30.000Z", siteId: "DEMO-001", severity: "Minor", probableCause: "Transmission link degraded, link 2", state: "acknowledged" });
    expect("cellId" in alarms[2]).toBe(false);
    expect("clearedAt" in alarms[2]).toBe(false);
  });

  it("validates alarm rows: timestamps are errors, unknown severity/state are warnings with fallbacks", () => {
    const csv = "alarmId,timestamp,siteId,severity,probableCause,state\nA1,bad,S-1,Major,x,active\nA2,2026-09-23T06:00:00Z,S-1,Huge,x,open\n,2026-09-23T06:00:00Z,S-1,Major,x,active";
    const { alarms, issues } = parseAlarmsCsv(csv);
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatchObject({ alarmId: "A2", severity: "Warning", state: "active" });
    expect(errors(issues).map((e) => e.row)).toEqual([2, 4]);
    expect(warnings(issues).filter((w) => w.row === 3)).toHaveLength(2);
  });

  it("classifies files by content, falling back to the file name", () => {
    expect(classifyImportFile("kpi_small.csv", fixture("kpi_small.csv"))).toBe("kpi");
    expect(classifyImportFile("whatever.csv", fixture("kpi_bad.csv"))).toBe("kpi");
    expect(classifyImportFile("cells.json", fixture("cells.json"))).toBe("cells");
    expect(classifyImportFile("sites.json", fixture("sites.json"))).toBe("sites");
    expect(classifyImportFile("alarms.csv", fixture("alarms.csv"))).toBe("alarms");
    expect(classifyImportFile("alarms.json", JSON.stringify([{ alarmId: "A", timestamp: "2026-09-23T06:00:00Z", siteId: "S", severity: "Major", probableCause: "x", state: "active" }]))).toBe("alarms");
    expect(classifyImportFile("cells.csv", "cellId,siteId,technology,band,bandwidthMHz,azimuthDeg\nX-1-L1,X-1,LTE,B3,20,0")).toBe("cells");
    expect(classifyImportFile("my_sites.json", "[]")).toBe("sites");
    expect(classifyImportFile("notes.txt", "hello")).toBe("unknown");
  });
});

describe("importDataset", () => {
  it("builds a Dataset from the four fixtures with a summary", () => {
    const r = importDataset({ kpiCsv: fixture("kpi_small.csv"), cellsJson: fixture("cells.json"), sitesJson: fixture("sites.json"), alarmsCsv: fixture("alarms.csv") }, { label: "demo" });
    expect(errors(r.issues)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.label).toBe("demo");
    expect(r.summary).toEqual({ rows: 32, cells: 4, sites: 2, alarms: 3, start: "2026-09-23T06:15:00.000Z", end: "2026-09-23T08:00:00.000Z", intervalMin: 15 });
    const ds = r.dataset!;
    expect(ds.samples).toHaveLength(32);
    expect(ds.cells.find((c) => c.cellId === "DEMO-001-L1")).toMatchObject({ band: "B20", bandwidthMHz: 10, azimuthDeg: 30 });
    expect(ds.sites.map((s) => s.name)).toEqual(["Harbour", "Hill View"]);
    expect(ds.alarms).toHaveLength(3);
    expect(ds.incidents).toEqual([]);
    expect(ds.packetStats).toEqual([]);
    expect(ds.conversations).toEqual([]);
    expect(ds.tcpSummary).toEqual({ packets: 0, retransmissions: 0, retransmissionPct: 0, rttAvgMs: 0, rttP95Ms: 0 });
  });

  it("infers cells and sites when only the KPI CSV is given", () => {
    const r = importDataset({ kpiCsv: fixture("kpi_small.csv") });
    expect(r.ok).toBe(true);
    expect(r.label).toBe("Imported dataset");
    expect(r.dataset?.cells.map((c) => c.cellId)).toEqual(["DEMO-001-L1", "DEMO-001-N1", "DEMO-002-L1", "DEMO-002-N1"]);
    expect(r.dataset?.cells[1]).toMatchObject({ technology: "NR", band: "n78", bandwidthMHz: 100 });
    expect(r.dataset?.sites).toEqual([
      { siteId: "DEMO-001", name: "DEMO-001", lat: NaN, lon: NaN, region: "imported" },
      { siteId: "DEMO-002", name: "DEMO-002", lat: NaN, lon: NaN, region: "imported" },
    ]);
    expect(r.dataset?.alarms).toEqual([]);
    expect(r.summary.alarms).toBe(0);
  });

  it("fails without a dataset when the KPI file has errors", () => {
    const r = importDataset({ kpiCsv: fixture("kpi_bad.csv") });
    expect(r.ok).toBe(false);
    expect(r.dataset).toBeUndefined();
    expect(errors(r.issues).map((e) => [e.file, e.row])).toEqual([["kpi", 1], ["kpi", 3]]);
    expect(r.summary.rows).toBe(2);
  });

  it("flags cells in the KPI file that the cells file does not describe, and keeps extra cells", () => {
    const r = importDataset({ kpiCsv: fixture("kpi_small.csv"), cellsJson: '[{"cellId":"DEMO-001-L1","siteId":"DEMO-001","technology":"LTE","band":"B20","bandwidthMHz":10,"azimuthDeg":30},{"cellId":"DEMO-009-L1"}]' });
    expect(r.ok).toBe(true);
    expect(r.dataset?.cells.map((c) => c.cellId)).toEqual(["DEMO-001-L1", "DEMO-009-L1", "DEMO-001-N1", "DEMO-002-L1", "DEMO-002-N1"]);
    expect(warnings(r.issues).some((w) => /3 cell/.test(w.message) && /not in the cells file/i.test(w.message))).toBe(true);
    expect(r.summary.cells).toBe(5);
    expect(r.summary.sites).toBe(3);
  });

  it("passes packet statistics through and applies the row limit", () => {
    const packets = { packetStats: [{ protocol: "TCP", packets: 1, bytes: 2 }], conversations: [], tcpSummary: { packets: 1, retransmissions: 0, retransmissionPct: 0, rttAvgMs: 1, rttP95Ms: 2 } };
    expect(importDataset({ kpiCsv: fixture("kpi_small.csv") }, { packets }).dataset?.packetStats).toEqual(packets.packetStats);
    const limited = importDataset({ kpiCsv: fixture("kpi_small.csv") }, { maxRows: 10 });
    expect(limited.ok).toBe(false);
    expect(errors(limited.issues)[0].message).toMatch(/limit/i);
  });

  it("produces samples that the analytics engine accepts", () => {
    const r = importDataset({ kpiCsv: fixture("kpi_small.csv"), cellsJson: fixture("cells.json") });
    const ds = r.dataset!;
    const cells = new Map(ds.cells.map((c) => [c.cellId, c]));
    const end = Date.parse(r.summary.end);
    const win = inWindow(ds.samples, end, 6 * 3600e3);
    expect(win).toHaveLength(32);
    const agg = aggregateByCell(win, cells, DEFAULT_THRESHOLDS);
    expect(agg).toHaveLength(4);
    expect(agg.find((a) => a.cellId === "DEMO-002-L1")?.downIntervals).toBe(1);
    expect(agg.find((a) => a.cellId === "DEMO-002-L1")?.samples).toBe(8);
    expect(agg.find((a) => a.cellId === "DEMO-001-N1")?.values.dlThroughputMbps).toBeCloseTo(286.7, 0);
    expect(() => detectIssues(win, cells, DEFAULT_THRESHOLDS)).not.toThrow();
  });

  it("round-trips the generated data files byte-for-byte", () => {
    const kpiText = dataFile("kpi_15min.csv");
    const alarmsText = dataFile("alarms.csv");
    const r = importDataset({ kpiCsv: kpiText, alarmsCsv: alarmsText });
    expect(errors(r.issues)).toEqual([]);
    expect(r.summary).toMatchObject({ rows: 32_256, cells: 48, sites: 12, alarms: 300, intervalMin: 15, start: "2026-09-16T09:00:00.000Z", end: "2026-09-23T08:45:00.000Z" });
    const ds = r.dataset!;
    expect(toCsv(ds.samples as unknown as Record<string, unknown>[])).toBe(kpiText);
    expect(toCsv(ds.alarms as unknown as Record<string, unknown>[], ["alarmId", "timestamp", "clearedAt", "siteId", "cellId", "technology", "severity", "probableCause", "state"])).toBe(alarmsText);
  });

  it("ships a sample CSV that imports cleanly", () => {
    const text = sampleKpiCsv();
    expect(text.split("\r\n")[0]).toBe(KPI_HEADER);
    const r = importDataset({ kpiCsv: text });
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.summary.rows).toBeGreaterThanOrEqual(3);
  });
});
