export default function Footer({ onOpenHistory }) {
  return (
    <footer className="border-t border-glass-border bg-canvas-edge">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-3 px-6 py-12 text-center md:flex-row md:justify-between md:text-left">
        <div>
          <div className="font-sans text-lg font-extrabold text-fg">Docent</div>
          <p className="mt-1 text-xs text-fg/60">CSE499B senior design · North South University · 2026</p>
        </div>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={onOpenHistory}
            className="rounded-pill px-3 py-1.5 text-sm font-bold text-fg/75 hover:bg-glass-hover hover:text-fg focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-2"
          >
            History
          </button>
          <span className="text-xs text-fg/60">Built on the DashboardQA benchmark</span>
        </div>
      </div>
    </footer>
  );
}
