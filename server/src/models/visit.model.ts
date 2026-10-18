/**
 * visits: one record per recognition of a familiar person.
 * "unsure" recognitions are stored with needsConfirmation=true until the
 * caregiver confirms or rejects them; rejected/unconfirmed visits are never
 * used as context for the patient.
 */
import { HydratedDocument, InferSchemaType, Schema, model } from 'mongoose';

const visitSchema = new Schema({
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
  personId: { type: Schema.Types.ObjectId, ref: 'Person', required: true },
  timestamp: { type: Date, default: () => new Date() },
  matchConfidence: { type: Number, min: 0, max: 1 },
  outcome: { type: String, enum: ['match', 'unsure', 'manual'], default: 'match' },
  needsConfirmation: { type: Boolean, default: false },
  confirmedByCaregiver: { type: Boolean },
  confirmedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  location: { type: String, trim: true, maxlength: 100 },
});
visitSchema.index({ patientId: 1, timestamp: -1 });
visitSchema.index({ personId: 1, timestamp: -1 });

export type VisitDoc = HydratedDocument<InferSchemaType<typeof visitSchema>>;
export const Visit = model('Visit', visitSchema);

/** Visits that count as real (used for context, answers and timelines shown to the patient). */
export const trustedVisitFilter = {
  needsConfirmation: { $ne: true },
  confirmedByCaregiver: { $ne: false },
};

export const serializeVisit = (v: VisitDoc, personName?: string) => ({
  id: String(v._id),
  patientId: String(v.patientId),
  personId: String(v.personId),
  personName,
  timestamp: v.timestamp,
  matchConfidence: v.matchConfidence ?? undefined,
  outcome: v.outcome,
  needsConfirmation: v.needsConfirmation,
  confirmedByCaregiver: v.confirmedByCaregiver ?? undefined,
  location: v.location ?? undefined,
});
