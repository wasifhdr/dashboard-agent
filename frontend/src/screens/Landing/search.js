// Client-side keyword scoring over dashboard metadata (FRONTEND_PLAN.md §5.2
// / D8). No fuzzy matching, no embeddings — substring match per query term
// against name (x3), each tag (x2), description (x1); sum > 0 keeps the
// dashboard, sorted by score descending. Empty query returns every dashboard
// unfiltered, each with score 0 (used as the "no search active" state).

export function looksLikeUrl(query) {
  const trimmed = query.trim();
  if (!trimmed) return false;
  return /^https?:\/\//i.test(trimmed) || trimmed.includes("public.tableau.com");
}

function scoreOne(dashboard, terms) {
  const name = dashboard.name.toLowerCase();
  const tags = (dashboard.tags ?? []).map((t) => t.toLowerCase());
  const description = (dashboard.description ?? "").toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (name.includes(term)) score += 3;
    if (tags.some((t) => t.includes(term))) score += 2;
    if (description.includes(term)) score += 1;
  }
  return score;
}

export function scoreDashboards(dashboards, query) {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return dashboards.map((dashboard) => ({ dashboard, score: 0 }));
  }
  const terms = trimmed.split(/\s+/).filter(Boolean);
  return dashboards
    .map((dashboard) => ({ dashboard, score: scoreOne(dashboard, terms) }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score);
}
