import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppProvider } from "../src/state";
import { Alarms } from "../src/pages/Alarms";
import { generateDataset } from "../src/lib/synthetic";
import * as csv from "../src/lib/csv";

vi.mock("../src/lib/csv", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/csv")>();
  return { ...mod, downloadText: vi.fn() };
});

const data = generateDataset();
const downloadText = vi.mocked(csv.downloadText);

function mount(hash = "#/alarms") {
  window.location.hash = hash;
  return render(<AppProvider><Alarms /></AppProvider>);
}
function alarmTable(): HTMLElement {
  return screen.getByRole("table", { name: /alarms/i });
}
function dataRows(): HTMLElement[] {
  return within(alarmTable()).getAllByRole("row").slice(1);
}
function explainPanel(): HTMLElement {
  const heading = screen.getByRole("heading", { name: /^Explain/ });
  const section = heading.closest("section");
  if (!section) throw new Error("explain panel has no card section");
  return section;
}
function lastDownload(): { filename: string; text: string } {
  const call = downloadText.mock.calls.at(-1);
  if (!call) throw new Error("downloadText was not called");
  return { filename: String(call[0]), text: String(call[1]) };
}

beforeEach(() => {
  downloadText.mockClear();
  vi.restoreAllMocks();
});

describe("Alarms page — table, filters, pagination", () => {
  it("shows at most 50 rows per page with a page indicator and a row count in the heading", () => {
    mount();
    expect(screen.getByRole("heading", { name: "Alarm list (300)" })).toBeInTheDocument();
    expect(dataRows().length).toBeLessThanOrEqual(50);
    expect(dataRows()).toHaveLength(50);
    expect(screen.getByText(/page 1 of 6/i)).toBeInTheDocument();
  });

  it("narrows the rows when a severity is picked and writes the filter to the URL", async () => {
    const user = userEvent.setup();
    mount();
    const critical = data.alarms.filter((a) => a.severity === "Critical").length;
    await user.selectOptions(screen.getByLabelText("Severity filter"), "Critical");
    expect(window.location.hash).toContain("severity=Critical");
    expect(screen.getByRole("heading", { name: `Alarm list (${critical})` })).toBeInTheDocument();
    expect(dataRows()).toHaveLength(critical);
    expect(dataRows()[0]).toHaveTextContent("ALM-000001");
  });

  it("reads severity, state, site and text filters from the URL (deep link)", () => {
    const n = data.alarms.filter((a) => a.severity === "Minor" && a.state === "cleared" && a.siteId === "VSKP-004").length;
    expect(n).toBeGreaterThan(0);
    mount("#/alarms?severity=Minor&state=cleared&site=VSKP-004");
    expect(screen.getByRole("heading", { name: `Alarm list (${n})` })).toBeInTheDocument();
    expect(screen.getByLabelText("Severity filter")).toHaveValue("Minor");
    expect(screen.getByLabelText("Site filter")).toHaveValue("VSKP-004");
  });

  it("applies the text filter from the URL and shows an empty state when nothing matches", () => {
    mount("#/alarms?q=zzzz-nothing");
    expect(screen.getByRole("heading", { name: "Alarm list (0)" })).toBeInTheDocument();
    expect(screen.getByText(/no alarms match the current filters/i)).toBeInTheDocument();
  });

  it("filters live while typing in the search box and commits the text to the URL on Enter", async () => {
    const user = userEvent.setup();
    mount();
    const doorOpen = data.alarms.filter((a) => a.probableCause === "Door open").length;
    expect(doorOpen).toBeGreaterThan(0);
    await user.type(screen.getByLabelText("Search alarms"), "door open");
    expect(screen.getByRole("heading", { name: `Alarm list (${doorOpen})` })).toBeInTheDocument();
    expect(window.location.hash).not.toContain("q=");
    await user.keyboard("{Enter}");
    expect(decodeURIComponent(window.location.hash.replace(/\+/g, " "))).toContain("q=door open");
    expect(screen.getByRole("heading", { name: `Alarm list (${doorOpen})` })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(window.location.hash).not.toContain("q=");
    expect(screen.getByRole("heading", { name: "Alarm list (300)" })).toBeInTheDocument();
  });

  it("ignores unknown filter values and says so in a notice", () => {
    mount("#/alarms?severity=Bogus&sort=nope&state=weird");
    expect(screen.getByRole("heading", { name: "Alarm list (300)" })).toBeInTheDocument();
    expect(screen.getByText(/ignored unknown filter value/i)).toHaveTextContent("severity");
  });

  it("moves to the next page through the URL and clamps out-of-range pages", async () => {
    const user = userEvent.setup();
    mount();
    const firstOnPage1 = dataRows()[0].textContent;
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(window.location.hash).toContain("page=2");
    expect(screen.getByText(/page 2 of 6/i)).toBeInTheDocument();
    expect(dataRows()[0].textContent).not.toBe(firstOnPage1);
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();

    mount("#/alarms?page=99");
    expect(screen.getAllByText(/page 6 of 6/i).length).toBeGreaterThan(0);
  });

  it("sorts by severity (most severe first) when the column header is clicked and flips on the second click", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: /^Severity/ }));
    expect(window.location.hash).toContain("sort=severity");
    expect(dataRows()[0]).toHaveTextContent("Critical");
    expect(screen.getByRole("columnheader", { name: /^Severity/ })).toHaveAttribute("aria-sort", "descending");
    await user.click(screen.getByRole("button", { name: /^Severity/ }));
    expect(dataRows()[0]).toHaveTextContent("Warning");
    expect(screen.getByRole("columnheader", { name: /^Severity/ })).toHaveAttribute("aria-sort", "ascending");
  });
});

describe("Alarms page — selection and Explain panel", () => {
  it("shows the strong correlation verdict for ALM-000002 when it is selected through the URL", () => {
    mount("#/alarms?alarm=ALM-000002");
    const panel = explainPanel();
    expect(within(panel).getByRole("heading", { name: /Explain ALM-000002/ })).toBeInTheDocument();
    expect(within(panel).getByText("strong")).toBeInTheDocument();
    expect(within(panel).getAllByText(/PRB utilization/).length).toBeGreaterThan(0);
    expect(within(panel).getAllByText(/baseline/i).length).toBeGreaterThan(0);
    expect(within(panel).getByText(/score 0\.\d\d/)).toBeInTheDocument();
    expect(within(panel).getAllByText("congestion").length).toBeGreaterThan(0);
    expect(within(panel).getAllByText(/VSKP-007-N1/).length).toBeGreaterThan(0);
  });

  it("explains a cleared site-level alarm with baseline, during and after values and a recovery", () => {
    mount("#/alarms?alarm=ALM-000003");
    const panel = explainPanel();
    expect(within(panel).getByText("strong")).toBeInTheDocument();
    expect(within(panel).getAllByText(/Latency/).length).toBeGreaterThan(0);
    expect(within(panel).getAllByText(/4 cells/).length).toBeGreaterThan(0);
    const metrics = within(panel).getByRole("list", { name: "Correlation metrics" });
    expect(within(metrics).getByText("After (2 h)")).toBeInTheDocument();
    expect(within(metrics).getByText("Baseline (2 h before)")).toBeInTheDocument();
    expect(within(metrics).getByText("During alarm")).toBeInTheDocument();
    // the three window values are real numbers in ms and the recovery value is well below the during value
    const values = within(metrics).getAllByText(/^\d+(\.\d+)? ms$/).map((el) => parseFloat(el.textContent ?? "0"));
    expect(values.length).toBeGreaterThanOrEqual(3);
    const [baseline, during, after] = values;
    expect(during).toBeGreaterThan(baseline * 3);
    expect(after).toBeLessThan(during / 2);
    expect(within(panel).getByRole("button", { name: "Reopen" })).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Ack" })).toBeNull();
  });

  it("selects a row on click, marks it aria-selected and shows a verdict badge for non-cleared rows", async () => {
    const user = userEvent.setup();
    mount("#/alarms?severity=Major&state=active");
    const row = screen.getByText("ALM-000002").closest("tr");
    if (!row) throw new Error("row not found");
    expect(within(row).getByText("strong")).toBeInTheDocument();
    await user.click(row);
    expect(window.location.hash).toContain("alarm=ALM-000002");
    expect(row).toHaveAttribute("aria-selected", "true");
    expect(within(explainPanel()).getByRole("heading", { name: /Explain ALM-000002/ })).toBeInTheDocument();
  });

  it("supports keyboard navigation: rows are focusable, arrows move focus and Enter selects", async () => {
    const user = userEvent.setup();
    mount();
    const rows = dataRows();
    rows[0].focus();
    expect(rows[0]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(rows[1]).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(rows[1]).toHaveAttribute("aria-selected", "true");
    expect(rows[0]).toHaveAttribute("aria-selected", "false");
    await user.keyboard("{ArrowUp}");
    expect(rows[0]).toHaveFocus();
  });

  it("shows an empty explain panel for an unknown alarm id", () => {
    mount("#/alarms?alarm=ALM-999999");
    expect(screen.getByText(/ALM-999999/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Explain ALM-999999/ })).toBeNull();
  });
});

describe("Alarms page — operator actions and audit", () => {
  it("Ack on an active alarm adds an audit entry and changes the row state", async () => {
    const user = userEvent.setup();
    mount("#/alarms?state=active");
    const before = data.alarms.filter((a) => a.state === "active").length;
    expect(screen.getByRole("heading", { name: `Alarm list (${before})` })).toBeInTheDocument();
    const firstRow = dataRows()[0];
    const id = within(firstRow).getByText(/^ALM-\d{6}$/).textContent;
    await user.click(within(firstRow).getByRole("button", { name: "Ack" }));
    expect(screen.getByRole("heading", { name: "Audit trail (1)" })).toBeInTheDocument();
    const audit = screen.getByRole("list", { name: /audit/i });
    expect(within(audit).getByText(/acknowledge/)).toBeInTheDocument();
    expect(within(audit).getByText(id ?? "")).toBeInTheDocument();
    // the acknowledged alarm leaves the "active" view
    expect(screen.getByRole("heading", { name: `Alarm list (${before - 1})` })).toBeInTheDocument();
  });

  it("reopens a cleared alarm from the Explain panel with a note that shows up in the audit", async () => {
    const user = userEvent.setup();
    mount("#/alarms?alarm=ALM-000001");
    const panel = explainPanel();
    await user.type(within(panel).getByLabelText(/note/i), "fault came back");
    await user.click(within(panel).getByRole("button", { name: "Reopen" }));
    const audit = screen.getByRole("list", { name: /audit/i });
    expect(within(audit).getByText(/reopen/)).toBeInTheDocument();
    expect(within(audit).getByText(/fault came back/)).toBeInTheDocument();
    expect(within(explainPanel()).getByText("active")).toBeInTheDocument();
    expect(within(explainPanel()).getByLabelText(/note/i)).toHaveValue("");
  });

  it("acknowledges all filtered active alarms after confirmation", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    mount("#/alarms?state=active");
    const active = data.alarms.filter((a) => a.state === "active").length;
    await user.click(screen.getByRole("button", { name: `Acknowledge all filtered active (${active})` }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: `Audit trail (${active})` })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Alarm list (0)" })).toBeInTheDocument();
  });

  it("does nothing when the bulk confirmation is declined", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    mount("#/alarms?state=active");
    await user.click(screen.getByRole("button", { name: /Acknowledge all filtered active/ }));
    expect(screen.getByRole("heading", { name: "Audit trail (0)" })).toBeInTheDocument();
  });

  it("exports the filtered alarms as CSV with a correlation column", async () => {
    const user = userEvent.setup();
    mount("#/alarms?severity=Critical");
    await user.click(screen.getByRole("button", { name: "Export CSV" }));
    const { filename, text } = lastDownload();
    expect(filename).toBe("alarms.csv");
    const lines = text.split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0].split(",")).toContain("correlation");
    expect(lines[1]).toContain("ALM-000001");
    expect(lines[1]).toContain("strong");
  });

  it("exports and clears the audit trail", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mount("#/alarms?state=active");
    await user.click(within(dataRows()[0]).getByRole("button", { name: "Ack" }));
    await user.click(screen.getByRole("button", { name: "Export audit CSV" }));
    const { filename, text } = lastDownload();
    expect(filename).toMatch(/audit/);
    expect(text.split("\r\n")[0]).toBe("at,alarmId,action,note");
    expect(text.split("\r\n")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Clear audit" }));
    expect(screen.getByRole("heading", { name: "Audit trail (0)" })).toBeInTheDocument();
  });
});
