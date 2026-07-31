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
