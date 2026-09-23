import { useEffect, useMemo, useState } from "react";
import { useApp } from "../state";
import { durationMin } from "../lib/alarmStore";
import { toCsv, downloadText } from "../lib/csv";
import { KPI_META } from "../lib/kpi";
import { thresholdFor } from "../lib/thresholds";
import { KpiChart } from "../components/KpiChart";
import { Card, Empty, SeverityBadge, StateBadge, fmtTime } from "../components/ui";
import type { Alarm, KpiKey, Severity } from "../types/telecom";

const SEVERITIES: Severity[] = ["Critical", "Major", "Minor", "Warning"];
const CAUSE_KPI: Record<string, KpiKey> = {
  "Cell down": "dlThroughputMbps", "High PRB utilization": "prbUtilizationPct", "Transmission link degraded": "latencyMs", "VSWR high": "rsrpAvgDbm",
  "Sleeping cell suspected": "activeUsers" as KpiKey, "RRC setup success degraded": "rrcSetupSuccessPct", "Handover success degraded": "handoverSuccessPct", "Packet loss on backhaul": "latencyMs",
};

export function Alarms() {
  const { data, cells, alarms, alarmAction, audit, nowIso, thresholds, tech, route } = useApp();
  const [severity, setSeverity] = useState(route.params.get("severity") ?? "");
  const [state, setState] = useState(route.params.get("state") ?? "");
  const [site, setSite] = useState("");
  const [text, setText] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(route.params.get("alarm"));
  useEffect(() => { setSeverity(route.params.get("severity") ?? ""); setState(route.params.get("state") ?? ""); const a = route.params.get("alarm"); if (a) setSelectedId(a); }, [route]);

  const rows = useMemo(() => alarms.filter((a) =>
    (!severity || a.severity === severity) && (!state || a.state === state) && (!site || a.siteId === site) &&
    (tech === "All" || !a.technology || a.technology === tech) &&
    (!text || `${a.alarmId} ${a.probableCause} ${a.cellId ?? ""} ${a.siteId}`.toLowerCase().includes(text.toLowerCase())),
  ), [alarms, severity, state, site, text, tech]);
  const selected = alarms.find((a) => a.alarmId === selectedId) ?? null;

  const explain = useMemo(() => {
    if (!selected) return null;
    const cellIds = selected.cellId ? [selected.cellId] : data.cells.filter((c) => c.siteId === selected.siteId).map((c) => c.cellId);
    const kpi = (CAUSE_KPI[selected.probableCause] ?? "callDropRatePct") as KpiKey;
    const useKpi: KpiKey = KPI_META[kpi] ? kpi : "callDropRatePct";
    const t0 = Date.parse(selected.timestamp) - 2 * 3600e3;
    const t1 = Date.parse(selected.clearedAt ?? selected.timestamp) + 2 * 3600e3;
    const win = data.samples.filter((s) => cellIds.includes(s.cellId) && Date.parse(s.timestamp) >= t0 && Date.parse(s.timestamp) <= t1);
    const byTs = new Map<string, (number | null)[]>();
    for (const s of win) { const arr = byTs.get(s.timestamp) ?? []; arr.push(s[useKpi]); byTs.set(s.timestamp, arr); }
    const points = [...byTs.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([ts, vals]) => {
      const ok = vals.filter((v): v is number => v !== null);
      return { t: Date.parse(ts), v: ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null };
    });
    const cell = selected.cellId ? cells.get(selected.cellId) : undefined;
    return { kpi: useKpi, points, cellIds, threshold: thresholdFor(thresholds, useKpi, cell?.technology ?? "All"), markers: [{ t: Date.parse(selected.timestamp), label: "raised" }, ...(selected.clearedAt ? [{ t: Date.parse(selected.clearedAt), label: "cleared" }] : [])] };
  }, [selected, data, cells, thresholds]);

  const exportCsv = () => downloadText("alarms.csv", toCsv(rows.map((a: Alarm) => ({ ...a, durationMin: durationMin(a, nowIso) })), ["alarmId", "timestamp", "clearedAt", "durationMin", "siteId", "cellId", "technology", "severity", "probableCause", "state"]));

  return (
    <div className="page">
      <div className="page-head"><div><h1>Alarm and fault tracking</h1><p className="muted">{alarms.filter((a) => a.state === "active").length} active · {alarms.filter((a) => a.state === "acknowledged").length} acknowledged · {alarms.filter((a) => a.state === "cleared").length} cleared. Acknowledge / clear actions are stored in this browser with an audit trail.</p></div></div>

      <Card title={`Alarm list (${rows.length})`} actions={<>
        <select value={severity} onChange={(e) => setSeverity(e.target.value)}><option value="">All severities</option>{SEVERITIES.map((s) => <option key={s}>{s}</option>)}</select>
        <select value={state} onChange={(e) => setState(e.target.value)}><option value="">All states</option><option value="active">active</option><option value="acknowledged">acknowledged</option><option value="cleared">cleared</option></select>
        <select value={site} onChange={(e) => setSite(e.target.value)}><option value="">All sites</option>{data.sites.map((s) => <option key={s.siteId} value={s.siteId}>{s.siteId} {s.name}</option>)}</select>
        <input placeholder="Search cause / cell / id" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn small" onClick={exportCsv}>Export CSV</button>
      </>}>
        <div className="table-wrap tall">
          <table className="table">
            <thead><tr><th>Raised (IST)</th><th>Severity</th><th>Site</th><th>Cell</th><th>Probable cause</th><th>State</th><th className="num">Duration min</th><th>Actions</th></tr></thead>
            <tbody>
              {rows.slice(0, 200).map((a) => (
                <tr key={a.alarmId} className={a.alarmId === selectedId ? "selected" : ""} onClick={() => setSelectedId(a.alarmId)}>
                  <td>{fmtTime(a.timestamp)}</td><td><SeverityBadge s={a.severity} /></td><td>{a.siteId}</td><td>{a.cellId ?? <span className="muted">site</span>}</td><td>{a.probableCause}</td><td><StateBadge s={a.state} /></td>
                  <td className="num">{durationMin(a, nowIso)}</td>
                  <td><div className="actions">
                    {a.state === "active" && <button className="btn small" onClick={(e) => { e.stopPropagation(); alarmAction(a.alarmId, "acknowledge"); }}>Ack</button>}
                    {a.state !== "cleared" && <button className="btn small" onClick={(e) => { e.stopPropagation(); alarmAction(a.alarmId, "clear"); }}>Clear</button>}
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 200 && <p className="muted small-text">Showing first 200 of {rows.length}; narrow the filters or export CSV.</p>}
        </div>
      </Card>

      <div className="two-col">
        <Card title={selected ? `Explain ${selected.alarmId} · ${selected.probableCause}` : "Explain panel"}>
          {!selected || !explain ? <Empty text="Select an alarm row to see the affected cell's KPI around the alarm (±2 h)." /> : (
            <>
              <p className="small-text muted">{explain.cellIds.length === 1 ? `Cell ${explain.cellIds[0]}` : `Site ${selected.siteId}, mean of ${explain.cellIds.length} cells`} · {KPI_META[explain.kpi].label} from 2 h before the alarm to 2 h after {selected.clearedAt ? "clearance" : "now"}. Dashed lines mark raise/clear; gaps mean the cell had no counters (down).</p>
              <KpiChart kpi={explain.kpi} points={explain.points} threshold={explain.threshold} height={220} markers={explain.markers} />
            </>
          )}
        </Card>
        <Card title={`Audit trail (${audit.length})`}>
          {audit.length === 0 ? <Empty text="No acknowledge / clear actions yet." /> : (
            <ul className="audit">{audit.slice(0, 25).map((e, i) => <li key={i}><span className="muted">{fmtTime(e.at)}</span> {e.action} <a href={`#/alarms?alarm=${e.alarmId}`}>{e.alarmId}</a></li>)}</ul>
          )}
        </Card>
      </div>
    </div>
  );
}
