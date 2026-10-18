/**
 * people: authorized familiar persons (no login). Face data may only be
 * created after consent is recorded. Embeddings are stored encrypted and are
 * NEVER returned by the API.
 */
import { HydratedDocument, InferSchemaType, Schema, model } from 'mongoose';

export const CONSENT_SCOPES = ['recognition', 'visit-history', 'conversation-summaries'] as const;
export const CONSENT_GIVER_ROLES = ['person', 'caregiver'] as const;

const photoSchema = new Schema(
  {
    storageKey: { type: String, required: true }, // path of the encrypted file under UPLOAD_DIR
    mimeType: { type: String, required: true },
    addedAt: { type: Date, default: () => new Date() },
  },
  { _id: true },
);

const consentSchema = new Schema(
  {
    given: { type: Boolean, default: false },
    /** Name of who consented (the person themself, or the caregiver acting for them). */
    givenBy: { type: String, trim: true, maxlength: 100 },
    givenByRole: { type: String, enum: CONSENT_GIVER_ROLES },
    /** Required when a caregiver consents on the person's behalf. */
    reason: { type: String, trim: true, maxlength: 500 },
    givenAt: { type: Date },
    scope: [{ type: String, enum: CONSENT_SCOPES }],
    revokedAt: { type: Date },
  },
  { _id: false },
);

const personSchema = new Schema(
  {
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    relationship: { type: String, required: true, trim: true, maxlength: 60 },
    age: { type: Number, min: 0, max: 120 },
    notes: { type: String, trim: true, maxlength: 1000 },
    photos: [photoSchema],
    /**
     * AES-256-GCM encrypted 512-d embedding vectors, one per enrolled photo
     * (photoId links each embedding to the photo it came from).
     */
    embeddings: {
      type: [new Schema({ photoId: Schema.Types.ObjectId, enc: String }, { _id: false })],
      default: [],
    },
    consent: { type: consentSchema, default: () => ({}) },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
personSchema.index({ patientId: 1, isActive: 1 });

export type PersonDoc = HydratedDocument<InferSchemaType<typeof personSchema>>;
export const Person = model('Person', personSchema);

/** Consent is active when it was given and has not been revoked. Checked on every use. */
export const hasActiveConsent = (p: Pick<PersonDoc, 'consent'>): boolean =>
  Boolean(p.consent?.given && !p.consent?.revokedAt);

export const serializePerson = (p: PersonDoc) => ({
  id: String(p._id),
  patientId: String(p.patientId),
  name: p.name,
  relationship: p.relationship,
  age: p.age ?? undefined,
  notes: p.notes ?? undefined,
  photoCount: p.photos.length,
  photos: p.photos.map((ph) => ({ id: String(ph._id), addedAt: ph.addedAt })),
  enrolledFaceCount: p.embeddings.length,
  isActive: p.isActive,
  hasActiveConsent: hasActiveConsent(p),
  consent: {
    given: Boolean(p.consent?.given),
    givenBy: p.consent?.givenBy ?? undefined,
    givenByRole: p.consent?.givenByRole ?? undefined,
    reason: p.consent?.reason ?? undefined,
    givenAt: p.consent?.givenAt ?? undefined,
    scope: p.consent?.scope ?? [],
    revokedAt: p.consent?.revokedAt ?? undefined,
  },
  createdAt: p.get('createdAt') as Date,
  updatedAt: p.get('updatedAt') as Date,
});
