# Tableau Public Search + Viability Inspection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the landing-page search box find live dashboards on Tableau Public and open a session on any of them, with a read-only check afterwards that tells the user when the dashboard it opened is one the agent cannot work.

**Architecture:** A backend module wraps Tableau Public's undocumented search endpoint, normalizes each hit into the `public.tableau.com/views/<Workbook>/<View>` URL shape the app already opens, and caches briefly. A route exposes it, always returning HTTP 200 so an upstream failure degrades to the existing local results instead of breaking the page. Separately, a read-only inspector runs against the already-open session page and broadcasts a verdict over the existing live WebSocket.

**Tech Stack:** Node 20+ ESM, Express 5, `node:test` + `node:assert/strict`, Playwright, `sharp` (already a dependency), React 18 + Vite + Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-08-01-tableau-public-search-design.md`

## Global Constraints

- **No new dependencies.** Everything needed is already in `backend/package.json` and `frontend/package.json`. `fetch` is global in Node 20+.
- **Do not modify the frozen agent core:** `backend/src/vlmClient.js`, `backend/src/actionSchema.js`, `backend/src/actuator.js`, `backend/src/perception.js`, `backend/eval/`.
- **Do not modify `backend/public/host.html`.** Everything the inspector needs is reachable without it.
- **Do not modify `frontend/src/screens/Landing/search.js`.** Local scoring over `config.dashboards` stays exactly as-is.
- Backend is ESM (`"type": "module"`) — use `import`, always with the `.js` extension on relative paths.
- Tests are the Node built-in runner. Run with `npm test` from `backend/`, which is `node --test test/*.test.js`.
- `GET /api/search` **must never return a non-200 status.** Failure is reported in the body as `degraded: true`.
- The inspector is **strictly read-only**: it must never apply a filter, activate a sheet, or close anything.
- Backend runs on `:8990`, frontend dev server on `:5173`. Vite already proxies `/api` to the backend.
- Work happens on the `master` branch. Commit after every task.

---

### Task 1: Normalize Tableau Public search results

Pure transformation from the raw upstream JSON into the app's dashboard shape. No network in this task — network lands in Task 2.

**Files:**
- Create: `backend/src/tableauSearch.js`
- Create: `backend/test/fixtures/tableau-search-netflix.json`
- Create: `backend/test/tableauSearch.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `normalizeSearchPayload(payload) -> { results: Array<Result>, degraded: boolean, reason: string|null }` where `Result` is
  `{ name: string, url: string, thumbnail: string, author: string, description: string, viewCount: number, favorites: number, source: "tableau-public" }`.
  Task 2 calls this; Task 3 serves its output verbatim.

- [ ] **Step 1: Capture a real upstream response as a test fixture**

This is the only step that touches the network. It pins today's real shape so tests never depend on Tableau being up.

```bash
curl -s "https://public.tableau.com/public/apis/bff/v1/search/query-workbooks?count=5&query=netflix&start=0" -o backend/test/fixtures/tableau-search-netflix.json
```

Then confirm it is real JSON containing the field the whole design depends on:

```bash
node -e "const j=require('./backend/test/fixtures/tableau-search-netflix.json');console.log(j.results.length, j.totalHits, j.results[0].workbook.defaultViewRepoUrl)"
```

Expected: a count of 5, a large `totalHits`, and a string shaped like `Netflix_15774858118320/sheets/NetflixIMDbDetail`.

- [ ] **Step 2: Write the failing tests**

Create `backend/test/tableauSearch.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSearchPayload } from "../src/tableauSearch.js";

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
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd backend && node --test test/tableauSearch.test.js
```

Expected: FAIL — `Cannot find module '../src/tableauSearch.js'`.

- [ ] **Step 4: Write the implementation**

Create `backend/src/tableauSearch.js`:

```js
// Live search against Tableau Public's public (but undocumented, internal)
// search endpoint. Verified 2026-08-01:
//   GET /public/apis/bff/v1/search/query-workbooks?count=&query=&start=
// returns { results: [{ workbook: {...} }], totalHits, facets }.
//
// This endpoint has no SLA and can change shape without notice, so every
// consumer treats it as untrusted: normalization drops anything it cannot
// fully understand, and a shape change degrades to the local dashboard list
// rather than erroring.

const VIEWS_BASE = "https://public.tableau.com/views";
const THUMB_BASE = "https://public.tableau.com/thumb/views";

// "Workbook_123/sheets/ViewName" -> ["Workbook_123", "ViewName"]. Tableau's
// own /views/ URLs simply omit the "sheets/" segment.
const REPO_URL = /^([^/]+)\/sheets\/([^/]+)$/;

function normalizeOne(entry) {
  const wb = entry?.workbook;
  if (!wb) return null;

  const match = REPO_URL.exec(wb.defaultViewRepoUrl ?? "");
  if (!match) return null;
  const [, workbook, view] = match;

  return {
    name: (wb.title ?? "").trim() || workbook,
    url: `${VIEWS_BASE}/${workbook}/${view}`,
    thumbnail: `${THUMB_BASE}/${workbook}/${view}`,
    author: wb.authorDisplayName ?? wb.authorProfileName ?? "",
    description: (wb.description ?? "").trim(),
    viewCount: Number(wb.viewCount ?? 0),
    favorites: Number(wb.numberOfFavorites ?? 0),
    source: "tableau-public",
  };
}

export function normalizeSearchPayload(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.results)) {
    return { results: [], degraded: true, reason: "bad_payload" };
  }

  const results = payload.results.map(normalizeOne).filter(Boolean);

  // Upstream said it had matches but none survived normalization: the response
  // shape changed under us. This is the primary canary for the endpoint moving.
  if (results.length === 0 && Number(payload.totalHits ?? 0) > 0) {
    return { results: [], degraded: true, reason: "shape_change" };
  }

  return { results, degraded: false, reason: null };
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd backend && node --test test/tableauSearch.test.js
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add backend/src/tableauSearch.js backend/test/tableauSearch.test.js backend/test/fixtures/tableau-search-netflix.json
git commit -m "feat(search): normalize Tableau Public search results into openable dashboards"
```

---

### Task 2: Fetch, time out, and cache

Adds the network call around Task 1's normalizer. `fetch` is injectable so tests stay offline.

**Files:**
- Modify: `backend/src/tableauSearch.js` (append)
- Modify: `backend/test/tableauSearch.test.js` (append)

**Interfaces:**
- Consumes: `normalizeSearchPayload` from Task 1.
- Produces: `searchWorkbooks(query, { count = 10, start = 0, fetchImpl = globalThis.fetch }) -> Promise<{ results, degraded, reason }>` and `clearSearchCache()` (test hook). Task 3 calls `searchWorkbooks`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/tableauSearch.test.js`:

```js
import { searchWorkbooks, clearSearchCache } from "../src/tableauSearch.js";

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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd backend && node --test test/tableauSearch.test.js
```

Expected: FAIL — `searchWorkbooks is not a function` (Task 1's tests still pass).

- [ ] **Step 3: Write the implementation**

Append to `backend/src/tableauSearch.js`:

```js
const SEARCH_ENDPOINT = "https://public.tableau.com/public/apis/bff/v1/search/query-workbooks";
const TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 100;

// query -> { at: epochMs, value }. Insertion-ordered, so the oldest key is
// always the first key when we need to evict.
const cache = new Map();

export function clearSearchCache() {
  cache.clear();
}

function cacheKey(query, count, start) {
  return `${query}|${count}|${start}`;
}

function readCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function writeCache(key, value) {
  if (cache.size >= CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, { at: Date.now(), value });
}

export async function searchWorkbooks(query, options = {}) {
  const { count = 10, start = 0, fetchImpl = globalThis.fetch } = options;
  const normalizedQuery = String(query ?? "").trim().toLowerCase();

  if (!normalizedQuery) {
    return { results: [], degraded: false, reason: null };
  }

  const key = cacheKey(normalizedQuery, count, start);
  const cached = readCache(key);
  if (cached) return cached;

  const url =
    `${SEARCH_ENDPOINT}?count=${encodeURIComponent(count)}` +
    `&query=${encodeURIComponent(normalizedQuery)}&start=${encodeURIComponent(start)}`;

  let payload;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      if (!res.ok) {
        return { results: [], degraded: true, reason: `upstream_${res.status}` };
      }
      payload = await res.json();
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    // Abort, DNS failure, socket reset, malformed JSON - all the same to a
    // caller that just wants to fall back to the local dashboard list.
    return { results: [], degraded: true, reason: "fetch_failed" };
  }

  const out = normalizeSearchPayload(payload);
  // Only cache success; a degraded lookup must be retried next keystroke.
  if (!out.degraded) writeCache(key, out);
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd backend && node --test test/tableauSearch.test.js
```

Expected: PASS, 12 tests.

- [ ] **Step 5: Run the whole suite to confirm nothing regressed**

```bash
cd backend && npm test
```

Expected: PASS across all files.

- [ ] **Step 6: Commit**

```bash
git add backend/src/tableauSearch.js backend/test/tableauSearch.test.js
git commit -m "feat(search): add cached, timeout-bounded Tableau Public fetch"
```

---

### Task 3: Expose `GET /api/search`

**Files:**
- Modify: `backend/src/server.js` (add a route immediately after the `/api/config` handler at line 49-51)

**Interfaces:**
- Consumes: `searchWorkbooks` from Task 2.
- Produces: `GET /api/search?q=<string>&count=<int>` → always HTTP 200, body
  `{ results: Result[], degraded: boolean, reason: string|null }`. Task 4 consumes this.

- [ ] **Step 1: Add the import**

In `backend/src/server.js`, alongside the existing imports around line 15:

```js
import { searchWorkbooks } from "./tableauSearch.js";
```

- [ ] **Step 2: Add the route**

Insert directly after the `/api/config` handler:

```js
// Live keyword search against Tableau Public. Deliberately always 200: this
// proxies an undocumented third-party endpoint, and the landing page must stay
// fully usable (local results, paste-a-URL) when it is down or has changed
// shape. Failure is reported in the body as degraded:true.
app.get("/api/search", async (req, res) => {
  const q = String(req.query.q ?? "");
  const count = Math.min(Math.max(Number(req.query.count ?? 10) || 10, 1), 25);
  const out = await searchWorkbooks(q, { count });
  if (out.degraded) {
    console.warn(`[search] degraded (${out.reason}) for query ${JSON.stringify(q)}`);
  }
  res.json(out);
});
```

- [ ] **Step 3: Start the backend and verify the route by hand**

```bash
cd backend && npm run dev
```

Wait for the real listening banner (`server.js` gates it on `address()` — if you see a port diagnostic instead, fix the port before continuing; see README Troubleshooting).

In a second terminal:

```bash
curl -s "http://127.0.0.1:8990/api/search?q=netflix&count=3"
```

Expected: HTTP 200 JSON with `"degraded":false` and 3 results, each having a `url` under `https://public.tableau.com/views/`.

- [ ] **Step 4: Verify the empty-query case**

```bash
curl -s -w "\nHTTP:%{http_code}\n" "http://127.0.0.1:8990/api/search?q="
```

Expected: `HTTP:200` and `{"results":[],"degraded":false,"reason":null}`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/server.js
git commit -m "feat(search): expose GET /api/search, always 200"
```

---

### Task 4: Render Tableau Public results on the landing page

A sibling group below the existing carousel. `search.js` and `DashboardCarousel.jsx` are untouched.

**Files:**
- Create: `frontend/src/screens/Landing/TableauResults.jsx`
- Modify: `frontend/src/screens/Landing/Landing.jsx`

**Interfaces:**
- Consumes: `GET /api/search` from Task 3; the `debouncedQuery` state and `openDashboard(url, name)` function already present in `Landing.jsx`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Create the results component**

Create `frontend/src/screens/Landing/TableauResults.jsx`:

```jsx
// Live results from Tableau Public, rendered as a second group beneath the
// locally-scored dashboards. Thumbnails load straight from public.tableau.com;
// the backend stays out of the image path.

export default function TableauResults({ status, results, onOpenUrl }) {
  if (status === "idle") return null;

  if (status === "degraded") {
    return (
      <p className="mt-6 text-sm text-fg/50">
        Tableau Public search is unavailable right now.
      </p>
    );
  }

  if (status === "loading" && results.length === 0) {
    return <p className="mt-6 text-sm text-fg/50">Searching Tableau Public…</p>;
  }

  if (results.length === 0) return null;

  return (
    <div className="mt-8">
      <h3 className="mb-3 text-label uppercase text-fg/70">From Tableau Public</h3>
      <ul className="space-y-2">
        {results.map((r) => (
          <li key={r.url}>
            <button
              type="button"
              onClick={() => onOpenUrl(r.url)}
              className="flex w-full items-center gap-3 rounded-lg border border-fg/10 p-2 text-left transition hover:border-teal-ink/40 hover:bg-fg/5"
            >
              <img
                src={r.thumbnail}
                alt=""
                loading="lazy"
                className="h-12 w-20 shrink-0 rounded object-cover bg-fg/5"
                onError={(e) => {
                  e.currentTarget.style.visibility = "hidden";
                }}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-fg">{r.name}</span>
                <span className="block truncate text-xs text-fg/60">
                  {r.author}
                  {r.viewCount ? ` · ${r.viewCount.toLocaleString()} views` : ""}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into Landing.jsx — imports and state**

Add the import next to the other Landing imports:

```jsx
import TableauResults from "./TableauResults.jsx";
```

Add state beside the existing `query` / `debouncedQuery` declarations (near line 17-18):

```jsx
const [remoteResults, setRemoteResults] = useState([]);
const [remoteStatus, setRemoteStatus] = useState("idle");
```

- [ ] **Step 3: Wire it into Landing.jsx — the fetch effect**

Add after the existing debounce effect (the one ending near line 27). It reuses `debouncedQuery`, so it inherits the debounce already in place.

```jsx
// Live Tableau Public lookup. Skipped for URL-shaped input (that has its own
// open-directly path) and for very short queries, which would return noise and
// hammer an undocumented endpoint.
useEffect(() => {
  const q = debouncedQuery.trim();
  if (looksLikeUrl(q) || q.length < 3) {
    setRemoteResults([]);
    setRemoteStatus("idle");
    return;
  }

  const controller = new AbortController();
  setRemoteStatus("loading");

  fetch(`/api/search?q=${encodeURIComponent(q)}&count=8`, { signal: controller.signal })
    .then((r) => r.json())
    .then((data) => {
      setRemoteResults(data.results ?? []);
      setRemoteStatus(data.degraded ? "degraded" : "ok");
    })
    .catch((e) => {
      if (e.name === "AbortError") return;
      setRemoteResults([]);
      setRemoteStatus("degraded");
    });

  return () => controller.abort();
}, [debouncedQuery]);
```

- [ ] **Step 4: Wire it into Landing.jsx — render**

Directly after the `<DashboardCarousel .../>` block (closing `</div>` near line 154), inside the same right-hand column:

```jsx
<div className="hero-rise">
  <TableauResults
    status={remoteStatus}
    results={remoteResults}
    onOpenUrl={(url) => openDashboard(url, null)}
  />
</div>
```

- [ ] **Step 5: Verify in the browser**

Backend must be running from Task 3. Start the frontend with the preview tool (`preview_start({name: "frontend"})`), then:

1. Type `netflix` in "Find a dashboard".
2. Expected: the existing curated match appears first, then a "From Tableau Public" heading with up to 8 results carrying thumbnails and author names.
3. Type `ne` (two characters). Expected: the Tableau Public group disappears entirely.
4. Paste a full `https://public.tableau.com/views/...` URL into the search box. Expected: no Tableau Public group (URL input has its own path).
5. Check `read_console_messages` and `read_network_requests` — expect no errors, and exactly one `/api/search` request per settled query, not one per keystroke.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/screens/Landing/TableauResults.jsx frontend/src/screens/Landing/Landing.jsx
git commit -m "feat(search): show live Tableau Public results on the landing page"
```

---

### Task 5: Derive a viability verdict

Pure decision logic, separated from anything touching Playwright so it is fully testable.

**Files:**
- Create: `backend/src/viability.js`
- Create: `backend/test/viability.test.js`

**Interfaces:**
- Consumes: the normalized inventory shape produced by `backend/src/inventory.js` — `{ isDashboard: boolean, sheets: Array<{name, index, isActive, isHidden, sheetType}>, filters: Array<{operable: boolean, ...}>, parameters: Array<...> }`.
- Produces: `deriveVerdict({ activeSheetType, inventory, blankFrame }) -> { verdict, reasons, facts }` where `verdict` is `"good" | "unusable" | "unknown"`. Task 6 calls this.

**Why there is no "limited" verdict.** Actuation runs in pixel mode
(`config.actuationMode === "pixel"`), where `vlmClient.js:120` tells the model
the inventory is reference-only and it must act by clicking. So a bridge-visible
filter count does not predict whether a dashboard is workable — the agent
filters by clicking a *mark* (a bar, a row), which is not a Tableau filter
object at all. A dashboard with zero filters and zero parameters can be fully
operable. Counts stay in `facts` for the backend log; they do not drive a
verdict.

- [ ] **Step 1: Write the failing tests**

Create `backend/test/viability.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { deriveVerdict } from "../src/viability.js";

function inventory(overrides = {}) {
  return {
    isDashboard: true,
    sheets: [{ name: "D", index: 0, isActive: true, isHidden: false, sheetType: "dashboard" }],
    filters: [{ operable: true }, { operable: true }],
    parameters: [],
    ...overrides,
  };
}

test("a healthy dashboard is good", () => {
  const out = deriveVerdict({ activeSheetType: "dashboard", inventory: inventory(), blankFrame: false });
  assert.equal(out.verdict, "good");
  assert.deepEqual(out.reasons, []);
});

test("a story is unusable - the agent has no action that advances story points", () => {
  const out = deriveVerdict({ activeSheetType: "story", inventory: null, blankFrame: false });
  assert.equal(out.verdict, "unusable");
  assert.deepEqual(out.reasons, ["story"]);
});

test("a blank frame is unusable and outranks everything else", () => {
  const out = deriveVerdict({ activeSheetType: "dashboard", inventory: inventory(), blankFrame: true });
  assert.equal(out.verdict, "unusable");
  assert.deepEqual(out.reasons, ["blank_frame"]);
});

test("a bare worksheet is still good - it is readable and clickable", () => {
  const out = deriveVerdict({
    activeSheetType: "worksheet",
    inventory: inventory({ isDashboard: false }),
    blankFrame: false,
  });
  assert.equal(out.verdict, "good");
});

test("zero bridge-visible controls is still good - pixel mode clicks marks", () => {
  const out = deriveVerdict({
    activeSheetType: "dashboard",
    inventory: inventory({ filters: [{ operable: false }], parameters: [] }),
    blankFrame: false,
  });
  assert.equal(out.verdict, "good");
  assert.equal(out.facts.operableControlCount, 0, "still reported as a fact");
});

test("a missing inventory on a non-story is unknown, not a guess", () => {
  const out = deriveVerdict({ activeSheetType: "dashboard", inventory: null, blankFrame: false });
  assert.equal(out.verdict, "unknown");
});

test("facts report what was observed", () => {
  const out = deriveVerdict({
    activeSheetType: "dashboard",
    inventory: inventory({ sheets: [{ isActive: true, sheetType: "dashboard" }, { sheetType: "dashboard" }] }),
    blankFrame: false,
  });
  assert.equal(out.facts.sheetCount, 2);
  assert.equal(out.facts.operableControlCount, 2);
  assert.equal(out.facts.isDashboard, true);
  assert.equal(out.facts.activeSheetType, "dashboard");
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd backend && node --test test/viability.test.js
```

Expected: FAIL — `Cannot find module '../src/viability.js'`.

- [ ] **Step 3: Write the decision logic**

Create `backend/src/viability.js` with just this much for now (the Playwright half lands in Task 6):

```js
// Read-only viability check for a dashboard the user opened from search.
// Unlike probe.js this applies no filters, opens no browser, and closes
// nothing - it inspects the session's own live page and reports.
//
// The point is narrow: tell the user when the thing they opened is something
// the agent structurally cannot work, before they spend a question on it.

export function deriveVerdict({ activeSheetType, inventory, blankFrame }) {
  const facts = {
    activeSheetType: activeSheetType ?? null,
    isDashboard: inventory?.isDashboard ?? null,
    sheetCount: inventory?.sheets?.length ?? null,
    operableControlCount: inventory
      ? (inventory.filters ?? []).filter((f) => f.operable).length + (inventory.parameters ?? []).length
      : null,
    blankFrame: Boolean(blankFrame),
  };

  // Nothing painted: whatever else is true, there is nothing to read.
  if (blankFrame) {
    return { verdict: "unusable", reasons: ["blank_frame"], facts };
  }

  // No action in actionSchema.js advances a story point, so a story is
  // structurally unusable rather than merely awkward. Checked before the
  // inventory because getInventory() itself throws on a story sheet.
  if (activeSheetType === "story") {
    return { verdict: "unusable", reasons: ["story"], facts };
  }

  // Everything below needs an inventory; without one we genuinely don't know.
  if (!inventory) {
    return { verdict: "unknown", reasons: ["no_inventory"], facts };
  }

  // Nothing else predicts failure in pixel mode. A bare worksheet is readable,
  // and a dashboard with no bridge-visible filters is still clickable - the
  // agent filters by clicking marks, not by operating filter objects. Those
  // counts stay in `facts` for the log rather than becoming a warning.
  return { verdict: "good", reasons: [], facts };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd backend && node --test test/viability.test.js
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/viability.js backend/test/viability.test.js
git commit -m "feat(viability): derive a read-only usability verdict for a dashboard"
```

---

### Task 6: Inspect the live page

The Playwright half. Order matters: read the sheet type off the DOM element **before** calling the bridge, because `getInventory()` in `host.html:123` calls `getRawFilters()` unguarded and a Story object has no `getFiltersAsync` — on a story the bridge call throws.

**Files:**
- Modify: `backend/src/viability.js` (append)

**Interfaces:**
- Consumes: `deriveVerdict` from Task 5; `screenshotViz` from `backend/src/perception.js` (import only, no modification); `createInventoryTracker` from `backend/src/inventory.js`; `sharp`.
- Produces: `inspectViz(page, { screenshotPath }) -> Promise<{ verdict, reasons, facts }>`. Task 7 calls this.

- [ ] **Step 1: Append the imports**

At the top of `backend/src/viability.js`:

```js
import fs from "node:fs";
import sharp from "sharp";
import { screenshotViz } from "./perception.js";
import { createInventoryTracker } from "./inventory.js";
```

- [ ] **Step 2: Append the implementation**

```js
// A frame where every channel is essentially constant means the viz element
// exists but painted nothing (deleted extract, auth wall, error tile). Real
// dashboards have text and marks, so their standard deviation is far above this.
const BLANK_STDEV_MAX = 2;

async function isBlankFrame(imagePath) {
  try {
    const { channels } = await sharp(imagePath).stats();
    return channels.every((c) => c.stdev < BLANK_STDEV_MAX);
  } catch {
    // Unreadable screenshot is not evidence of blankness.
    return false;
  }
}

// Read the active sheet's type straight off the embed element. Deliberately
// does NOT go through __agentBridge.getInventory(), which calls getFiltersAsync
// unguarded and therefore throws on a Story - the exact case we most need to
// detect. The element id is "agentViz", never "viz" (Tableau's own internal
// iframe reuses "viz").
async function readActiveSheetType(page) {
  try {
    return await page.evaluate(() => {
      const el = document.getElementById("agentViz");
      return el?.workbook?.activeSheet?.sheetType ?? null;
    });
  } catch {
    return null;
  }
}

export async function inspectViz(page, { screenshotPath }) {
  try {
    const activeSheetType = await readActiveSheetType(page);

    // Short-circuit before touching the bridge: on a story it would throw.
    if (activeSheetType === "story") {
      return deriveVerdict({ activeSheetType, inventory: null, blankFrame: false });
    }

    await screenshotViz(page, screenshotPath);
    const blankFrame = await isBlankFrame(screenshotPath);

    let inventory = null;
    try {
      const raw = await page.evaluate(() => window.__agentBridge.getInventory());
      inventory = createInventoryTracker().normalize(raw);
    } catch {
      // Leave null - deriveVerdict reports "unknown" rather than guessing.
    }

    return deriveVerdict({ activeSheetType, inventory, blankFrame });
  } catch (e) {
    // Inspection is advisory. It must never take a session down.
    return {
      verdict: "unknown",
      reasons: ["inspection_failed"],
      facts: { error: e.message },
    };
  } finally {
    fs.rm(screenshotPath, { force: true }, () => {});
  }
}
```

- [ ] **Step 3: Verify the existing tests still pass**

```bash
cd backend && npm test
```

Expected: PASS. `deriveVerdict` is unchanged, so all 8 Task 5 tests still pass; the new code is exercised in Task 8.

- [ ] **Step 4: Commit**

```bash
git add backend/src/viability.js
git commit -m "feat(viability): inspect the live page without touching the bridge on stories"
```

---

### Task 7: Broadcast the verdict and show it

Wires the inspector into the runtime and surfaces it using the two banner patterns `Watch.jsx` already has.

**Files:**
- Modify: `backend/src/conversationRuntime.js` (after the `page.once("crash", ...)` block at lines 116-118)
- Modify: `frontend/src/api.js` (the switch at lines 163-184)
- Modify: `frontend/src/screens/Watch/useLiveChannel.js` (the handlers object at lines 96-131)
- Modify: `frontend/src/screens/Watch/warningLabels.js`
- Modify: `frontend/src/screens/Watch/Watch.jsx` (after the connection banner at lines 408-415)

**Interfaces:**
- Consumes: `inspectViz` from Task 6; the module-internal `broadcast(msg)` in `conversationRuntime.js`.
- Produces: a live-channel message `{ type: "inspection", verdict, reasons }`, surfaced as `live.inspection` from `useLiveChannel`.

- [ ] **Step 1: Backend — import and fire the inspection**

In `backend/src/conversationRuntime.js`, add to the imports:

```js
import { inspectViz } from "./viability.js";
import { FRAMES_DIR } from "./paths.js";
```

(`FRAMES_DIR` may already be imported — check before adding a duplicate.)

Then, immediately after the `page.once("crash", ...)` block, add:

```js
  // Advisory viability check for dashboards that didn't come from the local
  // list. Fire-and-forget by design: the dashboard is already on screen, and
  // this must never gate, delay, or fail the session.
  const isLocallyListed = (config.dashboards ?? []).some((d) => d.url === dashboardUrl);
  if (!isLocallyListed) {
    inspectViz(page, { screenshotPath: path.join(FRAMES_DIR, `_inspect_${id}.png`) })
      .then((result) => {
        broadcast({ type: "inspection", verdict: result.verdict, reasons: result.reasons });
        console.log(`[viability] ${dashboardUrl} -> ${result.verdict} ${JSON.stringify(result.reasons)}`);
      })
      .catch(() => {});
  }
```

`broadcast` is declared below this point in the file but is a hoisted function declaration, so calling it from an async callback that resolves later is safe. Confirm `path` is imported in this file; add `import path from "node:path";` if not.

- [ ] **Step 2: Frontend — route the new message type**

In `frontend/src/api.js`, add a case to the switch inside `openLiveChannel`, before `default`:

```js
      case "inspection":
        handlers.onInspection?.(evt.verdict, evt.reasons);
        break;
```

- [ ] **Step 3: Frontend — expose it from the live channel hook**

In `frontend/src/screens/Watch/useLiveChannel.js`, add state beside the other `useState` declarations:

```js
  const [inspection, setInspection] = useState(null);
```

Add a handler to the handlers object passed to `openLiveChannel`:

```js
        onInspection: (verdict, reasons) => setInspection({ verdict, reasons }),
```

Add `inspection` to the object the hook returns, and add `setInspection(null)` wherever the hook resets per-conversation state on `conversationId` change, so a verdict never leaks across conversations.

- [ ] **Step 4: Frontend — add the reason copy**

In `frontend/src/screens/Watch/warningLabels.js`, append:

```js
// Verdict reasons from the read-only viability inspection (viability.js).
// Only "unusable" reasons need copy - "good" and "unknown" render nothing.
export const INSPECTION_LABEL = {
  story: "This is a Tableau story, not a dashboard - the agent can't advance story points, so it can't work this one.",
  blank_frame: "This dashboard loaded but rendered nothing - the data source may have been removed.",
};
```

- [ ] **Step 5: Frontend — render the banner**

In `frontend/src/screens/Watch/Watch.jsx`, extend the existing import:

```jsx
import { WARNING_LABEL, INSPECTION_LABEL } from "./warningLabels.js";
```

Add dismissal state beside the other Watch state:

```jsx
const [inspectionDismissed, setInspectionDismissed] = useState(false);
```

Then insert this immediately after the `showConnectionBanner` block (after line 415). Only `unusable` renders anything at all; `good` and `unknown` are silent.

```jsx
      {live.inspection?.verdict === "unusable" && !inspectionDismissed && (
        <div className="flex items-center justify-between gap-3 border-b border-coral/30 bg-coral/10 px-6 py-2 text-sm text-coral-ink">
          <span>
            {INSPECTION_LABEL[live.inspection.reasons[0]] ?? "The agent may not be able to work this dashboard."}
          </span>
          <span className="flex shrink-0 gap-2">
            <Button size="sm" onClick={handleEndSession}>
              Back to search
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setInspectionDismissed(true)}>
              Dismiss
            </Button>
          </span>
        </div>
      )}
```

"Back to search" reuses the existing `handleEndSession` (defined around line 303) rather than navigating directly. This matters: `handleEndSession` calls `stream.stopAndLeave()` before `onEnd?.()`, which closes the live dashboard on the backend. Navigating away without it would leave the Playwright page open and the conversation runtime alive. The confirm dialog it raises is correct here — leaving really does end the session.

Do not introduce `react-router` or any new navigation mechanism. `Watch` receives `onBack` and `onEnd` as props; that is the whole navigation surface.

- [ ] **Step 6: Commit**

```bash
git add backend/src/conversationRuntime.js frontend/src/api.js frontend/src/screens/Watch/useLiveChannel.js frontend/src/screens/Watch/warningLabels.js frontend/src/screens/Watch/Watch.jsx
git commit -m "feat(viability): broadcast the verdict and surface it on Watch"
```

---

### Task 8: End-to-end verification

No new code. This is the task that proves the feature actually works, per CLAUDE.md's rule that anything observable in the browser gets run, not just typechecked.

**Files:** none.

**Interfaces:** none.

- [ ] **Step 1: Start all three processes**

In order, so llama's load time hides behind the rest:

```bash
powershell -File backend/scripts/start-llama.ps1
```

Wait for `main: server is listening`, then confirm:

```bash
curl -s http://127.0.0.1:8080/health
```

Expected: `{"status":"ok"}`.

Then `cd backend && npm run dev`, and start the frontend via `preview_start({name: "frontend"})`.

- [ ] **Step 2: Verify the known-good path still works**

Open `:5173`, pick **Video Game Sales** from the local list, and ask:

> In the Top 5 Publishers chart, which publisher has the highest total sales?

Expected: answers **Nintendo** in one step, and **no inspection banner appears** (this URL is in `config.dashboards`, so inspection is skipped).

- [ ] **Step 3: Verify search → open on a real Tableau Public result**

Back on the landing page, type `netflix`, pick a result from the "From Tableau Public" group, and ask it any reading question about a chart you can see.

Expected: the session opens, the dashboard renders, and any banner that appears matches what you actually see on screen.

- [ ] **Step 4: Verify the story path — the case this was built for**

Use this URL, verified as a story against this exact stack on 2026-08-01:

```
https://public.tableau.com/views/HartfordYoungChildrenDataStory/DataStory
```

Paste it into the "Or open a Tableau Public link" field on the landing page.

Measured behaviour of this URL through `openSession` + the host page:
- it loads successfully and reaches `FirstInteractive`
- `document.getElementById("agentViz").workbook.activeSheet.sheetType` === `"story"`
- `window.__agentBridge.getInventory()` **throws** `TypeError: worksheets[0].getFiltersAsync is not a function`

That last point is the whole reason Task 6 reads the sheet type before calling
the bridge. If you inverted the order, this dashboard would report `unknown`
instead of `unusable` and the banner would never appear.

Expected: the story appears on screen, then within a few seconds a coral banner
reads "This is a Tableau story, not a dashboard…" with "Back to search" and
"Dismiss". The backend logs `[viability] <url> -> unusable ["story"]`. Confirm
"Dismiss" hides the banner and leaves the session running, and that "Back to
search" prompts the end-session confirm and then returns to the landing page.

Do **not** substitute a workbook merely because its name contains "story".
`SevenDataStoryTypes` contains story sheets but its default view opens as a
`dashboard`, so it does not exercise this path.

- [ ] **Step 5: Verify graceful degradation**

Simulate the endpoint being gone. Temporarily edit `SEARCH_ENDPOINT` in `backend/src/tableauSearch.js` to a bad host (e.g. `https://public.tableau.invalid/nope`), restart the backend, and search for `netflix`.

Expected: local results still render normally, and the muted line "Tableau Public search is unavailable right now." appears instead of the results group. **No error screen, no blank page, no console exception.** Revert the edit and restart.

- [ ] **Step 6: Check for errors**

Run `read_console_messages` and `read_network_requests` on the preview.

Expected: no uncaught exceptions. `/api/search` returns 200 in every case, including the degraded run from Step 5.

- [ ] **Step 7: Run the full test suite**

```bash
cd backend && npm test
```

Expected: PASS across all files, 19 new tests included.

- [ ] **Step 8: Update project documentation**

Add a line to `README.md` describing live Tableau Public search, and update `CLAUDE.md`'s backend module map with `tableauSearch.js` and `viability.js`. While in `CLAUDE.md`, fix the stale claim that the repo has zero commits.

```bash
git add README.md CLAUDE.md
git commit -m "docs: record Tableau Public search and viability inspection"
```

---

## Notes for the implementer

- **Why `/api/search` never returns an error status.** It proxies an undocumented internal endpoint with no SLA. A 500 here would break the landing page for a dependency the app doesn't control. Degradation is the contract, not a shortcut.
- **Why the sheet type is read off the DOM element.** `getInventory()` calls `getRawFilters()` without a guard at `host.html:123`, and a Story has no `getFiltersAsync`. Detecting a story through the bridge would mean catching a `TypeError` and inferring the cause. Reading `activeSheet.sheetType` directly is both cheaper and unambiguous — and needs no change to `host.html`, which sits next to the frozen agent core.
- **Why the verdict is so narrow.** Actuation is pixel mode, where the inventory
  is reference-only (`vlmClient.js:120`) and the stable `F*`/`P*`/`S*` ids and
  the `operable` flag are unused — they exist to gate bridge actions the pixel
  path never emits. What the inventory contributes in pixel mode is *vocabulary*:
  filter domain values tell the model that a value exists even when it's inside
  a collapsed dropdown, which feeds the `target` string that the zoom-refine
  pass then tries to locate. So the inspector only flags what genuinely blocks
  the agent — a story it cannot navigate, or a frame with nothing on it.
- **Why `probe.js` is not reused.** It launches its own browser, applies a real filter to mutate state, and closes the browser when finished. All three are wrong for a live session.
- **The `config.dashboards` skip is an optimization, not an architecture.** Those entries are a starting shortcut on the landing page. Every other part of this feature treats all dashboard URLs identically, and it should stay that way.
