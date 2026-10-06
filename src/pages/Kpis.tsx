import { useMemo, useState } from "react";
import { href, useApp } from "../state";
import { parseKpiKey } from "../lib/router";
import { CORE_KPIS, KPI_META, RANGE_MS, aggregateByCell, filterTech, fmt, inWindow, seriesByInterval, type CellAggregate } from "../lib/kpi";
import { classify, thresholdFor } from "../lib/thresholds";
import { toCsv, downloadText } from "../lib/csv";
import { KpiChart, type ChartPoint } from "../components/KpiChart";
import { Card, Empty, LevelBadge, Notice, fmtTime } from "../components/ui";
import type { Cell, KpiKey, KpiSample, Technology } from "../types/telecom";

const ALL_KPIS = Object.keys(KPI_META) as KpiKey[];
const DEFAULT_CELL = "VSKP-007-N1";
const DEFAULT_KPI: KpiKey = "prbUtilizationPct";
const HOUR_MS = 3600e3;

/** A resolved `compare` parameter: the legend label and the samples that make up the compare series. */
interface CompareTarget { value: string; label: string; filter: (s: KpiSample) => boolean }

/**
 * Resolve the untrusted `compare` URL parameter: another cell id, `site:<SITE>` (user-weighted mean of the site's
 * cells per interval) or `network` (the technology-filtered network series). Unusable values turn the comparison
 * off and explain why in `issue`.
 */
function resolveCompare(raw: string | null, cellId: string | undefined, cells: Map<string, Cell>, siteIds: Set<string>, tech: Technology | "All"): { target: CompareTarget | null; issue?: string } {
  if (!raw) return { target: null };
  if (raw === "network") {
    return { target: { value: raw, label: `Network (${tech})`, filter: (s) => tech === "All" || cells.get(s.cellId)?.technology === tech } };
  }
  if (raw.startsWith("site:")) {
    const siteId = raw.slice("site:".length);
    if (siteIds.has(siteId)) return { target: { value: raw, label: `Site ${siteId}`, filter: (s) => cells.get(s.cellId)?.siteId === siteId } };
    return { target: null, issue: `Unknown compare site "${siteId}"; comparison turned off.` };
  }
  if (raw === cellId) return { target: null, issue: `Compare target "${raw}" is the selected cell; comparison turned off.` };
  if (cells.has(raw)) return { target: { value: raw, label: raw, filter: (s) => s.cellId === raw } };
  return { target: null, issue: `Unknown compare target "${raw}"; comparison turned off.` };
}

/** Share of the cell's intervals that reported counters, from the aggregate's counts (null without samples). */
function availabilityOf(r: CellAggregate): number | null {
  return r.samples === 0 ? null : ((r.samples - r.downIntervals) * 100) / r.samples;
}

const isNum = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const byTimestamp = (a: KpiSample, b: KpiSample) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0);

export function Kpis() {
  const { data, cells, now, range, tech, thresholds, route, setQuery } = useApp();
  const [sortKey, setSortKey] = useState<KpiKey>("callDropRatePct");
  const [sortDesc, setSortDesc] = useState(true);
  const [onlyBreaching, setOnlyBreaching] = useState(false);
  const [siteFilter, setSiteFilter] = useState("");

  const cellList = useMemo(() => data.cells.filter((c) => tech === "All" || c.technology === tech), [data, tech]);
  const sites = useMemo(() => {
    const names = new Map(data.sites.map((s) => [s.siteId, s.name]));
    return [...new Set(data.cells.map((c) => c.siteId))].sort().map((siteId) => ({ siteId, name: names.get(siteId) }));
  }, [data]);
  const siteIds = useMemo(() => new Set(sites.map((s) => s.siteId)), [sites]);

  // URL parameters are untrusted: each one is validated against the dataset and falls back to a default,
  // and every fallback is reported in a notice instead of crashing the page or rewriting the URL.
  const issues: string[] = [];
  const rawKpi = route.params.get("kpi");
  const kpi = parseKpiKey(rawKpi) ?? DEFAULT_KPI;
  if (rawKpi && parseKpiKey(rawKpi) === null) issues.push(`Unknown KPI "${rawKpi}"; showing ${KPI_META[DEFAULT_KPI].label} instead.`);
  const fallbackCell = cellList.find((c) => c.cellId === DEFAULT_CELL)?.cellId ?? cellList[0]?.cellId ?? data.cells[0]?.cellId;
  const rawCell = route.params.get("cell");
  const cellId = rawCell && cells.has(rawCell) ? rawCell : fallbackCell;
  if (rawCell && !cells.has(rawCell)) issues.push(`Unknown cell "${rawCell}"; showing ${cellId ?? "no cell"} instead.`);
  const cell = cellId ? cells.get(cellId) : undefined;
  const compareRaw = route.params.get("compare");
  const { target: compareTarget, issue: compareIssue } = useMemo(() => resolveCompare(compareRaw, cellId, cells, siteIds, tech), [compareRaw, cellId, cells, siteIds, tech]);
  if (compareIssue) issues.push(compareIssue);
  const bucketed = range === "7d" && route.params.get("bucket") === "1h";
  const bucketMs = bucketed ? HOUR_MS : undefined;
  const meta = KPI_META[kpi];

  /** Write a page parameter (empty removes it); the global filters travel along so the link stays shareable. */
  const setParam = (key: "cell" | "kpi" | "compare" | "bucket", value: string) => setQuery({ [key]: value || undefined, range, tech });

  const windowSamples = useMemo(() => inWindow(data.samples, now, RANGE_MS[range]), [data, now, range]);
  const techSamples = useMemo(() => filterTech(windowSamples, cells, tech), [windowSamples, cells, tech]);
  const cellSamples = useMemo(() => windowSamples.filter((s) => s.cellId === cellId).sort(byTimestamp), [windowSamples, cellId]);
  const compareSeries = useMemo(
    () => (compareTarget ? seriesByInterval(windowSamples.filter(compareTarget.filter), kpi, bucketMs) : null),
    [compareTarget, windowSamples, kpi, bucketMs],
  );
  // The compare series is joined by interval timestamp (bucket start when bucketed), never by array index,
  // so gaps or a different sample count in either series cannot shift the overlay.
  const points = useMemo<ChartPoint[]>(() => {
    const main = seriesByInterval(cellSamples, kpi, bucketMs);
    if (!compareSeries) return main;
    const byTime = new Map(compareSeries.map((p) => [p.t, p.v]));
    return main.map((p) => ({ ...p, v2: byTime.get(p.t) ?? null }));
  }, [cellSamples, kpi, bucketMs, compareSeries]);
  const networkSeries = useMemo(() => seriesByInterval(techSamples, kpi, bucketMs), [techSamples, kpi, bucketMs]);

  const th = cell ? thresholdFor(thresholds, kpi, cell.technology) : undefined;
  const breaches = th ? cellSamples.filter((s) => classify(s[kpi], th) !== "ok").length : 0;
  const downs = cellSamples.filter((s) => s.prbUtilizationPct === null).length;
  const availability = cellSamples.length === 0 ? null : ((cellSamples.length - downs) * 100) / cellSamples.length;
  const values = cellSamples.map((s) => s[kpi]).filter(isNum);
  const meanValue = values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

  const aggregates = useMemo(() => aggregateByCell(techSamples, cells, thresholds), [techSamples, cells, thresholds]);
  const tableRows = useMemo(() => {
    const dir = sortDesc ? -1 : 1;
    return aggregates
      .filter((r) => (!onlyBreaching || r.worstLevel !== "ok") && (!siteFilter || r.siteId === siteFilter))
      .sort((a, b) => {
        const av = a.values[sortKey] ?? Number.NEGATIVE_INFINITY;
        const bv = b.values[sortKey] ?? Number.NEGATIVE_INFINITY;
        if (av !== bv) return (av - bv) * dir;
        return a.cellId < b.cellId ? -1 : a.cellId > b.cellId ? 1 : 0;
      });
  }, [aggregates, onlyBreaching, siteFilter, sortKey, sortDesc]);
  const toggleSort = (k: KpiKey) => {
    if (sortKey === k) setSortDesc((d) => !d);
    else {
      setSortKey(k);
      setSortDesc(true);
    }
  };

  const exportCellCsv = () => {
    if (!cellId) return;
    const rows = cellSamples.map((s: KpiSample) => ({ timestamp_utc: s.timestamp, ...s }));
    downloadText(`kpi_${cellId}_${range}.csv`, toCsv(rows, ["timestamp_utc", "cellId", ...ALL_KPIS, "activeUsers"]));
  };
  const exportReportCsv = () => {
    const rows = tableRows.map((r) => {
      const av = availabilityOf(r);
      return {
        cellId: r.cellId, siteId: r.siteId, technology: r.technology, samples: r.samples, down_intervals: r.downIntervals,
        availability_pct: av === null ? "" : av.toFixed(2), status: r.worstLevel, breached_kpis: r.breaches,
        ...Object.fromEntries(ALL_KPIS.map((k) => [`${k}_avg`, r.values[k] === null ? "" : r.values[k]!.toFixed(KPI_META[k].decimals)])),
      };
    });
    downloadText(`network_performance_report_${range}_${tech}.csv`, toCsv(rows));
  };

  const cellOptions = cell && !cellList.some((c) => c.cellId === cell.cellId) ? [cell, ...cellList] : cellList;
  const siteName = cell ? sites.find((s) => s.siteId === cell.siteId)?.name : undefined;
  const chartLabel = cellId ? `${meta.label} for ${cellId}` : `${meta.label} chart`;

  return (
    <div className="page">
      <div className="page-head"><div><h1>KPI analysis</h1><p className="muted">Per-cell time series with threshold bands and breach markers; per-cell performance table with CSV export.</p></div></div>

      {issues.length > 0 && (
        <Notice kind="warning">
          <div>
            <p>Some parameters in the link were not valid; the defaults are shown instead.</p>
            <ul className="issue-list">{issues.map((text) => <li key={text}>{text}</li>)}</ul>
          </div>
        </Notice>
      )}

      <Card
        title={<span>{cellId ?? "No cell"} <span className="muted small-text">{cell ? `${cell.technology} ${cell.band} ${cell.bandwidthMHz} MHz · site ${cell.siteId}${siteName ? ` (${siteName})` : ""} · azimuth ${cell.azimuthDeg}°` : ""}</span></span>}
        actions={<>
          <label className="inline">Cell <select value={cellId ?? ""} onChange={(e) => setParam("cell", e.target.value)}>{cellOptions.map((c) => <option key={c.cellId} value={c.cellId}>{c.cellId}</option>)}</select></label>
          <label className="inline">KPI <select value={kpi} onChange={(e) => setParam("kpi", e.target.value)}>{ALL_KPIS.map((k) => <option key={k} value={k}>{KPI_META[k].label}</option>)}</select></label>
          <label className="inline">Compare <select value={compareTarget?.value ?? ""} onChange={(e) => setParam("compare", e.target.value)}>
            <option value="">none</option>
            <option value="network">Network ({tech})</option>
            {sites.length > 0 && <optgroup label="Sites">{sites.map((s) => <option key={s.siteId} value={`site:${s.siteId}`}>Site {s.siteId}{s.name ? ` (${s.name})` : ""}</option>)}</optgroup>}
            <optgroup label="Cells">{cellOptions.filter((c) => c.cellId !== cellId).map((c) => <option key={c.cellId} value={c.cellId}>{c.cellId}</option>)}</optgroup>
          </select></label>
          {range === "7d" && <label className="inline"><input type="checkbox" checked={bucketed} onChange={(e) => setParam("bucket", e.target.checked ? "1h" : "")} /> Hourly buckets</label>}
          <button type="button" className="btn small" onClick={exportCellCsv} disabled={!cellId}>Export cell CSV</button>
        </>}
      >
        {!cell ? <Empty text="No cells in this dataset." /> : (
          <>
            <KpiChart kpi={kpi} points={points} threshold={th} seriesLabel={cellId} compareLabel={compareTarget?.label} ariaLabel={chartLabel} bands brush={range === "7d"} showTable />
            <div className="stat-row">
              <span>{cellSamples.length} intervals</span>
              <span>{breaches} threshold breaches</span>
              <span>{downs} intervals down</span>
              <span>availability {fmt(availability, 1)} %</span>
              <span>mean {fmt(meanValue, meta.decimals)} {meta.unit}</span>
              <span>window {fmtTime(now - RANGE_MS[range])} to {fmtTime(now)} IST{bucketed ? " · hourly buckets" : ""}</span>
            </div>
          </>
        )}
      </Card>

      <Card title={`Network-wide ${meta.label} (${tech})`}>
        {techSamples.length === 0 ? <Empty text="No KPI samples in this window." /> : (
          <KpiChart kpi={kpi} points={networkSeries} threshold={thresholdFor(thresholds, kpi, tech)} height={180} ariaLabel={`Network-wide ${meta.label} (${tech})`} bands brush={range === "7d"} />
        )}
      </Card>

      <Card
        title={`Per-cell performance report · ${range} · ${tech} · ${tableRows.length} of ${aggregates.length} cells`}
        actions={<>
          <label className="inline"><input type="checkbox" checked={onlyBreaching} onChange={(e) => setOnlyBreaching(e.target.checked)} /> Only breaching</label>
          <label className="inline">Site <select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}>
            <option value="">All sites</option>
            {sites.map((s) => <option key={s.siteId} value={s.siteId}>{s.siteId}{s.name ? ` ${s.name}` : ""}</option>)}
          </select></label>
          <button type="button" className="btn small" onClick={exportReportCsv} disabled={tableRows.length === 0} title="Exports the rows currently shown, in the current order">Export network performance report (CSV)</button>
        </>}
      >
        {aggregates.length === 0 ? <Empty text="No cells to report in this window." /> : (
          <div className="table-wrap">
            <table className="table" aria-label="Per-cell performance report">
              <thead>
                <tr>
                  <th scope="col">Cell</th><th scope="col">Site</th><th scope="col">Tech</th><th scope="col">Status</th>
                  <th scope="col" className="num">Availability %</th>
                  {CORE_KPIS.map((k) => (
                    <th key={k} scope="col" className="num" aria-sort={sortKey === k ? (sortDesc ? "descending" : "ascending") : undefined}>
                      <button type="button" className="sort-btn" onClick={() => toggleSort(k)}>{KPI_META[k].label}{sortKey === k ? (sortDesc ? " ▼" : " ▲") : ""}</button>
                    </th>
                  ))}
                  <th scope="col" className="num">Down</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((r) => (
                  <tr key={r.cellId} className={r.cellId === cellId ? "selected" : ""}>
                    <td><a href={href("kpis", { cell: r.cellId, kpi, range, tech })}>{r.cellId}</a></td><td>{r.siteId}</td><td>{r.technology}</td><td><LevelBadge level={r.worstLevel} /></td>
                    <td className="num">{fmt(availabilityOf(r), 1)}</td>
                    {CORE_KPIS.map((k) => <td key={k} className={`num lvl-text-${classify(r.values[k], thresholdFor(thresholds, k, r.technology))}`}>{fmt(r.values[k], KPI_META[k].decimals)}</td>)}
                    <td className="num">{r.downIntervals}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {tableRows.length === 0 && <Empty text="No cells match the current filters." />}
          </div>
        )}
      </Card>
    </div>
  );
}
