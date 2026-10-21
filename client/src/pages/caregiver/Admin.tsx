/** Settings (pairing, retention, export, delete), audit log viewer, and evaluation (latency + SUS). */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, apiBlob, saveBlob } from '../../api/client';
import type { Patient, SystemStatus, User } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { Alert, ErrorText, Spinner, formatDateTime } from '../../components/ui';

const LANGUAGES = [
  ['en', 'English'],
  ['hi', 'हिन्दी (Hindi)'],
  ['kn', 'ಕನ್ನಡ (Kannada)'],
  ['ta', 'தமிழ் (Tamil)'],
  ['te', 'తెలుగు (Telugu)'],
  ['ml', 'മലയാളം (Malayalam)'],
  ['mr', 'मराठी (Marathi)'],
  ['bn', 'বাংলা (Bengali)'],
  ['gu', 'ગુજરાતી (Gujarati)'],
];

interface Settings {
  thresholds: { match: number; unsure: number; editable: boolean };
  language: string;
  retentionDays: number;
  pinEnabled: boolean;
}

/**
 * Three ways to get the patient's device signed in, easiest first:
 *  1. One tap: the caregiver signs in ON the patient's tablet and switches it.
 *  2. PIN: if the device is ever signed out, the patient types their PIN.
 *  3. A one-time code typed on the device.
 */
function DeviceSetup({ patientId, pinEnabled }: { patientId: string; pinEnabled: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { becomePatient } = useAuth();
  const base = `/api/patients/${patientId}`;
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [pin, setPin] = useState('');
  const switchDevice = useMutation({
    mutationFn: () =>
      api<{ accessToken: string; user: User; patient: Patient }>(`${base}/device-session`, {
        method: 'POST',
      }),
    onSuccess: (r) => {
      becomePatient(r);
      navigate('/patient');
    },
  });
  const savePin = useMutation({
    mutationFn: () => api(`${base}/pin`, { method: 'PUT', body: { pin } }),
    onSuccess: () => {
      setPin('');
      void qc.invalidateQueries({ queryKey: ['settings', patientId] });
    },
  });
  const removePin = useMutation({
    mutationFn: () => api(`${base}/pin`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['settings', patientId] }),
  });
  const pairing = useMutation({
    mutationFn: () => api<{ code: string; expiresAt: string }>(`${base}/pairing-code`, { method: 'POST' }),
  });
  const revokeDevices = useMutation({ mutationFn: () => api(`${base}/revoke-devices`, { method: 'POST' }) });

  return (
    <section className="card flex flex-col gap-5">
      <div>
        <h2 className="text-xl font-semibold">Patient device</h2>
        <p className="text-sub">A paired device stays signed in for months. Pick whichever way is easiest.</p>
      </div>

      <div className="flex flex-col gap-2 rounded-xl border border-line p-4">
        <h3 className="font-semibold">1. Use this device for the patient (no code)</h3>
        <p className="text-sm text-sub">
          Open this dashboard on the patient's tablet or phone and tap the button. You will be signed out on
          this device, so the patient can never reach the caregiver dashboard.
        </p>
        {confirmSwitch ? (
          <div className="flex flex-wrap gap-2">
            <button
              className="btn-primary"
              onClick={() => switchDevice.mutate()}
              disabled={switchDevice.isPending}
            >
              Yes, switch this device
            </button>
            <button className="btn-secondary" onClick={() => setConfirmSwitch(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button className="btn-primary self-start" onClick={() => setConfirmSwitch(true)}>
            Use this device for the patient
          </button>
        )}
        <ErrorText error={switchDevice.error} />
      </div>

      <div className="flex flex-col gap-2 rounded-xl border border-line p-4">
        <h3 className="font-semibold">
          2. Patient PIN {pinEnabled && <span className="badge bg-ok-bg text-ok-ink">On</span>}
        </h3>
        <p className="text-sm text-sub">
          If the patient's device is ever signed out, it shows "Welcome back" and a big number pad. No new
          code needed. Use 4 to 6 numbers that are easy for them to remember.
        </p>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            savePin.mutate();
          }}
        >
          <div>
            <label className="label" htmlFor="pin">
              {pinEnabled ? 'New PIN' : 'PIN'}
            </label>
            <input
              id="pin"
              className="input w-40 text-center font-mono text-xl tracking-widest"
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </div>
          <button className="btn-secondary" disabled={pin.length < 4 || savePin.isPending}>
            {pinEnabled ? 'Change PIN' : 'Set PIN'}
          </button>
          {pinEnabled && (
            <button type="button" className="btn-secondary" onClick={() => removePin.mutate()}>
              Remove PIN
            </button>
          )}
        </form>
        {savePin.isSuccess && <Alert kind="success">PIN saved.</Alert>}
        <ErrorText error={savePin.error ?? removePin.error} />
      </div>

      <div className="flex flex-col gap-2 rounded-xl border border-line p-4">
        <h3 className="font-semibold">3. One-time code</h3>
        <p className="text-sm text-sub">Type it on the device, on the page "Set up this device".</p>
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary" onClick={() => pairing.mutate()} disabled={pairing.isPending}>
            Create pairing code
          </button>
          <button className="btn-secondary" onClick={() => revokeDevices.mutate()}>
            Sign out all patient devices
          </button>
        </div>
        {pairing.data && (
          <div className="rounded-2xl bg-soft p-4" role="status">
            <div className="font-mono text-4xl tracking-widest" data-testid="pairing-code">
              {pairing.data.code}
            </div>
            <div>Works once, until {new Date(pairing.data.expiresAt).toLocaleTimeString()}.</div>
          </div>
        )}
        {revokeDevices.isSuccess && <Alert kind="success">All patient devices were signed out.</Alert>}
        <ErrorText error={pairing.error ?? revokeDevices.error} />
      </div>
    </section>
  );
}

/** Shows whether the AI and face service work, with a "Test AI" button. */
function SystemStatusCard() {
  const status = useQuery({
    queryKey: ['system-status'],
    queryFn: () => api<SystemStatus>('/api/system/status'),
  });
  const test = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; reply?: string; reason?: string; detail?: string; ms: number; model: string }>(
        '/api/system/ai-test',
        { method: 'POST' },
      ),
    onSettled: () => void status.refetch(),
  });
  const ai = status.data?.ai;
  const face = status.data?.face;
  const voice = status.data?.voice;
  const dot = (ok: boolean) => (
    <span
      aria-hidden
      className={`inline-block h-2.5 w-2.5 rounded-full ${ok ? 'bg-ok-ink' : 'bg-bad-ink'}`}
    />
  );
  return (
    <section className="card flex flex-col gap-3">
      <h2 className="text-xl font-semibold">System status</h2>
      {status.isLoading && <Spinner />}
      {ai && (
        <div className="flex flex-col gap-1">
          <p className="flex items-center gap-2 font-semibold">
            {dot(ai.enabled && (ai.lastCall?.ok ?? true))} AI summaries (Groq, model {ai.model})
          </p>
          {!ai.configured && (
            <Alert kind="warn">
              No AI key yet. Add GROQ_API_KEY to server/.env and restart. Until then simple built-in sentences
              are used.
            </Alert>
          )}
          {ai.configured && ai.lastCall && !ai.lastCall.ok && (
            <p className="text-sm text-bad-ink">
              Last attempt failed{ai.lastCall.httpStatus ? ` (HTTP ${ai.lastCall.httpStatus})` : ''}:{' '}
              {ai.lastCall.detail ?? ai.lastCall.reason}
            </p>
          )}
          <p className="text-sm text-sub">
            Today: {ai.today.calls} calls, {ai.today.failures} failed (limit {ai.dailyLimit}).
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-secondary" onClick={() => test.mutate()} disabled={test.isPending}>
              {test.isPending ? 'Testing…' : 'Test AI'}
            </button>
            {test.data?.ok && (
              <Alert kind="success">
                Working: “{test.data.reply}” ({test.data.ms} ms)
              </Alert>
            )}
            {test.data && !test.data.ok && (
              <Alert kind="error">
                Not working ({test.data.reason}). {test.data.detail}
              </Alert>
            )}
          </div>
        </div>
      )}
      {face && (
        <p className="flex flex-wrap items-center gap-2 font-semibold">
          {dot(face.reachable && face.modelsLoaded && !face.problem)} Face recognition service{' '}
          <span className="font-normal text-sub">
            {!face.reachable
              ? `not running at ${face.url} (start it with npm run dev)`
              : face.problem === 'secret_mismatch'
                ? 'running, but FACE_SERVICE_SECRET does not match'
                : face.problem === 'models_not_loaded'
                  ? 'running, but the face models are missing (run npm run setup)'
                  : 'running'}
          </span>
        </p>
      )}
      {voice && (
        <div className="flex flex-col gap-1">
          <p className="flex flex-wrap items-center gap-2 font-semibold">
            {dot(voice.enabled && (voice.lastCall?.ok ?? true))} Voice typing{' '}
            <span className="font-normal text-sub">
              {voice.mode === 'off'
                ? "off on the server (VOICE_TRANSCRIBE=off): the browser's own voice typing is used"
                : !voice.enabled
                  ? 'needs GROQ_API_KEY in server/.env'
                  : `Groq, model ${voice.lastCall?.model ?? voice.model}`}
            </span>
          </p>
          {voice.lastCall && !voice.lastCall.ok && (
            <p className="text-sm text-bad-ink">
              Last attempt failed{voice.lastCall.httpStatus ? ` (HTTP ${voice.lastCall.httpStatus})` : ''}:{' '}
              {voice.lastCall.detail || 'no details'}
            </p>
          )}
          {voice.lastCall?.ok && <p className="text-sm text-sub">Last attempt worked.</p>}
        </div>
      )}
      <ErrorText error={status.error} />
    </section>
  );
}

export function SettingsPage() {
  const { patientId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const base = `/api/patients/${patientId}`;
  const settings = useQuery({
    queryKey: ['settings', patientId],
    queryFn: () => api<{ settings: Settings }>(`${base}/settings`),
  });
  const patient = useQuery({
    queryKey: ['patient', patientId],
    queryFn: () => api<{ patient: Patient }>(base),
  });
  const [language, setLanguage] = useState('en');
  const [retention, setRetention] = useState(365);
  const [name, setName] = useState('');
  useEffect(() => {
    if (settings.data) {
      setLanguage(settings.data.settings.language);
      setRetention(settings.data.settings.retentionDays);
    }
  }, [settings.data]);
  useEffect(() => {
    if (patient.data) setName(patient.data.patient.name);
  }, [patient.data]);

  const saveSettings = useMutation({
    mutationFn: () =>
      api(`${base}/settings`, { method: 'PATCH', body: { language, retentionDays: retention } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['settings', patientId] }),
  });
  const saveName = useMutation({
    mutationFn: () => api(base, { method: 'PATCH', body: { name } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['patient', patientId] }),
  });
  const exportData = useMutation({
    mutationFn: async () => saveBlob(await apiBlob(`${base}/export`), `patient-${patientId}-export.json`),
  });
  const [confirmText, setConfirmText] = useState('');
  const deleteAll = useMutation({
    mutationFn: () => api(base, { method: 'DELETE', body: { confirm: 'DELETE' } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['patients'] });
      navigate('/care');
    },
  });

  if (settings.isLoading) return <Spinner />;
  const s = settings.data?.settings;

  return (
    <div className="flex flex-col gap-5">
      <ErrorText error={settings.error} />
      <DeviceSetup patientId={patientId!} pinEnabled={Boolean(s?.pinEnabled)} />
      <SystemStatusCard />

      <section className="card flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Patient</h2>
        <div className="flex flex-wrap gap-2">
          <input
            className="input max-w-sm"
            aria-label="Patient name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="btn-secondary" onClick={() => saveName.mutate()} disabled={!name.trim()}>
            Rename
          </button>
        </div>
      </section>

      <section className="card flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Language and data retention</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="lang">
              Speech and dates language
            </label>
            <select
              id="lang"
              className="input"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              {LANGUAGES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="ret">
              Keep visit records for (days)
            </label>
            <input
              id="ret"
              type="number"
              min={1}
              max={3650}
              className="input"
              value={retention}
              onChange={(e) => setRetention(Number(e.target.value))}
            />
          </div>
        </div>
        <button className="btn-primary self-start" onClick={() => saveSettings.mutate()}>
          Save
        </button>
        {saveSettings.isSuccess && <Alert kind="success">Saved.</Alert>}
        <ErrorText error={saveSettings.error} />
        {s && (
          <p className="text-sm">
            Recognition thresholds (set by the administrator in the server's .env): confident match ≥{' '}
            {s.thresholds.match}, "This may be…" ≥ {s.thresholds.unsure}. Below that, the patient hears "I
            don't recognize this person."
          </p>
        )}
      </section>

      <section className="card flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Export</h2>
        <p>
          Download all of this patient's data as a JSON file (face photos and face data are not included).
        </p>
        <button
          className="btn-secondary self-start"
          onClick={() => exportData.mutate()}
          disabled={exportData.isPending}
        >
          Download data (JSON)
        </button>
        <ErrorText error={exportData.error} />
      </section>

      <section className="card flex flex-col gap-3 border-bad-ink">
        <h2 className="text-xl font-semibold text-bad-ink">Delete all data</h2>
        <p>
          Permanently deletes this patient, every familiar person, all photos, face data, visits, memories and
          notes. This cannot be undone. Type <strong>DELETE</strong> to confirm.
        </p>
        <input
          className="input max-w-xs"
          aria-label="Type DELETE"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
        />
        <button
          className="btn-danger self-start"
          disabled={confirmText !== 'DELETE' || deleteAll.isPending}
          onClick={() => deleteAll.mutate()}
        >
          Delete everything
        </button>
        <ErrorText error={deleteAll.error} />
      </section>
    </div>
  );
}

interface AuditEntry {
  id: string;
  actorId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  timestamp: string;
  ip?: string;
}

export function AuditLogPage() {
  const { patientId } = useParams();
  const q = useInfiniteQuery({
    queryKey: ['audit', patientId],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      api<{ logs: AuditEntry[] }>(
        `/api/patients/${patientId}/audit-logs?limit=50${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (last) =>
      last.logs.length === 50 ? last.logs[last.logs.length - 1].timestamp : undefined,
  });
  const logs = q.data?.pages.flatMap((p) => p.logs) ?? [];
  return (
    <div className="card flex flex-col gap-3 overflow-x-auto">
      <ErrorText error={q.error} />
      {q.isLoading && <Spinner />}
      <table className="w-full text-left text-sm">
        <thead>
          <tr>
            <th className="py-1">When</th>
            <th>Action</th>
            <th>Item</th>
            <th>By</th>
            <th>IP</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((l) => (
            <tr key={l.id} className="border-t border-line">
              <td className="py-1">{formatDateTime(l.timestamp)}</td>
              <td className="font-mono">{l.action}</td>
              <td>
                {l.entityType} {l.entityId?.slice(-6)}
              </td>
              <td className="font-mono">{l.actorId?.slice(-6) ?? 'system'}</td>
              <td>{l.ip}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {q.hasNextPage && (
        <button
          className="btn-secondary self-start"
          onClick={() => void q.fetchNextPage()}
          disabled={q.isFetchingNextPage}
        >
          Load older
        </button>
      )}
    </div>
  );
}

interface EvalSummary {
  events: number;
  outcomes: Record<string, number>;
  latencyMs: Record<string, { n: number; p50: number | null; p95: number | null; max: number | null }>;
  underTargetRate: number | null;
  summarySources: Record<string, number>;
  llmFallbackRate: number | null;
}
interface SusData {
  items: string[];
  responses: { id: string; respondentRole: string; score: number; createdAt: string }[];
  meanScore: number | null;
}

export function EvaluationPage() {
  const { patientId } = useParams();
  const qc = useQueryClient();
  const base = `/api/patients/${patientId}`;
  const summary = useQuery({
    queryKey: ['eval', patientId],
    queryFn: () => api<EvalSummary>(`${base}/evaluation/summary`),
  });
  const sus = useQuery({ queryKey: ['sus', patientId], queryFn: () => api<SusData>(`${base}/sus`) });
  const [answers, setAnswers] = useState<number[]>(Array(10).fill(0));
  const [role, setRole] = useState('caregiver');
  const [comment, setComment] = useState('');
  const submit = useMutation({
    mutationFn: () =>
      api<{ score: number }>(`${base}/sus`, {
        body: { respondentRole: role, answers, ...(comment ? { comment } : {}) },
      }),
    onSuccess: () => {
      setAnswers(Array(10).fill(0));
      setComment('');
      void qc.invalidateQueries({ queryKey: ['sus', patientId] });
    },
  });
  const csv = useMutation({
    mutationFn: async () =>
      saveBlob(await apiBlob(`${base}/evaluation/events.csv`), 'recognition-events.csv'),
  });
  const s = summary.data;

  return (
    <div className="flex flex-col gap-5">
      <section className="card flex flex-col gap-3 overflow-x-auto">
        <h2 className="text-xl font-semibold">Recognition performance</h2>
        {summary.isLoading && <Spinner />}
        <ErrorText error={summary.error} />
        {s && (
          <>
            <p>
              {s.events} recognitions ·{' '}
              {Object.entries(s.outcomes)
                .map(([k, v]) => `${k}: ${v}`)
                .join(' · ')}
            </p>
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th>Stage (ms)</th>
                  <th>n</th>
                  <th>median</th>
                  <th>p95</th>
                  <th>max</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(s.latencyMs).map(([k, v]) => (
                  <tr key={k} className="border-t border-line">
                    <td className="py-1">{k}</td>
                    <td>{v.n}</td>
                    <td>{v.p50 ?? '—'}</td>
                    <td>{v.p95 ?? '—'}</td>
                    <td>{v.max ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              End-to-end under 3 s:{' '}
              {s.underTargetRate === null ? '—' : `${Math.round(s.underTargetRate * 100)}%`} · AI sentence
              fallback rate: {s.llmFallbackRate === null ? '—' : `${Math.round(s.llmFallbackRate * 100)}%`} (
              {Object.entries(s.summarySources)
                .map(([k, v]) => `${k} ${v}`)
                .join(', ') || 'none yet'}
              )
            </p>
          </>
        )}
        <button className="btn-secondary self-start" onClick={() => csv.mutate()}>
          Download per-recognition log (CSV)
        </button>
      </section>

      <section className="card flex flex-col gap-4">
        <h2 className="text-xl font-semibold">Usability questionnaire (SUS)</h2>
        <p>
          Mean score: <strong>{sus.data?.meanScore ?? '—'}</strong> from {sus.data?.responses.length ?? 0}{' '}
          response(s). (68 is average; above 80 is excellent.)
        </p>
        <div>
          <label className="label" htmlFor="role">
            Who is answering?
          </label>
          <select id="role" className="input max-w-xs" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="caregiver">Caregiver</option>
            <option value="patient">Patient</option>
            <option value="family">Family member</option>
            <option value="other">Other</option>
          </select>
        </div>
        <ol className="flex flex-col gap-3">
          {sus.data?.items.map((item, i) => (
            <li key={i}>
              <fieldset>
                <legend className="mb-1">
                  {i + 1}. {item}
                </legend>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm">Strongly disagree</span>
                  {[1, 2, 3, 4, 5].map((v) => (
                    <label key={v} className="flex items-center gap-1">
                      <input
                        type="radio"
                        name={`sus-${i}`}
                        checked={answers[i] === v}
                        onChange={() => setAnswers(answers.map((a, j) => (j === i ? v : a)))}
                      />
                      {v}
                    </label>
                  ))}
                  <span className="text-sm">Strongly agree</span>
                </div>
              </fieldset>
            </li>
          ))}
        </ol>
        <textarea
          className="input"
          aria-label="Comment"
          placeholder="Comments (optional)"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        <button
          className="btn-primary self-start"
          disabled={answers.some((a) => a === 0) || submit.isPending}
          onClick={() => submit.mutate()}
        >
          Save response
        </button>
        {submit.data && <Alert kind="success">Saved. Score: {submit.data.score}</Alert>}
        <ErrorText error={submit.error} />
      </section>
    </div>
  );
}
