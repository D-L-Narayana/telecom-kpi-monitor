import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useApp } from "../state";
import { parseCapture } from "../lib/pcap";
import { toCsv, downloadText } from "../lib/csv";
import { Card } from "../components/ui";
import type { PacketStat } from "../types/telecom";

const fmtBytes = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e3).toFixed(0)} kB`);

export function Packets() {
  const { data } = useApp();
  const [custom, setCustom] = useState<{ name: string; stats: PacketStat[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stats = custom?.stats ?? data.packetStats;
  const top = stats.filter((s) => !s.parent);
  const totalPk = top.reduce((a, s) => a + s.packets, 0);
  const totalBytes = top.reduce((a, s) => a + s.bytes, 0);
  const chart = useMemo(() => stats.map((s) => ({ name: s.protocol.split(" ")[0], bytesMB: +(s.bytes / 1e6).toFixed(1), packets: s.packets })), [stats]);
  const retrans = stats.reduce((a, s) => a + (s.retransmissions ?? 0), 0);
  const tcpPk = stats.filter((s) => /tcp/i.test(s.protocol)).reduce((a, s) => a + s.packets, 0);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try { setCustom({ name: f.name, stats: parseCapture(f.name, await f.text()) }); setError(null); } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="page">
      <div className="page-head"><div><h1>Packet statistics</h1><p className="muted">Protocol hierarchy and conversations for the synthetic S1-U / N3 capture, or load your own <code>tshark -T json</code> / Wireshark CSV export (parsed in the browser, nothing is uploaded).</p></div></div>

      <div className="tiles">
        <div className="tile"><span className="tile-label">Frames</span><span className="tile-value">{totalPk.toLocaleString()}</span></div>
        <div className="tile"><span className="tile-label">Bytes</span><span className="tile-value">{fmtBytes(totalBytes)}</span></div>
        <div className="tile"><span className="tile-label">TCP retransmissions</span><span className="tile-value">{retrans.toLocaleString()} <small>({tcpPk ? ((retrans / tcpPk) * 100).toFixed(2) : "0.00"}% of TCP)</small></span></div>
        {!custom && <div className="tile"><span className="tile-label">User-plane RTT (avg / p95)</span><span className="tile-value">{data.tcpSummary.rttAvgMs} / {data.tcpSummary.rttP95Ms} ms</span></div>}
      </div>

      <div className="two-col">
        <Card title={`Protocol hierarchy${custom ? ` · ${custom.name}` : ""}`} actions={<>
          <label className="btn small file">Load capture export<input type="file" accept=".json,.csv" onChange={(e) => onFile(e.target.files?.[0])} /></label>
          {custom && <button className="btn small" onClick={() => setCustom(null)}>Back to synthetic</button>}
          <button className="btn small" onClick={() => downloadText("protocol_hierarchy.csv", toCsv(stats as unknown as Record<string, unknown>[]))}>CSV</button>
        </>}>
          {error && <p className="error">{error}</p>}
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Protocol</th><th className="num">Packets</th><th className="num">% frames</th><th className="num">Bytes</th><th className="num">Avg size B</th><th className="num">Retrans.</th></tr></thead>
              <tbody>{stats.map((s) => (
                <tr key={s.protocol}><td className={s.parent ? "indent" : ""}>{s.parent ? "↳ " : ""}{s.protocol}</td><td className="num">{s.packets.toLocaleString()}</td><td className="num">{((s.packets / totalPk) * 100).toFixed(1)}</td><td className="num">{fmtBytes(s.bytes)}</td><td className="num">{s.packets ? Math.round(s.bytes / s.packets) : 0}</td><td className="num">{s.retransmissions?.toLocaleString() ?? "–"}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </Card>
        <Card title="Bytes by protocol (MB)">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chart} layout="vertical" margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
              <CartesianGrid stroke="#e6e4de" horizontal={false} />
              <XAxis type="number" fontSize={11} />
              <YAxis type="category" dataKey="name" width={70} fontSize={11} />
              <Tooltip contentStyle={{ fontSize: 12 }} />
              <Bar dataKey="bytesMB" fill="#20808D" isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {!custom && (
        <Card title="Top conversations (by bytes)">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Address A</th><th>Address B</th><th>Protocol</th><th className="num">Packets</th><th className="num">Bytes</th><th className="num">Duration s</th><th className="num">Avg rate kbps</th></tr></thead>
              <tbody>{data.conversations.map((c, i) => (
                <tr key={i}><td>{c.addressA}</td><td>{c.addressB}</td><td>{c.protocol}</td><td className="num">{c.packets.toLocaleString()}</td><td className="num">{fmtBytes(c.bytes)}</td><td className="num">{c.durationS}</td><td className="num">{((c.bytes * 8) / c.durationS / 1000).toFixed(0)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
