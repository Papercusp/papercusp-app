/**
 * Standing-approval auto-upgrade detector (Phase 4e).
 *
 * After 3 silent dispatches of `(capability, target_harness)` within 24h,
 * surface the (capability, target) pair as a candidate for a standing
 * approval. The user promotes a candidate via the settings page, which
 * appends an `[OPERATOR-PROPOSED-USER-CONFIRMED-…] [STANDING-APPROVE]`
 * entry to preferences.md.
 *
 * Reads dispatch counts from `audit_log` rows written by `operator-audit.ts`.
 * Candidates are stored as a tiny JSON cache so the settings page can
 * render them without re-querying audit_log on every mount.
 */

import { withWorkspace } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import { loadPreferences } from './operator-preferences';
import { readOperatorState, writeOperatorState } from './operator-state-pg';

const SILENT_DISPATCH_THRESHOLD = 3;
const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface StandingCandidate {
  capability: string;
  targetHarness: string;
  /** How many silent dispatches landed in the trailing 24h window. */
  count: number;
  /** ISO of the most recent qualifying dispatch. */
  lastSeenAt: string;
  /**
   * ISO of when this candidate was first surfaced in the UI. Required
   * non-null for `operator approve <slug>` voice eligibility per
   * voice-mode-plan-v4 §5d. Implementer note: each NEW candidate id
   * MUST start `null` — do NOT copy from a prior candidate with the
   * same (capability, targetHarness) pair. Re-proposed = user hasn't
   * seen this round.
   */
  firstShownAt: string | null;
}

export async function readCandidates(): Promise<StandingCandidate[]> {
  const raw = await readOperatorState<{ candidates?: StandingCandidate[] } | StandingCandidate[]>(
    'operator_standing_candidates',
  );
  if (!raw) return [];
  // Payload may be the bare array (legacy) or { candidates: [...] }; accept both.
  if (Array.isArray(raw)) return raw;
  return Array.isArray(raw.candidates) ? raw.candidates : [];
}

async function writeCandidates(cands: StandingCandidate[]): Promise<void> {
  await writeOperatorState('operator_standing_candidates', { candidates: cands });
}

/**
 * Recompute candidates from audit_log. Called after each successful
 * dispatch. Cheap query — bounded by ~the last 24h of operator dispatches.
 */
export async function refreshCandidates(): Promise<StandingCandidate[]> {
  const workspaceId = activeWorkspaceId();
  const cutoffMs = Date.now() - WINDOW_MS;
  let rows: { details: { capability?: string; target?: string }; ts: number }[] = [];
  try {
    rows = await withWorkspace(workspaceId, async (tx) => {
      return tx<{ details: { capability?: string; target?: string }; ts: number }[]>`
        SELECT details, ts
          FROM harness_shared.audit_log
         WHERE actor  = 'system:operator'
           AND action = 'operator.dispatched'
           AND ts     >= ${cutoffMs}
      `;
    });
  } catch {
    return await readCandidates();
  }

  const groups = new Map<string, { count: number; lastSeenMs: number; capability: string; target: string }>();
  for (const r of rows) {
    const cap = r.details?.capability;
    const target = r.details?.target;
    if (!cap || !target) continue;
    const key = `${cap}::${target}`;
    const cur = groups.get(key);
    if (cur) {
      cur.count++;
      if (r.ts > cur.lastSeenMs) cur.lastSeenMs = r.ts;
    } else {
      groups.set(key, { count: 1, lastSeenMs: r.ts, capability: cap, target });
    }
  }

  // Filter out (capability, target) pairs the user has already approved.
  const approved = new Set(
    (await loadPreferences()).standingApprovals.map((a) => `${a.capability}::${a.targetHarness}`),
  );

  // Preserve firstShownAt across recomputations: if the same
  // (capability, targetHarness) pair already had a non-null
  // firstShownAt in the prior list, carry it forward.
  const prior = await readCandidates();
  const priorShown = new Map<string, string>();
  for (const p of prior) {
    if (p.firstShownAt) priorShown.set(`${p.capability}::${p.targetHarness}`, p.firstShownAt);
  }

  const candidates: StandingCandidate[] = [];
  for (const [key, g] of groups) {
    if (g.count < SILENT_DISPATCH_THRESHOLD) continue;
    if (approved.has(key)) continue;
    candidates.push({
      capability: g.capability,
      targetHarness: g.target,
      count: g.count,
      lastSeenAt: new Date(g.lastSeenMs).toISOString(),
      firstShownAt: priorShown.get(key) ?? null,
    });
  }

  await writeCandidates(candidates);
  return candidates;
}

/**
 * Mark a candidate as having been shown in the UI (sets firstShownAt
 * to now, idempotent — only sets if currently null). Settings page
 * calls this when rendering a candidate row for the first time.
 *
 * Voice-approve eligibility (per v4 §2f) requires firstShownAt to be
 * non-null, so the user can only voice-grant something they've actually
 * seen.
 */
export async function markCandidateShown(capability: string, targetHarness: string): Promise<void> {
  const all = await readCandidates();
  let changed = false;
  for (const c of all) {
    if (c.capability === capability && c.targetHarness === targetHarness && !c.firstShownAt) {
      c.firstShownAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) await writeCandidates(all);
}
