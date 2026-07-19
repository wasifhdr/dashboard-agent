import test from "node:test";
import assert from "node:assert/strict";
import { _internal } from "../src/vlmClient.js";

const { resolveVlmTarget, authHeaders } = _internal;

test("api mode resolves to llamaEndpoint completions URL, no key", () => {
  const cfg = { llamaEndpoint: "http://127.0.0.1:8080", modelName: "local" };
  const t = resolveVlmTarget(cfg);
  assert.equal(t.url, "http://127.0.0.1:8080/v1/chat/completions");
  assert.equal(t.modelName, "local");
  assert.equal(t.apiKeyEnv, null);
});

test("pixel mode resolves to the pixel endpoint + key env name", () => {
  const cfg = {
    actuationMode: "pixel",
    llamaEndpoint: "http://127.0.0.1:8080",
    modelName: "local",
    pixel: {
      vlmEndpoint: "https://api.craftx.corecraftsolutions.com/api",
      modelName: "Qwen3 VL 30B A3B Instruct",
      vlmApiKeyEnv: "CRAFTX_API_KEY",
    },
  };
  const t = resolveVlmTarget(cfg);
  assert.equal(t.url, "https://api.craftx.corecraftsolutions.com/api/v1/chat/completions");
  assert.equal(t.modelName, "Qwen3 VL 30B A3B Instruct");
  assert.equal(t.apiKeyEnv, "CRAFTX_API_KEY");
});

test("authHeaders returns {} without a key, Bearer with one", () => {
  assert.deepEqual(authHeaders(null, {}), {});
  assert.deepEqual(authHeaders("CRAFTX_API_KEY", {}), {});
  assert.deepEqual(authHeaders("CRAFTX_API_KEY", { CRAFTX_API_KEY: "" }), {});
  assert.deepEqual(authHeaders("CRAFTX_API_KEY", { CRAFTX_API_KEY: "sk-x" }), {
    Authorization: "Bearer sk-x",
  });
});
