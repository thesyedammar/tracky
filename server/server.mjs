// The Tracky helper — a loopback-only Node server that holds the Jev key and
// answers one question: "which sentences in this page mean what I searched?"
//
// Contract: docs/contract.md (v1, frozen; additive extensions in its appendix).
// Extra endpoints: GET /api/health, POST /api/preview (dry-run — no Jev call),
// SSE progress on POST /api/search?stream=1 (or Accept: text/event-stream).
// Privacy: binds loopback only; page text is NEVER logged (counts only);
// the key never appears in any response, log line, or error message.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { loadEnv, envSuffix } from "./env.mjs";
import { searchText } from "./search.mjs";
import { whyFor, validateWhyInput } from "./why.mjs";
import { validateSearchInput, SearchError, LIMITS } from "./validate.mjs";
import { preparePassages, buildRequest, BATCH_MAX } from "./jev.mjs";
import { redactText } from "./redact.mjs";

export const BODY_CAP = 512 * 1024; // 512 KB — the contract cap
export const NAME = "tracky-helper";
export const VERSION = "0.4.0";

const loopback = (host) =>
  host === "127.0.0.1" || host === "::1" || host === "localhost" || host === "::ffff:127.0.0.1";

const parseOrigins = (raw) =>
  (raw ?? "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** chrome-extension://* plus configured dev origins; requests without an Origin (curl, same-machine tools) pass. */
const originAllowed = (origin, allowed) =>
  !origin || origin.startsWith("chrome-extension://") || allowed.includes(origin);

const sendJson = (res, status, body) => {
  if (res.destroyed || res.writableEnded) return; // raced disconnect — nothing to write to
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
};

const sendError = (res, err, log) => {
  const status = err instanceof SearchError ? err.status : 500;
  const message = err instanceof SearchError ? err.message : "Something went wrong inside the helper.";
  if (!(err instanceof SearchError)) log?.(`!! unexpected error: ${err?.name ?? "Error"}${err?.code ? ` (${err.code})` : ""}`);
  log?.(`→ ${status} · ${message}`);
  sendJson(res, status, { message });
};

function readBody(req, res, cap, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    const tooLarge = new SearchError(`Body too large — ${cap / 1024} KB cap.`, 413);
    const disconnected = new SearchError("Client disconnected before the body arrived.", 499);
    const stopReading = () => {
      req.removeAllListeners("data");
      req.removeAllListeners("end");
      req.removeAllListeners("error");
      req.on("error", () => {
        /* socket torn down after the rejection — nothing left to report */
      });
      req.pause();
    };
    const dropAfterFlush = () => {
      if (res.destroyed || res.writableEnded) req.destroy();
      else {
        res.once("finish", () => req.destroy());
        res.once("close", () => req.destroy()); // client may vanish before the response flushes
      }
    };
    // Send the rejection first, then drop the connection instead of draining a body we will never read.
    const reject413 = () => {
      done(reject, tooLarge);
      dropAfterFlush();
      stopReading();
    };
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > cap) return reject413();
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > cap) {
        reject413();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => done(resolve, Buffer.concat(chunks).toString("utf8")));
    req.on("error", (e) => done(reject, e?.code === "ECONNRESET" || e?.message === "aborted" ? disconnected : e));
    req.on("close", () => done(reject, disconnected)); // vanished mid-body: settle now, never hang
    // Slowloris guard: a trickling client must not hold the handler open forever.
    timer = setTimeout(() => {
      done(reject, new SearchError("Request body timed out.", 408));
      dropAfterFlush();
      stopReading();
    }, timeoutMs);
    timer.unref?.();
  });
}

/**
 * The Jev source a request asked for, or the helper's default. Unknown ids and
 * key-less sources fail loudly with a message that says exactly what to fix —
 * a dropdown typo must never turn into a silent wrong-route search.
 */
function pickProvider(config, wanted) {
  const providers = config.providers ?? [];
  const asked = wanted == null ? "" : String(wanted).trim().toLowerCase();
  if (!asked) {
    const d = providers.find((p) => p.id === config.defaultId);
    if (d && !d.configured) {
      // The default source lost its key (or its address): say which, instead of sending an empty key upstream.
      if (d.badUrl) {
        throw new SearchError(
          `The default source "${d.id}" has a broken address — check JEV_PROVIDER_${envSuffix(d.id)}_BASE_URL in server/.env (it needs a full http(s):// URL).`,
          503,
        );
      }
      if (!d.model) {
        throw new SearchError(`The default source "${d.id}" has no model — add JEV_MODEL to server/.env.`, 503);
      }
      if (!d.baseUrl) {
        throw new SearchError("The shared JEV_BASE_URL in server/.env looks broken — it needs a full http(s):// URL.", 503);
      }
      const envName = d.id === "default" ? "JEV_API_KEY (and JEV_MODEL / JEV_BASE_URL)" : `JEV_PROVIDER_${envSuffix(d.id)}_KEY`;
      throw new SearchError(
        `The default source "${d.id}" has no key right now — add ${envName} to server/.env, or pick another source.`,
        503,
      );
    }
    return d
      ? { id: d.id, baseUrl: d.baseUrl, model: d.model, apiKey: d.apiKey }
      : { id: "default", baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey };
  }
  const id = asked;
  const p = providers.find((x) => x.id === id);
  if (!p) {
    const names = providers.map((x) => x.id).join(", ") || "default";
    throw new SearchError(`Unknown source "${String(wanted).slice(0, 40)}" — this helper offers: ${names}.`, 400);
  }
  if (!p.configured) {
    if (p.badUrl) {
      throw new SearchError(
        `The source "${id}" has a broken address — check JEV_PROVIDER_${envSuffix(id)}_BASE_URL in server/.env (it needs a full http(s):// URL).`,
        503,
      );
    }
    const envName = `JEV_PROVIDER_${envSuffix(id)}_KEY`;
    throw new SearchError(`The source "${id}" has no key yet — add ${envName} to server/.env and restart the helper.`, 503);
  }
  return { id: p.id, baseUrl: p.baseUrl, model: p.model, apiKey: p.apiKey };
}

/**
 * Build the helper server. `config` is the Jev config from loadEnv(); `fetchImpl`
 * is injectable so tests drive the whole pipeline with a fake Jev.
 */
export function createHelperServer({
  config,
  fetchImpl,
  allowedOrigins = parseOrigins(process.env.TRACKY_ALLOWED_ORIGINS),
  log = console.log,
  readTimeoutMs = 30_000,
} = {}) {
  if (!config?.baseUrl || !config?.model || !config?.apiKey) {
    throw new Error("createHelperServer needs a Jev config (baseUrl, model, apiKey).");
  }

  const server = createServer(async (req, res) => {
    const started = Date.now();
    const origin = req.headers.origin;
    let url;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch {
      return sendJson(res, 400, { message: "Bad URL." });
    }
    const path = url.pathname;

    // Origin gate: a random website must not be able to drive the helper while it runs.
    if (origin && !originAllowed(origin, allowedOrigins)) return sendJson(res, 403, { message: "Origin not allowed." });
    if (origin) res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, accept",
        "access-control-max-age": "600",
      });
      return res.end();
    }

    try {
      if (path === "/api/health" && req.method === "GET") {
        return sendJson(res, 200, {
          ok: true,
          name: NAME,
          version: VERSION,
          model: config.model,
          defaultSource: config.defaultId ?? "default",
          caps: { bodyKB: BODY_CAP / 1024, passages: LIMITS.passagesMax, batch: BATCH_MAX },
        });
      }

      // The dropdown's source list: labels and models only — never a key.
      if (path === "/api/providers" && req.method === "GET") {
        return sendJson(res, 200, {
          default: config.defaultId ?? "default",
          providers: (config.providers ?? []).map(({ id, label, kind, model, configured, badUrl }) => ({
            id,
            label,
            kind,
            model,
            configured,
            badUrl: Boolean(badUrl),
          })),
        });
      }

      if ((path === "/api/search" || path === "/api/preview") && req.method === "POST") {
        const wantsStream =
          path === "/api/search" &&
          (url.searchParams.get("stream") === "1" || (req.headers.accept ?? "").includes("text/event-stream"));
        // For a stream request, open the SSE channel first so even early failures arrive as events.
        if (wantsStream) {
          res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
          try {
            res.write("event: open\ndata: {}\n\n");
          } catch {
            /* client gone before the channel opened */
          }
          if (res.destroyed) return; // channel never opened — don't burn a Jev call on a dead client
        }
        const raw = await readBody(req, res, BODY_CAP, readTimeoutMs);
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          throw new SearchError("Malformed JSON body.", 400);
        }
        const input = validateSearchInput(body);
        const source = pickProvider(config, body.provider);

        // Optional redact mode: same-length masking, offsets stay exact.
        let passages = input.passages;
        let redactNote = "";
        if (body.redact === true) {
          const counts = {};
          passages = passages.map((p) => {
            const r = redactText(p.text);
            for (const [k, n] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + n;
            return { id: p.id, text: r.text };
          });
          const parts = Object.entries(counts).map(([k, n]) => `${k}×${n}`);
          redactNote = ` · redacted ${parts.length ? parts.join(" ") : "nothing"}`;
        }

        if (path === "/api/preview") {
          const prepared = preparePassages(passages);
          const bodies = [];
          for (let i = 0; i < prepared.length; i += BATCH_MAX) {
            const chunk = prepared.slice(i, i + BATCH_MAX);
            bodies.push(buildRequest({ query: input.query, passages: chunk, model: source.model }));
          }
          const bytes = Buffer.byteLength(JSON.stringify(bodies));
          log(`POST /api/preview → 200 · source ${source.id} · ${prepared.length} passages · ${bodies.length} chunk${bodies.length > 1 ? "s" : ""} · ${bytes} B${redactNote} · ${Date.now() - started} ms`);
          return sendJson(res, 200, {
            ok: true,
            model: source.model,
            source: source.id,
            auth: "Bearer •••", // the key itself is never echoed
            stats: { passages: prepared.length, chunks: bodies.length, bytes },
            chunks: bodies,
          });
        }

        const controller = new AbortController();
        res.on("close", () => controller.abort(new Error("client disconnected")));

        try {
          const { results, stats } = await searchText(
            { query: input.query, passages },
            {
              config: { baseUrl: source.baseUrl, model: source.model, apiKey: source.apiKey },
              fetchImpl,
              signal: controller.signal,
              onProgress: (p) => {
                if (!wantsStream || res.destroyed) return;
                try {
                  res.write(`event: progress\ndata: ${JSON.stringify(p)}\n\n`);
                } catch {
                  /* client gone; the abort handler finishes the teardown */
                }
              },
            },
          );
          if (res.destroyed) {
            // Results are ready but the client is gone — say so instead of logging a 200 nobody received.
            log(`POST /api/search → 499 cancelled (client disconnected before delivery) · source ${source.id}${redactNote} · ${stats.ms} ms`);
            return;
          }
          const okLine = `POST /api/search → 200 · source ${source.id} · ${stats.passages} passages · ${results.length} results · ${stats.chunks} pass${stats.chunks > 1 ? "es" : ""}${redactNote} · ${stats.ms} ms · tokens ${stats.usage.input_tokens}/${stats.usage.output_tokens}`;
          if (wantsStream) {
            // Log the 200 only once the result frame has actually flushed; async failures log 499.
            try {
              res.write(`event: result\ndata: ${JSON.stringify({ results, stats })}\n\n`, (err) => {
                log(err ? `POST /api/search → 499 cancelled (client disconnected mid-delivery) · source ${source.id}${redactNote} · ${stats.ms} ms` : `${okLine} · sse`);
              });
              res.end();
            } catch {
              log(`POST /api/search → 499 cancelled (client disconnected mid-delivery) · source ${source.id}${redactNote} · ${stats.ms} ms`);
            }
          } else {
            sendJson(res, 200, { results, stats });
            log(okLine); // after the write attempt, so a 200 always means delivered
          }
          return;
        } catch (err) {
          const status = err instanceof SearchError ? err.status : 500;
          if (status === 499 || res.destroyed || controller.signal.aborted) {
            log(`POST /api/search → 499 cancelled (client disconnected) · source ${source.id}${redactNote} · ${Date.now() - started} ms`);
            if (!res.destroyed) {
              try {
                res.end();
              } catch {
                /* already gone */
              }
            }
            return;
          }
          throw err; // the outer catch delivers JSON (or an SSE error event)
        }
      }

      // Why-chips: one extra Jev pass that only PICKS a reason from our fixed list.
      if (path === "/api/why" && req.method === "POST") {
        const raw = await readBody(req, res, BODY_CAP, readTimeoutMs);
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          throw new SearchError("Malformed JSON body.", 400);
        }
        const input = validateWhyInput(body);
        const source = pickProvider(config, body.provider);

        // Same privacy rule as search: page text is masked before it leaves.
        let matches = input.matches;
        let redactNote = "";
        if (body.redact === true) {
          const counts = {};
          matches = matches.map((m) => {
            const r = redactText(m.sentence);
            for (const [k, n] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + n;
            return { id: m.id, sentence: r.text };
          });
          const parts = Object.entries(counts).map(([k, n]) => `${k}×${n}`);
          redactNote = ` · redacted ${parts.length ? parts.join(" ") : "nothing"}`;
        }

        const controller = new AbortController();
        res.on("close", () => controller.abort(new Error("client disconnected")));
        try {
          const { reasons, stats } = await whyFor(
            { query: input.query, matches },
            { config: { baseUrl: source.baseUrl, model: source.model, apiKey: source.apiKey }, fetchImpl, signal: controller.signal },
          );
          if (res.destroyed) {
            log(`POST /api/why → 499 cancelled (client disconnected) · source ${source.id}${redactNote} · ${stats.ms} ms`);
            return;
          }
          sendJson(res, 200, { reasons, stats });
          log(
            `POST /api/why → 200 · source ${source.id} · ${reasons.length} matches · ${reasons.filter((r) => r.reason).length} chips${redactNote} · ${stats.ms} ms · tokens ${stats.usage.input_tokens}/${stats.usage.output_tokens}`,
          );
          return;
        } catch (err) {
          const status = err instanceof SearchError ? err.status : 500;
          if (status === 499 || res.destroyed || controller.signal.aborted) {
            log(`POST /api/why → 499 cancelled (client disconnected) · source ${source.id}${redactNote} · ${Date.now() - started} ms`);
            if (!res.destroyed) {
              try {
                res.end();
              } catch {
                /* already gone */
              }
            }
            return;
          }
          throw err;
        }
      }

      return sendJson(res, 404, { message: "Not found." });
    } catch (err) {
      if (res.headersSent) {
        // A streaming response may already be open — deliver the failure as an SSE error event.
        const isStream = (res.getHeader("content-type") ?? "").toString().includes("text/event-stream");
        if (isStream) {
          const status = err instanceof SearchError ? err.status : 500;
          const message = err instanceof SearchError ? err.message : "Something went wrong inside the helper.";
          if (!res.destroyed) {
            try {
              res.write(`event: error\ndata: ${JSON.stringify({ message, status })}\n\n`);
            } catch {
              /* client gone */
            }
          }
          log(`→ ${status} (stream) · ${message}`);
        }
        if (!(err instanceof SearchError)) log(`!! unexpected error: ${err?.name ?? "Error"}${err?.code ? ` (${err.code})` : ""}`);
        try {
          res.end();
        } catch {
          /* already gone */
        }
        return;
      }
      sendError(res, err, log);
    }
  });

  // Belt: even if a caller listens on a non-loopback address, slam it shut immediately.
  server.on("listening", () => {
    const addr = server.address();
    if (addr && typeof addr === "object" && !loopback(addr.address)) {
      log(`tracky-helper: bound to ${addr.address} — refusing to serve off loopback. Closing.`);
      server.close();
    }
  });

  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  let config;
  try {
    config = loadEnv();
  } catch (e) {
    console.error(`tracky-helper: ${e.message}`);
    process.exit(1);
  }
  const port = Number(process.env.TRACKY_PORT ?? 4199);
  let host = process.env.TRACKY_HOST ?? "127.0.0.1";
  if (!loopback(host)) {
    console.warn(`tracky-helper: refusing to bind ${host} — this helper is loopback-only. Using 127.0.0.1.`);
    host = "127.0.0.1";
  }
  const server = createHelperServer({ config });
  server.listen(port, host, () => {
    console.log(`tracky-helper ${VERSION} · http://${host}:${port}`);
    console.log(`  POST /api/search · POST /api/why · POST /api/preview · GET /api/health`);
    console.log(`  model ${config.model} · key loaded from server/.env (never logged)`);
    console.log(`  caps: body ${BODY_CAP / 1024} KB · ${LIMITS.passagesMax} passages · ${BATCH_MAX}/pass`);
  });
  server.on("error", (e) => {
    console.error(
      `tracky-helper: ${e.code === "EADDRINUSE" ? `port ${port} is already in use — is another helper running?` : e.message}`,
    );
    process.exit(1);
  });
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      console.log(`tracky-helper: ${sig} — closing.`);
      server.close(() => process.exit(0));
    });
  }
}
