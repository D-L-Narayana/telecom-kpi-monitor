#!/usr/bin/env node
/**
 * Writes the synthetic dataset as JSON + CSV so it can be used outside the browser (SQL, pandas, …).
 * The app regenerates exactly the same data in the browser at load time.
 *
 *   npm run gen:data                   -> data/ (the committed copy)
 *   npm run gen:data -- --out <dir>    -> any other directory (scripts/check-data-determinism.mjs uses this
 *                                         to compare a fresh generation with data/)
 *
 * Runs through tsx because it imports the TypeScript generator directly.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateDataset } from "../src/lib/synthetic.ts";
import { toCsv } from "../src/lib/csv.ts";

const USAGE = "usage: generate-synthetic-data.mjs [--out <dir>]";

function outputDir(argv) {
  let out = "data";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) fail(`--out needs a directory\n${USAGE}`);
      out = value;
      i++;
    } else if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
      if (out === "") fail(`--out needs a directory\n${USAGE}`);
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}\n${USAGE}`);
    }
  }
  return out;
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

const out = outputDir(process.argv.slice(2));
const d = generateDataset();
mkdirSync(out, { recursive: true });
const write = (name, text) => writeFileSync(join(out, name), text);
write("sites.json", JSON.stringify(d.sites, null, 2));
write("cells.json", JSON.stringify(d.cells, null, 2));
write("alarms.json", JSON.stringify(d.alarms, null, 2));
write("packet_stats.json", JSON.stringify({ protocolHierarchy: d.packetStats, topConversations: d.conversations, tcpSummary: d.tcpSummary }, null, 2));
write("kpi_15min.csv", toCsv(d.samples));
write("alarms.csv", toCsv(d.alarms, ["alarmId", "timestamp", "clearedAt", "siteId", "cellId", "technology", "severity", "probableCause", "state"]));
console.log(`sites ${d.sites.length}, cells ${d.cells.length}, kpi rows ${d.samples.length}, alarms ${d.alarms.length} -> ${out}/`);
