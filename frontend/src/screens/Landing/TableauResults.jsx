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
