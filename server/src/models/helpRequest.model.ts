/**
 * helpRequests: created when the patient taps "Ask my caregiver".
 * Shown on the caregiver dashboard until resolved.
 */
import { HydratedDocument, InferSchemaType, Schema, model } from 'mongoose';

const helpRequestSchema = new Schema(
  {
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** Where the patient was when they asked, e.g. "who-is-this" */
    context: { type: String, maxlength: 40 },
    resolvedAt: { type: Date },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export type HelpRequestDoc = HydratedDocument<InferSchemaType<typeof helpRequestSchema>>;
export const HelpRequest = model('HelpRequest', helpRequestSchema);

export const serializeHelpRequest = (h: HelpRequestDoc) => ({
  id: String(h._id),
  context: h.context ?? undefined,
  createdAt: h.get('createdAt') as Date,
  resolvedAt: h.resolvedAt ?? undefined,
});
