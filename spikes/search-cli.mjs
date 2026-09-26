#!/usr/bin/env node
// search-cli — file + query → ranked [score] sentence, with offsets and timing.
// The whole meaning-search runs through the production engine; this script is
// only a thin shell over server/search.mjs.
//
// Usage: node spikes/search-cli.mjs --file spikes/fixtures/tos.txt --query "hidden charges" [--json]
import { readFileSync } from "node:fs";
import { loadEnv } from "../server/env.mjs";
import { searchText } from "../server/search.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};

const file = opt("file");
const query = opt("query");
if (!file || !query) {
  console.error('usage: node spikes/search-cli.mjs --file <path> --query "..." [--json]');
  process.exit(2);
}

let passages;
try {
  const text = readFileSync(file, "utf8");
  passages = text
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s, i) => ({ id: `p${i}`, text: s }));
} catch (e) {
  console.error(`search-cli: cannot read ${file} — ${e.message}`);
  process.exit(1);
}
if (!passages.length) {
  console.error(`search-cli: ${file} has no readable paragraphs`);
  process.exit(1);
}

try {
  const config = loadEnv();
  const { results, stats } = await searchText(
    { query, passages },
    { config, onProgress: (p) => process.stderr.write(`  … pass ${p.chunk}/${p.chunks} (${p.done}/${p.total} passages)\n`) },
  );
  if (flag("json")) {
    console.log(JSON.stringify({ query, file, stats, results }, null, 2));
  } else {
    console.log(`\nQuery: ${query}\nFile:  ${file} — ${stats.passages} passages in ${stats.chunks} pass${stats.chunks > 1 ? "es" : ""}\n`);
    if (!results.length) console.log("No meaning-match on this page.");
    for (const [i, r] of results.entries()) {
      console.log(`${String(i + 1).padStart(2)}. [${r.score.toFixed(2)}] ${r.sentence}`);
      console.log(`    ↳ ${r.passageId} @${r.offset}`);
    }
    console.log(`\n${stats.ms} ms · tokens in/out ${stats.usage.input_tokens}/${stats.usage.output_tokens}`);
  }
} catch (e) {
  console.error(`search-cli: ${e.message}`);
  process.exit(1);
}
