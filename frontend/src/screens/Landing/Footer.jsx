// No History link here — the header's History control is always on screen and
// is the single way in, so a second one in the footer was just a duplicate.
export default function Footer() {
  return (
    <footer className="border-t border-glass-border bg-canvas-edge">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-3 px-6 py-12 text-center md:flex-row md:justify-between md:text-left">
        <div>
          <div className="brand-wordmark text-fg">DashLens</div>
          <p className="mt-1 text-xs text-fg/60">CSE499B senior design · North South University · 2026</p>
        </div>
        <span className="text-xs text-fg/60">Built on the DashboardQA benchmark</span>
      </div>
    </footer>
  );
}
