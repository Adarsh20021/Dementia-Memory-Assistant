/**
 * Embeddings are 512 float32 values (base64 from the face service).
 * At rest they are AES-256-GCM encrypted; they are decrypted only in memory,
 * only for the current patient's people, right before a match request.
 */
import { decryptBytes, encryptBytes } from '../lib/crypto';

export const encryptEmbedding = (b64Float32: string): string =>
  encryptBytes(Buffer.from(b64Float32, 'base64'));

export const decryptEmbedding = (enc: string): string => decryptBytes(enc).toString('base64');
