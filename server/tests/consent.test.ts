/**
 * Consent enforcement, revocation, encryption at rest, data deletion.
 */
import { mkdir, writeFile, access } from 'fs/promises';
import path from 'path';
import mongoose from 'mongoose';
import request from 'supertest';
import { env } from '../src/config/env';
import { encryptText } from '../src/lib/crypto';
import { AuditLog } from '../src/models/auditLog.model';
import { Note } from '../src/models/note.model';
import { Person } from '../src/models/person.model';
import { User } from '../src/models/user.model';
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

let token: string;
let patientId: string;
const peopleUrl = () => `/api/patients/${patientId}/people`;

beforeAll(async () => {
  token = (await registerAndLogin()).token;
  patientId = await createPatient(token);
});

describe('mandatory consent when adding a person', () => {
  const base = { name: 'Arjun', relationship: 'grandson' };

  it('rejects a person without consent', async () => {
    await request(app).post(peopleUrl()).set(bearer(token)).send(base).expect(400);
  });

  it('rejects an unticked consent checkbox', async () => {
    await request(app)
      .post(peopleUrl())
      .set(bearer(token))
      .send({ ...base, consent: { ...validConsent, given: false } })
      .expect(400);
  });

  it('requires a reason when a caregiver consents on the person’s behalf', async () => {
    const res = await request(app)
      .post(peopleUrl())
      .set(bearer(token))
      .send({ ...base, consent: { ...validConsent, givenByRole: 'caregiver' } })
      .expect(400);
    expect(res.body.error.details[0].path).toBe('consent.reason');
    await request(app)
      .post(peopleUrl())
      .set(bearer(token))
      .send({
        ...base,
        consent: {
          ...validConsent,
          givenByRole: 'caregiver',
          reason: 'Person is a minor; parent consented',
        },
      })
      .expect(201);
  });

  it('rejects a consent date in the future', async () => {
    await request(app)
      .post(peopleUrl())
      .set(bearer(token))
      .send({
        ...base,
        consent: { ...validConsent, givenAt: new Date(Date.now() + 86400000).toISOString() },
      })
      .expect(400);
  });

  it('records consent (who, role, date, scope) and audits it', async () => {
    const res = await request(app)
      .post(peopleUrl())
      .set(bearer(token))
      .send({
        ...base,
        consent: { ...validConsent, givenBy: 'Arjun', scope: ['recognition', 'visit-history'] },
      })
      .expect(201);
    expect(res.body.person.consent).toMatchObject({
      given: true,
      givenBy: 'Arjun',
      givenByRole: 'person',
    });
    expect(res.body.person.consent.givenAt).toBeTruthy();
    expect(res.body.person.hasActiveConsent).toBe(true);
    expect(
      await AuditLog.exists({ action: 'consent.grant', entityId: res.body.person.id }),
    ).toBeTruthy();
  });
});

describe('face enrollment is blocked without consent', () => {
  it('blocks enrollment once consent is revoked', async () => {
    const personId = await createPerson(token, patientId, 'Kiran');
    await request(app)
      .post(`${peopleUrl()}/${personId}/consent/revoke`)
      .set(bearer(token))
      .send({})
      .expect(200);
    const res = await request(app)
      .post(`${peopleUrl()}/${personId}/photos`)
      .set(bearer(token))
      .expect(403);
    expect(res.body.error.code).toBe('CONSENT_REQUIRED');
    expect(
      await AuditLog.exists({ action: 'enroll.blocked_no_consent', entityId: personId }),
    ).toBeTruthy();
  });
});

describe('revoking consent', () => {
  it('deletes embeddings + photo files, deactivates the person, and writes an audit entry', async () => {
    const personId = await createPerson(token, patientId, 'Priya');

    // Simulate Phase-2 enrollment data directly in the DB + an encrypted file on disk.
    const key = `${patientId}/${personId}/face1.enc`;
    const file = path.resolve(env.UPLOAD_DIR, key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'encrypted-bytes');
    await Person.updateOne(
      { _id: personId },
      {
        $set: {
          embeddings: [{ enc: encryptText('[0.1,0.2]') }],
          photos: [{ storageKey: key, mimeType: 'image/jpeg' }],
        },
      },
    );

    const before = await request(app)
      .get(`${peopleUrl()}/${personId}`)
      .set(bearer(token))
      .expect(200);
    expect(before.body.person).toMatchObject({ photoCount: 1, enrolledFaceCount: 1 });
    // Embeddings are never exposed by the API.
    expect(before.body.person.embeddings).toBeUndefined();

    const res = await request(app)
      .post(`${peopleUrl()}/${personId}/consent/revoke`)
      .set(bearer(token))
      .send({})
      .expect(200);
    expect(res.body.person).toMatchObject({
      isActive: false,
      hasActiveConsent: false,
      photoCount: 0,
      enrolledFaceCount: 0,
    });
    expect(res.body.person.consent.revokedAt).toBeTruthy();

    const raw = await Person.findById(personId).lean();
    expect(raw!.embeddings).toHaveLength(0);
    expect(raw!.photos).toHaveLength(0);
    await expect(access(file)).rejects.toThrow();
    expect(await AuditLog.exists({ action: 'consent.revoke', entityId: personId })).toBeTruthy();

    // Revoking again is a harmless no-op.
    await request(app)
      .post(`${peopleUrl()}/${personId}/consent/revoke`)
      .set(bearer(token))
      .send({})
      .expect(200);

    // Consent can be recorded again, but not twice.
    await request(app)
      .post(`${peopleUrl()}/${personId}/consent`)
      .set(bearer(token))
      .send(validConsent)
      .expect(200);
    await request(app)
      .post(`${peopleUrl()}/${personId}/consent`)
      .set(bearer(token))
      .send(validConsent)
      .expect(409);
  });

  it('cannot change consent through the generic update route', async () => {
    const personId = await createPerson(token, patientId, 'Dev');
    await request(app)
      .patch(`${peopleUrl()}/${personId}`)
      .set(bearer(token))
      .send({ consent: { given: false } })
      .expect(400);
  });
});

describe('encryption at rest & injection protection', () => {
  it('stores note text encrypted, returns it decrypted', async () => {
    const res = await request(app)
      .post(`/api/patients/${patientId}/notes`)
      .set(bearer(token))
      .send({ text: 'Priya likes jasmine flowers' })
      .expect(201);
    expect(res.body.note.text).toBe('Priya likes jasmine flowers');
    const raw = await Note.findById(res.body.note.id).lean();
    expect(raw!.textEnc).not.toContain('jasmine');
    expect(JSON.stringify(raw)).not.toContain('jasmine');
  });

  it('rejects NoSQL operator injection in login', async () => {
    await request(app)
      .post('/api/auth/login')
      .send({ email: { $gt: '' }, password: { $gt: '' } })
      .expect(400);
  });

  it('audit log API never contains note text or secrets', async () => {
    const res = await request(app)
      .get(`/api/patients/${patientId}/audit-logs?limit=200`)
      .set(bearer(token))
      .expect(200);
    expect(res.body.logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toMatch(/jasmine|password|token/i);
  });
});

describe('delete all patient data', () => {
  it('requires explicit confirmation, then removes everything', async () => {
    const pid = await createPatient(token, 'Temp');
    await createPerson(token, pid, 'Sam');
    const { token: pToken } = await pairPatient(token, pid);
    await request(app)
      .post(`/api/patients/${pid}/notes`)
      .set(bearer(pToken))
      .send({ text: 'note' })
      .expect(201);

    await request(app).delete(`/api/patients/${pid}`).set(bearer(token)).send({}).expect(400);
    await request(app)
      .delete(`/api/patients/${pid}`)
      .set(bearer(token))
      .send({ confirm: 'DELETE' })
      .expect(204);

    const oid = new mongoose.Types.ObjectId(pid);
    expect(await Person.countDocuments({ patientId: oid })).toBe(0);
    expect(await Note.countDocuments({ patientId: oid })).toBe(0);
    expect(await User.countDocuments({ role: 'patient', patientIds: oid })).toBe(0);
    // The paired device is signed out immediately.
    await request(app).get('/api/patients/me').set(bearer(pToken)).expect(401);
    expect(
      await AuditLog.exists({ action: 'patient.delete_all_data', patientId: oid }),
    ).toBeTruthy();
  });
});
