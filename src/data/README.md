# Synthetic data

Generated files are written here by `npm run gen:data` (see `scripts/generate-synthetic-data.mjs`):

- `sites.json` - 12 sites
- `cells.json` - 3 LTE + 1 NR cell per site (48 cells)
- `kpi_15min.json` - 7 days of 15-minute KPI samples per cell
- `alarms.json` - alarm log (about 300 alarms, correlated with KPI dips)
- `packet_stats.json` - protocol-hierarchy summary of a synthetic capture

The generator is a stub until milestone M1 in `PLAN.md`. Do not commit generated files; they are reproducible from a fixed seed.
