/**
 * Hash router: page union, hash <-> route conversion and URL parameter validators.
 *
 * URL scheme: `#/<page>?range=1h|6h|24h|7d&tech=All|LTE|NR&...page params`.
 * Everything read from the URL is untrusted: pages fall back to "overview" and the
 * `parse*` validators return `null` (or a fallback) instead of passing bad values on.
 */
import type { KpiKey, Technology } from "../types/telecom";
import { KPI_META, RANGE_MS, type TimeRange } from "./kpi";

export type Page = "overview" | "kpis" | "alarms" | "packets" | "sites" | "report";
/** Pages in navigation order. */
export const PAGES: readonly Page[] = ["overview", "kpis", "alarms", "packets", "sites", "report"];

export interface Route { page: Page; params: URLSearchParams }

const PAGE_SET: ReadonlySet<string> = new Set(PAGES);
const TECH_SET: ReadonlySet<string> = new Set(["All", "LTE", "NR"]);

function isPage(v: string): v is Page {
  return PAGE_SET.has(v);
}

/** Parse a location hash. Tolerates "", "#", "#/", "#kpis", "#/kpis/", "#/KPIs?x=1"; unknown pages map to "overview". */
export function parseHash(hash: string): Route {
  const h = hash.replace(/^#?\/?/, "");
  const qIndex = h.indexOf("?");
  const rawPath = qIndex === -1 ? h : h.slice(0, qIndex);
  const query = qIndex === -1 ? "" : h.slice(qIndex + 1);
  const path = rawPath.replace(/\/+$/, "").toLowerCase();
  return { page: isPage(path) ? path : "overview", params: new URLSearchParams(query) };
}

/** Build a hash link. `undefined` and empty-string values are skipped; insertion order is kept. */
export function href(page: Page, params?: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === "") continue;
      q.append(k, v);
    }
  }
  const s = q.toString();
  return `#/${page}${s ? `?${s}` : ""}`;
}

export function navigate(page: Page, params?: Record<string, string | undefined>): void {
  if (typeof window === "undefined") return;
  window.location.hash = href(page, params);
}

/**
 * Merge `patch` into the params of an existing hash (existing keys keep their position; `undefined`/"" deletes).
 * The page is kept unless `page` is given. Used for URL-synced filters that must not disturb other params.
 */
export function withParams(hash: string, patch: Record<string, string | undefined>, page?: Page): string {
  const r = parseHash(hash);
  const merged: Record<string, string | undefined> = {};
  for (const [k, v] of r.params) merged[k] = v;
  for (const [k, v] of Object.entries(patch)) merged[k] = v;
  return href(page ?? r.page, merged);
}

/** A KPI key is valid only if it is one of the KPI_META keys (own properties only). */
export function parseKpiKey(v: string | null | undefined): KpiKey | null {
  if (!v || !Object.prototype.hasOwnProperty.call(KPI_META, v)) return null;
  return v as KpiKey;
}

export function parseRange(v: string | null | undefined): TimeRange | null {
  if (!v || !Object.prototype.hasOwnProperty.call(RANGE_MS, v)) return null;
  return v as TimeRange;
}

export function parseTech(v: string | null | undefined): Technology | "All" | null {
  if (!v || !TECH_SET.has(v)) return null;
  return v as Technology | "All";
}

/** Decimal integer >= 1 (surrounding whitespace tolerated); anything else yields `fallback`. */
export function parsePositiveInt(v: string | null | undefined, fallback: number): number {
  if (v === null || v === undefined) return fallback;
  const s = v.trim();
  if (!/^\d+$/.test(s)) return fallback;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 1 ? n : fallback;
}
