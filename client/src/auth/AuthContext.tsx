/**
 * Session state for both roles.
 *
 * Caregiver and patient sessions use separate refresh cookies, so one browser
 * can hold both (e.g. while testing) without one signing the other out. On
 * load we restore the session that fits the page: /patient and /pair prefer
 * the patient session, /care and /login the caregiver one.
 *
 * Patient devices remember who they belong to (a "device hint": patient id
 * and first name, not secret). If the patient session ever ends, the device
 * shows "Welcome back — enter your PIN" instead of asking for a new code.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, refreshSession, setAccessToken, setOnSessionLost, setSessionRole } from '../api/client';
import type { Patient, User } from '../api/types';
import { localPref } from '../hooks/useDraft';

type Status = 'loading' | 'anonymous' | 'caregiver' | 'patient';
type Role = 'caregiver' | 'patient';

export interface DeviceHint {
  patientId: string;
  name: string;
}

const HINT_KEY = 'dma-device-patient';
const LAST_ROLE_KEY = 'dma-last-role';

export function readDeviceHint(): DeviceHint | null {
  try {
    const raw = localPref.read(HINT_KEY);
    const v = raw ? (JSON.parse(raw) as DeviceHint) : null;
    return v?.patientId && v.name ? v : null;
  } catch {
    return null;
  }
}
export const forgetDevice = () => localPref.write(HINT_KEY, null);

interface PatientSession {
  accessToken: string;
  user: User;
  patient: Patient;
}

interface AuthState {
  status: Status;
  user: User | null;
  /** For patient sessions: their own record (with display preferences). */
  patient: Patient | null;
  setPatient: (p: Patient) => void;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  pair: (code: string) => Promise<void>;
  pinLogin: (patientId: string, pin: string) => Promise<void>;
  /** Adopt a patient session created by the caregiver ("use this device for …"). */
  becomePatient: (s: PatientSession) => void;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

/** Which session to try first for the page we're on. */
function preferredRoles(): Role[] {
  const path = window.location.pathname;
  if (path.startsWith('/patient') || path.startsWith('/pair')) return ['patient', 'caregiver'];
  if (path.startsWith('/care') || path.startsWith('/login') || path.startsWith('/register'))
    return ['caregiver', 'patient'];
  return localPref.read(LAST_ROLE_KEY) === 'caregiver' ? ['caregiver', 'patient'] : ['patient', 'caregiver'];
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [patient, setPatient] = useState<Patient | null>(null);

  const reset = useCallback(() => {
    setAccessToken(null);
    setSessionRole(null);
    setUser(null);
    setPatient(null);
    setStatus('anonymous');
  }, []);

  const adoptPatient = useCallback((u: User, p: Patient) => {
    setSessionRole('patient');
    localPref.write(LAST_ROLE_KEY, 'patient');
    localPref.write(HINT_KEY, JSON.stringify({ patientId: p.id, name: p.name.split(/\s+/)[0] }));
    setUser(u);
    setPatient(p);
    setStatus('patient');
  }, []);

  const adopt = useCallback(
    async (u: User) => {
      if (u.role === 'patient') {
        setSessionRole('patient');
        const { patient: p } = await api<{ patient: Patient }>('/api/patients/me');
        adoptPatient(u, p);
      } else {
        setSessionRole('caregiver');
        localPref.write(LAST_ROLE_KEY, 'caregiver');
        setUser(u);
        setStatus('caregiver');
      }
    },
    [adoptPatient],
  );

  useEffect(() => {
    setOnSessionLost(reset);
    (async () => {
      for (const role of preferredRoles()) {
        const r = await refreshSession(role);
        if (r) return adopt(r.user);
      }
      reset();
    })().catch(reset);
  }, [adopt, reset]);

  const value = useMemo<AuthState>(
    () => ({
      status,
      user,
      patient,
      setPatient,
      login: async (email, password) => {
        const r = await api<{ accessToken: string; user: User }>('/api/auth/login', {
          body: { email, password },
        });
        setAccessToken(r.accessToken);
        await adopt(r.user);
      },
      register: async (name, email, password) => {
        await api('/api/auth/register', { body: { name, email, password } });
        const r = await api<{ accessToken: string; user: User }>('/api/auth/login', {
          body: { email, password },
        });
        setAccessToken(r.accessToken);
        await adopt(r.user);
      },
      pair: async (code) => {
        const r = await api<PatientSession>('/api/auth/pair', { body: { code } });
        setAccessToken(r.accessToken);
        adoptPatient(r.user, r.patient);
      },
      pinLogin: async (patientId, pin) => {
        const r = await api<PatientSession>('/api/auth/pin', { body: { patientId, pin } });
        setAccessToken(r.accessToken);
        adoptPatient(r.user, r.patient);
      },
      becomePatient: (s) => {
        setAccessToken(s.accessToken);
        adoptPatient(s.user, s.patient);
      },
      logout: async () => {
        const role = status === 'patient' || status === 'caregiver' ? status : undefined;
        await api('/api/auth/logout', { method: 'POST', body: role ? { role } : {} }).catch(() => undefined);
        reset();
      },
    }),
    [status, user, patient, adopt, adoptPatient, reset],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
