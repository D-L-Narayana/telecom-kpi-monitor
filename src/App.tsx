import { useState, type MouseEvent } from "react";
import { AppProvider, href, useApp } from "./state";
import { PAGES, type Page } from "./lib/router";
import { Overview } from "./pages/Overview";
import { Kpis } from "./pages/Kpis";
import { Alarms } from "./pages/Alarms";
import { Packets } from "./pages/Packets";
import { Sites } from "./pages/Sites";
import { Report } from "./pages/Report";
import { ThresholdDrawer } from "./components/ThresholdDrawer";
import { DataSourceDrawer } from "./components/DataSourceDrawer";
import { ThemeToggle } from "./theme";
import type { TimeRange } from "./lib/kpi";

const PAGE_LABELS: Record<Page, string> = { overview: "Overview", kpis: "KPIs", alarms: "Alarms", packets: "Packets", sites: "Sites", report: "Report" };
const RANGES: TimeRange[] = ["1h", "6h", "24h", "7d"];
const TECHS = ["All", "LTE", "NR"] as const;

function Shell() {
  const { route, range, setRange, tech, setTech, source, loadDataset, resetToSynthetic } = useApp();
  const [drawer, setDrawer] = useState<"thresholds" | "data" | null>(null);
  const skipToContent = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const main = document.getElementById("main");
    main?.focus();
    main?.scrollIntoView();
  };
  return (
    <div className="app">
      <a className="skip-link" href="#main" onClick={skipToContent}>Skip to content</a>
      <header className="topbar no-print">
        <div className="brand">
          <span className="brand-title">Telecom KPI Monitor</span>
          <span className="brand-sub">4G LTE / 5G NR network KPI and alarm monitoring · {source.kind === "synthetic" ? "synthetic NOC dataset" : `imported dataset: ${source.label}`}</span>
        </div>
        <nav className="nav" aria-label="Primary">
          {PAGES.map((p) => (
            <a key={p} className={route.page === p ? "nav-item active" : "nav-item"} href={href(p, { range, tech })} aria-current={route.page === p ? "page" : undefined}>
              {PAGE_LABELS[p]}
            </a>
          ))}
        </nav>
        <div className="global-filters">
          <div className="seg" role="group" aria-label="Time range">
            {RANGES.map((r) => <button key={r} type="button" className={range === r ? "active" : ""} aria-pressed={range === r} onClick={() => setRange(r)}>{r}</button>)}
          </div>
          <div className="seg" role="group" aria-label="Technology">
            {TECHS.map((t) => <button key={t} type="button" className={tech === t ? "active" : ""} aria-pressed={tech === t} onClick={() => setTech(t)}>{t}</button>)}
          </div>
          <ThemeToggle />
          <button type="button" className="btn small" onClick={() => setDrawer("data")} aria-haspopup="dialog">Data</button>
          <button type="button" className="btn small" onClick={() => setDrawer("thresholds")} aria-haspopup="dialog">Thresholds</button>
        </div>
      </header>
      <main id="main" className="content" tabIndex={-1}>
        {route.page === "overview" && <Overview />}
        {route.page === "kpis" && <Kpis />}
        {route.page === "alarms" && <Alarms />}
        {route.page === "packets" && <Packets />}
        {route.page === "sites" && <Sites />}
        {route.page === "report" && <Report />}
      </main>
      <footer className="footer no-print">
        {source.kind === "synthetic"
          ? `Synthetic data (${source.siteCount} sites, ${source.cellCount} cells, 7 days of 15-minute KPIs, ${source.alarmCount} alarms) generated in the browser with a fixed seed; no live network is connected.`
          : `Imported dataset "${source.label}" (${source.rows.toLocaleString()} KPI samples, ${source.cellCount} cells, ${source.siteCount} sites, ${source.alarmCount} alarms), held in memory for this session only; a reload returns to the synthetic dataset.`}
        {" "}{source.persisted ? "Alarm actions are kept in this browser." : "Alarm actions are kept for this session only."}
        {" "}Source: <a href="https://github.com/D-L-Narayana/telecom-kpi-monitor">github.com/D-L-Narayana/telecom-kpi-monitor</a>
      </footer>
      <ThresholdDrawer open={drawer === "thresholds"} onClose={() => setDrawer(null)} />
      <DataSourceDrawer
        open={drawer === "data"}
        onClose={() => setDrawer(null)}
        onLoad={(ds, label, warnings) => { loadDataset(ds, label, warnings); setDrawer(null); }}
        onReset={() => { resetToSynthetic(); setDrawer(null); }}
        source={{ kind: source.kind, label: source.label, rows: source.rows, cellCount: source.cellCount, siteCount: source.siteCount, alarmCount: source.alarmCount }}
      />
    </div>
  );
}

export default function App() {
  return <AppProvider><Shell /></AppProvider>;
}
