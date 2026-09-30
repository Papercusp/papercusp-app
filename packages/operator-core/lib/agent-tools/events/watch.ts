/**
 * watch — the unified subscription primitive (unify-watch-primitive-2026-06-06 P-007).
 *
 * Awaiting an event and following a topic are the same act — register an interest, receive
 * a delivery — that differ on exactly two axes: CARDINALITY (`once`: one-shot vs standing)
 * and DELIVERY (`wake`: re-invoke me as a fresh turn vs inject into my inbox for my next
 * natural turn). `watch(pattern, {wake, once, min_sleep_sec, urgency, deadline})` is the one
 * registration with those as knobs; `events:await` survives as a thin sugar preset (D-007):
 *
 *   events:await {key}      = watch(key,   {wake:true,  once:true})
 *
 * The topic-flavoured preset `topics:subscribe` = watch(topic, {wake:false, once:false}) was
 * RETIRED 2026-08-09 (coordination-spec-adoption-2026-08-03 D-102): zero calls in 30 days
 * despite seven role prompts prescribing it by name. Ambient topic interest is now this tool
 * directly — watch:create { pattern: <topic>, targetKind:'topic', wake:false }. Note the
 * retirement was of the DOOR only; this base kept every cell, which is also why `state:subscribe`
 * (the live preset, 25 calls/11 agents) still delegates to the handler below.
 *
 * Routing (D-002 — inject is the cheap default; wake is the deliberate opt-in):
 *   - `wake:false` → the inject path (a standing topic subscription → coord inbox; no token cost).
 *   - `wake:true`  → the wake path (the durable liveness-adaptive re-invoke ladder), with the
 *     per-subscriber floor + burst-coalesce applied (a standing wake watch is bounded, not a
 *     ~30s re-wake storm). `once:true` carries the exactly-once + atomic-fire + wake-handle-at-
 *     registration grant guarantee (D-004).
 */

import { z } from 'zod';
import { dataConditionSchema } from '@papercusp/rules';
import { defineTool, lookupByMcpName, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { captureWakeHandleForOwner } from '../../events/await/handle';
import { registerAwait, cancelAwait } from '../../events/await/store';
import { startAwaitSweeper, deliverToSpecificAwaits } from '../../events/await/engine';
import {
  PREDICATE_OPS,
  registerPredicateWatch,
  startPredicateWatchPoller,
  evalPredicateWatch,
  findMatchingActivePredicateWatch,
} from '../../events/await/predicate-watch';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolvePotHomeSlug } from '../../pot/wake';
import { subscribeTopic } from '../coordination/topics';
import { subscribeEventKey } from '../coordination/event-subscriptions';
import { softText, clampText, LIMITS } from '../limits';
import {
  producerHealthInputSchema,
  progressLeaseInputSchema,
  resolveProducerHealthCertificate,
  resolveProgressLeaseCertificate,
} from './producer-health';
import {
  registerInterestWatch,
  startInterestWatchSweeper,
  INTEREST_DEFAULT_SIM_FLOOR,
  INTEREST_MIN_SIM_FLOOR,
  INTEREST_MAX_SIM_FLOOR,
  INTEREST_DEFAULT_INTERVAL_SEC,
} from '../../events/await/interest-watch';
import { resolveProseProfileSelection } from '../../search/prose-vector-dims';

// The fallback timeout-wake window + hard cap — one shared source of truth
// (await-timeout-fallback-defaults-2026-07-03): the one-shot wake default is now
// 30min, not 4h. Aliased to the local names so every usage below is unchanged.
import { AWAIT_DEFAULT_TIMEOUT_SEC as DEFAULT_TIMEOUT_SEC, AWAIT_MAX_TIMEOUT_SEC as MAX_TIMEOUT_SEC } from '../../events/await/types';

/** Default floor for a STANDING wake watch (once:false) — bounds the recurring-wake burn,
 *  generalized from the pot's floor. One-shot grants default to 0 (wake promptly). */
function standingWakeFloorSec(): number {
  const n = Number(process.env.PAPERCUSP_WATCH_MIN_SLEEP_SEC ?? 60);
  return Number.isFinite(n) && n >= 0 ? n : 60;
}

const watchPatternSchema = z
  .string()
  .min(1)
  .max(200)
  .describe('What to watch: an exact event key (wake) or a topic slug (inject). Exact match.');

const watchWakeSchema = z
  .boolean()
  .optional()
  .describe(
    'Delivery mode. false (DEFAULT) = inject into your inbox (cheap, seen next turn). true = re-invoke you (a turn = tokens) — opt-in, for specific readiness only.',
  );

const watchOnceSchema = z
  .boolean()
  .optional()
  .describe(
    'Cardinality. Default follows wake (one-shot for a wake grant; standing for an inject subscription). true = fires once then clears; false = standing (re-fires).',
  );

const watchTargetKindDescription =
  '"topic" (DEFAULT; wake:false only) — pattern is a curated topic slug (topics:list). "event" (wake:false only; WI-4014 Part 2) — pattern is an EXACT event key (see events:catalog): a standing, no-token-cost subscription so every future events:emit on that key lands in your inbox, without ever waking you. "interest" (EITHER wake mode; P-008 push-interjection) — pattern is FREE TEXT: a standing interest, embedded once at registration and matched against peers\' NEW transcript turns by similarity (>= min_similarity); fires coalesced matches with owner+excerpt+sim evidence on a synthetic interest:<id> key. Cancel via events:cancel (wake) / events:unsubscribe (inject) — the watch GCs itself.';

const watchMinSimilaritySchema = z
  .number()
  .min(INTEREST_MIN_SIM_FLOOR)
  .max(INTEREST_MAX_SIM_FLOOR)
  .optional()
  .describe(
    `targetKind:"interest" only — cosine floor a peer turn must clear to fire (default ${INTEREST_DEFAULT_SIM_FLOOR}, precision-biased: an interjection channel prefers silence over spam). Lower it only if a too-quiet watch proves it.`,
  );

const watchPayloadFilterSchema = dataConditionSchema
  .optional()
  .describe(
    "EI-8998: a predicate tested against the emitted event's PAYLOAD (not just its key/pattern), e.g. { queue_depth: { lt: 5 } } — kills the polling-vigil pattern (\"wake me when X crosses a threshold\") without a bespoke exact key per condition. Same MatchMap/all/any/not vocabulary as an ECA rule's `when`. A filter that never matches the emitter's actual payload shape silently never fires — check the emitting source's payload shape first.",
  );

const predicateInputSchema = z.object({
  tool: z.string().min(1).max(200).describe('READ-ONLY tool to poll, by mcp name (e.g. "work_items:list").'),
  args: z.record(z.string(), z.unknown()).optional().describe('Args passed on every poll.'),
  path: z.string().min(1).max(300).describe('Dot-path into the tool result, e.g. "counts.open" or "rows.0.status".'),
  op: z.enum(PREDICATE_OPS),
  value: z.unknown().optional().describe('Comparison operand (omit for exists).'),
});

const predicateDescription =
  'P-008 predicate watch (wake:true only): the engine polls `tool` every interval_sec UNDER YOUR ROLE (role gate enforced per poll, audited), extracts `path`, compares with `op` against `value`, and EDGE-fires your wake on the false→true cross. `pattern` becomes a label; the real key is synthetic (predicate:<id>). once:true deactivates after the first fire; once:false re-fires per cross. Registration runs ONE inline eval — a broken tool/role/args fails loudly NOW, and an already-true predicate fires immediately. DEDUPE (P-004): an IDENTICAL predicate (same scope/tool/args/path/op/value/interval_sec/once) already active JOINS that poller instead of starting a second one — response carries `deduped.joined_watch_id` when this happens.';

const watchSharedShape = {
  pattern: watchPatternSchema,
  once: watchOnceSchema,
  min_sleep_sec: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_TIMEOUT_SEC)
    .optional()
    .describe(
      'Per-subscriber wake floor (wake:true only): never re-wake you within this window; a burst inside it coalesces into ONE wake. Default: a sane floor for a standing watch, 0 (no floor — wake promptly) for a one-shot grant.',
    ),
  urgency: z
    .boolean()
    .optional()
    .describe('This watch’s wakes always bypass the floor (a human-message / escalation watch).'),
  timeout_sec: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_SEC)
    .optional()
    .describe('Deadline. wake:true → see on_timeout (default 4h for a one-shot). wake:false → auto-drops the subscription (TTL).'),
  on_timeout: z
    .enum(['wake', 'expire'])
    .optional()
    .describe('wake:true only — at the deadline without the event: wake (default — a TIMEOUT marker) or expire (silent lapse, visible in events:status).'),
  mode: z
    .enum(['full', 'digest', 'mention'])
    .optional()
    .describe('wake:false only — inject delivery tiering: full (default), digest (high-churn), mention (the quiet floor).'),
  note: softText(LIMITS.ANNOTATION).optional().describe('Why you are watching — echoed into the wake turn (wake:true). Auto-truncated to 2000 chars if longer.'),
  plan_run_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('wake:true from a plan run — the wake resumes the run via the plans:resume path instead of a session resume.'),
};

const watchIntervalSchema = z
  .number()
  .int()
  .min(15)
  .max(3600)
  .optional()
  .describe('Predicate poll cadence in seconds (predicate only; default 60).');

/**
 * Keep matcher alternatives explicit in the callable schema. A runtime-only
 * superRefine cannot publish that predicate is a different matcher from the
 * topic/event/interest fields, so callers could send a representable payload
 * that the handler had to reject after dispatch.
 */
const nonPredicateWatchSchema = z.object({
  ...watchSharedShape,
  wake: watchWakeSchema,
  targetKind: z.enum(['topic', 'event', 'interest']).optional().describe(watchTargetKindDescription),
  min_similarity: watchMinSimilaritySchema,
  payload_filter: watchPayloadFilterSchema,
  producer_health: producerHealthInputSchema.optional(),
  progress_lease: progressLeaseInputSchema.optional(),
  predicate: z.never().optional().describe('Only valid for the predicate matcher branch.'),
  interval_sec: watchIntervalSchema,
});

const predicateWatchSchema = z.object({
  ...watchSharedShape,
  wake: z.literal(true).describe('Predicate watches require wake:true.'),
  targetKind: z.never().optional().describe('Predicate watches do not use a topic, event, or interest targetKind.'),
  min_similarity: z.never().optional().describe('Only valid with targetKind:"interest".'),
  payload_filter: z.never().optional().describe('Payload filters are not used by predicate watches.'),
  producer_health: z.never().optional().describe('Producer health is only valid for a one-shot event watch.'),
  progress_lease: z.never().optional().describe('Progress leases are only valid for a non-predicate watch.'),
  predicate: predicateInputSchema.describe(predicateDescription),
  interval_sec: watchIntervalSchema,
});

export default defineTool({
  name: 'watch:create',
  description:
    'The unified subscription primitive — watch(pattern, {wake, once, min_sleep_sec, urgency, timeout_sec, mode, targetKind}): register an interest, receive a delivery. DELIVERY — wake:false (DEFAULT, cheap) injects into your inbox (no token cost); wake:true (opt-in, tokens) re-invokes you. CARDINALITY — once:true one-shot; once:false standing. TARGET: targetKind "topic" (default) / "event" (exact key) — wake:false — or "interest" (free text; fires on matching peer work; either wake mode — see arg). Sugar: events:await = watch(key,{wake:true,once:true}). Ambient topic interest is this tool with targetKind:"topic", wake:false. PREDICATE (wake:true): predicate:{tool,args,path,op,value}+interval_sec polls a read-only tool under YOUR role, wakes on false→true.',
  guidance: {
    when: 'Prefer wake:false (inject) for continuous awareness of a churning area — no cost. Use wake:true ONLY for specific readiness ("wake me when THIS grant/lock/deadline is ready"); for a standing wake watch set min_sleep_sec to bound the re-wake rate. once:true for a one-shot grant; once:false to keep following.',
    notWhen:
      'A sub-minute wait inside one turn — just do the bounded blocking call. A recurring TIME schedule — the pot/routines own time-based wakes. Ambient interest where a wake would burn turns — use wake:false.',
    chaining:
      'wake:true → end your turn; on wake the turn text carries the event + payload. events:cancel (wake) / topics:unsubscribe or events:unsubscribe (inject) to stop; events:status to inspect your active wake watches + recent wakes.',
    seeAlso: [
      'events:await (a one-shot wait vs this standing watch)',
      'events:cancel (retract the watch)',
      'events:status (inspect your active watches)',
      'events:unsubscribe (retract a wake:false targetKind:"event" subscription)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.union([nonPredicateWatchSchema, predicateWatchSchema]),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const wake = args.wake ?? false;
    // Default cardinality follows delivery: a wake is a one-shot grant; an inject is standing.
    const once = args.once ?? wake;

    if (args.producer_health && (!wake || !once || args.predicate)) {
      throw new Error('watch:create — producer_health requires a one-shot wake:true event watch (not inject, standing, or predicate)');
    }
    if (args.progress_lease && (!wake || !once || args.predicate)) {
      throw new Error('watch:create — progress_lease requires a one-shot wake:true event watch (not inject, standing, or predicate)');
    }
    if (args.producer_health && args.progress_lease) {
      throw new Error('watch:create — pass producer_health or progress_lease, not both');
    }
    if (args.producer_health && args.on_timeout === 'expire') {
      throw new Error('watch:create — producer_health requires on_timeout:"wake" so a stalled/absent diagnosis is actionable');
    }
    if (args.progress_lease && args.on_timeout === 'expire') {
      throw new Error('watch:create — progress_lease requires on_timeout:"wake" so stale evidence and remedies remain actionable');
    }

    const isInterest = args.targetKind === 'interest';
    if (args.interval_sec != null && !args.predicate && !isInterest) {
      throw new Error(
        'watch:create — interval_sec applies only to a predicate or interest watch (for a wake floor, use min_sleep_sec).',
      );
    }
    if (args.min_similarity != null && !isInterest) {
      // Fail loud rather than silently ignore — a caller believing a topic/event
      // watch is similarity-filtered when it isn't is the trap this kills.
      throw new Error('watch:create — min_similarity applies only to targetKind:"interest".');
    }

    if (isInterest) {
      // ── P-008 interest watch (get-feedback-relevance-consults-2026-08-16): a
      // standing free-text interest, embedded ONCE here, matched by the sweep
      // (interest-watch.ts) against peers' NEW transcript turns — the push half
      // of the consult system. One emitted key serves both delivery modes.
      if (args.predicate) {
        throw new Error('watch:create — targetKind:"interest" and predicate are mutually exclusive (one watch, one matcher).');
      }
      if (args.producer_health) {
        throw new Error('watch:create — producer_health applies to a one-shot event watch, not an interest watch.');
      }
      if (!wake && args.payload_filter) {
        throw new Error(
          'watch:create — payload_filter is only supported with wake:true today (it filters wake-await fires; a wake:false inject subscription has no per-emit matching step to apply it to).',
        );
      }
      // An interest is STANDING by nature in both delivery modes (unlike a bare
      // wake watch, whose default cardinality is one-shot).
      const interestOnce = args.once ?? false;
      // Embed ONCE — dynamically imported because the embedder's transitive
      // graph opens PG at import time (same reason get-feedback.ts lazy-loads it).
      const { buildQueryEmbedderResolved } = await import('../search/embedder');
      const resolved = await buildQueryEmbedderResolved();
      const embeddingProfile = resolved
        ? resolveProseProfileSelection(resolved.mode, resolved.profile)
        : null;
      if (!resolved || !embeddingProfile) {
        throw new Error(
          'watch:create — no profile-compatible prose embedder is available on this host, so this interest could never be matched. Refusing to register (honest degrade) rather than registering a watch that silently never fires.',
        );
      }
      const vec = await resolved.embed(args.pattern).catch(() => null);
      if (!vec || vec.length === 0) {
        throw new Error('watch:create — embedding the interest text failed; retry, or check the embedding sidecar.');
      }
      const id = globalThis.crypto.randomUUID();
      const eventKey = `interest:${id}`;
      const workspaceId = ctx.workspaceId ?? activeWorkspaceId();
      const simFloor = args.min_similarity ?? INTEREST_DEFAULT_SIM_FLOOR;
      startInterestWatchSweeper();

      let wakeHandleNote: string | undefined;
      let awaitRowId: string | number | undefined;
      if (wake) {
        // Delivery target registers FIRST (GC safety: the sweep deactivates an
        // interest row with no live await/subscription on its key).
        startAwaitSweeper();
        const minSleepSec = args.min_sleep_sec ?? (interestOnce ? 0 : standingWakeFloorSec());
        const { handle, note: handleNote } = await captureWakeHandleForOwner(identity.ownerId, {
          planRunId: args.plan_run_id,
        });
        const row = await registerAwait({
          subscriberId: identity.ownerId,
          eventKey,
          policy: 'wake',
          note: clampText(args.note ?? `interest: ${args.pattern}`, LIMITS.ANNOTATION) ?? null,
          wakeHandle: handle,
          timeoutBehavior: args.on_timeout ?? 'wake',
          timeoutSec: args.timeout_sec ?? (interestOnce ? DEFAULT_TIMEOUT_SEC : null),
          once: interestOnce,
          minSleepSec,
          urgency: args.urgency,
          payloadFilter: args.payload_filter ?? null,
        });
        wakeHandleNote = handleNote;
        awaitRowId = row.id;
      } else {
        await subscribeEventKey(identity, eventKey, { mode: args.mode, ttl_sec: args.timeout_sec });
      }

      const { getOrgPg } = await import('@papercusp/db-org');
      const watchRow = await registerInterestWatch(getOrgPg().sql, {
        id,
        workspaceId,
        ownerId: identity.ownerId,
        // NOT `ctx.harnessSlug ?? null`: on an operator-scoped call ctx.harnessSlug is
        // the WILDCARD sentinel ('*'/'all'), and a raw `??` would persist that sentinel
        // into interest_watches.harness_slug as though it were a concrete slug.
        // resolvePotHomeSlug skips the sentinel at each level, falls through to the env
        // home, and canonicalises — yielding a real slug or null, never '*'.
        harnessSlug: resolvePotHomeSlug(undefined, ctx.harnessSlug),
        eventKey,
        interest: args.pattern,
        embedding: vec,
        embeddingMode: resolved.mode,
        embeddingProfile,
        simFloor,
        ...(args.interval_sec != null ? { intervalSec: args.interval_sec } : {}),
        once: interestOnce,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              watch: {
                id: awaitRowId ?? watchRow.id,
                pattern: eventKey,
                label: args.pattern,
                targetKind: 'interest',
                wake,
                once: interestOnce,
                min_similarity: simFloor,
                interval_sec: watchRow.intervalSec,
              },
              interest: {
                watch_id: watchRow.id,
                sim_floor: simFloor,
                swept_every_sec: watchRow.intervalSec,
                matches_from: watchRow.watermark,
              },
              ...(wakeHandleNote !== undefined ? { wake_handle: wakeHandleNote } : {}),
              advice: wake
                ? `Interest registered (standing, swept every ${watchRow.intervalSec}s). End your turn — you will be woken (floored, coalesced) when a peer's new work matches above ${simFloor}. Only turns from now on are candidates. events:cancel to stop.`
                : `Interest registered (inject, swept every ${watchRow.intervalSec}s). Matches above ${simFloor} land in your coord inbox with owner + excerpt + sim evidence — no token cost. Only turns from now on are candidates. events:unsubscribe (targetKind:"event", pattern "${eventKey}") to stop.`,
            }),
          },
        ],
      };
    }

    if (!wake) {
      // EI-8998: payload_filter is a wake-path-only feature today (it filters which
      // AWAIT rows fire; inject is a topic subscription with no per-emit fire/claim
      // step to hook it into) — fail loud rather than silently ignore it, so a caller
      // never believes an inject watch is predicate-filtered when it isn't.
      if (args.payload_filter) {
        throw new Error(
          'watch:create — payload_filter is only supported with wake:true today (it filters wake-await fires; a wake:false inject subscription has no per-emit matching step to apply it to).',
        );
      }
      // P-008: a predicate watch exists to FIRE A WAKE on a threshold cross — an
      // inject subscription has no await row to pair the poll with. Fail loud.
      if (args.predicate) {
        throw new Error(
          'watch:create — predicate requires wake:true (the engine-side poll fires a wake await on the false→true cross; there is no inject leg).',
        );
      }
      // ── Inject preset (D-002 cheap default) → a standing topic OR event-key subscription. ──
      const targetKind = args.targetKind ?? 'topic';
      if (targetKind === 'event' && args.once === true) {
        // A one-shot event inject uses the await table's notify policy rather than
        // the standing subscription table. emitAwaitedEvent already claims these
        // rows atomically and folds them into the normal coord-inbox send, so this
        // preserves exactly-once delivery without adding a second fan-out path.
        startAwaitSweeper();
        const row = await registerAwait({
          subscriberId: identity.ownerId,
          eventKey: args.pattern,
          policy: 'notify',
          note: clampText(args.note, LIMITS.ANNOTATION) ?? null,
          timeoutBehavior: 'expire',
          timeoutSec: args.timeout_sec,
          once: true,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                watch: {
                  id: row.id,
                  pattern: row.eventKey,
                  targetKind,
                  wake: false,
                  once: row.once,
                  mode: args.mode ?? 'full',
                  expires_ts: row.expiresTs,
                },
                advice:
                  'Watching this EVENT KEY (inject, one-shot). The first matching events:emit lands in your coord inbox next turn, no token cost; the watch then clears. events:cancel to stop it early.',
              }),
            },
          ],
        };
      }
      const sub =
        targetKind === 'event'
          ? await subscribeEventKey(identity, args.pattern, { mode: args.mode, ttl_sec: args.timeout_sec })
          : await subscribeTopic(identity, args.pattern, { mode: args.mode, ttl_sec: args.timeout_sec });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              watch: {
                pattern: sub.target_ref,
                targetKind,
                wake: false,
                once: false,
                mode: sub.delivery_mode,
                expires_ts: sub.expires_ts,
              },
              advice:
                targetKind === 'event'
                  ? 'Watching this EVENT KEY (inject). Every future events:emit on it lands in your coord inbox next turn, no token cost. events:unsubscribe to stop.'
                  : 'Watching (inject). Updates land in your coord inbox — you will see them on your next turn, no token cost.',
            }),
          },
        ],
      };
    }

    // EI-22459575798410641: `targetKind` is only meaningful on the inject path above
    // ('interest' returned earlier), so anything left here is 'topic' or 'event' — both
    // documented "wake:false only". Reaching this point used to SILENTLY DROP the arg: no
    // refusal, no echo, no downgrade marker, so a caller asking for a standing event-key
    // watch got an unrelated wake grant and believed targetKind had been honoured. Fail
    // loud instead, and name the two forms that actually work — the same fail-loud
    // treatment payload_filter and predicate already get on the opposite path.
    if (args.targetKind) {
      throw new Error(
        `watch:create — targetKind:"${args.targetKind}" is not supported with wake:true (it is read only on the wake:false inject path). ` +
          'For a standing subscription that RE-INVOKES you, drop targetKind and pass { wake:true, once:false } — it never expires and is floored by min_sleep_sec. ' +
          `For a no-token-cost inbox subscription, pass { wake:false, targetKind:"${args.targetKind}" }.`,
      );
    }

    // ── Wake preset → the durable re-invoke ladder, floored + coalesced. ──
    startAwaitSweeper();
    const minSleepSec = args.min_sleep_sec ?? (once ? 0 : standingWakeFloorSec());
    const { handle, note: handleNote } = await captureWakeHandleForOwner(identity.ownerId, {
      planRunId: args.plan_run_id,
    });

    if (args.predicate) {
      // ── P-008 predicate watch: engine-side poll under the CALLER's role envelope. ──
      const p = args.predicate;
      const projected = lookupByMcpName(p.tool);
      if (!projected) {
        throw new Error(`watch:create — predicate.tool "${p.tool}" is not a known tool (use the mcp name, e.g. "work_items:list").`);
      }
      if (projected.effect !== 'read') {
        throw new Error(
          `watch:create — predicate.tool "${p.tool}" is not read-only (effect=${projected.effect ?? 'unset'}); a predicate poll may only observe, never mutate.`,
        );
      }
      startPredicateWatchPoller();
      const workspaceId = ctx.workspaceId ?? activeWorkspaceId();
      const role = ctx.role ?? 'su';
      // Same reasoning as the interest branch above: NOT `ctx.harnessSlug ?? null`.
      // On an operator-scoped call ctx.harnessSlug is the WILDCARD sentinel ('*'/'all'),
      // and this binding feeds BOTH the dedup lookup below and the persisted
      // predicate_watches.harness_slug — so a raw `??` addresses a bucket named '*'
      // and stores it as though it were a concrete slug.
      const harnessSlug = resolvePotHomeSlug(undefined, ctx.harnessSlug);
      const intervalSec = args.interval_sec ?? 60;

      // EI-8998 dedup (fleet-reliability-verification-2026-07-10 P-004): join an
      // existing ACTIVE poller for the IDENTICAL predicate instead of starting a
      // second one — the motivating repro was two agents each independently polling
      // the same watermark SQL ~12+ times during the 2026-07-09/10 night shift.
      const existing = await findMatchingActivePredicateWatch({
        workspaceId,
        role,
        harnessSlug,
        tool: p.tool,
        args: p.args ?? {},
        path: p.path,
        op: p.op,
        value: p.value,
        intervalSec,
        once,
      });

      if (existing) {
        const row = await registerAwait({
          subscriberId: identity.ownerId,
          eventKey: existing.eventKey,
          policy: 'wake',
          note: clampText(args.note ?? `predicate: ${p.tool} ${p.path} ${p.op}`, LIMITS.ANNOTATION) ?? null,
          wakeHandle: handle,
          timeoutBehavior: args.on_timeout ?? 'wake',
          timeoutSec: args.timeout_sec ?? (once ? DEFAULT_TIMEOUT_SEC : null),
          once,
          minSleepSec,
          urgency: args.urgency,
          payloadFilter: null,
        });
        // The shared row only edge-fires on a false→true cross — a fresh join when
        // it's ALREADY true would otherwise never wake (no cross left to observe).
        // Deliver directly to THIS new await, without touching any other standing
        // subscriber already on the shared key.
        let fired = false;
        if (existing.lastEval === true) {
          const { delivered } = await deliverToSpecificAwaits({
            awaitRows: [row],
            payload: {
              observed: existing.lastValue,
              predicate: { tool: p.tool, path: p.path, op: p.op, value: p.value },
            },
            summary: `predicate already matched (joined existing poller ${existing.id}): ${p.tool} ${p.path} ${p.op}`,
            source: `predicate-watch:${identity.ownerId}`,
          });
          fired = delivered > 0;
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                watch: {
                  id: row.id,
                  pattern: existing.eventKey,
                  label: args.pattern,
                  wake: true,
                  once: row.once,
                  min_sleep_sec: row.minSleepSec,
                  urgency: row.urgency,
                  expires_ts: row.expiresTs,
                  on_timeout: row.timeoutBehavior,
                },
                predicate: { tool: p.tool, path: p.path, op: p.op, value: p.value, interval_sec: existing.intervalSec },
                deduped: { joined_watch_id: existing.id },
                first_eval: { matched: existing.lastEval === true, fired, observed: existing.lastValue },
                wake_handle: handleNote,
                advice: fired
                  ? 'Predicate is ALREADY true (joined an existing poller for the identical predicate) — the wake fired on this registration. End your turn; the delivery is on its way.'
                  : `Predicate registered — joined an EXISTING poller for the identical predicate (polled every ${existing.intervalSec}s under your role; no extra poller started). End your turn — you will be woken on the false→true cross${once ? ' exactly once' : ', each cross'} (or at the deadline). Do not poll.`,
              }),
            },
          ],
        };
      }

      const id = globalThis.crypto.randomUUID();
      const eventKey = `predicate:${id}`;
      // The await registers FIRST: the poller GCs any predicate row whose paired
      // await is gone, so the row must never exist without its waiter.
      const row = await registerAwait({
        subscriberId: identity.ownerId,
        eventKey,
        policy: 'wake',
        note: clampText(args.note ?? `predicate: ${p.tool} ${p.path} ${p.op}`, LIMITS.ANNOTATION) ?? null,
        wakeHandle: handle,
        timeoutBehavior: args.on_timeout ?? 'wake',
        timeoutSec: args.timeout_sec ?? (once ? DEFAULT_TIMEOUT_SEC : null),
        once,
        minSleepSec,
        urgency: args.urgency,
        payloadFilter: null,
      });
      const watchRow = await registerPredicateWatch({
        id,
        workspaceId,
        ownerId: identity.ownerId,
        role,
        harnessSlug,
        eventKey,
        tool: p.tool,
        args: p.args ?? {},
        path: p.path,
        op: p.op,
        value: p.value,
        intervalSec,
        once,
      });
      // ONE inline eval: validates the whole pipeline under the real envelope NOW,
      // and an already-true predicate fires immediately instead of one interval out.
      const first = await evalPredicateWatch(watchRow);
      if (first.error) {
        // A registration whose very first poll fails (role gate, bad args, tool
        // throw) will fail every poll — unwind both rows and fail LOUDLY now.
        await cancelAwait({ awaitId: Number(row.id), subscriberId: identity.ownerId });
        throw new Error(
          `watch:create — predicate registration failed its inline first eval (unwound): ${first.error}`,
        );
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              watch: {
                id: row.id,
                pattern: eventKey,
                label: args.pattern,
                wake: true,
                once: row.once,
                min_sleep_sec: row.minSleepSec,
                urgency: row.urgency,
                expires_ts: row.expiresTs,
                on_timeout: row.timeoutBehavior,
              },
              predicate: { tool: p.tool, path: p.path, op: p.op, value: p.value, interval_sec: watchRow.intervalSec },
              first_eval: { matched: first.matched, fired: first.fired, observed: first.observed },
              wake_handle: handleNote,
              advice: first.fired
                ? 'Predicate is ALREADY true — the wake fired on this registration. End your turn; the delivery is on its way.'
                : `Predicate registered (polled every ${watchRow.intervalSec}s under your role). End your turn — you will be woken on the false→true cross${once ? ' exactly once' : ', each cross'} (or at the deadline). Do not poll.`,
            }),
          },
        ],
      };
    }

    const workspaceId = ctx.workspaceId ?? activeWorkspaceId();
    const harnessSlug = resolvePotHomeSlug(undefined, ctx.harnessSlug);
    const producerHealthCertificate = args.producer_health
      ? await resolveProducerHealthCertificate({
          producerHealth: args.producer_health,
          subscriberId: identity.ownerId,
          timeoutSec: args.timeout_sec,
        })
      : args.progress_lease
        ? await resolveProgressLeaseCertificate({
            progressLease: args.progress_lease,
            subscriberId: identity.ownerId,
            workspaceId,
            harnessSlug,
            role: ctx.role ?? 'su',
            timeoutSec: args.timeout_sec,
          })
        : null;
    const effectiveTimeoutSec =
      args.timeout_sec ??
      (args.producer_health
        ? args.producer_health.expected_cadence_sec
        : args.progress_lease
          ? args.progress_lease.expected_cadence_sec
          : once
            ? DEFAULT_TIMEOUT_SEC
            : null);
    const row = await registerAwait({
      subscriberId: identity.ownerId,
      eventKey: args.pattern,
      policy: 'wake',
      note: clampText(args.note, LIMITS.ANNOTATION) ?? null,
      wakeHandle: handle,
      timeoutBehavior: args.on_timeout ?? 'wake',
      timeoutSec: effectiveTimeoutSec,
      once,
      minSleepSec,
      urgency: args.urgency,
      payloadFilter: args.payload_filter ?? null,
      producerHealthCertificate,
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            watch: {
              id: row.id,
              pattern: row.eventKey,
              wake: true,
              once: row.once,
              min_sleep_sec: row.minSleepSec,
              urgency: row.urgency,
              expires_ts: row.expiresTs,
              on_timeout: row.timeoutBehavior,
              ...(args.payload_filter !== undefined ? { payload_filter: args.payload_filter } : {}),
            },
            wake_handle: handleNote,
            advice: once
              ? 'Registered a one-shot wake. End your turn now — you will be re-invoked exactly once when it fires (or at the deadline). Do not poll.'
              : 'Registered a standing wake watch (floored). End your turn — you will be re-woken on matches, at most once per min_sleep_sec, with bursts coalesced into one wake.',
          }),
        },
      ],
    };
  },
});
