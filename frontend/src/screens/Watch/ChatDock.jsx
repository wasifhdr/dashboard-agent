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
export default function ChatPanel({ open, onMinimize, title = "Ask the Agent", thread, footer }) {
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
        "glass-deep absolute bottom-3 left-4 z-30 flex w-[400px] flex-col overflow-hidden rounded-card-lg",
        // Bottom edge sits level with the minimized bubble in the bar below, so
        // the panel visibly grows out of it; top rises to 10px under the header.
        "top-[10px]",
        "max-[900px]:left-3 max-[900px]:right-3 max-[900px]:w-auto",
        // Scaling from the bottom-left corner makes it unfold out of the bubble.
        "origin-bottom-left transition-[opacity,transform] duration-300 ease-glass motion-reduce:transition-none",
        open ? "scale-100 opacity-100" : "pointer-events-none scale-[0.4] opacity-0",
      )}
    >
      {/* Thread layer (scrolls; fades out under the bars above it). */}
      <div className="chat-thread-fade absolute inset-0 z-0">{thread}</div>

      {/* Header floats free — no bar fill, no border. Two masked blur layers
          (gentle + strong) sit behind it, so messages soften on approach and
          the area around the title stays blurred without drawing a bar. */}
      <div className="thread-blur-veil-top pointer-events-none absolute inset-x-0 top-0 z-10 h-24 backdrop-blur-md" />
      <div className="thread-blur-veil-top pointer-events-none absolute inset-x-0 top-0 z-20 h-[4.5rem] backdrop-blur-2xl" />

      <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-center justify-between gap-2 px-4 pb-3 pt-3">
        {/* Editorial serif (see .docent-title in index.css) — the docent's own
            voice, distinct from the Inter UI around it. */}
        <span className="docent-title text-teal-ink">{title}</span>
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
          bar fill or border here. Two masked blur layers (gentle + strong) sit
          behind it instead, so the thread still softens toward the bottom and
          the area AROUND the floating bubble stays blurred. */}
      {footer && (
        <>
          {/* Kept just tall enough to cover the composer bubble (~91px from the
              panel's bottom edge, including the p-3 gutter) plus a small halo.
              These used to be h-40/h-32 (160/128px), which reached far enough
              above the bubble to visibly haze the bottom of the newest answer —
              the one message you're most likely to be reading. The mask already
              fades each veil out over its top half, so a shorter box still
              softens the approach without smearing live text. */}
          <div className="thread-blur-veil-bottom pointer-events-none absolute inset-x-0 bottom-0 z-10 h-28 backdrop-blur-md" />
          <div className="thread-blur-veil-bottom pointer-events-none absolute inset-x-0 bottom-0 z-20 h-24 backdrop-blur-2xl" />
          <div className="absolute inset-x-0 bottom-0 z-30 p-3">{footer}</div>
        </>
      )}
    </div>
  );
}
