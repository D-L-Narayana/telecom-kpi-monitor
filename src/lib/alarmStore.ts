/**
 * Client-side alarm state overrides (acknowledge / clear / reopen) with an audit trail, persisted in localStorage.
 *
 * Store v2 (`tkm.alarms.v2`) is produced by a pure reducer so that every state change is testable and the
 * clock is explicit: `clearedAt` uses the dataset "now" while audit timestamps use the wall clock.
 * A v1 store (`tkm.alarms.v1`, no `version` field) is migrated transparently on first load.
 */
import type { Alarm, AlarmState } from "../types/telecom";
import { toCsv } from "./csv";

export type AlarmActionType = "acknowledge" | "clear" | "reopen";

export type AlarmAction =
  | { type: AlarmActionType; alarmId: string; note?: string }
  | { type: "bulk"; action: AlarmActionType; alarmIds: string[]; note?: string }
  | { type: "resetAlarm"; alarmId: string }
  | { type: "clearAudit" };

export interface AuditEntry { at: string; alarmId: string; action: AlarmActionType | "reset"; note?: string }

/** Operator override for one alarm. `note` is the most recent note given with any action on the alarm. */
export interface AlarmOverride { state: AlarmState; clearedAt?: string; note?: string }

export interface Store { version: 2; overrides: Record<string, AlarmOverride>; audit: AuditEntry[] }

/** `at` stamps audit entries (wall clock); `datasetNow` stamps `clearedAt` (the dataset's notion of now). */
export interface StoreClock { at: string; datasetNow: string }

export const ALARM_STORE_KEY = "tkm.alarms.v2";
export const LEGACY_ALARM_STORE_KEY = "tkm.alarms.v1";
export const AUDIT_LIMIT = 500;
export const AUDIT_CSV_COLUMNS = ["at", "alarmId", "action", "note"] as const;

const ALARM_STATES: readonly AlarmState[] = ["active", "acknowledged", "cleared"];
const AUDIT_ACTIONS: readonly AuditEntry["action"][] = ["acknowledge", "clear", "reopen", "reset"];
const STATE_FOR_ACTION: Record<AlarmActionType, AlarmState> = { acknowledge: "acknowledged", clear: "cleared", reopen: "active" };

export function emptyStore(): Store {
  return { version: 2, overrides: {}, audit: [] };
}

function cleanNote(note: string | undefined): string | undefined {
  const n = note?.trim();
  return n ? n : undefined;
}

function entry(at: string, alarmId: string, action: AuditEntry["action"], note?: string): AuditEntry {
  const e: AuditEntry = { at, alarmId, action };
  if (note !== undefined) e.note = note;
  return e;
}

function applyOne(overrides: Record<string, AlarmOverride>, alarmId: string, action: AlarmActionType, note: string | undefined, clock: StoreClock): AlarmOverride {
  const next: AlarmOverride = { state: STATE_FOR_ACTION[action] };
  if (action === "clear") next.clearedAt = clock.datasetNow;
  const keptNote = note ?? overrides[alarmId]?.note;
  if (keptNote !== undefined) next.note = keptNote;
  return next;
}

/** Pure reducer: never mutates `s`; returns `s` itself when the action changes nothing. */
export function reduceStore(s: Store, a: AlarmAction, clock: StoreClock): Store {
  switch (a.type) {
    case "acknowledge":
    case "clear":
    case "reopen": {
      const note = cleanNote(a.note);
      const overrides = { ...s.overrides, [a.alarmId]: applyOne(s.overrides, a.alarmId, a.type, note, clock) };
      return { version: 2, overrides, audit: [entry(clock.at, a.alarmId, a.type, note), ...s.audit].slice(0, AUDIT_LIMIT) };
    }
    case "bulk": {
      if (a.alarmIds.length === 0) return s;
      const note = cleanNote(a.note);
      const overrides = { ...s.overrides };
      const entries: AuditEntry[] = [];
      for (const alarmId of a.alarmIds) {
        overrides[alarmId] = applyOne(overrides, alarmId, a.action, note, clock);
        entries.push(entry(clock.at, alarmId, a.action, note));
      }
      return { version: 2, overrides, audit: [...entries, ...s.audit].slice(0, AUDIT_LIMIT) };
    }
    case "resetAlarm": {
      if (!(a.alarmId in s.overrides)) return s;
      const overrides = { ...s.overrides };
      delete overrides[a.alarmId];
      return { version: 2, overrides, audit: [entry(clock.at, a.alarmId, "reset"), ...s.audit].slice(0, AUDIT_LIMIT) };
    }
    case "clearAudit":
      return s.audit.length === 0 ? s : { version: 2, overrides: s.overrides, audit: [] };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Accepts v1 (`{ overrides, audit }`) or v2 objects of unknown provenance; drops anything malformed. */
export function normalizeStore(raw: unknown): Store {
  const out = emptyStore();
  if (!isRecord(raw)) return out;
  if (isRecord(raw.overrides)) {
    for (const [alarmId, o] of Object.entries(raw.overrides)) {
      if (!isRecord(o) || !ALARM_STATES.includes(o.state as AlarmState)) continue;
      const ov: AlarmOverride = { state: o.state as AlarmState };
      if (ov.state === "cleared" && typeof o.clearedAt === "string") ov.clearedAt = o.clearedAt;
      if (typeof o.note === "string" && o.note.trim()) ov.note = o.note;
      out.overrides[alarmId] = ov;
    }
  }
  if (Array.isArray(raw.audit)) {
    for (const e of raw.audit) {
      if (!isRecord(e) || typeof e.at !== "string" || typeof e.alarmId !== "string" || !AUDIT_ACTIONS.includes(e.action as AuditEntry["action"])) continue;
      out.audit.push(entry(e.at, e.alarmId, e.action as AuditEntry["action"], typeof e.note === "string" && e.note.trim() ? e.note : undefined));
      if (out.audit.length >= AUDIT_LIMIT) break;
    }
  }
  return out;
}

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : undefined;
  } catch {
    return undefined; // corrupt JSON or unavailable storage
  }
}

/** Loads the v2 store; falls back to a one-time migration of the v1 key; any corrupt or malformed data yields an empty store. */
export function loadStore(): Store {
  if (typeof localStorage === "undefined") return emptyStore();
  const v2 = readJson(ALARM_STORE_KEY);
  if (v2 !== undefined) return normalizeStore(v2);
  const v1 = readJson(LEGACY_ALARM_STORE_KEY);
  if (v1 === undefined) return emptyStore();
  const migrated = normalizeStore(v1);
  try {
    localStorage.setItem(ALARM_STORE_KEY, JSON.stringify(migrated));
    localStorage.removeItem(LEGACY_ALARM_STORE_KEY);
  } catch { /* keep the legacy key so the next load can retry the migration */ }
  return migrated;
}

export function saveStore(s: Store): void {
  try {
    localStorage.setItem(ALARM_STORE_KEY, JSON.stringify(s));
  } catch { /* storage full or unavailable: the in-memory store still works */ }
}

/** Applies operator overrides. `clearedAt` only survives for alarms that are (still) cleared. */
export function applyOverrides(alarms: Alarm[], s: Store): Alarm[] {
  return alarms.map((a) => {
    const o = s.overrides[a.alarmId];
    if (!o) return a;
    const merged: Alarm = { ...a, state: o.state };
    if (o.state === "cleared") {
      const clearedAt = o.clearedAt ?? a.clearedAt;
      if (clearedAt) merged.clearedAt = clearedAt;
    } else {
      delete merged.clearedAt;
    }
    return merged;
  });
}

/** Thin wrapper kept for existing callers: one action with a single clock value for both timestamps. */
export function act(s: Store, alarmId: string, action: AlarmActionType, nowIso: string, note?: string): Store {
  return reduceStore(s, { type: action, alarmId, note }, { at: nowIso, datasetNow: nowIso });
}

/** Audit trail as CSV (`at,alarmId,action,note`); the header is present even when the trail is empty. */
export function auditToCsv(audit: AuditEntry[]): string {
  const columns = [...AUDIT_CSV_COLUMNS];
  if (audit.length === 0) return columns.join(",");
  return toCsv(audit.map((e) => ({ at: e.at, alarmId: e.alarmId, action: e.action, note: e.note ?? "" })), columns);
}

export function durationMin(a: Alarm, nowIso: string): number {
  return Math.max(0, Math.round((Date.parse(a.clearedAt ?? nowIso) - Date.parse(a.timestamp)) / 60000));
}
