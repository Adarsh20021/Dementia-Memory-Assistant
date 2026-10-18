/**
 * /api/patients/:patientId/schedule   (caregiver OR the patient)
 *
 *   GET    /              upcoming (default) or ?range=past|all; ?personId
 *   POST   /              plan a visit { personId? | visitorName?, startsAt, durationMin?, note? }
 *   PATCH  /:id           change time / note / status (patient: only visits they added,
 *                         except marking any visit "done")
 *   DELETE /:id           patient: own only; caregiver: any
 *
 * Both roles can plan visits. Everyone with access to the patient sees all
 * planned visits, so the patient always knows who is coming.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { HttpError, ah, isObjectId, notFound } from '../lib/http';
import { encryptText } from '../lib/crypto';
import { validate } from '../middleware/validate';
import { Person } from '../models/person.model';
import {
  SCHEDULE_STATUSES,
  ScheduledVisit,
  serializeScheduledVisit,
  type ScheduledVisitDoc,
} from '../models/scheduledVisit.model';
import { audit } from '../services/audit.service';
import { personLabels } from '../services/people.service';

const router = Router({ mergeParams: true });
const objectId = z.string().refine(isObjectId, 'Invalid id');

const createSchema = z
  .object({
    personId: objectId.optional(),
    visitorName: z.string().trim().min(1).max(80).optional(),
    startsAt: z.coerce.date(),
    durationMin: z.number().int().min(5).max(1440).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((b) => b.personId || b.visitorName, {
    message: 'Choose who is visiting, or type their name.',
    path: ['personId'],
  });

const updateSchema = z
  .object({
    personId: objectId.nullable(),
    visitorName: z.string().trim().max(80).nullable(),
    startsAt: z.coerce.date(),
    durationMin: z.number().int().min(5).max(1440).nullable(),
    note: z.string().trim().max(500).nullable(),
    status: z.enum(SCHEDULE_STATUSES),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

const listQuery = z.object({
  range: z.enum(['upcoming', 'past', 'all']).default('upcoming'),
  personId: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

async function checkPerson(req: Request, personId?: string | null) {
  if (personId && !(await Person.exists({ _id: personId, patientId: req.patient!._id }))) {
    throw notFound('Person');
  }
}

async function load(req: Request): Promise<ScheduledVisitDoc> {
  if (!isObjectId(req.params.id)) throw notFound('Visit');
  const v = await ScheduledVisit.findOne({ _id: req.params.id, patientId: req.patient!._id });
  if (!v) throw notFound('Visit');
  return v;
}

const isPatient = (req: Request) => req.user!.role === 'patient';
const ownedBy = (req: Request, v: ScheduledVisitDoc) => String(v.createdBy) === req.user!.id;

async function respond(req: Request, visits: ScheduledVisitDoc[]) {
  const labels = await personLabels(
    req.patient!._id,
    visits.map((v) => v.personId),
  );
  return visits.map((v) =>
    serializeScheduledVisit(
      v,
      req.user!.id,
      v.personId ? labels.get(String(v.personId)) : undefined,
    ),
  );
}

router.get(
  '/',
  validate({ query: listQuery }),
  ah(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const filter: Record<string, unknown> = { patientId: req.patient!._id };
    if (q.personId) filter.personId = q.personId;
    // "Upcoming" includes visits that started in the last 2 hours (still happening).
    const cutoff = new Date(Date.now() - 2 * 3_600_000);
    if (q.range === 'upcoming') {
      filter.startsAt = { $gte: cutoff };
      filter.status = 'scheduled';
    } else if (q.range === 'past') filter.startsAt = { $lt: cutoff };
    const visits = await ScheduledVisit.find(filter)
      .sort({ startsAt: q.range === 'past' ? -1 : 1 })
      .limit(q.limit);
    res.json({ visits: await respond(req, visits) });
  }),
);

router.post(
  '/',
  validate({ body: createSchema }),
  ah(async (req, res) => {
    const body = req.body as z.infer<typeof createSchema>;
    await checkPerson(req, body.personId);
    if (body.startsAt.getTime() < Date.now() - 24 * 3_600_000) {
      throw new HttpError(400, 'IN_THE_PAST', 'Please choose a time that has not passed yet.');
    }
    const v = await ScheduledVisit.create({
      patientId: req.patient!._id,
      personId: body.personId,
      visitorName: body.personId ? undefined : body.visitorName,
      startsAt: body.startsAt,
      durationMin: body.durationMin,
      noteEnc: body.note ? encryptText(body.note) : undefined,
      createdBy: req.user!.id,
      createdByRole: req.user!.role,
    });
    await audit(req, {
      patientId: req.patient!._id,
      action: 'schedule.create',
      entityType: 'scheduledVisit',
      entityId: v._id,
    });
    res.status(201).json({ visit: (await respond(req, [v]))[0] });
  }),
);

router.patch(
  '/:id',
  validate({ body: updateSchema }),
  ah(async (req, res) => {
    const v = await load(req);
    const body = req.body as z.infer<typeof updateSchema>;
    const onlyMarkingDone = Object.keys(body).length === 1 && body.status === 'done';
    if (isPatient(req) && !ownedBy(req, v) && !onlyMarkingDone) {
      throw new HttpError(403, 'NOT_YOUR_ENTRY', 'You can only change visits you added.');
    }
    if (body.personId !== undefined) {
      await checkPerson(req, body.personId);
      v.set('personId', body.personId ?? undefined);
    }
    if (body.visitorName !== undefined) v.set('visitorName', body.visitorName || undefined);
    if (body.startsAt) v.startsAt = body.startsAt;
    if (body.durationMin !== undefined) v.set('durationMin', body.durationMin ?? undefined);
    if (body.note !== undefined) v.set('noteEnc', body.note ? encryptText(body.note) : undefined);
    if (body.status) v.status = body.status;
    if (!v.personId && !v.visitorName) {
      throw new HttpError(400, 'NO_VISITOR', 'Choose who is visiting, or type their name.');
    }
    await v.save();
    res.json({ visit: (await respond(req, [v]))[0] });
  }),
);

router.delete(
  '/:id',
  ah(async (req, res) => {
    const v = await load(req);
    if (isPatient(req) && !ownedBy(req, v)) {
      throw new HttpError(403, 'NOT_YOUR_ENTRY', 'You can only remove visits you added.');
    }
    await v.deleteOne();
    await audit(req, {
      patientId: req.patient!._id,
      action: 'schedule.delete',
      entityType: 'scheduledVisit',
      entityId: v._id,
    });
    res.status(204).end();
  }),
);

export default router;
