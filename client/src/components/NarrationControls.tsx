/**
 * Voice controls on every patient screen:
 *  - VoiceToggle: turn the app's voice off / on (remembered on this device);
 *  - StopTalkingBar: a big "Stop talking" button that appears whenever the
 *    app is reading something aloud, whatever started it.
 */
import { Square, Volume2, VolumeX } from 'lucide-react';
import { setMuted, stopNarration, useNarration } from '../tts/narration';

export function VoiceToggle({ className = '' }: { className?: string }) {
  const { muted } = useNarration();
  return (
    <button
      type="button"
      onClick={() => setMuted(!muted)}
      aria-pressed={muted}
      aria-label={muted ? 'Voice is off. Tap to turn the voice on' : 'Voice is on. Tap to turn the voice off'}
      className={`btn px-4 ${muted ? 'bg-warn-bg text-warn-ink' : 'text-white hover:bg-white/10'} ${className}`}
    >
      {muted ? <VolumeX size={24} aria-hidden /> : <Volume2 size={24} aria-hidden />}
      {muted ? 'Voice off' : 'Voice on'}
    </button>
  );
}

export function StopTalkingBar() {
  const { speaking } = useNarration();
  if (!speaking) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center p-4">
      <button
        type="button"
        onClick={stopNarration}
        className="btn-help pointer-events-auto min-h-[72px] rounded-2xl px-8 text-2xl shadow-lg"
      >
        <Square size={28} aria-hidden /> Stop talking
      </button>
    </div>
  );
}
