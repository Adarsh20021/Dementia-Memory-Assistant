/**
 * /api/patients/:patientId/memories   (caregiver OR patient, ownership-checked at mount)
 *
 * Patient:
 *   POST   /             "Remember this" — saved immediately, reviewStatus "pending"
 *   GET    /             only their own entries (pending ones included)
 *   PATCH  /:id          own entries only; edit sends it back to "pending"
 *   DELETE /:id          own entries only
 * Caregiver:
 *   POST   /             caregiver-written memory, or an approved AI draft (stored as approved)
 *   POST   /draft        Groq drafts a summary from notes — NOT stored; caregiver edits + saves
 *   GET    /             all, filterable: ?personId&source&reviewStatus&q
 *   GET    /review-queue patient entries awaiting review
 *   GET    /:id          with full version history
 *   PATCH  /:id          edit (new version, history kept)
 *   POST   /:id/review   { action: approve | flag | correct, summary? }
 *   DELETE /:id
 *
 * Text is encrypted at rest. Only "approved" + consentApproved memories are
 * ever used as LLM context (context.service).
 */
import { Router, type Request } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { HttpError, ah, isObjectId, notFound } from '../lib/http';
import { decryptText, encryptText } from '../lib/crypto';
import { requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  Memory,
  MEMORY_SOURCES,
  REVIEW_STATUSES,
  memorySummary,
  type MemoryDoc,
} from '../models/memory.model';
import { Person, hasActiveConsent, type PersonDoc } from '../models/person.model';
import { Visit } from '../models/visit.model';
import { audit } from '../services/audit.service';
import { firstNameOf } from '../services/context.service';
import { personLabels, type PersonLabel } from '../services/people.service';
import { formatVisitDate } from '../services/context.service';
import { llmStatus } from '../services/llm.service';
import { draftVisitSummary, retellMemory } from '../services/summary.service';

const router = Router({ mergeParams: true });

const summary = z.string().trim().min(1, 'Please write something.').max(1000);
const objectId = z.string().refine(isObjectId, 'Invalid id');

const patientCreate = z
  .object({ summary, personId: objectId.optional(), visitId: objectId.optional() })
  .strict();
const caregiverCreate = patientCreate
  .extend({ source: z.enum(['caregiver', 'ai-summary']).default('caregiver') })
  .strict();
const updateSchema = z.object({ summary }).strict();
const reviewSchema = z
  .object({ action: z.enum(['approve', 'flag', 'correct']), summary: summary.optional() })
  .strict()
  .refine((b) => b.action !== 'correct' || b.summary, {
    message: 'A corrected text is required.',
    path: ['summary'],
  });
const draftSchema = z
  .object({ personId: objectId, notes: z.string().trim().min(3).max(4000) })
  .strict();
const listQuery = z.object({
  personId: objectId.optional(),
  source: z.enum(MEMORY_SOURCES).optional(),
  reviewStatus: z.enum(REVIEW_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/** Consent for using conversation summaries about this person. */
const allowsSummaries = (p: PersonDoc | null) =>
  !p || (hasActiveConsent(p) && (p.consent?.scope ?? []).includes('conversation-summaries'));

async function loadLinks(req: Request, personId?: string, visitId?: string) {
  const patientId = req.patient!._id;
  const person = personId ? await Person.findOne({ _id: personId, patientId }) : null;
  if (personId && !person) throw notFound('Person');
  if (visitId) {
    const visit = await Visit.findOne({ _id: visitId, patientId });
    if (!visit) throw notFound('Visit');
    if (person && String(visit.personId) !== String(person._id)) {
      throw new HttpError(400, 'VISIT_MISMATCH', 'That visit belongs to a different person.');
    }
  }
  return person;
}

async function loadMemory(req: Request): Promise<MemoryDoc> {
  if (!isObjectId(req.params.id)) throw notFound('Memory');
  const m = await Memory.findOne({ _id: req.params.id, patientId: req.patient!._id });
  if (!m) throw notFound('Memory');
  if (req.user!.role === 'patient' && String(m.authorId) !== req.user!.id) {
    throw new HttpError(403, 'NOT_YOUR_ENTRY', 'You can only change entries you wrote.');
  }
  return m;
}

/** Saves the current text into history and replaces it (version + 1). */
function newVersion(m: MemoryDoc, text: string, editorId: string) {
  m.history.push({
    version: m.version,
    summaryEnc: m.summaryEnc,
    editedBy: m.lastEditedBy ?? m.authorId,
    editedAt: m.editedAt ?? (m.get('createdAt') as Date),
  });
  m.summaryEnc = encryptText(text);
  m.version += 1;
  m.editedAt = new Date();
  m.lastEditedBy = new Types.ObjectId(editorId);
}

const serialize = (m: MemoryDoc, req: Request, labels?: Map<string, PersonLabel>) => {
  const isCaregiver = req.user!.role === 'caregiver';
  const who = m.personId ? labels?.get(String(m.personId)) : undefined;
  return {
    id: String(m._id),
    personId: m.personId ? String(m.personId) : undefined,
    personName: who?.name,
    relationship: who?.relationship,
    visitId: m.visitId ? String(m.visitId) : undefined,
    summary: memorySummary(m),
    source: m.source,
    authorId: String(m.authorId),
    mine: String(m.authorId) === req.user!.id,
    reviewStatus: m.reviewStatus,
    consentApproved: m.consentApproved,
    version: m.version,
    createdAt: m.get('createdAt') as Date,
    editedAt: m.editedAt ?? undefined,
    ...(isCaregiver
      ? {
          approvedBy: m.approvedBy ? String(m.approvedBy) : undefined,
          history: m.history.map((h) => ({
            version: h.version,
            summary: decryptText(h.summaryEnc),
            editedBy: h.editedBy ? String(h.editedBy) : undefined,
            editedAt: h.editedAt,
          })),
        }
      : {}),
  };
};

/** Serializes several memories with "who is this about" labels. */
async function serializeAll(ms: MemoryDoc[], req: Request) {
  const labels = await personLabels(
    req.patient!._id,
    ms.map((m) => m.personId),
  );
  return ms.map((m) => serialize(m, req, labels));
}
const serializeOne = async (m: MemoryDoc, req: Request) => (await serializeAll([m], req))[0];

// ---------------------------------------------------------------- create

router.post(
  '/',
  ah(async (req, res) => {
    const isPatient = req.user!.role === 'patient';
    const body = (isPatient ? patientCreate : caregiverCreate).parse(req.body);
    const person = await loadLinks(req, body.personId, body.visitId);

    if (isPatient) {
      // Never blocked: saved immediately, reviewed later by the caregiver.
      const m = await Memory.create({
        patientId: req.patient!._id,
        personId: person?._id,
        visitId: body.visitId,
        summaryEnc: encryptText(body.summary),
        source: 'patient',
        authorId: req.user!.id,
        reviewStatus: 'pending',
        consentApproved: false,
      });
      res.status(201).json({ memory: await serializeOne(m, req) });
      return;
    }

    if (!allowsSummaries(person)) {
      throw new HttpError(
        409,
        'NO_SUMMARY_CONSENT',
        'This person has not consented to conversation summaries. Update their consent first.',
      );
    }
    const m = await Memory.create({
      patientId: req.patient!._id,
      personId: person?._id,
      visitId: body.visitId,
      summaryEnc: encryptText(body.summary),
      source: (body as z.infer<typeof caregiverCreate>).source,
      authorId: req.user!.id,
      reviewStatus: 'approved',
      consentApproved: true,
      approvedBy: req.user!.id,
    });
    await audit(req, {
      patientId: req.patient!._id,
      action: 'memory.create',
      entityType: 'memory',
      entityId: m._id,
    });
    res.status(201).json({ memory: await serializeOne(m, req) });
  }),
);

router.post(
  '/draft',
  requireRole('caregiver'),
  validate({ body: draftSchema }),
  ah(async (req, res) => {
    const { personId, notes } = req.body as z.infer<typeof draftSchema>;
    const person = await loadLinks(req, personId);
    if (!allowsSummaries(person)) {
      throw new HttpError(
        409,
        'NO_SUMMARY_CONSENT',
        'This person has not consented to conversation summaries.',
      );
    }
    const result = await draftVisitSummary(
      String(req.patient!._id),
      { firstName: firstNameOf(person!.name), relationship: person!.relationship },
      notes,
    );
    const why = (await llmStatus()).lastCall?.detail;
    res.json({
      ...result,
      message:
        result.source === 'llm'
          ? 'Please check and edit this draft before saving.'
          : result.source === 'shortened'
            ? `The AI is not available${why ? ` (${why})` : ''}, so this is only the start of your notes. Please shorten and edit it.`
            : `Automatic drafting is not available${why ? ` (${why})` : ''}. Please write the summary yourself.`,
    });
  }),
);

// ---------------------------------------------------------------- read

router.get(
  '/',
  validate({ query: listQuery }),
  ah(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const filter: Record<string, unknown> = { patientId: req.patient!._id };
    if (req.user!.role === 'patient') filter.authorId = new Types.ObjectId(req.user!.id);
    if (q.personId) filter.personId = q.personId;
    if (q.source) filter.source = q.source;
    if (q.reviewStatus) filter.reviewStatus = q.reviewStatus;
    let memories = await Memory.find(filter).sort({ createdAt: -1 }).limit(q.limit);
    // Text is encrypted, so search happens after decryption (bounded by `limit`).
    if (q.q) {
      const needle = q.q.toLowerCase();
      memories = memories.filter((m) => memorySummary(m).toLowerCase().includes(needle));
    }
    res.json({ memories: await serializeAll(memories, req) });
  }),
);

router.get(
  '/review-queue',
  requireRole('caregiver'),
  ah(async (req, res) => {
    const memories = await Memory.find({
      patientId: req.patient!._id,
      source: 'patient',
      reviewStatus: 'pending',
    }).sort({
      createdAt: 1,
    });
    res.json({ memories: await serializeAll(memories, req) });
  }),
);

router.get(
  '/:id',
  ah(async (req, res) => {
    res.json({ memory: await serializeOne(await loadMemory(req), req) });
  }),
);

// ---------------------------------------------------------------- update

router.patch(
  '/:id',
  validate({ body: updateSchema }),
  ah(async (req, res) => {
    const m = await loadMemory(req);
    const text = (req.body as z.infer<typeof updateSchema>).summary;
    newVersion(m, text, req.user!.id);
    if (req.user!.role === 'patient') {
      // A patient edit needs review again before it can be used.
      m.reviewStatus = 'pending';
      m.consentApproved = false;
    } else {
      await audit(req, {
        patientId: m.patientId,
        action: 'memory.update',
        entityType: 'memory',
        entityId: m._id,
      });
    }
    await m.save();
    res.json({ memory: await serializeOne(m, req) });
  }),
);

router.post(
  '/:id/review',
  requireRole('caregiver'),
  validate({ body: reviewSchema }),
  ah(async (req, res) => {
    const m = await loadMemory(req);
    const { action, summary: corrected } = req.body as z.infer<typeof reviewSchema>;
    const person = m.personId ? await Person.findById(m.personId) : null;

    if (action === 'flag') {
      m.reviewStatus = 'flagged';
      m.consentApproved = false;
    } else {
      // The original patient text is kept in history when corrected.
      if (action === 'correct' && corrected) newVersion(m, corrected, req.user!.id);
      m.reviewStatus = 'approved';
      m.approvedBy = new Types.ObjectId(req.user!.id);
      m.consentApproved = allowsSummaries(person);
    }
    await m.save();
    await audit(req, {
      patientId: m.patientId,
      action: `memory.review_${action}`,
      entityType: 'memory',
      entityId: m._id,
    });
    res.json({
      memory: await serializeOne(m, req),
      note:
        m.reviewStatus === 'approved' && !m.consentApproved
          ? 'Approved, but it will not be read to the patient because this person has not consented to conversation summaries.'
          : undefined,
    });
  }),
);

/**
 * "Tell me simply": an AI re-telling of one memory, for reading aloud.
 * The patient may use it on their own entries and on approved memories.
 * Only approved + consent-approved memories are ever sent to the AI; for
 * anything else the original text comes back unchanged.
 */
router.post(
  '/:id/retell',
  ah(async (req, res) => {
    if (!isObjectId(req.params.id)) throw notFound('Memory');
    const m = await Memory.findOne({ _id: req.params.id, patientId: req.patient!._id });
    const usable = m && m.reviewStatus === 'approved' && m.consentApproved;
    const visible =
      m && (req.user!.role === 'caregiver' || usable || String(m.authorId) === req.user!.id);
    if (!m || !visible) throw notFound('Memory');
    const text = memorySummary(m);
    const person = m.personId ? await Person.findById(m.personId) : null;
    if (!usable || !person || !allowsSummaries(person)) {
      res.json({
        text,
        source: 'original',
        reason: usable ? 'no_person' : 'waiting_for_review',
      });
      return;
    }
    const lang = req.patient!.preferences?.language ?? 'en';
    const result = await retellMemory(String(req.patient!._id), `${m._id}:${m.version}`, {
      firstName: firstNameOf(person.name),
      relationship: person.relationship,
      when: formatVisitDate(m.get('createdAt') as Date, lang).date,
      memory: text,
    });
    res.json({ text: result.text, source: result.source, reason: result.failure });
  }),
);

router.delete(
  '/:id',
  ah(async (req, res) => {
    const m = await loadMemory(req);
    await m.deleteOne();
    await audit(req, {
      patientId: m.patientId,
      action: 'memory.delete',
      entityType: 'memory',
      entityId: m._id,
    });
    res.status(204).end();
  }),
);

export default router;
