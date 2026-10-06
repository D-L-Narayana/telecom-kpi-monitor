# Dataset notes

The application does **not** load JSON from this folder. The synthetic dataset is regenerated in the browser on every page load by `src/lib/synthetic.ts` (mulberry32 PRNG, seed `20260923`), so the bundle carries no multi-MB data file.

The same generator writes reproducible files to the top-level `data/` directory with `npm run gen:data` (see `scripts/generate-synthetic-data.mjs`):

- `data/sites.json` - 12 sites
- `data/cells.json` - 3 LTE + 1 NR cell per site (48 cells)
- `data/kpi_15min.csv` - 7 days of 15-minute KPI samples per cell (32,256 rows)
- `data/alarms.json` / `data/alarms.csv` - 300 alarms
- `data/packet_stats.json` - protocol hierarchy, top conversations and TCP summary of a synthetic capture

These files are committed so they can be used directly in SQL / pandas, and `npm run check:data` verifies that the generator still reproduces them byte for byte. Files in the same format can be loaded back into the app through the **Data** drawer; the column schema is documented in `docs/DATA_SCHEMA.md`.
