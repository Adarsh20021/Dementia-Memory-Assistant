/**
 * Patient questions, answered from the DATABASE first. Groq is used only to
 * re-phrase the factual answer (see summary.service#phraseAnswer).
 *
 * Supported (simple, rule-based, unit-tested):
 *   "When did Priya last visit?"         -> last trusted visit of that person
 *   "Who is Arjun?" / "Who is my grandson?" -> name + relationship
 *   "Who came today / yesterday / this week?" -> visitors in that range
 *   "When is Priya coming?"              -> next planned visit of that person
 *   "Who is coming today / tomorrow / this week?" -> planned visits in that range
 * Anything else -> a gentle "please ask your caregiver".
 */
import { firstNameOf, formatVisitDate } from './context.service';

export interface AskPerson {
  id: string;
  name: string;
  relationship: string;
  canShareVisits: boolean;
}

export interface AskVisit {
  personId: string;
  timestamp: Date;
}

/** A planned visit (scheduled by the caregiver or the patient). */
export interface AskPlanned {
  personId?: string;
  who: string;
  startsAt: Date;
}

export type AskIntent =
  | { kind: 'last_visit'; person: AskPerson }
  | { kind: 'who_is'; person: AskPerson }
  | { kind: 'visitors'; range: 'today' | 'yesterday' | 'week' }
  | { kind: 'next_visit'; person: AskPerson }
  | { kind: 'upcoming'; range: 'today' | 'tomorrow' | 'week' }
  | { kind: 'unknown_person' }
  | { kind: 'unsupported' };

export const NOT_SURE = "I'm not sure about that. Please ask your caregiver.";

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function findPerson(question: string, people: AskPerson[]): AskPerson | null {
  const q = ` ${norm(question)} `;
  // Prefer an explicit first name, then a relationship ("my daughter").
  for (const p of people) {
    const first = norm(firstNameOf(p.name));
    if (first && q.includes(` ${first} `)) return p;
  }
  for (const p of people) {
    const rel = norm(p.relationship);
    if (rel && (q.includes(` my ${rel} `) || q.includes(` the ${rel} `) || q.includes(` ${rel} `)))
      return p;
  }
  return null;
}

export function parseQuestion(question: string, people: AskPerson[]): AskIntent {
  const q = norm(question);
  const person = findPerson(question, people);

  // Future questions: "When is Priya coming?", "Who is coming tomorrow?"
  const future = /\b(coming|will|next|going to|tomorrow|planned|expected)\b/.test(q);
  if (future) {
    const fRange: 'today' | 'tomorrow' | 'week' = /\btomorrow\b/.test(q)
      ? 'tomorrow'
      : /\bweek\b/.test(q)
        ? 'week'
        : /\b(today|tonight|this (morning|afternoon|evening))\b/.test(q)
          ? 'today'
          : 'week';
    if (person && /\b(when|what time|what day|is|coming|next)\b/.test(q))
      return { kind: 'next_visit', person };
    if (!person && /\b(who|anyone|anybody|visitors?|visit)\b/.test(q))
      return { kind: 'upcoming', range: fRange };
  }

  const asksVisitors =
    /\b(who|anyone|anybody|visitors?)\b.*\b(came|come|visited|visit|here|saw|see)\b/.test(q);
  const range: 'today' | 'yesterday' | 'week' | null = /\byesterday\b/.test(q)
    ? 'yesterday'
    : /\b(this week|week)\b/.test(q)
      ? 'week'
      : /\b(today|this morning|this afternoon|tonight)\b/.test(q)
        ? 'today'
        : null;
  if (asksVisitors && range && !person) return { kind: 'visitors', range };

  const asksWhen =
    /\b(when|last time|how long)\b/.test(q) && /\b(visit|visited|came|come|see|saw|here)\b/.test(q);
  if (asksWhen) return person ? { kind: 'last_visit', person } : { kind: 'unknown_person' };

  if (/\bwho (is|was|s)\b/.test(q) || /\bwho's\b/.test(q)) {
    return person ? { kind: 'who_is', person } : { kind: 'unknown_person' };
  }
  if (asksVisitors && !person) return { kind: 'visitors', range: 'today' };
  return { kind: 'unsupported' };
}

const joinNames = (names: string[]) =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** Turns an intent + DB rows into a factual sentence. Pure. */
const timeOf = (d: Date, lang = 'en') => {
  let locale = lang === 'en' ? 'en-GB' : lang;
  try {
    new Intl.DateTimeFormat(locale);
  } catch {
    locale = 'en-GB';
  }
  return d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', hour12: true });
};

/** "today at 4:00 pm", "tomorrow at 10:30 am", "on Saturday 25 October at 4:00 pm". */
export function whenPlanned(d: Date, lang = 'en', now = new Date()) {
  const startNow = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startD = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startD - startNow) / 86_400_000);
  const day =
    days === 0 ? 'today' : days === 1 ? 'tomorrow' : `on ${formatVisitDate(d, lang, now).date}`;
  return `${day} at ${timeOf(d, lang)}`;
}

export function answerFact(
  intent: AskIntent,
  data: {
    visits: AskVisit[];
    people: AskPerson[];
    planned?: AskPlanned[];
    lang?: string;
    now?: Date;
  },
): { fact: string; found: boolean } {
  const now = data.now ?? new Date();
  const planned = (data.planned ?? [])
    .filter((p) => p.startsAt.getTime() >= now.getTime() - 2 * 3_600_000)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  switch (intent.kind) {
    case 'next_visit': {
      const name = firstNameOf(intent.person.name);
      const next = planned.find((p) => p.personId === intent.person.id);
      if (!next) return { fact: `I don't have a planned visit from ${name} yet.`, found: true };
      return {
        fact: `${name} is coming ${whenPlanned(next.startsAt, data.lang, now)}.`,
        found: true,
      };
    }
    case 'upcoming': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const from = intent.range === 'tomorrow' ? new Date(start.getTime() + 86_400_000) : start;
      const to = new Date(
        start.getTime() +
          (intent.range === 'today' ? 1 : intent.range === 'tomorrow' ? 2 : 7) * 86_400_000,
      );
      const inRange = planned.filter((p) => p.startsAt >= from && p.startsAt < to);
      const label = intent.range === 'week' ? 'in the next few days' : intent.range;
      if (!inRange.length) return { fact: `No visits are planned ${label}.`, found: true };
      const parts = inRange
        .slice(0, 4)
        .map((p) => `${p.who} ${whenPlanned(p.startsAt, data.lang, now)}`);
      return { fact: `Coming soon: ${joinNames(parts)}.`, found: true };
    }
    case 'who_is': {
      const p = intent.person;
      return { fact: `${firstNameOf(p.name)} is your ${p.relationship}.`, found: true };
    }
    case 'last_visit': {
      const p = intent.person;
      const name = firstNameOf(p.name);
      if (!p.canShareVisits) return { fact: NOT_SURE, found: false };
      const last = data.visits
        .filter((v) => v.personId === p.id)
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];
      if (!last) return { fact: `I don't have a visit from ${name} saved yet.`, found: true };
      const { date, daysAgo } = formatVisitDate(last.timestamp, data.lang, now);
      const when = daysAgo === 0 ? 'today' : daysAgo === 1 ? 'yesterday' : `on ${date}`;
      return { fact: `${name} last visited ${when}.`, found: true };
    }
    case 'visitors': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      let from = start;
      let to = new Date(start.getTime() + 86_400_000);
      if (intent.range === 'yesterday') {
        from = new Date(start.getTime() - 86_400_000);
        to = start;
      } else if (intent.range === 'week') {
        from = new Date(start.getTime() - 6 * 86_400_000);
      }
      const shareable = new Map(data.people.filter((p) => p.canShareVisits).map((p) => [p.id, p]));
      const ids = [
        ...new Set(
          data.visits
            .filter((v) => v.timestamp >= from && v.timestamp < to && shareable.has(v.personId))
            .map((v) => v.personId),
        ),
      ];
      const label = intent.range === 'week' ? 'this week' : intent.range;
      if (!ids.length) return { fact: `I don't have any visits saved for ${label}.`, found: true };
      const names = ids.map((id) => firstNameOf(shareable.get(id)!.name));
      const capital = label.charAt(0).toUpperCase() + label.slice(1);
      return { fact: `${capital}, ${joinNames(names)} visited.`, found: true };
    }
    default:
      return { fact: NOT_SURE, found: false };
  }
}
