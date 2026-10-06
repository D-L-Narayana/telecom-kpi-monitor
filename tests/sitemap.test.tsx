import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SiteMap } from "../src/components/SiteMap";
import { aggregateBySite, type SiteAggregate } from "../src/lib/sites";
import { RANGE_MS, inWindow } from "../src/lib/kpi";
import { DEFAULT_THRESHOLDS } from "../src/lib/thresholds";
import { DATASET_END, generateDataset } from "../src/lib/synthetic";

const data = generateDataset();
const cells = new Map(data.cells.map((c) => [c.cellId, c]));
const win24 = inWindow(data.samples, DATASET_END, RANGE_MS["24h"]);
/** 12 sites × 4 cells; VSKP-002 is critical in this window (handover success ≈ 88 % on VSKP-002-L1). */
const agg24 = aggregateBySite(win24, cells, data.sites, DEFAULT_THRESHOLDS, data.alarms);

const circlesOf = (container: HTMLElement) => Array.from(container.querySelectorAll("svg.site-map circle"));

describe("SiteMap (synthetic 24h aggregates)", () => {
  it("draws one keyboard-focusable circle per site, named, coloured by level and sized by cell count", () => {
    const { container } = render(<SiteMap sites={agg24} onSelect={() => {}} />);
    const svg = container.querySelector("svg.site-map");
    expect(svg).not.toBeNull();
    // the map is a labelled group so its circles can be real tab stops (role="img" would make them presentational)
    expect(svg!.getAttribute("role")).toBe("group");
    expect(svg!.getAttribute("viewBox")).toBe("0 0 640 360");
    const titleId = svg!.getAttribute("aria-labelledby");
    expect(titleId).toBeTruthy();
    const title = svg!.querySelector("title");
    expect(title).not.toBeNull();
    expect(title!.id).toBe(titleId);
    expect(title!.textContent).toMatch(/^Site health map: 12 sites/);
    const criticalSites = agg24.filter((s) => s.worstLevel === "critical").length;
    expect(criticalSites).toBeGreaterThanOrEqual(1); // VSKP-002 (VSWR fault) at least
    expect(title!.textContent).toMatch(new RegExp(`\\b${criticalSites} critical\\b`));

    const circles = circlesOf(container);
    expect(circles).toHaveLength(12);
    for (const c of circles) {
      expect(c.getAttribute("tabindex")).toBe("0");
      expect(c.getAttribute("role")).toBe("button");
      expect(c.getAttribute("aria-pressed")).toBe("false");
      expect(Number.isFinite(Number(c.getAttribute("cx")))).toBe(true);
      expect(Number.isFinite(Number(c.getAttribute("cy")))).toBe(true);
      expect(c.getAttribute("r")).toBe("12"); // 6 + 1.5 × 4 cells
      expect(c.getAttribute("fill")).toBeNull(); // colour comes from the lvl-* class → CSS tokens, never a literal
      expect(c.getAttribute("aria-label")).toMatch(/^VSKP-\d{3} .+, VSKP-(North|Central|South), (OK|Warning|Critical), 4 cells/);
    }
    const s2 = screen.getByRole("button", { name: /^VSKP-002 MVP Colony, VSKP-Central, Critical, 4 cells/ });
    expect(s2).toHaveClass("lvl-critical");
    const s1 = agg24[0];
    expect(s1.siteId).toBe("VSKP-001");
    expect(screen.getByRole("button", { name: /^VSKP-001 Gajuwaka/ })).toHaveClass(`lvl-${s1.worstLevel}`);
    expect(circles.filter((c) => c.classList.contains("lvl-critical"))).toHaveLength(criticalSites);
  });

  it("selects a site with Enter or Space on its circle and with a click", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<SiteMap sites={agg24} onSelect={onSelect} />);
    const circle = screen.getByRole("button", { name: /^VSKP-004 Madhurawada/ });
    circle.focus();
    expect(document.activeElement).toBe(circle);
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("VSKP-004");
    fireEvent.keyDown(screen.getByRole("button", { name: /^VSKP-007 Pendurthi/ }), { key: " " });
    expect(onSelect).toHaveBeenLastCalledWith("VSKP-007");
    await user.click(screen.getByRole("button", { name: /^VSKP-001 Gajuwaka/ }));
    expect(onSelect).toHaveBeenLastCalledWith("VSKP-001");
    expect(onSelect).toHaveBeenCalledTimes(3);
    fireEvent.keyDown(circle, { key: "a" }); // other keys do nothing
    expect(onSelect).toHaveBeenCalledTimes(3);
  });

  it("marks the selected site pressed and labels the selected and the critical sites", () => {
    const { container } = render(<SiteMap sites={agg24} selected="VSKP-004" onSelect={() => {}} />);
    const pressed = container.querySelectorAll('svg.site-map circle[aria-pressed="true"]');
    expect(pressed).toHaveLength(1);
    expect(pressed[0].getAttribute("aria-label")).toMatch(/^VSKP-004 Madhurawada/);
    expect(pressed[0]).toHaveClass("selected");
    expect(container.querySelectorAll('svg.site-map circle[aria-pressed="false"]')).toHaveLength(11);
    const labels = Array.from(container.querySelectorAll("svg.site-map text")).map((t) => t.textContent).sort();
    const expected = agg24.filter((s) => s.worstLevel === "critical" || s.siteId === "VSKP-004").map((s) => s.siteId).sort();
    expect(expected).toContain("VSKP-002");
    expect(labels).toEqual(expected);
  });

  it("lists every site in a visually hidden list and skips circles for sites without coordinates", () => {
    const noGeo: SiteAggregate = { ...agg24[11], lat: Number.NaN };
    expect(noGeo.siteId).toBe("VSKP-012");
    const { container } = render(<SiteMap sites={[...agg24.slice(0, 11), noGeo]} onSelect={() => {}} />);
    expect(circlesOf(container)).toHaveLength(11);
    expect(screen.queryByRole("button", { name: /^VSKP-012/ })).toBeNull();
    expect(container.querySelector("svg.site-map title")!.textContent).toMatch(/12 sites.*1 without coordinates/);
    const list = container.querySelector("ul.visually-hidden");
    expect(list).not.toBeNull();
    const items = Array.from(list!.querySelectorAll("li")).map((li) => li.textContent ?? "");
    expect(items).toHaveLength(12);
    expect(items[0]).toMatch(/^VSKP-001 Gajuwaka, VSKP-North, (OK|Warning|Critical), 4 cells/);
    expect(items[11]).toMatch(/^VSKP-012 Yendada/);
    expect(items[11]).toMatch(/no coordinates/);
    expect(items.filter((t) => /no coordinates/.test(t))).toHaveLength(1);
  });

  it("fits custom dimensions and explains an empty map instead of crashing", () => {
    const { container, unmount } = render(<SiteMap sites={agg24} width={300} height={200} onSelect={() => {}} />);
    expect(container.querySelector("svg.site-map")!.getAttribute("viewBox")).toBe("0 0 300 200");
    for (const c of circlesOf(container)) {
      const cx = Number(c.getAttribute("cx"));
      const cy = Number(c.getAttribute("cy"));
      expect(cx).toBeGreaterThan(0);
      expect(cx).toBeLessThan(300);
      expect(cy).toBeGreaterThan(0);
      expect(cy).toBeLessThan(200);
    }
    unmount();
    const empty = render(<SiteMap sites={[]} onSelect={() => {}} />);
    expect(circlesOf(empty.container)).toHaveLength(0);
    expect(empty.container.querySelector("svg.site-map title")!.textContent).toMatch(/^Site health map: 0 sites/);
    expect(empty.container.querySelector("svg.site-map text")).toHaveTextContent(/no site coordinates/i);
    expect(empty.container.querySelector("ul.visually-hidden")).toBeNull();
  });
});
