import { useEffect, useState } from "react";
import { cx } from "../../components/ui/cx.js";
import CrossfadeImage from "../../components/CrossfadeImage.jsx";
import Button from "../../components/ui/Button.jsx";
import Badge from "../../components/ui/Badge.jsx";

// Dashboard frame viewport. There are no playback buttons any more (step
// navigation is the filmstrip plus the arrow keys), and the status pill and
// control row float over the frame, so it gets the full column height here.
export default function Stage({
  step,
  showOverlay,
  showJumpToLivePill = false,
  onJumpToLive,
  loadingState = null,
  previewUrl = null,
  dashboardName = null,
}) {
  const [naturalSize, setNaturalSize] = useState(null);

  useEffect(() => {
    setNaturalSize(null);
  }, [step?.frameUrl]);

  const overlay = step?.overlay;

  const showingFrame = !loadingState && !!step?.frameUrl;
  // Idle (no run yet): show the dashboard's default view - the step-1 frame
  // from a prior run - as a static preview. The user's browser can't embed the
  // live Tableau canvas, so this cached screenshot is the best "default view"
  // we can render before a question kicks off a real Playwright session.
  const showingPreview = !loadingState && !step?.frameUrl && !!previewUrl;

  return (
    <div className="flex min-h-0 flex-1 flex-col p-2">
      <div className="relative mx-auto flex min-h-0 w-full flex-1 flex-col items-center justify-center">
        {showJumpToLivePill && (
          <div className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2">
            <Badge variant="info">Viewing step {step?.idx}</Badge>
            <Button size="sm" variant="gold" onClick={onJumpToLive}>
              Jump to live
            </Button>
          </div>
        )}

        <div className={cx("glass shadow-teal-glow relative overflow-hidden rounded-card-lg", showingFrame || showingPreview ? "w-fit max-w-full" : "w-full")}>
          {loadingState ? (
            // The loading message itself renders in the caption row BELOW the
            // dashboard (see Watch.jsx) rather than on top of the frame.
            loadingState.thumbnailUrl ? (
              <img
                src={loadingState.thumbnailUrl}
                alt=""
                className="max-h-[calc(100dvh-7rem)] w-full object-contain opacity-50"
              />
            ) : (
              <div className="py-24" />
            )
          ) : !step?.frameUrl ? (
            showingPreview ? (
              // "Default view · ask a question to begin" likewise lives in the
              // caption row below the dashboard.
              <img
                src={previewUrl}
                alt={dashboardName ? `Default view of ${dashboardName}` : "Dashboard default view"}
                className="max-h-[calc(100dvh-7rem)] w-full object-contain"
              />
            ) : (
              <div className="flex flex-col items-center gap-2 py-24 text-center">
                {dashboardName && (
                  <span className="font-sans text-display-sm font-extrabold text-fg/20">{dashboardName.charAt(0)}</span>
                )}
                <p className="text-sm text-fg/60">Ask a question to open this dashboard's live view.</p>
              </div>
            )
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
                  {overlay?.click_point && (
                    <g>
                      <circle
                        cx={overlay.click_point.nx * naturalSize.w}
                        cy={overlay.click_point.ny * naturalSize.h}
                        r={Math.max(10, naturalSize.w * 0.012)}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={Math.max(2, naturalSize.w * 0.002)}
                        className="text-teal"
                      />
                      <circle
                        cx={overlay.click_point.nx * naturalSize.w}
                        cy={overlay.click_point.ny * naturalSize.h}
                        r={Math.max(3, naturalSize.w * 0.003)}
                        className="fill-teal"
                      />
                    </g>
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
