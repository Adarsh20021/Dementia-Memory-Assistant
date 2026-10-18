/** The patient's own notes, reminders and "remember this" entries. */
import { AlarmClock, Heart, PenLine } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { Memory, Note } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { ErrorText, Spinner, formatDateTime } from '../../components/ui';

type Entry = { type: 'note'; at: string; note: Note } | { type: 'memory'; at: string; memory: Memory };

export default function MyNotes() {
  const { patient } = useAuth();
  const qc = useQueryClient();
  const base = `/api/patients/${patient!.id}`;
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const notes = useQuery({ queryKey: ['my-notes'], queryFn: () => api<{ notes: Note[] }>(`${base}/notes`) });
  const memories = useQuery({
    queryKey: ['my-memories'],
    queryFn: () => api<{ memories: Memory[] }>(`${base}/memories`),
  });

  const del = useMutation({
    mutationFn: (e: Entry) =>
      api(e.type === 'note' ? `${base}/notes/${e.note.id}` : `${base}/memories/${e.memory.id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      setConfirmDelete(null);
      void qc.invalidateQueries({ queryKey: ['my-notes'] });
      void qc.invalidateQueries({ queryKey: ['my-memories'] });
    },
  });
  const toggle = useMutation({
    mutationFn: (n: Note) =>
      api(`${base}/notes/${n.id}`, { method: 'PATCH', body: { completed: !n.completed } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['my-notes'] }),
  });

  const entries: Entry[] = [
    ...(notes.data?.notes ?? []).map((n) => ({ type: 'note' as const, at: n.createdAt, note: n })),
    ...(memories.data?.memories ?? []).map((m) => ({ type: 'memory' as const, at: m.createdAt, memory: m })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-3xl">My notes</h1>
      <div className="grid gap-3 sm:grid-cols-3">
        <Link to="/patient/write?kind=note" className="btn-primary">
          <PenLine size={24} aria-hidden /> Add a note
        </Link>
        <Link to="/patient/write?kind=memory" className="btn-primary">
          <Heart size={24} aria-hidden /> Remember this
        </Link>
        <Link to="/patient/write?kind=reminder" className="btn-primary">
          <AlarmClock size={24} aria-hidden /> Add a reminder
        </Link>
      </div>
      {(notes.isLoading || memories.isLoading) && <Spinner />}
      <ErrorText error={notes.error ?? memories.error} />
      {!notes.isLoading && entries.length === 0 && <p className="text-xl">Nothing here yet.</p>}
      <ul className="flex flex-col gap-3">
        {entries.map((e) => {
          const id = e.type === 'note' ? e.note.id : e.memory.id;
          const text = e.type === 'note' ? e.note.text : e.memory.summary;
          const label = e.type === 'memory' ? 'Memory' : e.note.kind === 'reminder' ? 'Reminder' : 'Note';
          const editKind = e.type === 'memory' ? 'memory' : e.note.kind;
          return (
            <li key={id} className="card flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2 text-sub">
                <span className="badge bg-soft text-ink">{label}</span>
                <span>{formatDateTime(e.at)}</span>
                {(e.type === 'memory' ? e.memory.personName : e.note.personName) && (
                  <span className="badge bg-ok-bg text-ok-ink">
                    About {e.type === 'memory' ? e.memory.personName : e.note.personName}
                  </span>
                )}
                {e.type === 'note' && e.note.dueAt && <span>· for {formatDateTime(e.note.dueAt)}</span>}
                {e.type === 'memory' && e.memory.reviewStatus === 'pending' && (
                  <span className="badge bg-warn-bg text-warn-ink">Your caregiver will look at this</span>
                )}
              </div>
              <p
                className={`whitespace-pre-wrap text-xl ${e.type === 'note' && e.note.completed ? 'line-through opacity-70' : ''}`}
              >
                {text}
              </p>
              <div className="flex flex-wrap gap-3">
                {e.type === 'note' && e.note.kind === 'reminder' && (
                  <button className="btn-secondary" onClick={() => toggle.mutate(e.note)}>
                    {e.note.completed ? 'Not done yet' : 'Done'}
                  </button>
                )}
                <Link className="btn-secondary" to={`/patient/write/${editKind}/${id}`}>
                  Change
                </Link>
                {confirmDelete === id ? (
                  <>
                    <button className="btn-danger" onClick={() => del.mutate(e)}>
                      Yes, remove it
                    </button>
                    <button className="btn-secondary" onClick={() => setConfirmDelete(null)}>
                      Keep it
                    </button>
                  </>
                ) : (
                  <button className="btn-secondary" onClick={() => setConfirmDelete(id)}>
                    Remove
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
