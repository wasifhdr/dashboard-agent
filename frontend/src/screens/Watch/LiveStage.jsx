import { useEffect, useRef } from "react";
import Spinner from "../../components/ui/Spinner.jsx";
import Badge from "../../components/ui/Badge.jsx";
import { cx } from "../../components/ui/cx.js";

// Live view of the agent's browser. Renders the CDP screencast frames
// streamed over the live-view WebSocket. The frame is the full browser
// viewport (mostly the viz plus dark host-page margin); vizBox is the viz
// sub-rectangle in normalized [0,1] coords, so we crop to just the viz.
//
// Crop math: to make the viz region (nw x nh of the frame) fill a container
// whose aspect ratio equals the viz's pixel aspect (nw*vw : nh*vh), scale the
// image to 1/nw wide and 1/nh tall and shift it by -nx/nw, -ny/nh. This keeps
// the image's own aspect ratio (no distortion) - see the plan/LiveStage notes.
//
// Phase B2: once a turn has finished (mode !== "agent"), a transparent
// input-capture layer mounts over the displayed image and forwards
// mouse/keyboard events to `sendInput` - see InputCaptureLayer below for the
// coordinate contract (docs/LIVE_TAKEOVER_PLAN.md's B2 input coordinate
// contract).

// Maps the browser's numeric MouseEvent/PointerEvent.button code to the
// string the WS contract (and Playwright's page.mouse API) expects.
const BUTTON_NAMES = { 0: "left", 1: "middle", 2: "right" };

// Maps the server's terminal {type:"closed", reason} strings (see
// conversationRuntime.js / docs/LIVE_TAKEOVER_PLAN.md §9 Phase B4) to a
// short, human-readable line. This is a LiveStage-local sibling of
// warningLabels.js's WARNING_LABEL - same lookup-object pattern, but for the
// live-connection error surface (a different, transport-level concept from
// the orchestrator-level `run.warnings` StatusBar renders). Any reason not
// listed here - including a missing/unrecognized one - falls back to the
// generic message rather than being left unhandled.
const CLOSED_REASON_LABEL = {
  idle_timeout: "This session was closed after being idle.",
  browser_crashed: "The dashboard browser crashed. Start a new conversation to continue.",
  screencast_failed:
    "The live view failed to start. Per-step frames are still available; try a new conversation for the live view.",
  conversation_closed: "This session has ended.",
};

function closedReasonMessage(reason) {
  return CLOSED_REASON_LABEL[reason] ?? "This session has ended.";
}

// Keys that would otherwise have an unwanted side effect *inside* this
// focused capture layer (move focus away, scroll the containing page) if
// left to the browser's default handling - preventDefault only for these,
// never blanket-prevented for every key.
const PREVENT_DEFAULT_KEYS = new Set([
  "Tab",
  " ",
  "Spacebar",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

// nx, ny per the B2 input coordinate contract: fractions [0,1] of THIS
// element's own displayed rectangle - (0,0) is its top-left corner, (1,1) its
// bottom-right - i.e. exactly what the user visually sees and clicks on. The
// server is the only side that knows the current vizbox + viewport, and
// performs the one necessary transform into absolute page pixels.
function nxnyFromEvent(el, clientX, clientY) {
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return { nx: 0, ny: 0 };
  return {
    nx: clamp01((clientX - rect.left) / rect.width),
    ny: clamp01((clientY - rect.top) / rect.height),
  };
}

// Transparent layer mounted over the live viz image whenever it's the user's
// turn to drive. Uses the native Pointer Events API with
// setPointerCapture(pointerId) on pointerdown so THIS element keeps
// receiving move/up even if the pointer strays outside it mid-drag (e.g.
// dragging a range-filter handle) - no document-level listeners to hand-roll
// or clean up. React unmounting this component (the caller gates that on
// `mode`) is all the cleanup needed; there's nothing else to tear down.
function InputCaptureLayer({ sendInput }) {
  // Tracks the button (if any) a pointerdown here hasn't yet released, so an
  // unmount mid-drag (e.g. a turn starts right as the user is dragging a
  // range-filter handle) can send the matching synthetic 'up' instead of
  // leaving Playwright's virtual mouse button stuck pressed on the shared
  // page. Position is irrelevant for an 'up' event (the server's dispatchInput
  // doesn't use nx/ny for it), so nx:0,ny:0 is fine here.
  const heldButtonRef = useRef(null);

  useEffect(() => {
    return () => {
      if (heldButtonRef.current) {
        sendInput({ type: "mouse", event: "up", nx: 0, ny: 0, button: heldButtonRef.current });
        heldButtonRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function forwardPointer(e, event) {
    const { nx, ny } = nxnyFromEvent(e.currentTarget, e.clientX, e.clientY);
    sendInput({ type: "mouse", event, nx, ny, button: BUTTON_NAMES[e.button] ?? "left" });
  }

  function handlePointerDown(e) {
    heldButtonRef.current = BUTTON_NAMES[e.button] ?? "left";
    e.currentTarget.focus();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported for this pointer type - move/up still fire normally */
    }
    forwardPointer(e, "down");
  }

  function handlePointerMove(e) {
    forwardPointer(e, "move");
  }

  function handlePointerUp(e) {
    heldButtonRef.current = null;
    forwardPointer(e, "up");
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  }

  function handleWheel(e) {
    // Only while this layer is mounted - don't also scroll the containing page.
    e.preventDefault();
    const { nx, ny } = nxnyFromEvent(e.currentTarget, e.clientX, e.clientY);
    sendInput({ type: "mouse", event: "wheel", nx, ny, deltaY: e.deltaY });
  }

  function handleKeyDown(e) {
    if (PREVENT_DEFAULT_KEYS.has(e.key)) e.preventDefault();
    sendInput({ type: "key", event: "down", key: e.key });
  }

  function handleKeyUp(e) {
    if (PREVENT_DEFAULT_KEYS.has(e.key)) e.preventDefault();
    sendInput({ type: "key", event: "up", key: e.key });
  }

  return (
    <div
      className="absolute inset-0 z-20 cursor-crosshair outline-none"
      style={{ touchAction: "none" }}
      tabIndex={0}
      role="application"
      aria-label="Live dashboard - click, drag, or type to interact"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
    />
  );
}

export default function LiveStage({
  liveFrameUrl,
  vizBox,
  viewport,
  mode,
  connected,
  closedReason = null,
  sendInput = () => {},
  dashboardName = null,
  cursor = null,
}) {
  const canCrop = liveFrameUrl && vizBox && viewport && vizBox.nw > 0 && vizBox.nh > 0;
  // Post-completion takeover (B2): the capture layer and the lock veil are
  // mutually exclusive by construction - this is only true while the agent
  // isn't driving. Also requires canCrop, not just a frame: nx/ny are
  // measured against the DISPLAYED viz container, which only matches the
  // server's coordinate contract once the frame is actually cropped to the
  // viz - the raw-frame fallback below (no vizbox yet) has no such rectangle,
  // so input can't be mapped correctly there and must not be captured.
  const interactive = mode !== "agent" && canCrop;

  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <div className="relative mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col items-center justify-center">
        <div
          className={cx(
            "glass shadow-teal-glow relative w-full overflow-hidden rounded-card-lg transition-shadow",
            interactive && "ring-1 ring-teal/50",
          )}
        >
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
                  draggable={false}
                  className="absolute left-0 top-0"
                  style={{
                    width: `${100 / vizBox.nw}%`,
                    height: `${100 / vizBox.nh}%`,
                    left: `${(-vizBox.nx / vizBox.nw) * 100}%`,
                    top: `${(-vizBox.ny / vizBox.nh) * 100}%`,
                    maxWidth: "none",
                  }}
                />
                {mode === "agent" && cursor && (
                  <div
                    className="pointer-events-none absolute z-30 transition-all duration-200 ease-out"
                    style={{ left: `${cursor.nx * 100}%`, top: `${cursor.ny * 100}%`, transform: "translate(-2px, -2px)" }}
                  >
                    {/* pointer glyph */}
                    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
                      <path d="M2 2 L2 16 L6 12 L9 19 L12 18 L9 11 L15 11 Z" fill="white" stroke="black" strokeWidth="1.2" />
                    </svg>
                    {/* click ripple */}
                    {cursor.phase === "click" && (
                      <span className="absolute -left-2 -top-2 block h-6 w-6 animate-ping rounded-full bg-teal/60" />
                    )}
                    <span className="absolute left-5 top-3 whitespace-nowrap rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                      agent
                    </span>
                  </div>
                )}
                {interactive && <InputCaptureLayer sendInput={sendInput} />}
              </div>
            ) : (
              // Frames arriving but no vizbox yet: show the raw frame
              // uncropped. No InputCaptureLayer here - without a vizbox there
              // is no viz rectangle to measure clicks against, so `interactive`
              // is always false in this branch by construction (see above).
              <div className="relative">
                <img
                  src={liveFrameUrl}
                  alt={dashboardName ? `Live view of ${dashboardName}` : "Live dashboard view"}
                  draggable={false}
                  className="block max-h-[calc(100dvh-12rem)] w-full object-contain"
                />
              </div>
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
              and input is not forwarded. */}
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

          {/* Subtle affordance that the view is now clickable - the input
              layer itself is fully transparent, so without this there's no
              visual cue the takeover window is open. */}
          {interactive && (
            <div className="pointer-events-none absolute right-3 top-3">
              <Badge variant="success">Yours — click to interact</Badge>
            </div>
          )}

          {/* Terminal-close overlay: the server ended the live channel for
              good (idle timeout, crash, screencast failure, explicit close) -
              distinct from a transient reconnect-in-progress drop, which
              leaves closedReason null and keeps showing the ordinary
              Connecting…/Waiting… spinner state below. Covers whatever was
              last on screen (a frozen last frame, or nothing yet). */}
          {closedReason && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-canvas/90 p-6 text-center backdrop-blur-sm">
              <Badge variant="neutral">Live view ended</Badge>
              <p className="max-w-sm text-sm text-fg/70">{closedReasonMessage(closedReason)}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
