import { useId, useMemo, type KeyboardEvent } from "react";
import { projectSites, type SiteAggregate } from "../lib/sites";
import type { Level } from "../lib/thresholds";

export interface SiteMapProps {
  sites: SiteAggregate[];
  /** Site id highlighted on the map (pressed state). */
  selected?: string;
  onSelect: (siteId: string) => void;
  width?: number;
  height?: number;
}

/** Margin inside the SVG box so the largest circles and their focus rings stay visible. */
const PAD = 24;
/** Circle radius grows with the number of cells a site carries. */
const BASE_RADIUS = 6;
const RADIUS_PER_CELL = 1.5;
/** Approximate glyph width (px) used to keep site labels inside the box. */
const LABEL_CHAR_PX = 6.5;

const LEVEL_LABEL: Record<Level, string> = { ok: "OK", warning: "Warning", critical: "Critical" };

const hasCoordinates = (s: Pick<SiteAggregate, "lat" | "lon">) => Number.isFinite(s.lat) && Number.isFinite(s.lon);

function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

/** Text alternative for one site: id, name, region, status, cells and (when present) active alarms. */
function describeSite(s: SiteAggregate): string {
  const alarms = s.activeAlarms > 0 ? `, ${plural(s.activeAlarms, "active alarm")}` : "";
  return `${s.siteId} ${s.name}, ${s.region}, ${LEVEL_LABEL[s.worstLevel]}, ${plural(s.cellIds.length, "cell")}${alarms}`;
}

/**
 * Pure-SVG site health map. Sites are placed with `projectSites`; each site with finite coordinates becomes a
 * keyboard-focusable circle (Enter / Space / click select it) whose colour follows its worst threshold level
 * (`.site-map circle.lvl-*` fills) and whose radius grows with its cell count. The selected and the critical
 * sites carry a text label. A visually hidden list repeats every site — including those without coordinates,
 * which are not drawn — as a text alternative.
 */
export function SiteMap({ sites, selected, onSelect, width = 640, height = 360 }: SiteMapProps) {
  const titleId = useId();
  const placed = useMemo(() => {
    const position = new Map(projectSites(sites, width, height, PAD).map((p) => [p.siteId, p]));
    return sites.flatMap((site) => {
      const p = position.get(site.siteId);
      return p ? [{ site, x: p.x, y: p.y, r: BASE_RADIUS + RADIUS_PER_CELL * site.cellIds.length }] : [];
    });
  }, [sites, width, height]);

  const counts = { ok: 0, warning: 0, critical: 0 } as Record<Level, number>;
  for (const s of sites) counts[s.worstLevel]++;
  const withoutCoordinates = sites.length - placed.length;
  const title =
    `Site health map: ${plural(sites.length, "site")}, ${counts.critical} critical, ${counts.warning} warning, ${counts.ok} OK` +
    (withoutCoordinates > 0 ? `, ${withoutCoordinates} without coordinates` : "");

  const select = (siteId: string) => (e: KeyboardEvent<SVGCircleElement>) => {
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      onSelect(siteId);
    }
  };

  return (
    <>
      <svg className="site-map" role="group" aria-labelledby={titleId} viewBox={`0 0 ${width} ${height}`}>
        <title id={titleId}>{title}</title>
        {placed.length === 0 && (
          <text className="map-label" x={width / 2} y={height / 2} textAnchor="middle">
            No site coordinates to draw
          </text>
        )}
        {placed.map(({ site, x, y, r }) => {
          const isSelected = site.siteId === selected;
          return (
            <circle
              key={site.siteId}
              className={isSelected ? `lvl-${site.worstLevel} selected` : `lvl-${site.worstLevel}`}
              cx={x}
              cy={y}
              r={r}
              role="button"
              tabIndex={0}
              aria-label={describeSite(site)}
              aria-pressed={isSelected}
              onClick={() => onSelect(site.siteId)}
              onKeyDown={select(site.siteId)}
            >
              <title>{describeSite(site)}</title>
            </circle>
          );
        })}
        {placed
          .filter(({ site }) => site.siteId === selected || site.worstLevel === "critical")
          .map(({ site, x, y, r }) => {
            const fitsRight = x + r + 4 + site.siteId.length * LABEL_CHAR_PX <= width - 4;
            return (
              <text key={site.siteId} x={fitsRight ? x + r + 4 : x - r - 4} y={y + 3.5} textAnchor={fitsRight ? "start" : "end"} aria-hidden="true">
                {site.siteId}
              </text>
            );
          })}
      </svg>
      {sites.length > 0 && (
        <ul className="visually-hidden" aria-label="Sites on the map">
          {sites.map((s) => (
            <li key={s.siteId}>{hasCoordinates(s) ? describeSite(s) : `${describeSite(s)}, no coordinates`}</li>
          ))}
        </ul>
      )}
    </>
  );
}
