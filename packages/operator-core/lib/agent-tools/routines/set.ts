/**
 * routines:set — retune or pause/resume a scheduled system routine (live-configurability-audit
 * P-002). The safe, audited replacement for the raw `UPDATE harness_shared.routines` the playbook
 * forbids: change a routine's cron and/or active flag (active:false = PAUSE, true = RESUME).
 *
 * Wrapped in the gateway-control harness (dryRun preview, post-apply verify+auto-revert, audit,
 * one-call revert). A bad cron is rejected up front (computeNextFireAt returns null), so a typo
 * can't silently kill a routine. On a cron change, next_fire_at is recomputed.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import { computeNextFireAt } from '../../harness/routines/cron';
import { resolveIntegrationRoot } from '../../harness/routines/release-actions';
import { runControlMutation } from '../../gateway-control/control-harness';
import { readQualificationAdmission } from '../../release-checkpoint-config';
import { checkActiveCheckpointRunAsync } from '../../release-checkpoint-launch';
import { readCheckpointSerializerAuthority } from '../../release/checkpoint-serializer-authority';
import { readGateOwnership, shouldStandDownForLivePeer } from '../../coord/gate-ownership';
import { resolveAgentIdentity, type ResolveIdentityCtx } from '../coordination/identity';
import {
  isRoutineTargetMissingError,
  readRoutineSnap,
  resolveRoutineSnap,
  writeRoutineSnap,
  stableJson,
  type RoutineSnap,
} from './routine-snapshot';
import { DEFAULT_RELEASE_PAUSE_TTL_HOURS, resolvePauseExpiryMs } from '../../harness/routines/release-pause-ttl';

/**
 * Best-effort caller ownerId for the pause-attribution stamp. A ctx-supplied
 * ownerId wins (some in-process callers thread it directly); otherwise derive
 * it (grade-idea's D-012 pattern — resolveAgentIdentity THROWS on an
 * unattributable ctx, and an attribution miss must degrade to the role string,
 * never block the pause).
 */
export function pausedByFrom(ctx: unknown, role: string | undefined): string {
  const explicit = (ctx as { ownerId?: unknown } | undefined)?.ownerId;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  try {
    return resolveAgentIdentity((ctx ?? {}) as ResolveIdentityCtx).ownerId;
  } catch {
    return `role:${role}`;
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Recursively merge a config patch into a routine's payload_template.
 *
 * DEEP, not shallow (WI-4482): a routine payload is NESTED
 * (`payload.budget.maxIdeators`, `payload.models.ideator`, `payload.cadence.*`), so a
 * shallow `Object.assign` of `{ payload: { budget: {...} } }` would REPLACE the whole
 * `payload` object and silently drop `models` / `cadence` — turning a one-key retune into
 * a config wipe. Plain objects merge; arrays and scalars REPLACE wholesale (an array patch
 * means "this is the new list", never an element-wise merge).
 */
function deepMergePlain(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMergePlain(cur, v) : v;
  }
  return out;
}

type TriggerConfigPatchArgs = {
  cron?: string;
  triggerConfig?: Record<string, unknown>;
};

/** Merge the validated cron argument and trigger_config patch into a routine snapshot. */
function mergeTriggerConfig(prev: RoutineSnap, args: TriggerConfigPatchArgs): Record<string, unknown> {
  const triggerConfig = { ...prev.triggerConfig };
  if (args.cron !== undefined) {
    triggerConfig.cron = args.cron;
  }
  if (args.triggerConfig !== undefined) {
    // `cron` is only accepted through the validated top-level argument.
    const { cron: _ignoredCron, ...patch } = args.triggerConfig;
    Object.assign(triggerConfig, patch);
  }
  return triggerConfig;
}

/**
 * A resume is a control-plane write, even when the caller asks for a dry-run. The
 * scheduled green-checkpoint path has two durable fences that a peer must not clear:
 * qualification admission and the exact serializer hold. Check the live run before
 * allowing the routine mutation too, otherwise a peer can replace an in-flight run.
 *
 * Keep this deliberately narrow: only the operator-home green-checkpoint resume is
 * serializer-owned. Other routines, installs, and active:false pauses retain the
 * generic routines:set behavior.
 */
async function assertGreenCheckpointResumeAdmission(
  slug: string,
  name: string,
  callerOwnerId: string,
): Promise<void> {
  if (name !== 'green-checkpoint' || slug !== operatorHomeHarnessSlug()) return;

  let root: string;
  try {
    root = resolveIntegrationRoot();
  } catch (error) {
    throw new Error(
      `green-checkpoint resume refused: integration root could not be resolved (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const admission = await readQualificationAdmission();
  if (admission.status !== 'clear') {
    throw new Error(
      admission.status === 'held'
        ? `green-checkpoint resume refused: qualification is held by ${admission.hold.governingRef}`
        : `green-checkpoint resume refused: qualification admission is unknown (${admission.reason})`,
    );
  }

  const serializer = await readCheckpointSerializerAuthority({ installSlug: slug });
  if (serializer.status === 'held') {
    throw new Error(
      `green-checkpoint resume refused: serializer hold for ${serializer.itemId} is owned by ${serializer.ownerId}`,
    );
  }
  if (serializer.status === 'unreadable') {
    throw new Error(`green-checkpoint resume refused: serializer authority is unreadable (${serializer.error})`);
  }

  // EI-21526695715087245: the structured D-012/D-016 fence is deliberately a
  // separate, stronger authority, but it is not atomic with every ownership
  // transfer. A consequence-reclaim clears the stale holder's liveness-bound
  // hold_open lease, then a successor's ordinary claim lands before that
  // successor can restore the fence. During that short window the serializer
  // reader correctly reports `none` even though the live gate-red-streak owner
  // is already the only peer allowed to decide the transition.
  //
  // Reuse the gate ownership cell's condition + liveness resolver here rather
  // than inventing another WI-40086 query. Direct routine resume stands down
  // only for a positively-live PEER; the owner itself can still repair/encode
  // the canonical fence, and ambiguous/dead ownership follows the existing
  // recovery path instead of wedging the release indefinitely.
  const gateOwnership = await readGateOwnership({ harness: slug });
  if (gateOwnership.claimState === null) {
    throw new Error(
      `green-checkpoint resume refused: gate ownership is unreadable (${gateOwnership.unknown?.detail ?? 'unknown resolver failure'})`,
    );
  }
  if (shouldStandDownForLivePeer(gateOwnership, callerOwnerId)) {
    throw new Error(
      `green-checkpoint resume refused: live gate owner ${gateOwnership.takenBy} holds ${gateOwnership.workItem ?? gateOwnership.eventKey}`,
    );
  }

  let activeRun: Awaited<ReturnType<typeof checkActiveCheckpointRunAsync>>;
  try {
    // WI-10005268: the async form keeps systemctl/git off the operator main thread.
    activeRun = await checkActiveCheckpointRunAsync(root);
  } catch (error) {
    throw new Error(
      `green-checkpoint resume refused: active-run probe failed (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (activeRun.probe_failed || activeRun.active !== false) {
    throw new Error(
      activeRun.probe_failed
        ? `green-checkpoint resume refused: active-run probe is indeterminate${activeRun.probe_detail ? ` (${activeRun.probe_detail})` : ''}`
        : 'green-checkpoint resume refused: a checkpoint run is already active',
    );
  }
}

export default defineTool({
  name: 'routines:set',
  profile: 'engineer',
  description:
    "Retune or pause/resume a scheduled system routine (git-sync, green-checkpoint, release-trigger, scout, …) without raw SQL: change its cron, its active flag (active:false = PAUSE, active:true = RESUME), its trigger_config, its GROUP (group — metadata only, see routines:group-set / routines:list { rollup:true }), and/or DEEP-merge a patch into its payload_template (the routine's own run knobs — e.g. the scout singleton's payload.budget.maxIdeators). Audited + one-call-revertible via the control harness; an invalid cron is rejected. On a cron change, next_fire_at is recomputed.",
  capability: 'operator:write',
  guidance: {
    when: 'Pause git-sync during a delicate manual operation (active:false), resume it (active:true), retune a routine\'s cadence (cron), patch a routine CONFIG value (triggerConfig — e.g. a sweep\'s caps), assign/clear its group (group — WI-5018 routines grouping), or retune a routine\'s RUN KNOBS (payloadTemplate — e.g. the scout singleton\'s budget.maxIdeators / models.ideator) on a running system — the safe alternative to the raw UPDATE harness_shared.routines the playbook forbids.',
    notWhen: 'For a harness blueprint autoloop, use autoloop:control. To just SEE routines, routines:list. To pause/resume a WHOLE group at once, routines:group-set. (These routine rows are their own store; they do not appear in config:list-overrides.)',
    chaining: 'routines:list first to get the exact name + installSlug; routines:list after to confirm the change.',
    seeAlso: [
      'routines:list (get the exact name + installSlug first)',
      'routines:list (rollup:true — see/manage the group registry)',
      'routines:group-set (bulk pause/resume a whole group)',
      'autoloop:control (a harness blueprint autoloop instead)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 30 } },
  args: z.object({
    name: z.string().min(1).max(200).describe('Routine name, e.g. "git-sync", "green-checkpoint", "release-trigger".'),
    installSlug: z.string().max(120).optional().describe('Install slug owning the routine (default: the operator home harness).'),
    cron: z.string().min(1).max(120).optional().describe('New cron expression (5/6-field). Rejected if invalid.'),
    active: z.boolean().optional().describe('false = pause the routine, true = resume it.'),
    triggerConfig: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Merge these keys into the routine trigger_config (live-configurability-audit P-017 — e.g. the claim-discipline throttle_min, or a reaper dry_run). The safe way to retune a routine CONFIG value without raw SQL. `cron` is ignored here — set it via the validated `cron` arg.'),
    payloadTemplate: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("DEEP-merge this patch into the routine's payload_template — the routine's own run knobs (e.g. the scout singleton's payload.budget.maxIdeators / payload.models.ideator). Nested plain objects merge, so { payload: { budget: { maxIdeators: 4 } } } retunes ONE key without disturbing payload.models or payload.cadence; arrays and scalars replace. Previously the only way to change these was the raw UPDATE harness_shared.routines the playbook forbids (WI-4482)."),
    group: z
      .string()
      .max(120)
      .nullable()
      .optional()
      .describe(
        'Assign this routine to a routine group (WI-5018 — metadata + management ONLY, never fires anything). Pass a slug (e.g. "health") to assign — the group is auto-created in harness_shared.routine_groups with blank metadata if it does not exist yet (fill it in via routines:group-set). Pass null to clear (ungroup).',
      ),
    reason: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe(
        'REQUIRED when pausing (active:false) — why. Persisted durably as metadata.pause { reason, pausedBy, pausedAtMs } (EI-18654017982759582: a routine paused during an incident with no reason/owner recorded has TWICE stayed silently paused for days — 2026-06-18, then ~4 days 2026-07-21→25 — because nothing durable said WHO paused it or WHY, so a responder could not tell a stuck bug from a deliberate hold). Ignored (but harmless) when resuming (active:true) or when active is unset.',
      ),
    reviewBy: z
      .string()
      .datetime()
      .optional()
      .describe(
        'Only meaningful alongside active:false, for an ALWAYS-ON singleton learning loop (change-ledger / scout / iq-battery). An ISO timestamp persisted as metadata.pause.reviewBy — the DARK_FLAGS_REVIEW_BY analog for a deliberate pause (EI-19370236916382521). While it is in the future, the learning-loop-health sweep treats the pause as EXPLICITLY RE-AFFIRMED and stops daily-re-escalating it (`improvements:capture`-ing a fresh EI every 24h) — the "re-affirm it explicitly rather than letting this alarm re-fire silently" remedy that sweep\'s own health read asks for. Pass this whenever you are pausing (or re-pausing to re-affirm) one of those loops on purpose, with a date you intend to actually re-review it by — omitting it on a deliberate pause just means the alarm keeps re-firing until someone either resumes the loop or comes back and sets one.',
      ),
    pauseTtlHours: z
      .number()
      .positive()
      .finite()
      .optional()
      .describe(
        `Only meaningful alongside active:false on a RELEASE-GROUP routine (green-checkpoint, release-trigger, pr-poll). How long this hold may last, in hours — persisted as metadata.pause.expiresAtMs, after which the routines engine AUTO-RESUMES the routine and records a notice. Omit for the ${DEFAULT_RELEASE_PAUSE_TTL_HOURS}h default. A longer TTL is allowed, but a release-group pause is ALWAYS finite: an open-ended hold is exactly what this closes (green-checkpoint sat deliberately paused 99h across 14 windows — 37% of an 11-day red streak — with nothing to end it, and no watchdog message saying it was off rather than failing). Ignored (but harmless) on a non-release-group routine and on the structured D-012/D-013 serializer quiescence hold, which has its own owner-liveness recovery instead of a clock.`,
      ),
    dryRun: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('routines:set requires an operator-config write role (operator, architect, or mug; the isOperatorConfigWriteRole set is operator-equivalent write authority, NOT any su/worker role)');
    }
    if (
      args.cron === undefined &&
      args.active === undefined &&
      args.triggerConfig === undefined &&
      args.payloadTemplate === undefined &&
      args.group === undefined
    ) {
      throw new Error('set requires cron, active, triggerConfig, payloadTemplate, and/or group');
    }
    // Validate the cron BEFORE touching anything — a typo must not silently kill a routine.
    if (args.cron !== undefined && !computeNextFireAt(args.cron, new Date())) {
      throw new Error(`invalid cron expression: ${args.cron}`);
    }
    // EI-18654017982759582: a pause with no recorded reason/owner is how this recurs — require
    // one up front (a typo'd/omitted reason must not silently produce an unattributed freeze,
    // same "validate before touching anything" discipline as the cron check above).
    if (args.active === false && !args.reason) {
      throw new Error(
        'routines:set { active: false } (pausing) requires a `reason` — an unattributed pause is exactly the class of bug this guards against (a routine paused during an incident with no recorded reason/owner has silently stayed off for DAYS, twice). Pass a short reason (e.g. "pausing during manual deploy-checkout surgery").',
      );
    }

    const { sql } = getOrgPg();
    const ws = activeWorkspaceId();
    let slug = args.installSlug ?? operatorHomeHarnessSlug();

    // Guard before runControlMutation itself so dryRun cannot be used to probe or
    // bypass the same serializer-owned resume admission as a real write.
    if (args.active === true) {
      await assertGreenCheckpointResumeAdmission(slug, args.name, pausedByFrom(ctx, ctx.role));
    }

    // Name-only callers historically addressed the operator-home harness. Preserve
    // that exact lookup first, but allow a unique workspace singleton (such as the
    // Scout row under @singleton) when no home row exists. Resolve after the
    // green-checkpoint admission guard so the guard remains the first refusal, then
    // cache the resolved snapshot for the control harness's capture boundary.
    let initialSnap: RoutineSnap | undefined;
    if (args.installSlug === undefined) {
      const resolved = await resolveRoutineSnap(sql, ws, slug, args.name);
      slug = resolved.installSlug;
      initialSnap = resolved.snapshot;
    }

    // A target may disappear after the control harness captures its authoritative
    // snapshot but before apply() takes its second read. That is a benign stale
    // target race, not a retryable mutation failure. Keep this marker separate from
    // the snapshot itself so an initially missing target still fails normally.
    let captureCompleted = false;
    let mutationWriteStarted = false;
    const readSnap = async (): Promise<RoutineSnap> => {
      let snap: RoutineSnap;
      if (initialSnap !== undefined) {
        snap = initialSnap;
        initialSnap = undefined;
      } else {
        snap = await readRoutineSnap(sql, ws, slug, args.name);
      }
      captureCompleted = true;
      return snap;
    };
    const writeSnap = (snap: RoutineSnap): Promise<void> => writeRoutineSnap(sql, ws, slug, args.name, snap);

    // P-004: the stamped release-group pause expiry, captured so the CALLER is told
    // when their hold auto-resumes. A pause whose end date only exists in the DB is
    // the same silence one indirection over — the person taking the hold is the one
    // who needs to know it is finite.
    let stampedPauseExpiryMs: number | null = null;

    let outcome: Awaited<ReturnType<typeof runControlMutation<RoutineSnap>>>;
    try {
      outcome = await runControlMutation<RoutineSnap>(
        {
          action: 'routines:set',
          subject: `${slug}/${args.name}`,
          actor: `role:${ctx.role}`,
          capturePrev: readSnap,
          apply: async () => {
            const prev = await readSnap();
            const triggerConfig = mergeTriggerConfig(prev, args);
            let nextIso = prev.nextFireAtIso;
            if (args.cron !== undefined) {
              const computed = computeNextFireAt(args.cron, new Date());
              nextIso = computed ? computed.toISOString() : null;
            }
            const payloadTemplate =
              args.payloadTemplate !== undefined
                ? deepMergePlain(prev.payloadTemplate, args.payloadTemplate)
                : prev.payloadTemplate;
            // EI-18654017982759582: persist WHO/WHY/WHEN at pause time, and clear it on resume
            // (moved to lastPause for audit history) — so a responder (or a watchdog) never has
            // to reverse-engineer the pause from tool_invocations telemetry. Other metadata keys
            // (e.g. gate_health, written by the green-checkpoint tick / stall watchdogs) are
            // preserved untouched via the spread — only the `pause`/`lastPause` keys are patched.
            const metadata = { ...prev.metadata };
            const nextActive = args.active ?? prev.active;
            if (args.active === false) {
              const pausedAtMs = Date.now();
              // gate-verdict-liveness-and-repair-reliability-2026-08-31 P-004: a
              // RELEASE-GROUP pause is always FINITE. Resolve the group as it will be
              // AFTER this call (a caller may assign the group in the same mutation),
              // then stamp the expiry the routines-engine sweep enforces. Null for a
              // non-release routine and for the D-012/D-013 serializer quiescence hold —
              // see release-pause-ttl.ts's "ONE EXCLUSION".
              const nextGroupSlug = args.group !== undefined ? args.group : prev.groupSlug;
              const expiresAtMs = resolvePauseExpiryMs({
                groupSlug: nextGroupSlug,
                pausedAtMs,
                ttlHours: args.pauseTtlHours ?? null,
                reason: args.reason ?? null,
              });
              stampedPauseExpiryMs = expiresAtMs;
              metadata.pause = {
                reason: args.reason,
                pausedBy: pausedByFrom(ctx, ctx.role),
                pausedAtMs,
                // EI-19370236916382521: omit the key entirely rather than storing `undefined` —
                // a present-but-undefined key would round-trip through JSON.stringify as if it
                // were never set, which is harmless, but an explicit omission keeps the stored
                // shape honest (no `reviewBy` key at all on a plain, non-reaffirmed pause).
                ...(args.reviewBy !== undefined ? { reviewBy: args.reviewBy } : {}),
                // Same omit-don't-store-null discipline: an absent key means "not
                // TTL-governed", which is a different claim from "TTL of null".
                ...(expiresAtMs !== null ? { expiresAtMs } : {}),
              };
            } else if (args.active === true && prev.metadata.pause) {
              metadata.lastPause = { ...(prev.metadata.pause as Record<string, unknown>), resumedAtMs: Date.now() };
              delete metadata.pause;
            }
            const next: RoutineSnap = {
              triggerConfig,
              payloadTemplate,
              active: nextActive,
              nextFireAtIso: nextIso,
              groupSlug: args.group !== undefined ? args.group : prev.groupSlug,
              metadata,
            };
            mutationWriteStarted = true;
            await writeSnap(next);
            return next;
          },
          revertTo: (prev) => writeSnap(prev),
          verify: async (next) => {
            const cur = await readSnap();
            const ok =
              cur.active === next.active &&
              (args.cron === undefined || (cur.triggerConfig as { cron?: string }).cron === args.cron) &&
              (args.group === undefined || cur.groupSlug === next.groupSlug) &&
              // The payload merge must actually be READABLE back, not just written — a silent
              // no-op write here would leave the caller believing a live knob was retuned.
              //
              // Compared via stableJson (order-independent), NOT a raw JSON.stringify: Postgres
              // jsonb does not preserve JS object insertion order on a round-trip (it reorders by
              // key length then lexicographically for its binary encoding), so `next` — an
              // in-memory object with any NEW key appended at the end by deepMergePlain — never
              // string-equals `cur` — the same object freshly read back from jsonb, reordered — even
              // when every key/value pair matches. That false mismatch made every additive
              // payloadTemplate patch (e.g. adding a `model` override) spuriously fail verify and
              // get auto-reverted (EI-22136767702523358). routineSnapEqual below already solves this
              // for a whole RoutineSnap; stableJson is its same order-independent primitive, reused
              // here since this check compares only the payloadTemplate field.
              (args.payloadTemplate === undefined ||
                JSON.stringify(stableJson(cur.payloadTemplate)) === JSON.stringify(stableJson(next.payloadTemplate)));
            return { ok, detail: ok ? undefined : 'routine row did not reflect the change' };
          },
          describe: (prev) => ({
            current: {
              cron: (prev.triggerConfig as { cron?: string }).cron ?? null,
              active: prev.active,
              group: prev.groupSlug,
              // P-017: include the complete current config when a trigger_config patch is
              // requested, so a dry-run can prove the interval/cap values it will change.
              ...(args.triggerConfig !== undefined ? { triggerConfig: prev.triggerConfig } : {}),
              ...(args.payloadTemplate !== undefined ? { payloadTemplate: prev.payloadTemplate } : {}),
            },
            proposed: {
              cron: args.cron ?? ((prev.triggerConfig as { cron?: string }).cron ?? null),
              active: args.active ?? prev.active,
              group: args.group !== undefined ? args.group : prev.groupSlug,
              ...(args.triggerConfig !== undefined
                ? { triggerConfig: mergeTriggerConfig(prev, args) }
                : {}),
              ...(args.payloadTemplate !== undefined
                ? { payloadTemplate: deepMergePlain(prev.payloadTemplate, args.payloadTemplate) }
                : {}),
              // P-004: a dryRun must PREVIEW the auto-resume deadline, not just the flag —
              // `apply` never runs on a preview, so this is the only place it can appear.
              ...(args.active === false
                ? (() => {
                    const at = resolvePauseExpiryMs({
                      groupSlug: args.group !== undefined ? args.group : prev.groupSlug,
                      pausedAtMs: Date.now(),
                      ttlHours: args.pauseTtlHours ?? null,
                      reason: args.reason ?? null,
                    });
                    return { pauseAutoResumesAt: at !== null ? new Date(at).toISOString() : null };
                  })()
                : {}),
            },
          }),
        },
        { dryRun: args.dryRun },
      );
    } catch (error) {
      if (!captureCompleted || mutationWriteStarted || !isRoutineTargetMissingError(error)) throw error;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              routine: `${slug}/${args.name}`,
              error: 'stale_target',
              disposition: 'stale_target',
              retryable: false,
              applied: false,
              message: 'The routine disappeared after its snapshot was captured; no mutation was applied. Refresh routines:list before retrying.',
            }),
          },
        ],
      };
    }

    // Refresh the owner's automation panes (Blender / Docs) the moment a pause or
    // retune commits — they read `automation.catalog`. Skipped on a dryRun (nothing
    // changed) and never allowed to fail the mutation: the routine row is already
    // written, so a dead SSE hub must not turn a successful pause into an error.
    if (outcome.applied && !outcome.dryRun) {
      try {
        const { notifySyncInvalidate } = await import('../../sync-sse');
        notifySyncInvalidate('automation.catalog');
        notifySyncInvalidate('learning.dream');
      } catch {
        /* SSE hub unavailable — the pane still refreshes on its next poll */
      }
    }

    // Pausing a routine whose own seed script commits it to ACTIVE is a SILENCING event, so
    // the owner-facing notice fires HERE — at the silencing instant — per plan
    // silent-halt-detection-and-owner-rails-2026-08-08 D-001: this is the only moment the
    // system holds both facts (that the routine is being silenced, and who did it). Any later
    // detector has to rediscover state that no longer announces itself, and D-007 measured
    // what that costs: `unguarded-halt-rescue` — the sweep that re-wakes silently-stopped
    // agents — sat paused 11.9 days with nothing saying a word, because every age-based
    // exemption downstream eventually reclassified it as decommissioned.
    //
    // This does NOT tighten the `reason` validator: D-006 rules that out (it would re-break
    // the Agents pane's one-click pause, a regression with its own EI-18680916805234639). The
    // pause is accepted exactly as before — a human is simply told it happened. That split is
    // the point of D-006: when a required field is a deliberate trade-off, get the
    // accountability from a DIFFERENT mechanism rather than breaking the field's caller.
    //
    // Fail-soft and non-blocking, like the SSE refresh above: the row is already written, so
    // a dead notification rail must never turn a successful pause into an error.
    if (outcome.applied && !outcome.dryRun && args.active === false) {
      void (async () => {
        try {
          const { isAlwaysOnSystemRoutine, isReaffirmed } = await import(
            '../../harness/routines/bespoke-active-seeds-check'
          );
          if (!isAlwaysOnSystemRoutine(args.name)) return;
          // A dated re-affirmation is the sanctioned way to pause one of these on purpose
          // (EI-19370236916382521) — respect it, or this notice becomes the cry-wolf noise
          // that motivated the original pause.
          if (isReaffirmed(args.reviewBy ?? null, Date.now())) return;
          const { notifyAttention } = await import('../../attention-notify');
          await notifyAttention({
            kind: 'intervention',
            importance: 'high',
            harnessSlug: slug,
            title: `Always-on routine paused: ${args.name}`,
            body:
              `"${args.name}" (${slug}) is seeded ACTIVE by default and was just paused — ` +
              `reason: "${args.reason}". ` +
              // P-004: "Nothing re-arms it on its own" is now FALSE for a TTL'd
              // release-group pause, and a notice that misstates whether recovery is
              // automatic is worse than no notice — it is what a responder plans around.
              (stampedPauseExpiryMs !== null
                ? `It is in the release group, so the hold is FINITE: the routines engine auto-resumes it at ` +
                  `${new Date(stampedPauseExpiryMs).toISOString()} unless it is resumed sooner. `
                : 'Nothing re-arms it on its own. ') +
              `Resume with ` +
              `routines:set { name: "${args.name}", installSlug: "${slug}", active: true }, ` +
              `or re-pause with a \`reviewBy\` date to silence this notice deliberately.`,
            data: {
              routine: args.name,
              installSlug: slug,
              reason: args.reason ?? '',
              event: 'always-on-routine-paused',
              pauseExpiresAtMs: stampedPauseExpiryMs,
            },
          });
        } catch (e) {
          console.warn('[routines:set] always-on pause notice failed (non-fatal):', (e as Error)?.message ?? e);
        }
      })();
    }

    const revertHandle =
      outcome.auditId && outcome.applied && !outcome.reverted
        ? { tool: 'routines:revert', args: { auditId: outcome.auditId } }
        : undefined;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            routine: `${slug}/${args.name}`,
            dryRun: outcome.dryRun,
            applied: outcome.applied,
            reverted: outcome.reverted,
            preview: outcome.preview,
            verify: outcome.verify,
            auditId: outcome.auditId,
            revertHandle,
            // P-004: a release-group pause is finite — say so in the reply, so the
            // caller learns the deadline at the moment they take the hold rather than
            // from a watchdog hours later. `null` on an untimed pause is the honest
            // answer, not a missing field: it means nothing will re-arm this routine.
            ...(args.active === false
              ? {
                  pauseAutoResumesAt:
                    stampedPauseExpiryMs !== null ? new Date(stampedPauseExpiryMs).toISOString() : null,
                  pauseIsFinite: stampedPauseExpiryMs !== null,
                }
              : {}),
          }),
        },
      ],
    };
  },
});
