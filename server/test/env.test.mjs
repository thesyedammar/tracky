// Env loader specs — fail fast, tolerate real-world files, never leak silently.
import test from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadEnv, parseEnv } from "../env.mjs";

test("parseEnv handles comments, blanks, export prefix and spacing", () => {
  const out = parseEnv(["# comment", "", "A=1", "export B2 = two", "C='three'", 'D="four"', "MALFORMED LINE"].join("\n"));
  assert.deepEqual(out, { A: "1", B2: "two", C: "three", D: "four" });
});

test("parseEnv strips inline comments after unquoted values", () => {
  const out = parseEnv("KEY=value # trailing note\nURL=https://x.test/path#frag");
  assert.equal(out.KEY, "value");
  assert.equal(out.URL, "https://x.test/path#frag"); // no whitespace before # → not a comment
});

test("parseEnv keeps quoted values with trailing comments", () => {
  const out = parseEnv('K="a b" # note');
  assert.equal(out.K, "a b");
});

const dir = mkdtempSync(join(fileURLToPath(new URL(".", import.meta.url)), ".tmp-"));
const envFile = join(dir, ".env");
after(() => rmSync(dir, { recursive: true, force: true }));

test("loadEnv throws a clear error when keys are missing", () => {
  writeFileSync(envFile, "JEV_MODEL=jev-x\n");
  assert.throws(() => loadEnv({ envPath: envFile, target: {} }), /Missing JEV_BASE_URL, JEV_API_KEY/);
});

test("loadEnv treats blank/whitespace values as missing", () => {
  writeFileSync(envFile, 'JEV_BASE_URL=https://x.test\nJEV_MODEL=   \nJEV_API_KEY="  "\n');
  assert.throws(() => loadEnv({ envPath: envFile, target: {} }), /Missing JEV_MODEL, JEV_API_KEY/);
});

test("real env vars win over the file", () => {
  writeFileSync(envFile, "JEV_BASE_URL=https://from-file.test\nJEV_MODEL=file-model\nJEV_API_KEY=file-key\n");
  const target = { JEV_MODEL: "real-model" };
  const cfg = loadEnv({ envPath: envFile, target });
  assert.equal(cfg.model, "real-model");
  assert.equal(cfg.baseUrl, "https://from-file.test");
  assert.equal(cfg.apiKey, "file-key");
});

test("loadEnv rejects a non-URL base", () => {
  writeFileSync(envFile, "JEV_BASE_URL=not a url\nJEV_MODEL=m\nJEV_API_KEY=k\n");
  assert.throws(() => loadEnv({ envPath: envFile, target: {} }), /not a valid URL/);
});
