/**
 * susResponses: System Usability Scale questionnaires (10 items, 1-5 Likert)
 * for the project's usability evaluation.
 */
import { InferSchemaType, Schema, model } from 'mongoose';

export const SUS_ITEMS = [
  'I think that I would like to use this system frequently.',
  'I found the system unnecessarily complex.',
  'I thought the system was easy to use.',
  'I think that I would need the support of a technical person to be able to use this system.',
  'I found the various functions in this system were well integrated.',
  'I thought there was too much inconsistency in this system.',
  'I would imagine that most people would learn to use this system very quickly.',
  'I found the system very cumbersome to use.',
  'I felt very confident using the system.',
  'I needed to learn a lot of things before I could get going with this system.',
] as const;

/** Standard SUS scoring: odd items (score-1), even items (5-score), sum x 2.5 -> 0..100. */
export function susScore(answers: number[]): number {
  if (answers.length !== 10) throw new Error('SUS needs 10 answers');
  const sum = answers.reduce((acc, a, i) => acc + (i % 2 === 0 ? a - 1 : 5 - a), 0);
  return sum * 2.5;
}

const susSchema = new Schema(
  {
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    recordedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    respondentRole: {
      type: String,
      enum: ['caregiver', 'patient', 'family', 'other'],
      required: true,
    },
    answers: { type: [Number], required: true },
    score: { type: Number, required: true },
    comment: { type: String, maxlength: 1000 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export type SusAttrs = InferSchemaType<typeof susSchema>;
export const SusResponse = model('SusResponse', susSchema);
