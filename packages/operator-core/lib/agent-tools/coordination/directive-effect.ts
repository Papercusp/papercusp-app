/**
 * directive-effect.ts — DELIVERED vs ACTED-ON for a coord directive.
 *
 * P-013 of fleet-leadership-continuity-and-actuation-2026-08-01.
 *
 * `coord:send { wake:'required' }` returning `woken: 1` proves ONE thing: a session
 * woke. It does not prove the instruction was carried out. The existing obligation
 * axis (`expects` / `expectsReply` → unanswered-directed.ts) closes a DIFFERENT gap:
 * it tracks whether the recipient SAID something back. A reply is an assertion by the
 * party under instruction — which is precisely the party whose compliance is in
 * question. For a safety-critical directive ("checkpoint before you compact",
 * "release that claim") the leader needs the SIDE EFFECT, observed in the ledger that
 * records it, not the recipient's word for it.
 *
 * So this module is deliberately NOT an ack channel. The sender NAMES the effect its
 * directive requires (`coord:send { expectEffect }`), the expectation rides the
 * envelope, and actuation is DERIVED afterwards from state we already store:
 *
 *   checkpoint    → harness_shared.carry_notes, scope `workitem:<harness>:<id>`,
 *                   `updated_ts` newer than the directive (the same join
 *                   listActiveClaimFreshnessForOwner uses for the flush gate), or
 *                   a committed/validated terminal completion record as a
 *                   checkpoint-safety alternative
 *   claim-release → the item no longer has a live holder AND `last_released_at`
 *                   post-dates the directive
 *   terminal      → `status` in the terminal set, closed after the directive
 *
 * ⚠ THE VERDICT IS TRI-STATE-PLUS, NOT A BOOLEAN, AND THAT IS THE WHOLE DESIGN.
 * `unknown` is a first-class answer and must never be collapsed into `not-yet`. The
 * ledger genuinely cannot prove some of these: only FEATURE-family rows carry
 * `last_released_at` / release history at all (see work-item-prior-work.ts's family
 * note), so an issue-family claim-release has no timestamp to compare and is
 * `unknown` — honestly unprovable — rather than "they ignored me". The sibling
 * postmortem on this exact surface (WI-6729, unanswered-directed.ts) is the reason:
 * a confident-but-wrong verdict on "what does this member still owe me" got acted on
 * and a real commitment was publicly retracted as non-existent. A leader escalating
 * on a fabricated `not-yet` is the same failure with a sharper edge, so an
 * unprovable effect SAYS it is unprovable and names what would prove it.
 *
 * `pre-existing` is the second guard, against the opposite error: an effect already
 * true BEFORE the directive was sent is not evidence the directive was obeyed. Every
 * verdict below is measured against `sentAtMs`, never against "is it true now".
 *
 * Shape follows work-item-prior-work.ts (P-001): a PURE fold that unit-tests without
 * PG, a thin IO seam that fails soft, and a pure renderer so the guarantee is
 * directly testable and a later edit cannot silently weaken the wording.
 */
import { getOrgPg } from '@papercusp/db-org';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { isTerminalStateInput } from '../../work-item-dispatch-states';
import { CompletionVerificationEvidenceSchema } from '../../coord-lifecycle/records';
import { isSufficientEvidence } from '../../work-item-completion-authority';

/** The side effects a directive can name. Deliberately small: each one is a fact the
 *  platform already records, so none of them needs the recipient's cooperation to
 *  observe. Adding a kind means adding a LEDGER to read, never an ack to trust. */
export const DIRECTIVE_EFFECT_KINDS = ['checkpoint', 'claim-release', 'terminal'] as const;
export type DirectiveEffectKind = (typeof DIRECTIVE_EFFECT_KINDS)[number];

/** What the sender declares at `coord:send` time. */
export interface DirectiveEffectSpec {
  kind: DirectiveEffectKind;
  /** The work-item the effect is expected on (WI-/EI-/F- id). */
  itemId: string;
  /** Harness slug, when the sender knows it (disambiguates the same id across pots). */
  harness?: string | null;
}

export type DirectiveEffectVerdict = 'satisfied' | 'not-yet' | 'pre-existing' | 'unknown';
export type DirectiveAlternativeProof = 'terminal-completion';

export interface DirectiveActuation {
  spec: DirectiveEffectSpec;
  verdict: DirectiveEffectVerdict;
  /** A durable terminal completion can prove checkpoint safety without being caused by this directive. */
  alternativeProof?: DirectiveAlternativeProof;
  /** Epoch ms of the observed effect, when one is recorded. */
  observedAtMs: number | null;
  /** One line naming what was observed — and, for `unknown`, what WOULD prove it. */
  evidence: string;
}

/** The REAL row shape of the actuation probe — column-for-column what the SQL below
 *  selects. Test fixtures build THIS, so a column rename reds the tests instead of
 *  quietly reading `undefined` (the P-020 lesson: an invented fixture shape made
 *  eleven green unit tests assert nothing). */
export interface DirectiveEffectRow {
  feature_id: string;
  harness_slug: string;
  status: string | null;
  taken_by: string | null;
  terminal_owner: string | null;
  completion_authority: string | null;
  completion_evidence: unknown;
  /** epoch ms; bigint columns arrive as strings from postgres-js. */
  last_released_ms: string | number | null;
  closed_ts: string | number | null;
  updated_ts: string | number | null;
  /** max(carry_notes.updated_ts) for this item's checkpoint scope. */
  checkpoint_ms: string | number | null;
}

function persistedCompletionEvidence(value: unknown) {
  let candidate = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }
  const parsed = CompletionVerificationEvidenceSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * A terminal item with a committed/validated, structured completion record has no
 * in-flight item state left to checkpoint. This is an ALTERNATIVE proof for the
 * checkpoint safety primitive, not a claim that the checkpoint directive itself
 * caused the terminal close.
 */
function hasDurableTerminalCompletion(row: DirectiveEffectRow): boolean {
  const status = String(row.status ?? '').trim();
  if (!status || !isTerminalStateInput(status)) return false;
  if (!String(row.terminal_owner ?? '').trim()) return false;
  if (row.completion_authority !== 'committed' && row.completion_authority !== 'validated') return false;
  const evidence = persistedCompletionEvidence(row.completion_evidence);
  return evidence != null && isSufficientEvidence(evidence);
}

function toMs(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * PURE: decide whether the named effect happened AFTER the directive was sent.
 *
 * `row === null` means the item was not found at all — `unknown`, never `not-yet`:
 * an id the probe cannot resolve says nothing about the recipient's compliance.
 */
export function resolveDirectiveEffect(
  spec: DirectiveEffectSpec,
  row: DirectiveEffectRow | null,
  sentAtMs: number,
): DirectiveActuation {
  const base = { spec, observedAtMs: null as number | null };
  if (!row) {
    return {
      ...base,
      verdict: 'unknown',
      evidence: `work-item ${spec.itemId} not found — cannot observe the effect. Check the id/harness on the directive.`,
    };
  }

  switch (spec.kind) {
    case 'checkpoint': {
      const ms = toMs(row.checkpoint_ms);
      if (ms != null && ms >= sentAtMs) {
        return {
          spec,
          verdict: 'satisfied',
          observedAtMs: ms,
          evidence: `checkpoint written at ${iso(ms)}, after the directive (${iso(sentAtMs)}).`,
        };
      }
      if (hasDurableTerminalCompletion(row)) {
        const terminalMs = toMs(row.closed_ts) ?? toMs(row.updated_ts);
        const status = String(row.status ?? '').trim();
        const authority = row.completion_authority;
        const timing =
          terminalMs == null
            ? 'with no close timestamp'
            : terminalMs >= sentAtMs
              ? `at ${iso(terminalMs)}, after the directive (${iso(sentAtMs)})`
              : `at ${iso(terminalMs)}, before the directive (${iso(sentAtMs)})`;
        return {
          spec,
          // This is an alternative proof for checkpoint SAFETY, not evidence that
          // the named checkpoint effect happened. Keep the generic actuation
          // contract honest: a checkpoint directive must not be marked acted-on
          // merely because the item later reached a durable terminal close.
          verdict: 'pre-existing',
          alternativeProof: 'terminal-completion',
          observedAtMs: terminalMs,
          evidence:
            `${spec.itemId} is already terminal (\`${status}\`) with ${authority} structured completion evidence ` +
            `${timing}; the checkpoint directive is not attributable, but no additional checkpoint write is possible or required.`,
        };
      }
      if (ms == null) {
        return {
          ...base,
          verdict: 'not-yet',
          evidence: `no checkpoint has ever been written for ${spec.itemId}.`,
        };
      }
      return {
        spec,
        verdict: 'pre-existing',
        observedAtMs: ms,
        evidence: `a checkpoint exists but is OLDER than the directive (written ${iso(ms)}, directive ${iso(sentAtMs)}) — it is not evidence the directive was carried out.`,
      };
    }

    case 'claim-release': {
      const heldBy = String(row.taken_by ?? '').trim();
      const releasedMs = toMs(row.last_released_ms);
      if (heldBy) {
        return {
          spec,
          verdict: 'not-yet',
          observedAtMs: null,
          evidence: `${spec.itemId} is STILL HELD by ${heldBy}.`,
        };
      }
      if (releasedMs == null) {
        // Only feature-family rows carry release history at all. No holder + no
        // timestamp is genuinely unprovable, not a miss — say so, and name the proof.
        return {
          ...base,
          verdict: 'unknown',
          evidence: `${spec.itemId} has no holder, but no release timestamp is recorded (issue-family rows carry no release history), so the release cannot be dated against the directive. Confirm via the item's checkpoint or its holder's presence.`,
        };
      }
      if (releasedMs >= sentAtMs) {
        return {
          spec,
          verdict: 'satisfied',
          observedAtMs: releasedMs,
          evidence: `claim released at ${iso(releasedMs)}, after the directive (${iso(sentAtMs)}).`,
        };
      }
      return {
        spec,
        verdict: 'pre-existing',
        observedAtMs: releasedMs,
        evidence: `${spec.itemId} is unheld, but its last release (${iso(releasedMs)}) PRE-DATES the directive (${iso(sentAtMs)}) — the item was already free, so this is not evidence of compliance.`,
      };
    }

    case 'terminal': {
      const status = String(row.status ?? '').trim();
      if (!status || !isTerminalStateInput(status)) {
        return {
          ...base,
          verdict: 'not-yet',
          evidence: `${spec.itemId} is still \`${status || 'unknown'}\` — not terminal.`,
        };
      }
      // closed_ts is the precise stamp; updated_ts is the fallback for rows closed
      // before closed_ts was maintained. Neither ⇒ terminal but undatable.
      const closedMs = toMs(row.closed_ts) ?? toMs(row.updated_ts);
      if (closedMs == null) {
        return {
          ...base,
          verdict: 'unknown',
          evidence: `${spec.itemId} is terminal (\`${status}\`) but carries no close timestamp, so it cannot be dated against the directive.`,
        };
      }
      if (closedMs >= sentAtMs) {
        return {
          spec,
          verdict: 'satisfied',
          observedAtMs: closedMs,
          evidence: `${spec.itemId} reached \`${status}\` at ${iso(closedMs)}, after the directive (${iso(sentAtMs)}).`,
        };
      }
      return {
        spec,
        verdict: 'pre-existing',
        observedAtMs: closedMs,
        evidence: `${spec.itemId} was ALREADY \`${status}\` before the directive (closed ${iso(closedMs)}, directive ${iso(sentAtMs)}) — the directive cannot be credited for it.`,
      };
    }
  }
}

/**
 * PURE: the one line a leader reads. Kept separate from the verdict so wording is
 * directly testable, and so a caller that wants the structure is never forced
 * through prose (the priorWorkWarning shape).
 */
export function actuationLine(a: DirectiveActuation): string {
  const label =
    a.verdict === 'satisfied'
      ? '✓ ACTED ON'
      : a.verdict === 'not-yet'
        ? '✗ NOT ACTED ON'
        : a.verdict === 'pre-existing'
          ? '~ PRE-EXISTING (not attributable)'
          : '? UNPROVABLE';
  return `${label} — expected \`${a.spec.kind}\` on ${a.spec.itemId}: ${a.evidence}`;
}

/**
 * PURE: fold a set of actuations into the aggregate a fleet-health read shows.
 * `actionable` counts only the verdicts a leader should chase — `pre-existing` and
 * `unknown` are deliberately NOT counted as misses (see the header: a fabricated
 * miss is the failure this module is shaped to avoid).
 */
export interface DirectiveActuationSummary {
  total: number;
  satisfied: number;
  notYet: number;
  unprovable: number;
  /** Newest-first lines for the ones a leader should look at (not-yet only). */
  outstanding: string[];
}

export function summarizeActuations(
  actuations: readonly DirectiveActuation[],
  cap = 3,
): DirectiveActuationSummary {
  const notYet = actuations.filter((a) => a.verdict === 'not-yet');
  return {
    total: actuations.length,
    satisfied: actuations.filter((a) => a.verdict === 'satisfied').length,
    notYet: notYet.length,
    unprovable: actuations.filter((a) => a.verdict === 'unknown' || a.verdict === 'pre-existing').length,
    outstanding: notYet.slice(0, Math.max(0, cap)).map(actuationLine),
  };
}

/**
 * IO seam: batch-probe the ledgers for a set of expectations. ONE query for every
 * item (mirroring fetchUnansweredDirected / fetchContextPressure: enriching N
 * expectations costs one read, not N).
 *
 * Fails SOFT — a PG error yields `unknown` verdicts, never a throw. This decorates a
 * health read; it must never be able to fail the read it decorates.
 */
export async function fetchDirectiveActuations(
  specs: readonly (DirectiveEffectSpec & { sentAtMs: number })[],
  opts: { workspaceId?: string } = {},
): Promise<DirectiveActuation[]> {
  if (specs.length === 0) return [];
  const ws = resolveConcreteWorkspaceId(opts.workspaceId);
  const ids = [...new Set(specs.map((s) => s.itemId).filter(Boolean))];
  if (!ws || ids.length === 0) {
    return specs.map((s) => resolveDirectiveEffect(s, null, s.sentAtMs));
  }
  let byKey = new Map<string, DirectiveEffectRow>();
  try {
    const { sql } = getOrgPg();
    const rows = await sql<DirectiveEffectRow[]>`
      SELECT wi.feature_id,
             wi.harness_slug,
             wi.status,
             wi.taken_by,
             wi.terminal_owner,
             wi.authority AS completion_authority,
             wi.payload -> '_completionEvidence' AS completion_evidence,
             (extract(epoch FROM wi.last_released_at) * 1000)::bigint AS last_released_ms,
             wi.closed_ts,
             wi.updated_ts,
             (SELECT max(cn.updated_ts)
                FROM harness_shared.carry_notes cn
               WHERE cn.scope IN (
                       'workitem:' || wi.harness_slug || ':' || wi.feature_id,
                       'workitem:*:' || wi.feature_id)
                 AND cn.note IS NOT NULL)                            AS checkpoint_ms
        FROM harness_shared.work_items wi
       WHERE wi.workspace_id = ${ws}
         AND wi.feature_id = ANY(${ids}::text[])`;
    byKey = new Map(rows.map((r) => [`${r.harness_slug}\x00${r.feature_id}`, r]));
  } catch {
    return specs.map((s) => resolveDirectiveEffect(s, null, s.sentAtMs));
  }
  const byId = new Map<string, DirectiveEffectRow>();
  for (const r of byKey.values()) if (!byId.has(r.feature_id)) byId.set(r.feature_id, r);
  // (the per-recipient grouped read lives in directive-effect-read.ts — it reads the
  //  COORD handle for the stamped expectations, this reads the ORG handle for the
  //  ledger rows; keeping the two handles in one module invites blurring them.)

  return specs.map((s) => {
    const harness = s.harness == null || s.harness === '' || s.harness === '*' ? null : s.harness;
    const row = (harness ? byKey.get(`${harness}\x00${s.itemId}`) : undefined) ?? byId.get(s.itemId) ?? null;
    return resolveDirectiveEffect(s, row, s.sentAtMs);
  });
}
