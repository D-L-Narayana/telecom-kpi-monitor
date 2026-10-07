/**
 * Analyst workflows (WF1–WF9) on the production bundle served with the production headers.
 *
 * Every test attaches the security collectors before the first navigation and asserts at the end that the enforced
 * Content Security Policy produced no violation events or console refusals, that no request left the application
 * origin and that no uncaught error was thrown. Downloads are read back from disk and their content is asserted.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { attachSecurityCollectors, csvLines, downloadText, expectCleanSecurity } from "./helpers";

const fixture = (relative: string) => fileURLToPath(new URL(`../tests/fixtures/${relative}`, import.meta.url));
const h1 = (page: Page) => page.getByRole("heading", { level: 1 });
const primaryNav = (page: Page) => page.getByRole("navigation", { name: "Primary" });
/** Query parameters of the current hash route. */
const hashParams = (page: Page) => new URLSearchParams(new URL(page.url()).hash.replace(/^#\/[^?]*\??/, ""));
/** A Card section identified by its heading (string titles must match exactly: "Notes" is not "Handover notes"). */
const card = (page: Page, title: string | RegExp) =>
  page.locator("section.card", { has: page.getByRole("heading", { level: 2, name: title, exact: typeof title === "string" }) });
/** Clicks a control and returns the text of the file it downloads. */
async function downloadFrom(page: Page, control: Locator): Promise<{ name: string; text: string }> {
  const [download] = await Promise.all([page.waitForEvent("download"), control.click()]);
  return { name: download.suggestedFilename(), text: await downloadText(download) };
}
/** Opens a hash route; same-document hash changes are handled by the app's hashchange listener. */
async function open(page: Page, route: string): Promise<void> {
  await page.goto(`/${route}`);
}

test.describe("analyst workflows under the production CSP", () => {
  test("WF1 shift start: 7-day detections show the injected incidents and link into the PRB chart", async ({ page }) => {
    const security = await attachSecurityCollectors(page);
    await open(page, "#/overview?range=7d&tech=All");
    await expect(h1(page)).toHaveText("Network overview");
    await expect(page.getByRole("group", { name: "Time range" }).getByRole("button", { name: "7d" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("button.kpi-card")).toHaveCount(7);
    for (const link of await primaryNav(page).getByRole("link").all()) {
      expect(await link.getAttribute("href"), "nav links carry the global filters").toContain("range=7d");
    }

    const detections = card(page, "Congestion, outage and fault detection").locator(".detect-list > li");
    await expect(detections.filter({ hasText: "outage" }).filter({ hasText: "VSKP-004-L2" })).toHaveCount(1);
    await expect(detections.filter({ hasText: "congestion" }).filter({ hasText: "VSKP-007-N1" })).toHaveCount(1);
    expect(await detections.filter({ hasText: "latency" }).filter({ hasText: /VSKP-010-/ }).count(), "latency detections on VSKP-010 cells").toBeGreaterThanOrEqual(1);

    await detections.filter({ hasText: "congestion" }).getByRole("link", { name: "VSKP-007-N1" }).click();
    await expect(h1(page)).toHaveText("KPI analysis");
    const params = hashParams(page);
    expect(params.get("range"), "deep link keeps the 7d range").toBe("7d");
    expect(params.get("cell")).toBe("VSKP-007-N1");
    expect(params.get("kpi")).toBe("prbUtilizationPct");
    const chart = page.locator(".recharts-wrapper").first();
    await expect(chart.locator(".recharts-line-curve").first()).toBeVisible();
    expect(await chart.locator(".recharts-scatter-symbol").count(), "breach markers on the PRB chart").toBeGreaterThan(0);
    await expectCleanSecurity(page, security);
  });

  test("WF2 KPI deep link: compare overlay, invalid KPI parameter, cell CSV export", async ({ page }) => {
    const security = await attachSecurityCollectors(page);
    await open(page, "#/kpis?cell=VSKP-007-N1&kpi=prbUtilizationPct&range=7d&compare=VSKP-001-N1");
    await expect(h1(page)).toHaveText("KPI analysis");
    const chart = page.locator(".recharts-wrapper").first();
    await expect(chart.locator(".recharts-line-curve"), "two series: the cell and the compare cell").toHaveCount(2);
    await expect(chart.locator(".recharts-legend-wrapper")).toContainText("VSKP-001-N1");

    // An unknown KPI in the URL is reported, not fatal.
    await open(page, "#/kpis?cell=VSKP-007-N1&kpi=bogus&range=7d");
    await expect(h1(page)).toHaveText("KPI analysis");
    await expect(page.locator(".notice").first()).toContainText("bogus");
    await expect(page.locator(".recharts-wrapper").first().locator(".recharts-line-curve").first()).toBeVisible();

    // Cell CSV: one header plus every 15-minute interval of the 7d window. The window is (now − 7d, now] and the
    // dataset's first sample sits exactly at now − 7d, so the export holds 671 of the cell's 672 samples.
    await open(page, "#/kpis?cell=VSKP-007-N1&kpi=prbUtilizationPct&range=7d");
    const csv = await downloadFrom(page, page.getByRole("button", { name: "Export cell CSV" }));
    expect(csv.name).toBe("kpi_VSKP-007-N1_7d.csv");
    const lines = csvLines(csv.text);
    const header = lines[0].split(",");
    expect(header.slice(0, 2)).toEqual(["timestamp_utc", "cellId"]);
    expect(header).toContain("prbUtilizationPct");
    expect(header[header.length - 1]).toBe("activeUsers");
    expect(lines.length - 1, "data rows").toBe(671);
    expect(lines.slice(1).every((l) => l.split(",")[1] === "VSKP-007-N1")).toBe(true);
    await expectCleanSecurity(page, security);
  });

  test("WF3 alarm handling: filter, explain, acknowledge with note, persisted audit, CSV exports", async ({ page }) => {
    const security = await attachSecurityCollectors(page);
    await open(page, "#/alarms?range=7d");
    await expect(h1(page)).toHaveText("Alarm and fault tracking");
    await page.getByLabel("Severity filter").selectOption("Major");
    await page.getByLabel("State filter").selectOption("active");
    expect(hashParams(page).get("severity")).toBe("Major");
    expect(hashParams(page).get("state")).toBe("active");
    const table = page.getByRole("table", { name: "Alarms" });
    const rows = table.locator("tbody tr");
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);
    expect(rowCount).toBeLessThanOrEqual(50);
    for (const text of await rows.allInnerTexts()) {
      expect(text).toContain("Major");
      expect(text).toContain("active");
    }

    await page.locator("#alarm-row-ALM-000002 td").first().click();
    expect(hashParams(page).get("alarm")).toBe("ALM-000002");
    const explain = card(page, /^Explain ALM-000002/);
    await expect(explain).toBeVisible();
    await expect(explain.locator(".badge.verdict-strong")).toHaveText("strong");
    await expect(explain.locator(".badge.state-active")).toBeVisible();

    const note = "Evening congestion confirmed, capacity ticket raised";
    await explain.getByLabel("Note (optional)").fill(note);
    await explain.locator(".explain-actions").getByRole("button", { name: "Ack" }).click();
    await expect(explain.locator(".badge.state-acknowledged")).toBeVisible();
    await expect(explain).toContainText(note);
    const audit = card(page, /^Audit trail/).locator("ul.audit > li");
    await expect(audit).toHaveCount(1);
    await expect(audit.first()).toContainText("acknowledge");
    await expect(audit.first()).toContainText("ALM-000002");
    await expect(audit.first()).toContainText(note);
    // The acknowledged alarm no longer matches the "active" filter; the explain panel keeps it via ?alarm=.
    await expect(page.locator("#alarm-row-ALM-000002")).toHaveCount(0);

    await page.reload();
    await expect(h1(page)).toHaveText("Alarm and fault tracking");
    const explainAfterReload = card(page, /^Explain ALM-000002/);
    await expect(explainAfterReload.locator(".badge.state-acknowledged")).toBeVisible();
    await expect(explainAfterReload).toContainText(note);
    await expect(card(page, /^Audit trail/).locator("ul.audit > li")).toHaveCount(1);

    const auditCsv = await downloadFrom(page, page.getByRole("button", { name: "Export audit CSV" }));
    expect(auditCsv.name).toBe("alarm-audit.csv");
    const auditLines = csvLines(auditCsv.text);
    expect(auditLines[0]).toBe("at,alarmId,action,note");
    expect(auditLines).toHaveLength(2);
    expect(auditLines[1]).toContain("ALM-000002,acknowledge,");
    expect(auditLines[1]).toContain(note);

    const alarmsCsv = await downloadFrom(page, page.getByRole("button", { name: "Export CSV", exact: true }));
    expect(alarmsCsv.name).toBe("alarms.csv");
    const alarmLines = csvLines(alarmsCsv.text);
    const columns = alarmLines[0].split(",");
    expect(columns).toContain("correlation");
    expect(columns.slice(0, 2)).toEqual(["alarmId", "timestamp"]);
    expect(alarmLines.length - 1, "one row per alarm matching Major + active (ALM-000002 is acknowledged now)").toBe(rowCount - 1);
    await expectCleanSecurity(page, security);
  });

  test("WF4 thresholds: validation keeps a cleared field, a tightened PRB threshold flips the card, reset restores it", async ({ page }) => {
    const security = await attachSecurityCollectors(page);
    await open(page, "#/overview?range=24h&tech=All");
    await expect(h1(page)).toHaveText("Network overview");
    const prbCard = page.locator("button.kpi-card", { hasText: "PRB utilization" });
    await expect(prbCard).toHaveAttribute("aria-label", /, OK,/);

    await page.getByRole("button", { name: "Thresholds" }).click();
    const dialog = page.getByRole("dialog", { name: "KPI thresholds" });
    await expect(dialog).toBeVisible();
    const warning = dialog.getByLabel("PRB utilization (%) warning");
    const critical = dialog.getByLabel("PRB utilization (%) critical");
    await expect(warning).toHaveValue("70");
    await expect(critical).toHaveValue("85");
    const storedPrb = () => page.evaluate(() => {
      const raw = localStorage.getItem("tkm.thresholds.v1");
      return raw ? (JSON.parse(raw) as { prbUtilizationPct?: { warning: number; critical: number } }).prbUtilizationPct ?? null : null;
    });

    // Clearing a field is an inline error on that field; the value in force (85) must not silently become 0.
    await critical.fill("");
    await expect(critical).toHaveAttribute("aria-invalid", "true");
    await expect(dialog.locator(".field-error").filter({ hasText: /enter a number/i })).toBeVisible();
    await expect(prbCard).toHaveAttribute("aria-label", /, OK,/);
    expect((await storedPrb())?.critical ?? 85, "nothing persisted as 0").toBe(85);
    await critical.fill("85");
    await expect(critical).not.toHaveAttribute("aria-invalid", "true");
    await expect(dialog.getByText(/enter a number/i)).toHaveCount(0);

    // The network-wide PRB mean over 24 h is about 28 %, so warning 20 / critical 25 (valid ordering) turns the card critical.
    await warning.fill("20");
    await critical.fill("25");
    await expect(dialog.getByText(/warning must be/i)).toHaveCount(0);
    await expect.poll(storedPrb, { message: "valid edits are persisted" }).toMatchObject({ warning: 20, critical: 25 });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(prbCard).toHaveAttribute("aria-label", /, Critical,/);
    await page.reload();
    await expect(page.locator("button.kpi-card", { hasText: "PRB utilization" })).toHaveAttribute("aria-label", /, Critical,/);

    await page.getByRole("button", { name: "Thresholds" }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("PRB utilization (%) critical")).toHaveValue("25");
    page.once("dialog", (d) => d.accept());
    await dialog.getByRole("button", { name: /reset to defaults/i }).click();
    await expect(dialog.getByLabel("PRB utilization (%) critical")).toHaveValue("85");
    await expect(dialog.getByLabel("PRB utilization (%) warning")).toHaveValue("70");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.locator("button.kpi-card", { hasText: "PRB utilization" })).toHaveAttribute("aria-label", /, OK,/);
    expect(await storedPrb(), "reset clears the stored thresholds").toBeNull();
    await expectCleanSecurity(page, security);
  });

  test("WF5 bring-your-own data: import, analyse, empty packets, back to synthetic", async ({ page }) => {
    const security = await attachSecurityCollectors(page);
    await open(page, "#/overview?range=24h&tech=All");
    await expect(h1(page)).toHaveText("Network overview");
    await page.getByRole("button", { name: "Data" }).click();
    const dialog = page.getByRole("dialog", { name: "Data source" });
    await expect(dialog).toBeVisible();
    await dialog.locator('input[type="file"]').setInputFiles([fixture("import/kpi_small.csv"), fixture("import/cells.json")]);
    const summaryValue = (label: string) => dialog.locator("dl.import-summary > div", { has: page.locator("dt", { hasText: label }) }).locator("dd");
    await expect(summaryValue("Rows")).toHaveText("32");
    await expect(summaryValue("Cells")).toHaveText("4");
    await expect(summaryValue("Sites")).toHaveText("2");
    await expect(summaryValue("Interval")).toHaveText("15 min");
    await expect(dialog.getByRole("status").filter({ hasText: /ready to use/i })).toBeVisible();
    await dialog.getByRole("button", { name: "Use dataset" }).click();
    await expect(dialog).toBeHidden();

    const footer = page.locator("footer.footer");
    await expect(footer).toContainText('Imported dataset "kpi_small.csv" (32 KPI samples, 4 cells, 2 sites, 0 alarms)');
    const subtitle = page.locator(".page-head .muted");
    await expect(subtitle).toContainText("kpi_small.csv");
    await expect(subtitle).toContainText("2 sites");
    await expect(subtitle).toContainText("4 cells");
    // "now" is the imported end: the last sample is 2026-09-23T08:00Z = 13:30 IST.
    await expect(subtitle).toContainText(/ending 23 Sept?,?\s+13:30 IST/);
    await expect(page.locator("button.kpi-card")).toHaveCount(7);

    await primaryNav(page).getByRole("link", { name: "Packets" }).click();
    await expect(h1(page)).toHaveText("Packet statistics");
    await expect(page.locator(".empty").first()).toBeVisible();
    await expect(page.getByText("Load capture export").first()).toBeVisible();

    await page.getByRole("button", { name: "Data" }).click();
    await dialog.getByRole("button", { name: "Back to synthetic" }).click();
    await expect(dialog).toBeHidden();
    await expect(footer).toContainText("Synthetic data (12 sites, 48 cells, 7 days of 15-minute KPIs, 300 alarms)");
    await page.getByRole("button", { name: "Data" }).click();
    await expect(dialog).toContainText("32,256 rows");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expectCleanSecurity(page, security);
  });

  test("WF6 packets: tshark JSON hierarchy with retransmissions, io,phs tree, CSV with parent column", async ({ page }) => {
    const security = await attachSecurityCollectors(page);
    await open(page, "#/packets");
    await expect(h1(page)).toHaveText("Packet statistics");
    const fileInput = page.locator('input[type="file"]').first();

    await fileInput.setInputFiles(fixture("pcap/tshark.json"));
    const hierarchy = card(page, /Protocol hierarchy/);
    await expect(hierarchy.getByRole("heading", { level: 2 })).toContainText("tshark.json");
    const childRows = hierarchy.locator("tbody td").filter({ hasText: "↳" });
    expect(await childRows.count(), "encapsulated protocols rendered as children").toBeGreaterThan(0);
    await expect(hierarchy.locator("tbody")).toContainText("gtp");
    await expect(hierarchy.locator("tbody")).toContainText("tcp");
    const retransTile = page.locator(".tile", { hasText: "TCP retransmissions" }).locator(".tile-value");
    await expect(retransTile).toHaveText(/^1\b/);

    await fileInput.setInputFiles(fixture("pcap/phs.txt"));
    await expect(hierarchy.getByRole("heading", { level: 2 })).toContainText("phs.txt");
    await expect(hierarchy.locator("tbody")).toContainText("gtp");
    await expect(hierarchy.locator("tbody")).toContainText("s1ap");
    expect(await hierarchy.locator("tbody td").filter({ hasText: "↳" }).count(), "io,phs tree depth").toBeGreaterThan(0);
    await expect(page.locator(".tile", { hasText: "Frames" }).locator(".tile-value")).toHaveText("12");

    const csv = await downloadFrom(page, hierarchy.getByRole("button", { name: "Hierarchy CSV" }));
    expect(csv.name).toBe("phs_protocol_hierarchy.csv");
    const lines = csvLines(csv.text);
    expect(lines[0]).toBe("protocol,parent,packets,bytes,retransmissions");
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.slice(1).some((l) => l.split(",")[1] !== ""), "child rows carry their parent").toBe(true);
    expect(lines.slice(1).some((l) => l.startsWith("s1ap,")), "s1ap row exported").toBe(true);
    await expectCleanSecurity(page, security);
  });

  test("WF6b packets keyboard: overflowing protocol tables are named scrollable regions reached with Tab and scrolled with the arrow keys", async ({ page }) => {
    const security = await attachSecurityCollectors(page);
    const geometry = (wrap: Locator) => wrap.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    const scrollLeft = (el: Locator) => el.evaluate((node) => node.scrollLeft);
    const expectOverflowing = async (wrap: Locator, label: string) => {
      const g = await geometry(wrap);
      expect(g.scrollWidth, `precondition: ${label} overflows (scrollWidth ${g.scrollWidth} > clientWidth ${g.clientWidth})`).toBeGreaterThan(g.clientWidth);
    };
    /**
     * From the card's export button, one Tab must land on a region whose accessible name identifies the table
     * (not merely on "some scroller": Chromium can focus bare scroll containers on its own), the arrow keys must
     * scroll that region, and Shift+Tab must come back to the button.
     */
    const expectKeyboardScrollRegion = async (from: Locator, name: RegExp, label: string) => {
      const region = page.getByRole("region", { name });
      await from.focus();
      await expect(from).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(region, `${label}: Tab from the button reaches the region named ${name}`).toBeFocused();
      await region.evaluate((el) => { el.scrollLeft = 0; });
      for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
      await expect.poll(() => scrollLeft(region), { message: `${label}: ArrowRight scrolls the region` }).toBeGreaterThan(0);
      await page.keyboard.press("Shift+Tab");
      await expect(from, `${label}: Shift+Tab returns to the button`).toBeFocused();
    };

    // Two-column desktop layout: the hierarchy table is wider than its half-width card.
    await page.setViewportSize({ width: 1000, height: 800 });
    await open(page, "#/packets");
    await expect(h1(page)).toHaveText("Packet statistics");
    const hierarchy = card(page, /^Protocol hierarchy/).locator(".table-wrap");
    await expectOverflowing(hierarchy, "protocol hierarchy table at 1000 px");
    await expectKeyboardScrollRegion(page.getByRole("button", { name: "Hierarchy CSV" }), /protocol hierarchy/i, "hierarchy at 1000 px");

    // Single-column phone layout: both tables overflow.
    await page.setViewportSize({ width: 375, height: 800 });
    await page.reload();
    await expect(h1(page)).toHaveText("Packet statistics");
    const conversations = card(page, /^Top conversations/).locator(".table-wrap");
    await expectOverflowing(hierarchy, "protocol hierarchy table at 375 px");
    await expectOverflowing(conversations, "top conversations table at 375 px");
    await expectKeyboardScrollRegion(page.getByRole("button", { name: "Hierarchy CSV" }), /protocol hierarchy/i, "hierarchy at 375 px");
    await expectKeyboardScrollRegion(page.getByRole("button", { name: "Conversations CSV" }), /top conversations/i, "conversations at 375 px");
    await expectCleanSecurity(page, security);
  });

  test("WF7 sites: map and region tiles, selecting a site, availability below 100, open alarms", async ({ page }) => {
    const security = await attachSecurityCollectors(page);
    await open(page, "#/sites?range=7d");
    await expect(h1(page)).toHaveText("Sites and regions");
    await expect(page.locator("svg.site-map circle[role='button']")).toHaveCount(12);
    await expect(page.locator(".region-tile")).toHaveCount(3);

    await page.getByRole("button", { name: /^VSKP-004\b/ }).click();
    expect(hashParams(page).get("site")).toBe("VSKP-004");
    await expect(page.locator("svg.site-map circle[aria-pressed='true']")).toHaveCount(1);
    const detail = card(page, /^Site VSKP-004\b/);
    await expect(detail).toBeVisible();
    await expect(detail).toContainText(/availability 9\d\.\d %/); // 24 down intervals of 2,684 → below 100 %
    const sitesTable = card(page, /^Sites \(12\)$/).getByRole("table");
    const row = sitesTable.locator("tbody tr[aria-selected='true']");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("VSKP-004");
    const headers = await sitesTable.locator("thead th").allInnerTexts();
    const availabilityIndex = headers.findIndex((h) => /availability/i.test(h));
    expect(availabilityIndex, "availability column").toBeGreaterThanOrEqual(0);
    const availability = parseFloat(await row.locator("td").nth(availabilityIndex).innerText());
    expect(availability).toBeGreaterThan(90);
    expect(availability).toBeLessThan(100);
    // The outage site is the only one below 100 % availability over 7 days: sorting by availability puts it first.
    await sitesTable.getByRole("button", { name: "Availability %" }).click();
    await expect(sitesTable.locator("thead th[aria-sort='ascending']")).toContainText("Availability %");
    await expect(sitesTable.locator("tbody tr").first()).toContainText("VSKP-004");

    const openAlarms = detail.getByRole("link", { name: "Open alarms" });
    expect(await openAlarms.getAttribute("href")).toContain("site=VSKP-004");
    await openAlarms.click();
    await expect(h1(page)).toHaveText("Alarm and fault tracking");
    expect(hashParams(page).get("site")).toBe("VSKP-004");
    await expect(page.getByLabel("Site filter")).toHaveValue("VSKP-004");
    await expectCleanSecurity(page, security);
  });

  test("WF8 shift report: preview, Markdown download, print stylesheet hides the chrome", async ({ page }) => {
    const security = await attachSecurityCollectors(page);
    await open(page, "#/report?range=24h");
    await expect(h1(page)).toHaveText("Shift handover report");
    const preview = page.getByRole("article", { name: "Report preview" });
    await expect(preview.getByRole("heading", { level: 2 })).toHaveText(["Window", "KPIs", "Detections", "Worst cells", "Alarms", "Notes"]);
    await expect(preview.getByRole("table", { name: "Network KPIs" }).locator("tbody tr")).toHaveCount(7);

    const note = "Follow up on VSKP-007-N1 capacity with the planning team";
    await page.getByLabel("Handover notes").fill(note);
    await expect(card(page, "Notes")).toContainText(note);

    const md = await downloadFrom(page, page.getByRole("button", { name: "Download Markdown" }));
    expect(md.name).toBe("shift-report_20260923-1430_24h_All.md"); // dataset "now" = 23 Sep 2026 14:30 IST
    expect(md.text).toContain("## Detections");
    expect(md.text).toContain("## Worst cells");
    expect(md.text).toContain("## Notes");
    expect(md.text).toContain(note);

    // Five CSV sections in one click.
    const sections: string[] = [];
    page.on("download", (d) => { sections.push(d.suggestedFilename()); });
    await page.getByRole("button", { name: "Download CSV sections" }).click();
    await expect.poll(() => sections.length, { message: "five CSV section downloads" }).toBe(5);
    expect(sections.sort()).toEqual([
      "shift-report_20260923-1430_24h_All_alarms_cleared.csv",
      "shift-report_20260923-1430_24h_All_alarms_raised.csv",
      "shift-report_20260923-1430_24h_All_detections.csv",
      "shift-report_20260923-1430_24h_All_kpis.csv",
      "shift-report_20260923-1430_24h_All_worst_cells.csv",
    ]);

    // Notes persist in this browser.
    await page.reload();
    await expect(page.getByLabel("Handover notes")).toHaveValue(note);
    expect(await page.evaluate(() => localStorage.getItem("tkm.report.notes.v1"))).toBe(note);

    await page.emulateMedia({ media: "print" });
    const printState = await page.evaluate(() => ({
      hidden: Array.from(document.querySelectorAll<HTMLElement>("header.topbar, footer.footer, .no-print")).map((el) => getComputedStyle(el).display),
      preview: getComputedStyle(document.querySelector<HTMLElement>("article.report-preview")!).display,
    }));
    expect(printState.hidden.length).toBeGreaterThanOrEqual(4); // topbar, footer, notes card, toolbar
    expect(printState.hidden.every((d) => d === "none"), "navigation and chrome hidden in print").toBe(true);
    expect(printState.preview, "report body stays visible in print").not.toBe("none");
    await page.emulateMedia({ media: null });
    await expect(primaryNav(page)).toBeVisible();
    await expectCleanSecurity(page, security);
  });

  test("WF9 theme and layout: dark theme persists across reloads; 375 px viewport has no horizontal page scroll", async ({ page }) => {
    const security = await attachSecurityCollectors(page);
    await open(page, "#/overview?range=24h");
    await expect(h1(page)).toHaveText("Network overview");
    const theme = page.getByRole("group", { name: "Theme" });
    await theme.getByRole("button", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(theme.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => localStorage.getItem("tkm.theme.v1"))).toBe("dark");

    await page.setViewportSize({ width: 375, height: 740 });
    for (const route of ["#/overview?range=7d", "#/kpis?cell=VSKP-007-N1&kpi=prbUtilizationPct", "#/alarms", "#/sites", "#/report"]) {
      await open(page, route);
      await expect(h1(page)).toBeVisible();
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth, `${route} fits a 375 px viewport`).toBeLessThanOrEqual(375);
    }
    await theme.getByRole("button", { name: "Light" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expectCleanSecurity(page, security);
  });
});
