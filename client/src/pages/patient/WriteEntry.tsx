/**
 * "Add a note" / "Remember this" — one big text box, a microphone, autosaved
 * drafts, and a gentle "Save this?" confirmation. Used for new entries and
 * for editing the patient's own entries.
 */
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import type { DirectoryPerson, Memory, Note } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { Alert, MicButton } from '../../components/ui';
import { useDraft } from '../../hooks/useDraft';
import { useSpeechInput } from '../../hooks/useSpeechInput';

type Kind = 'note' | 'reminder' | 'memory';

export default function WriteEntry() {
  const { patient } = useAuth();
  const navigate = useNavigate();
  const { kind: editKind, id } = useParams();
  const [params] = useSearchParams();
  const kind = (editKind ?? params.get('kind') ?? 'note') as Kind;
  const fixedPersonId = params.get('personId') || undefined;
  const visitId = params.get('visitId') || undefined;
  const [personId, setPersonId] = useState<string | undefined>(fixedPersonId);
  const people = useQuery({
    queryKey: ['directory', patient?.id],
    queryFn: () => api<{ people: DirectoryPerson[] }>(`/api/patients/${patient!.id}/people-directory`),
    enabled: Boolean(patient) && !id,
  });
  const personName = params.get('name') ?? people.data?.people.find((p) => p.id === personId)?.name ?? null;

  const [text, setText, clearDraft, restored] = useDraft(`${kind}:${id ?? 'new'}:${fixedPersonId ?? ''}`);
  const [dueAt, setDueAt] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const append = useCallback((t: string) => setText((v) => (v ? `${v} ${t}` : t)), [setText]);
  const mic = useSpeechInput(append, patient?.preferences.language);

  // Editing: load the existing entry once (unless a newer draft exists).
  useEffect(() => {
    if (!id || !patient) return;
    const path = kind === 'memory' ? `memories/${id}` : `notes`;
    api<{ memory?: Memory; notes?: Note[] }>(`/api/patients/${patient.id}/${path}`)
      .then((r) => {
        const existing = kind === 'memory' ? r.memory?.summary : r.notes?.find((n) => n.id === id)?.text;
        if (existing) setText((v) => v || existing);
      })
      .catch(() => setError('I could not open this entry.'));
  }, [id, kind, patient, setText]);

  const title =
    kind === 'memory'
      ? fixedPersonId && personName
        ? `Remember this about ${personName}`
        : 'Remember this'
      : kind === 'reminder'
        ? 'Add a reminder'
        : 'Add a note';

  const save = async () => {
    if (!patient) return;
    setBusy(true);
    setError(null);
    try {
      const base = `/api/patients/${patient.id}`;
      if (kind === 'memory') {
        if (id) await api(`${base}/memories/${id}`, { method: 'PATCH', body: { summary: text } });
        else await api(`${base}/memories`, { body: { summary: text, personId, visitId } });
      } else if (id) {
        await api(`${base}/notes/${id}`, { method: 'PATCH', body: { text } });
      } else {
        await api(`${base}/notes`, {
          body: { text, kind, ...(dueAt ? { dueAt: new Date(dueAt).toISOString() } : {}), personId },
        });
      }
      clearDraft();
      setSaved(true);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'It could not be saved. Your words are kept here. Please try again.',
      );
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  if (saved) {
    return (
      <div className="card flex flex-col gap-4">
        <h1 className="text-3xl">Saved.</h1>
        <p className="text-xl">Thank you. Your caregiver can see this.</p>
        <div className="flex flex-wrap gap-3">
          <Link to="/patient/notes" className="btn-primary">
            See my notes
          </Link>
          <Link to="/patient" className="btn-secondary">
            Back to Who is this?
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-3xl">{title}</h1>
      <p className="rounded-2xl bg-soft p-3">Your caregiver can see this.</p>
      {restored && !id && text && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line p-3">
          <span>This is what you were writing before.</span>
          <button type="button" className="btn-secondary" onClick={clearDraft}>
            Start fresh
          </button>
        </div>
      )}
      {!id && !fixedPersonId && (people.data?.people.length ?? 0) > 0 && (
        <div>
          <label htmlFor="about" className="label">
            Who is this about? (optional)
          </label>
          <select
            id="about"
            className="input text-xl"
            value={personId ?? ''}
            onChange={(e) => setPersonId(e.target.value || undefined)}
          >
            <option value="">Nobody in particular</option>
            {people.data!.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.relationship})
              </option>
            ))}
          </select>
        </div>
      )}
      <label htmlFor="entry" className="sr-only">
        Write here
      </label>
      <textarea
        id="entry"
        className="input min-h-[220px] text-2xl"
        placeholder="Write here, or tap Speak."
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={kind === 'memory' ? 1000 : 2000}
      />
      {kind === 'reminder' && !id && (
        <div>
          <label htmlFor="due" className="label">
            When? (optional)
          </label>
          <input
            id="due"
            type="datetime-local"
            className="input"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
          />
        </div>
      )}
      <MicButton
        supported={mic.supported}
        listening={mic.listening}
        transcribing={mic.transcribing}
        onStart={mic.start}
        onStop={mic.stop}
      />
      {mic.error && <Alert kind="warn">{mic.error}</Alert>}
      {error && <Alert kind="error">{error}</Alert>}

      {!confirming ? (
        <div className="flex flex-wrap gap-3">
          <button className="btn-primary text-xl" disabled={!text.trim()} onClick={() => setConfirming(true)}>
            Save
          </button>
          <button className="btn-secondary" onClick={() => navigate(-1)}>
            Back
          </button>
        </div>
      ) : (
        <div className="card flex flex-col gap-3" role="dialog" aria-label="Save this?">
          <p className="text-2xl font-semibold">Save this?</p>
          {personName && <p className="text-lg text-sub">About {personName}</p>}
          <p className="whitespace-pre-wrap text-xl">{text}</p>
          <div className="flex flex-wrap gap-3">
            <button className="btn-primary text-xl" onClick={save} disabled={busy}>
              Yes, save it
            </button>
            <button className="btn-secondary" onClick={() => setConfirming(false)}>
              No, keep writing
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
