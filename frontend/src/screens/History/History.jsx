import { useEffect, useState } from "react";
import { listSessions } from "../../api.js";
import Table from "../../components/ui/Table.jsx";
import Badge from "../../components/ui/Badge.jsx";
import Button from "../../components/ui/Button.jsx";
import EmptyState from "../../components/ui/EmptyState.jsx";

const STATUS_BADGE = {
  answered: { variant: "success", label: "Answered" },
  failed: { variant: "pending", label: "Failed" },
  max_steps: { variant: "pending", label: "Max steps" },
  error: { variant: "failed", label: "Error" },
  stopped: { variant: "neutral", label: "Stopped" },
  running: { variant: "info", label: "Running", pulse: true },
};

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function truncate(text, max) {
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export default function History({ onOpenReplay, onGoToLanding }) {
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    listSessions()
      .then(setSessions)
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div>
      <h1 className="text-h1">Session history</h1>
      <p className="mt-1 text-sm text-fg/70">
        {sessions ? `${sessions.length} session${sessions.length === 1 ? "" : "s"}` : "Loading…"}
      </p>

      {error && <div className="mt-4 text-sm text-coral-ink">{error}</div>}

      {sessions && sessions.length === 0 && (
        <div className="mt-8">
          <EmptyState
            statement={
              <>
                No sessions <span className="text-gold-ink">yet.</span>
              </>
            }
            line="Ask your first question from the landing page."
            action={
              <Button variant="primary" onClick={onGoToLanding}>
                Go to landing
              </Button>
            }
          />
        </div>
      )}

      {sessions && sessions.length > 0 && (
        <div className="mt-6">
          <Table>
            <thead>
              <tr>
                <Table.Th>Question</Table.Th>
                <Table.Th>Dashboard</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Asked</Table.Th>
                <Table.Th>Answer</Table.Th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const badge = STATUS_BADGE[s.status];
                return (
                  <Table.Tr key={s.id} className="cursor-pointer" onClick={() => onOpenReplay(s.id)}>
                    <Table.Td>
                      <span title={s.question}>{truncate(s.question, 60)}</span>
                    </Table.Td>
                    <Table.Td>{s.dashboard_name || hostnameOf(s.dashboard_url)}</Table.Td>
                    <Table.Td>
                      {badge && (
                        <Badge variant={badge.variant} pulse={badge.pulse}>
                          {badge.label}
                        </Badge>
                      )}
                    </Table.Td>
                    <Table.Td mono>{new Date(s.created_at).toLocaleString()}</Table.Td>
                    <Table.Td mono>{truncate(s.final_answer, 40) || "—"}</Table.Td>
                  </Table.Tr>
                );
              })}
            </tbody>
          </Table>
        </div>
      )}
    </div>
  );
}
