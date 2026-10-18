/**
 * The main patient screen:
 *   - greeting and the next planned visit
 *   - live camera (can be switched off), one big "Who is this?" button
 *   - the result card, read aloud automatically (with "Say it again")
 *   - for a recognised person: everything shared about them — memories and
 *     visits — each with "Read aloud" and "Tell me simply" (AI)
 *   - "Ask a question": the answer from the database plus a short AI summary
 * Results stay on screen until the patient chooses to try again.
 */
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, Camera, CameraOff, PenLine, ScanFace, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import type { AskResponse, PersonStory, RecognitionResult, ScheduledVisit } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { AskCaregiverButton } from '../../components/AskCaregiverButton';
import { SpeakButton, useSpeak } from '../../components/speech';
import { AuthImage, MicButton, whenText } from '../../components/ui';
import { useCamera } from '../../hooks/useCamera';
import { localPref } from '../../hooks/useDraft';
import { useSpeechInput } from '../../hooks/useSpeechInput';

const FRAMES = 5;
const FRAME_INTERVAL_MS = 350;
const CAMERA_PREF = 'dma-camera-off';

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

type Phase = 'idle' | 'capturing' | 'thinking' | 'result' | 'error';

export default function WhoIsThis() {
  const { patient } = useAuth();
  const cam = useCamera();
  const { say, problem: speechProblem } = useSpeak();
  const [cameraOff, setCameraOff] = useState(() => localPref.read(CAMERA_PREF) === '1');
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<RecognitionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { start: startCamera, stop: stopCamera } = cam;

  useEffect(() => {
    if (cameraOff) stopCamera();
    else void startCamera();
  }, [cameraOff, startCamera, stopCamera]);

  const toggleCamera = () => {
    const next = !cameraOff;
    localPref.write(CAMERA_PREF, next ? '1' : '0');
    setCameraOff(next);
  };

  const upcoming = useQuery({
    queryKey: ['schedule', patient!.id, 'upcoming'],
    queryFn: () => api<{ visits: ScheduledVisit[] }>(`/api/patients/${patient!.id}/schedule?limit=3`),
    refetchInterval: 5 * 60_000,
  });
  const next = upcoming.data?.visits[0];

  const whoIsThis = async () => {
    if (!patient) return;
    setError(null);
    setResult(null);
    setPhase('capturing');
    void say('Please ask your visitor to look at the screen, and slowly turn their head a little.');
    const t0 = performance.now();
    const frames = await cam.captureFrames(FRAMES, FRAME_INTERVAL_MS);
    const tCaptured = performance.now();
    if (!frames.length) {
      setPhase('error');
      setError('I cannot see the camera picture. Please ask your caregiver.');
      return;
    }
    setPhase('thinking');
    const form = new FormData();
    frames.forEach((f, i) => form.append('frames', f, `frame${i}.jpg`));
    try {
      const r = await api<RecognitionResult>(`/api/patients/${patient.id}/recognize`, { form });
      const tResult = performance.now();
      setResult(r);
      setPhase('result');
      const { startedAt } = await say(r.message);
      // Report timings for the evaluation harness (best effort).
      void api(`/api/patients/${patient.id}/recognitions/${r.eventId}/timing`, {
        body: {
          captureMs: Math.round(tCaptured - t0),
          clientRoundTripMs: Math.round(tResult - tCaptured),
          resultToSpeechMs: Math.round(Math.max(0, startedAt - tResult)),
          // Full latency: button press -> capture -> result -> speech starts.
          endToEndMs: Math.round(Math.max(0, startedAt - t0)),
        },
      }).catch(() => undefined);
    } catch (err) {
      setPhase('error');
      const msg = err instanceof ApiError ? err.message : 'Something went wrong. Please ask your caregiver.';
      setError(msg);
      void say(msg);
    }
  };

  const busy = phase === 'capturing' || phase === 'thinking';
  const cameraReady = !cameraOff && cam.status === 'ready';

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl">
            {greeting()}, {patient?.name.split(' ')[0]}
          </h1>
          <p className="text-sub">When someone visits, press the green button.</p>
        </div>
        <button type="button" className="btn-secondary" onClick={toggleCamera} aria-pressed={!cameraOff}>
          {cameraOff ? <Camera size={22} aria-hidden /> : <CameraOff size={22} aria-hidden />}
          {cameraOff ? 'Turn camera on' : 'Turn camera off'}
        </button>
      </div>

      {next && (
        <Link
          to="/patient/visits"
          className="flex items-center gap-4 rounded-2xl border border-line bg-soft p-4 text-soft-ink"
        >
          <CalendarClock size={32} aria-hidden className="shrink-0" />
          <span>
            <span className="block font-semibold">
              {next.who} is coming{' '}
              {whenText(next.startsAt).replace(/^(Today|Tomorrow)/, (m) => m.toLowerCase())}
            </span>
            {next.note && <span className="block text-base">{next.note}</span>}
          </span>
        </Link>
      )}

      <div className="relative overflow-hidden rounded-3xl bg-cam shadow-sm ring-1 ring-line">
        <video
          ref={cam.videoRef}
          muted
          playsInline
          className={`aspect-video w-full -scale-x-100 object-cover ${cameraOff ? 'invisible' : ''}`}
          aria-label="Camera picture"
        />
        {(cameraOff || cam.status !== 'ready') && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-white">
            {cameraOff ? (
              <>
                <CameraOff size={40} aria-hidden />
                <span>The camera is off.</span>
                <button
                  type="button"
                  className="btn bg-white text-cam hover:bg-white/90"
                  onClick={toggleCamera}
                >
                  <Camera size={22} aria-hidden /> Turn camera on
                </button>
              </>
            ) : (
              <>
                {cam.status === 'starting' && 'Starting the camera…'}
                {cam.status === 'denied' &&
                  'The camera is not allowed. Please ask your caregiver to allow the camera.'}
                {cam.status === 'unavailable' &&
                  'No camera was found. You can still ask a question or write a note.'}
                {cam.status === 'error' && 'The camera could not start. Please ask your caregiver.'}
              </>
            )}
          </div>
        )}
        {phase === 'capturing' && (
          <div className="absolute inset-x-0 bottom-0 bg-cam/80 p-4 text-center text-white">
            Please ask your visitor to look here and slowly turn their head a little.
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={whoIsThis}
        disabled={busy || !cameraReady}
        className="btn-primary min-h-[96px] rounded-2xl text-3xl"
      >
        <ScanFace size={36} aria-hidden />
        {phase === 'capturing' ? 'Looking…' : phase === 'thinking' ? 'Thinking…' : 'Who is this?'}
      </button>
      {speechProblem && <p className="text-warn-ink">{speechProblem}</p>}

      {phase === 'result' && result && (
        <ResultCard result={result} onReplay={() => void say(result.message)} />
      )}
      {phase === 'result' && result?.outcome === 'match' && result.person && (
        <PersonHistory personId={result.person.id} />
      )}

      {phase === 'error' && error && (
        <div className="card flex flex-col gap-4" role="alert">
          <p className="text-2xl">{error}</p>
          <AskCaregiverButton context="who-is-this-error" large />
        </div>
      )}

      <AskBox />
    </div>
  );
}

function ResultCard({ result, onReplay }: { result: RecognitionResult; onReplay: () => void }) {
  const known = result.outcome === 'match' || result.outcome === 'unsure';
  const p = result.person;
  return (
    <section className="card flex flex-col gap-4" aria-live="polite" data-testid="result-card">
      {known && p ? (
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          {p.photoUrl && (
            <AuthImage
              src={p.photoUrl}
              alt={`Photo of ${p.name}`}
              className="h-40 w-40 shrink-0 rounded-3xl object-cover"
            />
          )}
          <div className="flex flex-col gap-2 text-center sm:text-left">
            <h2 className="text-4xl font-semibold">
              {result.outcome === 'unsure' ? `This may be ${p.name}` : p.name}
            </h2>
            <p className="text-2xl text-sub">Your {p.relationship}</p>
          </div>
        </div>
      ) : null}
      <p className="text-2xl leading-relaxed">{result.message}</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn-secondary" onClick={onReplay}>
          Say it again
        </button>
        {result.outcome === 'match' && p && (
          <Link
            className="btn-secondary"
            to={`/patient/write?kind=memory&personId=${p.id}&visitId=${result.visitId ?? ''}&name=${encodeURIComponent(p.name)}`}
          >
            <PenLine size={24} aria-hidden /> Add a memory about {p.name}
          </Link>
        )}
      </div>
      {!known || result.outcome === 'unsure' ? (
        <AskCaregiverButton context={`result-${result.outcome}`} large />
      ) : null}
    </section>
  );
}

/** Memories and visits with this person, each readable aloud and re-tellable by the AI. */
export function PersonHistory({ personId }: { personId: string }) {
  const { patient } = useAuth();
  const story = useQuery({
    queryKey: ['story', personId],
    queryFn: () => api<PersonStory>(`/api/patients/${patient!.id}/story/${personId}`),
  });
  if (story.isLoading) return <p className="text-sub">Looking for your memories…</p>;
  if (!story.data) return null;
  const { person, memories, visits, nextVisit } = story.data;
  const empty = !memories.length && !visits.length;

  return (
    <section className="card flex flex-col gap-4" aria-label={`Memories with ${person.name}`}>
      <h2 className="text-2xl">Your memories with {person.name}</h2>
      {nextVisit && (
        <p className="rounded-xl bg-soft p-3 text-soft-ink">
          {person.name} is coming again {nextVisit.when}.
        </p>
      )}
      {empty && <p>Nothing saved yet. You can add a memory about {person.name}.</p>}
      <ul className="flex flex-col gap-3">
        {memories.map((m) => (
          <MemoryItem key={m.id} memory={m} />
        ))}
      </ul>
      {visits.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-xl font-semibold">Visits</h3>
          <ul className="flex flex-col gap-1">
            {visits.slice(0, 6).map((v) => (
              <li key={v.id}>
                {person.name} visited on {v.date}.
              </li>
            ))}
          </ul>
          <SpeakButton
            text={`${person.name} visited on ${visits
              .slice(0, 3)
              .map((v) => v.date)
              .join(', and on ')}.`}
            label="Read the visits"
          />
        </div>
      )}
    </section>
  );
}

function MemoryItem({ memory: m }: { memory: PersonStory['memories'][number] }) {
  const { patient } = useAuth();
  const { say } = useSpeak();
  const [simple, setSimple] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tellSimply = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api<{ text: string; source: string }>(
        `/api/patients/${patient!.id}/memories/${m.id}/retell`,
        { method: 'POST' },
      );
      setSimple(r.text);
      void say(r.text);
    } catch {
      void say(m.summary);
    } finally {
      setBusy(false);
    }
  }, [m.id, m.summary, patient, say]);

  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-line p-4">
      <div className="flex flex-wrap items-center gap-2 text-base text-sub">
        <span>{m.date}</span>
        {m.mine && <span className="badge bg-soft text-soft-ink">You wrote this</span>}
        {m.reviewStatus === 'pending' && (
          <span className="badge bg-warn-bg text-warn-ink">Your caregiver will look at this</span>
        )}
      </div>
      <p className="text-xl">{m.summary}</p>
      {simple && simple !== m.summary && (
        <p className="rounded-xl bg-soft p-3 text-xl text-soft-ink">
          <Sparkles size={18} aria-hidden className="mr-1 inline" /> {simple}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <SpeakButton text={m.summary} />
        {m.canRetell && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void tellSimply()}>
            <Sparkles size={22} aria-hidden /> {busy ? 'Thinking…' : 'Tell me simply'}
          </button>
        )}
      </div>
    </li>
  );
}

/** "When did Priya last visit?" — answered from the database, summarised by the AI. */
function AskBox() {
  const { patient } = useAuth();
  const { say } = useSpeak();
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<AskResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const prefs = patient!.preferences;
  const onText = useCallback((t: string) => setQuestion((q) => (q ? `${q} ${t}` : t)), []);
  const mic = useSpeechInput(onText, prefs.language);

  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (question.trim().length < 2) return;
    setBusy(true);
    try {
      const r = await api<AskResponse>(`/api/patients/${patient!.id}/ask`, { body: { question } });
      setResult(r);
      void say(r.summary ? `${r.answer} ${r.summary}` : r.answer);
    } catch {
      setResult({ answer: "I'm not sure about that. Please ask your caregiver.", found: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={ask} className="card flex flex-col gap-3">
      <label htmlFor="ask" className="text-xl font-semibold">
        Ask a question
      </label>
      <input
        id="ask"
        className="input text-xl"
        placeholder="When is Priya coming?"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        maxLength={300}
      />
      <div className="flex flex-wrap gap-3">
        <button className="btn-primary" disabled={busy || question.trim().length < 2}>
          {busy ? 'Thinking…' : 'Ask'}
        </button>
        <MicButton
          supported={mic.supported}
          listening={mic.listening}
          onStart={mic.start}
          onStop={mic.stop}
        />
      </div>
      {mic.error && <p className="text-warn-ink">{mic.error}</p>}
      {result && (
        <div className="flex flex-col gap-3" role="status" data-testid="ask-result">
          <div className="rounded-2xl bg-soft p-4">
            <p className="text-base font-semibold text-soft-ink">Answer</p>
            <p className="text-2xl">{result.answer}</p>
          </div>
          {result.summary && (
            <div className="rounded-2xl border border-line p-4">
              <p className="flex items-center gap-2 text-base font-semibold text-sub">
                <Sparkles size={18} aria-hidden /> In short
              </p>
              <p className="text-2xl">{result.summary}</p>
            </div>
          )}
          <SpeakButton text={result.summary ? `${result.answer} ${result.summary}` : result.answer} />
          {!result.found && <AskCaregiverButton context="ask-unknown" />}
        </div>
      )}
    </form>
  );
}
