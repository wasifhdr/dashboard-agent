import { cx } from "./cx.js";

// Surface tiers (DESIGN.md §4): only `feature` blurs (glass); everything else
// is a non-blurred panel. An `accent` swaps the panel for its tinted variant —
// the colorful-zone move — so a card is either `panel` OR `panel-tint-*`,
// never both (they'd fight over background/border).
const PANEL_TINT = {
  green: "panel-tint-green",
  teal: "panel-tint-teal",
  sky: "panel-tint-sky",
  violet: "panel-tint-violet",
  gold: "panel-tint-gold",
  coral: "panel-tint-coral",
};

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

// Animating box-shadow directly forces the browser to re-rasterize the blur
// every frame, which reads as choppy no matter the duration/easing. Instead
// the hover shadow lives on a ::after overlay (same box, transparent fill) and
// only its opacity crossfades in - opacity is compositor-only, so it's always
// smooth regardless of how large the blur is. The real element only animates
// transform (also compositor-only) for the lift.
const CLICKABLE_EXTRA =
  "relative block w-full text-left transition-[transform,background-color] duration-1000 ease-glass " +
  "hover:-translate-y-1 " +
  "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] " +
  "after:opacity-0 after:shadow-glass-lg after:transition-opacity after:duration-1000 after:ease-glass " +
  "hover:after:opacity-100 " +
  "focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-2";

export default function Card({ variant = "standard", accent, onClick, className, children, ...props }) {
  const isClickable = variant === "clickable" || typeof onClick === "function";
  const baseVariant = variant === "clickable" ? "standard" : variant;

  let surface;
  let accentClass = null;
  if (baseVariant === "feature") {
    surface = "rounded-card-lg glass-raised p-6";
    if (accent) accentClass = ACCENT_BORDER_T[accent];
  } else if (baseVariant === "callout") {
    surface = "rounded-control panel p-4";
    accentClass = ACCENT_BORDER_L[accent ?? "gold"];
  } else if (baseVariant === "quiet") {
    surface = accent ? `rounded-card ${PANEL_TINT[accent]} p-5` : "rounded-card panel p-5";
  } else {
    // standard
    surface = accent
      ? `rounded-card ${PANEL_TINT[accent]} p-5 shadow-panel`
      : "rounded-card panel p-5 shadow-panel";
    if (accent) accentClass = ACCENT_BORDER_T[accent];
  }

  const classes = cx(surface, isClickable && CLICKABLE_EXTRA, accentClass, className);

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
