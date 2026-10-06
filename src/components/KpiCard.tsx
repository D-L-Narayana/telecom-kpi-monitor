import { KPI_META, deltaPct, fmt } from "../lib/kpi";
import type { KpiKey } from "../types/telecom";
import type { Level } from "../lib/thresholds";
import { LevelBadge } from "./ui";

/** Sparkline geometry in viewBox units; the SVG stretches to the card width (non-scaling stroke keeps the line crisp). */
const SPARK_W = 100;
const SPARK_H = 36;
const SPARK_PAD = 2;

/**
 * SVG path for a sparkline: one sub-path (M … L …) per run of consecutive values, so a gap (null) breaks the line
 * instead of being interpolated. Returns "" when there is nothing to draw.
 */
export function sparklinePath(series: { v: number | null }[]): string {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const p of series) {
    if (p.v === null || !Number.isFinite(p.v)) continue;
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
  }
  if (!Number.isFinite(min)) return "";
  const span = max - min;
  const n = series.length;
  const x = (i: number) => (n === 1 ? SPARK_W / 2 : (i / (n - 1)) * SPARK_W);
  const y = (v: number) => (span === 0 ? SPARK_H / 2 : SPARK_PAD + (1 - (v - min) / span) * (SPARK_H - 2 * SPARK_PAD));
  const parts: string[] = [];
  let open = false;
  series.forEach((p, i) => {
    if (p.v === null || !Number.isFinite(p.v)) {
      open = false;
      return;
    }
    parts.push(`${open ? "L" : "M"}${x(i).toFixed(2)} ${y(p.v).toFixed(2)}`);
    open = true;
  });
  return parts.join(" ");
}

const LEVEL_LABEL: Record<Level, string> = { ok: "OK", warning: "Warning", critical: "Critical" };

/**
 * Network KPI tile: value, threshold level, change against the previous window and a sparkline.
 * Rendered as a `<button>` whose children are all phrasing content (spans + an inline SVG), with an `aria-label`
 * that reads the whole card out; the sparkline itself is decorative.
 */
export function KpiCard({ kpi, value, previous, series, level, onClick }: {
  kpi: KpiKey; value: number | null; previous: number | null; series: { t: number; v: number | null }[]; level: Level; onClick?: () => void;
}) {
  const meta = KPI_META[kpi];
  const delta = deltaPct(value, previous);
  const improving = delta === null ? null : meta.higherIsBetter ? delta > 0 : delta < 0;
  const valueText = value === null ? "no data" : `${fmt(value, meta.decimals)} ${meta.unit}`;
  const deltaText = delta === null ? "no previous window" : `${delta >= 0 ? "up" : "down"} ${Math.abs(delta).toFixed(1)}% vs previous window`;
  const path = sparklinePath(series);
  return (
    <button
      type="button"
      className={`kpi-card lvl-border-${level}`}
      onClick={onClick}
      title={`Open ${meta.label} in KPI analysis`}
      aria-label={`${meta.label} ${valueText}, ${LEVEL_LABEL[level]}, ${deltaText}`}
    >
      <span className="kpi-top">
        <span className="kpi-label">{meta.label}</span>
        <LevelBadge level={level} />
      </span>
      <span className="kpi-value">
        {fmt(value, meta.decimals)} <span className="kpi-unit">{meta.unit}</span>
      </span>
      <span className={`kpi-delta ${improving === null ? "" : improving ? "good" : "bad"}`}>
        {delta === null ? "no previous window" : `${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta).toFixed(1)}% vs previous window`}
      </span>
      <svg className="sparkline" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} width="100%" height={SPARK_H} preserveAspectRatio="none" aria-hidden="true" focusable="false">
        {path && <path d={path} fill="none" stroke="var(--chart-series-1)" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
      </svg>
    </button>
  );
}
