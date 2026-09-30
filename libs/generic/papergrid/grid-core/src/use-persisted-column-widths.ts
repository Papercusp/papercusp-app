/**
 * usePersistedColumnWidths — a tiny companion to RichGrid's controlled
 * `columnWidths` / `onColumnWidthsChange` props: keeps the user's dragged
 * column widths in a storage slot so they survive component remounts
 * (dock-panel tab switches, layout changes, reloads).
 *
 * Domain-agnostic by design: the storage seam defaults to
 * `window.localStorage` but accepts any `getItem`/`setItem` pair (tests
 * inject a Map-backed stub; SSR renders get a no-op).
 *
 * Corrupt or foreign-shaped entries are discarded on read — a bad slot can
 * never wedge the grid; it just starts at the defaults again.
 */
import { useCallback, useState } from 'react';

export type ColumnWidthStorage = Pick<Storage, 'getItem' | 'setItem'>;

function readWidths(storage: ColumnWidthStorage | undefined, key: string): Record<string, number> {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function usePersistedColumnWidths(
  storageKey: string,
  storage?: ColumnWidthStorage,
): [Record<string, number>, (next: Record<string, number>) => void] {
  const store =
    storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
  // Lazy init: one storage read per mount. A storageKey change mid-life is
  // not tracked (keys are static per call site).
  const [widths, setWidths] = useState<Record<string, number>>(() =>
    readWidths(store, storageKey),
  );
  const save = useCallback(
    (next: Record<string, number>) => {
      setWidths(next);
      try {
        store?.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Quota/denied storage: widths still apply for this mount.
      }
    },
    // localStorage / injected stubs are stable identities.
    [storageKey, store],
  );
  return [widths, save];
}
