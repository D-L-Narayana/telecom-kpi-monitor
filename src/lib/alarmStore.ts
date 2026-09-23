/** Client-side alarm state overrides (acknowledge / clear) with an audit trail, persisted in localStorage. */
import type { Alarm, AlarmState } from "../types/telecom";

export interface AuditEntry { at: string; alarmId: string; action: "acknowledge" | "clear" | "reset"; note?: string }
interface Store { overrides: Record<string, { state: AlarmState; clearedAt?: string }>; audit: AuditEntry[] }
const KEY = "tkm.alarms.v1";

export function loadStore(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Store;
  } catch { /* ignore */ }
  return { overrides: {}, audit: [] };
}
export function saveStore(s: Store): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}
export function applyOverrides(alarms: Alarm[], s: Store): Alarm[] {
  return alarms.map((a) => (s.overrides[a.alarmId] ? { ...a, ...s.overrides[a.alarmId] } : a));
}
export function act(s: Store, alarmId: string, action: "acknowledge" | "clear", nowIso: string, note?: string): Store {
  const overrides = { ...s.overrides, [alarmId]: action === "clear" ? { state: "cleared" as AlarmState, clearedAt: nowIso } : { state: "acknowledged" as AlarmState } };
  return { overrides, audit: [{ at: nowIso, alarmId, action, note }, ...s.audit].slice(0, 200) };
}
export function durationMin(a: Alarm, nowIso: string): number {
  return Math.max(0, Math.round((Date.parse(a.clearedAt ?? nowIso) - Date.parse(a.timestamp)) / 60000));
}
