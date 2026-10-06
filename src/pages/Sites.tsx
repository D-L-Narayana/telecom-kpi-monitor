import { useMemo, type MouseEvent } from "react";
import { href, useApp } from "../state";
import { RANGE_MS, filterTech, fmt, inWindow, type CellAggregate, type TimeRange } from "../lib/kpi";
import { aggregateByRegion, aggregateBySite, type SiteAggregate } from "../lib/sites";
import { downloadText, toCsv } from "../lib/csv";
import type { Level } from "../lib/thresholds";
import type { Technology } from "../types/telecom";
import { SiteMap } from "../components/SiteMap";
import { Card, Empty, LevelBadge, Notice, fmtTime } from "../components/ui";

type SortDir = "asc" | "desc";
type SortValue = string | number | null;

interface Column {
  key: string;
  label: string;
  /** Right-aligned numeric column. */
  numeric: boolean;
  /** Direction that puts the worst (or largest) site first; used when a column is sorted for the first time. */
  worstFirst: SortDir;
  value: (s: SiteAggregate) => SortValue;
}

const LEVEL_RANK: Record<Level, number> = { ok: 0, warning: 1, critical: 2 };

/** Site table columns in display order; the first one is the default sort. */
const COLUMNS: readonly Column[] = [
  { key: "site", label: "Site", numeric: false, worstFirst: "asc", value: (s) => s.siteId },
  { key: "name", label: "Name", numeric: false, worstFirst: "asc", value: (s) => s.name },
  { key: "region", label: "Region", numeric: false, worstFirst: "asc", value: (s) => s.region },
  { key: "cells", label: "Cells", numeric: true, worstFirst: "desc", value: (s) => s.cellIds.length },
  { key: "status", label: "Status", numeric: false, worstFirst: "desc", value: (s) => LEVEL_RANK[s.worstLevel] },
  { key: "availability", label: "Availability %", numeric: true, worstFirst: "asc", value: (s) => s.availabilityPct },
  { key: "cdr", label: "CDR %", numeric: true, worstFirst: "desc", value: (s) => s.values.callDropRatePct },
  { key: "latency", label: "Latency ms", numeric: true, worstFirst: "desc", value: (s) => s.values.latencyMs },
  { key: "prb", label: "PRB %", numeric: true, worstFirst: "desc", value: (s) => s.values.prbUtilizationPct },
  { key: "dl", label: "DL Mbps", numeric: true, worstFirst: "asc", value: (s) => s.values.dlThroughputMbps },
  { key: "alarms", label: "Active alarms", numeric: true, worstFirst: "desc", value: (s) => s.activeAlarms },
  { key: "down", label: "Down cells", numeric: true, worstFirst: "desc", value: (s) => s.downCells },
];

const CSV_COLUMNS = ["siteId", "name", "region", "cells", "status", "availabilityPct", "callDropRatePct", "latencyMs", "prbUtilizationPct", "dlThroughputMbps", "activeAlarms", "downCells", "downIntervals", "worstCell"];

function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

function columnFor(key: string | null): Column {
  return COLUMNS.find((c) => c.key === key) ?? COLUMNS[0];
}

function parseDir(v: string | null): SortDir | null {
  return v === "asc" || v === "desc" ? v : null;
}

/** Missing values sort last in both directions; strings compare by code point, numbers by value. */
function compareValues(a: SortValue, b: SortValue, dir: SortDir): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const c = typeof a === "string" && typeof b === "string" ? (a < b ? -1 : a > b ? 1 : 0) : Number(a) - Number(b);
  return dir === "asc" ? c : -c;
}

const bySiteId = (a: SiteAggregate, b: SiteAggregate) => (a.siteId < b.siteId ? -1 : a.siteId > b.siteId ? 1 : 0);

function sortSites(sites: SiteAggregate[], col: Column, dir: SortDir): SiteAggregate[] {
  return [...sites].sort((a, b) => compareValues(col.value(a), col.value(b), dir) || bySiteId(a, b));
}

/** The cell to open first for a site: worst level, then most breached KPIs, then highest call drop rate. */
function worstCell(cells: CellAggregate[]): CellAggregate | undefined {
  return [...cells].sort(
    (a, b) =>
      LEVEL_RANK[b.worstLevel] - LEVEL_RANK[a.worstLevel] ||
      b.breaches - a.breaches ||
      (b.values.callDropRatePct ?? -1) - (a.values.callDropRatePct ?? -1) ||
      (a.cellId < b.cellId ? -1 : 1),
  )[0];
}

function round(v: number | null, decimals: number): number | "" {
  return v === null ? "" : Number(v.toFixed(decimals));
}

function csvFileName(range: TimeRange, tech: Technology | "All", region: string | null): string {
  const parts = ["sites", range, tech, ...(region ? [region] : [])];
  return `${parts.map((p) => p.replace(/[^\w.-]+/g, "-")).join("_")}.csv`;
}

/**
 * Sites and regions: region roll-up tiles (filter), the SVG site health map, a detail panel for the selected site
 * and a sortable per-site table. Every piece of view state lives in the URL (`region`, `site`, `sort`, `dir`) next
 * to the global `range` / `tech`, so any view can be shared as a link.
 */
export function Sites() {
  const { data, cells, now, range, tech, thresholds, alarms, route, setQuery, source } = useApp();
  const rangeMs = RANGE_MS[range];
  const cur = useMemo(() => filterTech(inWindow(data.samples, now, rangeMs), cells, tech), [data, cells, now, rangeMs, tech]);
  const siteAggs = useMemo(() => aggregateBySite(cur, cells, data.sites, thresholds, alarms), [cur, cells, data, thresholds, alarms]);
  const regions = useMemo(() => aggregateByRegion(siteAggs), [siteAggs]);

  // View state, derived from the URL on every render (never mirrored into local state).
  const params = route.params;
  const regionParam = params.get("region");
  const region = regionParam && regions.some((r) => r.region === regionParam) ? regionParam : null;
  const siteParam = params.get("site");
  const selected = siteParam ? siteAggs.find((s) => s.siteId === siteParam) ?? null : null;
  const sortParam = params.get("sort");
  const sortCol = columnFor(sortParam);
  const dir = parseDir(params.get("dir")) ?? sortCol.worstFirst;

  const visible = region ? siteAggs.filter((s) => s.region === region) : siteAggs;
  const sorted = sortSites(visible, sortCol, dir);
  const cellCount = siteAggs.reduce((n, s) => n + s.cellIds.length, 0);
  const withoutGeo = visible.filter((s) => !Number.isFinite(s.lat) || !Number.isFinite(s.lon)).length;
  const tzLabel = source.timeZone === "Asia/Kolkata" ? "IST" : source.timeZone;

  /** Link to this page with some params changed (`undefined` removes one); existing params keep their order. */
  const pageHref = (patch: Record<string, string | undefined>) => {
    const merged: Record<string, string | undefined> = {};
    for (const [k, v] of params) merged[k] = v;
    for (const [k, v] of Object.entries(patch)) merged[k] = v;
    return href("sites", merged);
  };
  const pickRegion = (e: MouseEvent<HTMLAnchorElement>, next: string | undefined) => {
    e.preventDefault();
    // keep the selection only while the selected site stays visible
    const site = selected && (!next || selected.region === next) ? selected.siteId : undefined;
    setQuery({ region: next, site });
  };
  const selectSite = (siteId: string | undefined) => setQuery({ site: siteId });
  const sortBy = (col: Column) => setQuery({ sort: col.key, dir: col === sortCol ? (dir === "asc" ? "desc" : "asc") : col.worstFirst });
  const exportCsv = () => {
    const rows = sorted.map((s) => ({
      siteId: s.siteId, name: s.name, region: s.region, cells: s.cellIds.length, status: s.worstLevel,
      availabilityPct: round(s.availabilityPct, 2), callDropRatePct: round(s.values.callDropRatePct, 3), latencyMs: round(s.values.latencyMs, 1),
      prbUtilizationPct: round(s.values.prbUtilizationPct, 1), dlThroughputMbps: round(s.values.dlThroughputMbps, 1),
      activeAlarms: s.activeAlarms, downCells: s.downCells, downIntervals: s.downIntervals, worstCell: worstCell(s.cells)?.cellId ?? "",
    }));
    downloadText(csvFileName(range, tech, region), toCsv(rows, CSV_COLUMNS));
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Sites and regions</h1>
          <p className="muted">
            {plural(siteAggs.length, "site")} · {plural(cellCount, "cell")} · {plural(regions.length, "region")} · window {range} ending {fmtTime(now, true, source.timeZone)} {tzLabel} · {cur.length.toLocaleString()} KPI samples
          </p>
        </div>
      </div>

      {cur.length === 0 ? (
        <Card title="Sites">
          <Empty text="No KPI samples in this window." />
          <p className="muted small-text">Dataset: {source.label}. Choose a longer time range or another technology filter.</p>
        </Card>
      ) : (
        <>
          {regionParam && !region && <Notice kind="info">Region “{regionParam}” has no sites in this window; showing all regions.</Notice>}
          {siteParam && !selected && <Notice kind="info">Site “{siteParam}” has no samples in this window; nothing is selected.</Notice>}

          <div className="region-grid" role="group" aria-label="Regions">
            {regions.map((r) => {
              const active = r.region === region;
              return (
                <a
                  key={r.region}
                  className={`region-tile lvl-border-${r.worstLevel}`}
                  href={pageHref({ region: active ? undefined : r.region })}
                  aria-current={active ? "true" : undefined}
                  title={active ? "Show all regions" : `Show only ${r.region}`}
                  onClick={(e) => pickRegion(e, active ? undefined : r.region)}
                >
                  <span className="kpi-top"><strong>{r.region}</strong><LevelBadge level={r.worstLevel} /></span>
                  <span className="tile-label">{plural(r.siteIds.length, "site")} · {plural(r.cellCount, "cell")}</span>
                  <span className="tile-label">{plural(r.activeAlarms, "active alarm")} · {plural(r.downCells, "down cell")}</span>
                  <span className="small-text">CDR {fmt(r.values.callDropRatePct, 2)} % · PRB {fmt(r.values.prbUtilizationPct, 1)} %</span>
                </a>
              );
            })}
          </div>

          <div className="two-col">
            <Card title={region ? `Site health map · ${region}` : "Site health map"}>
              <SiteMap sites={visible} selected={selected?.siteId} onSelect={(id) => selectSite(id === selected?.siteId ? undefined : id)} />
              <p className="muted small-text">
                Circle colour is the worst threshold level among a site&apos;s cells, circle size its number of cells. Click a circle, or focus it and press Enter, to select a site.
                {withoutGeo > 0 && ` ${plural(withoutGeo, "site")} without coordinates ${withoutGeo === 1 ? "is" : "are"} listed in the table but not drawn on the map.`}
              </p>
            </Card>

            {selected ? (
              <Card
                title={`Site ${selected.siteId} · ${selected.name}`}
                actions={<>
                  <a className="btn small" href={href("alarms", { site: selected.siteId, range, tech })}>Open alarms</a>
                  <button type="button" className="btn small" onClick={() => selectSite(undefined)}>Clear selection</button>
                </>}
              >
                <p className="small-text muted">
                  {selected.region} · {selected.technologies.join(" / ")} · <LevelBadge level={selected.worstLevel} /> · availability {fmt(selected.availabilityPct, 1)} % · {plural(selected.activeAlarms, "active alarm")} · {plural(selected.downCells, "down cell")}
                </p>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr><th scope="col">Cell</th><th scope="col">Tech</th><th scope="col">Status</th><th scope="col" className="num">CDR %</th><th scope="col" className="num">RRC %</th><th scope="col" className="num">HO %</th><th scope="col" className="num">DL Mbps</th><th scope="col" className="num">Latency ms</th><th scope="col" className="num">PRB %</th><th scope="col" className="num">Down intervals</th></tr>
                    </thead>
                    <tbody>
                      {selected.cells.map((c) => (
                        <tr key={c.cellId}>
                          <td><a href={href("kpis", { cell: c.cellId, range, tech })}>{c.cellId}</a></td>
                          <td>{c.technology}</td>
                          <td><LevelBadge level={c.worstLevel} /></td>
                          <td className="num">{fmt(c.values.callDropRatePct, 2)}</td>
                          <td className="num">{fmt(c.values.rrcSetupSuccessPct, 2)}</td>
                          <td className="num">{fmt(c.values.handoverSuccessPct, 2)}</td>
                          <td className="num">{fmt(c.values.dlThroughputMbps, 1)}</td>
                          <td className="num">{fmt(c.values.latencyMs, 1)}</td>
                          <td className="num">{fmt(c.values.prbUtilizationPct, 1)}</td>
                          <td className="num">{c.downIntervals}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {selected.detections.length === 0 ? (
                  <p className="muted small-text">No rule-based detections on this site in the window.</p>
                ) : (
                  <ul className="detect-list">
                    {selected.detections.map((d) => (
                      <li key={d.kind + d.cellId}>
                        <span className={`badge kind-${d.kind}`}>{d.kind}</span>
                        <a href={href("kpis", { cell: d.cellId, range, tech })}>{d.cellId}</a>
                        <span className="muted small-text">{d.detail} · {fmtTime(d.firstSeen, true, source.timeZone)} → {fmtTime(d.lastSeen, false, source.timeZone)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            ) : (
              <Card title="Selected site">
                <Empty text="Select a site on the map or in the table to see its cells and detections." />
              </Card>
            )}
          </div>

          <Card
            title={`Sites (${sorted.length})`}
            actions={<button type="button" className="btn small" onClick={exportCsv} disabled={sorted.length === 0}>Export CSV</button>}
          >
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    {COLUMNS.map((col) => (
                      <th key={col.key} scope="col" className={col.numeric ? "num" : undefined} aria-sort={col === sortCol ? (dir === "asc" ? "ascending" : "descending") : undefined}>
                        <button type="button" className="sort-btn" onClick={() => sortBy(col)}>{col.label}</button>
                      </th>
                    ))}
                    <th scope="col">Links</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((s) => {
                    const worst = worstCell(s.cells);
                    return (
                      <tr key={s.siteId} aria-selected={s.siteId === selected?.siteId ? "true" : undefined}>
                        <td><a href={pageHref({ site: s.siteId })} onClick={(e) => { e.preventDefault(); selectSite(s.siteId); }}>{s.siteId}</a></td>
                        <td>{s.name}</td>
                        <td>{s.region}</td>
                        <td className="num">{s.cellIds.length}</td>
                        <td><LevelBadge level={s.worstLevel} /></td>
                        <td className="num">{fmt(s.availabilityPct, 1)}</td>
                        <td className="num">{fmt(s.values.callDropRatePct, 2)}</td>
                        <td className="num">{fmt(s.values.latencyMs, 1)}</td>
                        <td className="num">{fmt(s.values.prbUtilizationPct, 1)}</td>
                        <td className="num">{fmt(s.values.dlThroughputMbps, 1)}</td>
                        <td className="num">{s.activeAlarms}</td>
                        <td className="num">{s.downCells}</td>
                        <td>
                          <a className="btn small" href={href("kpis", { cell: worst?.cellId, range, tech })} title={worst ? `Open ${worst.cellId} in KPI analysis` : "Open KPI analysis"}>KPIs</a>{" "}
                          <a className="btn small" href={href("alarms", { site: s.siteId, range, tech })} title={`Alarms raised on ${s.siteId}`}>Alarms</a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="muted small-text">
              Status is the worst threshold level across the site&apos;s cells; availability is the share of 15-minute intervals that reported counters; CDR, latency, PRB and DL throughput are the site&apos;s network KPIs over the window. “KPIs” opens the site&apos;s worst cell (level, then breached KPIs, then call drop rate).
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
