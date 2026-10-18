/**
 * Phase 1 placeholder. The real patient and caregiver UI (React Router,
 * Tailwind, TanStack Query) is built in Phases 3 and 5.
 */
import { useEffect, useState } from 'react';

export default function App() {
  const [api, setApi] = useState<'checking' | 'ok' | 'down'>('checking');

  useEffect(() => {
    fetch('/api/health')
      .then((r) => setApi(r.ok ? 'ok' : 'down'))
      .catch(() => setApi('down'));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', fontSize: 20, maxWidth: 640, margin: '48px auto', padding: 16, lineHeight: 1.5 }}>
      <h1>Memory Assistant</h1>
      <p>Foundation is in place. The patient screen arrives in Phase 3.</p>
      <p>
        API status: <strong>{api === 'checking' ? 'checking…' : api === 'ok' ? 'connected' : 'not reachable'}</strong>
      </p>
      <p style={{ fontSize: 16, color: '#444' }}>
        This is a memory aid and caregiver-support tool. It is not a medical or diagnostic device.
      </p>
    </main>
  );
}
