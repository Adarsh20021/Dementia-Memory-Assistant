/** Caregiver shell (green sidebar), patient list, and per-patient layout. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart3,
  CalendarDays,
  ClipboardCheck,
  History,
  House,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  PenLine,
  ScrollText,
  Settings,
  Sun,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useMatch, useParams } from 'react-router-dom';
import { api } from '../../api/client';
import type { Overview, Patient } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { Alert, BrandMark, Disclaimer, ErrorText, Spinner, useDarkMode } from '../../components/ui';

const PATIENT_NAV: [string, string, LucideIcon][] = [
  ['', 'Overview', LayoutDashboard],
  ['people', 'People', Users],
  ['visits', 'Visits', CalendarDays],
  ['timeline', 'Timeline', History],
  ['review', 'Review', ClipboardCheck],
  ['new-memory', 'Add memory', PenLine],
  ['settings', 'Settings', Settings],
  ['audit', 'Audit log', ScrollText],
  ['evaluation', 'Evaluation', BarChart3],
];

const initials = (name?: string) =>
  (name ?? '?')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

const sideClass = ({ isActive }: { isActive: boolean }) => `side-link ${isActive ? 'side-link-active' : ''}`;

function PatientNav({ patientId, onNavigate }: { patientId: string; onNavigate: () => void }) {
  // Same query keys as the pages, so React Query shares the cached data.
  const { data: p } = useQuery({
    queryKey: ['patient', patientId],
    queryFn: () => api<{ patient: Patient }>(`/api/patients/${patientId}`),
  });
  const { data: o } = useQuery({
    queryKey: ['overview', patientId],
    queryFn: () => api<Overview>(`/api/patients/${patientId}/overview`),
    refetchInterval: 30_000,
  });
  const pending = o?.counts.pendingReviews ?? 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="mb-1 mt-5 flex items-center gap-3 px-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/15 text-xs font-semibold text-white">
          {initials(p?.patient.name)}
        </span>
        <span className="truncate text-sm text-side-ink">
          Caring for <span className="font-semibold text-white">{p?.patient.name ?? '…'}</span>
        </span>
      </div>
      {PATIENT_NAV.map(([path, label, Icon]) => (
        <NavLink
          key={path}
          to={`/care/patients/${patientId}${path ? `/${path}` : ''}`}
          end={path === ''}
          className={sideClass}
          onClick={onNavigate}
        >
          <Icon size={18} aria-hidden />
          {label}
          {path === 'review' && pending > 0 && (
            <span className="ml-auto rounded-full bg-brand px-2 text-xs font-semibold text-on-brand">
              {pending}
            </span>
          )}
        </NavLink>
      ))}
    </div>
  );
}

export function CaregiverLayout() {
  const { user, logout } = useAuth();
  const [dark, setDark] = useDarkMode();
  const [open, setOpen] = useState(false);
  const match = useMatch('/care/patients/:patientId/*');
  const patientId = match?.params.patientId;

  return (
    <div className="min-h-screen lg:flex">
      <aside className="bg-side text-side-ink lg:fixed lg:inset-y-0 lg:left-0 lg:flex lg:w-64 lg:flex-col">
        <div className="flex items-center justify-between px-5 py-4 lg:py-6">
          <Link
            to="/care"
            className="flex items-center gap-3 text-white"
            onClick={() => setOpen(false)}
            aria-label="Memory Assistant, go to home (all patients)"
          >
            <BrandMark />
            <span className="leading-tight">
              <span className="block font-serif text-lg font-semibold">Memory Assistant</span>
              <span className="block text-xs text-side-ink">Caregiver dashboard</span>
            </span>
          </Link>
          <button
            className="rounded-lg p-2 text-white hover:bg-white/10 lg:hidden"
            onClick={() => setOpen(!open)}
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
          >
            {open ? <X aria-hidden /> : <Menu aria-hidden />}
          </button>
        </div>
        <nav
          aria-label="Caregiver"
          className={`${open ? 'flex' : 'hidden'} flex-1 flex-col overflow-y-auto px-3 pb-4 lg:flex`}
        >
          <NavLink to="/care" end className={sideClass} onClick={() => setOpen(false)}>
            <House size={18} aria-hidden />
            Home · All patients
          </NavLink>
          {patientId && <PatientNav patientId={patientId} onNavigate={() => setOpen(false)} />}
          <div className="mt-auto flex flex-col gap-1 border-t border-white/10 pt-4">
            <div className="flex items-center gap-3 px-3 py-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-xs font-semibold text-side">
                {initials(user?.name)}
              </span>
              <span className="truncate text-sm font-medium text-white">{user?.name}</span>
            </div>
            <button className="side-link" onClick={() => setDark(!dark)}>
              {dark ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
              {dark ? 'Light theme' : 'Dark theme'}
            </button>
            <button className="side-link" onClick={() => void logout()}>
              <LogOut size={18} aria-hidden />
              Sign out
            </button>
          </div>
        </nav>
      </aside>
      <div className="flex min-h-screen flex-1 flex-col lg:pl-64">
        <main className="mx-auto w-full max-w-6xl flex-1 p-4 sm:p-8">
          <Outlet />
        </main>
        <footer className="mx-auto w-full max-w-6xl px-4 pb-6 sm:px-8">
          <Disclaimer />
        </footer>
      </div>
    </div>
  );
}

export function PatientsList() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['patients'],
    queryFn: () => api<{ patients: Patient[] }>('/api/patients'),
  });
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api<{ patient: Patient }>('/api/patients', { body: { name } }),
    onSuccess: () => {
      setName('');
      void qc.invalidateQueries({ queryKey: ['patients'] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate();
  };

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl">Your patients</h1>
      {isLoading && <Spinner />}
      <ErrorText error={error} />
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data?.patients.map((p) => (
          <li key={p.id}>
            <Link
              to={`/care/patients/${p.id}`}
              className="card flex items-center gap-4 transition-colors hover:border-brand"
            >
              <span
                aria-hidden
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-soft font-semibold text-soft-ink"
              >
                {initials(p.name)}
              </span>
              <span className="flex flex-col">
                <span className="text-xl font-semibold">{p.name}</span>
                <span className="text-sm text-sub">Open dashboard</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {data && data.patients.length === 0 && (
        <Alert>No patients yet. Add the person you care for below.</Alert>
      )}
      <form onSubmit={submit} className="card flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label className="label" htmlFor="pname">
            Add a patient
          </label>
          <input
            id="pname"
            className="input"
            placeholder="Their name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <button className="btn-primary" disabled={!name.trim() || create.isPending}>
          Add patient
        </button>
      </form>
      <ErrorText error={create.error} />
    </div>
  );
}

export function PatientShell() {
  const { patientId } = useParams();
  const onOverview = !!useMatch('/care/patients/:patientId');
  const { data } = useQuery({
    queryKey: ['patient', patientId],
    queryFn: () => api<{ patient: Patient }>(`/api/patients/${patientId}`),
  });
  return (
    <div className="flex flex-col gap-6">
      <div>
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center text-sm text-sub">
          <Link to="/care" className="inline-flex items-center gap-1 hover:text-ink hover:underline">
            <House size={14} aria-hidden /> Home
          </Link>
          <span aria-hidden className="mx-2">
            /
          </span>
          {onOverview ? (
            <span>{data?.patient.name ?? '…'}</span>
          ) : (
            <Link to={`/care/patients/${patientId}`} className="hover:text-ink hover:underline">
              {data?.patient.name ?? '…'}
            </Link>
          )}
        </nav>
        <h1 className="mt-1 text-3xl">{data?.patient.name ?? '…'}</h1>
      </div>
      <Outlet />
    </div>
  );
}
