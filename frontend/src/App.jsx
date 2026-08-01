import { useState, useEffect } from "react";
import { Routes, Route, Navigate, useNavigate, useParams, useLocation } from "react-router-dom";
import AppShell from "./components/AppShell.jsx";
import ConfirmDialog, { useConfirm } from "./components/ui/ConfirmDialog.jsx";
import Landing from "./screens/Landing/Landing.jsx";
import Watch from "./screens/Watch/Watch.jsx";
import History from "./screens/History/History.jsx";
import { getActiveConversation } from "./api.js";

// Maps a pathname back to the coarse "view" AppShell styles itself around.
// AppShell only needs to know which of the three layouts to use, not the
// specific route.
function viewForPath(pathname) {
  if (pathname.startsWith("/watch") || pathname.startsWith("/replay")) return "watch";
  if (pathname.startsWith("/history")) return "history";
  return "landing";
}

function ConversationReplay({ onActiveRunChange, onDashboardChange }) {
  const { id } = useParams();
  const navigate = useNavigate();
  return (
    <Watch
      mode="replay"
      conversationId={id}
      onBack={() => navigate("/history")}
      onActiveRunChange={onActiveRunChange}
      onDashboardChange={onDashboardChange}
    />
  );
}

function SessionReplay({ onActiveRunChange, onDashboardChange }) {
  const { id } = useParams();
  const navigate = useNavigate();
  return (
    <Watch
      mode="replay"
      sessionId={id}
      onBack={() => navigate("/history")}
      onActiveRunChange={onActiveRunChange}
      onDashboardChange={onDashboardChange}
    />
  );
}

// Live watch. On mount, ask the backend whether a conversation is already
// running: after a refresh one usually is, and re-attaching to it preserves
// the open dashboard, its filters, and the thread. Only when nothing is live
// do we open the dashboard carried in router location state (set by Landing,
// and preserved across reloads because it lives in history.state).
function LiveWatch({ onActiveRunChange, onDashboardChange, onEnd, confirm }) {
  const location = useLocation();
  const [resolved, setResolved] = useState(null); // null = still checking

  useEffect(() => {
    let cancelled = false;
    getActiveConversation()
      .then((info) => {
        if (cancelled) return;
        // runningTurn carries the in-flight turn's id and question when one
        // exists. It is the only way to re-attach to a turn whose session row
        // has not been written yet - see useSessionStream's placeholder run.
        setResolved(info.active ? { resume: info.conversationId, runningTurn: info.runningTurn ?? null } : { resume: null });
      })
      .catch(() => {
        // Backend unreachable: fall back to whatever the URL carried rather
        // than stranding the user on a spinner.
        if (!cancelled) setResolved({ resume: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (resolved === null) return <div className="p-6 text-sm text-fg/60">Reconnecting…</div>;

  if (resolved.resume) {
    return (
      <Watch
        mode="live"
        resumeConversationId={resolved.resume}
        resumeRunningTurn={resolved.runningTurn}
        onActiveRunChange={onActiveRunChange}
        onEnd={onEnd}
        confirm={confirm}
        onDashboardChange={onDashboardChange}
      />
    );
  }

  const target = location.state?.dashboard ?? null;
  if (!target) return <Navigate to="/" replace />;
  return (
    <Watch
      mode="live"
      dashboardTarget={target}
      onActiveRunChange={onActiveRunChange}
      onEnd={onEnd}
      confirm={confirm}
      onDashboardChange={onDashboardChange}
    />
  );
}

export default function App() {
  const [watchHasActiveRun, setWatchHasActiveRun] = useState(false);
  // The live dashboard {name, url} Watch is currently showing, surfaced in the
  // top header as a clickable link. Null outside the watch/replay views.
  const [watchDashboard, setWatchDashboard] = useState(null);
  const [confirm, confirmProps] = useConfirm();
  const navigate = useNavigate();
  const location = useLocation();
  const view = viewForPath(location.pathname);

  // Navigation no longer confirms. Leaving a live watch does NOT end the
  // conversation - nothing on unmount closes it - and with routing in place
  // the exit is recoverable: navigate back to /watch and the still-running
  // session is re-attached. "End session" inside Watch keeps its own confirm,
  // because that one really does close the runtime.
  function handleNavigate(nextView) {
    setWatchHasActiveRun(false);
    setWatchDashboard(null);
    navigate(nextView === "history" ? "/history" : "/");
  }

  function endLiveWatch() {
    setWatchHasActiveRun(false);
    setWatchDashboard(null);
    navigate("/");
  }

  const watchProps = {
    onActiveRunChange: setWatchHasActiveRun,
    onDashboardChange: setWatchDashboard,
  };

  return (
    <AppShell view={view} onNavigate={handleNavigate} headerCenter={view === "watch" ? watchDashboard : null}>
      <Routes>
        <Route
          path="/"
          element={<Landing onOpenWatch={(target) => navigate("/watch", { state: { dashboard: target } })} />}
        />
        <Route path="/watch" element={<LiveWatch {...watchProps} onEnd={endLiveWatch} confirm={confirm} />} />
        <Route path="/replay/c/:id" element={<ConversationReplay {...watchProps} />} />
        <Route path="/replay/s/:id" element={<SessionReplay {...watchProps} />} />
        <Route
          path="/history"
          element={
            <History
              onOpenReplay={(t) => navigate(t.kind === "conversation" ? `/replay/c/${t.id}` : `/replay/s/${t.id}`)}
              onGoToLanding={() => navigate("/")}
            />
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ConfirmDialog {...confirmProps} />
    </AppShell>
  );
}
