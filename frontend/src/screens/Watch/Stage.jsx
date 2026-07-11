import { useEffect, useState } from "react";
import { cx } from "../../components/ui/cx.js";
import CrossfadeImage from "../../components/CrossfadeImage.jsx";
import Button from "../../components/ui/Button.jsx";
import Badge from "../../components/ui/Badge.jsx";
import Spinner from "../../components/ui/Spinner.jsx";

// Dashboard frame viewport. Playback controls (Prev/Next/Play/Overlays) now
// live in the StatusBar, so the frame gets the full column height here.
export default function Stage({
  step,
  showOverlay,
  showJumpToLivePill = false,
  onJumpToLive,
  loadingState = null,
}) {
  const [naturalSize, setNaturalSize] = useState(null);

  useEffect(() => {
    setNaturalSize(null);
  }, [step?.frameUrl]);

  const overlay = step?.overlay;

  const showingFrame = !loadingState && !!step?.frameUrl;

  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <div className="relative mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col items-center justify-center">
        {showJumpToLivePill && (
          <div className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2">
            <Badge variant="info">Viewing step {step?.idx}</Badge>
            <Button size="sm" variant="gold" onClick={onJumpToLive}>
              Jump to live
            </Button>
          </div>
        )}

        <div className={cx("glass shadow-teal-glow relative overflow-hidden rounded-card-lg", showingFrame ? "w-fit max-w-full" : "w-full")}>
          {loadingState ? (
            <div className="relative">
              {loadingState.thumbnailUrl ? (
                <img
                  src={loadingState.thumbnailUrl}
                  alt=""
                  className="max-h-[calc(100dvh-12rem)] w-full object-contain opacity-50"
                />
              ) : (
                <div className="py-24" />
              )}
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
                <Spinner />
                <p className="text-sm text-fg/70">{loadingState.message}</p>
              </div>
            </div>
          ) : !step?.frameUrl ? (
            <div className="py-24 text-center text-sm text-fg/60">No frame yet.</div>
          ) : (
            <>
              <CrossfadeImage
                src={step.frameUrl}
                onLoad={(e) => setNaturalSize({ w: e.target.naturalWidth, h: e.target.naturalHeight })}
              />
              {showOverlay && naturalSize && (
                <svg
                  className="pointer-events-none absolute inset-0 h-full w-full"
                  viewBox={`0 0 ${naturalSize.w} ${naturalSize.h}`}
                  preserveAspectRatio="none"
                >
                  {(overlay?.changed_regions ?? []).map((r, i) => (
                    <rect key={`cr-${step.idx}-${i}`} className="overlay-region" x={r.x} y={r.y} width={r.w} height={r.h} />
                  ))}
                  {overlay?.widget_bbox && (
                    <rect
                      className="overlay-widget"
                      x={overlay.widget_bbox.x}
                      y={overlay.widget_bbox.y}
                      width={overlay.widget_bbox.w}
                      height={overlay.widget_bbox.h}
                    />
                  )}
                </svg>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
