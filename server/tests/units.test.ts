/**
 * Unit tests: decision logic, context builder, guardrails, question parsing, SUS.
 */
import type { FrameAnalysis } from '../src/services/faceClient.service';
import { decide, type DecisionConfig } from '../src/services/decision.service';
import { assembleContext } from '../src/services/context.service';
import { fallbackSummary, validateAgainstFacts } from '../src/services/summary.service';
import {
  answerFact,
  parseQuestion,
  rankMemories,
  type AskMemory,
  type AskPerson,
} from '../src/services/ask.service';
import { susScore } from '../src/models/susResponse.model';

const cfg: DecisionConfig = {
  matchThreshold: 0.5,
  unsureThreshold: 0.35,
  framesRequired: 3,
  margin: 0.05,
  livenessMode: 'motion',
  livenessMinYawRange: 0.06,
};

const f = (id: string | null, score = 0, yaw = 0, second?: number): FrameAnalysis =>
  id === null
    ? { faceFound: false, faceCount: 0 }
    : {
        faceFound: true,
        faceCount: 1,
        yaw,
        best: { id, score },
        second: second === undefined ? null : { id: 'other', score: second },
      };

const moving = (id: string, scores: number[]) => scores.map((s, i) => f(id, s, -0.1 + i * 0.05));

describe('decision logic (thresholds + N of M frames + liveness)', () => {
  it('match when 3+ of 5 frames agree with median >= MATCH', () => {
    const d = decide(moving('priya', [0.62, 0.58, 0.7, 0.2, 0.66]), cfg);
    expect(d).toMatchObject({ outcome: 'match', personId: 'priya', votes: 4 });
    expect(d.score).toBeCloseTo(0.64, 2);
  });

  it('unsure when the median is between UNSURE and MATCH', () => {
    expect(decide(moving('priya', [0.4, 0.45, 0.42, 0.41, 0.44]), cfg)).toMatchObject({
      outcome: 'unsure',
      personId: 'priya',
    });
  });

  it('exactly at the MATCH threshold counts as a match; just below is unsure', () => {
    expect(decide(moving('p', [0.5, 0.5, 0.5]), cfg).outcome).toBe('match');
    expect(decide(moving('p', [0.4999, 0.4999, 0.4999]), cfg).outcome).toBe('unsure');
  });

  it('unknown below UNSURE — never guesses', () => {
    const d = decide(moving('priya', [0.3, 0.2, 0.33, 0.1, 0.34]), cfg);
    expect(d.outcome).toBe('unknown');
    expect(d.personId).toBeUndefined();
  });

  it('one or two strong frames are not enough (N of M)', () => {
    const frames = [
      f('priya', 0.9, 0),
      f('priya', 0.9, 0.1),
      f('arjun', 0.6, 0.05),
      f('x', 0.1, 0.02),
      f(null),
    ];
    expect(decide(frames, cfg).outcome).toBe('unknown');
  });

  it('split votes between two people -> unknown', () => {
    const frames = [
      f('a', 0.7, 0),
      f('b', 0.7, 0.1),
      f('a', 0.7, 0.05),
      f('b', 0.7, 0.02),
      f('c', 0.7, 0.08),
    ];
    expect(decide(frames, cfg).outcome).toBe('unknown');
  });

  it('ambiguous frames (best barely beats runner-up) do not vote', () => {
    const frames = [0, 0.05, 0.1, 0.15, 0.2].map((y) => f('a', 0.6, y, 0.58));
    expect(decide(frames, cfg).outcome).toBe('unknown');
  });

  it('no_face when fewer than N frames contain a face', () => {
    expect(decide([f(null), f(null), f('a', 0.9, 0), f('a', 0.9, 0.1), f(null)], cfg).outcome).toBe(
      'no_face',
    );
  });

  it('liveness: a static photo (constant yaw) is rejected and the identity is not revealed', () => {
    const d = decide(
      [0.7, 0.7, 0.7, 0.7, 0.7].map((s) => f('priya', s, 0.02)),
      cfg,
    );
    expect(d.outcome).toBe('liveness_failed');
    expect(d.personId).toBeUndefined();
    expect(d.liveness).toMatchObject({ checked: true, passed: false });
  });

  it('liveness can be switched off', () => {
    const d = decide(
      [0.7, 0.7, 0.7].map((s) => f('p', s, 0)),
      { ...cfg, livenessMode: 'off' },
    );
    expect(d.outcome).toBe('match');
  });
});

describe('context builder', () => {
  const person = {
    name: 'Priya Sharma',
    relationship: 'daughter',
    age: 42,
    consent: { given: true, scope: ['recognition', 'visit-history', 'conversation-summaries'] },
  };
  const visits = [
    { timestamp: new Date('2026-10-12T10:00:00') },
    { timestamp: new Date('2026-10-05T10:00:00') },
  ];
  const memories = [
    { summary: 'Brought mangoes.', reviewStatus: 'approved', consentApproved: true },
    { summary: 'PENDING patient text', reviewStatus: 'pending', consentApproved: false },
    { summary: 'FLAGGED text', reviewStatus: 'flagged', consentApproved: false },
    { summary: 'Approved but no consent', reviewStatus: 'approved', consentApproved: false },
  ];
  const now = new Date('2026-10-15T10:00:00');

  it('uses first name only, approved+consented memories only, visits newest first', () => {
    const ctx = assembleContext(person as never, visits, memories, { now });
    expect(ctx.firstName).toBe('Priya');
    expect(JSON.stringify(ctx)).not.toContain('Sharma');
    expect(ctx.memories).toEqual(['Brought mangoes.']);
    expect(ctx.lastVisits[0]).toEqual({ date: 'Monday 12 October', daysAgo: 3 });
  });

  it('respects consent scope', () => {
    const ctx = assembleContext(
      { ...person, consent: { given: true, scope: ['recognition'] } } as never,
      visits,
      memories,
      { now },
    );
    expect(ctx.lastVisits).toEqual([]);
    expect(ctx.memories).toEqual([]);
  });

  it('revoked consent -> no visits or memories', () => {
    const revoked = { ...person, consent: { ...person.consent, revokedAt: new Date() } };
    const ctx = assembleContext(revoked as never, visits, memories, { now });
    expect(ctx.lastVisits).toEqual([]);
    expect(ctx.memories).toEqual([]);
  });

  it('deterministic fallback template', () => {
    const ctx = assembleContext(person as never, visits, memories, { now });
    expect(fallbackSummary(ctx)).toBe(
      'This is Priya, your daughter. They last visited on Monday 12 October.',
    );
    expect(fallbackSummary({ ...ctx, lastVisits: [] })).toBe('This is Priya, your daughter.');
  });
});

describe('LLM output guardrails', () => {
  const facts = ['Priya', 'daughter', 'Monday 12 October 3 days ago', 'Brought mangoes.'];
  const limits = { maxSentences: 3, maxWords: 55, mustInclude: 'Priya' };
  const ok = (t: string) => validateAgainstFacts(t, facts, limits);

  it('accepts a faithful summary', () => {
    expect(
      ok('This is Priya, your daughter. She came on Monday 12 October and brought mangoes.').ok,
    ).toBe(true);
  });
  it('rejects health / diagnosis words', () => {
    expect(ok('This is Priya, your daughter. She helps with your dementia.').reason).toBe(
      'banned_word',
    );
  });
  it('rejects invented names and places', () => {
    expect(ok('This is Priya, your daughter. She came with Rahul.').reason).toBe(
      'unsupported_name',
    );
    expect(ok('This is Priya, your daughter. She lives in Mumbai.').reason).toBe(
      'unsupported_name',
    );
  });
  it('rejects invented numbers/dates', () => {
    expect(ok('This is Priya, your daughter. She is 45.').reason).toBe('unsupported_number');
  });
  it('rejects too many sentences, questions, missing name', () => {
    expect(ok('This is Priya. Hi. Hello. Bye.').reason).toBe('too_many_sentences');
    expect(ok('This is Priya, your daughter. Do you remember her?').reason).toBe('question');
    expect(ok('This is your daughter.').reason).toBe('missing_name');
  });
});

describe('patient questions (database first)', () => {
  const people: AskPerson[] = [
    { id: '1', name: 'Priya Sharma', relationship: 'daughter', canShareVisits: true },
    { id: '2', name: 'Arjun', relationship: 'grandson', canShareVisits: true },
    { id: '3', name: 'Meera', relationship: 'neighbour', canShareVisits: false },
  ];
  const now = new Date('2026-10-15T15:00:00');
  const visits = [
    { personId: '1', timestamp: new Date('2026-10-12T10:00:00') },
    { personId: '2', timestamp: new Date('2026-10-15T09:00:00') },
    { personId: '3', timestamp: new Date('2026-10-15T11:00:00') },
  ];
  const ask = (q: string) => answerFact(parseQuestion(q, people), { visits, people, now }).fact;

  it('when did X last visit', () => {
    expect(ask('When did Priya last visit?')).toBe('Priya last visited on Monday 12 October.');
    expect(ask('when did my grandson last come?')).toBe('Arjun last visited today.');
  });
  it('who is X / who is my <relationship>', () => {
    expect(ask('Who is Arjun?')).toBe('Arjun is your grandson.');
    expect(ask('Who is my daughter?')).toBe('Priya is your daughter.');
  });
  it('who came today — respects visit-history consent', () => {
    expect(ask('Who came today?')).toBe('Today, Arjun visited.');
    expect(ask('When did Meera last visit?')).toMatch(/ask your caregiver/);
  });
  it('unknown person / unsupported -> gentle redirect', () => {
    expect(ask('When did Rahul visit?')).toMatch(/ask your caregiver/);
    expect(ask('What is the weather?')).toMatch(/ask your caregiver/);
  });
  it('"meet" / "met" questions are last-visit questions', () => {
    expect(parseQuestion('When did Priya meet?', people).kind).toBe('last_visit');
    expect(parseQuestion('When did I meet Priya?', people).kind).toBe('last_visit');
    expect(parseQuestion('When did I last see my grandson?', people).kind).toBe('last_visit');
    expect(ask('When did Priya meet me?')).toBe('Priya last visited on Monday 12 October.');
  });

  const memories: AskMemory[] = [
    {
      id: 'm1',
      personId: '1',
      text: 'Priya brought mangoes from the market.',
      at: new Date('2026-10-01T10:00:00'),
    },
    {
      id: 'm2',
      personId: '1',
      text: 'You looked at the wedding album with Priya.',
      at: new Date('2026-10-10T10:00:00'),
    },
    {
      id: 'm3',
      personId: '2',
      text: 'Arjun played chess with you.',
      at: new Date('2026-10-14T10:00:00'),
    },
  ];
  const priyaMemories = memories.filter((m) => m.personId === '1');

  it('any other question naming a person is answered from their memories', () => {
    const intent = parseQuestion('What did Priya bring?', people);
    expect(intent.kind).toBe('about_person');
    const ranked = rankMemories('What did Priya bring?', people[0], priyaMemories);
    expect(ranked[0].id).toBe('m1');
    expect(answerFact(intent, { visits, people, memories: ranked, now }).fact).toBe(
      'Here is a memory about Priya, from Thursday 1 October: Priya brought mangoes from the market.',
    );
    expect(
      answerFact(parseQuestion('Tell me about Meera', people), {
        visits,
        people,
        memories: [],
        now,
      }).fact,
    ).toBe("I don't have any memories about Meera saved yet.");
  });
  it('rankMemories: shared words first, newest on a tie, the name does not count', () => {
    expect(rankMemories('Tell me about Priya', people[0], priyaMemories).map((m) => m.id)).toEqual([
      'm2',
      'm1',
    ]);
    expect(rankMemories('the wedding photos', people[0], priyaMemories)[0].id).toBe('m2');
    expect(rankMemories('mango', people[0], priyaMemories)[0].id).toBe('m1');
  });
  it('last visit falls back to the newest memory when no visit is saved', () => {
    const noVisits = answerFact(parseQuestion('When did I meet Priya?', people), {
      visits: [],
      people,
      memories: priyaMemories,
      now,
    }).fact;
    expect(noVisits).toBe(
      'The last memory about Priya was saved on Saturday 10 October: You looked at the wedding album with Priya.',
    );
    // Visit history not shared, but there is a memory: still answered from the memory.
    const meera = answerFact(parseQuestion('When did Meera visit?', people), {
      visits,
      people,
      memories: [
        {
          id: 'x',
          personId: '3',
          text: 'Meera brought flowers.',
          at: new Date('2026-10-13T09:00:00'),
        },
      ],
      now,
    }).fact;
    expect(meera).toBe(
      'The last memory about Meera was saved on Tuesday 13 October: Meera brought flowers.',
    );
  });
});

describe('SUS scoring', () => {
  it('computes the standard 0-100 score', () => {
    expect(susScore([5, 1, 5, 1, 5, 1, 5, 1, 5, 1])).toBe(100);
    expect(susScore([1, 5, 1, 5, 1, 5, 1, 5, 1, 5])).toBe(0);
    expect(susScore([3, 3, 3, 3, 3, 3, 3, 3, 3, 3])).toBe(50);
    expect(() => susScore([1, 2])).toThrow();
  });
});
