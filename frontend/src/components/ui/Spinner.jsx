import { cx } from "./cx.js";

export default function Spinner({ className }) {
  return <span className={cx("size-5 animate-spin rounded-pill border-2 border-glass-border border-t-teal", className)} />;
}
