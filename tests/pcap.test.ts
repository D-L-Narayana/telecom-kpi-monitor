import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_CAPTURE_BYTES,
  assertCaptureSize,
  buildHierarchy,
  flattenHierarchy,
  parseCapture,
  parseTsharkFields,
  parseTsharkJson,
  parseTsharkPhs,
  parseWiresharkCsv,
  protocolPath,
  sniffCaptureKind,
  splitCsvLine,
  type ParsedCapture,
} from "../src/lib/pcap";
import { generateDataset } from "../src/lib/synthetic";
import type { PacketStat } from "../src/types/telecom";

// vitest runs from the repository root; jsdom rewrites import.meta.url, so resolve fixtures from the cwd.
const fixture = (name: string) => readFileSync(resolve(process.cwd(), "tests/fixtures/pcap", name), "utf8");
const row = (c: ParsedCapture, protocol: string): PacketStat | undefined => c.stats.find((s) => s.protocol === protocol);
const names = (c: ParsedCapture) => c.stats.map((s) => s.protocol);
const roots = (c: ParsedCapture) => c.stats.filter((s) => !s.parent);
const rootFrames = (c: ParsedCapture) => roots(c).reduce((a, s) => a + s.packets, 0);

describe("capture parsers", () => {
  it("parses a Wireshark CSV export", () => {
    const csv = '"No.","Time","Source","Destination","Protocol","Length","Info"\n"1","0","10.0.0.1","10.0.0.2","TCP","74","x"\n"2","0.1","10.0.0.2","10.0.0.1","TCP","66","y"\n"3","0.2","10.0.0.1","8.8.8.8","DNS","80","q"';
    const s = parseWiresharkCsv(csv);
    expect(s.kind).toBe("wireshark-csv");
    expect(s.stats[0]).toMatchObject({ protocol: "TCP", packets: 2, bytes: 140 });
    expect(s.stats[1]).toMatchObject({ protocol: "DNS", packets: 1, bytes: 80 });
    expect(s.frames).toBe(3);
    expect(s.bytes).toBe(220);
  });

  it("parses tshark JSON", () => {
    const j = JSON.stringify([{ _source: { layers: { frame: { "frame.protocols": "eth:ethertype:ip:udp:gtp:ip:tcp", "frame.len": "120" } } } }]);
    const parsed = parseTsharkJson(j);
    expect(parsed.kind).toBe("tshark-json");
    // the hierarchy starts at the outermost network protocol; link-layer tokens are not rows
    expect(parsed.stats[0]).toMatchObject({ protocol: "ip", packets: 1, bytes: 120 });
    expect(parsed.stats[0].parent).toBeUndefined();
    // the tunnelled TCP segment is the leaf; its parent is the IP packet carried inside GTP-U
    expect(row(parsed, "tcp")).toMatchObject({ protocol: "tcp", parent: "ip (in gtp)", packets: 1, bytes: 120 });
    expect(names(parsed)).toEqual(["ip", "udp", "gtp", "ip (in gtp)", "tcp"]);
    expect(parsed.frames).toBe(1);
    expect(parsed.bytes).toBe(120);
  });
});

describe("protocolPath", () => {
  it("drops link-layer, padding and dissector-status tokens but keeps a frame countable", () => {
    expect(protocolPath("eth:ethertype:ip:udp:gtp:ip:tcp:data")).toEqual(["ip", "udp", "gtp", "ip", "tcp"]);
    expect(protocolPath("eth:ethertype:arp")).toEqual(["arp"]);
    expect(protocolPath("eth:ethertype:ip:udp:gtp:_ws.malformed")).toEqual(["ip", "udp", "gtp"]);
    expect(protocolPath("eth")).toEqual(["eth"]);
    expect(protocolPath("")).toEqual(["unknown"]);
  });
});

describe("parseTsharkJson (tests/fixtures/pcap/tshark.json)", () => {
  const c = parseTsharkJson(fixture("tshark.json"));

  it("builds the protocol hierarchy with parent links and no data/_ws rows", () => {
    expect(names(c)).toEqual(["ip", "udp", "gtp", "ip (in gtp)", "tcp (in gtp)", "udp (in gtp)", "dns", "sctp", "s1ap", "tcp", "arp"]);
    expect(row(c, "udp")).toMatchObject({ parent: "ip", packets: 5, bytes: 2308 });
    expect(row(c, "gtp")).toMatchObject({ parent: "udp", packets: 5, bytes: 2308 });
    expect(row(c, "ip (in gtp)")).toMatchObject({ parent: "gtp", packets: 4, bytes: 2218 });
    expect(row(c, "dns")).toMatchObject({ parent: "udp (in gtp)", packets: 1, bytes: 98 });
    expect(row(c, "s1ap")).toMatchObject({ parent: "sctp", packets: 1, bytes: 180 });
    expect(row(c, "sctp")).toMatchObject({ parent: "ip", packets: 1, bytes: 180 });
    expect(names(c)).not.toContain("data");
    expect(names(c).some((n) => n.startsWith("_ws") || n === "eth" || n === "ethertype")).toBe(false);
  });

  it("counts the frame with a trailing data token on its TCP leaf and the retransmission on that row", () => {
    expect(row(c, "tcp (in gtp)")).toMatchObject({ parent: "ip (in gtp)", packets: 3, bytes: 2120, retransmissions: 1 });
    expect(row(c, "tcp")).toMatchObject({ parent: "ip", packets: 1, bytes: 74, retransmissions: 0 });
    expect(c.tcp).toEqual({ packets: 4, retransmissions: 1 });
  });

  it("totals: roots sum to the frame count and bytes add up", () => {
    expect(c.frames).toBe(8);
    expect(c.bytes).toBe(2622);
    expect(roots(c).map((s) => s.protocol)).toEqual(["ip", "arp"]);
    expect(rootFrames(c)).toBe(8);
    expect(roots(c).reduce((a, s) => a + s.bytes, 0)).toBe(2622);
  });

  it("reports malformed frames as a warning", () => {
    expect(c.warnings).toHaveLength(1);
    expect(c.warnings[0]).toMatch(/1 frame.*malformed/i);
  });

  it("derives conversations from the innermost IP layer", () => {
    expect(c.conversations[0]).toMatchObject({ addressA: "100.64.12.7", addressB: "93.184.216.34", protocol: "tcp", packets: 3, bytes: 2120 });
    expect(c.conversations[0].durationS).toBeCloseTo(0.278, 3);
    expect(c.conversations).toHaveLength(5);
    expect(c.conversations.map((x) => x.bytes)).toEqual([2120, 180, 98, 90, 74]);
  });

  it("rejects input that is not a tshark JSON array", () => {
    expect(() => parseTsharkJson("{not json")).toThrow(/not valid json/i);
    expect(() => parseTsharkJson('{"_source":{}}')).toThrow(/json array/i);
    expect(() => parseTsharkJson("[]")).toThrow(/no packets/i);
  });
});

describe("parseTsharkPhs (tests/fixtures/pcap/phs.txt)", () => {
  const c = parseTsharkPhs(fixture("phs.txt"));

  it("reads the frame and byte totals from the top of the tree", () => {
    expect(c.kind).toBe("tshark-phs");
    expect(c.frames).toBe(12);
    expect(c.bytes).toBe(3246);
    expect(roots(c).map((s) => s.protocol)).toEqual(["ip", "arp"]);
    expect(rootFrames(c)).toBe(12);
  });

  it("keeps the nesting and collapses eth/ethertype/data", () => {
    expect(names(c)).toEqual(["ip", "udp", "gtp", "ip (in gtp)", "tcp (in gtp)", "udp (in gtp)", "dns (in gtp)", "dns", "sctp", "s1ap", "tcp", "arp"]);
    expect(row(c, "ip")).toMatchObject({ packets: 11, bytes: 3186 });
    expect(row(c, "tcp (in gtp)")).toMatchObject({ parent: "ip (in gtp)", packets: 4, bytes: 2194 });
    expect(row(c, "dns (in gtp)")).toMatchObject({ parent: "udp (in gtp)", packets: 2, bytes: 124 });
    expect(row(c, "dns")).toMatchObject({ parent: "udp", packets: 1, bytes: 98 });
    expect(row(c, "s1ap")).toMatchObject({ parent: "sctp", packets: 3, bytes: 540 });
    expect(row(c, "tcp")).toMatchObject({ parent: "ip", packets: 1, bytes: 230 });
    expect(row(c, "tcp (in gtp)")?.retransmissions).toBeUndefined();
  });

  it("has no TCP analysis and says so", () => {
    expect(c.tcp).toBeNull();
    expect(c.conversations).toEqual([]);
    expect(c.warnings.join(" ")).toMatch(/retransmission/i);
  });

  it("rejects text without hierarchy lines", () => {
    expect(() => parseTsharkPhs("Protocol Hierarchy Statistics\nFilter:\n")).toThrow(/frames:N bytes:N/);
  });
});

describe("parseTsharkFields", () => {
  it("parses the tab-separated export with a header (tests/fixtures/pcap/fields.tsv)", () => {
    const c = parseTsharkFields(fixture("fields.tsv"));
    expect(c.kind).toBe("tshark-fields");
    expect(c.frames).toBe(8);
    expect(c.bytes).toBe(2622);
    expect(names(c)).toEqual(["ip", "udp", "gtp", "ip (in gtp)", "tcp (in gtp)", "udp (in gtp)", "dns", "sctp", "s1ap", "tcp", "arp"]);
    expect(row(c, "tcp (in gtp)")).toMatchObject({ parent: "ip (in gtp)", packets: 3, bytes: 2120 });
    expect(row(c, "tcp (in gtp)")?.retransmissions).toBeUndefined();
    expect(c.tcp).toBeNull();
    expect(c.warnings.join(" ")).toMatch(/retransmission/i);
    expect(rootFrames(c)).toBe(8);
  });

  it("parses comma-separated rows without a header", () => {
    const c = parseTsharkFields("eth:ethertype:ip:udp:dns,98\neth:ethertype:ip:sctp:s1ap,180\n");
    expect(c.frames).toBe(2);
    expect(c.bytes).toBe(278);
    expect(names(c)).toEqual(["ip", "sctp", "s1ap", "udp", "dns"]);
    expect(row(c, "dns")).toMatchObject({ parent: "udp", packets: 1, bytes: 98 });
    expect(c.warnings).toEqual([]);
  });

  it("counts frames with zero bytes and warns when frame.len is missing", () => {
    const c = parseTsharkFields("frame.protocols\neth:ethertype:ip:tcp\neth:ethertype:arp\n");
    expect(c.frames).toBe(2);
    expect(c.bytes).toBe(0);
    expect(c.warnings.join(" ")).toMatch(/frame\.len/);
  });

  it("rejects text without a protocol column", () => {
    expect(() => parseTsharkFields("hello world\n")).toThrow(/frame\.protocols/);
  });
});

describe("parseWiresharkCsv (tests/fixtures/pcap/wireshark.csv)", () => {
  const c = parseWiresharkCsv(fixture("wireshark.csv"));

  it("keeps a quoted multi-line Info field inside one record", () => {
    expect(c.frames).toBe(8);
    expect(c.bytes).toBe(2368);
    expect(names(c)).toEqual(["TCP", "DNS", "SIP/SDP", "TLSv1.3"]);
    expect(row(c, "SIP/SDP")).toMatchObject({ packets: 1, bytes: 812 });
    expect(c.warnings).toEqual([]);
  });

  it("counts TCP retransmissions from the Info column", () => {
    expect(row(c, "TCP")).toMatchObject({ packets: 4, bytes: 797, retransmissions: 1 });
    expect(c.tcp).toEqual({ packets: 4, retransmissions: 1 });
  });

  it("merges both directions into one conversation and measures its duration", () => {
    const tcp = c.conversations.find((x) => x.protocol === "TCP");
    expect(tcp).toMatchObject({ addressA: "10.40.1.10", addressB: "172.16.0.5", packets: 4, bytes: 797 });
    expect(tcp?.durationS).toBeCloseTo(0.48, 6);
    const dns = c.conversations.find((x) => x.protocol === "DNS");
    expect(dns).toMatchObject({ addressA: "10.40.1.10", addressB: "8.8.8.8", packets: 2, bytes: 176 });
    expect(dns?.durationS).toBeCloseTo(0.02, 6);
    expect(c.conversations).toHaveLength(4);
    expect(c.conversations.map((x) => x.bytes)).toEqual([812, 797, 583, 176]);
  });

  it("rejects exports without data or without the Protocol/Length columns", () => {
    expect(() => parseWiresharkCsv('"No.","Time","Source","Destination","Protocol","Length","Info"\n')).toThrow(/no data rows/i);
    expect(() => parseWiresharkCsv("a,b\n1,2\n")).toThrow(/Protocol.*Length/);
  });

  it("works without Source/Destination columns and notes the missing conversations", () => {
    const c2 = parseWiresharkCsv("Protocol,Length\nTCP,100\nTCP,50\n");
    expect(c2.stats[0]).toMatchObject({ protocol: "TCP", packets: 2, bytes: 150 });
    expect(c2.conversations).toEqual([]);
    expect(c2.warnings.join(" ")).toMatch(/Source.*Destination/);
  });
});

describe("sniffCaptureKind", () => {
  it("recognises the format from the content, whatever the file name", () => {
    expect(sniffCaptureKind("export.txt", fixture("tshark.json"))).toBe("tshark-json");
    expect(sniffCaptureKind("export.csv", fixture("phs.txt"))).toBe("tshark-phs");
    expect(sniffCaptureKind("export.json", fixture("fields.tsv"))).toBe("tshark-fields");
    expect(sniffCaptureKind("export.txt", fixture("wireshark.csv"))).toBe("wireshark-csv");
    expect(sniffCaptureKind("x", "eth:ethertype:ip:tcp\t74\n")).toBe("tshark-fields");
    expect(sniffCaptureKind("x", '"No.","Time","Source"\n')).toBe("wireshark-csv");
    expect(sniffCaptureKind("x", " \n{\"_source\":{}}")).toBe("tshark-json");
  });

  it("falls back to the file extension and otherwise refuses", () => {
    expect(sniffCaptureKind("a.csv", "")).toBe("wireshark-csv");
    expect(sniffCaptureKind("a.json", "")).toBe("tshark-json");
    expect(sniffCaptureKind("a.tsv", "")).toBe("tshark-fields");
    expect(() => sniffCaptureKind("notes.md", "hello world")).toThrow(/unrecognised capture export/i);
  });
});

describe("parseCapture", () => {
  it("dispatches to the parser for the sniffed kind", () => {
    expect(parseCapture("tshark.json", fixture("tshark.json"))).toEqual(parseTsharkJson(fixture("tshark.json")));
    expect(parseCapture("phs.txt", fixture("phs.txt")).kind).toBe("tshark-phs");
    expect(parseCapture("fields.tsv", fixture("fields.tsv")).kind).toBe("tshark-fields");
    expect(parseCapture("wireshark.csv", fixture("wireshark.csv")).kind).toBe("wireshark-csv");
    expect(() => parseCapture("a.csv", "")).toThrow(/no data rows/i);
  });

  it("refuses captures above MAX_CAPTURE_BYTES with a readable message", () => {
    expect(MAX_CAPTURE_BYTES).toBe(50 * 1024 * 1024);
    expect(() => assertCaptureSize("big.json", MAX_CAPTURE_BYTES + 1)).toThrow(/big\.json .*limit is 50 MB/);
    expect(() => assertCaptureSize("ok.json", MAX_CAPTURE_BYTES)).not.toThrow();
    expect(() => parseCapture("big.json", `[${" ".repeat(MAX_CAPTURE_BYTES)}`)).toThrow(/limit is 50 MB/);
  });
});

describe("flattenHierarchy / buildHierarchy", () => {
  const scrambled: PacketStat[] = [
    { protocol: "DNS", parent: "UDP", packets: 21_400, bytes: 1 },
    { protocol: "S1AP (LTE)", parent: "SCTP", packets: 61_200, bytes: 1 },
    { protocol: "ICMP", packets: 3_900, bytes: 1 },
    { protocol: "UDP", parent: "GTP-U", packets: 261_300, bytes: 1 },
    { protocol: "TCP", parent: "GTP-U", packets: 540_200, bytes: 1, retransmissions: 4_322 },
    { protocol: "SCTP (control plane)", packets: 96_300, bytes: 1 },
    { protocol: "RTP (VoLTE media)", parent: "UDP", packets: 148_600, bytes: 1 },
    { protocol: "GTP-U (user plane, S1-U / N3)", packets: 812_400, bytes: 1 },
    { protocol: "ghost", parent: "nowhere", packets: 1, bytes: 1 },
  ];

  it("orders rows depth-first, parents before children, resolving short parent names; unknown parents go last", () => {
    expect(flattenHierarchy(scrambled).map((s) => s.protocol)).toEqual([
      "ICMP", "SCTP (control plane)", "S1AP (LTE)", "GTP-U (user plane, S1-U / N3)", "UDP", "DNS", "RTP (VoLTE media)", "TCP", "ghost",
    ]);
    expect(buildHierarchy(scrambled).map((r) => r.depth)).toEqual([0, 0, 1, 0, 1, 2, 2, 1, 0]);
  });

  it("keeps the synthetic hierarchy intact: every child follows its parent and roots sum to the frame count", () => {
    const stats = generateDataset().packetStats;
    const flat = flattenHierarchy(stats);
    expect(flat).toHaveLength(stats.length);
    expect(flat[0].protocol).toBe("GTP-U (user plane, S1-U / N3)");
    const index = new Map(flat.map((s, i) => [s.protocol, i]));
    for (const s of flat) {
      if (!s.parent) continue;
      const parentIndex = [...index.entries()].find(([name]) => name === s.parent || name.split(" ")[0] === s.parent)?.[1];
      expect(parentIndex).toBeDefined();
      expect(parentIndex!).toBeLessThan(index.get(s.protocol)!);
    }
    expect(flat.filter((s) => !s.parent).reduce((a, s) => a + s.packets, 0)).toBe(912_600);
  });
});

describe("splitCsvLine", () => {
  it("splits on unquoted commas and unescapes doubled quotes", () => {
    expect(splitCsvLine('a,"b,c","d ""e"" f",,g')).toEqual(["a", "b,c", 'd "e" f', "", "g"]);
  });
});
