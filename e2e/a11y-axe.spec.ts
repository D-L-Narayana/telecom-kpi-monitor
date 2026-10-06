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
import { expect, test, type Page } from "@playwright/test";
import { attachSecurityCollectors, expectCleanSecurity } from "./helpers";

const TAGS = ["wcag2a", "wcag2aa"];
const BLOCKING = new Set(["serious", "critical"]);

function describeViolation(v: Result): string {
  const targets = v.nodes.slice(0, 5).map((n) => n.target.join(" ")).join(" | ");
  return `${v.id} [${v.impact}] ${v.help} — ${targets}${v.nodes.length > 5 ? ` (+${v.nodes.length - 5} more)` : ""}`;
}

/** Runs axe on the current document and fails on any serious or critical violation; all violations are attached. */
async function expectNoBlockingViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  await test.info().attach(`axe-${label}.json`, {
    body: JSON.stringify({ url: results.url, violations: results.violations, incomplete: results.incomplete.map((i) => i.id) }, null, 2),
    contentType: "application/json",
  });
  const blocking = results.violations.filter((v) => typeof v.impact === "string" && BLOCKING.has(v.impact)).map(describeViolation);
  expect(blocking, `${label}: serious/critical axe violations (${TAGS.join(", ")})`).toEqual([]);
}

async function openClean(page: Page, route: string, heading: string | RegExp) {
  const security = await attachSecurityCollectors(page);
  await page.goto(`/${route}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
  await expectCleanSecurity(page, security);
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

  test("dark theme (overview and alarms): no serious or critical violations", async ({ page }) => {
    await openClean(page, "#/overview?range=7d", "Network overview");
    await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expectNoBlockingViolations(page, "overview-dark");
    await page.goto("/#/alarms?alarm=ALM-000002");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Alarm and fault tracking");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expectNoBlockingViolations(page, "alarms-dark");
  });
});
