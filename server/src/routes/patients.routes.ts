/**
 * /api/patients
 *
 * Patient-role routes (own record only):
 *   GET   /me                       own profile + display preferences
 *   PATCH /me/preferences           font size / voice speed only
 *
 * Caregiver-only routes (ownership-checked):
 *   POST   /                        create patient (+ patient device-user)
 *   GET    /                        list my patients
 *   GET    /:patientId
 *   PATCH  /:patientId              name / dob / preferences
 *   DELETE /:patientId              delete ALL of this patient's data  { confirm: "DELETE" }
 *   POST   /:patientId/pairing-code issue single-use device pairing code
 *   POST   /:patientId/revoke-devices  sign out every paired patient device
 *   POST   /:patientId/device-session  one-tap: switch THIS browser to patient mode
 *                                      (signs the caregiver out on this device)
 *   PUT    /:patientId/pin          set the patient's PIN { pin: "1234" }
 *   DELETE /:patientId/pin          remove the PIN
 *   GET    /:patientId/settings     thresholds (read-only), language, retention
 *   PATCH  /:patientId/settings
 *   GET    /:patientId/audit-logs   ?limit=50&before=<ISO date>
 */
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { HttpError, ah, notFound } from '../lib/http';
import { authenticate, caregiverOfPatient, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { AuditLog } from '../models/auditLog.model';
import { Memory } from '../models/memory.model';
import { Note } from '../models/note.model';
import { Patient, serializePatient } from '../models/patient.model';
import { Person } from '../models/person.model';
import { PairingCode, RefreshToken } from '../models/session.model';
import { User } from '../models/user.model';
import { HelpRequest } from '../models/helpRequest.model';
import { RecognitionEvent } from '../models/recognitionEvent.model';
import { SusResponse } from '../models/susResponse.model';
import { Visit } from '../models/visit.model';
import { ScheduledVisit } from '../models/scheduledVisit.model';
import { audit } from '../services/audit.service';
import { issuePairingCode } from '../services/pairing.service';
import { deletePhotoFiles } from '../services/photoStorage.service';
import { hashPassword } from '../services/password.service';
import {
  clearRefreshCookie,
  refreshCookieName,
  revokeAllSessions,
  revokeRefreshToken,
  startSession,
} from '../services/token.service';

const router = Router();

const displayPrefs = {
  fontScale: z.number().min(1).max(2.5),
  voiceRate: z.number().min(0.5).max(1.5),
};
const language = z.string().trim().min(2).max(10);

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    dob: z.coerce.date().max(new Date(), 'Date of birth cannot be in the future').optional(),
    preferences: z
      .object({ language, ...displayPrefs })
      .partial()
      .strict()
      .optional(),
  })
  .strict();

const updateSchema = createSchema
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

const patientPrefsSchema = z
  .object(displayPrefs)
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

const settingsSchema = z
  .object({ language, retentionDays: z.number().int().min(1).max(3650) })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.date().optional(),
});

// ---------- Patient-role routes (must be declared before /:patientId) ----------

router.get(
  '/me',
  authenticate,
  requireRole('patient'),
  ah(async (req, res) => {
    const patient = await Patient.findById(req.user!.patientIds[0]);
    if (!patient) throw notFound('Patient');
    res.json({ patient: serializePatient(patient) });
  }),
);

router.patch(
  '/me/preferences',
  authenticate,
  requireRole('patient'),
  validate({ body: patientPrefsSchema }),
  ah(async (req, res) => {
    const patient = await Patient.findById(req.user!.patientIds[0]);
    if (!patient) throw notFound('Patient');
    const body = req.body as z.infer<typeof patientPrefsSchema>;
    if (body.fontScale !== undefined) patient.set('preferences.fontScale', body.fontScale);
    if (body.voiceRate !== undefined) patient.set('preferences.voiceRate', body.voiceRate);
    await patient.save();
    res.json({ patient: serializePatient(patient) });
  }),
);

// ---------- Caregiver routes ----------

router.post(
  '/',
  authenticate,
  requireRole('caregiver'),
  validate({ body: createSchema }),
  ah(async (req, res) => {
    const body = req.body as z.infer<typeof createSchema>;
    const caregiverId = req.user!.id;
    const patient = new Patient({
      name: body.name,
      dob: body.dob,
      preferences: body.preferences,
      caregiverIds: [caregiverId],
    });
    // The patient signs in as this device-user (no email, no password).
    const patientUser = await User.create({
      name: body.name,
      role: 'patient',
      patientIds: [patient._id],
    });
    patient.patientUserId = patientUser._id;
    await patient.save();
    await User.updateOne({ _id: caregiverId }, { $addToSet: { patientIds: patient._id } });

    await audit(req, {
      patientId: patient._id,
      action: 'patient.create',
      entityType: 'patient',
      entityId: patient._id,
    });
    res.status(201).json({ patient: serializePatient(patient) });
  }),
);

router.get(
  '/',
  authenticate,
  requireRole('caregiver'),
  ah(async (req, res) => {
    const patients = await Patient.find({ caregiverIds: req.user!.id }).sort({ name: 1 });
    res.json({ patients: patients.map(serializePatient) });
  }),
);

router.get(
  '/:patientId',
  ...caregiverOfPatient,
  ah(async (req, res) => {
    res.json({ patient: serializePatient(req.patient!) });
  }),
);

router.patch(
  '/:patientId',
  ...caregiverOfPatient,
  validate({ body: updateSchema }),
  ah(async (req, res) => {
    const patient = req.patient!;
    const body = req.body as z.infer<typeof updateSchema>;
    if (body.name !== undefined) patient.name = body.name;
    if (body.dob !== undefined) patient.dob = body.dob;
    for (const [k, v] of Object.entries(body.preferences ?? {})) patient.set(`preferences.${k}`, v);
    await patient.save();
    if (body.name && patient.patientUserId) {
      await User.updateOne({ _id: patient.patientUserId }, { $set: { name: body.name } });
    }
    await audit(req, {
      patientId: patient._id,
      action: 'patient.update',
      entityType: 'patient',
      entityId: patient._id,
    });
    res.json({ patient: serializePatient(patient) });
  }),
);

router.delete(
  '/:patientId',
  ...caregiverOfPatient,
  validate({ body: z.object({ confirm: z.literal('DELETE') }).strict() }),
  ah(async (req, res) => {
    const patient = req.patient!;
    const pid = patient._id;

    const people = await Person.find({ patientId: pid }).select('photos');
    await deletePhotoFiles(people.flatMap((p) => p.photos.map((ph) => ph.storageKey)));

    await Promise.all([
      Person.deleteMany({ patientId: pid }),
      Visit.deleteMany({ patientId: pid }),
      Memory.deleteMany({ patientId: pid }),
      Note.deleteMany({ patientId: pid }),
      ScheduledVisit.deleteMany({ patientId: pid }),
      PairingCode.deleteMany({ patientId: pid }),
      RecognitionEvent.deleteMany({ patientId: pid }),
      HelpRequest.deleteMany({ patientId: pid }),
      SusResponse.deleteMany({ patientId: pid }),
    ]);
    if (patient.patientUserId) {
      await RefreshToken.deleteMany({ userId: patient.patientUserId });
      await User.deleteOne({ _id: patient.patientUserId });
    }
    await User.updateMany({ patientIds: pid }, { $pull: { patientIds: pid } });
    await patient.deleteOne();

    // The audit trail of actions is kept (it holds no personal content).
    await audit(req, {
      patientId: pid,
      action: 'patient.delete_all_data',
      entityType: 'patient',
      entityId: pid,
    });
    res.status(204).end();
  }),
);

router.post(
  '/:patientId/pairing-code',
  ...caregiverOfPatient,
  ah(async (req, res) => {
    const patient = req.patient!;
    const result = await issuePairingCode(patient._id, req.user!.id);
    await audit(req, {
      patientId: patient._id,
      action: 'pairing.code_issued',
      entityType: 'patient',
      entityId: patient._id,
    });
    res.status(201).json(result);
  }),
);

const pinSchema = z
  .object({ pin: z.string().regex(/^\d{4,6}$/, 'The PIN must be 4 to 6 numbers.') })
  .strict();

router.put(
  '/:patientId/pin',
  ...caregiverOfPatient,
  validate({ body: pinSchema }),
  ah(async (req, res) => {
    const patient = req.patient!;
    const { pin } = req.body as z.infer<typeof pinSchema>;
    if (/^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) {
      throw new HttpError(400, 'WEAK_PIN', 'Please avoid simple PINs like 1111 or 1234.');
    }
    await Patient.updateOne(
      { _id: patient._id },
      {
        $set: {
          'pin.hash': await hashPassword(pin),
          'pin.failedCount': 0,
          'pin.setAt': new Date(),
        },
        $unset: { 'pin.lockedUntil': 1 },
      },
    );
    await audit(req, {
      patientId: patient._id,
      action: 'pin.set',
      entityType: 'patient',
      entityId: patient._id,
    });
    res.json({ pinEnabled: true });
  }),
);

router.delete(
  '/:patientId/pin',
  ...caregiverOfPatient,
  ah(async (req, res) => {
    const patient = req.patient!;
    await Patient.updateOne({ _id: patient._id }, { $unset: { pin: 1 } });
    await audit(req, {
      patientId: patient._id,
      action: 'pin.removed',
      entityType: 'patient',
      entityId: patient._id,
    });
    res.json({ pinEnabled: false });
  }),
);

/**
 * One-tap device setup: the caregiver, signed in on the patient's tablet,
 * switches it to patient mode. The caregiver's session on this browser is
 * ended first, so the patient can never reach the caregiver dashboard.
 */
router.post(
  '/:patientId/device-session',
  ...caregiverOfPatient,
  ah(async (req, res) => {
    const patient = req.patient!;
    if (!patient.patientUserId) throw notFound('Patient device user');
    await revokeRefreshToken(req.cookies?.[refreshCookieName('caregiver')]);
    clearRefreshCookie(res, 'caregiver');
    const accessToken = await startSession(res, String(patient.patientUserId), 'patient');
    await audit(req, {
      patientId: patient._id,
      action: 'pairing.device_switched',
      entityType: 'patient',
      entityId: patient._id,
    });
    res.json({
      accessToken,
      user: { id: String(patient.patientUserId), name: patient.name, role: 'patient' },
      patient: serializePatient(patient),
    });
  }),
);

router.post(
  '/:patientId/revoke-devices',
  ...caregiverOfPatient,
  ah(async (req, res) => {
    const patient = req.patient!;
    if (patient.patientUserId) await revokeAllSessions(patient.patientUserId);
    await PairingCode.deleteMany({ patientId: patient._id, usedAt: { $exists: false } });
    await audit(req, {
      patientId: patient._id,
      action: 'pairing.devices_revoked',
      entityType: 'patient',
      entityId: patient._id,
    });
    res.status(204).end();
  }),
);

const serializeSettings = (p: NonNullable<Express.Request['patient']>) => ({
  thresholds: { match: env.MATCH_THRESHOLD, unsure: env.UNSURE_THRESHOLD, editable: false },
  language: p.preferences?.language ?? 'en',
  retentionDays: p.settings?.retentionDays ?? 365,
  pinEnabled: Boolean(p.pin?.setAt),
});

router.get(
  '/:patientId/settings',
  ...caregiverOfPatient,
  ah(async (req, res) => {
    res.json({ settings: serializeSettings(req.patient!) });
  }),
);

router.patch(
  '/:patientId/settings',
  ...caregiverOfPatient,
  validate({ body: settingsSchema }),
  ah(async (req, res) => {
    const patient = req.patient!;
    const body = req.body as z.infer<typeof settingsSchema>;
    if (body.language !== undefined) patient.set('preferences.language', body.language);
    if (body.retentionDays !== undefined) patient.set('settings.retentionDays', body.retentionDays);
    await patient.save();
    await audit(req, {
      patientId: patient._id,
      action: 'settings.update',
      entityType: 'patient',
      entityId: patient._id,
    });
    res.json({ settings: serializeSettings(patient) });
  }),
);

router.get(
  '/:patientId/audit-logs',
  ...caregiverOfPatient,
  validate({ query: auditQuery }),
  ah(async (req, res) => {
    const { limit, before } = req.query as unknown as z.infer<typeof auditQuery>;
    const filter: Record<string, unknown> = { patientId: req.patient!._id };
    if (before) filter.timestamp = { $lt: before };
    const logs = await AuditLog.find(filter).sort({ timestamp: -1 }).limit(limit).lean();
    res.json({
      logs: logs.map((l) => ({
        id: String(l._id),
        actorId: l.actorId ? String(l.actorId) : undefined,
        action: l.action,
        entityType: l.entityType,
        entityId: l.entityId ? String(l.entityId) : undefined,
        timestamp: l.timestamp,
        ip: l.ip,
      })),
    });
  }),
);

export default router;
