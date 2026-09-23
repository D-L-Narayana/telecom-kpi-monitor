import { useMemo } from "react";
import { useApp, navigate } from "../state";
import { CORE_KPIS, RANGE_MS, aggregateByCell, detectIssues, filterTech, fmt, inWindow, networkKpi, seriesByInterval, KPI_META } from "../lib/kpi";
import { classify, thresholdFor } from "../lib/thresholds";
import { KpiCard } from "../components/KpiCard";
import { Card, Empty, LevelBadge, SeverityBadge, fmtTime } from "../components/ui";
import type { Severity } from "../types/telecom";

const SEVERITIES: Severity[] = ["Critical", "Major", "Minor", "Warning"];

export function Overview() {
  const { data, cells, now, range, tech, thresholds, alarms } = useApp();
  const rangeMs = RANGE_MS[range];
  const cur = useMemo(() => filterTech(inWindow(data.samples, now, rangeMs), cells, tech), [data, cells, now, rangeMs, tech]);
  const prev = useMemo(() => filterTech(inWindow(data.samples, now - rangeMs, rangeMs), cells, tech), [data, cells, now, rangeMs, tech]);
  const cards = useMemo(() => CORE_KPIS.map((k) => {
    const value = networkKpi(cur, k);
    return { kpi: k, value, previous: prev.length >= cur.length / 2 ? networkKpi(prev, k) : null, series: seriesByInterval(cur, k), level: classify(value, thresholdFor(thresholds, k, tech)) };
  }), [cur, prev, thresholds, tech]);
  const worst = useMemo(() => aggregateByCell(cur, cells, thresholds).sort((a, b) => (b.values.callDropRatePct ?? 99) - (a.values.callDropRatePct ?? 99) || b.breaches - a.breaches).slice(0, 10), [cur, cells, thresholds]);
  const detections = useMemo(() => detectIssues(cur, cells, thresholds), [cur, cells, thresholds]);
  const activeAlarms = alarms.filter((a) => a.state !== "cleared" && (tech === "All" || !a.technology || a.technology === tech));
  const bySeverity = SEVERITIES.map((s) => ({ s, n: activeAlarms.filter((a) => a.severity === s).length }));
  const downCells = useMemo(() => new Set(cur.filter((s) => s.prbUtilizationPct === null && s.timestamp === new Date(now).toISOString()).map((s) => s.cellId)), [cur, now]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Network overview</h1>
          <p className="muted">{data.sites.length} sites · {tech === "All" ? data.cells.length : data.cells.filter((c) => c.technology === tech).length} cells · window {range} ending {fmtTime(now)} IST · {cur.length.toLocaleString()} KPI samples</p>
        </div>
      </div>

      <div className="kpi-grid">
        {cards.map((c) => <KpiCard key={c.kpi} {...c} onClick={() => navigate("kpis", { kpi: c.kpi })} />)}
      </div>

      <div className="two-col">
        <Card title="Active alarms" actions={<a className="btn small" href="#/alarms?state=active">Open alarm list</a>}>
          <div className="sev-grid">
            {bySeverity.map(({ s, n }) => (
              <a key={s} className={`sev-tile sev-tile-${s.toLowerCase()}`} href={`#/alarms?severity=${s}&state=active`}>
                <span className="sev-count">{n}</span><SeverityBadge s={s} />
              </a>
            ))}
          </div>
          <p className="muted small-text">{activeAlarms.length} unresolved (active + acknowledged) of {alarms.length} alarms in the 7-day dataset. Cells currently down: {downCells.size}.</p>
        </Card>

        <Card title="Congestion, outage and fault detection">
          {detections.length === 0 ? <Empty text="No rule-based detections in this window." /> : (
            <ul className="detect-list">
              {detections.slice(0, 8).map((d) => (
                <li key={d.kind + d.cellId}>
                  <span className={`badge kind-${d.kind}`}>{d.kind}</span>
                  <a href={`#/kpis?cell=${d.cellId}&kpi=${d.kind === "congestion" ? "prbUtilizationPct" : d.kind === "latency" ? "latencyMs" : d.kind === "drops" ? "callDropRatePct" : "dlThroughputMbps"}`}>{d.cellId}</a>
                  <span className="muted small-text">{d.detail} · {fmtTime(d.firstSeen)} → {fmtTime(d.lastSeen, false)}</span>
                </li>
              ))}
              {detections.length > 8 && <li className="muted small-text">+{detections.length - 8} more</li>}
            </ul>
          )}
          <p className="muted small-text">Rules: outage = ≥2 consecutive intervals without counters; congestion = ≥3 intervals PRB above critical; latency = ≥2 intervals above critical; drops = ≥3 intervals CDR above critical.</p>
        </Card>
      </div>

      <Card title="Worst 10 cells by call drop rate" actions={<a className="btn small" href="#/kpis">KPI analysis</a>}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Cell</th><th>Tech</th><th>Status</th><th className="num">CDR %</th><th className="num">RRC %</th><th className="num">HO %</th><th className="num">DL Mbps</th><th className="num">Latency ms</th><th className="num">PRB %</th><th className="num">Down intervals</th></tr>
            </thead>
            <tbody>
              {worst.map((r) => (
                <tr key={r.cellId}>
                  <td><a href={`#/kpis?cell=${r.cellId}`}>{r.cellId}</a></td>
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
    </div>
  );
}
