/**
 * /api/patients/:patientId/notes   (caregiver OR the patient themself)
 *
 *   POST   /            create a note / reminder (text encrypted at rest)
 *   GET    /            patient: only their own entries; caregiver: all
 *   PATCH  /:noteId     patient: own entries only; caregiver: any
 *   DELETE /:noteId     patient: own entries only; caregiver: any
 *
 * Ownership rule from the spec: a patient may only write/edit/delete entries
 * whose author is themself.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { HttpError, ah, isObjectId, notFound } from '../lib/http';
import { validate } from '../middleware/validate';
import { encryptText } from '../lib/crypto';
import { NOTE_KINDS, Note, serializeNote, type NoteDoc } from '../models/note.model';
import { Person } from '../models/person.model';
import { audit } from '../services/audit.service';
import { personLabels } from '../services/people.service';

const router = Router({ mergeParams: true });

const text = z.string().trim().min(1, 'Please write something.').max(2000);
const objectId = z.string().refine(isObjectId, 'Invalid id');

const createSchema = z
  .object({
    kind: z.enum(NOTE_KINDS).default('note'),
    text,
    dueAt: z.coerce.date().optional(),
    personId: objectId.optional(),
  })
  .strict();

const updateSchema = z
  .object({ text, dueAt: z.coerce.date().nullable(), completed: z.boolean() })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

async function loadOwnedNote(req: Request): Promise<NoteDoc> {
  const { noteId } = req.params;
  if (!isObjectId(noteId)) throw notFound('Note');
  const note = await Note.findOne({ _id: noteId, patientId: req.patient!._id });
  if (!note) throw notFound('Note');
  if (req.user!.role === 'patient' && String(note.createdBy) !== req.user!.id) {
    throw new HttpError(403, 'NOT_YOUR_ENTRY', 'You can only change entries you wrote.');
  }
  return note;
}

router.post(
  '/',
  validate({ body: createSchema }),
  ah(async (req, res) => {
    const body = req.body as z.infer<typeof createSchema>;
    const patientId = req.patient!._id;
    if (body.personId && !(await Person.exists({ _id: body.personId, patientId }))) {
      throw notFound('Person');
    }
    const note = await Note.create({
      patientId,
      personId: body.personId,
      kind: body.kind,
      textEnc: encryptText(body.text),
      dueAt: body.dueAt,
      createdBy: req.user!.id,
    });
    res.status(201).json({ note: serializeNote(note, req.user!.id) });
  }),
);

router.get(
  '/',
  ah(async (req, res) => {
    const filter: Record<string, unknown> = { patientId: req.patient!._id };
    if (req.user!.role === 'patient') filter.createdBy = req.user!.id;
    const notes = await Note.find(filter).sort({ createdAt: -1 }).limit(500);
    const labels = await personLabels(
      req.patient!._id,
      notes.map((n) => n.personId),
    );
    res.json({
      notes: notes.map((n) => ({
        ...serializeNote(n, req.user!.id),
        personName: n.personId ? labels.get(String(n.personId))?.name : undefined,
      })),
    });
  }),
);

router.patch(
  '/:noteId',
  validate({ body: updateSchema }),
  ah(async (req, res) => {
    const note = await loadOwnedNote(req);
    const body = req.body as z.infer<typeof updateSchema>;
    if (body.text !== undefined) note.textEnc = encryptText(body.text);
    if (body.dueAt !== undefined) note.set('dueAt', body.dueAt ?? undefined);
    if (body.completed !== undefined) note.completed = body.completed;
    await note.save();
    res.json({ note: serializeNote(note, req.user!.id) });
  }),
);

router.delete(
  '/:noteId',
  ah(async (req, res) => {
    const note = await loadOwnedNote(req);
    await note.deleteOne();
    await audit(req, {
      patientId: note.patientId,
      action: 'note.delete',
      entityType: 'note',
      entityId: note._id,
    });
    res.status(204).end();
  }),
);

export default router;
