// The retry policy for a rate-limited VLM call. A 429 used to be fatal: three
// in a row is an invalid-response streak, which ends the session and records a
// quota message where the trajectory should be. Observed on a real run - eight
// pixel steps at two calls each cleared a 15-per-minute allowance in ~24s.
import { test } from "node:test";
import assert from "node:assert/strict";
import { _internal } from "../src/vlmClient.js";

const { isRetryableStatus, retryDelayMs } = _internal;

// A real Gemini 429 body, trimmed to the parts the parser reads.
const QUOTA_BODY = JSON.stringify({
  error: {
    code: 429,
    message:
      "You exceeded your current quota, please check your plan and billing details. " +
      "* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, " +
      "limit: 15, model: gemini-3.5-flash-lite\nPlease retry in 8.363871091s.",
    status: "RESOURCE_EXHAUSTED",
  },
});

test("only rate limits and overload are retried", () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(503), true);
  // A bad key, a bad payload or a missing model will never fix themselves -
  // retrying those just delays the real error by the length of the backoff.
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(401), false);
  assert.equal(isRetryableStatus(404), false);
  assert.equal(isRetryableStatus(500), false);
});

test("the wait comes from the body's own hint when there is one", () => {
  // 8.363871091s + the 250ms guard against waking a hair before the window
  // reopens and burning the retry on the same closed quota.
  assert.equal(retryDelayMs(QUOTA_BODY, 0), 8363.871091 + 250);
});

test("the body's hint wins over the attempt-number backoff", () => {
  // Otherwise a later attempt would wait longer than the API said it needs to.
  assert.equal(retryDelayMs(QUOTA_BODY, 2), 8363.871091 + 250);
});

test("a hinted wait is capped, so a wild value cannot stall the run", () => {
  assert.equal(retryDelayMs("Please retry in 3600s.", 0), 60_000);
});

test("no hint falls back to a widening backoff", () => {
  assert.equal(retryDelayMs("", 0), 2_000);
  assert.equal(retryDelayMs("Too Many Requests", 1), 4_000);
  assert.equal(retryDelayMs(null, 2), 8_000);
  // Capped, so the backoff cannot outgrow the per-call timeout on its own.
  assert.equal(retryDelayMs(undefined, 10), 30_000);
});
