import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppProvider, useApp } from "../src/state";
import { ThresholdDrawer } from "../src/components/ThresholdDrawer";
import { DEFAULT_THRESHOLDS, THRESHOLDS_KEY, THRESHOLD_PRESETS, thresholdsToJson, type Thresholds } from "../src/lib/thresholds";
import * as csv from "../src/lib/csv";

vi.mock("../src/lib/csv", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/csv")>();
  return { ...mod, downloadText: vi.fn() };
});
const downloadText = vi.mocked(csv.downloadText);

/** Exposes the thresholds the rest of the app sees, so persistence can be checked independently of the inputs. */
function Probe() {
  const { thresholds } = useApp();
  return <output data-testid="prb">{JSON.stringify(thresholds.prbUtilizationPct)}</output>;
}

function mount(open = true) {
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(
    <AppProvider>
      <button>Before</button>
      <ThresholdDrawer open={open} onClose={onClose} />
      <Probe />
    </AppProvider>,
  );
  return { onClose, user };
}

const dialog = () => screen.getByRole("dialog");
const field = (name: string) => within(dialog()).getByLabelText(name) as HTMLInputElement;
const applied = () => JSON.parse(screen.getByTestId("prb").textContent ?? "null") as Thresholds["prbUtilizationPct"];
const stored = (): Thresholds | null => {
  const raw = localStorage.getItem(THRESHOLDS_KEY);
  return raw === null ? null : (JSON.parse(raw) as Thresholds);
};

beforeEach(() => {
  downloadText.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("ThresholdDrawer dialog", () => {
  it("renders nothing while closed", () => {
    mount(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/KPI thresholds/)).toBeNull();
  });

  it("is a modal dialog titled 'KPI thresholds' with a labelled input per threshold", async () => {
    const { user, onClose } = mount();
    expect(dialog()).toHaveAttribute("aria-modal", "true");
    expect(dialog()).toHaveAccessibleName("KPI thresholds");
    expect(within(dialog()).getByRole("heading", { name: /thresholds/i })).toBeInTheDocument();
    const inputs = within(dialog()).getAllByRole("spinbutton");
    expect(inputs).toHaveLength(16); // 8 KPIs x warning + critical
    for (const input of inputs) expect(input).toHaveAccessibleName(/(warning|critical)$/);
    expect(field("PRB utilization (%) warning")).toHaveValue(70);
    expect(field("PRB utilization (%) critical")).toHaveValue(85);
    expect(field("DL throughput NR (Mbps) critical")).toHaveValue(40);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("ThresholdDrawer editing", () => {
  it("persists a valid edit, then keeps the last valid value when the field is cleared and shows an inline error", async () => {
    const { user } = mount();
    const critical = field("PRB utilization (%) critical");
    await user.clear(critical);
    await user.type(critical, "90");
    expect(applied()).toEqual({ warning: 70, critical: 90, direction: "above" });
    expect(stored()?.prbUtilizationPct.critical).toBe(90);

    await user.clear(critical);
    expect(critical).toHaveValue(null);
    expect(critical).toHaveAttribute("aria-invalid", "true");
    const error = within(dialog()).getByText(/enter a number/i);
    expect(error).toHaveClass("field-error");
    expect(critical.getAttribute("aria-describedby")).toBe(error.id);
    // nothing was persisted as 0 or NaN: the previous critical value survives everywhere
    expect(applied()).toEqual({ warning: 70, critical: 90, direction: "above" });
    expect(stored()?.prbUtilizationPct.critical).toBe(90);

    await user.type(critical, "95");
    expect(within(dialog()).queryByText(/enter a number/i)).toBeNull();
    expect(critical).not.toHaveAttribute("aria-invalid", "true");
    expect(applied()).toEqual({ warning: 70, critical: 95, direction: "above" });
    expect(stored()?.prbUtilizationPct.critical).toBe(95);
  });

  it("flags a warning/critical pair in the wrong order for the KPI's direction and does not persist it", async () => {
    const { user } = mount();
    const critical = field("PRB utilization (%) critical");
    await user.clear(critical);
    await user.type(critical, "60"); // below the warning 70 (and so is the intermediate "6"): never a valid pair for an "above" KPI
    expect(within(dialog()).getByText(/warning must be below critical/i)).toHaveClass("field-error");
    expect(critical).toHaveAttribute("aria-invalid", "true");
    expect(field("PRB utilization (%) warning")).toHaveAttribute("aria-invalid", "true"); // the pair is wrong, both fields are flagged
    expect(applied()).toEqual(DEFAULT_THRESHOLDS.prbUtilizationPct);
    expect(stored()).toBeNull();

    const rrcWarning = field("RRC setup success (%) warning");
    await user.clear(rrcWarning);
    await user.type(rrcWarning, "90"); // below the critical 95: wrong for a "below" KPI
    expect(within(dialog()).getByText(/warning must be above critical/i)).toHaveClass("field-error");
    expect(stored()).toBeNull();

    await user.clear(critical);
    await user.type(critical, "95");
    expect(within(dialog()).queryByText(/warning must be below critical/i)).toBeNull();
    expect(critical).not.toHaveAttribute("aria-invalid", "true");
    expect(applied()).toEqual({ warning: 70, critical: 95, direction: "above" });
    expect(stored()?.prbUtilizationPct).toEqual({ warning: 70, critical: 95, direction: "above" });
    expect(stored()?.rrcSetupSuccessPct).toEqual(DEFAULT_THRESHOLDS.rrcSetupSuccessPct); // the invalid RRC pair was never saved
    expect(within(dialog()).getByText(/warning must be above critical/i)).toBeInTheDocument(); // and is still flagged
  });

  it("applies a preset to every input and persists it", async () => {
    const { user } = mount();
    const preset = within(dialog()).getByLabelText("Preset");
    expect(preset).toHaveValue("default");
    await user.selectOptions(preset, "strict");
    expect(field("PRB utilization (%) warning")).toHaveValue(THRESHOLD_PRESETS.strict.prbUtilizationPct.warning);
    expect(field("PRB utilization (%) critical")).toHaveValue(THRESHOLD_PRESETS.strict.prbUtilizationPct.critical);
    expect(field("Latency (ms) critical")).toHaveValue(THRESHOLD_PRESETS.strict.latencyMs.critical);
    expect(applied()).toEqual(THRESHOLD_PRESETS.strict.prbUtilizationPct);
    expect(stored()).toEqual(THRESHOLD_PRESETS.strict);
    // editing a value leaves the preset list on "custom"
    const critical = field("PRB utilization (%) critical");
    await user.clear(critical);
    await user.type(critical, "77");
    expect(within(dialog()).getByLabelText("Preset")).toHaveValue("custom");
  });

  it("exports the current thresholds as pretty JSON", async () => {
    const { user } = mount();
    await user.selectOptions(within(dialog()).getByLabelText("Preset"), "lenient");
    await user.click(within(dialog()).getByRole("button", { name: /export json/i }));
    expect(downloadText).toHaveBeenCalledTimes(1);
    const [filename, text, mime] = downloadText.mock.calls[0];
    expect(filename).toBe("kpi-thresholds.json");
    expect(text).toBe(thresholdsToJson(THRESHOLD_PRESETS.lenient));
    expect(String(mime)).toMatch(/json/);
  });

  it("imports a JSON file, reports its problems and keeps the last valid thresholds on failure", async () => {
    const { user } = mount();
    const input = within(dialog()).getByLabelText(/import json/i);
    await user.upload(input, new File([thresholdsToJson(THRESHOLD_PRESETS.strict)], "strict.json", { type: "application/json" }));
    expect(await within(dialog()).findByText(/imported .*strict\.json/i)).toBeInTheDocument();
    expect(field("PRB utilization (%) critical")).toHaveValue(THRESHOLD_PRESETS.strict.prbUtilizationPct.critical);
    expect(stored()).toEqual(THRESHOLD_PRESETS.strict);

    const bad = JSON.stringify({ prbUtilizationPct: { warning: 95, critical: 85 }, latencyMs: { warning: "", critical: 60 } });
    await user.upload(input, new File([bad], "bad.json", { type: "application/json" }));
    const alert = await within(dialog()).findByRole("alert");
    expect(alert).toHaveTextContent(/bad\.json/);
    expect(alert).toHaveTextContent(/PRB utilization/);
    expect(alert).toHaveTextContent(/Latency/);
    expect(stored()).toEqual(THRESHOLD_PRESETS.strict);
    expect(field("PRB utilization (%) critical")).toHaveValue(THRESHOLD_PRESETS.strict.prbUtilizationPct.critical);

    await user.upload(input, new File(["{not json"], "broken.json", { type: "application/json" }));
    expect(await within(dialog()).findByText(/not valid JSON/i)).toBeInTheDocument();
    expect(stored()).toEqual(THRESHOLD_PRESETS.strict);
  });

  it("resets to the defaults only after confirmation", async () => {
    const { user } = mount();
    await user.selectOptions(within(dialog()).getByLabelText("Preset"), "strict");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.click(within(dialog()).getByRole("button", { name: /reset to defaults/i }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(applied()).toEqual(THRESHOLD_PRESETS.strict.prbUtilizationPct);
    expect(stored()).toEqual(THRESHOLD_PRESETS.strict);

    confirm.mockReturnValue(true);
    await user.click(within(dialog()).getByRole("button", { name: /reset to defaults/i }));
    expect(applied()).toEqual(DEFAULT_THRESHOLDS.prbUtilizationPct);
    expect(field("PRB utilization (%) critical")).toHaveValue(85);
    expect(stored()).toBeNull();
    expect(within(dialog()).getByLabelText("Preset")).toHaveValue("default");
  });
});
