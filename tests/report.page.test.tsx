import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppProvider, useApp, type AppState } from "../src/state";
import { Report } from "../src/pages/Report";
import { MAX_ALARM_LINES, REPORT_NOTES_KEY } from "../src/lib/report";
import { generateDataset, type Dataset } from "../src/lib/synthetic";
import * as csv from "../src/lib/csv";

vi.mock("../src/lib/csv", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/csv")>();
  return { ...mod, downloadText: vi.fn() };
});

const downloadText = vi.mocked(csv.downloadText);
const data = generateDataset();

/* ---------- harness: real provider + Report page, with access to the context for loadDataset ---------- */

function Harness({ onApp }: { onApp: (s: AppState) => void }) {
  onApp(useApp());
  return <Report />;
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

const preview = () => screen.getByRole("article", { name: "Report preview" });
/** The elements between a level-2 preview heading and the next one. */
function sectionOf(name: string): HTMLElement {
  const heading = within(preview()).getByRole("heading", { level: 2, name });
  const section = heading.closest("section");
  if (!section) throw new Error(`heading ${name} is not inside a section`);
  return section;
}
function downloads(): { filename: string; text: string; mime: string | undefined }[] {
  return downloadText.mock.calls.map((c) => ({ filename: String(c[0]), text: String(c[1]), mime: c[2] }));
}

const emptyDataset: Dataset = {
  sites: [], cells: [], samples: [], alarms: [], packetStats: [], conversations: [], incidents: [],
  tcpSummary: { packets: 0, retransmissions: 0, retransmissionPct: 0, rttAvgMs: 0, rttP95Ms: 0 },
};

beforeEach(() => {
  downloadText.mockClear();
  vi.restoreAllMocks();
});

describe("Report page — preview", () => {
  it("renders the page head and a semantic preview with every section for the synthetic 24h window", () => {
    mount("#/report?range=24h&tech=All");
    expect(screen.getByRole("heading", { level: 1, name: "Shift handover report" })).toBeInTheDocument();
    expect(screen.getByText(/window 24h ending 23 Sep.* 14:30 IST/)).toBeInTheDocument();
    for (const name of ["Window", "KPIs", "Detections", "Worst cells", "Alarms", "Notes"]) {
      expect(within(preview()).getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
    // no HTML strings: the preview is made of real tables
    const kpis = within(sectionOf("KPIs")).getByRole("table", { name: "Network KPIs" });
    const rows = within(kpis).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(7);
    expect(rows[0]).toHaveTextContent(/^Call drop rate/);
    expect(rows[0]).toHaveTextContent(/\d+\.\d\d %/);
    expect(within(rows[0]).getByText(/^(OK|Warning|Critical)$/)).toHaveClass("badge");
    const windowTable = within(sectionOf("Window")).getByRole("table", { name: "Report window" });
    expect(windowTable).toHaveTextContent(/Range24h/);
    expect(windowTable).toHaveTextContent(/TechnologyAll/);
    expect(windowTable).toHaveTextContent(/Synthetic dataset/);
    expect(within(sectionOf("Notes")).getByText("(none)")).toBeInTheDocument();
    // the on-screen controls are hidden when printing; the generation line only prints
    for (const name of ["Download Markdown", "Download CSV sections", "Copy Markdown", "Print"]) {
      expect(screen.getByRole("button", { name }).closest(".no-print")).not.toBeNull();
    }
    expect(screen.getByText(/^Generated /).className).toContain("print-only");
  });

  it("lists the 7-day detections, ten worst cells and truncated alarm lists with filter-preserving links", () => {
    mount("#/report?range=7d&tech=All");
    const detections = sectionOf("Detections");
    expect(within(detections).getByRole("link", { name: "VSKP-004-L2" })).toHaveAttribute("href", "#/kpis?cell=VSKP-004-L2&kpi=dlThroughputMbps&range=7d&tech=All");
    expect(within(detections).getAllByText("outage")[0]).toHaveClass("badge", "kind-outage");
    expect(within(detections).getAllByRole("link", { name: "VSKP-007-N1" }).length).toBeGreaterThan(0);
    const worst = within(sectionOf("Worst cells")).getByRole("table", { name: "Worst cells by call drop rate" });
    expect(within(worst).getAllByRole("row").slice(1)).toHaveLength(10);
    const alarms = sectionOf("Alarms");
    expect(within(alarms).getByRole("heading", { level: 3, name: `Raised in window (${data.alarms.length})` })).toBeInTheDocument();
    const raised = within(alarms).getByRole("table", { name: "Alarms raised in window" });
    expect(within(raised).getAllByRole("row").slice(1)).toHaveLength(MAX_ALARM_LINES);
    expect(within(alarms).getByText(`… and ${data.alarms.length - MAX_ALARM_LINES} more; the CSV export holds the full list.`)).toBeInTheDocument();
    const newest = data.alarms[0];
    expect(within(raised).getByRole("link", { name: newest.alarmId })).toHaveAttribute("href", `#/alarms?alarm=${newest.alarmId}&range=7d&tech=All`);
    expect(within(alarms).getByRole("heading", { level: 3, name: /^Cleared in window \(\d+\)$/ })).toBeInTheDocument();
    expect(within(alarms).getByRole("table", { name: "Alarm counts" })).toHaveTextContent(/Active\d+/);
  });

  it("renders an alarms-only report with a warning when the window holds no samples", () => {
    const { app } = mount("#/report?range=24h");
    act(() => app().loadDataset(emptyDataset, "empty.csv"));
    expect(screen.getByRole("heading", { level: 1, name: "Shift handover report" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/No KPI samples in this window/);
    const rows = within(within(sectionOf("KPIs")).getByRole("table", { name: "Network KPIs" })).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(7);
    for (const row of rows) expect(row).toHaveTextContent(/–/);
    expect(within(sectionOf("Detections")).getByText("No rule-based detections in this window.")).toBeInTheDocument();
    expect(within(sectionOf("Worst cells")).getByText("No cells reported samples in this window.")).toBeInTheDocument();
    expect(within(sectionOf("Alarms")).getByText("No alarms raised in this window.")).toBeInTheDocument();
    // the imported label is reported as the source, in the Window table and in the print footer
    expect(within(sectionOf("Window")).getByRole("table", { name: "Report window" })).toHaveTextContent(/Sourceempty\.csv \(imported\)/);
    expect(screen.getByText(/^Generated /)).toHaveTextContent(/empty\.csv$/);
  });

  it("the preview's scrollable table wrappers are keyboard-focusable named regions", () => {
    /** The scroll container around a preview table: reachable with Tab, named, and not echoing the table's own label. */
    const scrollRegion = (name: RegExp): HTMLElement => {
      const region = within(preview()).getByRole("region", { name });
      expect(region).toHaveAttribute("tabindex", "0");
      const table = within(region).getByRole("table");
      expect(region.getAttribute("aria-label")).not.toBe(table.getAttribute("aria-label"));
      return region;
    };
    const first = mount("#/report?range=7d&tech=All");
    for (const name of [/report window/i, /network kpis/i, /worst cells/i, /alarm counts/i, /alarms raised in window/i, /alarms cleared in window/i]) scrollRegion(name);
    expect(preview().querySelectorAll('[role="region"]')).toHaveLength(6);
    first.unmount();

    // without a table there is no scroll container, so no dead tab stop is left behind
    const { app } = mount("#/report?range=24h");
    act(() => app().loadDataset(emptyDataset, "empty.csv"));
    for (const name of [/report window/i, /network kpis/i, /alarm counts/i]) scrollRegion(name);
    for (const name of [/worst cells/i, /alarms raised in window/i, /alarms cleared in window/i]) {
      expect(within(preview()).queryByRole("region", { name })).toBeNull();
    }
    expect(preview().querySelectorAll('[role="region"]')).toHaveLength(3);
  });
});

describe("Report page — notes and actions", () => {
  it("persists handover notes in localStorage, includes them in the preview and restores them on remount", async () => {
    const user = userEvent.setup();
    const first = mount("#/report?range=24h");
    const notes = () => screen.getByRole("textbox", { name: /handover notes/i });
    expect(notes()).toHaveValue("");
    await user.type(notes(), "Watch VSKP-007-N1 tonight");
    expect(localStorage.getItem(REPORT_NOTES_KEY)).toBe("Watch VSKP-007-N1 tonight");
    expect(within(sectionOf("Notes")).getByText("Watch VSKP-007-N1 tonight")).toBeInTheDocument();
    first.unmount();
    mount("#/report?range=24h");
    expect(notes()).toHaveValue("Watch VSKP-007-N1 tonight");
    await user.click(screen.getByRole("button", { name: "Clear notes" }));
    expect(notes()).toHaveValue("");
    expect(localStorage.getItem(REPORT_NOTES_KEY)).toBeNull();
    expect(within(sectionOf("Notes")).getByText("(none)")).toBeInTheDocument();
  });

  it("downloads the Markdown report with an IST-stamped .md file name", async () => {
    const user = userEvent.setup();
    localStorage.setItem(REPORT_NOTES_KEY, "Handed over to the night shift.");
    mount("#/report?range=7d&tech=NR");
    await user.click(screen.getByRole("button", { name: "Download Markdown" }));
    expect(downloads()).toHaveLength(1);
    const [md] = downloads();
    expect(md.filename).toBe("shift-report_20260923-1430_7d_NR.md");
    expect(md.mime).toBe("text/markdown;charset=utf-8");
    expect(md.text.startsWith("# Shift handover report\n")).toBe(true);
    expect(md.text).toContain("| Technology | NR |");
    expect(md.text).toContain("\n## Detections\n");
    expect(md.text).toContain("\n## Worst cells\n");
    expect(md.text).toContain("| congestion | VSKP-007-N1 |");
    expect(md.text).toContain("Handed over to the night shift.");
  });

  it("downloads one CSV file per report section", async () => {
    const user = userEvent.setup();
    mount("#/report?range=24h&tech=All");
    await user.click(screen.getByRole("button", { name: "Download CSV sections" }));
    expect(downloads().map((d) => d.filename)).toEqual([
      "shift-report_20260923-1430_24h_All_kpis.csv",
      "shift-report_20260923-1430_24h_All_detections.csv",
      "shift-report_20260923-1430_24h_All_worst_cells.csv",
      "shift-report_20260923-1430_24h_All_alarms_raised.csv",
      "shift-report_20260923-1430_24h_All_alarms_cleared.csv",
    ]);
    expect(downloads()[0].text.split("\r\n")[0]).toBe("kpi,label,unit,value,previous,deltaPct,level");
    expect(downloads()[0].text.split("\r\n")).toHaveLength(8);
    for (const d of downloads()) expect(d.mime).toBeUndefined(); // the CSV default of downloadText
  });

  it("copies the Markdown to the clipboard and falls back to a message when the clipboard is unavailable", async () => {
    const user = userEvent.setup(); // installs a clipboard stub on navigator
    mount("#/report?range=24h&tech=All");
    await user.click(screen.getByRole("button", { name: "Copy Markdown" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Markdown copied to the clipboard.");
    await user.click(screen.getByRole("button", { name: "Download Markdown" }));
    expect(await navigator.clipboard.readText()).toBe(downloads()[0].text);

    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    try {
      await user.click(screen.getByRole("button", { name: "Copy Markdown" }));
      expect(screen.getByRole("status")).toHaveTextContent(/Clipboard access is unavailable/);
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else delete (navigator as unknown as Record<string, unknown>).clipboard;
    }
  });

  it("prints through window.print", async () => {
    const user = userEvent.setup();
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    mount("#/report?range=24h");
    await user.click(screen.getByRole("button", { name: "Print" }));
    expect(print).toHaveBeenCalledTimes(1);
  });
});
