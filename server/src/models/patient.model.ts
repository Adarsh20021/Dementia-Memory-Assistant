/**
 * patients: the person living with dementia. Owned by one or more caregivers.
 * `patientUserId` is the device-user the patient signs in as (role "patient").
 */
import { HydratedDocument, InferSchemaType, Schema, model } from 'mongoose';

const patientSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    dob: { type: Date },
    caregiverIds: [{ type: Schema.Types.ObjectId, ref: 'User', index: true }],
    patientUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    preferences: {
      language: { type: String, default: 'en', maxlength: 10 },
      fontScale: { type: Number, default: 1.25, min: 1, max: 2.5 },
      voiceRate: { type: Number, default: 0.9, min: 0.5, max: 1.5 },
    },
    /** Optional patient PIN (4–6 digits), hashed with argon2. Never returned by the API. */
    pin: {
      hash: { type: String, select: false },
      failedCount: { type: Number, default: 0, select: false },
      lockedUntil: { type: Date, select: false },
      setAt: { type: Date },
    },
    settings: {
      /** How long visit records / recognition data are kept (auto-delete job arrives in Phase 6). */
      retentionDays: { type: Number, default: 365, min: 1, max: 3650 },
    },
  },
  { timestamps: true },
);

export type PatientDoc = HydratedDocument<InferSchemaType<typeof patientSchema>>;
export const Patient = model('Patient', patientSchema);

export const serializePatient = (p: PatientDoc) => ({
  id: String(p._id),
  name: p.name,
  dob: p.dob ?? undefined,
  preferences: {
    language: p.preferences?.language ?? 'en',
    fontScale: p.preferences?.fontScale ?? 1.25,
    voiceRate: p.preferences?.voiceRate ?? 0.9,
  },
  settings: { retentionDays: p.settings?.retentionDays ?? 365 },
  pinEnabled: Boolean(p.pin?.setAt),
  createdAt: p.get('createdAt') as Date,
});
