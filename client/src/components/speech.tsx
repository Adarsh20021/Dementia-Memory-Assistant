/**
 * Speaking helpers used on patient screens: one hook that applies the
 * patient's voice settings and notices when the browser refuses to speak,
 * and a "Read aloud" button.
 */
import { Square, Volume2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { stopNarration, useNarration } from '../tts/narration';
import { getTTS } from '../tts/TTSProvider';

export function useSpeak() {
  const { patient } = useAuth();
  const [problem, setProblem] = useState<string | null>(null);
  const rate = patient?.preferences.voiceRate ?? 0.95;
  const lang = patient?.preferences.language ?? 'en';

  const say = useCallback(
    async (text: string) => {
      const tts = getTTS();
      if (!tts.isAvailable()) {
        setProblem('This browser cannot read aloud. Try Chrome or Edge.');
        return { startedAt: performance.now() };
      }
      try {
        const r = await tts.speak(text, { rate, lang });
        setProblem(
          tts.lastError === 'not-allowed'
            ? 'Tap "Read aloud" to hear it.'
            : tts.lastError
              ? 'The voice did not work. Check the sound is on.'
              : null,
        );
        return r;
      } catch {
        setProblem('The voice did not work. Check the sound is on.');
        return { startedAt: performance.now() };
      }
    },
    [rate, lang],
  );

  return { say, problem };
}

export function SpeakButton({
  text,
  label = 'Read aloud',
  className = 'btn-secondary',
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const { say, problem } = useSpeak();
  const { speaking, text: current, muted } = useNarration();
  const [mutedHint, setMutedHint] = useState(false);
  const mine = speaking && current === text;
  const note = mutedHint && muted ? 'The voice is off. Tap "Voice on" at the top to hear it.' : problem;
  return (
    <span className="inline-flex flex-col items-start gap-1 self-start">
      {mine ? (
        <button type="button" className="btn-help" onClick={stopNarration} aria-label="Stop reading">
          <Square size={20} aria-hidden /> Stop
        </button>
      ) : (
        <button
          type="button"
          className={className}
          onClick={() => {
            setMutedHint(muted);
            void say(text);
          }}
        >
          <Volume2 size={22} aria-hidden /> {label}
        </button>
      )}
      {note && <span className="text-base text-warn-ink">{note}</span>}
    </span>
  );
}
