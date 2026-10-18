import request from 'supertest';
import { AuditLog } from '../src/models/auditLog.model';
import { User } from '../src/models/user.model';
import {
  PASSWORD,
  app,
  bearer,
  createPatient,
  pairPatient,
  registerAndLogin,
  useTestDb,
} from './helpers';

useTestDb();

const refreshCookie = (res: request.Response) =>
  ((res.headers['set-cookie'] as unknown as string[]) ?? []).find((c) => c.startsWith('dma_rt_'));

describe('registration', () => {
  it('rejects weak passwords with a clear message', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'A', email: 'weak@example.com', password: 'short' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('cannot self-assign a role (mass assignment blocked)', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'A', email: 'role@example.com', password: PASSWORD, role: 'patient' })
      .expect(400);
  });

  it('creates a caregiver and never returns the password hash', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Asha', email: 'Asha@Example.com', password: PASSWORD })
      .expect(201);
    expect(res.body.user).toMatchObject({ email: 'asha@example.com', role: 'caregiver' });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2/);
  });

  it('rejects duplicate email', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'Asha', email: 'asha@example.com', password: PASSWORD })
      .expect(409);
  });
});

describe('login, lockout, refresh, logout', () => {
  it('logs in, sets an httpOnly SameSite=Strict refresh cookie, and /me works', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'Bo', email: 'bo@example.com', password: PASSWORD });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'bo@example.com', password: PASSWORD })
      .expect(200);
    const cookie = refreshCookie(res)!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/auth/);
    const me = await request(app).get('/api/auth/me').set(bearer(res.body.accessToken)).expect(200);
    expect(me.body.user.role).toBe('caregiver');
  });

  it('gives the same error for unknown email and wrong password', async () => {
    const a = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: PASSWORD })
      .expect(401);
    const b = await request(app)
      .post('/api/auth/login')
      .send({ email: 'bo@example.com', password: 'Wrong12345' })
      .expect(401);
    expect(a.body.error).toEqual(b.body.error);
  });

  it('locks the account after repeated failures (LOGIN_MAX_FAILURES=3 in tests)', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'Lu', email: 'lu@example.com', password: PASSWORD });
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/api/auth/login')
        .send({ email: 'lu@example.com', password: 'Wrong12345' })
        .expect(401);
    }
    // Even the correct password is refused while locked.
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'lu@example.com', password: PASSWORD })
      .expect(423);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(await AuditLog.exists({ action: 'auth.account_locked' })).toBeTruthy();

    // After the lock expires, login works again and the counter resets.
    await User.updateOne(
      { email: 'lu@example.com' },
      { $set: { lockedUntil: new Date(Date.now() - 1000) } },
    );
    await request(app)
      .post('/api/auth/login')
      .send({ email: 'lu@example.com', password: PASSWORD })
      .expect(200);
  });

  it('rejects missing, malformed and tampered access tokens', async () => {
    await request(app).get('/api/auth/me').expect(401);
    await request(app).get('/api/auth/me').set('Authorization', 'Bearer not-a-jwt').expect(401);
    const { token } = await registerAndLogin('Tam');
    await request(app)
      .get('/api/auth/me')
      .set(bearer(token.slice(0, -2) + 'xx'))
      .expect(401);
  });

  it('rotates refresh tokens and detects reuse of an old one', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'bo@example.com', password: PASSWORD });
    const first = refreshCookie(login)!.split(';')[0];

    const r1 = await request(app).post('/api/auth/refresh').set('Cookie', first).expect(200);
    expect(r1.body.accessToken).toBeTruthy();
    const second = refreshCookie(r1)!.split(';')[0];
    expect(second).not.toBe(first);

    // Replaying the first (already rotated) token = theft signal.
    await request(app).post('/api/auth/refresh').set('Cookie', first).expect(401);
    // ...which also kills the legitimately rotated one.
    await request(app).post('/api/auth/refresh').set('Cookie', second).expect(401);
    expect(await AuditLog.exists({ action: 'auth.refresh_reuse_detected' })).toBeTruthy();
  });

  it('logout revokes the refresh token', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'bo@example.com', password: PASSWORD });
    const cookie = refreshCookie(login)!.split(';')[0];
    await request(app).post('/api/auth/logout').set('Cookie', cookie).expect(204);
    await request(app).post('/api/auth/refresh').set('Cookie', cookie).expect(401);
  });

  it('refresh without a cookie is 401', async () => {
    await request(app).post('/api/auth/refresh').expect(401);
  });
});

describe('patient device pairing', () => {
  it('pairs with a caregiver-issued code, once only', async () => {
    const cg = await registerAndLogin();
    const patientId = await createPatient(cg.token);
    const codeRes = await request(app)
      .post(`/api/patients/${patientId}/pairing-code`)
      .set(bearer(cg.token))
      .expect(201);
    expect(codeRes.body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    // Lowercase and without the dash also works (easier to type).
    const typed = codeRes.body.code.replace('-', '').toLowerCase();
    const pair = await request(app).post('/api/auth/pair').send({ code: typed }).expect(200);
    expect(pair.body.user.role).toBe('patient');
    expect(pair.body.patient.id).toBe(patientId);

    // Single use.
    await request(app).post('/api/auth/pair').send({ code: codeRes.body.code }).expect(400);

    const me = await request(app)
      .get('/api/patients/me')
      .set(bearer(pair.body.accessToken))
      .expect(200);
    expect(me.body.patient.name).toBe('Ravi');
  });

  it('rejects wrong codes with a friendly message', async () => {
    const res = await request(app).post('/api/auth/pair').send({ code: 'AAAA-BBBB' }).expect(400);
    expect(res.body.error.message).toMatch(/ask your caregiver/i);
  });

  it('issuing a new code invalidates the old unused one', async () => {
    const cg = await registerAndLogin();
    const patientId = await createPatient(cg.token);
    const a = await request(app)
      .post(`/api/patients/${patientId}/pairing-code`)
      .set(bearer(cg.token));
    await request(app).post(`/api/patients/${patientId}/pairing-code`).set(bearer(cg.token));
    await request(app).post('/api/auth/pair').send({ code: a.body.code }).expect(400);
  });

  it('caregiver can revoke all paired devices', async () => {
    const cg = await registerAndLogin();
    const patientId = await createPatient(cg.token);
    const codeRes = await request(app)
      .post(`/api/patients/${patientId}/pairing-code`)
      .set(bearer(cg.token));
    const pair = await request(app).post('/api/auth/pair').send({ code: codeRes.body.code });
    const cookie = refreshCookie(pair)!.split(';')[0];
    await request(app)
      .post(`/api/patients/${patientId}/revoke-devices`)
      .set(bearer(cg.token))
      .expect(204);
    await request(app).post('/api/auth/refresh').set('Cookie', cookie).expect(401);
  });

  it('patient can change only display preferences on their own record', async () => {
    const cg = await registerAndLogin();
    const patientId = await createPatient(cg.token);
    const { token } = await pairPatient(cg.token, patientId);
    const res = await request(app)
      .patch('/api/patients/me/preferences')
      .set(bearer(token))
      .send({ fontScale: 1.8, voiceRate: 0.8 })
      .expect(200);
    expect(res.body.patient.preferences).toMatchObject({ fontScale: 1.8, voiceRate: 0.8 });
    await request(app)
      .patch('/api/patients/me/preferences')
      .set(bearer(token))
      .send({ language: 'hi' })
      .expect(400);
  });
});
