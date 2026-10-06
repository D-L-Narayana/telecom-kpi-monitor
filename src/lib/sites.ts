/**
 * Site and region roll-ups of per-cell KPI samples, plus the map projection used by the Sites page.
 * Pure functions over the same inputs as `aggregateByCell` / `detectIssues`; nothing here reads app state.
 */
import type { Alarm, Cell, KpiKey, KpiSample, Site, Technology } from "../types/telecom";
import { KPI_META, aggregateByCell, availabilityPct, detectIssues, mean, networkKpi, type CellAggregate, type Detection } from "./kpi";
import type { Level, Thresholds } from "./thresholds";

export interface SiteAggregate {
  siteId: string;
  name: string;
  region: string;
  lat: number;
  lon: number;
  /** Cells of the site that reported samples in the window, sorted. */
  cellIds: string[];
  technologies: Technology[];
  samples: number;
  /** Intervals without counters, summed over the site's cells. */
  downIntervals: number;
  availabilityPct: number | null;
  /** Network KPI over the site's samples (user-weighted where `networkKpi` weights). */
  values: Record<KpiKey, number | null>;
  /** Worst threshold level of any cell of the site. */
  worstLevel: Level;
  /** Breached KPIs summed over the site's cells. */
  breaches: number;
  detections: Detection[];
  /** Alarms raised on the site that are not cleared. */
  activeAlarms: number;
  /** Per-cell aggregates (sorted by cell id), for drill-down tables. */
  cells: CellAggregate[];
  /** Cells with at least one interval without counters in the window. */
  downCells: number;
}

export interface RegionAggregate {
  region: string;
  siteIds: string[];
  cellCount: number;
  worstLevel: Level;
  /** Site values rolled up as a mean weighted by each site's intervals with counters. */
  values: Record<KpiKey, number | null>;
  activeAlarms: number;
  downCells: number;
}

const LEVEL_RANK: Record<Level, number> = { ok: 0, warning: 1, critical: 2 };
const ALL_KPIS = Object.keys(KPI_META) as KpiKey[];

/** Region used for cells whose site is not in the site list. */
export const UNASSIGNED_REGION = "Unassigned";

function worstOf(levels: Level[]): Level {
  let worst: Level = "ok";
  for (const l of levels) if (LEVEL_RANK[l] > LEVEL_RANK[worst]) worst = l;
  return worst;
}

const byId = (a: { siteId: string }, b: { siteId: string }) => (a.siteId < b.siteId ? -1 : a.siteId > b.siteId ? 1 : 0);

/**
 * One aggregate per site that has samples in `samples`. Samples of cells unknown to `cells` are skipped; cells whose
 * site is missing from `sites` get a placeholder site (name = id, region "Unassigned", NaN coordinates — which the
 * map projection skips). Output is sorted by site id.
 */
export function aggregateBySite(samples: KpiSample[], cells: Map<string, Cell>, sites: Site[], thresholds: Thresholds, alarms: Alarm[] = []): SiteAggregate[] {
  const siteIndex = new Map(sites.map((s) => [s.siteId, s]));
  const rowsBySite = new Map<string, KpiSample[]>();
  for (const s of samples) {
    const cell = cells.get(s.cellId);
    if (!cell) continue;
    const g = rowsBySite.get(cell.siteId);
    if (g) g.push(s);
    else rowsBySite.set(cell.siteId, [s]);
  }
  if (rowsBySite.size === 0) return [];

  const cellAggs = aggregateByCell(samples, cells, thresholds);
  const detections = detectIssues(samples, cells, thresholds);
  const activeBySite = new Map<string, number>();
  for (const a of alarms) if (a.state !== "cleared") activeBySite.set(a.siteId, (activeBySite.get(a.siteId) ?? 0) + 1);

  const out: SiteAggregate[] = [];
  for (const [siteId, rows] of rowsBySite) {
    const site = siteIndex.get(siteId) ?? { siteId, name: siteId, lat: Number.NaN, lon: Number.NaN, region: UNASSIGNED_REGION };
    const siteCells = cellAggs.filter((c) => c.siteId === siteId).sort((a, b) => (a.cellId < b.cellId ? -1 : 1));
    const values = {} as Record<KpiKey, number | null>;
    for (const k of ALL_KPIS) values[k] = networkKpi(rows, k);
    out.push({
      siteId,
      name: site.name,
      region: site.region,
      lat: site.lat,
      lon: site.lon,
      cellIds: siteCells.map((c) => c.cellId),
      technologies: [...new Set(siteCells.map((c) => c.technology))].sort(),
      samples: rows.length,
      downIntervals: siteCells.reduce((n, c) => n + c.downIntervals, 0),
      availabilityPct: availabilityPct(rows),
      values,
      worstLevel: worstOf(siteCells.map((c) => c.worstLevel)),
      breaches: siteCells.reduce((n, c) => n + c.breaches, 0),
      detections: detections.filter((d) => d.siteId === siteId),
      activeAlarms: activeBySite.get(siteId) ?? 0,
      cells: siteCells,
      downCells: siteCells.filter((c) => c.downIntervals > 0).length,
    });
  }
  return out.sort(byId);
}

/** Roll site aggregates up per region (sorted by region name). */
export function aggregateByRegion(sites: SiteAggregate[]): RegionAggregate[] {
  const groups = new Map<string, SiteAggregate[]>();
  for (const s of sites) {
    const g = groups.get(s.region);
    if (g) g.push(s);
    else groups.set(s.region, [s]);
  }
  const out: RegionAggregate[] = [];
  for (const [region, members] of groups) {
    const sorted = [...members].sort(byId);
    // weight each site by its intervals that reported counters, so a site that was mostly down does not dominate
    const weights = sorted.map((s) => Math.max(1, s.samples - s.downIntervals));
    const values = {} as Record<KpiKey, number | null>;
    for (const k of ALL_KPIS) values[k] = mean(sorted.map((s) => s.values[k]), weights);
    out.push({
      region,
      siteIds: sorted.map((s) => s.siteId),
      cellCount: sorted.reduce((n, s) => n + s.cellIds.length, 0),
      worstLevel: worstOf(sorted.map((s) => s.worstLevel)),
      values,
      activeAlarms: sorted.reduce((n, s) => n + s.activeAlarms, 0),
      downCells: sorted.reduce((n, s) => n + s.downCells, 0),
    });
  }
  return out.sort((a, b) => (a.region < b.region ? -1 : a.region > b.region ? 1 : 0));
}

/**
 * Equirectangular projection of site coordinates into a `width × height` box with `pad` pixels of margin.
 * Longitude is scaled by cos(mean latitude) so distances look right at the sites' latitude; the aspect ratio is
 * preserved and the point cloud is centred. North is up (smaller y). Sites with non-finite coordinates are skipped;
 * a single site (or coincident sites) lands in the centre.
 */
export function projectSites(sites: Pick<Site, "siteId" | "lat" | "lon">[], width: number, height: number, pad = 16): { siteId: string; x: number; y: number }[] {
  const valid = sites.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
  if (valid.length === 0) return [];
  const innerW = Math.max(0, width - 2 * pad);
  const innerH = Math.max(0, height - 2 * pad);
  const meanLat = valid.reduce((a, s) => a + s.lat, 0) / valid.length;
  const k = Math.cos((meanLat * Math.PI) / 180);
  const pts = valid.map((s) => ({ siteId: s.siteId, px: s.lon * k, py: -s.lat }));
  const minX = Math.min(...pts.map((p) => p.px));
  const maxX = Math.max(...pts.map((p) => p.px));
  const minY = Math.min(...pts.map((p) => p.py));
  const maxY = Math.max(...pts.map((p) => p.py));
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const scaleX = spanX > 0 ? innerW / spanX : Number.POSITIVE_INFINITY;
  const scaleY = spanY > 0 ? innerH / spanY : Number.POSITIVE_INFINITY;
  const scale = Math.min(scaleX, scaleY);
  const s = Number.isFinite(scale) ? scale : 0;
  const offX = pad + (innerW - spanX * s) / 2;
  const offY = pad + (innerH - spanY * s) / 2;
  return pts.map((p) => ({ siteId: p.siteId, x: offX + (p.px - minX) * s, y: offY + (p.py - minY) * s }));
}
