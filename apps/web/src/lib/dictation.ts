import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Voice input through the system's own speech recognition (the Web Speech API: on-device
 * or the platform's service, never ours). Where the system doesn't offer it, there's no
 * microphone button at all.
 */

interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  const w = globalThis as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Add a dictated phrase to what's typed, with one space between (or none at a line start). */
export function joinDictation(current: string, phrase: string): string {
  const p = phrase.trim();
  if (!p) return current;
  if (!current || /\s$/.test(current)) return current + p;
  return `${current} ${p}`;
}

/** What went wrong, in words, or null when it was just silence or a stop. */
export function dictationError(code: string): string | null {
  if (code === "no-speech" || code === "aborted") return null;
  if (code === "not-allowed" || code === "service-not-allowed")
    return "LemonLime isn't allowed to use the microphone. Turn it on in your system's privacy settings.";
  if (code === "audio-capture") return "No microphone was found.";
  if (code === "network") return "Speech recognition needs a connection right now.";
  return "Dictation stopped. Try again.";
}

export function useDictation(onPhrase: (text: string) => void) {
  // Checked after the first render, so a page rendered on a server matches in the browser.
  const [supported, setSupported] = useState(false);
  useEffect(() => setSupported(recognitionCtor() !== null), []);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const onPhraseRef = useRef(onPhrase);
  onPhraseRef.current = onPhrase;

  const stop = useCallback(() => {
    rec.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor || rec.current) return;
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language || "en-US";
    r.onresult = e => {
      let pending = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        if (res.isFinal) onPhraseRef.current(res[0].transcript);
        else pending += res[0].transcript;
      }
      setInterim(pending);
    };
    r.onerror = e => setError(dictationError(e.error));
    r.onend = () => {
      rec.current = null;
      setListening(false);
      setInterim("");
    };
    rec.current = r;
    setError(null);
    try {
      r.start();
      setListening(true);
    } catch {
      rec.current = null;
      setError("Dictation couldn't start. Try again.");
    }
  }, []);

  useEffect(() => () => rec.current?.abort(), []);

  return { supported, listening, interim, error, start, stop, toggle: () => (rec.current ? stop() : start()) };
}
