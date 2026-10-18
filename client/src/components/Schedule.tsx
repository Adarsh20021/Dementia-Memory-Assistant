/**
 * Planned visits, shared by the patient ("Visits") and the caregiver
 * ("Visits" in the sidebar). Both can plan a visit; the patient can change or
 * remove only the visits they added, and can mark any visit as done.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, Check, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import type { DirectoryPerson, ScheduledVisit } from '../api/types';
import { SpeakButton } from './speech';
import { Alert, ErrorText, Spinner, whenText } from './ui';

const pad = (n: number) => String(n).padStart(2, '0');
const toDateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toTimeInput = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

interface FormState {
  id?: string;
  personId: string; // '' = someone else
  visitorName: string;
  date: string;
  time: string;
  note: string;
}

const emptyForm = (): FormState => {
  const d = new Date(Date.now() + 86_400_000);
  d.setHours(16, 0, 0, 0);
  return { personId: '', visitorName: '', date: toDateInput(d), time: '16:00', note: '' };
};

export function Schedule({ patientId, mode }: { patientId: string; mode: 'patient' | 'caregiver' }) {
  const qc = useQueryClient();
  const big = mode === 'patient';
  const base = `/api/patients/${patientId}/schedule`;
  const visits = useQuery({
    queryKey: ['schedule', patientId, 'upcoming'],
    queryFn: () => api<{ visits: ScheduledVisit[] }>(`${base}?limit=50`),
  });
  const past = useQuery({
    queryKey: ['schedule', patientId, 'past'],
    queryFn: () => api<{ visits: ScheduledVisit[] }>(`${base}?range=past&limit=10`),
    enabled: mode === 'caregiver',
  });
  const people = useQuery({
    queryKey: ['directory', patientId],
    queryFn: () => api<{ people: DirectoryPerson[] }>(`/api/patients/${patientId}/people-directory`),
  });

  const [form, setForm] = useState<FormState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    // Default the picker to the first person once the list arrives.
    if (form && !form.id && !form.personId && !form.visitorName && people.data?.people[0]) {
      setForm((f) => (f ? { ...f, personId: people.data!.people[0].id } : f));
    }
  }, [form, people.data]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['schedule', patientId] });
    void qc.invalidateQueries({ queryKey: ['overview', patientId] });
  };

  const save = useMutation({
    mutationFn: (f: FormState) => {
      const startsAt = new Date(`${f.date}T${f.time}`).toISOString();
      const who = f.personId ? { personId: f.personId } : { visitorName: f.visitorName.trim() };
      const body = { ...who, startsAt, ...(f.note.trim() ? { note: f.note.trim() } : {}) };
      return f.id
        ? api(`${base}/${f.id}`, {
            method: 'PATCH',
            body: {
              personId: f.personId || null,
              visitorName: f.personId ? null : f.visitorName.trim(),
              startsAt,
              note: f.note.trim() || null,
            },
          })
        : api(base, { body });
    },
    onSuccess: () => {
      setSaved(form?.id ? 'Visit changed.' : 'Visit saved.');
      setForm(null);
      setConfirming(false);
      refresh();
    },
    onError: () => setConfirming(false),
  });
  const markDone = useMutation({
    mutationFn: (id: string) => api(`${base}/${id}`, { method: 'PATCH', body: { status: 'done' } }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`${base}/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const startEdit = (v: ScheduledVisit) => {
    const d = new Date(v.startsAt);
    setSaved(null);
    setForm({
      id: v.id,
      personId: v.personId ?? '',
      visitorName: v.visitorName ?? '',
      date: toDateInput(d),
      time: toTimeInput(d),
      note: v.note ?? '',
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    if (big && !confirming) return setConfirming(true);
    save.mutate(form);
  };

  const canEdit = (v: ScheduledVisit) => mode === 'caregiver' || v.mine;
  const whoLabel = (f: FormState) =>
    f.personId ? (people.data?.people.find((p) => p.id === f.personId)?.name ?? '') : f.visitorName;
  const textSize = big ? 'text-xl' : '';

  return (
    <div className="flex flex-col gap-5">
      {!form && (
        <button
          type="button"
          className={`btn-primary self-start ${big ? 'min-h-[72px] text-2xl' : ''}`}
          onClick={() => {
            setSaved(null);
            setForm(emptyForm());
          }}
        >
          <CalendarPlus size={big ? 28 : 20} aria-hidden /> Plan a visit
        </button>
      )}
      {saved && <Alert kind="success">{saved}</Alert>}

      {form && (
        <form onSubmit={submit} className={`card flex flex-col gap-4 ${textSize}`} aria-label="Plan a visit">
          <h2 className={big ? 'text-3xl' : 'text-xl'}>{form.id ? 'Change this visit' : 'Plan a visit'}</h2>
          <div>
            <label className="label" htmlFor="sv-who">
              Who is coming?
            </label>
            <select
              id="sv-who"
              className="input"
              value={form.personId}
              onChange={(e) => setForm({ ...form, personId: e.target.value })}
            >
              {people.data?.people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.relationship})
                </option>
              ))}
              <option value="">Someone else…</option>
            </select>
          </div>
          {!form.personId && (
            <div>
              <label className="label" htmlFor="sv-name">
                Their name
              </label>
              <input
                id="sv-name"
                className="input"
                placeholder="Nurse Meera"
                value={form.visitorName}
                onChange={(e) => setForm({ ...form, visitorName: e.target.value })}
                maxLength={80}
              />
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="sv-date">
                Day
              </label>
              <input
                id="sv-date"
                type="date"
                className="input"
                value={form.date}
                min={toDateInput(new Date())}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
                required
              />
            </div>
            <div>
              <label className="label" htmlFor="sv-time">
                Time
              </label>
              <input
                id="sv-time"
                type="time"
                className="input"
                value={form.time}
                onChange={(e) => setForm({ ...form, time: e.target.value })}
                required
              />
            </div>
          </div>
          <div>
            <label className="label" htmlFor="sv-note">
              Note (optional)
            </label>
            <input
              id="sv-note"
              className="input"
              placeholder="Bringing lunch"
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              maxLength={500}
            />
          </div>
          {confirming ? (
            <div
              className="flex flex-col gap-3 rounded-2xl bg-soft p-4"
              role="dialog"
              aria-label="Save this visit?"
            >
              <p className="text-2xl font-semibold">Save this visit?</p>
              <p>
                {whoLabel(form) || 'A visitor'} —{' '}
                {whenText(new Date(`${form.date}T${form.time}`).toISOString())}
              </p>
              <div className="flex flex-wrap gap-3">
                <button className="btn-primary" disabled={save.isPending}>
                  Yes, save it
                </button>
                <button type="button" className="btn-secondary" onClick={() => setConfirming(false)}>
                  No, change it
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-3">
              <button
                className="btn-primary"
                disabled={save.isPending || (!form.personId && !form.visitorName.trim())}
              >
                {form.id ? 'Save changes' : 'Save visit'}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setForm(null)}>
                Cancel
              </button>
            </div>
          )}
          <ErrorText error={save.error} />
        </form>
      )}

      <section className="flex flex-col gap-3">
        <h2 className={big ? 'text-3xl' : 'text-xl'}>Coming up</h2>
        {visits.isLoading && <Spinner />}
        <ErrorText error={visits.error ?? markDone.error ?? remove.error} />
        {visits.data?.visits.length === 0 && (
          <p className={`text-sub ${textSize}`}>No visits are planned yet.</p>
        )}
        <ul className="flex flex-col gap-3">
          {visits.data?.visits.map((v) => (
            <li key={v.id} className={`card flex flex-col gap-3 ${big ? 'p-5' : 'p-4'}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className={big ? 'text-2xl font-semibold' : 'text-lg font-semibold'}>
                  {v.who}
                  {v.relationship && <span className="font-normal text-sub"> · your {v.relationship}</span>}
                </p>
                <p className={big ? 'text-xl' : ''}>{whenText(v.startsAt)}</p>
              </div>
              {v.note && <p className={textSize}>{v.note}</p>}
              <p className="text-sm text-sub">
                Added by {v.mine ? 'you' : v.createdByRole === 'patient' ? 'the patient' : 'the caregiver'}
              </p>
              <div className="flex flex-wrap gap-2">
                {big && <SpeakButton text={`${v.who} is coming ${whenText(v.startsAt)}. ${v.note ?? ''}`} />}
                <button type="button" className="btn-secondary" onClick={() => markDone.mutate(v.id)}>
                  <Check size={20} aria-hidden /> Done
                </button>
                {canEdit(v) && (
                  <button type="button" className="btn-secondary" onClick={() => startEdit(v)}>
                    <Pencil size={20} aria-hidden /> Change
                  </button>
                )}
                {canEdit(v) &&
                  (confirmRemove === v.id ? (
                    <>
                      <button type="button" className="btn-danger" onClick={() => remove.mutate(v.id)}>
                        Yes, remove it
                      </button>
                      <button type="button" className="btn-secondary" onClick={() => setConfirmRemove(null)}>
                        Keep it
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn-secondary" onClick={() => setConfirmRemove(v.id)}>
                      <Trash2 size={20} aria-hidden /> Remove
                    </button>
                  ))}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {mode === 'caregiver' && (past.data?.visits.length ?? 0) > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-xl">Earlier</h2>
          <ul className="card divide-y divide-line p-0">
            {past.data!.visits.map((v) => (
              <li key={v.id} className="flex flex-wrap justify-between gap-2 px-5 py-3">
                <span>{v.who}</span>
                <span className="text-sub">
                  {new Date(v.startsAt).toLocaleString(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}{' '}
                  · {v.status}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
