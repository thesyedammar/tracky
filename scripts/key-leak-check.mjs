#!/usr/bin/env node
// Tracky — the key-leak test (Phase 11.3).
//
// The rule the whole design rests on: the Jev key lives ONLY in server/.env and is
// never shipped, never committed, never logged. This script tries to prove that the
// key is absent everywhere else — the working tree, the packaged zip, and every
// commit in git history. It prints the key's length and a fingerprint, never the key.
//
// Run: node scripts/key-leak-check.mjs

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, "server", ".env");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "spikes", "out"]);

const problems = [];
const notes = [];

// ------------------------------------------------------------------ the key
let key = "";
try {
  const env = readFileSync(ENV_PATH, "utf8");
  const line = env.split("\n").find((l) => l.trim().startsWith("JEV_API_KEY="));
  key = line ? line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") : "";
} catch {
  problems.push("server/.env is missing — the helper cannot run at all");
}
if (!key) problems.push("no JEV_API_KEY found in server/.env");
if (key && key.length < 12) problems.push(`the key looks too short (${key.length} chars) to be real`);
if (key) {
  const fp = createHash("sha256").update(key).digest("hex").slice(0, 10);
  notes.push(`key present in server/.env · ${key.length} chars · sha256:${fp}… (value never printed)`);
  const perms = (statSync(ENV_PATH).mode & 0o777).toString(8);
  if (perms !== "600") problems.push(`server/.env permissions are ${perms}, not 600`);
  else notes.push("server/.env permissions 600 ✓");
}
const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
if (!/^\.env$/m.test(gitignore) && !/server\/\.env/.test(gitignore) && !/^\.env\b/m.test(gitignore)) {
  problems.push(".gitignore does not exclude .env");
} else {
  notes.push(".env is gitignored ✓");
}

// ------------------------------------------------- scan the working tree
const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".env") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(abs);
    } else if (statSync(abs).size < 4_000_000) {
      files.push(abs);
    }
  }
};
walk(ROOT);
const textish = (f) => /\.(js|mjs|json|md|html|css|txt|yml|yaml|sh|py)$/.test(f) || f.endsWith(".env");
let scanned = 0;
const leaks = [];
for (const f of files) {
  const rel = relative(ROOT, f);
  if (rel === join("server", ".env")) continue; // the one place it is allowed
  if (!textish(f)) continue;
  scanned++;
  const text = readFileSync(f, "utf8");
  if (key && text.includes(key)) leaks.push(rel);
}
for (const l of leaks) problems.push(`the key appears in ${l}`);
notes.push(`working tree: ${scanned} text files scanned, ${leaks.length} leaks`);

// ------------------------------------------------- scan the packaged zip
const distDir = join(ROOT, "dist");
let zipName = "";
try {
  zipName = readdirSync(distDir).filter((f) => f.endsWith(".zip")).sort().pop() ?? "";
} catch {
  notes.push("no dist/ yet — package the extension first to scan a zip");
}
if (zipName) {
  const buf = readFileSync(join(distDir, zipName));
  const text = buf.toString("latin1");
  const inside = key && (text.includes(key) || inflateAll(buf).includes(key));
  if (inside) problems.push(`the key appears inside dist/${zipName}`);
  notes.push(`package: dist/${zipName} scanned (${(buf.length / 1024).toFixed(1)} KB), ${inside ? "LEAK" : "clean"}`);
}
function inflateAll(buf) {
  // Cheap approach: try to inflate every plausible deflate stream start offset.
  let out = "";
  for (let i = 0; i < buf.length - 2; i++) {
    if (buf[i] === 0x78 && (buf[i + 1] === 0x9c || buf[i + 1] === 0x01 || buf[i + 1] === 0xda)) {
      try {
        out += inflateRawSync(buf.subarray(i + 2, Math.min(i + 2 + 400_000, buf.length))).toString("latin1");
      } catch {
        /* not a stream start — keep looking */
      }
    }
  }
  return out;
}

// ------------------------------------------------- scan every git commit
try {
  const commits = execFileSync("git", ["rev-list", "--all"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  let hits = 0;
  for (const c of commits) {
    try {
      const out = execFileSync("git", ["grep", "-l", "-F", key, c], { cwd: ROOT, encoding: "utf8" });
      if (out.trim()) {
        hits++;
        problems.push(`the key appears in commit ${c.slice(0, 8)}: ${out.trim().split("\n")[0]}`);
      }
    } catch {
      /* git grep exits 1 when there is no match — that is the good case */
    }
  }
  notes.push(`git history: ${commits.length} commits scanned, ${hits} hits`);
} catch {
  notes.push("git history scan skipped (not a git checkout?)");
}

// ---------------------------------------------------------------- report
for (const n of notes) console.log(`  · ${n}`);
if (problems.length) {
  console.error("\n✗ KEY-LEAK CHECK FAILED:");
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}
console.log("\n✓ key-leak check passed — the key exists only in server/.env");
