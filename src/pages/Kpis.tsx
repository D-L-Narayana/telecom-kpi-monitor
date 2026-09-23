import { useEffect, useMemo, useState } from "react";
import { useApp } from "../state";
import { CORE_KPIS, KPI_META, RANGE_MS, aggregateByCell, fmt, inWindow, seriesByInterval } from "../lib/kpi";
import { classify, thresholdFor } from "../lib/thresholds";
import { toCsv, downloadText } from "../lib/csv";
import { KpiChart } from "../components/KpiChart";
import { Card, LevelBadge, fmtTime } from "../components/ui";
import type { KpiKey, KpiSample } from "../types/telecom";

const ALL_KPIS = Object.keys(KPI_META) as KpiKey[];

export function Kpis() {
  const { data, cells, now, range, tech, thresholds, route } = useApp();
  const cellList = useMemo(() => data.cells.filter((c) => tech === "All" || c.technology === tech), [data, tech]);
  const [cellId, setCellId] = useState(route.params.get("cell") ?? "VSKP-007-N1");
  const [kpi, setKpi] = useState<KpiKey>((route.params.get("kpi") as KpiKey) ?? "prbUtilizationPct");
  const [compare, setCompare] = useState<string>("");
  const [sortKey, setSortKey] = useState<KpiKey>("callDropRatePct");
  const [sortDesc, setSortDesc] = useState(true);
  useEffect(() => { const c = route.params.get("cell"); if (c) setCellId(c); const k = route.params.get("kpi") as KpiKey | null; if (k && KPI_META[k]) setKpi(k); }, [route]);

  const cell = cells.get(cellId);
  const windowSamples = useMemo(() => inWindow(data.samples, now, RANGE_MS[range]), [data, now, range]);
  const cellSamples = useMemo(() => windowSamples.filter((s) => s.cellId === cellId).sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1)), [windowSamples, cellId]);
  const cmpSamples = useMemo(() => (compare ? windowSamples.filter((s) => s.cellId === compare).sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1)) : []), [windowSamples, compare]);
  const points = useMemo(() => cellSamples.map((s, i) => ({ t: Date.parse(s.timestamp), v: s[kpi], v2: cmpSamples[i]?.[kpi] ?? null })), [cellSamples, cmpSamples, kpi]);
  const th = cell ? thresholdFor(thresholds, kpi, cell.technology) : undefined;
  const breaches = th ? cellSamples.filter((s) => classify(s[kpi], th) !== "ok").length : 0;
  const downs = cellSamples.filter((s) => s.prbUtilizationPct === null).length;
  const networkSeries = useMemo(() => seriesByInterval(windowSamples.filter((s) => tech === "All" || cells.get(s.cellId)?.technology === tech), kpi), [windowSamples, kpi, cells, tech]);

  const table = useMemo(() => {
    const rows = aggregateByCell(windowSamples.filter((s) => tech === "All" || cells.get(s.cellId)?.technology === tech), cells, thresholds);
    return rows.sort((a, b) => ((a.values[sortKey] ?? -Infinity) - (b.values[sortKey] ?? -Infinity)) * (sortDesc ? -1 : 1));
  }, [windowSamples, cells, thresholds, tech, sortKey, sortDesc]);

  const exportCellCsv = () => {
    const rows = cellSamples.map((s: KpiSample) => ({ timestamp_utc: s.timestamp, ...s }));
    downloadText(`kpi_${cellId}_${range}.csv`, toCsv(rows, ["timestamp_utc", "cellId", ...ALL_KPIS, "activeUsers"]));
  };
  const exportReportCsv = () => {
    const rows = table.map((r) => ({
      cellId: r.cellId, siteId: r.siteId, technology: r.technology, samples: r.samples, down_intervals: r.downIntervals, status: r.worstLevel, breached_kpis: r.breaches,
      ...Object.fromEntries(ALL_KPIS.map((k) => [`${k}_avg`, r.values[k] === null ? "" : r.values[k]!.toFixed(KPI_META[k].decimals)])),
    }));
    downloadText(`network_performance_report_${range}_${tech}.csv`, toCsv(rows));
  };

  return (
    <div className="page">
      <div className="page-head"><div><h1>KPI analysis</h1><p className="muted">Per-cell time series with threshold bands and breach markers; per-cell performance table with CSV export.</p></div></div>

      <Card title={<span>{cellId} <span className="muted small-text">{cell ? `${cell.technology} ${cell.band} ${cell.bandwidthMHz} MHz · site ${cell.siteId} (${data.sites.find((s) => s.siteId === cell.siteId)?.name}) · azimuth ${cell.azimuthDeg}°` : ""}</span></span>}
        actions={<>
          <label className="inline">Cell <select value={cellId} onChange={(e) => setCellId(e.target.value)}>{cellList.map((c) => <option key={c.cellId} value={c.cellId}>{c.cellId}</option>)}</select></label>
          <label className="inline">KPI <select value={kpi} onChange={(e) => setKpi(e.target.value as KpiKey)}>{ALL_KPIS.map((k) => <option key={k} value={k}>{KPI_META[k].label}</option>)}</select></label>
          <label className="inline">Compare <select value={compare} onChange={(e) => setCompare(e.target.value)}><option value="">none</option>{cellList.filter((c) => c.cellId !== cellId).map((c) => <option key={c.cellId} value={c.cellId}>{c.cellId}</option>)}</select></label>
          <button className="btn small" onClick={exportCellCsv}>Export cell CSV</button>
        </>}>
        <KpiChart kpi={kpi} points={points} threshold={th} compareLabel={compare || undefined} />
        <div className="stat-row">
          <span><strong>{cellSamples.length}</strong> intervals</span>
          <span><strong>{breaches}</strong> threshold breaches</span>
          <span><strong>{downs}</strong> intervals down</span>
          <span>mean <strong>{fmt(points.reduce((a, p) => (p.v === null ? a : a + p.v), 0) / Math.max(1, points.filter((p) => p.v !== null).length), KPI_META[kpi].decimals)}</strong> {KPI_META[kpi].unit}</span>
          <span>window {fmtTime(now - RANGE_MS[range])} → {fmtTime(now)} IST</span>
        </div>
      </Card>

      <Card title={`Network-wide ${KPI_META[kpi].label} (${tech})`}>
        <KpiChart kpi={kpi} points={networkSeries} threshold={thresholdFor(thresholds, kpi, tech)} height={180} />
      </Card>

      <Card title={`Per-cell performance report · ${range} · ${tech}`} actions={<button className="btn small" onClick={exportReportCsv}>Export network performance report (CSV)</button>}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Cell</th><th>Tech</th><th>Status</th>
                {CORE_KPIS.map((k) => (
                  <th key={k} className="num sortable" onClick={() => { if (sortKey === k) setSortDesc(!sortDesc); else { setSortKey(k); setSortDesc(true); } }}>
                    {KPI_META[k].label} {sortKey === k ? (sortDesc ? "▼" : "▲") : ""}
                  </th>
                ))}
                <th className="num">Down</th>
              </tr>
            </thead>
            <tbody>
              {table.map((r) => (
                <tr key={r.cellId} className={r.cellId === cellId ? "selected" : ""}>
                  <td><a href={`#/kpis?cell=${r.cellId}&kpi=${kpi}`}>{r.cellId}</a></td><td>{r.technology}</td><td><LevelBadge level={r.worstLevel} /></td>
                  {CORE_KPIS.map((k) => <td key={k} className={`num lvl-text-${classify(r.values[k], thresholdFor(thresholds, k, r.technology))}`}>{fmt(r.values[k], KPI_META[k].decimals)}</td>)}
                  <td className="num">{r.downIntervals}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
