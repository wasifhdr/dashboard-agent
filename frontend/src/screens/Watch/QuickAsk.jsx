import { useCallback, useEffect, useRef, useState } from "react";
import { cx } from "../../components/ui/cx.js";
import { ChatDockTrigger } from "./ChatDock.jsx";
import { useSpeechRecognition } from "../../hooks/useSpeechRecognition.js";

function MicIcon({ className = "size-[18px]" }) {
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
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="22" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

// Voice-first quick ask, hung off the MINIMIZED chat dock.
//
// Hovering the bubble (while the agent isn't working) raises a mic above it;
// clicking it opens a floating glass bubble beside the mic that fills with the
// live transcript as you speak, and sending from there starts a turn WITHOUT
// expanding the thread — the dock just flips to its "Thinking" face. The whole
// point is asking a follow-up without giving up the full-canvas dashboard, so
// nothing here is allowed to open the panel.
//
// The transcript is a real textarea, not a read-only readout: recognition
// mangles exactly the words these dashboards are full of (publisher names,
// "Tableau"), and re-dictating a whole question to fix one word is worse than
// typing the fix.
export default function QuickAsk({ isRunning, unread, onOpen, onVoiceAsk }) {
  const [hovered, setHovered] = useState(false);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  // Text already in the box when the current dictation leg started. Each
  // recognition event carries the whole session transcript, so the field is
  // rebuilt as base + transcript — that's what lets Chrome revise an interim
  // guess in place instead of appending it twice. Also means a user edit made
  // mid-dictation is overwritten by the next event, so `stop()` runs before
  // the textarea is realistically editable.
  const baseRef = useRef("");
  const dictation = useSpeechRecognition({
    onTranscript: useCallback((transcript) => {
      const base = baseRef.current;
      setValue(base && transcript ? `${base} ${transcript}` : base + transcript);
    }, []),
  });

  const close = useCallback(() => {
    // `cancel`, not `stop`: the draft is being thrown away, and a transcript
    // that landed a second later would refill a box nobody is looking at.
    dictation.cancel();
    setOpen(false);
    setValue("");
  }, [dictation]);

  function handleMicClick() {
    if (!open) {
      baseRef.current = "";
      setValue("");
      setOpen(true);
      dictation.start();
      return;
    }
    // Second click is a stop/resume for the current draft, not a reset.
    if (dictation.listening) dictation.stop();
    else {
      baseRef.current = value.trim();
      dictation.start();
    }
  }

  async function handleSubmit(e) {
    e?.preventDefault();
    const question = value.trim();
    if (!question || submitting) return;
    dictation.cancel();
    setSubmitting(true);
    try {
      await onVoiceAsk(question);
      setOpen(false);
      setValue("");
    } finally {
      setSubmitting(false);
    }
  }

  // A turn starting (from here or the panel) retires the quick-ask UI — the
  // trigger becomes the "Thinking" pill and there's nothing to type into.
  useEffect(() => {
    if (isRunning && open) close();
  }, [isRunning, open, close]);

  // Escape closes; click-outside closes. Both skipped while shut so the
  // listeners aren't bound for the whole session.
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (e.key === "Escape") close();
    }
    function onPointerDown(e) {
      if (!wrapRef.current?.contains(e.target)) close();
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, close]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Grow the textarea with the question, capped so a rambling dictation can't
  // push the bubble off the top of the screen.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  // The mic is offered only when a turn could actually be started: not while
  // the agent is working, and not on browsers without the Web Speech API.
  const showMic = dictation.supported && !isRunning && (hovered || open);

  return (
    <div
      ref={wrapRef}
      className="relative flex items-center"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <ChatDockTrigger isRunning={isRunning} unread={unread} onOpen={onOpen} />

      {/* Rises out of the TOP of the bubble. Absolutely positioned so revealing
          it never reflows the bar — the step history beside the dock stays put.
          The 8px gap between this and the bubble is `pb-2` (padding, INSIDE the
          box) rather than a margin: the box then touches the bubble's top edge,
          so moving the cursor up into the mic never leaves this element's DOM
          subtree and can't fire the wrapper's mouseleave mid-travel. With a
          margin there, the mic would vanish just as you reached for it. */}
      {dictation.supported && !isRunning && (
        <div
          className={cx(
            "absolute bottom-full left-0 z-40 flex flex-col items-start gap-1.5 pb-2",
            "transition-[opacity,transform] duration-250 ease-glass motion-reduce:transition-none",
            showMic ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-1.5 opacity-0",
          )}
        >
          {/* Mic permission / hardware failures, surfaced next to the control
              that caused them rather than inside the collapsed panel. */}
          {open && dictation.error && (
            <div className="glass-raised max-w-[360px] rounded-control px-3 py-1.5 text-xs text-coral-ink">
              {dictation.error}
            </div>
          )}

          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={handleMicClick}
              disabled={dictation.transcribing}
              aria-label={dictation.listening ? "Stop dictating" : "Ask by voice"}
              aria-pressed={dictation.listening}
              title={dictation.listening ? "Stop dictating" : "Ask by voice"}
              tabIndex={showMic ? 0 : -1}
              className={cx(
                "glass-teal grid size-9 shrink-0 place-items-center rounded-pill transition-colors",
                "focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-2",
                dictation.listening ? "ready-ping relative text-coral-ink" : "text-teal-ink",
                dictation.transcribing && "opacity-70",
              )}
            >
              <MicIcon />
            </button>

            {/* Transcript bubble, beside the mic. */}
            {open && (
              <form
                onSubmit={handleSubmit}
                className={cx(
                  "glass-raised flex w-[360px] items-end gap-2 rounded-card py-2 pl-3 pr-2",
                  "max-[900px]:w-[min(360px,calc(100vw-6rem))]",
                )}
              >
                <textarea
                  ref={inputRef}
                  rows={1}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) handleSubmit(e);
                  }}
                  placeholder={
                    dictation.listening
                      ? "Listening…"
                      : dictation.transcribing
                        ? "Cleaning up what you said…"
                        : "Speak or type a question…"
                  }
                  aria-label="Voice question"
                  className="thin-scrollbar min-w-0 flex-1 resize-none bg-transparent py-1 text-sm leading-relaxed text-fg placeholder:text-fg/40 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={submitting || !value.trim()}
                  aria-label="Send question"
                  title="Send question"
                  className={cx(
                    "grid size-8 shrink-0 place-items-center rounded-pill bg-teal text-night transition-[opacity,transform]",
                    "hover:bg-teal-deep hover:text-snow active:scale-[0.97]",
                    "focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-2",
                    "disabled:pointer-events-none disabled:opacity-40",
                  )}
                >
                  <SendIcon />
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
