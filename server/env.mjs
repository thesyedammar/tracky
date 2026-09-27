// Production env loader for the helper. The key lives HERE and nowhere else —
// not in the extension, not in the playground, not in any committed file.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ENV_PATH = join(HERE, ".env");
const REQUIRED = ["JEV_BASE_URL", "JEV_MODEL", "JEV_API_KEY"];

/**
 * Resolve the list of Jev sources (providers) from the environment.
 *
 * `JEV_PROVIDERS` is a comma list of ids; each id inherits the shared
 * JEV_BASE_URL / JEV_MODEL / JEV_API_KEY and may override any of them with
 * `JEV_PROVIDER_<ID>_BASE_URL`, `_MODEL`, `_KEY`, plus `_LABEL` (what the
 * extension's dropdown shows) and `_KIND` (free|paid, for the honest label).
 * The first id is the default. No list configured → one implicit provider, so
 * older .env files keep working unchanged.
 */
/** `zen-paid` → `ZEN_PAID` — one place that turns an id into its env-var stem. */
export const envSuffix = (id) => id.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

const hostOf = (u) => {
  try {
    return new URL(u).origin; // scheme + host + port: an https key must not follow to http
  } catch {
    return null; // unparsable → treat as a different host and demand its own key
  }
};

export function resolveProviders(target = process.env) {
  const ids = [
    ...new Set(
      String(target.JEV_PROVIDERS ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].filter((id, i, all) => all.findIndex((x) => envSuffix(x) === envSuffix(id)) === i); // two ids that share env vars are one source
  if (!ids.length) ids.push("default");
  const sharedHost = hostOf(target.JEV_BASE_URL);
  const providers = ids.map((id) => {
    const P = `JEV_PROVIDER_${envSuffix(id)}_`;
    const model = String(target[P + "MODEL"] || target.JEV_MODEL || "").trim();
    const ownBaseRaw = target[P + "BASE_URL"] ? String(target[P + "BASE_URL"]).trim() : "";
    const ownBase = ownBaseRaw && hostOf(ownBaseRaw) ? ownBaseRaw : ""; // a typo'd URL is no URL at all
    if (ownBaseRaw && !ownBase) return { id, label: id, kind: "paid", model: "", baseUrl: ownBaseRaw, apiKey: "", configured: false };
    const baseUrl = ownBase || String(target.JEV_BASE_URL || "").trim();
    // The shared key belongs to the shared host: a provider may inherit it only while
    // it stays on that same host, so the key can never travel somewhere it doesn't belong.
    const ownKey = target[P + "KEY"] ? String(target[P + "KEY"]).trim() : "";
    const sameHost = !ownBase || (hostOf(ownBase) !== null && hostOf(ownBase) === sharedHost);
    const apiKey = ownKey || (sameHost ? String(target.JEV_API_KEY || "").trim() : "");
    const label = String(target[P + "LABEL"] ?? "").trim() || id; // a blank label falls back to the id
    const rawKind = String(target[P + "KIND"] || "").trim().toLowerCase();
    const kind = rawKind === "free" || rawKind === "paid" ? rawKind : /[-_]free\b/i.test(model) ? "free" : "paid";
    return { id, label, kind, model, baseUrl, apiKey, configured: Boolean(model && baseUrl && apiKey) };
  });
  return { defaultId: providers[0].id, providers };
}

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
  const { defaultId, providers } = resolveProviders(target);
  return {
    baseUrl: String(target.JEV_BASE_URL).trim(),
    model: String(target.JEV_MODEL).trim(),
    apiKey: String(target.JEV_API_KEY).trim(),
    defaultId,
    providers,
  };
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
