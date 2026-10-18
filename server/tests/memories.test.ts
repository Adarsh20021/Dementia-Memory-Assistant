/**
 * Memories (patient writes + caregiver review + Groq drafts), export, SUS, retention.
 */
import request from 'supertest';
import { Memory } from '../src/models/memory.model';
import { Patient } from '../src/models/patient.model';
import { RecognitionEvent } from '../src/models/recognitionEvent.model';
import { Visit } from '../src/models/visit.model';
import { runRetention } from '../src/services/retention.service';
import {
  app,
  bearer,
  createPatient,
  pairPatient,
  registerAndLogin,
  useTestDb,
  validConsent,
} from './helpers';
import { startMocks, type Mocks } from './mockServices';

useTestDb();

let mocks: Mocks;
let cg: string;
let patientId: string;
let pt: string;
let priyaId: string;
let noSummaryPersonId: string;
const url = (p = '') => `/api/patients/${patientId}/memories${p}`;

beforeAll(async () => {
  mocks = await startMocks();
  cg = (await registerAndLogin()).token;
  patientId = await createPatient(cg);
  pt = (await pairPatient(cg, patientId)).token;
  const mk = (name: string, scope: string[]) =>
    request(app)
      .post(`/api/patients/${patientId}/people`)
      .set(bearer(cg))
      .send({ name, relationship: 'friend', consent: { ...validConsent, givenBy: name, scope } });
  priyaId = (await mk('Priya', ['recognition', 'visit-history', 'conversation-summaries'])).body
    .person.id;
  noSummaryPersonId = (await mk('Sam', ['recognition'])).body.person.id;
});
afterAll(() => mocks.close());

describe('patient "Remember this" entries', () => {
  let mineId: string;
  let caregiverId: string;

  it('are saved immediately as pending, encrypted at rest', async () => {
    const res = await request(app)
      .post(url())
      .set(bearer(pt))
      .send({ personId: priyaId, summary: 'Priya came with sweets' })
      .expect(201);
    expect(res.body.memory).toMatchObject({
      source: 'patient',
      reviewStatus: 'pending',
      mine: true,
      version: 1,
    });
    expect(res.body.memory.history).toBeUndefined(); // patients don't get caregiver-only fields
    mineId = res.body.memory.id;
    const raw = await Memory.findById(mineId).lean();
    expect(raw!.summaryEnc).not.toContain('sweets');
  });

  it('patient cannot set source/status (mass assignment blocked)', async () => {
    await request(app)
      .post(url())
      .set(bearer(pt))
      .send({ summary: 'x', reviewStatus: 'approved' })
      .expect(400);
    await request(app)
      .post(url())
      .set(bearer(pt))
      .send({ summary: 'x', source: 'caregiver' })
      .expect(400);
  });

  it('patient lists only their own; caregiver sees all', async () => {
    caregiverId = (
      await request(app)
        .post(url())
        .set(bearer(cg))
        .send({ personId: priyaId, summary: 'Caregiver note' })
        .expect(201)
    ).body.memory.id;
    const mine = await request(app).get(url()).set(bearer(pt)).expect(200);
    expect(mine.body.memories.map((m: { id: string }) => m.id)).toEqual([mineId]);
    const all = await request(app).get(url()).set(bearer(cg)).expect(200);
    expect(all.body.memories).toHaveLength(2);
  });

  it('patient cannot edit or delete caregiver-authored memories', async () => {
    await request(app)
      .patch(url(`/${caregiverId}`))
      .set(bearer(pt))
      .send({ summary: 'hack' })
      .expect(403);
    await request(app)
      .delete(url(`/${caregiverId}`))
      .set(bearer(pt))
      .expect(403);
  });

  it('caregiver review: correct keeps the original patient text in history', async () => {
    const queue = await request(app).get(url('/review-queue')).set(bearer(cg)).expect(200);
    expect(queue.body.memories.map((m: { id: string }) => m.id)).toContain(mineId);

    const res = await request(app)
      .post(url(`/${mineId}/review`))
      .set(bearer(cg))
      .send({ action: 'correct', summary: 'Priya came with sweets for Diwali.' })
      .expect(200);
    expect(res.body.memory).toMatchObject({
      reviewStatus: 'approved',
      consentApproved: true,
      version: 2,
    });
    expect(res.body.memory.history[0]).toMatchObject({
      version: 1,
      summary: 'Priya came with sweets',
    });
  });

  it('a patient edit after approval sends it back to pending', async () => {
    const res = await request(app)
      .patch(url(`/${mineId}`))
      .set(bearer(pt))
      .send({ summary: 'Priya came with sweets and flowers' })
      .expect(200);
    expect(res.body.memory).toMatchObject({ reviewStatus: 'pending', version: 3 });
  });

  it('flagging keeps it out of context', async () => {
    const res = await request(app)
      .post(url(`/${mineId}/review`))
      .set(bearer(cg))
      .send({ action: 'flag' })
      .expect(200);
    expect(res.body.memory).toMatchObject({ reviewStatus: 'flagged', consentApproved: false });
  });

  it('approving a memory about someone without summary consent is not used for the patient', async () => {
    const m = await request(app)
      .post(url())
      .set(bearer(pt))
      .send({ personId: noSummaryPersonId, summary: 'Sam fixed the radio' })
      .expect(201);
    const res = await request(app)
      .post(url(`/${m.body.memory.id}/review`))
      .set(bearer(cg))
      .send({ action: 'approve' })
      .expect(200);
    expect(res.body.memory.consentApproved).toBe(false);
    expect(res.body.note).toMatch(/not consented/);
    await request(app)
      .post(url())
      .set(bearer(cg))
      .send({ personId: noSummaryPersonId, summary: 'x' })
      .expect(409);
  });

  it('search works on encrypted text', async () => {
    const res = await request(app).get(url('?q=radio')).set(bearer(cg)).expect(200);
    expect(res.body.memories).toHaveLength(1);
  });

  it('patient can delete their own entry', async () => {
    await request(app)
      .delete(url(`/${mineId}`))
      .set(bearer(pt))
      .expect(204);
  });
});

describe('Groq visit-summary drafts', () => {
  it('drafts from caregiver notes but stores nothing', async () => {
    mocks.llmReply = () => 'Priya brought mangoes and you looked at old photos.';
    const before = await Memory.countDocuments();
    const res = await request(app)
      .post(url('/draft'))
      .set(bearer(cg))
      .send({
        personId: priyaId,
        notes: 'priya came, brought mangoes, looked at old photos together',
      })
      .expect(200);
    expect(res.body).toMatchObject({
      source: 'llm',
      draft: 'Priya brought mangoes and you looked at old photos.',
    });
    expect(await Memory.countDocuments()).toBe(before);
    const saved = await request(app)
      .post(url())
      .set(bearer(cg))
      .send({ personId: priyaId, summary: res.body.draft, source: 'ai-summary' })
      .expect(201);
    expect(saved.body.memory).toMatchObject({ source: 'ai-summary', reviewStatus: 'approved' });
  });

  it('when Groq is unavailable the draft is just the start of the notes, labelled as such', async () => {
    mocks.llmReply = () => 'ERROR';
    const res = await request(app)
      .post(url('/draft'))
      .set(bearer(cg))
      .send({ personId: priyaId, notes: 'came for lunch' })
      .expect(200);
    expect(res.body).toMatchObject({ draft: 'came for lunch.', source: 'shortened' });
    expect(res.body.message).toMatch(/not available/i);
  });

  it('patients cannot draft', async () => {
    await request(app)
      .post(url('/draft'))
      .set(bearer(pt))
      .send({ personId: priyaId, notes: 'abc' })
      .expect(403);
  });
});

describe('export, SUS, retention', () => {
  it('export returns decrypted data without biometrics', async () => {
    const res = await request(app)
      .get(`/api/patients/${patientId}/export`)
      .set(bearer(cg))
      .expect(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.body.people.length).toBe(2);
    expect(JSON.stringify(res.body)).not.toMatch(/embedding"|"enc"|storageKey/);
    expect(res.body.memories.some((m: { summary: string }) => m.summary.includes('mangoes'))).toBe(
      true,
    );
  });

  it('records SUS responses and computes the mean', async () => {
    await request(app)
      .post(`/api/patients/${patientId}/sus`)
      .set(bearer(cg))
      .send({ respondentRole: 'caregiver', answers: [5, 1, 5, 1, 5, 1, 5, 1, 5, 1] })
      .expect(201);
    await request(app)
      .post(`/api/patients/${patientId}/sus`)
      .set(bearer(cg))
      .send({ respondentRole: 'family', answers: [3, 3, 3, 3, 3, 3, 3, 3, 3, 3] })
      .expect(201);
    const res = await request(app)
      .get(`/api/patients/${patientId}/sus`)
      .set(bearer(cg))
      .expect(200);
    expect(res.body.meanScore).toBe(75);
    expect(res.body.items).toHaveLength(10);
    await request(app)
      .post(`/api/patients/${patientId}/sus`)
      .set(bearer(cg))
      .send({ respondentRole: 'caregiver', answers: [6] })
      .expect(400);
  });

  it('retention removes old visits and recognition events only', async () => {
    await Patient.updateOne({ _id: patientId }, { $set: { 'settings.retentionDays': 30 } });
    const old = new Date(Date.now() - 40 * 86_400_000);
    await Visit.create({ patientId, personId: priyaId, timestamp: old });
    const recent = await Visit.create({ patientId, personId: priyaId });
    await RecognitionEvent.create({ patientId, outcome: 'unknown', timestamp: old });
    const memoriesBefore = await Memory.countDocuments({ patientId });

    const summary = await runRetention();
    expect(summary.visits).toBeGreaterThanOrEqual(1);
    expect(await Visit.exists({ _id: recent._id })).toBeTruthy();
    expect(
      await Visit.countDocuments({
        patientId,
        timestamp: { $lt: new Date(Date.now() - 31 * 86_400_000) },
      }),
    ).toBe(0);
    expect(
      await RecognitionEvent.countDocuments({
        patientId,
        timestamp: { $lt: new Date(Date.now() - 31 * 86_400_000) },
      }),
    ).toBe(0);
    expect(await Memory.countDocuments({ patientId })).toBe(memoriesBefore);
  });
});
