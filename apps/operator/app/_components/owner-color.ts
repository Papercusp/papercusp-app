/**
 * owner-color — a deterministic per-user color so a busy shared plan list is
 * visually parseable at a glance (shared-hive-collaboration-2026-06-14 P-003).
 *
 * Pure + stable: the same identity (email / login / pubkey) always maps to the
 * same hue across machines and reloads, so an owner's plans read as "the same
 * color" everywhere. Hue is spread over the wheel via an FNV-1a hash; saturation
 * and lightness are fixed for legibility on the dark UI. Consumed by AuthorBadge
 * / the plans rail owner chip (P-001).
 */

/** FNV-1a 32-bit — tiny, dependency-free, stable across processes/platforms.
 *  (Same hash the git-sync cron jitter uses.) */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic hue (0–359) for an identity. Empty/blank → a neutral 0. */
export function ownerHue(identity: string | null | undefined): number {
  const key = (identity ?? '').trim().toLowerCase();
  if (!key) return 0;
  return fnv1a(key) % 360;
}

export interface OwnerColorOpts {
  /** Saturation %, default 60. */
  saturation?: number;
  /** Lightness %, default 60 (legible on the dark UI). */
  lightness?: number;
  /** Alpha 0–1, default 1. */
  alpha?: number;
}

/**
 * A stable CSS color for an identity. Blank identity → a neutral grey (so an
 * unowned plan doesn't get a misleading vivid color). Use for an owner chip's
 * border/background accent.
 */
export function ownerColor(identity: string | null | undefined, opts: OwnerColorOpts = {}): string {
  const key = (identity ?? '').trim();
  const sat = opts.saturation ?? 60;
  const light = opts.lightness ?? 60;
  const alpha = opts.alpha ?? 1;
  if (!key) return alpha < 1 ? `hsl(0 0% 60% / ${alpha})` : 'hsl(0 0% 60%)';
  const hue = ownerHue(key);
  return alpha < 1 ? `hsl(${hue} ${sat}% ${light}% / ${alpha})` : `hsl(${hue} ${sat}% ${light}%)`;
}
