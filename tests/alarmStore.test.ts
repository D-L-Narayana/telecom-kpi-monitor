import { describe, expect, it } from "vitest";
import {
  ALARM_STORE_KEY, AUDIT_LIMIT, LEGACY_ALARM_STORE_KEY, act, applyOverrides, auditToCsv, emptyStore, loadStore, reduceStore, saveStore,
  type AlarmAction, type Store, type StoreClock,
} from "../src/lib/alarmStore";
import type { Alarm } from "../src/types/telecom";

const clock: StoreClock = { at: "2026-10-04T10:15:00.000Z", datasetNow: "2026-09-23T09:00:00.000Z" };

function frozen(s: Store): Store {
  Object.freeze(s.overrides);
  Object.freeze(s.audit);
  return Object.freeze(s);
}

const activeAlarm: Alarm = { alarmId: "ALM-000010", timestamp: "2026-09-22T08:00:00.000Z", siteId: "VSKP-001", cellId: "VSKP-001-L1", technology: "LTE", severity: "Major", probableCause: "Sleeping cell suspected", state: "active" };
const clearedAlarm: Alarm = { alarmId: "ALM-000011", timestamp: "2026-09-21T08:00:00.000Z", siteId: "VSKP-002", severity: "Minor", probableCause: "Door open", state: "cleared", clearedAt: "2026-09-21T10:00:00.000Z" };

describe("reduceStore transitions", () => {
  it("acknowledge sets the override state and logs an audit entry stamped with the wall clock", () => {
    const s = reduceStore(frozen(emptyStore()), { type: "acknowledge", alarmId: "ALM-000010", note: "looking into it" }, clock);
    expect(s.version).toBe(2);
    expect(s.overrides["ALM-000010"]).toEqual({ state: "acknowledged", note: "looking into it" });
    expect(s.audit).toHaveLength(1);
    expect(s.audit[0]).toEqual({ at: clock.at, alarmId: "ALM-000010", action: "acknowledge", note: "looking into it" });
    expect(applyOverrides([activeAlarm], s)[0].state).toBe("acknowledged");
  });

  it("clear stamps clearedAt with the dataset clock, not the wall clock", () => {
    const s = reduceStore(frozen(emptyStore()), { type: "clear", alarmId: "ALM-000010" }, clock);
    expect(s.overrides["ALM-000010"].state).toBe("cleared");
    expect(s.overrides["ALM-000010"].clearedAt).toBe(clock.datasetNow);
    expect(s.overrides["ALM-000010"].clearedAt).not.toBe(clock.at);
    expect(s.audit[0].at).toBe(clock.at);
    const applied = applyOverrides([activeAlarm], s)[0];
    expect(applied.state).toBe("cleared");
    expect(applied.clearedAt).toBe(clock.datasetNow);
  });

  it("reopen returns the alarm to active and removes clearedAt", () => {
    const cleared = reduceStore(emptyStore(), { type: "clear", alarmId: "ALM-000011" }, clock);
    const s = reduceStore(frozen(cleared), { type: "reopen", alarmId: "ALM-000011", note: "fault came back" }, clock);
    expect(s.overrides["ALM-000011"].state).toBe("active");
    expect(s.overrides["ALM-000011"]).not.toHaveProperty("clearedAt");
    expect(s.audit.map((e) => e.action)).toEqual(["reopen", "clear"]);
    // a dataset-cleared alarm that is reopened must not keep its original clearance time either
    const applied = applyOverrides([clearedAlarm], s)[0];
    expect(applied.state).toBe("active");
    expect(applied.clearedAt).toBeUndefined();
  });

  it("bulk acknowledge of 3 ids creates 3 overrides and 3 audit entries sharing the note", () => {
    const ids = ["ALM-000020", "ALM-000021", "ALM-000022"];
    const s = reduceStore(frozen(emptyStore()), { type: "bulk", action: "acknowledge", alarmIds: ids, note: "shift handover" }, clock);
    expect(Object.keys(s.overrides).sort()).toEqual(ids);
    expect(Object.values(s.overrides).every((o) => o.state === "acknowledged" && o.note === "shift handover")).toBe(true);
    expect(s.audit).toHaveLength(3);
    expect(s.audit.map((e) => e.alarmId).sort()).toEqual(ids);
    expect(s.audit.every((e) => e.action === "acknowledge" && e.at === clock.at && e.note === "shift handover")).toBe(true);
    const empty = emptyStore();
    expect(reduceStore(empty, { type: "bulk", action: "clear", alarmIds: [] }, clock)).toBe(empty);
  });

  it("resetAlarm drops the override and logs a reset entry", () => {
    const acked = reduceStore(emptyStore(), { type: "acknowledge", alarmId: "ALM-000010" }, clock);
    const s = reduceStore(frozen(acked), { type: "resetAlarm", alarmId: "ALM-000010" }, clock);
    expect(s.overrides).not.toHaveProperty("ALM-000010");
    expect(s.audit[0]).toEqual({ at: clock.at, alarmId: "ALM-000010", action: "reset" });
    expect(applyOverrides([activeAlarm], s)[0]).toEqual(activeAlarm);
  });

  it("clearAudit empties the audit trail but keeps overrides", () => {
    const acked = reduceStore(emptyStore(), { type: "acknowledge", alarmId: "ALM-000010" }, clock);
    const s = reduceStore(frozen(acked), { type: "clearAudit" }, clock);
    expect(s.audit).toEqual([]);
    expect(s.overrides["ALM-000010"].state).toBe("acknowledged");
  });

  it("caps the audit trail at 500 entries, newest first", () => {
    let s = emptyStore();
    for (let i = 0; i < AUDIT_LIMIT + 5; i++) {
      s = reduceStore(s, { type: "acknowledge", alarmId: `ALM-${String(i).padStart(6, "0")}` }, { at: `2026-10-04T10:${String(i % 60).padStart(2, "0")}:00.${String(i).padStart(3, "0")}Z`, datasetNow: clock.datasetNow });
    }
    expect(AUDIT_LIMIT).toBe(500);
    expect(s.audit).toHaveLength(500);
    expect(s.audit[0].alarmId).toBe("ALM-000504");
    expect(s.audit[499].alarmId).toBe("ALM-000005");
  });

  it("keeps the latest note when a follow-up action has none, and ignores blank notes", () => {
    const a = reduceStore(emptyStore(), { type: "acknowledge", alarmId: "ALM-000010", note: "ticket 4711" }, clock);
    const b = reduceStore(a, { type: "clear", alarmId: "ALM-000010", note: "   " }, clock);
    expect(b.overrides["ALM-000010"].note).toBe("ticket 4711");
    expect(b.audit[0]).not.toHaveProperty("note");
  });
});

describe("act() compatibility wrapper", () => {
  it("still acknowledges and clears with a single clock value", () => {
    const now = "2026-09-23T09:00:00.000Z";
    const a = act(emptyStore(), "ALM-000010", "acknowledge", now, "legacy caller");
    expect(a.overrides["ALM-000010"]).toEqual({ state: "acknowledged", note: "legacy caller" });
    expect(a.audit[0]).toEqual({ at: now, alarmId: "ALM-000010", action: "acknowledge", note: "legacy caller" });
    const c = act(a, "ALM-000010", "clear", now);
    expect(c.overrides["ALM-000010"].state).toBe("cleared");
    expect(c.overrides["ALM-000010"].clearedAt).toBe(now);
    expect(c.audit).toHaveLength(2);
  });
});

describe("persistence and migration", () => {
  it("round-trips through localStorage under the v2 key", () => {
    const s = reduceStore(emptyStore(), { type: "clear", alarmId: "ALM-000010", note: "fixed" }, clock);
    saveStore(s);
    expect(localStorage.getItem(ALARM_STORE_KEY)).not.toBeNull();
    expect(loadStore()).toEqual(s);
  });

  it("migrates a v1 store (no version field) from tkm.alarms.v1 and writes it back as v2", () => {
    const v1 = { overrides: { "ALM-000010": { state: "acknowledged" }, "ALM-000011": { state: "cleared", clearedAt: "2026-10-01T00:00:00.000Z" } }, audit: [{ at: "2026-10-01T00:00:00.000Z", alarmId: "ALM-000011", action: "clear" }] };
    localStorage.setItem(LEGACY_ALARM_STORE_KEY, JSON.stringify(v1));
    const s = loadStore();
    expect(s.version).toBe(2);
    expect(s.overrides).toEqual(v1.overrides);
    expect(s.audit).toEqual(v1.audit);
    expect(JSON.parse(localStorage.getItem(ALARM_STORE_KEY) ?? "null")).toEqual(s);
    expect(localStorage.getItem(LEGACY_ALARM_STORE_KEY)).toBeNull();
  });

  it("returns an empty store on corrupt or malformed JSON", () => {
    localStorage.setItem(ALARM_STORE_KEY, "{not json");
    expect(loadStore()).toEqual({ version: 2, overrides: {}, audit: [] });
    localStorage.setItem(ALARM_STORE_KEY, JSON.stringify([1, 2, 3]));
    expect(loadStore()).toEqual({ version: 2, overrides: {}, audit: [] });
    localStorage.setItem(ALARM_STORE_KEY, JSON.stringify({ version: 2, overrides: { "ALM-000010": { state: "bogus" }, "ALM-000011": { state: "cleared", clearedAt: "2026-09-23T09:00:00.000Z" } }, audit: [{ at: 1 }, { at: "2026-10-01T00:00:00.000Z", alarmId: "ALM-000011", action: "clear" }] }));
    const s = loadStore();
    expect(Object.keys(s.overrides)).toEqual(["ALM-000011"]);
    expect(s.audit).toHaveLength(1);
  });
});

describe("auditToCsv", () => {
  it("emits the at,alarmId,action,note header even for an empty trail and one line per entry", () => {
    expect(auditToCsv([]).split("\r\n")[0]).toBe("at,alarmId,action,note");
    const s = reduceStore(reduceStore(emptyStore(), { type: "acknowledge", alarmId: "ALM-000010", note: 'say "hi", twice' }, clock), { type: "clear", alarmId: "ALM-000010" }, clock);
    const lines = auditToCsv(s.audit).split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("at,alarmId,action,note");
    expect(lines[1]).toBe(`${clock.at},ALM-000010,clear,`);
    expect(lines[2]).toBe(`${clock.at},ALM-000010,acknowledge,"say ""hi"", twice"`);
  });
});

describe("AlarmAction type coverage", () => {
  it("accepts every action variant without throwing", () => {
    const actions: AlarmAction[] = [
      { type: "acknowledge", alarmId: "A" }, { type: "clear", alarmId: "A" }, { type: "reopen", alarmId: "A" },
      { type: "bulk", action: "clear", alarmIds: ["A", "B"] }, { type: "resetAlarm", alarmId: "B" }, { type: "clearAudit" },
    ];
    const s = actions.reduce((acc, a) => reduceStore(acc, a, clock), emptyStore());
    expect(s.overrides).toEqual({ A: { state: "cleared", clearedAt: clock.datasetNow } });
    expect(s.audit).toEqual([]);
  });
});
