/**
 * messages.ts — operator host adapter for the L3 message + ack substrate.
 *
 * The envelope shapes + the inbox-filter / thread-fold logic live in
 * @papercusp/coordination/core; the per-sender-outbox I/O lives behind
 * the CoordEventLog seam (coordLog). This file keeps the original
 * function surface (sendMessage / appendAck / readInbox / readThread)
 * so every caller + test is unchanged.
 *
 * agent-coordination-architecture-v2 §6.4 (#6).
 */

import type postgres from 'postgres';
import {
  newMsgId,
  filterInbox,
  foldThread,
  type CoordEnvelope,
  type CoordKind,
  type InboxOptions,
} from '@papercusp/coordination/core';
import { coordLog, coordWorkspaceId, coordSql, coordHasPgFastPath } from './log';
import { getLineEnvelopeById } from './line-event-by-id';
import { expandAudienceDetailed, hasAudienceSelector, type UnreachableAudience } from './audience';
import { hostAudienceResolvers, audienceMode, deriveAudienceKey } from './audience-host';
import { deliverFleetDigests } from './fleet-delivery';
import { slotSelectorsIn, parseSlotSelector } from './slot-selector';
import { parkSlotMessage, drainUserMailbox } from './slot-parked-store';
import { resolveLiveRoleHolders, resolveRoleSlotPotSlug } from './role-slot-live-resolve';
import type { AgentIdentity } from './identity';
import { resolveBestEffortAgainstRoster } from './recipient-resolve';
import { resolveWorkspaceHiveScope } from './federation-scope';
import {
  CUE_AUTHORITY_FIELD,
  readCueAuthority,
  renderCueAuthorityTag,
  type CueAuthorityStamp,
} from './cue-authority';
import { resolveSenderCueAuthority } from './cue-authority-resolve';
import { collectRetractedIds, suppressRetracted } from './retraction';
import {
  isMachineAuthoredSender,
  isMachineEmitterForStamping,
  isSystemEmissionUnderAgentIdentity,
} from './machine-authored';
import { shouldDerivePlanSlug, derivePlanSlug, PLAN_SLUG_DERIVED_PROVENANCE } from './derived-plan-slug';
import { shouldDeriveWhyGoal, deriveWhyGoal, WHY_GOAL_DERIVED_PROVENANCE } from './derived-why-goal';
import { noteIntentDeclared, readAgentStateStamp } from '../../agent-state-stamp';

export type { InboxOptions };

// Audience diagnostics are for the immediate coord:send result only. Keep them
// out of CoordEnvelope so they cannot become durable wire fields or change the
// inbox/federation shape; the envelope object returned by sendMessage is the
// short-lived hand-off to the tool layer.
const unresolvedAudienceByEnvelope = new WeakMap<object, readonly string[]>();
const unreachableAudienceByEnvelope = new WeakMap<object, readonly UnreachableAudience[]>();

export function getUnresolvedAudienceSelectors(env: CoordEnvelope): readonly string[] {
  return unresolvedAudienceByEnvelope.get(env) ?? [];
}

/**
 * Selectors that resolved to recipients who are ALL reaped (EI-22180848452883121).
 * An empty result means "none KNOWN" — never proof that every recipient is
 * reachable; see {@link UnreachableAudience}.
 */
export function getUnreachableAudienceSelectors(
  env: CoordEnvelope,
): readonly UnreachableAudience[] {
  return unreachableAudienceByEnvelope.get(env) ?? [];
}

/** Options for sendMessage / generalised coord append. */
export interface SendOptions {
  /** Recipient ownerIds. Use ['*'] for broadcast, ['human'] for the human inbox. */
  to: string[];
  /**
   * Internal stable id for a producer with its own replay key. Ordinary callers
   * omit this and receive a freshly generated id. A harness-scoped stable id is
   * protected by coord_event_log_fed_uq, so a retry can treat 23505 as already
   * delivered instead of appending a duplicate owner message.
   */
  msgId?: string;
  summary?: string;
  body?: string;
  /**
   * Internal body renderer for the rare envelope whose prose must quote its
   * generated msg_id (for example, a control cue teaching coord:ack). This is
   * evaluated after the id is minted and is never serialized as an envelope key.
   */
  bodyWithMsgId?: (msgId: string) => string;
  files?: string[];
  plan_slug?: string;
  related_msg_id?: string;
  /** Explicit sender-side intent: this message is awaiting a reply. */
  expectsReply?: boolean;
  /** Originating harness slug — ALSO the coord federation key (the capture
   *  trigger only outboxes a coord_event_log row whose harness_slug names a
   *  federating harness/hive-home). Tri-state (WI-3653):
   *    string    → stamp verbatim (harness-scoped sender / MCP-resolved scope);
   *    null      → EXPLICIT machine-local (coord:send scope:'local') — never
   *                auto-stamped;
   *    undefined → AUTO: stamp the workspace's single shared Hive home when
   *                exactly one exists (the SAME rule coord:send documents for
   *                an omitted scope), else stay local.
   *  WHY the auto default lives HERE and not only in the MCP tool layer: the
   *  serve plane's system emitters (plan-clobber-watch etc.) call sendMessage
   *  directly, so on a fed-plane machine (P-059 Mac rig) every locally-emitted
   *  coord event carried harness_slug NULL and could NEVER federate — zero
   *  coord ops ever entered that machine's outbox while plan-parts/issues
   *  federated fine. The write seam is the one place every writer passes. */
  harnessSlug?: string | null;
  /** Default 'message'. Use other kinds for typed channel writes. */
  kind?: CoordKind;
  /** Ambient-classification tag (e.g. 'service-health'). A categorised message
   *  is still a message, but coord:inbox default-excludes ambient categories. */
  category?: string;
  /** Extra envelope keys merged verbatim (e.g. the auto-lifecycle markers
   *  `auto:true` + `lifecycle:'<category>'` that `coord:emit` stamps so the
   *  inbox can distinguish system-emitted lifecycle from human-authored
   *  coord:send — coord-lifecycle-automation-2026-06-04). Reserved envelope
   *  fields (ts/msg_id/from/to/kind) are NOT overridable. */
  extra?: Record<string, unknown>;
  /** The sender's ALREADY-RESOLVED cue-authority stamp (or explicit null =
   *  "resolved, sender holds none"). tools/send resolves it once per bulk call
   *  for its own down-scope/stamp logic and threads it here so the H5a seam
   *  invariant (below) doesn't re-pay the presence/fleet reads. `undefined` =
   *  not resolved yet — the seam resolves it itself for a `'*'` message-kind
   *  broadcast. */
  cueAuthorityResolved?: CueAuthorityStamp | null;
}

/**
 * H5a (coord-authority-hardening-2026-07-11 P-002): the typed refusal thrown
 * when a fleet-scoped control authority attempts a hive-wide `'*'` delivery —
 * the shipped self-contradiction of the EI-9501 leak (stamped
 * `fleet-members(X)`, delivered to everyone). Carries the same error code the
 * landed coord:send guard uses so every surface teaches one lesson.
 */
export class FleetScopedBroadcastRefusedError extends Error {
  readonly code = 'fleet_scoped_cue_allhive_contradiction';
  readonly stamp: CueAuthorityStamp;
  constructor(stamp: CueAuthorityStamp) {
    super(
      `broadcast to '*' refused: your control authority is ${renderCueAuthorityTag(stamp)} — ` +
        `only fleet '${stamp.scopeRef ?? stamp.authorityRef}' members are meant to act on your cues. ` +
        `Address @fleet:${stamp.scopeRef ?? stamp.authorityRef} (leader included), or send a genuinely ` +
        `hive-wide notice from a non-fleet-authority context.`,
    );
    this.name = 'FleetScopedBroadcastRefusedError';
    this.stamp = stamp;
  }
}

/** Append a new envelope to the caller's outbox. */
export async function sendMessage(
  identity: AgentIdentity,
  opts: SendOptions,
): Promise<CoordEnvelope> {
  // Audience-selector expansion (coord-emit-subscription-scoping-2026-06-05): a
  // `to[]` carrying `@plan:`/`@topic:`/`@object:`/`@file:` selectors resolves to
  // the concrete ownerIds watching that plan/topic/work-item. Zero-overhead when
  // no selector is present (the overwhelmingly common case). The EXPANDED set is
  // stored on the envelope so the inbox filter + federation projection are
  // unchanged (D-001/D-003); an empty resolution → empty `to` → no inbox
  // delivery, but the row still persists (D-004).
  // B2 / park-for-slot: @role:/@wave:/@feature: entries address a SLOT that may
  // have no agent yet — split them off so they PARK (below) instead of resolving
  // to live ownerIds; only the non-slot addressees are delivered now.
  // Capture the durable audience KEY from the ORIGINAL `to`, BEFORE expansion
  // discards the selectors. This makes every broadcast queryable as audience-keyed
  // history (coord:feed { audience }) — the generalization of plan_slug, live +
  // retained by default. (fleet-broadcast-audience-history-integration-2026-06-30 D-003)
  const audienceKey = deriveAudienceKey(opts.to);
  const slots = slotSelectorsIn(opts.to);
  // EI-13620: a `role` slot may ALREADY have a live holder RIGHT NOW, not just
  // a future spawn — resolve it against the live roster so a stable,
  // currently-idle role (e.g. the Mug) is delivered to (and can be woken) like
  // an ordinary ownerId, instead of silently parking a nudge that only a FRESH
  // relaunch would ever drain (mug-brief-launch's gatherInbox runs at LAUNCH,
  // never on an existing session's plain wake — see role-slot-live-resolve.ts
  // for the full incident writeup). The slot is STILL parked below
  // unconditionally (unchanged) so a future relaunch keeps draining it too —
  // this is purely ADDITIVE to the legacy park-only behavior.
  const roleSlots = slots.filter((s) => s.kind === 'role');
  let liveRoleOwners: string[] = [];
  if (roleSlots.length) {
    const potSlug = await resolveRoleSlotPotSlug(identity.workspaceId, opts.harnessSlug ?? null);
    const found = await Promise.all(
      roleSlots.map((s) =>
        resolveLiveRoleHolders(s.ref, { workspaceId: identity.workspaceId, potSlug }).catch(
          () => [] as string[],
        ),
      ),
    );
    liveRoleOwners = Array.from(new Set(found.flat()));
  }
  const liveAddrs = slots.length
    ? [...opts.to.filter((t) => parseSlotSelector(t) === null), ...liveRoleOwners]
    : opts.to;
  let toExpanded: string[] = liveAddrs;
  let unresolvedAudienceSelectors: string[] = [];
  let unreachableAudienceSelectors: UnreachableAudience[] = [];
  if (hasAudienceSelector(liveAddrs)) {
    const expansion = await expandAudienceDetailed(liveAddrs, hostAudienceResolvers, audienceMode());
    toExpanded = expansion.resolved;
    unresolvedAudienceSelectors = expansion.unresolvedSelectors;
    unreachableAudienceSelectors = expansion.unreachableSelectors;
  }
  // owner-2026-06-17: resolve short ownerId PREFIXES to full ids so inbox delivery
  // + any inbox-wake hit the right recipient. Best-effort + fail-soft; an
  // all-selector/broadcast `to` skips the roster read entirely.
  const to = await resolveBestEffortAgainstRoster(toExpanded, identity.workspaceId);
  // H5a — the audience⊆authority INVARIANT, enforced at the ONE seam every
  // message writer passes (coord-authority-hardening-2026-07-11 P-002,
  // generalizing the EI-9501 guard that lives only in tools/send.ts): a sender
  // whose control authority is FLEET-scoped must never deliver a hive-wide
  // `'*'` message — the stamped intent (fleet-members) would contradict the
  // actual delivery (everyone), which is the exact shipped contradiction of
  // the 2026-07-11 leak. Scoped to kind 'message' (the human-authored /
  // control channel both incidents used): lifecycle kinds (plan_event / ack /
  // notify / …) legitimately broadcast `'*'` from any sender and carry no
  // control weight, so they pass untouched. tools/send.ts still refuses its
  // own allHive path with a per-item bulk error BEFORE reaching here (and
  // down-scopes bare `'*'` for fleeted senders, so its sends arrive without a
  // wildcard); THIS check catches every OTHER path — emit, dispatch, system
  // emitters, federated relays through local tools, and tomorrow's new verb.
  // The resolved stamp is ALSO written onto the envelope so a permitted
  // broadcast (hive-queen, or an unstamped ordinary sender) stays legible to
  // the receive-side defang (P-003 H1).
  const kind = opts.kind ?? 'message';
  // coord:emit deliberately keeps lifecycle records on the visible `message`
  // wire kind so inbox readers can see them, while stamping `auto` + a
  // lifecycle category to distinguish machine chatter from a control cue.
  // Treat that explicit machine-lifecycle shape like the executable lifecycle
  // kinds above: it carries no authority and must not trip H5a merely because
  // the sender happens to be a fleet leader broadcasting the lifecycle signal.
  const isAutoLifecycleMessage =
    kind === 'message' &&
    opts.extra?.auto === true &&
    typeof opts.extra.lifecycle === 'string' &&
    opts.extra.lifecycle.length > 0;
  if (kind === 'message' && to.includes('*') && !isAutoLifecycleMessage) {
    let stamp: CueAuthorityStamp | null;
    if (opts.cueAuthorityResolved !== undefined) {
      stamp = opts.cueAuthorityResolved;
    } else if (opts.extra && CUE_AUTHORITY_FIELD in opts.extra) {
      stamp = readCueAuthority(opts.extra);
    } else {
      try {
        stamp = await resolveSenderCueAuthority(identity);
      } catch {
        stamp = null; // presence outage must never block a send (house rule)
      }
    }
    if (stamp?.scope === 'fleet-members') {
      throw new FleetScopedBroadcastRefusedError(stamp);
    }
    if (stamp && !(opts.extra && CUE_AUTHORITY_FIELD in opts.extra)) {
      opts = { ...opts, extra: { ...opts.extra, [CUE_AUTHORITY_FIELD]: stamp } };
    }
  }
  const env: CoordEnvelope = {
    ts: new Date().toISOString(),
    msg_id: opts.msgId ?? newMsgId(),
    from: identity.ownerId,
    to,
    kind: opts.kind ?? 'message',
  };
  if (audienceKey.length) env.audience = audienceKey;
  if (opts.summary !== undefined) env.summary = opts.summary;
  if (opts.bodyWithMsgId !== undefined) {
    env.body = opts.bodyWithMsgId(env.msg_id);
  } else if (opts.body !== undefined) {
    env.body = opts.body;
  }
  if (opts.category !== undefined) env.category = opts.category;
  if (opts.files !== undefined) env.files = opts.files;
  if (opts.plan_slug !== undefined) env.plan_slug = opts.plan_slug;
  if (opts.related_msg_id !== undefined) env.related_msg_id = opts.related_msg_id;
  if (opts.expectsReply !== undefined) env.expectsReply = opts.expectsReply;
  // Canonical snake_case envelope field (matches plan_slug/msg_id/related_msg_id
  // and the coord_event_log.harness_slug column PgCoordLog projects it to for
  // federation — distributed-coordination-shared-harness-2026-06-04 Track A).
  if (typeof opts.harnessSlug === 'string') {
    env.harness_slug = opts.harnessSlug;
  } else if (opts.harnessSlug === undefined) {
    // WI-3653 AUTO-stamp (see SendOptions.harnessSlug): an un-scoped writer in a
    // workspace with EXACTLY ONE shared Hive stamps that Hive's home so the
    // message federates; none/many → machine-local (byte-identical to before).
    // Fail-soft: a resolver error means "no shared hive visible here" — it must
    // never block the send. `null` (explicit scope:'local') skips this entirely.
    try {
      const ws = identity.workspaceId ?? coordWorkspaceId();
      if (ws && ws !== '*') {
        const resolved = await resolveWorkspaceHiveScope(ws);
        if (resolved.kind === 'one') env.harness_slug = resolved.homeSlug;
      }
    } catch {
      /* stay machine-local */
    }
  }
  // Merge caller-supplied extra keys LAST, but never let them clobber the
  // reserved envelope fields (identity + addressing integrity).
  if (opts.extra) {
    const RESERVED = new Set(['ts', 'msg_id', 'from', 'to', 'kind']);
    for (const [k, v] of Object.entries(opts.extra)) {
      if (!RESERVED.has(k) && v !== undefined) env[k] = v;
    }
  }
  // WI-4537: AUTO-stamp `auto: true` when the SENDER is a machine identity (a watchdog, sweep,
  // monitor, digest, the work-item event emitter…). `auto` already existed as the "this is robot
  // lifecycle chatter, not a peer talking to you" marker, but it was set by hand and MOST machine
  // emitters never set it — so `unanswered_directed`, the counter wired to PREEMPT an agent's
  // work, was firing on robot mail (~490 of 2791 unanswered rows came from synthetic senders that
  // cannot read a reply; `system:delivery-ladder`, whose whole job is to nag you about unread
  // directed mail, was itself generating unread directed mail).
  //
  // Stamping HERE — at the one chokepoint every send passes through — instead of hand-patching
  // each emitter is what makes it durable: the next watchdog anyone writes is flagged for free
  // and cannot silently re-pollute the signal. An explicit `extra.auto` from the caller always
  // wins (never override a deliberate stamp — including a deliberate `auto: false`).
  if (env.auto === undefined && isMachineAuthoredSender(identity.ownerId)) {
    env.auto = true;
  }
  // D-095: the same stamp for system code emitting under a BORROWED AGENT
  // IDENTITY — library code running inside an agent's tool call that passes that
  // agent's ownerId straight through to this seam. No name-based pattern can see
  // it (`from` IS a real agent), so this one asks the ENVELOPE: `coord:send`
  // requires `expects`, therefore an agent-session sender with NO `expects` did
  // not come through the agent-callable tool and is not hand-authored.
  //
  // Placed BEFORE the `expects` stamp below on purpose — setting `auto` here is
  // what makes that block's `env.auto === true` leg fire, so these rows get the
  // same `expects:'none'` + `system-emitter-derived` provenance as every other
  // machine emission instead of a second, parallel rule.
  //
  // Measured 36h before shipping: 36 messages, every one a lifecycle notice
  // (fleet-scope admission blocks, take-leadership demotions, a fed-event probe,
  // a typed control cue) — each counted as hand-authored prose in the P-001
  // adoption denominator AND as directed mail awaiting a peer's answer. An
  // explicit caller `auto` still wins, exactly as above.
  if (
    env.auto === undefined &&
    isSystemEmissionUnderAgentIdentity(identity.ownerId, env.expects !== undefined)
  ) {
    env.auto = true;
  }
  // P-033 (d) / D-072: the ~25 SYSTEM emitters (service-health, severe-event,
  // agent-governor, boot-migrate, the sweeps…) call this seam directly, so they
  // never pass through the coord:send tool that requires `expects`. Their intent
  // is never in doubt — a watchdog broadcast wants nothing back — so it is
  // stamped here rather than hand-patched into every emitter, for exactly the
  // reason the `auto` stamp above is: the next watchdog anyone writes is covered
  // for free and cannot silently re-pollute the signal.
  //
  // ⚠ `expects:'none'` and NOTHING ELSE (D-072 §4). A system broadcast has no
  // model of its receiver, so it gets no `forYouBecause`, no `premises`, no
  // `youMayNotKnow` — inventing them would be the fill-rate theatre D-064 warns
  // about, on the highest-volume traffic in the system.
  //
  // The value is DERIVED, so it is STAMPED as derived: adoption measurement must
  // not count a machine default as sender intent. An explicit caller value always
  // wins, so the coord:send tool (which sets `expects` itself) is untouched.
  //
  // ⚠ TWO SIGNALS, NOT ONE — `isMachineAuthoredSender` ALONE SILENTLY MISSES
  // MOST EMITTERS. Its pattern is conservative on purpose (a false positive
  // would silence the human `pc-admin-coord-ui`), so it matches `system-watchdog`
  // and `system:operator-directive` but NOT `service-health`, `rate-governor`,
  // `boot-migrate` or `hive-owner-key-health`. Keying only on it would look like
  // a one-seam fix while covering a third of the traffic. `auto === true` is the
  // other canonical machine marker (set explicitly by coord:emit's lifecycle
  // sends and by the stamp directly above), so the two together cover the real
  // population. Widening the shared MACHINE_SENDER_PATTERN itself is deliberately
  // NOT done here: it is embedded verbatim in unanswered-directed's SQL, so
  // changing it also changes which historical rows count as unanswered — a
  // separate change with its own measurement, not a side effect of this one.
  // WI-6768: the two signals above were MEASURED insufficient — 36h after they went
  // live, 845 of 2,013 messages (42%) still carried no `expects`, 97% of them from six
  // named process emitters matching neither. `isMachineEmitterForStamping` adds those
  // as a THIRD, stamp-only signal (see machine-authored.ts for why it is a separate
  // pattern and not a widening of the SQL-embedded one).
  if (env.expects === undefined && (isMachineEmitterForStamping(identity.ownerId) || env.auto === true)) {
    env.expects = 'none';
    const existing = (env.fieldProvenance ?? {}) as Record<string, unknown>;
    env.fieldProvenance = { ...existing, expects: 'system-emitter-derived' };
  }
  // P-005 / D-097: `plan_slug` is DERIVABLE, not authored. The sender already
  // told the system its plan at `coord:orient { planSlug }`; measured 24h,
  // 2026-08-03: of 343 hand-authored sends, 228 came from a sender with a
  // declared plan lane and only 12 carried the field — 216 missing across 24
  // DISTINCT senders, so a plan-scoped `coord:feed { plan_slug }` was reading
  // ~5% of its plan's traffic and presenting it as the whole. See
  // ./derived-plan-slug for why this field qualifies where `current_files` does
  // not (stamp what is FIXED AT WRITE TIME; derive at read what is LIVE).
  //
  // ⚠ MUST RUN AFTER THE TWO `auto` STAMPS ABOVE — `shouldDerivePlanSlug` reads
  // `env.auto` to exclude D-095's system-code-under-a-borrowed-agent-identity
  // population, which matches the agent-session shape by construction. Hoist it
  // above them and a lifecycle notice inherits the calling agent's plan.
  if (shouldDerivePlanSlug({ explicitPlanSlug: env.plan_slug, auto: env.auto, from: identity.ownerId })) {
    // ⚠ DYNAMIC IMPORT, DELIBERATELY (EI-19281789650149592). A STATIC import of
    // `./presence` from this hot path transitively reaches `presence-wakeability`,
    // whose module-scope `const LIVE_TURN_WINDOW_MS = PRESENCE_STALE_MS` turns any
    // suite that PARTIALLY mocks `../presence` into a collection failure naming a
    // constant this change never mentions — 95 tests went uncollectable that way on
    // 2026-08-01. That filing notes the class has no lint guard yet, only "tribal
    // memory", and prescribes exactly this. Same remedy as coupling-divergence-stamp.
    const slug = await derivePlanSlug({
      ownerId: identity.ownerId,
      readPlanSlug: async (id) => (await (await import('./presence')).getPresence(id))?.currentPlanSlug ?? null,
    });
    if (slug) {
      env.plan_slug = slug;
      const existing = (env.fieldProvenance ?? {}) as Record<string, unknown>;
      env.fieldProvenance = { ...existing, plan_slug: PLAN_SLUG_DERIVED_PROVENANCE };
    }
  }
  // coord-derived-fields-2026-08-31 D-002: `why.goalRef` is DERIVABLE, not
  // authored. Measured 24h, 2026-08-31: 1,635 of 2,755 hand-authored sends
  // omitted `why`, and 1,563 of those (95.6%) came from a sender whose goal_ref
  // was stamped on tool_invocations that same hour — 151 distinct senders. Same
  // tier-1 auto-stamp as plan_slug above; see ./derived-why-goal for the full
  // qualification (fixed at write time; absence is ambiguous; explicit wins;
  // the stamp is a last-write-wins DEFAULT, which is why provenance is marked).
  //
  // ⚠ MUST RUN AFTER THE `auto` STAMPS, for the same reason plan_slug must —
  // shouldDeriveWhyGoal reads `env.auto` to exclude system code emitting under
  // a borrowed agent identity (D-095).
  if (shouldDeriveWhyGoal({ explicitWhy: env.why, auto: env.auto, from: identity.ownerId })) {
    // Static read — agent-state-stamp is ALREADY a static import of this module
    // (noteIntentDeclared above), so unlike derivePlanSlug's presence read there
    // is no new import-graph edge to keep dynamic. One Map.get, no I/O.
    const goalRef = await deriveWhyGoal({
      ownerId: identity.ownerId,
      readGoalRef: (id) => readAgentStateStamp(id).goalRef,
    });
    if (goalRef) {
      env.why = { goalRef };
      const existing = (env.fieldProvenance ?? {}) as Record<string, unknown>;
      env.fieldProvenance = { ...existing, why: WHY_GOAL_DERIVED_PROVENANCE };
    }
  }
  // Park the envelope durably for each addressed slot (./slot-parked-store) —
  // drained into the spawnee's handoff when an agent spawns into the slot (P-023).
  if (slots.length) {
    // Use the coord seam's handle + workspace (NOT getOrgPg()+'default') so the
    // parked rows live on the SAME DB/workspace as the coord messages this
    // sendMessage writes — a swapped seam (tests, non-default workspace) would
    // otherwise split them. Mirrors readAckedMsgIds.
    const sql = coordSql();
    const ws = coordWorkspaceId();
    const nowMs = Date.now();
    for (const slot of slots) {
      await parkSlotMessage(sql, { slot, harnessSlug: opts.harnessSlug ?? null, envelope: env, nowMs, workspaceId: ws });
    }
  }
  // Deliver to the live inbox when there's a live audience — or when there were
  // no slots at all (preserve the legacy "audience resolved to nobody still
  // persists the row" behaviour, ./audience D-004). A purely-slot send is
  // delivered by the park alone.
  let persistedEnv = env;
  let persistedSequence: number | null = null;
  if (liveAddrs.length > 0 || slots.length === 0) {
    // A caller-supplied msg_id is a producer's deterministic replay key (for
    // example, coord:send's MCP idempotency key). Claim that line atomically
    // and return the durable winner on replay: the transport may report an
    // outcome-unknown failure after the first write, so a retry must not add a
    // second message or return a freshly-built envelope that was never stored.
    //
    // Calls without an explicit msg_id intentionally retain append-only
    // semantics. In particular, appendAck uses this path so repeated acks stay
    // visible, and mailbox re-delivery below remains append-only.
    if (opts.msgId !== undefined) {
      const result = await coordLog.appendLineIfAbsent('messages', identity.ownerId, env);
      persistedEnv = result.envelope;
      persistedSequence = result.sequence;
    } else {
      persistedSequence = await coordLog.appendLine('messages', identity.ownerId, env);
    }
    // P-009 / D-011 / D-014: an INTENT declaration is the append-only record
    // `tool_invocations.intent_event_id` points at, and this is the only place
    // its row id is known. The `coord:declare-intent` handler cannot cache it —
    // the row is written AFTER the tool settles, by the lifecycle emit rule that
    // lands here (D-014 describes declare-intent as writing the row directly;
    // in the live code the emit rule does, one hop later).
    //
    // Deliberately NOT the presence row: `coord_presence.intent` is mutated in
    // place, so a pointer at it would name different content than it did when
    // stamped — the D-003 violation P-008(a) fixed for facts. The event log is
    // append-only, so this pointer is stable.
    //
    // `lifecycle` rides in `extra` (merged verbatim above), so it is read
    // structurally rather than off a declared envelope field.
    const lifecycle = (persistedEnv as { lifecycle?: unknown }).lifecycle;
    if (persistedSequence != null && typeof lifecycle === 'string' && lifecycle === 'intent') {
      noteIntentDeclared(identity.ownerId, persistedSequence);
    }
  }
  // Fleet DIGEST sidecar (fleet-delivery-override-mute-digest D-001): a `@fleet:`
  // broadcast's digest members were dropped from the live `to` (listFleetMembers), so
  // deliver each a terse `digest:true` notify (the inbox hook coalesces it). Best-effort,
  // side-effect only, guarded on a `@fleet:` selector — a normal send pays nothing.
  if (opts.to.some((t) => t.startsWith('@fleet:'))) {
    await deliverFleetDigests(opts.to, persistedEnv, persistedEnv.to).catch(() => {});
  }
  unresolvedAudienceByEnvelope.set(persistedEnv, unresolvedAudienceSelectors);
  unreachableAudienceByEnvelope.set(persistedEnv, unreachableAudienceSelectors);
  return persistedEnv;
}

/**
 * Append an ack for `targetMsgId`, addressed back to the message's
 * sender. The acker's own outbox is the writer.
 */
export async function appendAck(
  identity: AgentIdentity,
  targetMsgId: string,
  targetFrom: string,
  targetHarnessSlug?: string | null,
): Promise<CoordEnvelope> {
  return sendMessage(identity, {
    to: [targetFrom],
    kind: 'ack',
    related_msg_id: targetMsgId,
    // Inherit the target's federation scope. `null` is an explicit local
    // override; `undefined` preserves the historical AUTO resolution for
    // callers that only have the sender id.
    harnessSlug: targetHarnessSlug,
  });
}

/**
 * Append-only compensation for an acknowledgement. The original ack remains in
 * history; readAckedMsgIds folds this later event back to the unacknowledged
 * state for the same principal and target message.
 */
export async function appendUnack(
  identity: AgentIdentity,
  targetMsgId: string,
  targetFrom: string,
  targetHarnessSlug?: string | null,
  eventId?: string,
): Promise<CoordEnvelope> {
  return sendMessage(identity, {
    to: [targetFrom],
    kind: 'unack',
    related_msg_id: targetMsgId,
    harnessSlug: targetHarnessSlug,
    ...(eventId ? { msgId: eventId } : {}),
  });
}

/** WI-3825: skew-padded lower bound subtracted from `since_ts` before it is
 *  pushed into SQL as `ts >= …`. The row `ts` column is set via `DEFAULT
 *  now()` at INSERT time (monotonic with `id`) — a DIFFERENT field from
 *  `body->>'ts'`, the client-stamped envelope time `filterInbox` filters on,
 *  which can trail the DB insert under load/retries (or, under clock skew,
 *  even lead it). Live-verified divergence: >1s on 2,317 of 53,560 rows. This
 *  pad is a PRE-filter only — generous enough that no row `filterInbox` would
 *  keep (`body.ts > since_ts`) is ever pruned before it runs; `filterInbox`
 *  remains the authoritative, byte-identical final filter over the reduced
 *  set. 10 minutes comfortably covers any plausible insert-latency /
 *  clock-skew jitter while still giving the new `coord_event_log_messages_ts_idx`
 *  (migration 545) a highly selective range to seek on the dominant "since a
 *  few minutes/hours ago" polling pattern (orient / inbox-wake / dispatch). */
export const INBOX_SINCE_TS_SKEW_PAD_MS = 10 * 60_000;

/** Hard backstop on rows scanned per `readInbox` PG-fast-path call, applied
 *  even with NO `since_ts` (a full-history read) — a LIMIT is the one bound
 *  that is correct regardless of any ts/id skew question. Generously above
 *  the live-observed ~12.5k-rows-per-call figure so a normal read is never
 *  truncated; only a genuinely pathological full-history backlog is capped
 *  (and logged, never silently). */
export const INBOX_FAST_PATH_ROW_CAP = 25_000;

/**
 * Read everything addressed to `ownerId` (or to '*') across all outboxes.
 * Sorted by ts ascending; forgiving of malformed/missing files.
 *
 * coord:retract (WI-4176): messages a retraction notice withdraws are
 * SUPPRESSED here — the chokepoint every owner-scoped read rides (coord:inbox,
 * the [coord+N] injection, orient's inbox fold). Markers are collected from
 * the RAW pre-filter window (so a notice a kinds/since filter would drop still
 * suppresses its target); the notice row itself always survives. The notice is
 * addressed to the original audience, so any window containing the original
 * also contains the (newer) notice. coord:thread stays unsuppressed (forensics).
 */
export async function readInbox(
  ownerId: string,
  opts: InboxOptions = {},
  window?: CoordWindowSpec,
): Promise<CoordEnvelope[]> {
  // Recipient-pushdown fast path (fleet-concurrency-first P-003, round4 D-005):
  // readInbox is the dominant `coord_event_log` call — every agent fires it every
  // turn (always-armed inbox-wake + orient + manual coord:inbox). The old body
  // loaded the ENTIRE `messages` surface (~23K rows) through readLines and filtered
  // in JS, re-transferring + JSON-parsing + allocating every envelope on the
  // operator's single event loop per call — the round-3/4 "heavy work on one thread"
  // saturation, multiplied by fleet size. Push the inbox MEMBERSHIP predicate into
  // Postgres so only this owner's + broadcast rows come back. The SQL predicate is
  // exactly filterInbox's recipient+array conditions
  // (`Array.isArray(to) && (to.includes(ownerId) || to.includes('*'))`), and
  // filterInbox is STILL run as the final authority over the reduced set — so the
  // output is byte-identical to the full-scan path (it re-applies the recipient
  // check plus since/kinds/excludeOwn/sort). EI-401 precedent (readAckedMsgIds).
  //
  // WI-3825: that predicate alone was still an UNBOUNDED scan of the whole
  // `messages` surface (no since/id predicate, no LIMIT) — ~79h of cumulative
  // DB CPU, saturating the bg-host's PG pool and starving the substrate
  // outbox-drain. Two independent bounds, both safe:
  //   (a) when the caller passes `since_ts`, push a SKEW-PADDED `ts >= …`
  //       lower bound (INBOX_SINCE_TS_SKEW_PAD_MS) — a highly selective range
  //       the new coord_event_log_messages_ts_idx (migration 545) can seek on;
  //   (b) always cap rows scanned via LIMIT (INBOX_FAST_PATH_ROW_CAP) — the
  //       one bound that holds regardless of any ts/id skew question, so even
  //       a no-`since_ts` full-history read can never trigger an unbounded scan.
  // Both are PRE-filters only: `filterInbox` below remains the authoritative,
  // exact filter over the (now bounded) reduced set.
  //
  // ⚠ THE CAP'S ORDER IS LOAD-BEARING, AND IT MUST BE `id DESC` (EI-19314819320465915).
  // A LIMIT keeps the rows the ORDER BY puts FIRST, so `ORDER BY id ASC LIMIT n` keeps
  // the n OLDEST matching rows and silently discards the NEWEST — i.e. once an owner's
  // matching set exceeds the cap, their inbox freezes: they keep re-reading ancient mail
  // and never see anything new again. That is the worst possible failure mode for an
  // inbox, and it is SILENT (the read still returns a full, plausible 25k rows). `DESC`
  // keeps the newest instead, so the cap degrades by forgetting history — recoverable,
  // and what every caller actually wants.
  // This was latent, not academic: at the time of the fix the `to` array matched 20,365
  // broadcast rows (`to` containing '*') against a 25,000 cap — 81% of the way there,
  // growing ~150/day, so ~1 month of headroom fleet-wide.
  // SAFE because the SQL order is NOT the output order: `filterInbox` ends in
  // `.sort(compareByTsThenId)` (libs/generic/pubsub-substrate/src/core/inbox.ts), so it
  // re-sorts ascending by (ts, msg_id) regardless of what order the rows arrive in. The
  // ORDER BY therefore chooses only WHICH rows survive the cap, never how they are
  // presented. It also strictly improves `collectRetractedIds`, which reads the same
  // window: retractions skew recent, so keeping the newest rows keeps the retractions
  // that are actually still suppressing something.
  //
  // Gated on a true PG backend (coordHasPgFastPath): an in-memory/fs seam (tests)
  // keeps using readLines, since coordSql() would otherwise read getOrgPg() and miss
  // the swapped store. On PG a query error PROPAGATES: the full-surface read is not a
  // safe fallback there — it materialises the whole messages surface and pins it in
  // the process cache (~2 GB measured, host-memory-reduction-2026-09-27 D-011).
  if (coordHasPgFastPath()) {
    // WI-6939: a caller that only needs the most RECENT slice passes `window`, and
    // gets a bounded keyset-paged read instead of the 25k-row cap. Deliberately an
    // OPTION on this function rather than a second exported entry point: readInbox
    // is the seam every caller imports and every test mocks, and a parallel export
    // would force each of those mocks to stub two functions that must agree — a
    // divergence trap. One seam, one mock, same behaviour when `window` is absent.
    if (window) return (await readInboxWindow(ownerId, opts, window.enough)).entries;
    const sql = coordSql();
    const sinceBound = opts.since_ts
      ? new Date(new Date(opts.since_ts).getTime() - INBOX_SINCE_TS_SKEW_PAD_MS).toISOString()
      : null;
    const rows = await sql<{ body: unknown }[]>`
      SELECT body
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${coordWorkspaceId()}
         AND surface = 'messages'
         ${sinceBound ? sql`AND ts >= ${sinceBound}` : sql``}
         AND jsonb_typeof(body->'to') = 'array'
         -- Keep the native JSONB membership operator here: the partial
         -- coord_event_log_msgs_to_gin index can answer the native operator,
         -- while the semantically equivalent function-call spelling falls back to
         -- a parallel sequential scan of the whole messages surface.
         AND ((body->'to') ? ${ownerId} OR (body->'to') ? '*')
       ORDER BY id DESC
       LIMIT ${INBOX_FAST_PATH_ROW_CAP}
    `;
    if (rows.length >= INBOX_FAST_PATH_ROW_CAP) {
      console.warn(
        `[readInbox] fast-path row cap (${INBOX_FAST_PATH_ROW_CAP}) hit for owner=${ownerId} ` +
          `since_ts=${opts.since_ts ?? '(none)'} — the OLDEST matching rows beyond the cap were NOT ` +
          'returned; a caller doing a genuine full-history backfill should page via since_ts.',
      );
    }
    const lines = rows.map((r) => (typeof r.body === 'string' ? JSON.parse(r.body) : r.body) as CoordEnvelope);
    return suppressRetracted(filterInbox(lines, ownerId, opts), collectRetractedIds(lines));
  }
  const lines = await coordLog.readLines('messages');
  return suppressRetracted(filterInbox(lines, ownerId, opts), collectRetractedIds(lines));
}

/** Rows fetched per keyset page by {@link readInboxWindow}. Sized so a normal
 *  read is satisfied by ONE page while transferring ~20x less than the
 *  unbounded read it replaces. */
export const INBOX_PAGE_ROWS = 1_000;

/** Safety stop on pages walked by one {@link readInboxWindow} call.
 *  INBOX_PAGE_ROWS * INBOX_MAX_PAGES is deliberately >= INBOX_FAST_PATH_ROW_CAP,
 *  so a bounded read can never reach LESS history than the capped full read. */
export const INBOX_MAX_PAGES = 25;

/** Opt a `readInbox` or `readOutbox` call into the bounded keyset-paged read
 *  (WI-6939 built it for the inbox; EI-19323045109346905 extended it to the
 *  outbox). Named for the coord log rather than the inbox because BOTH
 *  directions page the same table on the same loop — only the match predicate
 *  and the visibility projection differ. */
export interface CoordWindowSpec {
  /** The CALLER's stopping rule, over the envelopes visible so far. Paging stops
   *  when this returns true or history is exhausted. It lives with the caller
   *  because the selective filters do (see {@link readInboxWindow}). */
  enough: (entries: CoordEnvelope[]) => boolean;
}

export interface CoordWindowResult {
  /** Filtered + retraction-suppressed envelopes, ascending by (ts, msg_id). */
  entries: CoordEnvelope[];
  /** True when paging reached the end of this owner's matching history. */
  exhausted: boolean;
  /** Raw rows actually transferred across all pages (the cost paid). */
  rowsScanned: number;
  /** Pages issued. */
  pages: number;
}

/**
 * The keyset pager both windowed reads share — newest-first over
 * `coord_event_log`, stopping when the caller is satisfied or history runs out.
 *
 * EXTRACTED rather than copied (EI-19323045109346905). The inbox and outbox
 * windows differ in exactly two places — the row-match predicate and how raw
 * rows project to VISIBLE envelopes — and everything else (the `id < beforeId`
 * cursor, the short-page exhaustion test, the page budget, the skew-padded
 * `since_ts` bound, the fail-soft warn) is subtle enough that a second copy
 * would drift. In particular the "evaluate `enough` on VISIBLE entries, never
 * raw rows" rule is the whole correctness argument for the under-fill hazard,
 * and it is the first thing a copy gets wrong.
 *
 * `satisfied` receives the accumulated RAW rows and is expected to project them
 * itself, because only the caller knows what "visible" means for its direction.
 */
async function pageCoordEventLogDesc(params: {
  /** Direction-specific row match, e.g. recipient-pushdown or `from = owner`.
   *  Returns a postgres FRAGMENT (`postgres.Fragment` = `PendingQuery<any>`), not
   *  `unknown`: the result is interpolated straight into the tagged template below,
   *  whose parameters are typed `ParameterOrFragment<…>`. Typing it `unknown` did
   *  compile at the definition but broke the CALL SITE with a TS2345, and cascaded
   *  into a confusing TS1320 ("await operand must be a valid promise") on the query
   *  itself — which reads like a bug in the await, not in this annotation. */
  match: (sql: ReturnType<typeof coordSql>) => postgres.Fragment;
  /** Skew-padded lower bound, or null for no bound. */
  sinceBound: string | null;
  /** Caller's stopping rule over the accumulated raw rows. */
  satisfied: (raw: CoordEnvelope[]) => boolean;
}): Promise<{ raw: CoordEnvelope[]; exhausted: boolean; pages: number }> {
  const { match, sinceBound, satisfied } = params;
  const raw: CoordEnvelope[] = [];
  let beforeId: string | number | null = null;
  let pages = 0;
  let exhausted = false;
  const sql = coordSql();
  while (pages < INBOX_MAX_PAGES) {
    // Explicit annotation: `beforeId` is assigned FROM `rows` and then read back
    // into the next iteration's query, which TS otherwise flags as circular (TS7022).
    const rows: { id: string | number; body: unknown }[] = await sql<
      { id: string | number; body: unknown }[]
    >`
      SELECT id, body
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${coordWorkspaceId()}
         AND surface = 'messages'
         ${sinceBound ? sql`AND ts >= ${sinceBound}` : sql``}
         ${beforeId !== null ? sql`AND id < ${beforeId}` : sql``}
         ${match(sql)}
       ORDER BY id DESC
       LIMIT ${INBOX_PAGE_ROWS}
    `;
    pages += 1;
    for (const r of rows) {
      raw.push((typeof r.body === 'string' ? JSON.parse(r.body) : r.body) as CoordEnvelope);
    }
    // A short page means we reached the end of this owner's matching history.
    if (rows.length < INBOX_PAGE_ROWS) {
      exhausted = true;
      break;
    }
    beforeId = rows[rows.length - 1]!.id;
    if (satisfied(raw)) break;
  }
  return { raw, exhausted, pages };
}

/**
 * Never truncate silently. Running out of page budget without satisfying the
 * caller means older matching rows exist that this read did NOT return — the
 * same failure shape as the row cap (EI-19314819320465915), and the caller only
 * sees `entries`, so without this the shortfall is invisible. `exhausted:false`
 * is the machine-readable form; this is the one a human debugging a short
 * mailbox will actually see.
 */
function warnOnPageBudgetExhausted(
  label: string,
  ownerId: string,
  sinceTs: string | undefined,
  exhausted: boolean,
  pages: number,
  rowsScanned: number,
): void {
  if (exhausted || pages < INBOX_MAX_PAGES) return;
  console.warn(
    `[${label}] page budget (${INBOX_MAX_PAGES} x ${INBOX_PAGE_ROWS}) exhausted for ` +
      `owner=${ownerId} since_ts=${sinceTs ?? '(none)'} without satisfying the caller's ` +
      `stopping rule — matching rows OLDER than the ${rowsScanned} read were NOT returned; ` +
      'page via since_ts for a genuine full-history backfill.',
  );
}

/**
 * Bounded, keyset-paged inbox read — the cheap alternative to `readInbox` for a
 * caller that only needs the most RECENT slice.
 *
 * WHY (WI-6939). `readInbox`'s fast path is one `LIMIT 25000` query, and for a
 * typical owner it matches ~20.4k rows of which **99.8% are broadcasts** (`to`
 * containing `'*'`) — the matched set is essentially independent of how much
 * mail the caller actually has. Measured on the live box: 491,954 calls of the
 * no-`since_ts` shape, 220ms mean, 18,151 rows/call, **30.1 hours** cumulative
 * DB time; each call seq-scans the table, sorts ~20k rows and launches 3 extra
 * parallel workers. The `since_ts` shape of the same query costs 11.6ms — a 20x
 * gap that is entirely explained by the window, not the predicate.
 *
 * WHY THE CALLER SUPPLIES `enough` RATHER THAN A ROW LIMIT. A bare `LIMIT n` is
 * NOT sound here, and the reason is not the one that looks obvious. Pushing
 * `filterInbox`'s own options down (excludeOwn/kinds) would shrink the set by
 * **0.08%** — measured — because broadcasts pass all of them. The genuinely
 * selective filters live ABOVE this function, in the caller: a live `coord:inbox`
 * read excludes 7,651 ambient broadcasts and coalesces 11,564 repeats out of
 * ~20k. So a small `LIMIT` really can return a page that filters down to almost
 * nothing — via the caller's rules, which this function cannot see. Letting the
 * caller decide when it has enough is what makes the bound correct instead of
 * merely probable; it pages backwards until satisfied or history runs out.
 *
 * RETRACTION MARKERS STAY CORRECT, for a reason specific to newest-first paging:
 * a retraction notice is always NEWER than the message it retracts and is
 * addressed to the same audience, so any newest-first window containing a target
 * necessarily also contains its notice. Markers are collected over the ACCUMULATED
 * raw window (every page fetched so far), preserving `collectRetractedIds`'
 * pre-filter contract. A separate marker query would be both unnecessary and a
 * new seq scan.
 *
 * Falls back to the authoritative `readInbox` on a non-PG seam or any query error.
 */
export async function readInboxWindow(
  ownerId: string,
  opts: InboxOptions = {},
  enough: (entries: CoordEnvelope[]) => boolean = () => false,
): Promise<CoordWindowResult> {
  if (!coordHasPgFastPath()) {
    const entries = await readInbox(ownerId, opts);
    return { entries, exhausted: true, rowsScanned: entries.length, pages: 1 };
  }
  const sinceBound = opts.since_ts
    ? new Date(new Date(opts.since_ts).getTime() - INBOX_SINCE_TS_SKEW_PAD_MS).toISOString()
    : null;
  const visible = (raw: CoordEnvelope[]): CoordEnvelope[] =>
    suppressRetracted(filterInbox(raw, ownerId, opts), collectRetractedIds(raw));
  let pages = 0;
  try {
    const paged = await pageCoordEventLogDesc({
      sinceBound,
      match: (sql) => sql`
        -- Same GIN-backed spelling as the single-shot path above. The ts/id
        -- keyset bounds reduce the candidate range; the native operator keeps recipient
        -- membership indexable inside that range.
        AND jsonb_typeof(body->'to') = 'array'
        AND ((body->'to') ? ${ownerId} OR (body->'to') ? '*')
      `,
      satisfied: (raw) => enough(visible(raw)),
    });
    pages = paged.pages;
    warnOnPageBudgetExhausted(
      'readInboxWindow',
      ownerId,
      opts.since_ts,
      paged.exhausted,
      paged.pages,
      paged.raw.length,
    );
    return {
      entries: visible(paged.raw),
      exhausted: paged.exhausted,
      rowsScanned: paged.raw.length,
      pages: paged.pages,
    };
  } catch (err) {
    // Any query error falls back to the authoritative full read. WI-1338374: that
    // fallback is `readInbox(ownerId, opts)` — a 2-ARG call, so it hits the SAME
    // no-since_ts `LIMIT 25000` unbounded fast-path query this window form exists
    // to avoid (messages.ts's top-level readInbox, coord_event_log queryid
    // 6351213335932394379 — the query WI-1338374 measured at 32k calls/10 days).
    // Under load, a page failing partway through pageCoordEventLogDesc's own
    // up-to-25-sequential-round-trip loop is plausible, and the fallback then
    // amplifies the load with the single MOST expensive query in this file — a
    // vicious-cycle candidate. Log it so a future occurrence is ATTRIBUTABLE
    // (grep for this tag) instead of requiring the same code trace again.
    console.warn(
      `[readInboxWindow] pageCoordEventLogDesc threw for owner=${ownerId} ` +
        `since_ts=${opts.since_ts ?? '(none)'} pagesCompleted=${pages} — falling back to the ` +
        `UNBOUNDED readInbox fast path (no since_ts, LIMIT ${INBOX_FAST_PATH_ROW_CAP}). ` +
        `error=${err instanceof Error ? err.message : String(err)}`,
    );
    const entries = await readInbox(ownerId, opts);
    return { entries, exhausted: true, rowsScanned: entries.length, pages };
  }
}

/**
 * Deliver any `@user:`-parked messages waiting for a returning member into their
 * live inbox — the offline-member-assign mailbox (shared-hive-collaboration P-016).
 *
 * An assignment to an absent member is parked under `@user:<actorUserKey>`
 * (slot-parked-store) and writes NO coord_event_log row (a purely-slot send is
 * delivered by the park alone — see sendMessage). When that member's session
 * RETURNS, this drains (claim-once) every pending row matching one of their
 * candidate `keys` (actorMailboxKeys) and re-appends each envelope to the message
 * log addressed to their live `ownerId`, so it surfaces as a normal inbox card —
 * the same envelope, so the original assigner (`from`) + summary/body/plan_slug are
 * preserved. The claim-once UPDATE makes a second session a no-op, so re-delivery
 * is never a duplicate. Returns the delivered envelopes (the caller may fire an
 * optimistic inbox-wake on a presence-arrival edge).
 *
 * This is the `@user:` analog of the spawn-path deliver-on-spawn (P-023) — same
 * store, a presence/inbox-read trigger instead of a spawn trigger.
 */
export async function drainAndDeliverUserMailbox(
  keys: readonly string[],
  ownerId: string,
): Promise<CoordEnvelope[]> {
  if (!ownerId || keys.length === 0) return [];
  const sql = coordSql();
  const ws = coordWorkspaceId();
  const drained = await drainUserMailbox(sql, {
    keys,
    toOwner: ownerId,
    nowMs: Date.now(),
    workspaceId: ws,
  });
  for (const env of drained) {
    await coordLog.appendLine('messages', env.from, { ...env, to: [ownerId] });
  }
  return drained;
}

/**
 * Msg-ids that `ackerOwnerId` has acknowledged — the `related_msg_id` of every
 * `ack` envelope THEY authored. Acks were always written (appendAck) but never
 * folded out of any view, so a coord-message inbox "Acknowledge" had no visible
 * effect. The Planning inbox uses this to dismiss acked messages.
 *
 * SECURITY: scoped to the acker's own acks (`l.from === ackerOwnerId`) — never
 * global. A global set would let ANY agent's ack of a broadcast (to:['*'])
 * suppress that message from the human's inbox even though the human never
 * acked it (visibility suppression). Callers pass the principal whose inbox is
 * being rendered, so only that principal's own acks dismiss their view.
 *
 * Optimized to query database directly (EI-401): avoid loading all messages
 * when table is large; use a narrow ack/unack + author filter at DB level and
 * fold in append order. Gated like readInbox: on a PG backend a query error
 * PROPAGATES (never the whole-surface read — D-011); only a non-PG seam folds
 * the seam's own readLines.
 */
export async function readAckedMsgIds(ackerOwnerId: string): Promise<Set<string>> {
  const acked = new Set<string>();
  if (!ackerOwnerId) return acked;
  if (coordHasPgFastPath()) {
    // Run on the SAME handle + workspace the coordLog seam reads/writes (NOT
    // getOrgPg()+'default'): the acks were written through the seam, so a swapped
    // seam (tests, non-default workspace) would otherwise query the wrong DB /
    // scope and find nothing. Matches readInbox exactly.
    const sql = coordSql();
    const rows = await sql<{ kind: string | null; related_msg_id: string | null }[]>`
      SELECT body->>'kind' AS kind, body->>'related_msg_id' AS related_msg_id
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${coordWorkspaceId()}
         AND surface = 'messages'
         AND body->>'kind' = ANY (ARRAY['ack', 'unack'])
         AND body->>'from' = ${ackerOwnerId}
       ORDER BY id ASC
    `;
    for (const row of rows) {
      if (typeof row.related_msg_id === 'string') {
        if (row.kind === 'unack') acked.delete(row.related_msg_id);
        else if (row.kind === 'ack') acked.add(row.related_msg_id);
      }
    }
    return acked;
  }
  const lines = await coordLog.readLines('messages');
  for (const l of lines) {
    if (l.from === ackerOwnerId && typeof l.related_msg_id === 'string') {
      if (l.kind === 'unack') acked.delete(l.related_msg_id);
      else if (l.kind === 'ack') acked.add(l.related_msg_id);
    }
  }
  return acked;
}

/**
 * EI-18676763837940562 (redundant-inbox-wake-suppression, reply-linkage leg): which of
 * `msgIds` has `subscriberId` ALREADY REPLIED to — i.e. sent ANY message (not just an
 * `ack`) whose `related_msg_id` is one of them? A reply is unambiguous proof the recipient
 * discharged that specific message THEMSELVES (unlike the read-cursor check in
 * `isInboxWakeGroupRedundant`, which only proves the message predates their last inbox
 * poll) — the wake-pump's redundant-inbox-wake suppression uses this as a SECOND,
 * independent discharge signal for the one case its read-cursor check cannot see: a
 * subscriber who read + replied via the SAME turn a queued wake delivery lands after
 * (the reply's `related_msg_id` is set at reply time, before the read-cursor watermark this
 * batch would otherwise need to have observed the read moved past).
 *
 * Mirrors `readAckedMsgIds`'s scoping (own-sends only — never a global reply set, which
 * would let a THIRD party's reply to a broadcast wrongly suppress someone else's still-due
 * wake) and its PG-gated shape: a query error PROPAGATES on PG (D-011; the wake-pump caller
 * already fails open on a rejection), and only a non-PG seam scans its own readLines.
 * Bounded to the given `msgIds` (never a full-log scan) — cheap even when called on every
 * pump tick.
 */
export async function repliedMsgIdsBatch(subscriberId: string, msgIds: readonly string[]): Promise<Set<string>> {
  const replied = new Set<string>();
  if (!subscriberId || msgIds.length === 0) return replied;
  const ids = [...new Set(msgIds)];
  if (coordHasPgFastPath()) {
    const sql = coordSql();
    const rows = await sql<{ related_msg_id: string | null }[]>`
      SELECT body->>'related_msg_id' AS related_msg_id
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${coordWorkspaceId()}
         AND surface = 'messages'
         AND body->>'from' = ${subscriberId}
         -- WI-8806: REQUIRED for the planner to use coord_event_log_related_msg_id_idx,
         -- which is PARTIAL on the key-presence test. It reads as redundant beside the
         -- equality below (a missing key makes body->>... NULL, and NULL matches no
         -- = ANY) and that is exactly why it keeps getting deleted as noise -- but it is
         -- load-bearing for the PLAN: without it this becomes a Parallel Seq Scan of the
         -- whole table. Measured 40,717 -> 113 buffers, 111.6ms -> 2.4ms, on a query this
         -- file's own header notes runs on every wake-pump tick.
         AND body ? 'related_msg_id'
         AND body->>'related_msg_id' = ANY(${ids})
    `;
    for (const row of rows) {
      if (typeof row.related_msg_id === 'string') replied.add(row.related_msg_id);
    }
    return replied;
  }
  const lines = await coordLog.readLines('messages');
  const idSet = new Set(ids);
  for (const l of lines) {
    if (l.from === subscriberId && typeof l.related_msg_id === 'string' && idSet.has(l.related_msg_id)) {
      replied.add(l.related_msg_id);
    }
  }
  return replied;
}

/** Hard backstop on rows scanned per `readOutbox` PG-fast-path call, applied
 *  even with NO `since_ts` (a full-history read) — the one bound that is
 *  correct regardless of any ts/id skew question. Sized generously above the
 *  live-observed busiest single sender (11,739 rows on 2026-08-02, against a
 *  173-row p99) so a normal read is never truncated; only a pathological
 *  backlog is capped, and then loudly. Mirrors INBOX_FAST_PATH_ROW_CAP. */
export const OUTBOX_FAST_PATH_ROW_CAP = 25_000;

/**
 * The authoritative outbox filter + sort. Deliberately shared by BOTH read
 * paths below so the bounded PG pre-filter can never drift from the fallback:
 * the SQL only chooses which rows are FETCHED, this decides what is RETURNED.
 *
 * `!sinceMs` covers 0 (no `since_ts`) AND NaN (an unparseable one) — an invalid
 * timestamp degrades to "no lower bound", which is the pre-existing behaviour.
 */
function filterOutbox(
  lines: readonly CoordEnvelope[],
  ownerId: string,
  sinceMs: number,
): CoordEnvelope[] {
  return lines
    .filter((l) => l.from === ownerId)
    .filter((l) => !sinceMs || new Date(l.ts).getTime() > sinceMs)
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.msg_id.localeCompare(b.msg_id));
}

/**
 * Read everything `ownerId` SENT — every envelope whose `from === ownerId`,
 * across the whole message log. The outbox half of the per-bee mail view
 * (pui-bee-dossier-pane-2026-06-06). Sorted by ts ascending; `since_ts` filters
 * strictly later than the given ISO timestamp.
 *
 * SENDER-PUSHDOWN FAST PATH (EI-19323734935411369). This was the last PRIMARY
 * (non-catch-fallback) caller of the unbounded `coordLog.readLines('messages')`
 * IN THIS FILE — `adv-agent-detail.ts`'s `getAgentCoordState` also called it
 * unconditionally (see {@link readInvolvingOwner} below, fixed the same wake).
 * It loaded the ENTIRE messages surface and filtered in JS, which on
 * 2026-08-02 measured **76,209 rows / 63 MB of JSONB bodies transferred and
 * JSON-parsed on the operator's single event loop, per call**. Across the
 * 349,842 logged calls that unbounded shape returned 9.7 BILLION rows and
 * absorbed ~55h of DB time on a 59 MB table — a top contributor to the
 * saturation behind the WI-6739 data-plane stalls.
 *
 * Both bounds mirror `readInbox` exactly:
 *   (a) `since_ts` (which every routine caller already passes, only to apply it
 *       in JS afterwards) becomes a SKEW-PADDED `ts >= …` lower bound the
 *       coord_event_log_messages_ts_idx (migration 545) seeks on;
 *   (b) a LIMIT always caps rows scanned, so the one caller that passes no
 *       `since_ts` (sync-resolver's cupMail fold) is bounded too.
 *
 * Measured after: 438ms/76,209 rows/63 MB → 82ms/48 rows/51 KB without
 * `since_ts`, 3ms/8 rows/3.4 KB with it. Deliberately NO new index: the
 * worst case (an owner who has sent nothing, so the LIMIT never fills) still
 * lands at 76ms, and the caught stalls showed ZERO lock contention — the cost
 * was row volume, not seek time, so bounding rows is the fix and an index
 * would only add write amplification to a hot append-only table.
 *
 * ⚠ THE CAP'S ORDER MUST BE `id DESC` (EI-19314819320465915, learned on the
 * inbox side): `ORDER BY id ASC LIMIT n` keeps the n OLDEST rows and silently
 * discards the newest, freezing the view once a sender exceeds the cap. `DESC`
 * degrades by forgetting history instead. Safe because the SQL order is NOT the
 * output order — `filterOutbox` re-sorts ascending by (ts, msg_id) regardless.
 */
export async function readOutbox(
  ownerId: string,
  opts: { since_ts?: string } = {},
  window?: CoordWindowSpec,
): Promise<CoordEnvelope[]> {
  const sinceMs = opts.since_ts ? new Date(opts.since_ts).getTime() : 0;
  // Gated on a true PG backend: an in-memory/fs seam (tests) keeps using
  // readLines, since coordSql() would otherwise read getOrgPg() and miss the
  // swapped store. On PG a query error PROPAGATES — never the whole-surface read
  // (host-memory-reduction-2026-09-27 D-011, see readInbox).
  if (coordHasPgFastPath()) {
    // EI-19323045109346905: a caller that only needs the newest slice pages a
    // bounded window instead of pulling the whole sender history. DELEGATES to
    // readOutboxWindow rather than inlining the pager, mirroring readInbox above
    // — same "one seam, one mock" property (this stays the function every caller
    // imports and every test mocks), and the two cannot drift because there is
    // only one implementation. A caller that also needs the BOUNDARY
    // (`exhausted`) calls readOutboxWindow directly; this shape discards it.
    if (window) return (await readOutboxWindow(ownerId, opts, window.enough)).entries;
    const sql = coordSql();
    // Only pad a FINITE, positive cutoff — new Date(NaN).toISOString() throws.
    const sinceBound =
      Number.isFinite(sinceMs) && sinceMs > 0
        ? new Date(sinceMs - INBOX_SINCE_TS_SKEW_PAD_MS).toISOString()
        : null;

    const rows = await sql<{ body: unknown }[]>`
      SELECT body
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${coordWorkspaceId()}
         AND surface = 'messages'
         ${sinceBound ? sql`AND ts >= ${sinceBound}` : sql``}
         AND body->>'from' = ${ownerId}
       ORDER BY id DESC
       LIMIT ${OUTBOX_FAST_PATH_ROW_CAP}
    `;
    if (rows.length >= OUTBOX_FAST_PATH_ROW_CAP) {
      console.warn(
        `[readOutbox] fast-path row cap (${OUTBOX_FAST_PATH_ROW_CAP}) hit for owner=${ownerId} ` +
          `since_ts=${opts.since_ts ?? '(none)'} — the OLDEST matching rows beyond the cap were NOT ` +
          'returned; a caller doing a genuine full-history backfill should page via since_ts.',
      );
    }
    const lines = rows.map(
      (r) => (typeof r.body === 'string' ? JSON.parse(r.body) : r.body) as CoordEnvelope,
    );
    return filterOutbox(lines, ownerId, sinceMs);
  }
  const lines = await coordLog.readLines('messages');
  return filterOutbox(lines, ownerId, sinceMs);
}

/**
 * Bounded, keyset-paged OUTBOX read — the sender-side twin of
 * {@link readInboxWindow}, and the form that reports the WINDOW BOUNDARY.
 *
 * WHY A SEPARATE EXPORT (EI-19340198432470691). `readOutbox(…, window)` already
 * pages, but its return type is `CoordEnvelope[]`, so it throws away
 * `exhausted`/`rowsScanned`/`pages`. A caller that reports a COUNT to someone
 * else needs `exhausted`: it is the only thing that distinguishes "this owner
 * has sent 48 messages" from "48 is merely where we stopped looking". Without
 * it a bounded count is not a smaller truth, it is a plausible falsehood — the
 * same silent-shortfall shape as the row cap (EI-19314819320465915). The array
 * form stays for callers that only want entries.
 *
 * The `enough` rule is POST-FILTER (evaluated on VISIBLE envelopes), and paging
 * is newest-first, so an early stop returns the NEWEST slice — which is what
 * every `tail(n)` caller wants. `filterOutbox` re-sorts ascending regardless.
 *
 * Note the asymmetry with the inbox: `from = owner` is already selective in
 * SQL, so this bounds a read-to-use RATIO (pulling a prolific sender's whole
 * history to render a tail) rather than the inbox's ~99.8%-broadcast scan.
 *
 * Falls back to the authoritative `readOutbox` on a non-PG seam or query error;
 * both fallbacks report `exhausted: true` because that read IS the full one.
 */
export async function readOutboxWindow(
  ownerId: string,
  opts: { since_ts?: string } = {},
  enough: (entries: CoordEnvelope[]) => boolean = () => false,
): Promise<CoordWindowResult> {
  if (!coordHasPgFastPath()) {
    const entries = await readOutbox(ownerId, opts);
    return { entries, exhausted: true, rowsScanned: entries.length, pages: 1 };
  }
  const sinceMs = opts.since_ts ? new Date(opts.since_ts).getTime() : 0;
  // Only pad a FINITE, positive cutoff — new Date(NaN).toISOString() throws.
  const sinceBound =
    Number.isFinite(sinceMs) && sinceMs > 0
      ? new Date(sinceMs - INBOX_SINCE_TS_SKEW_PAD_MS).toISOString()
      : null;
  const visible = (raw: CoordEnvelope[]): CoordEnvelope[] => filterOutbox(raw, ownerId, sinceMs);
  let pages = 0;
  try {
    const paged = await pageCoordEventLogDesc({
      sinceBound,
      match: (s) => s`AND body->>'from' = ${ownerId}`,
      satisfied: (raw) => enough(visible(raw)),
    });
    pages = paged.pages;
    warnOnPageBudgetExhausted(
      'readOutboxWindow',
      ownerId,
      opts.since_ts,
      paged.exhausted,
      paged.pages,
      paged.raw.length,
    );
    return {
      entries: visible(paged.raw),
      exhausted: paged.exhausted,
      rowsScanned: paged.raw.length,
      pages: paged.pages,
    };
  } catch (err) {
    // Any query error falls back to the authoritative full read — see the matching
    // instrumentation on readInboxWindow's catch block (WI-1338374) for why this
    // fallback is worth logging: it hits readOutbox's own unbounded no-since_ts
    // LIMIT-capped fast path, the same shape of query implicated there.
    console.warn(
      `[readOutboxWindow] pageCoordEventLogDesc threw for owner=${ownerId} ` +
        `since_ts=${opts.since_ts ?? '(none)'} pagesCompleted=${pages} — falling back to the ` +
        `UNBOUNDED readOutbox fast path (no since_ts, LIMIT ${OUTBOX_FAST_PATH_ROW_CAP}). ` +
        `error=${err instanceof Error ? err.message : String(err)}`,
    );
    const entries = await readOutbox(ownerId, opts);
    return { entries, exhausted: true, rowsScanned: entries.length, pages };
  }
}

/** Hard backstop on rows scanned per `readInvolvingOwner` PG-fast-path call —
 *  mirrors INBOX_FAST_PATH_ROW_CAP / OUTBOX_FAST_PATH_ROW_CAP. A normal
 *  per-agent dossier read is nowhere near this; only a pathological backlog
 *  is capped, and then loudly. */
export const INVOLVING_FAST_PATH_ROW_CAP = 25_000;

/**
 * Read every envelope "involving" `ownerId` — sent BY them, addressed TO them,
 * or broadcast (`to` containing `'*'`) — across the whole `messages` surface.
 * ALL kinds included (unlike `readInbox`, which defaults to EXCLUDING the
 * owner's own sends and non-directed `notify` kinds): this exists specifically
 * to replace `coordLog.readLines('messages')` at a call site that needs the
 * exact same "from OR to" union the unbounded read used to return, just
 * bounded — `adv-agent-detail.ts`'s `getAgentCoordState` (the per-agent
 * dossier's coord section: last-message + unread derivation for ONE owner).
 *
 * SENDER-OR-RECIPIENT PUSHDOWN (EI-19323734935411369, the getAgentCoordState
 * leg). `readOutbox`'s docstring above called itself "the last PRIMARY caller"
 * of the unbounded read — that missed this one: `getAgentCoordState` is called
 * unconditionally on every agent-dossier open/poll (`getAgentDetail`), so it
 * was unconditional PRIMARY traffic exactly like `readOutbox` was, not a rare
 * catch-fallback.
 *
 * ORDER BY id DESC + LIMIT, mirroring readInbox/readOutbox — the newest rows
 * survive the cap (EI-19314819320465915: `ASC` would keep the OLDEST rows and
 * silently freeze the view once an owner's involving-set exceeds the cap).
 * Safe here because the caller (`deriveCoordState`) re-sorts by ts rather than
 * trusting SQL order.
 *
 * Keep the recipient membership checks in PostgreSQL's native JSONB `?`
 * operator. `coord_event_log_msgs_to_gin` (migration 1053) can answer that
 * operator directly; the semantically equivalent `jsonb_exists(...)` spelling
 * degrades this OR into a parallel sequential scan on the live log.
 *
 * Uses `coordLog.readLines('messages')` only on a non-PG seam (tests); on PG a
 * query error PROPAGATES (host-memory-reduction-2026-09-27 D-011, see readInbox).
 */
export async function readInvolvingOwner(
  ownerId: string,
  limit: number = INVOLVING_FAST_PATH_ROW_CAP,
): Promise<CoordEnvelope[]> {
  if (coordHasPgFastPath()) {
    const sql = coordSql();
    const rows = await sql<{ body: unknown }[]>`
      SELECT body
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${coordWorkspaceId()}
         AND surface = 'messages'
         AND (
           body->>'from' = ${ownerId}
           OR (
             jsonb_typeof(body->'to') = 'array'
             AND ((body->'to') ? ${ownerId} OR (body->'to') ? '*')
           )
         )
       ORDER BY id DESC
       LIMIT ${limit}
    `;
    if (rows.length >= limit) {
      console.warn(
        `[readInvolvingOwner] fast-path row cap (${limit}) hit for owner=${ownerId} — the ` +
          'OLDEST matching rows beyond the cap were NOT returned.',
      );
    }
    return rows.map(
      (r) => (typeof r.body === 'string' ? JSON.parse(r.body) : r.body) as CoordEnvelope,
    );
  }
  return coordLog.readLines('messages');
}

/**
 * Look up a single message envelope by its `msg_id` (the `messages` surface).
 * Used by the wake-on-reply path (coord:send) to find the ORIGINAL message a
 * reply points at via `related_msg_id` — so a peer's reply can wake the original
 * sender. Returns null when no such message exists. Fail-soft at the call site:
 * a lookup miss/error must never block the send.
 *
 * WI-3832: previously called `coordLog.getEvent('messages', msgId)` — but
 * `messages` is a `LineSurface` (append-only, via `appendLine`/`readLines`), not
 * an `EventSurface` (single-record-per-id upsert, via `putEvent`/`getEvent` —
 * `handoffs`/`escalations` only). That was a real TS2345 compile error (`npx tsc
 * --noEmit` in packages/operator-core), AND a genuine runtime gap on the
 * in-memory/fs test backends (InMemoryCoordLog / FsCoordLog keep `lines` and
 * `events` as separate stores; nothing ever `putEvent`s a message, so
 * `getEvent('messages', …)` always returned null there) — only PgCoordLog's
 * `getEvent` happened to work by accident, since `handoffs`/`escalations`/
 * `messages` all share the one `coord_event_log` table and its `msg_id` column.
 * Implemented outside `EventSurface` rather than by widening it (which would let
 * `putEvent`/`putEvents` be miscalled on `messages` too — its ON CONFLICT target
 * is a partial index scoped to `handoffs`/`escalations` only, so a stray
 * `putEvent('messages', …)` would silently insert a duplicate row instead of
 * upserting). PG fast path mirrors readInbox's convention above and rides the
 * (workspace_id, msg_id) index a peer already landed on this same plan
 * (migration 543 — WI-3817 — built exactly for this `WHERE workspace_id = $1 AND
 * msg_id = $2` shape); the readLines fallback covers the test/dev backends
 * (small in-memory datasets, a scan is fine) and is now also the CORRECT
 * behavior there, not just the compiling one.
 *
 * WI-7297: the read itself now lives in `line-event-by-id.ts`, surface-
 * parameterised, so `plan-events` could get the same correct by-id lookup
 * without a second copy of this query. Behaviour here is unchanged.
 */
export async function getMessageById(msgId: string): Promise<CoordEnvelope | null> {
  return getLineEnvelopeById('messages', msgId);
}

/**
 * P-004 (agent-epistemics-2026-08-02, migration 732): has this message already
 * been corrected, and by what?
 *
 * Returns the correction's msg_id, or null when the message is current OR the
 * columns are not readable. NOTE those two collapse deliberately: a fail-open
 * null means "proceed with the supersession", and the worst case is a second
 * correction in a chain — strictly better than refusing a legitimate retraction
 * because a read hiccuped, since a blocked retraction leaves wrong information
 * standing.
 */
export async function getSupersededBy(msgId: string): Promise<string | null> {
  if (!msgId || !coordHasPgFastPath()) return null;
  try {
    const sql = coordSql();
    const rows = await sql<{ superseded_by_msg_id: string | null }[]>`
      SELECT superseded_by_msg_id
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${coordWorkspaceId()}
         AND surface = 'messages'
         AND msg_id = ${msgId}
       LIMIT 1
    `;
    return rows[0]?.superseded_by_msg_id ?? null;
  } catch {
    return null;
  }
}

/** One message's supersession marker: what replaced it, and when. */
export interface SupersessionMark {
  supersededBy: string;
  supersededAt: string | null;
}

/**
 * The subset of `msgIds` whose `coord_event_log` row was authored on a DIFFERENT
 * NODE (`origin = 'remote'` — "authored on a different node", the same column
 * `fleet:leader-brief` reads to explain why a federated work-item is not locally
 * claimable).
 *
 * Why the READ side needs this (EI-19493603840800478): a federated severe-event
 * names only a HARNESS SLUG — "git-sync FAULTING on papercusp" — and slugs are
 * IDENTICAL on every node. So a peer's alarm about ITS OWN install renders locally
 * as a claim about the tree the reader is standing in, and is locally
 * UNFALSIFIABLE: you check local state, find it healthy, and cannot distinguish
 * "already recovered" from "never was about this machine". Measured 2026-08-04:
 * every "git-sync FAULTING on papercusp" row back to 2026-07-17 is origin='remote'
 * while the local routine read last_error=NULL / wd_error_sweeps=0 — two agents in
 * a row mis-attributed it to a local cause, and the first attribution became a
 * filed (wrong) diagnosis.
 *
 * This cannot be fixed at the EMITTER. WI-7309's `emitter{pid,cwd,startedAt}` stamp
 * is the natural home for provenance, but a remote alarm carries whatever its own
 * node's code produced — and the peers are precisely the nodes running older code,
 * so `emitter` stays null on exactly the alarms that most need attributing. The
 * receiving node, by contrast, always knows `origin`. Hence: annotate on READ.
 *
 * Batched by msg_id over the already-bounded page, and fail-soft, for the same
 * reasons as {@link getSupersededMap}: losing the marker must never cost the caller
 * their inbox. Degrades to "nothing marked remote" — which is the pre-existing
 * behaviour, not a new wrong answer.
 */
export async function getRemoteOriginMsgIds(
  msgIds: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (msgIds.length === 0 || !coordHasPgFastPath()) return out;
  const ids = [...new Set(msgIds.filter((id) => typeof id === 'string' && id !== ''))];
  if (ids.length === 0) return out;
  try {
    const sql = coordSql();
    const rows = await sql<{ msg_id: string | null }[]>`
      SELECT msg_id
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${coordWorkspaceId()}
         AND surface = 'messages'
         AND origin = 'remote'
         AND msg_id = ANY(${ids})
    `;
    for (const row of rows) if (typeof row.msg_id === 'string') out.add(row.msg_id);
  } catch {
    // Degrade to unmarked — see the fail-soft note above.
  }
  return out;
}

/**
 * Batch form of {@link getSupersededBy} for a page of messages (P-004 follow-up).
 *
 * Exists because the READ side of supersession was missing: migration 732 records
 * the marker and `coord:supersede` writes it, but `readCoordFeed` — which backs
 * BOTH `coord:feed` and `coord:catch-up` — never selected it. So the later reader,
 * the one P-004's whole rationale is about ("produces no message, no argument and
 * no signal"), still saw a retracted claim unmarked. The correction body even
 * PROMISES otherwise: "anyone catching up later sees this correction instead of
 * acting on it." That promise was false until this read existed.
 *
 * Batched by msg_id over the already-bounded page rather than per row: a feed page
 * is up to MAX_FEED_LIMIT envelopes, and a per-row `getSupersededBy` would turn one
 * read into N round-trips on the hot catch-up path.
 *
 * Fail-soft on purpose, exactly like {@link getSupersededBy}: a supersession lookup
 * that errors must degrade to "unmarked", never break the feed. The marker is an
 * annotation on history, not history itself.
 */
export async function getSupersededMap(
  msgIds: readonly string[],
): Promise<Map<string, SupersessionMark>> {
  const out = new Map<string, SupersessionMark>();
  if (msgIds.length === 0 || !coordHasPgFastPath()) return out;
  const ids = [...new Set(msgIds.filter((id) => typeof id === 'string' && id !== ''))];
  if (ids.length === 0) return out;
  try {
    const sql = coordSql();
    const rows = await sql<
      { msg_id: string | null; superseded_by_msg_id: string | null; superseded_at: string | null }[]
    >`
      SELECT msg_id, superseded_by_msg_id, superseded_at
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${coordWorkspaceId()}
         AND surface = 'messages'
         AND superseded_by_msg_id IS NOT NULL
         AND msg_id = ANY(${ids})
    `;
    for (const row of rows) {
      if (typeof row.msg_id !== 'string' || typeof row.superseded_by_msg_id !== 'string') continue;
      out.set(row.msg_id, {
        supersededBy: row.superseded_by_msg_id,
        supersededAt: row.superseded_at ? String(row.superseded_at) : null,
      });
    }
  } catch {
    // Degrade to unmarked — see the fail-soft note above.
  }
  return out;
}

/**
 * Mark `msgId` superseded by `correctionMsgId` (P-004, migration 732).
 *
 * Ordering matters and is the caller's contract: the correction is SENT first,
 * then this marks the original. That way a failure here leaves a delivered
 * correction and an unmarked original — noisy but safe — rather than an original
 * marked as corrected by a message that was never delivered, which would tell
 * every later reader to go find a correction that does not exist.
 *
 * `WHERE superseded_by_msg_id IS NULL` makes it idempotent AND race-safe: two
 * concurrent supersessions cannot overwrite each other, and the first one wins.
 */
export async function markSuperseded(msgId: string, correctionMsgId: string): Promise<boolean> {
  if (!msgId || !correctionMsgId || !coordHasPgFastPath()) return false;
  try {
    const sql = coordSql();
    const rows = await sql<{ msg_id: string }[]>`
      UPDATE harness_shared.coord_event_log
         SET superseded_by_msg_id = ${correctionMsgId}, superseded_at = now()
       WHERE workspace_id = ${coordWorkspaceId()}
         AND surface = 'messages'
         AND msg_id = ${msgId}
         AND superseded_by_msg_id IS NULL
      RETURNING msg_id
    `;
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * A full coord msg_id looks like `msas1j6h-0000-<32 hex>`. The LEADING SHORT
 * FORM is what actually circulates: agents cite ids in prose, summaries and
 * carry-notes constantly ("still waiting on msas1j6h"), and `getMessageById`
 * matches EXACTLY — so anyone who copied an id out of prose and looked it up
 * was told, confidently, that a real message did not exist.
 *
 * WI-6725: that silent empty is a WRONG ANSWER, not a missing feature — it is
 * indistinguishable from a true negative. It cost a real commitment on
 * 2026-08-01: a leader distrusted a carried claim, went to the primitive to
 * check it, got `found:false` on the short form, and retracted a genuine
 * unanswered question as fabricated. The failure mode specifically punishes
 * verify-don't-trust, which is the discipline this fleet is trying to build.
 *
 * So resolution is explicit and three-valued — `found` / `not-found` /
 * `ambiguous` — and a unique PREFIX resolves rather than missing. A caller can
 * no longer collapse "you gave me a truncated id" into "no such message"
 * without saying so. Exact match is tried first and always wins, so a full id
 * keeps its indexed fast path and its existing behavior exactly.
 */
const FULL_MSG_ID_SHAPE = /^[^-\s]+-\d+-[0-9a-f]{32}$/i;
/** Ambiguity is reported with candidates, capped so a 2-char ref can't flood. */
const REF_CANDIDATE_CAP = 10;

export type MessageRefResolution =
  | { status: 'found'; msgId: string; message: CoordEnvelope; resolvedFrom: 'exact' | 'prefix' }
  | { status: 'not-found'; msgId: string; looksTruncated: boolean }
  | { status: 'ambiguous'; msgId: string; candidates: string[] };

/** Ids whose msg_id starts with `prefix` (bounded). Prefix-only — never a substring match.
 *  On PG a query error PROPAGATES (D-011); the scan below is the non-PG seam only. */
async function findMessageIdsByPrefix(prefix: string, limit: number): Promise<string[]> {
  if (coordHasPgFastPath()) {
    const sql = coordSql();
    // starts_with() rather than LIKE: no escaping of `%`/`_` in the ref.
    const rows = await sql<{ msg_id: string }[]>`
      SELECT msg_id
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${coordWorkspaceId()}
         AND surface = 'messages'
         AND starts_with(msg_id, ${prefix})
       ORDER BY msg_id
       LIMIT ${limit}
    `;
    return rows.map((r) => r.msg_id);
  }
  const lines = await coordLog.readLines('messages');
  const seen: string[] = [];
  for (const l of lines) {
    if (typeof l.msg_id === 'string' && l.msg_id.startsWith(prefix) && !seen.includes(l.msg_id)) {
      seen.push(l.msg_id);
      if (seen.length >= limit) break;
    }
  }
  return seen;
}

/**
 * Escalations are a separate coord surface, not messages. Both OPEN and
 * RESOLVED originals remain valid reply targets: resolving appends a sibling
 * `escalation_resolved` event, but must not make a subsequent response to the
 * immutable original look dangling. The event log therefore supplies every
 * retained original, while `coord_open_escalations` supplements it with open
 * records whose original event-log row has already been pruned.
 *
 * Both PG reads are best-effort and independently fail-soft. Older/dev
 * databases may not have migration 355 yet, while a transient event-log read
 * must not hide a projection-only open escalation. Non-PG seams read the
 * original escalation events directly; resolved siblings do not remove them.
 */
async function findEscalationsByPrefix(prefix: string, limit: number): Promise<CoordEnvelope[]> {
  if (!prefix || limit <= 0) return [];

  if (coordHasPgFastPath()) {
    const candidates = new Map<string, CoordEnvelope>();
    try {
      const sql = coordSql();
      const rows = await sql<{ body: unknown }[]>`
        SELECT body
          FROM harness_shared.coord_event_log
         WHERE workspace_id = ${coordWorkspaceId()}
           AND surface = 'escalations'
           AND starts_with(msg_id, ${prefix})
           AND body->>'kind' = 'escalation'
         ORDER BY msg_id
         LIMIT ${limit}
      `;
      for (const row of rows) {
        const event = (typeof row.body === 'string' ? JSON.parse(row.body) : row.body) as CoordEnvelope;
        if (event?.kind === 'escalation' && typeof event.msg_id === 'string') candidates.set(event.msg_id, event);
      }
    } catch {
      // Fall through to the projection: it may still retain an open original.
    }
    try {
      const sql = coordSql();
      const rows = await sql<{ body: unknown }[]>`
        SELECT body
          FROM harness_shared.coord_open_escalations
         WHERE workspace_id = ${coordWorkspaceId()}
           AND starts_with(msg_id, ${prefix})
         ORDER BY msg_id
         LIMIT ${limit}
      `;
      for (const row of rows) {
        const event = (typeof row.body === 'string' ? JSON.parse(row.body) : row.body) as CoordEnvelope;
        if (event?.kind === 'escalation' && typeof event.msg_id === 'string') candidates.set(event.msg_id, event);
      }
    } catch {
      // Migration 355 may not exist yet; retained event-log originals still work.
    }
    return [...candidates.values()].sort((a, b) => a.msg_id.localeCompare(b.msg_id)).slice(0, limit);
  }

  try {
    const events = await coordLog.readEvents('escalations');
    return events
      .filter(
        (event) =>
          event.kind === 'escalation' &&
          typeof event.msg_id === 'string' &&
          event.msg_id.startsWith(prefix),
      )
      .sort((a, b) => a.msg_id.localeCompare(b.msg_id))
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Handoffs are an event surface, but coord:feed intentionally exposes them
 * alongside messages. Keep coord:read's reference resolver aligned with that
 * feed contract so an id copied from a handoff row is not reported missing.
 * The PG path uses the same indexed prefix lookup as the message resolver;
 * non-PG seams fall back to the event-log abstraction used by handoffs.ts.
 */
async function findHandoffsByPrefix(prefix: string, limit: number): Promise<CoordEnvelope[]> {
  if (!prefix || limit <= 0) return [];

  if (coordHasPgFastPath()) {
    try {
      const sql = coordSql();
      const rows = await sql<{ body: unknown }[]>`
        SELECT body
          FROM harness_shared.coord_event_log
         WHERE workspace_id = ${coordWorkspaceId()}
           AND surface = 'handoffs'
           AND starts_with(msg_id, ${prefix})
         ORDER BY msg_id
         LIMIT ${limit}
      `;
      return rows.map((row) => (typeof row.body === 'string' ? JSON.parse(row.body) : row.body) as CoordEnvelope);
    } catch {
      // Fall through to the event-log seam for older/dev backends.
    }
  }

  try {
    const events = await coordLog.readEvents('handoffs');
    return events
      .filter((event) => typeof event.msg_id === 'string' && event.msg_id.startsWith(prefix))
      .sort((a, b) => a.msg_id.localeCompare(b.msg_id))
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Resolve a msg_id REF (a full id, or a unique leading prefix) to its message.
 * See the WI-6725 note above for why this is three-valued rather than
 * `CoordEnvelope | null`.
 */
export async function resolveMessageRef(ref: string): Promise<MessageRefResolution> {
  const msgId = (ref ?? '').trim();
  if (!msgId) return { status: 'not-found', msgId, looksTruncated: false };

  const exact = await getMessageById(msgId);
  if (exact) return { status: 'found', msgId, message: exact, resolvedFrom: 'exact' };

  // EI-21271857379493174: an open escalation can outlive its original
  // `escalations` event in the log while remaining durable in the open-set
  // projection. Treat that live record as a valid exact/prefix target so a
  // driver can acknowledge it through coord:send.
  const escalations = await findEscalationsByPrefix(msgId, REF_CANDIDATE_CAP + 1);
  const exactEscalation = escalations.find((event) => event.msg_id === msgId);
  if (exactEscalation) {
    return { status: 'found', msgId, message: exactEscalation, resolvedFrom: 'exact' };
  }

  // coord:feed includes handoffs, whose immutable records live on their own
  // event surface. Resolve them before treating a well-formed full id as a
  // genuine miss, and retain the candidates for truncated-prefix resolution.
  const handoffs = await findHandoffsByPrefix(msgId, REF_CANDIDATE_CAP + 1);
  const exactHandoff = handoffs.find((event) => event.msg_id === msgId);
  if (exactHandoff) {
    return { status: 'found', msgId, message: exactHandoff, resolvedFrom: 'exact' };
  }

  // A well-formed full id that missed is a genuine not-found — no prefix scan.
  if (FULL_MSG_ID_SHAPE.test(msgId)) return { status: 'not-found', msgId, looksTruncated: false };

  const messageCandidates = await findMessageIdsByPrefix(msgId, REF_CANDIDATE_CAP + 1);
  const candidates = [
    ...new Set([
      ...messageCandidates,
      ...escalations.map((event) => event.msg_id),
      ...handoffs.map((event) => event.msg_id),
    ]),
  ];
  if (candidates.length === 0) return { status: 'not-found', msgId, looksTruncated: true };
  if (candidates.length > 1) {
    return { status: 'ambiguous', msgId, candidates: candidates.slice(0, REF_CANDIDATE_CAP) };
  }
  const resolved = await getMessageById(candidates[0]);
  if (resolved) return { status: 'found', msgId: candidates[0], message: resolved, resolvedFrom: 'prefix' };
  const escalation = escalations.find((event) => event.msg_id === candidates[0]);
  if (escalation) return { status: 'found', msgId: candidates[0], message: escalation, resolvedFrom: 'prefix' };
  const handoff = handoffs.find((event) => event.msg_id === candidates[0]);
  if (!handoff) return { status: 'not-found', msgId, looksTruncated: true };
  return { status: 'found', msgId: candidates[0], message: handoff, resolvedFrom: 'prefix' };
}

/**
 * Reconstruct a thread rooted at `rootMsgId` by walking the
 * `related_msg_id` chain in both directions. Sorted by ts ascending.
 */
export async function readThread(rootMsgId: string): Promise<CoordEnvelope[]> {
  // EI-21150596392578187: the old implementation loaded the entire messages
  // surface and only then folded the related_msg_id graph in JavaScript. On a
  // cold PG cache that made one rooted thread read pay for every message ever
  // retained, and the bounded coord:thread tool could yield before the fold
  // completed. Walk the graph in Postgres instead. Each recursive step can use
  // the existing (workspace,msg_id) index for parents and the partial
  // related_msg_id index for children; the final fold remains the authority for
  // the exact historical semantics (including ordering and duplicate ids).
  //
  // This is deliberately a fast path rather than a change to CoordEventLog:
  // readThread needs a graph-shaped predicate no other surface currently needs,
  // while InMemoryCoordLog/FsCoordLog retain the portable full-read behavior.
  // On PG a query error PROPAGATES: the full read is exactly the whole-surface
  // load this fast path replaced (host-memory-reduction-2026-09-27 D-011).
  if (coordHasPgFastPath()) {
    const sql = coordSql();
    const rows = await sql<
      { body: unknown; ts: unknown; msg_id: string; harness_slug: string | null }[]
    >`
      WITH RECURSIVE thread_ids(msg_id) AS (
        SELECT ${rootMsgId}::text
        UNION
        SELECT CASE
                 WHEN e.msg_id = ids.msg_id THEN e.body->>'related_msg_id'
                 ELSE e.msg_id
               END
          FROM thread_ids AS ids
          JOIN harness_shared.coord_event_log AS e
            ON e.workspace_id = ${coordWorkspaceId()}
           AND e.surface = 'messages'
           AND (
             e.msg_id = ids.msg_id
             OR (
               e.body ? 'related_msg_id'
               AND e.body->>'related_msg_id' = ids.msg_id
             )
           )
         WHERE e.msg_id <> ids.msg_id
            OR (
              e.body ? 'related_msg_id'
              AND e.body->>'related_msg_id' IS NOT NULL
            )
      )
      SELECT e.body, e.ts, e.msg_id, e.harness_slug
        FROM harness_shared.coord_event_log AS e
        JOIN thread_ids AS ids ON ids.msg_id = e.msg_id
       WHERE e.workspace_id = ${coordWorkspaceId()}
         AND e.surface = 'messages'
       ORDER BY e.id ASC
    `;
    const all = rows.map((row) => {
      const parsed = (typeof row.body === 'string' ? JSON.parse(row.body) : row.body) as
        | Record<string, unknown>
        | null;
      const envelope: Record<string, unknown> =
        parsed && typeof parsed === 'object' ? { ...parsed } : {};
      // Match PgCoordLog's read boundary: remote/federated rows can have a
      // malformed body, so the NOT-NULL columns backstop the fold's required
      // identity/order fields. The normalized scope column is authoritative.
      if ((typeof envelope.ts !== 'string' || !envelope.ts) && row.ts != null) {
        envelope.ts = row.ts instanceof Date ? row.ts.toISOString() : String(row.ts);
      }
      if ((typeof envelope.msg_id !== 'string' || !envelope.msg_id) && row.msg_id) {
        envelope.msg_id = row.msg_id;
      }
      if (row.harness_slug == null) delete envelope.harness_slug;
      else envelope.harness_slug = row.harness_slug;
      return envelope as CoordEnvelope;
    });
    return foldThread(all, rootMsgId);
  }
  const all = await coordLog.readLines('messages');
  return foldThread(all, rootMsgId);
}
