import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DATASET_END, generateDataset, type Dataset } from "./lib/synthetic";
import { loadThresholds, saveThresholds, resetThresholds, type Thresholds, DEFAULT_THRESHOLDS } from "./lib/thresholds";
import { act, applyOverrides, loadStore, saveStore } from "./lib/alarmStore";
import type { Alarm, Cell, Technology } from "./types/telecom";
import type { TimeRange } from "./lib/kpi";

export interface Route { page: "overview" | "kpis" | "alarms" | "packets"; params: URLSearchParams }

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, "");
  const [path, query = ""] = h.split("?");
  const page = (["overview", "kpis", "alarms", "packets"].includes(path) ? path : "overview") as Route["page"];
  return { page, params: new URLSearchParams(query) };
}
export function href(page: Route["page"], params?: Record<string, string>): string {
  const q = params ? new URLSearchParams(params).toString() : "";
  return `#/${page}${q ? `?${q}` : ""}`;
}
export function navigate(page: Route["page"], params?: Record<string, string>): void {
  window.location.hash = href(page, params);
}

interface AppState {
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
  audit: ReturnType<typeof loadStore>["audit"];
  route: Route;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const data = useMemo(() => generateDataset(), []);
  const cells = useMemo(() => new Map(data.cells.map((c) => [c.cellId, c])), [data]);
  const [range, setRange] = useState<TimeRange>("24h");
  const [tech, setTech] = useState<Technology | "All">("All");
  const [thresholds, setThresholds] = useState<Thresholds>(() => (typeof localStorage === "undefined" ? DEFAULT_THRESHOLDS : loadThresholds()));
  const [store, setStore] = useState(() => (typeof localStorage === "undefined" ? { overrides: {}, audit: [] } : loadStore()));
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const nowIso = new Date(DATASET_END).toISOString();
  const alarms = useMemo(() => applyOverrides(data.alarms, store), [data, store]);
  const value: AppState = {
    data, cells, now: DATASET_END, nowIso, range, setRange, tech, setTech, thresholds,
    updateThresholds: (t) => { setThresholds(t); saveThresholds(t); },
    resetThresholdsToDefault: () => setThresholds(resetThresholds()),
    alarms,
    alarmAction: (id, action, note) => { const s = act(store, id, action, new Date().toISOString(), note); setStore(s); saveStore(s); },
    audit: store.audit,
    route,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside provider");
  return v;
}
