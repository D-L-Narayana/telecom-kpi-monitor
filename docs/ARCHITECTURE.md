# Architecture

Telecom KPI Monitor is a single-page application that behaves like a NOC analyst workstation while staying a
plain static site: no backend, no authentication, no live OSS/NMS connection, no telemetry. Everything — the
dataset, the analytics, the alarm operations, the exports — runs in the browser.

Three principles shape the code:

1. **The dataset is a value, not a service.** A deterministic generator produces the demo dataset on every load;
   an imported dataset (CSV/JSON in the same schema) replaces it for the session. Pages never fetch anything.
2. **The URL is the analysis state.** Every filter lives in the hash (`#/<page>?range=…&tech=…&…`) so a view can
   be shared; `localStorage` only remembers preferences and operator actions.
3. **Pure libraries, thin pages.** `src/lib/*` is framework-free, deterministic and unit-tested; pages compose
   those functions with React state from one provider.

## Module map

```
src/
  main.tsx               bootstrap: applies the stored theme before the first paint, mounts <App/>
  App.tsx                shell: primary nav (Overview, KPIs, Alarms, Packets, Sites, Report), range/technology
                         segmented controls, theme toggle, Data and Thresholds drawers, skip link, footer
  state.tsx              AppProvider / useApp(): dataset source, dataset clock, URL-synced filters, thresholds,
                         alarm store dispatch, current route
  lib/router.ts          Page union, parseHash / href / navigate / withParams, URL parameter validators
  lib/synthetic.ts       seeded dataset generator (sites, cells, 15-min KPI samples, incidents, alarms, packet
                         statistics); INCIDENT_WINDOWS describes the four injected incidents
  lib/rng.ts             mulberry32 PRNG + gaussian helper (the generator's only source of randomness)
  lib/kpi.ts             KPI metadata and formulas, window selection, user-weighted aggregation, bucketed series,
                         availability, percentiles, rule-based detection (outage, congestion, latency, drops, sleeping)
  lib/sites.ts           per-site and per-region roll-ups, equirectangular projection for the SVG map
  lib/thresholds.ts      direction-aware thresholds, validation, presets, JSON import/export, persistence
  lib/alarmStore.ts      versioned operator store: reducer for acknowledge / clear / reopen / bulk / notes,
                         v1 → v2 migration, audit trail and its CSV
  lib/correlation.ts     alarm ↔ KPI correlation (baseline / during / after windows, breach fraction, verdict)
  lib/pcap.ts            capture-export parsers: tshark JSON, `-z io,phs`, `-T fields`, Wireshark CSV → hierarchy,
                         conversations, retransmissions, size guard
  lib/csv.ts             RFC 4180 parser and serialiser (formula-injection guard), Blob download helper
  lib/importers.ts       bring-your-own-data: KPI CSV, cells, sites, alarms → validated Dataset + issues
  lib/report.ts          shift handover report model → Markdown / CSV sections / file names
  theme/                 useTheme (light / dark / system, persisted), ThemeToggle, applyTheme for boot
  components/ui.tsx      Card, Empty, badges, Notice, Drawer (dialog semantics), VisuallyHidden, fmtTime
  components/            KpiCard, KpiChart (Recharts), ThresholdDrawer, DataSourceDrawer, SiteMap (pure SVG)
  pages/                 Overview, Kpis, Alarms, Packets, Sites, Report
  styles.css             design tokens (light and dark palettes), layout, components, focus, motion, print
  types/telecom.ts       Site, Cell, KpiSample, Alarm, PacketStat, Conversation
scripts/                 generate-synthetic-data.mjs (gen:data), check-data-determinism.mjs, check-no-skips.mjs
tests/                   Vitest unit and component tests (jsdom) + fixtures (import/, pcap/)
e2e/                     Playwright specs against the production bundle (headers, workflows, axe)
data/                    committed output of gen:data (must stay byte-identical to the generator)
docs/                    DATA_SCHEMA.md, CONTRIBUTING.md, this file, screenshots
```

The runtime dependencies are React, ReactDOM and Recharts only. The production bundle is split into an
application chunk and two vendor chunks (`vendor-react`, `vendor-charts`) so that the vendor code caches
independently of application changes.

## Data flow

```
                ┌─ synthetic: generateDataset()  (seed 20260923, generated once per page load)
dataset source ─┤
                └─ imported: importDataset(files) → Dataset + warnings  (Data drawer, in memory only)
        │
        ▼
AppProvider  data · cells (Map) · now = source.end · range/tech (URL) · thresholds · alarm store
        │
        ├─ inWindow(samples, now, RANGE_MS[range]) → filterTech(…)        the analysis window
        ├─ networkKpi / aggregateByCell / aggregateBySite / aggregateByRegion
        ├─ detectIssues(window, cells, thresholds)                          Overview, Report, correlation
        ├─ applyOverrides(data.alarms, store)                               alarms as the operator sees them
        └─ correlateAlarm(alarm, samplesByCell, cells, thresholds, nowIso)  Alarms Explain panel, CSV column
        ▼
pages render from useApp(); links are built with href(page, params) and keep range/tech
```

Key decisions:

- **Dataset clock.** "Now" is the end of the data source — `DATASET_END` (23 Sep 2026 14:30 IST) for the
  synthetic dataset, the latest sample timestamp for an imported one. Window selection, alarm durations and
  clearance timestamps use this clock; only audit entries carry the wall clock. This keeps the demo stable and
  makes figures reproducible.
- **Windows** are `(now − range, now]` on ISO strings (the sample format is uniform, so string comparison is
  exact). The previous window of the same length provides the deltas on the Overview cards.
- **Thresholds are direction-aware**: drop rate, latency and PRB breach *above*; success rates and throughput
  breach *below* (DL throughput has separate LTE / NR values). `classify()` yields `ok | warning | critical`.
- **Detections** are rule-based per cell over the window: outage (≥ 2 consecutive intervals without counters),
  congestion (≥ 3 intervals PRB above critical), latency (≥ 2 above critical), drops (≥ 3 CDR above critical),
  sleeping (≥ 4 consecutive intervals with counters but almost no active users). The sort is a strict total order
  so lists are stable.
- **Alarm operations** never mutate the dataset. A reducer applies acknowledge / clear / reopen / bulk / note /
  reset actions to an override map plus a capped audit list; `applyOverrides` merges them into the dataset's
  alarms at render time. For the synthetic dataset the store is persisted; for an imported dataset (whose ids
  may collide with the synthetic ones) it lives in memory for the session.
- **Correlation** compares the KPI implied by the alarm's probable cause across baseline (2 h before), during and
  after (2 h after clearance) windows, combines peak worsening with the breach fraction into a score and maps it
  to a verdict (`strong`, `weak`, `none`, `insufficient`). Outages are recognised through down intervals.
- **Exports** (CSV, Markdown) are built in memory and offered as Blob downloads; no network is involved and CSV
  cells that could be interpreted as spreadsheet formulas are guarded.
- **Determinism** is a contract: `scripts/check-data-determinism.mjs` regenerates the dataset and diffs it
  byte-for-byte against `data/`, and `tests/synthetic.test.ts` locks the generator (see CONTRIBUTING.md).

## URL scheme

Hash routing (`#/<page>?…`) needs no server rewrites, so deep links work on any static host; a rewrite of deep
paths to `index.html` is kept for robustness. Unknown pages fall back to `overview`; every parameter is validated
and invalid values are ignored (the KPIs page shows a notice instead of crashing).

| Page | Path | Page parameters |
| --- | --- | --- |
| Overview | `#/overview` | — |
| KPIs | `#/kpis` | `cell`, `kpi`, `compare` (`<cellId>`, `site:<SITE>` or `network`), `bucket` (`1h`) |
| Alarms | `#/alarms` | `severity`, `state`, `site`, `q`, `alarm`, `sort`, `dir`, `page` |
| Packets | `#/packets` | — (loaded captures are session state) |
| Sites | `#/sites` | `region`, `site`, `sort`, `dir` |
| Report | `#/report` | — (handover notes are stored locally) |

Global parameters on every page: `range` (`1h` · `6h` · `24h` · `7d`) and `tech` (`All` · `LTE` · `NR`). They
are read from the URL first, then from the last persisted values, then default to `24h` / `All`; nav links and
page links carry them along.

## Browser storage

| Key | Content |
| --- | --- |
| `tkm.filters.v1` | last used `range` / `tech` (fallback when a link has none) |
| `tkm.thresholds.v1` | the threshold set, validated on load (corrupt or partial data falls back to defaults) |
| `tkm.alarms.v2` | alarm overrides + audit trail for the synthetic dataset (`tkm.alarms.v1` is migrated on first load) |
| `tkm.theme.v1` | theme preference: `light`, `dark` or `system` |
| `tkm.report.notes.v1` | handover notes typed on the Report page |

Imported datasets and loaded captures are never written to storage: a reload returns to the synthetic dataset.

## Security headers and CSP

The deployment sends the same five headers on every response; they are declared **once** in `vercel.json`, and
`vite.config.ts` reads that file so `vite preview` serves identical headers for local and CI verification.

| Header | Value | Why |
| --- | --- | --- |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'` | see below |
| `X-Content-Type-Options` | `nosniff` | assets are served with exact MIME types; no sniffing |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | the only outbound link is the repository; the hash (analysis state) never leaves the origin anyway |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | the app uses none of these |
| `X-Frame-Options` | `DENY` | belt and braces with `frame-ancestors 'none'` for older agents |

CSP rationale: scripts come only from the site's own origin (`script-src 'self'`, no `unsafe-inline`, no
`unsafe-eval`), which is why the application contains no inline scripts, no `eval`/`new Function` and no remote
analytics; `connect-src 'self'` documents that nothing is fetched at runtime (the e2e suite fails on any request
to another origin). `style-src` allows inline styles because React and Recharts set element `style` attributes;
`img-src` additionally permits `data:` URLs, i.e. images embedded in the document itself without a network request;
fonts are system fonts only. CSV and Markdown downloads use Blob URLs created in the page and triggered through an
anchor's `download` attribute, which needs no network access and no navigation.

## Testing strategy

| Layer | Tooling | What it proves |
| --- | --- | --- |
| Unit | Vitest, `tests/*.test.ts` | formulas, aggregation, detection, thresholds validation, alarm reducer and migration, correlation verdicts on the synthetic incidents, CSV/import/capture parsers, report model, router validators, generator lock (SHA-256 of the KPI CSV) |
| Component | Vitest + jsdom + Testing Library, `tests/*.test.tsx` | pages render inside the real `AppProvider` with the synthetic dataset, an imported dataset and an empty window; drawers are dialogs; theme toggle; keyboard behaviour |
| Gates | `scripts/` | dataset byte-identity (`check:data`), no skipped/focused tests (`check:noskip`), coverage ≥ 80 % lines on `src/lib` and `src/theme` |
| End-to-end | Playwright (Chromium, one worker) against `vite preview` of the production build | exact production headers on the document and compiled assets; analyst workflows (shift start, KPI deep links and exports, alarm handling with persistence, thresholds, data import, captures, sites, report, theme, 375 px layout) with CSP-violation / console-refusal / foreign-request collectors asserted empty; axe-core scans (separately labelled, zero serious/critical) |
| CI | GitHub Actions, Node 20 | lint → typecheck → typecheck:tests → test:coverage → check:data → check:noskip → build → e2e, Playwright report uploaded on failure |

Tests are written before the behaviour they describe (see CONTRIBUTING.md), and a test that cannot run in an
environment fails visibly instead of being skipped.
