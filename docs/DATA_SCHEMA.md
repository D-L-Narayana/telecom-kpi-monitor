# Data schema

The dashboard reads and writes one data schema. `npm run gen:data` writes the synthetic dataset to `data/` in this
schema, and the **Data** drawer in the app loads the same files back (bring-your-own data). Everything is parsed in the
browser; nothing is uploaded, and an imported dataset lives in memory only until the page is reloaded.

| File | Role in the Data drawer | Format |
| --- | --- | --- |
| `kpi_15min.csv` | **required** - one row per cell per reporting interval | CSV |
| `cells.json` or `cells.csv` | optional - cell attributes (technology, band, site); otherwise inferred from the cell id | JSON array or CSV |
| `sites.json` | optional - site names, regions and coordinates for the Sites map; otherwise placeholder sites | JSON array |
| `alarms.csv` or `alarms.json` | optional - alarm list for the Alarms page; otherwise no alarms | CSV or JSON array |
| `packet_stats.json` | not imported here - load `tshark` / Wireshark exports on the Packets page instead | JSON |

Any file name is accepted: the drawer recognises each file by its header (CSV) or first object (JSON) and only falls
back to the file name (`*alarm*`, `*cell*`, `*site*`, `*kpi*`). When two files of the same kind are chosen, the newer one
replaces the older one.

## CSV conventions

- RFC 4180: comma separated, optional double quotes, `""` escapes a quote inside a quoted field, quoted fields may contain
  commas and line breaks. Line ends may be CRLF, LF or CR. A leading UTF-8 byte-order mark is ignored.
- The first row is the header. Column **order is free**; header names are trimmed and case-sensitive. Unknown columns
  are ignored with a warning; a duplicated column name is ignored after its first occurrence.
- Rows with fewer fields than the header are padded with empty fields, rows with more are truncated; both are reported.
- Blank lines are skipped. Messages refer to **file line numbers** (the header is line 1), which equal the row numbers a
  spreadsheet shows when no field contains a line break. For JSON files the number is the 1-based position in the array.
- Exports written by the app use CRLF line ends, no trailing newline, and quote only fields that need it. Text cells that
  start with `=`, `+`, `-`, `@`, a tab or a carriage return are prefixed with an apostrophe (`'=CMD()`), so a value coming
  from a loaded file cannot run as a spreadsheet formula. Numbers and numeric strings such as `-92.14` are never altered.

## `kpi_15min.csv`

All twelve columns are required. Empty values are **null** ("no counters" - the cell was down or did not report), except
`activeUsers`, where an empty value means `0`. The tokens `null`, `NaN`, `NA`, `N/A`, `None` and `-` (any case) are also
read as null. Any other non-numeric value is an error that rejects the row.

| Column | Type | Unit | Null | Notes |
| --- | --- | --- | --- | --- |
| `cellId` | string | | no | `<SITE>-L<n>` (LTE) or `<SITE>-N<n>` (NR) lets the app infer the site and technology, e.g. `VSKP-001-L1`, `VSKP-001-N1` |
| `timestamp` | ISO 8601 date-time | UTC | no | Interval **end** instant. `2026-09-16T09:00:00.000Z`, any `+hh:mm` offset, epoch seconds or epoch milliseconds. Normalised to `YYYY-MM-DDTHH:mm:ss.sssZ`. A value without a zone designator is read in the browser's local time zone (one warning per file) |
| `callDropRatePct` | number | % | yes | dropped / (dropped + completed) x 100. Values outside 0..100 are kept but warned about |
| `rrcSetupSuccessPct` | number | % | yes | RRC connection setup success rate (0..100 expected) |
| `handoverSuccessPct` | number | % | yes | Handover success rate (0..100 expected) |
| `dlThroughputMbps` | number | Mbps | yes | Average downlink user throughput |
| `ulThroughputMbps` | number | Mbps | yes | Average uplink user throughput |
| `latencyMs` | number | ms | yes | User-plane round-trip time |
| `prbUtilizationPct` | number | % | yes | PRB utilisation - the congestion indicator (0..100 expected). `null` marks a down interval |
| `rsrpAvgDbm` | number | dBm | yes | Average RSRP (negative values are normal) |
| `sinrAvgDb` | number | dB | yes | Average SINR |
| `activeUsers` | integer | users | no (empty = 0) | Used as the weight for traffic-weighted network KPIs (drop rate, success rates, latency) |

Rules and derived values:

- The reporting interval is detected as the **median gap** between consecutive distinct timestamps (15 min for
  `gen:data` output); charts and the "down intervals" counts assume one row per cell per interval.
- The app's "now" becomes the latest timestamp in the file; the 1h/6h/24h/7d windows count back from there.
- A row whose nine KPI columns are all empty is a **down interval**; two or more consecutive down intervals trigger the
  outage detection.
- Limit: **500,000 data rows** per file (the import stops with an error above that) and **100 MB** per file. A file with
  no data rows or without a header is an error. Rows with an empty `cellId` or an unparseable `timestamp` are errors
  (reported with their line); the import is only usable when there are no errors.

### Example (three rows)

```csv
cellId,timestamp,callDropRatePct,rrcSetupSuccessPct,handoverSuccessPct,dlThroughputMbps,ulThroughputMbps,latencyMs,prbUtilizationPct,rsrpAvgDbm,sinrAvgDb,activeUsers
SITE-001-L1,2026-09-23T06:15:00.000Z,0.61,99.02,98.15,33.4,10.3,30.8,35.2,-92.1,7.4,64
SITE-001-N1,2026-09-23T06:15:00.000Z,0.58,99.1,98.3,301.5,54.2,18.6,31.9,-92.6,12.1,131
SITE-001-L1,2026-09-23T06:30:00.000Z,,,,,,,,,,0
```

The third row is a down interval for `SITE-001-L1`. "Download sample CSV" in the Data drawer produces a six-row file in
this shape.

## `cells.json` / `cells.csv`

A JSON array of objects (or a CSV with the same field names). Only `cellId` is required; every other field falls back
to the value inferred from the cell id.

| Field | Type | Default when missing |
| --- | --- | --- |
| `cellId` | string | required - entries without it are errors |
| `siteId` | string | the cell id up to its last `-` |
| `technology` | `"LTE"` or `"NR"` (case-insensitive) | `L<n>` -> LTE, `N<n>` -> NR, otherwise LTE with a warning |
| `band` | string | LTE: `B3`, `B40`, `B1` for n = 1, 2, 3 (repeating); NR: `n78`; otherwise `unknown` |
| `bandwidthMHz` | number | LTE 20, NR 100, otherwise 0 |
| `azimuthDeg` | number | LTE `(n-1) mod 3 x 120`, NR 0 |

Cells that appear in the KPI file but not in the cells file are added with inferred attributes (one warning listing
them); cells in the file without KPI rows are kept (they simply have no samples). Duplicate `cellId`s keep the first entry.

## `sites.json`

A JSON array. `siteId` is required; `lat`/`lon` (also accepted as `latitude`/`longitude`, `lng`) must be finite numbers
to place the site on the map - a site without valid coordinates is kept but not drawn (warning). `name` defaults to the
site id and `region` to `"imported"`. Sites referenced by cells but absent from the file are created as placeholders
(`name` = site id, no coordinates, region `"imported"`).

```json
[{ "siteId": "SITE-001", "name": "Harbour", "lat": 17.6868, "lon": 83.2185, "region": "East" }]
```

## `alarms.csv` / `alarms.json`

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `alarmId` | string | yes | Duplicates keep the first row |
| `timestamp` | ISO 8601 / epoch | yes | Raise time; invalid values are errors |
| `clearedAt` | ISO 8601 / epoch | no | Empty when not cleared; invalid values are dropped with a warning |
| `siteId` | string | yes, unless `cellId` is given | Derived from the cell when missing |
| `cellId` | string | no | Empty for site-level alarms |
| `technology` | `LTE` / `NR` | no | Taken from the cells list when missing and the cell is known |
| `severity` | `Critical` / `Major` / `Minor` / `Warning` (case-insensitive) | no | Unknown values become `Warning` with a warning |
| `probableCause` | string | no | Free text, e.g. `Cell down`, `High PRB utilization`; empty when missing |
| `state` | `active` / `acknowledged` / `cleared` (case-insensitive) | no | Unknown values become `active` with a warning |

```csv
alarmId,timestamp,clearedAt,siteId,cellId,technology,severity,probableCause,state
ALM-000001,2026-09-18T03:30:00.000Z,2026-09-18T09:30:00.000Z,VSKP-004,VSKP-004-L2,LTE,Critical,Cell down,cleared
```

Acknowledge/clear/reopen actions taken in the app are applied on top of the imported states by alarm id. For the
synthetic dataset they are stored per browser (`localStorage`); for an imported dataset they are kept in memory for the
session only and disappear with the dataset on reload.

## Round trip with `gen:data`

1. `npm run gen:data` writes `data/kpi_15min.csv`, `data/cells.json`, `data/sites.json`, `data/alarms.csv` (and
   `alarms.json`, `packet_stats.json`).
2. Open the app, press **Data**, choose or drop `kpi_15min.csv` together with `cells.json`, `sites.json` and
   `alarms.csv`, check the summary (32,256 rows, 48 cells, 12 sites, 300 alarms, 15-min interval) and press
   **Use dataset**.
3. The whole app now runs on the imported copy: "now" is the last sample (2026-09-23 08:45 UTC), the Packets page shows
   its empty state because no capture is part of this schema, and **Back to synthetic** restores the built-in dataset.

The unit tests import the committed `data/kpi_15min.csv` and `data/alarms.csv`, export them again and compare the text
byte for byte, so a file produced by the generator survives the import/export cycle unchanged.
