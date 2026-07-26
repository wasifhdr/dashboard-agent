import { useCallback, useEffect, useRef, useState } from "react";

// Web Speech API — Chrome/Edge expose it prefixed. Resolved once at module load
// so `supported` is a stable boolean rather than a per-render window probe.
const SpeechRecognitionImpl =
  typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

export const speechRecognitionSupported = !!SpeechRecognitionImpl;

const ERROR_MESSAGE = {
  "not-allowed": "Microphone access is blocked — allow it in the address bar to dictate.",
  "service-not-allowed": "Microphone access is blocked — allow it in the address bar to dictate.",
  "audio-capture": "No microphone found.",
  network: "Speech recognition lost its network connection.",
};

// Click-to-speak dictation for the composer.
//
// Chrome's implementation streams audio to Google's servers and hands back
// interim guesses that get revised as you keep talking, so the caller is given
// the FULL transcript of the current listening session on every event (not
// deltas) via `onTranscript(text, isFinal)`. The composer replaces everything
// it appended since `start()` with that string, which is what makes live
// revision ("nintendo" -> "Nintendo") look seamless in the textarea.
//
// `no-speech` is deliberately swallowed: Chrome fires it on any quiet pause,
// and surfacing "no speech detected" every time someone thinks mid-sentence
// reads as a malfunction. The mic simply stops.
export function useSpeechRecognition({ onTranscript } = {}) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState("");
  const recognitionRef = useRef(null);
  // Read the callback through a ref so re-creating it on the caller's every
  // render doesn't tear down and rebuild the recognition session mid-sentence.
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const stop = useCallback(() => {
    // `stop()` lets the final result arrive; `abort()` would discard it.
    recognitionRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    if (!SpeechRecognitionImpl || recognitionRef.current) return;
    setError("");

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
      onTranscriptRef.current?.(transcript.trim(), allFinal);
    };

    recognition.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      setError(ERROR_MESSAGE[event.error] ?? `Dictation failed (${event.error}).`);
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      // start() throws if a session is somehow already running; drop back to a
      // clean idle state rather than leaving a live mic the user can't stop.
      recognitionRef.current = null;
      setListening(false);
    }
  }, []);

  const toggle = useCallback(() => {
    if (recognitionRef.current) stop();
    else start();
  }, [start, stop]);

  // Never leave the mic open behind a closed panel or a navigation.
  useEffect(() => () => recognitionRef.current?.abort(), []);

  return { supported: speechRecognitionSupported, listening, error, start, stop, toggle };
}
