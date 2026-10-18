/**
 * Password hashing with argon2id (OWASP-recommended parameters).
 */
import argon2 from 'argon2';
import { z } from 'zod';

const OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

/** Password rules: 10-128 chars with at least one lowercase, uppercase and digit. */
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters.')
  .max(128, 'Password must be at most 128 characters.')
  .regex(/[a-z]/, 'Password needs a lowercase letter.')
  .regex(/[A-Z]/, 'Password needs an uppercase letter.')
  .regex(/[0-9]/, 'Password needs a number.');

export const hashPassword = (plain: string) => argon2.hash(plain, OPTIONS);

let dummyHash: Promise<string> | null = null;

/**
 * Verifies a password. When the user does not exist we still verify against a
 * dummy hash so response timing does not reveal which emails are registered.
 */
export async function verifyPassword(
  hash: string | undefined | null,
  plain: string,
): Promise<boolean> {
  if (!hash) {
    dummyHash ??= argon2.hash('dummy-password-for-timing', OPTIONS);
    await argon2.verify(await dummyHash, plain).catch(() => false);
    return false;
  }
  return argon2.verify(hash, plain).catch(() => false);
}
