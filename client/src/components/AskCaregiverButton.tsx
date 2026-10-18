/** Visible, friendly "Ask my caregiver" button, shown on every patient screen. */
import { HandHelping } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { getTTS } from '../tts/TTSProvider';

export function AskCaregiverButton({ context, large = false }: { context?: string; large?: boolean }) {
  const { patient } = useAuth();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = async () => {
    if (!patient) return;
    setBusy(true);
    try {
      const r = await api<{ message: string }>(`/api/patients/${patient.id}/help-requests`, {
        body: { context },
      });
      setMessage(r.message);
      void getTTS().speak(r.message, {
        rate: patient.preferences.voiceRate,
        lang: patient.preferences.language,
      });
    } catch {
      setMessage('Please call out to your caregiver, or someone nearby.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-stretch gap-2">
      <button
        type="button"
        className={`btn-help ${large ? 'min-h-[72px] text-xl' : ''}`}
        onClick={ask}
        disabled={busy}
      >
        <HandHelping size={24} aria-hidden /> Ask my caregiver
      </button>
      {message && (
        <p role="status" className="rounded-2xl bg-warn-bg p-3 text-warn-ink">
          {message}
        </p>
      )}
    </div>
  );
}
