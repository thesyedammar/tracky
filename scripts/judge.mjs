#!/usr/bin/env node
// Tracky judge — "Muse Spark" (Meta, contributor variant) via opencode zen/go.
// Scores an artifact 1-10 on five axes, appends to docs/judge-report.md.
// Exit code: 0 = accept (>8.5) · 2 = needs work · 1 = judge error.
//
// Usage:
//   node scripts/judge.mjs --name "Phase 2 core" --type code \
//        [--spec pathOrText] --files server/sentences.mjs,server/jev.mjs \
//        [--image shot.png] [--no-report]
//
// Env overrides: JUDGE_MODEL, JUDGE_BASE, JUDGE_API_KEY, X_OPENCODE_SESSION

import { readFileSync, appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const opt = (n, d = "") => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const flag = (n) => args.includes(`--${n}`);

const name = opt("name").trim();
const type = opt("type", "code").trim();
const files = opt("files").split(",").map((s) => s.trim()).filter(Boolean);
const specRaw = opt("spec");
const image = opt("image");
const noReport = flag("no-report");
if (!name || !files.length) {
  console.error("usage: node scripts/judge.mjs --name X --files a.mjs,b.mjs [--spec s] [--type code]");
  process.exit(1);
}

let key = process.env.JUDGE_API_KEY || process.env.HERMES_CUSTOM_OPENCODE_AI_API_KEY || "";
if (!key) {
  const envPath = join(ROOT, "server", ".env");
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, "utf8").match(/^JEV_API_KEY=(.+)$/m);
    if (m) key = m[1].trim();
  }
}
if (!key) { console.error("judge: no API key found"); process.exit(1); }

const MODEL = process.env.JUDGE_MODEL || "muse-spark-1.3-contributor";
const BASE = process.env.JUDGE_BASE || "https://opencode.ai/zen/go/v1";
const SESSION = process.env.X_OPENCODE_SESSION || "hermes-go-static-7f3a9c2e";

const spec = specRaw && existsSync(join(ROOT, specRaw)) ? readFileSync(join(ROOT, specRaw), "utf8") : specRaw;

// ---------- gather artifact text ----------
let budget = 60000;
let body = "";
for (const f of files) {
  let t;
  try { t = readFileSync(join(ROOT, f), "utf8"); } catch { t = `[unreadable: ${f}]`; }
  if (t.length > budget) t = t.slice(0, budget) + "\n[...truncated...]";
  budget -= t.length;
  body += `\n===== FILE: ${f} =====\n${t}\n`;
  if (budget <= 0) { body += "\n[...more files omitted...]\n"; break; }
}

const RUBRIC = `Score 1-10 on each axis:
- correctness: does it do exactly what the spec says; would it behave right on edge cases?
- craft: code/design quality, clarity, naming, structure, no dead weight; would a senior dev respect it?
- robustness: failure handling, validation, hostile inputs, what happens when things go wrong?
- performance: is it fast and economical; any wasted work, needless calls, repeated passes?
- polish: finish level — comments where they matter, docs, consistency, user-facing finish.

Bands: below 8 = needs improvement; 8.0-8.5 = good but not yet a pass; above 8.5 = accept (the bar).
Be a strict, independent judge — find real flaws; do not be nice.`;

const prompt = `You are "Muse Spark", the independent judge for the "Tracky" project (a Ctrl+F-that-finds-by-meaning browser extension + local helper + playground). Artifacts are scored so improvements can be looped until every one is above 8.5.
Artifact under judgment: "${name}" (type: ${type}).
${spec ? `Spec it must satisfy:\n${spec}\n` : ""}${body}

${RUBRIC}
Respond with ONLY a JSON object (no markdown fences, no text around it):
{"scores":{"correctness":<1-10>,"craft":<1-10>,"robustness":<1-10>,"performance":<1-10>,"polish":<1-10>},"overall":<1-10 one decimal>,"strengths":["<up to 3>"],"top_fixes":["<up to 5, most important first>"]}`;

// ---------- call Muse ----------
async function askMuse(userContent) {
  const res = await fetch(`${BASE}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      "x-opencode-session": SESSION,
    },
    body: JSON.stringify({ model: MODEL, input: userContent, max_output_tokens: 16000 }),
    signal: AbortSignal.timeout(180000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`judge HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  const texts = [];
  for (const item of data.output ?? []) for (const c of item.content ?? []) if (c.type === "output_text") texts.push(c.text);
  const text = texts.join("\n").trim();
  if (!text) throw new Error(`judge returned no text (status ${data.status})`);
  return { text, usage: data.usage };
}

function extractJson(text) {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s < 0 || e < 0) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

const content = image
  ? [{ role: "user", content: [
      { type: "input_text", text: prompt },
      { type: "input_image", image_url: `data:image/png;base64,${readFileSync(join(ROOT, image)).toString("base64")}` },
    ] }]
  : prompt;

let verdict;
try {
  const { text, usage } = await askMuse(content);
  verdict = extractJson(text);
  if (!verdict) {
    const retry = await askMuse(`${prompt}\n\nYour previous reply was not valid JSON. Reply with ONLY the JSON object.`);
    verdict = extractJson(retry.text);
    if (!verdict) {
      console.error("judge: could not parse JSON. Raw reply:\n", text.slice(0, 800));
      process.exit(1);
    }
  }
  verdict._usage = usage;
} catch (e) {
  console.error("judge error:", e.message);
  process.exit(1);
}

// ---------- normalize + bands ----------
const overall = Number(verdict.overall);
const scores = verdict.scores ?? {};
const band = overall > 8.5 ? "accept" : overall >= 8 ? "good" : "needs_improvement";
const icon = band === "accept" ? "🟢" : band === "good" ? "🟡" : "🔴";
const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const stamp = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });

console.log(`${icon} ${name} — ${overall}/10 (${band})`);
console.log(`   scores: ${Object.entries(scores).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
if (verdict.strengths?.length) console.log(`   strengths: ${verdict.strengths.join(" | ")}`);
if (verdict.top_fixes?.length) console.log(`   top fixes: ${verdict.top_fixes.join(" | ")}`);

// ---------- keep raw + append report ----------
try {
  mkdirSync(join(ROOT, ".judge"), { recursive: true });
  writeFileSync(join(ROOT, ".judge", `${slug}.json`), JSON.stringify({ name, type, files, when: stamp, ...verdict }, null, 2));
} catch {}

if (!noReport) {
  const fixList = (verdict.top_fixes ?? []).map((f) => `  - ${f}`).join("\n");
  const scoreLine = Object.entries(scores).map(([k, v]) => `${k} **${v}**`).join(" · ");
  appendFileSync(
    join(ROOT, "docs", "judge-report.md"),
    `\n### ${name} — ${overall}/10 ${icon}\n- ${stamp} IST · model \`${MODEL}\` · type ${type} · files: ${files.join(", ")}\n- ${scoreLine}\n${fixList ? `- top fixes:\n${fixList}` : "- no fixes requested 🎉"}\n`,
  );
}

process.exit(band === "accept" ? 0 : 2);
