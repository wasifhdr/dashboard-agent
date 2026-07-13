import { useEffect, useMemo, useState } from "react";
import { listConversations, listStandaloneSessions } from "../../api.js";
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

// Turns a raw GET /api/conversations row (conversation + turn_count/last_*
// summary fields, see backend stage 1) into the same row shape a standalone
// session produces, so both render through one <Table> with no branching in
// the JSX below.
// created_at here is deliberately the conversation's *last turn* timestamp
// (falling back to the conversation's own created_at for a zero-turn
// conversation), not c.created_at - otherwise a conversation that just got a
// new turn after sitting idle would still sort/display by when it was first
// opened, burying the most-recently-active conversation under newer,
// unrelated activity (review fix).
function conversationToRow(c) {
  return {
    key: `conversation-${c.id}`,
    kind: "conversation",
    id: c.id,
    created_at: c.last_turn_at ?? c.created_at,
    dashboard_url: c.dashboard_url,
    dashboard_name: c.dashboard_name,
    question: c.last_question ?? "(no turns yet)",
    status: c.last_status,
    answer: c.last_answer,
    turnCount: c.turn_count,
  };
}

// Legacy sessions row (conversation_id IS NULL) - never part of a
// conversation, so it keeps behaving exactly as the old flat list did.
function standaloneToRow(s) {
  return {
    key: `session-${s.id}`,
    kind: "session",
    id: s.id,
    created_at: s.created_at,
    dashboard_url: s.dashboard_url,
    dashboard_name: s.dashboard_name,
    question: s.question,
    status: s.status,
    answer: s.final_answer,
    turnCount: null,
  };
}

export default function History({ onOpenReplay, onGoToLanding }) {
  // null = "not loaded yet"; [] = "loaded, empty". Kept as two independent
  // sources (rather than one combined list) so a failure/emptiness in either
  // never blocks the other from rendering.
  const [conversations, setConversations] = useState(null);
  const [standaloneSessions, setStandaloneSessions] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    listConversations()
      .then(setConversations)
      .catch((e) => {
        setConversations([]);
        setError((prev) => prev || e.message);
      });
    listStandaloneSessions()
      .then(setStandaloneSessions)
      .catch((e) => {
        setStandaloneSessions([]);
        setError((prev) => prev || e.message);
      });
  }, []);

  // Unified, sorted list: conversations (one row per conversation, summarized
  // by its latest turn) merged with legacy standalone sessions (one row per
  // session, unchanged), newest first by each row's own created_at.
  const rows = useMemo(() => {
    if (conversations === null || standaloneSessions === null) return null;
    return [...conversations.map(conversationToRow), ...standaloneSessions.map(standaloneToRow)].sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at),
    );
  }, [conversations, standaloneSessions]);

  function handleRowClick(row) {
    onOpenReplay({ kind: row.kind, id: row.id });
  }

  return (
    <div>
      <h1 className="text-h1">Session history</h1>
      <p className="mt-1 text-sm text-fg/70">
        {rows ? `${rows.length} entr${rows.length === 1 ? "y" : "ies"}` : "Loading…"}
      </p>

      {error && <div className="mt-4 text-sm text-coral-ink">{error}</div>}

      {rows && rows.length === 0 && (
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

      {rows && rows.length > 0 && (
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
              {rows.map((row) => {
                const badge = STATUS_BADGE[row.status];
                return (
                  <Table.Tr key={row.key} className="cursor-pointer" onClick={() => handleRowClick(row)}>
                    <Table.Td>
                      <span title={row.question}>{truncate(row.question, 60)}</span>
                      {row.kind === "conversation" && row.turnCount > 0 && (
                        <span className="ml-1.5 text-xs text-fg/40">
                          ({row.turnCount} question{row.turnCount === 1 ? "" : "s"})
                        </span>
                      )}
                    </Table.Td>
                    <Table.Td>{row.dashboard_name || hostnameOf(row.dashboard_url)}</Table.Td>
                    <Table.Td>
                      {badge && (
                        <Badge variant={badge.variant} pulse={badge.pulse}>
                          {badge.label}
                        </Badge>
                      )}
                    </Table.Td>
                    <Table.Td mono>{new Date(row.created_at).toLocaleString()}</Table.Td>
                    <Table.Td mono>{truncate(row.answer, 40) || "—"}</Table.Td>
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
