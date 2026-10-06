import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { THEME_KEY, applyTheme, readThemePref, useTheme } from "../src/theme/useTheme";
import { ThemeToggle } from "../src/theme/ThemeToggle";
import * as themeIndex from "../src/theme";

type Listener = (e: MediaQueryListEvent) => void;

/** Controllable stand-in for window.matchMedia("(prefers-color-scheme: dark)"). */
function mockMatchMedia(matches: boolean) {
  const listeners = new Set<Listener>();
  const mql = {
    matches,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: (_type: string, fn: Listener) => { listeners.add(fn); },
    removeEventListener: (_type: string, fn: Listener) => { listeners.delete(fn); },
    addListener: (fn: Listener) => { listeners.add(fn); },
    removeListener: (fn: Listener) => { listeners.delete(fn); },
    dispatchEvent: () => true,
  };
  const spy = vi.fn((_query: string) => mql as unknown as MediaQueryList);
  window.matchMedia = spy as unknown as typeof window.matchMedia;
  return {
    spy,
    listeners,
    change(next: boolean) {
      mql.matches = next;
      for (const fn of [...listeners]) fn({ matches: next, media: mql.media } as MediaQueryListEvent);
    },
  };
}

const originalMatchMedia = window.matchMedia;
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe("applyTheme", () => {
  it('sets <html data-theme="dark"> and returns "dark"', () => {
    expect(applyTheme("dark")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it('sets <html data-theme="light"> and returns "light"', () => {
    applyTheme("dark");
    expect(applyTheme("light")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it('"system" follows a matching prefers-color-scheme: dark query', () => {
    const mm = mockMatchMedia(true);
    expect(applyTheme("system")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(mm.spy).toHaveBeenCalledWith("(prefers-color-scheme: dark)");
  });

  it('"system" resolves to light when the query does not match', () => {
    mockMatchMedia(false);
    expect(applyTheme("system")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("does not persist anything by itself", () => {
    applyTheme("dark");
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
  });
});

describe("readThemePref", () => {
  it('returns the stored preference, "system" when nothing is stored', () => {
    expect(readThemePref()).toBe("system");
    localStorage.setItem(THEME_KEY, "dark");
    expect(readThemePref()).toBe("dark");
    localStorage.setItem(THEME_KEY, "light");
    expect(readThemePref()).toBe("light");
  });

  it('returns "system" for garbage values', () => {
    localStorage.setItem(THEME_KEY, "sepia");
    expect(readThemePref()).toBe("system");
    localStorage.setItem(THEME_KEY, '{"theme":"dark"}');
    expect(readThemePref()).toBe("system");
    localStorage.setItem(THEME_KEY, "");
    expect(readThemePref()).toBe("system");
  });

  it("accepts the JSON-quoted form too", () => {
    localStorage.setItem(THEME_KEY, '"dark"');
    expect(readThemePref()).toBe("dark");
  });
});

describe("useTheme", () => {
  it("uses the storage key tkm.theme.v1", () => {
    expect(THEME_KEY).toBe("tkm.theme.v1");
  });

  it('defaults to "system" and applies the resolved theme on mount', () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("system");
    expect(result.current.resolved).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("persists the preference to tkm.theme.v1 and updates <html data-theme>", () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme("dark"));
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(result.current.theme).toBe("dark");
    expect(result.current.resolved).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    act(() => result.current.setTheme("light"));
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
    expect(result.current.resolved).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("restores a stored preference on mount", () => {
    mockMatchMedia(false);
    localStorage.setItem(THEME_KEY, "dark");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
    expect(result.current.resolved).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it('falls back to "system" for an unknown stored value', () => {
    mockMatchMedia(false);
    localStorage.setItem(THEME_KEY, "sepia");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("system");
    expect(result.current.resolved).toBe("light");
  });

  it('follows OS changes while "system" and stops after an explicit choice', () => {
    const mm = mockMatchMedia(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current.resolved).toBe("light");
    act(() => mm.change(true));
    expect(result.current.resolved).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    act(() => result.current.setTheme("light"));
    act(() => mm.change(false));
    act(() => mm.change(true));
    expect(result.current.theme).toBe("light");
    expect(result.current.resolved).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("removes the media-query listener on unmount", () => {
    const mm = mockMatchMedia(false);
    const { unmount } = renderHook(() => useTheme());
    expect(mm.listeners.size).toBe(1);
    unmount();
    expect(mm.listeners.size).toBe(0);
  });

  it("keeps several hook instances in sync", () => {
    mockMatchMedia(false);
    const a = renderHook(() => useTheme());
    const b = renderHook(() => useTheme());
    act(() => a.result.current.setTheme("dark"));
    expect(b.result.current.theme).toBe("dark");
    expect(b.result.current.resolved).toBe("dark");
  });
});

describe("ThemeToggle", () => {
  it('renders a "Theme" group with Light / Dark / System buttons and exactly one aria-pressed="true"', () => {
    mockMatchMedia(false);
    render(<ThemeToggle />);
    const group = screen.getByRole("group", { name: "Theme" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Light", "Dark", "System"]);
    for (const b of buttons) expect(["true", "false"]).toContain(b.getAttribute("aria-pressed"));
    expect(buttons.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent)).toEqual(["System"]);
  });

  it('clicking "Dark" updates <html data-theme>, aria-pressed and localStorage', async () => {
    mockMatchMedia(false);
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByRole("button", { name: "Dark" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "false");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
  });

  it("reflects a stored preference", () => {
    mockMatchMedia(false);
    localStorage.setItem(THEME_KEY, "light");
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("is re-exported from src/theme", () => {
    expect(themeIndex.ThemeToggle).toBe(ThemeToggle);
    expect(themeIndex.applyTheme).toBe(applyTheme);
    expect(themeIndex.useTheme).toBe(useTheme);
    expect(themeIndex.THEME_KEY).toBe(THEME_KEY);
    expect(themeIndex.readThemePref).toBe(readThemePref);
  });
});
