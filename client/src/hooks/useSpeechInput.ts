/**
 * Optional speech-to-text (Web Speech API SpeechRecognition).
 * Typing always works; the mic button only appears when supported.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { toSpeechLang } from '../tts/TTSProvider';

/* Minimal typings: SpeechRecognition is not in lib.dom for all browsers. */
interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

const getCtor = (): (new () => RecognitionLike) | null => {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => RecognitionLike) | null;
};

export function useSpeechInput(onText: (text: string) => void, lang?: string) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<RecognitionLike | null>(null);
  const supported = typeof window !== 'undefined' && getCtor() !== null;

  const stop = useCallback(() => {
    recRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Ctor = getCtor();
    if (!Ctor) return;
    setError(null);
    const rec = new Ctor();
    rec.lang = toSpeechLang(lang);
    rec.interimResults = false;
    rec.continuous = false;
    rec.onresult = (e) => {
      const text = Array.from(e.results)
        .filter((r) => r.isFinal)
        .map((r) => r[0].transcript)
        .join(' ')
        .trim();
      if (text) onText(text);
    };
    rec.onerror = (e) => {
      setError(
        e.error === 'not-allowed' || e.error === 'service-not-allowed'
          ? 'The microphone is blocked. Allow it with the lock icon in the address bar, or type instead.'
          : e.error === 'network'
            ? 'Voice typing needs an internet connection. You can type instead.'
            : e.error === 'no-speech'
              ? 'I did not hear anything. Tap the microphone and try again.'
              : 'I could not hear that. You can try again or type instead.',
      );
    };
    rec.onend = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    rec.start();
  }, [lang, onText]);

  useEffect(() => () => recRef.current?.stop(), []);

  return { supported, listening, error, start, stop };
}
