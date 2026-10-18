/**
 * Encrypted photo file storage under UPLOAD_DIR.
 * Files are AES-256-GCM encrypted (lib/crypto) before touching disk, so a
 * copied uploads folder reveals nothing without ENCRYPTION_KEY.
 * Layout: <UPLOAD_DIR>/<patientId>/<personId>/<random>.enc
 */
import { randomBytes } from 'crypto';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import { env } from '../config/env';
import { decryptBytes, encryptBytes } from '../lib/crypto';
import { logger } from '../lib/logger';

const root = () => path.resolve(env.UPLOAD_DIR);

/** Resolves a storage key safely inside UPLOAD_DIR (blocks path traversal). */
function resolveKey(key: string): string {
  const full = path.resolve(root(), key);
  if (!full.startsWith(root() + path.sep)) throw new Error('Invalid storage key');
  return full;
}

export async function savePhoto(
  patientId: string,
  personId: string,
  data: Buffer,
): Promise<string> {
  const key = path.posix.join(patientId, personId, `${randomBytes(12).toString('hex')}.enc`);
  const full = resolveKey(key);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, encryptBytes(data), 'utf8');
  return key;
}

export async function readPhoto(key: string): Promise<Buffer> {
  return decryptBytes(await readFile(resolveKey(key), 'utf8'));
}

export async function deletePhotoFiles(keys: string[]): Promise<void> {
  await Promise.all(
    keys.map(async (key) => {
      try {
        await rm(resolveKey(key), { force: true });
      } catch (err) {
        logger.error({ err }, 'Failed to delete photo file');
      }
    }),
  );
}
