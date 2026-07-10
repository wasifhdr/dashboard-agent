import CapsLabel from "../../components/ui/CapsLabel.jsx";
import Badge from "../../components/ui/Badge.jsx";
import CodeBlock from "../../components/ui/CodeBlock.jsx";

const ACTION_STATUS_BADGE = {
  ok: { variant: "success", label: "ok" },
  rejected_loop: { variant: "pending", label: "rejected_loop" },
  rejected_target: { variant: "pending", label: "rejected_target" },
  error: { variant: "failed", label: "error" },
  invalid_json: { variant: "failed", label: "invalid_json" },
  vlm_error: { variant: "failed", label: "vlm_error" },
};

export default function Inspect({ step }) {
  if (!step) {
    return <div className="panel h-full rounded-card p-4 text-sm text-fg/60">Select a step to inspect.</div>;
  }

  const statusBadge = ACTION_STATUS_BADGE[step.actionStatus];
  const inv = step.inventorySummary;

  return (
    <div className="panel flex h-full flex-col gap-4 overflow-y-auto rounded-card p-4 text-fg">
      <div>
        <CapsLabel className="text-fg/60">Thought</CapsLabel>
        <p className="mt-1 text-sm leading-relaxed">{step.thought || <span className="text-fg/50">(none)</span>}</p>
      </div>

      <div>
        <CapsLabel className="text-fg/60">Action</CapsLabel>
        {step.action ? (
          <div className="mt-1">
            <CodeBlock lang="JSON" showCopy={false}>
              {JSON.stringify(step.action, null, 2)}
            </CodeBlock>
          </div>
        ) : (
          <p className="mt-1 text-sm text-fg/50">(none)</p>
        )}
      </div>

      <div>
        <CapsLabel className="text-fg/60">Status</CapsLabel>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {statusBadge && <Badge variant={statusBadge.variant}>{statusBadge.label}</Badge>}
          {step.errorMsg && <span className="text-sm text-coral-ink">{step.errorMsg}</span>}
        </div>
      </div>

      {inv && (
        <div>
          <CapsLabel className="text-fg/60">Inventory (this step)</CapsLabel>
          <div className="mt-1 font-mono text-sm text-fg/80">
            <div>Active sheet: {inv.activeSheet}</div>
            <div>{inv.sheetCount} sheet(s)</div>
            <div>{inv.filterCount} filter(s)</div>
            <div>{inv.parameterCount} parameter(s)</div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {step.durationMs != null && (
          <span className="font-mono text-sm text-fg/70">{(step.durationMs / 1000).toFixed(1)} s</span>
        )}
        {step.settleTimeout && <Badge variant="pending">settle timeout</Badge>}
      </div>
    </div>
  );
}
