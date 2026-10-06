/**
 * scheduler:preview_spec_delta — what a proposed claim-spec revision would change, by ITEM,
 * before you write it (agent-epistemics-2026-08-02 P-005).
 *
 * WHY: re-steering a fleet is a spec bump, and the only pre-write signal was
 * `set_claim_spec`'s `poolEffect` — a COUNT (matched / pool / previousMatched), computed
 * during the write and failing open. A count answers "did the lane get smaller"; it cannot
 * answer "did it drop the four criticals this fleet was launched for". For WI-6995 the audit
 * hand-rolled the item-level delta in raw SQL and the answer OVERTURNED the proposal it was
 * checking — which is the case for making it a cheap first-class read instead of an ad-hoc
 * query someone has to think to write.
 *
 * The engine is {@link readClaimSpecDelta}, deliberately co-located with the claim floors in
 * scheduler/get-next.ts: a second SQL copy of those floors drifts (D-007 measured one
 * reporting 0 blocked against the claim path's 5). This tool is a thin, READ-ONLY projection
 * over it — it resolves the CURRENT spec exactly as scheduler:get_claim_spec does and
 * validates the PROPOSED spec exactly as scheduler:set_claim_spec does, so a proposal that
 * previews clean is one set_claim_spec will accept.
 *
 * ⚠ EI-21177555351818650: `readClaimSpecDelta` shares scheduler:get_next's FLOOR logic but
 * NOT its claim-family coverage — the engine's candidate subquery is issue-family-only
 * (`item_kind IN ('bug','change','task')`), while scheduler:get_next's real claim ladder also
 * runs tiers 1/2 against feature-family rows. Reproduced live: this preview reported
 * `currentClaimable: 0` / `proposedClaimable: 0` for a feature-family id it was explicitly
 * asked about, and `scheduler:get_next` claimed that exact id under the same stored spec
 * seconds later. See {@link deltaFamilyScopeIncomplete} / {@link FAMILY_SCOPE_BLIND_SPOT_WARNING}
 * for the mitigation: this tool now loudly flags (`familyScopeIncomplete` + a `warnings` entry)
 * whenever either spec's own `kind` filter does not restrict exclusively to issue-family kinds,
 * so a false zero can never be mistaken for a confirmed one.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import {
  resolveClaimSpecWorkspace,
  getClaimSpecRecord,
  fleetSpecBeeKey,
} from '../../scheduler/claim-spec-store';
import { resolveClaimSpecPotSlug } from '../../scheduler/claim-spec-workspace';
import { claimSpecSchema, validateClaimSpec } from '../../scheduler/claim-spec';
import { readClaimSpecDelta, type ClaimSpecDeltaReading } from '../../scheduler/get-next';
import { previewSpecFilterPartition } from '../../scheduler/spec-predicate-partition';
import { evaluateGoalFenceGuardForIncumbent } from '../../scheduler/spec-pool-preview';
import { specIsIssueFamilyOnly } from './get_next';

/**
 * Resolve the concrete harness used by the delta read. Operator-context `'*'`
 * is a sentinel, not a database harness slug; passing it through would make
 * the issue query return an empty 0/0 reading that looks like a no-op.
 *
 * Prefer a concrete explicit argument, then a concrete stored spec scope, and
 * finally a concrete ambient session scope. Wildcard values are skipped at
 * each layer so stale rows cannot mask a valid scoped session.
 */
export function resolvePreviewHarness(
  explicitHarness: string | undefined,
  storedHarness: string | null | undefined,
  ambientHarness: unknown,
): string | undefined {
  return (
    resolveClaimSpecPotSlug(explicitHarness, storedHarness) ??
    resolveClaimSpecPotSlug(undefined, ambientHarness)
  );
}

/**
 * The prominent warnings a delta earns — pure, so the judgment is unit-testable without a DB
 * (mirrors set_claim_spec's own exported `claimSpecInertWarning` / `claimSpecWakeabilityWarning`).
 *
 * These are the two shapes a leader must not miss in a wall of counts. STARVATION is the one
 * that has actually bitten this fleet: a lane re-steered to 0 is indistinguishable from a
 * drained one, so members go idle beside real work and the leader reads it as "nothing left
 * to do". COLLAPSE is the softer form of the same thing. The third is diagnostic rather than
 * a hazard — when EVERY listed drop is caused by `states`, the author almost certainly hit
 * the issue-family token trap rather than writing the filter they meant.
 */
export function deriveSpecDeltaWarnings(reading: ClaimSpecDeltaReading): string[] {
  const warnings: string[] = [];
  const starves = reading.proposedClaimable === 0 && reading.currentClaimable > 0;
  if (starves) {
    warnings.push(
      `STARVATION: this revision takes the lane from ${reading.currentClaimable} claimable to 0. ` +
        'A starved lane is indistinguishable from a drained one — members go idle beside real work. ' +
        'set_claim_spec will refuse this write without confirmCollapse:true.',
    );
  } else if (reading.currentClaimable > 0 && reading.proposedClaimable < reading.currentClaimable / 4) {
    warnings.push(
      `COLLAPSE: claimable drops ${reading.currentClaimable} → ${reading.proposedClaimable} (losing ${Math.round(
        (1 - reading.proposedClaimable / reading.currentClaimable) * 100,
      )}% of the lane). Confirm the narrowing is intended before writing it.`,
    );
  }
  // Only assertable over the rows we actually listed — a truncated list cannot speak for the
  // rows it did not return, so this stays silent rather than overclaiming.
  if (
    reading.newlyExcluded.length > 0 &&
    !reading.truncated.newlyExcluded &&
    reading.newlyExcluded.every((r) => r.cause === 'states')
  ) {
    warnings.push(
      'Every excluded item is caused by `states`, not by the filter — the classic issue-family trap: ' +
        "bug/change/task rows are status 'open', never 'todo', so a spec carrying the feature-family " +
        'token matches ~nothing while still validating cleanly.',
    );
  }
  return warnings;
}

/**
 * EI-21177555351818650: `readClaimSpecDelta` (like every other claimability read in
 * `scheduler/get-next.ts`) is an ISSUE-FAMILY-ONLY oracle — its candidate subquery is
 * `WHERE wi.item_kind IN ('bug', 'change', 'task')`. `scheduler:get_next` is not: its claim
 * ladder also runs tier 1/2 against the FEATURE-family table (`item_kind = 'feature'`/
 * `'chunk'`), which `readClaimSpecDelta` never queries at all. So whenever a spec's own
 * `kind` filter does not restrict EXCLUSIVELY to issue-family kinds (no kind leaf at all, or
 * one that also admits feature/chunk/…), a feature-family row can be genuinely claimable via
 * `scheduler:get_next` while this preview's `currentClaimable`/`proposedClaimable` reports it
 * as excluded — a FALSE ZERO with no structural way to tell it apart from a genuine one.
 *
 * Reproduced live (EI-21177555351818650): `preview_spec_delta` reported
 * `currentClaimable: 0` / `proposedClaimable: 0` — including for a proposal naming
 * feature-family WI-40469/WI-40491/WI-40500 by id explicitly — and
 * `scheduler:get_next` claimed WI-40469 immediately afterward under the SAME stored spec.
 * No intervening state changed; the two oracles simply cover different populations.
 *
 * True when EITHER side of the delta could reach a feature-family row (i.e. the reading is
 * not exhaustive for that side). False only when BOTH the current and proposed spec restrict
 * exclusively to issue-family kinds, in which case a feature-family row is structurally
 * unreachable under either spec and the 0/exclusion is genuine.
 */
export function deltaFamilyScopeIncomplete(currentSpec: unknown, proposedSpec: unknown): boolean {
  return !specIsIssueFamilyOnly(currentSpec) || !specIsIssueFamilyOnly(proposedSpec);
}

/** The loud caveat `deltaFamilyScopeIncomplete` gates — prepended to `warnings` so it is the
 *  first thing a reader sees, mirroring `buildMissDiagnosis`'s `familyScopeNote` for
 *  `scheduler:get_next`'s own miss diagnosis (the sibling fix for the same blind spot). */
export const FAMILY_SCOPE_BLIND_SPOT_WARNING =
  'FAMILY SCOPE: this preview evaluates ONLY the issue-family (bug/change/task) claim path — it never ' +
  'queries feature-family rows (kind:"feature"/"chunk") at all, while scheduler:get_next claims from BOTH. ' +
  "Neither the current nor the proposed spec's own kind filter restricts EXCLUSIVELY to issue-family kinds, " +
  'so a feature-family item can be genuinely claimable via scheduler:get_next RIGHT NOW even though this ' +
  'preview reports it excluded or reports currentClaimable/proposedClaimable as 0. Do NOT read a low or ' +
  'zero count here as proof nothing is claimable, and do NOT let it suppress a fleet launch — verify with ' +
  'scheduler:get_next (or work_items:get on the specific id) before trusting this reading for feature-family work.';

/**
 * Render the human-facing summary from the exact count fields, while refusing to turn an
 * internally inconsistent reading into a reassuring "NO CHANGE". The row lists are deliberately
 * capped, so a short list is expected when its side is marked truncated; an uncapped list whose
 * length disagrees with its exact count is an enumeration failure and must be named as such.
 */
export function deriveSpecDeltaNote(reading: ClaimSpecDeltaReading): string {
  const net = reading.proposedClaimable - reading.currentClaimable;
  const countFieldsAgree =
    reading.currentClaimable === reading.retained + reading.newlyExcludedCount &&
    reading.proposedClaimable === reading.retained + reading.newlyAdmittedCount &&
    net === reading.newlyAdmittedCount - reading.newlyExcludedCount;
  const rowListsAgree =
    (reading.truncated.newlyExcluded || reading.newlyExcluded.length === reading.newlyExcludedCount) &&
    (reading.truncated.newlyAdmitted || reading.newlyAdmitted.length === reading.newlyAdmittedCount);
  const signedNet = net > 0 ? `+${net}` : String(net);

  let summary: string;
  if (!countFieldsAgree || !rowListsAgree) {
    summary =
      `INCONSISTENT DELTA: exact counts report ${reading.currentClaimable} → ${reading.proposedClaimable} ` +
      `claimable (net ${signedNet}), ${reading.newlyExcludedCount} item(s) DROPPED and ` +
      `${reading.newlyAdmittedCount} PICKED UP, but the row lists enumerate ${reading.newlyExcluded.length} ` +
      `dropped and ${reading.newlyAdmitted.length} picked-up item(s)` +
      (reading.truncated.newlyExcluded || reading.truncated.newlyAdmitted ? ' (one or both lists are truncated)' : '') +
      '. Treat this reading as a change, not a no-op; the changed item(s) could not be fully enumerated. ';
  } else if (net === 0 && reading.newlyExcludedCount === 0 && reading.newlyAdmittedCount === 0) {
    summary =
      reading.currentClaimable === 0 && reading.proposedClaimable === 0
        ? 'UNDETERMINED: both specs admit zero currently claimable items; this empty snapshot cannot establish equivalence for future work. '
        : 'NO CHANGE: the proposed spec admits exactly the same items as the current one. ';
  } else {
    summary =
      `${reading.newlyExcludedCount} item(s) would be DROPPED, ${reading.newlyAdmittedCount} PICKED UP ` +
      `(net ${signedNet}). `;
  }

  return (
    summary +
    'Counts are exact; the row lists are capped by `limit` (see `truncated`). Both sides were read ' +
    'in ONE snapshot, so nothing here is an artifact of a peer claiming mid-read. READ-ONLY — write ' +
    'it with scheduler:set_claim_spec.'
  );
}

export default defineTool({
  name: 'scheduler:preview_spec_delta',
  profile: 'engineer',
  description:
    'Preview a claim-spec re-steer BEFORE writing it: which ITEMS the proposed revision would newly EXCLUDE from the lane and newly ADMIT, not just how many. READ-ONLY — nothing is stored. Returns exact counts (currentClaimable / proposedClaimable / retained) plus both row lists, each ordered the way its own spec would hand work out, and a per-row `cause`: "filter" (the view.filter disagrees) or "states" (the claimable-status floor changed). Both sides are read in ONE snapshot, so a peer claiming an item mid-read can never be misreported as a loss your change caused. ⚠ ISSUE-FAMILY ONLY — never sees feature-family rows, unlike scheduler:get_next. `familyScopeIncomplete:true` + a leading warning mean a count here can be a FALSE ZERO for feature-family work — verify with scheduler:get_next before trusting a low/zero reading.',
  guidance: {
    when:
      'Before scheduler:set_claim_spec on a live cup/fleet — especially a NARROWING revision, a `not:`/glob exclusion, or any `states` change. Also to explain a starved lane: preview the CURRENT spec against a wider candidate to see what it is holding back.',
    notWhen:
      'Writing the spec — scheduler:set_claim_spec. Reading the stored spec — scheduler:get_claim_spec. Today\'s claimable count/breakdown for ONE spec — work_items:claimable.',
    chaining:
      'scheduler:get_claim_spec (current) → scheduler:preview_spec_delta (what the revision costs) → scheduler:set_claim_spec (write it).',
    seeAlso: [
      // EI-20185841251188914 — see the same note on scheduler:get_claim_spec. In seeAlso
      // rather than when/notWhen/chaining because seeAlso is outside the prompt-weight
      // budget; pinned by scope-args-contract.test.ts.
      'scheduler:set_claim_spec (write/re-steer — same spec grammar, documented on its `spec` arg; SCOPE ARGS DIFFER: it has NO workspace, and scheduler:get_claim_spec has NO harness — this tool is the superset that accepts both, so a scope key valid here is not automatically valid there)',
      'scheduler:get_claim_spec (read the stored spec — takes workspace, rejects harness)',
      'work_items:claimable (single-spec claimable count + per-floor exclusion breakdown)',
    ],
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      cupId: z
        .string()
        .min(1)
        .optional()
        .describe('the cup whose CURRENT spec is the baseline (bee → fleet → default inheritance) — exactly one of cupId | fleet'),
      fleet: z
        .string()
        .min(1)
        .optional()
        .describe("a fleet slug — baselines against that fleet's own sentinel spec"),
      proposed: claimSpecSchema.describe(
        'the candidate spec, same grammar and validation as scheduler:set_claim_spec\'s `spec` arg — all required fields are exposed here so a read-only preview can be formed without a trial-and-error write.',
      ),
      harness: z
        .string()
        .min(1)
        .optional()
        .describe('lane to evaluate against (default: the stored spec row\'s harness, else your session harness)'),
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .describe('max rows listed PER SIDE (default 25, cap 200) — the counts are always exact'),
      workspace: z.string().max(120).optional().describe('override the workspace partition (default: from your identity)'),
    })
    .refine((a) => Boolean(a.cupId) !== Boolean(a.fleet), {
      message: 'pass exactly ONE of cupId (one cup, with fleet inheritance) or fleet (the fleet sentinel spec)',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const workspaceId = resolveClaimSpecWorkspace(args.workspace ?? ident.workspaceId);

    // Validate FIRST: a malformed proposal must fail the same way set_claim_spec would fail
    // it, before we spend a full claimability pass on it.
    const validated = validateClaimSpec(args.proposed);
    if (!validated.ok || !validated.spec) {
      return {
        data: {
          ok: false as const,
          error: 'proposed spec is invalid — set_claim_spec would reject it too; nothing was previewed',
          issues: validated.errors,
        },
      };
    }
    const proposedSpec = validated.spec;

    const targetBeeId = args.fleet ? fleetSpecBeeKey(args.fleet.trim()) : (args.cupId as string);
    const record = await getClaimSpecRecord({ cupId: targetBeeId, workspaceId });

    // The lane. A delta is meaningless without one, and guessing a default harness here would
    // silently preview against the wrong backlog — so this refuses instead.
    const harness = resolvePreviewHarness(
      args.harness,
      record.harnessSlug,
      (ctx as { harnessSlug?: string | null }).harnessSlug,
    );
    if (!harness) {
      return {
        data: {
          ok: false as const,
          error:
            'no harness to evaluate against — the stored spec row carries none and this session is not harness-scoped. Pass `harness` explicitly rather than previewing against a guessed lane.',
        },
      };
    }

    // The caller identity feeds the release-cooldown + reserved-plan-lane floors exactly as
    // the real claim path resolves them — identical on both sides, so it can never itself
    // manufacture a delta.
    const reading = await readClaimSpecDelta(
      { filter: record.spec.view.filter, states: record.spec.states, spec: record.spec },
      { filter: proposedSpec.view.filter, states: proposedSpec.states, spec: proposedSpec },
      { harness, workspaceId, assignee: ident.ownerId },
      { limit: args.limit ?? 25 },
    );

    const net = reading.proposedClaimable - reading.currentClaimable;
    const warnings = deriveSpecDeltaWarnings(reading);
    // EI-21177555351818650: `readClaimSpecDelta` is issue-family-only and structurally
    // cannot see a feature-family row — prepend the caveat so it is the FIRST thing a
    // reader sees, before any narrowing/starvation judgment computed from the (possibly
    // false-zero) counts above.
    const familyScopeIncomplete = deltaFamilyScopeIncomplete(record.spec, proposedSpec);
    if (familyScopeIncomplete) warnings.unshift(FAMILY_SCOPE_BLIND_SPOT_WARNING);

    // WI-10005785: the write door refuses (or discloses) a revision by the goal-fence guard, and a
    // preview that never ran it showed clean counts for a revision set_claim_spec then REFUSED.
    // Run the SAME shared helper, with confirm:false — a preview reports what the write would do
    // before the caller acknowledges anything, so a refusal here reads exactly as it will there.
    const goalFence = evaluateGoalFenceGuardForIncumbent({
      incumbent: record,
      candidateFilter: proposedSpec.view.filter,
      confirm: false,
    });
    if (goalFence.refuse) {
      warnings.unshift(`GOAL FENCE: set_claim_spec would REFUSE this revision. ${goalFence.errors.join(' ')}`);
    } else if (goalFence.warning) {
      warnings.push(`GOAL FENCE: ${goalFence.warning}`);
    }

    // EI-23760081161304754 (plan dry-run-for-claims…, P-005): the counts above are COUNTS, and a
    // count cannot show the rows a nullable field leaves UNKNOWN under the proposed filter — they
    // fall out of every predicate AND out of `proposedClaimable` while the number stays
    // well-formed (EI-13306: 2341 → 4). The shared predicate-partition primitive can, so run it
    // over the PROPOSED spec. Advisory + fail-open: it never changes a count, and a probe or build
    // failure is named, not swallowed into a reading that looks like "nothing fell through".
    let predicatePartition: string | null = null;
    let predicatePartitionError: string | undefined;
    if (!workspaceId) {
      // The floors are scoped by workspace; an unresolved one would render `workspace_id = NULL`,
      // which matches nothing and reads as a clean "no row fell through". Name the skip instead.
      predicatePartitionError = 'no workspace resolved — the predicate partition was not run';
    } else {
      try {
        predicatePartition = await previewSpecFilterPartition(proposedSpec, { workspaceId, harness });
      } catch (error) {
        predicatePartitionError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      data: {
        ok: true as const,
        harness,
        target: args.fleet ? { fleet: args.fleet } : { cupId: args.cupId },
        current: {
          specId: record.spec.specId,
          revision: record.revision,
          /** Which row answered: 'cup' (per-bee override), 'fleet' (inherited), 'default'
           *  (neither exists — the baseline is DEFAULT_CLAIM_SPEC, i.e. the WHOLE lane). */
          source: record.source,
          ...(record.fleetSlug ? { fleetSlug: record.fleetSlug } : {}),
          states: record.spec.states ?? null,
        },
        proposed: { specId: proposedSpec.specId, revision: proposedSpec.revision, states: proposedSpec.states ?? null },
        counts: {
          currentClaimable: reading.currentClaimable,
          proposedClaimable: reading.proposedClaimable,
          retained: reading.retained,
          newlyExcluded: reading.newlyExcludedCount,
          newlyAdmitted: reading.newlyAdmittedCount,
          net,
        },
        newlyExcluded: reading.newlyExcluded,
        newlyAdmitted: reading.newlyAdmitted,
        truncated: reading.truncated,
        // EI-21177555351818650: programmatic sibling of the warning above — true whenever
        // this reading's counts cover only a SUBSET of what scheduler:get_next can claim.
        familyScopeIncomplete,
        /** WI-10005785: true when set_claim_spec would refuse this revision's goal-fence change. */
        goalFenceWouldRefuse: goalFence.refuse,
        ...(predicatePartition ? { predicatePartition } : {}),
        ...(predicatePartitionError ? { predicatePartitionError } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
        note: deriveSpecDeltaNote(reading),
      },
    };
  },
});
