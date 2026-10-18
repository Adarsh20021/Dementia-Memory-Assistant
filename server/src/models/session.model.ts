/**
 * Auth support collections (not in the original data model, required for
 * secure sessions):
 *  - refreshTokens: hashed, rotating refresh tokens with reuse detection.
 *  - pairingCodes: single-use, short-lived codes a caregiver issues so a
 *    patient's device can sign in without a password.
 */
import { Schema, model } from 'mongoose';

const refreshTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
// MongoDB removes expired tokens automatically.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const RefreshToken = model('RefreshToken', refreshTokenSchema);

const pairingCodeSchema = new Schema(
  {
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    codeHash: { type: String, required: true, unique: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
pairingCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const PairingCode = model('PairingCode', pairingCodeSchema);
