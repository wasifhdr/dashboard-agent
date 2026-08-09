// Accepts the Tableau Public URL a human actually has, and returns the one the
// embedding API can load.
//
// Tableau Public serves the same viz under two shapes:
//   browse: https://public.tableau.com/app/profile/<profile>/viz/<workbook>/<view>
//   embed:  https://public.tableau.com/views/<workbook>/<view>
// The address bar shows the FIRST while you are looking at a viz, so that is
// what gets copied and pasted - but <tableau-viz> can only load the second.
//
// Left unrewritten, a browse URL is not a fast, clear error: the viz simply
// never reports interactive, so the open burns openSession's full 90s timeout
// and then fails. tableauSearch.js already normalizes its own results into the
// /views/ shape; this is the same rule applied to user-supplied input.

const TABLEAU_HOSTS = new Set(["public.tableau.com", "www.public.tableau.com"]);

// /app/profile/<profile>/viz/<workbook>/<view>[/...] - trailing segments (and
// the query string) are viewer state, not part of the embed URL.
const BROWSE_PATH = /^\/app\/profile\/[^/]+\/viz\/([^/]+)\/([^/]+)/;

// Returns { url, rewritten }. Never throws: anything it does not fully
// recognize is passed through untouched, on the same "drop what you cannot
// understand" principle as normalizeSearchPayload.
export function normalizeTableauViewUrl(raw) {
  if (typeof raw !== "string" || !raw) return { url: raw, rewritten: false };

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { url: raw, rewritten: false };
  }

  if (!TABLEAU_HOSTS.has(parsed.hostname.toLowerCase())) return { url: raw, rewritten: false };

  const match = BROWSE_PATH.exec(parsed.pathname);
  if (!match) return { url: raw, rewritten: false };

  const [, workbook, view] = match;
  return { url: `https://public.tableau.com/views/${workbook}/${view}`, rewritten: true };
}
