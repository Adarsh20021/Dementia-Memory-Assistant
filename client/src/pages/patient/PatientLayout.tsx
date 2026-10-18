/**
 * Patient shell: large text (root font = 20px x fontScale), few choices,
 * "Ask my caregiver" always visible, no clutter.
 */
import { CalendarDays, NotebookPen, ScanFace, Settings } from 'lucide-react';
import { useEffect } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { AskCaregiverButton } from '../../components/AskCaregiverButton';
import { BrandMark, Disclaimer } from '../../components/ui';

export default function PatientLayout() {
  const { patient } = useAuth();
  const scale = patient?.preferences.fontScale ?? 1.25;

  useEffect(() => {
    // 16px x 1.25 = 20px minimum body text, scaled up by the patient's setting.
    document.documentElement.style.fontSize = `${Math.max(20, 16 * scale)}px`;
    return () => {
      document.documentElement.style.fontSize = '';
    };
  }, [scale]);

  const tab = ({ isActive }: { isActive: boolean }) =>
    `btn px-4 ${isActive ? 'bg-side-active text-side-active-ink shadow-sm' : 'text-white hover:bg-white/10'}`;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 bg-side text-white shadow-md">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-2">
          <nav className="flex flex-wrap items-center gap-1" aria-label="Main">
            <BrandMark className="mr-1 hidden lg:flex" />
            <NavLink to="/patient" end className={tab}>
              <ScanFace size={24} aria-hidden /> Who is this?
            </NavLink>
            <NavLink to="/patient/visits" className={tab}>
              <CalendarDays size={24} aria-hidden /> Visits
            </NavLink>
            <NavLink to="/patient/notes" className={tab}>
              <NotebookPen size={24} aria-hidden /> My notes
            </NavLink>
            <NavLink to="/patient/settings" className={tab} aria-label="Settings">
              <Settings size={24} aria-hidden />
            </NavLink>
          </nav>
          <AskCaregiverButton context="header" />
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 p-4">
        <Outlet />
      </main>
      <footer className="mx-auto w-full max-w-3xl px-4 pb-4">
        <Disclaimer />
      </footer>
    </div>
  );
}
