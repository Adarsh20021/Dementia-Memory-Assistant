/**
 * Patient shell: large text (root font = 20px x fontScale), few choices,
 * "Ask my caregiver" always visible, no clutter.
 *
 * Wide screens show the menu items in the top bar. On phones and tablets the
 * bar stays one line — a "Menu" button on the left and "Ask my caregiver" on
 * the right — and the menu items drop down underneath.
 */
import { ArrowLeft, CalendarDays, House, Menu, NotebookPen, Settings, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
  const [menuOpen, setMenuOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);

  // The dropdown closes when you pick a page, press Escape, or tap outside it.
  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [menuOpen]);

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
  // Same links inside the dropdown: full width, left-aligned.
  const menuTab = ({ isActive }: { isActive: boolean }) =>
    `btn w-full justify-start px-4 ${isActive ? 'bg-side-active text-side-active-ink shadow-sm' : 'text-white hover:bg-white/10'}`;

  return (
    <div className="flex min-h-screen flex-col">
      <header ref={headerRef} className="sticky top-0 z-30 bg-side text-white shadow-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-4 py-2">
          {/* Wide screens: the menu items sit in the bar. */}
          <nav className="hidden items-center gap-1 lg:flex" aria-label="Main">
            <Link to="/patient" aria-label="Go to home" className="mr-1 flex">
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
          {/* Phones and tablets: one "Menu" button that opens the dropdown below. */}
          <button
            type="button"
            className="btn px-4 text-white hover:bg-white/10 lg:hidden"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-expanded={menuOpen}
            aria-controls="patient-menu"
          >
            {menuOpen ? <X size={24} aria-hidden /> : <Menu size={24} aria-hidden />}
            {menuOpen ? 'Close' : 'Menu'}
          </button>
          <div className="flex items-center gap-2">
            <VoiceToggle className="hidden lg:inline-flex" />
            <AskCaregiverButton context="header" />
          </div>
        </div>
        {menuOpen && (
          <nav
            id="patient-menu"
            aria-label="Main"
            className="mx-auto flex max-w-5xl flex-col gap-1 border-t border-white/10 px-4 pb-3 pt-2 lg:hidden"
          >
            <NavLink to="/patient" end className={menuTab}>
              <House size={24} aria-hidden /> Home
            </NavLink>
            <NavLink to="/patient/visits" className={menuTab}>
              <CalendarDays size={24} aria-hidden /> Visits
            </NavLink>
            <NavLink to="/patient/notes" className={menuTab}>
              <NotebookPen size={24} aria-hidden /> My notes
            </NavLink>
            <NavLink to="/patient/settings" className={menuTab}>
              <Settings size={24} aria-hidden /> Settings
            </NavLink>
            <VoiceToggle className="w-full justify-start" />
          </nav>
        )}
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
