/**
 * Session tokens.
 *  - Access token: short-lived JWT (HS256), sent as "Authorization: Bearer".
 *  - Refresh token: random 384-bit opaque value in an httpOnly cookie. Only its
 *    SHA-256 hash is stored. Every refresh rotates it; presenting an already
 *    rotated token is treated as theft and revokes all of the user's sessions.
 */
import { randomBytes } from 'crypto';
import type { Response } from 'express';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { env, isProd } from '../config/env';
import { sha256 } from '../lib/crypto';
import { HttpError } from '../lib/http';
import { RefreshToken } from '../models/session.model';
import type { Role } from '../models/user.model';

/**
 * One refresh cookie per role, so a caregiver signing in on the same browser
 * (e.g. while testing) never signs the patient's device out, and vice versa.
 */
export const refreshCookieName = (role: Role) => `dma_rt_${role}`;
/** Cookie used before per-role cookies existed; still accepted once, then replaced. */
export const LEGACY_REFRESH_COOKIE = 'dma_refresh';
const ttlDays = (role: Role) =>
  role === 'patient' ? env.PATIENT_SESSION_DAYS : env.REFRESH_TOKEN_TTL_DAYS;
const ISSUER = 'dementia-memory-assistant';

export interface AccessClaims {
  sub: string;
  role: Role;
}

export function signAccessToken(userId: string, role: Role): string {
  return jwt.sign({ role }, env.JWT_ACCESS_SECRET, {
    subject: userId,
    issuer: ISSUER,
    algorithm: 'HS256',
    expiresIn: `${env.ACCESS_TOKEN_TTL_MIN}m`,
  });
}

export function verifyAccessToken(token: string): AccessClaims {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
    algorithms: ['HS256'],
    issuer: ISSUER,
  });
  if (typeof payload === 'string' || !payload.sub || !payload.role) {
    throw new Error('Malformed token');
  }
  return { sub: payload.sub, role: payload.role as Role };
}

function setRefreshCookie(res: Response, raw: string, role: Role) {
  res.cookie(refreshCookieName(role), raw, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: ttlDays(role) * 24 * 60 * 60 * 1000,
  });
}

export function clearRefreshCookie(res: Response, role: Role | 'legacy') {
  res.clearCookie(role === 'legacy' ? LEGACY_REFRESH_COOKIE : refreshCookieName(role), {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    path: '/api/auth',
  });
}

/** Creates a new refresh token (cookie) and returns a fresh access token. */
export async function startSession(res: Response, userId: string, role: Role): Promise<string> {
  const raw = randomBytes(48).toString('base64url');
  await RefreshToken.create({
    userId,
    tokenHash: sha256(raw),
    expiresAt: new Date(Date.now() + ttlDays(role) * 24 * 60 * 60 * 1000),
  });
  setRefreshCookie(res, raw, role);
  return signAccessToken(userId, role);
}

const invalidSession = () => new HttpError(401, 'INVALID_SESSION', 'Please sign in again.');

/**
 * Validates and consumes a refresh token. Returns the owning user id.
 * Throws 401 on unknown / expired / reused tokens.
 */
export async function consumeRefreshToken(
  raw: string | undefined,
): Promise<{ userId: string; reuse: boolean }> {
  if (!raw) throw invalidSession();
  const now = new Date();
  const record = await RefreshToken.findOne({ tokenHash: sha256(raw) });
  if (!record) throw invalidSession();

  if (record.revokedAt) {
    // Reuse of a rotated token: assume it was stolen and end every session.
    await revokeAllSessions(record.userId);
    return { userId: String(record.userId), reuse: true };
  }
  if (record.expiresAt <= now) throw invalidSession();

  // Atomic claim so two parallel refreshes cannot both succeed.
  const claimed = await RefreshToken.findOneAndUpdate(
    { _id: record._id, revokedAt: { $exists: false } },
    { $set: { revokedAt: now } },
  );
  if (!claimed) throw invalidSession();
  return { userId: String(record.userId), reuse: false };
}

/** Revokes one refresh token (logout). Silently ignores unknown tokens. */
export async function revokeRefreshToken(raw: string | undefined): Promise<string | null> {
  if (!raw) return null;
  const record = await RefreshToken.findOneAndUpdate(
    { tokenHash: sha256(raw), revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
  );
  return record ? String(record.userId) : null;
}

export async function revokeAllSessions(userId: string | Types.ObjectId): Promise<void> {
  await RefreshToken.updateMany(
    { userId, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
  );
}
