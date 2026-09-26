// Spike 1.1 — the smallest possible Jev call.
// One paragraph (string state) + one typed question -> answer + probability + latency.
// Proves: the key, the route and the request shape all work.
//
// Run from the repo root:
//   node --env-file=server/.env spikes/jev-1-question.mjs

const { JEV_BASE_URL, JEV_MODEL, JEV_API_KEY } = process.env;

const state =
  "Passage: Breakfast is included. A service charge of Rs.250 applies to cancellations made less than 24 hours before pickup. The pool is on the roof.";

const body = {
  model: JEV_MODEL,
  state,
  questions: {
    mentions_fee: {
      type: "noul",
      instructions: "Does this passage mention a fee or charge?",
    },
  },
};

const t0 = performance.now();
const res = await fetch(JEV_BASE_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${JEV_API_KEY}`,
  },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(30000),
});
const ms = Math.round(performance.now() - t0);
const text = await res.text();

console.log(`spike 1.1 | HTTP ${res.status} | ${ms} ms`);
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text.slice(0, 1200));
}
