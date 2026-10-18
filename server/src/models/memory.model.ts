/**
 * memories: conversation summaries and "remember this" entries.
 * The summary text is encrypted at rest. Only reviewStatus "approved" memories
 * are ever used as LLM context (enforced in Phase 4).
 * `history` keeps every previous version, including the original patient text
 * when a caregiver corrects it.
 */
import { HydratedDocument, InferSchemaType, Schema, model } from 'mongoose';
import { decryptText } from '../lib/crypto';

export const MEMORY_SOURCES = ['caregiver', 'ai-summary', 'patient'] as const;
export const REVIEW_STATUSES = ['pending', 'approved', 'flagged'] as const;

const versionSchema = new Schema(
  {
    version: { type: Number, required: true },
    summaryEnc: { type: String, required: true },
    editedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    editedAt: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const memorySchema = new Schema(
  {
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    personId: { type: Schema.Types.ObjectId, ref: 'Person' },
    visitId: { type: Schema.Types.ObjectId, ref: 'Visit' },
    summaryEnc: { type: String, required: true },
    source: { type: String, enum: MEMORY_SOURCES, required: true },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    consentApproved: { type: Boolean, default: false },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewStatus: { type: String, enum: REVIEW_STATUSES, default: 'pending' },
    version: { type: Number, default: 1 },
    history: { type: [versionSchema], default: [] },
    editedAt: { type: Date },
    /** Who wrote the current version (author until someone edits it). */
    lastEditedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
memorySchema.index({ patientId: 1, reviewStatus: 1 });
memorySchema.index({ personId: 1, createdAt: -1 });

export type MemoryDoc = HydratedDocument<InferSchemaType<typeof memorySchema>>;
export const Memory = model('Memory', memorySchema);

export const memorySummary = (m: { summaryEnc: string }) => decryptText(m.summaryEnc);
