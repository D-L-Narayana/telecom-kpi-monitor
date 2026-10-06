import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppProvider, useApp, type AppState } from "../src/state";
import { Sites } from "../src/pages/Sites";
import { downloadText } from "../src/lib/csv";
import { RANGE_MS, aggregateByCell, inWindow, type CellAggregate } from "../src/lib/kpi";
import { DEFAULT_THRESHOLDS } from "../src/lib/thresholds";
import { DATASET_END, generateDataset, type Dataset } from "../src/lib/synthetic";
import type { KpiSample } from "../src/types/telecom";

vi.mock("../src/lib/csv", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/csv")>();
  return { ...mod, downloadText: vi.fn() };
});
const download = vi.mocked(downloadText);

/* ---------- harness: real provider + Sites page, with access to the context for loadDataset ---------- */

function Harness({ onApp }: { onApp: (s: AppState) => void }) {
  onApp(useApp());
  return <Sites />;
}

function mount(hash: string) {
  window.location.hash = hash;
  const holder: { current: AppState | null } = { current: null };
  const utils = render(
    <AppProvider>
      <Harness onApp={(s) => { holder.current = s; }} />
    </AppProvider>,
  );
  return {
    ...utils,
    app: () => {
      if (!holder.current) throw new Error("provider did not render");
      return holder.current;
    },
  };
}

const regionTiles = () => screen.getAllByRole("link").filter((l) => l.classList.contains("region-tile"));
const siteTable = () => screen.getByRole("heading", { name: /^Sites \(\d+\)/ }).closest("section")!.querySelector("table")!;
const dataRows = () => within(siteTable()).getAllByRole("row").slice(1);
const cellsOf = (row: HTMLElement) => within(row).getAllByRole("cell").map((c) => c.textContent ?? "");
const siteOfRow = (row: HTMLElement) => cellsOf(row)[0];
const circles = () => Array.from(document.querySelectorAll("svg.site-map circle"));
const hasLevelBorder = (el: HTMLElement) => Array.from(el.classList).some((c) => /^lvl-border-(ok|warning|critical)$/.test(c));

/** Worst cell per the page contract: level (critical > warning > ok), then breaches, then call drop rate, all descending. */
function worstCellOf(siteId: string, rangeKey: keyof typeof RANGE_MS): string {
  const data = generateDataset();
  const cells = new Map(data.cells.map((c) => [c.cellId, c]));
  const rank = { ok: 0, warning: 1, critical: 2 } as const;
  const rows = aggregateByCell(inWindow(data.samples, DATASET_END, RANGE_MS[rangeKey]), cells, DEFAULT_THRESHOLDS).filter((c) => c.siteId === siteId);
  const byWorst = (a: CellAggregate, b: CellAggregate) =>
    rank[b.worstLevel] - rank[a.worstLevel] || b.breaches - a.breaches || (b.values.callDropRatePct ?? -1) - (a.values.callDropRatePct ?? -1) || (a.cellId < b.cellId ? -1 : 1);
  return [...rows].sort(byWorst)[0].cellId;
}

/* ---------- hand-made import fixtures ---------- */

const T0 = Date.UTC(2026, 0, 10, 0, 0, 0);
const STEP = 15 * 60e3;
function sample(cellId: string, i: number, patch: Partial<KpiSample> = {}): KpiSample {
  return {
    cellId, timestamp: new Date(T0 + i * STEP).toISOString(),
    callDropRatePct: 0.5, rrcSetupSuccessPct: 99.1, handoverSuccessPct: 98.2, dlThroughputMbps: 30, ulThroughputMbps: 8,
    latencyMs: 25, prbUtilizationPct: 40, rsrpAvgDbm: -95, sinrAvgDb: 12, activeUsers: 50, ...patch,
  };
}
const noPackets: Pick<Dataset, "packetStats" | "conversations" | "incidents" | "tcpSummary"> = {
  packetStats: [], conversations: [], incidents: [], tcpSummary: { packets: 0, retransmissions: 0, retransmissionPct: 0, rttAvgMs: 0, rttP95Ms: 0 },
};
const emptyDataset: Dataset = { sites: [], cells: [], samples: [], alarms: [], ...noPackets };
/** Two imported sites: one with coordinates, one inferred without them (lat/lon NaN, as `inferSites` produces). */
const partialGeoDataset: Dataset = {
  sites: [
    { siteId: "SITE-1", name: "Mapped site", lat: 17.7, lon: 83.2, region: "Imported region" },
    { siteId: "SITE-2", name: "SITE-2", lat: Number.NaN, lon: Number.NaN, region: "Imported region" },
  ],
  cells: [
    { cellId: "SITE-1-L1", siteId: "SITE-1", technology: "LTE", band: "B3", bandwidthMHz: 20, azimuthDeg: 0 },
    { cellId: "SITE-2-L1", siteId: "SITE-2", technology: "LTE", band: "B3", bandwidthMHz: 20, azimuthDeg: 0 },
  ],
  samples: [
    ...Array.from({ length: 8 }, (_, i) => sample("SITE-1-L1", i)),
    ...Array.from({ length: 8 }, (_, i) => sample("SITE-2-L1", i, { latencyMs: 95 })),
  ],
  alarms: [],
  ...noPackets,
};

beforeEach(() => download.mockClear());

describe("Sites page (synthetic dataset, 7d window from the URL)", () => {
  it("renders the page head, one tile per region, the map and one row per site with deep links", () => {
    mount("#/sites?range=7d");
    expect(screen.getByRole("heading", { level: 1, name: "Sites and regions" })).toBeInTheDocument();
    expect(screen.getByText(/12 sites · 48 cells · 3 regions · window 7d/)).toBeInTheDocument();

    const tiles = regionTiles();
    expect(tiles).toHaveLength(3);
    expect(tiles.map((t) => (t.textContent ?? "").match(/^VSKP-(Central|North|South)/)?.[0])).toEqual(["VSKP-Central", "VSKP-North", "VSKP-South"]);
    for (const tile of tiles) {
      expect(tile).toHaveTextContent(/4 sites/);
      expect(tile).toHaveTextContent(/16 cells/);
      expect(tile).toHaveTextContent(/active alarm/);
      expect(tile).toHaveTextContent(/CDR/);
      expect(tile).toHaveTextContent(/PRB/);
      expect(hasLevelBorder(tile)).toBe(true);
      expect(tile.getAttribute("href")).toMatch(/^#\/sites\?range=7d&region=VSKP-(Central|North|South)$/);
      expect(tile).not.toHaveAttribute("aria-current");
    }
    expect(tiles[1]).toHaveTextContent(/1 down cell/); // VSKP-004-L2 outage

    expect(circles()).toHaveLength(12);
    const rows = dataRows();
    expect(rows).toHaveLength(12);
    expect(rows.map(siteOfRow)).toEqual(Array.from({ length: 12 }, (_, i) => `VSKP-${String(i + 1).padStart(3, "0")}`));
    const headers = within(siteTable()).getAllByRole("columnheader").map((h) => h.textContent?.trim());
    expect(headers).toEqual(["Site", "Name", "Region", "Cells", "Status", "Availability %", "CDR %", "Latency ms", "PRB %", "DL Mbps", "Active alarms", "Down cells", "Links"]);
    expect(within(siteTable()).getByRole("columnheader", { name: "Site" })).toHaveAttribute("aria-sort", "ascending");

    const s4 = rows[3];
    expect(siteOfRow(s4)).toBe("VSKP-004");
    const s4cells = cellsOf(s4);
    expect(s4cells[1]).toBe("Madhurawada");
    expect(s4cells[2]).toBe("VSKP-North");
    expect(s4cells[3]).toBe("4");
    expect(s4cells[5]).toBe("99.1"); // 24 of 2684 intervals without counters
    expect(s4cells[11]).toBe("1");
    expect(within(s4).getByRole("link", { name: /KPIs/ }).getAttribute("href")).toBe(`#/kpis?cell=${worstCellOf("VSKP-004", "7d")}&range=7d&tech=All`);
    expect(within(s4).getByRole("link", { name: /Alarms/ }).getAttribute("href")).toBe("#/alarms?site=VSKP-004&range=7d&tech=All");
    const s2 = rows[1];
    expect(within(s2).getByRole("link", { name: /KPIs/ }).getAttribute("href")).toBe(`#/kpis?cell=${worstCellOf("VSKP-002", "7d")}&range=7d&tech=All`);
    for (const row of rows) expect(cellsOf(row)[4]).toMatch(/^(OK|Warning|Critical)$/);
    expect(screen.queryByRole("row", { selected: true })).toBeNull();
  });

  it("sorts worst-first on a header click (availability: VSKP-004 first), toggles the direction and keeps the state in the URL", async () => {
    const user = userEvent.setup();
    mount("#/sites?range=7d");
    await user.click(within(siteTable()).getByRole("button", { name: "Availability %" }));
    expect(window.location.hash).toBe("#/sites?range=7d&sort=availability&dir=asc");
    expect(within(siteTable()).getByRole("columnheader", { name: "Availability %" })).toHaveAttribute("aria-sort", "ascending");
    expect(within(siteTable()).getByRole("columnheader", { name: "Site" })).not.toHaveAttribute("aria-sort");
    let rows = dataRows();
    expect(siteOfRow(rows[0])).toBe("VSKP-004");
    expect(siteOfRow(rows[1])).toBe("VSKP-001"); // ties (100 %) fall back to the site id
    await user.click(within(siteTable()).getByRole("button", { name: "Availability %" }));
    expect(window.location.hash).toBe("#/sites?range=7d&sort=availability&dir=desc");
    expect(within(siteTable()).getByRole("columnheader", { name: "Availability %" })).toHaveAttribute("aria-sort", "descending");
    rows = dataRows();
    expect(siteOfRow(rows[0])).toBe("VSKP-001");
    expect(siteOfRow(rows[11])).toBe("VSKP-004");
    // a "higher is worse" column starts descending so the worst site is first as well
    await user.click(within(siteTable()).getByRole("button", { name: "Active alarms" }));
    expect(window.location.hash).toBe("#/sites?range=7d&sort=alarms&dir=desc");
    const alarms = dataRows().map((r) => Number(cellsOf(r)[10]));
    expect(alarms).toEqual([...alarms].sort((a, b) => b - a));
    expect(alarms[0]).toBeGreaterThan(0);
  });

  it("selects a site from its link: URL, row, map circle and a detail panel with its cells and alarm link", async () => {
    const user = userEvent.setup();
    mount("#/sites?range=7d");
    await user.click(within(siteTable()).getByRole("link", { name: "VSKP-004" }));
    expect(window.location.hash).toBe("#/sites?range=7d&site=VSKP-004");
    const selectedRows = screen.getAllByRole("row", { selected: true });
    expect(selectedRows).toHaveLength(1);
    expect(siteOfRow(selectedRows[0])).toBe("VSKP-004");
    const pressed = circles().filter((c) => c.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0].getAttribute("aria-label")).toMatch(/^VSKP-004 Madhurawada/);

    const panel = screen.getByRole("heading", { name: /^Site VSKP-004 · Madhurawada/ }).closest("section")!;
    expect(within(panel).getByRole("link", { name: "Open alarms" }).getAttribute("href")).toBe("#/alarms?site=VSKP-004&range=7d&tech=All");
    const cellRows = within(within(panel).getByRole("table")).getAllByRole("row").slice(1);
    expect(cellRows.map((r) => cellsOf(r)[0])).toEqual(["VSKP-004-L1", "VSKP-004-L2", "VSKP-004-L3", "VSKP-004-N1"]);
    expect(within(cellRows[1]).getByRole("link", { name: "VSKP-004-L2" }).getAttribute("href")).toBe("#/kpis?cell=VSKP-004-L2&range=7d&tech=All");
    const l2 = cellsOf(cellRows[1]);
    expect(l2[l2.length - 1]).toBe("24"); // down intervals
    expect(within(panel).getByText("outage")).toHaveClass("badge", "kind-outage");
    expect(within(panel).getByText(/24 consecutive intervals without counters/)).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: "Clear selection" }));
    expect(window.location.hash).toBe("#/sites?range=7d");
    expect(screen.queryByRole("row", { selected: true })).toBeNull();
    expect(screen.queryByRole("heading", { name: /^Site VSKP-004/ })).toBeNull();
  });

  it("toggles selection from the map and filters map and table by region from a tile", async () => {
    const user = userEvent.setup();
    mount("#/sites?range=24h&tech=NR");
    expect(circles()).toHaveLength(12);
    expect(circles().every((c) => c.getAttribute("r") === "7.5")).toBe(true); // one NR cell per site
    await user.click(screen.getByRole("button", { name: /^VSKP-007 Pendurthi/ }));
    expect(window.location.hash).toBe("#/sites?range=24h&tech=NR&site=VSKP-007");
    expect(siteOfRow(screen.getByRole("row", { selected: true }))).toBe("VSKP-007");
    await user.click(screen.getByRole("button", { name: /^VSKP-007 Pendurthi/ }));
    expect(window.location.hash).toBe("#/sites?range=24h&tech=NR");
    expect(screen.queryByRole("row", { selected: true })).toBeNull();

    const north = regionTiles()[1];
    expect(north).toHaveTextContent(/^VSKP-North/);
    await user.click(north);
    expect(window.location.hash).toBe("#/sites?range=24h&tech=NR&region=VSKP-North");
    expect(regionTiles()[1]).toHaveAttribute("aria-current", "true");
    expect(regionTiles()[0]).not.toHaveAttribute("aria-current");
    expect(dataRows().map(siteOfRow)).toEqual(["VSKP-001", "VSKP-004", "VSKP-007", "VSKP-010"]);
    expect(circles()).toHaveLength(4);
    expect(screen.getByRole("heading", { name: "Sites (4)" })).toBeInTheDocument();
    expect(regionTiles()[1].getAttribute("href")).toBe("#/sites?range=24h&tech=NR"); // the active tile links back to all regions
    await user.click(regionTiles()[1]);
    expect(window.location.hash).toBe("#/sites?range=24h&tech=NR");
    expect(dataRows()).toHaveLength(12);
  });

  it("applies region, site, sort and dir from the URL and reports unknown values instead of crashing", () => {
    const { unmount } = mount("#/sites?range=24h&region=VSKP-Central&site=VSKP-002&sort=cdr&dir=desc");
    expect(dataRows().map(siteOfRow).sort()).toEqual(["VSKP-002", "VSKP-005", "VSKP-008", "VSKP-011"]);
    const cdrs = dataRows().map((r) => Number(cellsOf(r)[6]));
    expect(cdrs).toEqual([...cdrs].sort((a, b) => b - a));
    expect(within(siteTable()).getByRole("columnheader", { name: "CDR %" })).toHaveAttribute("aria-sort", "descending");
    const selected = screen.getByRole("row", { selected: true });
    expect(siteOfRow(selected)).toBe("VSKP-002");
    expect(within(selected).getByText("Critical")).toHaveClass("badge", "lvl-critical"); // VSKP-002-L1 handover success ≈ 88 % (VSWR fault)
    expect(regionTiles()[0]).toHaveAttribute("aria-current", "true");
    expect(screen.queryByRole("status")).toBeNull();
    unmount();

    mount("#/sites?range=7d&region=Nowhere&site=NOPE-001&sort=bogus&dir=sideways");
    const notices = screen.getAllByRole("status").map((n) => n.textContent).join(" ");
    expect(notices).toMatch(/Nowhere/);
    expect(notices).toMatch(/NOPE-001/);
    expect(dataRows()).toHaveLength(12);
    expect(dataRows().map(siteOfRow)[0]).toBe("VSKP-001");
    expect(within(siteTable()).getByRole("columnheader", { name: "Site" })).toHaveAttribute("aria-sort", "ascending");
    expect(screen.queryByRole("row", { selected: true })).toBeNull();
    expect(regionTiles().every((t) => !t.hasAttribute("aria-current"))).toBe(true);
  });

  it("exports the visible site rows as CSV", async () => {
    const user = userEvent.setup();
    mount("#/sites?range=7d&region=VSKP-North");
    await user.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(download).toHaveBeenCalledTimes(1);
    const [filename, text] = download.mock.calls[0];
    expect(filename).toBe("sites_7d_All_VSKP-North.csv");
    const lines = text.trim().split(/\r?\n/);
    expect(lines).toHaveLength(5);
    expect(lines[0].split(",").slice(0, 6)).toEqual(["siteId", "name", "region", "cells", "status", "availabilityPct"]);
    expect(lines.slice(1).map((l) => l.split(",")[0])).toEqual(["VSKP-001", "VSKP-004", "VSKP-007", "VSKP-010"]);
  });
});

describe("Sites page (imported datasets)", () => {
  it("shows an empty-window message instead of tiles, map and table when there are no samples", () => {
    const { app } = mount("#/sites?range=24h");
    act(() => app().loadDataset(emptyDataset, "empty.csv"));
    expect(screen.getByRole("heading", { level: 1, name: "Sites and regions" })).toBeInTheDocument();
    expect(screen.getByText("No KPI samples in this window.")).toBeInTheDocument();
    expect(screen.queryAllByRole("link").filter((l) => l.classList.contains("region-tile"))).toHaveLength(0);
    expect(document.querySelector("svg.site-map")).toBeNull();
    expect(screen.queryByRole("heading", { name: /^Sites \(/ })).toBeNull();
  });

  it("lists sites without coordinates in the table and the hidden list but draws no circle for them", () => {
    const { app } = mount("#/sites?range=24h");
    act(() => app().loadDataset(partialGeoDataset, "partial.csv"));
    expect(screen.getByText(/2 sites · 2 cells · 1 region · window 24h/)).toBeInTheDocument();
    expect(regionTiles()).toHaveLength(1);
    expect(regionTiles()[0]).toHaveTextContent(/^Imported region/);
    expect(dataRows().map(siteOfRow)).toEqual(["SITE-1", "SITE-2"]);
    expect(circles()).toHaveLength(1);
    expect(circles()[0].getAttribute("aria-label")).toMatch(/^SITE-1 Mapped site, Imported region, OK, 1 cell$/);
    const hidden = Array.from(document.querySelectorAll("ul.visually-hidden li")).map((li) => li.textContent);
    expect(hidden).toHaveLength(2);
    expect(hidden[1]).toMatch(/^SITE-2 SITE-2, Imported region, Critical, 1 cell, no coordinates$/); // latency 95 ms > critical 60
    expect(within(dataRows()[1]).getByText("Critical")).toHaveClass("lvl-critical");
    expect(screen.getByText(/1 site without coordinates/)).toBeInTheDocument();
  });
});
