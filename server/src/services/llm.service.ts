/**
 * Groq client — OpenAI-compatible Chat Completions API.
 *
 *  - The API key never leaves the backend.
 *  - Only short text context is ever sent (no images, embeddings or IDs).
 *  - Hard timeout, global daily call budget, per-patient rate limit.
 *  - Never throws: returns { ok: false, reason } so callers fall back to templates.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { Schema, model } from 'mongoose';
import { env, llmEnabled } from '../config/env';
import { logger } from '../lib/logger';

const llmUsageSchema = new Schema({
  day: { type: String, required: true, unique: true }, // YYYY-MM-DD (UTC)
  calls: { type: Number, default: 0 },
  promptTokens: { type: Number, default: 0 },
  completionTokens: { type: Number, default: 0 },
  failures: { type: Number, default: 0 },
});
export const LlmUsage = model('LlmUsage', llmUsageSchema);

export type LlmFailure = 'disabled' | 'budget' | 'rate' | 'timeout' | 'error';
export type LlmResult =
  { ok: true; text: string; ms: number } | { ok: false; reason: LlmFailure; ms: number };

// ---------- prompts (versioned markdown files in server/prompts) ----------

const PROMPT_DIR = path.resolve(__dirname, '../../prompts');
const promptCache = new Map<string, { version: number; text: string }>();

/** Loads a prompt file, stripping its front-matter header. */
export function loadPrompt(id: string): { version: number; text: string } {
  const cached = promptCache.get(id);
  if (cached) return cached;
  const raw = readFileSync(path.join(PROMPT_DIR, `${id}.md`), 'utf8');
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const version = Number(match?.[1].match(/version:\s*(\d+)/)?.[1] ?? 0);
  const prompt = { version, text: (match?.[2] ?? raw).trim() };
  promptCache.set(id, prompt);
  return prompt;
}

// ---------- limits ----------

const today = () => new Date().toISOString().slice(0, 10);
const perPatient = new Map<string, number[]>();

function patientRateOk(patientId: string): boolean {
  const now = Date.now();
  const recent = (perPatient.get(patientId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= env.LLM_PER_PATIENT_PER_MIN) {
    perPatient.set(patientId, recent);
    return false;
  }
  recent.push(now);
  perPatient.set(patientId, recent);
  return true;
}

/** Atomically reserves one call from today's budget. */
async function reserveBudget(): Promise<boolean> {
  const day = today();
  await LlmUsage.updateOne({ day }, { $setOnInsert: { day } }, { upsert: true });
  const res = await LlmUsage.updateOne(
    { day, calls: { $lt: env.LLM_DAILY_CALL_LIMIT } },
    { $inc: { calls: 1 } },
  );
  return res.modifiedCount === 1;
}

/** One call from the shared daily AI budget (used by speech-to-text too). */
export const reserveLlmCall = reserveBudget;

/** For tests. */
export function __resetLlmRateLimits() {
  perPatient.clear();
}

// ---------- status (for the caregiver "System status" card) ----------

export interface LlmLastCall {
  at: string;
  ok: boolean;
  reason?: LlmFailure;
  httpStatus?: number;
  /** Short, key-free error text from Groq, to help fix configuration problems. */
  detail?: string;
}
let lastCall: LlmLastCall | null = null;
const remember = (c: Omit<LlmLastCall, 'at'>) => {
  lastCall = { at: new Date().toISOString(), ...c };
};

export async function llmStatus() {
  const usage = await LlmUsage.findOne({ day: today() }).lean();
  return {
    configured: Boolean(env.GROQ_API_KEY),
    enabled: llmEnabled(),
    model: env.GROQ_MODEL,
    dailyLimit: env.LLM_DAILY_CALL_LIMIT,
    today: { calls: usage?.calls ?? 0, failures: usage?.failures ?? 0 },
    lastCall,
  };
}

/** Removes anything that looks like a key before showing an error to a caregiver. */
const scrub = (t: string) =>
  t
    .replace(/gsk_[A-Za-z0-9_-]+/g, 'gsk_***')
    .replace(/\s+/g, ' ')
    .slice(0, 300);

// ---------- call ----------

const REASONING_MODEL = /gpt-oss/i;

export async function chat(opts: {
  system: string;
  user: string;
  patientId: string;
  timeoutMs: number;
  maxTokens?: number;
}): Promise<LlmResult> {
  const started = Date.now();
  const fail = (reason: LlmFailure): LlmResult => ({ ok: false, reason, ms: Date.now() - started });

  if (!llmEnabled()) {
    remember({ ok: false, reason: 'disabled', detail: 'GROQ_API_KEY is not set in server/.env' });
    return fail('disabled');
  }
  if (!patientRateOk(opts.patientId)) return fail('rate');
  if (!(await reserveBudget())) {
    remember({ ok: false, reason: 'budget', detail: 'Daily AI call limit reached' });
    return fail('budget');
  }

  const send = () =>
    fetch(`${env.GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: env.GROQ_MODEL,
        temperature: 0.2,
        // Reasoning models (e.g. openai/gpt-oss-*) spend part of the token budget on hidden
        // "thinking"; without headroom and a low effort they return an EMPTY answer.
        max_tokens: (opts.maxTokens ?? 150) + (REASONING_MODEL.test(env.GROQ_MODEL) ? 600 : 0),
        ...(REASONING_MODEL.test(env.GROQ_MODEL)
          ? { reasoning_effort: 'low', include_reasoning: false }
          : {}),
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
      }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });

  try {
    const res = await send();
    if (!res.ok) {
      const detail = scrub(await res.text().catch(() => ''));
      remember({ ok: false, reason: 'error', httpStatus: res.status, detail });
      logger.warn({ status: res.status, detail }, 'Groq request failed');
      await LlmUsage.updateOne({ day: today() }, { $inc: { failures: 1 } });
      return fail('error');
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    await LlmUsage.updateOne(
      { day: today() },
      {
        $inc: {
          promptTokens: data.usage?.prompt_tokens ?? 0,
          completionTokens: data.usage?.completion_tokens ?? 0,
        },
      },
    );
    if (!text) {
      remember({ ok: false, reason: 'error', httpStatus: res.status, detail: 'Empty reply' });
      return fail('error');
    }
    remember({ ok: true, httpStatus: res.status });
    return { ok: true, text, ms: Date.now() - started };
  } catch (err) {
    const timeout = (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError';
    const detail = timeout
      ? `No reply within ${opts.timeoutMs} ms`
      : scrub((err as Error).message || 'Network error');
    remember({ ok: false, reason: timeout ? 'timeout' : 'error', detail });
    logger.warn({ reason: timeout ? 'timeout' : 'error', detail }, 'Groq request error');
    await LlmUsage.updateOne({ day: today() }, { $inc: { failures: 1 } });
    return fail(timeout ? 'timeout' : 'error');
  }
}
