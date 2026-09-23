import type { ReactNode } from "react";
import type { Severity } from "../types/telecom";
import type { Level } from "../lib/thresholds";

export function SeverityBadge({ s }: { s: Severity }) {
  return <span className={`badge sev-${s.toLowerCase()}`}>{s}</span>;
}
export function LevelBadge({ level }: { level: Level }) {
  const label = level === "ok" ? "OK" : level === "warning" ? "Warning" : "Critical";
  return <span className={`badge lvl-${level}`}>{label}</span>;
}
export function StateBadge({ s }: { s: string }) {
  return <span className={`badge state-${s}`}>{s}</span>;
}
export function Card({ title, children, actions, className = "" }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
export function Empty({ text }: { text: string }) {
  return <p className="empty">{text}</p>;
}
export function fmtTime(iso: string | number, withDate = true): string {
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = withDate
    ? { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }
    : { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" };
  return d.toLocaleString("en-IN", opts);
}
