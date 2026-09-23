#!/usr/bin/env node
/**
 * Writes the synthetic dataset to data/ as JSON + CSV so it can be used outside the browser
 * (e.g. loaded into SQL / pandas). The app itself regenerates the same data in the browser at load time.
 * Run: npm run gen:data   (uses tsx to import the TypeScript generator)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { generateDataset } from "../src/lib/synthetic.ts";
import { toCsv } from "../src/lib/csv.ts";

const d = generateDataset();
mkdirSync("data", { recursive: true });
writeFileSync("data/sites.json", JSON.stringify(d.sites, null, 2));
writeFileSync("data/cells.json", JSON.stringify(d.cells, null, 2));
writeFileSync("data/alarms.json", JSON.stringify(d.alarms, null, 2));
writeFileSync("data/packet_stats.json", JSON.stringify({ protocolHierarchy: d.packetStats, topConversations: d.conversations, tcpSummary: d.tcpSummary }, null, 2));
writeFileSync("data/kpi_15min.csv", toCsv(d.samples));
writeFileSync("data/alarms.csv", toCsv(d.alarms, ["alarmId", "timestamp", "clearedAt", "siteId", "cellId", "technology", "severity", "probableCause", "state"]));
console.log(`sites ${d.sites.length}, cells ${d.cells.length}, kpi rows ${d.samples.length}, alarms ${d.alarms.length} -> data/`);
