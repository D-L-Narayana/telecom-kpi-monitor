import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS, THRESHOLDS_KEY, THRESHOLD_KEYS, THRESHOLD_PRESETS, classify, loadThresholds, resetThresholds, saveThresholds, thresholdFor,
  thresholdsFromJson, thresholdsToJson, validateThresholds, type ThresholdIssue, type Thresholds,
} from "../src/lib/thresholds";

const keys = Object.keys(DEFAULT_THRESHOLDS) as (keyof Thresholds)[];
const fieldsOf = (issues: ThresholdIssue[]) => issues.map((i) => `${i.key}.${i.field}`).sort();

describe("validateThresholds", () => {
  it("accepts the defaults unchanged, as fresh objects", () => {
    const r = validateThresholds(DEFAULT_THRESHOLDS);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.value).toEqual(DEFAULT_THRESHOLDS);
    expect(r.value.prbUtilizationPct).not.toBe(DEFAULT_THRESHOLDS.prbUtilizationPct);
    expect(THRESHOLD_KEYS).toEqual(keys);
  });

  it("requires warning < critical for KPIs that breach above", () => {
    const r = validateThresholds({ ...DEFAULT_THRESHOLDS, prbUtilizationPct: { warning: 90, critical: 85, direction: "above" } });
    expect(r.ok).toBe(false);
    expect(fieldsOf(r.issues)).toEqual(["prbUtilizationPct.order"]);
    expect(r.issues[0].message).toMatch(/warning/i);
    expect(r.value.prbUtilizationPct).toEqual(DEFAULT_THRESHOLDS.prbUtilizationPct);
    // equal values are not an ordering either
    const eq = validateThresholds({ ...DEFAULT_THRESHOLDS, latencyMs: { warning: 50, critical: 50, direction: "above" } });
    expect(fieldsOf(eq.issues)).toEqual(["latencyMs.order"]);
    expect(eq.value.latencyMs).toEqual(DEFAULT_THRESHOLDS.latencyMs);
    // a correctly ordered edit is kept as given
    const ok = validateThresholds({ ...DEFAULT_THRESHOLDS, prbUtilizationPct: { warning: 65, critical: 80, direction: "above" } });
    expect(ok.ok).toBe(true);
    expect(ok.value.prbUtilizationPct).toEqual({ warning: 65, critical: 80, direction: "above" });
  });

  it("requires warning > critical for KPIs that breach below", () => {
    const r = validateThresholds({ ...DEFAULT_THRESHOLDS, rrcSetupSuccessPct: { warning: 95, critical: 98, direction: "below" } });
    expect(r.ok).toBe(false);
    expect(fieldsOf(r.issues)).toEqual(["rrcSetupSuccessPct.order"]);
    expect(r.value.rrcSetupSuccessPct).toEqual(DEFAULT_THRESHOLDS.rrcSetupSuccessPct);
    const ok = validateThresholds({ ...DEFAULT_THRESHOLDS, rrcSetupSuccessPct: { warning: 99, critical: 97, direction: "below" } });
    expect(ok.ok).toBe(true);
    expect(ok.value.rrcSetupSuccessPct).toEqual({ warning: 99, critical: 97, direction: "below" });
  });

  it("rejects NaN, empty strings, numeric strings and nulls and restores the defaults for that KPI", () => {
    const r = validateThresholds({
      ...DEFAULT_THRESHOLDS,
      prbUtilizationPct: { warning: "", critical: NaN, direction: "above" },
      latencyMs: { warning: "40", critical: null, direction: "above" },
    });
    expect(r.ok).toBe(false);
    expect(fieldsOf(r.issues)).toEqual(["latencyMs.critical", "latencyMs.warning", "prbUtilizationPct.critical", "prbUtilizationPct.warning"]);
    for (const issue of r.issues) expect(issue.message).toMatch(/finite number/);
    expect(r.value.prbUtilizationPct).toEqual(DEFAULT_THRESHOLDS.prbUtilizationPct);
    expect(r.value.latencyMs).toEqual(DEFAULT_THRESHOLDS.latencyMs);
    expect(r.value.callDropRatePct).toEqual(DEFAULT_THRESHOLDS.callDropRatePct);
    expect(validateThresholds(r.value).ok).toBe(true);
  });

  it("rejects infinite values and keeps the other field of the same KPI from producing a half-edited pair", () => {
    const r = validateThresholds({ ...DEFAULT_THRESHOLDS, ulThroughputMbps: { warning: Infinity, critical: 1, direction: "below" } });
    expect(r.ok).toBe(false);
    expect(fieldsOf(r.issues)).toEqual(["ulThroughputMbps.warning"]);
    expect(r.value.ulThroughputMbps).toEqual(DEFAULT_THRESHOLDS.ulThroughputMbps);
  });

  it("drops unknown keys, fills missing keys from the defaults and normalises the direction label", () => {
    const r = validateThresholds({ prbUtilizationPct: { warning: 60, critical: 80, direction: "below" }, bogus: { warning: 1, critical: 2 } });
    expect(r.ok).toBe(true);
    expect(Object.keys(r.value).sort()).toEqual([...keys].sort());
    expect(r.value.prbUtilizationPct).toEqual({ warning: 60, critical: 80, direction: "above" });
    expect(r.value.callDropRatePct).toEqual(DEFAULT_THRESHOLDS.callDropRatePct);
    expect("bogus" in r.value).toBe(false);
  });

  it("falls back to the defaults for non-object input and garbage entries", () => {
    for (const bad of [null, undefined, 42, "x", [], true]) {
      const r = validateThresholds(bad);
      expect(r.ok, `input ${String(bad)}`).toBe(false);
      expect(r.value).toEqual(DEFAULT_THRESHOLDS);
      expect(r.issues.length).toBeGreaterThan(0);
    }
    const r = validateThresholds({ ...DEFAULT_THRESHOLDS, latencyMs: 5 });
    expect(r.ok).toBe(false);
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.issues.every((i) => i.key === "latencyMs")).toBe(true);
    expect(r.value.latencyMs).toEqual(DEFAULT_THRESHOLDS.latencyMs);
  });

  it("does not mutate its input", () => {
    const input = { ...DEFAULT_THRESHOLDS, prbUtilizationPct: { warning: 90, critical: 85, direction: "above" as const } };
    const copy = JSON.parse(JSON.stringify(input)) as unknown;
    validateThresholds(input);
    expect(input).toEqual(copy);
  });
});

describe("THRESHOLD_PRESETS", () => {
  it("offers default, strict and lenient sets that all validate", () => {
    expect(Object.keys(THRESHOLD_PRESETS).sort()).toEqual(["default", "lenient", "strict"]);
    for (const [name, preset] of Object.entries(THRESHOLD_PRESETS)) {
      const r = validateThresholds(preset);
      expect(r.ok, `preset ${name}`).toBe(true);
      expect(r.value).toEqual(preset);
    }
    expect(THRESHOLD_PRESETS.default).toEqual(DEFAULT_THRESHOLDS);
    expect(THRESHOLD_PRESETS.strict).not.toEqual(DEFAULT_THRESHOLDS);
    expect(THRESHOLD_PRESETS.lenient).not.toEqual(DEFAULT_THRESHOLDS);
    expect(THRESHOLD_PRESETS.strict).not.toEqual(THRESHOLD_PRESETS.lenient);
  });

  it("strict is tighter and lenient looser than the defaults in every KPI's breach direction", () => {
    for (const key of keys) {
      const def = DEFAULT_THRESHOLDS[key];
      const strict = THRESHOLD_PRESETS.strict[key];
      const lenient = THRESHOLD_PRESETS.lenient[key];
      expect(strict.direction).toBe(def.direction);
      expect(lenient.direction).toBe(def.direction);
      if (def.direction === "above") {
        expect(strict.warning, `${key} strict warning`).toBeLessThan(def.warning);
        expect(strict.critical, `${key} strict critical`).toBeLessThan(def.critical);
        expect(lenient.warning, `${key} lenient warning`).toBeGreaterThan(def.warning);
        expect(lenient.critical, `${key} lenient critical`).toBeGreaterThan(def.critical);
      } else {
        expect(strict.warning, `${key} strict warning`).toBeGreaterThan(def.warning);
        expect(strict.critical, `${key} strict critical`).toBeGreaterThan(def.critical);
        expect(lenient.warning, `${key} lenient warning`).toBeLessThan(def.warning);
        expect(lenient.critical, `${key} lenient critical`).toBeLessThan(def.critical);
      }
    }
    // the same PRB value is a warning under the strict preset, fine under the default and lenient ones
    expect(classify(65, THRESHOLD_PRESETS.strict.prbUtilizationPct)).toBe("warning");
    expect(classify(65, THRESHOLD_PRESETS.default.prbUtilizationPct)).toBe("ok");
    expect(classify(65, THRESHOLD_PRESETS.lenient.prbUtilizationPct)).toBe("ok");
  });
});

describe("JSON export / import", () => {
  it("round-trips a threshold set through pretty-printed JSON", () => {
    const text = thresholdsToJson(THRESHOLD_PRESETS.strict);
    expect(text).toContain("\n");
    expect(JSON.parse(text)).toEqual(THRESHOLD_PRESETS.strict);
    const r = thresholdsFromJson(text);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.value).toEqual(THRESHOLD_PRESETS.strict);
  });

  it("reports invalid JSON and bad fields without throwing", () => {
    const r = thresholdsFromJson("{not json");
    expect(r.ok).toBe(false);
    expect(r.value).toEqual(DEFAULT_THRESHOLDS);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].message).toMatch(/JSON/);
    const r2 = thresholdsFromJson(JSON.stringify({ prbUtilizationPct: { warning: "70", critical: 85 } }));
    expect(r2.ok).toBe(false);
    expect(fieldsOf(r2.issues)).toEqual(["prbUtilizationPct.warning"]);
    expect(r2.value).toEqual(DEFAULT_THRESHOLDS);
    expect(thresholdsFromJson("").ok).toBe(false);
  });
});

describe("persistence in tkm.thresholds.v1", () => {
  beforeEach(() => localStorage.clear());

  it("saves and loads a valid set", () => {
    expect(THRESHOLDS_KEY).toBe("tkm.thresholds.v1");
    saveThresholds(THRESHOLD_PRESETS.strict);
    expect(localStorage.getItem(THRESHOLDS_KEY)).not.toBeNull();
    expect(loadThresholds()).toEqual(THRESHOLD_PRESETS.strict);
  });

  it("returns the defaults when nothing is stored or the JSON is corrupt", () => {
    expect(loadThresholds()).toEqual(DEFAULT_THRESHOLDS);
    localStorage.setItem(THRESHOLDS_KEY, "{not json");
    expect(loadThresholds()).toEqual(DEFAULT_THRESHOLDS);
    localStorage.setItem(THRESHOLDS_KEY, JSON.stringify("hello"));
    expect(loadThresholds()).toEqual(DEFAULT_THRESHOLDS);
    localStorage.setItem(THRESHOLDS_KEY, JSON.stringify([1, 2]));
    expect(loadThresholds()).toEqual(DEFAULT_THRESHOLDS);
  });

  it("sanitises a partial or corrupt stored set instead of trusting it", () => {
    localStorage.setItem(THRESHOLDS_KEY, JSON.stringify({ prbUtilizationPct: { warning: 60, critical: 80, direction: "above" }, bogus: 1 }));
    const t = loadThresholds();
    expect(t.prbUtilizationPct).toEqual({ warning: 60, critical: 80, direction: "above" });
    expect(t.callDropRatePct).toEqual(DEFAULT_THRESHOLDS.callDropRatePct);
    expect("bogus" in t).toBe(false);
    expect(Object.keys(t).sort()).toEqual([...keys].sort());

    localStorage.setItem(THRESHOLDS_KEY, JSON.stringify({ prbUtilizationPct: { warning: null, critical: "" }, latencyMs: { warning: 80, critical: 60, direction: "above" } }));
    const u = loadThresholds();
    expect(u.prbUtilizationPct).toEqual(DEFAULT_THRESHOLDS.prbUtilizationPct);
    expect(u.latencyMs).toEqual(DEFAULT_THRESHOLDS.latencyMs);
    expect(validateThresholds(u).ok).toBe(true);
  });

  it("resetThresholds clears the key and returns the defaults", () => {
    saveThresholds(THRESHOLD_PRESETS.lenient);
    expect(resetThresholds()).toEqual(DEFAULT_THRESHOLDS);
    expect(localStorage.getItem(THRESHOLDS_KEY)).toBeNull();
  });
});

describe("stable helpers", () => {
  it("thresholdFor picks the NR throughput row and skips KPIs without thresholds", () => {
    expect(thresholdFor(DEFAULT_THRESHOLDS, "dlThroughputMbps", "NR")).toBe(DEFAULT_THRESHOLDS.dlThroughputMbpsNR);
    expect(thresholdFor(DEFAULT_THRESHOLDS, "dlThroughputMbps", "LTE")).toBe(DEFAULT_THRESHOLDS.dlThroughputMbps);
    expect(thresholdFor(DEFAULT_THRESHOLDS, "dlThroughputMbps", "All")).toBe(DEFAULT_THRESHOLDS.dlThroughputMbps);
    expect(thresholdFor(DEFAULT_THRESHOLDS, "rsrpAvgDbm", "LTE")).toBeUndefined();
    expect(thresholdFor(DEFAULT_THRESHOLDS, "sinrAvgDb", "NR")).toBeUndefined();
  });

  it("classify follows the breach direction and treats missing data as ok", () => {
    expect(classify(1.5, DEFAULT_THRESHOLDS.callDropRatePct)).toBe("warning");
    expect(classify(2.5, DEFAULT_THRESHOLDS.callDropRatePct)).toBe("critical");
    expect(classify(96, DEFAULT_THRESHOLDS.rrcSetupSuccessPct)).toBe("warning");
    expect(classify(94, DEFAULT_THRESHOLDS.rrcSetupSuccessPct)).toBe("critical");
    expect(classify(null, DEFAULT_THRESHOLDS.latencyMs)).toBe("ok");
    expect(classify(undefined, DEFAULT_THRESHOLDS.latencyMs)).toBe("ok");
    expect(classify(500, undefined)).toBe("ok");
  });
});
