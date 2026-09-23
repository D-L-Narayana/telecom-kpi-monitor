import { Placeholder } from "../components/Placeholder";

export function Overview() {
  return (
    <Placeholder
      title="Network Overview"
      description="NOC-style summary of the monitored 4G LTE / 5G NR cells: KPI cards, active alarm counts and worst-cell list."
      planned={[
        "KPI cards: call drop rate, RRC setup success rate, DL/UL throughput, latency, PRB utilization",
        "Active alarms by severity (Critical / Major / Minor / Warning)",
        "Top 10 worst cells by call drop rate and congestion",
        "Time-range selector (last 1h / 24h / 7d) applied to every card",
      ]}
    />
  );
}
