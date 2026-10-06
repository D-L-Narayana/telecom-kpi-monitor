import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "../src/lib/csv";
import { generateDataset } from "../src/lib/synthetic";

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const BOM = String.fromCharCode(0xfeff);
// vitest runs from the repository root; jsdom rewrites import.meta.url, so resolve data files from the cwd.
const dataFile = (name: string) => readFileSync(resolve(process.cwd(), "data", name));

describe("CSV export", () => {
  it("quotes CSV fields", () => {
    expect(toCsv([{ a: 'x,"y"', b: 1 }])).toBe('a,b\r\n"x,""y""",1');
  });

  it("returns an empty string for no rows", () => {
    expect(toCsv([])).toBe("");
  });

  it("uses the union of keys (first-seen order) when no columns are given", () => {
    const rows = [{ protocol: "GTP-U", packets: 1 }, { protocol: "TCP", parent: "GTP-U", packets: 2, retransmissions: 3 }];
    expect(toCsv(rows)).toBe("protocol,packets,parent,retransmissions\r\nGTP-U,1,,\r\nTCP,2,GTP-U,3");
  });

  it("explicit columns override the union and keep their order", () => {
    expect(toCsv([{ a: 1, b: 2 }, { c: 3 }], ["b", "c"])).toBe("b,c\r\n2,\r\n,3");
  });

  it("guards spreadsheet formula cells but leaves numeric strings and numbers alone", () => {
    expect(toCsv([{ v: "=1+1" }])).toBe("v\r\n'=1+1");
    expect(toCsv([{ v: "+cmd" }])).toBe("v\r\n'+cmd");
    expect(toCsv([{ v: "@SUM(A1)" }])).toBe("v\r\n'@SUM(A1)");
    expect(toCsv([{ v: "-abc" }])).toBe("v\r\n'-abc");
    expect(toCsv([{ v: "\tx" }])).toBe("v\r\n'\tx");
    expect(toCsv([{ v: "=HYPERLINK(\"x\")" }])).toBe('v\r\n"\'=HYPERLINK(""x"")"');
    expect(toCsv([{ v: "-92.14" }])).toBe("v\r\n-92.14");
    expect(toCsv([{ v: "-12" }])).toBe("v\r\n-12");
    expect(toCsv([{ v: -5 }])).toBe("v\r\n-5");
    expect(toCsv([{ v: -0.5 }])).toBe("v\r\n-0.5");
  });

  it("can switch the formula guard off", () => {
    expect(toCsv([{ v: "=1+1" }], undefined, { guardFormulas: false })).toBe("v\r\n=1+1");
  });

  it("prepends a UTF-8 BOM on request", () => {
    expect(toCsv([{ a: 1 }], undefined, { bom: true })).toBe(`${BOM}a\r\n1`);
    expect(toCsv([{ a: 1 }], ["a"], { bom: false })).toBe("a\r\n1");
  });

  it("keeps the generated dataset exports byte-identical to the committed data files", () => {
    const d = generateDataset();
    expect(sha256(toCsv(d.samples as unknown as Record<string, unknown>[]))).toBe(sha256(dataFile("kpi_15min.csv")));
    expect(
      sha256(toCsv(d.alarms as unknown as Record<string, unknown>[], ["alarmId", "timestamp", "clearedAt", "siteId", "cellId", "technology", "severity", "probableCause", "state"])),
    ).toBe(sha256(dataFile("alarms.csv")));
  });
});

describe("CSV parsing (RFC 4180)", () => {
  it("parses CRLF rows and strips a UTF-8 BOM", () => {
    const r = parseCsv(`${BOM}a,b,c\r\n1,2,3\r\n4,5,6\r\n`);
    expect(r.header).toEqual(["a", "b", "c"]);
    expect(r.rows).toEqual([["1", "2", "3"], ["4", "5", "6"]]);
    expect(r.issues).toEqual([]);
  });

  it("handles quoted fields with escaped quotes, commas and embedded newlines", () => {
    const r = parseCsv('id,info\n1,"multi\r\nline, with ""quotes"""\n2,plain\n');
    expect(r.rows).toEqual([["1", 'multi\r\nline, with "quotes"'], ["2", "plain"]]);
    expect(r.issues).toEqual([]);
  });

  it("accepts LF and lone CR line endings and an empty trailing line", () => {
    expect(parseCsv("a,b\n1,2\n\n3,4").rows).toEqual([["1", "2"], ["3", "4"]]);
    expect(parseCsv("a,b\r1,2\r3,4\r").rows).toEqual([["1", "2"], ["3", "4"]]);
  });

  it("reports ragged rows with their line number and pads or truncates them", () => {
    const r = parseCsv("a,b,c\n1,2\n3,4,5,6\n7,8,9");
    expect(r.rows).toEqual([["1", "2", ""], ["3", "4", "5"], ["7", "8", "9"]]);
    expect(r.issues).toHaveLength(2);
    expect(r.issues[0]).toMatch(/line 2\b.*expected 3 fields.*found 2/i);
    expect(r.issues[1]).toMatch(/line 3\b.*expected 3 fields.*found 4/i);
  });

  it("reports an unterminated quoted field instead of throwing", () => {
    const r = parseCsv('a,b\n1,"open\n2,3');
    expect(r.rows).toHaveLength(1);
    expect(r.issues.some((m) => /unterminated/i.test(m))).toBe(true);
  });

  it("trims header whitespace and keeps empty fields", () => {
    const r = parseCsv(" a , b \n,\n");
    expect(r.header).toEqual(["a", "b"]);
    expect(r.rows).toEqual([["", ""]]);
  });

  it("stops at an optional row limit and flags the truncation", () => {
    const r = parseCsv("a\n1\n2\n3\n4", { maxRows: 2 });
    expect(r.rows).toEqual([["1"], ["2"]]);
    expect(r.truncated).toBe(true);
    expect(r.issues.some((m) => /limit/i.test(m))).toBe(true);
    expect(parseCsv("a\n1\n2", { maxRows: 2 }).truncated).toBe(false);
  });

  it("round-trips through toCsv", () => {
    const rows = [{ a: 'x,"y"', b: "line1\nline2", c: "" }, { a: "plain", b: "", c: "z" }];
    const r = parseCsv(toCsv(rows));
    expect(r.header).toEqual(["a", "b", "c"]);
    expect(r.rows).toEqual([['x,"y"', "line1\nline2", ""], ["plain", "", "z"]]);
  });
});
