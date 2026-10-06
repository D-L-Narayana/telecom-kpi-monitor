import { useCallback, useMemo, useState, type ChangeEvent, type DragEvent } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useApp } from "../state";
import { CAPTURE_KIND_LABEL, MAX_CAPTURE_BYTES, assertCaptureSize, buildHierarchy, parseCapture, type HierarchyRow, type ParsedCapture } from "../lib/pcap";
import { toCsv, downloadText } from "../lib/csv";
import { Card, Empty, Notice } from "../components/ui";
import type { Dataset } from "../lib/synthetic";
import type { Conversation, PacketStat } from "../types/telecom";

/** Explicit export columns, so rows without a parent or without a retransmission count keep every column. */
const HIERARCHY_COLUMNS = ["protocol", "parent", "packets", "bytes", "retransmissions"];
const CONVERSATION_COLUMNS = ["addressA", "addressB", "protocol", "packets", "bytes", "durationS"];
const ACCEPT = ".json,.csv,.txt,.tsv,application/json,text/csv,text/plain,text/tab-separated-values";
const CHART_ROWS = 12;
const CONVERSATION_ROWS = 100;
const MAX_MB = MAX_CAPTURE_BYTES / (1024 * 1024);

const fmtInt = (n: number) => n.toLocaleString("en-US");
const fmtBytes = (b: number) =>
  b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${(b / 1e3).toFixed(1)} kB` : `${fmtInt(b)} B`;
const pct = (part: number, whole: number, digits: number) => (whole > 0 ? (part / whole) * 100 : 0).toFixed(digits);
/** Axis label: "GTP-U" for "GTP-U (user plane, S1-U / N3)"; the "(in gtp)" qualifier of nested rows is kept. */
const chartLabel = (protocol: string) => protocol.replace(/ \((?!in )[^)]*\)$/, "");
const baseName = (file: string) => file.replace(/\.[^.]+$/, "") || "capture";

interface LoadedCapture {
  name: string;
  capture: ParsedCapture;
}

/** What the page shows: either the synthetic capture of the dataset or a capture export loaded by the analyst. */
interface CaptureView {
  title: string;
  subtitle: string | null;
  stats: PacketStat[];
  conversations: Conversation[];
  frames: number;
  bytes: number;
  tcp: { packets: number; retransmissions: number } | null;
  rtt: { avgMs: number; p95Ms: number } | null;
  warnings: string[];
}

function viewOf(custom: LoadedCapture | null, data: Dataset): CaptureView {
  if (custom) {
    const c = custom.capture;
    return {
      title: `Protocol hierarchy · ${custom.name}`,
      subtitle: `${CAPTURE_KIND_LABEL[c.kind]} · ${fmtInt(c.frames)} ${c.frames === 1 ? "frame" : "frames"} · ${fmtBytes(c.bytes)}`,
      stats: c.stats,
      conversations: c.conversations,
      frames: c.frames,
      bytes: c.bytes,
      tcp: c.tcp,
      rtt: null,
      warnings: c.warnings,
    };
  }
  const roots = data.packetStats.filter((s) => !s.parent);
  const t = data.tcpSummary;
  return {
    title: "Protocol hierarchy",
    subtitle: null,
    stats: data.packetStats,
    conversations: data.conversations,
    frames: roots.reduce((a, s) => a + s.packets, 0),
    bytes: roots.reduce((a, s) => a + s.bytes, 0),
    tcp: t.packets > 0 ? { packets: t.packets, retransmissions: t.retransmissions } : null,
    rtt: t.rttAvgMs > 0 ? { avgMs: t.rttAvgMs, p95Ms: t.rttP95Ms } : null,
    warnings: [],
  };
}

function hierarchyCsv(rows: HierarchyRow[]): string {
  return toCsv(
    rows.map(({ stat }) => ({ protocol: stat.protocol, parent: stat.parent ?? "", packets: stat.packets, bytes: stat.bytes, retransmissions: stat.retransmissions ?? "" })),
    HIERARCHY_COLUMNS,
  );
}

export function Packets() {
  const { data, source } = useApp();
  const [custom, setCustom] = useState<LoadedCapture | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const { view, rows, chart, unit } = useMemo(() => {
    const v = viewOf(custom, data);
    const largest = [...v.stats].sort((a, b) => b.bytes - a.bytes).slice(0, CHART_ROWS);
    const mb = (largest[0]?.bytes ?? 0) >= 1e6;
    return {
      view: v,
      rows: buildHierarchy(v.stats),
      unit: mb ? "MB" : "kB",
      chart: largest.map((s) => ({ name: chartLabel(s.protocol), value: mb ? +(s.bytes / 1e6).toFixed(1) : +(s.bytes / 1e3).toFixed(2), packets: s.packets })),
    };
  }, [custom, data]);

  const loadFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    try {
      assertCaptureSize(file.name, file.size);
      const capture = parseCapture(file.name, await file.text());
      setCustom({ name: file.name, capture });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  const onInput = (e: ChangeEvent<HTMLInputElement>) => {
    void loadFile(e.target.files?.[0]);
    e.target.value = ""; // allow re-selecting the same file
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    void loadFile(e.dataTransfer?.files?.[0]);
  };
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!dragging) setDragging(true);
  };
  const clearCapture = () => {
    setCustom(null);
    setError(null);
  };
  const exportHierarchy = () => downloadText(custom ? `${baseName(custom.name)}_protocol_hierarchy.csv` : "protocol_hierarchy.csv", hierarchyCsv(rows));
  const exportConversations = () =>
    downloadText(custom ? `${baseName(custom.name)}_conversations.csv` : "conversations.csv", toCsv(view.conversations as unknown as Record<string, unknown>[], CONVERSATION_COLUMNS));

  const hasStats = custom !== null || data.packetStats.length > 0;
  const dropProps = {
    className: "drop-target",
    role: "group",
    "aria-label": "Protocol hierarchy. Drop a capture export here to analyse it.",
    "data-active": dragging || undefined,
    onDragOver,
    onDragLeave: () => setDragging(false),
    onDrop,
  };
  const loadControl = (
    <label className="btn small file">
      Load capture export
      <input type="file" accept={ACCEPT} onChange={onInput} />
    </label>
  );
  const formats = (
    <>
      <code>tshark -T json</code>, <code>tshark -z io,phs</code>, <code>tshark -T fields -e frame.protocols -e frame.len</code> or Wireshark CSV
    </>
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Packet statistics</h1>
          <p className="muted">
            Protocol hierarchy, TCP retransmissions and conversations for the synthetic S1-U / N3 capture, or for your own {formats} export (parsed in the browser, nothing is uploaded; up to {MAX_MB} MB per file).
          </p>
        </div>
      </div>

      {hasStats && (
        <div className="tiles">
          <div className="tile"><span className="tile-label">Frames</span><span className="tile-value">{fmtInt(view.frames)}</span></div>
          <div className="tile"><span className="tile-label">Bytes</span><span className="tile-value">{fmtBytes(view.bytes)}</span></div>
          {view.tcp && (
            <div className="tile">
              <span className="tile-label">TCP retransmissions</span>
              <span className="tile-value">{fmtInt(view.tcp.retransmissions)} <small>({pct(view.tcp.retransmissions, view.tcp.packets, 2)}% of {fmtInt(view.tcp.packets)} TCP)</small></span>
            </div>
          )}
          {view.rtt && (
            <div className="tile"><span className="tile-label">User-plane RTT (avg / p95)</span><span className="tile-value">{view.rtt.avgMs} / {view.rtt.p95Ms} ms</span></div>
          )}
        </div>
      )}

      {!hasStats ? (
        <div {...dropProps}>
          <Card title="Protocol hierarchy" actions={loadControl}>
            {error && <Notice kind="error">{error}</Notice>}
            <Empty text="This dataset has no packet statistics." />
            <p className="drop-zone" data-active={dragging || undefined}>
              Drop a {formats} export here, or use Load capture export, to analyse its protocol hierarchy alongside this dataset.
            </p>
          </Card>
        </div>
      ) : (
        <div className="two-col">
          <div {...dropProps}>
            <Card
              title={view.title}
              actions={
                <>
                  {loadControl}
                  {custom && <button type="button" className="btn small" onClick={clearCapture}>{source.kind === "synthetic" ? "Back to synthetic" : "Remove capture"}</button>}
                  <button type="button" className="btn small" onClick={exportHierarchy}>Hierarchy CSV</button>
                </>
              }
            >
              {view.subtitle && <p className="muted small-text">{view.subtitle}</p>}
              {error && <Notice kind="error">{error}</Notice>}
              {view.warnings.length > 0 && (
                <Notice kind="warning">
                  <ul className="issue-list">{view.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
                </Notice>
              )}
              <div className="table-wrap">
                <table className="table" aria-label="Protocol hierarchy">
                  <thead>
                    <tr><th>Protocol</th><th className="num">Packets</th><th className="num">% frames</th><th className="num">Bytes</th><th className="num">Avg size B</th><th className="num">Retrans.</th></tr>
                  </thead>
                  <tbody>
                    {rows.map(({ stat: s, depth }, i) => (
                      <tr key={`${i}:${s.protocol}`}>
                        <td className={depth > 0 ? "indent" : undefined} style={depth > 0 ? { paddingLeft: 8 + 14 * depth } : undefined}>{depth > 0 ? "↳ " : ""}{s.protocol}</td>
                        <td className="num">{fmtInt(s.packets)}</td>
                        <td className="num">{pct(s.packets, view.frames, 1)}</td>
                        <td className="num">{fmtBytes(s.bytes)}</td>
                        <td className="num">{s.packets > 0 ? fmtInt(Math.round(s.bytes / s.packets)) : "–"}</td>
                        <td className="num">{s.retransmissions === undefined ? "–" : fmtInt(s.retransmissions)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted small-text">
                Rows without a parent add up to the frame count; a row's packets and bytes include everything carried inside it. Drop another export on this card to replace it.
              </p>
            </Card>
          </div>
          <Card title={`Bytes by protocol (${unit})`}>
            <figure className="chart-figure">
              <ResponsiveContainer width="100%" height={Math.max(220, 40 + 24 * chart.length)}>
                <BarChart data={chart} layout="vertical" margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
                  <CartesianGrid stroke="var(--chart-grid)" horizontal={false} />
                  <XAxis type="number" fontSize={11} />
                  <YAxis type="category" dataKey="name" width={96} fontSize={11} />
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                  <Bar dataKey="value" name={`Bytes (${unit})`} fill="var(--chart-series-1)" isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
              <figcaption className="muted small-text">
                {view.stats.length > CHART_ROWS ? `Largest ${CHART_ROWS} of ${view.stats.length} rows; ` : ""}the hierarchy table lists the exact values.
              </figcaption>
            </figure>
          </Card>
        </div>
      )}

      {hasStats && (
        <Card
          title="Top conversations (by bytes)"
          actions={view.conversations.length > 0 ? <button type="button" className="btn small" onClick={exportConversations}>Conversations CSV</button> : undefined}
        >
          {view.conversations.length === 0 ? (
            <Empty text="Conversations need Source/Destination addresses: load a Wireshark CSV export or a tshark -T json export with IP layers." />
          ) : (
            <div className="table-wrap">
              <table className="table" aria-label="Top conversations">
                <thead>
                  <tr><th>Address A</th><th>Address B</th><th>Protocol</th><th className="num">Packets</th><th className="num">Bytes</th><th className="num">Duration s</th><th className="num">Avg rate kbps</th></tr>
                </thead>
                <tbody>
                  {view.conversations.slice(0, CONVERSATION_ROWS).map((c, i) => (
                    <tr key={`${i}:${c.addressA}:${c.addressB}:${c.protocol}`}>
                      <td>{c.addressA}</td>
                      <td>{c.addressB}</td>
                      <td>{c.protocol}</td>
                      <td className="num">{fmtInt(c.packets)}</td>
                      <td className="num">{fmtBytes(c.bytes)}</td>
                      <td className="num">{c.durationS}</td>
                      <td className="num">{c.durationS > 0 ? fmtInt(Math.round((c.bytes * 8) / c.durationS / 1000)) : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {view.conversations.length > CONVERSATION_ROWS && <p className="muted small-text">Largest {CONVERSATION_ROWS} of {fmtInt(view.conversations.length)} conversations.</p>}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
