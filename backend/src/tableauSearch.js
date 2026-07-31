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
