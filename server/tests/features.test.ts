/**
 * Newer features: per-role sessions, patient PIN, one-tap device setup,
 * planned visits, the person "story", "Tell me simply", question summaries,
 * the people directory and the caregiver system-status card.
 */
import request from 'supertest';
import { __resetLlmRateLimits } from '../src/services/llm.service';
import { __clearSummaryCache } from '../src/services/summary.service';
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

const cookiesOf = (res: request.Response) =>
  ((res.headers['set-cookie'] as unknown as string[]) ?? []).map((c) => c.split(';')[0]);

beforeAll(async () => {
  mocks = await startMocks();
  cg = (await registerAndLogin()).token;
  patientId = await createPatient(cg);
  pt = (await pairPatient(cg, patientId)).token;
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
afterAll(async () => mocks.close());
beforeEach(() => {
  mocks.llmRequests = [];
  mocks.llmReply = () => 'This is Priya, your daughter.';
  __resetLlmRateLimits();
  __clearSummaryCache();
});

describe('sessions', () => {
  it('caregiver and patient use separate cookies, so one never signs the other out', async () => {
    const cgLogin = await registerAndLogin('Dual');
    const p = await createPatient(cgLogin.token, 'Dual patient');
    const code = await request(app)
      .post(`/api/patients/${p}/pairing-code`)
      .set(bearer(cgLogin.token))
      .expect(201);
    const pair = await request(app)
      .post('/api/auth/pair')
      .send({ code: code.body.code })
      .expect(200);
    const patientCookie = cookiesOf(pair).find((c) => c.startsWith('dma_rt_patient='))!;
    expect(patientCookie).toBeTruthy();
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: cgLogin.email, password: 'CorrectHorse9' })
      .expect(200);
    const caregiverCookie = cookiesOf(login).find((c) => c.startsWith('dma_rt_caregiver='))!;
    const both = [patientCookie, caregiverCookie].join('; ');
    const asPatient = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', both)
      .send({ role: 'patient' })
      .expect(200);
    expect(asPatient.body.user.role).toBe('patient');
    const asCaregiver = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', both)
      .send({ role: 'caregiver' })
      .expect(200);
    expect(asCaregiver.body.user.role).toBe('caregiver');
  });
});

describe('patient PIN', () => {
  it('caregiver sets a PIN; the device signs in with it; wrong PINs lock it for a while', async () => {
    await request(app)
      .put(`/api/patients/${patientId}/pin`)
      .set(bearer(cg))
      .send({ pin: '1234' })
      .expect(400); // too simple
    await request(app)
      .put(`/api/patients/${patientId}/pin`)
      .set(bearer(pt))
      .send({ pin: '4826' })
      .expect(403);
    await request(app)
      .put(`/api/patients/${patientId}/pin`)
      .set(bearer(cg))
      .send({ pin: '4826' })
      .expect(200);
    const status = await request(app).post('/api/auth/pin-status').send({ patientId }).expect(200);
    expect(status.body.pinEnabled).toBe(true);

    const ok = await request(app)
      .post('/api/auth/pin')
      .send({ patientId, pin: '4826' })
      .expect(200);
    expect(ok.body.user.role).toBe('patient');
    expect(JSON.stringify(ok.body)).not.toContain('hash');

    for (let i = 0; i < 5; i++)
      await request(app).post('/api/auth/pin').send({ patientId, pin: '0000' }).expect(401);
    // Locked now, even with the right PIN.
    await request(app).post('/api/auth/pin').send({ patientId, pin: '4826' }).expect(423);
  });
});

describe('one-tap device setup', () => {
  it('switches this browser to patient mode and ends the caregiver session here', async () => {
    const c = await registerAndLogin('Tap');
    const p = await createPatient(c.token, 'Tap patient');
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: c.email, password: 'CorrectHorse9' })
      .expect(200);
    const caregiverCookie = cookiesOf(login).find((x) => x.startsWith('dma_rt_caregiver='))!;
    const res = await request(app)
      .post(`/api/patients/${p}/device-session`)
      .set(bearer(login.body.accessToken))
      .set('Cookie', caregiverCookie)
      .expect(200);
    expect(res.body.user.role).toBe('patient');
    const set = (res.headers['set-cookie'] as unknown as string[]).join('\n');
    expect(set).toMatch(/dma_rt_patient=[^;]+/);
    expect(set).toMatch(/dma_rt_caregiver=;/); // cleared
    await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', caregiverCookie)
      .send({ role: 'caregiver' })
      .expect(401);
  });
});

describe('planned visits', () => {
  const url = (p = '') => `/api/patients/${patientId}/schedule${p}`;
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

  it('both roles can plan; the patient can only change visits they added', async () => {
    const byCg = await request(app)
      .post(url())
      .set(bearer(cg))
      .send({ personId: priyaId, startsAt: inHours(26), note: 'Bringing lunch' })
      .expect(201);
    expect(byCg.body.visit).toMatchObject({
      who: 'Priya',
      relationship: 'daughter',
      note: 'Bringing lunch',
    });
    const byPt = await request(app)
      .post(url())
      .set(bearer(pt))
      .send({ visitorName: 'Nurse Meera', startsAt: inHours(3) })
      .expect(201);
    expect(byPt.body.visit.mine).toBe(true);

    const list = await request(app).get(url()).set(bearer(pt)).expect(200);
    expect(list.body.visits.map((v: { who: string }) => v.who)).toEqual(['Nurse Meera', 'Priya']);

    await request(app)
      .patch(url(`/${byCg.body.visit.id}`))
      .set(bearer(pt))
      .send({ startsAt: inHours(30) })
      .expect(403);
    await request(app)
      .patch(url(`/${byCg.body.visit.id}`))
      .set(bearer(pt))
      .send({ status: 'done' })
      .expect(200);
    await request(app)
      .delete(url(`/${byPt.body.visit.id}`))
      .set(bearer(pt))
      .expect(204);
    await request(app)
      .post(url())
      .set(bearer(pt))
      .send({ startsAt: inHours(2) })
      .expect(400);
  });

  it('"When is Priya coming?" is answered from the plan', async () => {
    await request(app)
      .post(url())
      .set(bearer(cg))
      .send({ personId: priyaId, startsAt: inHours(48) })
      .expect(201);
    const res = await request(app)
      .post(`/api/patients/${patientId}/ask`)
      .set(bearer(pt))
      .send({ question: 'When is Priya coming?' })
      .expect(200);
    expect(res.body.answer).toMatch(/^Priya is coming (tomorrow|on .+) at /);
    expect(res.body.personId).toBe(priyaId);
  });
});

describe('person story and "Tell me simply"', () => {
  let approvedId: string;
  let pendingId: string;

  beforeAll(async () => {
    approvedId = (
      await request(app)
        .post(`/api/patients/${patientId}/memories`)
        .set(bearer(cg))
        .send({ personId: priyaId, summary: 'Priya brought mangoes and played cards.' })
        .expect(201)
    ).body.memory.id;
    pendingId = (
      await request(app)
        .post(`/api/patients/${patientId}/memories`)
        .set(bearer(pt))
        .send({ personId: priyaId, summary: 'PATIENT-OWN-TEXT' })
        .expect(201)
    ).body.memory.id;
  });

  it('memories say who they are about', async () => {
    const res = await request(app)
      .get(`/api/patients/${patientId}/memories`)
      .set(bearer(pt))
      .expect(200);
    expect(res.body.memories[0]).toMatchObject({ personName: 'Priya', relationship: 'daughter' });
  });

  it('the story shows approved memories and the patient’s own entries', async () => {
    const res = await request(app)
      .get(`/api/patients/${patientId}/story/${priyaId}`)
      .set(bearer(pt))
      .expect(200);
    expect(res.body.person).toMatchObject({ name: 'Priya', relationship: 'daughter' });
    const byId = Object.fromEntries(
      res.body.memories.map((m: { id: string }) => [m.id, m]),
    ) as Record<string, { canRetell: boolean; reviewStatus: string }>;
    expect(byId[approvedId].canRetell).toBe(true);
    expect(byId[pendingId]).toMatchObject({ canRetell: false, reviewStatus: 'pending' });
  });

  it('retells approved memories with the AI, never pending ones', async () => {
    mocks.llmReply = () =>
      'Priya, your daughter, brought you mangoes and you played cards together.';
    const ok = await request(app)
      .post(`/api/patients/${patientId}/memories/${approvedId}/retell`)
      .set(bearer(pt))
      .expect(200);
    expect(ok.body.source).toBe('llm');
    expect(ok.body.text).toContain('mangoes');

    const before = mocks.llmRequests.length;
    const pending = await request(app)
      .post(`/api/patients/${patientId}/memories/${pendingId}/retell`)
      .set(bearer(pt))
      .expect(200);
    expect(pending.body).toMatchObject({ source: 'original', text: 'PATIENT-OWN-TEXT' });
    expect(mocks.llmRequests.length).toBe(before);
    expect(JSON.stringify(mocks.llmRequests)).not.toContain('PATIENT-OWN-TEXT');
  });

  it('a retelling that invents details falls back to the original text', async () => {
    mocks.llmReply = () => 'Priya took you to Goa for a holiday.';
    __clearSummaryCache();
    const res = await request(app)
      .post(`/api/patients/${patientId}/memories/${approvedId}/retell`)
      .set(bearer(pt))
      .expect(200);
    expect(res.body).toMatchObject({
      source: 'fallback',
      text: 'Priya brought mangoes and played cards.',
    });
  });

  it('a question about a person returns the answer and an AI summary', async () => {
    mocks.llmReply = () => 'This is Priya, your daughter. She brought mangoes and played cards.';
    const res = await request(app)
      .post(`/api/patients/${patientId}/ask`)
      .set(bearer(pt))
      .send({ question: 'Who is Priya?' })
      .expect(200);
    expect(res.body.answer).toBe('Priya is your daughter.');
    expect(res.body.summarySource).toBe('llm');
    expect(res.body.summary).toContain('mangoes');
  });

  it('a memory question is answered from that person’s memories', async () => {
    mocks.llmReply = () => 'Priya brought you mangoes and you played cards together.';
    __clearSummaryCache();
    const res = await request(app)
      .post(`/api/patients/${patientId}/ask`)
      .set(bearer(pt))
      .send({ question: 'What did Priya bring?' })
      .expect(200);
    expect(res.body.found).toBe(true);
    expect(res.body.answer).toMatch(
      /^Here is a memory about Priya, from .+: Priya brought mangoes/,
    );
    expect(res.body.summary).toContain('mangoes');
    // Related memories are listed; the patient also sees their own (pending) entry.
    const ids = res.body.memories.map((m: { id: string }) => m.id);
    expect(ids).toEqual(expect.arrayContaining([approvedId, pendingId]));
    expect(res.body.memories.find((m: { id: string }) => m.id === pendingId)).toMatchObject({
      reviewStatus: 'pending',
      canRetell: false,
      mine: true,
    });
    // ...but only approved memories are ever sent to the AI.
    expect(JSON.stringify(mocks.llmRequests)).not.toContain('PATIENT-OWN-TEXT');
  });

  it('"When did I meet Priya?" uses the memories when no visit is saved', async () => {
    mocks.llmReply = () => 'Priya visited and brought mangoes, and you played cards.';
    __clearSummaryCache();
    const res = await request(app)
      .post(`/api/patients/${patientId}/ask`)
      .set(bearer(pt))
      .send({ question: 'When did I meet Priya?' })
      .expect(200);
    expect(res.body.found).toBe(true);
    expect(res.body.answer).toMatch(/^The last memory about Priya was saved on /);
    expect(res.body.memories.length).toBeGreaterThan(0);
  });

  it('an AI answer that invents details is dropped; the database answer stays', async () => {
    mocks.llmReply = () => 'Priya took you to Goa for a holiday.';
    __clearSummaryCache();
    const res = await request(app)
      .post(`/api/patients/${patientId}/ask`)
      .set(bearer(pt))
      .send({ question: 'What did Priya bring?' })
      .expect(200);
    expect(res.body.answer).toMatch(/mangoes/);
    expect(res.body.summary ?? '').not.toContain('Goa');
  });
});

describe('directory and system status', () => {
  it('the patient can list people by first name only', async () => {
    const res = await request(app)
      .get(`/api/patients/${patientId}/people-directory`)
      .set(bearer(pt))
      .expect(200);
    expect(res.body.people).toEqual([
      { id: priyaId, name: 'Priya', relationship: 'daughter', hasPhoto: false },
    ]);
  });

  it('system status is caregiver-only and never shows the key', async () => {
    await request(app).get('/api/system/status').set(bearer(pt)).expect(403);
    const res = await request(app).get('/api/system/status').set(bearer(cg)).expect(200);
    expect(res.body.ai).toMatchObject({ configured: true, enabled: true });
    expect(JSON.stringify(res.body)).not.toContain('test-groq-key');
    mocks.llmReply = () => 'Hello, I am working.';
    const test = await request(app).post('/api/system/ai-test').set(bearer(cg)).expect(200);
    expect(test.body).toMatchObject({ ok: true, reply: 'Hello, I am working.' });
    mocks.llmReply = () => 'ERROR';
    const bad = await request(app).post('/api/system/ai-test').set(bearer(cg)).expect(200);
    expect(bad.body).toMatchObject({ ok: false, reason: 'error' });
  });
});
