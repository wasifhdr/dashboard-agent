import { useState } from "react";
import { cx } from "./cx.js";

export default function CodeBlock({ lang, children, showCopy = true, className }) {
  const [copied, setCopied] = useState(false);
  const codeText = typeof children === "string" ? children : String(children ?? "");

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(codeText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access denied - the button simply doesn't confirm.
    }
  }

  return (
    <div className={cx("glass-deep overflow-hidden rounded-card", className)}>
      {(lang || showCopy) && (
        <div className="flex items-center justify-between border-b border-glass-border px-4 py-2">
          <span className="text-label uppercase text-mist/50">{lang}</span>
          {showCopy && (
            <button
              type="button"
              onClick={handleCopy}
              className="rounded-dot border border-glass-border px-2 py-1 text-xs font-bold text-mist hover:bg-glass-hover focus-visible:outline-[3px] focus-visible:outline-gold focus-visible:outline-offset-2"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          )}
        </div>
      )}
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed text-mist">{codeText}</pre>
    </div>
  );
}
