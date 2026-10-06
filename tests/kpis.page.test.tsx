import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppProvider, useApp, type AppState } from "../src/state";
import { Kpis } from "../src/pages/Kpis";
import * as csv from "../src/lib/csv";
import type { Dataset } from "../src/lib/synthetic";
import type { KpiSample } from "../src/types/telecom";

vi.mock("../src/lib/csv", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/csv")>();
  return { ...mod, downloadText: vi.fn() };
});
const downloadText = vi.mocked(csv.downloadText);

/* ---------- harness: real provider + page, with access to the context for loadDataset ---------- */

function Harness({ onApp }: { onApp: (s: AppState) => void }) {
  onApp(useApp());
  return <Kpis />;
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

/** jsdom has no layout: give Recharts' container a real box so the SVG and legend render. */
function fakeRect(this: HTMLElement): DOMRect {
  const isChartBox = this.classList.contains("recharts-responsive-container") || this.classList.contains("recharts-wrapper");
  const width = isChartBox ? 800 : 60;
  const height = isChartBox ? 260 : 16;
  return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
}

beforeEach(() => {
  downloadText.mockClear();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(fakeRect);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const legendNames = () => Array.from(document.querySelectorAll(".recharts-legend-item-text")).map((e) => e.textContent);
const mainFigure = (name: RegExp | string) => screen.getByRole("figure", { name });
const captionOf = (figure: HTMLElement) => {
  const el = figure.querySelector("figcaption");
  if (!el) throw new Error("figure has no figcaption");
  return el;
};
const reportTable = () => screen.getByRole("table", { name: /per-cell performance/i });
const reportRows = () => within(reportTable()).getAllByRole("row").slice(1);
const lastDownload = () => {
  const call = downloadText.mock.calls[downloadText.mock.calls.length - 1];
  if (!call) throw new Error("downloadText was not called");
  return { filename: String(call[0]), lines: String(call[1]).split("\r\n") };
};

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
/** Two LTE cells on one site; the second cell reports only every other interval, so an index join would misalign it. */
const gapDataset: Dataset = {
  sites: [{ siteId: "SITE-1", name: "Test site", lat: 17.7, lon: 83.2, region: "Test region" }],
  cells: [
    { cellId: "SITE-1-L1", siteId: "SITE-1", technology: "LTE", band: "B3", bandwidthMHz: 20, azimuthDeg: 0 },
    { cellId: "SITE-1-L2", siteId: "SITE-1", technology: "LTE", band: "B40", bandwidthMHz: 20, azimuthDeg: 120 },
  ],
  samples: [
    ...[10, 20, 30, 40, 50].map((latencyMs, i) => sample("SITE-1-L1", i, { latencyMs })),
    sample("SITE-1-L2", 0, { latencyMs: 11 }),
    sample("SITE-1-L2", 2, { latencyMs: 13 }),
    sample("SITE-1-L2", 4, { latencyMs: 15 }),
  ],
  alarms: [],
  ...noPackets,
};

describe("KPI page deep links (synthetic dataset)", () => {
  it("falls back to the defaults with a warning notice instead of crashing on unknown kpi/cell params", () => {
    mount("#/kpis?kpi=bogus&cell=NOPE&range=24h");
    expect(screen.getByRole("heading", { level: 1, name: "KPI analysis" })).toBeInTheDocument();
    const notice = screen.getByText(/unknown KPI/i).closest(".notice");
    expect(notice).toHaveClass("notice-warning");
    expect(notice).toHaveTextContent(/bogus/);
    expect(notice).toHaveTextContent(/NOPE/);
    expect(mainFigure("PRB utilization for VSKP-007-N1")).toBeInTheDocument();
    expect(screen.getByLabelText("Cell")).toHaveValue("VSKP-007-N1");
    expect(screen.getByLabelText("KPI")).toHaveValue("prbUtilizationPct");
    // the page never rewrites the URL on its own
    expect(window.location.hash).toBe("#/kpis?kpi=bogus&cell=NOPE&range=24h");
  });

  it("opens the Overview outage deep link with availability and down-interval statistics", () => {
    mount("#/kpis?cell=VSKP-004-L2&kpi=dlThroughputMbps&range=7d&tech=All");
    expect(screen.queryByText(/unknown KPI/i)).toBeNull();
    const figure = mainFigure("DL throughput for VSKP-004-L2");
    expect(captionOf(figure)).toHaveTextContent(/^671 points/);
    expect(captionOf(figure)).toHaveTextContent(/24 intervals without counters/);
    expect(screen.getByText("24 intervals down")).toBeInTheDocument();
    expect(screen.getByText(/^availability/).textContent).toMatch(/96\.4 %/);
    expect(screen.getByText("671 intervals")).toBeInTheDocument();
  });

  it("writes cell, KPI and compare changes to the URL together with the global filters", async () => {
    const user = userEvent.setup();
    mount("#/kpis");
    await user.selectOptions(screen.getByLabelText("Cell"), "VSKP-001-L1");
    expect(window.location.hash).toBe("#/kpis?cell=VSKP-001-L1&range=24h&tech=All");
    expect(mainFigure("PRB utilization for VSKP-001-L1")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("KPI"), "latencyMs");
    expect(window.location.hash).toBe("#/kpis?cell=VSKP-001-L1&range=24h&tech=All&kpi=latencyMs");
    expect(mainFigure("Latency (RTT) for VSKP-001-L1")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Compare"), "network");
    expect(window.location.hash).toBe("#/kpis?cell=VSKP-001-L1&range=24h&tech=All&kpi=latencyMs&compare=network");
    expect(legendNames()).toEqual(["VSKP-001-L1", "Network (All)"]);
    // the per-cell table links keep the KPI and the global filters
    const row = reportRows().find((r) => within(r).queryByRole("link", { name: "VSKP-002-L1" }));
    expect(row).toBeDefined();
    expect(within(row!).getByRole("link", { name: "VSKP-002-L1" }).getAttribute("href")).toBe("#/kpis?cell=VSKP-002-L1&kpi=latencyMs&range=24h&tech=All");
  });

  it("compares with another cell from the URL and offers hourly buckets and a brush for 7d", async () => {
    const user = userEvent.setup();
    const { container } = mount("#/kpis?cell=VSKP-007-N1&kpi=prbUtilizationPct&compare=VSKP-001-N1&range=7d&tech=NR");
    expect(screen.getByLabelText("Compare")).toHaveValue("VSKP-001-N1");
    expect(legendNames()).toEqual(["VSKP-007-N1", "VSKP-001-N1"]);
    const figure = mainFigure("PRB utilization for VSKP-007-N1");
    expect(captionOf(figure)).toHaveTextContent(/^671 points/);
    expect(captionOf(figure)).toHaveTextContent(/VSKP-001-N1: mean/);
    expect(container.querySelector(".recharts-brush")).not.toBeNull();
    const hourly = screen.getByLabelText(/hourly buckets/i);
    expect(hourly).not.toBeChecked();
    await user.click(hourly);
    expect(window.location.hash).toContain("bucket=1h");
    expect(screen.getByLabelText(/hourly buckets/i)).toBeChecked();
    expect(captionOf(mainFigure("PRB utilization for VSKP-007-N1"))).toHaveTextContent(/^168 points/);
    const table = screen.getByRole("table", { name: /data points/i });
    expect(within(table).getAllByRole("row")).toHaveLength(1 + 168);
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Time (IST)", "VSKP-007-N1", "VSKP-001-N1"]);
  });

  it("hides the hourly toggle and the brush for short ranges and rejects a compare equal to the cell", () => {
    const { container } = mount("#/kpis?cell=VSKP-007-N1&compare=VSKP-007-N1&range=24h");
    expect(screen.queryByLabelText(/hourly buckets/i)).toBeNull();
    expect(container.querySelector(".recharts-brush")).toBeNull();
    expect(screen.getByText(/compare/i, { selector: ".notice p, .notice li, .notice" })).toBeInTheDocument();
    expect(screen.getByLabelText("Compare")).toHaveValue("");
    expect(legendNames()).toEqual([]);
  });
});

describe("KPI page per-cell report and exports", () => {
  it("exports the selected cell's samples as CSV with one header line and one line per interval", async () => {
    const user = userEvent.setup();
    mount("#/kpis?cell=VSKP-007-N1&kpi=prbUtilizationPct&range=24h");
    await user.click(screen.getByRole("button", { name: "Export cell CSV" }));
    expect(downloadText).toHaveBeenCalledTimes(1);
    const { filename, lines } = lastDownload();
    expect(filename).toBe("kpi_VSKP-007-N1_24h.csv");
    expect(lines[0]).toBe("timestamp_utc,cellId,callDropRatePct,rrcSetupSuccessPct,handoverSuccessPct,dlThroughputMbps,ulThroughputMbps,latencyMs,prbUtilizationPct,rsrpAvgDbm,sinrAvgDb,activeUsers");
    expect(lines).toHaveLength(1 + 95); // (end - 24h, end] holds 95 intervals
    expect(lines[1]).toMatch(/^2026-09-22T09:15:00\.000Z,VSKP-007-N1,/);
  });

  it("shows an availability column and exports it in the network performance report", async () => {
    const user = userEvent.setup();
    mount("#/kpis?range=7d");
    const headers = within(reportTable()).getAllByRole("columnheader").map((h) => h.textContent?.trim());
    expect(headers).toEqual(expect.arrayContaining(["Cell", "Site", "Status", "Availability %", "Down"]));
    expect(reportRows()).toHaveLength(48);
    const outage = reportRows().find((r) => within(r).queryByRole("link", { name: "VSKP-004-L2" }));
    expect(outage).toBeDefined();
    expect(outage!.textContent).toMatch(/96\.4/);
    expect(within(outage!).getAllByRole("cell").map((c) => c.textContent)).toContain("24");
    await user.click(screen.getByRole("button", { name: /export network performance report/i }));
    const { filename, lines } = lastDownload();
    expect(filename).toBe("network_performance_report_7d_All.csv");
    expect(lines[0].split(",")).toEqual(expect.arrayContaining(["cellId", "siteId", "technology", "samples", "down_intervals", "availability_pct", "status", "breached_kpis", "callDropRatePct_avg"]));
    expect(lines).toHaveLength(1 + 48);
    const outageLine = lines.find((l) => l.startsWith("VSKP-004-L2,"));
    expect(outageLine).toBeDefined();
    const cols = lines[0].split(",");
    expect(outageLine!.split(",")[cols.indexOf("availability_pct")]).toBe("96.42");
    expect(outageLine!.split(",")[cols.indexOf("down_intervals")]).toBe("24");
  });

  it("filters the report to breaching cells or a site and sorts by a KPI column", async () => {
    const user = userEvent.setup();
    mount("#/kpis?range=24h&tech=All");
    expect(reportRows()).toHaveLength(48);
    await user.click(screen.getByLabelText(/only breaching/i));
    const breaching = reportRows();
    expect(breaching.length).toBeGreaterThan(0);
    expect(breaching.length).toBeLessThan(48);
    for (const row of breaching) expect(within(row).queryByText("OK")).toBeNull();
    expect(screen.getByRole("heading", { name: /Per-cell performance report/ })).toHaveTextContent(`${breaching.length} of 48 cells`);
    await user.click(screen.getByLabelText(/only breaching/i));
    await user.selectOptions(screen.getByLabelText("Site"), "VSKP-004");
    const site = reportRows();
    expect(site).toHaveLength(4);
    for (const row of site) expect(within(row).getByRole("link").textContent).toMatch(/^VSKP-004-/);
    await user.selectOptions(screen.getByLabelText("Site"), "");
    const cdrHeader = screen.getByRole("columnheader", { name: /call drop rate/i });
    expect(cdrHeader).toHaveAttribute("aria-sort", "descending"); // default sort
    await user.click(within(cdrHeader).getByRole("button"));
    expect(screen.getByRole("columnheader", { name: /call drop rate/i })).toHaveAttribute("aria-sort", "ascending");
    const latencyHeader = screen.getByRole("columnheader", { name: /latency/i });
    expect(latencyHeader).not.toHaveAttribute("aria-sort");
    await user.click(within(latencyHeader).getByRole("button"));
    expect(screen.getByRole("columnheader", { name: /latency/i })).toHaveAttribute("aria-sort", "descending");
    expect(screen.getByRole("columnheader", { name: /call drop rate/i })).not.toHaveAttribute("aria-sort");
  });
});

describe("KPI page with imported datasets", () => {
  it("joins the compare series by timestamp, not by index", () => {
    const { app } = mount("#/kpis?cell=SITE-1-L1&kpi=latencyMs&compare=SITE-1-L2&range=24h");
    act(() => app().loadDataset(gapDataset, "gap.csv"));
    expect(screen.queryByText(/unknown KPI/i)).toBeNull();
    expect(legendNames()).toEqual(["SITE-1-L1", "SITE-1-L2"]);
    const table = screen.getByRole("table", { name: /data points/i });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(5);
    const cells = (i: number) => within(rows[i]).getAllByRole("cell").map((c) => c.textContent);
    expect(cells(0)).toEqual(["10.0", "11.0"]);
    expect(cells(1)).toEqual(["20.0", "no counters"]); // no SITE-1-L2 sample at this interval
    expect(cells(2)).toEqual(["30.0", "13.0"]);
    expect(cells(3)).toEqual(["40.0", "no counters"]);
    expect(cells(4)).toEqual(["50.0", "15.0"]);
    expect(captionOf(mainFigure("Latency (RTT) for SITE-1-L1"))).toHaveTextContent(/SITE-1-L2: mean 13\.0 ms/);
  });

  it("compares with the mean of a site's cells per timestamp", () => {
    const { app } = mount("#/kpis?cell=SITE-1-L1&kpi=latencyMs&compare=site:SITE-1&range=24h");
    act(() => app().loadDataset(gapDataset, "gap.csv"));
    expect(screen.getByLabelText("Compare")).toHaveValue("site:SITE-1");
    expect(legendNames()).toEqual(["SITE-1-L1", "Site SITE-1"]);
    const table = screen.getByRole("table", { name: /data points/i });
    const rows = within(table).getAllByRole("row").slice(1);
    const cells = (i: number) => within(rows[i]).getAllByRole("cell").map((c) => c.textContent);
    expect(cells(0)).toEqual(["10.0", "10.5"]); // (10 + 11) / 2
    expect(cells(1)).toEqual(["20.0", "20.0"]); // only SITE-1-L1 reported
  });

  it("renders empty states instead of crashing when the dataset has no cells", () => {
    const { app } = mount("#/kpis?range=24h");
    act(() => app().loadDataset(emptyDataset, "empty.csv"));
    expect(screen.getByRole("heading", { level: 1, name: "KPI analysis" })).toBeInTheDocument();
    expect(screen.getByText("No cells in this dataset.")).toBeInTheDocument();
    expect(screen.getByText("No KPI samples in this window.")).toBeInTheDocument();
    expect(screen.queryByRole("figure")).toBeNull();
    expect(screen.queryByRole("table", { name: /per-cell performance/i })).toBeNull();
  });
});
