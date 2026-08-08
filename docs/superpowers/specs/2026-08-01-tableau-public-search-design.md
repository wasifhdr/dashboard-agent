# Tableau Public Search + Post-Open Viability Inspection

**Date:** 2026-08-01
**Status:** Approved, not yet implemented

## Problem

Dashboard Agent can only start a session on one of the 5 dashboards curated in
`backend/config.json`, or on a URL the user pastes by hand. The landing page
search box scores only those 5 entries locally. We want the search box to reach
the real Tableau Public library — match keywords against live public workbooks,
show their names, and let the user open one — without mirroring any part of that
library locally.

Unvetted workbooks bring a new risk the curated set never had: a result may be a
story, a bare worksheet, or a viz that renders nothing. The agent cannot navigate
story points (no such action exists in `actionSchema.js`), so some results are
genuinely unusable rather than merely awkward.

## Non-goals

Deliberately excluded from this spec:

- Pagination / infinite scroll of search results
- Searching Tableau Public authors (only workbooks)
- Re-ranking results by whether they can answer the user's question
- Pre-probing results before the user clicks one
- Persisting search history
- Multi-dashboard exploration (a separate, later piece of work)

## Key findings that shape the design

Verified live on 2026-08-01:

- `GET https://public.tableau.com/public/apis/bff/v1/search/query-workbooks?count=&query=&start=`
  returns 200 unauthenticated JSON. Each hit carries `title`, `description`,
  `authorDisplayName`, `authorProfileName`, `viewCount`, `numberOfFavorites`,
  and `defaultViewRepoUrl` in the form `Workbook/sheets/View`.
- Dropping `sheets/` yields `https://public.tableau.com/views/Workbook/View`,
  exactly the URL shape `config.json` already stores. Verified 200.
- `https://public.tableau.com/thumb/views/Workbook/View` returns 200 `image/png`.

This endpoint is **undocumented and internal**. It has no SLA and may change
shape without notice. Every design decision below treats it as untrusted.

Existing plumbing we reuse rather than rebuild:

- `frontend/src/screens/Landing/Landing.jsx` already debounces the query and
  already has `looksLikeUrl` + `onOpenUrl`, which opens a session on an arbitrary
  Tableau URL. Search only needs to *produce* URLs for a path that already works.
- `window.__agentBridge.getInventory()` in `backend/public/host.html` already
  returns `isDashboard`, `worksheetNames`, and `sheets[].sheetType`, which is
  everything needed to detect a story or a bare worksheet.

`backend/probe.js` is **not** reused. It launches its own browser, applies a real
filter to mutate dashboard state, and closes the browser when done. Running it
against a live session would spawn a second browser and change the state of the
dashboard the user is about to ask questions about.

## Architecture

```
Landing.jsx ──debounced q──► GET /api/search ──► tableauSearch.js ──► public.tableau.com BFF
     │                                                │
     │◄────── curated (local, unchanged) ─────────────┘ normalize + cache
     │
     └──click──► onOpenUrl(url) ──► conversationRuntime ──► inspectViz(page) ──SSE──► Watch banner
```

### Component 1 — `backend/src/tableauSearch.js` (new)

Owns the external call and normalization. No Express dependency, so the
normalization is pure and unit-testable.

`searchWorkbooks(query, { count = 10, start = 0 })` returns
`{ results, degraded, reason }`.

- Calls the BFF endpoint with a 6s `AbortController` timeout.
- Normalizes each hit into:
  `{ name, url, thumbnail, author, description, viewCount, favorites, source: "tableau-public" }`
  where `url` and `thumbnail` are derived from `defaultViewRepoUrl` as above.
- Drops any hit whose `defaultViewRepoUrl` is missing or does not match
  `<workbook>/sheets/<view>`.
- In-memory `Map` cache keyed by the normalized (trimmed, lowercased) query.
  ~5 minute TTL, capped at ~100 entries with oldest-out eviction.

### Component 2 — `GET /api/search` in `backend/src/server.js`

Query params: `q` (required), `count` (optional, default 10, clamped to 25).

**Always returns HTTP 200.** On upstream failure it returns
`{ results: [], degraded: true, reason }`. A dead third-party endpoint must never
break the landing page, so failure is data, not an HTTP error.

Thumbnails are loaded directly by the browser from `public.tableau.com` in an
`<img>` tag. The backend stays out of the image path.

### Component 3 — Landing page result group

`Landing.jsx` gains `remoteResults` and `remoteStatus`
(`idle | loading | ok | degraded`), reusing the existing `debouncedQuery`.

- Skips the fetch when `looksLikeUrl(query)` is true, or the trimmed query is
  under 3 characters.
- Aborts any in-flight request when the query changes.
- Renders curated matches first (existing component, existing scoring), then a
  labeled "From Tableau Public" divider, then remote cards showing thumbnail,
  title, author, and view count.
- Clicking a remote card calls the existing `onOpenUrl(url)`. No new session
  plumbing.
- `degraded` renders one muted line stating Tableau Public search is
  unavailable, with curated results still fully usable. Never an error screen.

`frontend/src/screens/Landing/search.js` is **not modified**. Curated scoring
stays exactly as it is.

### Component 4 — `backend/src/viability.js` (new)

`inspectViz(page, { screenshotPath })` — strictly read-only. It applies no
filters and opens no browser; it runs against the session's existing page.

Returns `{ verdict, reasons, facts }` where verdict is one of:

| Verdict | Meaning | Triggers |
|---|---|---|
| `unusable` | Agent has no path to an answer | active sheet is a story; viz never reached `FirstInteractive`; first frame is near-uniform (nothing painted) |
| `good` | No known problems | none of the above |
| `unknown` | Inspection itself failed | any thrown error, caught |

`facts` carries the raw observations: `sheetType`, `isDashboard`, sheet count,
operable-filter count, parameter count, blank-frame boolean.

**There is deliberately no "limited" verdict.** Actuation runs in pixel mode,
where `vlmClient.js:120` tells the model the inventory is reference-only and it
must act by clicking. A bridge-visible filter count therefore does not predict
whether a dashboard is workable: the agent filters by clicking a *mark* — a bar,
a row — which is not a Tableau filter object at all, so a dashboard reporting
zero filters and zero parameters can be fully operable. A bare worksheet is
likewise perfectly readable. Both counts stay in `facts` for the backend log
without becoming a user-facing warning.

What the inventory *does* contribute in pixel mode is vocabulary: filter domain
values tell the model a value exists even when it sits inside a collapsed
dropdown, which feeds the `target` string that the zoom-refine pass then tries
to locate on screen.

Dead margin (`size.behavior === "automatic"`) is deliberately **not** inspected.
It is a token-efficiency annoyance, not an answerability problem, and plenty of
automatic-sized dashboards answer reading questions perfectly well. Nothing
would consume it, so `getInventory()` in `host.html` is left untouched.

Story detection reads `sheets.find(s => s.isActive).sheetType`, already present
in the inventory payload.

No change to `backend/public/host.html` is required. Everything `inspectViz`
needs is already in the `getInventory()` payload.

### Component 5 — wiring and surfacing

`conversationRuntime.js` calls `inspectViz` after the viz reaches
`FirstInteractive`, for any dashboard URL not already listed in
`config.dashboards`. That list is a starting shortcut on the landing page, not a
privileged class — skipping it is purely a noise optimization, and every other
part of this pipeline treats all URLs identically. The call never gates or
delays the session; the dashboard is already visible by the time it resolves.

The result is emitted on the existing event channel as a `viz_inspection` event.
On the Watch screen:

- `unusable` → dismissible banner stating the specific reason, with a
  back-to-search button. Nothing is torn down; the user stays in control.
- `good` / `unknown` → nothing rendered.

## Error handling

- **Upstream shape change.** If zero results survive normalization while
  `totalHits > 0`, treat it as the API having changed shape: return `degraded`
  and log loudly. This is the primary canary.
- **Rate limiting.** Mitigated by the cache, the 3-character minimum, and the
  existing debounce. A 429 degrades like any other failure.
- **Timeout.** 6s abort, degrades.
- **Inspection failure.** `inspectViz` errors are caught and reported as
  `verdict: 'unknown'`. Inspection must never kill a session.

## Testing

- **Unit** — `tableauSearch.js` normalization against a captured real JSON
  fixture committed to the repo, so tests never hit the network. Covers: happy
  path, missing `defaultViewRepoUrl`, malformed repo URL, empty results,
  `totalHits > 0` with zero survivors (the degraded canary).
- **Unit** — `viability.js` verdict derivation against hand-written inventory
  fixtures for each verdict.
- **Live canary** — one opt-in integration test asserting the real endpoint still
  returns the fields we depend on. Not run in the normal suite.
- **Manual** — start all three processes, type "netflix", confirm both result
  groups render, click a Tableau Public result, confirm the session opens and the
  inspection banner behaves. Check `read_console_messages` and
  `read_network_requests` for errors.

## Open risks

- The BFF endpoint is undocumented and can break at any time. Mitigated by
  graceful degradation to the curated set, plus the shape-change canary.
- Search relevance is keyword matching over title and description. It does not
  know whether a dashboard contains the data to answer a question.
- Viability inspection cannot detect small or ambiguous click targets (the
  known pixel-mode loop failure) or decoy controls. Neither is exposed by the
  Embedding API.
