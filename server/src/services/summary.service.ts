/**
 * Patient-facing sentences:
 *   - who-is-this summary (Groq, validated, cached, template fallback)
 *   - caregiver visit-summary drafts (Groq, never stored until approved)
 *   - phrasing of database answers (Groq rephrases; facts come from the DB)
 *
 * Every LLM output passes guardrails; anything that fails falls back to a
 * deterministic template, so the core feature works with no LLM at all.
 */
import { createHash } from 'crypto';
import { env } from '../config/env';
import type { PersonContext } from './context.service';
import { chat, loadPrompt } from './llm.service';

// ---------------------------------------------------------------- templates

export function fallbackSummary(ctx: PersonContext): string {
  const intro = `This is ${ctx.firstName}, your ${ctx.relationship}.`;
  const last = ctx.lastVisits[0];
  return last ? `${intro} They last visited on ${last.date}.` : intro;
}

export const unsureMessage = (firstName: string) =>
  `This may be ${firstName}. Let's ask your caregiver to check.`;
export const UNKNOWN_MESSAGE = "I don't recognize this person. Please ask your caregiver.";
export const NO_FACE_MESSAGE =
  "I can't see a face clearly. Please ask your visitor to look at the screen.";
export const LIVENESS_MESSAGE =
  'Please ask your visitor to look at the screen and slowly turn their head a little. Then try again.';

// ---------------------------------------------------------------- guardrails

const BANNED =
  /\b(dementia|alzheimer\w*|memory loss|forget\w*|forgot\w*|forgetful|diagnos\w*|disease|illness|ill|sick\w*|medic\w*|medication|pills?|dose|hospital|doctor\w*|condition|confus\w*|symptom\w*|therap\w*)\b/i;

const sentencesOf = (t: string) => t.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length);
const wordsOf = (t: string) => t.split(/\s+/).filter(Boolean);

/** Words allowed to be capitalised mid-sentence: everything that appears in the context. */
function allowedVocabulary(sources: string[]): Set<string> {
  const set = new Set<string>(['I', 'You', 'Your', 'They', 'Their']);
  for (const s of sources) for (const w of s.match(/[\p{L}']+/gu) ?? []) set.add(w.toLowerCase());
  return set;
}

export interface Guardrail {
  ok: boolean;
  reason?: string;
}

/**
 * Validates LLM output against the facts it was given.
 * Heuristics (documented limits): sentence/word caps, banned health words,
 * no questions, every number and every capitalised mid-sentence word must
 * appear in the source facts (catches invented names, places and dates).
 */
export function validateAgainstFacts(
  text: string,
  facts: string[],
  limits: { maxSentences: number; maxWords: number; mustInclude?: string },
): Guardrail {
  const t = text.trim();
  if (!t) return { ok: false, reason: 'empty' };
  if (sentencesOf(t).length > limits.maxSentences)
    return { ok: false, reason: 'too_many_sentences' };
  if (wordsOf(t).length > limits.maxWords) return { ok: false, reason: 'too_long' };
  if (t.includes('?')) return { ok: false, reason: 'question' };
  if (/[*#`\-•]\s|\n/.test(t)) return { ok: false, reason: 'formatting' };
  const factText = facts.join(' ');
  const banned = t.match(BANNED);
  if (banned && !new RegExp(`\\b${banned[0]}\\b`, 'i').test(factText))
    return { ok: false, reason: 'banned_word' };
  if (limits.mustInclude && !t.toLowerCase().includes(limits.mustInclude.toLowerCase()))
    return { ok: false, reason: 'missing_name' };

  for (const num of t.match(/\d+/g) ?? []) {
    if (!factText.includes(num)) return { ok: false, reason: 'unsupported_number' };
  }
  const vocab = allowedVocabulary(facts);
  for (const sentence of sentencesOf(t)) {
    const words = sentence.match(/[\p{L}']+/gu) ?? [];
    for (const w of words.slice(1)) {
      if (/^\p{Lu}/u.test(w) && !vocab.has(w.toLowerCase()))
        return { ok: false, reason: 'unsupported_name' };
    }
  }
  return { ok: true };
}

/** Simple, no-AI shortening: the first two sentences of the notes, at most 45 words. */
function shorten(notes: string): string {
  const sentences = notes.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]*/g) ?? [];
  const words = sentences.slice(0, 2).join(' ').trim().split(' ');
  const out = words.slice(0, 45).join(' ').trim();
  return out && !/[.!?]$/.test(out) ? `${out}.` : out;
}

const clean = (t: string) =>
  t
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// ---------------------------------------------------------------- cache

const CACHE_MAX = 500;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { text: string; at: number }>();

export const contextFingerprint = (personId: string, ctx: PersonContext, promptVersion: number) =>
  createHash('sha256')
    .update(`${personId}|${promptVersion}|${JSON.stringify(ctx)}`)
    .digest('hex');

function cacheGet(key: string): string | null {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.at > CACHE_TTL_MS) return null;
  cache.delete(key); // refresh LRU position
  cache.set(key, hit);
  return hit.text;
}

function cacheSet(key: string, text: string) {
  cache.set(key, { text, at: Date.now() });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
}

export function __clearSummaryCache() {
  cache.clear();
}

// ---------------------------------------------------------------- public API

export type SummarySource = 'llm' | 'cache' | 'fallback';

export async function patientSummary(
  personId: string,
  patientId: string,
  ctx: PersonContext,
  timeoutMs: number = env.LLM_TIMEOUT_MS,
): Promise<{ text: string; source: SummarySource; llmMs?: number; failure?: string }> {
  const prompt = loadPrompt('patientSummary');
  const key = contextFingerprint(personId, ctx, prompt.version);
  const cached = cacheGet(key);
  if (cached) return { text: cached, source: 'cache' };

  const result = await chat({
    system: prompt.text,
    user: `CONTEXT:\n${JSON.stringify(ctx, null, 2)}`,
    patientId,
    timeoutMs,
    maxTokens: 120,
  });
  if (!result.ok)
    return {
      text: fallbackSummary(ctx),
      source: 'fallback',
      llmMs: result.ms,
      failure: result.reason,
    };

  const text = clean(result.text);
  const facts = [
    ctx.firstName,
    ctx.relationship,
    String(ctx.age ?? ''),
    ...ctx.lastVisits.map((v) => `${v.date} ${v.daysAgo} days ago`),
    ...ctx.memories,
  ];
  let check = validateAgainstFacts(text, facts, {
    maxSentences: 3,
    maxWords: 55,
    mustInclude: ctx.firstName,
  });
  // No visit history given? Then the reply must not talk about visits.
  if (check.ok && !ctx.lastVisits.length && /\b(visit\w*|came|come|stopped by)\b/i.test(text))
    check = { ok: false, reason: 'unsupported_visit' };
  if (!check.ok) {
    return {
      text: fallbackSummary(ctx),
      source: 'fallback',
      llmMs: result.ms,
      failure: `guardrail:${check.reason}`,
    };
  }
  cacheSet(key, text);
  return { text, source: 'llm', llmMs: result.ms };
}

export async function draftVisitSummary(
  patientId: string,
  person: { firstName: string; relationship: string },
  notes: string,
): Promise<{
  draft: string | null;
  source: 'llm' | 'shortened' | 'unavailable';
  warning?: string;
}> {
  const prompt = loadPrompt('visitSummaryDraft');
  const result = await chat({
    system: prompt.text,
    user: `VISITOR: ${person.firstName}, ${person.relationship}\nNOTES:\n${notes}`,
    patientId,
    timeoutMs: env.LLM_DRAFT_TIMEOUT_MS,
    maxTokens: 200,
  });
  if (!result.ok) {
    // No AI right now: still give the caregiver something to edit (the opening of their notes).
    const short = shorten(notes);
    return short
      ? { draft: short, source: 'shortened', warning: result.reason }
      : { draft: null, source: 'unavailable', warning: result.reason };
  }
  const draft = clean(result.text);
  const check = validateAgainstFacts(draft, [notes, person.firstName, person.relationship], {
    maxSentences: 3,
    maxWords: 65,
  });
  // The caregiver reviews every draft anyway; surface the concern instead of hiding it.
  return { draft, source: 'llm', warning: check.ok ? undefined : check.reason };
}

export async function phraseAnswer(
  patientId: string,
  question: string,
  fact: string,
  timeoutMs: number = env.LLM_TIMEOUT_MS,
): Promise<{ text: string; source: 'llm' | 'fallback' }> {
  const prompt = loadPrompt('answerPhrasing');
  const result = await chat({
    system: prompt.text,
    user: `QUESTION: ${question}\nFACT: ${fact}`,
    patientId,
    timeoutMs,
    maxTokens: 80,
  });
  if (!result.ok) return { text: fact, source: 'fallback' };
  const text = clean(result.text);
  // Facts come from the question + DB fact only; every name/number in FACT must survive.
  const check = validateAgainstFacts(text, [fact], { maxSentences: 2, maxWords: 35 });
  const keepsFacts = (fact.match(/\d+|\p{Lu}[\p{L}']+/gu) ?? [])
    .filter((w) => !['This', 'They', 'I', 'You', 'Your', 'The'].includes(w))
    .every((w) => text.includes(w));
  return check.ok && keepsFacts ? { text, source: 'llm' } : { text: fact, source: 'fallback' };
}

/**
 * "Tell me simply": re-tells ONE approved memory in warm, plain words.
 * Only call this for memories that are approved AND consentApproved — pending
 * patient entries never go to the LLM. Falls back to the original text.
 */
export async function retellMemory(
  patientId: string,
  cacheKey: string,
  input: { firstName: string; relationship: string; when?: string; memory: string },
): Promise<{ text: string; source: SummarySource; failure?: string }> {
  const prompt = loadPrompt('memoryRetell');
  const key = `retell|${prompt.version}|${cacheKey}`;
  const cached = cacheGet(key);
  if (cached) return { text: cached, source: 'cache' };
  const result = await chat({
    system: prompt.text,
    user: `PERSON: ${input.firstName}, your ${input.relationship}\nWHEN: ${input.when ?? ''}\nMEMORY: ${input.memory}`,
    patientId,
    timeoutMs: env.LLM_ASK_TIMEOUT_MS,
    maxTokens: 100,
  });
  if (!result.ok) return { text: input.memory, source: 'fallback', failure: result.reason };
  const text = clean(result.text);
  const check = validateAgainstFacts(
    text,
    [input.memory, input.firstName, input.relationship, input.when ?? ''],
    { maxSentences: 2, maxWords: 45, mustInclude: input.firstName },
  );
  if (!check.ok)
    return { text: input.memory, source: 'fallback', failure: `guardrail:${check.reason}` };
  cacheSet(key, text);
  return { text, source: 'llm' };
}
