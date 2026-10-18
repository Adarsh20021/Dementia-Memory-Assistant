/**
 * Shared test helpers: per-file database and common API flows.
 */
import { randomBytes } from 'crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../src/app';

export const app = createApp();

export function useTestDb() {
  beforeAll(async () => {
    const uri = process.env.TEST_MONGO_URI;
    if (!uri) throw new Error('TEST_MONGO_URI not set (globalSetup failed?)');
    await mongoose.connect(uri, { dbName: `dma_test_${randomBytes(4).toString('hex')}` });
    // Build indexes (unique constraints matter for tests). Some MongoDB-compatible
    // test servers lack TTL indexes; that one gap is tolerated, nothing else.
    for (const model of Object.values(mongoose.models)) {
      try {
        await model.syncIndexes();
      } catch (err) {
        if (!/expireAfterSeconds/.test(String(err))) throw err;
      }
    }
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
}

export const PASSWORD = 'CorrectHorse9';

let counter = 0;
export async function registerAndLogin(name = 'Carol') {
  const email = `${name.toLowerCase()}${++counter}@example.com`;
  await request(app)
    .post('/api/auth/register')
    .send({ name, email, password: PASSWORD })
    .expect(201);
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return { token: res.body.accessToken as string, userId: res.body.user.id as string, email };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export async function createPatient(token: string, name = 'Ravi') {
  const res = await request(app)
    .post('/api/patients')
    .set(bearer(token))
    .send({ name })
    .expect(201);
  return res.body.patient.id as string;
}

/** Issues a pairing code as the caregiver and redeems it as the patient's device. */
export async function pairPatient(caregiverToken: string, patientId: string) {
  const codeRes = await request(app)
    .post(`/api/patients/${patientId}/pairing-code`)
    .set(bearer(caregiverToken))
    .expect(201);
  const res = await request(app)
    .post('/api/auth/pair')
    .send({ code: codeRes.body.code })
    .expect(200);
  return { token: res.body.accessToken as string, userId: res.body.user.id as string };
}

export const validConsent = {
  given: true,
  givenBy: 'Priya',
  givenByRole: 'person',
  scope: ['recognition'],
};

export async function createPerson(token: string, patientId: string, name = 'Priya') {
  const res = await request(app)
    .post(`/api/patients/${patientId}/people`)
    .set(bearer(token))
    .send({ name, relationship: 'daughter', consent: { ...validConsent, givenBy: name } })
    .expect(201);
  return res.body.person.id as string;
}
