/**
 * Text-to-speech behind a small interface so a cloud TTS can be swapped in
 * later without touching the UI. Default: the browser's Web Speech API
 * (free, offline-capable, no key).
 */
export interface SpeakOptions {
  /** 0.5 (slow) .. 1.5 (fast); 1 = normal */
  rate?: number;
  /** BCP-47, e.g. "en-IN", "hi-IN" */
  lang?: string;
}

export interface TTSProvider {
  readonly name: string;
  isAvailable(): boolean;
  /** Resolves when speech has STARTED (used for latency measurement). */
  speak(text: string, opts?: SpeakOptions): Promise<{ startedAt: number }>;
  cancel(): void;
  /** Last error reported by the engine (e.g. "not-allowed"), if any. */
  lastError?: string | null;
}

const LANG_MAP: Record<string, string> = {
  en: 'en-IN',
  hi: 'hi-IN',
  ta: 'ta-IN',
  te: 'te-IN',
  kn: 'kn-IN',
  ml: 'ml-IN',
  mr: 'mr-IN',
  bn: 'bn-IN',
  gu: 'gu-IN',
};
export const toSpeechLang = (lang?: string) => (lang ? (LANG_MAP[lang] ?? lang) : 'en-IN');

export class WebSpeechTTS implements TTSProvider {
  readonly name = 'web-speech';
  /** Keeps the utterance referenced: Chrome may garbage-collect it mid-sentence otherwise. */
  private current: SpeechSynthesisUtterance | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  /** Set when the browser refused to speak (usually: no tap on the page yet). */
  lastError: string | null = null;

  isAvailable() {
    return (
      typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window
    );
  }

  /** Voices load asynchronously in Chrome/Edge; wait for them (max ~1.5 s). */
  private voices(): Promise<SpeechSynthesisVoice[]> {
    const synth = window.speechSynthesis;
    const now = synth.getVoices();
    if (now.length) return Promise.resolve(now);
    return new Promise((resolve) => {
      const done = () => resolve(synth.getVoices());
      synth.addEventListener('voiceschanged', done, { once: true });
      setTimeout(done, 1500);
    });
  }

  private pickVoice(voices: SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice | undefined {
    const base = lang.split('-')[0];
    return (
      voices.find((v) => v.lang === lang) ??
      voices.find((v) => v.lang.replace('_', '-') === lang) ??
      voices.find((v) => v.lang.startsWith(base) && v.localService) ??
      voices.find((v) => v.lang.startsWith(base)) ??
      undefined
    );
  }

  async speak(text: string, opts: SpeakOptions = {}): Promise<{ startedAt: number }> {
    if (!this.isAvailable()) throw new Error('Speech is not available');
    const synth = window.speechSynthesis;
    // Chrome drops an utterance queued in the same tick as cancel(); wait a moment.
    if (synth.speaking || synth.pending) {
      synth.cancel();
      await new Promise((r) => setTimeout(r, 60));
    }
    const voices = await this.voices();
    const lang = toSpeechLang(opts.lang);
    const u = new SpeechSynthesisUtterance(text);
    const voice = this.pickVoice(voices, lang);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else if (voices.length === 0) {
      u.lang = lang; // let the browser choose
    }
    u.rate = Math.min(1.5, Math.max(0.5, opts.rate ?? 0.9));
    u.pitch = 1;
    u.volume = 1;
    this.current = u;
    this.lastError = null;

    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve({ startedAt: performance.now() });
        }
      };
      u.onstart = finish;
      u.onerror = (e) => {
        // "interrupted"/"canceled" happen when we start the next sentence; not an error.
        if (e.error !== 'interrupted' && e.error !== 'canceled') this.lastError = e.error;
        this.stopKeepAlive();
        finish();
      };
      u.onend = () => {
        this.stopKeepAlive();
        if (this.current === u) this.current = null;
      };
      // Some browsers never fire onstart; don't block the UI.
      setTimeout(finish, 2000);
      synth.resume(); // un-stick a paused engine (Chrome on Windows)
      synth.speak(u);
      // Chrome stops long speech after ~15 s unless nudged.
      this.stopKeepAlive();
      this.keepAlive = setInterval(() => {
        if (!synth.speaking) return this.stopKeepAlive();
        synth.pause();
        synth.resume();
      }, 10_000);
    });
  }

  private stopKeepAlive() {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
  }

  cancel() {
    if (!this.isAvailable()) return;
    this.stopKeepAlive();
    window.speechSynthesis.cancel();
  }
}

/** Silent provider used when no speech engine exists (text is still shown). */
export class SilentTTS implements TTSProvider {
  readonly name = 'silent';
  isAvailable() {
    return false;
  }
  async speak() {
    return { startedAt: performance.now() };
  }
  cancel() {}
}

let provider: TTSProvider | null = null;
export function getTTS(): TTSProvider {
  if (!provider) {
    const web = new WebSpeechTTS();
    provider = web.isAvailable() ? web : new SilentTTS();
  }
  return provider;
}
/** Swap in another provider (e.g. a cloud TTS) at app start. */
export const setTTS = (p: TTSProvider) => {
  provider = p;
};
