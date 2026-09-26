// Production env loader for the helper. The key lives HERE and nowhere else —
// not in the extension, not in the playground, not in any committed file.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ENV_PATH = join(HERE, ".env");
const REQUIRED = ["JEV_BASE_URL", "JEV_MODEL", "JEV_API_KEY"];

/**
 * Load server/.env into `target` (defaults to process.env). Real env vars win,
 * so `JEV_MODEL=x npm start` overrides the file. Throws a plain Error with a
 * human-readable message when a required key is missing (or blank) or when
 * JEV_BASE_URL is not a URL — callers turn that into a clear startup failure.
 */
export function loadEnv({ envPath = DEFAULT_ENV_PATH, target = process.env } = {}) {
  if (existsSync(envPath)) {
    for (const [k, v] of Object.entries(parseEnv(readFileSync(envPath, "utf8")))) {
      if (target[k] === undefined) target[k] = v;
    }
  }
  const missing = REQUIRED.filter((k) => typeof target[k] !== "string" || target[k].trim() === "");
  if (missing.length) {
    throw new Error(`Missing ${missing.join(", ")} — put them in ${envPath} (copy .env.example) or export them.`);
  }
  try {
    new URL(target.JEV_BASE_URL);
  } catch {
    throw new Error(`JEV_BASE_URL is not a valid URL: "${String(target.JEV_BASE_URL).slice(0, 60)}"`);
  }
  return { baseUrl: target.JEV_BASE_URL, model: target.JEV_MODEL, apiKey: target.JEV_API_KEY };
}

/**
 * Tolerant .env parser: comments (#), blank lines, optional `export ` prefix,
 * `KEY = value` spacing, single/double quotes, inline comments after unquoted
 * values. Malformed lines are skipped.
 */
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    const q = value[0];
    if (q === '"' || q === "'") {
      const close = value.indexOf(q, 1);
      value = close > 0 ? value.slice(1, close) : value.slice(1); // unterminated: take the rest
    } else {
      value = value.replace(/\s+#.*$/, "").trim(); // strip inline comment
    }
    out[m[1]] = value;
  }
  return out;
}
