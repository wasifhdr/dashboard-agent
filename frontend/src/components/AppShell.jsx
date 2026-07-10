import { cx } from "./ui/cx.js";

const NAV_LINK_BASE =
  "rounded-pill px-3 py-1.5 text-sm font-bold focus-visible:outline-[3px] focus-visible:outline-gold focus-visible:outline-offset-2";

export default function AppShell({ view, onNavigate, children }) {
  // Landing manages its own full-width marketing bands; watch manages its own
  // full-height stage/feed/composer layout. Only history uses the default
  // padded content wrapper (DESIGN.md §6).
  const fullBleed = view === "landing" || view === "watch";

  return (
    <div className="flex min-h-screen flex-col">
      <div className="bg-orbs" aria-hidden="true" />
      <header className="glass-deep sticky top-0 z-40">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <button
            type="button"
            onClick={() => onNavigate("landing")}
            className="rounded-control font-sans text-lg font-extrabold tracking-tight text-mist focus-visible:outline-[3px] focus-visible:outline-gold focus-visible:outline-offset-2"
          >
            Docent
          </button>
          <nav className="flex items-center gap-2">
            {view === "watch" && (
              <button type="button" onClick={() => onNavigate("landing")} className={cx(NAV_LINK_BASE, "text-mist/70 hover:bg-glass-hover hover:text-mist")}>
                New dashboard
              </button>
            )}
            <button
              type="button"
              onClick={() => onNavigate("history")}
              className={cx(NAV_LINK_BASE, view === "history" ? "bg-glass-hover text-gold" : "text-mist/70 hover:bg-glass-hover hover:text-mist")}
            >
              History
            </button>
          </nav>
        </div>
      </header>
      <main className={cx("flex min-h-0 flex-1 flex-col", !fullBleed && "mx-auto w-full max-w-6xl px-6 py-8")}>
        {children}
      </main>
    </div>
  );
}
