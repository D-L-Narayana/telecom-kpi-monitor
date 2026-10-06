/**
 * Alarm and fault tracking: filterable, sortable, paginated alarm list with keyboard navigation, operator actions
 * (acknowledge / clear / reopen with optional notes, bulk acknowledge), an Explain panel that correlates the alarm
 * with the KPI implied by its probable cause, and the persisted audit trail.
 *
 * Every filter lives in the URL hash (`severity`, `state`, `site`, `q`, `sort`, `dir`, `page`, `alarm`) so that a
 * view can be shared; the page derives its state from `route.params` and writes changes through `setQuery`.
 */
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { href, useApp } from "../state";
import { auditToCsv, durationMin, type AlarmActionType } from "../lib/alarmStore";
import { correlateAlarm, indexSamplesByCell, type AlarmCorrelation, type CorrelationVerdict } from "../lib/correlation";
import { toCsv, downloadText } from "../lib/csv";
import { KPI_META, fmt } from "../lib/kpi";
import { parsePositiveInt } from "../lib/router";
import { thresholdFor } from "../lib/thresholds";
import { KpiChart } from "../components/KpiChart";
import { Card, Empty, Notice, SeverityBadge, StateBadge, fmtTime } from "../components/ui";
import type { Alarm, AlarmState, KpiKey, Severity, Site } from "../types/telecom";

export const PAGE_SIZE = 50;
const AUDIT_PREVIEW = 25;
const HOUR_MS = 3600e3;

const SEVERITIES: readonly Severity[] = ["Critical", "Major", "Minor", "Warning"];
const SEVERITY_RANK: Record<Severity, number> = { Critical: 0, Major: 1, Minor: 2, Warning: 3 };
const STATES: readonly AlarmState[] = ["active", "acknowledged", "cleared"];

type SortKey = "raised" | "severity" | "site" | "duration";
type SortDir = "asc" | "desc";
const SORT_KEYS: readonly SortKey[] = ["raised", "severity", "site", "duration"];
const SORT_DIRS: readonly SortDir[] = ["asc", "desc"];
/** Default direction per column: newest / most severe / longest first, sites alphabetically. */
const DEFAULT_DIR: Record<SortKey, SortDir> = { raised: "desc", severity: "desc", site: "asc", duration: "desc" };

const VERDICT_HELP: Record<CorrelationVerdict, string> = {
  strong: "KPI evidence supports this alarm.",
  weak: "Some KPI movement, but below the strong threshold.",
  none: "No KPI degradation found around this alarm.",
  insufficient: "Not enough KPI samples around this alarm to judge.",
};

const EXPORT_COLUMNS = ["alarmId", "timestamp", "clearedAt", "durationMin", "siteId", "cellId", "technology", "severity", "probableCause", "state", "correlation", "correlationScore", "correlationKpi", "note"];

interface Filters {
  severity: Severity | "";
  state: AlarmState | "";
  site: string;
  q: string;
  sort: SortKey;
  dir: SortDir;
  /** Explicit `page` param (validated) or null when absent / invalid. */
  pageParam: number | null;
  alarm: string | null;
  /** `key=value` pairs that were present in the URL but not understood. */
  ignored: string[];
}

function readFilters(params: URLSearchParams, siteIds: ReadonlySet<string>): Filters {
  const ignored: string[] = [];
  const pick = <T extends string>(key: string, allowed: readonly T[]): T | "" => {
    const v = params.get(key);
    if (v === null || v === "") return "";
    if ((allowed as readonly string[]).includes(v)) return v as T;
    ignored.push(`${key}=${v}`);
    return "";
  };
  const severity = pick("severity", SEVERITIES);
  const state = pick("state", STATES);
  const siteRaw = params.get("site") ?? "";
  let site = "";
  if (siteRaw) {
    if (siteIds.has(siteRaw)) site = siteRaw;
    else ignored.push(`site=${siteRaw}`);
  }
  const sort = pick("sort", SORT_KEYS) || "raised";
  const dir = pick("dir", SORT_DIRS) || DEFAULT_DIR[sort];
  const pageRaw = params.get("page");
  let pageParam: number | null = null;
  if (pageRaw !== null && pageRaw !== "") {
    const n = parsePositiveInt(pageRaw, 0);
    if (n >= 1) pageParam = n;
    else ignored.push(`page=${pageRaw}`);
  }
  const alarm = params.get("alarm");
  return { severity, state, site, q: (params.get("q") ?? "").trim(), sort, dir, pageParam, alarm: alarm ? alarm : null, ignored };
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareAlarms(a: Alarm, b: Alarm, sort: SortKey, dir: SortDir, nowIso: string): number {
  let c = 0;
  switch (sort) {
    case "raised": c = compareStrings(a.timestamp, b.timestamp); break;
    case "severity": c = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]; break; // "larger" = more severe
    case "site": c = compareStrings(a.siteId, b.siteId); break;
    case "duration": c = durationMin(a, nowIso) - durationMin(b, nowIso); break;
  }
  if (dir === "desc") c = -c;
  return c !== 0 ? c : compareStrings(a.alarmId, b.alarmId);
}

function matchesText(a: Alarm, q: string): boolean {
  return `${a.alarmId} ${a.probableCause} ${a.cellId ?? ""} ${a.siteId}`.toLowerCase().includes(q);
}

function rowDomId(alarmId: string): string {
  return `alarm-row-${alarmId.replace(/[^\w-]/g, "_")}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function VerdictBadge({ c }: { c: AlarmCorrelation }) {
  return <span className={`badge verdict-${c.verdict}`} title={`${VERDICT_HELP[c.verdict]} Score ${c.score.toFixed(2)}.`}>{c.verdict}</span>;
}

function SortHeader({ label, col, sort, dir, onSort, className }: { label: string; col: SortKey; sort: SortKey; dir: SortDir; onSort: (col: SortKey) => void; className?: string }) {
  const active = sort === col;
  return (
    <th scope="col" className={className} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}>
      <button type="button" className="sort-btn" onClick={() => onSort(col)}>
        {label}
        {active && <span aria-hidden="true">{dir === "asc" ? " ▲" : " ▼"}</span>}
      </button>
    </th>
  );
}

/** Note + action buttons for the selected alarm; remounted per alarm (`key`) so a draft note never leaks to another alarm. */
function ExplainActions({ alarm, hasOverride, onAction, onReset }: { alarm: Alarm; hasOverride: boolean; onAction: (type: AlarmActionType, note?: string) => void; onReset: () => void }) {
  const [note, setNote] = useState("");
  const run = (type: AlarmActionType) => {
    onAction(type, note.trim() || undefined);
    setNote("");
  };
  return (
    <div className="explain-actions">
      <label htmlFor="alarm-note" className="small-text muted">Note (optional)</label>
      <textarea id="alarm-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ticket id, finding, handover remark…" />
      <div className="toolbar">
        {alarm.state === "active" && <button type="button" className="btn small" onClick={() => run("acknowledge")}>Ack</button>}
        {alarm.state !== "cleared" && <button type="button" className="btn small" onClick={() => run("clear")}>Clear</button>}
        {alarm.state === "cleared" && <button type="button" className="btn small" onClick={() => run("reopen")}>Reopen</button>}
        {hasOverride && <button type="button" className="btn small" onClick={onReset} title="Drop the local override and show the alarm as delivered by the data source">Reset override</button>}
      </div>
    </div>
  );
}

export function Alarms() {
  const { data, cells, alarms, alarmDispatch, alarmStore, audit, nowIso, thresholds, range, tech, route, setQuery, source } = useApp();

  const byCell = useMemo(() => indexSamplesByCell(data.samples), [data]);
  const sites = useMemo<Pick<Site, "siteId" | "name">[]>(() => {
    const known = new Map(data.sites.map((s) => [s.siteId, s.name]));
    for (const a of data.alarms) if (!known.has(a.siteId)) known.set(a.siteId, "");
    return [...known.entries()].map(([siteId, name]) => ({ siteId, name })).sort((a, b) => compareStrings(a.siteId, b.siteId));
  }, [data]);
  const siteIds = useMemo(() => new Set(sites.map((s) => s.siteId)), [sites]);
  const filters = useMemo(() => readFilters(route.params, siteIds), [route.params, siteIds]);

  // The search box filters live while typing; the text is committed to the URL on Enter or blur.
  const [draft, setDraft] = useState<string | null>(null);
  const q = (draft ?? filters.q).trim().toLowerCase();

  const rows = useMemo(() => alarms
    .filter((a) =>
      (!filters.severity || a.severity === filters.severity) && (!filters.state || a.state === filters.state) && (!filters.site || a.siteId === filters.site) &&
      (tech === "All" || !a.technology || a.technology === tech) && (!q || matchesText(a, q)))
    .sort((a, b) => compareAlarms(a, b, filters.sort, filters.dir, nowIso)),
  [alarms, filters.severity, filters.state, filters.site, filters.sort, filters.dir, tech, q, nowIso]);

  const selectedId = filters.alarm;
  const selected = useMemo(() => (selectedId ? alarms.find((a) => a.alarmId === selectedId) ?? null : null), [alarms, selectedId]);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  // Without an explicit page the view opens on the page that holds the selected alarm (deep links).
  const page = useMemo(() => {
    if (filters.pageParam !== null) return clamp(filters.pageParam, 1, pageCount);
    if (selectedId) {
      const i = rows.findIndex((a) => a.alarmId === selectedId);
      if (i >= 0) return Math.floor(i / PAGE_SIZE) + 1;
    }
    return 1;
  }, [filters.pageParam, pageCount, rows, selectedId]);
  const pageRows = useMemo(() => rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [rows, page]);
  // Verdict badges are computed lazily for the visible non-cleared rows only.
  const pageVerdicts = useMemo(() => {
    const m = new Map<string, AlarmCorrelation>();
    for (const a of pageRows) if (a.state !== "cleared") m.set(a.alarmId, correlateAlarm(a, byCell, cells, thresholds, nowIso));
    return m;
  }, [pageRows, byCell, cells, thresholds, nowIso]);

  const explain = useMemo(() => {
    if (!selected) return null;
    const corr = correlateAlarm(selected, byCell, cells, thresholds, nowIso);
    const t0 = Date.parse(selected.timestamp) - 2 * HOUR_MS;
    const t1 = Date.parse(selected.clearedAt ?? nowIso) + 2 * HOUR_MS;
    const byTs = new Map<string, (number | null)[]>();
    for (const cellId of corr.cellIds) {
      for (const s of byCell.get(cellId) ?? []) {
        const t = Date.parse(s.timestamp);
        if (t < t0) continue;
        if (t > t1) break;
        const arr = byTs.get(s.timestamp) ?? [];
        arr.push(s[corr.kpi]);
        byTs.set(s.timestamp, arr);
      }
    }
    const points = [...byTs.entries()].sort(([a], [b]) => compareStrings(a, b)).map(([ts, vals]) => {
      const ok = vals.filter((v): v is number => v !== null);
      return { t: Date.parse(ts), v: ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null };
    });
    const cellTech = selected.cellId ? cells.get(selected.cellId)?.technology ?? "All" : "All";
    const threshold = thresholdFor(thresholds, corr.kpi, cellTech);
    const markers = [{ t: Date.parse(selected.timestamp), label: "raised" }, ...(selected.clearedAt ? [{ t: Date.parse(selected.clearedAt), label: "cleared" }] : [])];
    return { corr, points, threshold, markers };
  }, [selected, byCell, cells, thresholds, nowIso]);

  useEffect(() => {
    if (!selectedId) return;
    document.getElementById(rowDomId(selectedId))?.scrollIntoView({ block: "nearest" });
  }, [selectedId, page]);

  const updateFilters = useCallback((patch: Record<string, string | undefined>) => setQuery({ ...patch, page: undefined }), [setQuery]);
  const select = useCallback((alarmId: string) => setQuery({ alarm: alarmId }), [setQuery]);
  const commitSearch = () => {
    if (draft === null) return;
    const v = draft.trim();
    if (v !== filters.q) updateFilters({ q: v || undefined });
    setDraft(null);
  };
  const clearFilters = () => {
    setDraft(null);
    updateFilters({ severity: undefined, state: undefined, site: undefined, q: undefined });
  };
  const onSort = (col: SortKey) => {
    const dir: SortDir = col === filters.sort ? (filters.dir === "asc" ? "desc" : "asc") : DEFAULT_DIR[col];
    const isDefault = col === "raised" && dir === DEFAULT_DIR.raised;
    updateFilters({ sort: isDefault ? undefined : col, dir: isDefault ? undefined : dir });
  };
  const onRowKeyDown = (e: KeyboardEvent<HTMLTableRowElement>, alarmId: string) => {
    if (e.target !== e.currentTarget) return; // keys inside the action buttons belong to the buttons
    const row = e.currentTarget;
    const focus = (el: Element | null | undefined) => { if (el instanceof HTMLElement) el.focus(); };
    switch (e.key) {
      case "Enter":
      case " ":
        e.preventDefault();
        select(alarmId);
        break;
      case "ArrowDown": e.preventDefault(); focus(row.nextElementSibling); break;
      case "ArrowUp": e.preventDefault(); focus(row.previousElementSibling); break;
      case "Home": e.preventDefault(); focus(row.parentElement?.firstElementChild); break;
      case "End": e.preventDefault(); focus(row.parentElement?.lastElementChild); break;
    }
  };

  const act = (type: AlarmActionType, alarmId: string, note?: string) => alarmDispatch({ type, alarmId, note });
  const activeFiltered = useMemo(() => rows.filter((a) => a.state === "active").map((a) => a.alarmId), [rows]);
  const ackAllFiltered = () => {
    if (activeFiltered.length === 0) return;
    if (!window.confirm(`Acknowledge ${activeFiltered.length} active alarm${activeFiltered.length === 1 ? "" : "s"} matching the current filters?`)) return;
    alarmDispatch({ type: "bulk", action: "acknowledge", alarmIds: activeFiltered });
  };
  const exportCsv = () => downloadText("alarms.csv", toCsv(rows.map((a) => {
    const c = correlateAlarm(a, byCell, cells, thresholds, nowIso);
    return { ...a, durationMin: durationMin(a, nowIso), correlation: c.verdict, correlationScore: c.score.toFixed(2), correlationKpi: c.kpi, note: alarmStore.overrides[a.alarmId]?.note ?? "" };
  }), EXPORT_COLUMNS));
  const exportAudit = () => downloadText("alarm-audit.csv", auditToCsv(audit));
  const clearAudit = () => {
    if (audit.length === 0) return;
    if (!window.confirm(`Clear all ${audit.length} audit entries? This cannot be undone.`)) return;
    alarmDispatch({ type: "clearAudit" });
  };

  const alarmLink = (alarmId: string): string => {
    const merged: Record<string, string | undefined> = {};
    route.params.forEach((v, k) => { merged[k] = v; });
    merged.alarm = alarmId;
    merged.page = undefined; // let the view open on the page that holds the alarm
    return href("alarms", merged);
  };
  const kpiLink = (cellId: string, kpi: KpiKey): string => href("kpis", { cell: cellId, kpi, range, tech });

  const counts = useMemo(() => {
    const c = { active: 0, acknowledged: 0, cleared: 0 };
    for (const a of alarms) c[a.state]++;
    return c;
  }, [alarms]);
  const hasFilters = Boolean(filters.severity || filters.state || filters.site || filters.q || (draft !== null && draft.trim()));
  const rangeStart = rows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(rows.length, page * PAGE_SIZE);
  const storageNote = source.kind === "synthetic" ? "stored in this browser" : "kept in memory for this session";

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Alarm and fault tracking</h1>
          <p className="muted">{counts.active} active · {counts.acknowledged} acknowledged · {counts.cleared} cleared. Acknowledge / clear / reopen actions and notes are {storageNote} with an audit trail.</p>
        </div>
      </div>

      {filters.ignored.length > 0 && <Notice kind="warning">Ignored unknown filter value{filters.ignored.length > 1 ? "s" : ""}: {filters.ignored.join(", ")}.</Notice>}

      <Card title={`Alarm list (${rows.length})`} actions={<>
        <select aria-label="Severity filter" value={filters.severity} onChange={(e) => updateFilters({ severity: e.target.value || undefined })}>
          <option value="">All severities</option>
          {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select aria-label="State filter" value={filters.state} onChange={(e) => updateFilters({ state: e.target.value || undefined })}>
          <option value="">All states</option>
          {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select aria-label="Site filter" value={filters.site} onChange={(e) => updateFilters({ site: e.target.value || undefined })}>
          <option value="">All sites</option>
          {sites.map((s) => <option key={s.siteId} value={s.siteId}>{s.siteId}{s.name ? ` ${s.name}` : ""}</option>)}
        </select>
        <input type="search" aria-label="Search alarms" placeholder="Search id / cause / cell / site" value={draft ?? filters.q}
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") commitSearch(); }} onBlur={commitSearch} />
        <button type="button" className="btn small" onClick={clearFilters} disabled={!hasFilters}>Clear filters</button>
        <button type="button" className="btn small" onClick={ackAllFiltered} disabled={activeFiltered.length === 0}>Acknowledge all filtered active ({activeFiltered.length})</button>
        <button type="button" className="btn small" onClick={exportCsv} disabled={rows.length === 0}>Export CSV</button>
      </>}>
        {alarms.length === 0 ? <Empty text="This dataset has no alarms." /> : rows.length === 0 ? <Empty text="No alarms match the current filters." /> : (
          <>
            <div className="table-wrap tall">
              <table className="table" aria-label="Alarms">
                <thead>
                  <tr>
                    <th scope="col">Alarm</th>
                    <SortHeader label="Raised (IST)" col="raised" sort={filters.sort} dir={filters.dir} onSort={onSort} />
                    <SortHeader label="Severity" col="severity" sort={filters.sort} dir={filters.dir} onSort={onSort} />
                    <SortHeader label="Site" col="site" sort={filters.sort} dir={filters.dir} onSort={onSort} />
                    <th scope="col">Cell</th>
                    <th scope="col">Probable cause</th>
                    <th scope="col">State</th>
                    <th scope="col">Correlation</th>
                    <SortHeader label="Duration min" col="duration" sort={filters.sort} dir={filters.dir} onSort={onSort} className="num" />
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((a) => {
                    const isSelected = a.alarmId === selectedId;
                    const verdict = pageVerdicts.get(a.alarmId);
                    return (
                      <tr key={a.alarmId} id={rowDomId(a.alarmId)} tabIndex={0} aria-selected={isSelected} className={isSelected ? "selected" : undefined}
                        onClick={() => select(a.alarmId)} onKeyDown={(e) => onRowKeyDown(e, a.alarmId)}>
                        <td>{a.alarmId}</td>
                        <td>{fmtTime(a.timestamp)}</td>
                        <td><SeverityBadge s={a.severity} /></td>
                        <td>{a.siteId}</td>
                        <td>{a.cellId ?? <span className="muted">site</span>}</td>
                        <td>{a.probableCause}</td>
                        <td><StateBadge s={a.state} /></td>
                        <td>{verdict ? <VerdictBadge c={verdict} /> : <span className="muted" title="Select the row to correlate a cleared alarm">–</span>}</td>
                        <td className="num">{durationMin(a, nowIso)}</td>
                        <td>
                          <div className="actions">
                            {a.state === "active" && <button type="button" className="btn small" onClick={(e) => { e.stopPropagation(); act("acknowledge", a.alarmId); }}>Ack</button>}
                            {a.state !== "cleared" && <button type="button" className="btn small" onClick={(e) => { e.stopPropagation(); act("clear", a.alarmId); }}>Clear</button>}
                            {a.state === "cleared" && <button type="button" className="btn small" onClick={(e) => { e.stopPropagation(); act("reopen", a.alarmId); }}>Reopen</button>}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <span>Showing {rangeStart}–{rangeEnd} of {rows.length}</span>
              <button type="button" className="btn small" disabled={page <= 1} onClick={() => setQuery({ page: String(page - 1) })}>Previous</button>
              <span aria-live="polite">Page {page} of {pageCount}</span>
              <button type="button" className="btn small" disabled={page >= pageCount} onClick={() => setQuery({ page: String(page + 1) })}>Next</button>
            </div>
            <p className="muted small-text">Rows are keyboard-navigable: focus a row, use ↑ / ↓ (Home / End) to move and Enter to open it in the Explain panel.</p>
          </>
        )}
      </Card>

      <div className="two-col">
        <Card title={selected ? `Explain ${selected.alarmId} · ${selected.probableCause}` : "Explain panel"}
          actions={selected ? <button type="button" className="btn small" onClick={() => setQuery({ alarm: undefined })}>Close</button> : undefined}>
          {!selectedId ? <Empty text="Select an alarm row to see the affected cell's KPI around the alarm (±2 h) and how strongly it correlates." /> :
            !selected || !explain ? <Empty text={`Alarm ${selectedId} is not in the current dataset.`} /> : (() => {
              const { corr, points, threshold, markers } = explain;
              const meta = KPI_META[corr.kpi];
              const val = (v: number | null) => (v === null ? "–" : `${fmt(v, meta.decimals)} ${meta.unit}`);
              const delta = (d: number | null) => (d === null ? "–" : `${d > 0 ? "+" : ""}${d.toFixed(1)} %${d > 0 ? " worse" : d < 0 ? " better" : ""}`);
              const override = alarmStore.overrides[selected.alarmId];
              return (
                <>
                  <p className="small-text">
                    <SeverityBadge s={selected.severity} /> <StateBadge s={selected.state} /> raised {fmtTime(selected.timestamp)}
                    {selected.clearedAt ? `, cleared ${fmtTime(selected.clearedAt)}` : ""} · {durationMin(selected, nowIso)} min
                    {override?.note ? <> · note: <em>{override.note}</em></> : null}
                  </p>
                  <p className="small-text muted">
                    {corr.cellIds.length === 0 ? `No cells of site ${selected.siteId} in this dataset` : corr.cellIds.length === 1 ? `Cell ${corr.cellIds[0]}` : `Site ${selected.siteId}, mean of ${corr.cellIds.length} cells`}
                    {" · "}{meta.label} from 2 h before the alarm to 2 h after {selected.clearedAt ? "clearance" : "the end of the data"}. Dashed lines mark raise/clear; gaps mean the cell had no counters (down).
                  </p>
                  <p className="small-text"><VerdictBadge c={corr} /> <span>score {corr.score.toFixed(2)}</span> <span className="muted">— {VERDICT_HELP[corr.verdict]}</span></p>
                  <ul className="detect-list metrics" aria-label="Correlation metrics">
                    <li><span className="muted">Baseline (2 h before)</span><strong>{val(corr.baseline)}</strong></li>
                    <li><span className="muted">During alarm</span><strong>{val(corr.during)}</strong></li>
                    <li><span className="muted">After (2 h)</span><strong>{selected.clearedAt ? val(corr.after) : "–"}</strong></li>
                    <li><span className="muted">Peak (first 2 h)</span><strong>{val(corr.peak)}</strong></li>
                    <li><span className="muted">Change</span><strong>{delta(corr.deltaPct)}</strong></li>
                    <li><span className="muted">Peak change</span><strong>{delta(corr.peakDeltaPct)}</strong></li>
                    <li><span className="muted">Breach fraction</span><strong>{threshold ? `${Math.round(corr.breachFraction * 100)} % of samples` : "no threshold for this KPI"}</strong></li>
                    <li><span className="muted">Down intervals</span><strong>{corr.downIntervals}</strong></li>
                  </ul>
                  <h3 className="small-text">Related detections ({corr.detections.length})</h3>
                  {corr.detections.length === 0 ? <p className="muted small-text">No rule-based detections in the alarm window.</p> : (
                    <ul className="detect-list">
                      {corr.detections.map((d) => (
                        <li key={`${d.kind}-${d.cellId}`}>
                          <span className={`badge kind-${d.kind}`}>{d.kind}</span>
                          <a href={kpiLink(d.cellId, corr.kpi)}>{d.cellId}</a>
                          <span className="muted small-text">{d.detail}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {points.length === 0 ? <Empty text="No KPI samples around this alarm." /> : <KpiChart kpi={corr.kpi} points={points} threshold={threshold} height={220} markers={markers} />}
                  <ExplainActions key={selected.alarmId} alarm={selected} hasOverride={override !== undefined}
                    onAction={(type, note) => act(type, selected.alarmId, note)} onReset={() => alarmDispatch({ type: "resetAlarm", alarmId: selected.alarmId })} />
                </>
              );
            })()}
        </Card>

        <Card title={`Audit trail (${audit.length})`} actions={<>
          <button type="button" className="btn small" onClick={exportAudit} disabled={audit.length === 0}>Export audit CSV</button>
          <button type="button" className="btn small" onClick={clearAudit} disabled={audit.length === 0}>Clear audit</button>
        </>}>
          {audit.length === 0 ? <Empty text="No acknowledge / clear / reopen actions yet." /> : (
            <>
              <ul className="audit" aria-label="Audit entries">
                {audit.slice(0, AUDIT_PREVIEW).map((e, i) => (
                  <li key={`${e.at}-${e.alarmId}-${i}`}>
                    <span className="muted">{fmtTime(e.at)}</span> {e.action} <a href={alarmLink(e.alarmId)}>{e.alarmId}</a>
                    {e.note ? <> — <em>{e.note}</em></> : null}
                  </li>
                ))}
              </ul>
              {audit.length > AUDIT_PREVIEW && <p className="muted small-text">Showing the latest {AUDIT_PREVIEW} of {audit.length} entries; export the CSV for the full trail.</p>}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
