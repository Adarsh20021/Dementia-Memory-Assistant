/**
 * HTTP client for the internal face service. All calls carry the shared
 * secret header and a timeout. Images are sent as base64 in memory and are
 * never persisted by either side (enrollment photos are stored encrypted by
 * Express itself; recognition frames are discarded).
 */
import { env } from '../config/env';
import { HttpError } from '../lib/http';
import { logger } from '../lib/logger';

export interface EmbedResult {
  ok: boolean;
  code: string | null;
  message: string | null;
  metrics: Record<string, number>;
  /** base64 float32[512], only when ok */
  embedding?: string;
  ms: number;
}

export interface FrameAnalysis {
  faceFound: boolean;
  faceCount: number;
  faceSizePx?: number;
  yaw?: number;
  best?: { id: string; score: number } | null;
  second?: { id: string; score: number } | null;
  error?: string;
}

export interface AnalyzeResult {
  frames: FrameAnalysis[];
  ms: number;
}

export interface Candidate {
  id: string;
  embeddings: string[]; // base64 float32
}

export const faceServiceUnavailable = () =>
  new HttpError(
    503,
    'FACE_SERVICE_UNAVAILABLE',
    "I can't check faces right now. Please ask your caregiver.",
  );

async function call<T>(path: string, body: unknown): Promise<T> {
  if (!env.FACE_SERVICE_SECRET) {
    logger.error('FACE_SERVICE_SECRET is not set');
    throw faceServiceUnavailable();
  }
  let res: Response;
  try {
    res = await fetch(`${env.FACE_SERVICE_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-face-secret': env.FACE_SERVICE_SECRET },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(env.FACE_SERVICE_TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message, path }, 'Face service unreachable');
    throw faceServiceUnavailable();
  }
  if (!res.ok) {
    logger.warn({ status: res.status, path }, 'Face service error');
    throw faceServiceUnavailable();
  }
  return (await res.json()) as T;
}

export const faceClient = {
  embed: (image: Buffer) => call<EmbedResult>('/v1/embed', { image: image.toString('base64') }),
  analyze: (frames: Buffer[], candidates: Candidate[]) =>
    call<AnalyzeResult>('/v1/analyze', {
      frames: frames.map((f) => f.toString('base64')),
      candidates,
    }),
};
