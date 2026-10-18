/**
 * Patient-facing routes under /api/patients/:patientId (patient OR caregiver,
 * ownership-checked per route):
 *
 *   POST /recognize                   "Who is this?" — multipart field "frames" (camera frames)
 *   POST /recognitions/:eventId/timing  client-side latency report (evaluation harness)
 *   GET  /faces/:personId/photo       photo for the result card (consented people only)
 *   POST /ask                         simple questions, answered from the database
 *   POST /help-requests               "Ask my caregiver"
 *
 * Camera frames are processed in memory and discarded — never stored or logged.
 */
import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { env, isTest } from '../config/env';
import { ah, isObjectId, notFound } from '../lib/http';
import { logger } from '../lib/logger';
import { patientOrCaregiver } from '../middleware/auth';
import { imageUpload } from '../middleware/upload';
import { validate } from '../middleware/validate';
import { HelpRequest } from '../models/helpRequest.model';
import { Person, hasActiveConsent, type PersonDoc } from '../models/person.model';
import { RecognitionEvent } from '../models/recognitionEvent.model';
import { Visit, trustedVisitFilter } from '../models/visit.model';
import { Types } from 'mongoose';
import { Memory, memorySummary } from '../models/memory.model';
import { ScheduledVisit } from '../models/scheduledVisit.model';
import {
  answerFact,
  parseQuestion,
  whenPlanned,
  type AskPerson,
  type AskPlanned,
} from '../services/ask.service';
import { directory, personLabels } from '../services/people.service';
import { buildPersonContext, firstNameOf, formatVisitDate } from '../services/context.service';
import { decide, type DecisionConfig } from '../services/decision.service';
import { decryptEmbedding } from '../services/embedding.service';
import { faceClient } from '../services/faceClient.service';
import { readPhoto } from '../services/photoStorage.service';
import {
  LIVENESS_MESSAGE,
  NO_FACE_MESSAGE,
  UNKNOWN_MESSAGE,
  patientSummary,
  phraseAnswer,
  unsureMessage,
  type SummarySource,
} from '../services/summary.service';

const router = Router({ mergeParams: true });

const decisionConfig = (): DecisionConfig => ({
  matchThreshold: env.MATCH_THRESHOLD,
  unsureThreshold: env.UNSURE_THRESHOLD,
  framesRequired: env.RECOG_FRAMES_REQUIRED,
  margin: env.RECOG_MARGIN,
  livenessMode: env.LIVENESS_MODE,
  livenessMinYawRange: env.LIVENESS_MIN_YAW_RANGE,
});

/** People whose consent allows recognition and who have enrolled faces. */
async function recognizablePeople(patientId: unknown): Promise<PersonDoc[]> {
  const people = await Person.find({ patientId, isActive: true });
  return people.filter(
    (p) =>
      hasActiveConsent(p) &&
      (p.consent?.scope ?? []).includes('recognition') &&
      p.embeddings.length > 0,
  );
}

const recognizeLimiter = isTest
  ? []
  : [rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false })];

router.post(
  '/recognize',
  ...patientOrCaregiver,
  ...recognizeLimiter,
  ...imageUpload('frames', 8, 1.5 * 1024 * 1024),
  ah(async (req, res) => {
    const started = Date.now();
    const patient = req.patient!;
    const frames = (req.files as Express.Multer.File[]).map((f) => f.buffer);
    const lang = patient.preferences?.language ?? 'en';

    const people = await recognizablePeople(patient._id);
    const event = new RecognitionEvent({
      patientId: patient._id,
      candidates: people.length,
      framesTotal: frames.length,
    });

    if (!people.length) {
      event.outcome = 'unknown';
      event.summarySource = 'none';
      event.set('timings.serverTotalMs', Date.now() - started);
      await event.save();
      res.json({
        eventId: String(event._id),
        outcome: 'unknown',
        message: 'No familiar people have been set up yet. Please ask your caregiver.',
      });
      return;
    }

    const candidates = people.map((p) => ({
      id: String(p._id),
      embeddings: p.embeddings.map((e) => decryptEmbedding(e.enc as string)),
    }));

    let analysis;
    const faceStarted = Date.now();
    try {
      analysis = await faceClient.analyze(frames, candidates);
    } catch (err) {
      event.outcome = 'error';
      event.set('timings.serverTotalMs', Date.now() - started);
      await event.save().catch(() => undefined);
      throw err;
    } finally {
      frames.length = 0; // drop references to the frames as early as possible
    }
    const faceServiceMs = Date.now() - faceStarted;
    const decision = decide(analysis.frames, decisionConfig());

    event.set({
      outcome: decision.outcome,
      score: decision.score,
      votes: decision.votes,
      framesWithFace: decision.framesWithFace,
      yawRange: decision.liveness.yawRange ?? undefined,
      'timings.faceServiceMs': faceServiceMs,
    });

    const response: Record<string, unknown> = { outcome: decision.outcome };
    let summarySource: SummarySource | 'none' = 'none';

    if ((decision.outcome === 'match' || decision.outcome === 'unsure') && decision.personId) {
      const person = people.find((p) => String(p._id) === decision.personId)!;
      const firstName = firstNameOf(person.name);
      const visit = await recordVisit(person, decision.score!, decision.outcome);
      event.personId = person._id;
      event.visitId = visit._id;
      response.person = {
        id: String(person._id),
        name: firstName,
        relationship: person.relationship,
        photoUrl: person.photos.length
          ? `/api/patients/${patient._id}/faces/${person._id}/photo`
          : null,
      };
      response.visitId = String(visit._id);
      response.score = decision.score;

      if (decision.outcome === 'match') {
        const ctx = await buildPersonContext(person, { excludeVisitId: visit._id, lang });
        const summary = await patientSummary(String(person._id), String(patient._id), ctx);
        summarySource = summary.source;
        response.message = summary.text;
        if (summary.llmMs !== undefined) event.set('timings.llmMs', summary.llmMs);
        if (summary.failure) logger.debug({ failure: summary.failure }, 'Summary fallback used');
      } else {
        response.message = unsureMessage(firstName);
        response.needsCaregiverConfirmation = true;
      }
    } else if (decision.outcome === 'no_face') {
      response.message = NO_FACE_MESSAGE;
    } else if (decision.outcome === 'liveness_failed') {
      response.message = LIVENESS_MESSAGE;
    } else {
      response.message = UNKNOWN_MESSAGE;
    }

    event.summarySource = summarySource;
    event.set('timings.serverTotalMs', Date.now() - started);
    await event.save();
    res.json({ eventId: String(event._id), ...response });
  }),
);

/** Creates a visit, or updates the recent one for the same person (dedup window). */
async function recordVisit(person: PersonDoc, score: number, outcome: 'match' | 'unsure') {
  const since = new Date(Date.now() - env.VISIT_DEDUP_MIN * 60_000);
  const recent = await Visit.findOne({
    patientId: person.patientId,
    personId: person._id,
    timestamp: { $gte: since },
  }).sort({ timestamp: -1 });
  if (recent) {
    if (outcome === 'match' && recent.needsConfirmation) {
      recent.needsConfirmation = false; // a confident match settles an earlier "unsure"
      recent.outcome = 'match';
    }
    recent.matchConfidence = Math.max(recent.matchConfidence ?? 0, score);
    await recent.save();
    return recent;
  }
  return Visit.create({
    patientId: person.patientId,
    personId: person._id,
    matchConfidence: score,
    outcome,
    needsConfirmation: outcome === 'unsure',
  });
}

const timingSchema = z
  .object({
    captureMs: z.number().min(0).max(120_000),
    clientRoundTripMs: z.number().min(0).max(120_000),
    resultToSpeechMs: z.number().min(0).max(120_000),
    endToEndMs: z.number().min(0).max(240_000),
  })
  .partial()
  .strict();

router.post(
  '/recognitions/:eventId/timing',
  ...patientOrCaregiver,
  validate({ body: timingSchema }),
  ah(async (req, res) => {
    if (!isObjectId(req.params.eventId)) throw notFound('Recognition');
    const updates = Object.fromEntries(
      Object.entries(req.body as z.infer<typeof timingSchema>).map(([k, v]) => [`timings.${k}`, v]),
    );
    const r = await RecognitionEvent.updateOne(
      { _id: req.params.eventId, patientId: req.patient!._id },
      { $set: updates },
    );
    if (!r.matchedCount) throw notFound('Recognition');
    res.status(204).end();
  }),
);

router.get(
  '/faces/:personId/photo',
  ...patientOrCaregiver,
  ah(async (req, res) => {
    if (!isObjectId(req.params.personId)) throw notFound('Photo');
    const person = await Person.findOne({ _id: req.params.personId, patientId: req.patient!._id });
    if (!person || !hasActiveConsent(person) || !person.photos.length) throw notFound('Photo');
    const photo = person.photos[0];
    res.setHeader('Cache-Control', 'private, no-store');
    res.type(photo.mimeType).send(await readPhoto(photo.storageKey));
  }),
);

const askSchema = z.object({ question: z.string().trim().min(2).max(300) }).strict();

router.post(
  '/ask',
  ...patientOrCaregiver,
  validate({ body: askSchema }),
  ah(async (req, res) => {
    const patient = req.patient!;
    const { question } = req.body as z.infer<typeof askSchema>;
    const people = (await Person.find({ patientId: patient._id, isActive: true })).filter(
      hasActiveConsent,
    );
    const askPeople: AskPerson[] = people.map((p) => ({
      id: String(p._id),
      name: p.name,
      relationship: p.relationship,
      canShareVisits: (p.consent?.scope ?? []).includes('visit-history'),
    }));
    const intent = parseQuestion(question, askPeople);
    const since = new Date(Date.now() - 365 * 86_400_000);
    const visits =
      intent.kind === 'last_visit' || intent.kind === 'visitors'
        ? (
            await Visit.find({
              patientId: patient._id,
              timestamp: { $gte: since },
              ...trustedVisitFilter,
            })
              .sort({ timestamp: -1 })
              .limit(500)
              .lean()
          ).map((v) => ({ personId: String(v.personId), timestamp: v.timestamp as Date }))
        : [];
    const planned =
      intent.kind === 'next_visit' || intent.kind === 'upcoming'
        ? await plannedVisits(patient._id)
        : [];
    const lang = patient.preferences?.language ?? 'en';
    const { fact, found } = answerFact(intent, { visits, people: askPeople, planned, lang });
    if (!found) {
      res.json({ answer: fact, source: 'database', found: false });
      return;
    }

    // The answer (from the database) is always shown. The AI adds a short summary:
    // for a question about one person, a summary of what we know about them
    // (approved memories + visits); otherwise a gentle re-phrasing of the answer.
    const aboutPerson =
      intent.kind === 'who_is' || intent.kind === 'last_visit' || intent.kind === 'next_visit'
        ? people.find((p) => String(p._id) === intent.person.id)
        : undefined;
    let summary: { text: string; source: string } | null = null;
    if (aboutPerson) {
      const ctx = await buildPersonContext(aboutPerson, { lang });
      const s = await patientSummary(
        String(aboutPerson._id),
        String(patient._id),
        ctx,
        env.LLM_ASK_TIMEOUT_MS,
      );
      if (s.source !== 'fallback') summary = { text: s.text, source: 'llm' };
    } else {
      const p = await phraseAnswer(String(patient._id), question, fact, env.LLM_ASK_TIMEOUT_MS);
      if (p.source === 'llm' && p.text !== fact) summary = { text: p.text, source: 'llm' };
    }
    res.json({
      answer: fact,
      summary: summary?.text,
      summarySource: summary ? 'llm' : 'none',
      source: 'database',
      found: true,
      personId: aboutPerson ? String(aboutPerson._id) : undefined,
    });
  }),
);

/** Upcoming planned visits, labelled, for questions like "Who is coming tomorrow?". */
async function plannedVisits(patientId: Types.ObjectId): Promise<AskPlanned[]> {
  const rows = await ScheduledVisit.find({
    patientId,
    status: 'scheduled',
    startsAt: { $gte: new Date(Date.now() - 2 * 3_600_000) },
  })
    .sort({ startsAt: 1 })
    .limit(100);
  const labels = await personLabels(
    patientId,
    rows.map((r) => r.personId),
  );
  return rows.map((r) => ({
    personId: r.personId ? String(r.personId) : undefined,
    who: (r.personId && labels.get(String(r.personId))?.name) || r.visitorName || 'A visitor',
    startsAt: r.startsAt,
  }));
}

/** People the patient can pick from (first name + relationship only). */
router.get(
  '/people-directory',
  ...patientOrCaregiver,
  ah(async (req, res) => {
    res.json({ people: await directory(req.patient!._id) });
  }),
);

/**
 * Everything the patient may see about one person, newest first:
 *   - visits (only with "visit-history" consent)
 *   - memories: approved + consent-approved ones, plus the patient's own
 *     entries (shown with their review status)
 *   - the next planned visit
 * Caregivers get the same view (it is what the patient sees).
 */
router.get(
  '/story/:personId',
  ...patientOrCaregiver,
  ah(async (req, res) => {
    const patient = req.patient!;
    if (!isObjectId(req.params.personId)) throw notFound('Person');
    const person = await Person.findOne({
      _id: req.params.personId,
      patientId: patient._id,
      isActive: true,
    });
    if (!person || !hasActiveConsent(person)) throw notFound('Person');
    const scope = person.consent?.scope ?? [];
    const lang = patient.preferences?.language ?? 'en';

    const visits = scope.includes('visit-history')
      ? await Visit.find({ patientId: patient._id, personId: person._id, ...trustedVisitFilter })
          .sort({ timestamp: -1 })
          .limit(20)
          .lean()
      : [];

    const memoryFilter: Record<string, unknown>[] = [];
    if (scope.includes('conversation-summaries'))
      memoryFilter.push({ reviewStatus: 'approved', consentApproved: true });
    if (req.user!.role === 'patient')
      memoryFilter.push({
        authorId: new Types.ObjectId(req.user!.id),
        reviewStatus: { $ne: 'flagged' },
      });
    const memories = memoryFilter.length
      ? await Memory.find({ patientId: patient._id, personId: person._id, $or: memoryFilter })
          .sort({ createdAt: -1 })
          .limit(50)
      : [];

    const next = await ScheduledVisit.findOne({
      patientId: patient._id,
      personId: person._id,
      status: 'scheduled',
      startsAt: { $gte: new Date(Date.now() - 2 * 3_600_000) },
    }).sort({ startsAt: 1 });

    res.json({
      person: {
        id: String(person._id),
        name: firstNameOf(person.name),
        relationship: person.relationship,
        photoUrl: person.photos.length
          ? `/api/patients/${patient._id}/faces/${person._id}/photo`
          : null,
      },
      nextVisit: next
        ? { id: String(next._id), startsAt: next.startsAt, when: whenPlanned(next.startsAt, lang) }
        : null,
      visits: visits.map((v) => ({
        id: String(v._id),
        timestamp: v.timestamp,
        date: formatVisitDate(v.timestamp as Date, lang).date,
      })),
      memories: memories.map((m) => ({
        id: String(m._id),
        summary: memorySummary(m),
        source: m.source,
        mine: String(m.authorId) === req.user!.id,
        reviewStatus: m.reviewStatus,
        /** Only these may be re-told by the AI. */
        canRetell: m.reviewStatus === 'approved' && m.consentApproved,
        createdAt: m.get('createdAt') as Date,
        date: formatVisitDate(m.get('createdAt') as Date, lang).date,
      })),
    });
  }),
);

const helpSchema = z.object({ context: z.string().trim().max(40).optional() }).strict();

router.post(
  '/help-requests',
  ...patientOrCaregiver,
  validate({ body: helpSchema }),
  ah(async (req, res) => {
    const patient = req.patient!;
    // One open request is enough; repeated taps within 10 minutes reuse it.
    const recent = await HelpRequest.findOne({
      patientId: patient._id,
      resolvedAt: { $exists: false },
      createdAt: { $gte: new Date(Date.now() - 10 * 60_000) },
    });
    if (!recent) {
      await HelpRequest.create({
        patientId: patient._id,
        createdBy: req.user!.id,
        context: (req.body as z.infer<typeof helpSchema>).context,
      });
    }
    res.status(201).json({ message: "I've let your caregiver know. They will come to help you." });
  }),
);

export default router;
