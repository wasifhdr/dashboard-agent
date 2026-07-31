import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSearchPayload, searchWorkbooks, clearSearchCache } from "../src/tableauSearch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "tableau-search-netflix.json"), "utf-8"),
);

test("normalizes a real upstream payload into openable dashboards", () => {
  const { results, degraded } = normalizeSearchPayload(fixture);
  assert.equal(degraded, false);
  assert.ok(results.length > 0);
  for (const r of results) {
    assert.match(r.url, /^https:\/\/public\.tableau\.com\/views\/[^/]+\/[^/]+$/);
    assert.match(r.thumbnail, /^https:\/\/public\.tableau\.com\/thumb\/views\/[^/]+\/[^/]+$/);
    assert.equal(r.source, "tableau-public");
    assert.equal(typeof r.name, "string");
  }
});

test("derives the views URL by dropping the sheets segment", () => {
  const payload = {
    totalHits: 1,
    results: [
      {
        workbook: {
          title: "Sales",
          description: "d",
          authorDisplayName: "A",
          viewCount: 7,
          numberOfFavorites: 2,
          defaultViewRepoUrl: "MyBook_123/sheets/Overview",
        },
      },
    ],
  };
  const { results } = normalizeSearchPayload(payload);
  assert.equal(results[0].url, "https://public.tableau.com/views/MyBook_123/Overview");
  assert.equal(results[0].thumbnail, "https://public.tableau.com/thumb/views/MyBook_123/Overview");
});

test("drops hits with a missing or malformed repo url", () => {
  const payload = {
    totalHits: 3,
    results: [
      { workbook: { title: "no repo" } },
      { workbook: { title: "malformed", defaultViewRepoUrl: "NoSheetsSegment" } },
      { workbook: { title: "ok", defaultViewRepoUrl: "B/sheets/V" } },
    ],
  };
  const { results, degraded } = normalizeSearchPayload(payload);
  assert.equal(results.length, 1);
  assert.equal(results[0].name, "ok");
  assert.equal(degraded, false);
});

test("zero survivors with a positive totalHits is the shape-change canary", () => {
  const payload = { totalHits: 42, results: [{ workbook: { title: "x" } }] };
  const { results, degraded, reason } = normalizeSearchPayload(payload);
  assert.equal(results.length, 0);
  assert.equal(degraded, true);
  assert.equal(reason, "shape_change");
});

test("a genuinely empty result set is not degraded", () => {
  const { results, degraded } = normalizeSearchPayload({ totalHits: 0, results: [] });
  assert.equal(results.length, 0);
  assert.equal(degraded, false);
});

test("a non-object or resultless payload is degraded, not a crash", () => {
  for (const bad of [null, undefined, "nope", 5, {}, { results: "no" }]) {
    const out = normalizeSearchPayload(bad);
    assert.equal(out.degraded, true);
    assert.equal(out.reason, "bad_payload");
    assert.deepEqual(out.results, []);
  }
});

function fakeFetch(payload, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };
  impl.calls = calls;
  return impl;
}

test("searchWorkbooks returns normalized results", async () => {
  clearSearchCache();
  const impl = fakeFetch({ totalHits: 1, results: [{ workbook: { title: "T", defaultViewRepoUrl: "B/sheets/V" } }] });
  const out = await searchWorkbooks("netflix", { fetchImpl: impl });
  assert.equal(out.degraded, false);
  assert.equal(out.results[0].url, "https://public.tableau.com/views/B/V");
  assert.match(impl.calls[0], /query=netflix/);
  assert.match(impl.calls[0], /count=10/);
});

test("an identical query is served from cache without a second fetch", async () => {
  clearSearchCache();
  const impl = fakeFetch({ totalHits: 1, results: [{ workbook: { title: "T", defaultViewRepoUrl: "B/sheets/V" } }] });
  await searchWorkbooks("Netflix", { fetchImpl: impl });
  await searchWorkbooks("  netflix  ", { fetchImpl: impl });
  assert.equal(impl.calls.length, 1, "second call should hit the cache");
});

test("a non-ok upstream status degrades instead of throwing", async () => {
  clearSearchCache();
  const impl = fakeFetch({}, { status: 429 });
  const out = await searchWorkbooks("anything", { fetchImpl: impl });
  assert.equal(out.degraded, true);
  assert.equal(out.reason, "upstream_429");
  assert.deepEqual(out.results, []);
});

test("a thrown fetch degrades instead of propagating", async () => {
  clearSearchCache();
  const impl = async () => {
    throw new Error("socket hang up");
  };
  const out = await searchWorkbooks("anything", { fetchImpl: impl });
  assert.equal(out.degraded, true);
  assert.equal(out.reason, "fetch_failed");
});

test("an empty query never reaches the network", async () => {
  clearSearchCache();
  const impl = fakeFetch({ totalHits: 0, results: [] });
  const out = await searchWorkbooks("   ", { fetchImpl: impl });
  assert.equal(impl.calls.length, 0);
  assert.deepEqual(out.results, []);
  assert.equal(out.degraded, false);
});

test("a degraded response is not cached", async () => {
  clearSearchCache();
  const bad = fakeFetch({}, { status: 500 });
  await searchWorkbooks("q", { fetchImpl: bad });
  const good = fakeFetch({ totalHits: 1, results: [{ workbook: { title: "T", defaultViewRepoUrl: "B/sheets/V" } }] });
  const out = await searchWorkbooks("q", { fetchImpl: good });
  assert.equal(out.degraded, false);
  assert.equal(good.calls.length, 1, "a failed lookup must be retried, not cached");
});
