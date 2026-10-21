/**
 * Shared narration state for the whole app:
 *  - `speaking` / `text`: what the app is saying right now (drives the Stop button);
 *  - `muted`: the patient's "voice off" switch, remembered on this device.
 * Every call to getTTS().speak() goes through this, so Stop and Mute work for
 * every narration, wherever it starts.
 */
import { useSyncExternalStore } from 'react';

type State = { speaking: boolean; text: string | null; muted: boolean };

const MUTE_KEY = 'dma-voice-muted';
const readMuted = () => {
  try {
    return window.localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
};

let state: State = { speaking: false, text: null, muted: typeof window !== 'undefined' && readMuted() };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

let token = 0;
let poll: ReturnType<typeof setInterval> | null = null;
const clearPoll = () => {
  if (poll) clearInterval(poll);
  poll = null;
};
const engineBusy = () => {
  try {
    return window.speechSynthesis.speaking || window.speechSynthesis.pending;
  } catch {
    return false;
  }
};

/** Low-level hooks the TTS wrapper uses. */
export const narration = {
  get: () => state,
  /** A new sentence is about to be spoken; returns its id. */
  begin(text: string) {
    clearPoll();
    token += 1;
    set({ speaking: true, text });
    return token;
  },
  /** Speech has started: watch the engine until it goes quiet. */
  watch(id: number) {
    clearPoll();
    let quietTicks = 0;
    poll = setInterval(() => {
      if (id !== token) return clearPoll();
      // Two quiet checks in a row, so a pause/resume nudge is not mistaken for the end.
      quietTicks = engineBusy() ? 0 : quietTicks + 1;
      if (quietTicks >= 2) narration.end(id);
    }, 200);
  },
  end(id?: number) {
    if (id !== undefined && id !== token) return;
    clearPoll();
    if (state.speaking || state.text) set({ speaking: false, text: null });
  },
};

let stopper: () => void = () => undefined;
/** Registered by the TTS layer so the UI can stop speech without importing it. */
export const registerStopper = (fn: () => void) => {
  stopper = fn;
};

/** Stop whatever is being said right now. */
export function stopNarration() {
  token += 1;
  stopper();
  narration.end();
}

/** Turn the app's voice off (and stop it now) or back on. */
export function setMuted(muted: boolean) {
  try {
    window.localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    /* storage unavailable: the setting lasts until the page reloads */
  }
  if (muted) stopNarration();
  set({ muted });
}

export function useNarration() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}
