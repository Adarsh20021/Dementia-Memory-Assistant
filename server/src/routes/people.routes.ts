/**
 * /api/patients/:patientId/people   (caregiver only, ownership-checked at mount)
 *
 *   POST   /                          add a familiar person — consent is MANDATORY
 *   GET    /                          list
 *   GET    /:personId
 *   PATCH  /:personId                 name / relationship / age / notes
 *   DELETE /:personId                 delete person, photos, visits, memories
 *   POST   /:personId/consent         record consent again (after a revocation)
 *   POST   /:personId/consent/revoke  revoke: deletes embeddings + photos, deactivates
 *   POST   /:personId/photos          enroll face photos (consent-gated, quality-checked)
 *   GET    /:personId/photos/:photoId view one photo (decrypted)
 *   DELETE /:personId/photos/:photoId remove one photo + embedding
 *   DELETE /:personId/photos          remove all photos + embeddings (re-enroll)
 */
import { Router } from 'express';
import { z } from 'zod';
import { HttpError, ah, isObjectId, notFound } from '../lib/http';
import { validate } from '../middleware/validate';
import { Memory } from '../models/memory.model';
import { Note } from '../models/note.model';
import {
  CONSENT_GIVER_ROLES,
  CONSENT_SCOPES,
  Person,
  hasActiveConsent,
  serializePerson,
  type PersonDoc,
} from '../models/person.model';
import { RecognitionEvent } from '../models/recognitionEvent.model';
import { Visit } from '../models/visit.model';
import { audit } from '../services/audit.service';
import { env } from '../config/env';
import { imageUpload } from '../middleware/upload';
import { encryptEmbedding } from '../services/embedding.service';
import { faceClient } from '../services/faceClient.service';
import { deletePhotoFiles, readPhoto, savePhoto } from '../services/photoStorage.service';
import type { Request } from 'express';

const router = Router({ mergeParams: true });

/** Consent step: checkbox (given: true) + who consented + date + scope. */
export const consentSchema = z
  .object({
    given: z.literal(true, { errorMap: () => ({ message: 'Consent must be confirmed.' }) }),
    givenBy: z.string().trim().min(1, 'Who gave consent is required.').max(100),
    givenByRole: z.enum(CONSENT_GIVER_ROLES),
    reason: z.string().trim().max(500).optional(),
    givenAt: z.coerce
      .date()
      .refine((d) => d.getTime() <= Date.now() + 60_000, 'Consent date cannot be in the future.')
      .optional(),
    scope: z.array(z.enum(CONSENT_SCOPES)).min(1).default(['recognition']),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.givenByRole === 'caregiver' && !c.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'A reason is required when a caregiver consents on the person’s behalf.',
      });
    }
  });

const profileFields = {
  name: z.string().trim().min(1).max(100),
  relationship: z.string().trim().min(1).max(60),
  age: z.number().int().min(0).max(120).optional(),
  notes: z.string().trim().max(1000).optional(),
};

const createSchema = z.object({ ...profileFields, consent: consentSchema }).strict();
const updateSchema = z
  .object(profileFields)
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

async function loadPerson(req: Request): Promise<PersonDoc> {
  const { personId } = req.params;
  if (!isObjectId(personId)) throw notFound('Person');
  const person = await Person.findOne({ _id: personId, patientId: req.patient!._id });
  if (!person) throw notFound('Person');
  return person;
}

const consentRecord = (c: z.infer<typeof consentSchema>) => ({
  given: true,
  givenBy: c.givenBy,
  givenByRole: c.givenByRole,
  reason: c.reason,
  givenAt: c.givenAt ?? new Date(),
  scope: c.scope,
  revokedAt: undefined,
});

router.post(
  '/',
  validate({ body: createSchema }),
  ah(async (req, res) => {
    const body = req.body as z.infer<typeof createSchema>;
    const patientId = req.patient!._id;
    const person = await Person.create({
      patientId,
      name: body.name,
      relationship: body.relationship,
      age: body.age,
      notes: body.notes,
      consent: consentRecord(body.consent),
      isActive: true,
    });
    await audit(req, {
      patientId,
      action: 'person.create',
      entityType: 'person',
      entityId: person._id,
    });
    await audit(req, {
      patientId,
      action: 'consent.grant',
      entityType: 'person',
      entityId: person._id,
    });
    res.status(201).json({ person: serializePerson(person) });
  }),
);

router.get(
  '/',
  ah(async (req, res) => {
    const people = await Person.find({ patientId: req.patient!._id }).sort({ name: 1 });
    res.json({ people: people.map(serializePerson) });
  }),
);

router.get(
  '/:personId',
  ah(async (req, res) => {
    res.json({ person: serializePerson(await loadPerson(req)) });
  }),
);

router.patch(
  '/:personId',
  validate({ body: updateSchema }),
  ah(async (req, res) => {
    const person = await loadPerson(req);
    person.set(req.body as z.infer<typeof updateSchema>);
    await person.save();
    await audit(req, {
      patientId: person.patientId,
      action: 'person.update',
      entityType: 'person',
      entityId: person._id,
    });
    res.json({ person: serializePerson(person) });
  }),
);

router.delete(
  '/:personId',
  ah(async (req, res) => {
    const person = await loadPerson(req);
    await deletePhotoFiles(person.photos.map((p) => p.storageKey));
    await Promise.all([
      Visit.deleteMany({ personId: person._id }),
      Memory.deleteMany({ personId: person._id }),
      Note.updateMany({ personId: person._id }, { $unset: { personId: 1 } }),
      RecognitionEvent.updateMany({ personId: person._id }, { $unset: { personId: 1 } }),
    ]);
    await person.deleteOne();
    await audit(req, {
      patientId: person.patientId,
      action: 'person.delete',
      entityType: 'person',
      entityId: person._id,
    });
    res.status(204).end();
  }),
);

router.post(
  '/:personId/consent',
  validate({ body: consentSchema }),
  ah(async (req, res) => {
    const person = await loadPerson(req);
    if (hasActiveConsent(person)) {
      throw new HttpError(
        409,
        'CONSENT_ALREADY_ACTIVE',
        'Consent is already recorded for this person.',
      );
    }
    person.set('consent', consentRecord(req.body as z.infer<typeof consentSchema>));
    person.isActive = true;
    await person.save();
    await audit(req, {
      patientId: person.patientId,
      action: 'consent.grant',
      entityType: 'person',
      entityId: person._id,
    });
    res.json({ person: serializePerson(person) });
  }),
);

router.post(
  '/:personId/consent/revoke',
  validate({ body: z.object({}).strict() }),
  ah(async (req, res) => {
    const person = await loadPerson(req);
    if (!hasActiveConsent(person)) {
      res.json({ person: serializePerson(person) }); // idempotent
      return;
    }
    // Revocation deletes all biometric data for this person.
    await deletePhotoFiles(person.photos.map((p) => p.storageKey));
    person.set('photos', []);
    person.set('embeddings', []);
    person.set('consent.given', false);
    person.set('consent.revokedAt', new Date());
    person.isActive = false;
    await person.save();
    await audit(req, {
      patientId: person.patientId,
      action: 'consent.revoke',
      entityType: 'person',
      entityId: person._id,
    });
    res.json({ person: serializePerson(person) });
  }),
);

/** Loads the person and refuses biometric work unless consent is active. */
const requireEnrollmentConsent = ah(async (req, _res, next) => {
  const person = await loadPerson(req);
  if (!hasActiveConsent(person)) {
    await audit(req, {
      patientId: person.patientId,
      action: 'enroll.blocked_no_consent',
      entityType: 'person',
      entityId: person._id,
    });
    throw new HttpError(
      403,
      'CONSENT_REQUIRED',
      'Record consent before adding face photos for this person.',
    );
  }
  withPerson(req).person = person;
  next();
});

const withPerson = (req: Request) => req as Request & { person?: PersonDoc };

export const MIN_RECOMMENDED_PHOTOS = 3;

/**
 * Enroll face photos (multipart field "photos", 1-5 files, camera snapshots or uploads).
 * Each photo is quality-checked by the face service; good ones are stored
 * encrypted with their encrypted embedding. Poor ones are rejected with a reason.
 */
router.post(
  '/:personId/photos',
  requireEnrollmentConsent,
  ...imageUpload('photos', 5, 6 * 1024 * 1024),
  ah(async (req, res) => {
    const person = withPerson(req).person!;
    const files = req.files as Express.Multer.File[];
    const results: {
      index: number;
      filename: string;
      ok: boolean;
      code?: string | null;
      message?: string | null;
      photoId?: string;
    }[] = [];

    for (const [index, file] of files.entries()) {
      const filename = file.originalname.slice(0, 100);
      if (person.photos.length >= env.MAX_PHOTOS_PER_PERSON) {
        results.push({
          index,
          filename,
          ok: false,
          code: 'limit_reached',
          message: `This person already has ${env.MAX_PHOTOS_PER_PERSON} photos. Remove one first.`,
        });
        continue;
      }
      const check = await faceClient.embed(file.buffer);
      if (!check.ok || !check.embedding) {
        results.push({ index, filename, ok: false, code: check.code, message: check.message });
        continue;
      }
      const storageKey = await savePhoto(String(person.patientId), String(person._id), file.buffer);
      person.photos.push({ storageKey, mimeType: file.mimetype, addedAt: new Date() });
      const photo = person.photos[person.photos.length - 1];
      person.embeddings.push({ photoId: photo._id, enc: encryptEmbedding(check.embedding) });
      results.push({ index, filename, ok: true, photoId: String(photo._id) });
    }
    await person.save();

    const added = results.filter((r) => r.ok).length;
    if (added) {
      await audit(req, {
        patientId: person.patientId,
        action: 'enroll.photos_added',
        entityType: 'person',
        entityId: person._id,
      });
    }
    res.status(added ? 201 : 422).json({
      results,
      person: serializePerson(person),
      minRecommended: MIN_RECOMMENDED_PHOTOS,
      needsMore: Math.max(0, MIN_RECOMMENDED_PHOTOS - person.photos.length),
    });
  }),
);

/** View an enrolled photo (decrypted on the fly, never cached). */
router.get(
  '/:personId/photos/:photoId',
  ah(async (req, res) => {
    const person = await loadPerson(req);
    const photo = person.photos.find((p) => String(p._id) === req.params.photoId);
    if (!photo) throw notFound('Photo');
    res.setHeader('Cache-Control', 'private, no-store');
    res.type(photo.mimeType).send(await readPhoto(photo.storageKey));
  }),
);

/** Remove one photo and its embedding. */
router.delete(
  '/:personId/photos/:photoId',
  ah(async (req, res) => {
    const person = await loadPerson(req);
    const photo = person.photos.find((p) => String(p._id) === req.params.photoId);
    if (!photo) throw notFound('Photo');
    await deletePhotoFiles([photo.storageKey]);
    person.set(
      'photos',
      person.photos.filter((p) => String(p._id) !== req.params.photoId),
    );
    person.set(
      'embeddings',
      person.embeddings.filter((e) => String(e.photoId) !== req.params.photoId),
    );
    await person.save();
    await audit(req, {
      patientId: person.patientId,
      action: 'enroll.photo_removed',
      entityType: 'person',
      entityId: person._id,
    });
    res.json({ person: serializePerson(person) });
  }),
);

/** Remove all photos + embeddings (re-enroll from scratch). */
router.delete(
  '/:personId/photos',
  ah(async (req, res) => {
    const person = await loadPerson(req);
    await deletePhotoFiles(person.photos.map((p) => p.storageKey));
    person.set('photos', []);
    person.set('embeddings', []);
    await person.save();
    await audit(req, {
      patientId: person.patientId,
      action: 'enroll.photos_cleared',
      entityType: 'person',
      entityId: person._id,
    });
    res.json({ person: serializePerson(person) });
  }),
);

export default router;
