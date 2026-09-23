import { useState } from "react";
import { Overview } from "./pages/Overview";
import { Kpis } from "./pages/Kpis";
import { Alarms } from "./pages/Alarms";
import { Packets } from "./pages/Packets";

export type PageId = "overview" | "kpis" | "alarms" | "packets";

const PAGES: { id: PageId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "kpis", label: "KPIs" },
  { id: "alarms", label: "Alarms" },
  { id: "packets", label: "Packets" },
];

export default function App() {
  const [page, setPage] = useState<PageId>("overview");

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-title">Telecom KPI Monitor</span>
          <span className="brand-sub">4G LTE / 5G NR network KPI and alarm monitoring</span>
        </div>
        <nav className="nav" aria-label="Primary">
          {PAGES.map((p) => (
            <button
              key={p.id}
              className={page === p.id ? "nav-item active" : "nav-item"}
              onClick={() => setPage(p.id)}
              aria-current={page === p.id ? "page" : undefined}
            >
              {p.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="content">
        {page === "overview" && <Overview />}
        {page === "kpis" && <Kpis />}
        {page === "alarms" && <Alarms />}
        {page === "packets" && <Packets />}
      </main>

      <footer className="footer">
        Scaffold v0.1 - features are specified in{" "}
        <a href="https://github.com/D-L-Narayana/telecom-kpi-monitor/blob/main/PLAN.md">PLAN.md</a>{" "}
        and not yet implemented. Data shown is synthetic.
      </footer>
    </div>
  );
}
