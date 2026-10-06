# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.0.0] - 2026-10-06

### Added
- **Shareable analysis state**: the global time range and technology filter live in the URL hash (`#/kpis?range=7d&tech=NR&cell=…`) and are remembered between visits; every page validates its parameters and falls back gracefully.
- **Bring-your-own data** (`Data` drawer): load a KPI 15-minute CSV plus optional cells / sites / alarms files in the same schema that `npm run gen:data` writes. Rows are validated, cells and sites are inferred when not supplied, and every page (Overview, KPIs, Alarms, Sites, Report) runs on the imported dataset. Schema in `docs/DATA_SCHEMA.md`.
- **Alarm operations**: alarm ↔ KPI correlation (baseline / during / after windows, hourly peak, breach fraction, score and verdict shown in the Explain panel and exported with `alarms.csv`), reopen, notes, bulk acknowledge of the filtered list, URL-synced filters, sortable and paginated alarm table with keyboard navigation, audit-trail export (`alarm-audit.csv`). The alarm store moves to `tkm.alarms.v2` (v1 data is migrated once).
- **Sites & regions page**: pure-SVG site health map from the dataset's coordinates, region roll-ups and a sortable per-site table with availability, KPIs, active alarms and down cells; CSV export.
- **Shift handover report**: Markdown / CSV / print report for the current window (KPIs with deltas, detections, worst cells, alarm counts, raised / cleared lists, handover notes kept in the browser).
- **Packets**: protocol hierarchy reconstructed from `frame.protocols` (tunnelled layers kept apart as `ip (in gtp)`, link-layer/padding tokens dropped, roots sum to the frame count), support for `tshark -z io,phs` and `tshark -T fields` exports, conversations from tshark JSON and Wireshark CSV exports (quoted multi-line fields handled), parser warnings, 50 MB size guard and drag-and-drop; `Conversations CSV` export.
- **KPI analysis**: timestamp-aligned compare (cell / site mean / network), hourly aggregation and brush for 7-day views, warning band, availability column and breach filter, text alternative for charts.
- **Thresholds**: validation (ordering, numeric), presets, JSON import / export; invalid input no longer silently becomes 0.
- **Sleeping-cell detection** rule alongside outage, congestion, latency and drop detections.
- **Dark mode** (light / dark / system) built on design tokens; accessible dialogs (focus trap, Esc), skip link, focus-visible styling, reduced-motion and print stylesheets, 375 px layout.
- **Quality infrastructure**: jsdom component tests, ESLint (TypeScript, React hooks, jsx-a11y), typed tests, coverage threshold, Playwright end-to-end workflows run against the production bundle with the production security headers, dataset-determinism and no-skipped-tests gates, GitHub Actions CI.
- **Security headers** in `vercel.json` (Content-Security-Policy, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`), also served by `vite preview`.

### Changed
- `clearedAt` for alarms cleared in the UI is stamped in dataset time (the dataset's "now") instead of the wall clock, so durations stay meaningful.
- CSV exports use the union of all row columns and guard against spreadsheet formula injection.
- Vendor code is split into separate chunks (`vendor-react`, `vendor-charts`).
- `vitest` and `tsx` moved to `devDependencies`; Node 20 or newer is required.

### Fixed
- Crash when opening `#/kpis` with an unknown `kpi` or `cell` parameter.
- Compare overlay joined series by array index instead of timestamp.
- Protocol CSV export dropped the `parent` and `retransmissions` columns.
- Wireshark CSV exports with quoted multi-line `Info` fields were parsed incorrectly.
- Inconsistent sort comparator in the detection list.
- Stale notes in `src/data/README.md` and the scaffold-era page description.

## [1.0.0] - 2026-09-23

Initial release: Overview, KPIs, Alarms and Packets pages on the synthetic dataset; thresholds drawer; CSV exports; Vitest unit tests; Vercel deployment.
