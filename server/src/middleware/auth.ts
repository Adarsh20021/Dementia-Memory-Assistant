/**
 * Authentication + role-based access control + ownership checks.
 *
 *  authenticate   -> verifies the access token and loads the user
 *  requireRole    -> rejects users without one of the given roles (403)
 *  patientAccess  -> loads :patientId and checks the user owns it.
 *                    Caregivers: must be in patient.caregiverIds.
 *                    Patients:   must be their own patient record.
 *                    Otherwise 404 (we don't reveal that the patient exists).
 */
import type { RequestHandler } from 'express';
import { HttpError, ah, isObjectId, notFound } from '../lib/http';
import { Patient, type PatientDoc } from '../models/patient.model';
import { User, type Role } from '../models/user.model';
import { verifyAccessToken } from '../services/token.service';

export interface AuthUser {
  id: string;
  role: Role;
  name: string;
  patientIds: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      patient?: PatientDoc;
    }
  }
}

export const authenticate: RequestHandler = ah(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Please sign in.');
  }
  let claims;
  try {
    claims = verifyAccessToken(header.slice(7));
  } catch {
    throw new HttpError(401, 'INVALID_TOKEN', 'Your session has expired. Please sign in again.');
  }
  // Re-check the user on every request so deleted users lose access immediately.
  const user = await User.findById(claims.sub).select('name role patientIds').lean();
  if (!user || user.role !== claims.role) {
    throw new HttpError(401, 'INVALID_TOKEN', 'Please sign in again.');
  }
  req.user = {
    id: String(user._id),
    role: user.role as Role,
    name: user.name,
    patientIds: (user.patientIds ?? []).map(String),
  };
  next();
});

export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'Please sign in.'));
    if (!roles.includes(req.user.role)) {
      return next(new HttpError(403, 'FORBIDDEN', 'You do not have permission to do this.'));
    }
    next();
  };

export const patientAccess: RequestHandler = ah(async (req, _res, next) => {
  const user = req.user;
  if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'Please sign in.');
  const { patientId } = req.params;
  if (!isObjectId(patientId)) throw notFound('Patient');

  let patient: PatientDoc | null = null;
  if (user.role === 'caregiver') {
    patient = await Patient.findOne({ _id: patientId, caregiverIds: user.id });
  } else if (user.role === 'patient' && user.patientIds.includes(patientId)) {
    patient = await Patient.findById(patientId);
  }
  if (!patient) throw notFound('Patient');
  req.patient = patient;
  next();
});

/** Convenience chain for caregiver-only, patient-scoped routes. */
export const caregiverOfPatient = [authenticate, requireRole('caregiver'), patientAccess];
/** Either the patient themself or one of their caregivers. */
export const patientOrCaregiver = [
  authenticate,
  requireRole('caregiver', 'patient'),
  patientAccess,
];
