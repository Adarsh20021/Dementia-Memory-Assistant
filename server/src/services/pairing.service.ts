/**
 * Patient device pairing. A caregiver issues a short-lived, single-use code
 * (e.g. "K7QM-3RXA"); the patient types it once on their device and is signed
 * in with a patient-scoped session. No passwords for the patient.
 *
 * 8 characters from a 31-symbol alphabet ≈ 40 bits of entropy. Combined with
 * a 15-minute expiry, single use and rate limiting on /auth/pair, online
 * guessing is impractical.
 */
import { randomInt } from 'crypto';
import { Types } from 'mongoose';
import { env } from '../config/env';
import { sha256 } from '../lib/crypto';
import { PairingCode } from '../models/session.model';

// No 0/O, 1/I/L to avoid confusion when reading the code aloud.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LENGTH = 8;

/** Uppercases and strips spaces/dashes so "k7qm 3rxa" works too. */
export const normalizeCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, '');

export async function issuePairingCode(patientId: Types.ObjectId, caregiverId: string) {
  let code = '';
  for (let i = 0; i < LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  const expiresAt = new Date(Date.now() + env.PAIRING_CODE_TTL_MIN * 60 * 1000);

  // Only one valid code per patient at a time.
  await PairingCode.deleteMany({ patientId, usedAt: { $exists: false } });
  await PairingCode.create({
    patientId,
    codeHash: sha256(code),
    createdBy: caregiverId,
    expiresAt,
  });

  return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
}

/** Atomically consumes a code. Returns the patient id, or null if invalid/expired/used. */
export async function redeemPairingCode(rawCode: string): Promise<Types.ObjectId | null> {
  const record = await PairingCode.findOneAndUpdate(
    {
      codeHash: sha256(normalizeCode(rawCode)),
      usedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
    },
    { $set: { usedAt: new Date() } },
  );
  return record ? record.patientId : null;
}
