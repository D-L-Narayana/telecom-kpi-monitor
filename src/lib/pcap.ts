/** Parse user-supplied capture exports into protocol statistics.
 *  - tshark -T json  (array of packets with _source.layers.frame["frame.protocols"] and frame["frame.len"])
 *  - Wireshark "Export Packet Dissections > As CSV" (columns No.,Time,Source,Destination,Protocol,Length,Info)
 */
import type { PacketStat } from "../types/telecom";

export function parseTsharkJson(text: string): PacketStat[] {
  const arr = JSON.parse(text) as unknown;
  if (!Array.isArray(arr)) throw new Error("Expected a JSON array from `tshark -T json`.");
  const acc = new Map<string, PacketStat>();
  for (const pkt of arr as Array<{ _source?: { layers?: Record<string, Record<string, string>> } }>) {
    const frame = pkt?._source?.layers?.frame ?? {};
    const protos = (frame["frame.protocols"] ?? "unknown").split(":");
    const proto = protos[protos.length - 1] || "unknown";
    const len = Number(frame["frame.len"] ?? 0);
    const tcp = pkt?._source?.layers?.tcp as Record<string, unknown> | undefined;
    const analysis = tcp?.["tcp.analysis"] as Record<string, unknown> | undefined;
    const retrans = analysis && ("tcp.analysis.retransmission" in analysis || "tcp.analysis.flags" in analysis && JSON.stringify(analysis).includes("retransmission")) ? 1 : 0;
    const row = acc.get(proto) ?? { protocol: proto, packets: 0, bytes: 0, retransmissions: 0 };
    row.packets++;
    row.bytes += len;
    row.retransmissions = (row.retransmissions ?? 0) + retrans;
    acc.set(proto, row);
  }
  return [...acc.values()].sort((a, b) => b.packets - a.packets);
}

export function parseWiresharkCsv(text: string): PacketStat[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error("CSV has no data rows.");
  const header = splitCsvLine(lines[0]).map((h) => h.replace(/^"|"$/g, "").trim().toLowerCase());
  const pi = header.indexOf("protocol");
  const li = header.indexOf("length");
  if (pi < 0 || li < 0) throw new Error("CSV needs 'Protocol' and 'Length' columns (Wireshark default export).");
  const acc = new Map<string, PacketStat>();
  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line);
    const proto = (cols[pi] ?? "unknown").replace(/^"|"$/g, "") || "unknown";
    const len = Number((cols[li] ?? "0").replace(/^"|"$/g, "")) || 0;
    const row = acc.get(proto) ?? { protocol: proto, packets: 0, bytes: 0 };
    row.packets++;
    row.bytes += len;
    acc.set(proto, row);
  }
  return [...acc.values()].sort((a, b) => b.packets - a.packets);
}

export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
    } else if (ch === "," && !q) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseCapture(filename: string, text: string): PacketStat[] {
  return filename.toLowerCase().endsWith(".json") || text.trim().startsWith("[") ? parseTsharkJson(text) : parseWiresharkCsv(text);
}
