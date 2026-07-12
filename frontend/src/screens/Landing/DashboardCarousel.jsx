import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import CapsLabel from "../../components/ui/CapsLabel.jsx";
import Card from "../../components/ui/Card.jsx";
import Badge from "../../components/ui/Badge.jsx";
import Button from "../../components/ui/Button.jsx";
import EmptyState from "../../components/ui/EmptyState.jsx";
import { cx } from "../../components/ui/cx.js";

gsap.registerPlugin(useGSAP);

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

function ChevronIcon({ dir }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      {dir === "left" ? <path d="M15 18l-6-6 6-6" /> : <path d="M9 18l6-6-6-6" />}
    </svg>
  );
}

function ArrowButton({ dir, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="grid size-9 shrink-0 place-items-center rounded-pill panel text-fg/70 transition-[transform,background-color,color] duration-150 ease-glass hover:bg-glass-hover hover:text-fg active:scale-95 focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-2"
    >
      <ChevronIcon dir={dir} />
    </button>
  );
}

// Single-card dashboard carousel that sits under the search box. Empty query
// shows every dashboard; a search narrows the set; left/right arrows (and dots)
// walk through the matches one at a time, with a GSAP slide on each change.
export default function DashboardCarousel({ matches, isUrlQuery, query, onOpenDashboard, onOpenUrl }) {
  const [index, setIndex] = useState(0);
  const dirRef = useRef(1); // slide direction: +1 = forward, -1 = back
  const cardRef = useRef(null);
  const containerRef = useRef(null);

  const count = matches.length;
  // Stable signature of the current match set; when it changes (new search),
  // snap back to the first card.
  const matchesKey = matches.map((m) => m.dashboard.url).join("|");
  useEffect(() => {
    dirRef.current = 1;
    setIndex(0);
  }, [matchesKey]);

  const activeIndex = count ? Math.min(index, count - 1) : 0;

  useGSAP(
    () => {
      if (!cardRef.current) return undefined;
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from(cardRef.current, {
          xPercent: 7 * dirRef.current,
          opacity: 0,
          duration: 0.4,
          ease: "power2.out",
        });
      });
      return () => mm.revert();
    },
    { dependencies: [activeIndex, matchesKey, isUrlQuery], scope: containerRef },
  );

  function go(delta) {
    dirRef.current = delta;
    setIndex((i) => (i + delta + count) % count);
  }
  function jumpTo(target) {
    dirRef.current = target > activeIndex ? 1 : -1;
    setIndex(target);
  }

  // URL typed into the search box → offer to open it directly.
  if (isUrlQuery) {
    return (
      <div ref={containerRef}>
        <div ref={cardRef}>
          <Button variant="primary" className="w-full" onClick={() => onOpenUrl(query.trim())}>
            Open this dashboard →
          </Button>
        </div>
      </div>
    );
  }

  if (count === 0) {
    return (
      <div ref={containerRef}>
        <div ref={cardRef}>
          <EmptyState
            statement={
              <>
                No dashboard knows about that <span className="text-gold-ink">yet.</span>
              </>
            }
            line="Try different words, or paste a Tableau Public link above."
          />
        </div>
      </div>
    );
  }

  const active = matches[activeIndex].dashboard;
  const isSearching = query.trim() !== "";

  return (
    <div ref={containerRef}>
      <div className="mb-3 flex items-center justify-between">
        <CapsLabel className="text-teal-ink">{isSearching ? "MATCHES" : "GALLERY"}</CapsLabel>
        <span className="text-label uppercase text-fg/50">
          {activeIndex + 1} / {count}
        </span>
      </div>

      {/* Only the active card is mounted, keyed by index so React swaps it and
          the useGSAP slide re-fires each move. */}
      <div key={activeIndex} ref={cardRef}>
        <Card variant="clickable" onClick={() => onOpenDashboard(active.url, active.name)}>
          <DashboardThumbnail dashboard={active} />
          {/* Every dashboard's copy differs in length (name, description, tag
              count), so each text block reserves its own fixed min-height
              (~2 lines each) regardless of content - the card never shrinks
              or grows between dashboards (e.g. the shorter "California
              Revenue Sources" copy used to shrink the whole card). */}
          <h3 className="mt-4 line-clamp-2 min-h-[3.3rem] text-h2">{active.name}</h3>
          <p className="mt-1 line-clamp-2 min-h-[2.5rem] text-sm text-fg/70">{active.description}</p>
          <div className="mt-3 flex min-h-[1.75rem] flex-wrap items-center gap-1.5">
            {(active.tags ?? []).slice(0, 3).map((tag) => (
              <Badge key={tag} variant="neutral">
                {tag}
              </Badge>
            ))}
            <ReadinessBadge inventory={active.inventory} />
          </div>
        </Card>
      </div>

      {count > 1 && (
        <div className="mt-4 flex items-center justify-center gap-4">
          <ArrowButton dir="left" label="Previous dashboard" onClick={() => go(-1)} />
          <div className="flex items-center gap-2">
            {matches.map((m, i) => (
              <button
                key={m.dashboard.url}
                type="button"
                aria-label={`Go to dashboard ${i + 1}`}
                aria-current={i === activeIndex}
                onClick={() => jumpTo(i)}
                className={cx(
                  "h-2 rounded-pill transition-[width,background-color] duration-200 ease-glass",
                  i === activeIndex ? "w-6 bg-teal" : "w-2 bg-fg/25 hover:bg-fg/40",
                )}
              />
            ))}
          </div>
          <ArrowButton dir="right" label="Next dashboard" onClick={() => go(1)} />
        </div>
      )}
    </div>
  );
}
