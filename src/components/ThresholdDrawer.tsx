import { useId, useState, type ChangeEvent } from "react";
import { useApp } from "../state";
import { Drawer, Notice } from "./ui";
import { downloadText } from "../lib/csv";
import {
  DEFAULT_THRESHOLDS, THRESHOLD_KEYS, THRESHOLD_LABELS, THRESHOLD_PRESETS, thresholdsFromJson, thresholdsToJson, validateThresholds,
  type ThresholdIssue, type Thresholds,
} from "../lib/thresholds";

type Field = "warning" | "critical";
type PresetName = keyof typeof THRESHOLD_PRESETS;

const FIELDS: readonly Field[] = ["warning", "critical"];
const PRESET_NAMES = Object.keys(THRESHOLD_PRESETS) as PresetName[];
const PRESET_LABELS: Record<PresetName, string> = { default: "Default", strict: "Strict", lenient: "Lenient" };
const EXPORT_FILENAME = "kpi-thresholds.json";

const draftKey = (key: keyof Thresholds, field: Field) => `${key}.${field}`;

/** Name of the preset that equals the given thresholds value for value, or null when they were edited. */
function matchingPreset(t: Thresholds): PresetName | null {
  return PRESET_NAMES.find((name) => THRESHOLD_KEYS.every((k) => t[k].warning === THRESHOLD_PRESETS[name][k].warning && t[k].critical === THRESHOLD_PRESETS[name][k].critical)) ?? null;
}

/** Short inline wording for one validation issue of a threshold row. */
function issueText(issue: ThresholdIssue): string {
  if (issue.field === "warning" || issue.field === "critical") return `Enter a number for ${issue.field}.`;
  // ordering: drop the "<label>: " prefix, the row already names the KPI
  return issue.message.replace(/^[^:]*:\s*/, "");
}

/**
 * Right-hand "Thresholds" drawer: a labelled warning / critical input per KPI, presets, JSON import / export and a
 * confirmed reset. Every edit is validated with `validateThresholds`; an input holding an empty, non-numeric or
 * wrongly ordered value is marked invalid with an inline message and the last valid thresholds stay in force
 * (nothing is ever persisted as 0 or NaN).
 */
export function ThresholdDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { thresholds, updateThresholds, resetThresholdsToDefault } = useApp();
  const idBase = useId();
  // Raw text of the inputs being edited, so an invalid or half-typed value is shown as typed while the applied
  // thresholds keep their last valid value.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [importStatus, setImportStatus] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  /** Thresholds as currently typed (drafts over the applied values), with the issues per row. */
  const candidate = (): { value: Record<keyof Thresholds, { warning: unknown; critical: unknown }>; issues: ThresholdIssue[] } => {
    const value = {} as Record<keyof Thresholds, { warning: unknown; critical: unknown }>;
    for (const key of THRESHOLD_KEYS) {
      const read = (field: Field): unknown => {
        const d = drafts[draftKey(key, field)];
        if (d === undefined) return thresholds[key][field];
        return d.trim() === "" ? Number.NaN : Number(d);
      };
      value[key] = { warning: read("warning"), critical: read("critical") };
    }
    return { value, issues: validateThresholds(value).issues };
  };
  const { issues } = candidate();
  const rowIssues = (key: keyof Thresholds) => issues.filter((i) => i.key === key);

  const onInput = (key: keyof Thresholds, field: Field, text: string) => {
    const nextDrafts = { ...drafts, [draftKey(key, field)]: text };
    setDrafts(nextDrafts);
    setImportStatus(null);
    // Apply the row as soon as both of its fields are valid; other rows keep whatever state they have.
    const typed = text.trim() === "" ? Number.NaN : Number(text);
    const other: Field = field === "warning" ? "critical" : "warning";
    const otherDraft = nextDrafts[draftKey(key, other)];
    const otherValue = otherDraft === undefined ? thresholds[key][other] : otherDraft.trim() === "" ? Number.NaN : Number(otherDraft);
    const row = { ...thresholds[key], [field]: typed, [other]: otherValue };
    const result = validateThresholds({ ...thresholds, [key]: row });
    if (result.issues.some((i) => i.key === key)) return;
    updateThresholds({ ...thresholds, [key]: result.value[key] });
  };
  const onBlur = (key: keyof Thresholds, field: Field) => {
    // A valid draft is no longer needed once editing stops: show the applied value in its canonical form.
    if (rowIssues(key).length > 0) return;
    setDrafts((d) => {
      const next = { ...d };
      delete next[draftKey(key, field)];
      return next;
    });
  };
  const replaceAll = (next: Thresholds) => {
    updateThresholds(next);
    setDrafts({});
  };
  const onPreset = (e: ChangeEvent<HTMLSelectElement>) => {
    const name = e.target.value as PresetName | "custom";
    if (name === "custom") return;
    replaceAll(THRESHOLD_PRESETS[name]);
    setImportStatus(null);
  };
  const onExport = () => downloadText(EXPORT_FILENAME, thresholdsToJson(thresholds), "application/json;charset=utf-8");
  const onImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow importing the same file again
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch (err) {
      setImportStatus({ kind: "error", text: `${file.name}: could not be read (${(err as Error).message}).` });
      return;
    }
    const result = thresholdsFromJson(text);
    if (result.ok) {
      replaceAll(result.value);
      setImportStatus({ kind: "success", text: `Imported ${file.name}.` });
    } else {
      setImportStatus({ kind: "error", text: `${file.name} was not imported: ${result.issues.map((i) => i.message).join(" ")}` });
    }
  };
  const onReset = () => {
    if (!window.confirm("Reset all KPI thresholds to the defaults? Your current values will be lost.")) return;
    resetThresholdsToDefault();
    setDrafts({});
    setImportStatus(null);
  };

  const preset = matchingPreset(thresholds);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="KPI thresholds"
      footer={<>
        <label className="btn small file">
          Import JSON
          <input type="file" accept=".json,application/json" onChange={(e) => { void onImport(e); }} />
        </label>
        <button type="button" className="btn small" onClick={onExport}>Export JSON</button>
        <button type="button" className="btn small" onClick={onReset}>Reset to defaults</button>
      </>}
    >
      <p className="muted small-text">
        Breach direction follows the KPI: call drop rate, latency and PRB utilization breach <em>above</em> the threshold; success rates and throughput breach <em>below</em>.
        Valid changes apply immediately and are saved in this browser; an invalid value is flagged and the previous one stays in force.
      </p>
      <div className="toolbar">
        <label className="inline">
          Preset
          <select value={preset ?? "custom"} onChange={onPreset}>
            {PRESET_NAMES.map((name) => <option key={name} value={name}>{PRESET_LABELS[name]}</option>)}
            <option value="custom">Custom (edited)</option>
          </select>
        </label>
      </div>
      {importStatus && <Notice kind={importStatus.kind}>{importStatus.text}</Notice>}
      <table className="table compact">
        <thead><tr><th scope="col">KPI</th><th scope="col">Warning</th><th scope="col">Critical</th></tr></thead>
        <tbody>
          {THRESHOLD_KEYS.map((key) => {
            const problems = rowIssues(key);
            const errorId = `${idBase}-${key}-error`;
            return [
              <tr key={key}>
                <th scope="row">
                  {THRESHOLD_LABELS[key]} <span className="muted small-text">breaches {DEFAULT_THRESHOLDS[key].direction}</span>
                </th>
                {FIELDS.map((field) => {
                  const invalid = problems.some((p) => p.field === field || p.field === "order");
                  return (
                    <td key={field}>
                      <label>
                        <span className="visually-hidden">{THRESHOLD_LABELS[key]} {field}</span>
                        <input
                          type="number"
                          step="0.1"
                          value={drafts[draftKey(key, field)] ?? thresholds[key][field]}
                          aria-invalid={invalid ? "true" : undefined}
                          aria-describedby={problems.length > 0 ? errorId : undefined}
                          onChange={(e) => onInput(key, field, e.target.value)}
                          onBlur={() => onBlur(key, field)}
                        />
                      </label>
                    </td>
                  );
                })}
              </tr>,
              problems.length > 0 ? (
                <tr key={`${key}-error`}>
                  <td colSpan={3}><p className="field-error" id={errorId}>{problems.map(issueText).join(" ")}</p></td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
    </Drawer>
  );
}
