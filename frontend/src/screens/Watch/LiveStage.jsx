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

// Agent-cursor glyph: the "cursor" arrow pointer by mbok sumirna, from the
// Noun Project (noun-cursor-8212745). Inlined rather than imported so it paints
// with the frame instead of costing a request on first click - the .svg is
// therefore only the source of this path, not a runtime asset.
const CURSOR_GLYPH_PATH =
  "m78.441 53.051-52.25-47.461c-1.4297-1.2969-3.7188-0.32422-3.7773 1.6055l-2.1562 70.555c-0.10156 3.2617 3.5625 5.2461 6.2383 3.375l13.215-9.2344c1.3008-0.90625 3.1055-0.39062 3.7227 1.0703l7.0117 16.516c1.7773 4.1836 6.5039 6.6055 10.777 5.0508 4.5547-1.6602 6.7383-6.7695 4.8672-11.176l-7.1953-16.953c-0.62109-1.457 0.26172-3.1172 1.8164-3.4219l15.824-3.0938c3.2031-0.625 4.3242-4.6367 1.9062-6.832z";
// Tight box around the arrow (ink spans x 20.3-79.9, y 5.0-94.9), leaving ~2.3
// units on every side for the outer half of the halo stroke below. NOT the
// source file's own viewBox, which is padded out to 110x135 to make room for
// the Noun Project attribution text (that text is dropped here; the credit
// lives in the comment above instead).
const CURSOR_VIEWBOX = { x: 17.5, y: 2.5, w: 65, h: 95 };
const CURSOR_GLYPH_H = 28; // rendered height on the frame
const CURSOR_GLYPH_W = Math.round((CURSOR_GLYPH_H * CURSOR_VIEWBOX.w) / CURSOR_VIEWBOX.h);

// Where the glyph actually "points": the arrow's tip, NOT the glyph's top-left
// corner. Measured off the real path rather than eyeballed - the tip is a
// rounded corner (a cubic from 26.191,5.590 to 22.414,7.195), so this is the
// outermost point of the drawn ink along the pointing direction, at t≈0.5 of
// that curve, rather than the sharper virtual corner at (22.56, 2.30) which is
// a couple of units outside the ink. The wrapper is shifted by this much so the
// tip lands exactly on the clicked point, and the click ripple is centred on
// it. Swap the glyph and you MUST redo this, or the pointer points somewhere
// other than where the agent clicked - which reads as authoritative while being
// wrong, and is worse than showing no cursor at all.
const CURSOR_HOTSPOT_VB = { x: 23.79, y: 5.18 };
const CURSOR_HOTSPOT = {
  x: ((CURSOR_HOTSPOT_VB.x - CURSOR_VIEWBOX.x) / CURSOR_VIEWBOX.w) * CURSOR_GLYPH_W,
  y: ((CURSOR_HOTSPOT_VB.y - CURSOR_VIEWBOX.y) / CURSOR_VIEWBOX.h) * CURSOR_GLYPH_H,
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
    <div className="flex min-h-0 flex-1 flex-col p-2">
      <div className="relative mx-auto flex min-h-0 w-full flex-1 flex-col items-center justify-center">
        <div
          className={cx(
            "glass shadow-teal-glow relative mx-auto w-full overflow-hidden rounded-card-lg transition-shadow",
            interactive && "ring-1 ring-teal/50",
          )}
          // The height budget caps the CARD, not just the frame inside it, so
          // the card hugs the viz instead of stretching to the (now uncapped)
          // column width and leaving dead glass either side of it — which is
          // also where the interactive ring would otherwise sit.
          style={canCrop ? { maxWidth: `calc((100dvh - 7rem) * ${aspectW} / ${aspectH})` } : undefined}
        >
          {liveFrameUrl ? (
            canCrop ? (
              <div
                className="relative mx-auto overflow-hidden"
                style={{
                  width: "100%",
                  aspectRatio: `${aspectW} / ${aspectH}`,
                  // Height bound lives on the card above (see its comment):
                  // without one this fixed-aspect box overflows the
                  // overflow-hidden card on short windows and the bottom of the
                  // dashboard is silently clipped (the image is sized in % of
                  // THIS box, so it doesn't scale down when the flex item
                  // shrinks). The budget there is only the app header plus this
                  // wrapper's padding: the status pill and bottom control row
                  // float OVER the frame now, so they reserve no height.
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
                    {/* pointer glyph. The icon is a SOLID arrow, so a plain black
                        fill vanishes on a dark dashboard - the Netflix one is
                        near-black. paint-order:stroke lays a white stroke BEHIND
                        the fill, giving a halo that keeps it legible on any
                        background without altering the icon's geometry. */}
                    <svg
                      width={CURSOR_GLYPH_W}
                      height={CURSOR_GLYPH_H}
                      viewBox={`${CURSOR_VIEWBOX.x} ${CURSOR_VIEWBOX.y} ${CURSOR_VIEWBOX.w} ${CURSOR_VIEWBOX.h}`}
                      aria-hidden="true"
                    >
                      {/* strokeWidth is in viewBox units, so it scales with the
                          glyph: 4.5/95 of a 28px render is the same ~1.3px halo
                          the previous (differently-scaled) icon had. */}
                      <path
                        d={CURSOR_GLYPH_PATH}
                        fill="black"
                        stroke="white"
                        strokeWidth="4.5"
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
                  className="block max-h-[calc(100dvh-7rem)] w-full object-contain"
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
              cursor on the frame and the pinging "DashLens is working…" pill in
              the status row below it (Watch.jsx). */}

          {/* No "Live" badge over the frame: a moving dashboard is its own
              liveness cue, and the corner overlay only covered part of it. The
              "Live view ended" overlay below still tells the other half of the
              story, which is the half that isn't self-evident. */}

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
