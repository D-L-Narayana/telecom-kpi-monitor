import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";
import { KPI_META, fmt } from "../lib/kpi";
import type { KpiKey } from "../types/telecom";
import type { Level } from "../lib/thresholds";
import { LevelBadge } from "./ui";

export function KpiCard({ kpi, value, previous, series, level, onClick }: {
  kpi: KpiKey; value: number | null; previous: number | null; series: { t: number; v: number | null }[]; level: Level; onClick?: () => void;
}) {
  const meta = KPI_META[kpi];
  const delta = value !== null && previous !== null && previous !== 0 ? ((value - previous) / Math.abs(previous)) * 100 : null;
  const improving = delta === null ? null : meta.higherIsBetter ? delta > 0 : delta < 0;
  return (
    <button className={`kpi-card lvl-border-${level}`} onClick={onClick} title={`Open ${meta.label} in KPI analysis`}>
      <div className="kpi-top">
        <span className="kpi-label">{meta.label}</span>
        <LevelBadge level={level} />
      </div>
      <div className="kpi-value">
        {fmt(value, meta.decimals)} <span className="kpi-unit">{meta.unit}</span>
      </div>
      <div className={`kpi-delta ${improving === null ? "" : improving ? "good" : "bad"}`}>
        {delta === null ? "no previous window" : `${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta).toFixed(1)}% vs previous window`}
      </div>
      <div className="sparkline" aria-hidden>
        <ResponsiveContainer width="100%" height={36}>
          <LineChart data={series} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
            <YAxis hide domain={["auto", "auto"]} />
            <Line type="monotone" dataKey="v" stroke="#20808D" dot={false} strokeWidth={1.6} isAnimationActive={false} connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </button>
  );
}
