import { describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { AppProvider, useApp, type AppState } from "../src/state";
import { DATASET_END, DATASET_START, type Dataset } from "../src/lib/synthetic";
import { DEFAULT_THRESHOLDS } from "../src/lib/thresholds";
import type { Alarm, KpiSample } from "../src/types/telecom";

const FILTERS_KEY = "tkm.filters.v1";
const SYNTHETIC_SAMPLES = 7 * 96 * 48; // 32,256

function Probe({ onState }: { onState: (s: AppState) => void }) {
  onState(useApp());
  return null;
}

/** Mount the provider at the given location hash and return an accessor for the latest context value. */
function mount(hash = ""): () => AppState {
  window.location.hash = hash;
  const holder: { current: AppState | null } = { current: null };
  render(
    <AppProvider>
      <Probe onState={(s) => { holder.current = s; }} />
    </AppProvider>,
  );
  return () => {
    if (!holder.current) throw new Error("provider did not render");
    return holder.current;
  };
}

function storedFilters(): unknown {
  const raw = localStorage.getItem(FILTERS_KEY);
  return raw === null ? null : JSON.parse(raw);
}

function storageKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k !== null) keys.push(k);
  }
  return keys;
}

// --- hand-made import fixture: 1 site, 2 cells, 5 samples (deliberately not in chronological order) ---
const T0 = Date.UTC(2026, 0, 10, 0, 0, 0);
const STEP = 15 * 60e3;
function sample(cellId: string, i: number, activeUsers: number): KpiSample {
  return {
    cellId, timestamp: new Date(T0 + i * STEP).toISOString(),
    callDropRatePct: 0.5, rrcSetupSuccessPct: 99.1, handoverSuccessPct: 98.2, dlThroughputMbps: 30, ulThroughputMbps: 8,
    latencyMs: 25, prbUtilizationPct: 40, rsrpAvgDbm: -95, sinrAvgDb: 12, activeUsers,
  };
}
const smallDataset: Dataset = {
  sites: [{ siteId: "SITE-1", name: "Test site", lat: 17.7, lon: 83.2, region: "Test region" }],
  cells: [
    { cellId: "SITE-1-L1", siteId: "SITE-1", technology: "LTE", band: "B3", bandwidthMHz: 20, azimuthDeg: 0 },
    { cellId: "SITE-1-N1", siteId: "SITE-1", technology: "NR", band: "n78", bandwidthMHz: 100, azimuthDeg: 0 },
  ],
  samples: [sample("SITE-1-L1", 2, 60), sample("SITE-1-N1", 0, 80), sample("SITE-1-L1", 0, 50), sample("SITE-1-N1", 1, 90), sample("SITE-1-L1", 1, 55)],
  alarms: [],
  packetStats: [],
  conversations: [],
  incidents: [],
  tcpSummary: { packets: 0, retransmissions: 0, retransmissionPct: 0, rttAvgMs: 0, rttP95Ms: 0 },
};
const IMPORT_START = T0;
const IMPORT_END = T0 + 2 * STEP;
/** Imported alarm that deliberately reuses a synthetic alarm id. */
const importedAlarm: Alarm = { alarmId: "ALM-000002", timestamp: new Date(T0).toISOString(), siteId: "SITE-1", cellId: "SITE-1-L1", technology: "LTE", severity: "Major", probableCause: "Door open", state: "active" };

describe("AppProvider defaults (synthetic dataset)", () => {
  it("exposes the synthetic dataset with now = DATASET_END and default filters", () => {
    const app = mount();
    expect(app().range).toBe("24h");
    expect(app().tech).toBe("All");
    expect(app().route.page).toBe("overview");
    expect(app().now).toBe(DATASET_END);
    expect(app().nowIso).toBe(new Date(DATASET_END).toISOString());
    expect(app().data.samples).toHaveLength(SYNTHETIC_SAMPLES);
    expect(app().cells.size).toBe(48);
    expect(app().alarms).toHaveLength(300);
    expect(app().source.kind).toBe("synthetic");
    expect(app().source.rows).toBe(SYNTHETIC_SAMPLES);
    expect(app().source.cellCount).toBe(48);
    expect(app().source.siteCount).toBe(12);
    expect(app().source.alarmCount).toBe(300);
    expect(app().source.start).toBe(DATASET_START);
    expect(app().source.end).toBe(DATASET_END);
    expect(app().source.timeZone).toBe("Asia/Kolkata");
    expect(app().source.warnings).toEqual([]);
    expect(app().audit).toEqual([]);
    expect(app().alarmStore.audit).toBe(app().audit);
    expect(storedFilters()).toBeNull();
  });
});

describe("URL-synced range / tech filters", () => {
  it("reads range, tech and the page from the hash", () => {
    const app = mount("#/kpis?range=7d&tech=NR");
    expect(app().range).toBe("7d");
    expect(app().tech).toBe("NR");
    expect(app().route.page).toBe("kpis");
  });

  it("setRange / setTech rewrite the hash in place (page and other params kept) and persist to tkm.filters.v1", () => {
    const app = mount("#/kpis?range=7d&tech=NR&cell=VSKP-001-L1");
    act(() => app().setRange("1h"));
    expect(window.location.hash).toBe("#/kpis?range=1h&tech=NR&cell=VSKP-001-L1");
    expect(app().range).toBe("1h");
    expect(app().tech).toBe("NR");
    expect(app().route.page).toBe("kpis");
    expect(app().route.params.get("cell")).toBe("VSKP-001-L1");
    expect(storedFilters()).toEqual({ range: "1h", tech: "NR" });

    act(() => app().setTech("LTE"));
    expect(window.location.hash).toBe("#/kpis?range=1h&tech=LTE&cell=VSKP-001-L1");
    expect(app().tech).toBe("LTE");
    expect(storedFilters()).toEqual({ range: "1h", tech: "LTE" });
  });

  it("adds the filters to a hash that did not carry them", () => {
    const app = mount("#/alarms?state=active");
    act(() => app().setRange("7d"));
    expect(window.location.hash).toBe("#/alarms?state=active&range=7d");
    act(() => app().setTech("NR"));
    expect(window.location.hash).toBe("#/alarms?state=active&range=7d&tech=NR");
    expect(app().route.params.get("state")).toBe("active");
    expect(storedFilters()).toEqual({ range: "7d", tech: "NR" });
  });

  it("falls back to the stored filters when the URL has none, and to the defaults when storage is invalid", () => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify({ range: "6h", tech: "LTE" }));
    const app = mount("#/overview");
    expect(app().range).toBe("6h");
    expect(app().tech).toBe("LTE");

    localStorage.setItem(FILTERS_KEY, JSON.stringify({ range: "2h", tech: "5G" }));
    const bad = mount("#/overview");
    expect(bad().range).toBe("24h");
    expect(bad().tech).toBe("All");

    localStorage.setItem(FILTERS_KEY, "{not json");
    const corrupt = mount("#/overview");
    expect(corrupt().range).toBe("24h");
    expect(corrupt().tech).toBe("All");
  });

  it("prefers valid URL params over stored filters and ignores invalid URL values", () => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify({ range: "6h", tech: "LTE" }));
    const app = mount("#/alarms?range=1h");
    expect(app().range).toBe("1h");
    expect(app().tech).toBe("LTE");

    const invalid = mount("#/alarms?range=2h&tech=5G");
    expect(invalid().range).toBe("6h");
    expect(invalid().tech).toBe("LTE");
    expect(invalid().route.page).toBe("alarms");
  });
});

describe("route and setQuery", () => {
  it("follows external hash changes", () => {
    const app = mount("#/overview");
    act(() => {
      window.location.hash = "#/sites?region=VSKP-North";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(app().route.page).toBe("sites");
    expect(app().route.params.get("region")).toBe("VSKP-North");
  });

  it("setQuery merges into the current page params, deletes undefined keys and keeps the page and global filters", () => {
    const app = mount("#/kpis?range=7d&kpi=latencyMs");
    act(() => app().setQuery({ cell: "VSKP-001-L1", kpi: undefined }));
    expect(window.location.hash).toBe("#/kpis?range=7d&cell=VSKP-001-L1");
    expect(app().route.page).toBe("kpis");
    expect(app().route.params.get("cell")).toBe("VSKP-001-L1");
    expect(app().route.params.has("kpi")).toBe(false);
    expect(app().range).toBe("7d");

    act(() => app().setQuery({ kpi: "prbUtilizationPct", cell: "" }));
    expect(window.location.hash).toBe("#/kpis?range=7d&kpi=prbUtilizationPct");
    expect(app().route.params.get("kpi")).toBe("prbUtilizationPct");

    act(() => app().setQuery({ range: undefined, kpi: undefined }));
    expect(window.location.hash).toBe("#/kpis");
    expect(app().range).toBe("24h"); // nothing stored → default
  });
});

describe("dataset source", () => {
  it("loadDataset switches to the imported data with now = max sample timestamp", () => {
    const app = mount();
    act(() => app().loadDataset(smallDataset, "import.csv", ["2 rows had empty counters"]));
    expect(app().source.kind).toBe("imported");
    expect(app().source.label).toBe("import.csv");
    expect(app().now).toBe(IMPORT_END);
    expect(app().nowIso).toBe(new Date(IMPORT_END).toISOString());
    expect(app().source.start).toBe(IMPORT_START);
    expect(app().source.end).toBe(IMPORT_END);
    expect(app().source.rows).toBe(5);
    expect(app().source.cellCount).toBe(2);
    expect(app().source.siteCount).toBe(1);
    expect(app().source.alarmCount).toBe(0);
    expect(app().source.warnings).toEqual(["2 rows had empty counters"]);
    expect(app().source.timeZone).toBe("Asia/Kolkata");
    expect(app().data).toBe(smallDataset);
    expect(app().cells.size).toBe(2);
    expect(app().cells.get("SITE-1-N1")?.technology).toBe("NR");
    expect(app().alarms).toEqual([]);
  });

  it("marks the synthetic store as persisted and an imported one as session-only", () => {
    const app = mount();
    expect(app().source.persisted).toBe(true);
    act(() => app().loadDataset(smallDataset, "import.csv"));
    expect(app().source.persisted).toBe(false);
  });

  it("falls back to the alarm timeline, then the import time, when a dataset has no usable samples", () => {
    const app = mount();
    act(() => app().loadDataset({ ...smallDataset, samples: [], alarms: [importedAlarm] }, "alarms-only.csv"));
    expect(app().now).toBe(Date.parse(importedAlarm.timestamp));
    expect(app().source.start).toBe(Date.parse(importedAlarm.timestamp));
    expect(app().source.rows).toBe(0);
    expect(app().source.warnings.some((w) => /no kpi samples/i.test(w))).toBe(true);

    const before = Date.now();
    act(() => app().loadDataset({ ...smallDataset, samples: [], alarms: [] }, "empty.csv"));
    expect(app().now).toBeGreaterThanOrEqual(before);
    expect(app().now).toBeLessThanOrEqual(Date.now());
    expect(app().source.warnings).toHaveLength(1);
  });

  it("resetToSynthetic restores the synthetic dataset and DATASET_END", () => {
    const app = mount();
    act(() => app().loadDataset(smallDataset, "import.csv"));
    expect(app().source.kind).toBe("imported");
    expect(app().source.warnings).toEqual([]);
    act(() => app().resetToSynthetic());
    expect(app().source.kind).toBe("synthetic");
    expect(app().now).toBe(DATASET_END);
    expect(app().data.samples).toHaveLength(SYNTHETIC_SAMPLES);
    expect(app().cells.size).toBe(48);
    expect(app().alarms).toHaveLength(300);
  });
});

describe("alarm store dispatch", () => {
  it("clear stamps clearedAt in dataset time while the audit entry carries the wall clock, and persists", () => {
    const app = mount();
    const before = app().alarms.find((a) => a.alarmId === "ALM-000002");
    expect(before?.state).toBe("active");
    const wallClockBefore = Date.now();
    act(() => app().alarmDispatch({ type: "clear", alarmId: "ALM-000002" }));
    const cleared = app().alarms.find((a) => a.alarmId === "ALM-000002");
    expect(cleared?.state).toBe("cleared");
    expect(cleared?.clearedAt).toBe(app().nowIso);
    expect(cleared?.clearedAt).toBe(new Date(DATASET_END).toISOString());
    expect(app().audit[0]?.alarmId).toBe("ALM-000002");
    expect(app().audit[0]?.action).toBe("clear");
    const at = Date.parse(app().audit[0]?.at ?? "");
    expect(at).toBeGreaterThanOrEqual(wallClockBefore - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
    expect(app().audit[0]?.at).not.toBe(cleared?.clearedAt);
    expect(app().alarmStore.audit).toBe(app().audit);
    expect(storageKeys().some((k) => k.startsWith("tkm.alarms."))).toBe(true);

    // a second provider instance (page reload) sees the persisted override
    const reloaded = mount();
    expect(reloaded().alarms.find((a) => a.alarmId === "ALM-000002")?.state).toBe("cleared");
    expect(reloaded().audit[0]?.alarmId).toBe("ALM-000002");
  });

  it("alarmAction stays a wrapper around alarmDispatch: acknowledge with a note, clear stamped in dataset time", () => {
    const app = mount();
    const active = app().alarms.filter((a) => a.state === "active" && a.alarmId !== "ALM-000002").map((a) => a.alarmId);
    expect(active.length).toBeGreaterThanOrEqual(2);
    const [first, second] = active;
    act(() => app().alarmAction(first, "acknowledge", "shift handover"));
    expect(app().alarms.find((a) => a.alarmId === first)?.state).toBe("acknowledged");
    expect(app().audit[0]).toMatchObject({ alarmId: first, action: "acknowledge", note: "shift handover" });
    expect(app().audit).toHaveLength(1);

    act(() => app().alarmAction(second, "clear"));
    const cleared = app().alarms.find((a) => a.alarmId === second);
    expect(cleared?.state).toBe("cleared");
    expect(cleared?.clearedAt).toBe(app().nowIso); // dataset time, not the wall clock
    expect(app().audit).toHaveLength(2);
    expect(app().audit[0]).toMatchObject({ alarmId: second, action: "clear" });
  });

  it("operator actions on an imported dataset stay in memory and never touch the persisted synthetic store", () => {
    const app = mount();
    act(() => app().loadDataset({ ...smallDataset, alarms: [importedAlarm] }, "alarms.csv"));
    expect(app().source.kind).toBe("imported");
    expect(app().alarms).toHaveLength(1);
    act(() => app().alarmDispatch({ type: "acknowledge", alarmId: "ALM-000002", note: "field team informed" }));
    expect(app().alarms[0]?.state).toBe("acknowledged");
    expect(app().audit).toHaveLength(1);
    expect(app().audit[0]?.note).toBe("field team informed");
    expect(storageKeys().some((k) => k.startsWith("tkm.alarms."))).toBe(false);

    act(() => app().resetToSynthetic());
    expect(app().alarms.find((a) => a.alarmId === "ALM-000002")?.state).toBe("active");
    expect(app().audit).toEqual([]);
  });
});

describe("thresholds (stable behaviour)", () => {
  it("updateThresholds persists and resetThresholdsToDefault restores the defaults", () => {
    const app = mount();
    const next = { ...app().thresholds, prbUtilizationPct: { ...app().thresholds.prbUtilizationPct, critical: 50 } };
    act(() => app().updateThresholds(next));
    expect(app().thresholds.prbUtilizationPct.critical).toBe(50);
    expect(localStorage.getItem("tkm.thresholds.v1")).toContain("50");
    act(() => app().resetThresholdsToDefault());
    expect(app().thresholds).toEqual(DEFAULT_THRESHOLDS);
    expect(localStorage.getItem("tkm.thresholds.v1")).toBeNull();
  });
});
