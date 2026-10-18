/**
 * notes / reminders: patient-writable entries (caregivers can write them too).
 * Text is encrypted at rest because patient-written text is sensitive.
 */
import { HydratedDocument, InferSchemaType, Schema, model } from 'mongoose';
import { decryptText } from '../lib/crypto';

export const NOTE_KINDS = ['note', 'reminder'] as const;

const noteSchema = new Schema(
  {
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    personId: { type: Schema.Types.ObjectId, ref: 'Person' },
    kind: { type: String, enum: NOTE_KINDS, default: 'note' },
    textEnc: { type: String, required: true },
    dueAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    completed: { type: Boolean, default: false },
  },
  { timestamps: true },
);
noteSchema.index({ patientId: 1, createdBy: 1, createdAt: -1 });

export type NoteDoc = HydratedDocument<InferSchemaType<typeof noteSchema>>;
export const Note = model('Note', noteSchema);

export const serializeNote = (n: NoteDoc, viewerId: string) => ({
  id: String(n._id),
  patientId: String(n.patientId),
  personId: n.personId ? String(n.personId) : undefined,
  kind: n.kind,
  text: decryptText(n.textEnc),
  dueAt: n.dueAt ?? undefined,
  completed: n.completed,
  createdBy: String(n.createdBy),
  mine: String(n.createdBy) === viewerId,
  createdAt: n.get('createdAt') as Date,
  updatedAt: n.get('updatedAt') as Date,
});
