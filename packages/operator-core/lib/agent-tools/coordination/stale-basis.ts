import type { BasedOnEntry } from './message-fields';

export const STALE_BASIS_FIELD = 'staleBasis';

export interface StaleBasisStamp {
  ref: string;
  readAt: string;
  versionAtSend: string;
  changedAt: string;
  stateAtSend: string;
}

/**
 * Find refs whose current version token proves that they changed after the
 * sender read them. Work-item freshness tokens are `<state>@<updated-ms>`; no
 * version-at-read is invented, and opaque token kinds remain unclassified.
 */
export function staleBasis(entries: readonly BasedOnEntry[]): StaleBasisStamp[] {
  const out: StaleBasisStamp[] = [];
  for (const entry of entries) {
    if (!entry.ref.startsWith('work-item:') || !entry.versionAtSend) continue;
    const match = /^([^@]+)@(\d+)$/.exec(entry.versionAtSend);
    if (!match) continue;
    const readMs = Date.parse(entry.readAt);
    const changedMs = Number(match[2]);
    if (!Number.isFinite(readMs) || !Number.isSafeInteger(changedMs) || changedMs <= readMs) continue;
    out.push({
      ref: entry.ref,
      readAt: entry.readAt,
      versionAtSend: entry.versionAtSend,
      changedAt: new Date(changedMs).toISOString(),
      stateAtSend: match[1]!,
    });
  }
  return out;
}

export function readStaleBasis(value: unknown): StaleBasisStamp[] {
  if (!Array.isArray(value)) return [];
  return value.filter((stamp): stamp is StaleBasisStamp => {
    if (!stamp || typeof stamp !== 'object') return false;
    const row = stamp as Record<string, unknown>;
    return typeof row.ref === 'string' && typeof row.readAt === 'string' &&
      typeof row.versionAtSend === 'string' && typeof row.changedAt === 'string' &&
      typeof row.stateAtSend === 'string';
  });
}

export function renderStaleBasisSuffix(value: unknown): string {
  const stamps = readStaleBasis(value);
  if (!stamps.length) return '';
  const rendered = stamps.slice(0, 3).map((stamp) => {
    const ref = stamp.ref.replace(/^work-item:/, '');
    return `${ref} changed after read (now ${stamp.stateAtSend})`;
  });
  return ` ⚠ stale basis: ${rendered.join('; ')}`;
}
