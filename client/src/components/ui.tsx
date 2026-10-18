/** Small shared UI pieces. */
import { useEffect, useState, type ReactNode } from 'react';
import { apiBlob } from '../api/client';
import { HeartHandshake, Mic, Square } from 'lucide-react';
import { localPref } from '../hooks/useDraft';

export function Alert({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'error' | 'success' | 'warn';
  children: ReactNode;
}) {
  const styles = {
    info: 'bg-soft text-ink border-line',
    error: 'bg-bad-bg text-bad-ink border-bad-ink/30',
    success: 'bg-ok-bg text-ok-ink border-ok-ink/30',
    warn: 'bg-warn-bg text-warn-ink border-warn-ink/30',
  }[kind];
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={`rounded-xl border p-4 ${styles}`}>
      {children}
    </div>
  );
}

/** The app's logo mark: a rounded tile with a caring-hands icon. */
export function BrandMark({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`brand-mark flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/15 text-white ring-1 ring-white/20 ${className}`}
    >
      <HeartHandshake size={22} strokeWidth={1.8} />
    </span>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-3 py-4">
      {/* Slow, gentle pulse instead of a fast spinner. */}
      <span className="inline-block h-4 w-4 animate-pulse rounded-full bg-brand" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : 'Something went wrong.';
  return <Alert kind="error">{msg}</Alert>;
}

/** <img> for API photos (needs the auth header, so it is fetched as a blob). */
export function AuthImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    apiBlob(src)
      .then((b) => {
        if (revoked) return;
        objectUrl = URL.createObjectURL(b);
        setUrl(objectUrl);
      })
      .catch(() => setFailed(true));
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);
  if (failed)
    return <div className={`flex items-center justify-center bg-soft text-sub ${className}`}>No photo</div>;
  if (!url) return <div className={`animate-pulse bg-soft ${className}`} aria-label="Loading photo" />;
  return <img src={url} alt={alt} className={className} />;
}

export function Disclaimer({ className = '' }: { className?: string }) {
  return (
    <p className={`text-sm text-sub ${className}`}>
      This is a memory aid and caregiver-support tool. It is not a medical or diagnostic device.{' '}
      <a href="/privacy" className="underline">
        Privacy
      </a>
    </p>
  );
}

/** Dark mode: remembered per device; falls back to the operating-system setting. */
function initialDark(): boolean {
  const stored = localPref.read('dma-dark');
  if (stored === '1' || stored === '0') return stored === '1';
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function applyInitialTheme() {
  document.documentElement.classList.toggle('dark', initialDark());
}

export function useDarkMode() {
  const [dark, setDarkState] = useState(initialDark);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);
  const setDark = (v: boolean) => {
    localPref.write('dma-dark', v ? '1' : '0');
    setDarkState(v);
  };
  return [dark, setDark] as const;
}

export function MicButton({
  supported,
  listening,
  onStart,
  onStop,
  label = 'Speak',
}: {
  supported: boolean;
  listening: boolean;
  onStart: () => void;
  onStop: () => void;
  label?: string;
}) {
  if (!supported)
    return (
      <p className="text-base text-sub">
        <Mic size={18} className="mr-1 inline" aria-hidden />
        Voice typing is not available in this browser. Please type, or open the app in Chrome or Edge.
      </p>
    );
  return (
    <button
      type="button"
      className={listening ? 'btn-help' : 'btn-secondary'}
      onClick={listening ? onStop : onStart}
      aria-pressed={listening}
    >
      {listening ? <Square size={20} aria-hidden /> : <Mic size={22} aria-hidden />}{' '}
      {listening ? 'Listening… tap to stop' : label}
    </button>
  );
}

export const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/** "Today at 4:00 pm", "Tomorrow at 10:30 am", "Saturday 25 October at 4:00 pm". */
export function whenText(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(d) - start(today)) / 86_400_000);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const day =
    days === 0
      ? 'Today'
      : days === 1
        ? 'Tomorrow'
        : d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  return `${day} at ${time}`;
}
