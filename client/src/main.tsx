import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { Spinner } from './components/ui';
import '@fontsource-variable/inter';
import '@fontsource-variable/source-serif-4';
import './index.css';
import { applyInitialTheme } from './components/ui';
import { AuditLogPage, EvaluationPage, SettingsPage } from './pages/caregiver/Admin';
import { CaregiverLayout, PatientShell, PatientsList } from './pages/caregiver/CaregiverLayout';
import { NewMemory, ReviewQueue, Timeline } from './pages/caregiver/Memories';
import Overview from './pages/caregiver/Overview';
import { PeopleList, PersonDetail } from './pages/caregiver/People';
import MyNotes from './pages/patient/MyNotes';
import PatientLayout from './pages/patient/PatientLayout';
import PatientSettings from './pages/patient/PatientSettings';
import Visits from './pages/patient/Visits';
import VisitsPage from './pages/caregiver/VisitsPage';
import WhoIsThis from './pages/patient/WhoIsThis';
import WriteEntry from './pages/patient/WriteEntry';
import { Home, Login, NotFound, Pair, Privacy, Register } from './pages/PublicPages';

// Set light/dark before the first paint to avoid a flash.
applyInitialTheme();

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function RequireRole({ role, children }: { role: 'caregiver' | 'patient'; children: ReactNode }) {
  const { status } = useAuth();
  if (status === 'loading') return <Spinner />;
  if (status !== role) return <Navigate to={role === 'patient' ? '/pair' : '/login'} replace />;
  return <>{children}</>;
}

/** A new "Add a note / Remember this" starts fresh: remount when the query changes. */
function WriteEntryKeyed() {
  const { search } = useLocation();
  return <WriteEntry key={search} />;
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/pair" element={<Pair />} />
      <Route path="/privacy" element={<Privacy />} />

      <Route
        path="/patient"
        element={
          <RequireRole role="patient">
            <PatientLayout />
          </RequireRole>
        }
      >
        <Route index element={<WhoIsThis />} />
        <Route path="notes" element={<MyNotes />} />
        <Route path="visits" element={<Visits />} />
        <Route path="write" element={<WriteEntryKeyed />} />
        <Route path="write/:kind/:id" element={<WriteEntry />} />
        <Route path="settings" element={<PatientSettings />} />
      </Route>

      <Route
        path="/care"
        element={
          <RequireRole role="caregiver">
            <CaregiverLayout />
          </RequireRole>
        }
      >
        <Route index element={<PatientsList />} />
        <Route path="patients/:patientId" element={<PatientShell />}>
          <Route index element={<Overview />} />
          <Route path="people" element={<PeopleList />} />
          <Route path="people/:personId" element={<PersonDetail />} />
          <Route path="timeline" element={<Timeline />} />
          <Route path="visits" element={<VisitsPage />} />
          <Route path="review" element={<ReviewQueue />} />
          <Route path="new-memory" element={<NewMemory />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="audit" element={<AuditLogPage />} />
          <Route path="evaluation" element={<EvaluationPage />} />
        </Route>
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
