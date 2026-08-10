import { useEffect, useRef } from "react";
import { cx } from "../../components/ui/cx.js";

function ChatIcon({ className = "size-5" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

// Minimize = collapse the panel back down into the bar. A chevron pointing down
// reads as "put this away" more clearly than a dash at this size.
function MinimizeIcon({ className = "size-4" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

// Height of the idle composer bubble, measured: pt-2.5 (10) + one line of
// textarea (24) + gap-1 (4) + the size-10 action buttons on their own row (40)
// + pb-2 (8) + its hairline border (2). Used only for the first paint, before
// the ResizeObserver in Watch has reported the real height — measuring it live
// is what keeps the thread's clearance and the blur ramp attached to the bubble
// as it grows.
const IDLE_COMPOSER_H = 88;

// How far the composer's frosting reaches ABOVE the bubble before it has fully
// ramped off, so messages soften on approach instead of hitting a hard edge.
const VEIL_RAMP = 40;

// Clear air between where the ramp reaches zero and where the thread's last
// message comes to rest, so a resting bubble is never even slightly blurred.
const VEIL_CLEARANCE = 10;

// Full strength across the bubble's footprint (its height + the p-3 gutter),
// then a linear ramp to nothing over VEIL_RAMP above it.
const VEIL_MASK = (footerHeight) =>
  `linear-gradient(to top, #000 ${(footerHeight || IDLE_COMPOSER_H) + 12}px, transparent 100%)`;

// Bottom padding the thread needs so its last message rests ABOVE the veil
// entirely — the composer footprint, the whole ramp, and a little clear air.
// Derived from the veil's own numbers rather than being a second hand-tuned
// constant: when the two were independent the ramp reached ~40px past the
// resting bubble's bottom edge and permanently blurred it, which reads as the
// message being out of focus rather than as depth.
export const threadBottomClearance = (footerHeight) =>
  (footerHeight || IDLE_COMPOSER_H) + 12 + VEIL_RAMP + VEIL_CLEARANCE;

const TRIGGER_BASE =
  "glass-teal relative flex items-center rounded-pill text-fg transition-transform duration-150 ease-glass " +
  "hover:scale-[1.03] active:scale-[0.97] focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-2";

// The minimized face of the conversation, living in the bar under the dashboard.
// Three looks, in priority order:
//   running -> "Thinking" pill with sequentially fading dots
//   unread  -> "Response ready" pill with a repeating ping ring
//   idle    -> a compact chat bubble
export function ChatDockTrigger({ isRunning, unread, onOpen, title = "Ask the Agent" }) {
  if (isRunning) {
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label="Open the agent panel — a response is being generated"
        className={cx(TRIGGER_BASE, "gap-2 px-4 py-2 text-sm font-bold")}
      >
        <span>Thinking</span>
        <span aria-hidden="true" className="flex gap-0.5">
          <span className="thinking-dot">•</span>
          <span className="thinking-dot">•</span>
          <span className="thinking-dot">•</span>
        </span>
      </button>
    );
  }

  if (unread) {
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label="Open the agent panel — the response is ready"
        className={cx(TRIGGER_BASE, "ready-ping gap-2 px-4 py-2 text-sm font-bold text-teal-ink")}
      >
        <span className="size-2 shrink-0 rounded-pill bg-teal" aria-hidden="true" />
        Response ready
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Open the agent panel"
      title={title}
      className={cx(TRIGGER_BASE, "gap-2 px-3 py-2 text-fg/80 hover:text-fg")}
    >
      <ChatIcon />
    </button>
  );
}

// The expanded conversation panel. Floats over the dashboard (glassmorphic, so
// the dashboard blurs through it) and rises to just under the site header.
//
// Always mounted — visibility is animated rather than conditional — for two
// reasons: the open/close transition stays smooth in both directions, and the
// Feed never remounts (which would restart its live thought typewriters).
//
// Layering: the thread is a full-bleed scroll layer; the header and composer sit
// ABOVE it as glass bars, so messages slide underneath them and blur through,
// with .chat-thread-fade dissolving them instead of clipping at a hard edge.
export default function ChatPanel({ open, onMinimize, title = "Ask the Agent", thread, footer, footerHeight = 0 }) {
  // The panel stays mounted while minimized, so its composer and buttons would
  // otherwise still be reachable by Tab. `inert` takes them out of the tab order
  // and the a11y tree; React 18 has no `inert` prop, so set it on the node.
  const panelRef = useRef(null);
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    if (open) el.removeAttribute("inert");
    else el.setAttribute("inert", "");
  }, [open]);

  // Clicking anywhere outside the panel (the dashboard, the bar below it, the
  // header) minimizes it. pointerdown rather than click so the panel is already
  // on its way out as the press lands on the live dashboard, and non-capturing
  // so a handler that stops propagation can still opt out.
  // Read through a ref so the listener is bound once per open/close, not on
  // every parent render - Watch re-renders on every live screencast frame.
  const onMinimizeRef = useRef(onMinimize);
  onMinimizeRef.current = onMinimize;
  useEffect(() => {
    if (!open) return undefined;
    function handlePointerDown(e) {
      if (!panelRef.current?.contains(e.target)) onMinimizeRef.current?.();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  return (
    <div
      ref={panelRef}
      aria-hidden={!open}
      className={cx(
        "glass-plate absolute bottom-3 left-4 z-30 flex w-[400px] flex-col overflow-hidden rounded-card-lg",
        // Bottom edge sits level with the minimized bubble in the bar below, so
        // the panel visibly grows out of it; top rises to 10px under the header.
        "top-[10px]",
        "max-[900px]:left-3 max-[900px]:right-3 max-[900px]:w-auto",
        // Scaling from the bottom-left corner makes it unfold out of the bubble.
        "origin-bottom-left transition-[opacity,transform] duration-300 ease-glass motion-reduce:transition-none",
        open ? "scale-100 opacity-100" : "pointer-events-none scale-[0.4] opacity-0",
      )}
    >
      {/* The panel's own frosting of the dashboard, as a CHILD rather than on the
          panel itself (`glass-plate` is `glass-deep` minus the blur). Identical
          to look at — it blurs the same backdrop through the same fill — but it
          leaves the panel free of backdrop-filter, so the layers ABOVE this one
          can blur the thread instead of silently re-blurring the dashboard. */}
      <div className="pointer-events-none absolute inset-0 z-0 backdrop-blur-[28px] backdrop-saturate-[1.4]" />

      {/* Thread layer (scrolls; fades out under the bars above it). */}
      <div className="chat-thread-fade absolute inset-0 z-[1]">{thread}</div>

      {/* Header floats free — no bar fill, no border. Two masked blur layers
          (gentle + strong) sit behind it, so messages soften on approach and
          the area around the title stays blurred without drawing a bar. */}
      <div className="thread-blur-veil-top pointer-events-none absolute inset-x-0 top-0 z-10 h-24 backdrop-blur-md" />
      <div className="thread-blur-veil-top pointer-events-none absolute inset-x-0 top-0 z-20 h-[4.5rem] backdrop-blur-2xl" />

      <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-center justify-between gap-2 px-4 pb-3 pt-3">
        {/* Editorial serif (see .agent-title in index.css) — the agent's own
            voice, distinct from the Inter UI around it. */}
        <span className="agent-title text-teal-ink">{title}</span>
        <button
          type="button"
          onClick={onMinimize}
          aria-label="Minimize the agent panel"
          title="Minimize"
          className="pointer-events-auto grid size-8 place-items-center rounded-pill text-fg/60 transition-colors hover:bg-glass-hover hover:text-fg focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-2"
        >
          <MinimizeIcon />
        </button>
      </div>

      {/* Composer floats free — it carries its own glass bubble, so there is no
          bar fill or border here. */}
      {footer && (
        <>
          {/* The frosting behind the composer. Runs from the panel's BOTTOM edge
              up across the bubble's whole footprint at full strength, then ramps
              off over RAMP px above it — so the blur reaches the bottom of the
              container instead of stopping at the bubble's top edge, and a
              message softens before it slides under rather than snapping.
              This layer, not `.glass-pane`, is what makes the composer read as
              glass: the bubble is a thin translucent fill sitting ON a blurred
              region. A backdrop-filter on the bubble itself cannot do this while
              nested in the panel — see `glass-plate` in index.css.
              Height and mask both key off the MEASURED composer height, so the
              full-strength band keeps matching the bubble as the textarea grows.
              The explicit mask replaces `.thread-blur-veil-bottom`, whose fixed
              50% split can't track a variable-height bubble. */}
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 z-[2] backdrop-blur-lg"
            style={{
              height: `${(footerHeight || IDLE_COMPOSER_H) + 12 + VEIL_RAMP}px`,
              maskImage: VEIL_MASK(footerHeight),
              WebkitMaskImage: VEIL_MASK(footerHeight),
            }}
          />
          <div className="absolute inset-x-0 bottom-0 z-30 p-3">{footer}</div>
        </>
      )}
    </div>
  );
}
