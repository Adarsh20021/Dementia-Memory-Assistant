/** Dashboard overview: what needs the caregiver's attention right now. */
import { BellRing, Check } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api/client';
import type { Overview as OverviewData } from '../../api/types';
import { Alert, ErrorText, Spinner, formatDateTime, whenText } from '../../components/ui';

const OUTCOME_LABEL: Record<string, string> = {
  match: 'Recognised',
  unsure: 'Unsure',
  unknown: 'Not recognised',
  no_face: 'No face seen',
  liveness_failed: 'Liveness check failed',
  error: 'Error',
};

export default function Overview() {
  const { patientId } = useParams();
  const qc = useQueryClient();
  const base = `/api/patients/${patientId}`;
  const { data, isLoading, error } = useQuery({
    queryKey: ['overview', patientId],
    queryFn: () => api<OverviewData>(`${base}/overview`),
    refetchInterval: 30_000,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['overview', patientId] });
  const confirm = useMutation({
    mutationFn: ({ id, confirmed }: { id: string; confirmed: boolean }) =>
      api(`${base}/visits/${id}/confirm`, { body: { confirmed } }),
    onSuccess: refresh,
  });
  const resolve = useMutation({
    mutationFn: (id: string) => api(`${base}/help-requests/${id}/resolve`, { method: 'POST' }),
    onSuccess: refresh,
  });

  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorText error={error} />;
  const c = data.counts;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {[
          ['People', c.people],
          ['With face photos', c.enrolled],
          ['Entries to review', c.pendingReviews],
          ['Visits to confirm', c.unsureVisits],
          ['Help requests', c.openHelpRequests],
        ].map(([label, n]) => (
          <div key={label} className="card flex flex-col gap-1 p-5">
            <div className="text-sm font-medium text-sub">{label}</div>
            <div className="font-serif text-4xl font-semibold tracking-tight">{n}</div>
          </div>
        ))}
      </div>

      <GettingStarted setup={data.setup} patientId={patientId!} />

      <section className="card flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xl font-semibold">Coming up</h2>
          <Link className="btn-secondary min-h-[40px] px-4" to={`/care/patients/${patientId}/visits`}>
            Plan a visit
          </Link>
        </div>
        {data.upcomingVisits.length === 0 ? (
          <p className="text-sub">No visits planned.</p>
        ) : (
          <ul className="divide-y divide-line">
            {data.upcomingVisits.map((v) => (
              <li key={v.id} className="flex flex-wrap justify-between gap-2 py-2">
                <span>
                  <strong>{v.who}</strong>
                  {v.relationship && <span className="text-sub"> · {v.relationship}</span>}
                  {v.createdByRole === 'patient' && (
                    <span className="badge ml-2 bg-soft text-soft-ink">added by the patient</span>
                  )}
                </span>
                <span className="text-sub">{whenText(v.startsAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.openHelpRequests.length > 0 && (
        <section className="card flex flex-col gap-3 border-warn-ink">
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            <BellRing size={20} className="text-warn-ink" aria-hidden /> Asked for help
          </h2>
          {data.openHelpRequests.map((h) => (
            <div key={h.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>{formatDateTime(h.createdAt)}</span>
              <button className="btn-secondary" onClick={() => resolve.mutate(h.id)}>
                Mark as handled
              </button>
            </div>
          ))}
        </section>
      )}

      {data.unsureVisits.length > 0 && (
        <section className="card flex flex-col gap-3">
          <h2 className="text-xl font-semibold">Was this really them?</h2>
          <p>
            The system was unsure. Confirming keeps the visit in the history; rejecting removes it from what
            the patient hears.
          </p>
          {data.unsureVisits.map((v) => (
            <div
              key={v.id}
              className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3"
            >
              <span>
                <strong>{v.personName}</strong> · {formatDateTime(v.timestamp)} · score{' '}
                {v.matchConfidence?.toFixed(2)}
              </span>
              <span className="flex gap-2">
                <button className="btn-primary" onClick={() => confirm.mutate({ id: v.id, confirmed: true })}>
                  Yes, it was
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => confirm.mutate({ id: v.id, confirmed: false })}
                >
                  No
                </button>
              </span>
            </div>
          ))}
        </section>
      )}

      {data.pendingReviews.length > 0 && (
        <section className="card flex flex-col gap-3">
          <h2 className="text-xl font-semibold">Written by the patient — waiting for review</h2>
          {data.pendingReviews.map((m) => (
            <p key={m.id} className="border-t border-line pt-2">
              “{m.summary}” {m.personName && <span className="text-sub">· about {m.personName}</span>}
            </p>
          ))}
          <Link className="btn-primary self-start" to={`/care/patients/${patientId}/review`}>
            Review entries
          </Link>
        </section>
      )}

      {data.lowConfidence.length > 0 && (
        <section className="card flex flex-col gap-3">
          <h2 className="text-xl font-semibold">Recognition could be better</h2>
          <p>Adding clearer photos (different angles and lighting) usually helps.</p>
          {data.lowConfidence.map((p) => (
            <div
              key={p.personId}
              className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2"
            >
              <span>
                <strong>{p.name}</strong> · {p.photoCount} photo(s) · unsure {p.unsureCount}× · median score{' '}
                {p.medianScore?.toFixed(2) ?? '—'}
              </span>
              <Link className="btn-secondary" to={`/care/patients/${patientId}/people/${p.personId}`}>
                Update photos
              </Link>
            </div>
          ))}
        </section>
      )}

      <section className="card flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Recent "Who is this?"</h2>
        {data.recentEvents.length === 0 ? (
          <Alert>No recognitions yet.</Alert>
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr>
                <th className="py-1">When</th>
                <th>Result</th>
                <th>Person</th>
                <th>Score</th>
                <th>Sentence</th>
              </tr>
            </thead>
            <tbody>
              {data.recentEvents.map((e) => (
                <tr key={e.id} className="border-t border-line">
                  <td className="py-1">{formatDateTime(e.timestamp)}</td>
                  <td>{OUTCOME_LABEL[e.outcome] ?? e.outcome}</td>
                  <td>{e.personName ?? '—'}</td>
                  <td>{e.score?.toFixed(2) ?? '—'}</td>
                  <td>{e.summarySource ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-sm">
          Thresholds: match ≥ {data.thresholds.match}, unsure ≥ {data.thresholds.unsure}.
        </p>
      </section>
    </div>
  );
}

/** A short checklist for new caregivers; hides itself once everything is done. */
function GettingStarted({ setup, patientId }: { setup: OverviewData['setup']; patientId: string }) {
  const base = `/care/patients/${patientId}`;
  const steps: [boolean, string, string][] = [
    [setup.addedPerson, 'Add a familiar person (with their consent)', `${base}/people`],
    [setup.addedPhotos, 'Add 3–5 face photos of them', `${base}/people`],
    [setup.deviceReady, "Set up the patient's device (one tap, PIN or code)", `${base}/settings`],
    [setup.plannedVisit, 'Plan a visit', `${base}/visits`],
    [setup.addedMemory, 'Write a first memory', `${base}/new-memory`],
  ];
  const done = steps.filter(([d]) => d).length;
  if (done === steps.length) return null;
  return (
    <section className="card flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-xl font-semibold">Getting started</h2>
        <span className="text-sm text-sub">
          {done} of {steps.length} done
        </span>
      </div>
      <ol className="flex flex-col gap-2">
        {steps.map(([isDone, label, to], i) => (
          <li key={label} className="flex items-center gap-3">
            <span
              aria-hidden
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                isDone ? 'bg-brand text-on-brand' : 'border border-line text-sub'
              }`}
            >
              {isDone ? <Check size={16} /> : i + 1}
            </span>
            {isDone ? (
              <span className="text-sub line-through">{label}</span>
            ) : (
              <Link to={to} className="font-medium underline-offset-2 hover:underline">
                {label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
