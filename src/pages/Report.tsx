import { useId, useMemo, useState } from "react";
import { href, useApp, type Page } from "../state";
import { DETECTION_KPI, RANGE_MS, filterTech, fmt, inWindow } from "../lib/kpi";
import { MAX_ALARM_LINES, REPORT_NOTES_KEY, buildShiftReport, fmtDelta, fmtKpiValue, reportFilename, reportToCsvSections, reportToMarkdown, type ShiftReport } from "../lib/report";
import { downloadText } from "../lib/csv";
import { Card, Empty, LevelBadge, Notice, SeverityBadge, fmtTime, type NoticeKind } from "../components/ui";
import type { Alarm, Severity } from "../types/telecom";

const SEVERITIES: Severity[] = ["Critical", "Major", "Minor", "Warning"];
const MARKDOWN_MIME = "text/markdown;charset=utf-8";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function readNotes(): string {
  try {
    return localStorage.getItem(REPORT_NOTES_KEY) ?? "";
  } catch {
    return ""; // storage unavailable (privacy mode, policy): start with empty notes
  }
}

function writeNotes(text: string): void {
  try {
    if (text === "") localStorage.removeItem(REPORT_NOTES_KEY);
    else localStorage.setItem(REPORT_NOTES_KEY, text);
  } catch { /* storage unavailable or full: the notes still live in the page state and the report */ }
}

interface TimeFormat { tz: string; tzLabel: string }

/** One of the two alarm lists of the report: at most MAX_ALARM_LINES rows, like the Markdown; the CSV export holds all rows. */
function AlarmTable({ list, cleared, link, time }: { list: Alarm[]; cleared: boolean; link: (a: Alarm) => string; time: TimeFormat }) {
  if (list.length === 0) return <Empty text={cleared ? "No alarms cleared in this window." : "No alarms raised in this window."} />;
  const shown = list.slice(0, MAX_ALARM_LINES);
  return (
    <>
      <div className="table-wrap">
        <table className="table" aria-label={cleared ? "Alarms cleared in window" : "Alarms raised in window"}>
          <thead>
            <tr><th>Alarm</th><th>Severity</th><th>Site</th><th>Cell</th><th>Cause</th><th>Raised</th><th>{cleared ? "Cleared" : "State"}</th></tr>
          </thead>
          <tbody>
            {shown.map((a) => (
              <tr key={a.alarmId}>
                <td><a href={link(a)}>{a.alarmId}</a></td>
                <td><SeverityBadge s={a.severity} /></td>
                <td>{a.siteId}</td>
                <td>{a.cellId ?? "–"}</td>
                <td>{a.probableCause}</td>
                <td>{fmtTime(a.timestamp, true, time.tz)} {time.tzLabel}</td>
                <td>{cleared ? (a.clearedAt ? `${fmtTime(a.clearedAt, true, time.tz)} ${time.tzLabel}` : "–") : a.state}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length > shown.length && <p className="muted small-text">… and {list.length - shown.length} more; the CSV export holds the full list.</p>}
    </>
  );
}

/** Shift handover report: KPIs, detections, worst cells and alarms for the current window, as a preview, Markdown, CSV or printout. */
export function Report() {
  const { data, cells, now, range, tech, thresholds, alarms, source } = useApp();
  const rangeMs = RANGE_MS[range];
  const samples = useMemo(() => filterTech(inWindow(data.samples, now, rangeMs), cells, tech), [data, cells, now, rangeMs, tech]);
  const prevSamples = useMemo(() => filterTech(inWindow(data.samples, now - rangeMs, rangeMs), cells, tech), [data, cells, now, rangeMs, tech]);
  const [notes, setNotes] = useState<string>(readNotes);
  const [message, setMessage] = useState<{ kind: NoticeKind; text: string } | null>(null);
  const notesId = useId();

  // The analysis part of the report does not depend on the notes, so typing never re-runs detection and aggregation.
  const analysis = useMemo(
    () => buildShiftReport({ now, range, tech, samples, prevSamples, cells, sites: data.sites, alarms, thresholds, source: { kind: source.kind, label: source.label } }),
    [now, range, tech, samples, prevSamples, cells, data.sites, alarms, thresholds, source.kind, source.label],
  );
  const report = useMemo<ShiftReport>(() => ({ ...analysis, notes }), [analysis, notes]);
  const markdown = useMemo(() => reportToMarkdown(report), [report]);

  const time: TimeFormat = { tz: source.timeZone, tzLabel: source.timeZone === "Asia/Kolkata" ? "IST" : source.timeZone };
  const at = (iso: string) => `${fmtTime(iso, true, time.tz)} ${time.tzLabel}`;
  /** Page link that keeps the global range / technology filters. */
  const link = (page: Page, params: Record<string, string | undefined> = {}) => href(page, { ...params, range, tech });
  const hasSamples = samples.length > 0;
  const { window: w, alarms: al } = report;

  const updateNotes = (text: string) => {
    setNotes(text);
    writeNotes(text);
  };
  const downloadMarkdown = () => downloadText(reportFilename(report, "md"), markdown, MARKDOWN_MIME);
  const downloadCsvSections = () => {
    for (const s of reportToCsvSections(report)) downloadText(reportFilename(report, "csv", s.name), s.csv);
  };
  const copyMarkdown = async () => {
    const clipboard: Clipboard | undefined = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== "function") {
      setMessage({ kind: "warning", text: "Clipboard access is unavailable in this browser; use Download Markdown instead." });
      return;
    }
    try {
      await clipboard.writeText(markdown);
      setMessage({ kind: "success", text: "Markdown copied to the clipboard." });
    } catch {
      setMessage({ kind: "warning", text: "Copying to the clipboard was refused; use Download Markdown instead." });
    }
  };

  const noteLines = notes.split(/\r?\n/).filter((line) => line.trim() !== "");

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Shift handover report</h1>
          <p className="muted">window {range} ending {at(w.end)} · {tech === "All" ? "all technologies" : tech} · {samples.length.toLocaleString()} KPI samples · {plural(report.detections.length, "detection")} · {plural(al.raisedInWindow.length, "alarm")} raised</p>
        </div>
      </div>

      <Card
        title="Handover notes"
        className="no-print"
        actions={<button type="button" className="btn small" onClick={() => updateNotes("")} disabled={notes === ""}>Clear notes</button>}
      >
        <label htmlFor={notesId} className="visually-hidden">Handover notes</label>
        <textarea id={notesId} value={notes} onChange={(e) => updateNotes(e.target.value)} rows={4} placeholder="Open issues, actions taken, follow-ups for the next shift…" />
        <p className="muted small-text">Notes are kept in this browser only and appear in the Notes section of the report, the Markdown and the printout.</p>
      </Card>

      <div className="no-print">
        <div className="toolbar" role="group" aria-label="Report actions">
          <button type="button" className="btn primary" onClick={downloadMarkdown}>Download Markdown</button>
          <button type="button" className="btn" onClick={downloadCsvSections}>Download CSV sections</button>
          <button type="button" className="btn" onClick={() => { void copyMarkdown(); }}>Copy Markdown</button>
          <button type="button" className="btn" onClick={() => window.print()}>Print</button>
        </div>
        {message && <Notice kind={message.kind}>{message.text}</Notice>}
        <p className="muted small-text">The CSV export saves five files (KPIs, detections, worst cells, alarms raised, alarms cleared); the browser may ask once to allow multiple downloads. Times in the files are ISO 8601 (UTC); the preview shows {time.tzLabel}.</p>
      </div>

      {!hasSamples && (
        <Notice kind="warning">
          No KPI samples in this window ({at(w.start)} → {at(w.end)}{tech === "All" ? "" : `, ${tech} only`}). The report lists alarms only; widen the time range, change the technology filter or load a dataset that covers it.
        </Notice>
      )}

      <article className="report-preview report-rich" aria-label="Report preview">
        <Card title="Window">
          <div className="table-wrap">
            <table className="table" aria-label="Report window">
              <tbody>
                <tr><th scope="row">Start</th><td>{at(w.start)} · {w.start}</td></tr>
                <tr><th scope="row">End</th><td>{at(w.end)} · {w.end}</td></tr>
                <tr><th scope="row">Range</th><td>{w.range}</td></tr>
                <tr><th scope="row">Technology</th><td>{w.tech}</td></tr>
                <tr><th scope="row">Source</th><td>{report.source.label} ({report.source.kind})</td></tr>
                <tr><th scope="row">Samples</th><td>{samples.length.toLocaleString()} in the window · {prevSamples.length.toLocaleString()} in the previous window</td></tr>
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="KPIs">
          <div className="table-wrap">
            <table className="table" aria-label="Network KPIs">
              <thead>
                <tr><th>KPI</th><th className="num">Value</th><th className="num">Previous</th><th className="num">Δ %</th><th>Status</th></tr>
              </thead>
              <tbody>
                {report.kpis.map((k) => (
                  <tr key={k.kpi}>
                    <th scope="row">{k.label}</th>
                    <td className="num">{fmtKpiValue(k.value, k.kpi)}</td>
                    <td className="num">{fmtKpiValue(k.previous, k.kpi)}</td>
                    <td className="num">{fmtDelta(k.deltaPct)}</td>
                    <td><LevelBadge level={k.level} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small-text">Network values are user-weighted over the window (throughput: plain mean); Δ compares with the window of the same length before it and is omitted when that window is too sparse.</p>
        </Card>

        <Card title="Detections">
          {report.detections.length === 0 ? <Empty text="No rule-based detections in this window." /> : (
            <ul className="detect-list">
              {report.detections.map((d) => (
                <li key={d.kind + d.cellId}>
                  <span className={`badge kind-${d.kind}`}>{d.kind}</span>
                  <a href={link("kpis", { cell: d.cellId, kpi: DETECTION_KPI[d.kind] })}>{d.cellId}</a>
                  <span className="muted small-text">{d.siteId} · {d.technology} · {plural(d.intervals, "interval")} · {d.detail} · {fmtTime(d.firstSeen, true, time.tz)} → {fmtTime(d.lastSeen, true, time.tz)} {time.tzLabel}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Worst cells">
          {report.worstCells.length === 0 ? <Empty text="No cells reported samples in this window." /> : (
            <div className="table-wrap">
              <table className="table" aria-label="Worst cells by call drop rate">
                <thead>
                  <tr><th className="num">#</th><th>Cell</th><th>Site</th><th>Tech</th><th>Status</th><th className="num">CDR %</th><th className="num">RRC %</th><th className="num">HO %</th><th className="num">DL Mbps</th><th className="num">UL Mbps</th><th className="num">Latency ms</th><th className="num">PRB %</th><th className="num">Breaches</th><th className="num">Down intervals</th></tr>
                </thead>
                <tbody>
                  {report.worstCells.map((c, i) => (
                    <tr key={c.cellId}>
                      <td className="num">{i + 1}</td>
                      <td><a href={link("kpis", { cell: c.cellId })}>{c.cellId}</a></td>
                      <td><a href={link("sites", { site: c.siteId })}>{c.siteId}</a></td>
                      <td>{c.technology}</td>
                      <td><LevelBadge level={c.worstLevel} /></td>
                      <td className="num">{fmt(c.values.callDropRatePct, 2)}</td>
                      <td className="num">{fmt(c.values.rrcSetupSuccessPct, 2)}</td>
                      <td className="num">{fmt(c.values.handoverSuccessPct, 2)}</td>
                      <td className="num">{fmt(c.values.dlThroughputMbps, 1)}</td>
                      <td className="num">{fmt(c.values.ulThroughputMbps, 1)}</td>
                      <td className="num">{fmt(c.values.latencyMs, 1)}</td>
                      <td className="num">{fmt(c.values.prbUtilizationPct, 1)}</td>
                      <td className="num">{c.breaches}</td>
                      <td className="num">{c.downIntervals}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small-text">Ranked by mean call drop rate over the window (cells without counters first), then by the number of breached KPI thresholds.</p>
        </Card>

        <Card title="Alarms">
          <div className="table-wrap">
            <table className="table" aria-label="Alarm counts">
              <thead>
                <tr><th>Alarms</th><th className="num">Count</th></tr>
              </thead>
              <tbody>
                <tr><th scope="row">Active</th><td className="num">{al.active}</td></tr>
                <tr><th scope="row">Acknowledged</th><td className="num">{al.acknowledged}</td></tr>
                {SEVERITIES.map((s) => (
                  <tr key={s}><th scope="row">Unresolved <SeverityBadge s={s} /></th><td className="num">{al.bySeverity[s]}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>Raised in window ({al.raisedInWindow.length})</h3>
          <AlarmTable list={al.raisedInWindow} cleared={false} link={(a) => link("alarms", { alarm: a.alarmId })} time={time} />
          <h3>Cleared in window ({al.clearedInWindow.length})</h3>
          <AlarmTable list={al.clearedInWindow} cleared link={(a) => link("alarms", { alarm: a.alarmId })} time={time} />
        </Card>

        <Card title="Notes">
          {noteLines.length === 0 ? <p className="muted">(none)</p> : noteLines.map((line, i) => <p key={i}>{line}</p>)}
        </Card>
      </article>

      <p className="print-only muted small-text">Generated {at(report.generatedAt)} · {w.range} window · {w.tech === "All" ? "all technologies" : w.tech} · {report.source.label}</p>
    </div>
  );
}
