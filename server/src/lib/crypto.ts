/**
 * AES-256-GCM encryption for sensitive data at rest
 * (face embeddings, photos, patient-written text, memory summaries).
 *
 * Payload format: "v1:<iv b64>:<authTag b64>:<ciphertext b64>"
 * A fresh 96-bit IV is generated for every encryption. The version prefix
 * allows key rotation / algorithm changes later without ambiguity.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { env } from '../config/env';

const ALGO = 'aes-256-gcm';
const VERSION = 'v1';

let cachedKey: Buffer | null = null;
function key(): Buffer {
  if (!cachedKey) cachedKey = Buffer.from(env.ENCRYPTION_KEY, 'hex');
  return cachedKey;
}

export function encryptBytes(plain: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decryptBytes(payload: string): Buffer {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Unsupported or corrupted encrypted payload');
  }
  const [, iv, tag, ciphertext] = parts;
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
}

export const encryptText = (plain: string): string => encryptBytes(Buffer.from(plain, 'utf8'));
export const decryptText = (payload: string): string => decryptBytes(payload).toString('utf8');

/** One-way hash used for refresh tokens and pairing codes (high-entropy secrets). */
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
