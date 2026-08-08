import { useCallback, useEffect, useRef, useState } from "react";
import Button from "./Button.jsx";


// A promise-based replacement for window.confirm, so call sites still read
// top-to-bottom:
//
//   const [confirm, confirmProps] = useConfirm();
//   ...
//   if (!(await confirm({ title, body, confirmLabel }))) return;
//   ...
//   <ConfirmDialog {...confirmProps} />
//
// The resolver is held in a ref rather than in state: it is not rendered, and
// keeping it out of state means answering the dialog schedules exactly one
// re-render (clearing the request) instead of two.
export function useConfirm() {
  const [request, setRequest] = useState(null);
  const resolveRef = useRef(null);

  const confirm = useCallback(
    (options) =>
      new Promise((resolve) => {
        // A second confirm() while one is open would strand the first promise
        // forever; decline it instead so its caller unwinds.
        resolveRef.current?.(false);
        resolveRef.current = resolve;
        setRequest(options);
      }),
    [],
  );

  const onResolve = useCallback((answer) => {
    setRequest(null);
    resolveRef.current?.(answer);
    resolveRef.current = null;
  }, []);

  return [confirm, { request, onResolve }];
}

// Modal confirmation. Glass chrome over a dimmed, blurred page (DESIGN.md §4),
// styled to match the app rather than the browser's own dialog.
//
// `request` is { title, body, confirmLabel?, cancelLabel?, danger? } or null
// when nothing is being asked.
export default function ConfirmDialog({ request, onResolve }) {
  // Escape cancels, Enter confirms — the two things a native confirm() gives
  // you for free and are jarring to lose. Bound on document so they work
  // wherever focus happens to be.
  useEffect(() => {
    if (!request) return undefined;
    function onKeyDown(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        onResolve(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        onResolve(true);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [request, onResolve]);

  if (!request) return null;

  const { title, body, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false } = request;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-night/50 p-6 backdrop-blur-sm"
      // Clicking the scrim cancels, like clicking away from any other overlay in
      // this app. Guarded to the scrim itself so a click inside doesn't bubble.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onResolve(false);
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
        className="glass-raised w-full max-w-md rounded-card-lg p-6"
      >
        <h2 id="confirm-title" className="agent-title text-fg">
          {title}
        </h2>
        <p id="confirm-body" className="mt-2 text-[15px] leading-relaxed text-fg/70">
          {body}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onResolve(false)}>
            {cancelLabel}
          </Button>
          {/* autoFocus rather than a ref: Button is a plain function component
              and does not forward refs, and the dialog subtree mounts fresh on
              every open, so mount-time focus is exactly the right moment. */}
          <Button autoFocus variant={danger ? "danger" : "primary"} onClick={() => onResolve(true)}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
