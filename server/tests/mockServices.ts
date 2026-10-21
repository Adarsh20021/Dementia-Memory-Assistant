/**
 * In-process HTTP mocks for the face service and the Groq API.
 *
 * Test "images" are tiny buffers that start with real JPEG magic bytes followed
 * by a text marker the mock face service reads:
 *   enrollment:  "GOOD"  | "BLURRY" | "NOFACE"
 *   frames:      "FACE:<personId>:<score>:<yaw>"  | "NOFACE"
 */
import http from 'http';

export const jpeg = (marker: string) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(marker)]);

export const frame = (personId: string, score: number, yaw: number) =>
  jpeg(`FACE:${personId}:${score}:${yaw}`);

/** 5 frames of the same person with natural head movement. */
export const liveFrames = (personId: string, score: number, n = 5) =>
  Array.from({ length: n }, (_, i) => frame(personId, score, -0.1 + i * 0.05));

const marker = (b64: string) => Buffer.from(b64, 'base64').subarray(4).toString();
const vec = (seed: number) => {
  const f = new Float32Array(512).fill(0);
  f[seed % 512] = 1;
  return Buffer.from(f.buffer).toString('base64');
};

type Json = Record<string, unknown>;

export interface Mocks {
  faceUp: boolean;
  /** Override the LLM reply. Return text, or 'TIMEOUT' to hang, or 'ERROR' for a 500. */
  llmReply: (body: Json) => string;
  lastAnalyze?: Json;
  llmRequests: Json[];
  /** Override the transcription reply: text, or 'ERROR' for a 500. */
  sttReply: () => string;
  sttRequests: { model?: string; language?: string; bytes: number }[];
  close: () => Promise<void>;
}

export async function startMocks(port = 45999): Promise<Mocks> {
  let counter = 0;
  const mocks: Mocks = {
    faceUp: true,
    llmReply: () => 'This is Priya, your daughter. She visited you recently.',
    llmRequests: [],
    sttReply: () => 'When is Priya coming',
    sttRequests: [],
    close: async () => undefined,
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url === '/groq/audio/transcriptions') {
        if (req.headers.authorization !== 'Bearer test-groq-key') {
          res.writeHead(401);
          return res.end();
        }
        const field = (n: string) => raw.match(new RegExp(`name="${n}"\\r\\n\\r\\n([^\\r]*)`))?.[1];
        mocks.sttRequests.push({ model: field('model'), language: field('language'), bytes: raw.length });
        const reply = mocks.sttReply();
        if (reply === 'MODEL_BLOCKED') {
          res.writeHead(403, { 'content-type': 'application/json' });
          return res.end(
            JSON.stringify({ error: { message: 'The model `whisper-large-v3-turbo` is blocked at the organization level.' } }),
          );
        }
        res.writeHead(reply === 'ERROR' ? 500 : 200, { 'content-type': 'application/json' });
        return res.end(reply === 'ERROR' ? '{}' : JSON.stringify({ text: ` ${reply} ` }));
      }
      const body = raw ? (JSON.parse(raw) as Json) : {};
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };

      if (req.url?.startsWith('/groq/')) {
        if (req.headers.authorization !== 'Bearer test-groq-key') return send(401, {});
        mocks.llmRequests.push(body);
        const reply = mocks.llmReply(body);
        if (reply === 'TIMEOUT') return; // never answer
        if (reply === 'ERROR') return send(500, {});
        return send(200, {
          choices: [{ message: { content: reply } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
      }

      if (!mocks.faceUp) return send(503, {});
      if (req.headers['x-face-secret'] !== 'test-face-secret-123456') return send(401, {});

      if (req.url === '/v1/embed') {
        const m = marker(body.image as string);
        if (m.startsWith('BLURRY'))
          return send(200, {
            ok: false,
            code: 'too_blurry',
            message: 'The photo is blurry.',
            metrics: {},
            ms: 1,
          });
        if (m.startsWith('NOFACE'))
          return send(200, {
            ok: false,
            code: 'no_face',
            message: 'No face was found.',
            metrics: {},
            ms: 1,
          });
        return send(200, {
          ok: true,
          code: null,
          message: null,
          metrics: {},
          embedding: vec(++counter),
          ms: 1,
        });
      }

      if (req.url === '/v1/analyze') {
        mocks.lastAnalyze = body;
        const ids = new Set(((body.candidates as { id: string }[]) ?? []).map((c) => c.id));
        const frames = (body.frames as string[]).map((f) => {
          const m = marker(f);
          if (!m.startsWith('FACE:')) return { faceFound: false, faceCount: 0 };
          const [, id, score, yaw] = m.split(':');
          // Only candidates sent by Express can ever be matched.
          const best = ids.has(id) ? { id, score: Number(score) } : null;
          return {
            faceFound: true,
            faceCount: 1,
            faceSizePx: 120,
            yaw: Number(yaw),
            best,
            second: null,
          };
        });
        return send(200, { frames, ms: 5 });
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  mocks.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return mocks;
}
