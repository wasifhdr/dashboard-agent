import CapsLabel from "../../components/ui/CapsLabel.jsx";
import Card from "../../components/ui/Card.jsx";
import Badge from "../../components/ui/Badge.jsx";
import Button from "../../components/ui/Button.jsx";
import EmptyState from "../../components/ui/EmptyState.jsx";

function DashboardThumbnail({ dashboard }) {
  if (dashboard.thumbnailUrl) {
    return (
      <div className="panel aspect-[16/10] overflow-hidden rounded-control">
        <img src={dashboard.thumbnailUrl} alt="" className="h-full w-full object-cover" />
      </div>
    );
  }
  return (
    <div className="panel flex aspect-[16/10] items-center justify-center rounded-control">
      <span className="font-sans text-display-sm font-extrabold text-fg/25">{dashboard.name.charAt(0)}</span>
    </div>
  );
}

function ReadinessBadge({ inventory }) {
  if (!inventory) return null;
  const { filterCount = 0, sheetCount = 0, parameterCount = 0 } = inventory;
  if (!filterCount && !sheetCount && !parameterCount) {
    return <Badge variant="pending">read-only</Badge>;
  }
  return (
    <Badge variant="info">
      {filterCount} filters · {sheetCount} tabs
    </Badge>
  );
}

function DashboardCard({ dashboard, onOpen }) {
  return (
    <Card variant="clickable" onClick={() => onOpen(dashboard.url, dashboard.name)}>
      <DashboardThumbnail dashboard={dashboard} />
      <h3 className="mt-4 text-h2">{dashboard.name}</h3>
      <p className="mt-1 text-sm text-fg/70">{dashboard.description}</p>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {(dashboard.tags ?? []).slice(0, 3).map((tag) => (
          <Badge key={tag} variant="neutral">
            {tag}
          </Badge>
        ))}
        <ReadinessBadge inventory={dashboard.inventory} />
      </div>
    </Card>
  );
}

export default function GalleryBand({ dashboards, matches, query, isUrlQuery, onOpenDashboard, onOpenUrl }) {
  const isSearching = query.trim() !== "";
  const heading = isSearching ? `Matches for "${query.trim()}"` : "Five dashboards, ready to interrogate.";

  return (
    <section>
      <div className="mx-auto max-w-6xl px-6 py-16">
        <CapsLabel className="text-teal-ink">GALLERY</CapsLabel>
        <h2 className="mt-2 text-h1">{heading}</h2>
        {!isSearching && (
          <p className="mt-2 text-sm text-fg/70">Curated from the DashboardQA benchmark and validated end-to-end.</p>
        )}

        <div className="mt-8">
          {isUrlQuery ? (
            <Button variant="default" className="w-full" onClick={() => onOpenUrl(query.trim())}>
              Open this dashboard →
            </Button>
          ) : dashboards.length === 0 ? null : matches.length === 0 ? (
            <EmptyState
              statement={
                <>
                  No dashboard knows about that <span className="text-gold-ink">yet.</span>
                </>
              }
              line="Try different words, or paste a Tableau Public link above."
            />
          ) : (
            <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
              {matches.map(({ dashboard }) => (
                <DashboardCard key={dashboard.url} dashboard={dashboard} onOpen={onOpenDashboard} />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
