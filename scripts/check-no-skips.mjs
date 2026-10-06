#!/usr/bin/env node
/**
 * No-skip gate: fails when any test under tests/ or e2e/ is skipped, focused, conditional or left as a todo.
 *
 * Flags `.skip(`, `.only(`, `.todo(`, `.fixme(`, `.skipIf(`, `.runIf(` and the `xit(` / `xdescribe(` / `xtest(`
 * aliases in source files (.ts, .tsx, .js, .jsx, .mjs, .cjs, .mts, .cts). Comment lines are ignored. Every hit is
 * reported as file:line and the exit code is 1; otherwise 0.
 *
 *   npm run check:noskip                                  scan tests/ and e2e/
 *   node scripts/check-no-skips.mjs --dir <path> [...]    scan other directories instead (e.g. a fixture tree)
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ROOTS = ["tests", "e2e"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const MARKER = /\.(?:skip|only|todo|fixme|skipIf|runIf)\s*\(|\bx(?:it|describe|test)\s*\(/;
const USAGE = "usage: check-no-skips.mjs [--dir <path>]...";

function parseDirs(argv) {
  const dirs = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) fail(`--dir needs a path\n${USAGE}`);
      dirs.push(resolve(value));
      i++;
    } else if (arg.startsWith("--dir=")) {
      dirs.push(resolve(arg.slice("--dir=".length)));
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}\n${USAGE}`);
    }
  }
  return dirs;
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== "node_modules") yield* sourceFiles(path);
    } else if (SOURCE_EXTENSIONS.has(extname(entry))) {
      yield path;
    }
  }
}

function isComment(line) {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function main() {
  const custom = parseDirs(process.argv.slice(2));
  const base = custom.length > 0 ? process.cwd() : repoRoot;
  const roots = custom.length > 0 ? custom : DEFAULT_ROOTS.map((r) => join(repoRoot, r));
  const hits = [];
  let scanned = 0;
  const scannedRoots = [];
  for (const dir of roots) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    scannedRoots.push(`${relative(base, dir) || "."}/`);
    for (const file of sourceFiles(dir)) {
      scanned += 1;
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (isComment(line)) return;
        const m = MARKER.exec(line);
        if (m) hits.push(`${relative(base, file)}:${i + 1}: ${m[0].trim()}  ${line.trim()}`);
      });
    }
  }
  if (hits.length > 0) {
    for (const hit of hits) console.error(hit);
    console.error(`check:noskip FAILED — ${hits.length} skipped/focused/todo test marker(s) in ${scanned} files`);
    return 1;
  }
  console.log(`check:noskip OK — no skipped, focused or todo tests in ${scannedRoots.join(", ") || "(no test directories)"} (${scanned} files scanned)`);
  return 0;
}

process.exit(main());
