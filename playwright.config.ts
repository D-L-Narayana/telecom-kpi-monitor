import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end configuration.
 *
 * The suite runs against the production bundle served by `vite preview`, which sends the same response headers as
 * the Vercel deployment (see vercel.json and vite.config.ts), so the Content Security Policy is enforced exactly as
 * in production. Chromium only, one worker: the specs share one preview server and several of them persist state in
 * localStorage, and the host that runs the suite is small.
 *
 *   npm run build && npm run test:e2e          full suite (starts the preview server itself)
 *   npm run test:e2e -- e2e/headers.spec.ts    one spec
 *   E2E_PORT=4174 npm run test:e2e             when port 4173 is taken on this machine (preview and baseURL follow)
 */
const HOST = "127.0.0.1";
const PORT = portFrom(process.env.E2E_PORT, 4173);
const baseURL = `http://${HOST}:${PORT}`;
const isCI = Boolean(process.env.CI);

function portFrom(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`E2E_PORT must be a TCP port number, got "${raw}"`);
  return n;
}

export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  retries: isCI ? 1 : 0,
  forbidOnly: isCI,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run preview -- --host ${HOST} --port ${PORT} --strictPort`,
    url: baseURL,
    reuseExistingServer: !isCI,
    timeout: 60_000,
  },
});
