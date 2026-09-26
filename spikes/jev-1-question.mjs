// Spike 1.1 — the smallest possible Jev call (string state, one noul question).
// Asserts the obvious truth: this passage DOES mention a fee → score must be high.
// Run: node spikes/jev-1-question.mjs   (0 = pass, 1 = exec error, 2 = assertion failed)
import { main, loadEnv, askJev, mustAnswers, noul } from "./lib/jev.mjs";

await main(async () => {
  loadEnv();

  const state =
    "Passage: Breakfast is included. A service charge of Rs.250 applies to cancellations made less than 24 hours before pickup. The pool is on the roof.";

  const { data, ms } = await askJev({
    model: process.env.JEV_MODEL,
    state,
    questions: {
      mentions_fee: { type: "noul", instructions: "Does this passage mention a fee or charge?" },
    },
  });

  const answers = mustAnswers(data);
  const score = noul(answers.mentions_fee);
  const ok = score !== null && score >= 0.7;
  console.log(`spike 1.1 | ${ms} ms | mentions_fee = ${score?.toFixed(3) ?? "?"} ${ok ? "✓" : "✗ (want ≥ 0.7)"}`);
  console.log(ok ? "PASS" : "FAIL");
  process.exit(ok ? 0 : 2);
});
