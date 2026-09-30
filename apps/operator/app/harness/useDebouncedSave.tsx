'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * Per-field-settings auto-save with debounce. The canonical primitive for
 * settings pages where each control persists independently (no Submit button).
 *
 * Pattern:
 *   const [engine, setEngine] = useState(initial.engine);
 *   const { saving, lastSavedAt, flush } = useDebouncedSave(
 *     { engine },
 *     async (v) => { await fetch('/api/voice/config', { method: 'POST', body: JSON.stringify(v) }); },
 *   );
 *
 * - First-render save is suppressed by default (skipFirst), so hydration from
 *   the server doesn't fire an immediate POST.
 * - Pass `ms: 0` when the caller already gates typing into committed edits
 *   (DraftInput/DraftNumberInput, selects, toggles). The save starts
 *   immediately instead of waiting for a debounce timer.
 * - Calling flush() forces an immediate save (e.g. before a Test button runs).
 * - A PENDING save is FLUSHED (fire-and-forget) on unmount and on `pagehide`,
 *   never dropped — navigating away or reloading right after an edit must not
 *   lose it. Callers whose persist uses fetch should pass `keepalive: true`
 *   so the pagehide-time request survives a full page unload.
 *
 * See /docs/design/libraries#form-patterns for when to use this vs RHF.
 */
export function useDebouncedSave<T>(
  value: T,
  persist: (value: T) => Promise<void>,
  opts: {
    /** Debounce window in ms. Default 300. */
    ms?: number;
    /** Called with the timestamp of each successful save. */
    onSavedAt?: (date: Date) => void;
    /** Called when persist() throws. */
    onError?: (err: unknown) => void;
    /** If true (default), the first render does not trigger a save. */
    skipFirst?: boolean;
  } = {},
): {
  saving: boolean;
  lastSavedAt: Date | null;
  /** Force an immediate save with the current value. Resolves when done. */
  flush: () => Promise<void>;
  /**
   * Discard the pending edit: clear the debounce timer AND the pending flag,
   * so neither the timer nor the unmount/pagehide flush persists it. For
   * callers whose edit target is about to be destroyed by a competing action
   * (an outline merge/delete consumes the text another way) — flushing there
   * would resurrect the value onto a dead record.
   */
  cancel: () => void;
} {
  const { ms = 300, onSavedAt, onError, skipFirst = true } = opts;
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const valueRef = useRef(value);
  const persistRef = useRef(persist);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstRef = useRef(true);
  // True while an edit is scheduled but not yet persisted. Survives the
  // schedule-effect's cleanup (which only swaps timers) so the unmount /
  // pagehide flush can tell "still pending" from "already saved".
  const pendingRef = useRef(false);

  // Keep refs current so the debounced closure always reads the latest value
  // + the latest persist function (callers often pass an inline async fn).
  valueRef.current = value;
  persistRef.current = persist;

  const doSave = useCallback(async () => {
    setSaving(true);
    try {
      await persistRef.current(valueRef.current);
      const now = new Date();
      setLastSavedAt(now);
      onSavedAt?.(now);
    } catch (err) {
      onError?.(err);
    } finally {
      setSaving(false);
    }
  }, [onSavedAt, onError]);
  const doSaveRef = useRef(doSave);
  doSaveRef.current = doSave;

  const flush = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = false;
    await doSaveRef.current();
  }, []);

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = false;
  }, []);

  useEffect(() => {
    if (skipFirst && isFirstRef.current) {
      isFirstRef.current = false;
      return;
    }
    isFirstRef.current = false;

    pendingRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    if (ms <= 0) {
      pendingRef.current = false;
      timerRef.current = null;
      void doSaveRef.current();
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      pendingRef.current = false;
      void doSaveRef.current();
    }, ms);

    return () => {
      // Only swap the timer here — pendingRef stays true so the
      // unmount/pagehide flush below still fires for an unsaved edit.
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    // We deliberately depend on the serialised value, not the function, so
    // the debounce restarts when the user keeps typing but doesn't reset on
    // every render that creates a new persist closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value), ms, skipFirst]);

  // Flush (never drop) a pending edit when the component unmounts or the
  // page unloads — losing a save the UI already promised is data loss.
  useEffect(() => {
    const flushPending = () => {
      if (!pendingRef.current) return;
      pendingRef.current = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      void doSaveRef.current();
    };
    window.addEventListener('pagehide', flushPending);
    return () => {
      window.removeEventListener('pagehide', flushPending);
      flushPending();
    };
  }, []);

  return { saving, lastSavedAt, flush, cancel };
}
