import { useState } from "react";
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
  showEndSession = false,
  isRunning = false,
  onEndSession,
}) {
  const warningKinds = run ? [...new Set(run.warnings.map((w) => w.kind))] : [];
  const hasFrame = !!step;
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState("");

  // Explicit "End session" (live mode only - replay has its own "Back to
  // history" control). Always attempts the close, even mid-turn: the backend
  // 409s with "A turn is currently running on this conversation. Wait for it
  // to finish before closing." in that case, and that message is surfaced
  // below rather than the button silently doing nothing or being disabled
  // with no explanation (docs/LIVE_TAKEOVER_PLAN.md §9 Phase B4 item 2's
  // turn-while-locked error-taxonomy requirement). Only navigates away
  // (via onEndSession's own onEnd callback) on success.
  async function handleEndSession() {
    setEndError("");
    setEnding(true);
    try {
      await onEndSession?.();
    } catch (err) {
      setEndError(err.message || "Failed to end the session.");
    } finally {
      setEnding(false);
    }
  }

  return (
    <div className="glass-deep shrink-0 px-6 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="truncate text-h3">{dashboard?.name || (dashboard?.url ? hostnameOf(dashboard.url) : "")}</h3>
          <div className="truncate font-mono text-[13px] text-fg/45">{dashboard?.url}</div>
        </div>
        {(hasFrame || showEndSession) && (
          <div className="flex flex-shrink-0 items-center gap-3">
            {hasFrame && (
              <>
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
              </>
            )}
            {showEndSession && (
              <Button
                size="sm"
                variant="danger-ghost"
                onClick={handleEndSession}
                disabled={ending}
                title={
                  isRunning
                    ? "A turn is currently running — ending will fail until it finishes."
                    : "Close this conversation's live dashboard."
                }
              >
                {ending ? "Ending…" : "End session"}
              </Button>
            )}
          </div>
        )}
      </div>
      {endError && <div className="mt-2 text-xs font-medium text-coral-ink">{endError}</div>}
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
