/**
 * /api/patients/:patientId/visits   (caregiver only)
 *
 *   GET    /                ?personId&from&to&needsConfirmation=true
 *   POST   /                record a visit manually (e.g. recognition was skipped)
 *   POST   /:id/confirm     { confirmed: boolean } — settles an "unsure" recognition
 *   DELETE /:id
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { HttpError, ah, isObjectId, notFound } from '../lib/http';
import { validate } from '../middleware/validate';
import { Memory } from '../models/memory.model';
import { Person, hasActiveConsent } from '../models/person.model';
import { Visit, serializeVisit } from '../models/visit.model';
import { audit } from '../services/audit.service';

const router = Router({ mergeParams: true });
const objectId = z.string().refine(isObjectId, 'Invalid id');

const listQuery = z.object({
  personId: objectId.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  needsConfirmation: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
const createSchema = z
  .object({
    personId: objectId,
    timestamp: z.coerce
      .date()
      .max(new Date(Date.now() + 60_000))
      .optional(),
    location: z.string().trim().max(100).optional(),
  })
  .strict();
const confirmSchema = z.object({ confirmed: z.boolean() }).strict();

async function loadVisit(req: Request) {
  if (!isObjectId(req.params.id)) throw notFound('Visit');
  const v = await Visit.findOne({ _id: req.params.id, patientId: req.patient!._id });
  if (!v) throw notFound('Visit');
  return v;
}

async function nameMap(patientId: unknown) {
  const people = await Person.find({ patientId }).select('name');
  return new Map(people.map((p) => [String(p._id), p.name]));
}

router.get(
  '/',
  validate({ query: listQuery }),
  ah(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const filter: Record<string, unknown> = { patientId: req.patient!._id };
    if (q.personId) filter.personId = q.personId;
    if (q.needsConfirmation) filter.needsConfirmation = q.needsConfirmation === 'true';
    if (q.from || q.to) {
      filter.timestamp = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
    }
    const [visits, names] = await Promise.all([
      Visit.find(filter).sort({ timestamp: -1 }).limit(q.limit),
      nameMap(req.patient!._id),
    ]);
    res.json({ visits: visits.map((v) => serializeVisit(v, names.get(String(v.personId)))) });
  }),
);

router.post(
  '/',
  validate({ body: createSchema }),
  ah(async (req, res) => {
    const body = req.body as z.infer<typeof createSchema>;
    const person = await Person.findOne({ _id: body.personId, patientId: req.patient!._id });
    if (!person) throw notFound('Person');
    if (!hasActiveConsent(person) || !(person.consent?.scope ?? []).includes('visit-history')) {
      throw new HttpError(
        409,
        'NO_VISIT_CONSENT',
        'This person has not consented to visit history.',
      );
    }
    const v = await Visit.create({
      patientId: req.patient!._id,
      personId: person._id,
      timestamp: body.timestamp ?? new Date(),
      location: body.location,
      outcome: 'manual',
      confirmedByCaregiver: true,
      confirmedBy: req.user!.id,
    });
    await audit(req, {
      patientId: v.patientId,
      action: 'visit.create',
      entityType: 'visit',
      entityId: v._id,
    });
    res.status(201).json({ visit: serializeVisit(v, person.name) });
  }),
);

router.post(
  '/:id/confirm',
  validate({ body: confirmSchema }),
  ah(async (req, res) => {
    const v = await loadVisit(req);
    v.confirmedByCaregiver = (req.body as z.infer<typeof confirmSchema>).confirmed;
    v.needsConfirmation = false;
    v.set('confirmedBy', req.user!.id);
    await v.save();
    await audit(req, {
      patientId: v.patientId,
      action: v.confirmedByCaregiver ? 'visit.confirm' : 'visit.reject',
      entityType: 'visit',
      entityId: v._id,
    });
    const names = await nameMap(v.patientId);
    res.json({ visit: serializeVisit(v, names.get(String(v.personId))) });
  }),
);

router.delete(
  '/:id',
  ah(async (req, res) => {
    const v = await loadVisit(req);
    await Memory.updateMany({ visitId: v._id }, { $unset: { visitId: 1 } });
    await v.deleteOne();
    await audit(req, {
      patientId: v.patientId,
      action: 'visit.delete',
      entityType: 'visit',
      entityId: v._id,
    });
    res.status(204).end();
  }),
);

export default router;
