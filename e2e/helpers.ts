/**
 * Shared e2e helpers: security collectors (CSP violations, CSP console refusals, foreign-origin requests, uncaught
 * page errors) and the production response headers read from vercel.json so that the specs and the deployment share
 * one source of truth.
 */
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface CspViolation {
  directive: string;
  blockedURI: string;
  sourceFile: string;
  line: number;
}

export interface SecurityCollectors {
  /** `securitypolicyviolation` events from every document the page loaded (survives reloads and navigations). */
  cspViolations: CspViolation[];
  /** Console messages mentioning the Content Security Policy or a refused resource. */
  cspConsole: string[];
  /** Requests whose origin is not the application origin (data:, blob: and about: URLs are not requests). */
  foreignRequests: string[];
  /** Uncaught exceptions reported by the page. */
  pageErrors: string[];
}

const VIOLATION_TAG = "[securitypolicyviolation]";

declare global {
  interface Window {
    __cspViolations?: CspViolation[];
  }
}

/**
 * Attaches the collectors to a page. Call before the first navigation. The init script runs in every document before
 * the application code, records violations on `window.__cspViolations` and echoes them to the console so that the
 * Node side keeps them across reloads.
 */
export async function attachSecurityCollectors(page: Page): Promise<SecurityCollectors> {
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) throw new Error("playwright.config.ts must set use.baseURL");
  const appOrigin = new URL(baseURL).origin;
  const collectors: SecurityCollectors = { cspViolations: [], cspConsole: [], foreignRequests: [], pageErrors: [] };

  await page.addInitScript((tag: string) => {
    window.__cspViolations = [];
    document.addEventListener(
      "securitypolicyviolation",
      (e) => {
        const v = { directive: e.violatedDirective, blockedURI: e.blockedURI, sourceFile: e.sourceFile, line: e.lineNumber };
        window.__cspViolations?.push(v);
        console.warn(`${tag} ${JSON.stringify(v)}`);
      },
      true,
    );
  }, VIOLATION_TAG);

  page.on("console", (msg) => {
    const text = msg.text();
    if (text.startsWith(VIOLATION_TAG)) {
      collectors.cspViolations.push(JSON.parse(text.slice(VIOLATION_TAG.length).trim()) as CspViolation);
    } else if (/Content Security Policy|Refused to/i.test(text)) {
      collectors.cspConsole.push(`${msg.type()}: ${text}`);
    }
  });
  page.on("pageerror", (err) => collectors.pageErrors.push(err.message));
  page.on("request", (req) => {
    const url = req.url();
    if (/^(data|blob|about):/i.test(url)) return;
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      origin = url;
    }
    if (origin !== appOrigin) collectors.foreignRequests.push(`${req.method()} ${url}`);
  });
  return collectors;
}

/** Asserts that nothing was blocked, refused, thrown or fetched from another origin. */
export async function expectCleanSecurity(page: Page, collectors: SecurityCollectors): Promise<void> {
  const inDocument = await page.evaluate(() => window.__cspViolations ?? []);
  expect(inDocument, "securitypolicyviolation events in the current document").toEqual([]);
  expect(collectors.cspViolations, "securitypolicyviolation events across all documents").toEqual([]);
  expect(collectors.cspConsole, "console messages about the Content Security Policy").toEqual([]);
  expect(collectors.foreignRequests, "requests to origins other than the application").toEqual([]);
  expect(collectors.pageErrors, "uncaught page errors").toEqual([]);
}

/** Response headers the deployment must send on every path (lower-case names, as Playwright reports them). */
export const REQUIRED_HEADERS = [
  "content-security-policy",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
  "x-frame-options",
] as const;

interface VercelConfig {
  headers?: { source: string; headers: { key: string; value: string }[] }[];
}

/** The production headers declared in vercel.json for `source: "/(.*)"`, keyed by lower-case header name. */
export function readProductionHeaders(): Record<string, string> {
  const file = fileURLToPath(new URL("../vercel.json", import.meta.url));
  const config = JSON.parse(readFileSync(file, "utf8")) as VercelConfig;
  const rule = config.headers?.find((r) => r.source === "/(.*)");
  if (!rule) throw new Error('vercel.json: no headers rule with source "/(.*)"');
  return Object.fromEntries(rule.headers.map((h) => [h.key.toLowerCase(), h.value]));
}

/** Asserts that a response carries exactly the production values of every required header. */
export function expectProductionHeaders(actual: Record<string, string>, expected: Record<string, string>, label: string): void {
  for (const name of REQUIRED_HEADERS) {
    expect(expected[name], `vercel.json declares ${name}`).toBeTruthy();
    expect(actual[name], `${label}: ${name}`).toBe(expected[name]);
  }
}

/** Reads a completed download as UTF-8 text. */
export async function downloadText(download: { path(): Promise<string | null> }): Promise<string> {
  const path = await download.path();
  if (!path) throw new Error("download has no file (was it cancelled?)");
  return readFileSync(path, "utf8");
}

/** Splits CSV text into lines, dropping a trailing empty line. */
export function csvLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line, i, all) => !(i === all.length - 1 && line === ""));
}
