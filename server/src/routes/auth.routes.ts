/**
 * /api/auth
 *   POST /register   caregiver sign-up (can be disabled with ALLOW_REGISTRATION=false)
 *   POST /login      caregiver login, with account lockout
 *   POST /pair       patient device sign-in with a caregiver-issued pairing code
 *   POST /pin-status { patientId } -> { pinEnabled } (for a device that was paired before)
 *   POST /pin        patient sign-in with their PIN on a device that was paired before
 *   POST /refresh    rotate refresh cookie, get a new access token  { role? }
 *   POST /logout     revoke the current refresh token               { role? }
 *
 * Caregiver and patient sessions use separate cookies, so both can live in
 * one browser without signing each other out. Patient sessions are long-lived
 * and sliding (PATIENT_SESSION_DAYS), so a paired device rarely needs a code.
 *   GET  /me         who am I
 */
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { HttpError, ah } from '../lib/http';
import { authenticate } from '../middleware/auth';
import { authLimiter, pairLimiter } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import { Patient, serializePatient } from '../models/patient.model';
import { User, serializeUser, type Role } from '../models/user.model';
import { audit } from '../services/audit.service';
import { redeemPairingCode } from '../services/pairing.service';
import { hashPassword, passwordSchema, verifyPassword } from '../services/password.service';
import { isObjectId } from '../lib/http';
import {
  LEGACY_REFRESH_COOKIE,
  clearRefreshCookie,
  refreshCookieName,
  consumeRefreshToken,
  revokeRefreshToken,
  startSession,
} from '../services/token.service';

const router = Router();

const email = z.string().trim().toLowerCase().email().max(254);

const registerSchema = z
  .object({ name: z.string().trim().min(1).max(100), email, password: passwordSchema })
  .strict();

const loginSchema = z.object({ email, password: z.string().min(1).max(128) }).strict();

const pairSchema = z.object({ code: z.string().trim().min(8).max(16) }).strict();
const roleBody = z.object({ role: z.enum(['caregiver', 'patient']).optional() }).strict();
const patientIdBody = z.string().refine(isObjectId, 'Invalid id');
const pinStatusSchema = z.object({ patientId: patientIdBody }).strict();
const pinLoginSchema = z
  .object({
    patientId: patientIdBody,
    pin: z.string().regex(/^\d{4,6}$/, 'The PIN is 4 to 6 numbers.'),
  })
  .strict();

const invalidLogin = () =>
  new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');

router.post(
  '/register',
  authLimiter,
  validate({ body: registerSchema }),
  ah(async (req, res) => {
    if (!env.ALLOW_REGISTRATION) {
      throw new HttpError(
        403,
        'REGISTRATION_DISABLED',
        'New accounts cannot be created right now.',
      );
    }
    const { name, email, password } = req.body as z.infer<typeof registerSchema>;
    if (await User.exists({ email })) {
      throw new HttpError(409, 'EMAIL_IN_USE', 'An account with this email already exists.');
    }
    // Public registration can only ever create caregivers.
    const user = await User.create({
      name,
      email,
      passwordHash: await hashPassword(password),
      role: 'caregiver',
    });
    await audit(req, {
      actorId: user._id,
      action: 'auth.register',
      entityType: 'user',
      entityId: user._id,
    });
    res.status(201).json({ user: serializeUser(user) });
  }),
);

router.post(
  '/login',
  authLimiter,
  validate({ body: loginSchema }),
  ah(async (req, res) => {
    const { email, password } = req.body as z.infer<typeof loginSchema>;
    const user = await User.findOne({ email, role: 'caregiver' }).select('+passwordHash');

    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      await audit(req, {
        actorId: user._id,
        action: 'auth.login_blocked_locked',
        entityType: 'user',
        entityId: user._id,
      });
      throw new HttpError(
        423,
        'ACCOUNT_LOCKED',
        'Too many failed attempts. Please try again later.',
      );
    }

    const ok = await verifyPassword(user?.passwordHash, password);
    if (!user || !ok) {
      if (user) {
        // Atomic increment, then read the new count.
        await User.updateOne({ _id: user._id }, { $inc: { failedLoginCount: 1 } });
        const updated = await User.findById(user._id);
        if (updated && updated.failedLoginCount >= env.LOGIN_MAX_FAILURES) {
          updated.lockedUntil = new Date(Date.now() + env.LOGIN_LOCKOUT_MIN * 60 * 1000);
          updated.failedLoginCount = 0;
          await updated.save();
          await audit(req, {
            actorId: user._id,
            action: 'auth.account_locked',
            entityType: 'user',
            entityId: user._id,
          });
        } else {
          await audit(req, {
            actorId: user._id,
            action: 'auth.login_failed',
            entityType: 'user',
            entityId: user._id,
          });
        }
      }
      throw invalidLogin();
    }

    if (user.failedLoginCount || user.lockedUntil) {
      await User.updateOne(
        { _id: user._id },
        { $set: { failedLoginCount: 0 }, $unset: { lockedUntil: 1 } },
      );
    }
    const accessToken = await startSession(res, String(user._id), 'caregiver');
    await audit(req, {
      actorId: user._id,
      action: 'auth.login',
      entityType: 'user',
      entityId: user._id,
    });
    res.json({ accessToken, user: serializeUser(user) });
  }),
);

router.post(
  '/pair',
  pairLimiter,
  validate({ body: pairSchema }),
  ah(async (req, res) => {
    const patientId = await redeemPairingCode((req.body as z.infer<typeof pairSchema>).code);
    const patient = patientId ? await Patient.findById(patientId) : null;
    if (!patient?.patientUserId) {
      throw new HttpError(
        400,
        'INVALID_CODE',
        'That code did not work. Please ask your caregiver for a new one.',
      );
    }
    const accessToken = await startSession(res, String(patient.patientUserId), 'patient');
    await audit(req, {
      actorId: patient.patientUserId,
      patientId: patient._id,
      action: 'auth.device_paired',
      entityType: 'patient',
      entityId: patient._id,
    });
    res.json({
      accessToken,
      user: { id: String(patient.patientUserId), name: patient.name, role: 'patient' as Role },
      patient: serializePatient(patient),
    });
  }),
);

/** Which refresh cookie to use: the requested role's, else any we find. */
function pickRefreshCookie(
  cookies: Record<string, string> | undefined,
  role?: Role,
): { raw?: string; from: Role | 'legacy' | null } {
  const order: Role[] = role ? [role] : ['caregiver', 'patient'];
  for (const r of order) {
    const raw = cookies?.[refreshCookieName(r)];
    if (raw) return { raw, from: r };
  }
  const legacy = cookies?.[LEGACY_REFRESH_COOKIE];
  return legacy ? { raw: legacy, from: 'legacy' } : { from: null };
}

router.post(
  '/refresh',
  authLimiter,
  validate({ body: roleBody }),
  ah(async (req, res) => {
    const { role } = req.body as z.infer<typeof roleBody>;
    const picked = pickRefreshCookie(req.cookies, role);
    if (!picked.from) throw new HttpError(401, 'INVALID_SESSION', 'Please sign in again.');
    const { userId, reuse } = await consumeRefreshToken(picked.raw);
    if (reuse) {
      clearRefreshCookie(res, picked.from);
      await audit(req, {
        actorId: userId,
        action: 'auth.refresh_reuse_detected',
        entityType: 'user',
        entityId: userId,
      });
      throw new HttpError(401, 'INVALID_SESSION', 'Please sign in again.');
    }
    const user = await User.findById(userId);
    if (!user || (role && user.role !== role)) {
      clearRefreshCookie(res, picked.from);
      throw new HttpError(401, 'INVALID_SESSION', 'Please sign in again.');
    }
    if (picked.from === 'legacy') clearRefreshCookie(res, 'legacy');
    const accessToken = await startSession(res, userId, user.role as Role);
    res.json({ accessToken, user: serializeUser(user) });
  }),
);

router.post(
  '/logout',
  validate({ body: roleBody }),
  ah(async (req, res) => {
    const { role } = req.body as z.infer<typeof roleBody>;
    const roles: (Role | 'legacy')[] = role ? [role] : ['caregiver', 'patient', 'legacy'];
    for (const r of roles) {
      const raw = req.cookies?.[r === 'legacy' ? LEGACY_REFRESH_COOKIE : refreshCookieName(r)];
      if (!raw) continue;
      const userId = await revokeRefreshToken(raw);
      clearRefreshCookie(res, r);
      if (userId)
        await audit(req, {
          actorId: userId,
          action: 'auth.logout',
          entityType: 'user',
          entityId: userId,
        });
    }
    res.status(204).end();
  }),
);

router.post(
  '/pin-status',
  pairLimiter,
  validate({ body: pinStatusSchema }),
  ah(async (req, res) => {
    const patient = await Patient.findById((req.body as z.infer<typeof pinStatusSchema>).patientId);
    res.json({ pinEnabled: Boolean(patient?.pin?.setAt) });
  }),
);

const wrongPin = () =>
  new HttpError(
    401,
    'INVALID_PIN',
    'That PIN did not work. Please try again, or ask your caregiver.',
  );

router.post(
  '/pin',
  pairLimiter,
  validate({ body: pinLoginSchema }),
  ah(async (req, res) => {
    const { patientId, pin } = req.body as z.infer<typeof pinLoginSchema>;
    const patient = await Patient.findById(patientId).select(
      '+pin.hash +pin.failedCount +pin.lockedUntil',
    );
    if (!patient?.pin?.hash || !patient.patientUserId) throw wrongPin();
    if (patient.pin.lockedUntil && patient.pin.lockedUntil > new Date()) {
      throw new HttpError(
        423,
        'PIN_LOCKED',
        'Too many tries. Please wait a few minutes, or ask your caregiver.',
      );
    }
    if (!(await verifyPassword(patient.pin.hash, pin))) {
      const failed = (patient.pin.failedCount ?? 0) + 1;
      const lock = failed >= env.PIN_MAX_FAILURES;
      await Patient.updateOne(
        { _id: patient._id },
        lock
          ? {
              $set: {
                'pin.failedCount': 0,
                'pin.lockedUntil': new Date(Date.now() + env.PIN_LOCKOUT_MIN * 60_000),
              },
            }
          : { $set: { 'pin.failedCount': failed } },
      );
      await audit(req, {
        actorId: patient.patientUserId,
        patientId: patient._id,
        action: lock ? 'auth.pin_locked' : 'auth.pin_failed',
        entityType: 'patient',
        entityId: patient._id,
      });
      throw wrongPin();
    }
    await Patient.updateOne(
      { _id: patient._id },
      { $set: { 'pin.failedCount': 0 }, $unset: { 'pin.lockedUntil': 1 } },
    );
    const accessToken = await startSession(res, String(patient.patientUserId), 'patient');
    await audit(req, {
      actorId: patient.patientUserId,
      patientId: patient._id,
      action: 'auth.pin_login',
      entityType: 'patient',
      entityId: patient._id,
    });
    res.json({
      accessToken,
      user: { id: String(patient.patientUserId), name: patient.name, role: 'patient' as Role },
      patient: serializePatient(patient),
    });
  }),
);

router.get(
  '/me',
  authenticate,
  ah(async (req, res) => {
    res.json({ user: { ...req.user } });
  }),
);

export default router;
