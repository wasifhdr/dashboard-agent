import { cx } from "./ui/cx.js";
import { useTheme } from "../hooks/useTheme.js";

const NAV_LINK_BASE =
  "rounded-pill px-3 py-1.5 text-sm font-bold focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-2";

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function ThemeToggle() {
  const [theme, toggleTheme] = useTheme();
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="grid size-8 place-items-center rounded-pill text-fg/70 hover:bg-glass-hover hover:text-fg focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-2"
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

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
            className="rounded-control font-sans text-lg font-extrabold tracking-tight text-fg focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-2"
          >
            Docent
          </button>
          <nav className="flex items-center gap-2">
            {view === "watch" && (
              <button type="button" onClick={() => onNavigate("landing")} className={cx(NAV_LINK_BASE, "text-fg/70 hover:bg-glass-hover hover:text-fg")}>
                New dashboard
              </button>
            )}
            <button
              type="button"
              onClick={() => onNavigate("history")}
              className={cx(NAV_LINK_BASE, view === "history" ? "bg-glass-hover text-teal-ink" : "text-fg/70 hover:bg-glass-hover hover:text-fg")}
            >
              History
            </button>
            <ThemeToggle />
          </nav>
        </div>
      </header>
      <main className={cx("flex min-h-0 flex-1 flex-col", !fullBleed && "mx-auto w-full max-w-6xl px-6 py-8")}>
        {children}
      </main>
    </div>
  );
}
