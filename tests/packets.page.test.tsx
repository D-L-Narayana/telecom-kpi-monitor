import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProvider, useApp, type AppState } from "../src/state";
import { Packets } from "../src/pages/Packets";
import { MAX_CAPTURE_BYTES } from "../src/lib/pcap";
import { downloadText } from "../src/lib/csv";
import type { Dataset } from "../src/lib/synthetic";

vi.mock("../src/lib/csv", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/csv")>();
  return { ...original, downloadText: vi.fn() };
});
const download = vi.mocked(downloadText);

// vitest runs from the repository root; jsdom rewrites import.meta.url, so resolve fixtures from the cwd.
const fixtureFile = (name: string, type: string) => new File([readFileSync(resolve(process.cwd(), "tests/fixtures/pcap", name), "utf8")], name, { type });

const emptyDataset: Dataset = {
  sites: [], cells: [], samples: [], alarms: [], packetStats: [], conversations: [], incidents: [],
  tcpSummary: { packets: 0, retransmissions: 0, retransmissionPct: 0, rttAvgMs: 0, rttP95Ms: 0 },
};

function Harness({ onApp }: { onApp: (s: AppState) => void }) {
  onApp(useApp());
  return <Packets />;
}

function mount() {
  window.location.hash = "#/packets";
  const holder: { current: AppState | null } = { current: null };
  render(
    <AppProvider>
      <Harness onApp={(s) => { holder.current = s; }} />
    </AppProvider>,
  );
  return {
    user: userEvent.setup(),
    app: () => {
      if (!holder.current) throw new Error("provider did not render");
      return holder.current;
    },
  };
}

const hierarchyTable = () => screen.queryByRole("table", { name: "Protocol hierarchy" });
const conversationsTable = () => screen.queryByRole("table", { name: "Top conversations" });
const loadInput = () => screen.getByLabelText(/load capture export/i);
const bodyRows = (table: HTMLElement) => within(table).getAllByRole("row").slice(1);
const cells = (row: HTMLElement) => within(row).getAllByRole("cell").map((c) => c.textContent ?? "");
const rowNamed = (table: HTMLElement, first: string) => bodyRows(table).find((r) => cells(r)[0] === first);
/** The tile whose label is `label` (table headers such as "Bytes" also exist, so match the label element itself). */
const tileValue = (label: string) => {
  const el = screen.getAllByText(label).find((e) => e.classList.contains("tile-label"));
  if (!el || !el.parentElement) throw new Error(`no tile labelled "${label}"`);
  return el.parentElement;
};

afterEach(() => {
  download.mockClear();
});

describe("Packets page (synthetic dataset)", () => {
  it("renders the synthetic hierarchy as an indented tree with tiles and conversations", () => {
    mount();
    expect(screen.getByRole("heading", { level: 1, name: "Packet statistics" })).toBeInTheDocument();
    const table = hierarchyTable();
    expect(table).not.toBeNull();
    const rows = bodyRows(table!);
    expect(rows).toHaveLength(10);
    expect(cells(rows[0])[0]).toBe("GTP-U (user plane, S1-U / N3)");
    expect(cells(rows[0])[2]).toBe("89.0"); // 812,400 of 912,600 root frames
    const tcp = rowNamed(table!, "↳ TCP");
    expect(tcp).toBeDefined();
    expect(within(tcp!).getAllByRole("cell")[0]).toHaveClass("indent");
    expect(cells(tcp!)[5]).toBe("4,322");
    // RTP sits two levels down (GTP-U → UDP → RTP) and is indented further than UDP
    const udp = rowNamed(table!, "↳ UDP");
    const rtp = rowNamed(table!, "↳ RTP (VoLTE media)");
    expect(udp).toBeDefined();
    expect(rtp).toBeDefined();
    const indent = (r: HTMLElement) => parseInt(within(r).getAllByRole("cell")[0].style.paddingLeft || "0", 10);
    expect(indent(rtp!)).toBeGreaterThan(indent(udp!));
    expect(tileValue("Frames")).toHaveTextContent("912,600");
    expect(tileValue("TCP retransmissions")).toHaveTextContent(/4,322 \(0\.80% of 540,200 TCP\)/);
    expect(tileValue("User-plane RTT (avg / p95)")).toHaveTextContent("38.4 / 92.1 ms");
    const conv = conversationsTable();
    expect(conv).not.toBeNull();
    expect(bodyRows(conv!)).toHaveLength(20);
    expect(screen.queryByRole("button", { name: /back to synthetic|remove capture/i })).toBeNull();
  });

  it("exports the hierarchy with explicit columns including parent and retransmissions", async () => {
    const { user } = mount();
    await user.click(screen.getByRole("button", { name: "Hierarchy CSV" }));
    expect(download).toHaveBeenCalledTimes(1);
    const [filename, text] = download.mock.calls[0];
    expect(filename).toBe("protocol_hierarchy.csv");
    const lines = text.split("\r\n");
    expect(lines[0]).toBe("protocol,parent,packets,bytes,retransmissions");
    expect(lines[1]).toBe('"GTP-U (user plane, S1-U / N3)",,812400,633672000,');
    expect(lines[2]).toBe("TCP,GTP-U,540200,480778000,4322");
    expect(lines).toHaveLength(11);
  });
});

describe("Packets page (loading capture exports)", () => {
  it("loads a tshark JSON export, shows the file name, the nested rows and the TCP analysis", async () => {
    const { user } = mount();
    await user.upload(loadInput(), fixtureFile("tshark.json", "application/json"));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Protocol hierarchy · tshark.json" })).not.toBeNull());
    expect(screen.getByText(/^tshark -T json · 8 frames/)).toBeInTheDocument();
    const table = hierarchyTable()!;
    const rows = bodyRows(table);
    expect(rows).toHaveLength(11);
    expect(cells(rows[0])).toEqual(["ip", "7", "87.5", "2.6 kB", "366", "–"]);
    expect(within(rows[0]).getAllByRole("cell")[0]).not.toHaveClass("indent");
    const tcp = rowNamed(table, "↳ tcp (in gtp)");
    expect(tcp).toBeDefined();
    expect(within(tcp!).getAllByRole("cell")[0]).toHaveClass("indent");
    expect(cells(tcp!)).toEqual(["↳ tcp (in gtp)", "3", "37.5", "2.1 kB", "707", "1"]);
    expect(rowNamed(table, "↳ data")).toBeUndefined();
    expect(tileValue("Frames")).toHaveTextContent("8");
    expect(tileValue("Bytes")).toHaveTextContent("2.6 kB");
    expect(tileValue("TCP retransmissions")).toHaveTextContent(/^TCP retransmissions1 \(25\.00% of 4 TCP\)$/);
    expect(screen.queryByText("User-plane RTT (avg / p95)")).toBeNull();
    const warnings = screen.getByRole("status");
    expect(warnings).toHaveTextContent(/1 frame flagged as malformed/);
    // conversations come from the innermost IP layer
    const conv = conversationsTable();
    expect(conv).not.toBeNull();
    expect(cells(bodyRows(conv!)[0]).slice(0, 4)).toEqual(["100.64.12.7", "93.184.216.34", "tcp", "3"]);
    await user.click(screen.getByRole("button", { name: "Back to synthetic" }));
    expect(rowNamed(hierarchyTable()!, "GTP-U (user plane, S1-U / N3)")).toBeDefined();
    expect(screen.queryByRole("heading", { name: /tshark\.json/ })).toBeNull();
  });

  it("accepts a dropped tshark -z io,phs text file and hides the TCP tile when the export has no TCP analysis", async () => {
    mount();
    const zone = screen.queryByRole("group", { name: /drop a capture export/i });
    expect(zone).not.toBeNull();
    fireEvent.drop(zone!, { dataTransfer: { files: [fixtureFile("phs.txt", "text/plain")], types: ["Files"] } });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Protocol hierarchy · phs.txt" })).not.toBeNull());
    const table = hierarchyTable()!;
    expect(tileValue("Frames")).toHaveTextContent(/^Frames12$/);
    const s1ap = rowNamed(table, "↳ s1ap");
    expect(s1ap).toBeDefined();
    expect(cells(s1ap!).slice(0, 3)).toEqual(["↳ s1ap", "3", "25.0"]);
    expect(screen.queryByText("TCP retransmissions")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(/Retransmissions are not counted/);
    expect(conversationsTable()).toBeNull();
    expect(screen.getByText(/Conversations need Source\/Destination addresses/)).toBeInTheDocument();
  });

  it("refuses oversized and unreadable files with an alert and keeps the current data", async () => {
    const { user } = mount();
    const huge = new File(["[]"], "huge.json", { type: "application/json" });
    Object.defineProperty(huge, "size", { value: MAX_CAPTURE_BYTES + 1 });
    await user.upload(loadInput(), huge);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("huge.json is 50.0 MB; the limit is 50 MB.");
    expect(rowNamed(hierarchyTable()!, "GTP-U (user plane, S1-U / N3)")).toBeDefined();
    await user.upload(loadInput(), new File(["{oops"], "broken.json", { type: "application/json" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Not valid JSON/));
  });
});

describe("Packets page (imported dataset without packet statistics)", () => {
  it("renders an empty state with the load call to action and still analyses a Wireshark CSV", async () => {
    const { user, app } = mount();
    act(() => app().loadDataset(emptyDataset, "empty.csv"));
    expect(screen.getByRole("heading", { level: 1, name: "Packet statistics" })).toBeInTheDocument();
    expect(screen.queryByText("This dataset has no packet statistics.")).not.toBeNull();
    expect(screen.queryByLabelText(/load capture export/i)).not.toBeNull();
    expect(hierarchyTable()).toBeNull();
    expect(screen.queryByText("Frames")).toBeNull();

    await user.upload(loadInput(), fixtureFile("wireshark.csv", "text/csv"));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Protocol hierarchy · wireshark.csv" })).not.toBeNull());
    const table = hierarchyTable()!;
    expect(bodyRows(table).map((r) => cells(r)[0])).toEqual(["TCP", "DNS", "SIP/SDP", "TLSv1.3"]);
    expect(tileValue("Frames")).toHaveTextContent(/^Frames8$/);
    expect(tileValue("TCP retransmissions")).toHaveTextContent(/1 \(25\.00% of 4 TCP\)/);
    const conv = conversationsTable();
    expect(conv).not.toBeNull();
    const convRows = bodyRows(conv!);
    expect(convRows).toHaveLength(4);
    const tcp = convRows.find((r) => cells(r)[2] === "TCP");
    expect(tcp).toBeDefined();
    expect(cells(tcp!)).toEqual(["10.40.1.10", "172.16.0.5", "TCP", "4", "797 B", "0.48", "13"]);
    const sip = convRows.find((r) => cells(r)[2] === "SIP/SDP");
    expect(cells(sip!)[6]).toBe("–"); // a single packet has no duration, hence no rate
    await user.click(screen.getByRole("button", { name: "Remove capture" }));
    expect(screen.queryByText("This dataset has no packet statistics.")).not.toBeNull();
  });
});
