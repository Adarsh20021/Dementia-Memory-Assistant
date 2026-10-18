/**
 * Phase 2-4 API tests: enrollment, recognition, Groq summary with guardrails,
 * fallback and cache, visits, questions, help requests.
 */
import { readFile, readdir } from 'fs/promises';
import path from 'path';
import request from 'supertest';
import { env } from '../src/config/env';
import { Person } from '../src/models/person.model';
import { RecognitionEvent } from '../src/models/recognitionEvent.model';
import { Visit } from '../src/models/visit.model';
import { __clearSummaryCache } from '../src/services/summary.service';
import {
  app,
  bearer,
  createPatient,
  createPerson,
  pairPatient,
  registerAndLogin,
  useTestDb,
  validConsent,
} from './helpers';
import { frame, jpeg, liveFrames, startMocks, type Mocks } from './mockServices';

useTestDb();

let mocks: Mocks;
let cg: string;
let patientId: string;
let patientToken: string;
let priyaId: string;

const enroll = (personId: string, markers: string[], token = cg) => {
  let r = request(app)
    .post(`/api/patients/${patientId}/people/${personId}/photos`)
    .set(bearer(token));
  markers.forEach(
    (m, i) =>
      (r = r.attach('photos', jpeg(m), { filename: `p${i}.jpg`, contentType: 'image/jpeg' })),
  );
  return r;
};

const recognize = (frames: Buffer[], token = patientToken, pid = patientId) => {
  let r = request(app).post(`/api/patients/${pid}/recognize`).set(bearer(token));
  frames.forEach(
    (f, i) => (r = r.attach('frames', f, { filename: `f${i}.jpg`, contentType: 'image/jpeg' })),
  );
  return r;
};

beforeAll(async () => {
  mocks = await startMocks();
  cg = (await registerAndLogin()).token;
  patientId = await createPatient(cg);
  patientToken = (await pairPatient(cg, patientId)).token;
  const res = await request(app)
    .post(`/api/patients/${patientId}/people`)
    .set(bearer(cg))
    .send({
      name: 'Priya Sharma',
      relationship: 'daughter',
      consent: {
        ...validConsent,
        scope: ['recognition', 'visit-history', 'conversation-summaries'],
      },
    })
    .expect(201);
  priyaId = res.body.person.id;
});

afterAll(async () => {
  await mocks.close();
});

beforeEach(() => {
  mocks.faceUp = true;
  mocks.llmReply = () => 'This is Priya, your daughter. She visited you recently.';
  mocks.llmRequests = [];
  __clearSummaryCache();
});

describe('face enrollment', () => {
  it('stores good photos encrypted, rejects poor ones with a reason', async () => {
    const res = await enroll(priyaId, ['GOOD-1', 'BLURRY', 'GOOD-2', 'NOFACE']).expect(201);
    expect(res.body.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, false, true, false]);
    expect(res.body.results[1]).toMatchObject({
      code: 'too_blurry',
      message: 'The photo is blurry.',
    });
    expect(res.body.person).toMatchObject({ photoCount: 2, enrolledFaceCount: 2 });
    expect(res.body.needsMore).toBe(1);
    expect(JSON.stringify(res.body)).not.toMatch(/"embeddings"|"enc"/);

    // On disk: encrypted, the original bytes are not there.
    const dir = path.resolve(env.UPLOAD_DIR, patientId, priyaId);
    const files = await readdir(dir);
    expect(files).toHaveLength(2);
    expect(await readFile(path.join(dir, files[0]), 'utf8')).not.toContain('GOOD');

    // ...and the API decrypts it for the caregiver.
    const photoId = res.body.person.photos[0].id;
    const img = await request(app)
      .get(`/api/patients/${patientId}/people/${priyaId}/photos/${photoId}`)
      .set(bearer(cg))
      .expect(200);
    expect(img.headers['cache-control']).toMatch(/no-store/);
    expect(img.body.subarray(4).toString()).toBe('GOOD-1');

    await enroll(priyaId, ['GOOD-3']).expect(201);
  });

  it('rejects non-images even if they claim to be JPEG', async () => {
    const res = await request(app)
      .post(`/api/patients/${patientId}/people/${priyaId}/photos`)
      .set(bearer(cg))
      .attach('photos', Buffer.from('MZ fake exe'), {
        filename: 'x.jpg',
        contentType: 'image/jpeg',
      })
      .expect(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_FILE');
  });

  it('enforces the per-person photo limit', async () => {
    const pid = await createPerson(cg, patientId, 'Limit');
    await enroll(pid, ['GOOD', 'GOOD', 'GOOD', 'GOOD', 'GOOD']).expect(201);
    const res = await enroll(pid, ['GOOD']).expect(422);
    expect(res.body.results[0].code).toBe('limit_reached');
  });

  it('is blocked without consent and for patients', async () => {
    const pid = await createPerson(cg, patientId, 'Revoked');
    await request(app)
      .post(`/api/patients/${patientId}/people/${pid}/consent/revoke`)
      .set(bearer(cg))
      .send({});
    const res = await enroll(pid, ['GOOD']).expect(403);
    expect(res.body.error.code).toBe('CONSENT_REQUIRED');
    await enroll(priyaId, ['GOOD'], patientToken).expect(403);
  });

  it('removing a photo also removes its embedding', async () => {
    const pid = await createPerson(cg, patientId, 'Remove');
    const r = await enroll(pid, ['GOOD', 'GOOD']).expect(201);
    const res = await request(app)
      .delete(`/api/patients/${patientId}/people/${pid}/photos/${r.body.person.photos[0].id}`)
      .set(bearer(cg))
      .expect(200);
    expect(res.body.person).toMatchObject({ photoCount: 1, enrolledFaceCount: 1 });
    const cleared = await request(app)
      .delete(`/api/patients/${patientId}/people/${pid}/photos`)
      .set(bearer(cg))
      .expect(200);
    expect(cleared.body.person).toMatchObject({ photoCount: 0, enrolledFaceCount: 0 });
  });
});

describe('"Who is this?" recognition', () => {
  it('match: names the person, records a visit and an event; an invented visit is rejected -> template', async () => {
    const res = await recognize(liveFrames(priyaId, 0.72)).expect(200);
    expect(res.body).toMatchObject({
      outcome: 'match',
      person: { id: priyaId, name: 'Priya', relationship: 'daughter' },
      message: 'This is Priya, your daughter.',
    });
    // Groq was asked, but its reply mentioned a visit that is not in the facts.
    expect(mocks.llmRequests).toHaveLength(1);
    expect(res.body.person.photoUrl).toBe(`/api/patients/${patientId}/faces/${priyaId}/photo`);
    const visit = await Visit.findById(res.body.visitId);
    expect(visit).toMatchObject({ outcome: 'match', needsConfirmation: false });
    const ev = await RecognitionEvent.findById(res.body.eventId).lean();
    expect(ev).toMatchObject({ outcome: 'match', votes: 5 });
    expect(ev!.timings?.serverTotalMs).toBeGreaterThanOrEqual(0);
  });

  it('only sends this patient’s consented, enrolled people to the face service (decrypted in memory)', async () => {
    await recognize(liveFrames(priyaId, 0.72)).expect(200);
    const ids = (mocks.lastAnalyze!.candidates as { id: string }[]).map((c) => c.id);
    expect(ids).toContain(priyaId);
    const revoked = await Person.findOne({ name: 'Revoked' });
    expect(ids).not.toContain(String(revoked!._id));
    // Embeddings are decrypted 512-float vectors when sent.
    const emb = (mocks.lastAnalyze!.candidates as { embeddings: string[] }[])[0].embeddings[0];
    expect(Buffer.from(emb, 'base64').length).toBe(2048);
  });

  it('Groq receives only first name, relationship, visit dates and approved memories', async () => {
    await request(app)
      .post(`/api/patients/${patientId}/memories`)
      .set(bearer(cg))
      .send({ personId: priyaId, summary: 'Priya brought mangoes.' })
      .expect(201);
    await request(app)
      .post(`/api/patients/${patientId}/memories`)
      .set(bearer(patientToken))
      .send({ personId: priyaId, summary: 'PATIENT-PENDING-TEXT' })
      .expect(201);
    await Visit.create({
      patientId,
      personId: priyaId,
      timestamp: new Date(Date.now() - 3 * 86_400_000),
    });

    mocks.llmReply = () => 'This is Priya, your daughter. She brought mangoes.';
    const res = await recognize(liveFrames(priyaId, 0.7)).expect(200);
    expect(res.body.message).toBe('This is Priya, your daughter. She brought mangoes.');
    const sent = JSON.stringify(mocks.llmRequests[0]);
    expect(sent).toContain('Priya brought mangoes.');
    expect(sent).not.toContain('PATIENT-PENDING-TEXT');
    expect(sent).not.toContain('Sharma');
    expect(sent).not.toContain(priyaId);
    expect(sent).not.toContain(patientId);
  });

  it('second identical request is served from the cache (no Groq call)', async () => {
    await recognize(liveFrames(priyaId, 0.7)).expect(200);
    const calls = mocks.llmRequests.length;
    const res = await recognize(liveFrames(priyaId, 0.7)).expect(200);
    expect(mocks.llmRequests.length).toBe(calls);
    const ev = await RecognitionEvent.findById(res.body.eventId).lean();
    expect(ev!.summarySource).toBe('cache');
  });

  it('falls back to the template when Groq breaks the rules', async () => {
    mocks.llmReply = () => 'This is Priya, your daughter. She knows about your dementia.';
    const res = await recognize(liveFrames(priyaId, 0.7)).expect(200);
    expect(res.body.message).toMatch(/^This is Priya, your daughter\. They last visited on /);
  });

  it('falls back to the template when Groq times out (3 s budget; 300 ms in tests)', async () => {
    mocks.llmReply = () => 'TIMEOUT';
    const started = Date.now();
    const res = await recognize(liveFrames(priyaId, 0.7)).expect(200);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.body.message).toMatch(/^This is Priya, your daughter\./);
    const ev = await RecognitionEvent.findById(res.body.eventId).lean();
    expect(ev!.summarySource).toBe('fallback');
  });

  it('unsure: "This may be ..." and the visit waits for caregiver confirmation', async () => {
    await Visit.deleteMany({ personId: priyaId });
    const res = await recognize(liveFrames(priyaId, 0.42)).expect(200);
    expect(res.body).toMatchObject({ outcome: 'unsure', needsCaregiverConfirmation: true });
    expect(res.body.message).toBe("This may be Priya. Let's ask your caregiver to check.");
    expect(mocks.llmRequests).toHaveLength(0);

    const pending = await request(app)
      .get(`/api/patients/${patientId}/visits?needsConfirmation=true`)
      .set(bearer(cg))
      .expect(200);
    expect(pending.body.visits).toHaveLength(1);
    const confirmed = await request(app)
      .post(`/api/patients/${patientId}/visits/${res.body.visitId}/confirm`)
      .set(bearer(cg))
      .send({ confirmed: true })
      .expect(200);
    expect(confirmed.body.visit).toMatchObject({
      needsConfirmation: false,
      confirmedByCaregiver: true,
    });
  });

  it('unknown: low scores never name anyone', async () => {
    const res = await recognize(liveFrames(priyaId, 0.2)).expect(200);
    expect(res.body).toMatchObject({
      outcome: 'unknown',
      message: "I don't recognize this person. Please ask your caregiver.",
    });
    expect(res.body.person).toBeUndefined();
  });

  it('a person who is not enrolled for this patient cannot be matched', async () => {
    const res = await recognize(liveFrames('000000000000000000000000', 0.95)).expect(200);
    expect(res.body.outcome).toBe('unknown');
  });

  it('needs 3 of 5 frames to agree', async () => {
    const frames = [
      frame(priyaId, 0.9, 0),
      frame(priyaId, 0.9, 0.1),
      jpeg('NOFACE'),
      frame(priyaId, 0.1, 0.05),
      jpeg('NOFACE'),
    ];
    expect((await recognize(frames).expect(200)).body.outcome).toBe('unknown');
  });

  it('liveness: a photo held up to the camera (no head movement) is refused', async () => {
    const still = Array.from({ length: 5 }, () => frame(priyaId, 0.8, 0.03));
    const res = await recognize(still).expect(200);
    expect(res.body.outcome).toBe('liveness_failed');
    expect(res.body.person).toBeUndefined();
    expect(res.body.message).toMatch(/turn their head/);
  });

  it('no face', async () => {
    const res = await recognize(Array.from({ length: 5 }, () => jpeg('NOFACE'))).expect(200);
    expect(res.body.outcome).toBe('no_face');
  });

  it('face service down -> friendly 503', async () => {
    mocks.faceUp = false;
    const res = await recognize(liveFrames(priyaId, 0.8)).expect(503);
    expect(res.body.error.message).toBe(
      "I can't check faces right now. Please ask your caregiver.",
    );
  });

  it('a repeat recognition within the dedup window updates the same visit', async () => {
    const a = await recognize(liveFrames(priyaId, 0.7)).expect(200);
    const b = await recognize(liveFrames(priyaId, 0.8)).expect(200);
    expect(b.body.visitId).toBe(a.body.visitId);
  });

  it('patient sees the result photo; another patient cannot', async () => {
    await request(app)
      .get(`/api/patients/${patientId}/faces/${priyaId}/photo`)
      .set(bearer(patientToken))
      .expect(200);
    const other = await createPatient(cg, 'Other');
    const otherToken = (await pairPatient(cg, other)).token;
    await request(app)
      .get(`/api/patients/${patientId}/faces/${priyaId}/photo`)
      .set(bearer(otherToken))
      .expect(404);
    await recognize(liveFrames(priyaId, 0.8), otherToken).expect(404);
  });

  it('client timings are stored for the evaluation harness', async () => {
    const r = await recognize(liveFrames(priyaId, 0.7)).expect(200);
    await request(app)
      .post(`/api/patients/${patientId}/recognitions/${r.body.eventId}/timing`)
      .set(bearer(patientToken))
      .send({ captureMs: 1500, clientRoundTripMs: 400, resultToSpeechMs: 120, endToEndMs: 2020 })
      .expect(204);
    const summary = await request(app)
      .get(`/api/patients/${patientId}/evaluation/summary`)
      .set(bearer(cg))
      .expect(200);
    expect(summary.body.latencyMs.endToEnd.n).toBeGreaterThanOrEqual(1);
    const csv = await request(app)
      .get(`/api/patients/${patientId}/evaluation/events.csv`)
      .set(bearer(cg))
      .expect(200);
    expect(csv.text.split('\n')[0]).toMatch(/^timestamp,outcome,score/);
  });
});

describe('questions and help', () => {
  it('answers from the database; Groq only rephrases', async () => {
    mocks.llmReply = () => 'Priya last visited today.';
    const res = await request(app)
      .post(`/api/patients/${patientId}/ask`)
      .set(bearer(patientToken))
      .send({ question: 'When did Priya last visit?' })
      .expect(200);
    expect(res.body).toMatchObject({ answer: 'Priya last visited today.', found: true });
  });

  it('rejects a rephrasing that changes the facts', async () => {
    mocks.llmReply = () => 'Arjun last visited yesterday.';
    const res = await request(app)
      .post(`/api/patients/${patientId}/ask`)
      .set(bearer(patientToken))
      .send({ question: 'When did Priya last visit?' })
      .expect(200);
    expect(res.body).toMatchObject({ answer: 'Priya last visited today.', source: 'database' });
  });

  it('"Ask my caregiver" creates one open help request', async () => {
    await request(app)
      .post(`/api/patients/${patientId}/help-requests`)
      .set(bearer(patientToken))
      .send({ context: 'who-is-this' })
      .expect(201);
    await request(app)
      .post(`/api/patients/${patientId}/help-requests`)
      .set(bearer(patientToken))
      .send({})
      .expect(201);
    const list = await request(app)
      .get(`/api/patients/${patientId}/help-requests?open=true`)
      .set(bearer(cg))
      .expect(200);
    expect(list.body.helpRequests).toHaveLength(1);
    await request(app)
      .post(`/api/patients/${patientId}/help-requests/${list.body.helpRequests[0].id}/resolve`)
      .set(bearer(cg))
      .expect(200);
    const overview = await request(app)
      .get(`/api/patients/${patientId}/overview`)
      .set(bearer(cg))
      .expect(200);
    expect(overview.body.counts.openHelpRequests).toBe(0);
    expect(overview.body.recentEvents.length).toBeGreaterThan(0);
  });
});
