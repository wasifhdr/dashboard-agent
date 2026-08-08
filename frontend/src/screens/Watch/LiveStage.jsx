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

// Agent-cursor glyph: the "cursor-pointer" outline hand from SVG Repo
// (svgrepo.com), inlined rather than imported so it paints with the frame
// instead of costing a request on first click.
const CURSOR_GLYPH_PATH =
  "M38.1,16.1a4.8,4.8,0,0,0-2.7.2A4.9,4.9,0,0,0,31.2,14l-1.3.2A4.8,4.8,0,0,0,25.4,11h-1V7.2a5,5,0,0,0-5.8-5.1,5.1,5.1,0,0,0-4,5V21.9l-2.4-2.4A4.9,4.9,0,0,0,8.7,18a4.6,4.6,0,0,0-3.4,1.5,4.1,4.1,0,0,0-1.3,3,7.9,7.9,0,0,0,1.3,4C6.5,28.7,13.8,41.3,16,45a1.9,1.9,0,0,0,1.7,1H36.5a2,2,0,0,0,2-1.5l3.4-13.2a1.3,1.3,0,0,0,.1-.6V21.2A5.2,5.2,0,0,0,38.1,16.1ZM35.1,42H18.8c-2.7-4.5-9-15.5-10.1-17.5-.1-.2-1.1-1.8-.7-2.2l.7-.3a1.1,1.1,0,0,1,.7.3l5.8,6a2,2,0,0,0,3.3-1.4V7a1,1,0,0,1,2,0V21a1.9,1.9,0,0,0,1.9,2h0a2,2,0,0,0,2-2V16a1,1,0,0,1,1-1,1,1,0,0,1,.9,1v6a2,2,0,0,0,2,2h0a2,2,0,0,0,2-2V19a.9.9,0,0,1,.9-1,.9.9,0,0,1,1,1v5a2,2,0,0,0,2,2h0a1.9,1.9,0,0,0,1.9-2V21a1,1,0,0,1,2,0v9.5a1.3,1.3,0,0,1-.1.6Z";
const CURSOR_VIEWBOX = 48; // the source icon's coordinate space
const CURSOR_GLYPH_PX = 26; // rendered size on the frame

// Where the glyph actually "points": the index fingertip, NOT the glyph's
// top-left corner. Measured off the real path rather than eyeballed - sampling
// it with getPointAtLength puts the topmost point at y=2.04, and the finger's
// edges at x=14.6/24.4 (so centre 19.5). The wrapper is shifted by this much so
// the fingertip lands exactly on the clicked point, and the click ripple is
// centred on it. Swap the glyph and you MUST redo this, or the hand points
// somewhere other than where the agent clicked - which reads as authoritative
// while being wrong, and is worse than showing no cursor at all.
const CURSOR_HOTSPOT_VB = { x: 19.5, y: 2.04 };
const CURSOR_HOTSPOT = {
  x: (CURSOR_HOTSPOT_VB.x / CURSOR_VIEWBOX) * CURSOR_GLYPH_PX,
  y: (CURSOR_HOTSPOT_VB.y / CURSOR_VIEWBOX) * CURSOR_GLYPH_PX,
};

// Maps the browser's numeric MouseEvent/PointerEvent.button code to the
// string the WS contract (and Playwright's page.mouse API) expects.
const BUTTON_NAMES = { 0: "left", 1: "middle", 2: "right" };

// Maps the server's terminal {type:"closed", reason} strings (see
// conversationRuntime.js / docs/LIVE_TAKEOVER_PLAN.md §9 Phase B4) to a
// short, human-readable line. This is a LiveStage-local sibling of
// warningLabels.js's WARNING_LABEL - same lookup-object pattern, but for the
// live-connection error surface (a different, transport-level concept from
// the orchestrator-level `run.warnings` the Watch warnings strip renders). Any reason not
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
  // Pixel dimensions of the viz sub-rectangle, used both for the displayed
  // box's aspect ratio and for the height-derived width cap below.
  const aspectW = canCrop ? vizBox.nw * viewport.width : 1;
  const aspectH = canCrop ? vizBox.nh * viewport.height : 1;

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
                  aspectRatio: `${aspectW} / ${aspectH}`,
                  // Without a height bound this fixed-aspect box overflows the
                  // overflow-hidden card above it on short windows and the
                  // bottom of the dashboard is silently clipped (the image is
                  // sized in % of THIS box, so it doesn't scale down when the
                  // flex item shrinks). Cap the width by the height budget
                  // instead, so the box shrinks whole and keeps its aspect.
                  maxWidth: `calc((100dvh - 14rem) * ${aspectW} / ${aspectH})`,
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
                    style={{
                      left: `${cursor.nx * 100}%`,
                      top: `${cursor.ny * 100}%`,
                      transform: `translate(${-CURSOR_HOTSPOT.x}px, ${-CURSOR_HOTSPOT.y}px)`,
                    }}
                  >
                    {/* pointer glyph. The icon is an OUTLINE (hollow palm), so a
                        plain black fill vanishes on a dark dashboard - the
                        Netflix one is near-black. paint-order:stroke lays a white
                        stroke BEHIND the fill, giving a halo that keeps it legible
                        on any background without altering the icon's geometry. */}
                    <svg
                      width={CURSOR_GLYPH_PX}
                      height={CURSOR_GLYPH_PX}
                      viewBox={`0 0 ${CURSOR_VIEWBOX} ${CURSOR_VIEWBOX}`}
                      aria-hidden="true"
                    >
                      <path
                        d={CURSOR_GLYPH_PATH}
                        fill="black"
                        stroke="white"
                        strokeWidth="2.5"
                        strokeLinejoin="round"
                        style={{ paintOrder: "stroke" }}
                      />
                    </svg>
                    {/* click ripple - centred on the fingertip, not the glyph box */}
                    {cursor.phase === "click" && (
                      <span
                        className="absolute block h-6 w-6 animate-ping rounded-full bg-teal/60"
                        style={{ left: CURSOR_HOTSPOT.x, top: CURSOR_HOTSPOT.y, transform: "translate(-50%, -50%)" }}
                      />
                    )}
                    <span className="absolute left-[21px] top-2 whitespace-nowrap rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">
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

          {/* No lock veil: the dashboard stays at full brightness while the
              agent drives it. Input is still not forwarded (see `interactive`
              above); the hands-off signal is carried entirely by the "agent"
              cursor on the frame and the pinging "Docent is working…" pill in
              the status row below it (Watch.jsx). */}

          {liveFrameUrl && (
            <div className="pointer-events-none absolute left-3 top-3">
              <Badge variant="neutral">● Live</Badge>
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
