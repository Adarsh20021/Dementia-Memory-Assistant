/**
 * Autosaved drafts so nothing typed is lost (tab closed, battery died...).
 * Stored per device in localStorage; every access is wrapped because storage
 * can be unavailable (private mode, blocked site data).
 */
import { useCallback, useEffect, useState } from 'react';

const read = (key: string) => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string | null) => {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: draft only lives in memory */
  }
};

export function useDraft(key: string, initial = '') {
  const storageKey = `dma-draft:${key}`;
  const [value, setValue] = useState(() => read(storageKey) ?? initial);
  /** True when the text shown came from an earlier, unsaved draft. */
  const [restored, setRestored] = useState(() => Boolean(read(storageKey)));
  const [loadedKey, setLoadedKey] = useState(storageKey);

  // A different entry (key) loads its own draft instead of keeping the old text.
  if (loadedKey !== storageKey) {
    const saved = read(storageKey);
    setLoadedKey(storageKey);
    setValue(saved ?? initial);
    setRestored(Boolean(saved));
  }

  useEffect(() => {
    const t = setTimeout(() => write(storageKey, value || null), 400);
    return () => clearTimeout(t);
  }, [storageKey, value]);

  const clear = useCallback(() => {
    write(storageKey, null);
    setValue('');
    setRestored(false);
  }, [storageKey]);

  return [value, setValue, clear, restored] as const;
}

export const localPref = { read, write };
