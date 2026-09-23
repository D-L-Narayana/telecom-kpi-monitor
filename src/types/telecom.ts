/** Data model for the dashboard. The synthetic dataset (src/lib/synthetic.ts) follows this shape (PLAN.md, section 3). */

export type Technology = "LTE" | "NR";
export type Severity = "Critical" | "Major" | "Minor" | "Warning";
export type AlarmState = "active" | "acknowledged" | "cleared";

export interface Site {
  siteId: string; // e.g. "VSKP-001"
  name: string;
  lat: number;
  lon: number;
  region: string;
}

export interface Cell {
  cellId: string; // e.g. "VSKP-001-L1" (LTE) or "VSKP-001-N1" (NR)
  siteId: string;
  technology: Technology;
  band: string; // e.g. "B3", "B40", "n78"
  bandwidthMHz: number;
  azimuthDeg: number;
}

/** One KPI sample per cell per 15-minute reporting interval. Null values = cell was down (no counters). */
export interface KpiSample {
  cellId: string;
  timestamp: string; // ISO 8601, UTC
  callDropRatePct: number | null; // dropped / (dropped + completed) * 100
  rrcSetupSuccessPct: number | null;
  handoverSuccessPct: number | null;
  dlThroughputMbps: number | null;
  ulThroughputMbps: number | null;
  latencyMs: number | null; // user-plane RTT
  prbUtilizationPct: number | null; // congestion indicator
  rsrpAvgDbm: number | null;
  sinrAvgDb: number | null;
  activeUsers: number;
}

export type KpiKey =
  | "callDropRatePct" | "rrcSetupSuccessPct" | "handoverSuccessPct" | "dlThroughputMbps"
  | "ulThroughputMbps" | "latencyMs" | "prbUtilizationPct" | "rsrpAvgDbm" | "sinrAvgDb";

export interface Alarm {
  alarmId: string;
  timestamp: string;
  siteId: string;
  cellId?: string;
  technology?: Technology;
  severity: Severity;
  probableCause: string; // e.g. "Cell down", "VSWR high", "Transmission link degraded"
  state: AlarmState;
  clearedAt?: string;
}

export interface PacketStat {
  protocol: string;
  parent?: string; // encapsulating protocol; rows without a parent sum to the frame count
  packets: number;
  bytes: number;
  retransmissions?: number;
}

export interface Conversation {
  addressA: string;
  addressB: string;
  protocol: string;
  packets: number;
  bytes: number;
  durationS: number;
}
