/** Data model for the dashboard. Synthetic data follows this shape (see PLAN.md, section 4). */

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

/** One KPI sample per cell per 15-minute reporting interval. */
export interface KpiSample {
  cellId: string;
  timestamp: string; // ISO 8601, UTC
  callDropRatePct: number; // dropped / (dropped + completed) * 100
  rrcSetupSuccessPct: number;
  handoverSuccessPct: number;
  dlThroughputMbps: number;
  ulThroughputMbps: number;
  latencyMs: number; // user-plane RTT
  prbUtilizationPct: number; // congestion indicator
  rsrpAvgDbm: number;
  sinrAvgDb: number;
  activeUsers: number;
}

export interface Alarm {
  alarmId: string;
  timestamp: string;
  siteId: string;
  cellId?: string;
  severity: Severity;
  probableCause: string; // e.g. "Cell down", "VSWR high", "Transmission link failure"
  state: AlarmState;
  clearedAt?: string;
}

export interface PacketStat {
  protocol: string;
  packets: number;
  bytes: number;
  retransmissions?: number;
}
