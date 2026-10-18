/**
 * Context builder: the ONLY data that may be sent to the LLM about a person.
 *
 *  - first name + relationship (+ age), never full names or IDs
 *  - last visits (dates only) — only if consent scope includes "visit-history"
 *  - memories — only reviewStatus "approved" AND consentApproved, and only if
 *    consent scope includes "conversation-summaries". Pending/flagged patient
 *    entries are never included.
 */
import { Types } from 'mongoose';
import { Memory, memorySummary } from '../models/memory.model';
import { hasActiveConsent, type PersonDoc } from '../models/person.model';
import { Visit, trustedVisitFilter } from '../models/visit.model';

export const MAX_VISITS = 5;
export const MAX_MEMORIES = 5;

export interface PersonContext {
  firstName: string;
  relationship: string;
  age?: number;
  /** Most recent first, e.g. "Sunday, 12 October" */
  lastVisits: { date: string; daysAgo: number }[];
  /** Most recent first; approved memories only */
  memories: string[];
}

export const firstNameOf = (name: string) => name.trim().split(/\s+/)[0];

export function formatVisitDate(d: Date, lang = 'en', now = new Date()) {
  const daysAgo = Math.max(0, Math.floor((startOfDay(now) - startOfDay(d)) / 86_400_000));
  let locale = lang;
  try {
    new Intl.DateTimeFormat(lang);
  } catch {
    locale = 'en';
  }
  const date = d.toLocaleDateString(locale === 'en' ? 'en-GB' : locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  return { date, daysAgo };
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Pure assembly step (unit-tested): applies consent scope and review filters. */
export function assembleContext(
  person: Pick<PersonDoc, 'name' | 'relationship' | 'age' | 'consent'>,
  visits: { timestamp: Date }[],
  memories: { summary: string; reviewStatus: string; consentApproved: boolean }[],
  opts: { lang?: string; now?: Date } = {},
): PersonContext {
  const scope = person.consent?.scope ?? [];
  const consentOk = hasActiveConsent(person);
  return {
    firstName: firstNameOf(person.name),
    relationship: person.relationship,
    age: person.age ?? undefined,
    lastVisits:
      consentOk && scope.includes('visit-history')
        ? visits.slice(0, MAX_VISITS).map((v) => formatVisitDate(v.timestamp, opts.lang, opts.now))
        : [],
    memories:
      consentOk && scope.includes('conversation-summaries')
        ? memories
            .filter((m) => m.reviewStatus === 'approved' && m.consentApproved)
            .slice(0, MAX_MEMORIES)
            .map((m) => m.summary)
        : [],
  };
}

/** Loads visits + memories from MongoDB and assembles the context. */
export async function buildPersonContext(
  person: PersonDoc,
  opts: { excludeVisitId?: Types.ObjectId | string; lang?: string } = {},
): Promise<PersonContext> {
  const visitFilter: Record<string, unknown> = {
    personId: person._id,
    patientId: person.patientId,
    ...trustedVisitFilter,
  };
  if (opts.excludeVisitId) visitFilter._id = { $ne: opts.excludeVisitId };
  const [visits, memories] = await Promise.all([
    Visit.find(visitFilter).sort({ timestamp: -1 }).limit(MAX_VISITS).lean(),
    Memory.find({
      personId: person._id,
      patientId: person.patientId,
      reviewStatus: 'approved',
      consentApproved: true,
    })
      .sort({ createdAt: -1 })
      .limit(MAX_MEMORIES),
  ]);
  return assembleContext(
    person,
    visits.map((v) => ({ timestamp: v.timestamp as Date })),
    memories.map((m) => ({
      summary: memorySummary(m),
      reviewStatus: m.reviewStatus,
      consentApproved: m.consentApproved,
    })),
    { lang: opts.lang },
  );
}
