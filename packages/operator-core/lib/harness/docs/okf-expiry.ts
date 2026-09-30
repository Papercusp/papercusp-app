/**
 * okf-expiry — the TIME-based half of doc freshness (P-005 of
 * `okf-frontmatter-adoption-2026-08-08`).
 *
 * The existing freshness sweep answers "did the CODE this doc documents move?"
 * (git anchors, `documents:` frontmatter). OKF's `stale_after` answers a
 * different question — "has this doc outlived the date its author gave it?" —
 * and the two are orthogonal in a way that matters:
 *
 *   - Anchor drift fires only when a commit touches an anchored path. An expiry
 *     fires on a day when NOTHING changed, which is exactly the case the git
 *     sweep is structurally blind to.
 *   - Anchor drift is REPAIRABLE by a doc-steward regeneration. An expiry is a
 *     request for a HUMAN (or an agent) to re-check claims against reality; it
 *     cannot be healed by rewriting the doc from the code.
 *
 * So expiry is reported as its OWN class and deliberately does NOT flow into
 * `classifyDrift` / the steward retry latches — folding it in would both corrupt
 * drift's git semantics and burn a doc's 5-attempt steward budget on work no
 * steward can do.
 *
 * ⚠ The whole live corpus carries ZERO `stale_after` values today (659/659
 * insights, 70/70 pack docs — plan D-002: a fabricated expiry is worse than an
 * absent one). This scan therefore reports nothing at all right now, and that is
 * the CORRECT result. It exists so the first author who writes a real
 * `stale_after` gets the behaviour without further work.
 */

import { parseOkfFrontmatter, evaluateOkfTrust } from '@papercusp/docs-engine';
import { pinModuleState } from '@papercusp/module-singleton';
import { listDocBodies, readDocBody } from './doc-fs';

export interface ExpiredDoc {
  docId: string;
  /** The authored `stale_after` this doc is past. */
  staleAfter: string;
}

export interface OkfExpiryScan {
  /** Docs walked (the DENOMINATOR — a scan that silently walked 6 files instead of
   *  659 reads identical to a clean result; plan D-001 learned this the hard way). */
  scanned: number;
  /** Docs carrying a `stale_after` at all — the population the verdict is about. */
  withStaleAfter: number;
  expired: ExpiredDoc[];
  /** Docs whose `stale_after` did not parse as a date. NOT counted as expired — an
   *  unreadable field is a conformance defect (P-006's lint), not staleness. */
  unparseable: string[];
}

/** Cap on how many doc ids the digest names inline (mirrors the drift digest). */
export const OKF_EXPIRY_DIGEST_MAX_NAMED = 8;

/** Bound on concurrent file reads — the corpus is ~700 small files. */
const READ_CONCURRENCY = 16;

/**
 * Walk a docs tree and report which docs are past their `stale_after`.
 *
 * Pure w.r.t. the database: it reads files and returns a verdict, writing
 * nothing. Every failure degrades to "not expired" (an unreadable file cannot
 * be judged, and guessing would manufacture a warning out of an IO error).
 */
export async function scanExpiredDocs(
  docsRoot: string,
  now: Date = new Date(),
): Promise<OkfExpiryScan> {
  const files = await listDocBodies(docsRoot).catch(() => [] as string[]);
  const out: OkfExpiryScan = { scanned: 0, withStaleAfter: 0, expired: [], unparseable: [] };

  for (let i = 0; i < files.length; i += READ_CONCURRENCY) {
    const batch = files.slice(i, i + READ_CONCURRENCY);
    const bodies = await Promise.all(batch.map((rel) => readDocBody(docsRoot, rel)));
    for (let j = 0; j < batch.length; j++) {
      const body = bodies[j];
      if (body === null) continue;
      out.scanned += 1;
      const okf = parseOkfFrontmatter(body);
      if (!okf?.staleAfter) continue;
      out.withStaleAfter += 1;
      const trust = evaluateOkfTrust(okf, now);
      if (trust.staleAfterUnparseable) out.unparseable.push(batch[j]);
      else if (trust.stale) out.expired.push({ docId: batch[j], staleAfter: okf.staleAfter });
    }
  }

  return out;
}

/**
 * ONE digest line per scan, or null when there is nothing to say (the corpus's
 * state today). Same shape + naming cap as the drift digest so a reader's inbox
 * treats them alike — and, per EI-2826, so this can never become a per-doc flood.
 */
export function buildOkfExpiryDigest(harnessSlug: string, scan: OkfExpiryScan): string | null {
  if (scan.expired.length === 0 && scan.unparseable.length === 0) return null;
  const parts: string[] = [];
  if (scan.expired.length > 0) {
    const named = scan.expired
      .slice(0, OKF_EXPIRY_DIGEST_MAX_NAMED)
      .map((d) => `${d.docId} (${d.staleAfter})`)
      .join(', ');
    const more =
      scan.expired.length > OKF_EXPIRY_DIGEST_MAX_NAMED
        ? ` (+${scan.expired.length - OKF_EXPIRY_DIGEST_MAX_NAMED} more)`
        : '';
    parts.push(`${scan.expired.length} past stale_after → NEEDS RE-VERIFY: ${named}${more}`);
  }
  if (scan.unparseable.length > 0) {
    parts.push(
      `${scan.unparseable.length} with an unparseable stale_after: ${scan.unparseable.slice(0, OKF_EXPIRY_DIGEST_MAX_NAMED).join(', ')}`,
    );
  }
  return `📅 ${harnessSlug}: OKF expiry sweep over ${scan.scanned} doc(s) — ${parts.join('; ')}`;
}

/**
 * Once-per-UTC-day gate, per harness.
 *
 * `stale_after` is DATE-granular, so re-scanning the tree on every git-sync tick
 * (minutes apart) can never surface anything a scan earlier the same day did not.
 * The gate is per-process, so a restart costs at most one extra scan — cheap, and
 * strictly better than either extreme (a per-tick walk of ~700 files, or a
 * persisted watermark whose staleness would then need its own reconciliation).
 */
const __okfExpiryScanDays = pinModuleState<Map<string, string>>(
  'papercusp.operator-core.okf-expiry-scan-days',
  () => new Map<string, string>(),
);

export function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** True at most once per UTC day per harness; marks the day as scanned when it returns true. */
export function claimDailyExpiryScan(harnessSlug: string, now: Date = new Date()): boolean {
  const day = utcDayKey(now);
  if (__okfExpiryScanDays.get(harnessSlug) === day) return false;
  __okfExpiryScanDays.set(harnessSlug, day);
  return true;
}

/** Test-only: forget the per-day gate so a case can re-run the scan. */
export function __resetDailyExpiryScanGate(): void {
  __okfExpiryScanDays.clear();
}
