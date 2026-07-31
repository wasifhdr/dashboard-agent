import { useEffect, useMemo, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { getConfig, getDashboardsMeta } from "../../api.js";
import { scoreDashboards, looksLikeUrl } from "./search.js";
import Field from "../../components/ui/Field.jsx";
import Button from "../../components/ui/Button.jsx";
import StepFlow from "./StepFlow.jsx";
import DashboardCarousel from "./DashboardCarousel.jsx";
import Footer from "./Footer.jsx";
import TableauResults from "./TableauResults.jsx";

gsap.registerPlugin(useGSAP);

const DEBOUNCE_MS = 150;

export default function Landing({ onOpenWatch }) {
  const [dashboards, setDashboards] = useState([]);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [urlValue, setUrlValue] = useState("");
  const [urlError, setUrlError] = useState("");
  const [remoteResults, setRemoteResults] = useState([]);
  const [remoteStatus, setRemoteStatus] = useState("idle");
  const heroRef = useRef(null);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

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
    setRemoteResults([]);
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

  function handleUrlSubmit(e) {
    e.preventDefault();
    const trimmed = urlValue.trim();
    if (!trimmed.toLowerCase().startsWith("http")) {
      setUrlError("Paste a full Tableau Public view URL.");
      return;
    }
    setUrlError("");
    openDashboard(trimmed, null);
  }

  // One-shot entrance for the hero headline + search column (the StepFlow and
  // carousel run their own GSAP intros). Skipped under reduced-motion.
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from(".hero-rise", {
          y: 18,
          opacity: 0,
          duration: 0.6,
          stagger: 0.08,
          ease: "power3.out",
        });
      });
      return () => mm.revert();
    },
    { scope: heroRef },
  );

  return (
    <div>
      <section ref={heroRef}>
        <div className="mx-auto grid max-w-6xl gap-x-12 gap-y-12 px-6 py-16 md:grid-cols-2 md:items-start">
          {/* Left: headline + the loop, as a vertical sequence */}
          <div>
            <h1 className="hero-rise font-sans text-display font-extrabold text-fg">
              Ask a question. Watch the agent <span className="text-teal-ink">work the dashboard.</span>
            </h1>
            <div className="hero-rise mt-10">
              <StepFlow />
            </div>
          </div>

          {/* Right: find a dashboard, then browse matches in the carousel */}
          <div className="md:pt-2">
            <div className="hero-rise space-y-5">
              <Field
                label="Find a dashboard"
                placeholder='Try "video games", "netflix", "flight delays"…'
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleEnterSearch();
                }}
              />
              <div>
                <label className="mb-1.5 block text-label uppercase text-fg/70">Or open a Tableau Public link</label>
                <form onSubmit={handleUrlSubmit} className="flex items-start gap-2">
                  <div className="flex-1">
                    <Field
                      placeholder="https://public.tableau.com/views/Workbook/Sheet"
                      value={urlValue}
                      onChange={(e) => setUrlValue(e.target.value)}
                      error={urlError || undefined}
                    />
                  </div>
                  <Button type="submit" variant="primary" className="shrink-0">
                    Open dashboard
                  </Button>
                </form>
              </div>
            </div>

            <div className="hero-rise mt-8">
              <DashboardCarousel
                matches={matches}
                isUrlQuery={isUrlQuery}
                query={query}
                onOpenDashboard={openDashboard}
                onOpenUrl={(url) => openDashboard(url, null)}
              />
            </div>

            <div className="hero-rise">
              <TableauResults
                status={remoteStatus}
                results={remoteResults}
                onOpenUrl={(url) => openDashboard(url, null)}
              />
            </div>
          </div>
        </div>
      </section>
      <Footer />
    </div>
  );
}
