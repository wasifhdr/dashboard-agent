import Badge from "../../components/ui/Badge.jsx";
import SegmentedMeter from "../../components/ui/SegmentedMeter.jsx";
import Card from "../../components/ui/Card.jsx";
import { WARNING_LABEL } from "./warningLabels.js";

const STATUS_BADGE = {
  running: { variant: "info", label: "Running", pulse: true },
  answered: { variant: "success", label: "Answered" },
  failed: { variant: "pending", label: "NOT ANSWERABLE" },
  max_steps: { variant: "pending", label: "BEST-EFFORT" },
  error: { variant: "failed", label: "Error" },
  stopped: { variant: "neutral", label: "Stopped" },
};

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export default function StatusBar({ dashboard, run, maxSteps }) {
  const badge = run ? STATUS_BADGE[run.status] : null;
  const stepsUsed = run ? run.steps.size : 0;
  const warningKinds = run ? [...new Set(run.warnings.map((w) => w.kind))] : [];

  return (
    <div className="glass-deep px-6 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="truncate text-h3">{dashboard?.name || (dashboard?.url ? hostnameOf(dashboard.url) : "")}</h3>
          <div className="truncate font-mono text-[13px] text-mist/45">{dashboard?.url}</div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-4">
          <SegmentedMeter used={stepsUsed} total={maxSteps} caption={`${stepsUsed} / ${maxSteps}`} />
          {badge && (
            <Badge variant={badge.variant} pulse={badge.pulse}>
              {badge.label}
            </Badge>
          )}
        </div>
      </div>
      {warningKinds.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {warningKinds.map((kind) => (
            <Card key={kind} variant="callout" accent="gold" className="py-2 text-sm text-mist/80">
              {WARNING_LABEL[kind] ?? kind}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
