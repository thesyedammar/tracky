#!/usr/bin/env node
// Tracky — one-command setup (Phase 12.4).
//
// Asks the one question that matters (your Jev key), writes server/.env with
// 600 permissions, then proves the whole path with a live health check and one
// real search. Nothing is echoed, nothing is stored anywhere else.
//
// Run: node scripts/setup.mjs

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, "server", ".env");
const DEFAULT_BASE = "https://opencode.ai/zen/v1/system1";
const DEFAULT_MODEL = "jev-1.13-free";

const ask = (question) =>
  new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

/** Read a secret without echoing it (POSIX stty; falls back to a visible prompt). */
async function askSecret(question) {
  if (process.platform === "win32" || !process.stdin.isTTY) return ask(question);
  process.stdout.write(question);
  try {
    execFileSync("stty", ["-echo"], { stdio: ["inherit", "inherit", "inherit"] });
  } catch {
    return ask("");
  }
  const answer = await new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.once("line", (line) => {
      rl.close();
      resolve(line.trim());
    });
  });
  try {
    execFileSync("stty", ["echo"], { stdio: ["inherit", "inherit", "inherit"] });
  } catch {
    /* the terminal will come back on its own */
  }
  process.stdout.write("\n");
  return answer;
}

console.log("Tracky setup — three things: your key, then proof that it works.\n");

let existing = "";
if (existsSync(ENV_PATH)) existing = readFileSync(ENV_PATH, "utf8");
const haveKey = /^JEV_API_KEY=\S+/m.test(existing);
if (haveKey) {
  const keep = await ask("server/.env already has a key. Keep it? [Y/n] ");
  if (!/^n/i.test(keep)) {
    console.log("Keeping the existing key.\n");
    process.exit(0);
  }
}

const key = await askSecret("Paste your Jev API key (it will not be shown): ");
if (!key) {
  console.error("No key entered — nothing written.");
  process.exit(1);
}
if (key.length < 12) {
  console.error(`That looks too short (${key.length} characters) to be a real key — nothing written.`);
  process.exit(1);
}

const base = (await ask(`Model base URL [${DEFAULT_BASE}]: `)) || DEFAULT_BASE;
const model = (await ask(`Model name [${DEFAULT_MODEL}]: `)) || DEFAULT_MODEL;

writeFileSync(ENV_PATH, `JEV_BASE_URL=${base}\nJEV_MODEL=${model}\nJEV_API_KEY=${key}\n`);
chmodSync(ENV_PATH, 0o600);
console.log(`\n✓ wrote server/.env (permissions 600). The key is now in exactly one place.`);

// ---- proof: health, then one real search -------------------------------------
console.log("\nStarting the helper for a live check…");
const { spawn } = await import("node:child_process");
const helper = spawn(process.execPath, [join(ROOT, "server", "server.mjs")], { stdio: "ignore", detached: true });
helper.unref();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let health = null;
for (let i = 0; i < 40; i++) {
  try {
    const res = await fetch("http://127.0.0.1:4199/api/health", { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      health = await res.json();
      break;
    }
  } catch {
    /* not up yet */
  }
  await wait(250);
}
if (!health) {
  console.error("✗ the helper did not answer on 127.0.0.1:4199 — start it yourself with: node server/server.mjs");
  process.exit(1);
}
console.log(`✓ helper ${health.version} · ${health.model} · caps ${JSON.stringify(health.caps)}`);

const passages = [
  { id: "p0", text: "A cancellation made less than 24 hours before pickup is charged Rs.250. Later cancellations are free." },
  { id: "p1", text: "Standard insurance covers collision damage with a deductible of Rs.15,000." },
];
console.log("\nRunning one real search (2 passages)…");
const t0 = Date.now();
const res = await fetch("http://127.0.0.1:4199/api/search", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query: "how much is the late cancellation fee?", passages }),
  signal: AbortSignal.timeout(45000),
});
const ms = Date.now() - t0;
const body = await res.json();
if (!res.ok) {
  console.error(`✗ the search failed: ${body.message ?? res.status}`);
  console.error("  (a rate-limited free route is the usual cause — try again later.)");
  process.exit(1);
}
const top = body.results?.[0];
console.log(`✓ search answered in ${ms} ms — ${body.results?.length ?? 0} match(es)`);
if (top) {
  const exact = passages.some((p) => p.text.includes(top.sentence));
  console.log(`  top: “${top.sentence}” (${top.score})`);
  console.log(`  exact slice of the page? ${exact ? "yes ✓" : "NO — this would be a bug"}`);
  if (!exact) process.exit(1);
}
console.log("\nDone. Load extension/ in chrome://extensions (Developer mode → Load unpacked) and press Alt+K on any page.");
