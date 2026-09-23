import { useState } from "react";
import { AppProvider, href, useApp } from "./state";
import { Overview } from "./pages/Overview";
import { Kpis } from "./pages/Kpis";
import { Alarms } from "./pages/Alarms";
import { Packets } from "./pages/Packets";
import { ThresholdDrawer } from "./components/ThresholdDrawer";
import type { TimeRange } from "./lib/kpi";

const PAGES = [
  { id: "overview", label: "Overview" },
  { id: "kpis", label: "KPIs" },
  { id: "alarms", label: "Alarms" },
  { id: "packets", label: "Packets" },
] as const;

function Shell() {
  const { route, range, setRange, tech, setTech } = useApp();
  const [drawer, setDrawer] = useState(false);
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-title">Telecom KPI Monitor</span>
          <span className="brand-sub">4G LTE / 5G NR network KPI and alarm monitoring · synthetic NOC dataset</span>
        </div>
        <nav className="nav" aria-label="Primary">
          {PAGES.map((p) => <a key={p.id} className={route.page === p.id ? "nav-item active" : "nav-item"} href={href(p.id)} aria-current={route.page === p.id ? "page" : undefined}>{p.label}</a>)}
        </nav>
        <div className="global-filters">
          <div className="seg" role="group" aria-label="Time range">
            {(["1h", "6h", "24h", "7d"] as TimeRange[]).map((r) => <button key={r} className={range === r ? "active" : ""} onClick={() => setRange(r)}>{r}</button>)}
          </div>
          <div className="seg" role="group" aria-label="Technology">
            {(["All", "LTE", "NR"] as const).map((t) => <button key={t} className={tech === t ? "active" : ""} onClick={() => setTech(t)}>{t}</button>)}
          </div>
          <button className="btn small" onClick={() => setDrawer(true)}>Thresholds</button>
        </div>
      </header>
      <main className="content">
        {route.page === "overview" && <Overview />}
        {route.page === "kpis" && <Kpis />}
        {route.page === "alarms" && <Alarms />}
        {route.page === "packets" && <Packets />}
      </main>
      <footer className="footer">
        Synthetic data (12 sites, 48 cells, 7 days of 15-minute KPIs, ~300 alarms) generated in the browser with a fixed seed; no live network is connected.
        Source: <a href="https://github.com/D-L-Narayana/telecom-kpi-monitor">github.com/D-L-Narayana/telecom-kpi-monitor</a>
      </footer>
      <ThresholdDrawer open={drawer} onClose={() => setDrawer(false)} />
    </div>
  );
}

export default function App() {
  return <AppProvider><Shell /></AppProvider>;
}
