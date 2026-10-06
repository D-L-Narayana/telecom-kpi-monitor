import { useMemo } from "react";
import { useApp, navigate, href, type Page } from "../state";
import { CORE_KPIS, DETECTION_KPI, KPI_META, RANGE_MS, aggregateByCell, detectIssues, filterTech, fmt, inWindow, networkKpi, seriesByInterval } from "../lib/kpi";
import { aggregateByRegion, aggregateBySite } from "../lib/sites";
import { classify, thresholdFor } from "../lib/thresholds";
import { KpiCard } from "../components/KpiCard";
import { Card, Empty, LevelBadge, SeverityBadge, fmtTime } from "../components/ui";
import type { Severity } from "../types/telecom";

const SEVERITIES: Severity[] = ["Critical", "Major", "Minor", "Warning"];
/** Detections listed before the "+N more" line. */
const MAX_DETECTIONS = 8;
/** Sparklines over a 7-day window are bucketed per hour (672 → 168 points). */
const HOUR_MS = 3600e3;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function Overview() {
  const { data, cells, now, range, tech, thresholds, alarms, source } = useApp();
  const rangeMs = RANGE_MS[range];
  const cur = useMemo(() => filterTech(inWindow(data.samples, now, rangeMs), cells, tech), [data, cells, now, rangeMs, tech]);
  const prev = useMemo(() => filterTech(inWindow(data.samples, now - rangeMs, rangeMs), cells, tech), [data, cells, now, rangeMs, tech]);
  const bucketMs = range === "7d" ? HOUR_MS : undefined;
  const cards = useMemo(() => CORE_KPIS.map((k) => {
    const value = networkKpi(cur, k);
    return { kpi: k, value, previous: prev.length >= cur.length / 2 ? networkKpi(prev, k) : null, series: seriesByInterval(cur, k, bucketMs), level: classify(value, thresholdFor(thresholds, k, tech)) };
  }), [cur, prev, thresholds, tech, bucketMs]);
  const worst = useMemo(() => aggregateByCell(cur, cells, thresholds).sort((a, b) => (b.values.callDropRatePct ?? 99) - (a.values.callDropRatePct ?? 99) || b.breaches - a.breaches).slice(0, 10), [cur, cells, thresholds]);
  const detections = useMemo(() => detectIssues(cur, cells, thresholds), [cur, cells, thresholds]);
  const techAlarms = useMemo(() => alarms.filter((a) => tech === "All" || !a.technology || a.technology === tech), [alarms, tech]);
  const activeAlarms = techAlarms.filter((a) => a.state !== "cleared");
  const bySeverity = SEVERITIES.map((s) => ({ s, n: activeAlarms.filter((a) => a.severity === s).length }));
  // cells without counters at the latest reporting interval of the window
  const downCells = useMemo(() => {
    let latest = "";
    for (const s of cur) if (s.timestamp > latest) latest = s.timestamp;
    return new Set(cur.filter((s) => s.timestamp === latest && s.prbUtilizationPct === null).map((s) => s.cellId)).size;
  }, [cur]);
  const siteAggs = useMemo(() => aggregateBySite(cur, cells, data.sites, thresholds, techAlarms), [cur, cells, data, thresholds, techAlarms]);
  const regions = useMemo(() => aggregateByRegion(siteAggs), [siteAggs]);
  const hasSamples = cur.length > 0;

  /** Page link that keeps the global range / technology filters. */
  const link = (page: Page, params: Record<string, string | undefined> = {}) => href(page, { ...params, range, tech });
  const tzLabel = source.timeZone === "Asia/Kolkata" ? "IST" : source.timeZone;
  const cellCount = tech === "All" ? data.cells.length : data.cells.filter((c) => c.technology === tech).length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Network overview</h1>
          <p className="muted">{plural(data.sites.length, "site")} · {plural(cellCount, "cell")} · window {range} ending {fmtTime(now, true, source.timeZone)} {tzLabel} · {cur.length.toLocaleString()} KPI samples · {source.label}</p>
        </div>
      </div>

      {hasSamples ? (
        <div className="kpi-grid">
          {cards.map((c) => <KpiCard key={c.kpi} {...c} onClick={() => navigate("kpis", { kpi: c.kpi, range, tech })} />)}
        </div>
      ) : (
        <Card title="Network KPIs">
          <Empty text="No KPI samples in this window." />
          <p className="muted small-text">The window {fmtTime(now - rangeMs, true, source.timeZone)} → {fmtTime(now, true, source.timeZone)} {tzLabel} holds no {tech === "All" ? "" : `${tech} `}samples. Widen the time range, change the technology filter or load a dataset that covers it.</p>
        </Card>
      )}

      <div className="two-col">
        <Card title="Active alarms" actions={<a className="btn small" href={link("alarms", { state: "active" })}>Open alarm list</a>}>
          <div className="sev-grid">
            {bySeverity.map(({ s, n }) => (
              <a key={s} className={`sev-tile sev-tile-${s.toLowerCase()}`} href={link("alarms", { severity: s, state: "active" })}>
                <span className="sev-count">{n}</span><SeverityBadge s={s} />
              </a>
            ))}
          </div>
          <p className="muted small-text">{activeAlarms.length} unresolved (active + acknowledged) of {techAlarms.length} alarms in the dataset. Cells down at the latest interval of this window: {downCells}.</p>
        </Card>

        {hasSamples && (
          <Card title="Congestion, outage and fault detection">
            {detections.length === 0 ? <Empty text="No rule-based detections in this window." /> : (
              <ul className="detect-list">
                {detections.slice(0, MAX_DETECTIONS).map((d) => (
                  <li key={d.kind + d.cellId}>
                    <span className={`badge kind-${d.kind}`}>{d.kind}</span>
                    <a href={link("kpis", { cell: d.cellId, kpi: DETECTION_KPI[d.kind] })}>{d.cellId}</a>
                    <span className="muted small-text">{d.detail} · {fmtTime(d.firstSeen, true, source.timeZone)} → {fmtTime(d.lastSeen, false, source.timeZone)}</span>
                  </li>
                ))}
                {detections.length > MAX_DETECTIONS && <li className="muted small-text">+{detections.length - MAX_DETECTIONS} more</li>}
              </ul>
            )}
            <p className="muted small-text">Rules: outage = ≥2 consecutive intervals without counters; congestion = ≥3 intervals PRB above critical; latency = ≥2 intervals above critical; drops = ≥3 intervals CDR above critical; sleeping = ≥4 consecutive intervals with counters but at most max(2, 10 % of the cell's median) active users.</p>
          </Card>
        )}
      </div>

      {hasSamples && (
        <Card title="Sites & regions" actions={<a className="btn small" href={link("sites")}>Open Sites page</a>}>
          {regions.length === 0 ? <Empty text="No sites in this window." /> : (
            <div className="region-grid">
              {regions.map((r) => (
                <a key={r.region} className={`region-tile lvl-border-${r.worstLevel}`} href={link("sites", { region: r.region })}>
                  <span className="kpi-top"><span className="tile-label">{r.region}</span><LevelBadge level={r.worstLevel} /></span>
                  <span>{plural(r.siteIds.length, "site")} · {plural(r.cellCount, "cell")} · {plural(r.activeAlarms, "active alarm")}</span>
                  <span className="muted small-text">CDR {fmt(r.values.callDropRatePct, 2)} % · PRB {fmt(r.values.prbUtilizationPct, 1)} %{r.downCells > 0 ? ` · ${plural(r.downCells, "cell")} with down intervals` : ""}</span>
                </a>
              ))}
            </div>
          )}
          <p className="muted small-text">{plural(siteAggs.length, "site")} reported samples in this window; a region's status is the worst threshold level of any of its cells. The Sites page has the map and the per-site table.</p>
        </Card>
      )}

      {hasSamples && (
        <Card title="Worst 10 cells by call drop rate" actions={<a className="btn small" href={link("kpis")}>KPI analysis</a>}>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Cell</th><th>Tech</th><th>Status</th><th className="num">CDR %</th><th className="num">RRC %</th><th className="num">HO %</th><th className="num">DL Mbps</th><th className="num">Latency ms</th><th className="num">PRB %</th><th className="num">Down intervals</th></tr>
              </thead>
              <tbody>
                {worst.map((r) => (
                  <tr key={r.cellId}>
                    <td><a href={link("kpis", { cell: r.cellId })}>{r.cellId}</a></td>
                    <td>{r.technology}</td>
                    <td><LevelBadge level={r.worstLevel} /></td>
                    <td className="num">{fmt(r.values.callDropRatePct, 2)}</td>
                    <td className="num">{fmt(r.values.rrcSetupSuccessPct, 2)}</td>
                    <td className="num">{fmt(r.values.handoverSuccessPct, 2)}</td>
                    <td className="num">{fmt(r.values.dlThroughputMbps, 1)}</td>
                    <td className="num">{fmt(r.values.latencyMs, 1)}</td>
                    <td className="num">{fmt(r.values.prbUtilizationPct, 1)}</td>
                    <td className="num">{r.downIntervals}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small-text">Cells are ranked by mean {KPI_META.callDropRatePct.label.toLowerCase()} over the window; status is the worst threshold level across all KPIs.</p>
        </Card>
      )}
    </div>
  );
}
