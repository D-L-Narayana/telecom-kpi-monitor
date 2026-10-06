import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { KpiChart, type ChartPoint } from "../src/components/KpiChart";
import { DEFAULT_THRESHOLDS } from "../src/lib/thresholds";
import { fmtTime } from "../src/components/ui";

const T0 = Date.UTC(2026, 8, 22, 9, 0, 0);
const STEP = 15 * 60e3;
/** Five 15-minute latency points: one gap in the main series, one in the compare series, two breaches (45 = warning, 70 = critical). */
const points: ChartPoint[] = [
  { t: T0, v: 10, v2: 12 },
  { t: T0 + STEP, v: 20, v2: null },
  { t: T0 + 2 * STEP, v: null, v2: 14 },
  { t: T0 + 3 * STEP, v: 45, v2: 16 },
  { t: T0 + 4 * STEP, v: 70, v2: 18 },
];

/**
 * jsdom performs no layout, so Recharts' size detector would see a 0 x 0 container and skip the SVG.
 * Give the chart container a real box; every other element (text measurement spans, the legend) gets a small one.
 */
function fakeRect(this: HTMLElement): DOMRect {
  const isChartBox = this.classList.contains("recharts-responsive-container") || this.classList.contains("recharts-wrapper");
  const width = isChartBox ? 800 : 60;
  const height = isChartBox ? 260 : 16;
  return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(fakeRect);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const caption = () => {
  const el = screen.getByRole("figure").querySelector("figcaption");
  if (!el) throw new Error("figure has no figcaption");
  return el;
};

describe("KpiChart text alternative", () => {
  it("wraps the chart in a labelled figure whose caption summarises the points, gaps and breaches", () => {
    render(<KpiChart kpi="latencyMs" points={points} threshold={DEFAULT_THRESHOLDS.latencyMs} />);
    expect(screen.getByRole("figure", { name: "Latency (RTT) chart" })).toHaveClass("chart-figure");
    expect(caption()).toHaveTextContent(/^5 points/);
    expect(caption()).toHaveTextContent(`from ${fmtTime(T0)} to ${fmtTime(T0 + 4 * STEP)} IST`);
    expect(caption()).toHaveTextContent(/min 10\.0, max 70\.0, mean 36\.3 ms/);
    expect(caption()).toHaveTextContent(/1 interval without counters/);
    expect(caption()).toHaveTextContent(/2 threshold breaches/);
    expect(screen.queryByRole("table")).toBeNull(); // the table alternative is opt-in
  });

  it("accepts a custom aria label, mentions the compare series and omits breach counts without a threshold", () => {
    render(<KpiChart kpi="prbUtilizationPct" points={points} ariaLabel="PRB utilization for VSKP-007-N1" compareLabel="VSKP-001-N1" />);
    expect(screen.getByRole("figure", { name: "PRB utilization for VSKP-007-N1" })).toBeInTheDocument();
    expect(caption()).toHaveTextContent(/VSKP-001-N1: mean 15\.0 %/);
    expect(caption()).not.toHaveTextContent(/breach/);
  });

  it("renders a visually hidden data table of the points when showTable is set", () => {
    render(<KpiChart kpi="latencyMs" points={points} seriesLabel="VSKP-007-N1" compareLabel="VSKP-001-N1" showTable />);
    const table = screen.getByRole("table");
    expect(table.closest(".visually-hidden")).not.toBeNull();
    expect(table.querySelector("caption")).toHaveTextContent(/data points/i);
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Time (IST)", "VSKP-007-N1", "VSKP-001-N1"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(5);
    expect(within(rows[2]).getByRole("rowheader")).toHaveTextContent(fmtTime(T0 + 2 * STEP));
    expect(within(rows[2]).getAllByRole("cell").map((c) => c.textContent)).toEqual(["no counters", "14.0"]);
    expect(within(rows[1]).getAllByRole("cell").map((c) => c.textContent)).toEqual(["20.0", "no counters"]);
    expect(within(rows[4]).getAllByRole("cell").map((c) => c.textContent)).toEqual(["70.0", "18.0"]);
  });

  it("shows an empty message instead of a chart when there are no points", () => {
    const { container } = render(<KpiChart kpi="latencyMs" points={[]} threshold={DEFAULT_THRESHOLDS.latencyMs} showTable />);
    expect(screen.getByRole("figure")).toHaveTextContent(/no data points/i);
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("KpiChart drawing", () => {
  it("draws the series, threshold lines, markers, band and breach markers with theme tokens only", () => {
    const { container } = render(
      <KpiChart kpi="latencyMs" points={points} threshold={DEFAULT_THRESHOLDS.latencyMs} compareLabel="Other" bands brush markers={[{ t: T0 + STEP, label: "raised" }]} />,
    );
    const curves = Array.from(container.querySelectorAll("path.recharts-line-curve"));
    expect(curves).toHaveLength(2);
    expect(curves[0].getAttribute("stroke")).toBe("var(--chart-series-1)");
    expect(curves[1].getAttribute("stroke")).toBe("var(--chart-series-2)");
    const refLines = Array.from(container.querySelectorAll(".recharts-reference-line-line")).map((l) => l.getAttribute("stroke"));
    expect(refLines).toHaveLength(3);
    expect(refLines).toEqual(expect.arrayContaining(["var(--chart-warn)", "var(--chart-crit)", "var(--chart-marker)"]));
    expect(container.querySelector(".recharts-reference-area-rect")?.getAttribute("fill")).toBe("var(--chart-band)");
    expect(container.querySelector(".recharts-brush")).not.toBeNull();
    const breaches = Array.from(container.querySelectorAll("path.recharts-symbols"));
    expect(breaches).toHaveLength(2);
    for (const b of breaches) expect(b.getAttribute("fill")).toBe("var(--chart-breach)");
    // the legend names both series
    expect(screen.getByText("Latency (RTT)", { selector: ".recharts-legend-item-text" })).toBeInTheDocument();
    expect(screen.getByText("Other", { selector: ".recharts-legend-item-text" })).toBeInTheDocument();
    // none of the previous hard-coded colours survive in the markup
    expect(container.innerHTML).not.toMatch(/#(?:20808D|A84B2F|A13544|DA7101|7A7974|e6e4de)/i);
  });

  it("keeps the band, brush and legend off by default and honours the height prop (Alarms explain panel usage)", () => {
    const { container } = render(<KpiChart kpi="dlThroughputMbps" points={points} threshold={DEFAULT_THRESHOLDS.dlThroughputMbps} height={220} markers={[{ t: T0, label: "raised" }, { t: T0 + 4 * STEP, label: "cleared" }]} />);
    expect(container.querySelector(".recharts-responsive-container")).toHaveStyle({ height: "220px" });
    expect(container.querySelectorAll("path.recharts-line-curve")).toHaveLength(1);
    expect(container.querySelector(".recharts-reference-area-rect")).toBeNull();
    expect(container.querySelector(".recharts-brush")).toBeNull();
    expect(container.querySelector(".recharts-legend-wrapper")).toBeNull();
    expect(container.querySelectorAll(".recharts-reference-line-line")).toHaveLength(4); // warn + crit + 2 markers
  });
});
