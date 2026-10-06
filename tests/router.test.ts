import { describe, expect, it } from "vitest";
import { PAGES, href, navigate, parseHash, parseKpiKey, parsePositiveInt, parseRange, parseTech, withParams } from "../src/lib/router";
import { KPI_META } from "../src/lib/kpi";
import type { KpiKey } from "../src/types/telecom";

describe("parseHash", () => {
  it("maps an empty or bare hash to the overview page with no params", () => {
    for (const h of ["", "#", "#/", "/"]) {
      const r = parseHash(h);
      expect(r.page).toBe("overview");
      expect([...r.params.keys()]).toEqual([]);
    }
  });
  it("maps an unknown page to overview but keeps its params", () => {
    const r = parseHash("#/nope?x=1");
    expect(r.page).toBe("overview");
    expect(r.params.get("x")).toBe("1");
  });
  it("recognises every navigation page, including sites and report", () => {
    expect(PAGES).toEqual(["overview", "kpis", "alarms", "packets", "sites", "report"]);
    for (const p of PAGES) expect(parseHash(`#/${p}`).page).toBe(p);
  });
  it("parses the query string into URLSearchParams", () => {
    const r = parseHash("#/kpis?cell=VSKP-001-L1&kpi=latencyMs&q=cell+down");
    expect(r.page).toBe("kpis");
    expect(r.params.get("cell")).toBe("VSKP-001-L1");
    expect(r.params.get("kpi")).toBe("latencyMs");
    expect(r.params.get("q")).toBe("cell down");
  });
  it("tolerates a missing '#', a missing slash, a trailing slash and upper case", () => {
    expect(parseHash("kpis?x=1").page).toBe("kpis");
    expect(parseHash("#kpis").page).toBe("kpis");
    expect(parseHash("#/alarms/").page).toBe("alarms");
    expect(parseHash("#/KPIs").page).toBe("kpis");
  });
});

describe("href", () => {
  it("builds a bare page link without params", () => {
    expect(href("overview")).toBe("#/overview");
    expect(href("sites", {})).toBe("#/sites");
  });
  it("skips undefined and empty values and keeps insertion order", () => {
    expect(href("kpis", { cell: "X", kpi: undefined, q: "" })).toBe("#/kpis?cell=X");
    expect(href("alarms", { state: "active", severity: "Major", page: "2" })).toBe("#/alarms?state=active&severity=Major&page=2");
  });
  it("encodes values so that parseHash(href(...)) round-trips", () => {
    const params = { q: "cell down & more", cell: "VSKP-001-L1", range: "7d" };
    const r = parseHash(href("alarms", params));
    expect(r.page).toBe("alarms");
    expect(r.params.get("q")).toBe("cell down & more");
    expect(r.params.get("cell")).toBe("VSKP-001-L1");
    expect(r.params.get("range")).toBe("7d");
  });
});

describe("withParams", () => {
  it("merges a patch into the current params, deletes undefined/empty keys and keeps the page", () => {
    expect(withParams("#/kpis?range=7d&kpi=latencyMs", { cell: "VSKP-001-L1", kpi: undefined })).toBe("#/kpis?range=7d&cell=VSKP-001-L1");
    expect(withParams("#/alarms?state=active&q=door", { q: "" })).toBe("#/alarms?state=active");
  });
  it("replaces an existing value in place and can switch the page", () => {
    expect(withParams("#/kpis?range=7d&tech=NR", { range: "1h" })).toBe("#/kpis?range=1h&tech=NR");
    expect(withParams("#/overview?range=7d", {}, "sites")).toBe("#/sites?range=7d");
    expect(withParams("", { range: "6h" })).toBe("#/overview?range=6h");
  });
});

describe("navigate", () => {
  it("writes the built href to window.location.hash", () => {
    navigate("kpis", { cell: "VSKP-001-L1", kpi: undefined });
    expect(window.location.hash).toBe("#/kpis?cell=VSKP-001-L1");
  });
});

describe("validators", () => {
  it("parseKpiKey accepts only KPI_META keys", () => {
    expect(parseKpiKey("prbUtilizationPct")).toBe("prbUtilizationPct");
    for (const k of Object.keys(KPI_META) as KpiKey[]) expect(parseKpiKey(k)).toBe(k);
    expect(parseKpiKey("bogus")).toBeNull();
    expect(parseKpiKey("activeUsers")).toBeNull();
    expect(parseKpiKey("constructor")).toBeNull();
    expect(parseKpiKey("")).toBeNull();
    expect(parseKpiKey(null)).toBeNull();
    expect(parseKpiKey(undefined)).toBeNull();
  });
  it("parseRange accepts only the four time ranges", () => {
    for (const r of ["1h", "6h", "24h", "7d"] as const) expect(parseRange(r)).toBe(r);
    expect(parseRange("2h")).toBeNull();
    expect(parseRange("24H")).toBeNull();
    expect(parseRange("")).toBeNull();
    expect(parseRange(null)).toBeNull();
    expect(parseRange(undefined)).toBeNull();
  });
  it("parseTech accepts only All, LTE and NR", () => {
    for (const t of ["All", "LTE", "NR"] as const) expect(parseTech(t)).toBe(t);
    expect(parseTech("nr")).toBeNull();
    expect(parseTech("5G")).toBeNull();
    expect(parseTech("")).toBeNull();
    expect(parseTech(null)).toBeNull();
  });
  it("parsePositiveInt returns integers >= 1 and the fallback otherwise", () => {
    expect(parsePositiveInt("0", 1)).toBe(1);
    expect(parsePositiveInt("3", 1)).toBe(3);
    expect(parsePositiveInt("x", 2)).toBe(2);
    expect(parsePositiveInt("-2", 1)).toBe(1);
    expect(parsePositiveInt("2.5", 1)).toBe(1);
    expect(parsePositiveInt("1e3", 1)).toBe(1);
    expect(parsePositiveInt("007", 1)).toBe(7);
    expect(parsePositiveInt(" 4 ", 1)).toBe(4);
    expect(parsePositiveInt("", 5)).toBe(5);
    expect(parsePositiveInt(null, 6)).toBe(6);
    expect(parsePositiveInt(undefined, 7)).toBe(7);
  });
});
