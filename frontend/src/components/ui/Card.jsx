import { cx } from "./cx.js";

const VARIANT_CLASSES = {
  feature: "rounded-card-lg glass-raised p-6",
  standard: "rounded-card glass p-5",
  quiet: "rounded-card border border-glass-border bg-glass/60 p-5",
  callout: "rounded-control glass p-4",
};

const CLICKABLE_EXTRA =
  "block w-full text-left transition-[transform,box-shadow,background-color] duration-200 ease-glass " +
  "hover:-translate-y-1 hover:shadow-glass-lg hover:bg-glass-hover " +
  "focus-visible:outline-[3px] focus-visible:outline-gold focus-visible:outline-offset-2";

// Only ever one of these is emitted per card (never two colors on the same
// side) so there is no same-specificity utility clash in the generated CSS.
const ACCENT_BORDER_T = {
  green: "border-t-4 border-t-green",
  teal: "border-t-4 border-t-teal",
  sky: "border-t-4 border-t-sky",
  violet: "border-t-4 border-t-violet",
  gold: "border-t-4 border-t-gold",
  coral: "border-t-4 border-t-coral",
};

const ACCENT_BORDER_L = {
  green: "border-l-4 border-l-green",
  teal: "border-l-4 border-l-teal",
  sky: "border-l-4 border-l-sky",
  violet: "border-l-4 border-l-violet",
  gold: "border-l-4 border-l-gold",
  coral: "border-l-4 border-l-coral",
};

export default function Card({ variant = "standard", accent, onClick, className, children, ...props }) {
  const isClickable = variant === "clickable" || typeof onClick === "function";
  const baseVariant = variant === "clickable" ? "standard" : variant;

  const accentClass =
    baseVariant === "callout" ? ACCENT_BORDER_L[accent ?? "gold"] : accent ? ACCENT_BORDER_T[accent] : null;

  const classes = cx(
    VARIANT_CLASSES[baseVariant] ?? VARIANT_CLASSES.standard,
    isClickable && CLICKABLE_EXTRA,
    accentClass,
    className,
  );

  if (isClickable) {
    return (
      <button type="button" onClick={onClick} className={classes} {...props}>
        {children}
      </button>
    );
  }
  return (
    <div className={classes} {...props}>
      {children}
    </div>
  );
}
