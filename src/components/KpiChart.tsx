import type { CSSProperties } from "react";
import { Brush, CartesianGrid, Legend, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from "recharts";
import { KPI_META, fmt } from "../lib/kpi";

/**
 * Tooltip styling shared by every chart. Recharts colours each tooltip row with its series stroke, which the
 * 12 px text cannot afford on the tooltip box (the light teal series falls just short of 4.5:1 on `--surface`).
 * The rows therefore use the text token; the series identity stays in the row name and the legend. The box
 * background, border and label colour come from the stylesheet (`.recharts-default-tooltip`).
 */
export const CHART_TOOLTIP_PROPS: { contentStyle: CSSProperties; itemStyle: CSSProperties } = {
  contentStyle: { fontSize: 12, color: "var(--text)" },
  itemStyle: { color: "var(--text)" },
};
import type { KpiKey } from "../types/telecom";
import type { Threshold } from "../lib/thresholds";
import { classify } from "../lib/thresholds";
import { Empty, fmtTime } from "./ui";

/** One plotted interval: `v` is the main series, `v2` the optional compare series (null = no counters). */
export interface ChartPoint { t: number; v: number | null; v2?: number | null }
/** Vertical marker (e.g. alarm raised / cleared). */
export interface ChartMarker { t: number; label: string }

export interface KpiChartProps {
  kpi: KpiKey;
  points: ChartPoint[];
  threshold?: Threshold;
  height?: number;
  /** Legend name of the compare series (`v2`); the legend is shown only when a compare series is present. */
  compareLabel?: string;
  markers?: ChartMarker[];
  /** Legend and table name of the main series (defaults to the KPI label). */
  seriesLabel?: string;
  /** Shade the warning zone between the warning and critical thresholds. */
  bands?: boolean;
  /** Add a brush below the chart to zoom and pan long ranges. */
  brush?: boolean;
  /** Accessible name of the figure (defaults to "<KPI label> chart"). */
  ariaLabel?: string;
  /** Render a visually hidden data table with every point as a text alternative to the drawing. */
  showTable?: boolean;
}

const isValue = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * One-sentence description of the plotted points (count, time span, min/max/mean, intervals without counters,
 * threshold breaches, compare series mean). Used as the figure caption and as the SVG description.
 */
export function describePoints(points: ChartPoint[], kpi: KpiKey, threshold?: Threshold, compareLabel?: string): string {
  const meta = KPI_META[kpi];
  if (points.length === 0) return "No data points in this window.";
  const values = points.map((p) => p.v).filter(isValue);
  const parts = [`${points.length} points from ${fmtTime(points[0].t)} to ${fmtTime(points[points.length - 1].t)} IST`];
  if (values.length > 0) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    parts.push(`min ${fmt(Math.min(...values), meta.decimals)}, max ${fmt(Math.max(...values), meta.decimals)}, mean ${fmt(mean, meta.decimals)} ${meta.unit}`);
  } else {
    parts.push("no counters reported");
  }
  const missing = points.length - values.length;
  if (missing > 0) parts.push(`${plural(missing, "interval", "intervals")} without counters`);
  if (threshold) {
    const breaches = points.filter((p) => classify(p.v, threshold) !== "ok").length;
    parts.push(`${plural(breaches, "threshold breach", "threshold breaches")}`);
  }
  if (compareLabel) {
    const cmp = points.map((p) => p.v2).filter(isValue);
    parts.push(cmp.length > 0 ? `${compareLabel}: mean ${fmt(cmp.reduce((a, b) => a + b, 0) / cmp.length, meta.decimals)} ${meta.unit}` : `${compareLabel}: no counters`);
  }
  return `${parts.join("; ")}.`;
}

/**
 * Time series of one KPI with threshold lines, optional warning band, breach markers, vertical event markers,
 * an optional compare series and an optional brush. The chart is wrapped in a `<figure>` whose caption summarises
 * the data; `showTable` adds a visually hidden table of every point for assistive technology.
 * Colours come from the theme tokens only.
 */
export function KpiChart({ kpi, points, threshold, height = 260, compareLabel, markers = [], seriesLabel, bands = false, brush = false, ariaLabel, showTable = false }: KpiChartProps) {
  const meta = KPI_META[kpi];
  const label = ariaLabel ?? `${meta.label} chart`;
  const seriesName = seriesLabel ?? meta.label;
  const summary = describePoints(points, kpi, threshold, compareLabel);
  const breaches = threshold ? points.filter((p) => classify(p.v, threshold) !== "ok").map((p) => ({ t: p.t, b: p.v })) : [];
  const span = points.length ? points[points.length - 1].t - points[0].t : 0;
  const cellText = (v: number | null | undefined) => (isValue(v) ? fmt(v, meta.decimals) : "no counters");

  if (points.length === 0) {
    return (
      <figure className="chart-figure" aria-label={label}>
        <Empty text={summary} />
      </figure>
    );
  }
  return (
    <figure className="chart-figure" aria-label={label}>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={points} margin={{ top: 8, right: 16, bottom: 4, left: 0 }} title={label} desc={summary}>
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(t: number) => fmtTime(t, span > 36 * 3600e3)} fontSize={11} minTickGap={40} />
          <YAxis fontSize={11} width={48} domain={["auto", "auto"]} tickFormatter={(v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(meta.decimals))} />
          <Tooltip
            {...CHART_TOOLTIP_PROPS}
            labelFormatter={(t) => fmtTime(Number(t))}
            formatter={(v: unknown, name?: unknown) => [v === null || v === undefined ? "down / no counters" : `${Number(v).toFixed(meta.decimals)} ${meta.unit}`, String(name ?? "")]}
          />
          {compareLabel && <Legend wrapperStyle={{ fontSize: 12 }} itemSorter="dataKey" />}
          {bands && threshold && (
            <ReferenceArea y1={Math.min(threshold.warning, threshold.critical)} y2={Math.max(threshold.warning, threshold.critical)} fill="var(--chart-band)" fillOpacity={1} stroke="none" ifOverflow="extendDomain" />
          )}
          {threshold && <ReferenceLine y={threshold.warning} stroke="var(--chart-warn)" strokeDasharray="4 4" ifOverflow="extendDomain" label={{ value: `warn ${threshold.warning}`, fontSize: 10, fill: "var(--chart-warn)", position: "insideTopRight" }} />}
          {threshold && <ReferenceLine y={threshold.critical} stroke="var(--chart-crit)" strokeDasharray="4 4" ifOverflow="extendDomain" label={{ value: `crit ${threshold.critical}`, fontSize: 10, fill: "var(--chart-crit)", position: "insideBottomRight" }} />}
          {markers.map((m) => (
            <ReferenceLine key={`${m.t}-${m.label}`} x={m.t} stroke="var(--chart-marker)" strokeDasharray="2 2" label={{ value: m.label, fontSize: 10, fill: "var(--chart-marker)", position: "top" }} />
          ))}
          <Line type="monotone" dataKey="v" name={seriesName} stroke="var(--chart-series-1)" strokeWidth={1.8} dot={false} connectNulls={false} isAnimationActive={false} />
          {compareLabel && <Line type="monotone" dataKey="v2" name={compareLabel} stroke="var(--chart-series-2)" strokeWidth={1.5} dot={false} connectNulls={false} isAnimationActive={false} />}
          {breaches.length > 0 && <Scatter data={breaches} dataKey="b" fill="var(--chart-breach)" shape="circle" isAnimationActive={false} name="breach" legendType="none" tooltipType="none" />}
          {brush && <Brush dataKey="t" height={24} travellerWidth={8} tickFormatter={(t) => fmtTime(Number(t), false)} stroke="var(--chart-marker)" fill="var(--surface-2)" />}
        </LineChart>
      </ResponsiveContainer>
      <figcaption>{summary}</figcaption>
      {showTable && (
        <div className="visually-hidden">
          <table>
            <caption>Data points of {label}</caption>
            <thead>
              <tr>
                <th scope="col">Time (IST)</th>
                <th scope="col">{seriesName}</th>
                {compareLabel && <th scope="col">{compareLabel}</th>}
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.t}>
                  <th scope="row">{fmtTime(p.t)}</th>
                  <td>{cellText(p.v)}</td>
                  {compareLabel && <td>{cellText(p.v2)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  );
}
