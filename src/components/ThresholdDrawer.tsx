import { useApp } from "../state";
import { KPI_META } from "../lib/kpi";
import type { Thresholds } from "../lib/thresholds";

const ROWS: { key: keyof Thresholds; label: string }[] = [
  { key: "callDropRatePct", label: "Call drop rate (%)" },
  { key: "rrcSetupSuccessPct", label: "RRC setup success (%)" },
  { key: "handoverSuccessPct", label: "Handover success (%)" },
  { key: "latencyMs", label: "Latency (ms)" },
  { key: "dlThroughputMbps", label: "DL throughput LTE (Mbps)" },
  { key: "dlThroughputMbpsNR", label: "DL throughput NR (Mbps)" },
  { key: "ulThroughputMbps", label: "UL throughput (Mbps)" },
  { key: "prbUtilizationPct", label: "PRB utilization (%)" },
];

export function ThresholdDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { thresholds, updateThresholds, resetThresholdsToDefault } = useApp();
  if (!open) return null;
  const set = (key: keyof Thresholds, field: "warning" | "critical", v: number) => updateThresholds({ ...thresholds, [key]: { ...thresholds[key], [field]: v } });
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label="KPI thresholds">
        <header className="card-head"><h2>KPI thresholds</h2><button className="btn small" onClick={onClose}>Close</button></header>
        <p className="muted small-text">Breach direction follows the KPI: {KPI_META.callDropRatePct.label}, latency and PRB utilization breach <em>above</em>; success rates and throughput breach <em>below</em>. Saved in this browser.</p>
        <table className="table compact">
          <thead><tr><th>KPI</th><th>Warning</th><th>Critical</th></tr></thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.key}>
                <td>{r.label}</td>
                <td><input type="number" step="0.1" value={thresholds[r.key].warning} onChange={(e) => set(r.key, "warning", Number(e.target.value))} /></td>
                <td><input type="number" step="0.1" value={thresholds[r.key].critical} onChange={(e) => set(r.key, "critical", Number(e.target.value))} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="btn" onClick={resetThresholdsToDefault}>Reset to defaults</button>
      </aside>
    </div>
  );
}
