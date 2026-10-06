import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import vercel from "./vercel.json";

/**
 * Production response headers (CSP etc.) are declared once in vercel.json. `vite preview` serves the same
 * headers so the production bundle can be verified locally and in CI exactly as deployed.
 */
const productionHeaders: Record<string, string> = Object.fromEntries(
  (vercel.headers ?? [])
    .filter((rule) => rule.source === "/(.*)")
    .flatMap((rule) => rule.headers.map((h) => [h.key, h.value] as const)),
);

/** Split long-lived vendor code from application code so app changes do not invalidate the vendor cache. */
function manualChunks(id: string): string | undefined {
  if (!id.includes("node_modules/")) return undefined;
  if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "vendor-react";
  return "vendor-charts";
}

export default defineConfig({
  plugins: [react()],
  preview: { headers: productionHeaders },
  build: {
    rollupOptions: { output: { manualChunks } },
  },
});
