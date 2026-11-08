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

// ── The microphone level meter shown while dictating ──

/** How loud a frame of samples is, 0 to 1 (from the analyser's 0–255 time-domain bytes). */
export function levelFromSamples(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = (samples[i]! - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / samples.length);
  // Speech sits low on the scale; lift it so a normal voice fills most of the meter.
  return Math.min(1, Math.sqrt(rms) * 1.6);
}

/** The microphones this computer has (names show once the microphone has been allowed). */
export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  try {
    const all = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
    return all.filter(d => d.kind === "audioinput");
  } catch {
    return [];
  }
}

/** Choices for the microphone setting: the system default first, then each one by name. */
export function micOptions(mics: readonly Pick<MediaDeviceInfo, "deviceId" | "label">[]): { value: string; label: string }[] {
  const named = mics.filter(m => m.deviceId && m.deviceId !== "default" && m.deviceId !== "communications");
  return [{ value: "", label: "System default" }, ...named.map((m, i) => ({ value: m.deviceId, label: m.label || `Microphone ${i + 1}` }))];
}

/** Ask once for the microphone, so the system tells us the microphones' names. */
export async function allowMicrophone(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const t of stream.getTracks()) t.stop();
}

/**
 * Listen on a microphone (the default when `deviceId` is empty or gone) and report its level
 * about 20 times a second. Resolves to a function that stops listening.
 */
export async function startLevelMeter(deviceId: string, onLevel: (level: number) => void): Promise<() => void> {
  const media = navigator.mediaDevices;
  if (!media?.getUserMedia || typeof AudioContext === "undefined") throw new Error("No microphone access here.");
  let stream: MediaStream;
  try {
    stream = await media.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
  } catch (err) {
    // The chosen microphone was unplugged: fall back to the default.
    if (!deviceId) throw err;
    stream = await media.getUserMedia({ audio: true });
  }
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);
  const timer = setInterval(() => {
    analyser.getByteTimeDomainData(buf);
    onLevel(levelFromSamples(buf));
  }, 50);
  return () => {
    clearInterval(timer);
    source.disconnect();
    for (const t of stream.getTracks()) t.stop();
    void ctx.close().catch(() => undefined);
  };
}
