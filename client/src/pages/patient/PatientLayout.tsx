/**
 * Patient shell: large text (root font = 20px x fontScale), few choices,
 * "Ask my caregiver" always visible, no clutter.
 */
import { ArrowLeft, CalendarDays, House, NotebookPen, Settings } from 'lucide-react';
import { useEffect } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { AskCaregiverButton } from '../../components/AskCaregiverButton';
import { StopTalkingBar, VoiceToggle } from '../../components/NarrationControls';
import { stopNarration } from '../../tts/narration';
import { BrandMark, Disclaimer } from '../../components/ui';

export default function PatientLayout() {
  const { patient } = useAuth();
  const scale = patient?.preferences.fontScale ?? 1.25;
  const { pathname } = useLocation();
  const atHome = pathname.replace(/\/+$/, '') === '/patient';

  // Leaving the patient screens (e.g. signing out) stops any speech.
  useEffect(() => () => stopNarration(), []);

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
            <Link to="/patient" aria-label="Go to home" className="mr-1 hidden lg:flex">
              <BrandMark />
            </Link>
            <NavLink to="/patient" end className={tab} aria-label="Home: Who is this?">
              <House size={24} aria-hidden /> Home
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
          <div className="flex flex-wrap items-center gap-2">
            <VoiceToggle />
            <AskCaregiverButton context="header" />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 p-4">
        {!atHome && (
          // One big, obvious way back to the main "Who is this?" screen.
          <Link to="/patient" className="btn-secondary mb-4 w-full text-xl sm:w-auto">
            <ArrowLeft size={26} aria-hidden /> Back to home
          </Link>
        )}
        <Outlet />
      </main>
      {/* Extra bottom space so the Stop button never covers content. */}
      <footer className="mx-auto w-full max-w-3xl px-4 pb-28">
        <Disclaimer />
      </footer>
      <StopTalkingBar />
    </div>
  );
}
