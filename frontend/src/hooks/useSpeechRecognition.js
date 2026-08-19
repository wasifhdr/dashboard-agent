import { useCallback, useEffect, useRef, useState } from "react";
import { getSttConfig, transcribeAudio } from "../api.js";

// Web Speech API — Chrome/Edge expose it prefixed. Resolved once at module load
// so `supported` is a stable boolean rather than a per-render window probe.
const SpeechRecognitionImpl =
  typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

export const speechRecognitionSupported = !!SpeechRecognitionImpl;

// Recording is the other half of the hybrid (see the block comment below) and
// has its own support story: MediaRecorder exists everywhere the Web Speech API
// does NOT, which is what makes dictation work at all in Firefox and Safari.
const recorderSupported =
  typeof window !== "undefined" &&
  typeof window.MediaRecorder !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia;

// Ordered by preference: Opus in WebM is what Chrome/Firefox produce and what
// Whisper handles best; Safari only offers MP4/AAC. An empty string means "let
// the browser pick", which is a last resort because we then have to trust
// recorder.mimeType to name it accurately for the upload.
const RECORDER_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

function pickRecorderMimeType() {
  if (!recorderSupported || !window.MediaRecorder.isTypeSupported) return "";
  return RECORDER_MIME_TYPES.find((type) => window.MediaRecorder.isTypeSupported(type)) ?? "";
}

// Whether the backend can transcribe. Probed once per page load and shared by
// every hook instance (the composer and QuickAsk both mount one), because it is
// a property of the deployment, not of the component.
let remoteProbe = null;
function probeRemoteStt() {
  if (!remoteProbe) {
    remoteProbe = getSttConfig()
      .then((cfg) => !!cfg.available)
      .catch(() => false);
  }
  return remoteProbe;
}

// Roughly a second of Opus. Below this the blob is silence or a mis-click, and
// sending it wastes a request against the daily quota to get back "" — or, far
// worse, a confident "Thank you.", which is what Whisper reliably answers with
// when handed near-empty audio (verified against this very endpoint). Pasting
// that into the composer looks like a transcription, not a failure.
const MIN_AUDIO_BYTES = 4000;

const ERROR_MESSAGE = {
  "not-allowed": "Microphone access is blocked — allow it in the address bar to dictate.",
  "service-not-allowed": "Microphone access is blocked — allow it in the address bar to dictate.",
  "audio-capture": "No microphone found.",
  network: "Speech recognition lost its network connection.",
};

// Click-to-speak dictation for the composer — HYBRID, two transcribers running
// over one press of the mic:
//
//   1. The Web Speech API streams audio to Google and hands back interim
//      guesses that get revised as you keep talking, so the caller is given the
//      FULL transcript of the current listening session on every event (not
//      deltas) via `onTranscript(text, isFinal)`. The composer replaces
//      everything it appended since `start()` with that string, which is what
//      makes live revision look seamless in the textarea.
//   2. In parallel a MediaRecorder captures the same speech to a blob. On stop
//      that blob goes to /api/stt (Groq Whisper) and the resulting transcript
//      REPLACES the live one through the same `onTranscript` channel.
//
// Why both: pass 1 is instant but weak, and mangles exactly the words these
// dashboards are full of (publisher names, "Tableau"); pass 2 is accurate but
// only arrives when you stop talking. Running them together buys the live feel
// AND the accuracy, and each covers the other's absence — Chrome-only for pass
// 1, key/quota/network-dependent for pass 2. If pass 2 fails for any reason the
// pass-1 text simply stands, so this is never worse than dictation was before.
//
// `no-speech` is deliberately swallowed: Chrome fires it on any quiet pause,
// and surfacing "no speech detected" every time someone thinks mid-sentence
// reads as a malfunction. The mic simply stops.
export function useSpeechRecognition({ onTranscript } = {}) {
  const [listening, setListening] = useState(false);
  // True only for the gap between releasing the mic and the accurate transcript
  // landing — the caller shows it as "Polishing…" rather than as another kind
  // of listening, because the mic is closed by then.
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState("");
  const [remoteAvailable, setRemoteAvailable] = useState(false);
  const recognitionRef = useRef(null);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  // Bumped on every start/abort. A transcription that resolves after its leg
  // has been superseded is dropped rather than pasted over newer text.
  const legRef = useRef(0);
  // Whether the Web Speech pass produced anything this leg. Decides whether a
  // failed transcription is silent (there is text on screen already) or has to
  // be reported (the user spoke into a void).
  const gotInterimRef = useRef(false);
  // Read the callback through a ref so re-creating it on the caller's every
  // render doesn't tear down and rebuild the recognition session mid-sentence.
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  useEffect(() => {
    let alive = true;
    probeRemoteStt().then((available) => {
      if (alive) setRemoteAvailable(available);
    });
    return () => {
      alive = false;
    };
  }, []);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  }, []);

  const stop = useCallback(() => {
    // `stop()` lets the final result arrive; `abort()` would discard it.
    recognitionRef.current?.stop();
    // Fires onstop, which is where the recorded audio is sent for transcription.
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
    } else if (!recorderRef.current) {
      // Nothing recorded yet — either this browser isn't recording at all, or
      // the mic permission prompt is still up. Retiring the leg makes a stream
      // that arrives after the click resolve into a no-op instead of a mic that
      // opens after the user has already stopped.
      legRef.current += 1;
      releaseStream();
    }
    setListening(false);
  }, [releaseStream]);

  const startRecording = useCallback(
    async (leg) => {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        // Permission denied or no device. The Web Speech pass raises its own
        // error for the same causes, so staying quiet here avoids doubling it;
        // if that pass isn't running there is nothing left to dictate with, and
        // the caller sees the mic simply not engage.
        return;
      }
      // The user let go (or started a new leg) while the permission prompt was
      // up — don't open a mic nobody is watching.
      if (leg !== legRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const mimeType = pickRecorderMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunksRef.current.push(event.data);
      };

      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || "audio/webm" });
        releaseStream();
        if (leg !== legRef.current || blob.size < MIN_AUDIO_BYTES) return;

        setTranscribing(true);
        try {
          const text = await transcribeAudio(blob);
          // Late arrival: the user has since started dictating again, so this
          // transcript belongs to text that is no longer on screen.
          if (leg !== legRef.current) return;
          if (text.trim()) onTranscriptRef.current?.(text.trim(), true);
        } catch (err) {
          // Accuracy is the only casualty — the interim transcript stands.
          console.warn("[dictation] remote transcription failed:", err.message);
          if (leg === legRef.current && !gotInterimRef.current) {
            setError("Couldn't transcribe that — try again, or type your question.");
          }
        } finally {
          if (leg === legRef.current) setTranscribing(false);
        }
      };

      recorder.start();
    },
    [releaseStream],
  );

  const start = useCallback(() => {
    if (!SpeechRecognitionImpl && !(recorderSupported && remoteAvailable)) return;
    if (recognitionRef.current || recorderRef.current) return;
    setError("");
    setTranscribing(false);
    gotInterimRef.current = false;
    const leg = legRef.current + 1;
    legRef.current = leg;

    if (recorderSupported && remoteAvailable) {
      // Fire-and-forget: awaiting the permission prompt would delay `listening`
      // (and so the mic's own pulse) behind a dialog the user is looking at.
      startRecording(leg);
    }

    if (!SpeechRecognitionImpl) {
      // Recording-only browser: no interim text, so the transcript lands in one
      // piece when the user stops. `listening` still drives the mic UI.
      setListening(true);
      return;
    }

    const recognition = new SpeechRecognitionImpl();
    recognition.lang = "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      // In continuous mode `event.results` accumulates every phrase of the
      // session, so rebuild the whole transcript rather than reading only the
      // newest entry.
      let transcript = "";
      let allFinal = true;
      for (let i = 0; i < event.results.length; i += 1) {
        transcript += event.results[i][0].transcript;
        if (!event.results[i].isFinal) allFinal = false;
      }
      if (transcript.trim()) gotInterimRef.current = true;
      onTranscriptRef.current?.(transcript.trim(), allFinal);
    };

    recognition.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      // A network/service failure in this pass is survivable when the recorder
      // is running: the accurate transcript is still coming, and reporting a
      // dead mic while one is plainly recording is worse than saying nothing.
      if (recorderRef.current && event.error === "network") return;
      setError(ERROR_MESSAGE[event.error] ?? `Dictation failed (${event.error}).`);
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      // Chrome ends the session on its own after a long pause. The recorder
      // keeps running until the user actually clicks stop, so the leg is only
      // over — and `listening` only false — once both have finished.
      if (!recorderRef.current) setListening(false);
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      // start() throws if a session is somehow already running; drop back to a
      // clean idle state rather than leaving a live mic the user can't stop.
      recognitionRef.current = null;
      setListening(!!recorderRef.current);
    }
  }, [remoteAvailable, startRecording]);

  // Ends dictation AND throws away anything still in flight. Callers reach for
  // this when the text being dictated into is about to disappear — the question
  // was sent, or the panel was closed — because a `stop()` there would let an
  // accurate transcript land a second later in a box the user has moved on
  // from, repopulating it with the question they just asked.
  const cancel = useCallback(() => {
    legRef.current += 1;
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    releaseStream();
    setListening(false);
    setTranscribing(false);
  }, [releaseStream]);

  // `listening` is checked alongside the refs so a second click lands during
  // the gap where the mic permission prompt is up and neither ref is set yet.
  const toggle = useCallback(() => {
    if (listening || recognitionRef.current || recorderRef.current) stop();
    else start();
  }, [listening, start, stop]);

  // Never leave the mic open behind a closed panel or a navigation, and retire
  // the leg so an in-flight transcription can't call back into a dead tree.
  useEffect(
    () => () => {
      legRef.current += 1;
      recognitionRef.current?.abort();
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  return {
    supported: speechRecognitionSupported || (recorderSupported && remoteAvailable),
    listening,
    transcribing,
    error,
    start,
    stop,
    cancel,
    toggle,
  };
}
