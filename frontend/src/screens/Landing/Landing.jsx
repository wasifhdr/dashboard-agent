import { useEffect, useMemo, useState } from "react";
import { getConfig, getDashboardsMeta } from "../../api.js";
import { scoreDashboards, looksLikeUrl } from "./search.js";
import HeroBand from "./HeroBand.jsx";
import GalleryBand from "./GalleryBand.jsx";
import HowItWorksBand from "./HowItWorksBand.jsx";
import FeatureBand from "./FeatureBand.jsx";
import StatBand from "./StatBand.jsx";
import Footer from "./Footer.jsx";

const DEBOUNCE_MS = 150;

export default function Landing({ onOpenWatch, onOpenHistory }) {
  const [dashboards, setDashboards] = useState([]);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getConfig(), getDashboardsMeta()])
      .then(([cfg, meta]) => {
        if (cancelled) return;
        const metaByUrl = new Map((meta.dashboards ?? []).map((m) => [m.url, m]));
        const merged = (cfg.dashboards ?? []).map((d) => {
          const m = metaByUrl.get(d.url);
          return {
            ...d,
            thumbnailUrl: m?.thumbnailUrl ?? null,
            inventory: m?.inventory ?? null,
            lastAnsweredSessionId: m?.lastAnsweredSessionId ?? null,
          };
        });
        setDashboards(merged);
      })
      .catch(() => {
        if (!cancelled) setDashboards([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isUrlQuery = looksLikeUrl(query);
  const matches = useMemo(() => scoreDashboards(dashboards, debouncedQuery), [dashboards, debouncedQuery]);

  function openDashboard(url, name) {
    onOpenWatch({ url, name: name ?? null });
  }

  function handleEnterSearch() {
    if (isUrlQuery) {
      openDashboard(query.trim(), null);
      return;
    }
    const immediate = scoreDashboards(dashboards, query);
    if (immediate.length === 1) {
      openDashboard(immediate[0].dashboard.url, immediate[0].dashboard.name);
    }
  }

  return (
    <div>
      <HeroBand
        query={query}
        onQueryChange={setQuery}
        onEnterSearch={handleEnterSearch}
        onOpenUrl={(url) => openDashboard(url, null)}
      />
      <GalleryBand
        dashboards={dashboards}
        matches={matches}
        query={debouncedQuery}
        isUrlQuery={isUrlQuery}
        onOpenDashboard={openDashboard}
        onOpenUrl={(url) => openDashboard(url, null)}
      />
      <HowItWorksBand />
      <FeatureBand />
      <StatBand />
      <Footer onOpenHistory={onOpenHistory} />
    </div>
  );
}
