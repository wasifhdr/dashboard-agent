import { forwardRef } from "react";
import { cx } from "./cx.js";

const INPUT_BASE =
  "w-full panel rounded-control px-3.5 py-2 text-[15px] text-fg " +
  "placeholder:text-fg/40 focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-2 " +
  "disabled:opacity-40";

const INPUT_ERROR = "border-coral/60 focus-visible:outline-coral-ink";

const Field = forwardRef(function Field({ as = "input", label, error, help, className, id, ...props }, ref) {
  const As = as;
  return (
    <div>
      {label && (
        <label htmlFor={id} className="mb-1.5 block text-label uppercase text-fg/60">
          {label}
        </label>
      )}
      <As ref={ref} id={id} className={cx(INPUT_BASE, error && INPUT_ERROR, className)} {...props} />
      {error && <div className="mt-1 text-xs font-medium text-coral-ink">{error}</div>}
      {!error && help && <div className="mt-1 text-xs text-fg/60">{help}</div>}
    </div>
  );
});

export default Field;

export const Checkbox = forwardRef(function Checkbox({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      type="checkbox"
      className={cx(
        "size-4 rounded-dot border-2 border-glass-border-strong accent-teal " +
          "focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-2",
        className,
      )}
      {...props}
    />
  );
});
