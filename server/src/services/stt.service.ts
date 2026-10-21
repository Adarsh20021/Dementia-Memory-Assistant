/**
 * Speech-to-text with Groq Whisper (OpenAI-compatible /audio/transcriptions).
 *
 * Why on the server: the browser's built-in voice typing (Web Speech API) only
 * works in some browsers (not Firefox, Brave, many embedded browsers) and fails
 * silently on some machines. Recording audio in the page and transcribing here
 * works everywhere that has a microphone.
 *
 *  - Audio is processed in memory, sent to Groq, and discarded. It is never
 *    stored or logged, and neither is the text.
 *  - Shares the daily AI budget with the text features; own per-patient rate limit.
 *  - Never throws: returns { ok: false, reason } so the route can answer kindly.
 */
import { env, sttEnabled } from '../config/env';
import { logger } from '../lib/logger';
import { reserveLlmCall } from './llm.service';

export type SttFailure = 'disabled' | 'budget' | 'rate' | 'timeout' | 'error';
export type SttResult =
  | { ok: true; text: string; ms: number }
  | { ok: false; reason: SttFailure; ms: number; /** short code shown to the user, e.g. "groq-403" */ code?: string };

/** Used if the configured model is not available to this Groq account. */
const FALLBACK_MODEL = 'whisper-large-v3';

/** Removes anything that looks like a key, keeps error text short. */
const scrub = (t: string) =>
  t
    .replace(/gsk_[A-Za-z0-9_-]+/g, 'gsk_***')
    .replace(/\s+/g, ' ')
    .slice(0, 300);

// ---------- status (caregiver "System status" card) ----------
export interface SttLastCall {
  at: string;
  ok: boolean;
  httpStatus?: number;
  detail?: string;
  model?: string;
}
let lastCall: SttLastCall | null = null;
const remember = (c: Omit<SttLastCall, 'at'>) => {
  lastCall = { at: new Date().toISOString(), ...c };
};
export const sttLastCall = () => lastCall;

const perPatient = new Map<string, number[]>();
function rateOk(patientId: string): boolean {
  const now = Date.now();
  const recent = (perPatient.get(patientId) ?? []).filter((t) => now - t < 60_000);
  const ok = recent.length < env.STT_PER_PATIENT_PER_MIN;
  if (ok) recent.push(now);
  perPatient.set(patientId, recent);
  return ok;
}
/** For tests. */
export const __resetSttRateLimits = () => perPatient.clear();

/** "en" from "en-IN"; Whisper wants ISO-639-1. */
const isoLang = (lang?: string) => (lang ?? '').toLowerCase().split(/[-_]/)[0].slice(0, 2) || undefined;

export async function transcribe(opts: {
  audio: Buffer;
  filename: string;
  mime: string;
  lang?: string;
  patientId: string;
}): Promise<SttResult> {
  const started = Date.now();
  const fail = (reason: SttFailure, code?: string): SttResult => ({ ok: false, reason, ms: Date.now() - started, code });
  if (!sttEnabled()) return fail('disabled');
  if (!rateOk(opts.patientId)) return fail('rate');
  if (!(await reserveLlmCall())) return fail('budget');

  const language = isoLang(opts.lang);
  const call = async (model: string, lang?: string) => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(opts.audio)], { type: opts.mime }), opts.filename);
    form.append('model', model);
    form.append('response_format', 'json');
    form.append('temperature', '0');
    if (lang) form.append('language', lang);
    const res = await fetch(`${env.GROQ_BASE_URL}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(env.STT_TIMEOUT_MS),
    });
    if (res.ok) {
      const data = (await res.json()) as { text?: string };
      return { ok: true as const, text: (data.text ?? '').replace(/\s+/g, ' ').trim() };
    }
    return { ok: false as const, status: res.status, detail: scrub(await res.text().catch(() => '')) };
  };

  try {
    let model = env.GROQ_STT_MODEL;
    let lang = language;
    let r = await call(model, lang);
    // Recover automatically from the two common configuration problems:
    // a model this account cannot use, and a language Whisper does not accept.
    for (let attempt = 0; !r.ok && attempt < 2; attempt++) {
      const d = r.detail.toLowerCase();
      if (r.status >= 400 && r.status < 500 && /model/.test(d) && model !== FALLBACK_MODEL) model = FALLBACK_MODEL;
      else if (r.status === 400 && /language/.test(d) && lang) lang = undefined;
      else break;
      r = await call(model, lang);
    }
    if (!r.ok) {
      remember({ ok: false, httpStatus: r.status, detail: r.detail, model });
      logger.warn({ status: r.status, detail: r.detail, model }, 'Groq transcription failed');
      return fail('error', `groq-${r.status}`);
    }
    remember({ ok: true, model });
    return { ok: true, text: r.text, ms: Date.now() - started };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const timeout = e.name === 'TimeoutError' || e.name === 'AbortError';
    const detail = timeout
      ? `No reply within ${env.STT_TIMEOUT_MS} ms`
      : scrub([e.message, e.cause?.code, e.cause?.message].filter(Boolean).join(' - '));
    remember({ ok: false, detail });
    logger.warn({ reason: timeout ? 'timeout' : 'error', detail }, 'Groq transcription error');
    return fail(timeout ? 'timeout' : 'error', timeout ? undefined : `network${e.cause?.code ? `-${e.cause.code}` : ''}`);
  }
}
