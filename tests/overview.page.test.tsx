import { describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppProvider, useApp, type AppState } from "../src/state";
import { Overview } from "../src/pages/Overview";
import { KpiCard } from "../src/components/KpiCard";
import type { Dataset } from "../src/lib/synthetic";
import type { KpiSample } from "../src/types/telecom";

/* ---------- harness: real provider + Overview page, with access to the context for loadDataset ---------- */

function Harness({ onApp }: { onApp: (s: AppState) => void }) {
  onApp(useApp());
  return <Overview />;
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

const kpiCards = () => screen.queryAllByRole("button").filter((b) => b.classList.contains("kpi-card"));
/** Number of plotted points in a sparkline path: one M per run of values plus one L per further point. */
const plotted = (card: Element) => card.querySelector("svg.sparkline path")?.getAttribute("d")?.match(/[ML]/g)?.length ?? 0;

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
/** One LTE cell that reports counters for two hours while carrying a single user: a sleeping cell. */
const sleepyDataset: Dataset = {
  sites: [{ siteId: "SITE-1", name: "Test site", lat: 17.7, lon: 83.2, region: "Test region" }],
  cells: [{ cellId: "SITE-1-L1", siteId: "SITE-1", technology: "LTE", band: "B3", bandwidthMHz: 20, azimuthDeg: 0 }],
  samples: Array.from({ length: 8 }, (_, i) => sample("SITE-1-L1", i, { activeUsers: 1 })),
  alarms: [],
  ...noPackets,
};

describe("Overview page (synthetic dataset, filters from the URL)", () => {
  it("renders seven KPI cards as valid, labelled buttons with an hourly-bucketed sparkline for 7d", () => {
    mount("#/overview?range=7d&tech=All");
    expect(screen.getByRole("heading", { level: 1, name: "Network overview" })).toBeInTheDocument();
    const cards = kpiCards();
    expect(cards).toHaveLength(7);
    for (const card of cards) {
      expect(card.querySelector("div")).toBeNull(); // only phrasing content inside a <button>
      expect(card.getAttribute("aria-label")).toMatch(/^(Call drop rate|RRC setup success|Handover success|DL throughput|UL throughput|Latency \(RTT\)|PRB utilization) \d/);
      expect(card.getAttribute("aria-label")).toMatch(/, (OK|Warning|Critical), /);
      expect(card.querySelector("svg.sparkline path")?.getAttribute("stroke")).toBe("var(--chart-series-1)");
    }
    expect(cards[0].getAttribute("aria-label")).toMatch(/^Call drop rate \d+\.\d\d %, (OK|Warning|Critical), /);
    // 7 days of 15-minute samples collapse into 168 hourly points
    for (const card of cards) expect(plotted(card)).toBe(168);
  });

  it("keeps one point per 15-minute interval for the 24h window", () => {
    mount("#/overview?range=24h");
    expect(plotted(kpiCards()[0])).toBe(95); // (end - 24h, end] holds 95 intervals: the last sample is 15 min before the end
  });

  it("lists the injected incidents with deep links that carry the global filters", () => {
    mount("#/overview?range=7d&tech=All");
    const card = screen.getByRole("heading", { name: "Congestion, outage and fault detection" }).closest("section")!;
    const hrefs = (cellId: string) => within(card).getAllByRole("link", { name: cellId }).map((l) => l.getAttribute("href"));
    expect(hrefs("VSKP-004-L2")).toEqual(["#/kpis?cell=VSKP-004-L2&kpi=dlThroughputMbps&range=7d&tech=All"]);
    // the congested cell also breaches the drop-rate rule, so it may be listed twice (congestion + drops)
    expect(hrefs("VSKP-007-N1")).toContain("#/kpis?cell=VSKP-007-N1&kpi=prbUtilizationPct&range=7d&tech=All");
    const items = within(card).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("VSKP-004-L2"); // outage first
    expect(within(items[0]).getByText("outage")).toHaveClass("badge", "kind-outage");
    expect(within(card).getByText(/sleeping = /)).toBeInTheDocument(); // the rule legend documents the new kind
  });

  it("shows a Sites & regions card with one tile per region linking to the Sites page", () => {
    mount("#/overview?range=7d&tech=NR");
    const card = screen.getByRole("heading", { name: "Sites & regions" }).closest("section")!;
    const tiles = within(card).getAllByRole("link").filter((l) => l.classList.contains("region-tile"));
    expect(tiles).toHaveLength(3);
    expect(tiles.map((t) => t.getAttribute("href"))).toEqual([
      "#/sites?region=VSKP-Central&range=7d&tech=NR",
      "#/sites?region=VSKP-North&range=7d&tech=NR",
      "#/sites?region=VSKP-South&range=7d&tech=NR",
    ]);
    // with the NR filter each region holds 4 sites with 1 NR cell each
    for (const tile of tiles) {
      expect(tile).toHaveTextContent(/4 sites/);
      expect(tile).toHaveTextContent(/4 cells/);
      expect(tile).toHaveTextContent(/active alarm/);
      expect(tile).toHaveTextContent(/CDR \d+\.\d\d %/);
      expect(tile).toHaveTextContent(/PRB \d+\.\d %/);
      expect(tile.querySelector(".badge")).not.toBeNull(); // worst level badge
    }
    expect(within(card).getByRole("link", { name: "Open Sites page" }).getAttribute("href")).toBe("#/sites?range=7d&tech=NR");
  });

  it("carries range and tech on every alarm and KPI link and on card navigation", async () => {
    mount("#/overview?range=6h&tech=LTE");
    expect(screen.getByRole("link", { name: "Open alarm list" }).getAttribute("href")).toBe("#/alarms?state=active&range=6h&tech=LTE");
    const critical = screen.getAllByRole("link").find((l) => l.getAttribute("href")?.includes("severity=Critical"));
    expect(critical?.getAttribute("href")).toBe("#/alarms?severity=Critical&state=active&range=6h&tech=LTE");
    expect(screen.getByRole("link", { name: "KPI analysis" }).getAttribute("href")).toBe("#/kpis?range=6h&tech=LTE");
    const worst = screen.getByRole("heading", { name: /Worst 10 cells/ }).closest("section")!;
    const rows = within(worst).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(within(row).getByRole("link").getAttribute("href")).toMatch(/^#\/kpis\?cell=VSKP-\d{3}-L\d&range=6h&tech=LTE$/);
    }
    const user = userEvent.setup();
    await user.click(kpiCards()[6]);
    expect(window.location.hash).toBe("#/kpis?kpi=prbUtilizationPct&range=6h&tech=LTE");
  });
});

describe("Overview page (imported datasets)", () => {
  it("renders an empty-window message instead of crashing when the dataset has no samples", () => {
    const { app } = mount("#/overview?range=24h");
    act(() => app().loadDataset(emptyDataset, "empty.csv"));
    expect(screen.getByRole("heading", { level: 1, name: "Network overview" })).toBeInTheDocument();
    expect(screen.getByText("No KPI samples in this window.")).toBeInTheDocument();
    expect(screen.getByText(/empty\.csv/)).toBeInTheDocument();
    expect(kpiCards()).toHaveLength(0);
    expect(screen.queryByRole("heading", { name: "Sites & regions" })).toBeNull();
    expect(screen.queryByRole("heading", { name: /Worst 10 cells/ })).toBeNull();
    // the alarm summary does not depend on samples and stays available
    expect(screen.getByRole("link", { name: "Open alarm list" })).toBeInTheDocument();
  });

  it("renders a sleeping-cell detection with its badge and PRB deep link", () => {
    const { app } = mount("#/overview?range=24h");
    act(() => app().loadDataset(sleepyDataset, "sleepy.csv"));
    expect(app().now).toBe(T0 + 7 * STEP);
    const card = screen.getByRole("heading", { name: "Congestion, outage and fault detection" }).closest("section")!;
    expect(within(card).getByText("sleeping")).toHaveClass("badge", "kind-sleeping");
    expect(within(card).getByRole("link", { name: "SITE-1-L1" }).getAttribute("href")).toBe("#/kpis?cell=SITE-1-L1&kpi=prbUtilizationPct&range=24h&tech=All");
    const regions = screen.getByRole("heading", { name: "Sites & regions" }).closest("section")!;
    const tile = within(regions).getAllByRole("link").find((l) => l.classList.contains("region-tile"));
    expect(tile?.getAttribute("href")).toBe("#/sites?region=Test+region&range=24h&tech=All");
    expect(tile).toHaveTextContent(/1 site · 1 cell · 0 active alarms/);
    expect(kpiCards()).toHaveLength(7);
    expect(plotted(kpiCards()[0])).toBe(8);
  });
});

describe("KpiCard", () => {
  const series = [{ t: 0, v: 10 }, { t: 1, v: null }, { t: 2, v: 30 }, { t: 3, v: 20 }];

  it("is a button of phrasing content with an accessible summary and a token-coloured sparkline", () => {
    render(<KpiCard kpi="latencyMs" value={45.25} previous={40} series={series} level="warning" />);
    const button = screen.getByRole("button");
    expect(button).toHaveClass("kpi-card", "lvl-border-warning");
    expect(button).toHaveAttribute("title", "Open Latency (RTT) in KPI analysis");
    expect(button.getAttribute("aria-label")).toBe("Latency (RTT) 45.3 ms, Warning, up 13.1% vs previous window");
    expect(button.querySelector("div")).toBeNull();
    expect(button.querySelector(".kpi-value")).toHaveTextContent("45.3 ms");
    expect(button.querySelector(".kpi-delta")).toHaveTextContent("▲ 13.1% vs previous window");
    expect(button.querySelector(".kpi-delta")).toHaveClass("bad"); // latency: higher is worse
    const sparkline = button.querySelector("svg.sparkline");
    expect(sparkline).toHaveAttribute("aria-hidden", "true");
    const path = sparkline!.querySelector("path");
    expect(path?.getAttribute("stroke")).toBe("var(--chart-series-1)");
    expect(path?.getAttribute("fill")).toBe("none");
    // the null point breaks the line into two runs (the isolated first point is a bare move), three plotted points in total
    expect(path?.getAttribute("d")?.match(/M/g)).toHaveLength(2);
    expect(plotted(button)).toBe(3);
  });

  it("marks improvements, handles a missing previous window and a null value", () => {
    const { unmount } = render(<KpiCard kpi="dlThroughputMbps" value={44} previous={40} series={series} level="ok" />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe("DL throughput 44.0 Mbps, OK, up 10.0% vs previous window");
    expect(screen.getByRole("button").querySelector(".kpi-delta")).toHaveClass("good");
    unmount();
    render(<KpiCard kpi="callDropRatePct" value={null} previous={0} series={[]} level="ok" />);
    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-label")).toBe("Call drop rate no data, OK, no previous window");
    expect(button.querySelector(".kpi-delta")).toHaveTextContent("no previous window");
    expect(button.querySelector("svg.sparkline")).not.toBeNull();
    expect(button.querySelector("svg.sparkline path")).toBeNull();
  });
});
