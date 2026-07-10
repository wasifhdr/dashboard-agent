import { cx } from "./cx.js";

export default function CapsLabel({ as: As = "p", className, children }) {
  return <As className={cx("text-label uppercase text-fg/60", className)}>{children}</As>;
}
