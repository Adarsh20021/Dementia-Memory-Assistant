/** Home, caregiver sign-in / sign-up, patient device pairing, privacy notice. */
import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import { forgetDevice, readDeviceHint, useAuth, type DeviceHint } from '../auth/AuthContext';
import { Alert, BrandMark, Disclaimer } from '../components/ui';

function Shell({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <aside className="flex flex-col justify-between gap-10 bg-side px-6 py-8 text-side-ink sm:px-10 lg:min-h-screen lg:py-12">
        <Link to="/" className="flex items-center gap-3 text-white">
          <BrandMark />
          <span className="font-serif text-xl font-semibold">Memory Assistant</span>
        </Link>
        <div className="hidden max-w-md lg:block">
          <p className="font-serif text-4xl font-semibold leading-tight text-white">
            Helping familiar faces stay familiar.
          </p>
          <p className="mt-4 text-lg">
            Recognises the people who visit, and tells the person you care for who they are in a few calm
            words.
          </p>
        </div>
        <p className="hidden text-sm lg:block">Face data is encrypted and only used with recorded consent.</p>
      </aside>
      <div className="mx-auto flex min-h-[70vh] w-full max-w-xl flex-col gap-6 px-6 py-10 lg:min-h-screen lg:justify-center">
        <h1 className="text-3xl">{title}</h1>
        <main className="flex flex-col gap-4">{children}</main>
        <footer className="mt-4">
          <Disclaimer />
        </footer>
      </div>
    </div>
  );
}

const errorMessage = (e: unknown) => {
  if (e instanceof ApiError) {
    if (e.details?.length) return e.details.map((d) => d.message).join(' ');
    return e.message;
  }
  return 'Something went wrong. Please try again.';
};

export function Home() {
  const { status } = useAuth();
  if (status === 'caregiver') return <Navigate to="/care" replace />;
  if (status === 'patient') return <Navigate to="/patient" replace />;
  return (
    <Shell title="Welcome">
      <p className="text-lg">
        A memory aid that helps a person living with dementia recognise familiar visitors, with a dashboard
        for their caregiver.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Link to="/login" className="card flex flex-col gap-2 transition-colors hover:border-brand">
          <span className="text-xl font-semibold">I am a caregiver</span>
          <span>Sign in to manage people, photos and memories.</span>
        </Link>
        <Link to="/pair" className="card flex flex-col gap-2 transition-colors hover:border-brand">
          <span className="text-xl font-semibold">Set up this device for the patient</span>
          <span>Enter the code from the caregiver dashboard.</span>
        </Link>
      </div>
    </Shell>
  );
}

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      navigate('/care');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="Caregiver sign in">
      <form onSubmit={submit} className="card flex flex-col gap-4">
        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && <Alert kind="error">{error}</Alert>}
        <button className="btn-primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p>
          New here?{' '}
          <Link className="underline" to="/register">
            Create a caregiver account
          </Link>
        </p>
      </form>
    </Shell>
  );
}

export function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register(form.name, form.email, form.password);
      navigate('/care');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="Create a caregiver account">
      <form onSubmit={submit} className="card flex flex-col gap-4">
        {(['name', 'email', 'password'] as const).map((k) => (
          <div key={k}>
            <label className="label" htmlFor={k}>
              {k === 'name' ? 'Your name' : k === 'email' ? 'Email' : 'Password'}
            </label>
            <input
              id={k}
              type={k === 'password' ? 'password' : k === 'email' ? 'email' : 'text'}
              autoComplete={k === 'password' ? 'new-password' : k}
              className="input"
              value={form[k]}
              onChange={(e) => setForm({ ...form, [k]: e.target.value })}
              required
            />
            {k === 'password' && (
              <p className="mt-1 text-sm">
                At least 10 characters, with an uppercase letter, a lowercase letter and a number.
              </p>
            )}
          </div>
        ))}
        {error && <Alert kind="error">{error}</Alert>}
        <button className="btn-primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>
    </Shell>
  );
}

export function Pair() {
  const { pair, pinLogin } = useAuth();
  const navigate = useNavigate();
  const [hint, setHint] = useState<DeviceHint | null>(() => readDeviceHint());
  const [pinEnabled, setPinEnabled] = useState<boolean | null>(null);
  const [mode, setMode] = useState<'pin' | 'code'>('pin');
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A device that was set up before: offer the PIN, if the caregiver set one.
  useEffect(() => {
    if (!hint) return setPinEnabled(false);
    api<{ pinEnabled: boolean }>('/api/auth/pin-status', { body: { patientId: hint.patientId } })
      .then((r) => setPinEnabled(r.pinEnabled))
      .catch(() => setPinEnabled(false));
  }, [hint]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      navigate('/patient');
    } catch (err) {
      setError(errorMessage(err));
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  const usePin = hint && pinEnabled && mode === 'pin';

  if (usePin) {
    const press = (d: string) => {
      if (busy) return;
      const next = (pin + d).slice(0, 6);
      setPin(next);
    };
    return (
      <Shell title={`Welcome back, ${hint.name}`}>
        <div className="card flex flex-col gap-5 text-xl">
          <p>Type your PIN to start.</p>
          <div className="flex justify-center gap-3" aria-label={`${pin.length} numbers typed`} role="status">
            {Array.from({ length: Math.max(4, pin.length) }).map((_, i) => (
              <span
                key={i}
                className={`h-5 w-5 rounded-full border-2 border-brand ${i < pin.length ? 'bg-brand' : ''}`}
              />
            ))}
          </div>
          <div className="grid grid-cols-3 gap-3">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <button
                key={d}
                type="button"
                className="btn-secondary min-h-[72px] text-3xl"
                onClick={() => press(d)}
              >
                {d}
              </button>
            ))}
            <button
              type="button"
              className="btn-secondary min-h-[72px] text-lg"
              onClick={() => setPin(pin.slice(0, -1))}
              aria-label="Delete last number"
            >
              Delete
            </button>
            <button type="button" className="btn-secondary min-h-[72px] text-3xl" onClick={() => press('0')}>
              0
            </button>
            <button
              type="button"
              className="btn-primary min-h-[72px] text-xl"
              disabled={pin.length < 4 || busy}
              onClick={() => void run(() => pinLogin(hint.patientId, pin))}
            >
              {busy ? '…' : 'Start'}
            </button>
          </div>
          {error && <Alert kind="error">{error}</Alert>}
        </div>
        <div className="flex flex-wrap gap-3">
          <button className="btn-secondary" onClick={() => setMode('code')}>
            Use a code instead
          </button>
          <button
            className="btn-secondary"
            onClick={() => {
              forgetDevice();
              setHint(null);
            }}
          >
            This is not {hint.name}
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="Set up this device">
      <div className="card flex flex-col gap-3">
        <p className="text-lg">
          <strong>Easiest:</strong> the caregiver signs in on this device and chooses{' '}
          <em>Use this device for the patient</em> in Settings. No code is needed.
        </p>
      </div>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void run(() => pair(code));
        }}
        className="card flex flex-col gap-4 text-xl"
      >
        <p>Or type the code shown on the caregiver's screen. You only need to do this once.</p>
        <label className="label" htmlFor="code">
          Code
        </label>
        <input
          id="code"
          className="input text-center font-mono text-3xl uppercase tracking-widest"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="ABCD-EFGH"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          required
        />
        {error && <Alert kind="error">{error}</Alert>}
        <button className="btn-primary text-xl" disabled={busy || code.replace(/[\s-]/g, '').length < 8}>
          {busy ? 'Checking…' : 'Start'}
        </button>
      </form>
      {hint && pinEnabled && (
        <button className="btn-secondary self-start" onClick={() => setMode('pin')}>
          Use my PIN instead
        </button>
      )}
      <p className="text-sub">
        This device stays signed in for months. If it is ever signed out, the caregiver can set a PIN so you
        can come back without a new code.
      </p>
    </Shell>
  );
}

export function Privacy() {
  return (
    <Shell title="Privacy notice">
      <article className="card flex flex-col gap-4 leading-relaxed">
        <p>
          <strong>What this app is for.</strong> It helps a person living with dementia recognise familiar
          people and remember recent visits. It is a memory aid, not a medical or diagnostic device.
        </p>
        <p>
          <strong>What we collect.</strong> Names and relationships of familiar people, face photos and face
          measurements (called embeddings) used only to recognise them, dates of visits, and short notes or
          memories written by the caregiver or the patient.
        </p>
        <p>
          <strong>Consent.</strong> Face photos are only added after the person (or the caregiver, with a
          recorded reason) agrees. Consent can be withdrawn at any time. Withdrawing it deletes that person's
          photos and face data straight away.
        </p>
        <p>
          <strong>Camera pictures.</strong> Pictures taken when the patient asks "Who is this?" are checked in
          memory and then thrown away. They are never stored.
        </p>
        <p>
          <strong>Security.</strong> Face data, photos, notes and memories are encrypted when stored. Only the
          patient's caregivers can see and manage them. Important actions are recorded in an audit log.
        </p>
        <p>
          <strong>AI text.</strong> To write friendly sentences, a short text summary (first name,
          relationship, visit dates and caregiver-approved memories) may be sent to an AI service (Groq).
          Photos, face data and full names are never sent. If the AI is unavailable, a simple built-in
          sentence is used.
        </p>
        <p>
          <strong>How long we keep data.</strong> Visit records are deleted automatically after the retention
          period the caregiver chooses. The caregiver can export all data or delete everything at any time.
        </p>
        <p>
          <strong>Your rights.</strong> Following India's Digital Personal Data Protection Act 2023 and GDPR
          principles, you can ask to see, correct or delete your data, and withdraw consent. Ask the caregiver
          who manages the account.
        </p>
      </article>
    </Shell>
  );
}

export function NotFound() {
  return (
    <Shell title="Page not found">
      <Link to="/" className="btn-primary">
        Go to the start
      </Link>
    </Shell>
  );
}
