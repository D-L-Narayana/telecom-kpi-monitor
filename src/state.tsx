/**
 * Application state: dataset source (synthetic or imported), the dataset clock ("now"), URL-synced
 * global filters, thresholds, the hash route and the alarm operator store.
 *
 * - `range` / `tech` are derived from the URL hash (`?range=&tech=`), falling back to the values last
 *   persisted in localStorage (`tkm.filters.v1`) and finally to the defaults 24h / All. The URL is the
 *   single source of truth, so every link is shareable.
 * - `now` is the end of the data source: `DATASET_END` for the synthetic dataset, the latest sample
 *   timestamp for an imported one. Alarm clearance is stamped in dataset time; audit entries carry
 *   the wall clock.
 * - Operator actions on the synthetic dataset persist in localStorage. Actions on an imported dataset
 *   live in memory only (imported alarm ids may collide with the synthetic ones) and are dropped when
 *   another dataset is loaded.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DATASET_END, DATASET_START, SEED, generateDataset, type Dataset } from "./lib/synthetic";
import { loadThresholds, saveThresholds, resetThresholds, type Thresholds, DEFAULT_THRESHOLDS } from "./lib/thresholds";
import { applyOverrides, emptyStore, loadStore, reduceStore, saveStore, type AlarmAction, type Store, type StoreClock } from "./lib/alarmStore";
import { parseHash, parseRange, parseTech, withParams, type Route } from "./lib/router";
import type { TimeRange } from "./lib/kpi";
import type { Alarm, Cell, Technology } from "./types/telecom";

export { parseHash, href, navigate, PAGES } from "./lib/router";
export type { Route, Page } from "./lib/router";
export type { AlarmAction, Store } from "./lib/alarmStore";

/** localStorage key for the last used global filters (`{ range, tech }`). */
export const FILTERS_KEY = "tkm.filters.v1";
/** Display time zone for dataset timestamps. */
export const DEFAULT_TIME_ZONE = "Asia/Kolkata";
const DEFAULT_RANGE: TimeRange = "24h";
const DEFAULT_TECH: Technology | "All" = "All";

export interface DataSource {
  kind: "synthetic" | "imported";
  label: string;
  rows: number;
  cellCount: number;
  siteCount: number;
  alarmCount: number;
  /** Earliest sample timestamp (ms since epoch). */
  start: number;
  /** End of the data; the app treats this instant as "now" (ms since epoch). */
  end: number;
  warnings: string[];
  timeZone: string;
  /** Whether operator actions (ack / clear / notes) on this dataset are kept in the browser's localStorage. */
  persisted: boolean;
}

export interface AppState {
  data: Dataset;
  cells: Map<string, Cell>;
  now: number;
  nowIso: string;
  range: TimeRange;
  setRange: (r: TimeRange) => void;
  tech: Technology | "All";
  setTech: (t: Technology | "All") => void;
  thresholds: Thresholds;
  updateThresholds: (t: Thresholds) => void;
  resetThresholdsToDefault: () => void;
  alarms: Alarm[];
  alarmAction: (id: string, action: "acknowledge" | "clear", note?: string) => void;
  audit: Store["audit"];
  route: Route;
  source: DataSource;
  /** Replace the dataset with imported data; `now` becomes the latest sample timestamp. */
  loadDataset: (ds: Dataset, label: string, warnings?: string[]) => void;
  resetToSynthetic: () => void;
  /** Merge params into the current page's hash; `undefined` or "" deletes a param; the page is kept. */
  setQuery: (patch: Record<string, string | undefined>) => void;
  alarmDispatch: (action: AlarmAction) => void;
  alarmStore: Store;
}

interface Filters { range: TimeRange; tech: Technology | "All" }
interface StoredFilters { range: TimeRange | null; tech: Technology | "All" | null }

const NO_STORED_FILTERS: StoredFilters = { range: null, tech: null };

function hasStorage(): boolean {
  try {
    return typeof window !== "undefined" && typeof localStorage !== "undefined";
  } catch {
    return false; // some browsers throw on any storage access when it is disabled by policy
  }
}

function currentHash(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
}

function writeHash(next: string): void {
  if (typeof window !== "undefined" && window.location.hash !== next) window.location.hash = next;
}

/** Stored filters are validated like URL params: anything unexpected is ignored. */
function readStoredFilters(): StoredFilters {
  if (!hasStorage()) return NO_STORED_FILTERS;
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (!raw) return NO_STORED_FILTERS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return NO_STORED_FILTERS;
    const o = parsed as Record<string, unknown>;
    return {
      range: parseRange(typeof o.range === "string" ? o.range : null),
      tech: parseTech(typeof o.tech === "string" ? o.tech : null),
    };
  } catch {
    return NO_STORED_FILTERS; // corrupt JSON or unavailable storage
  }
}

function writeStoredFilters(f: Filters): void {
  if (!hasStorage()) return;
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(f));
  } catch { /* storage unavailable or full: the URL still carries the filters */ }
}

function resolveFilters(hash: string, stored: StoredFilters): Filters {
  const p = parseHash(hash).params;
  return {
    range: parseRange(p.get("range")) ?? stored.range ?? DEFAULT_RANGE,
    tech: parseTech(p.get("tech")) ?? stored.tech ?? DEFAULT_TECH,
  };
}

/** Earliest and latest parseable ISO timestamp, or null when there is none. */
function timeExtent(times: Iterable<string | undefined>): { start: number; end: number } | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const iso of times) {
    if (!iso) continue;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) continue;
    if (t < start) start = t;
    if (t > end) end = t;
  }
  return Number.isFinite(end) ? { start, end } : null;
}

function describeSynthetic(data: Dataset): DataSource {
  return {
    kind: "synthetic", label: `Synthetic dataset (seed ${SEED})`, rows: data.samples.length, cellCount: data.cells.length,
    siteCount: data.sites.length, alarmCount: data.alarms.length, start: DATASET_START, end: DATASET_END, warnings: [],
    timeZone: DEFAULT_TIME_ZONE, persisted: true,
  };
}

function describeImported(data: Dataset, label: string, warnings: string[]): DataSource {
  const notes = [...warnings];
  let extent = timeExtent(data.samples.map((s) => s.timestamp));
  if (!extent) {
    // No usable sample timestamps: fall back to the alarm timeline, then to the time of import.
    extent = timeExtent(data.alarms.flatMap((a) => [a.timestamp, a.clearedAt]));
    notes.push(`No KPI samples with valid timestamps; the analysis window ends at ${extent ? "the latest alarm time" : "the import time"}.`);
    if (!extent) {
      const t = Date.now();
      extent = { start: t, end: t };
    }
  }
  return {
    kind: "imported", label, rows: data.samples.length, cellCount: data.cells.length, siteCount: data.sites.length,
    alarmCount: data.alarms.length, start: extent.start, end: extent.end, warnings: notes, timeZone: DEFAULT_TIME_ZONE, persisted: false,
  };
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  // Dataset source: the synthetic dataset is generated once; an imported dataset replaces it for the session.
  const synthetic = useMemo(() => generateDataset(), []);
  const syntheticSource = useMemo(() => describeSynthetic(synthetic), [synthetic]);
  const [imported, setImported] = useState<{ data: Dataset; source: DataSource } | null>(null);
  const data = imported?.data ?? synthetic;
  const source = imported?.source ?? syntheticSource;
  const cells = useMemo(() => new Map(data.cells.map((c) => [c.cellId, c])), [data]);
  const now = source.end;
  const nowIso = useMemo(() => new Date(now).toISOString(), [now]);

  // Route: the hash is the single source of truth; `hashchange` keeps the state in sync with external navigation.
  const [hash, setHash] = useState<string>(currentHash);
  const route = useMemo(() => parseHash(hash), [hash]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const applyHash = useCallback((next: string) => {
    writeHash(next);
    setHash(next); // synchronous, so consumers do not wait for the asynchronous hashchange event
  }, []);
  const setQuery = useCallback((patch: Record<string, string | undefined>) => applyHash(withParams(currentHash(), patch)), [applyHash]);

  // Global filters: URL params, then the last persisted values, then the defaults.
  const [stored, setStored] = useState<StoredFilters>(readStoredFilters);
  const { range, tech } = useMemo(() => resolveFilters(hash, stored), [hash, stored]);
  const persistFilters = useCallback((next: Filters) => {
    writeStoredFilters(next);
    setStored(next);
  }, []);
  const setRange = useCallback((r: TimeRange) => {
    const h = currentHash();
    persistFilters({ range: r, tech: resolveFilters(h, stored).tech });
    applyHash(withParams(h, { range: r }));
  }, [stored, persistFilters, applyHash]);
  const setTech = useCallback((t: Technology | "All") => {
    const h = currentHash();
    persistFilters({ range: resolveFilters(h, stored).range, tech: t });
    applyHash(withParams(h, { tech: t }));
  }, [stored, persistFilters, applyHash]);

  // Thresholds (persisted by the thresholds module).
  const [thresholds, setThresholds] = useState<Thresholds>(() => (hasStorage() ? loadThresholds() : DEFAULT_THRESHOLDS));
  const updateThresholds = useCallback((t: Thresholds) => { setThresholds(t); saveThresholds(t); }, []);
  const resetThresholdsToDefault = useCallback(() => setThresholds(resetThresholds()), []);

  // Alarm operator store: persisted for the synthetic dataset, in memory for imported data.
  const [persistedStore, setPersistedStore] = useState<Store>(() => loadStore());
  const [sessionStore, setSessionStore] = useState<Store>(() => emptyStore());
  const persisted = imported === null;
  const store = persisted ? persistedStore : sessionStore;
  const alarms = useMemo(() => applyOverrides(data.alarms, store), [data, store]);
  const alarmDispatch = useCallback((action: AlarmAction) => {
    const clock: StoreClock = { at: new Date().toISOString(), datasetNow: nowIso };
    const next = reduceStore(store, action, clock);
    if (next === store) return;
    if (persisted) {
      setPersistedStore(next);
      saveStore(next);
    } else {
      setSessionStore(next);
    }
  }, [store, persisted, nowIso]);
  const alarmAction = useCallback(
    (id: string, action: "acknowledge" | "clear", note?: string) => alarmDispatch({ type: action, alarmId: id, note }),
    [alarmDispatch],
  );

  const loadDataset = useCallback((ds: Dataset, label: string, warnings: string[] = []) => {
    setImported({ data: ds, source: describeImported(ds, label, warnings) });
    setSessionStore(emptyStore());
  }, []);
  const resetToSynthetic = useCallback(() => {
    setImported(null);
    setSessionStore(emptyStore());
  }, []);

  const value = useMemo<AppState>(() => ({
    data, cells, now, nowIso, range, setRange, tech, setTech, thresholds, updateThresholds, resetThresholdsToDefault,
    alarms, alarmAction, audit: store.audit, route, source, loadDataset, resetToSynthetic, setQuery, alarmDispatch, alarmStore: store,
  }), [data, cells, now, nowIso, range, setRange, tech, setTech, thresholds, updateThresholds, resetThresholdsToDefault, alarms, alarmAction, store, route, source, loadDataset, resetToSynthetic, setQuery, alarmDispatch]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside provider");
  return v;
}
