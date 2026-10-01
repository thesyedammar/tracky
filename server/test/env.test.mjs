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

test("loadEnv rejects an explicitly empty JEV_MODEL (not just a missing one)", () => {
  writeFileSync(envFile, "JEV_BASE_URL=https://x.test\nJEV_MODEL=\nJEV_API_KEY=k\n");
  assert.throws(() => loadEnv({ envPath: envFile, target: {} }), /Missing JEV_MODEL/);
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

test("loadEnv tolerates an invalid shared base when providers carry their own URLs", () => {
  writeFileSync(
    envFile,
    [
      "JEV_BASE_URL=not a url",
      "JEV_MODEL=shared-model",
      "JEV_API_KEY=shared-key",
      "JEV_PROVIDERS=alpha",
      "JEV_PROVIDER_ALPHA_BASE_URL=https://alpha.test/v1",
      "JEV_PROVIDER_ALPHA_MODEL=alpha-model",
      "JEV_PROVIDER_ALPHA_KEY=alpha-key",
    ].join("\n"),
  );
  const cfg = loadEnv({ envPath: envFile, target: {} });
  const alpha = cfg.providers.find((p) => p.id === "alpha");
  assert.ok(alpha.configured, "a provider with its own valid URLs must stay usable");
  assert.equal(alpha.baseUrl, "https://alpha.test/v1");
});

test("loadEnv marks inheritors unconfigured but still starts on valid providers", () => {
  writeFileSync(
    envFile,
    [
      "JEV_BASE_URL=not a url",
      "JEV_MODEL=shared-model",
      "JEV_API_KEY=shared-key",
      "JEV_PROVIDERS=alpha,beta",
      "JEV_PROVIDER_ALPHA_BASE_URL=https://alpha.test/v1",
      "JEV_PROVIDER_ALPHA_MODEL=alpha-model",
      "JEV_PROVIDER_ALPHA_KEY=alpha-key",
    ].join("\n"),
  );
  const cfg = loadEnv({ envPath: envFile, target: {} });
  assert.ok(cfg.providers.find((p) => p.id === "alpha").configured);
  const beta = cfg.providers.find((p) => p.id === "beta");
  assert.equal(beta.configured, false, "an inheritor of an invalid shared base cannot be used");
  assert.equal(beta.baseUrl, "", "nothing usable may be invented for it");
});
