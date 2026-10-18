/**
 * Role-based access control + ownership.
 * Spec requirement: a patient token is rejected on every caregiver-only route
 * (people, consent, settings, audit log, ...).
 */
import request from 'supertest';
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

useTestDb();

let cg: { token: string; userId: string };
let otherCg: { token: string };
let patientId: string;
let personId: string;
let patientToken: string;

beforeAll(async () => {
  cg = await registerAndLogin('Owner');
  otherCg = await registerAndLogin('Stranger');
  patientId = await createPatient(cg.token);
  personId = await createPerson(cg.token, patientId);
  patientToken = (await pairPatient(cg.token, patientId)).token;
});

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
const call = (method: Method, url: string) => request(app)[method](url);
const caregiverOnlyRoutes = (): Array<[Method, string, object?]> => [
  ['get', '/api/patients'],
  ['post', '/api/patients', { name: 'X' }],
  ['get', `/api/patients/${patientId}`],
  ['patch', `/api/patients/${patientId}`, { name: 'Y' }],
  ['delete', `/api/patients/${patientId}`, { confirm: 'DELETE' }],
  ['post', `/api/patients/${patientId}/pairing-code`],
  ['post', `/api/patients/${patientId}/revoke-devices`],
  ['post', `/api/patients/${patientId}/device-session`],
  ['put', `/api/patients/${patientId}/pin`, { pin: '4826' }],
  ['delete', `/api/patients/${patientId}/pin`],
  ['get', '/api/system/status'],
  ['post', '/api/system/ai-test'],
  ['get', `/api/patients/${patientId}/settings`],
  ['patch', `/api/patients/${patientId}/settings`, { retentionDays: 30 }],
  ['get', `/api/patients/${patientId}/audit-logs`],
  ['get', `/api/patients/${patientId}/people`],
  [
    'post',
    `/api/patients/${patientId}/people`,
    { name: 'Z', relationship: 'friend', consent: validConsent },
  ],
  ['get', `/api/patients/${patientId}/people/${personId}`],
  ['patch', `/api/patients/${patientId}/people/${personId}`, { notes: 'x' }],
  ['delete', `/api/patients/${patientId}/people/${personId}`],
  ['post', `/api/patients/${patientId}/people/${personId}/consent`, validConsent],
  ['post', `/api/patients/${patientId}/people/${personId}/consent/revoke`, {}],
  ['post', `/api/patients/${patientId}/people/${personId}/photos`],
  ['delete', `/api/patients/${patientId}/people/${personId}/photos`],
  ['get', `/api/patients/${patientId}/visits`],
  ['post', `/api/patients/${patientId}/visits`, { personId }],
  ['get', `/api/patients/${patientId}/overview`],
  ['get', `/api/patients/${patientId}/export`],
  ['get', `/api/patients/${patientId}/help-requests`],
  ['get', `/api/patients/${patientId}/evaluation/summary`],
  ['get', `/api/patients/${patientId}/evaluation/events.csv`],
  ['get', `/api/patients/${patientId}/sus`],
  [
    'post',
    `/api/patients/${patientId}/sus`,
    { respondentRole: 'caregiver', answers: [3, 3, 3, 3, 3, 3, 3, 3, 3, 3] },
  ],
  ['get', `/api/patients/${patientId}/memories/review-queue`],
  ['post', `/api/patients/${patientId}/memories/draft`, { personId, notes: 'abc' }],
];

describe('patient token on caregiver-only routes', () => {
  it('is rejected with 403 on every caregiver-only route', async () => {
    for (const [method, url, body] of caregiverOnlyRoutes()) {
      const res = await call(method, url)
        .set(bearer(patientToken))
        .send(body ?? {});
      expect({ method, url, status: res.status }).toEqual({ method, url, status: 403 });
    }
  });

  it('no token -> 401 on every caregiver-only route', async () => {
    for (const [method, url, body] of caregiverOnlyRoutes()) {
      const res = await call(method, url).send(body ?? {});
      expect({ method, url, status: res.status }).toEqual({ method, url, status: 401 });
    }
  });

  it('the data is untouched afterwards (person and consent still active)', async () => {
    const res = await request(app)
      .get(`/api/patients/${patientId}/people/${personId}`)
      .set(bearer(cg.token))
      .expect(200);
    expect(res.body.person.hasActiveConsent).toBe(true);
  });
});

describe('ownership: caregivers only see their own patients', () => {
  it("another caregiver gets 404 on every route of someone else's patient", async () => {
    for (const [method, url, body] of caregiverOnlyRoutes()) {
      // Collection routes are scoped (tested below); /api/system is not patient data.
      if (url === '/api/patients' || url.startsWith('/api/system')) continue;
      const res = await call(method, url)
        .set(bearer(otherCg.token))
        .send(body ?? {});
      expect({ method, url, status: res.status }).toEqual({ method, url, status: 404 });
    }
  });

  it('patient list is scoped to the caregiver', async () => {
    const mine = await request(app).get('/api/patients').set(bearer(cg.token)).expect(200);
    const theirs = await request(app).get('/api/patients').set(bearer(otherCg.token)).expect(200);
    expect(mine.body.patients.map((p: { id: string }) => p.id)).toContain(patientId);
    expect(theirs.body.patients).toHaveLength(0);
  });

  it('invalid ids are 404, not 500', async () => {
    await request(app).get('/api/patients/not-an-id').set(bearer(cg.token)).expect(404);
    await request(app)
      .get(`/api/patients/${patientId}/people/xyz`)
      .set(bearer(cg.token))
      .expect(404);
  });
});

describe('patient-only routes', () => {
  it('caregiver token cannot use /patients/me', async () => {
    await request(app).get('/api/patients/me').set(bearer(cg.token)).expect(403);
  });
});

describe('notes: patient can only write/edit/delete their own entries', () => {
  let caregiverNoteId: string;
  let patientNoteId: string;

  beforeAll(async () => {
    const c = await request(app)
      .post(`/api/patients/${patientId}/notes`)
      .set(bearer(cg.token))
      .send({ text: 'Doctor visit on Friday', kind: 'reminder' })
      .expect(201);
    caregiverNoteId = c.body.note.id;
    const p = await request(app)
      .post(`/api/patients/${patientId}/notes`)
      .set(bearer(patientToken))
      .send({ text: 'Priya brought mangoes', personId })
      .expect(201);
    patientNoteId = p.body.note.id;
    expect(p.body.note.mine).toBe(true);
  });

  it('patient lists only their own notes; caregiver sees all', async () => {
    const pl = await request(app)
      .get(`/api/patients/${patientId}/notes`)
      .set(bearer(patientToken))
      .expect(200);
    expect(pl.body.notes.map((n: { id: string }) => n.id)).toEqual([patientNoteId]);
    const cl = await request(app)
      .get(`/api/patients/${patientId}/notes`)
      .set(bearer(cg.token))
      .expect(200);
    expect(cl.body.notes).toHaveLength(2);
  });

  it('patient cannot edit or delete a caregiver-authored note', async () => {
    await request(app)
      .patch(`/api/patients/${patientId}/notes/${caregiverNoteId}`)
      .set(bearer(patientToken))
      .send({ text: 'changed' })
      .expect(403);
    await request(app)
      .delete(`/api/patients/${patientId}/notes/${caregiverNoteId}`)
      .set(bearer(patientToken))
      .expect(403);
  });

  it('patient can edit and delete their own note', async () => {
    const res = await request(app)
      .patch(`/api/patients/${patientId}/notes/${patientNoteId}`)
      .set(bearer(patientToken))
      .send({ text: 'Priya brought mangoes and jasmine', completed: true })
      .expect(200);
    expect(res.body.note.text).toBe('Priya brought mangoes and jasmine');
    await request(app)
      .delete(`/api/patients/${patientId}/notes/${patientNoteId}`)
      .set(bearer(patientToken))
      .expect(204);
  });

  it("a patient cannot reach another patient's notes", async () => {
    const otherPatient = await createPatient(cg.token, 'Lakshmi');
    await request(app)
      .get(`/api/patients/${otherPatient}/notes`)
      .set(bearer(patientToken))
      .expect(404);
    await request(app)
      .post(`/api/patients/${otherPatient}/notes`)
      .set(bearer(patientToken))
      .send({ text: 'hi' })
      .expect(404);
  });
});
