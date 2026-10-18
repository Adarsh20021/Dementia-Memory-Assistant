/**
 * Caregiver dashboard + evaluation routes under /api/patients/:patientId
 * (caregiver only, ownership-checked per route):
 *
 *   GET  /overview                    dashboard summary
 *   GET  /export                      all of this patient's data as JSON (right to access)
 *   GET  /help-requests               ?open=true
 *   POST /help-requests/:id/resolve
 *   GET  /evaluation/summary          latency, outcomes, LLM vs fallback (for the report)
 *   GET  /evaluation/events.csv       per-recognition log (CSV)
 *   GET  /sus                         SUS questionnaire items + responses + mean score
 *   POST /sus                         record one SUS response
 */
import { ScheduledVisit, serializeScheduledVisit } from '../models/scheduledVisit.model';
import { RefreshToken } from '../models/session.model';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { decryptText } from '../lib/crypto';
import { ah, isObjectId, notFound } from '../lib/http';
import { caregiverOfPatient } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { AuditLog } from '../models/auditLog.model';
import { HelpRequest, serializeHelpRequest } from '../models/helpRequest.model';
import { Memory, memorySummary } from '../models/memory.model';
import { Note } from '../models/note.model';
import { serializePatient } from '../models/patient.model';
import { Person, serializePerson } from '../models/person.model';
import { RecognitionEvent } from '../models/recognitionEvent.model';
import { SUS_ITEMS, SusResponse, susScore } from '../models/susResponse.model';
import { Visit, serializeVisit } from '../models/visit.model';
import { audit } from '../services/audit.service';
import { MIN_RECOMMENDED_PHOTOS } from './people.routes';

const router = Router({ mergeParams: true });

const quantile = (xs: number[], q: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round(s[lo] + (s[hi] - s[lo]) * (pos - lo));
};
const stats = (xs: number[]) => ({
  n: xs.length,
  p50: quantile(xs, 0.5),
  p95: quantile(xs, 0.95),
  max: xs.length ? Math.max(...xs) : null,
});

// ---------------------------------------------------------------- overview

router.get(
  '/overview',
  ...caregiverOfPatient,
  ah(async (req, res) => {
    const patientId = req.patient!._id;
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [people, events, unsureVisits, pendingReviews, openHelp] = await Promise.all([
      Person.find({ patientId }),
      RecognitionEvent.find({ patientId }).sort({ timestamp: -1 }).limit(200),
      Visit.find({ patientId, needsConfirmation: true }).sort({ timestamp: -1 }).limit(20),
      Memory.find({ patientId, source: 'patient', reviewStatus: 'pending' })
        .sort({ createdAt: -1 })
        .limit(5),
      HelpRequest.find({ patientId, resolvedAt: { $exists: false } }).sort({ createdAt: -1 }),
    ]);
    const pendingReviewCount = await Memory.countDocuments({
      patientId,
      source: 'patient',
      reviewStatus: 'pending',
    });
    const names = new Map(people.map((p) => [String(p._id), p.name]));
    const [upcoming, deviceSignedIn, plannedTotal, memoriesTotal] = await Promise.all([
      ScheduledVisit.find({
        patientId,
        status: 'scheduled',
        startsAt: { $gte: new Date(Date.now() - 2 * 3_600_000) },
      })
        .sort({ startsAt: 1 })
        .limit(5),
      req.patient!.patientUserId
        ? RefreshToken.exists({ userId: req.patient!.patientUserId })
        : null,
      ScheduledVisit.countDocuments({ patientId }),
      Memory.countDocuments({ patientId }),
    ]);

    // People who are often "unsure" or have low median scores -> suggest re-enrolling photos.
    const recent = events.filter((e) => e.timestamp >= since && e.personId);
    const lowConfidence = people
      .map((p) => {
        const mine = recent.filter((e) => String(e.personId) === String(p._id));
        const scores = mine.map((e) => e.score).filter((s): s is number => typeof s === 'number');
        const unsure = mine.filter((e) => e.outcome === 'unsure').length;
        const median = quantile(
          scores.map((s) => s * 1000),
          0.5,
        );
        return {
          personId: String(p._id),
          name: p.name,
          recognitions: mine.length,
          unsureCount: unsure,
          medianScore: median === null ? null : median / 1000,
          photoCount: p.photos.length,
        };
      })
      .filter(
        (x) =>
          x.unsureCount >= 2 ||
          (x.medianScore !== null && x.medianScore < env.MATCH_THRESHOLD + 0.05) ||
          (x.photoCount > 0 && x.photoCount < MIN_RECOMMENDED_PHOTOS),
      );

    res.json({
      patient: serializePatient(req.patient!),
      counts: {
        people: people.length,
        enrolled: people.filter((p) => p.embeddings.length > 0).length,
        pendingReviews: pendingReviewCount,
        unsureVisits: unsureVisits.length,
        openHelpRequests: openHelp.length,
      },
      recentEvents: events.slice(0, 10).map((e) => ({
        id: String(e._id),
        timestamp: e.timestamp,
        outcome: e.outcome,
        score: e.score ?? undefined,
        personName: e.personId ? names.get(String(e.personId)) : undefined,
        summarySource: e.summarySource ?? undefined,
      })),
      unsureVisits: unsureVisits.map((v) => serializeVisit(v, names.get(String(v.personId)))),
      pendingReviews: pendingReviews.map((m) => ({
        id: String(m._id),
        summary: memorySummary(m),
        personName: m.personId ? names.get(String(m.personId)) : undefined,
        createdAt: m.get('createdAt') as Date,
      })),
      openHelpRequests: openHelp.map(serializeHelpRequest),
      upcomingVisits: upcoming.map((v) =>
        serializeScheduledVisit(
          v,
          req.user!.id,
          v.personId && names.get(String(v.personId))
            ? {
                name: names.get(String(v.personId))!.split(/\s+/)[0],
                relationship: people.find((p) => String(p._id) === String(v.personId))!
                  .relationship,
              }
            : undefined,
        ),
      ),
      /** "Getting started" checklist for new caregivers. */
      setup: {
        addedPerson: people.length > 0,
        addedPhotos: people.some((p) => p.embeddings.length > 0),
        deviceReady: Boolean(deviceSignedIn) || Boolean(req.patient!.pin?.setAt),
        plannedVisit: plannedTotal > 0,
        addedMemory: memoriesTotal > 0,
      },
      lowConfidence,
      thresholds: { match: env.MATCH_THRESHOLD, unsure: env.UNSURE_THRESHOLD },
    });
  }),
);

// ---------------------------------------------------------------- export

router.get(
  '/export',
  ...caregiverOfPatient,
  ah(async (req, res) => {
    const patientId = req.patient!._id;
    const [people, visits, memories, notes, help, sus, auditLogs, planned] = await Promise.all([
      Person.find({ patientId }),
      Visit.find({ patientId }).sort({ timestamp: -1 }),
      Memory.find({ patientId }).sort({ createdAt: -1 }),
      Note.find({ patientId }).sort({ createdAt: -1 }),
      HelpRequest.find({ patientId }),
      SusResponse.find({ patientId }).lean(),
      AuditLog.find({ patientId }).sort({ timestamp: -1 }).limit(5000).lean(),
      ScheduledVisit.find({ patientId }).sort({ startsAt: -1 }),
    ]);
    const data = {
      exportedAt: new Date(),
      notice:
        'Face photos and face embeddings are not included: they are biometric data used only for recognition. ' +
        'They can be deleted at any time by revoking consent.',
      patient: serializePatient(req.patient!),
      people: people.map((p) => {
        const s = serializePerson(p);
        return { ...s, photos: undefined };
      }),
      visits: visits.map((v) => serializeVisit(v)),
      memories: memories.map((m) => ({
        id: String(m._id),
        personId: m.personId ? String(m.personId) : undefined,
        visitId: m.visitId ? String(m.visitId) : undefined,
        summary: memorySummary(m),
        source: m.source,
        reviewStatus: m.reviewStatus,
        version: m.version,
        createdAt: m.get('createdAt'),
        history: m.history.map((h) => ({
          version: h.version,
          summary: decryptText(h.summaryEnc),
          editedAt: h.editedAt,
        })),
      })),
      notes: notes.map((n) => ({
        id: String(n._id),
        kind: n.kind,
        text: decryptText(n.textEnc),
        dueAt: n.dueAt,
        completed: n.completed,
        createdBy: String(n.createdBy),
        createdAt: n.get('createdAt'),
      })),
      scheduledVisits: planned.map((v) => ({
        id: String(v._id),
        personId: v.personId ? String(v.personId) : undefined,
        visitorName: v.visitorName,
        startsAt: v.startsAt,
        durationMin: v.durationMin,
        note: v.noteEnc ? decryptText(v.noteEnc) : undefined,
        status: v.status,
        createdByRole: v.createdByRole,
      })),
      helpRequests: help.map(serializeHelpRequest),
      susResponses: sus.map((r) => ({
        respondentRole: r.respondentRole,
        answers: r.answers,
        score: r.score,
      })),
      auditLog: auditLogs.map((l) => ({
        action: l.action,
        entityType: l.entityType,
        timestamp: l.timestamp,
      })),
    };
    await audit(req, {
      patientId,
      action: 'patient.export',
      entityType: 'patient',
      entityId: patientId,
    });
    res.setHeader('Content-Disposition', `attachment; filename="patient-${patientId}-export.json"`);
    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  }),
);

// ---------------------------------------------------------------- help requests

router.get(
  '/help-requests',
  ...caregiverOfPatient,
  validate({ query: z.object({ open: z.enum(['true', 'false']).optional() }) }),
  ah(async (req, res) => {
    const filter: Record<string, unknown> = { patientId: req.patient!._id };
    if (req.query.open === 'true') filter.resolvedAt = { $exists: false };
    const list = await HelpRequest.find(filter).sort({ createdAt: -1 }).limit(100);
    res.json({ helpRequests: list.map(serializeHelpRequest) });
  }),
);

router.post(
  '/help-requests/:id/resolve',
  ...caregiverOfPatient,
  ah(async (req, res) => {
    if (!isObjectId(req.params.id)) throw notFound('Request');
    const h = await HelpRequest.findOne({ _id: req.params.id, patientId: req.patient!._id });
    if (!h) throw notFound('Request');
    h.resolvedAt = new Date();
    h.set('resolvedBy', req.user!.id);
    await h.save();
    res.json({ helpRequest: serializeHelpRequest(h) });
  }),
);

// ---------------------------------------------------------------- evaluation

router.get(
  '/evaluation/summary',
  ...caregiverOfPatient,
  ah(async (req, res) => {
    const events = await RecognitionEvent.find({ patientId: req.patient!._id })
      .sort({ timestamp: -1 })
      .limit(5000)
      .lean();
    const pick = (k: string) =>
      events
        .map((e) => (e.timings as Record<string, number | undefined> | undefined)?.[k])
        .filter((v): v is number => typeof v === 'number');
    const outcomes: Record<string, number> = {};
    for (const e of events) outcomes[e.outcome] = (outcomes[e.outcome] ?? 0) + 1;
    const spoken = events.filter((e) => e.outcome === 'match');
    const bySource: Record<string, number> = {};
    for (const e of spoken)
      bySource[e.summarySource ?? 'none'] = (bySource[e.summarySource ?? 'none'] ?? 0) + 1;
    const endToEnd = pick('endToEndMs');
    res.json({
      events: events.length,
      outcomes,
      latencyMs: {
        serverTotal: stats(pick('serverTotalMs')),
        faceService: stats(pick('faceServiceMs')),
        llm: stats(pick('llmMs')),
        capture: stats(pick('captureMs')),
        clientRoundTrip: stats(pick('clientRoundTripMs')),
        resultToSpeech: stats(pick('resultToSpeechMs')),
        endToEnd: stats(endToEnd),
      },
      targetMs: 3000,
      underTargetRate: endToEnd.length
        ? endToEnd.filter((x) => x < 3000).length / endToEnd.length
        : null,
      summarySources: bySource,
      llmFallbackRate: spoken.length ? (bySource.fallback ?? 0) / spoken.length : null,
    });
  }),
);

const csvCell = (v: unknown) => {
  const s = v === undefined || v === null ? '' : v instanceof Date ? v.toISOString() : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

router.get(
  '/evaluation/events.csv',
  ...caregiverOfPatient,
  ah(async (req, res) => {
    const events = await RecognitionEvent.find({ patientId: req.patient!._id })
      .sort({ timestamp: 1 })
      .limit(20000)
      .lean();
    const cols = [
      'timestamp',
      'outcome',
      'score',
      'votes',
      'framesTotal',
      'framesWithFace',
      'yawRange',
      'candidates',
      'summarySource',
      'faceServiceMs',
      'llmMs',
      'serverTotalMs',
      'captureMs',
      'clientRoundTripMs',
      'resultToSpeechMs',
      'endToEndMs',
    ];
    const rows = events.map((e) => {
      const t = (e.timings ?? {}) as Record<string, unknown>;
      return [
        e.timestamp,
        e.outcome,
        e.score,
        e.votes,
        e.framesTotal,
        e.framesWithFace,
        e.yawRange,
        e.candidates,
        e.summarySource,
        t.faceServiceMs,
        t.llmMs,
        t.serverTotalMs,
        t.captureMs,
        t.clientRoundTripMs,
        t.resultToSpeechMs,
        t.endToEndMs,
      ]
        .map(csvCell)
        .join(',');
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="recognition-events.csv"');
    res.send([cols.join(','), ...rows].join('\n'));
  }),
);

// ---------------------------------------------------------------- SUS

const susSchema = z
  .object({
    respondentRole: z.enum(['caregiver', 'patient', 'family', 'other']),
    answers: z.array(z.number().int().min(1).max(5)).length(10),
    comment: z.string().trim().max(1000).optional(),
  })
  .strict();

router.get(
  '/sus',
  ...caregiverOfPatient,
  ah(async (req, res) => {
    const list = await SusResponse.find({ patientId: req.patient!._id })
      .sort({ createdAt: -1 })
      .lean();
    const mean = list.length ? list.reduce((a, r) => a + r.score, 0) / list.length : null;
    res.json({
      items: SUS_ITEMS,
      responses: list.map((r) => ({
        id: String(r._id),
        respondentRole: r.respondentRole,
        answers: r.answers,
        score: r.score,
        comment: r.comment,
        createdAt: r.createdAt,
      })),
      meanScore: mean === null ? null : Math.round(mean * 10) / 10,
    });
  }),
);

router.post(
  '/sus',
  ...caregiverOfPatient,
  validate({ body: susSchema }),
  ah(async (req, res) => {
    const body = req.body as z.infer<typeof susSchema>;
    const r = await SusResponse.create({
      patientId: req.patient!._id,
      recordedBy: req.user!.id,
      respondentRole: body.respondentRole,
      answers: body.answers,
      score: susScore(body.answers),
      comment: body.comment,
    });
    res.status(201).json({ id: String(r._id), score: r.score });
  }),
);

export default router;
