#!/usr/bin/env node
// 3.7 — huge-page sweep proof: 1,000 blocks through the real engine, with gold
// blocks at the very start, the middle and the last block (chunk boundaries).
// Nothing may be missed: every block must receive an answer (the engine's
// adjudication would throw otherwise) and each gold block must surface.
import { loadEnv } from "../server/env.mjs";
import { searchText } from "../server/search.mjs";
import { BATCH_MAX } from "../server/jev.mjs";

const BLOCKS = 1000;
const CHUNKS = Math.ceil(BLOCKS / BATCH_MAX);
const LAST_PASS = BLOCKS - BATCH_MAX * (CHUNKS - 1);
const GOLD = [
  "A service charge of Rs.250 applies to cancellations made less than 24 hours before pickup.",
  "Fuel and toll estimates are added at checkout. They are not part of the advertised daily rate.",
  "Cleaning charges of Rs.1,200 apply if the vehicle is returned with excessive dirt.",
  "A young-driver surcharge of Rs.500 per day applies to all renters under the age of 25.",
  "Refuelling is charged at the posted pump rate plus a convenience fee of Rs.150.",
  "Damage exceeding the security deposit is billed separately at prevailing workshop rates.",
];
// Hard edges sit every BATCH_MAX blocks; gold straddles the first and last edges
// plus the very start and end — a boundary miss would show.
const EDGE_A = BATCH_MAX - 1; // last block of pass 1
const EDGE_A2 = BATCH_MAX; // first block of pass 2
const EDGE_B = BATCH_MAX * (CHUNKS - 1) - 1; // last block of the second-last pass
const EDGE_B2 = BATCH_MAX * (CHUNKS - 1); // first block of the last pass
const goldAt = { 0: 0, [EDGE_A]: 1, [EDGE_A2]: 2, [EDGE_B]: 3, [EDGE_B2]: 4, [BLOCKS - 1]: 5 };

const passages = Array.from({ length: BLOCKS }, (_, i) => {
  const g = goldAt[i];
  if (g !== undefined) return { id: `p${i}`, text: `${GOLD[g]} Section ${i} of the schedule continues below.` };
  return { id: `p${i}`, text: `Section ${i}. This clause describes routine administrative matters with no costs stated. Nothing here mentions money at all.` };
});

const config = loadEnv();
const seen = [];
const { results, stats } = await searchText(
  { query: "hidden charges", passages },
  { config, onProgress: (p) => seen.push(p) },
);

const ids = new Set(results.map((r) => r.passageId));
const sizes = seen.map((p, i) => p.done - (i ? seen[i - 1].done : 0));
const last = seen.at(-1);
const checks = [
  ["all 1000 blocks answered", last?.done === BLOCKS && last?.total === BLOCKS],
  [`${CHUNKS} passes of ${BATCH_MAX}/${LAST_PASS} exactly`, stats.chunks === CHUNKS && sizes.length === CHUNKS && sizes.slice(0, -1).every((s) => s === BATCH_MAX) && sizes.at(-1) === LAST_PASS],
  ["gold on the very start (p0)", ids.has("p0")],
  [`gold just before the first chunk edge (p${EDGE_A})`, ids.has(`p${EDGE_A}`)],
  [`gold just after it (p${EDGE_A2})`, ids.has(`p${EDGE_A2}`)],
  [`gold just before an interior edge (p${EDGE_B})`, ids.has(`p${EDGE_B}`)],
  [`gold just after it (p${EDGE_B2})`, ids.has(`p${EDGE_B2}`)],
  [`gold on the very end (p${BLOCKS - 1})`, ids.has(`p${BLOCKS - 1}`)],
  ["results capped at 8", results.length <= 8],
];

for (const [name, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${name}`);
console.log(`\n${stats.passages} passages · ${stats.chunks} passes · ${stats.ms} ms · tokens in/out ${stats.usage.input_tokens}/${stats.usage.output_tokens}`);
for (const [i, r] of results.entries()) console.log(`${i + 1}. [${r.score.toFixed(2)}] ${r.sentence}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
