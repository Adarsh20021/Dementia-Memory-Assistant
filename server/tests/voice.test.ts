/**
 * Voice typing: POST /api/patients/:patientId/transcribe
 * (recording in, text out — via the mocked Groq Whisper endpoint).
 */
import request from 'supertest';
import { __resetSttRateLimits } from '../src/services/stt.service';
import { app, bearer, createPatient, pairPatient, registerAndLogin, useTestDb } from './helpers';
import { startMocks, type Mocks } from './mockServices';

useTestDb();

let mocks: Mocks;
let cg: string;
let patientId: string;
let pt: string;

/** A minimal buffer with real WebM (EBML) magic bytes. */
const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200, 1)]);

beforeAll(async () => {
  mocks = await startMocks();
  cg = (await registerAndLogin()).token;
  patientId = await createPatient(cg);
  pt = (await pairPatient(cg, patientId)).token;
});
afterAll(async () => mocks.close());
beforeEach(() => {
  mocks.sttRequests = [];
  mocks.sttReply = () => 'When is Priya coming';
  __resetSttRateLimits();
});

const send = (token: string, buf: Buffer, type = 'audio/webm;codecs=opus', pid = patientId) =>
  request(app)
    .post(`/api/patients/${pid}/transcribe`)
    .set(bearer(token))
    .attach('audio', buf, { filename: 'speech.webm', contentType: type });

describe('voice typing', () => {
  it('turns a patient recording into text with the Whisper model and patient language', async () => {
    const res = await send(pt, webm).expect(200);
    expect(res.body).toEqual({ text: 'When is Priya coming' });
    expect(mocks.sttRequests).toHaveLength(1);
    expect(mocks.sttRequests[0].model).toBe('whisper-large-v3-turbo');
    expect(mocks.sttRequests[0].language).toBe('en');
  });

  it('works for the caregiver too (dictating notes)', async () => {
    await send(cg, webm).expect(200);
  });

  it('rejects files that are not real audio, whatever they claim to be', async () => {
    await send(pt, Buffer.from('this is not audio at all'), 'audio/webm').expect(415);
    await send(pt, webm, 'image/png').expect(415);
    expect(mocks.sttRequests).toHaveLength(0);
  });

  it('requires a recording', async () => {
    await request(app).post(`/api/patients/${patientId}/transcribe`).set(bearer(pt)).expect(400);
  });

  it('needs sign-in, and another caregivers patient is not found', async () => {
    await request(app).post(`/api/patients/${patientId}/transcribe`).expect(401);
    const other = (await registerAndLogin('Other')).token;
    const otherPatient = await createPatient(other, 'Someone');
    await send(cg, webm, 'audio/webm', otherPatient).expect(404);
  });

  it('answers kindly when transcription fails', async () => {
    mocks.sttReply = () => 'ERROR';
    const res = await send(pt, webm).expect(502);
    expect(res.body.error.code).toBe('VOICE_FAILED');
    expect(res.body.error.message).toMatch(/type instead/);
  });
});

describe('voice typing recovery', () => {
  beforeEach(() => {
    mocks.sttRequests = [];
    __resetSttRateLimits();
  });

  it('retries with whisper-large-v3 when the configured model is not allowed', async () => {
    mocks.sttReply = () => (mocks.sttRequests.length === 1 ? 'MODEL_BLOCKED' : 'Hello there');
    const res = await send(pt, webm).expect(200);
    expect(res.body.text).toBe('Hello there');
    expect(mocks.sttRequests.map((r) => r.model)).toEqual(['whisper-large-v3-turbo', 'whisper-large-v3']);
  });

  it('shows a short code and records the reason for the caregiver', async () => {
    mocks.sttReply = () => 'ERROR';
    const res = await send(pt, webm).expect(502);
    expect(res.body.error.message).toMatch(/\(groq-500\)/);
    const status = await request(app).get('/api/system/status').set(bearer(cg)).expect(200);
    expect(status.body.voice.lastCall).toMatchObject({ ok: false, httpStatus: 500 });
  });
});
