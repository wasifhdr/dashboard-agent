import Button from "../../components/ui/Button.jsx";
import { Checkbox } from "../../components/ui/Field.jsx";
import Card from "../../components/ui/Card.jsx";
import { WARNING_LABEL } from "./warningLabels.js";

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// Top bar for the Watch screen. Holds the dashboard identity plus the playback
// controls (Prev/Next/Play/Overlays) — pulled up here from the Stage so the
// dashboard frame below can use the full height. No run-status badge or step
// meter lives here: each question gets its own 15-step budget, and that
// per-question progress is shown in the Composer while a question is running.
export default function StatusBar({
  dashboard,
  run,
  step,
  showOverlay,
  onToggleOverlay,
  onPrev,
  onNext,
  canPrev,
  canNext,
  isPlaying,
  onTogglePlay,
  showPlayButton = false,
}) {
  const warningKinds = run ? [...new Set(run.warnings.map((w) => w.kind))] : [];
  const hasFrame = !!step;

  return (
    <div className="glass-deep shrink-0 px-6 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="truncate text-h3">{dashboard?.name || (dashboard?.url ? hostnameOf(dashboard.url) : "")}</h3>
          <div className="truncate font-mono text-[13px] text-fg/45">{dashboard?.url}</div>
        </div>
        {hasFrame && (
          <div className="flex flex-shrink-0 items-center gap-3">
            <Button size="sm" onClick={onPrev} disabled={!canPrev}>
              Prev
            </Button>
            <Button size="sm" onClick={onNext} disabled={!canNext}>
              Next
            </Button>
            {showPlayButton && (
              <Button size="sm" onClick={onTogglePlay}>
                {isPlaying ? "Pause" : "Play"}
              </Button>
            )}
            <label className="flex items-center gap-2 text-sm text-fg/70">
              <Checkbox checked={showOverlay} onChange={onToggleOverlay} /> Overlays
            </label>
            <div className="font-mono text-xs text-fg/60">step {step.idx}</div>
          </div>
        )}
      </div>
      {warningKinds.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {warningKinds.map((kind) => (
            <Card key={kind} variant="callout" accent="gold" className="py-2 text-sm text-fg/80">
              {WARNING_LABEL[kind] ?? kind}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
