/**
 * scheduledVisits: planned visits ("Priya is coming on Saturday at 4 pm").
 * Both the caregiver and the patient can add them. The optional note is
 * encrypted at rest like other free text.
 */
import { HydratedDocument, InferSchemaType, Schema, model } from 'mongoose';
import { decryptText } from '../lib/crypto';

export const SCHEDULE_STATUSES = ['scheduled', 'cancelled', 'done'] as const;

const scheduledVisitSchema = new Schema(
  {
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    /** A familiar person, when the visitor is one of them. */
    personId: { type: Schema.Types.ObjectId, ref: 'Person' },
    /** Free-text visitor (e.g. "Nurse Meera") when not a registered person. */
    visitorName: { type: String, trim: true, maxlength: 80 },
    startsAt: { type: Date, required: true },
    durationMin: { type: Number, min: 5, max: 24 * 60 },
    noteEnc: { type: String },
    status: { type: String, enum: SCHEDULE_STATUSES, default: 'scheduled' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByRole: { type: String, enum: ['caregiver', 'patient'], required: true },
  },
  { timestamps: true },
);
scheduledVisitSchema.index({ patientId: 1, startsAt: 1 });
scheduledVisitSchema.index({ personId: 1, startsAt: 1 });

export type ScheduledVisitDoc = HydratedDocument<InferSchemaType<typeof scheduledVisitSchema>>;
export const ScheduledVisit = model('ScheduledVisit', scheduledVisitSchema);

export const serializeScheduledVisit = (
  v: ScheduledVisitDoc,
  viewerId: string,
  person?: { name: string; relationship: string },
) => ({
  id: String(v._id),
  personId: v.personId ? String(v.personId) : undefined,
  personName: person?.name,
  relationship: person?.relationship,
  visitorName: v.visitorName ?? undefined,
  /** What to show: the person's first name, or the free-text visitor. */
  who: person?.name ?? v.visitorName ?? 'A visitor',
  startsAt: v.startsAt,
  durationMin: v.durationMin ?? undefined,
  note: v.noteEnc ? decryptText(v.noteEnc) : undefined,
  status: v.status,
  createdByRole: v.createdByRole,
  mine: String(v.createdBy) === viewerId,
  createdAt: v.get('createdAt') as Date,
});
