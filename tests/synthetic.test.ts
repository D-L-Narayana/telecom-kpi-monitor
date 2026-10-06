/**
 * Locks the synthetic generator: shape, traffic curve, incident windows (README IST timeline), alarm state split
 * and — most importantly — byte identity between a fresh generation and the committed gen:data artefacts in data/.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { toCsv } from "../src/lib/csv";
import {
  DATASET_END,
  DATASET_START,
  DAYS,
  INCIDENT_WINDOWS,
  INTERVALS_PER_DAY,
  SEED,
  generateDataset,
  trafficCurve,
} from "../src/lib/synthetic";
import type { AlarmState, KpiSample } from "../src/types/telecom";

const IST_OFFSET_MS = 5.5 * 3600e3;
const INTERVAL_MS = 15 * 60e3;
const KPI_CSV_HEADER =
  "cellId,timestamp,callDropRatePct,rrcSetupSuccessPct,handoverSuccessPct,dlThroughputMbps,ulThroughputMbps,latencyMs,prbUtilizationPct,rsrpAvgDbm,sinrAvgDb,activeUsers";
const ALARM_CSV_COLUMNS = ["alarmId", "timestamp", "clearedAt", "siteId", "cellId", "technology", "severity", "probableCause", "state"];

/** "YYYY-MM-DD HH:mm IST" for a UTC instant — the notation the README uses for the incident timeline. */
function istLabel(utc: number | string): string {
  const d = new Date(new Date(utc).getTime() + IST_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} IST`;
}

/** IST wall-clock hour as a fraction (14:30 IST → 14.5). */
function istHour(utc: number | string): number {
  const d = new Date(new Date(utc).getTime() + IST_OFFSET_MS);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
// vitest runs from the package root (its project root), so the committed artefacts live under <cwd>/data.
const committed = (name: string) => readFileSync(resolve(process.cwd(), "data", name));
const asRows = (rows: object[]) => rows as Record<string, unknown>[];

/** Describes the first difference between the generated and the committed text (null when identical). */
function firstDifference(generated: string, expected: string): string | null {
  const n = Math.min(generated.length, expected.length);
  for (let i = 0; i < n; i++) {
    if (generated[i] !== expected[i]) {
      const line = generated.slice(0, i).split("\n").length;
      return `offset ${i} (line ${line}): generated ${JSON.stringify(generated.slice(i, i + 40))} vs committed ${JSON.stringify(expected.slice(i, i + 40))}`;
    }
  }
  return generated.length === expected.length ? null : `length ${generated.length} vs committed ${expected.length}`;
}

describe("synthetic dataset", () => {
  const data = generateDataset();
  const startIso = new Date(DATASET_START).toISOString();
  const endIso = new Date(DATASET_END).toISOString();
  const samplesOf = (cellId: string) => data.samples.filter((s) => s.cellId === cellId);
  const within = (w: { start: string; end: string }) => (s: KpiSample) => s.timestamp >= w.start && s.timestamp < w.end;

  it("has the documented size and time anchors", () => {
    expect(endIso).toBe("2026-09-23T09:00:00.000Z"); // 23 Sep 2026 14:30 IST = dataset "now"
    expect(DATASET_END - DATASET_START).toBe(DAYS * 24 * 3600e3);
    expect(data.sites).toHaveLength(12);
    expect(data.cells).toHaveLength(48);
    expect(data.samples).toHaveLength(32_256);
    expect(data.samples).toHaveLength(DAYS * INTERVALS_PER_DAY * data.cells.length);
    expect(data.alarms).toHaveLength(300);
    expect(data.samples[0].timestamp).toBe(startIso);
    expect(data.samples[data.samples.length - 1].timestamp).toBe(new Date(DATASET_END - INTERVAL_MS).toISOString());
  });

  it("is deterministic for the default seed and sensitive to other seeds", () => {
    expect(sha256(JSON.stringify(generateDataset(SEED)))).toBe(sha256(JSON.stringify(data)));
    expect(generateDataset(SEED + 1).sites[0].lat).not.toBe(data.sites[0].lat);
  });

  describe("trafficCurve", () => {
    const day = Array.from({ length: INTERVALS_PER_DAY }, (_, i) => DATASET_START + i * INTERVAL_MS);

    it("stays within [0.25, 1] across a full day", () => {
      for (const ts of day) {
        const v = trafficCurve(ts);
        expect(v).toBeGreaterThanOrEqual(0.25);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(Math.min(...day.map(trafficCurve))).toBe(0.25);
    });

    it("peaks between 19:00 and 22:00 IST and bottoms out at 04:00 IST", () => {
      const points = day.map((ts) => ({ ts, v: trafficCurve(ts) }));
      const peak = points.reduce((a, b) => (b.v > a.v ? b : a));
      const trough = points.reduce((a, b) => (b.v < a.v ? b : a));
      expect(istHour(peak.ts)).toBeGreaterThanOrEqual(19);
      expect(istHour(peak.ts)).toBeLessThanOrEqual(22);
      expect(istHour(trough.ts)).toBe(4);
      expect(peak.v).toBeGreaterThan(0.8);
    });
  });

  describe("INCIDENT_WINDOWS", () => {
    const windowOf = (id: string) => {
      const w = INCIDENT_WINDOWS.find((x) => x.id === id);
      expect(w, `${id} missing from INCIDENT_WINDOWS`).toBeDefined();
      if (!w) throw new Error(`${id} missing from INCIDENT_WINDOWS`);
      return w;
    };
    const alarmOf = (alarmId: string) => data.alarms.find((a) => a.alarmId === alarmId);

    it("lists the four injected incidents in order with their alarm ids", () => {
      expect(INCIDENT_WINDOWS.map((w) => [w.id, w.kind, w.alarmId])).toEqual([
        ["INC-1", "outage", "ALM-000001"],
        ["INC-2", "congestion", "ALM-000002"],
        ["INC-3", "transmission", "ALM-000003"],
        ["INC-4", "antenna", "ALM-000004"],
      ]);
    });

    it("mirrors generateDataset().incidents as ISO 8601 UTC", () => {
      expect(data.incidents).toHaveLength(4);
      for (const inc of data.incidents) {
        const w = INCIDENT_WINDOWS.find((x) => x.id === inc.id);
        expect(w, `${inc.id} missing from INCIDENT_WINDOWS`).toEqual({
          id: inc.id,
          kind: inc.kind,
          title: inc.title,
          siteId: inc.siteId,
          cellIds: inc.cellIds,
          alarmId: inc.alarmId,
          start: new Date(inc.start).toISOString(),
          end: new Date(inc.end).toISOString(),
        });
      }
    });

    it("matches the README incident timeline (IST)", () => {
      expect(INCIDENT_WINDOWS.map((w) => `${w.id} ${istLabel(w.start)} → ${istLabel(w.end)}`)).toEqual([
        "INC-1 2026-09-18 09:00 IST → 2026-09-18 15:00 IST",
        "INC-2 2026-09-19 18:00 IST → 2026-09-22 23:00 IST",
        "INC-3 2026-09-20 11:00 IST → 2026-09-20 13:00 IST",
        "INC-4 2026-09-21 00:00 IST → 2026-09-23 14:30 IST",
      ]);
    });

    it("raises each incident alarm at the window start and clears it at the window end", () => {
      const w1 = windowOf("INC-1");
      const w2 = windowOf("INC-2");
      const w3 = windowOf("INC-3");
      const w4 = windowOf("INC-4");
      expect(alarmOf("ALM-000001")).toMatchObject({ timestamp: w1.start, clearedAt: w1.end, state: "cleared", severity: "Critical", cellId: "VSKP-004-L2", probableCause: "Cell down" });
      expect(alarmOf("ALM-000002")).toMatchObject({ timestamp: w2.start, state: "active", severity: "Major", cellId: "VSKP-007-N1", probableCause: "High PRB utilization" });
      expect(alarmOf("ALM-000002")?.clearedAt).toBeUndefined();
      expect(alarmOf("ALM-000003")).toMatchObject({ timestamp: w3.start, clearedAt: w3.end, state: "cleared", severity: "Major", siteId: "VSKP-010", probableCause: "Transmission link degraded" });
      expect(alarmOf("ALM-000004")).toMatchObject({ timestamp: w4.start, state: "acknowledged", severity: "Minor", cellId: "VSKP-002-L1", probableCause: "VSWR high" });
      expect(alarmOf("ALM-000004")?.clearedAt).toBeUndefined();
    });

    it("injects the documented KPI effects inside each window and nowhere else", () => {
      // INC-1 cell outage: 6 h = 24 intervals without counters; counters present at every other time
      const w1 = windowOf("INC-1");
      const outageCell = samplesOf("VSKP-004-L2");
      const down = outageCell.filter(within(w1));
      expect(down).toHaveLength(24);
      expect(down.every((s) => s.prbUtilizationPct === null && s.callDropRatePct === null && s.dlThroughputMbps === null && s.activeUsers === 0)).toBe(true);
      expect(outageCell.filter((s) => !within(w1)(s)).every((s) => s.prbUtilizationPct !== null)).toBe(true);

      // INC-2 evening congestion: 18:00–23:59 IST inside the window → PRB 90–98 %, CDR 3–4 %; daytime unaffected
      const w2 = windowOf("INC-2");
      const congestedCell = samplesOf("VSKP-007-N1").filter(within(w2));
      const evenings = congestedCell.filter((s) => istHour(s.timestamp) >= 18);
      expect(evenings).toHaveLength(92); // 3 full evenings × 24 intervals + 20 intervals on the last evening (ends 23:00)
      for (const s of evenings) {
        expect(s.prbUtilizationPct).toBeGreaterThanOrEqual(90);
        expect(s.prbUtilizationPct).toBeLessThanOrEqual(98);
        expect(s.callDropRatePct).toBeGreaterThanOrEqual(3);
        expect(s.callDropRatePct).toBeLessThanOrEqual(4);
      }
      expect(congestedCell.filter((s) => istHour(s.timestamp) < 18).every((s) => (s.prbUtilizationPct ?? 0) < 90)).toBe(true);

      // INC-3 transmission fault: all four VSKP-010 cells, 2 h = 8 intervals each, latency 120–180 ms
      const w3 = windowOf("INC-3");
      const siteCells = data.cells.filter((c) => c.siteId === "VSKP-010").map((c) => c.cellId);
      expect(w3.cellIds).toEqual(siteCells);
      const degraded = data.samples.filter((s) => siteCells.includes(s.cellId)).filter(within(w3));
      expect(degraded).toHaveLength(32);
      for (const s of degraded) {
        expect(s.latencyMs).toBeGreaterThanOrEqual(120);
        expect(s.latencyMs).toBeLessThanOrEqual(180);
      }

      // INC-4 antenna / VSWR fault: handover success 88–89.5 % from 21 Sep 00:00 IST until the dataset end
      const w4 = windowOf("INC-4");
      const antennaCell = samplesOf("VSKP-002-L1").filter(within(w4));
      expect(antennaCell).toHaveLength(250); // 62.5 h × 4
      for (const s of antennaCell) {
        expect(s.handoverSuccessPct).toBeGreaterThanOrEqual(88);
        expect(s.handoverSuccessPct).toBeLessThanOrEqual(89.5);
      }
    });
  });

  describe("alarms", () => {
    it("splits the 296 random alarms ≈ 70 % cleared / 20 % active / 10 % acknowledged (± 5 pp)", () => {
      const incidentAlarms = new Set(["ALM-000001", "ALM-000002", "ALM-000003", "ALM-000004"]);
      const random = data.alarms.filter((a) => !incidentAlarms.has(a.alarmId));
      expect(random).toHaveLength(296);
      const pct = (state: AlarmState) => (random.filter((a) => a.state === state).length / random.length) * 100;
      expect(pct("cleared")).toBeGreaterThanOrEqual(65);
      expect(pct("cleared")).toBeLessThanOrEqual(75);
      expect(pct("active")).toBeGreaterThanOrEqual(15);
      expect(pct("active")).toBeLessThanOrEqual(25);
      expect(pct("acknowledged")).toBeGreaterThanOrEqual(5);
      expect(pct("acknowledged")).toBeLessThanOrEqual(15);
      // exact split of the committed dataset; a change here means the PRNG draw order moved
      const count = (state: AlarmState) => data.alarms.filter((a) => a.state === state).length;
      expect([count("cleared"), count("active"), count("acknowledged")]).toEqual([206, 68, 26]);
    });

    it("is sorted newest first, with raise and clear times inside the dataset", () => {
      for (let i = 1; i < data.alarms.length; i++) {
        expect(data.alarms[i - 1].timestamp >= data.alarms[i].timestamp).toBe(true);
      }
      for (const a of data.alarms) {
        expect(a.timestamp >= startIso && a.timestamp <= endIso).toBe(true);
        if (a.state === "cleared") {
          expect(a.clearedAt, a.alarmId).toBeDefined();
          expect((a.clearedAt ?? "") >= a.timestamp && (a.clearedAt ?? "") <= endIso).toBe(true);
        } else {
          expect(a.clearedAt, a.alarmId).toBeUndefined();
        }
      }
    });
  });

  describe("gen:data artefacts", () => {
    it("sha256(toCsv(samples)) equals sha256(data/kpi_15min.csv): one header + 32,256 rows", () => {
      const csv = toCsv(asRows(data.samples));
      const lines = csv.split("\r\n");
      expect(lines).toHaveLength(32_257);
      expect(lines[0]).toBe(KPI_CSV_HEADER);
      expect(sha256(csv)).toBe(sha256(committed("kpi_15min.csv")));
    });

    it("every file written by scripts/generate-synthetic-data.mjs is byte-identical to data/", () => {
      const artefacts: [string, string][] = [
        ["sites.json", JSON.stringify(data.sites, null, 2)],
        ["cells.json", JSON.stringify(data.cells, null, 2)],
        ["alarms.json", JSON.stringify(data.alarms, null, 2)],
        ["packet_stats.json", JSON.stringify({ protocolHierarchy: data.packetStats, topConversations: data.conversations, tcpSummary: data.tcpSummary }, null, 2)],
        ["kpi_15min.csv", toCsv(asRows(data.samples))],
        ["alarms.csv", toCsv(asRows(data.alarms), ALARM_CSV_COLUMNS)],
      ];
      for (const [name, text] of artefacts) {
        const file = committed(name);
        expect(firstDifference(text, file.toString("utf8")), name).toBeNull();
        expect(sha256(text), name).toBe(sha256(file));
      }
    });
  });
});
