// Failover across several API keys when one hits its DAILY quota.
//
// The free tier's cap is `GenerateRequestsPerDayPerProjectPerModel-FreeTier`,
// 500 requests/day, enforced PER PROJECT - so a second key from a second project
// carries its own 500. Before this, a spent key made every call 429, and the
// backoff honoured Google's "Please retry in 23s" hint even though a daily quota
// will not reopen for hours: the agent sat in "Reading the dashboard…" for
// minutes per step instead of switching to a key that works. Observed
// 2026-08-17 after an eval run exhausted the day's allowance.
import test from "node:test";
import assert from "node:assert/strict";
import { _internal } from "../src/vlmClient.js";

const { resolveVlmTarget, isDailyQuotaExhausted, pickKeyEnv, markKeyExhausted, clearExhaustedKeys } = _internal;

const PIXEL = { vlmEndpoint: "https://example.test/v1beta/openai", modelName: "m" };

// ---- config shape ---------------------------------------------------------

test("a single key env name still resolves, as a one-element list", () => {
  const t = resolveVlmTarget({ pixel: { ...PIXEL, vlmApiKeyEnv: "K1" } });
  assert.deepEqual(t.apiKeyEnvs, ["K1"]);
  assert.equal(t.apiKeyEnv, "K1", "the single-name field stays, so existing readers keep working");
});

test("a list of key env names resolves in order", () => {
  const t = resolveVlmTarget({ pixel: { ...PIXEL, vlmApiKeyEnv: ["K1", "K2", "K3"] } });
  assert.deepEqual(t.apiKeyEnvs, ["K1", "K2", "K3"]);
  assert.equal(t.apiKeyEnv, "K1");
});

test("no key configured is not an error - a local/keyless endpoint is legal", () => {
  const t = resolveVlmTarget({ pixel: { ...PIXEL } });
  assert.deepEqual(t.apiKeyEnvs, []);
  assert.equal(t.apiKeyEnv, null);
});

// ---- reading the 429 ------------------------------------------------------

test("the per-DAY violation is recognised", () => {
  const body = JSON.stringify([
    {
      error: {
        code: 429,
        message: "You exceeded your current quota",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "500" }],
          },
        ],
      },
    },
  ]);
  assert.equal(isDailyQuotaExhausted(body), true);
});

test("a per-MINUTE violation is NOT treated as daily - that one really does clear in seconds", () => {
  const body = JSON.stringify({
    error: {
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", quotaValue: "15" }],
        },
      ],
    },
  });
  assert.equal(isDailyQuotaExhausted(body), false);
});

test("an unparseable or unrelated body is never read as a daily exhaustion", () => {
  for (const b of ["", "not json", "{}", '{"error":{}}', null, undefined]) {
    assert.equal(isDailyQuotaExhausted(b), false, `expected false for ${JSON.stringify(b)}`);
  }
});

// ---- key selection --------------------------------------------------------

test("picks the first configured name that actually has a value in the environment", () => {
  clearExhaustedKeys();
  assert.equal(pickKeyEnv(["K1", "K2"], { K2: "v2" }), "K2", "an unset K1 is skipped, not sent as an empty bearer");
  assert.equal(pickKeyEnv(["K1", "K2"], { K1: "v1", K2: "v2" }), "K1");
  assert.equal(pickKeyEnv(["K1"], {}), null);
  assert.equal(pickKeyEnv([], { K1: "v1" }), null);
});

test("a key marked exhausted is skipped on every LATER call, not just the one that hit the wall", () => {
  clearExhaustedKeys();
  markKeyExhausted("K1");
  assert.equal(pickKeyEnv(["K1", "K2"], { K1: "v1", K2: "v2" }), "K2");
});

test("when every key is exhausted the first usable one is still returned, rather than failing hard", () => {
  // The cooldown may simply have been too short, or the quota may have reset -
  // spending one request to find out beats refusing to try.
  clearExhaustedKeys();
  markKeyExhausted("K1");
  markKeyExhausted("K2");
  assert.equal(pickKeyEnv(["K1", "K2"], { K1: "v1", K2: "v2" }), "K1");
});

test("a STRICT pick refuses an exhausted key, so mid-call rotation cannot ping-pong", () => {
  clearExhaustedKeys();
  markKeyExhausted("K1");
  markKeyExhausted("K2");
  assert.equal(pickKeyEnv(["K1", "K2"], { K1: "v1", K2: "v2" }, { strict: true }), null);
});

test("rotation excludes the key that just failed", () => {
  clearExhaustedKeys();
  assert.equal(pickKeyEnv(["K1", "K2"], { K1: "v1", K2: "v2" }, { exclude: "K1", strict: true }), "K2");
  assert.equal(pickKeyEnv(["K1"], { K1: "v1" }, { exclude: "K1", strict: true }), null);
});

test("clearExhaustedKeys restores every key", () => {
  clearExhaustedKeys();
  markKeyExhausted("K1");
  clearExhaustedKeys();
  assert.equal(pickKeyEnv(["K1", "K2"], { K1: "v1", K2: "v2" }), "K1");
});
