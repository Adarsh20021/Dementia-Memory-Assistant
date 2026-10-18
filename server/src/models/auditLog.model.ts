/**
 * auditLogs: append-only record of security-relevant events.
 * Never contains images, embeddings, note text, tokens or API keys.
 * `patientId` is an addition to the spec so the caregiver's audit viewer
 * can be scoped to one patient.
 */
import { InferSchemaType, Schema, model } from 'mongoose';

const auditLogSchema = new Schema({
  actorId: { type: Schema.Types.ObjectId, ref: 'User' },
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient' },
  action: { type: String, required: true },
  entityType: { type: String, required: true },
  entityId: { type: Schema.Types.ObjectId },
  timestamp: { type: Date, default: () => new Date() },
  ip: { type: String },
});
auditLogSchema.index({ patientId: 1, timestamp: -1 });
auditLogSchema.index({ actorId: 1, timestamp: -1 });

export type AuditLogAttrs = InferSchemaType<typeof auditLogSchema>;
export const AuditLog = model('AuditLog', auditLogSchema);
