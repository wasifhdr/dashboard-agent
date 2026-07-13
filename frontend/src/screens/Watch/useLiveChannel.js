import { useCallback, useEffect, useRef, useState } from "react";
import { openLiveChannel } from "../../api.js";

// Live screencast + input channel for the active conversation (Phases B1 +
// B2). Opens a WebSocket to /api/conversations/:id/live and exposes:
//   - liveFrameUrl: object URL of the latest JPEG frame (previous URL revoked
//     each time, and on cleanup, to avoid unbounded object-URL growth)
//   - vizBox / viewport: normalized viz rectangle for cropping the frame
//   - mode: 'agent' while a turn is running (veil), else 'idle'
//   - connected: socket open?
//   - closedReason: the `reason` string from the server's terminal
//     {type:"closed", reason} message (e.g. "idle_timeout", "browser_crashed",
//     "screencast_failed", "conversation_closed"), or null while the channel
//     hasn't received one yet. Purely informational - storing/exposing it
//     does not change reconnect behavior, which still stops for good on any
//     {type:"closed"} exactly as before.
//   - sendInput(msg): forwards one mouse/key message (B2 WS contract) to the
//     server; a no-op before the first connection, and throttled for
//     {type:"mouse", event:"move"} messages only (~30fps) - down/up/click/
//     wheel/key are discrete and always sent immediately.
// Reconnects on an unexpected drop; stops for good once the server sends
// {type:"closed"} (the conversation is really gone) or the id changes/unmounts.
const MOVE_THROTTLE_MS = 33; // ~30fps cap on outbound mouse-move messages

export function useLiveChannel(conversationId) {
  const [liveFrameUrl, setLiveFrameUrl] = useState(null);
  const [vizBox, setVizBox] = useState(null);
  const [viewport, setViewport] = useState(null);
  const [mode, setMode] = useState("idle");
  const [connected, setConnected] = useState(false);
  const [closedReason, setClosedReason] = useState(null);

  const frameUrlRef = useRef(null);
  // Set inside the effect below (per conversationId/channel) so sendInput -
  // called from render, outside the effect - always forwards through the
  // CURRENT channel and throttle state. Defaults to a no-op so calling
  // sendInput before the first connection (or with no conversationId) is safe.
  const sendInputRef = useRef(() => {});

  useEffect(() => {
    if (!conversationId) {
      sendInputRef.current = () => {};
      return undefined;
    }

    let disposed = false; // component unmounted / conversationId changed
    let serverClosed = false; // server said {type:"closed"} -> don't reconnect
    let channel = null;
    let reconnectTimer = null;
    let backoff = 1000;
    let failedAttempts = 0; // consecutive (re)connects that never opened
    let lastMoveSentAt = 0; // throttle state for mouse-move, local to this effect run

    // Reset per-conversation view state so a new conversation doesn't briefly
    // show the previous one's last frame/box.
    setLiveFrameUrl(null);
    setVizBox(null);
    setViewport(null);
    setMode("idle");
    setConnected(false);
    setClosedReason(null);

    // Forwards one input message through whichever channel is currently open
    // (or no-ops if none is). Only outbound mouse-move is throttled - it's
    // the only high-frequency message type; down/up/click/wheel/key are
    // discrete user actions and must always reach the server immediately.
    sendInputRef.current = (msg) => {
      if (!channel) return;
      if (msg?.type === "mouse" && msg.event === "move") {
        const now = Date.now();
        if (now - lastMoveSentAt < MOVE_THROTTLE_MS) return;
        lastMoveSentAt = now;
      }
      channel.sendInput(msg);
    };

    function setFrame(base64) {
      try {
        const bin = atob(base64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const url = URL.createObjectURL(new Blob([arr], { type: "image/jpeg" }));
        if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current);
        frameUrlRef.current = url;
        if (!disposed) setLiveFrameUrl(url);
        else URL.revokeObjectURL(url);
      } catch {
        /* malformed frame - skip */
      }
    }

    function connect() {
      channel = openLiveChannel(conversationId, {
        onOpen: () => {
          if (disposed) return;
          backoff = 1000;
          failedAttempts = 0;
          setConnected(true);
          // Reset the veil baseline on every (re)connect: if a turn really is
          // running, the server's addClient re-primes 'lock' right after; if
          // not, we must not stay stuck on a 'lock' whose matching 'unlock' we
          // missed while disconnected mid-turn.
          setMode("idle");
        },
        onFrame: (data) => setFrame(data),
        onVizBox: (box, vp) => {
          if (disposed) return;
          setVizBox(box);
          setViewport(vp);
        },
        onLock: () => {
          if (!disposed) setMode("agent");
        },
        onUnlock: () => {
          if (!disposed) setMode("idle");
        },
        onClosed: (reason) => {
          serverClosed = true;
          if (!disposed) setClosedReason(reason || "conversation_closed");
        },
        onClose: () => {
          if (disposed) return;
          setConnected(false);
          if (serverClosed) return; // conversation really gone - no reconnect
          failedAttempts += 1;
          // Stop after enough consecutive failures with no successful open
          // (onOpen resets this to 0). Otherwise a socket whose upgrade keeps
          // 404ing - e.g. the conversation was replaced/closed while this
          // client was disconnected - would retry forever at the backoff cap.
          if (failedAttempts > 6) return;
          reconnectTimer = setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, 8000);
        },
      });
    }

    connect();

    return () => {
      disposed = true;
      sendInputRef.current = () => {};
      if (reconnectTimer) clearTimeout(reconnectTimer);
      channel?.close();
      if (frameUrlRef.current) {
        URL.revokeObjectURL(frameUrlRef.current);
        frameUrlRef.current = null;
      }
    };
  }, [conversationId]);

  // Stable identity across renders (reads the ref, which the effect above
  // keeps pointed at the current channel/throttle state) so consumers can
  // depend on it without re-subscribing to anything.
  const sendInput = useCallback((msg) => sendInputRef.current(msg), []);

  return { liveFrameUrl, vizBox, viewport, mode, connected, closedReason, sendInput };
}
