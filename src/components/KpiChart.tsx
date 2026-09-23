import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis, Legend } from "recharts";
import { KPI_META } from "../lib/kpi";
import type { KpiKey } from "../types/telecom";
import type { Threshold } from "../lib/thresholds";
import { classify } from "../lib/thresholds";
import { fmtTime } from "./ui";

export interface ChartPoint { t: number; v: number | null; v2?: number | null }

export function KpiChart({ kpi, points, threshold, height = 260, compareLabel, markers = [] }: {
  kpi: KpiKey; points: ChartPoint[]; threshold?: Threshold; height?: number; compareLabel?: string;
  markers?: { t: number; label: string }[];
}) {
  const meta = KPI_META[kpi];
  const breaches = threshold ? points.filter((p) => classify(p.v, threshold) !== "ok").map((p) => ({ t: p.t, b: p.v })) : [];
  const span = points.length ? points[points.length - 1].t - points[0].t : 0;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={points} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
        <CartesianGrid stroke="#e6e4de" vertical={false} />
        <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(t: number) => fmtTime(t, span > 36 * 3600e3)} fontSize={11} minTickGap={40} />
        <YAxis fontSize={11} width={48} domain={["auto", "auto"]} tickFormatter={(v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(meta.decimals))} />
        <Tooltip
          labelFormatter={(t) => fmtTime(Number(t))}
          formatter={(v: unknown, name?: unknown) => [v === null || v === undefined ? "down / no counters" : `${Number(v).toFixed(meta.decimals)} ${meta.unit}`, String(name ?? "")]}
          contentStyle={{ fontSize: 12 }}
        />
        {compareLabel && <Legend wrapperStyle={{ fontSize: 12 }} />}
        {threshold && <ReferenceLine y={threshold.warning} stroke="#DA7101" strokeDasharray="4 4" label={{ value: `warn ${threshold.warning}`, fontSize: 10, fill: "#DA7101", position: "insideTopRight" }} />}
        {threshold && <ReferenceLine y={threshold.critical} stroke="#A13544" strokeDasharray="4 4" label={{ value: `crit ${threshold.critical}`, fontSize: 10, fill: "#A13544", position: "insideBottomRight" }} />}
        {markers.map((m) => <ReferenceLine key={m.t} x={m.t} stroke="#7A7974" strokeDasharray="2 2" label={{ value: m.label, fontSize: 10, fill: "#7A7974", position: "top" }} />)}
        <Line type="monotone" dataKey="v" name={meta.label} stroke="#20808D" strokeWidth={1.8} dot={false} connectNulls={false} isAnimationActive={false} />
        {compareLabel && <Line type="monotone" dataKey="v2" name={compareLabel} stroke="#A84B2F" strokeWidth={1.5} dot={false} connectNulls={false} isAnimationActive={false} />}
        {breaches.length > 0 && <Scatter data={breaches} dataKey="b" fill="#A13544" shape="circle" isAnimationActive={false} name="breach" legendType="none" />}
      </LineChart>
    </ResponsiveContainer>
  );
}
