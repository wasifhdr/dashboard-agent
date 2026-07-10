import { cx } from "./cx.js";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-pill font-bold " +
  "transition-[transform,box-shadow,background-color,opacity] duration-150 ease-glass " +
  "focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-2 " +
  "disabled:pointer-events-none disabled:opacity-40 disabled:shadow-none";

const PRESS_PHYSICS = "active:scale-[0.97] active:duration-150 active:ease-bounce";

const SIZES = {
  md: "px-5 py-2.5 text-[15px]",
  sm: "px-4 py-1.5 text-sm",
};

// Solid accent fills use the constant night/snow pair (never theme `fg`):
// bright accents read best with near-black text; -deep hovers with near-white.
const VARIANTS = {
  default: "panel text-fg hover:bg-glass-hover",
  primary: "border border-transparent bg-teal text-night shadow-teal-glow hover:bg-teal-deep hover:text-snow",
  gold: "border border-transparent bg-gold text-night shadow-gold-glow hover:bg-gold-deep hover:text-snow",
  danger: "border border-transparent bg-coral text-night shadow-coral-glow hover:bg-coral-deep hover:text-snow",
  ghost: "border-transparent bg-transparent text-fg/70 shadow-none hover:bg-glass hover:text-fg",
  "danger-ghost": "border-transparent bg-transparent text-coral-ink shadow-none hover:bg-coral/10",
};

// Ghost variants carry no press physics (DESIGN.md §5) — they simply omit the
// press classes rather than trying to override them.
const GHOST_VARIANTS = new Set(["ghost", "danger-ghost"]);

export default function Button({ variant = "default", size = "md", type = "button", className, children, ...props }) {
  const isGhost = GHOST_VARIANTS.has(variant);
  return (
    <button
      type={type}
      className={cx(BASE, SIZES[size], VARIANTS[variant], !isGhost && PRESS_PHYSICS, className)}
      {...props}
    >
      {children}
    </button>
  );
}
