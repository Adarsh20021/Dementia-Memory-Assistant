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
 *   "When did I meet Priya?" / "When did Priya meet me?" -> last visit, or the
 *                                         latest memory about her if no visit is saved
 *   "What did Priya bring?" / "Tell me about Arjun" -> the most relevant saved
 *                                         memory about that person (about_person)
 * Anything else -> a gentle "please ask your caregiver".
 *
 * Memories are matched to the question by shared words (rankMemories), newest
 * first on a tie. The route only passes in memories the requester may see.
 */
import { firstNameOf, formatVisitDate } from './context.service';

export interface AskPerson {
  id: string;
  name: string;
  relationship: string;
  canShareVisits: boolean;
}

/** A memory the requester is allowed to see (already decrypted). */
export interface AskMemory {
  id: string;
  personId: string;
  text: string;
  at: Date;
  /** Caregiver-approved. Preferred over unreviewed entries when equally relevant. */
  approved?: boolean;
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
  | { kind: 'about_person'; person: AskPerson }
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
    /\b(who|anyone|anybody|visitors?)\b.*\b(came|come|visited|visit|here|saw|see|met|meet)\b/.test(
      q,
    );
  const range: 'today' | 'yesterday' | 'week' | null = /\byesterday\b/.test(q)
    ? 'yesterday'
    : /\b(this week|week)\b/.test(q)
      ? 'week'
      : /\b(today|this morning|this afternoon|tonight)\b/.test(q)
        ? 'today'
        : null;
  if (asksVisitors && range && !person) return { kind: 'visitors', range };

  const asksWhen =
    /\b(when|last time|how long)\b/.test(q) &&
    /\b(visit|visited|visiting|came|come|see|saw|seen|here|meet|met|meeting)\b/.test(q);
  if (asksWhen) return person ? { kind: 'last_visit', person } : { kind: 'unknown_person' };

  if (/\bwho (is|was|s)\b/.test(q) || /\bwho's\b/.test(q)) {
    return person ? { kind: 'who_is', person } : { kind: 'unknown_person' };
  }
  if (asksVisitors && !person) return { kind: 'visitors', range: 'today' };
  // Any other question that names someone we know: answer from their memories.
  if (person) return { kind: 'about_person', person };
  return { kind: 'unsupported' };
}

// ---------------------------------------------------------------- memories

const STOP = new Set(
  (
    'a an the and or but of to in on at for with from by about as is are was were be been am ' +
    'do does did done have has had i me my mine you your we our us he she him her his hers they ' +
    'them their it its this that these those what when where who whom which why how there here ' +
    'tell remember please can could would will just last time day ever also some any so very ' +
    'meet met meeting visit visited visiting came come see saw seen'
  ).split(' '),
);

/** Common irregular past tenses, so "What did Priya bring?" matches "brought". */
const IRREGULAR: Record<string, string> = {
  brought: 'bring',
  bought: 'buy',
  ate: 'eat',
  went: 'go',
  gave: 'give',
  made: 'make',
  took: 'take',
  told: 'tell',
  sang: 'sing',
  drank: 'drink',
  wrote: 'write',
  read: 'read',
  sat: 'sit',
  spoke: 'speak',
  taught: 'teach',
  thought: 'think',
  cooked: 'cook',
};

/** Content words of a text, lower-cased, with a light plural/past-tense trim. */
function keywords(text: string, exclude: string[] = []): Set<string> {
  const out = new Set<string>();
  const ex = new Set(exclude.map((w) => norm(w)));
  for (const raw of norm(text).split(' ')) {
    if (raw.length < 3 || STOP.has(raw) || ex.has(raw)) continue;
    const base = IRREGULAR[raw] ?? raw;
    out.add(base.replace(/(ies|es|s|ed|ing)$/, '') || base);
  }
  return out;
}

/**
 * Orders a person's memories by how well they match the question: number of
 * shared content words (the person's own name and relationship do not count);
 * on a tie, approved before unreviewed, then newest first. Pure, unit-tested.
 */
export function rankMemories<T extends AskMemory>(
  question: string,
  person: Pick<AskPerson, 'name' | 'relationship'>,
  memories: T[],
): T[] {
  const q = keywords(question, [...person.name.split(/\s+/), person.relationship]);
  return memories
    .map((m) => {
      const words = keywords(m.text);
      let score = 0;
      for (const w of q) if (words.has(w)) score++;
      return { m, score };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.m.approved ?? true) - Number(a.m.approved ?? true) ||
        b.m.at.getTime() - a.m.at.getTime(),
    )
    .map((x) => x.m);
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
    /** For person questions: that person's memories, best match first (rankMemories). */
    memories?: AskMemory[];
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
      const last = p.canShareVisits
        ? data.visits
            .filter((v) => v.personId === p.id)
            .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0]
        : undefined;
      if (!last && !p.canShareVisits && !data.memories?.length)
        return { fact: NOT_SURE, found: false };
      if (!last) {
        // No visit record: the newest memory about them is the best clue we have.
        const newest = [...(data.memories ?? [])].sort(
          (a, b) => b.at.getTime() - a.at.getTime(),
        )[0];
        if (newest) {
          const { date } = formatVisitDate(newest.at, data.lang, now);
          return {
            fact: `The last memory about ${name} was saved on ${date}: ${newest.text}`,
            found: true,
          };
        }
        return { fact: `I don't have a visit from ${name} saved yet.`, found: true };
      }
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
    case 'about_person': {
      const name = firstNameOf(intent.person.name);
      const best = data.memories?.[0];
      if (!best) return { fact: `I don't have any memories about ${name} saved yet.`, found: true };
      const { date } = formatVisitDate(best.at, data.lang, now);
      return { fact: `Here is a memory about ${name}, from ${date}: ${best.text}`, found: true };
    }
    default:
      return { fact: NOT_SURE, found: false };
  }
}
