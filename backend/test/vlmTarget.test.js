import test from "node:test";
import assert from "node:assert/strict";
import { _internal } from "../src/vlmClient.js";

const { resolveVlmTarget, authHeaders } = _internal;

test("an unconfigured endpoint throws instead of silently falling back", () => {
  // The local llama-server fallback was removed with the local model. A config
  // without pixel.vlmEndpoint used to resolve to a dead localhost URL and fail
  // later as an opaque fetch error; it must now fail loudly and immediately.
  assert.throws(() => resolveVlmTarget({}), /No VLM endpoint configured/);
  assert.throws(() => resolveVlmTarget({ pixel: {} }), /No VLM endpoint configured/);
});

test("resolution does not depend on actuationMode - the mode picks the prompt, not the provider", () => {
  const pixel = { vlmEndpoint: "https://example.test/v1beta/openai", modelName: "m", vlmApiKeyEnv: "K" };
  const asPixel = resolveVlmTarget({ actuationMode: "pixel", pixel });
  const asApi = resolveVlmTarget({ actuationMode: "api", pixel });
  assert.deepEqual(asApi, asPixel);
});

test("pixel mode resolves to the pixel endpoint + key env name", () => {
  const cfg = {
    actuationMode: "pixel",
    pixel: {
      vlmEndpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
      modelName: "gemini-flash-lite-latest",
      vlmApiKeyEnv: "GEMINI_API_KEY",
    },
  };
  const t = resolveVlmTarget(cfg);
  assert.equal(t.url, "https://generativelanguage.googleapis.com/v1beta/openai/v1/chat/completions");
  assert.equal(t.modelName, "gemini-flash-lite-latest");
  assert.equal(t.apiKeyEnv, "GEMINI_API_KEY");
});

test("authHeaders returns {} without a key, Bearer with one", () => {
  assert.deepEqual(authHeaders(null, {}), {});
  assert.deepEqual(authHeaders("GEMINI_API_KEY", {}), {});
  assert.deepEqual(authHeaders("GEMINI_API_KEY", { GEMINI_API_KEY: "" }), {});
  assert.deepEqual(authHeaders("GEMINI_API_KEY", { GEMINI_API_KEY: "sk-x" }), {
    Authorization: "Bearer sk-x",
  });
});
