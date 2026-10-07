/**
 * axe-core accessibility scans (instrumentation).
 *
 * This spec is deliberately separate from the workflow specs: @axe-core/playwright evaluates the axe script through
 * the browser automation protocol, which is not a page-level script injection, so the application's Content Security
 * Policy is neither relaxed nor bypassed for the application itself (the headers spec verifies the policy as served and
 * every page is asserted clean of CSP violations *before* axe is injected). Should the injection ever be refused,
 * `analyze()` throws and the test fails — it is never skipped.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Result } from "axe-core";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { attachSecurityCollectors, expectCleanSecurity } from "./helpers";

const TAGS = ["wcag2a", "wcag2aa"];
const BLOCKING = new Set(["serious", "critical"]);

function describeViolation(v: Result): string {
  const targets = v.nodes.slice(0, 5).map((n) => n.target.join(" ")).join(" | ");
  return `${v.id} [${v.impact}] ${v.help} — ${targets}${v.nodes.length > 5 ? ` (+${v.nodes.length - 5} more)` : ""}`;
}

/**
 * Runs axe on the current document and fails on any serious or critical violation; all violations are attached.
 * `forbiddenRules` are rule ids that must not appear at all, whatever impact axe assigns them.
 */
async function expectNoBlockingViolations(page: Page, label: string, forbiddenRules: string[] = []): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  await test.info().attach(`axe-${label}.json`, {
    body: JSON.stringify({ url: results.url, violations: results.violations, incomplete: results.incomplete.map((i) => i.id) }, null, 2),
    contentType: "application/json",
  });
  const forbidden = results.violations.filter((v) => forbiddenRules.includes(v.id)).map(describeViolation);
  expect(forbidden, `${label}: violations of ${forbiddenRules.join(", ")} (any impact)`).toEqual([]);
  const blocking = results.violations.filter((v) => typeof v.impact === "string" && BLOCKING.has(v.impact)).map(describeViolation);
  expect(blocking, `${label}: serious/critical axe violations (${TAGS.join(", ")})`).toEqual([]);
}

async function openClean(page: Page, route: string, heading: string | RegExp) {
  const security = await attachSecurityCollectors(page);
  await page.goto(`/${route}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
  await expectCleanSecurity(page, security);
}

interface Overflow { label: string; scrollWidth: number; clientWidth: number }

/** Horizontal overflow geometry of every table scroll container on the page, named by its label or its card heading. */
async function tableOverflow(page: Page): Promise<Overflow[]> {
  return page.locator(".table-wrap").evaluateAll((els) =>
    els.map((el) => ({
      label: el.getAttribute("aria-label") ?? el.closest("section")?.querySelector("h2")?.textContent?.trim() ?? "(unnamed)",
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    })),
  );
}

const tableWrapOf = (page: Page, cardTitle: RegExp): Locator =>
  page.locator("section.card", { has: page.getByRole("heading", { level: 2, name: cardTitle }) }).locator(".table-wrap");

/** Precondition for the overflow scans: the given table really is wider than its scroll container at this viewport. */
async function expectOverflowing(wrap: Locator, label: string): Promise<void> {
  const g = await wrap.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
  expect(g.scrollWidth, `precondition: ${label} overflows (scrollWidth ${g.scrollWidth} > clientWidth ${g.clientWidth})`).toBeGreaterThan(g.clientWidth);
}

/** Switches to the dark theme through the UI, as a user would. */
async function useDarkTheme(page: Page): Promise<void> {
  await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
}

/**
 * Presses Tab from `from` until the focused element lies inside a Recharts chart (bounded to `maxTabs` presses) and
 * asserts that it got there — the keyboard path into the chart is part of the behaviour under test.
 */
async function tabIntoChart(page: Page, from: Locator, maxTabs: number, label: string): Promise<void> {
  await from.focus();
  await expect(from).toBeFocused();
  let reached = false;
  for (let i = 0; i < maxTabs && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(() => document.activeElement?.closest(".recharts-wrapper") !== null && document.activeElement?.closest(".recharts-wrapper") !== undefined);
  }
  expect(reached, `${label}: keyboard focus reaches the chart within ${maxTabs} Tab presses`).toBe(true);
}

test.describe("axe accessibility scan (instrumentation; does not alter application CSP)", () => {
  const pages: { label: string; route: string; heading: string }[] = [
    { label: "overview", route: "#/overview?range=7d&tech=All", heading: "Network overview" },
    { label: "kpis", route: "#/kpis?cell=VSKP-007-N1&kpi=prbUtilizationPct&range=7d", heading: "KPI analysis" },
    { label: "alarms", route: "#/alarms?severity=Major&state=active&alarm=ALM-000002", heading: "Alarm and fault tracking" },
    { label: "packets", route: "#/packets", heading: "Packet statistics" },
    { label: "sites", route: "#/sites?range=7d", heading: "Sites and regions" },
    { label: "report", route: "#/report?range=24h", heading: "Shift handover report" },
  ];

  for (const p of pages) {
    test(`${p.label}: no serious or critical WCAG 2.0 A/AA violations`, async ({ page }) => {
      await openClean(page, p.route, p.heading);
      await expectNoBlockingViolations(page, p.label);
    });
  }

  test("thresholds drawer open: no serious or critical violations", async ({ page }) => {
    await openClean(page, "#/overview", "Network overview");
    await page.getByRole("button", { name: "Thresholds" }).click();
    await expect(page.getByRole("dialog", { name: "KPI thresholds" })).toBeVisible();
    await expectNoBlockingViolations(page, "thresholds-drawer");
  });

  test("data drawer open: no serious or critical violations", async ({ page }) => {
    await openClean(page, "#/overview", "Network overview");
    await page.getByRole("button", { name: "Data" }).click();
    await expect(page.getByRole("dialog", { name: "Data source" })).toBeVisible();
    await expectNoBlockingViolations(page, "data-drawer");
  });

  // While the drawer slides in, its text must already be readable: a scan that happens to run mid-animation (as
  // CI did) must not find half-transparent text blended into the backdrop. The animation is paused at an early
  // frame so the state is deterministic; the precondition fails loudly if the entrance animation is ever removed.
  test("data drawer mid-transition: text keeps its contrast while the drawer slides in", async ({ page }) => {
    await openClean(page, "#/overview", "Network overview");
    await page.getByRole("button", { name: "Data" }).click();
    const drawer = page.getByRole("dialog", { name: "Data source" });
    await expect(drawer).toBeVisible();
    const state = await drawer.evaluate((el) => {
      const animations = el.getAnimations();
      for (const a of animations) {
        a.pause();
        a.currentTime = 40;
      }
      return {
        animations: animations.map((a) => ({ name: a instanceof CSSAnimation ? a.animationName : a.constructor.name, playState: a.playState, currentTime: a.currentTime })),
        opacity: getComputedStyle(el).opacity,
      };
    });
    await test.info().attach("drawer-mid-transition.json", { body: JSON.stringify(state, null, 2), contentType: "application/json" });
    expect(state.animations.length, `precondition: the drawer has an entrance animation (${JSON.stringify(state)})`).toBeGreaterThanOrEqual(1);
    expect(state.animations.every((a) => a.playState === "paused"), "animation paused at 40 ms").toBe(true);
    await expectNoBlockingViolations(page, "data-drawer-mid-transition", ["color-contrast"]);
  });

  test("dark theme (overview and alarms): no serious or critical violations", async ({ page }) => {
    await openClean(page, "#/overview?range=7d", "Network overview");
    await useDarkTheme(page);
    await expectNoBlockingViolations(page, "overview-dark");
    await page.goto("/#/alarms?alarm=ALM-000002");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Alarm and fault tracking");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expectNoBlockingViolations(page, "alarms-dark");
  });

  // Wide tables inside `.table-wrap { overflow: auto }` become scrollable regions whenever the viewport (or the
  // reader's fonts) makes them wider than their card. Such a region needs keyboard access and a name (WCAG 2.1.1,
  // axe `scrollable-region-focusable`). These scans pin viewports where the overflow genuinely occurs — the
  // precondition fails loudly if it ever stops occurring — so the rule cannot pass by accident.
  test.describe("overflowing tables are keyboard-reachable scroll regions (scrollable-region-focusable)", () => {
    const SCROLL_RULE = ["scrollable-region-focusable"];

    test("packets at 1000 px: the protocol hierarchy table overflows its half-width card without a scrollable-region-focusable violation", async ({ page }) => {
      await page.setViewportSize({ width: 1000, height: 800 });
      await openClean(page, "#/packets", "Packet statistics");
      await expectOverflowing(tableWrapOf(page, /^Protocol hierarchy/), "protocol hierarchy table at 1000 px");
      await test.info().attach("overflow-packets-1000.json", { body: JSON.stringify(await tableOverflow(page), null, 2), contentType: "application/json" });
      await expectNoBlockingViolations(page, "packets-1000", SCROLL_RULE);
    });

    test("packets at 375 px: both protocol tables overflow without a scrollable-region-focusable violation", async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 800 });
      await openClean(page, "#/packets", "Packet statistics");
      await expectOverflowing(tableWrapOf(page, /^Protocol hierarchy/), "protocol hierarchy table at 375 px");
      await expectOverflowing(tableWrapOf(page, /^Top conversations/), "top conversations table at 375 px");
      await test.info().attach("overflow-packets-375.json", { body: JSON.stringify(await tableOverflow(page), null, 2), contentType: "application/json" });
      await expectNoBlockingViolations(page, "packets-375", SCROLL_RULE);
    });

    test("report at 375 px: the preview tables overflow without a scrollable-region-focusable violation", async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 800 });
      await openClean(page, "#/report?range=24h", "Shift handover report");
      const overflow = await tableOverflow(page);
      await test.info().attach("overflow-report-375.json", { body: JSON.stringify(overflow, null, 2), contentType: "application/json" });
      const overflowing = overflow.filter((o) => o.scrollWidth > o.clientWidth).map((o) => o.label);
      expect(overflowing.length, `precondition: at least one report table overflows at 375 px (${JSON.stringify(overflow)})`).toBeGreaterThanOrEqual(1);
      await expectNoBlockingViolations(page, "report-375", SCROLL_RULE);
    });
  });

  // A theme switch must never pass through a low-contrast state: if controls transitioned `color` or
  // `background-color`, text would cross-fade against an already re-coloured page for the transition's duration,
  // and a reader (or a scan) looking at that moment would see blended greys. Right after the switch the test
  // therefore asserts (1) that no colour-affecting CSS transition is in flight on any element and (2) that axe finds
  // no contrast violation in that very state. Whatever transitions do run are paused at 60 ms first, so the state
  // under test is deterministic rather than a race against the clock.
  test.describe("theme switch: text keeps its contrast at every moment", () => {
    const COLOUR_PROPERTIES = ["color", "background-color", "opacity", "fill", "stroke"];

    /** Switches to `theme` through the UI and freezes the page one frame later; returns the colour transitions found running. */
    async function switchAndFreeze(page: Page, theme: "Dark" | "Light") {
      await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: theme }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme.toLowerCase());
      const state = await page.evaluate(async (colourProperties: string[]) => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const all = document.getAnimations();
        for (const a of all) {
          a.pause();
          a.currentTime = 60;
        }
        const describe = (el: Element | null | undefined) => {
          if (!el) return "(detached)";
          const cls = el.getAttribute("class");
          return `${el.tagName.toLowerCase()}${cls ? `.${cls.trim().split(/\s+/).join(".")}` : ""}`;
        };
        const colourTransitions = all
          .filter((a): a is CSSTransition => a instanceof CSSTransition && colourProperties.includes(a.transitionProperty))
          .map((a) => ({ property: a.transitionProperty, element: describe((a.effect as KeyframeEffect | null)?.target as Element | null) }));
        const nav = document.querySelector(".nav-item:not(.active)");
        return {
          animationsRunning: all.length,
          colourTransitions,
          navColor: nav ? getComputedStyle(nav).color : null,
          navBackground: nav ? getComputedStyle(nav.closest(".topbar") ?? nav).backgroundColor : null,
        };
      }, COLOUR_PROPERTIES);
      await test.info().attach(`theme-switch-${theme.toLowerCase()}.json`, { body: JSON.stringify(state, null, 2), contentType: "application/json" });
      return state;
    }

    test("switching to dark: no colour transition is in flight and the frozen state has no contrast violation", async ({ page }) => {
      await openClean(page, "#/overview?range=7d", "Network overview");
      const state = await switchAndFreeze(page, "Dark");
      const summary = [...new Set(state.colourTransitions.map((t) => `${t.property} on ${t.element}`))].slice(0, 12);
      expect(state.colourTransitions, `colour transitions running right after the switch to dark (${state.colourTransitions.length}): ${summary.join(" | ")}`).toEqual([]);
      await expectNoBlockingViolations(page, "theme-switch-dark", ["color-contrast"]);
    });

    test("switching back to light: no colour transition is in flight and the frozen state has no contrast violation", async ({ page }) => {
      await openClean(page, "#/overview?range=7d", "Network overview");
      await useDarkTheme(page);
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.then(() => undefined, () => undefined))));
      const state = await switchAndFreeze(page, "Light");
      const summary = [...new Set(state.colourTransitions.map((t) => `${t.property} on ${t.element}`))].slice(0, 12);
      expect(state.colourTransitions, `colour transitions running right after the switch to light (${state.colourTransitions.length}): ${summary.join(" | ")}`).toEqual([]);
      await expectNoBlockingViolations(page, "theme-switch-light", ["color-contrast"]);
    });
  });

  // Recharts charts are keyboard-focusable and open their tooltip on focus. The tooltip text must meet the AA
  // contrast ratio in both themes; the scans run with the tooltip genuinely open, reached by the keyboard only.
  test.describe("keyboard-focused chart tooltips (color-contrast)", () => {
    const CONTRAST_RULE = ["color-contrast"];
    const charts: { label: string; route: string; heading: string; from: (page: Page) => Locator; maxTabs: number; tooltip: RegExp }[] = [
      { label: "packets-bar", route: "#/packets", heading: "Packet statistics", from: (page) => page.getByRole("button", { name: "Hierarchy CSV" }), maxTabs: 3, tooltip: /Bytes \(MB\)/ },
      {
        label: "kpis-line",
        route: "#/kpis?cell=VSKP-007-N1&kpi=prbUtilizationPct&range=7d&compare=VSKP-001-N1",
        heading: "KPI analysis",
        from: (page) => page.getByRole("button", { name: "Export cell CSV" }),
        maxTabs: 2,
        tooltip: /VSKP-001-N1/,
      },
      {
        label: "alarms-explain",
        route: "#/alarms?alarm=ALM-000002&range=7d",
        heading: "Alarm and fault tracking",
        from: (page) => page.locator("section.card", { has: page.getByRole("heading", { level: 2, name: /^Explain ALM-000002/ }) }).getByRole("button", { name: "Close" }),
        maxTabs: 4,
        tooltip: /PRB utilization/,
      },
    ];

    for (const theme of ["light", "dark"] as const) {
      for (const c of charts) {
        test(`${c.label} (${theme}): the tooltip opened by keyboard focus has sufficient contrast`, async ({ page }) => {
          await openClean(page, c.route, c.heading);
          if (theme === "dark") await useDarkTheme(page);
          await tabIntoChart(page, c.from(page), c.maxTabs, `${c.label} (${theme})`);
          const tooltip = page.locator(".recharts-tooltip-wrapper").filter({ hasText: c.tooltip }).first();
          await expect(tooltip, `${c.label} (${theme}): tooltip opens on keyboard focus`).toBeVisible();
          const colours = await tooltip.evaluate((el) => {
            const item = el.querySelector(".recharts-tooltip-item-name") ?? el.querySelector(".recharts-tooltip-label");
            const box = el.querySelector(".recharts-default-tooltip") ?? el;
            return { text: el.textContent, itemColor: item ? getComputedStyle(item).color : null, background: getComputedStyle(box).backgroundColor };
          });
          await test.info().attach(`tooltip-${c.label}-${theme}.json`, { body: JSON.stringify(colours, null, 2), contentType: "application/json" });
          await expectNoBlockingViolations(page, `${c.label}-${theme}-tooltip`, CONTRAST_RULE);
        });
      }
    }
  });
});
