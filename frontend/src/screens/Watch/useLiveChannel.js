import { useEffect, useRef, useState } from "react";
import { openLiveChannel } from "../../api.js";

// Read-only live screencast channel for the active conversation (Phase B1).
// Opens a WebSocket to /api/conversations/:id/live and exposes:
//   - liveFrameUrl: object URL of the latest JPEG frame (previous URL revoked
//     each time, and on cleanup, to avoid unbounded object-URL growth)
//   - vizBox / viewport: normalized viz rectangle for cropping the frame
//   - mode: 'agent' while a turn is running (veil), else 'idle'
//   - connected: socket open?
// Reconnects on an unexpected drop; stops for good once the server sends
// {type:"closed"} (the conversation is really gone) or the id changes/unmounts.
export function useLiveChannel(conversationId) {
  const [liveFrameUrl, setLiveFrameUrl] = useState(null);
  const [vizBox, setVizBox] = useState(null);
  const [viewport, setViewport] = useState(null);
  const [mode, setMode] = useState("idle");
  const [connected, setConnected] = useState(false);

  const frameUrlRef = useRef(null);

  useEffect(() => {
    if (!conversationId) return undefined;

    let disposed = false; // component unmounted / conversationId changed
    let serverClosed = false; // server said {type:"closed"} -> don't reconnect
    let channel = null;
    let reconnectTimer = null;
    let backoff = 1000;
    let failedAttempts = 0; // consecutive (re)connects that never opened

    // Reset per-conversation view state so a new conversation doesn't briefly
    // show the previous one's last frame/box.
    setLiveFrameUrl(null);
    setVizBox(null);
    setViewport(null);
    setMode("idle");
    setConnected(false);

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
        onClosed: () => {
          serverClosed = true;
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
      if (reconnectTimer) clearTimeout(reconnectTimer);
      channel?.close();
      if (frameUrlRef.current) {
        URL.revokeObjectURL(frameUrlRef.current);
        frameUrlRef.current = null;
      }
    };
  }, [conversationId]);

  return { liveFrameUrl, vizBox, viewport, mode, connected };
}
