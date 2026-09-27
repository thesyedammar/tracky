// Source (provider) specs — the extension's dropdown must never be able to point
// a search at a source the helper does not know, and a key must never travel to a
// host it does not belong to.
import test from "node:test";
import assert from "node:assert/strict";
import { resolveProviders, loadEnv } from "../env.mjs";
import { createHelperServer } from "../server.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const response = (payload, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
});

const baseEnv = {
  JEV_BASE_URL: "https://zen.test",
  JEV_MODEL: "jev-1.13",
  JEV_API_KEY: "shared-key",
  JEV_PROVIDERS: "zen-paid,zen-free,typesafe",
  JEV_PROVIDER_ZEN_FREE_MODEL: "jev-1.13-free",
  JEV_PROVIDER_TYPESAFE_BASE_URL: "https://typesafe.test/v1/systemone",
};

test("the first id is the default and each one inherits the shared values", () => {
  const { defaultId, providers } = resolveProviders(baseEnv);
  assert.equal(defaultId, "zen-paid");
  assert.deepEqual(
    providers.map((p) => p.id),
    ["zen-paid", "zen-free", "typesafe"],
  );
  const [paid, free] = providers;
  assert.equal(paid.model, "jev-1.13");
  assert.equal(paid.baseUrl, "https://zen.test");
  assert.equal(paid.apiKey, "shared-key");
  assert.equal(paid.kind, "paid");
  assert.equal(free.model, "jev-1.13-free");
  assert.equal(free.kind, "free"); // derived from the model name
});

test("a provider that points at another host must bring its own key", () => {
  const { providers } = resolveProviders(baseEnv);
  const typesafe = providers.find((p) => p.id === "typesafe");
  assert.equal(typesafe.baseUrl, "https://typesafe.test/v1/systemone");
  assert.equal(typesafe.apiKey, ""); // the shared key belongs to the shared route
  assert.equal(typesafe.configured, false);

  const withKey = resolveProviders({ ...baseEnv, JEV_PROVIDER_TYPESAFE_KEY: "own-key" });
  const ts2 = withKey.providers.find((p) => p.id === "typesafe");
  assert.equal(ts2.apiKey, "own-key");
  assert.equal(ts2.configured, true);
});

test("no JEV_PROVIDERS list → one implicit provider, so older .env files keep working", () => {
  const { defaultId, providers } = resolveProviders({
    JEV_BASE_URL: "https://zen.test",
    JEV_MODEL: "jev-1.13-free",
    JEV_API_KEY: "k",
  });
  assert.equal(defaultId, "default");
  assert.equal(providers.length, 1);
  assert.equal(providers[0].configured, true);
});

test("a provider on the SAME host may inherit the shared key; a different host may not", () => {
  const sameHost = resolveProviders({ ...baseEnv, JEV_PROVIDER_TYPESAFE_BASE_URL: "https://zen.test/v2/other" });
  const ts = sameHost.providers.find((p) => p.id === "typesafe");
  assert.equal(ts.apiKey, "shared-key"); // same host → inheriting is safe
  assert.equal(ts.configured, true);

  const otherHost = resolveProviders(baseEnv);
  assert.equal(otherHost.providers.find((p) => p.id === "typesafe").apiKey, "");
});

test("duplicate ids are deduped, whitespace is trimmed, kind is normalized", () => {
  const { providers } = resolveProviders({
    ...baseEnv,
    JEV_PROVIDERS: " zen-paid , zen-paid, zen-free ",
    JEV_PROVIDER_ZEN_PAID_LABEL: "  Zen paid  ",
    JEV_PROVIDER_ZEN_FREE_KIND: " FREE ",
    JEV_PROVIDER_ZEN_FREE_MODEL: "  jev-1.13-free  ",
  });
  assert.deepEqual(
    providers.map((p) => p.id),
    ["zen-paid", "zen-free"],
  );
  assert.equal(providers[0].label, "Zen paid");
  assert.equal(providers[1].kind, "free");
  assert.equal(providers[1].model, "jev-1.13-free");
});

test("a blank label falls back to the id", () => {
  const { providers } = resolveProviders({ ...baseEnv, JEV_PROVIDER_ZEN_PAID_LABEL: "   " });
  assert.equal(providers[0].label, "zen-paid");
});

test("labels fall back to the id, and _LABEL wins when set", () => {
  const { providers } = resolveProviders({ ...baseEnv, JEV_PROVIDER_ZEN_PAID_LABEL: "Zen (paid)" });
  assert.equal(providers[0].label, "Zen (paid)");
  assert.equal(providers[1].label, "zen-free");
});

test("a scheme change counts as another host — an https key must not follow to http", () => {
  const { providers } = resolveProviders({ ...baseEnv, JEV_PROVIDER_TYPESAFE_BASE_URL: "http://zen.test/x" });
  assert.equal(providers.find((p) => p.id === "typesafe").apiKey, "");
});

test("a typo'd provider URL is never 'configured'", () => {
  const { providers } = resolveProviders({ ...baseEnv, JEV_PROVIDER_TYPESAFE_BASE_URL: "not a url" });
  const ts = providers.find((p) => p.id === "typesafe");
  assert.equal(ts.configured, false);
});

test("ids that share an env-var stem collapse to one source", () => {
  const { providers } = resolveProviders({ ...baseEnv, JEV_PROVIDERS: "zen-paid,zen_paid" });
  assert.deepEqual(
    providers.map((p) => p.id),
    ["zen-paid"],
  );
});

test("loadEnv trims the shared values it returns", () => {
  const dir = mkdtempSync(join(fileURLToPath(new URL(".", import.meta.url)), ".tmp-"));
  const f = join(dir, ".env");
  writeFileSync(f, 'JEV_BASE_URL=" https://zen.test "\nJEV_MODEL="  jev-1.13  "\nJEV_API_KEY=" k "\n');
  const cfg = loadEnv({ envPath: f, target: {} });
  assert.equal(cfg.baseUrl, "https://zen.test");
  assert.equal(cfg.model, "jev-1.13");
  assert.equal(cfg.apiKey, "k");
  rmSync(dir, { recursive: true, force: true });
});

test("a default source with no key is a 503 naming the shared vars", async () => {
  const bare = { baseUrl: "https://zen.test", model: "jev-1.13", apiKey: "k", defaultId: "default", providers: [{ id: "default", label: "default", kind: "paid", model: "", baseUrl: "", apiKey: "", configured: false }] };
  const server = createHelperServer({ config: bare, fetchImpl: answerOk, log: () => {} });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await post(base, "/api/search", onePassage);
    assert.equal(res.status, 503);
    assert.match((await res.json()).message, /JEV_API_KEY/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

const config = {
  baseUrl: "https://zen.test",
  model: "jev-1.13",
  apiKey: "shared-key",
  defaultId: "zen-paid",
  providers: [
    { id: "zen-paid", label: "Paid", kind: "paid", model: "jev-1.13", baseUrl: "https://zen.test", apiKey: "shared-key", configured: true },
    { id: "zen-free", label: "Free", kind: "free", model: "jev-1.13-free", baseUrl: "https://zen.test", apiKey: "shared-key", configured: true },
    { id: "typesafe", label: "TypeSafe", kind: "paid", model: "jev-latest", baseUrl: "https://typesafe.test", apiKey: "", configured: false },
  ],
};

async function withServer(fetchImpl, fn) {
  const server = createHelperServer({ config, fetchImpl, log: () => {} });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const post = (base, path, body) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const onePassage = { query: "fee", passages: [{ id: "p0", text: "A service charge applies. Something else." }] };
const answerOk = (url, init) => {
  const body = JSON.parse(init.body);
  const answers = {};
  for (const p of body.state.passages) {
    answers[p.id] = { type: "noul", noul: 0.9 };
    if (body.questions[`focus_${p.id}`]) answers[`focus_${p.id}`] = { type: "choice", choice: "s0" };
  }
  return response({ answers, usage: { input_tokens: 5, output_tokens: 2 } });
};

test("/api/providers lists labels and models — never a key", async () => {
  await withServer(answerOk, async (base) => {
    const res = await fetch(`${base}/api/providers`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes("shared-key"), "the key must never appear");
    const body = JSON.parse(text);
    assert.equal(body.default, "zen-paid");
    assert.deepEqual(
      body.providers.map((p) => p.id),
      ["zen-paid", "zen-free", "typesafe"],
    );
    assert.equal(body.providers.find((p) => p.id === "typesafe").configured, false);
  });
});

test("a chosen source routes the search to THAT model", async () => {
  const seen = [];
  await withServer(
    (url, init) => {
      seen.push({ url, model: JSON.parse(init.body).model, auth: init.headers.Authorization });
      return answerOk(url, init);
    },
    async (base) => {
      const res = await post(base, "/api/search", { ...onePassage, provider: "zen-free" });
      assert.equal(res.status, 200);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].model, "jev-1.13-free");
      assert.equal(seen[0].url, "https://zen.test");
    },
  );
});

test("no source in the body → the default one", async () => {
  const seen = [];
  await withServer(
    (url, init) => {
      seen.push(JSON.parse(init.body).model);
      return answerOk(url, init);
    },
    async (base) => {
      assert.equal((await post(base, "/api/search", onePassage)).status, 200);
      assert.deepEqual(seen, ["jev-1.13"]);
    },
  );
});

test("an unknown source is a 400 that names the ones that exist", async () => {
  await withServer(answerOk, async (base) => {
    const res = await post(base, "/api/search", { ...onePassage, provider: "nope" });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.message, /Unknown source "nope"/);
    assert.match(body.message, /zen-paid, zen-free, typesafe/);
  });
});

test("a source without a key is a 503 that names the exact .env line", async () => {
  await withServer(answerOk, async (base) => {
    const res = await post(base, "/api/search", { ...onePassage, provider: "typesafe" });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.match(body.message, /JEV_PROVIDER_TYPESAFE_KEY/);
  });
});

test("why-chips honour the same source", async () => {
  const seen = [];
  await withServer(
    (url, init) => {
      seen.push(JSON.parse(init.body).model);
      return response({ answers: { p0: { type: "choice", choice: "r0" } }, usage: { input_tokens: 3, output_tokens: 1 } });
    },
    async (base) => {
      const res = await post(base, "/api/why", {
        query: "fee",
        matches: [{ passageId: "p0", sentence: "A service charge applies." }],
        provider: "zen-free",
      });
      assert.equal(res.status, 200);
      assert.deepEqual(seen, ["jev-1.13-free"]);
    },
  );
});
