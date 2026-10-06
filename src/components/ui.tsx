import { useEffect, useId, useRef, type ReactNode } from "react";
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
/** Formats a timestamp for display; the dataset is reported in IST unless another IANA zone is given. */
export function fmtTime(iso: string | number, withDate = true, tz = "Asia/Kolkata"): string {
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = withDate
    ? { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }
    : { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz };
  return d.toLocaleString("en-IN", opts);
}

/** Text available to assistive technology only (see .visually-hidden). */
export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="visually-hidden">{children}</span>;
}

export type NoticeKind = "info" | "warning" | "error" | "success";
/** Inline message. Errors are announced immediately (alert); everything else politely (status). */
export function Notice({ kind, children }: { kind: NoticeKind; children: ReactNode }) {
  return (
    <div className={`notice notice-${kind}`} role={kind === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** True when neither the element nor an ancestor up to (and including) root is hidden. */
function isShown(el: HTMLElement, root: HTMLElement): boolean {
  const view = el.ownerDocument.defaultView;
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (node.hidden || node.getAttribute("aria-hidden") === "true") return false;
    if (view) {
      const style = view.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    if (node === root) break;
  }
  return true;
}

/** Tab stops inside root, in document order. */
function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => isShown(el, root));
}

export interface DrawerProps {
  open: boolean;
  onClose(): void;
  title: string;
  children: ReactNode;
  /** Panel width in px (defaults to the stylesheet's min(420px, 100%)). */
  width?: number;
  footer?: ReactNode;
  /** Extra class names for the panel element (e.g. a wide variant). */
  className?: string;
}

/**
 * Right-hand side panel with dialog semantics: role="dialog" + aria-modal, labelled by its title,
 * Escape and backdrop click close it, Tab/Shift+Tab cycle inside it, focus moves in on open and
 * returns to the previously focused element on close, and the page behind it does not scroll.
 */
export function Drawer({ open, onClose, title, children, width, footer, className }: DrawerProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const pressedBackdrop = useRef(false);

  // Focus management and scroll lock, once per opening.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const panel = panelRef.current;
    if (panel) (focusableIn(panel)[0] ?? panel).focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previous && previous.isConnected) previous.focus();
    };
  }, [open]);

  // Keyboard: Escape closes, Tab is trapped inside the panel.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = focusableIn(panel);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      // Index of the focused tab stop; -1 when focus is on the panel itself or outside the dialog.
      const index = document.activeElement instanceof HTMLElement ? items.indexOf(document.activeElement) : -1;
      if (e.shiftKey) {
        if (index <= 0) {
          e.preventDefault();
          items[items.length - 1].focus();
        }
      } else if (index === -1 || index === items.length - 1) {
        e.preventDefault();
        items[0].focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="drawer-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // Close only when the press started and ended on the backdrop (not when a drag leaves the panel).
        if (e.target === e.currentTarget && pressedBackdrop.current) onClose();
        pressedBackdrop.current = false;
      }}
    >
      <div
        ref={panelRef}
        className={className ? `drawer ${className}` : "drawer"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={width ? { width: `${width}px` } : undefined}
      >
        <header className="drawer-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="btn small" onClick={onClose}>Close</button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer className="drawer-foot">{footer}</footer>}
      </div>
    </div>
  );
}
