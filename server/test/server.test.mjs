// Helper-server specs — contract shapes, caps, origin gate, redact, preview, SSE.
import test from "node:test";
import assert from "node:assert/strict";
import { createHelperServer, BODY_CAP } from "../server.mjs";
import { BATCH_MAX } from "../jev.mjs";

const config = { baseUrl: "https://jev.test", model: "jev-t", apiKey: "sk-test-SECRET" };

const response = (payload, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
});

const makePassages = (n, tpl = (i) => `Passage ${i} has a fee. Something else.`) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, text: tpl(i) }));

const allRelevant = (body, score = 0.9, pick = "s0") => {
  const answers = {};
  for (const p of body.state.passages) {
    answers[p.id] = { type: "noul", noul: score };
    if (body.questions[`focus_${p.id}`]) answers[`focus_${p.id}`] = { type: "choice", choice: pick };
  }
  return answers;
};

const jevOk =
  (opts = {}) =>
  (url, init) =>
    response({ answers: allRelevant(JSON.parse(init.body), opts.score, opts.pick), usage: { input_tokens: 11, output_tokens: 3 } });

async function withServer({ fetchImpl, ...opts }, fn) {
  const logs = [];
  const server = createHelperServer({ config, fetchImpl, log: (l) => logs.push(l), ...opts });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base, logs);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const post = (base, path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("health reports model and caps — and never the key", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name, "tracky-helper");
    assert.equal(body.model, "jev-t");
    assert.equal(body.caps.batch, BATCH_MAX);
    assert.ok(!JSON.stringify(body).includes("sk-test-SECRET"));
  });
});

test("search: contract shape end-to-end", async () => {
  await withServer({ fetchImpl: jevOk() }, async (base, logs) => {
    const res = await post(base, "/api/search", { query: "fee", passages: makePassages(3) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.results.length, 3);
    assert.deepEqual(Object.keys(body.results[0]).sort(), ["offset", "passageId", "score", "sentence"]);
    assert.equal(typeof body.results[0].offset, "number");
    assert.ok(body.stats.ms >= 0);
    assert.ok(logs.some((l) => l.includes("POST /api/search → 200")));
  });
});

test("400 on empty query and on malformed JSON", async () => {
  await withServer({ fetchImpl: jevOk() }, async (base) => {
    let res = await post(base, "/api/search", { query: "  ", passages: makePassages(1) });
    assert.equal(res.status, 400);
    assert.equal(typeof (await res.json()).message, "string");
    res = await post(base, "/api/search", "{nope");
    assert.equal(res.status, 400);
  });
});

test("413 when the body exceeds the 512 KB cap", async () => {
  await withServer({ fetchImpl: jevOk() }, async (base) => {
    const big = JSON.stringify({ query: "x", passages: [{ id: "p0", text: "a".repeat(BODY_CAP) }] });
    const res = await post(base, "/api/search", big);
    assert.equal(res.status, 413);
    assert.match((await res.json()).message, /too large/i);
  });
});

test("502 when Jev returns an unvalidatable answer", async () => {
  const badFetch = () => response({ answers: { p0: { noul: "high" } } });
  await withServer({ fetchImpl: badFetch }, async (base) => {
    const res = await post(base, "/api/search", { query: "fee", passages: makePassages(1) });
    assert.equal(res.status, 502);
    assert.match((await res.json()).message, /incomplete evaluation/i);
  });
});

test("404 for unknown paths and non-POST on POST routes", async () => {
  await withServer({ fetchImpl: jevOk() }, async (base) => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/search`)).status, 404);
  });
});

test("no error response carries a stack or internals — only {message}", async () => {
  // Every failure below travels a different error path (validation 400, body
  // cap 413, upstream 502, unknown route 404, raw escape 500); all must expose
  // the same message-only shape, never a stack trace or echoed internals.
  const downFetch = () => response("upstream exploded", { ok: false, status: 500 });
  const rawEscapeFetch = () => ({
    ok: false,
    status: 429, // the rate-limit branch reads retry-after OUTSIDE any try…
    headers: { get: () => { throw new Error("boom-inside-headers"); } }, // …so a raw throw here escapes as a genuine 500
    text: async () => "",
  });
  // A stack frame is newline + "at": the substring "at " alone also matches
  // innocent prose ("must be at least…"), so only the frame shape counts.
  const hasStackFrame = (raw) => /(\n|\\n)\s*at\s/.test(raw);
  await withServer({ fetchImpl: downFetch }, async (base) => {
    const cases = [
      await post(base, "/api/search", { query: "  ", passages: makePassages(1) }), // 400
      await post(base, "/api/search", JSON.stringify({ query: "x", passages: [{ id: "p0", text: "a".repeat(BODY_CAP) }] })), // 413
      await post(base, "/api/search", { query: "fee", passages: makePassages(1) }), // 502
      await fetch(`${base}/nope`), // 404
    ];
    assert.deepEqual(cases.map((r) => r.status), [400, 413, 502, 404]);
    for (const res of cases) {
      const raw = await res.text();
      assert.ok(!hasStackFrame(raw), `error body must never carry a trace frame: ${raw.slice(0, 120)}`);
      assert.ok(!raw.includes("upstream exploded"), `upstream internals must never be echoed: ${raw.slice(0, 120)}`);
      assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["message"]);
    }
  });
  await withServer({ fetchImpl: rawEscapeFetch }, async (base) => {
    const res = await post(base, "/api/search", { query: "fee", passages: makePassages(1) });
    assert.equal(res.status, 500);
    const raw = await res.text();
    assert.ok(!hasStackFrame(raw), `generic 500 must never carry a trace frame: ${raw.slice(0, 120)}`);
    assert.ok(!raw.includes("boom-inside-headers"), `raw error text must never reach the wire: ${raw.slice(0, 120)}`);
    assert.deepEqual(JSON.parse(raw), { message: "Something went wrong inside the helper." });
  });
});

test("origin gate: websites are refused, extensions and curl pass", async () => {
  await withServer({ fetchImpl: jevOk() }, async (base) => {
    let res = await post(base, "/api/search", { query: "fee", passages: makePassages(1) }, { origin: "https://evil.example" });
    assert.equal(res.status, 403);
    res = await post(base, "/api/search", { query: "fee", passages: makePassages(1) }, { origin: "chrome-extension://abcdefghijklmnop" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "chrome-extension://abcdefghijklmnop");
    res = await post(base, "/api/search", { query: "fee", passages: makePassages(1) });
    assert.equal(res.status, 200); // curl: no origin header
    res = await fetch(`${base}/api/search`, { method: "OPTIONS", headers: { origin: "http://localhost:5173" } });
    assert.equal(res.status, 204); // preflight for an allowed dev origin
  });
});

test("redact: masks PII before it leaves for Jev, offsets stay exact", async () => {
  let seen = null;
  const fetchImpl = (url, init) => {
    seen = JSON.parse(init.body);
    return response({ answers: allRelevant(seen), usage: { input_tokens: 1, output_tokens: 1 } });
  };
  const text = "Contact john@example.com or 9876543210. A service charge of Rs.250 applies. Card 4111 1111 1111 1111.";
  await withServer({ fetchImpl }, async (base) => {
    const res = await post(base, "/api/search", { query: "fee", passages: [{ id: "p0", text }], redact: true });
    assert.equal(res.status, 200);
    const sent = seen.state.passages[0].text;
    assert.equal(sent.length, text.length); // same length → offsets stable
    assert.ok(!sent.includes("john@example.com"));
    assert.ok(!sent.includes("9876543210"));
    assert.ok(!sent.includes("4111"));
    assert.ok(sent.includes("Rs.250")); // money survives — it is the content
    assert.ok(sent.includes("•"));
  });
});

test("without redact the text goes as-is", async () => {
  let seen = null;
  const fetchImpl = (url, init) => {
    seen = JSON.parse(init.body);
    return response({ answers: allRelevant(seen) });
  };
  await withServer({ fetchImpl }, async (base) => {
    await post(base, "/api/search", { query: "fee", passages: [{ id: "p0", text: "Mail john@example.com about the fee." }] });
    assert.ok(seen.state.passages[0].text.includes("john@example.com"));
  });
});

test("preview: exact payload, zero Jev calls, key never echoed", async () => {
  let calls = 0;
  const fetchImpl = () => {
    calls++;
    return response({});
  };
  await withServer({ fetchImpl }, async (base) => {
    const res = await post(base, "/api/preview", { query: "hidden charges", passages: makePassages(2) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(calls, 0);
    assert.equal(body.model, "jev-t");
    assert.equal(body.auth, "Bearer •••");
    assert.equal(body.chunks.length, 1);
    assert.equal(body.chunks[0].state.search, "hidden charges");
    assert.ok(body.chunks[0].questions.p0);
    assert.ok(!JSON.stringify(body).includes("sk-test-SECRET"));
  });
});

test("preview chunks match the engine's byte-sized splitter — live HTTP", async () => {
  await withServer({ fetchImpl: jevOk() }, async (base) => {
    const passages = makePassages(100, (i) => `Dense passage ${i}. `.repeat(120));
    const res = await post(base, "/api/preview", { query: "fee", passages });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.stats.chunks > 2, `dense preview must chunk like the engine (got ${body.stats.chunks})`);
    const { MAX_BODY_CHARS } = await import("../search.mjs");
    for (const builtBody of body.chunks) {
      // NOTE: preview's `chunks` ARE the built request bodies (server.mjs returns
      // `chunks: bodies`), so this asserts on buildRequest output directly —
      // no chunk-vs-body gap is possible here.
      assert.ok(JSON.stringify(builtBody).length <= MAX_BODY_CHARS, "every previewed request body must fit the engine budget");
    }
  });
});

test("why: chips end-to-end over HTTP, key never in the body", async () => {
  const whyOk = () => async () => response({ answers: { p0: { type: "choice", choice: "r0" } }, usage: { input_tokens: 5, output_tokens: 2 } });
  await withServer({ fetchImpl: whyOk() }, async (base) => {
    const res = await post(base, "/api/why", {
      query: "fee",
      matches: [{ passageId: "p0", sentence: "A late fee applies." }],
    });
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.ok(!raw.includes("sk-test-SECRET"), "key must never appear in a why response");
    const body = JSON.parse(raw);
    assert.deepEqual(body.reasons, [{ passageId: "p0", reason: "states a price or fee" }]);
    assert.ok(body.stats.ms >= 0);
  });
});

test("why: 400 on empty query and on zero matches", async () => {
  await withServer({ fetchImpl: jevOk() }, async (base) => {
    let res = await post(base, "/api/why", { query: "  ", matches: [{ passageId: "p0", sentence: "x" }] });
    assert.equal(res.status, 400);
    res = await post(base, "/api/why", { query: "fee", matches: [] });
    assert.equal(res.status, 400);
  });
});

test("pickProvider: unknown source is a 400 that names what exists", async () => {
  await withServer({ fetchImpl: jevOk() }, async (base) => {
    const res = await post(base, "/api/preview", { query: "fee", passages: makePassages(1), provider: "nope" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).message, /Unknown source "nope"/);
  });
});

test("pickProvider: provider id routes the request to that source", async () => {
  const providers = [
    { id: "a", label: "A", kind: "paid", model: "model-a", baseUrl: "https://a.test/v1", apiKey: "key-a", configured: true, badUrl: false },
    { id: "b", label: "B", kind: "free", model: "model-b", baseUrl: "https://b.test/v1", apiKey: "key-b", configured: true, badUrl: false },
  ];
  const cfg = { ...config, defaultId: "a", providers };
  const routeFetch = (url, init) => jevOk()(url, init);
  const server = createHelperServer({ config: cfg, fetchImpl: routeFetch, log: () => {} });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await post(base, "/api/preview", { query: "fee", passages: makePassages(1), provider: "b" });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).model, "model-b", "preview must build with source b's model");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("pickProvider: keyless source fails fast with a 503 naming the fix", async () => {
  const providers = [
    { id: "a", label: "A", kind: "paid", model: "model-a", baseUrl: "https://a.test/v1", apiKey: "key-a", configured: true, badUrl: false },
    { id: "b", label: "B", kind: "free", model: "model-b", baseUrl: "https://b.test/v1", apiKey: "", configured: false, badUrl: false },
  ];
  const cfg = { ...config, defaultId: "a", providers };
  await withServer({ fetchImpl: jevOk(), config: cfg }, async (base) => {
    const res = await post(base, "/api/search", { query: "fee", passages: makePassages(1), provider: "b" });
    assert.equal(res.status, 503);
    assert.match((await res.json()).message, /no key/i);
  });
});

test("SSE stream: progress per pass then the final result", async () => {
  await withServer({ fetchImpl: jevOk() }, async (base) => {
    const res = await fetch(`${base}/api/search?stream=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "fee", passages: makePassages(BATCH_MAX + 1) }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const text = await res.text();
    assert.ok(text.includes("event: open"));
    assert.equal((text.match(/event: progress/g) ?? []).length, 2);
    const resultLine = text.split("event: result\ndata: ")[1].split("\n\n")[0];
    const final = JSON.parse(resultLine);
    assert.equal(final.stats.chunks, 2);
    assert.equal(final.results.length, 8);
  });
});

test("privacy: page text never reaches the logs (counts only)", async () => {
  const secret = "ZEBRA-CONFIDENTIAL-9137";
  await withServer({ fetchImpl: jevOk() }, async (base, logs) => {
    const res = await post(base, "/api/search", { query: "fee", passages: [{ id: "p0", text: `${secret}. A fee applies. Nothing else.` }] });
    assert.equal(res.status, 200);
    const all = logs.join("\n");
    assert.ok(!all.includes(secret), "page text leaked into logs");
    assert.ok(all.includes("1 passages"));
  });
});

test("SSE early failure: the error arrives as an event, not JSON", async () => {
  await withServer({ fetchImpl: jevOk() }, async (base, logs) => {
    const res = await fetch(`${base}/api/search?stream=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "  ", passages: makePassages(1) }),
    });
    assert.equal(res.status, 200); // the SSE channel opens first
    const text = await res.text();
    assert.ok(text.includes("event: open"));
    assert.ok(text.includes("event: error"));
    assert.ok(text.includes("Enter something"));
    assert.ok(logs.some((l) => l.includes("(stream)")), "the stream error path must be logged");
  });
});

test("a trickling client is cut off by the body read timeout (408)", async () => {
  await withServer({ fetchImpl: jevOk(), readTimeoutMs: 150 }, async (base, logs) => {
    const net = await import("node:net");
    const { port } = new URL(base);
    const reply = await new Promise((resolve) => {
      let buf = "";
      const sock = net.connect(Number(port), "127.0.0.1", () => {
        // Promise a 500-byte body, then send only a few bytes and stall.
        sock.write('POST /api/search HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"query":');
      });
      const finish = () => {
        sock.destroy();
        resolve(buf);
      };
      sock.on("data", (d) => {
        buf += d;
        if (buf.includes("408")) finish();
      });
      sock.on("error", () => resolve(buf));
      setTimeout(finish, 1500); // safety net
    });
    assert.match(reply, /408|timed out/i);
    assert.ok(logs.some((l) => l.includes("408")), `expected a 408 log line; got: ${logs.join(" | ")}`);
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200); // still healthy
  });
});

test("unexpected errors are logged without their message (counts-only)", async () => {
  const secret = "LEAKY-SECRET-4242";
  let reads = 0;
  const leaky = {
    baseUrl: "https://jev.test",
    apiKey: "sk-test-SECRET",
    get model() {
      reads += 1;
      if (reads > 1) throw new Error(`boom ${secret}`); // first read is the factory's config check
      return "jev-t";
    },
  };
  await withServer({ fetchImpl: jevOk(), config: leaky }, async (base, logs) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 500);
    const all = logs.join("\n");
    assert.ok(!all.includes(secret), "the error message leaked into the logs");
    assert.ok(logs.some((l) => l.includes("unexpected error")), "the unexpected-error line must still be logged");
  });
});

test("early disconnect mid-body does not hang the server (499, then still healthy)", async () => {
  await withServer({ fetchImpl: jevOk() }, async (base, logs) => {
    const net = await import("node:net");
    const { port } = new URL(base);
    await new Promise((resolve) => {
      const sock = net.connect(Number(port), "127.0.0.1", () => {
        sock.write(
          'POST /api/search HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"query":',
        );
        setTimeout(() => {
          sock.destroy();
          resolve();
        }, 30);
      });
      sock.on("error", () => resolve());
    });
    await new Promise((r) => setTimeout(r, 120)); // let the server settle
    assert.ok(logs.some((l) => l.includes("499")), `expected a 499 log line; got: ${logs.join(" | ")}`);
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200); // the helper never hung
  });
});

test("client disconnect cancels the search (499 logged) and the server survives", async () => {
  const hangFetch = (url, init) =>
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error("never")), 60_000);
      init.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(init.signal.reason ?? new Error("aborted"));
        },
        { once: true },
      );
    });
  await withServer({ fetchImpl: hangFetch }, async (base, logs) => {
    const ctrl = new AbortController();
    const p = fetch(`${base}/api/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "fee", passages: makePassages(1) }),
      signal: ctrl.signal,
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 60));
    ctrl.abort();
    await p;
    await new Promise((r) => setTimeout(r, 150)); // let the server settle
    assert.ok(logs.some((l) => l.includes("499")), `expected a 499 log line; got: ${logs.join(" | ")}`);
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200); // still alive
  });
});

test("GET /api/providers exposes labels and reasons — never keys or addresses", async () => {
  const providers = [
    { id: "a", label: "A", kind: "paid", model: "m-a", baseUrl: "https://a.test/v1", apiKey: "sk-SECRET-1", configured: true, badUrl: false },
    { id: "b", label: "B", kind: "free", model: "", baseUrl: "", apiKey: "", configured: false, badUrl: true },
  ];
  const cfg = { ...config, defaultId: "a", providers };
  const server = createHelperServer({ config: cfg, fetchImpl: jevOk(), log: () => {} });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/providers`);
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.ok(!raw.includes("sk-SECRET"), "key value must never leave the helper");
    assert.ok(!raw.includes("https://a.test/v1"), "base URL value must never leave the helper");
    const body = JSON.parse(raw);
    assert.equal(body.default, "a");
    assert.equal(body.providers.length, 2);
    for (const p of body.providers) {
      assert.deepEqual(Object.keys(p).sort(), ["badUrl", "configured", "id", "kind", "label", "model", "why"]);
    }
    assert.equal(body.providers[0].why, "");
    assert.ok(body.providers[1].why.length > 0, "an unusable source must say why");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
