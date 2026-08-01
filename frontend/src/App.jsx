import { useState } from "react";
import { Routes, Route, Navigate, useNavigate, useParams, useLocation } from "react-router-dom";
import AppShell from "./components/AppShell.jsx";
import ConfirmDialog, { useConfirm } from "./components/ui/ConfirmDialog.jsx";
import Landing from "./screens/Landing/Landing.jsx";
import Watch from "./screens/Watch/Watch.jsx";
import History from "./screens/History/History.jsx";

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

// Live watch. The dashboard to open arrives as router location state from
// Landing (history.state, so it survives a reload). Task 3 replaces this body
// with the resume-aware version; today a refresh with no state redirects home.
function LiveWatch({ onActiveRunChange, onDashboardChange, onEnd, confirm }) {
  const location = useLocation();
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
