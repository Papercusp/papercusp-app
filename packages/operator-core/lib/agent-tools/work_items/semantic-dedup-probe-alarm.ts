/**
 * semantic-dedup-probe-alarm — EI-22170937574367219: the semantic dedup
 * prescreen (semantic-dupe-guard.ts) fails OPEN by design on every failure
 * mode — embed throw, query throw, disabled embedder, dims mismatch, budget
 * expiry, kill switch (see that file's own docstring + its
 * `fail-open — every failure mode returns null` test suite). That is correct
 * for an ordinary create: a create must never be blocked by embedder health.
 *
 * But every one of those paths was previously SILENT — no log, no escalation,
 * anywhere (confirmed by reading each one: `findSemanticDupes`'s catch swallows
 * the error, `classify()`'s early returns are plain `return null`, and
 * `withBudget`'s timeout resolves null with no callback). The ONLY externally
 * visible signal was a goal-mode create's `dedup_unavailable` refusal
 * (_create-core.ts, P-004), hit by whichever agent happened to be filing at
 * the time. While the probe is down, EVERY goal-mode create across the fleet
 * refuses (or files degraded under `force:true`) — a fleet-wide condition with
 * no publisher.
 *
 * This module is that missing publisher: a best-effort, deduplicated
 * escalation opened whenever `_create-core.ts` observes `semanticLeg ===
 * 'unavailable'` on a screened create. It reuses the SAME dedup-by-(kind,
 * signature) escalation primitive `embed-space-self-check.ts` already uses for
 * the adjacent embedding-desync alarm, so repeated occurrences bump ONE
 * record's repeat count instead of opening a new one per failed create.
 *
 * Deliberately:
 *  - NEVER throws and NEVER rejects (internal try/catch; callers still treat
 *    the returned promise as fire-and-forget — see the call site).
 *  - NEVER logs via console. This codebase fails a vitest run on an
 *    unexpected console.warn/error (see
 *    `_create-core.goal-dedup-gate.test.ts`'s comment on the goal-context
 *    stamp for the precedent), and this path is exercised by ~15 existing
 *    dedup-gate test cases that mock `findSemanticDupes` to resolve `null`.
 *  - A NO-OP under vitest (checked first, before touching any real
 *    infrastructure) — mirrors the same-file convention in
 *    `semantic-dupe-guard.ts` (`if (process.env.VITEST && !deps) return
 *    null;`). This means the existing create-path test suites need no new
 *    mocking to stay green; this module's own behaviour is covered by its
 *    dedicated test file instead.
 */
import { openEscalation } from '../coordination/escalations';
import type { AgentIdentity } from '../coordination/identity';

const IDENTITY: AgentIdentity = {
  ownerId: 'system:semantic-dedup-probe-alarm',
  ownerLabel: 'system · semantic-dedup-probe-alarm',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

// Durable escalation dedup identity — bumps one open record's repeat count on
// every re-occurrence rather than opening a new one (same shape as
// embed-space-self-check.ts's DEDUP_KIND/SUBJECT_SIGNATURE).
const DEDUP_KIND = 'semantic-dedup-probe-unavailable';
const SUBJECT_SIGNATURE = 'work-items-create-goal-gate';

export interface SemanticDedupProbeUnavailableDetail {
  /** The harness the refused/degraded create targeted, if known. */
  harnessSlug?: string;
}

/**
 * Fire-and-forget: report that the semantic dedup probe was unavailable for a
 * SCREENED create (issue-family, or any goal-gated create). Callers must never
 * `await` this on the create's hot path — call it as
 * `void reportSemanticDedupProbeUnavailable(...).catch(() => {})`.
 */
export async function reportSemanticDedupProbeUnavailable(
  detail: SemanticDedupProbeUnavailableDetail,
): Promise<void> {
  if (process.env.VITEST) return; // never touch real infra under test — see file header
  try {
    await openEscalation(IDENTITY, {
      severity: 'advisory',
      summary:
        'work_items:create semantic dedup probe is unavailable — goal-mode creates are refusing ' +
        'with dedup_unavailable (or filing degraded under force:true) until this clears.',
      body:
        `EI-22170937574367219: the semantic leg of the work-item dedup prescreen ` +
        `(semantic-dupe-guard.ts) returned no verdict for a screened create` +
        (detail.harnessSlug ? ` in harness '${detail.harnessSlug}'` : '') +
        `. This fails OPEN by design (a create is never blocked by embedder health), but under ` +
        `the P-004 goal gate it also means the create refused with 'dedup_unavailable' unless ` +
        `force:true was passed — a reworded duplicate cannot be screened while this holds ` +
        `(the WI-39373 relapse shape). Root cause is one of: the embedder cascade resolved ` +
        `'disabled' (no OpenAI key + no local/gemma model), an embed/query call threw, or the ` +
        `2500ms probe budget expired. Check accounts:status / embed sidecar health first.`,
      meta: { dedupKind: DEDUP_KIND, subjectSignature: SUBJECT_SIGNATURE },
    });
  } catch {
    /* an alarm-send failure must never crash the request worker */
  }
}
