/**
 * Capture exports → protocol statistics, parsed in the browser (nothing is uploaded).
 *
 * Supported inputs
 *  - `tshark -T json`                                    one entry per packet; the hierarchy comes from `frame.protocols`,
 *                                                        TCP retransmissions from `tcp.analysis`, conversations from the
 *                                                        innermost ip/ipv6 layer
 *  - `tshark -qz io,phs`                                 protocol hierarchy statistics (`proto  frames:N bytes:N`, indented)
 *  - `tshark -T fields -e frame.protocols -e frame.len`  tab or comma separated, optional header (`-E header=y`)
 *  - Wireshark "File → Export Packet Dissections → As CSV" (No., Time, Source, Destination, Protocol, Length, Info)
 *
 * Hierarchy model (the same as tshark's io,phs): one row per protocol node, `parent` names the encapsulating row,
 * a node's counts include everything carried inside it, and rows without a parent (roots) sum to the frame count.
 * Link-layer, padding and dissector-status tokens (`eth`, `ethertype`, `frame`, `data`, `sll`, `_ws.*`) are not rows.
 * Protocol names are unique within a capture: when the same protocol occurs at two depths (the IP packet carried
 * inside a GTP-U tunnel) the deeper one is labelled with the protocol that encloses it, e.g. `ip (in gtp)`, so that
 * `parent` references stay exact for `flattenHierarchy`, table keys and the CSV export.
 */
import { parseCsv } from "./csv";
import type { Conversation, PacketStat } from "../types/telecom";

export type CaptureKind = "tshark-json" | "tshark-phs" | "tshark-fields" | "wireshark-csv";

export interface ParsedCapture {
  kind: CaptureKind;
  /** Depth-first hierarchy rows (parents before children, siblings by packets descending). */
  stats: PacketStat[];
  /** Unordered (address pair, protocol) conversations by bytes descending; empty when the export has no addresses. */
  conversations: Conversation[];
  frames: number;
  bytes: number;
  /** TCP analysis when the export carries it (tshark JSON, Wireshark CSV); null otherwise. */
  tcp: { packets: number; retransmissions: number } | null;
  warnings: string[];
}

export interface HierarchyRow {
  stat: PacketStat;
  depth: number;
}

/** Largest capture export accepted (characters read into memory). */
export const MAX_CAPTURE_BYTES = 50 * 1024 * 1024;

export const CAPTURE_KIND_LABEL: Record<CaptureKind, string> = {
  "tshark-json": "tshark -T json",
  "tshark-phs": "tshark -z io,phs",
  "tshark-fields": "tshark -T fields",
  "wireshark-csv": "Wireshark CSV",
};

/* ------------------------------------------------------------------ helpers */

const IGNORED_TOKENS = new Set(["eth", "ethertype", "frame", "data", "sll", "sll2"]);
const isIgnored = (token: string) => IGNORED_TOKENS.has(token) || token.startsWith("_ws.");
const MALFORMED = /(^|:)_ws\.malformed(:|$)/;
const RETRANSMISSION = /retransmission/i;
/** Wireshark's Info column prefix for retransmitted segments. */
const RETRANSMISSION_INFO = /\[TCP (?:Spurious |Fast )?Retransmission\]/i;
const PHS_LINE = /^(\s*)(\S+)\s+frames:(\d+)\s+bytes:(\d+)\s*$/;
const PROTOCOL_PATH = /^[A-Za-z0-9_.+-]+(?::[A-Za-z0-9_.+-]+)+$/;
const SINGLE_TOKEN = /^[A-Za-z][A-Za-z0-9_.+-]*$/;
const TCP_ANALYSIS_NOTE = "Retransmissions are not counted: this export carries no TCP analysis. Load a `tshark -T json` or Wireshark CSV export for them.";

const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
const plural = (n: number, word: string, words = `${word}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? word : words}`;
const fmtMb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** First string of a value that tshark may emit as a string or (with --no-duplicate-keys) as an array of strings. */
function firstString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return firstString(v[0]);
  return undefined;
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (Array.isArray(v)) return toNumber(v[0]);
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : null;
}

/** Wireshark "Time" values: seconds since the capture start, or an absolute date/time; null when unparseable. */
function parseTime(v: string): number | null {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  if (Number.isFinite(n)) return n;
  const ms = Date.parse(t.replace(" ", "T"));
  return Number.isNaN(ms) ? null : ms / 1000;
}

/**
 * Protocol path of a frame (outermost first) from a `frame.protocols` value, without link-layer, padding and
 * dissector-status tokens. A frame made only of such tokens keeps its last real token so that it still counts.
 */
export function protocolPath(protocols: string): string[] {
  const raw = protocols.split(":").map((t) => t.trim()).filter((t) => t !== "");
  const path = raw.filter((t) => !isIgnored(t));
  if (path.length > 0) return path;
  const fallback = [...raw].reverse().find((t) => !t.startsWith("_ws.") && t !== "frame");
  return [fallback ?? "unknown"];
}

/* ------------------------------------------------------------------ hierarchy tree */

interface Node {
  token: string;
  parent: Node | null;
  children: Map<string, Node>;
  packets: number;
  bytes: number;
  retransmissions?: number;
}
type Level = Map<string, Node>;

function childNode(level: Level, token: string, parent: Node | null): Node {
  let node = level.get(token);
  if (!node) {
    node = { token, parent, children: new Map(), packets: 0, bytes: 0 };
    level.set(token, node);
  }
  return node;
}

/** Counts one frame at every node of `path`, creating nodes as needed; returns the chain of nodes. */
function countPath(roots: Level, path: string[], bytes: number): Node[] {
  const chain: Node[] = [];
  let level = roots;
  let parent: Node | null = null;
  for (const token of path) {
    const node = childNode(level, token, parent);
    node.packets++;
    node.bytes += bytes;
    chain.push(node);
    parent = node;
    level = node.children;
  }
  return chain;
}

function allNodes(roots: Level): Node[] {
  const out: Node[] = [];
  const walk = (level: Level): void => {
    for (const node of level.values()) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(roots);
  return out;
}

/** Ancestor tokens, nearest first. */
function ancestors(node: Node): string[] {
  const out: string[] = [];
  for (let p = node.parent; p; p = p.parent) out.push(p.token);
  return out;
}

function sumToken(roots: Level, token: string): number {
  return allNodes(roots).reduce((a, n) => (n.token === token ? a + n.packets : a), 0);
}

/**
 * Unique display names. The shallowest occurrence of a token keeps the bare name; a deeper occurrence is labelled
 * `<token> (in <X>)` where X is the nearest ancestor that differs from the bare row's ancestors at the same distance
 * (the GTP-U tunnel for the inner IP packet). Should that still collide, the full ancestor path is used.
 */
function nameNodes(roots: Level): Map<Node, string> {
  const byToken = new Map<string, Node[]>();
  for (const node of allNodes(roots)) {
    const list = byToken.get(node.token);
    if (list) list.push(node);
    else byToken.set(node.token, [node]);
  }
  const names = new Map<Node, string>();
  const used = new Set<string>();
  for (const [token, nodes] of byToken) {
    if (nodes.length === 1) {
      names.set(nodes[0], token);
      used.add(token);
      continue;
    }
    const [bare, ...deeper] = [...nodes].sort((a, b) => ancestors(a).length - ancestors(b).length);
    names.set(bare, token);
    used.add(token);
    const bareChain = ancestors(bare);
    for (const node of deeper) {
      const chain = ancestors(node);
      const i = chain.findIndex((t, k) => t !== bareChain[k]);
      let name = `${token} (in ${chain[i >= 0 ? i : chain.length - 1]})`;
      if (used.has(name)) name = `${token} (in ${[...chain].reverse().join(":")})`;
      for (let k = 2; used.has(name); k++) name = `${token} (in ${[...chain].reverse().join(":")}) #${k}`;
      names.set(node, name);
      used.add(name);
    }
  }
  return names;
}

/** Depth-first rows; siblings by packets descending, then by token. */
function toStats(roots: Level): PacketStat[] {
  const names = nameNodes(roots);
  const out: PacketStat[] = [];
  const emit = (level: Level, parent: string | undefined): void => {
    const nodes = [...level.values()].sort((a, b) => b.packets - a.packets || compare(a.token, b.token));
    for (const node of nodes) {
      const stat: PacketStat = { protocol: names.get(node) ?? node.token, packets: node.packets, bytes: node.bytes };
      if (parent !== undefined) stat.parent = parent;
      if (node.retransmissions !== undefined) stat.retransmissions = node.retransmissions;
      out.push(stat);
      emit(node.children, stat.protocol);
    }
  };
  emit(roots, undefined);
  return out;
}

/* ------------------------------------------------------------------ conversations */

interface ConversationAcc {
  addressA: string;
  addressB: string;
  protocol: string;
  packets: number;
  bytes: number;
  first: number | null;
  last: number | null;
}

/** Accumulates a packet into its conversation: unordered address pair + protocol; A/B keep the first-seen direction. */
function addConversation(map: Map<string, ConversationAcc>, src: string, dst: string, protocol: string, bytes: number, time: number | null): void {
  const [a, b] = src <= dst ? [src, dst] : [dst, src];
  const key = `${a}\u0000${b}\u0000${protocol}`;
  let c = map.get(key);
  if (!c) {
    c = { addressA: src, addressB: dst, protocol, packets: 0, bytes: 0, first: null, last: null };
    map.set(key, c);
  }
  c.packets++;
  c.bytes += bytes;
  if (time !== null) {
    c.first = c.first === null ? time : Math.min(c.first, time);
    c.last = c.last === null ? time : Math.max(c.last, time);
  }
}

function finishConversations(map: Map<string, ConversationAcc>): Conversation[] {
  return [...map.values()]
    .map((c) => ({
      addressA: c.addressA,
      addressB: c.addressB,
      protocol: c.protocol,
      packets: c.packets,
      bytes: c.bytes,
      durationS: c.first !== null && c.last !== null ? Math.round((c.last - c.first) * 1000) / 1000 : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes || b.packets - a.packets || compare(a.protocol, b.protocol));
}

/* ------------------------------------------------------------------ tshark -T json */

function mentionsRetransmission(v: unknown, depth = 0): boolean {
  if (depth > 8 || v === null || v === undefined) return false;
  if (typeof v === "string") return RETRANSMISSION.test(v);
  if (Array.isArray(v)) return v.some((x) => mentionsRetransmission(x, depth + 1));
  if (typeof v === "object") return Object.entries(v).some(([k, val]) => RETRANSMISSION.test(k) || mentionsRetransmission(val, depth + 1));
  return false;
}

/** True when a `tcp.analysis` object (or `tcp.analysis.flags` expert info) marks the segment as a retransmission. */
function isRetransmitted(tcpLayer: unknown): boolean {
  const layers = Array.isArray(tcpLayer) ? tcpLayer : [tcpLayer];
  return layers.some((layer) => mentionsRetransmission(asRecord(layer)?.["tcp.analysis"]));
}

/** The innermost of possibly repeated layers (an array with --no-duplicate-keys, otherwise the last object wins). */
function innermostLayer(layer: unknown): Record<string, unknown> | null {
  return Array.isArray(layer) ? asRecord(layer[layer.length - 1]) : asRecord(layer);
}

export function parseTsharkJson(text: string): ParsedCapture {
  let data: unknown;
  try {
    data = JSON.parse(stripBom(text));
  } catch (e) {
    throw new Error(`Not valid JSON: ${(e as Error).message}. Export packets with \`tshark -r capture.pcap -T json > capture.json\`.`);
  }
  if (!Array.isArray(data)) throw new Error("Expected a JSON array of packets (`tshark -T json`); newline-delimited `-T ek` output is not supported.");

  const roots: Level = new Map();
  const conversations = new Map<string, ConversationAcc>();
  let frames = 0;
  let bytes = 0;
  let tcpFrames = 0;
  let retransmissions = 0;
  let skipped = 0;
  let noProtocols = 0;
  let noLength = 0;
  let malformed = 0;

  for (const entry of data as unknown[]) {
    const layers = asRecord(asRecord(asRecord(entry)?._source)?.layers);
    if (!layers) {
      skipped++;
      continue;
    }
    const frame = asRecord(layers.frame) ?? {};
    const protocols = firstString(frame["frame.protocols"]) ?? "";
    if (protocols === "") noProtocols++;
    if (MALFORMED.test(protocols)) malformed++;
    const len = toNumber(frame["frame.len"]);
    if (len === null) noLength++;
    const path = protocolPath(protocols);
    const chain = countPath(roots, path, len ?? 0);
    frames++;
    bytes += len ?? 0;

    const tcpIndex = path.lastIndexOf("tcp");
    if (tcpIndex >= 0) {
      tcpFrames++;
      const retransmitted = isRetransmitted(layers.tcp);
      if (retransmitted) retransmissions++;
      const tcpNode = chain[tcpIndex];
      tcpNode.retransmissions = (tcpNode.retransmissions ?? 0) + (retransmitted ? 1 : 0);
    }

    const netToken = [...path].reverse().find((t) => t === "ip" || t === "ipv6");
    if (netToken) {
      const net = innermostLayer(layers[netToken]);
      const src = firstString(net?.[`${netToken}.src`]);
      const dst = firstString(net?.[`${netToken}.dst`]);
      if (src && dst) addConversation(conversations, src, dst, path[path.length - 1], len ?? 0, toNumber(frame["frame.time_epoch"]));
    }
  }

  if (frames === 0) {
    throw new Error(skipped > 0 ? `No packets found: ${plural(skipped, "entry", "entries")} without _source.layers.` : "No packets found in the JSON array.");
  }
  const warnings: string[] = [];
  if (skipped > 0) warnings.push(`${plural(skipped, "array entry", "array entries")} without _source.layers skipped`);
  if (noProtocols > 0) warnings.push(`${plural(noProtocols, "frame")} without frame.protocols counted as "unknown"`);
  if (noLength > 0) warnings.push(`${plural(noLength, "frame")} without a numeric frame.len counted with 0 bytes`);
  if (malformed > 0) warnings.push(`${plural(malformed, "frame")} flagged as malformed by the dissector`);
  return {
    kind: "tshark-json",
    stats: toStats(roots),
    conversations: finishConversations(conversations),
    frames,
    bytes,
    tcp: tcpFrames > 0 ? { packets: tcpFrames, retransmissions } : null,
    warnings,
  };
}

/* ------------------------------------------------------------------ tshark -qz io,phs */

interface PhsNode {
  token: string;
  indent: number;
  frames: number;
  bytes: number;
  children: PhsNode[];
}

export function parseTsharkPhs(text: string): ParsedCapture {
  const top: PhsNode[] = [];
  const stack: PhsNode[] = [];
  for (const line of stripBom(text).split(/\r?\n/)) {
    const m = PHS_LINE.exec(line);
    if (!m) continue;
    const node: PhsNode = { token: m[2], indent: m[1].length, frames: Number(m[3]), bytes: Number(m[4]), children: [] };
    while (stack.length > 0 && stack[stack.length - 1].indent >= node.indent) stack.pop();
    (stack.length > 0 ? stack[stack.length - 1].children : top).push(node);
    stack.push(node);
  }
  if (top.length === 0) throw new Error("No protocol hierarchy found: expected lines like `ip  frames:N bytes:N` from `tshark -qz io,phs`.");

  const frames = top.reduce((a, n) => a + n.frames, 0);
  const bytes = top.reduce((a, n) => a + n.bytes, 0);
  const roots: Level = new Map();
  // Ignored nodes are collapsed: their children attach to the nearest kept ancestor. Frames that end at a top-level
  // link-layer node (no kept ancestor) stay under the node's own name so that the roots still sum to `frames`.
  const place = (raw: PhsNode, parent: Node | null, level: Level): void => {
    if (isIgnored(raw.token)) {
      if (parent === null) {
        const rest = raw.frames - raw.children.reduce((a, c) => a + c.frames, 0);
        if (rest > 0) {
          const node = childNode(level, raw.token, null);
          node.packets += rest;
          node.bytes += Math.max(0, raw.bytes - raw.children.reduce((a, c) => a + c.bytes, 0));
        }
      }
      for (const child of raw.children) place(child, parent, level);
      return;
    }
    const node = childNode(level, raw.token, parent);
    node.packets += raw.frames;
    node.bytes += raw.bytes;
    for (const child of raw.children) place(child, node, node.children);
  };
  for (const raw of top) place(raw, null, roots);

  const warnings: string[] = [];
  if (sumToken(roots, "tcp") > 0) warnings.push(TCP_ANALYSIS_NOTE);
  return { kind: "tshark-phs", stats: toStats(roots), conversations: [], frames, bytes, tcp: null, warnings };
}

/* ------------------------------------------------------------------ tshark -T fields */

const unquote = (s: string) => {
  const t = s.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
};

export function parseTsharkFields(text: string): ParsedCapture {
  const lines = stripBom(text).split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) throw new Error("The file is empty.");
  const sep = lines[0].includes("\t") ? "\t" : lines[0].includes(",") ? "," : lines[0].includes(";") ? ";" : lines[0].includes("|") ? "|" : null;
  const fields = (line: string): string[] => (sep === null ? [unquote(line)] : line.split(sep).map(unquote));

  const first = fields(lines[0]);
  const lower = first.map((f) => f.toLowerCase());
  let protoCol = lower.indexOf("frame.protocols");
  let lenCol = lower.indexOf("frame.len");
  let retransCol = lower.indexOf("tcp.analysis.retransmission");
  let start = 1;
  if (protoCol < 0) {
    // No header: the protocol column holds colon-separated tokens; the length is the last integer column.
    start = 0;
    protoCol = first.findIndex((f) => PROTOCOL_PATH.test(f));
    if (protoCol < 0) protoCol = first.findIndex((f) => SINGLE_TOKEN.test(f));
    if (protoCol < 0) throw new Error("Expected a frame.protocols column (tshark -T fields -e frame.protocols -e frame.len).");
    lenCol = -1;
    for (let i = first.length - 1; i >= 0; i--) {
      if (i !== protoCol && /^\d+$/.test(first[i])) {
        lenCol = i;
        break;
      }
    }
    retransCol = -1;
  }

  const roots: Level = new Map();
  let frames = 0;
  let bytes = 0;
  let tcpFrames = 0;
  let retransmissions = 0;
  let noProtocols = 0;
  let noLength = 0;
  let malformed = 0;
  for (let i = start; i < lines.length; i++) {
    const f = fields(lines[i]);
    const protocols = f[protoCol] ?? "";
    if (protocols === "") noProtocols++;
    if (MALFORMED.test(protocols)) malformed++;
    const len = lenCol >= 0 ? toNumber(f[lenCol]) : 0;
    if (len === null) noLength++;
    const path = protocolPath(protocols);
    const chain = countPath(roots, path, len ?? 0);
    frames++;
    bytes += len ?? 0;
    const tcpIndex = path.lastIndexOf("tcp");
    if (tcpIndex >= 0) {
      tcpFrames++;
      if (retransCol >= 0) {
        const retransmitted = (f[retransCol] ?? "").trim() !== "";
        if (retransmitted) retransmissions++;
        chain[tcpIndex].retransmissions = (chain[tcpIndex].retransmissions ?? 0) + (retransmitted ? 1 : 0);
      }
    }
  }
  if (frames === 0) throw new Error("No packet rows found below the header.");

  const warnings: string[] = [];
  if (lenCol < 0) warnings.push("No frame.len column: byte counts are 0 (add `-e frame.len`).");
  if (noProtocols > 0) warnings.push(`${plural(noProtocols, "row")} without frame.protocols counted as "unknown"`);
  if (noLength > 0) warnings.push(`${plural(noLength, "row")} without a numeric frame.len counted with 0 bytes`);
  if (malformed > 0) warnings.push(`${plural(malformed, "frame")} flagged as malformed by the dissector`);
  if (tcpFrames > 0 && retransCol < 0) warnings.push(TCP_ANALYSIS_NOTE);
  return {
    kind: "tshark-fields",
    stats: toStats(roots),
    conversations: [],
    frames,
    bytes,
    tcp: retransCol >= 0 && tcpFrames > 0 ? { packets: tcpFrames, retransmissions } : null,
    warnings,
  };
}

/* ------------------------------------------------------------------ Wireshark CSV */

export function parseWiresharkCsv(text: string): ParsedCapture {
  const { header, rows, issues } = parseCsv(text);
  if (header.length === 0 || rows.length === 0) throw new Error("CSV has no data rows.");
  const col = (name: string) => header.findIndex((h) => h.replace(/^"|"$/g, "").trim().toLowerCase() === name);
  const pi = col("protocol");
  const li = col("length");
  if (pi < 0 || li < 0) throw new Error("CSV needs 'Protocol' and 'Length' columns (Wireshark default export).");
  const si = col("source");
  const di = col("destination");
  const ti = col("time");
  const ii = col("info");

  const acc = new Map<string, PacketStat>();
  const conversations = new Map<string, ConversationAcc>();
  let frames = 0;
  let bytes = 0;
  let tcpRows = 0;
  let retransmissions = 0;
  let noLength = 0;
  let badTime = 0;
  for (const r of rows) {
    const protocol = r[pi].trim() || "unknown";
    const len = toNumber(r[li]);
    if (len === null) noLength++;
    let stat = acc.get(protocol);
    if (!stat) {
      stat = { protocol, packets: 0, bytes: 0 };
      acc.set(protocol, stat);
    }
    stat.packets++;
    stat.bytes += len ?? 0;
    frames++;
    bytes += len ?? 0;
    if (protocol.toUpperCase() === "TCP") tcpRows++;
    if (ii >= 0 && RETRANSMISSION_INFO.test(r[ii])) {
      retransmissions++;
      stat.retransmissions = (stat.retransmissions ?? 0) + 1;
    }
    if (si >= 0 && di >= 0) {
      const src = r[si].trim();
      const dst = r[di].trim();
      let time: number | null = null;
      if (ti >= 0) {
        time = parseTime(r[ti]);
        if (time === null && r[ti].trim() !== "") badTime++;
      }
      if (src && dst) addConversation(conversations, src, dst, protocol, len ?? 0, time);
    }
  }
  const tcpStat = [...acc.values()].find((s) => s.protocol.toUpperCase() === "TCP");
  if (tcpStat && tcpStat.retransmissions === undefined) tcpStat.retransmissions = 0;

  const warnings = issues.slice(0, 5);
  if (issues.length > 5) warnings.push(`${issues.length - 5} more CSV issues not listed`);
  if (noLength > 0) warnings.push(`${plural(noLength, "row")} without a numeric Length counted with 0 bytes`);
  if (badTime > 0) warnings.push(`${plural(badTime, "Time value")} could not be parsed; conversation durations may be incomplete`);
  if (si < 0 || di < 0) warnings.push("No Source/Destination columns: conversations are not available.");
  return {
    kind: "wireshark-csv",
    stats: [...acc.values()].sort((a, b) => b.packets - a.packets || compare(a.protocol, b.protocol)),
    conversations: finishConversations(conversations),
    frames,
    bytes,
    tcp: tcpRows > 0 || retransmissions > 0 ? { packets: tcpRows, retransmissions } : null,
    warnings,
  };
}

/* ------------------------------------------------------------------ dispatch */

/**
 * Format detection from the content (first 64 kB), then from the file extension. Throws a readable error when
 * nothing matches.
 */
export function sniffCaptureKind(filename: string, text: string): CaptureKind {
  const head = stripBom(text).slice(0, 65536);
  const trimmed = head.trimStart();
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? "";
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return "tshark-json";
  if (/(^|[\t,;|"])frame\.protocols(["\t,;|]|$)/i.test(firstLine)) return "tshark-fields";
  if ((/protocol/i.test(firstLine) && /length/i.test(firstLine)) || /^"?No\.?"?,"?Time"?/i.test(firstLine)) return "wireshark-csv";
  if (/^\s*\S+\s+frames:\d+\s+bytes:\d+\s*$/m.test(head)) return "tshark-phs";
  if (/^[A-Za-z0-9_.+-]+(?::[A-Za-z0-9_.+-]+)+(?:[\t,;|]|$)/.test(firstLine)) return "tshark-fields";
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  if (ext === "json") return "tshark-json";
  if (ext === "csv") return "wireshark-csv";
  if (ext === "tsv") return "tshark-fields";
  if (ext === "txt") return head.includes("frames:") ? "tshark-phs" : "tshark-fields";
  throw new Error(
    `${filename}: unrecognised capture export. Supported: tshark -T json, tshark -qz io,phs, tshark -T fields -e frame.protocols -e frame.len, or a Wireshark CSV export (File → Export Packet Dissections → As CSV).`,
  );
}

/** Throws when a file is larger than MAX_CAPTURE_BYTES (checked before reading and again on the text). */
export function assertCaptureSize(filename: string, bytes: number): void {
  if (bytes > MAX_CAPTURE_BYTES) {
    throw new Error(
      `${filename} is ${fmtMb(bytes)}; the limit is ${MAX_CAPTURE_BYTES / (1024 * 1024)} MB. Export a filtered or shorter capture (tshark -Y "<filter>" / -c <count>) or only the hierarchy (tshark -qz io,phs).`,
    );
  }
}

export function parseCapture(filename: string, text: string): ParsedCapture {
  assertCaptureSize(filename, text.length);
  switch (sniffCaptureKind(filename, text)) {
    case "tshark-json":
      return parseTsharkJson(text);
    case "tshark-phs":
      return parseTsharkPhs(text);
    case "tshark-fields":
      return parseTsharkFields(text);
    case "wireshark-csv":
      return parseWiresharkCsv(text);
  }
}

/* ------------------------------------------------------------------ hierarchy order */

/** Index of the row a `parent` reference points to: the exact name first, then the first word ("GTP-U" for "GTP-U (user plane …)"). */
function resolveParent(stats: PacketStat[], parent: string, self: number): number {
  const exact = stats.findIndex((s, k) => k !== self && s.protocol === parent);
  if (exact >= 0) return exact;
  return stats.findIndex((s, k) => k !== self && s.protocol.split(" ")[0] === parent);
}

/**
 * Depth-first order with depths: roots in input order, each followed by its children (input order). Rows whose
 * parent is unknown follow as top-level rows; rows only reachable through a cycle are appended last. No row is dropped.
 */
export function buildHierarchy(stats: PacketStat[]): HierarchyRow[] {
  const children = new Map<number, number[]>();
  const roots: number[] = [];
  const orphans: number[] = [];
  stats.forEach((s, i) => {
    if (!s.parent) {
      roots.push(i);
      return;
    }
    const p = resolveParent(stats, s.parent, i);
    if (p < 0) {
      orphans.push(i);
      return;
    }
    const list = children.get(p);
    if (list) list.push(i);
    else children.set(p, [i]);
  });
  const out: HierarchyRow[] = [];
  const seen = new Set<number>();
  const visit = (i: number, depth: number): void => {
    if (seen.has(i)) return;
    seen.add(i);
    out.push({ stat: stats[i], depth });
    for (const c of children.get(i) ?? []) visit(c, depth + 1);
  };
  for (const i of roots) visit(i, 0);
  for (const i of orphans) visit(i, 0);
  for (let i = 0; i < stats.length; i++) visit(i, 0);
  return out;
}

/** Depth-first parent → children order (see buildHierarchy); roots sum to the frame count. */
export function flattenHierarchy(stats: PacketStat[]): PacketStat[] {
  return buildHierarchy(stats).map((r) => r.stat);
}

/** Splits one CSV line on unquoted commas, unescaping doubled quotes (kept for callers of the first release). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (ch === "," && !q) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
