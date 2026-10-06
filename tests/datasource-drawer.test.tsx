import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataSourceDrawer, MAX_IMPORT_FILE_BYTES, type DataSourceDrawerProps, type DataSourceSummary } from "../src/components/DataSourceDrawer";
import type { Dataset } from "../src/lib/synthetic";

// vitest runs from the repository root; jsdom rewrites import.meta.url, so resolve fixtures from the cwd.
const fixtureFile = (name: string) =>
  new File([readFileSync(resolve(process.cwd(), "tests/fixtures/import", name), "utf8")], name, { type: name.endsWith(".json") ? "application/json" : "text/csv" });

const synthetic: DataSourceSummary = { kind: "synthetic", label: "Synthetic dataset", rows: 32_256, cellCount: 48, siteCount: 12, alarmCount: 300 };
const imported: DataSourceSummary = { kind: "imported", label: "kpi_small.csv", rows: 32, cellCount: 4, siteCount: 2, alarmCount: 0 };

function setup(over: Partial<DataSourceDrawerProps> = {}) {
  const onClose = vi.fn();
  const onLoad = vi.fn<(ds: Dataset, label: string, warnings: string[]) => void>();
  const onReset = vi.fn();
  const user = userEvent.setup();
  render(<DataSourceDrawer open onClose={onClose} onLoad={onLoad} onReset={onReset} source={synthetic} {...over} />);
  return { onClose, onLoad, onReset, user };
}

const dropzone = () => screen.getByRole("group", { name: /import files/i });
const useButton = () => screen.getByRole("button", { name: /use dataset/i });
/** Resolves to the summary list once it exists; `field` reads one "label value" pair as text. */
const findSummary = () => screen.findByLabelText(/import summary/i);
const field = (summary: HTMLElement, label: string) => within(summary).getByText(label).parentElement?.textContent ?? "";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DataSourceDrawer", () => {
  it("renders nothing when closed", () => {
    render(<DataSourceDrawer open={false} onClose={() => {}} onLoad={() => {}} onReset={() => {}} source={synthetic} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is a labelled dialog that describes the current synthetic source", () => {
    setup();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName(/data source/i);
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveTextContent(/current source: synthetic dataset/i);
    expect(dialog).toHaveTextContent("32,256 rows");
    expect(within(dialog).queryByRole("button", { name: /back to synthetic/i })).toBeNull();
    expect(useButton()).toBeDisabled();
    expect(within(dialog).getByRole("link", { name: /schema/i })).toHaveAttribute("href", expect.stringContaining("DATA_SCHEMA.md"));
  });

  it("closes on Escape", async () => {
    const { user, onClose } = setup();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("imports a KPI CSV, shows the summary and hands the dataset to onLoad", async () => {
    const { user, onLoad, onClose } = setup();
    await user.upload(screen.getByLabelText(/choose files/i), fixtureFile("kpi_small.csv"));
    const summary = await findSummary();
    expect(field(summary, "Rows")).toBe("Rows32");
    expect(field(summary, "Cells")).toBe("Cells4");
    expect(field(summary, "Sites")).toBe("Sites2");
    expect(field(summary, "Alarms")).toBe("Alarms0");
    expect(field(summary, "Interval")).toBe("Interval15 min");
    expect(field(summary, "Window")).toMatch(/to .* IST$/);
    expect(within(screen.getByRole("list", { name: /selected files/i })).getByText("kpi_small.csv")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/ready to use/i);
    expect(useButton()).toBeEnabled();
    await user.click(useButton());
    expect(onLoad).toHaveBeenCalledTimes(1);
    const [ds, label, warnings] = onLoad.mock.calls[0];
    expect(ds.samples).toHaveLength(32);
    expect(ds.cells).toHaveLength(4);
    expect(ds.sites).toHaveLength(2);
    expect(ds.incidents).toEqual([]);
    expect(label).toBe("kpi_small.csv");
    expect(warnings).toEqual([]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("combines the KPI CSV with cells, sites and alarms files chosen together", async () => {
    const { user, onLoad } = setup();
    await user.upload(screen.getByLabelText(/choose files/i), [fixtureFile("kpi_small.csv"), fixtureFile("cells.json"), fixtureFile("sites.json"), fixtureFile("alarms.csv")]);
    const summary = await findSummary();
    expect(field(summary, "Rows")).toBe("Rows32");
    expect(field(summary, "Alarms")).toBe("Alarms3");
    const list = screen.getByRole("list", { name: /selected files/i });
    for (const name of ["kpi_small.csv", "cells.json", "sites.json", "alarms.csv"]) expect(within(list).getByText(name)).toBeInTheDocument();
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    await user.click(useButton());
    const [ds] = onLoad.mock.calls[0];
    expect(ds.sites.map((s) => s.name)).toEqual(["Harbour", "Hill View"]);
    expect(ds.cells.find((c) => c.cellId === "DEMO-001-L1")?.band).toBe("B20");
    expect(ds.alarms).toHaveLength(3);
  });

  it("lists the problems of kpi_bad.csv and keeps Use dataset disabled", async () => {
    const { user, onLoad } = setup();
    await user.upload(screen.getByLabelText(/choose files/i), fixtureFile("kpi_bad.csv"));
    expect(await screen.findByText(/missing required column "latencyMs"/i)).toBeInTheDocument();
    expect(screen.getByText(/line 3: invalid timestamp "not-a-timestamp"/i)).toBeInTheDocument();
    expect(screen.getByText(/line 4: prbUtilizationPct = 120\.5 is outside 0\.\.100/i)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/2 errors/i);
    expect(useButton()).toBeDisabled();
    await user.click(useButton());
    expect(onLoad).not.toHaveBeenCalled();
  });

  it("offers Back to synthetic for an imported source", async () => {
    const { user, onReset, onClose } = setup({ source: imported });
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/current source: imported dataset "kpi_small\.csv"/i);
    expect(dialog).toHaveTextContent("32 rows");
    await user.click(screen.getByRole("button", { name: /back to synthetic/i }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("accepts dropped files", async () => {
    const { user, onLoad } = setup();
    fireEvent.drop(dropzone(), { dataTransfer: { files: [fixtureFile("kpi_small.csv")], types: ["Files"] } });
    expect(field(await findSummary(), "Rows")).toBe("Rows32");
    await user.click(useButton());
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it("rejects unrecognised and oversized files with a message", async () => {
    setup();
    const huge = new File(["cellId,timestamp"], "huge.csv", { type: "text/csv" });
    Object.defineProperty(huge, "size", { value: MAX_IMPORT_FILE_BYTES + 1 });
    fireEvent.drop(dropzone(), { dataTransfer: { files: [new File(["hello"], "notes.txt", { type: "text/plain" }), huge], types: ["Files"] } });
    expect(await screen.findByText(/notes\.txt: not a recognised file/i)).toBeInTheDocument();
    expect(screen.getByText(/huge\.csv: too large/i)).toBeInTheDocument();
    expect(useButton()).toBeDisabled();
  });

  it("asks for the KPI CSV when only companion files are given", async () => {
    const { user } = setup();
    await user.upload(screen.getByLabelText(/choose files/i), fixtureFile("cells.json"));
    expect(await screen.findByText(/add the kpi csv/i)).toBeInTheDocument();
    expect(useButton()).toBeDisabled();
  });

  it("clears the selection", async () => {
    const { user } = setup();
    await user.upload(screen.getByLabelText(/choose files/i), fixtureFile("kpi_small.csv"));
    await findSummary();
    await user.click(screen.getByRole("button", { name: /clear/i }));
    expect(screen.queryByLabelText(/import summary/i)).toBeNull();
    expect(screen.queryByRole("list", { name: /selected files/i })).toBeNull();
    expect(useButton()).toBeDisabled();
  });

  it("downloads a sample CSV", async () => {
    const { user } = setup();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await user.click(screen.getByRole("button", { name: /download sample csv/i }));
    expect(click).toHaveBeenCalledTimes(1);
  });
});
