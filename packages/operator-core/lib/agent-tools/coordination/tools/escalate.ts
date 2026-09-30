/**
 * coord:escalate — raise an escalation to the human.
 *
 * The channel that earns the right to interrupt. Use sparingly — only
 * for decisions the agent should not make alone. The UI surfaces open
 * escalations prominently; coord:resolve closes them out.
 *
 * Emits (start-hive-wake-orchestration-2026-06-09 P-001 / D-001): the open
 * escalation also fires a `coord:emit` lifecycle notification to the plan's
 * watchers (the openEscalation record itself is addressed `to: ['human']`
 * only, so this is additive, not a duplicate). The Queen's default wake
 * subscription rides the same tool event (lib/hive/wake-defaults).
 */

import { stat as statFile } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { armEscalationRequesterInterest, openEscalation } from '../escalations';
import { EVIDENCE_BANDS } from '../relay-provenance';
import { COORD_ROLES } from '../roles';
import { softText, clampText, LIMITS } from '../../limits';
import { isAgentSessionSender } from '../machine-authored';
import { fetchHolderGoalRecord } from '../agent-goal-sources';
import {
  comparePredicate,
  dispatchReadOnlyTool,
  PREDICATE_OPS,
  valueAtPath,
  type PredicateOp,
} from '../../../events/await/predicate-watch';
import {
  GOAL_OWNER_REPORT_FIELD,
  parseGoalOwnerReport,
  stampGoalOwnerReport,
  type GoalOwnerReportStamp,
} from '../../../goal-owner-report';

const SEVERITY = ['blocker', 'question', 'advisory'] as const;

/**
 * A durable, read-only condition attached to an escalation.
 *
 * `conditionKey` remains the stable recurrence identity. This is the optional
 * machine-checkable meaning of that key: the same predicate can be re-run before
 * the SLA reroute decides whether the human ask still needs a live driver.
 *
 * The shape intentionally reuses predicate-watch's tool/path/operator contract
 * rather than inventing a second condition language. The tool is dispatched
 * under the original sender's role, so a later access or resolver failure is
 * UNKNOWN, never a false contradiction or a false all-clear.
 */
export interface EscalationPredicate {
  tool: string;
  args?: Record<string, unknown>;
  path: string;
  op: PredicateOp;
  value?: unknown;
}

export type NormalizedEscalationPredicate = EscalationPredicate & {
  args: Record<string, unknown>;
};

export type EscalationPredicateValidationStatus = 'satisfied' | 'contradicted' | 'unknown';

export interface EscalationPredicateValidation {
  status: EscalationPredicateValidationStatus;
  checkedAt: string;
  reason?: string;
}

export type EscalationArtifactValidationStatus = 'present' | 'absent' | 'unknown' | 'not-path';

export interface EscalationArtifactValidation {
  status: EscalationArtifactValidationStatus;
  ref: string;
  path?: string;
  checkedAt: string;
  reason?: string;
}

const escalationPredicateSchema = z.object({
  tool: z.string().min(1).max(200),
  args: z.record(z.string(), z.unknown()).optional(),
  path: z.string().min(1).max(300),
  op: z.enum(PREDICATE_OPS),
  value: z.unknown().optional(),
});

/** Normalize the persisted predicate so every recheck has an explicit args bag. */
export function normalizeEscalationPredicate(input: EscalationPredicate): NormalizedEscalationPredicate {
  return { ...input, args: input.args ?? {} };
}

/** Defensive parser for the flat JSON metadata on an escalation envelope. */
export function parseEscalationPredicate(raw: unknown): EscalationPredicate | null {
  const parsed = escalationPredicateSchema.safeParse(raw);
  return parsed.success ? normalizeEscalationPredicate(parsed.data as EscalationPredicate) : null;
}

/**
 * Extract a local path from an evidence ref when the ref actually names one.
 *
 * Evidence refs are deliberately broader than paths (`tool-output`, msg ids,
 * work-item refs, and prose are all valid). Only path-shaped refs are checked.
 * A URL or URI is not silently interpreted as a local file; it is reported as
 * `not-path` instead.
 */
export function artifactPathFromEvidenceRef(ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) return null;

  let candidate = trimmed.replace(/#L?\d+(?:-L?\d+)?$/, '');
  const line = candidate.match(/^(.*):\d+(?:-\d+)?$/);
  if (line) candidate = line[1];
  candidate = candidate.trim();
  if (!candidate) return null;

  const looksLikePath =
    isAbsolute(candidate) ||
    candidate.startsWith('./') ||
    candidate.startsWith('../') ||
    candidate.includes('/') ||
    /\.[A-Za-z0-9_-]+$/.test(candidate);
  return looksLikePath ? candidate : null;
}

/**
 * Verify a cited evidence ref at the point an escalation is raised and again
 * before an SLA reroute. Missing paths are a known absence; permission and
 * other resolver failures are UNKNOWN. Neither result blocks the human ask at
 * raise time, but callers must not render an absent/unknown path as evidence.
 */
export async function validateEscalationArtifactRef(
  ref: string,
  opts: {
    statFn?: (path: string) => Promise<unknown>;
    cwd?: string;
    nowMs?: () => number;
  } = {},
): Promise<EscalationArtifactValidation> {
  const checkedAt = new Date((opts.nowMs ?? Date.now)()).toISOString();
  const path = artifactPathFromEvidenceRef(ref);
  if (!path) return { status: 'not-path', ref, checkedAt };

  const absolutePath = isAbsolute(path) ? path : resolvePath(opts.cwd ?? process.cwd(), path);
  try {
    await (opts.statFn ?? statFile)(absolutePath);
    return { status: 'present', ref, path: absolutePath, checkedAt };
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : null;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { status: 'absent', ref, path: absolutePath, checkedAt };
    }
    return {
      status: 'unknown',
      ref,
      path: absolutePath,
      checkedAt,
      reason: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    };
  }
}

export interface EscalationPredicateValidationContext {
  workspaceId?: string | null;
  harnessSlug?: string | null;
  role?: string | null;
  onBehalfOf: string;
  spawnId?: string;
}

/**
 * Re-run one escalation predicate under the original sender's read authority.
 *
 * A missing workspace/role, an unreadable tool, an absent path, or the
 * baseline-relative `changed` operator all resolve to UNKNOWN. Only a present
 * observation that evaluates false is a contradiction; the caller can therefore
 * safely suppress an automatic reroute without ever self-closing the escalation.
 */
export async function revalidateEscalationPredicate(
  predicateInput: EscalationPredicate,
  context: EscalationPredicateValidationContext,
  opts: {
    dispatchFn?: typeof dispatchReadOnlyTool;
    nowMs?: () => number;
  } = {},
): Promise<EscalationPredicateValidation> {
  const checkedAt = new Date((opts.nowMs ?? Date.now)()).toISOString();
  const predicate = normalizeEscalationPredicate(predicateInput);
  const workspaceId = context.workspaceId?.trim();
  const role = context.role?.trim();
  if (!workspaceId) {
    return { status: 'unknown', checkedAt, reason: 'workspace scope unavailable for predicate revalidation' };
  }
  if (!role) {
    return { status: 'unknown', checkedAt, reason: 'sender role unavailable for predicate revalidation' };
  }
  if (predicate.op === 'changed') {
    return { status: 'unknown', checkedAt, reason: 'changed predicates require a prior polling baseline' };
  }

  try {
    const payload = await (opts.dispatchFn ?? dispatchReadOnlyTool)(predicate.tool, predicate.args, {
      workspaceId,
      harnessSlug: context.harnessSlug ?? null,
      role,
      onBehalfOf: context.onBehalfOf,
      spawnId: context.spawnId ?? 'coord-escalate-validation',
    });
    const observed = valueAtPath(payload, predicate.path);
    // `exists` deliberately answers the absence question, so a missing path is
    // a known contradiction there. For every other operator, an absent path is
    // unknown; `eq:null` is the explicit exception for asking about UNKNOWN.
    if (
      predicate.op !== 'exists' &&
      (observed === undefined || (observed === null && !(predicate.op === 'eq' && predicate.value === null)))
    ) {
      return {
        status: 'unknown',
        checkedAt,
        reason: `predicate path "${predicate.path}" produced no readable value`,
      };
    }
    return {
      status: comparePredicate(observed, predicate.op, predicate.value)
        ? 'satisfied'
        : 'contradicted',
      checkedAt,
    };
  } catch (error) {
    return {
      status: 'unknown',
      checkedAt,
      reason: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    };
  }
}

export default defineTool({
  name: 'coord:escalate',
  description:
    'Raise an escalation to the human. Provide severity (blocker | question | advisory), a one-line summary, and optionally a body and a small list of choice options to make resolution one click.',
  guidance: {
    when: 'A decision you should not make alone, a blocker that requires human input, or a risky operation that needs explicit confirmation.',
    notWhen: 'Routine status updates — use coord:send. File contention — locks:queue already names the holder.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  // The launch-fixer roles (merge-resolver / release-fixer / content-fixer) each
  // declare coord:escalate in their blueprint deps as their "can't safely fix → hand
  // to a human" escape hatch, but none are in COORD_ROLES — so a spawned fixer's
  // escalate hit role_not_allowed (a declared-but-ungated dependency). Granted HERE
  // only (least-privilege: just escalate, not the whole coord:* surface). The fixers'
  // primary human-surfacing is still their system routine's own escalation; this
  // makes the agent's richer per-file escalation actually fire. (git-sync-content-guard
  // D-008; fixes the inherited merge-resolver/release-fixer gap in the same edit.)
  agentRoles: [...COORD_ROLES, 'merge-resolver', 'release-fixer', 'content-fixer'],
  // Demand surfaces as an EVENT (start-hive-wake P-001 / D-001). The escalation
  // record goes to the human; this lifecycle emit reaches the plan's watchers
  // ([] when plan-less ⇒ recorded, delivered to no inbox — audit without noise).
  emits: [
    {
      fire: 'coord:emit',
      when: (e) => Boolean((e.result?.data as { ok?: boolean } | undefined)?.ok),
      render: (e) => {
        const a = e.args as { severity?: string; summary?: string; plan_slug?: string };
        return {
          category: 'escalation',
          summary: `escalation (${a.severity ?? '?'}): ${a.summary ?? ''}`,
          ...(a.plan_slug ? { plan_slug: a.plan_slug, to: [`@plan:${a.plan_slug}`] } : { to: [] }),
        };
      },
    },
  ],
  args: z.object({
    severity: z.enum(SEVERITY),
    summary: softText(LIMITS.ANNOTATION, { min: 1 }).describe(
      'One-line summary of the escalation — auto-truncated to 2000 chars if longer.',
    ),
    body: z.string().optional(),
    plan_slug: z.string().optional(),
    conditionKey: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        'Stable identifier for a RECURRING condition (e.g. "mug-placement-stall", "work-feed-dead"). Re-escalating the same conditionKey COALESCES onto the existing open row (bumps its repeatCount) instead of opening a new one; the response reports coalesced:true and bodyDiscarded:true when the new text is not persisted. Pass it for any watchdog/monitor condition you re-check on a cadence — especially when the summary embeds a live count or duration ("stalled ~7h", "302 items"), because without it the dedup falls back to the prose summary, which never repeats, and every wake leaks a new permanently-open escalation.',
      ),
    predicate: escalationPredicateSchema
      .optional()
      .describe(
        'Optional machine-checkable condition for this escalation. Shape: { tool, args?, path, op, value? }, using the same read-only predicate contract as watch:create. It is checked now and re-checked before any SLA reroute; unreadable or missing state is stamped unknown and never treated as a contradiction.',
      ),
    options: z
      .array(z.object({ id: z.string().min(1), label: z.string().min(1) }))
      .optional()
      .describe('Optional named choices the human can pick from. Omit for free-form.'),
    evidence: z
      .object({
        band: z.enum(EVIDENCE_BANDS),
        reportedBy: z.string().min(1).optional(),
        ref: z.string().min(1).max(200).optional(),
      })
      .optional()
      .describe(
        'How this escalation is GROUNDED: observed (you saw it) | tool-output (a tool result backs it; pass `ref`) | reported-by (a peer told you; `reportedBy` REQUIRED) | inferred (reasoned, not witnessed) | assumed (working assumption). Confidence is DERIVED from the band and rendered for the reader — never pass a number, it is discarded and flagged.',
      ),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    // Record the escalating agent's harness (pipeline roles carry it) so the
    // human inbox can open a chat scoped to it. '*'/empty = operator/SU/oracle
    // wildcard ⇒ workspace-level escalation; leave harness unset there.
    const ctxHarness = (ctx as { harnessSlug?: unknown }).harnessSlug;
    const harnessSlug =
      typeof ctxHarness === 'string' && ctxHarness && ctxHarness !== '*' ? ctxHarness : undefined;
    // P-006 / A-05: coord:escalate is always owner-facing, so a body using any
    // GOAL report heading is an attempted report operation. Resolve the CURRENT
    // subject server-side at the write boundary; callers cannot stamp or choose
    // a goal id. An ordinary escalation has no such heading and pays no mode
    // read. If the read itself is unavailable, preserve the escalation as a
    // diagnostic/remediation rail but make the missing evidence explicit.
    let goalOwnerReport: GoalOwnerReportStamp | null = null;
    let goalOwnerReportWarning: string | null = null;
    const parsedGoalOwnerReport = parseGoalOwnerReport(args.body);
    if (parsedGoalOwnerReport.attempted) {
      const reportWorkspaceId =
        identity.workspaceId ??
        (typeof (ctx as { workspaceId?: unknown }).workspaceId === 'string'
          ? (ctx as { workspaceId: string }).workspaceId
          : null);
      let goalId: string | null = null;
      if (!reportWorkspaceId || reportWorkspaceId === '*') {
        goalOwnerReportWarning =
          'GOAL owner-report validation was unavailable because this sender has no concrete workspace; the escalation was delivered but does not carry canonical report evidence.';
      } else {
        try {
          const { getModeSubject } = await import('../../../modes/store');
          goalId = await getModeSubject(reportWorkspaceId, identity.ownerId, 'goal');
        } catch (error) {
          goalOwnerReportWarning =
            'GOAL owner-report validation was unavailable at escalation time; the escalation was delivered without canonical report evidence. ' +
            `Retry after the active GOAL subject is readable (${error instanceof Error ? error.message : String(error)}).`;
        }
      }
      if (goalId) {
        if (!parsedGoalOwnerReport.complete) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  error: 'goal-owner-report-incomplete',
                  goalId,
                  missing: parsedGoalOwnerReport.missing,
                  empty: parsedGoalOwnerReport.empty,
                  duplicate: parsedGoalOwnerReport.duplicate,
                  message:
                    `GOAL owner report for ${goalId} is incomplete; nothing was escalated. ` +
                    'Provide exactly one non-empty section headed MOVED, COST, OWNER-WALLED, and KILLED. ' +
                    'Use explicit `none` or `unknown (<source/provenance>)` when that is the factual value.',
                }),
              },
            ],
            isError: true,
          };
        }
        goalOwnerReport = stampGoalOwnerReport(goalId, parsedGoalOwnerReport);
      }
    }
    // A caller-supplied conditionKey becomes the dedup subjectSignature, so the SAME
    // recurring condition coalesces onto one open row across firings. Without it the
    // signature is derived from the prose summary — and a watchdog whose summary carries
    // a live count/duration never produces the same signature twice, so every re-check
    // leaked a NEW permanently-open escalation (162 of papercusp's 193 open rows were
    // this: the kettle re-filing "Mug stalled ~7h" → "~10h" → "~16h" once per wake).
    // Same flood class as EI-1490 (placement-watchdog) and EI-6789 (steering-lease),
    // whose senders were excluded wholesale; a stable key fixes it at the source instead,
    // keeping a genuinely-live condition visible (and countable) as exactly one row.
    // owner-inbox-single-pane D-015: attach the authoritative goal the agent is
    // actually holding, rather than asking every caller to remember another
    // correlation argument. The shared state-plane resolver already reconciles
    // work-item, plan-item, fleet and explicit-override legs. Only an unambiguous
    // WI-/EI-/F- or <plan>#P-NNN goal is lifecycle-linkable; a divergent/fleet/
    // unknown goal stays unlinked and therefore can never be auto-resolved.
    let goalRef: string | null = null;
    if (isAgentSessionSender(identity.ownerId)) {
      const goal = await fetchHolderGoalRecord(identity.ownerId).catch(() => null);
      const candidate = goal?.itemId?.trim() ?? '';
      if (
        goal &&
        goal.agreement !== 'divergent' &&
        // `competing` is `readonly string[] | null` and documented "Absent ⇒ []"
        // (holder-context.ts D-093/D-092), so a missing leg means NO competing
        // claims — not an unknown one. Optional-chain rather than assert.
        (goal.competing?.length ?? 0) === 0 &&
        (/^(?:WI|EI|F)-\d+$/i.test(candidate) || /#P-\d+$/i.test(candidate))
      ) {
        goalRef = candidate;
      }
    }
    const predicate = args.predicate
      ? normalizeEscalationPredicate(args.predicate as EscalationPredicate)
      : undefined;
    const validationHarness =
      typeof ctxHarness === 'string' && ctxHarness && ctxHarness !== '*' ? ctxHarness : null;
    const validationWorkspace =
      identity.workspaceId ??
      (typeof (ctx as { workspaceId?: unknown }).workspaceId === 'string'
        ? (ctx as { workspaceId: string }).workspaceId
        : null);
    const validationRole =
      typeof (ctx as { role?: unknown }).role === 'string' ? (ctx as { role: string }).role : null;
    const [predicateValidation, evidenceValidation] = await Promise.all([
      predicate
        ? revalidateEscalationPredicate(predicate, {
            workspaceId: validationWorkspace,
            harnessSlug: validationHarness,
            role: validationRole,
            onBehalfOf: identity.ownerId,
          })
        : Promise.resolve(undefined),
      args.evidence?.ref
        ? validateEscalationArtifactRef(args.evidence.ref)
        : Promise.resolve(undefined),
    ]);
    const meta = {
      ...(harnessSlug ? { harnessSlug } : {}),
      ...(args.conditionKey ? { subjectSignature: args.conditionKey.trim() } : {}),
      ...(goalRef ? { goalRef } : {}),
      ...(predicate
        ? {
            escalationPredicate: predicate,
            ...(validationRole ? { escalationPredicateRole: validationRole } : {}),
          }
        : {}),
      ...(predicateValidation ? { predicateValidation } : {}),
      ...(evidenceValidation ? { evidenceValidation } : {}),
      ...(goalOwnerReport ? { [GOAL_OWNER_REPORT_FIELD]: goalOwnerReport } : {}),
      ...(goalOwnerReportWarning
        ? { goalOwnerReportValidation: { status: 'unknown', reason: goalOwnerReportWarning } }
        : {}),
    };
    const rec = await openEscalation(identity, {
      severity: args.severity,
      summary: clampText(args.summary, LIMITS.ANNOTATION),
      body: args.body,
      plan_slug: args.plan_slug,
      options: args.options,
      // P-010: a `reported-by` band with no attribution is rejected at READ time
      // (an unattributed relay is the provenance collapse the band exists to
      // stop), so drop it here rather than persist a stamp that will never read
      // back. DESCRIPTIVE only (D-015) — it never affects what the runtime does.
      ...(args.evidence && (args.evidence.band !== 'reported-by' || args.evidence.reportedBy)
        ? { evidence: args.evidence }
        : {}),
      // harnessSlug (a concrete harness, never '*') does double duty: meta.harnessSlug
      // scopes the human-inbox chat (existing), and harness_slug FEDERATES the record
      // so a peer-machine harness-scoped escalation reaches the hub where the human's
      // inbox lives (WI-1375; mirrors messages.ts + coord:handoff). Operator/SU
      // ('*'/unset) escalations stay workspace-local.
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
      ...(harnessSlug ? { harness_slug: harnessSlug } : {}),
    });
    const interestWatch = await armEscalationRequesterInterest(identity.ownerId, rec.msg_id);
    const coalesced = rec.coalesced === true;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ...(coalesced
              ? {
                  notice: "COALESCED: existing escalation retained; this call's summary/body/options were discarded.",
                  coalesced: true,
                  existingMsgId: rec.existingMsgId ?? rec.msg_id,
                  bodyDiscarded: rec.bodyDiscarded ?? true,
                }
              : {}),
            ok: true,
            msg_id: rec.msg_id,
            ts: rec.ts,
            interest_watch: interestWatch,
            ...(predicateValidation ? { predicate_validation: predicateValidation } : {}),
            ...(evidenceValidation ? { evidence_validation: evidenceValidation } : {}),
            ...(goalOwnerReport ? { goal_owner_report: { status: 'stamped', goalId: goalOwnerReport.goalId } } : {}),
            ...(goalOwnerReportWarning ? { goal_owner_report_warning: goalOwnerReportWarning } : {}),
          }),
        },
      ],
    };
  },
});
