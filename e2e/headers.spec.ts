/**
 * Production response headers. `vite preview` serves the headers declared in vercel.json, so these checks hold for
 * the deployment and for the local preview alike: the document, the SPA fallback for deep paths, static files and the
 * compiled JavaScript / CSS assets must all carry exactly the declared Content-Security-Policy,
 * X-Content-Type-Options, Referrer-Policy, Permissions-Policy and X-Frame-Options values.
 */
import { expect, test, type Response } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REQUIRED_HEADERS, expectProductionHeaders, readProductionHeaders } from "./helpers";

const expected = readProductionHeaders();
const distFile = (relative: string) => fileURLToPath(new URL(`../dist/${relative.replace(/^\/+/, "")}`, import.meta.url));

test.describe("production response headers (single source of truth: vercel.json)", () => {
  test("the server under test serves this repository's production build", async ({ request }) => {
    const built = readFileSync(distFile("index.html"), "utf8"); // fails loudly when dist/ is missing: build first
    const response = await request.get("/");
    expect(response.status()).toBe(200);
    expect(await response.text(), "GET / must be dist/index.html — nothing else may occupy the preview port").toBe(built);
    const assets = [...built.matchAll(/\/assets\/[^"']+/g)].map((m) => m[0]);
    expect(assets.length, "compiled assets referenced by index.html").toBeGreaterThanOrEqual(2);
    for (const asset of assets) expect(existsSync(distFile(asset)), `${asset} exists in dist/`).toBe(true);
  });

  test("vercel.json declares the five security headers with the production CSP", () => {
    for (const name of REQUIRED_HEADERS) expect(expected[name], name).toBeTruthy();
    const csp = expected["content-security-policy"];
    for (const directive of ["default-src 'self'", "script-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'", "form-action 'self'"]) {
      expect(csp, directive).toContain(directive);
    }
    expect(csp).not.toMatch(/unsafe-eval/);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(expected["x-content-type-options"]).toBe("nosniff");
    expect(expected["x-frame-options"]).toBe("DENY");
  });

  test("GET / carries exactly the production headers", async ({ page }) => {
    const response = await page.goto("/");
    expect(response).not.toBeNull();
    expect(response!.status()).toBe(200);
    expect(response!.headers()["content-type"]).toMatch(/text\/html/);
    expectProductionHeaders(response!.headers(), expected, "GET /");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Network overview");
  });

  test("GET /#/report carries exactly the production headers", async ({ page }) => {
    const response = await page.goto("/#/report");
    expect(response).not.toBeNull();
    expect(response!.status()).toBe(200);
    expect(response!.headers()["content-type"]).toMatch(/text\/html/);
    expectProductionHeaders(response!.headers(), expected, "GET /#/report");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Shift handover report");
  });

  test("compiled /assets/*.js and /assets/*.css responses carry the same headers and correct content types", async ({ page }) => {
    const assets: Response[] = [];
    page.on("response", (r) => {
      if (/\/assets\/[^/?]+\.(js|css)$/.test(new URL(r.url()).pathname)) assets.push(r);
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Network overview");

    const scripts = assets.filter((r) => new URL(r.url()).pathname.endsWith(".js"));
    const styles = assets.filter((r) => new URL(r.url()).pathname.endsWith(".css"));
    expect(scripts.length, "compiled JavaScript chunks requested by the document").toBeGreaterThanOrEqual(1);
    expect(styles.length, "compiled stylesheet requested by the document").toBeGreaterThanOrEqual(1);
    for (const r of scripts) {
      const label = `GET ${new URL(r.url()).pathname}`;
      expect(r.status(), label).toBe(200);
      expect(r.headers()["content-type"], label).toMatch(/javascript/);
      expectProductionHeaders(r.headers(), expected, label);
    }
    for (const r of styles) {
      const label = `GET ${new URL(r.url()).pathname}`;
      expect(r.status(), label).toBe(200);
      expect(r.headers()["content-type"], label).toMatch(/text\/css/);
      expectProductionHeaders(r.headers(), expected, label);
    }
  });

  test("the SPA fallback for a deep path and the static files carry the headers too", async ({ request }) => {
    const deep = await request.get("/sites");
    expect(deep.status()).toBe(200);
    expect(deep.headers()["content-type"]).toMatch(/text\/html/);
    expectProductionHeaders(deep.headers(), expected, "GET /sites");

    const robots = await request.get("/robots.txt");
    expect(robots.status()).toBe(200);
    expectProductionHeaders(robots.headers(), expected, "GET /robots.txt");

    const favicon = await request.get("/favicon.svg");
    expect(favicon.status()).toBe(200);
    expect(favicon.headers()["content-type"]).toMatch(/svg/);
    expectProductionHeaders(favicon.headers(), expected, "GET /favicon.svg");
  });
});
