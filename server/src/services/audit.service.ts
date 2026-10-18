/**
 * Writes security-relevant events to the auditLogs collection.
 * Audit failures are logged but never break the user's request.
 */
import type { Request } from 'express';
import { Types } from 'mongoose';
import { AuditLog } from '../models/auditLog.model';
import { logger } from '../lib/logger';

type Id = string | Types.ObjectId | null | undefined;

export interface AuditEntry {
  action: string; // e.g. "consent.revoke"
  entityType: string; // e.g. "person"
  entityId?: Id;
  patientId?: Id;
  /** Defaults to the authenticated user on the request. */
  actorId?: Id;
}

export async function audit(req: Request | undefined, entry: AuditEntry): Promise<void> {
  try {
    await AuditLog.create({
      actorId: entry.actorId ?? req?.user?.id,
      patientId: entry.patientId ?? undefined,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? undefined,
      ip: req?.ip,
    });
  } catch (err) {
    logger.error({ err, action: entry.action }, 'Failed to write audit log');
  }
}
