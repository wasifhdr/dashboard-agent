import { useCallback, useEffect, useRef, useState } from "react";
import { getTtsConfig, synthesizeSpeech } from "../api.js";

const synth = typeof window !== "undefined" ? window.speechSynthesis : null;

export const speechSynthesisSupported = !!synth;

// Windows ships a wide quality range under one API. "Natural" is Microsoft's
// neural line (Aria/Jenny/Guy) and sounds markedly better than the legacy
// David/Zira/George voices, so prefer it, then Google's, then any English voice.
function pickVoice(voices) {
  const english = voices.filter((v) => v.lang?.toLowerCase().startsWith("en"));
  if (english.length === 0) return null;
  return (
    english.find((v) => /natural/i.test(v.name)) ??
    english.find((v) => /google/i.test(v.name)) ??
    english.find((v) => v.lang?.toLowerCase() === "en-us") ??
    english[0]
  );
}

// Reads a string aloud, preferring a hosted neural voice and degrading to the
// browser's built-in synthesizer.
//
// Two paths, in order:
//   1. REMOTE — POST the text to the backend's /api/tts proxy (Groq Orpheus),
//      play the returned WAV. Good voice, but costs a network round trip and
//      can fail (no key, unaccepted model terms, rate limit, provider down).
//   2. LOCAL  — window.speechSynthesis. Instant and never fails, but on a
//      machine without neural voices installed it sounds robotic.
//
// Every remote failure falls through to local, so the feature degrades in
// quality rather than going silent — which matters more in a live demo than
// any voice-quality difference.
//
// Local-path platform quirks handled here: `getVoices()` is empty on Chrome's
// first call (resolved via the `voiceschanged` event), and Chrome silently
// truncates utterances past ~15s (the pause/resume keep-alive below).
export function useSpeechSynthesis() {
  const [speaking, setSpeaking] = useState(false);
  const [usingRemote, setUsingRemote] = useState(false);
  const voiceRef = useRef(null);
  const remoteAvailableRef = useRef(false);
  const audioRef = useRef(null);
  // Bumped on every speak()/cancel() so an in-flight fetch whose answer has
  // been superseded resolves into a no-op instead of talking over the new one.
  const requestSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    getTtsConfig()
      .then((cfg) => {
        if (!cancelled) remoteAvailableRef.current = !!cfg.available;
      })
      .catch(() => {
        remoteAvailableRef.current = false; // backend down — local path still works
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!synth) return undefined;
    function loadVoices() {
      const voices = synth.getVoices();
      if (voices.length > 0) voiceRef.current = pickVoice(voices);
    }
    loadVoices();
    synth.addEventListener("voiceschanged", loadVoices);
    return () => synth.removeEventListener("voiceschanged", loadVoices);
  }, []);

  const stopAudio = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    // Release the object URL — these accumulate for the life of the document.
    if (audio.src.startsWith("blob:")) URL.revokeObjectURL(audio.src);
    audioRef.current = null;
  }, []);

  const cancel = useCallback(() => {
    requestSeqRef.current += 1;
    stopAudio();
    synth?.cancel();
    setSpeaking(false);
    setUsingRemote(false);
  }, [stopAudio]);

  const speakLocal = useCallback((text) => {
    if (!synth) return;
    synth.cancel(); // without this, utterances queue instead of replacing
    const utterance = new SpeechSynthesisUtterance(text);
    if (voiceRef.current) utterance.voice = voiceRef.current;
    utterance.rate = 1.02; // a touch above default — default reads sluggish
    utterance.pitch = 1;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    setUsingRemote(false);
    synth.speak(utterance);
  }, []);

  const speak = useCallback(
    async (text) => {
      const trimmed = (text ?? "").trim();
      if (!trimmed) return;

      requestSeqRef.current += 1;
      const seq = requestSeqRef.current;
      stopAudio();
      synth?.cancel();

      if (!remoteAvailableRef.current) {
        speakLocal(trimmed);
        return;
      }

      setSpeaking(true);
      setUsingRemote(true);
      try {
        const blob = await synthesizeSpeech(trimmed);
        if (seq !== requestSeqRef.current) return; // superseded mid-flight

        const audio = new Audio(URL.createObjectURL(blob));
        audioRef.current = audio;
        audio.onended = () => {
          if (seq === requestSeqRef.current) setSpeaking(false);
          stopAudio();
        };
        audio.onerror = () => {
          if (seq === requestSeqRef.current) speakLocal(trimmed);
        };
        await audio.play();
      } catch (err) {
        if (seq !== requestSeqRef.current) return;
        // Quality regression, not a failure — say it with the local voice.
        console.warn("[tts] remote synthesis failed, falling back to local voice:", err.message);
        speakLocal(trimmed);
      }
    },
    [speakLocal, stopAudio],
  );

  // Chrome's ~15s truncation workaround — only relevant to the local path.
  useEffect(() => {
    if (!synth || !speaking || usingRemote) return undefined;
    const id = setInterval(() => {
      if (synth.speaking) {
        synth.pause();
        synth.resume();
      }
    }, 10000);
    return () => clearInterval(id);
  }, [speaking, usingRemote]);

  // Speech outlives the component otherwise — unmounting Watch must silence it.
  useEffect(
    () => () => {
      synth?.cancel();
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        if (audio.src.startsWith("blob:")) URL.revokeObjectURL(audio.src);
      }
    },
    [],
  );

  return { supported: speechSynthesisSupported, speaking, usingRemote, speak, cancel };
}
