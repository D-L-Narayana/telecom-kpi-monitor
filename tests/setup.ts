/** Vitest setup: jsdom polyfills shared by all unit and component tests. */
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver = ResizeObserverStub;
}

if (typeof window !== "undefined") {
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
  }
  if (typeof window.HTMLElement !== "undefined" && typeof window.HTMLElement.prototype.scrollIntoView !== "function") {
    window.HTMLElement.prototype.scrollIntoView = () => {};
  }
}

if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => "blob:vitest-mock";
}
if (typeof URL.revokeObjectURL !== "function") {
  URL.revokeObjectURL = () => {};
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  if (typeof window !== "undefined") window.location.hash = "";
  document.documentElement.removeAttribute("data-theme");
});
