import Spinner from "../../components/ui/Spinner.jsx";
import Badge from "../../components/ui/Badge.jsx";

// Live, read-only view of the agent's browser (Phase B1). Renders the CDP
// screencast frames streamed over the live-view WebSocket. The frame is the
// full browser viewport (mostly the viz plus dark host-page margin); vizBox is
// the viz sub-rectangle in normalized [0,1] coords, so we crop to just the viz.
//
// Crop math: to make the viz region (nw x nh of the frame) fill a container
// whose aspect ratio equals the viz's pixel aspect (nw*vw : nh*vh), scale the
// image to 1/nw wide and 1/nh tall and shift it by -nx/nw, -ny/nh. This keeps
// the image's own aspect ratio (no distortion) - see the plan/LiveStage notes.
export default function LiveStage({ liveFrameUrl, vizBox, viewport, mode, connected, dashboardName = null }) {
  const canCrop = liveFrameUrl && vizBox && viewport && vizBox.nw > 0 && vizBox.nh > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <div className="relative mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col items-center justify-center">
        <div className="glass shadow-teal-glow relative w-full overflow-hidden rounded-card-lg">
          {liveFrameUrl ? (
            canCrop ? (
              <div
                className="relative mx-auto overflow-hidden"
                style={{
                  width: "100%",
                  aspectRatio: `${vizBox.nw * viewport.width} / ${vizBox.nh * viewport.height}`,
                }}
              >
                <img
                  src={liveFrameUrl}
                  alt={dashboardName ? `Live view of ${dashboardName}` : "Live dashboard view"}
                  className="absolute left-0 top-0"
                  style={{
                    width: `${100 / vizBox.nw}%`,
                    height: `${100 / vizBox.nh}%`,
                    left: `${(-vizBox.nx / vizBox.nw) * 100}%`,
                    top: `${(-vizBox.ny / vizBox.nh) * 100}%`,
                    maxWidth: "none",
                  }}
                />
              </div>
            ) : (
              // Frames arriving but no vizbox yet: show the raw frame uncropped.
              <img
                src={liveFrameUrl}
                alt={dashboardName ? `Live view of ${dashboardName}` : "Live dashboard view"}
                className="block max-h-[calc(100dvh-12rem)] w-full object-contain"
              />
            )
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
              <Spinner />
              <p className="text-sm text-fg/70">
                {connected ? "Connecting to live view…" : "Waiting for the live dashboard…"}
              </p>
            </div>
          )}

          {/* Lock veil: the agent is driving, so the view is not interactive
              (and in B2, input is blocked here). */}
          {mode === "agent" && (
            <div className="pointer-events-none absolute inset-0 flex items-end justify-center bg-black/20 p-4 backdrop-blur-[1px]">
              <Badge variant="info">Docent is working…</Badge>
            </div>
          )}

          {liveFrameUrl && (
            <div className="pointer-events-none absolute left-3 top-3">
              <Badge variant="neutral">● Live</Badge>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
