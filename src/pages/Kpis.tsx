import { Placeholder } from "../components/Placeholder";

export function Kpis() {
  return (
    <Placeholder
      title="KPI Analysis"
      description="Per-cell and per-site KPI trends with threshold breaches highlighted."
      planned={[
        "Time-series charts for CDR, latency, throughput, PRB utilization, handover success rate",
        "Threshold lines per KPI (configurable) and breach markers",
        "Cell / site / technology (LTE, NR) filters",
        "Export of the filtered KPI table to CSV for network performance reports",
      ]}
    />
  );
}
