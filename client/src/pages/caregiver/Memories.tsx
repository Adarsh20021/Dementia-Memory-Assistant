/** Timeline (visits + memories), patient-entry review queue, and new memory with an AI draft. */
import { Sparkles } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api/client';
import type { Memory, Person, Visit } from '../../api/types';
import { Alert, ErrorText, MicButton, Spinner, formatDateTime } from '../../components/ui';
import { useSpeechInput } from '../../hooks/useSpeechInput';

const SOURCE_LABEL = {
  caregiver: 'Caregiver',
  'ai-summary': 'AI draft (approved)',
  patient: 'Patient',
} as const;
const STATUS_STYLE = {
  pending: 'bg-warn-bg text-warn-ink',
  approved: 'bg-ok-bg text-ok-ink',
  flagged: 'bg-bad-bg text-bad-ink',
} as const;

function usePeople(patientId?: string) {
  return useQuery({
    queryKey: ['people', patientId],
    queryFn: () => api<{ people: Person[] }>(`/api/patients/${patientId}/people`),
  });
}

function History({ m }: { m: Memory }) {
  if (!m.history?.length) return null;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer underline">Version history ({m.history.length} earlier)</summary>
      <ol className="mt-2 flex flex-col gap-1">
        {m.history.map((h) => (
          <li key={h.version}>
            v{h.version} · {formatDateTime(h.editedAt)}: “{h.summary}”
          </li>
        ))}
      </ol>
    </details>
  );
}

function MemoryItem({ m, patientId, personName }: { m: Memory; patientId: string; personName?: string }) {
  const qc = useQueryClient();
  const base = `/api/patients/${patientId}/memories/${m.id}`;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.summary);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['memories', patientId] });
    void qc.invalidateQueries({ queryKey: ['review', patientId] });
  };
  const save = useMutation({
    mutationFn: () => api(base, { method: 'PATCH', body: { summary: text } }),
    onSuccess: () => {
      setEditing(false);
      refresh();
    },
  });
  const del = useMutation({ mutationFn: () => api(base, { method: 'DELETE' }), onSuccess: refresh });
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="badge bg-soft text-ink">Memory · {SOURCE_LABEL[m.source]}</span>
        <span className={`badge ${STATUS_STYLE[m.reviewStatus]}`}>{m.reviewStatus}</span>
        <span className="badge bg-ok-bg text-ok-ink">
          {(personName ?? m.personName)
            ? `About ${personName ?? m.personName}`
            : 'Not about a specific person'}
        </span>
        <span>v{m.version}</span>
      </div>
      {editing ? (
        <>
          <textarea className="input" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="flex gap-2">
            <button className="btn-primary" onClick={() => save.mutate()}>
              Save
            </button>
            <button className="btn-secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <p>“{m.summary}”</p>
      )}
      <History m={m} />
      {!editing && (
        <div className="flex gap-3 text-sm">
          <button className="underline" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button className="text-bad-ink underline" onClick={() => del.mutate()}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

export function Timeline() {
  const { patientId } = useParams();
  const qc = useQueryClient();
  const [personId, setPersonId] = useState('');
  const [q, setQ] = useState('');
  const people = usePeople(patientId);
  const names = useMemo(() => new Map((people.data?.people ?? []).map((p) => [p.id, p.name])), [people.data]);
  const qs = personId ? `?personId=${personId}` : '';
  const visits = useQuery({
    queryKey: ['visits', patientId, personId],
    queryFn: () => api<{ visits: Visit[] }>(`/api/patients/${patientId}/visits${qs}`),
  });
  const memories = useQuery({
    queryKey: ['memories', patientId, personId],
    queryFn: () => api<{ memories: Memory[] }>(`/api/patients/${patientId}/memories${qs}`),
  });
  const confirm = useMutation({
    mutationFn: ({ id, confirmed }: { id: string; confirmed: boolean }) =>
      api(`/api/patients/${patientId}/visits/${id}/confirm`, { body: { confirmed } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['visits', patientId] }),
  });
  const delVisit = useMutation({
    mutationFn: (id: string) => api(`/api/patients/${patientId}/visits/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['visits', patientId] }),
  });

  const needle = q.trim().toLowerCase();
  const items = [
    ...(visits.data?.visits ?? []).map((v) => ({ kind: 'visit' as const, at: v.timestamp, v })),
    ...(memories.data?.memories ?? []).map((m) => ({ kind: 'memory' as const, at: m.createdAt, m })),
  ]
    .filter((i) =>
      !needle
        ? true
        : i.kind === 'visit'
          ? (i.v.personName ?? '').toLowerCase().includes(needle)
          : i.m.summary.toLowerCase().includes(needle) ||
            (names.get(i.m.personId ?? '') ?? '').toLowerCase().includes(needle),
    )
    .sort((a, b) => b.at.localeCompare(a.at));

  return (
    <div className="flex flex-col gap-4">
      <div className="card grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="person">
            Person
          </label>
          <select
            id="person"
            className="input"
            value={personId}
            onChange={(e) => setPersonId(e.target.value)}
          >
            <option value="">Everyone</option>
            {people.data?.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="q">
            Search
          </label>
          <input
            id="q"
            className="input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="mangoes, Priya…"
          />
        </div>
      </div>
      {(visits.isLoading || memories.isLoading) && <Spinner />}
      <ErrorText error={visits.error ?? memories.error} />
      {items.length === 0 && !visits.isLoading && <Alert>Nothing in the timeline yet.</Alert>}
      <ol className="flex flex-col gap-3">
        {items.map((i) => (
          <li key={`${i.kind}-${i.kind === 'visit' ? i.v.id : i.m.id}`} className="card flex flex-col gap-2">
            <span className="text-sm text-sub">{formatDateTime(i.at)}</span>
            {i.kind === 'visit' ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="badge mr-2 bg-soft text-ink">Visit</span>
                  <strong>{i.v.personName}</strong>
                  {i.v.matchConfidence !== undefined && <> · score {i.v.matchConfidence.toFixed(2)}</>}
                  {i.v.outcome === 'manual' && <> · added manually</>}
                  {i.v.needsConfirmation && (
                    <span className="badge ml-2 bg-warn-bg text-warn-ink">needs confirmation</span>
                  )}
                  {i.v.confirmedByCaregiver === false && (
                    <span className="badge ml-2 bg-bad-bg text-bad-ink">rejected</span>
                  )}
                </span>
                <span className="flex gap-2 text-sm">
                  {i.v.needsConfirmation && (
                    <>
                      <button
                        className="btn-primary"
                        onClick={() => confirm.mutate({ id: i.v.id, confirmed: true })}
                      >
                        Confirm
                      </button>
                      <button
                        className="btn-secondary"
                        onClick={() => confirm.mutate({ id: i.v.id, confirmed: false })}
                      >
                        Reject
                      </button>
                    </>
                  )}
                  <button className="text-bad-ink underline" onClick={() => delVisit.mutate(i.v.id)}>
                    Delete
                  </button>
                </span>
              </div>
            ) : (
              <MemoryItem m={i.m} patientId={patientId!} personName={names.get(i.m.personId ?? '')} />
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function ReviewQueue() {
  const { patientId } = useParams();
  const qc = useQueryClient();
  const people = usePeople(patientId);
  const names = new Map((people.data?.people ?? []).map((p) => [p.id, p.name]));
  const { data, isLoading, error } = useQuery({
    queryKey: ['review', patientId],
    queryFn: () => api<{ memories: Memory[] }>(`/api/patients/${patientId}/memories/review-queue`),
  });
  const [corrections, setCorrections] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const review = useMutation({
    mutationFn: ({
      id,
      action,
      summary,
    }: {
      id: string;
      action: 'approve' | 'flag' | 'correct';
      summary?: string;
    }) =>
      api<{ note?: string }>(`/api/patients/${patientId}/memories/${id}/review`, {
        body: { action, summary },
      }),
    onSuccess: (r, v) => {
      if (r.note) setNotes((n) => ({ ...n, [v.id]: r.note! }));
      void qc.invalidateQueries({ queryKey: ['review', patientId] });
      void qc.invalidateQueries({ queryKey: ['overview', patientId] });
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <Alert>
        The patient's own entries are saved straight away but are only used for summaries after you approve
        them, because they may contain confusion. When you correct one, the original wording is kept in the
        version history.
      </Alert>
      {isLoading && <Spinner />}
      <ErrorText error={error ?? review.error} />
      {Object.values(notes).map((n, i) => (
        <Alert key={i} kind="warn">
          {n}
        </Alert>
      ))}
      {data?.memories.length === 0 && <Alert kind="success">Nothing to review. You are all caught up.</Alert>}
      {data?.memories.map((m) => {
        const corrected = corrections[m.id] ?? m.summary;
        return (
          <section key={m.id} className="card flex flex-col gap-3">
            <div className="text-sm">
              {formatDateTime(m.createdAt)}{' '}
              <span className="badge bg-ok-bg text-ok-ink">
                {m.personId
                  ? `About ${names.get(m.personId) ?? m.personName ?? 'someone'}`
                  : 'Not about a specific person'}
              </span>
            </div>
            <textarea
              className="input"
              aria-label="Entry text"
              value={corrected}
              onChange={(e) => setCorrections({ ...corrections, [m.id]: e.target.value })}
            />
            <History m={m} />
            <div className="flex flex-wrap gap-2">
              {corrected === m.summary ? (
                <button
                  className="btn-primary"
                  onClick={() => review.mutate({ id: m.id, action: 'approve' })}
                >
                  Approve
                </button>
              ) : (
                <button
                  className="btn-primary"
                  onClick={() => review.mutate({ id: m.id, action: 'correct', summary: corrected })}
                >
                  Save correction and approve
                </button>
              )}
              <button className="btn-secondary" onClick={() => review.mutate({ id: m.id, action: 'flag' })}>
                Flag (don't use)
              </button>
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function NewMemory() {
  const { patientId } = useParams();
  const navigate = useNavigate();
  const people = usePeople(patientId);
  const eligible = (people.data?.people ?? []).filter(
    (p) => p.hasActiveConsent && p.consent.scope.includes('conversation-summaries'),
  );
  const [personId, setPersonId] = useState('');
  const [notes, setNotes] = useState('');
  const [summary, setSummary] = useState('');
  const [source, setSource] = useState<'caregiver' | 'ai-summary'>('caregiver');
  const [info, setInfo] = useState<string | null>(null);
  const append = useCallback((t: string) => setNotes((n) => (n ? `${n} ${t}` : t)), []);
  const mic = useSpeechInput(append);
  const appendSummary = useCallback((t: string) => setSummary((s) => (s ? `${s} ${t}` : t)), []);
  const summaryMic = useSpeechInput(appendSummary);

  const draft = useMutation({
    mutationFn: () =>
      api<{ draft: string | null; source: string; message: string; warning?: string }>(
        `/api/patients/${patientId}/memories/draft`,
        {
          body: { personId, notes },
        },
      ),
    onSuccess: (r) => {
      setInfo(
        r.warning && r.source === 'llm'
          ? `${r.message} (Check carefully: ${r.warning.replace(/_/g, ' ')}.)`
          : r.message,
      );
      if (r.draft) {
        setSummary(r.draft);
        setSource(r.source === 'llm' ? 'ai-summary' : 'caregiver');
      }
    },
  });
  const save = useMutation({
    mutationFn: () => api(`/api/patients/${patientId}/memories`, { body: { personId, summary, source } }),
    onSuccess: () => navigate(`/care/patients/${patientId}/timeline`),
  });

  return (
    <div className="flex flex-col gap-4">
      <section className="card flex flex-col gap-3">
        <h2 className="text-xl font-semibold">1. Who visited?</h2>
        <select
          className="input"
          aria-label="Person"
          value={personId}
          onChange={(e) => setPersonId(e.target.value)}
        >
          <option value="">Choose a person…</option>
          {eligible.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.relationship})
            </option>
          ))}
        </select>
        {people.data && eligible.length < people.data.people.length && (
          <p className="text-sm">Only people who consented to visit summaries are listed.</p>
        )}
      </section>
      <section className="card flex flex-col gap-3">
        <h2 className="text-xl font-semibold">2. Your notes (optional)</h2>
        <textarea
          className="input min-h-[120px]"
          aria-label="Notes"
          placeholder="Rough notes about the visit. Paste or dictate."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <MicButton
            supported={mic.supported}
            listening={mic.listening}
            transcribing={mic.transcribing}
            onStart={mic.start}
            onStop={mic.stop}
            label="Dictate"
          />
          <button
            className="btn-secondary"
            disabled={!personId || notes.trim().length < 3 || draft.isPending}
            onClick={() => draft.mutate()}
          >
            <Sparkles size={18} aria-hidden />
            {draft.isPending ? 'Drafting…' : 'Draft a summary with AI'}
          </button>
        </div>
        {info && <Alert kind="info">{info}</Alert>}
        {mic.error && <Alert kind="warn">{mic.error}</Alert>}
        <ErrorText error={draft.error} />
      </section>
      <section className="card flex flex-col gap-3">
        <h2 className="text-xl font-semibold">3. The memory (what the patient may hear)</h2>
        <textarea
          className="input min-h-[100px]"
          aria-label="Memory"
          placeholder="e.g. Priya brought mangoes and you looked at old photos together."
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          maxLength={1000}
        />
        <MicButton
          supported={summaryMic.supported}
          listening={summaryMic.listening}
          transcribing={summaryMic.transcribing}
          onStart={summaryMic.start}
          onStop={summaryMic.stop}
          label="Dictate the memory"
        />
        {summaryMic.error && <Alert kind="warn">{summaryMic.error}</Alert>}
        <p className="text-sm">Saving approves this memory. Only short, kind, factual sentences please.</p>
        <button
          className="btn-primary self-start"
          disabled={!personId || !summary.trim() || save.isPending}
          onClick={() => save.mutate()}
        >
          Approve and save
        </button>
        <ErrorText error={save.error} />
      </section>
    </div>
  );
}
