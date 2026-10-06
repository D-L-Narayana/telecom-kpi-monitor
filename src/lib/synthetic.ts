/**
 * Synthetic 4G LTE / 5G NR network dataset (PLAN.md section 4).
 * Deterministic: seed 20260923. 12 sites x (3 LTE + 1 NR) cells, 7 days of 15-minute KPI samples,
 * four injected incidents (cell outage, congestion, transmission fault, antenna/VSWR fault), ~300 alarms,
 * one protocol-hierarchy table for a synthetic S1-U / N3 capture.
 */
import { gaussian, mulberry32 } from "./rng";
import type { Alarm, AlarmState, Cell, Conversation, KpiSample, PacketStat, Severity, Site } from "../types/telecom";

export const SEED = 20260923;
export const INTERVAL_MIN = 15;
export const DAYS = 7;
export const INTERVALS_PER_DAY = (24 * 60) / INTERVAL_MIN; // 96
/** Dataset ends at this instant (UTC); the app treats it as "now". 2026-09-23 09:00 UTC = 14:30 IST */
export const DATASET_END = Date.UTC(2026, 8, 23, 9, 0, 0);
export const DATASET_START = DATASET_END - DAYS * 24 * 3600 * 1000;

const LOCALITIES = [
  "Gajuwaka", "MVP Colony", "Dwaraka Nagar", "Madhurawada", "Seethammadhara", "Rushikonda",
  "Pendurthi", "Anakapalle", "Bheemunipatnam", "Kancharapalem", "Akkayyapalem", "Yendada",
];
const REGIONS = ["VSKP-North", "VSKP-Central", "VSKP-South"];

export interface Incident {
  id: string;
  kind: "outage" | "congestion" | "transmission" | "antenna";
  title: string;
  cellIds: string[];
  siteId: string;
  start: number;
  end: number;
  alarmId: string;
}

/** An `Incident` whose window is given as ISO 8601 UTC strings (the format of `KpiSample.timestamp` / `Alarm.timestamp`). */
export interface IncidentWindow extends Omit<Incident, "start" | "end"> {
  start: string;
  end: string;
}

/**
 * The four injected incidents as fixed ISO windows — the same instants `generateDataset().incidents` computes
 * (tests/synthetic.test.ts cross-checks both against the README's IST timeline). Lets pages, reports and tests
 * reference the known windows without regenerating the dataset. IST = UTC+05:30.
 */
export const INCIDENT_WINDOWS: readonly IncidentWindow[] = [
  // 18 Sep 09:00–15:00 IST: VSKP-004-L2 has no counters for 24 intervals
  { id: "INC-1", kind: "outage", title: "Cell outage", cellIds: ["VSKP-004-L2"], siteId: "VSKP-004", start: "2026-09-18T03:30:00.000Z", end: "2026-09-18T09:30:00.000Z", alarmId: "ALM-000001" },
  // 19 Sep 18:00 IST – 22 Sep 23:00 IST: VSKP-007-N1 PRB 90–98 % and CDR 3–4 % every evening from 18:00 IST
  { id: "INC-2", kind: "congestion", title: "Evening congestion", cellIds: ["VSKP-007-N1"], siteId: "VSKP-007", start: "2026-09-19T12:30:00.000Z", end: "2026-09-22T17:30:00.000Z", alarmId: "ALM-000002" },
  // 20 Sep 11:00–13:00 IST: all four VSKP-010 cells at 120–180 ms latency, halved throughput
  { id: "INC-3", kind: "transmission", title: "Transmission link degraded", cellIds: ["VSKP-010-L1", "VSKP-010-L2", "VSKP-010-L3", "VSKP-010-N1"], siteId: "VSKP-010", start: "2026-09-20T05:30:00.000Z", end: "2026-09-20T07:30:00.000Z", alarmId: "ALM-000003" },
  // 21 Sep 00:00 IST until the dataset end (23 Sep 14:30 IST): VSKP-002-L1 RSRP −12 dB, handover success ≈ 88 %
  { id: "INC-4", kind: "antenna", title: "Antenna / VSWR fault", cellIds: ["VSKP-002-L1"], siteId: "VSKP-002", start: "2026-09-20T18:30:00.000Z", end: "2026-09-23T09:00:00.000Z", alarmId: "ALM-000004" },
];

export interface Dataset {
  sites: Site[];
  cells: Cell[];
  samples: KpiSample[];
  alarms: Alarm[];
  packetStats: PacketStat[];
  conversations: Conversation[];
  incidents: Incident[];
  tcpSummary: { packets: number; retransmissions: number; retransmissionPct: number; rttAvgMs: number; rttP95Ms: number };
}

function pad(n: number, w = 3): string {
  return String(n).padStart(w, "0");
}

/** Daily traffic curve in [0.25, 1]: low at 04:00, peak 19:00-22:00 local (IST = UTC+5:30). */
export function trafficCurve(tsUtc: number): number {
  const ist = new Date(tsUtc + 5.5 * 3600 * 1000);
  const h = ist.getUTCHours() + ist.getUTCMinutes() / 60;
  const base = 0.25 + 0.35 * (1 - Math.cos(((h - 4) / 24) * 2 * Math.PI)) / 2; // smooth daily wave
  const evening = h >= 18 && h <= 23 ? 0.4 * Math.exp(-((h - 20.5) ** 2) / 2.2) : 0;
  return Math.min(1, base + evening);
}

export function generateDataset(seed = SEED): Dataset {
  const rand = mulberry32(seed);
  const sites: Site[] = LOCALITIES.map((name, i) => ({
    siteId: `VSKP-${pad(i + 1)}`,
    name,
    lat: 17.69 + (rand() - 0.5) * 0.25,
    lon: 83.22 + (rand() - 0.5) * 0.25,
    region: REGIONS[i % 3],
  }));

  const cells: Cell[] = [];
  const LTE_BANDS = ["B3", "B40", "B1"];
  for (const s of sites) {
    LTE_BANDS.forEach((band, k) =>
      cells.push({ cellId: `${s.siteId}-L${k + 1}`, siteId: s.siteId, technology: "LTE", band, bandwidthMHz: 20, azimuthDeg: k * 120 }),
    );
    cells.push({ cellId: `${s.siteId}-N1`, siteId: s.siteId, technology: "NR", band: "n78", bandwidthMHz: 100, azimuthDeg: 0 });
  }

  // per-cell static offsets (some cells are naturally busier / worse)
  const cellLoad = new Map<string, number>();
  const cellRsrp = new Map<string, number>();
  for (const c of cells) {
    cellLoad.set(c.cellId, 0.75 + rand() * 0.5);
    cellRsrp.set(c.cellId, -95 + (rand() - 0.5) * 10);
  }

  // incidents (PLAN.md 4)
  // IST midnight of the dataset's first (partial) day, as a UTC instant; day(d, h) = h o'clock IST on dataset day d
  const IST = 5.5 * 3600 * 1000;
  const firstMidnightIst = Math.floor((DATASET_START + IST) / 86400000) * 86400000 - IST;
  const day = (d: number, hIst: number) => firstMidnightIst + (d - 1) * 86400000 + hIst * 3600 * 1000;
  const incidents: Incident[] = [
    { id: "INC-1", kind: "outage", title: "Cell outage", cellIds: ["VSKP-004-L2"], siteId: "VSKP-004", start: day(3, 9), end: day(3, 15), alarmId: "ALM-000001" },
    { id: "INC-2", kind: "congestion", title: "Evening congestion", cellIds: ["VSKP-007-N1"], siteId: "VSKP-007", start: day(4, 18), end: day(7, 23), alarmId: "ALM-000002" },
    { id: "INC-3", kind: "transmission", title: "Transmission link degraded", cellIds: cells.filter((c) => c.siteId === "VSKP-010").map((c) => c.cellId), siteId: "VSKP-010", start: day(5, 11), end: day(5, 13), alarmId: "ALM-000003" },
    { id: "INC-4", kind: "antenna", title: "Antenna / VSWR fault", cellIds: ["VSKP-002-L1"], siteId: "VSKP-002", start: day(6, 0), end: DATASET_END, alarmId: "ALM-000004" },
  ];
  const inCongestionWindow = (ts: number) => {
    const ist = new Date(ts + 5.5 * 3600 * 1000);
    const h = ist.getUTCHours();
    return h >= 18 && h <= 23;
  };

  const samples: KpiSample[] = [];
  const nIntervals = DAYS * INTERVALS_PER_DAY;
  for (let i = 0; i < nIntervals; i++) {
    const ts = DATASET_START + i * INTERVAL_MIN * 60 * 1000;
    const curve = trafficCurve(ts);
    const iso = new Date(ts).toISOString();
    for (const c of cells) {
      const load = Math.min(1, curve * (cellLoad.get(c.cellId) ?? 1));
      const noise = () => 1 + 0.05 * gaussian(rand);
      const isNR = c.technology === "NR";
      let prb = Math.min(98, (isNR ? 55 : 62) * load * noise());
      let cdr = (0.3 + 1.2 * load * load) * noise();
      let latency = (isNR ? 14 : 24) * (1 + 0.9 * load * load) * noise();
      let dl = (isNR ? 320 : 42) * (1.15 - 0.55 * load) * noise();
      let ul = (isNR ? 60 : 12) * (1.1 - 0.4 * load) * noise();
      let rrc = 99.4 - 1.3 * load * load * noise();
      let ho = 98.6 - 1.6 * load * load * noise();
      let rsrp = (cellRsrp.get(c.cellId) ?? -95) + gaussian(rand) * 1.5;
      let sinr = (isNR ? 14 : 12) - 5 * load + gaussian(rand) * 1.2;
      let users = Math.round((isNR ? 260 : 110) * load * noise());
      let down = false;

      for (const inc of incidents) {
        if (ts < inc.start || ts >= inc.end || !inc.cellIds.includes(c.cellId)) continue;
        if (inc.kind === "outage") down = true;
        if (inc.kind === "congestion" && inCongestionWindow(ts)) {
          prb = 90 + rand() * 8; cdr = 3 + rand(); latency = latency * 1.8; dl = dl * 0.35; rrc = 94 + rand() * 1.5; users = Math.round(users * 1.6);
        }
        if (inc.kind === "transmission") { latency = 120 + rand() * 60; dl = dl * 0.5; ul = ul * 0.5; cdr = cdr * 1.6; }
        if (inc.kind === "antenna") { rsrp -= 12; sinr -= 6; ho = 88 + rand() * 1.5; cdr = cdr * 1.5; dl = dl * 0.7; }
      }

      samples.push(
        down
          ? { cellId: c.cellId, timestamp: iso, callDropRatePct: null, rrcSetupSuccessPct: null, handoverSuccessPct: null, dlThroughputMbps: null, ulThroughputMbps: null, latencyMs: null, prbUtilizationPct: null, rsrpAvgDbm: null, sinrAvgDb: null, activeUsers: 0 }
          : {
              cellId: c.cellId, timestamp: iso,
              callDropRatePct: r2(Math.max(0, cdr)), rrcSetupSuccessPct: r2(Math.min(100, rrc)), handoverSuccessPct: r2(Math.min(100, ho)),
              dlThroughputMbps: r2(Math.max(0.5, dl)), ulThroughputMbps: r2(Math.max(0.2, ul)), latencyMs: r2(Math.max(5, latency)),
              prbUtilizationPct: r2(Math.max(2, Math.min(100, prb))), rsrpAvgDbm: r2(rsrp), sinrAvgDb: r2(sinr), activeUsers: users,
            },
      );
    }
  }

  // alarms
  const alarms: Alarm[] = [];
  const isoAt = (t: number) => new Date(t).toISOString();
  alarms.push({ alarmId: "ALM-000001", timestamp: isoAt(incidents[0].start), siteId: "VSKP-004", cellId: "VSKP-004-L2", severity: "Critical", probableCause: "Cell down", state: "cleared", clearedAt: isoAt(incidents[0].end), technology: "LTE" });
  alarms.push({ alarmId: "ALM-000002", timestamp: isoAt(incidents[1].start), siteId: "VSKP-007", cellId: "VSKP-007-N1", severity: "Major", probableCause: "High PRB utilization", state: "active", technology: "NR" });
  alarms.push({ alarmId: "ALM-000003", timestamp: isoAt(incidents[2].start), siteId: "VSKP-010", severity: "Major", probableCause: "Transmission link degraded", state: "cleared", clearedAt: isoAt(incidents[2].end) });
  alarms.push({ alarmId: "ALM-000004", timestamp: isoAt(incidents[3].start), siteId: "VSKP-002", cellId: "VSKP-002-L1", severity: "Minor", probableCause: "VSWR high", state: "acknowledged", technology: "LTE" });
  const RANDOM_CAUSES: { cause: string; severity: Severity; cellLevel: boolean }[] = [
    { cause: "Battery on discharge", severity: "Minor", cellLevel: false },
    { cause: "Door open", severity: "Warning", cellLevel: false },
    { cause: "Temperature high", severity: "Minor", cellLevel: false },
    { cause: "Sleeping cell suspected", severity: "Major", cellLevel: true },
    { cause: "Mains power failure", severity: "Major", cellLevel: false },
    { cause: "RRC setup success degraded", severity: "Minor", cellLevel: true },
    { cause: "Handover success degraded", severity: "Minor", cellLevel: true },
    { cause: "GPS synchronisation lost", severity: "Warning", cellLevel: false },
    { cause: "Packet loss on backhaul", severity: "Minor", cellLevel: false },
    { cause: "Rectifier fault", severity: "Warning", cellLevel: false },
  ];
  for (let i = 5; i <= 300; i++) {
    const tpl = RANDOM_CAUSES[Math.floor(rand() * RANDOM_CAUSES.length)];
    const site = sites[Math.floor(rand() * sites.length)];
    const cell = tpl.cellLevel ? cells.filter((c) => c.siteId === site.siteId)[Math.floor(rand() * 4)] : undefined;
    const t = DATASET_START + rand() * (DATASET_END - DATASET_START);
    const u = rand();
    const state: AlarmState = u < 0.7 ? "cleared" : u < 0.9 ? "active" : "acknowledged";
    const dur = (10 + rand() * 600) * 60 * 1000;
    alarms.push({
      alarmId: `ALM-${pad(i, 6)}`, timestamp: isoAt(t), siteId: site.siteId, cellId: cell?.cellId, severity: tpl.severity,
      probableCause: tpl.cause, state, clearedAt: state === "cleared" ? isoAt(Math.min(t + dur, DATASET_END)) : undefined, technology: cell?.technology,
    });
  }
  alarms.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

  // packet statistics: protocol hierarchy for a synthetic S1-U / N3 capture (~1.2 M packets)
  // top-level rows (no parent) sum to the frame count; child rows are encapsulated protocols
  const packetStats: PacketStat[] = [
    { protocol: "GTP-U (user plane, S1-U / N3)", packets: 812_400, bytes: 812_400 * 780 },
    { protocol: "TCP", parent: "GTP-U", packets: 540_200, bytes: 540_200 * 890, retransmissions: 4_322 },
    { protocol: "UDP", parent: "GTP-U", packets: 261_300, bytes: 261_300 * 420 },
    { protocol: "RTP (VoLTE media)", parent: "UDP", packets: 148_600, bytes: 148_600 * 214 },
    { protocol: "DNS", parent: "UDP", packets: 21_400, bytes: 21_400 * 96 },
    { protocol: "SIP (IMS signalling)", parent: "GTP-U", packets: 9_800, bytes: 9_800 * 640 },
    { protocol: "SCTP (control plane)", packets: 96_300, bytes: 96_300 * 212 },
    { protocol: "S1AP (LTE)", parent: "SCTP", packets: 61_200, bytes: 61_200 * 188 },
    { protocol: "NGAP (5G)", parent: "SCTP", packets: 35_100, bytes: 35_100 * 202 },
    { protocol: "ICMP", packets: 3_900, bytes: 3_900 * 84 },
  ];
  const conversations: Conversation[] = [];
  for (let i = 0; i < 20; i++) {
    const pk = Math.round(4000 + rand() * 60000);
    conversations.push({
      addressA: `10.${40 + Math.floor(rand() * 4)}.${Math.floor(rand() * 255)}.${1 + Math.floor(rand() * 250)}`,
      addressB: `172.16.${Math.floor(rand() * 8)}.${1 + Math.floor(rand() * 250)}`,
      protocol: rand() < 0.65 ? "TCP" : rand() < 0.7 ? "UDP" : "RTP",
      packets: pk, bytes: Math.round(pk * (300 + rand() * 900)), durationS: r2(30 + rand() * 1700),
    });
  }
  conversations.sort((a, b) => b.bytes - a.bytes);
  const tcp = packetStats[1];
  const tcpSummary = { packets: tcp.packets, retransmissions: tcp.retransmissions ?? 0, retransmissionPct: r2(((tcp.retransmissions ?? 0) / tcp.packets) * 100), rttAvgMs: 38.4, rttP95Ms: 92.1 };

  return { sites, cells, samples, alarms, packetStats, conversations, incidents, tcpSummary };
}

function r2(x: number): number {
  return Math.round(x * 100) / 100;
}
