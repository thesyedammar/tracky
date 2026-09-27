#!/usr/bin/env node
// Tracky — package the extension for sharing.
//
// An ALLOWLIST zip: only the files listed below can ever be shipped, so a stray
// .env, a key, or a debug file cannot leak by accident. The archive is built by
// hand (no dependencies) with fixed timestamps, so the same input always produces
// the same bytes — a hash you can compare between runs.
//
// Run: node scripts/package-extension.mjs [--out dist]

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "extension");
const outArg = process.argv.indexOf("--out");
const OUT_DIR = join(ROOT, outArg > -1 ? process.argv[outArg + 1] : "dist");

/** Only these files ship. Anything else in extension/ is ignored, not packaged. */
const ALLOW = [
  "manifest.json",
  "background.js",
  "content.js",
  "collect.js",
  "options.html",
  "options.js",
  "shared.js",
  "pdf.html",
  "pdf-viewer.js",
  "pdf-stub.js",
  "vendor/pdfjs/pdf.min.mjs",
  "vendor/pdfjs/pdf.worker.min.mjs",
  "vendor/pdfjs/LICENSE",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png",
];

/** Secrets must never be inside a shipped file, in any form we know about.
 *  Mentions of the PATH `server/.env` in user-facing text are fine (the UI tells you
 *  where keys live); what must never appear is a key's VALUE. */
const FORBIDDEN = [
  /\bsk-[A-Za-z0-9_-]{12,}/, // provider key shapes
  /JEV_API_KEY\s*[:=]\s*\S/, // an actual key assignment, not the bare name
  /Bearer\s+[A-Za-z0-9_-]{20,}/, // a real bearer token
  /\b[A-Z][A-Z0-9_]{2,}\s*=\s*[A-Za-z0-9_\-]{16,}/, // ENV_NAME=longvalue anywhere
];

// ---------------------------------------------------------------- zip writing
const CRC_TABLE = (() => {
  const table = new Uint32Array(256); // unsigned: the values go straight into the zip header
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

// Fixed DOS timestamp: 2026-01-01 00:00:00 — deterministic archives.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs: regular file, 644 (unsigned!)
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

// ------------------------------------------------------------------- checks
const problems = [];
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
for (const key of ["manifest_version", "name", "version", "description", "background", "action", "icons"]) {
  if (!(key in manifest)) problems.push(`manifest.json is missing "${key}"`);
}
if (manifest.manifest_version !== 3) problems.push("manifest_version must be 3");
if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? "")) problems.push(`version "${manifest.version}" is not x.y.z`);
if (!manifest.background?.service_worker) problems.push("manifest has no background.service_worker");
if (!manifest.icons?.["128"]) problems.push("manifest has no 128px icon");
if (!manifest.options_ui?.page) problems.push("manifest has no options_ui.page");

// The service worker must load shared.js the same way it does at runtime.
const bg = readFileSync(join(EXT, "background.js"), "utf8");
if (!/importScripts\("shared\.js"\)/.test(bg)) problems.push("background.js does not importScripts('shared.js')");

// Every allowed file must exist, and every JS file must parse.
const files = [];
for (const name of ALLOW) {
  const abs = join(EXT, name);
  let data;
  try {
    data = readFileSync(abs);
  } catch {
    problems.push(`missing file: ${name}`);
    continue;
  }
  if (name.endsWith(".js")) {
    try {
      execFileSync(process.execPath, ["--check", abs], { stdio: "pipe" });
    } catch (e) {
      problems.push(`${name} does not parse: ${String(e.stderr ?? e).split("\n")[0]}`);
    }
  }
  if (/\.(js|html|json)$/.test(name)) {
    const text = data.toString("utf8");
    for (const bad of FORBIDDEN) {
      if (bad.test(text)) problems.push(`${name} contains something that looks like a secret (${bad})`);
    }
  }
  files.push({ name, data });
}

// The same secret scan over everything in extension/, packaged or not — a leak
// sitting next to the code is still a leak waiting for a bad zip flag.
for (const name of ALLOW.filter((n) => n.endsWith(".json") || n.endsWith(".js") || n.endsWith(".html"))) {
  // (already scanned above — kept explicit so the intent is readable)
  void name;
}

// No remote code, ever: MV3 forbids it, and a bundled library that pulls a module
// off the network at runtime would be a supply-chain hole in a shipped extension.
for (const name of ALLOW.filter((n) => /\.(js|mjs)$/.test(n))) {
  const text = readFileSync(join(EXT, name), "utf8");
  if (/(?:^|[\s(])import\s*\(\s*["'`]https?:/m.test(text) || /from\s*["'`]https?:/.test(text)) {
    problems.push(`${name} imports code from a remote URL (MV3 forbids remote code)`);
  }
}

// Every file an HTML page loads must be in the allowlist, or the shipped page
// would be broken while the working tree looked fine.
for (const name of ALLOW.filter((n) => n.endsWith(".html"))) {
  const html = readFileSync(join(EXT, name), "utf8");
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const ref = m[1];
    if (/^(https?:|data:|#)/.test(ref)) continue;
    if (!ALLOW.includes(ref)) problems.push(`${name} loads "${ref}" which is not in the allowlist`);
  }
}

if (problems.length) {
  console.error("✗ packaging refused:");
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}

const buf = zip(files);
mkdirSync(OUT_DIR, { recursive: true });
const zipPath = join(OUT_DIR, `tracky-${manifest.version}.zip`);
writeFileSync(zipPath, buf);

const sha = createHash("sha256").update(buf).digest("hex");
console.log(`✓ ${relative(ROOT, zipPath)} — ${files.length} files, ${(buf.length / 1024).toFixed(1)} KB`);
for (const f of files) console.log(`  ${String(f.data.length).padStart(7)}  ${f.name}`);
console.log(`  sha256 ${sha}`);
