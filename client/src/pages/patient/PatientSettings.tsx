/** Text size, voice speed and dark mode — the only settings a patient can change. */
import { useState } from 'react';
import { api } from '../../api/client';
import type { Patient } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { SpeakButton } from '../../components/speech';
import { Alert, useDarkMode } from '../../components/ui';
import { getTTS } from '../../tts/TTSProvider';

const SIZES = [
  { label: 'Large', value: 1.25 },
  { label: 'Larger', value: 1.5 },
  { label: 'Largest', value: 1.8 },
];
const SPEEDS = [
  { label: 'Slow', value: 0.7 },
  { label: 'Normal', value: 0.9 },
  { label: 'Faster', value: 1.1 },
];

export default function PatientSettings() {
  const { patient, setPatient, logout } = useAuth();
  const [dark, setDark] = useDarkMode();
  const [error, setError] = useState<string | null>(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const prefs = patient!.preferences;

  const update = async (body: { fontScale?: number; voiceRate?: number }) => {
    setError(null);
    try {
      const r = await api<{ patient: Patient }>('/api/patients/me/preferences', { method: 'PATCH', body });
      setPatient(r.patient);
      if (body.voiceRate)
        void getTTS().speak('This is how I will sound.', { rate: body.voiceRate, lang: prefs.language });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    }
  };

  const choice = (active: boolean) => (active ? 'btn-primary' : 'btn-secondary');

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-semibold">Settings</h1>
      {error && <Alert kind="error">{error}</Alert>}
      <section className="card flex flex-col gap-3">
        <h2 className="text-2xl font-semibold">Text size</h2>
        <div className="flex flex-wrap gap-3">
          {SIZES.map((s) => (
            <button
              key={s.value}
              className={choice(Math.abs(prefs.fontScale - s.value) < 0.01)}
              onClick={() => update({ fontScale: s.value })}
            >
              {s.label}
            </button>
          ))}
        </div>
      </section>
      <section className="card flex flex-col gap-3">
        <h2 className="text-2xl font-semibold">Voice speed</h2>
        <div className="flex flex-wrap gap-3">
          {SPEEDS.map((s) => (
            <button
              key={s.value}
              className={choice(Math.abs(prefs.voiceRate - s.value) < 0.01)}
              onClick={() => update({ voiceRate: s.value })}
            >
              {s.label}
            </button>
          ))}
        </div>
        <SpeakButton text="Hello. This is how I will sound when I read to you." label="Test the voice" />
      </section>
      <section className="card flex flex-col gap-3">
        <h2 className="text-2xl font-semibold">Colours</h2>
        <div className="flex flex-wrap gap-3">
          <button className={choice(!dark)} onClick={() => setDark(false)}>
            Light
          </button>
          <button className={choice(dark)} onClick={() => setDark(true)}>
            Dark
          </button>
        </div>
      </section>
      <section className="card flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Sign out this device</h2>
        <p>Only do this if your caregiver asks you to.</p>
        {confirmSignOut ? (
          <div className="flex flex-wrap gap-3">
            <button className="btn-danger" onClick={() => void logout()}>
              Yes, sign out
            </button>
            <button className="btn-secondary" onClick={() => setConfirmSignOut(false)}>
              No
            </button>
          </div>
        ) : (
          <button className="btn-secondary" onClick={() => setConfirmSignOut(true)}>
            Sign out
          </button>
        )}
      </section>
    </div>
  );
}
