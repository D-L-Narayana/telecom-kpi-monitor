import { describe, expect, it } from "vitest";
import { callDropRatePct, successPct, prbUtilizationPct, mean, aggregateByCell, detectIssues, inWindow } from "../src/lib/kpi";
import { DEFAULT_THRESHOLDS, classify } from "../src/lib/thresholds";
import { generateDataset, DATASET_END, DAYS, INTERVALS_PER_DAY } from "../src/lib/synthetic";
import { toCsv } from "../src/lib/csv";
import { parseWiresharkCsv, parseTsharkJson } from "../src/lib/pcap";

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

describe("exports and parsers", () => {
  it("quotes CSV fields", () => {
    expect(toCsv([{ a: 'x,"y"', b: 1 }])).toBe('a,b\r\n"x,""y""",1');
  });
  it("parses a Wireshark CSV export", () => {
    const csv = '"No.","Time","Source","Destination","Protocol","Length","Info"\n"1","0","10.0.0.1","10.0.0.2","TCP","74","x"\n"2","0.1","10.0.0.2","10.0.0.1","TCP","66","y"\n"3","0.2","10.0.0.1","8.8.8.8","DNS","80","q"';
    const s = parseWiresharkCsv(csv);
    expect(s[0]).toMatchObject({ protocol: "TCP", packets: 2, bytes: 140 });
    expect(s[1]).toMatchObject({ protocol: "DNS", packets: 1, bytes: 80 });
  });
  it("parses tshark JSON", () => {
    const j = JSON.stringify([{ _source: { layers: { frame: { "frame.protocols": "eth:ethertype:ip:udp:gtp:ip:tcp", "frame.len": "120" } } } }]);
    expect(parseTsharkJson(j)[0]).toMatchObject({ protocol: "tcp", packets: 1, bytes: 120 });
  });
});
