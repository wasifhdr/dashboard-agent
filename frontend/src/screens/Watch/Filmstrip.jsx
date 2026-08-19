import { useState } from "react";
import { cx } from "../../components/ui/cx.js";

function statusDotColor(actionStatus) {
  if (!actionStatus || actionStatus === "ok") return null;
  // ok_nochange sits with the rejections, not with ok: the action ran but hit
  // nothing, so the step is a non-advance and should be scannable as one.
  if (
    actionStatus === "rejected_loop" ||
    actionStatus === "rejected_target" ||
    actionStatus === "rejected_claim" ||
    actionStatus === "rejected_state" ||
    actionStatus === "ok_nochange"
  )
    return "bg-gold";
  return "bg-coral"; // error, invalid_json, vlm_error
}

function HistoryIcon({ className = "size-5" }) {
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
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  );
}

// Step-history control: the per-step screenshot thumbnails. Lives inline in the
// bar under the dashboard (next to the chat dock trigger); collapsed by default
// to a history icon + frame count, and the scrollable thumbnail strip pops up
// ABOVE the bar when expanded, so the bar's height never changes. Renders
// nothing until the first frame exists.
export default function Filmstrip({ runs, selected, onSelect }) {
  const [expanded, setExpanded] = useState(false);

  const items = [];
  runs.forEach((run, runIdx) => {
    const sortedIdxs = [...run.steps.keys()].sort((a, b) => a - b);
    sortedIdxs.forEach((stepIdx, i) => {
      const step = run.steps.get(stepIdx);
      if (!step.frameUrl) return;
      items.push({ runIdx, stepIdx, step, isRunStart: i === 0 && runIdx > 0 });
    });
  });

  if (!items.length) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-label={`${expanded ? "Hide" : "Show"} step history (${items.length} frame${items.length === 1 ? "" : "s"})`}
        aria-expanded={expanded}
        title="Step history"
        className="glass-teal flex items-center gap-2 rounded-pill px-3 py-2 text-fg/80 transition-transform duration-150 ease-glass hover:scale-[1.03] hover:text-fg active:scale-[0.97] focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-2"
      >
        <HistoryIcon />
        <span className="font-mono text-xs tabular-nums">{items.length}</span>
      </button>

      {expanded && (
        <div className="glass-raised absolute bottom-full left-0 z-30 mb-2 flex w-max max-w-[min(46rem,calc(100vw-2rem))] flex-col gap-2 rounded-card p-2">
          <div className="flex items-center justify-between gap-4 px-1">
            <div className="flex items-center gap-2 text-fg/70">
              <HistoryIcon className="size-4" />
              <span className="text-label uppercase">Step history</span>
            </div>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              aria-label="Collapse step history"
              className="rounded-pill p-1 text-fg/60 transition-colors hover:bg-glass-hover hover:text-fg"
            >
              <svg
                viewBox="0 0 24 24"
                className="size-4"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
          </div>
          <div className="thin-scrollbar flex gap-2 overflow-x-auto">
        {items.map(({ runIdx, stepIdx, step, isRunStart }) => {
          const isSelected = selected && selected.runIdx === runIdx && selected.stepIdx === stepIdx;
          const dotColor = statusDotColor(step.actionStatus);
          return (
            <button
              key={`${runIdx}-${stepIdx}`}
              type="button"
              onClick={() => onSelect({ runIdx, stepIdx })}
              className={cx(
                "relative h-[55px] w-[88px] flex-shrink-0 overflow-hidden rounded-dot border bg-glass",
                isRunStart && "ml-2 border-l-2 border-l-glass-border-strong pl-2",
                isSelected ? "border-2 border-teal shadow-teal-glow" : "border-glass-border",
                "focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-2",
              )}
            >
              <img src={step.frameUrl} alt="" className="h-full w-full object-cover" />
              {dotColor && <span className={cx("absolute right-1 top-1 size-1.5 rounded-pill", dotColor)} />}
            </button>
          );
        })}
          </div>
        </div>
      )}
    </div>
  );
}
