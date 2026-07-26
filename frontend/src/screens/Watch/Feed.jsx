import { useEffect, useRef, useState } from "react";
import { cx } from "../../components/ui/cx.js";
import CapsLabel from "../../components/ui/CapsLabel.jsx";
import Spinner from "../../components/ui/Spinner.jsx";
import { TERMINAL_STATUSES } from "./terminalStatuses.js";

const OUTCOME_CONFIG = {
  answered: { label: "ANSWER", labelColor: "text-green-ink", surface: "panel-tint-green", border: "border-l-green" },
  max_steps: {
    label: "BEST-EFFORT ANSWER",
    labelColor: "text-gold-ink",
    surface: "panel-tint-gold",
    border: "border-l-gold",
    subline: "Step budget reached before a confident answer.",
  },
  failed: {
    label: "NOT ANSWERABLE",
    labelColor: "text-gold-ink",
    surface: "panel-tint-gold",
    border: "border-l-gold",
    body: "The agent determined this dashboard cannot answer this question.",
  },
  error: { label: "SESSION ERROR", labelColor: "text-coral-ink", surface: "panel-tint-coral", border: "border-l-coral" },
  stopped: {
    label: "STOPPED",
    labelColor: "text-fg/60",
    surface: "panel",
    border: "border-l-glass-border-strong",
    body: "Stopped by you before the agent finished.",
  },
};

// revealMode: 'resolved' (fully static) | 'pending' | 'typing' | 'action-pending' | null (withheld)
function revealModeFor(runIdx, stepIdx, playback, atOutcome) {
  if (atOutcome || !playback) return "resolved";
  if (runIdx < playback.runIdx) return "resolved";
  if (runIdx > playback.runIdx) return null;
  if (stepIdx < playback.stepIdx) return "resolved";
  if (stepIdx > playback.stepIdx) return null;
  switch (playback.phase) {
    case "frame":
      return "pending";
    case "thought":
      return "typing";
    case "action-pending":
      return "action-pending";
    default:
      return "resolved";
  }
}

function ElapsedTimer({ since }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const totalSeconds = Math.max(0, Math.floor((now - since) / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return (
    <span className="font-mono text-xs text-fg/60">
      {m}:{String(s).padStart(2, "0")}
    </span>
  );
}

// Collapsed-by-default reasoning disclosure (Claude/ChatGPT style): a small
// muted "Thinking…/Thought" label with no box; clicking it reveals the reasoning
// text in a smaller, quieter type. stopPropagation so toggling it doesn't also
// select the step's frame in the Stage.
function ThoughtDisclosure({ text, active }) {
  const [open, setOpen] = useState(false);
  if (!text && !active) return null;
  return (
    <div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="flex items-center gap-1 text-xs text-fg/45 hover:text-fg/70"
      >
        <span className={cx("transition-transform", open && "rotate-90")}>›</span>
        <span className={active ? "animate-pulse" : ""}>{active ? "Thinking…" : "Thought"}</span>
      </button>
      {open && text && <p className="mt-1 pl-3.5 text-xs leading-relaxed text-fg/55">{text}</p>}
    </div>
  );
}

function ActionLine({ step, pending }) {
  if (pending) {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-control border border-glass-border px-3 py-2 font-mono text-[13px]">
        <span className="text-fg">▸ {step.planned.label}</span>
        <Spinner className="size-4 border-glass-border border-t-gold-ink" />
        <span className="text-fg/60">applying…</span>
      </div>
    );
  }

  const status = step.actionStatus;
  let icon = "✓";
  let colorClass = "text-green-ink";
  let explain = null;

  if (status === "rejected_loop") {
    icon = "✗";
    colorClass = "text-gold-ink";
    explain = "rejected: already tried — rethinking…";
  } else if (status === "rejected_target") {
    icon = "✗";
    colorClass = "text-gold-ink";
    explain = "rejected: unknown target — rethinking…";
  } else if (status === "error") {
    icon = "✗";
    colorClass = "text-coral-ink";
    explain = (step.errorMsg ?? "").slice(0, 120);
  }

  return (
    <div className="mt-2 rounded-control border border-glass-border px-3 py-2 font-mono text-[13px]">
      <div className={colorClass}>
        {icon} {step.planned.label}
      </div>
      {explain && <div className="mt-1 text-xs text-fg/60">{explain}</div>}
    </div>
  );
}

function StepCard({ step, revealMode, isSelected, onSelect }) {
  if (revealMode === null) return null;

  const isInvalid = !step.thought && !step.planned;

  return (
    <div
      className="cursor-pointer py-1"
      onClick={onSelect}
    >
      {revealMode === "pending" && (
        <div className="flex items-center gap-2">
          <Spinner className="border-glass-border border-t-gold-ink" />
          <span className="text-sm text-fg/70">Reading the dashboard…</span>
          {step.attempt && (
            <span className="text-xs text-gold-ink">
              Attempt {step.attempt} of 3 — the previous response was invalid.
            </span>
          )}
        </div>
      )}

      {revealMode !== "pending" && isInvalid && (
        <div className="text-sm">
          {step.actionStatus === "vlm_error" ? (
            <span className="text-coral-ink">VLM request failed: {(step.errorMsg ?? "").slice(0, 120)}</span>
          ) : (
            <span className="text-gold-ink">The model's response was invalid — retrying.</span>
          )}
        </div>
      )}

      {revealMode !== "pending" && !isInvalid && (
        <>
          <ThoughtDisclosure text={step.thought} active={revealMode === "typing"} />
          {step.planned && step.planned.label !== "Answer" && (revealMode === "action-pending" || revealMode === "resolved") && (
            <ActionLine step={step} pending={revealMode === "action-pending"} />
          )}
        </>
      )}
    </div>
  );
}

// Live (data-driven) step rendering: unlike the playback-driven StepCard
// above, there's no beat sequencer imposing artificial pacing here - the
// thought's own typewriter reveal is what gates the action card, since real
// `thought` and `action_planned` events arrive near-simultaneously (gating
// on raw event data alone would make the typewriter effectively invisible).
function LiveStepCard({ step, isSelected, onSelect }) {
  const isInvalid = step.actionStatus === "invalid_json" || step.actionStatus === "vlm_error";

  return (
    <div
      className="cursor-pointer py-1"
      onClick={onSelect}
    >
      {!step.thought && !isInvalid && (
        <div className="flex items-center gap-2">
          <Spinner className="border-glass-border border-t-gold-ink" />
          <span className="text-sm text-fg/70">Reading the dashboard…</span>
          {step.attempt && (
            <span className="text-xs text-gold-ink">
              Attempt {step.attempt} of 3 — the previous response was invalid.
            </span>
          )}
          {step.stepStartedAt && <ElapsedTimer since={step.stepStartedAt} />}
        </div>
      )}

      {isInvalid && (
        <div className="text-sm">
          {step.actionStatus === "vlm_error" ? (
            <span className="text-coral-ink">VLM request failed: {(step.errorMsg ?? "").slice(0, 120)}</span>
          ) : (
            <span className="text-gold-ink">The model's response was invalid — retrying.</span>
          )}
        </div>
      )}

      {step.thought && !isInvalid && (
        <>
          <ThoughtDisclosure text={step.thought} active={!step.planned} />
          {step.planned && step.planned.label !== "Answer" && <ActionLine step={step} pending={step.actionStatus == null} />}
        </>
      )}
    </div>
  );
}

// Renders one summary_json entry (see conversationRuntime.js's
// diffInventories / docs/LIVE_TAKEOVER_PLAN.md §4.1) as a short human line.
function formatFilterValue(v) {
  if (v == null) return "none";
  if (Array.isArray(v.appliedValues)) {
    return v.appliedValues.length ? v.appliedValues.join(", ") : "(cleared)";
  }
  if (v.min != null || v.max != null) return `${v.min ?? "…"}–${v.max ?? "…"}`;
  if ("min" in v || "max" in v) return "any"; // range filter present, no bounds set
  return String(v);
}

function formatScalar(v) {
  return v == null ? "none" : String(v);
}

function takeoverLineFor(entry) {
  switch (entry.kind) {
    case "filter":
      return `Changed ${entry.field}: ${formatFilterValue(entry.from)} → ${formatFilterValue(entry.to)}`;
    case "parameter":
      return `Set ${entry.field} to ${formatScalar(entry.to)}`;
    case "sheet":
      return `Switched to the ${formatScalar(entry.to)} tab`;
    default:
      return null;
  }
}

// Compact, muted card for a user takeover between two turns (Phase B2) -
// deliberately smaller/quieter than QuestionCard/OutcomeCard since it's a
// side-note in the thread, not a turn of its own.
function TakeoverCard({ takeover }) {
  const lines = (takeover.summary ?? []).map(takeoverLineFor).filter(Boolean);
  if (lines.length === 0) return null;
  return (
    <div className="panel-tint-violet rounded-control border-l-4 border-l-violet px-3 py-1.5">
      <CapsLabel className="text-violet-ink">YOU EXPLORED THE DASHBOARD</CapsLabel>
      <ul className="mt-1 space-y-0.5 text-xs text-fg/70">
        {lines.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

// User's question — a bubble pushed to the right so it reads as "yours".
function QuestionCard({ question }) {
  return (
    <div className="flex justify-end">
      <div className="panel-tint-teal max-w-[85%] rounded-card rounded-br-sm px-3 py-2">
        <p className="text-sm font-medium text-fg">{question}</p>
      </div>
    </div>
  );
}

function OutcomeCard({ run }) {
  const config = OUTCOME_CONFIG[run.status];
  if (!config) return null;

  const body = config.body ?? (run.status === "error" ? run.error : run.finalAnswer);
  const showConfidence = (run.status === "answered" || run.status === "max_steps") && run.confidence != null;

  // Agent's answer — a bubble kept to the left, mirroring the user's right-aligned question.
  return (
    <div className="flex justify-start">
      <div className={cx("max-w-[90%] rounded-card rounded-bl-sm border-l-4 p-4", config.surface, config.border)}>
        {config.label !== "ANSWER" && <div className={cx("text-label uppercase", config.labelColor)}>{config.label}</div>}
        <p className={cx("text-sm font-medium text-fg", config.label !== "ANSWER" && "mt-1")}>{body}</p>
        {showConfidence && <div className="mt-1 font-mono text-xs text-fg/60">confidence {run.confidence.toFixed(2)}</div>}
        {config.subline && <p className="mt-1 text-sm text-fg/70">{config.subline}</p>}
      </div>
    </div>
  );
}

export default function Feed({ runs, selected, onSelectStep, playback, atOutcome, isLive, liveSessionIds, trailingTakeover }) {
  const scrollRef = useRef(null);
  const userScrolledUpRef = useRef(false);

  useEffect(() => {
    const el = scrollRef.current;
    // offsetParent is null while the Feed tab is hidden (display:none) — skip
    // so a hidden Feed doesn't reset its scroll position on background renders.
    if (!el || el.offsetParent === null || userScrolledUpRef.current) return;
    el.scrollTop = el.scrollHeight;
  });

  function handleScroll(e) {
    const el = e.target;
    userScrolledUpRef.current = el.scrollTop + el.clientHeight < el.scrollHeight - 24;
  }

  // pt-14/pb-24 clear the panel's overlaid header and composer bars, so messages
  // come to rest fully visible rather than under the glass.
  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      aria-live="polite"
      className="thin-scrollbar flex h-full flex-col gap-3 overflow-y-auto px-4 pb-24 pt-14 text-fg"
    >
      {/* Spacer to push content to the bottom */}
      <div className="flex-1 shrink-0" />
      {runs.map((run, runIdx) => {
        const sortedIdxs = [...run.steps.keys()].sort((a, b) => a - b);
        const runOutcomeVisible = atOutcome ? true : !playback ? true : runIdx < playback.runIdx;

        return (
          <div key={run.sessionId} className="flex flex-col gap-2">
            {runIdx > 0 && (
              <div className="my-1 text-center font-mono text-xs text-fg/50">— new question —</div>
            )}
            {runIdx > 0 && run.precedingTakeover && <TakeoverCard takeover={run.precedingTakeover} />}
            <QuestionCard question={run.question} />
            {run.status === "loading" ? (
              <div className="font-mono text-xs text-fg/60">→ opening dashboard…</div>
            ) : (
              run.steps.size > 0 && <div className="font-mono text-xs text-fg/60">→ dashboard ready</div>
            )}

            {sortedIdxs.map((stepIdx) => {
              const step = run.steps.get(stepIdx);
              const isSelected = selected?.runIdx === runIdx && selected?.stepIdx === stepIdx;
              const onSelect = () => onSelectStep({ runIdx, stepIdx });

              // Scoped to the run(s) that were actually driven by a live SSE
              // subscription (liveSessionIds), not every run in the thread -
              // otherwise reattaching live to the running last turn of a
              // replayed multi-turn conversation would also render earlier,
              // already-resolved turns through LiveStepCard, spuriously
              // re-typewriting their thoughts on load (review fix).
              if (isLive && !playback && liveSessionIds?.has(run.sessionId)) {
                return <LiveStepCard key={stepIdx} step={step} isSelected={isSelected} onSelect={onSelect} />;
              }
              const revealMode = revealModeFor(runIdx, stepIdx, playback, atOutcome);
              return <StepCard key={stepIdx} step={step} revealMode={revealMode} isSelected={isSelected} onSelect={onSelect} />;
            })}

            {TERMINAL_STATUSES.has(run.status) && runOutcomeVisible && <OutcomeCard run={run} />}
          </div>
        );
      })}
      {/* A takeover captured after the LAST turn (e.g. right as a conversation
          was closed, with no further turn ever asked) has no run to attach to
          as `precedingTakeover` - render it as the final thread item instead
          (docs/LIVE_TAKEOVER_PLAN.md §9 Phase B3). */}
      {trailingTakeover && <TakeoverCard takeover={trailingTakeover} />}
    </div>
  );
}
