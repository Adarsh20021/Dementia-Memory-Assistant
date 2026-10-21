/**
 * Voice typing for the microphone buttons.
 *
 * Main path (works in every modern browser with a microphone):
 *   record with MediaRecorder -> stop automatically when the person stops
 *   talking -> send the recording to our server -> Groq Whisper -> text.
 *   The recording is never stored (see server/src/services/stt.service.ts).
 *
 * Fallback: the browser's own voice typing (Web Speech API, Chrome/Edge),
 * used when recording is not possible here or the server has voice typing
 * turned off (VOICE_TRANSCRIBE=off).
 *
 * Typing always works either way.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { stopNarration } from '../tts/narration';
import { toSpeechLang } from '../tts/TTSProvider';

// ---------------------------------------------------------------- browser recogniser

interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult:
    | ((e: { resultIndex: number; results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void)
    | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
const getRecognizer = (): (new () => RecognitionLike) | null => {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => RecognitionLike) | null;
};

// ---------------------------------------------------------------- recording

const canRecord = () =>
  typeof window !== 'undefined' &&
  typeof window.MediaRecorder !== 'undefined' &&
  Boolean(navigator.mediaDevices?.getUserMedia);

const pickMime = () => {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return options.find((m) => {
    try {
      return MediaRecorder.isTypeSupported(m);
    } catch {
      return false;
    }
  });
};

/** Set once the server says voice typing is off; then the browser recogniser is used. */
let serverVoiceOff = false;

const MSG = {
  blocked: 'The microphone is blocked. Allow it with the lock icon in the address bar, or type instead.',
  noMic: 'No microphone was found. Check that one is plugged in, or type instead.',
  busyMic: 'The microphone is being used by another app. Close that app, or type instead.',
  noSpeech: 'I did not hear anything. Tap the microphone and try again.',
  failed: 'I could not write that down. Please try again, or type instead.',
};

const micError = (err: unknown) => {
  const name = (err as DOMException)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return MSG.blocked;
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return MSG.noMic;
  if (name === 'NotReadableError' || name === 'AbortError') return MSG.busyMic;
  return `${MSG.failed} (mic-${name || 'error'})`;
};

/* Silence detection (so the patient does not have to tap "stop"). */
const TICK_MS = 100;
const SILENCE_AFTER_SPEECH_MS = 1600;
const NO_SPEECH_TIMEOUT_MS = 8000;
const MAX_RECORDING_MS = 30000;

type Recording = {
  recorder: MediaRecorder;
  stream: MediaStream;
  ctx: AudioContext | null;
  timer: ReturnType<typeof setInterval> | null;
  heardSpeech: boolean;
  cancelled: boolean;
};

export function useSpeechInput(onText: (text: string) => void, lang?: string) {
  const { patient } = useAuth();
  const params = useParams();
  const patientId = params.patientId ?? patient?.id;

  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const recRef = useRef<Recording | null>(null);
  const recognizerRef = useRef<RecognitionLike | null>(null);
  const mounted = useRef(true);

  const supported = typeof window !== 'undefined' && (canRecord() || getRecognizer() !== null);

  // ------------------------------------------------ server path

  const cleanup = (r: Recording) => {
    if (r.timer) clearInterval(r.timer);
    r.stream.getTracks().forEach((t) => t.stop());
    void r.ctx?.close().catch(() => undefined);
  };

  const send = useCallback(
    async (blob: Blob) => {
      if (!patientId) return;
      setTranscribing(true);
      try {
        const form = new FormData();
        const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm';
        form.append('audio', blob, `speech.${ext}`);
        const r = await api<{ text: string }>(`/api/patients/${patientId}/transcribe`, { form });
        if (!mounted.current) return;
        if (r.text) onTextRef.current(r.text);
        else setError(MSG.noSpeech);
      } catch (err) {
        if (!mounted.current) return;
        if (err instanceof ApiError && err.code === 'VOICE_DISABLED') {
          serverVoiceOff = true;
          setError(
            getRecognizer()
              ? 'Please tap the microphone again.'
              : 'Voice typing is turned off. Please type instead.',
          );
        } else {
          setError(
            err instanceof ApiError && err.status !== 0
              ? err.message
              : `${MSG.failed} (${err instanceof ApiError ? 'no-connection' : 'client-error'})`,
          );
        }
      } finally {
        if (mounted.current) setTranscribing(false);
      }
    },
    [patientId],
  );

  const stopRecording = useCallback((cancel = false) => {
    const r = recRef.current;
    if (!r) return;
    r.cancelled = cancel;
    if (r.recorder.state !== 'inactive') r.recorder.stop();
    else cleanup(r);
  }, []);

  const startRecording = useCallback(async () => {
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      setError(micError(err));
      return;
    }
    if (!mounted.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const mime = pickMime();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      setError(`${MSG.failed} (recorder-${(err as Error)?.name || 'error'})`);
      return;
    }
    const chunks: Blob[] = [];
    const rec: Recording = { recorder, stream, ctx: null, timer: null, heardSpeech: false, cancelled: false };
    recRef.current = rec;

    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.onstop = () => {
      cleanup(rec);
      if (recRef.current === rec) recRef.current = null;
      if (!mounted.current) return;
      setListening(false);
      if (rec.cancelled) return;
      const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' });
      if (!rec.heardSpeech || blob.size < 800) {
        setError(MSG.noSpeech);
        return;
      }
      void send(blob);
    };

    // Silence detection with the Web Audio API (optional: without it, tap to stop).
    const started = Date.now();
    let lastVoice = 0;
    try {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        rec.ctx = ctx;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const data = new Float32Array(analyser.fftSize);
        let floor = 0.01;
        rec.timer = setInterval(() => {
          analyser.getFloatTimeDomainData(data);
          let sum = 0;
          for (const v of data) sum += v * v;
          const rms = Math.sqrt(sum / data.length);
          const now = Date.now();
          // Learn the background noise during the first half-second.
          if (now - started < 500) floor = Math.max(floor, rms);
          else if (rms > Math.max(0.02, floor * 2.5)) {
            rec.heardSpeech = true;
            lastVoice = now;
          }
          const silentFor = now - lastVoice;
          if (
            (rec.heardSpeech && silentFor > SILENCE_AFTER_SPEECH_MS) ||
            (!rec.heardSpeech && now - started > NO_SPEECH_TIMEOUT_MS) ||
            now - started > MAX_RECORDING_MS
          ) {
            stopRecording();
          }
        }, TICK_MS);
      } else {
        rec.heardSpeech = true; // cannot measure: let the server decide
        rec.timer = setInterval(() => {
          if (Date.now() - started > MAX_RECORDING_MS) stopRecording();
        }, 500);
      }
    } catch {
      rec.heardSpeech = true;
    }

    recorder.start(250);
    setListening(true);
  }, [send, stopRecording]);

  // ------------------------------------------------ browser path (fallback)

  const startBrowser = useCallback(
    (speechLang: string, isRetry = false) => {
      const Ctor = getRecognizer();
      if (!Ctor) {
        setError('Voice typing is not available here. Please type instead.');
        return;
      }
      setError(null);
      setInterim('');
      const rec = new Ctor();
      rec.lang = speechLang;
      rec.interimResults = true;
      rec.continuous = false;
      let finalText = '';
      let live = '';
      let retry = false;
      rec.onresult = (e) => {
        live = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText = `${finalText} ${r[0].transcript}`.trim();
          else live += r[0].transcript;
        }
        setInterim(`${finalText} ${live}`.trim());
      };
      rec.onerror = (e) => {
        if (e.error === 'aborted') return;
        if (e.error === 'language-not-supported' && !isRetry) {
          retry = true;
          return;
        }
        setError(
          e.error === 'not-allowed' || e.error === 'service-not-allowed'
            ? MSG.blocked
            : e.error === 'audio-capture'
              ? MSG.noMic
              : e.error === 'no-speech'
                ? MSG.noSpeech
                : `${MSG.failed} (${e.error})`,
        );
      };
      rec.onend = () => {
        recognizerRef.current = null;
        if (retry) return startBrowser('en-US', true);
        const text = (finalText || live).trim();
        if (text) onTextRef.current(text);
        setInterim('');
        setListening(false);
      };
      recognizerRef.current = rec;
      try {
        rec.start();
        setListening(true);
      } catch {
        recognizerRef.current = null;
        setListening(false);
        setError(MSG.failed);
      }
    },
    [],
  );

  // ------------------------------------------------ public API

  const start = useCallback(() => {
    if (recRef.current || recognizerRef.current || transcribing) return;
    stopNarration(); // the microphone must not hear the app's own voice
    if (canRecord() && patientId && !serverVoiceOff) void startRecording();
    else startBrowser(toSpeechLang(lang));
  }, [lang, patientId, startBrowser, startRecording, transcribing]);

  const stop = useCallback(() => {
    if (recRef.current) {
      // Tapped "stop": send what was said, even if it was quiet.
      recRef.current.heardSpeech = true;
      stopRecording();
    }
    recognizerRef.current?.stop();
  }, [stopRecording]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopRecording(true);
      try {
        recognizerRef.current?.abort();
      } catch {
        /* ignore */
      }
    };
  }, [stopRecording]);

  return { supported, listening, transcribing, interim, error, start, stop };
}
