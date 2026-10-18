/**
 * users: caregivers (email + password) and patient device-users (no password;
 * they sign in by pairing a device with a caregiver-issued code).
 */
import { HydratedDocument, InferSchemaType, Schema, model } from 'mongoose';

export const ROLES = ['caregiver', 'patient'] as const;
export type Role = (typeof ROLES)[number];

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    // Only caregivers have an email. Sparse so patient users (no email) don't collide.
    email: { type: String, lowercase: true, trim: true, unique: true, sparse: true },
    passwordHash: { type: String, select: false },
    role: { type: String, enum: ROLES, required: true },
    patientIds: [{ type: Schema.Types.ObjectId, ref: 'Patient' }],
    // Account lockout after repeated failed logins.
    failedLoginCount: { type: Number, default: 0 },
    lockedUntil: { type: Date },
  },
  { timestamps: true },
);

export type UserAttrs = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<UserAttrs>;
export const User = model('User', userSchema);

export const serializeUser = (u: {
  _id: unknown;
  name: string;
  email?: string | null;
  role: string;
}) => ({
  id: String(u._id),
  name: u.name,
  email: u.email ?? undefined,
  role: u.role as Role,
});
