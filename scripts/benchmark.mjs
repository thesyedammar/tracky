#!/usr/bin/env node
// Tracky — the benchmark room (Phase 11.4).
//
// One command, a fixed suite: real fixture text × real questions × expected
// outcomes, run through the real engine and the real model. Every case is a
// pass/fail, timings are printed, and the run is reproducible (same suite file,
// same model, same prompts).
//
// Run: node scripts/benchmark.mjs [--suite spikes/fixtures/bench.json] [--json]

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { searchText } from "../server/search.mjs";
import { splitSentences } from "../server/sentences.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const asJson = process.argv.includes("--json");
const suiteArg = process.argv.indexOf("--suite");
const SUITE = join(ROOT, suiteArg > -1 ? process.argv[suiteArg + 1] : "spikes/fixtures/bench.json");

const env = Object.fromEntries(
  readFileSync(join(ROOT, "server", ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const config = { baseUrl: env.JEV_BASE_URL, model: env.JEV_MODEL, apiKey: env.JEV_API_KEY };

/** The document: blank-line-separated blocks from a text file, exactly like the extension collects. */
function documentFrom(file) {
  return readFileSync(join(ROOT, file), "utf8")
    .split(/\n\s*\n/)
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter((t) => t.length >= 40)
    .map((text, i) => ({ id: `p${i}`, text }));
}

const suite = JSON.parse(readFileSync(SUITE, "utf8"));
const docs = new Map();
for (const doc of suite.documents) docs.set(doc.name, documentFrom(doc.file));

const rows = [];
for (const c of suite.cases) {
  const passages = docs.get(c.document);
  if (!passages) {
    rows.push({ case: c.name, ok: false, detail: `unknown document "${c.document}"`, ms: 0 });
    continue;
  }
  const started = Date.now();
  let results = [];
  let error = null;
  try {
    ({ results } = await searchText({ query: c.query, passages }, { config }));
  } catch (e) {
    error = e.message;
  }
  const ms = Date.now() - started;
  const joined = results.map((r) => r.sentence.toLowerCase()).join(" | ");
  const missing = (c.expect?.mustInclude ?? []).filter((needle) => !joined.includes(needle.toLowerCase()));
  const banned = (c.expect?.mustNotInclude ?? []).filter((needle) => joined.includes(needle.toLowerCase()));
  const minResults = c.expect?.minResults ?? 1;
  const maxResults = c.expect?.maxResults ?? 12;
  const ok =
    !error && missing.length === 0 && banned.length === 0 && results.length >= minResults && results.length <= maxResults;
  rows.push({
    case: c.name,
    ok,
    detail: error
      ? `error: ${error}`
      : `missing=${JSON.stringify(missing)} banned=${JSON.stringify(banned)} results=${results.length} top=${results[0]?.score ?? "—"}`,
    ms,
    query: c.query,
    top: results[0]?.sentence?.slice(0, 80) ?? "",
  });
}

if (asJson) {
  console.log(JSON.stringify({ suite: suite.name, model: config.model, rows }, null, 2));
} else {
  console.log(`suite: ${suite.name} · model: ${config.model} · ${rows.length} cases\n`);
  for (const r of rows) {
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.case} — ${r.ms} ms`);
    if (!r.ok) console.log(`        ${r.detail}`);
    else if (r.top) console.log(`        top: “${r.top}…”`);
  }
  const times = rows.map((r) => r.ms).sort((a, b) => a - b);
  console.log(
    `\n  timing: min ${times[0]} ms · median ${times[Math.floor(times.length / 2)]} ms · max ${times[times.length - 1]} ms`,
  );
}
const failed = rows.filter((r) => !r.ok);
const allRateLimited = failed.length > 0 && failed.every((r) => /rate-limited|429|quota/i.test(r.detail));
if (allRateLimited) {
  console.log(`\nBLOCKED — all ${failed.length} failure(s) are the model route rate-limiting, not product failures.`);
  process.exit(2);
}
console.log(`\n${failed.length ? "FAILURES PRESENT" : "ALL CASES PASSED"} — ${rows.length - failed.length}/${rows.length}`);
process.exit(failed.length ? 1 : 0);
