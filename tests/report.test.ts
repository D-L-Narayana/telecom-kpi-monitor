import { describe, expect, it, vi } from "vitest";
import { DATASET_END, generateDataset } from "../src/lib/synthetic";
import { CORE_KPIS, KPI_META, RANGE_MS, filterTech, inWindow, type TimeRange } from "../src/lib/kpi";
import { DEFAULT_THRESHOLDS } from "../src/lib/thresholds";
import {
  MAX_ALARM_LINES,
  REPORT_NOTES_KEY,
  buildShiftReport,
  reportFilename,
  reportToCsvSections,
  reportToMarkdown,
  type ShiftReportInput,
} from "../src/lib/report";
import type { Alarm, AlarmState, Cell, KpiSample, Site, Technology } from "../src/types/telecom";

/* ---------- synthetic dataset input (the same windows the pages build) ---------- */

const data = generateDataset();
const cells = new Map(data.cells.map((c) => [c.cellId, c]));
const SOURCE = { kind: "synthetic", label: "Synthetic dataset (seed 20260923)" };

function syntheticInput(range: TimeRange = "7d", tech: Technology | "All" = "All", notes?: string): ShiftReportInput {
  const rangeMs = RANGE_MS[range];
  return {
    now: DATASET_END, range, tech,
    samples: filterTech(inWindow(data.samples, DATASET_END, rangeMs), cells, tech),
    prevSamples: filterTech(inWindow(data.samples, DATASET_END - rangeMs, rangeMs), cells, tech),
    cells, sites: data.sites, alarms: data.alarms, thresholds: DEFAULT_THRESHOLDS, source: SOURCE, notes,
  };
}

/** Body of a level-2 markdown section: the text between its heading line and the next `## ` heading. */
function section(md: string, heading: string): string {
  const start = md.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`heading ${heading} not found in markdown`);
  const rest = md.slice(start + heading.length + 2);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}

/* ---------- hand-made fixtures: a 1h window ending 10 Jan 2026 12:00 UTC (17:30 IST) ---------- */

const T0 = Date.UTC(2026, 0, 10, 12, 0, 0);
const STEP = 15 * 60e3;
const HOUR = 3600e3;
const MIN = 60e3;
const iso = (ms: number) => new Date(ms).toISOString();

const craftedCells: Cell[] = [
  { cellId: "SITE-1-L1", siteId: "SITE-1", technology: "LTE", band: "B3", bandwidthMHz: 20, azimuthDeg: 0 },
  { cellId: "SITE-1-N1", siteId: "SITE-1", technology: "NR", band: "n78", bandwidthMHz: 100, azimuthDeg: 0 },
];
const craftedSites: Site[] = [{ siteId: "SITE-1", name: "Test site", lat: 17.7, lon: 83.2, region: "Test region" }];

/** One sample `i` intervals before the crafted window end (i = 0 is the end itself, which `inWindow` includes). */
function sample(cellId: string, i: number, patch: Partial<KpiSample> = {}): KpiSample {
  return {
    cellId, timestamp: iso(T0 - i * STEP),
    callDropRatePct: 0.5, rrcSetupSuccessPct: 99.1, handoverSuccessPct: 98.2, dlThroughputMbps: 30, ulThroughputMbps: 8,
    latencyMs: 25, prbUtilizationPct: 40, rsrpAvgDbm: -95, sinrAvgDb: 12, activeUsers: 50, ...patch,
  };
}
function alarm(alarmId: string, at: number, state: AlarmState, patch: Partial<Alarm> = {}): Alarm {
  return { alarmId, timestamp: iso(at), siteId: "SITE-1", severity: "Major", probableCause: "Test cause", state, ...patch };
}
function craftedInput(patch: Partial<ShiftReportInput> = {}): ShiftReportInput {
  return {
    now: T0, range: "1h", tech: "All",
    samples: [0, 1, 2, 3].map((i) => sample("SITE-1-L1", i)),
    prevSamples: [4, 5, 6, 7].map((i) => sample("SITE-1-L1", i)),
    cells: new Map(craftedCells.map((c) => [c.cellId, c])), sites: craftedSites, alarms: [], thresholds: DEFAULT_THRESHOLDS,
    source: { kind: "imported", label: "crafted.csv" }, ...patch,
  };
}

const WINDOW_START = T0 - HOUR;
/** Alarms around the crafted window: boundaries are inclusive, clearance is judged by `clearedAt`, NR alarms carry a technology. */
const windowAlarms: Alarm[] = [
  alarm("A-START", WINDOW_START, "active"),
  alarm("A-END", T0, "active"),
  alarm("A-BEFORE", WINDOW_START - 1, "active"),
  alarm("A-AFTER", T0 + 1, "active"),
  alarm("A-CLEARED-IN", WINDOW_START - 2 * HOUR, "cleared", { clearedAt: iso(T0 - 10 * MIN), severity: "Critical" }),
  alarm("A-CLEARED-OUT", WINDOW_START - 3 * HOUR, "cleared", { clearedAt: iso(WINDOW_START - HOUR) }),
  alarm("A-ACK", WINDOW_START - HOUR, "acknowledged", { severity: "Minor" }),
  alarm("A-NR", T0 - 5 * MIN, "active", { technology: "NR", cellId: "SITE-1-N1", severity: "Warning" }),
];

describe("buildShiftReport", () => {
  it("derives generatedAt and the window from the input clock, never from the wall clock", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2031-01-01T00:00:00.000Z"));
      const a = buildShiftReport(syntheticInput("7d"));
      vi.setSystemTime(new Date("2032-06-15T12:34:56.000Z"));
      const b = buildShiftReport(syntheticInput("7d"));
      expect(a.generatedAt).toBe("2026-09-23T09:00:00.000Z");
      expect(a.window).toEqual({ start: "2026-09-16T09:00:00.000Z", end: "2026-09-23T09:00:00.000Z", range: "7d", tech: "All" });
      expect(a.source).toEqual(SOURCE);
      expect(b).toEqual(a);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the seven core KPIs with previous-window deltas and threshold levels", () => {
    const input = craftedInput({
      samples: [0, 1, 2, 3].map((i) => sample("SITE-1-L1", i, { callDropRatePct: 3 })),
      prevSamples: [4, 5, 6, 7].map((i) => sample("SITE-1-L1", i, { callDropRatePct: 1.5 })),
    });
    const r = buildShiftReport(input);
    expect(r.kpis.map((k) => k.kpi)).toEqual(CORE_KPIS);
    const cdr = r.kpis[0];
    expect(cdr).toEqual({ kpi: "callDropRatePct", label: "Call drop rate", unit: "%", value: 3, previous: 1.5, deltaPct: 100, level: "critical" });
    const latency = r.kpis.find((k) => k.kpi === "latencyMs");
    expect(latency).toMatchObject({ label: KPI_META.latencyMs.label, unit: "ms", value: 25, previous: 25, deltaPct: 0, level: "ok" });
    // the NR throughput threshold applies when the technology filter is NR
    const nr = buildShiftReport(craftedInput({ tech: "NR", samples: [0, 1].map((i) => sample("SITE-1-N1", i, { dlThroughputMbps: 60 })), prevSamples: [] }));
    expect(nr.kpis.find((k) => k.kpi === "dlThroughputMbps")).toMatchObject({ value: 60, previous: null, deltaPct: null, level: "warning" });
  });

  it("drops the previous-window comparison when the previous window is too sparse to compare", () => {
    const r = buildShiftReport(craftedInput({ prevSamples: [sample("SITE-1-L1", 4, { callDropRatePct: 9 })] }));
    for (const k of r.kpis) {
      expect(k.previous).toBeNull();
      expect(k.deltaPct).toBeNull();
    }
    expect(r.kpis[0].value).toBe(0.5);
  });

  it("lists the rule-based detections and the ten worst cells for the synthetic 7-day window", () => {
    const r = buildShiftReport(syntheticInput("7d"));
    const outage = r.detections.find((d) => d.kind === "outage" && d.cellId === "VSKP-004-L2");
    expect(outage).toMatchObject({ siteId: "VSKP-004", technology: "LTE", intervals: 24 });
    expect(r.detections.some((d) => d.kind === "congestion" && d.cellId === "VSKP-007-N1")).toBe(true);
    expect(r.worstCells).toHaveLength(10);
    // ranked by mean call drop rate (cells without counters first), then by breaches
    const rank = (v: number | null) => v ?? 99;
    for (let i = 1; i < r.worstCells.length; i++) {
      const a = r.worstCells[i - 1];
      const b = r.worstCells[i];
      const cdrA = rank(a.values.callDropRatePct);
      const cdrB = rank(b.values.callDropRatePct);
      expect(cdrA >= cdrB).toBe(true);
      if (cdrA === cdrB) expect(a.breaches >= b.breaches).toBe(true);
    }
    expect(r.worstCells[0].values.callDropRatePct).toBeGreaterThan(r.worstCells[9].values.callDropRatePct ?? 0);
  });

  it("counts alarms and splits raised / cleared lists by the inclusive window boundaries", () => {
    const r = buildShiftReport(craftedInput({ alarms: windowAlarms }));
    expect(r.alarms.raisedInWindow.map((a) => a.alarmId)).toEqual(["A-END", "A-NR", "A-START"]); // newest first
    expect(r.alarms.clearedInWindow.map((a) => a.alarmId)).toEqual(["A-CLEARED-IN"]);
    expect(r.alarms.active).toBe(5);
    expect(r.alarms.acknowledged).toBe(1);
    expect(r.alarms.bySeverity).toEqual({ Critical: 0, Major: 4, Minor: 1, Warning: 1 });
    expect(Object.keys(r.alarms.bySeverity).sort()).toEqual(["Critical", "Major", "Minor", "Warning"]);
    // the synthetic dataset: every alarm was raised inside the 7-day window, none inside an empty 1h-window check
    const week = buildShiftReport(syntheticInput("7d"));
    expect(week.alarms.raisedInWindow).toHaveLength(data.alarms.length);
    const hour = buildShiftReport(syntheticInput("1h"));
    const expected = data.alarms.filter((a) => a.timestamp >= "2026-09-23T08:00:00.000Z" && a.timestamp <= "2026-09-23T09:00:00.000Z").map((a) => a.alarmId).sort();
    expect(hour.alarms.raisedInWindow.map((a) => a.alarmId).sort()).toEqual(expected);
    for (const a of hour.alarms.raisedInWindow) {
      expect(a.timestamp >= hour.window.start && a.timestamp <= hour.window.end).toBe(true);
    }
  });

  it("applies the technology filter to alarms while keeping site-level alarms without a technology", () => {
    const r = buildShiftReport(craftedInput({ tech: "LTE", alarms: windowAlarms }));
    expect(r.alarms.raisedInWindow.map((a) => a.alarmId)).toEqual(["A-END", "A-START"]);
    expect(r.alarms.active).toBe(4);
    expect(r.alarms.bySeverity).toEqual({ Critical: 0, Major: 4, Minor: 1, Warning: 0 });
    expect(r.window.tech).toBe("LTE");
  });

  it("builds a complete report for an empty window instead of throwing", () => {
    const r = buildShiftReport(craftedInput({ samples: [], prevSamples: [], alarms: windowAlarms, notes: "quiet shift" }));
    expect(r.kpis).toHaveLength(7);
    for (const k of r.kpis) expect(k).toMatchObject({ value: null, previous: null, deltaPct: null, level: "ok" });
    expect(r.detections).toEqual([]);
    expect(r.worstCells).toEqual([]);
    expect(r.alarms.raisedInWindow).toHaveLength(3);
    expect(r.notes).toBe("quiet shift");
    expect(buildShiftReport(craftedInput()).notes).toBe("");
  });
});

describe("reportToMarkdown", () => {
  it("is deterministic and contains every section for the synthetic 7-day window", () => {
    const notes = "Handover: VSKP-004-L2 outage cleared at 15:00 IST; watch VSKP-007-N1 congestion tonight.";
    const first = reportToMarkdown(buildShiftReport(syntheticInput("7d", "All", notes)));
    const second = reportToMarkdown(buildShiftReport(syntheticInput("7d", "All", notes)));
    expect(second).toBe(first);
    expect(first.startsWith("# Shift handover report\n")).toBe(true);
    for (const h of ["## Window", "## KPIs", "## Detections", "## Worst cells", "## Alarms", "## Notes"]) expect(first).toContain(`\n${h}\n`);

    const window = section(first, "## Window");
    expect(window).toContain("| Start | 2026-09-16T09:00:00.000Z |");
    expect(window).toContain("| End | 2026-09-23T09:00:00.000Z |");
    expect(window).toContain("| Range | 7d |");
    expect(window).toContain("| Technology | All |");
    expect(window).toContain("Synthetic dataset (seed 20260923)");

    const kpis = section(first, "## KPIs");
    expect(kpis).toContain("| KPI | Value | Previous | Δ % | Status |");
    expect(kpis).toMatch(/^\| Call drop rate \| \d+\.\d\d % \| – \| – \| (OK|Warning|Critical) \|$/m); // no previous week in the dataset
    expect(kpis).toMatch(/^\| PRB utilization \| \d+\.\d % \| /m);
    expect(kpis.match(/^\| /gm)).toHaveLength(2 + CORE_KPIS.length); // header, separator, seven rows

    const detections = section(first, "## Detections");
    expect(detections).toMatch(/^\| outage \| VSKP-004-L2 \| VSKP-004 \| LTE \| 24 \| 2026-09-18T03:30:00\.000Z \| 2026-09-18T09:15:00\.000Z \| /m);
    expect(detections).toContain("| congestion | VSKP-007-N1 | VSKP-007 | NR |");

    const worst = section(first, "## Worst cells");
    expect(worst).toContain("| # | Cell | Site | Tech | Status | CDR % | RRC % | HO % | DL Mbps | UL Mbps | Latency ms | PRB % | Breaches | Down intervals |");
    expect(worst.match(/^\| \d+ \| VSKP-\d{3}-[LN]\d \| /gm)).toHaveLength(10);

    const alarms = section(first, "## Alarms");
    expect(alarms).toMatch(/^\| Active \| \d+ \|$/m);
    expect(alarms).toMatch(/^\| Acknowledged \| \d+ \|$/m);
    expect(alarms).toContain(`### Raised in window (${data.alarms.length})`);
    expect(alarms).toContain(`… and ${data.alarms.length - MAX_ALARM_LINES} more`);
    expect(alarms).toMatch(/^### Cleared in window \(\d+\)$/m);
    const newest = data.alarms[0]; // the generator sorts alarms newest first, so this one heads the raised list
    expect(alarms).toContain(`| ${newest.alarmId} | ${newest.severity} | ${newest.siteId} | ${newest.cellId ?? "–"} | ${newest.probableCause} | ${newest.timestamp} | ${newest.state} |`);

    expect(section(first, "## Notes").trim()).toBe(notes);
  });

  it("renders the incident alarms with raise and clear times in the raised and cleared lists", () => {
    const incidents = data.alarms.filter((a) => a.alarmId <= "ALM-000004");
    const md = reportToMarkdown(buildShiftReport({ ...syntheticInput("7d"), alarms: incidents }));
    const alarms = section(md, "## Alarms");
    expect(alarms).toContain("### Raised in window (4)");
    expect(alarms).toContain("### Cleared in window (2)");
    expect(alarms).toContain("| Alarm | Severity | Site | Cell | Cause | Raised | State |");
    expect(alarms).toContain("| ALM-000001 | Critical | VSKP-004 | VSKP-004-L2 | Cell down | 2026-09-18T03:30:00.000Z | cleared |");
    expect(alarms).toContain("| Alarm | Severity | Site | Cell | Cause | Raised | Cleared |");
    expect(alarms).toContain("| ALM-000001 | Critical | VSKP-004 | VSKP-004-L2 | Cell down | 2026-09-18T03:30:00.000Z | 2026-09-18T09:30:00.000Z |");
    expect(alarms).toContain("| ALM-000003 | Major | VSKP-010 | – | Transmission link degraded | 2026-09-20T05:30:00.000Z | 2026-09-20T07:30:00.000Z |");
    expect(alarms).not.toContain("… and");
  });

  it("escapes pipes in table cells and renders placeholders for empty sections", () => {
    const odd: Cell = { cellId: "SITE|2-L1", siteId: "SITE|2", technology: "LTE", band: "B3", bandwidthMHz: 20, azimuthDeg: 0 };
    const r = buildShiftReport(craftedInput({
      cells: new Map([...craftedCells, odd].map((c) => [c.cellId, c])),
      samples: [0, 1, 2, 3].map((i) => sample(odd.cellId, i)),
      alarms: [alarm("A|1", T0 - MIN, "active", { probableCause: "Door | open" })],
    }));
    const md = reportToMarkdown(r);
    expect(md).toContain("| 1 | SITE\\|2-L1 | SITE\\|2 | LTE |");
    expect(md).toContain("| A\\|1 | Major | SITE-1 | – | Door \\| open |");
    expect(section(md, "## Detections").trim()).toBe("No rule-based detections in this window.");
    expect(section(md, "## Alarms")).toContain("No alarms cleared in this window.");
    expect(section(md, "## Notes").trim()).toBe("(none)");

    const empty = reportToMarkdown(buildShiftReport(craftedInput({ samples: [], prevSamples: [] })));
    expect(section(empty, "## KPIs")).toMatch(/^\| Call drop rate \| – \| – \| – \| OK \|$/m);
    expect(section(empty, "## Worst cells").trim()).toBe("No cells reported samples in this window.");
    expect(section(empty, "## Alarms")).toContain("No alarms raised in this window.");
  });

  it("truncates long alarm lists to 25 rows followed by an '… and N more' line", () => {
    const many = Array.from({ length: 30 }, (_, i) => alarm(`R-${String(i).padStart(2, "0")}`, T0 - i * MIN, "active"));
    const md = reportToMarkdown(buildShiftReport(craftedInput({ alarms: many })));
    const raised = section(md, "## Alarms");
    expect(raised).toContain("### Raised in window (30)");
    expect(raised).toContain("| R-00 |");
    expect(raised).toContain("| R-24 |");
    expect(raised).not.toContain("| R-25 |");
    expect(raised).toContain("… and 5 more");
    expect(MAX_ALARM_LINES).toBe(25);
  });
});

describe("reportToCsvSections", () => {
  const HEADERS: Record<string, string> = {
    kpis: "kpi,label,unit,value,previous,deltaPct,level",
    detections: "kind,cellId,siteId,technology,intervals,firstSeen,lastSeen,detail",
    worst_cells: "rank,cellId,siteId,technology,worstLevel,breaches,downIntervals,samples,callDropRatePct,rrcSetupSuccessPct,handoverSuccessPct,dlThroughputMbps,ulThroughputMbps,latencyMs,prbUtilizationPct,rsrpAvgDbm,sinrAvgDb",
    alarms_raised: "alarmId,timestamp,clearedAt,siteId,cellId,technology,severity,probableCause,state",
    alarms_cleared: "alarmId,timestamp,clearedAt,siteId,cellId,technology,severity,probableCause,state",
  };
  const lines = (csv: string) => csv.split("\r\n");

  it("returns the five sections with explicit headers and one row per entry", () => {
    const r = buildShiftReport(syntheticInput("7d"));
    const sections = reportToCsvSections(r);
    expect(sections.map((s) => s.name)).toEqual(["kpis", "detections", "worst_cells", "alarms_raised", "alarms_cleared"]);
    for (const s of sections) expect(lines(s.csv)[0]).toBe(HEADERS[s.name]);
    expect(lines(sections[0].csv)).toHaveLength(1 + CORE_KPIS.length);
    expect(lines(sections[0].csv)[1]).toMatch(/^callDropRatePct,Call drop rate,%,\d+\.\d+,,,(ok|warning|critical)$/);
    expect(lines(sections[1].csv)).toHaveLength(1 + r.detections.length);
    expect(lines(sections[2].csv)).toHaveLength(11);
    expect(lines(sections[2].csv)[1].startsWith("1,")).toBe(true);
    expect(lines(sections[3].csv)).toHaveLength(1 + data.alarms.length); // the CSV is not truncated like the markdown
    expect(lines(sections[4].csv)).toHaveLength(1 + r.alarms.clearedInWindow.length);
    expect(sections[3].csv).toContain("ALM-000001,2026-09-18T03:30:00.000Z,2026-09-18T09:30:00.000Z,VSKP-004,VSKP-004-L2,LTE,Critical,Cell down,cleared");
  });

  it("keeps the header line for empty sections and guards spreadsheet formulas", () => {
    const r = buildShiftReport(craftedInput({ samples: [], prevSamples: [], alarms: [alarm("A-1", T0 - MIN, "active", { probableCause: "=HYPERLINK(\"x\")" })] }));
    const byName = Object.fromEntries(reportToCsvSections(r).map((s) => [s.name, s.csv]));
    expect(byName.detections).toBe(HEADERS.detections);
    expect(byName.worst_cells).toBe(HEADERS.worst_cells);
    expect(byName.alarms_cleared).toBe(HEADERS.alarms_cleared);
    expect(lines(byName.kpis)).toHaveLength(8);
    expect(lines(byName.kpis)[1]).toBe("callDropRatePct,Call drop rate,%,,,,ok");
    expect(byName.alarms_raised).toContain("\"'=HYPERLINK(\"\"x\"\")\"");
  });
});

describe("reportFilename", () => {
  it("stamps the window end in IST and appends range, technology and an optional section", () => {
    expect(reportFilename(buildShiftReport(syntheticInput("7d")), "md")).toBe("shift-report_20260923-1430_7d_All.md");
    expect(reportFilename(buildShiftReport(syntheticInput("1h", "NR")), "csv", "kpis")).toBe("shift-report_20260923-1430_1h_NR_kpis.csv");
    expect(reportFilename(buildShiftReport(craftedInput()), "md")).toBe("shift-report_20260110-1730_1h_All.md");
    expect(REPORT_NOTES_KEY).toBe("tkm.report.notes.v1");
  });
});
