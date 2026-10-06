# Contributing

Telecom KPI Monitor is a static Vite + React + TypeScript application: no backend, no authentication, no live data
sources, and the whole dashboard runs on a seeded synthetic dataset (or on CSV/JSON files you load in the browser).
This guide covers the local setup, the npm scripts, the testing expectations and the one rule that is easy to break
by accident: the synthetic dataset must never change.

## Setup

- Node.js 20 or newer (see `engines` in `package.json`) and npm.
- `npm ci` installs the exact versions from `package-lock.json`.
- `npm run dev` starts the dev server at http://localhost:5173.
- Playwright needs a Chromium build once: `npx playwright install chromium` (CI runs the same command with
  `--with-deps`).

The app has **no runtime dependencies besides React, ReactDOM and Recharts**, and pull requests must keep it that
way. New *dev* dependencies need a reason in the pull request.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with hot reload |
| `npm run build` | `tsc --noEmit` on `src/` then `vite build` → `dist/` |
| `npm run preview` | Serves `dist/` with the production response headers from `vercel.json` (CSP etc.) |
| `npm run typecheck` | Type-checks `src/` (`tsconfig.json`: strict, no unused locals/parameters) |
| `npm run typecheck:tests` | Type-checks `src/`, `tests/`, `e2e/`, `scripts/` and the config files (`tsconfig.tests.json`) |
| `npm run lint` | ESLint flat config (`eslint.config.js`): JS + typescript-eslint recommended, React hooks, jsx-a11y |
| `npm test` | Vitest unit and component tests (`tests/**/*.test.{ts,tsx}`, jsdom) |
| `npm run test:coverage` | Same tests with V8 coverage; `src/lib` and `src/theme` must keep ≥ 80 % line coverage |
| `npm run test:e2e` | Playwright end-to-end suite against the production build (see below) |
| `npm run check:data` | Regenerates the synthetic dataset into a temporary directory and diffs it byte-for-byte with `data/` |
| `npm run check:noskip` | Fails if any test in `tests/` or `e2e/` is skipped, focused or a todo |
| `npm run gen:data` | Writes the dataset to `data/` (`-- --out <dir>` for another directory) |

Run a single test file with `npm test -- tests/kpi.test.ts`; lint a subset with `npm run lint -- src/lib`.

## Code conventions

- TypeScript strict mode everywhere, including tests. Unused parameters are allowed only with a leading underscore.
- Routing is hash-based (`#/<page>?range=…&tech=…`); build links with the `href()` helper and read parameters from
  the route, never from `window.location` directly.
- Colours come from the CSS custom properties defined in `src/styles.css` (light and dark palettes). Do not add hex
  colour literals to components or charts — pass `"var(--chart-series-1)"`-style strings instead.
- The production Content Security Policy is strict (`script-src 'self'`, `connect-src 'self'`, no `eval`, no inline
  scripts, no remote fonts or images). Anything that needs a network request, `new Function` or an injected
  `<script>` will be blocked in production, and the e2e suite fails on CSP violations.
- `vercel.json` is the single source of truth for response headers; `vite preview` serves the same headers so
  the production bundle can be checked locally exactly as deployed.

## Tests come first

Every behaviour change starts with a failing test:

1. Write the test in `tests/` (Vitest, jsdom, Testing Library) or `e2e/` (Playwright) and make sure it fails on an
   **assertion** — a missing export or a compile error is not a meaningful red.
2. Implement the smallest change that makes it pass, then run the related files (`npm test -- tests/<file>`).
3. Keep existing tests green. Adapt a test only when the behaviour it describes is intentionally changing, and say
   so in the pull request.

Rules enforced by the checks:

- No `.skip`, `.only`, `.todo`, `.fixme`, `.skipIf`/`.runIf`, `xit`, `xdescribe` or `xtest` in committed tests
  (`npm run check:noskip`). If something cannot run in an environment, make the test fail with a clear message
  instead of skipping it, so the gap is visible.
- Coverage of `src/lib/**` and `src/theme/**` stays at or above 80 % lines (`npm run test:coverage`).
- Component tests render through the real `AppProvider` wherever possible; `tests/setup.ts` already registers the
  jest-dom matchers, polyfills `ResizeObserver`/`matchMedia`/`URL.createObjectURL`, and clears storage, the URL
  hash and the theme attribute after each test.

## The synthetic dataset is frozen

`src/lib/synthetic.ts` (with `src/lib/rng.ts`) generates the demo dataset deterministically from the seed
`20260923`: 12 sites, 48 cells, 32,256 KPI rows, 300 alarms and the packet statistics. The committed files in
`data/`, the figures and incident timeline in the README, the screenshots, the unit tests and the e2e workflows
all depend on **exactly these bytes**.

- `generateDataset()` output is a contract: `npm run check:data` regenerates the dataset and compares every file
  in `data/` byte-for-byte, and `tests/synthetic.test.ts` locks the shape, the incident windows, the alarm state
  split and the SHA-256 of the KPI CSV.
- The PRNG is consumed in a fixed order. Adding, removing or reordering a single `rand()` call inside the
  generator — even in an unrelated branch — shifts every value that follows. The same applies to the CSV
  serialisation in `src/lib/csv.ts`: its default output for the generator's callers must stay identical.
- Changes to these modules must be **additive**: new exported constants or helpers (for example
  `INCIDENT_WINDOWS`, which describes the four injected incidents as ISO windows) are fine; changing numbers,
  formulas, draw order or formatting is not.
- Need different data? Load your own CSV/JSON through the Data drawer (the schema is described in
  `docs/DATA_SCHEMA.md`), or pass a different seed to `generateDataset(seed)` in a test. Do not regenerate
  `data/` to "fix" a failing determinism check — the check is telling you that the generator changed.

## Running the end-to-end suite locally

The Playwright suite exercises the production bundle, so build first:

```bash
npm run build
npm run test:e2e
```

`playwright.config.ts` starts `npm run preview -- --host 127.0.0.1 --port 4173 --strictPort` itself (reusing an
already running preview outside CI), runs Chromium only with a single worker, and keeps traces and screenshots for
failed tests under `test-results/`. The HTML report lands in `playwright-report/` (`npx playwright show-report`).
If something else already listens on 4173, run `E2E_PORT=4174 npm run test:e2e` — the preview server and the
`baseURL` follow the variable. The headers spec also checks that the server under test serves this repository's
`dist/index.html`, so a stale or foreign server on the port fails fast instead of producing misleading results.

What the specs cover:

- `e2e/headers.spec.ts` — the document and the compiled `/assets/*.js` / `*.css` responses carry exactly the
  Content-Security-Policy, X-Content-Type-Options, Referrer-Policy, Permissions-Policy and X-Frame-Options values
  from `vercel.json`, with the right content types.
- `e2e/workflows.spec.ts` — the analyst workflows (shift start, KPI deep links and exports, alarm handling with
  audit trail, thresholds, bring-your-own data, packet captures, sites, shift report, theme and a 375 px layout).
  Each test records `securitypolicyviolation` events, console CSP refusals and requests to foreign origins, and
  asserts that all three stay empty.
- `e2e/a11y-axe.spec.ts` — axe-core scans of every page; zero `serious`/`critical` violations. This spec is
  labelled separately because axe injects its own script for the scan; it does not change the application CSP,
  and a refused injection fails the test rather than skipping it.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request with Node 20 and no secrets:

1. `npm ci`
2. `npm run lint`, `npm run typecheck`, `npm run typecheck:tests`
3. `npm run test:coverage`
4. `npm run check:data`, `npm run check:noskip`
5. `npm run build`
6. `npx playwright install --with-deps chromium`, then `npm run test:e2e`
7. On failure the Playwright report is uploaded as a workflow artifact.

A pull request is ready when all of these pass locally in the same order.

## Pull request checklist

- [ ] Failing test written first, now green; no skipped or focused tests.
- [ ] `npm run lint`, `npm run typecheck`, `npm run typecheck:tests`, `npm test` pass.
- [ ] `npm run check:data` passes — the synthetic dataset did not change.
- [ ] No new runtime dependency; no hex colours in components; no inline scripts, `eval` or remote resources.
- [ ] README / docs updated when user-visible behaviour, URL parameters or storage keys change.
