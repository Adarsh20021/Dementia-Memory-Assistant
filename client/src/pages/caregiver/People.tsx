/** People list, add-person form with the mandatory consent step, and person detail with photo enrollment. */
import { Camera } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api/client';
import type { ConsentScope, Person } from '../../api/types';
import { Alert, AuthImage, ErrorText, Spinner, formatDateTime } from '../../components/ui';
import { useCamera } from '../../hooks/useCamera';

const SCOPES: { value: ConsentScope; label: string; help: string }[] = [
  { value: 'recognition', label: 'Recognise their face', help: 'Needed for "Who is this?".' },
  {
    value: 'visit-history',
    label: 'Keep a history of visits',
    help: 'Dates of visits may be told to the patient.',
  },
  {
    value: 'conversation-summaries',
    label: 'Use short visit summaries',
    help: 'Approved summaries may be read to the patient, and sent as text to the AI to write a sentence.',
  },
];

export interface ConsentValue {
  given: boolean;
  givenBy: string;
  givenByRole: 'person' | 'caregiver';
  reason: string;
  givenAt: string;
  scope: ConsentScope[];
}

export const emptyConsent = (): ConsentValue => ({
  given: false,
  givenBy: '',
  givenByRole: 'person',
  reason: '',
  givenAt: new Date().toISOString().slice(0, 10),
  scope: ['recognition', 'visit-history', 'conversation-summaries'],
});

export const consentPayload = (c: ConsentValue) => ({
  given: true,
  givenBy: c.givenBy,
  givenByRole: c.givenByRole,
  ...(c.reason.trim() ? { reason: c.reason.trim() } : {}),
  givenAt: new Date(`${c.givenAt}T12:00:00`).toISOString(),
  scope: c.scope,
});

export const consentValid = (c: ConsentValue) =>
  c.given && c.givenBy.trim() && c.scope.length > 0 && (c.givenByRole === 'person' || c.reason.trim());

export function ConsentForm({
  value,
  onChange,
}: {
  value: ConsentValue;
  onChange: (v: ConsentValue) => void;
}) {
  const set = (patch: Partial<ConsentValue>) => onChange({ ...value, ...patch });
  return (
    <fieldset className="flex flex-col gap-3 rounded-2xl border-2 border-line p-4">
      <legend className="px-2 font-semibold">Consent (required before any face photo is stored)</legend>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="role"
            checked={value.givenByRole === 'person'}
            onChange={() => set({ givenByRole: 'person' })}
          />
          The person agreed themself
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="role"
            checked={value.givenByRole === 'caregiver'}
            onChange={() => set({ givenByRole: 'caregiver' })}
          />
          I am consenting on their behalf
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="givenBy">
            Who gave consent
          </label>
          <input
            id="givenBy"
            className="input"
            value={value.givenBy}
            onChange={(e) => set({ givenBy: e.target.value })}
          />
        </div>
        <div>
          <label className="label" htmlFor="givenAt">
            Date
          </label>
          <input
            id="givenAt"
            type="date"
            className="input"
            value={value.givenAt}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => set({ givenAt: e.target.value })}
          />
        </div>
      </div>
      {value.givenByRole === 'caregiver' && (
        <div>
          <label className="label" htmlFor="reason">
            Reason (required)
          </label>
          <textarea
            id="reason"
            className="input"
            placeholder="e.g. The person is a child; their parent agreed."
            value={value.reason}
            onChange={(e) => set({ reason: e.target.value })}
          />
        </div>
      )}
      <div className="flex flex-col gap-2">
        <span className="font-semibold">They agree to:</span>
        {SCOPES.map((s) => (
          <label key={s.value} className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1.5"
              checked={value.scope.includes(s.value)}
              onChange={(e) =>
                set({
                  scope: e.target.checked
                    ? [...value.scope, s.value]
                    : value.scope.filter((x) => x !== s.value),
                })
              }
            />
            <span>
              {s.label} <span className="text-sm text-sub">— {s.help}</span>
            </span>
          </label>
        ))}
      </div>
      <label className="flex items-start gap-2 rounded-xl bg-soft p-3">
        <input
          type="checkbox"
          className="mt-1.5"
          checked={value.given}
          onChange={(e) => set({ given: e.target.checked })}
        />
        <span>
          I confirm consent was given for the uses ticked above, and that it can be withdrawn at any time
          (which deletes their photos and face data).
        </span>
      </label>
    </fieldset>
  );
}

export function PeopleList() {
  const { patientId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const base = `/api/patients/${patientId}/people`;
  const { data, isLoading, error } = useQuery({
    queryKey: ['people', patientId],
    queryFn: () => api<{ people: Person[] }>(base),
  });
  const [form, setForm] = useState({ name: '', relationship: '', age: '', notes: '' });
  const [consent, setConsent] = useState<ConsentValue>(emptyConsent());
  const [open, setOpen] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      api<{ person: Person }>(base, {
        body: {
          name: form.name,
          relationship: form.relationship,
          ...(form.age ? { age: Number(form.age) } : {}),
          ...(form.notes ? { notes: form.notes } : {}),
          consent: consentPayload(consent),
        },
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['people', patientId] });
      navigate(`/care/patients/${patientId}/people/${r.person.id}`);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <div className="flex flex-col gap-5">
      {isLoading && <Spinner />}
      <ErrorText error={error} />
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data?.people.map((p) => (
          <li key={p.id}>
            <Link
              to={`/care/patients/${patientId}/people/${p.id}`}
              className="card flex flex-col gap-1 hover:border-brand"
            >
              <span className="text-xl font-semibold">{p.name}</span>
              <span>{p.relationship}</span>
              <span className="text-sm">
                {p.photoCount} photo(s) ·{' '}
                {p.hasActiveConsent ? (
                  <span className="text-ok-ink">consent recorded</span>
                ) : (
                  <span className="text-bad-ink">consent withdrawn</span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {data && data.people.length === 0 && (
        <Alert>Add the familiar people the patient should recognise.</Alert>
      )}

      {!open ? (
        <button className="btn-primary self-start" onClick={() => setOpen(true)}>
          Add a familiar person
        </button>
      ) : (
        <form onSubmit={submit} className="card flex flex-col gap-4">
          <h2 className="text-xl font-semibold">Add a familiar person</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="name">
                Name
              </label>
              <input
                id="name"
                className="input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </div>
            <div>
              <label className="label" htmlFor="rel">
                Relationship to the patient
              </label>
              <input
                id="rel"
                className="input"
                placeholder="daughter, neighbour…"
                value={form.relationship}
                onChange={(e) => setForm({ ...form, relationship: e.target.value })}
                required
              />
            </div>
            <div>
              <label className="label" htmlFor="age">
                Age (optional)
              </label>
              <input
                id="age"
                type="number"
                min={0}
                max={120}
                className="input"
                value={form.age}
                onChange={(e) => setForm({ ...form, age: e.target.value })}
              />
            </div>
            <div>
              <label className="label" htmlFor="notes">
                Notes for caregivers (optional)
              </label>
              <input
                id="notes"
                className="input"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </div>
          </div>
          <ConsentForm value={consent} onChange={setConsent} />
          <ErrorText error={create.error} />
          <div className="flex gap-3">
            <button
              className="btn-primary"
              disabled={!form.name || !form.relationship || !consentValid(consent) || create.isPending}
            >
              Save person
            </button>
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

interface EnrollResult {
  results: { index: number; filename: string; ok: boolean; message?: string | null }[];
  person: Person;
  needsMore: number;
}

export function PersonDetail() {
  const { patientId, personId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const base = `/api/patients/${patientId}/people/${personId}`;
  const { data, isLoading, error } = useQuery({
    queryKey: ['person', personId],
    queryFn: () => api<{ person: Person }>(base),
  });
  const person = data?.person;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['person', personId] });
    void qc.invalidateQueries({ queryKey: ['people', patientId] });
  };

  const [edit, setEdit] = useState({ name: '', relationship: '', notes: '' });
  useEffect(() => {
    if (person) setEdit({ name: person.name, relationship: person.relationship, notes: person.notes ?? '' });
  }, [person]);
  const save = useMutation({
    mutationFn: () => api(base, { method: 'PATCH', body: { ...edit, notes: edit.notes || undefined } }),
    onSuccess: refresh,
  });

  const [files, setFiles] = useState<Blob[]>([]);
  const [results, setResults] = useState<EnrollResult | null>(null);
  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData();
      files.forEach((f, i) => form.append('photos', f, (f as File).name ?? `camera-${i}.jpg`));
      return api<EnrollResult>(`${base}/photos`, { form });
    },
    onSuccess: (r) => {
      setResults(r);
      setFiles([]);
      refresh();
    },
  });
  const removePhoto = useMutation({
    mutationFn: (id: string) => api(`${base}/photos/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  const [consent, setConsent] = useState<ConsentValue>(emptyConsent());
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const revoke = useMutation({
    mutationFn: () => api(`${base}/consent/revoke`, { body: {} }),
    onSuccess: () => {
      setConfirmRevoke(false);
      refresh();
    },
  });
  const grant = useMutation({
    mutationFn: () => api(`${base}/consent`, { body: consentPayload(consent) }),
    onSuccess: refresh,
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const del = useMutation({
    mutationFn: () => api(base, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['people', patientId] });
      navigate(`/care/patients/${patientId}/people`);
    },
  });

  const cam = useCamera();

  if (isLoading) return <Spinner />;
  if (error || !person) return <ErrorText error={error} />;

  return (
    <div className="flex flex-col gap-5">
      <Link to={`/care/patients/${patientId}/people`} className="underline">
        ‹ All people
      </Link>

      <section className="card flex flex-col gap-3">
        <h2 className="text-2xl font-semibold">{person.name}</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <input
            className="input"
            aria-label="Name"
            value={edit.name}
            onChange={(e) => setEdit({ ...edit, name: e.target.value })}
          />
          <input
            className="input"
            aria-label="Relationship"
            value={edit.relationship}
            onChange={(e) => setEdit({ ...edit, relationship: e.target.value })}
          />
          <input
            className="input"
            aria-label="Notes"
            placeholder="Notes"
            value={edit.notes}
            onChange={(e) => setEdit({ ...edit, notes: e.target.value })}
          />
        </div>
        <button className="btn-secondary self-start" onClick={() => save.mutate()} disabled={save.isPending}>
          Save changes
        </button>
        <ErrorText error={save.error} />
      </section>

      <section className="card flex flex-col gap-4">
        <h2 className="text-xl font-semibold">Face photos ({person.photoCount}/5)</h2>
        {!person.hasActiveConsent ? (
          <Alert kind="warn">
            Consent was withdrawn, so photos cannot be added. Record consent again below to continue.
          </Alert>
        ) : (
          <>
            <p>
              Add 3–5 clear photos with different angles and lighting. Only this person should be in each
              photo.
            </p>
            {person.photoCount < 3 && (
              <Alert kind="warn">
                Add at least {3 - person.photoCount} more photo(s) for reliable recognition.
              </Alert>
            )}
            <div className="flex flex-wrap gap-3">
              {person.photos.map((ph) => (
                <figure key={ph.id} className="flex flex-col items-center gap-1">
                  <AuthImage
                    src={`${base}/photos/${ph.id}`}
                    alt={`Photo of ${person.name}`}
                    className="h-28 w-28 rounded-2xl object-cover"
                  />
                  <button
                    className="text-sm text-bad-ink underline"
                    onClick={() => removePhoto.mutate(ph.id)}
                  >
                    Remove
                  </button>
                </figure>
              ))}
            </div>
            <div className="flex flex-col gap-3 rounded-2xl border-2 border-dashed border-line p-4">
              <label className="label" htmlFor="upload">
                Upload photos
              </label>
              <input
                id="upload"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 5))}
              />
              <div className="flex flex-col gap-2">
                <video
                  ref={cam.videoRef}
                  muted
                  playsInline
                  className={`w-full max-w-sm rounded-2xl -scale-x-100 ${cam.status === 'ready' ? '' : 'hidden'}`}
                />
                <div className="flex flex-wrap gap-2">
                  {cam.status !== 'ready' ? (
                    <button type="button" className="btn-secondary" onClick={() => void cam.start()}>
                      Use the camera
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={async () => {
                          const b = await cam.snapshot(1280, 0.92);
                          if (b) setFiles((f) => [...f, b].slice(0, 5));
                        }}
                      >
                        <Camera size={18} aria-hidden /> Take photo
                      </button>
                      <button type="button" className="btn-secondary" onClick={cam.stop}>
                        Close camera
                      </button>
                    </>
                  )}
                </div>
                {cam.status === 'denied' && (
                  <Alert kind="warn">Camera access was blocked. You can upload photos instead.</Alert>
                )}
              </div>
              {files.length > 0 && <p>{files.length} photo(s) ready to check.</p>}
              <button
                className="btn-primary self-start"
                disabled={!files.length || upload.isPending}
                onClick={() => upload.mutate()}
              >
                {upload.isPending ? 'Checking photos…' : 'Check and add photos'}
              </button>
            </div>
            <ErrorText error={upload.error} />
            {results && (
              <ul className="flex flex-col gap-1" aria-live="polite">
                {results.results.map((r) => (
                  <li key={r.index} className={r.ok ? 'text-ok-ink' : 'text-bad-ink'}>
                    {r.ok ? '✓' : '✗'} {r.filename}: {r.ok ? 'added' : r.message}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section className="card flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Consent</h2>
        {person.hasActiveConsent ? (
          <>
            <p>
              Given by <strong>{person.consent.givenBy}</strong> (
              {person.consent.givenByRole === 'person' ? 'the person' : 'caregiver on their behalf'})
              {person.consent.givenAt && <> on {formatDateTime(person.consent.givenAt)}</>}. Covers:{' '}
              {person.consent.scope.join(', ')}.
              {person.consent.reason && <> Reason: {person.consent.reason}</>}
            </p>
            {confirmRevoke ? (
              <Alert kind="warn">
                <p className="mb-3">
                  Withdrawing consent permanently deletes all of {person.name}'s photos and face data.
                </p>
                <div className="flex gap-2">
                  <button className="btn-danger" onClick={() => revoke.mutate()}>
                    Withdraw consent
                  </button>
                  <button className="btn-secondary" onClick={() => setConfirmRevoke(false)}>
                    Cancel
                  </button>
                </div>
              </Alert>
            ) : (
              <button className="btn-secondary self-start" onClick={() => setConfirmRevoke(true)}>
                Withdraw consent
              </button>
            )}
          </>
        ) : (
          <>
            <Alert kind="warn">
              Consent was withdrawn
              {person.consent.revokedAt && <> on {formatDateTime(person.consent.revokedAt)}</>}. Face data was
              deleted.
            </Alert>
            <ConsentForm value={consent} onChange={setConsent} />
            <button
              className="btn-primary self-start"
              disabled={!consentValid(consent) || grant.isPending}
              onClick={() => grant.mutate()}
            >
              Record consent again
            </button>
            <ErrorText error={grant.error} />
          </>
        )}
      </section>

      <section className="card flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Delete this person</h2>
        <p>Deletes their profile, photos, face data, visits and memories about them.</p>
        {confirmDelete ? (
          <div className="flex gap-2">
            <button className="btn-danger" onClick={() => del.mutate()}>
              Yes, delete {person.name}
            </button>
            <button className="btn-secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button className="btn-danger self-start" onClick={() => setConfirmDelete(true)}>
            Delete person
          </button>
        )}
      </section>
    </div>
  );
}
