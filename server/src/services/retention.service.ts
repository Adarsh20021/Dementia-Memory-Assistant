/**
 * Data retention: deletes recognition data older than each patient's
 * retentionDays (visits, recognition events, resolved help requests).
 * Curated memories and notes are kept until a caregiver deletes them.
 * Runs at startup and every RETENTION_JOB_INTERVAL_HOURS.
 */
import { env, isTest } from '../config/env';
import { logger } from '../lib/logger';
import { HelpRequest } from '../models/helpRequest.model';
import { Memory } from '../models/memory.model';
import { Patient } from '../models/patient.model';
import { RecognitionEvent } from '../models/recognitionEvent.model';
import { Visit } from '../models/visit.model';
import { audit } from './audit.service';

export async function runRetention(now = new Date()) {
  const patients = await Patient.find().select('settings');
  const summary = { patients: patients.length, visits: 0, events: 0, helpRequests: 0 };
  for (const p of patients) {
    const days = p.settings?.retentionDays ?? 365;
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    const oldVisits = await Visit.find({ patientId: p._id, timestamp: { $lt: cutoff } }).select(
      '_id',
    );
    const ids = oldVisits.map((v) => v._id);
    if (ids.length) await Memory.updateMany({ visitId: { $in: ids } }, { $unset: { visitId: 1 } });
    const [v, e, h] = await Promise.all([
      Visit.deleteMany({ _id: { $in: ids } }),
      RecognitionEvent.deleteMany({ patientId: p._id, timestamp: { $lt: cutoff } }),
      HelpRequest.deleteMany({ patientId: p._id, resolvedAt: { $lt: cutoff } }),
    ]);
    const removed = v.deletedCount + e.deletedCount + h.deletedCount;
    summary.visits += v.deletedCount;
    summary.events += e.deletedCount;
    summary.helpRequests += h.deletedCount;
    if (removed) {
      await audit(undefined, {
        patientId: p._id,
        action: 'retention.purge',
        entityType: 'patient',
        entityId: p._id,
      });
    }
  }
  return summary;
}

export function scheduleRetention(): NodeJS.Timeout | null {
  if (isTest) return null;
  const run = () =>
    runRetention()
      .then((s) => logger.info(s, 'Retention job finished'))
      .catch((err) => logger.error({ err }, 'Retention job failed'));
  void run();
  const timer = setInterval(run, env.RETENTION_JOB_INTERVAL_HOURS * 3_600_000);
  timer.unref();
  return timer;
}
