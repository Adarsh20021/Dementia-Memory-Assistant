/**
 * recognitionEvents: one row per "Who is this?" attempt, for the evaluation
 * harness (latency, scores, outcomes, LLM vs fallback). Contains no images,
 * no embeddings and no generated text. Subject to the retention period.
 */
import { HydratedDocument, InferSchemaType, Schema, model } from 'mongoose';

const recognitionEventSchema = new Schema({
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
  personId: { type: Schema.Types.ObjectId, ref: 'Person' },
  visitId: { type: Schema.Types.ObjectId, ref: 'Visit' },
  timestamp: { type: Date, default: () => new Date() },
  outcome: {
    type: String,
    enum: ['match', 'unsure', 'unknown', 'no_face', 'liveness_failed', 'error'],
    required: true,
  },
  score: Number,
  votes: Number,
  framesTotal: Number,
  framesWithFace: Number,
  yawRange: Number,
  candidates: Number,
  /** Where the spoken sentence came from. */
  summarySource: { type: String, enum: ['llm', 'cache', 'fallback', 'none'] },
  timings: {
    faceServiceMs: Number,
    llmMs: Number,
    serverTotalMs: Number,
    // Reported by the client after speech starts:
    captureMs: Number,
    clientRoundTripMs: Number,
    resultToSpeechMs: Number,
    endToEndMs: Number,
  },
});
recognitionEventSchema.index({ patientId: 1, timestamp: -1 });

export type RecognitionEventDoc = HydratedDocument<InferSchemaType<typeof recognitionEventSchema>>;
export const RecognitionEvent = model('RecognitionEvent', recognitionEventSchema);
