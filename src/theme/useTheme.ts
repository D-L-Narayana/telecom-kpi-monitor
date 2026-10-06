import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

/** User preference: an explicit theme or "system" (follow the operating system). */
export type ThemePref = "light" | "dark" | "system";
/** The theme actually applied to <html data-theme>. */
export type ResolvedTheme = "light" | "dark";

export const THEME_KEY = "tkm.theme.v1";
const DARK_QUERY = "(prefers-color-scheme: dark)";
const PREFS: readonly string[] = ["light", "dark", "system"];

function isPref(v: unknown): v is ThemePref {
  return typeof v === "string" && PREFS.includes(v);
}

/** Reads the stored preference; anything missing, malformed or unknown yields "system". */
export function readThemePref(): ThemePref {
  try {
    // Even reading `localStorage` can throw (storage disabled, sandboxed frame), hence the try around the check.
    if (typeof localStorage === "undefined") return "system";
    const raw = localStorage.getItem(THEME_KEY);
    if (raw === null) return "system";
    if (isPref(raw)) return raw;
    const parsed: unknown = JSON.parse(raw); // tolerate the JSON-quoted form ("\"dark\"")
    return isPref(parsed) ? parsed : "system";
  } catch {
    return "system";
  }
}

function writeThemePref(pref: ThemePref): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* storage disabled or full: the choice still applies to this page */
  }
}

function darkQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(DARK_QUERY);
}

/** Resolves a preference to a concrete theme ("system" asks the OS; no matchMedia means light). */
export function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref !== "system") return pref;
  return darkQuery()?.matches ? "dark" : "light";
}

function setDocumentTheme(resolved: ResolvedTheme): void {
  if (typeof document !== "undefined") document.documentElement.dataset.theme = resolved;
}

/** Applies a preference to the document (sets <html data-theme>) and returns the resolved theme. Does not persist. */
export function applyTheme(pref: ThemePref): ResolvedTheme {
  const resolved = resolveTheme(pref);
  setDocumentTheme(resolved);
  return resolved;
}

function subscribeDarkQuery(onChange: () => void): () => void {
  const mql = darkQuery();
  if (!mql) return () => {};
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }
  mql.addListener(onChange); // Safari < 14
  return () => mql.removeListener(onChange);
}
const prefersDarkNow = (): boolean => darkQuery()?.matches ?? false;
const prefersDarkServer = (): boolean => false;

/** Every mounted hook instance; a change made through one is pushed to all of them. */
const instances = new Set<(pref: ThemePref) => void>();

/**
 * Theme preference state: persisted in localStorage (tkm.theme.v1), mirrored to <html data-theme>,
 * and following the OS colour scheme while the preference is "system".
 */
export function useTheme(): { theme: ThemePref; resolved: ResolvedTheme; setTheme(t: ThemePref): void } {
  const [theme, setThemeState] = useState<ThemePref>(readThemePref);
  const prefersDark = useSyncExternalStore(subscribeDarkQuery, prefersDarkNow, prefersDarkServer);
  const resolved: ResolvedTheme = theme === "system" ? (prefersDark ? "dark" : "light") : theme;

  useEffect(() => {
    setDocumentTheme(resolved);
  }, [resolved]);

  useEffect(() => {
    instances.add(setThemeState);
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === THEME_KEY) setThemeState(readThemePref());
    };
    window.addEventListener("storage", onStorage);
    return () => {
      instances.delete(setThemeState);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const setTheme = useCallback((pref: ThemePref) => {
    writeThemePref(pref);
    applyTheme(pref);
    for (const notify of instances) notify(pref);
  }, []);

  return { theme, resolved, setTheme };
}
