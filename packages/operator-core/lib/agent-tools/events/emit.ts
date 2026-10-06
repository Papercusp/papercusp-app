/**
 * events:emit — fire an event through the await-event primitive
 * (await-event-primitive-2026-06-05 P-003, D-001).
 *
 * The agent-facing half of the emit surface (sources inside the host call
 * `emitAwaitedEvent` directly). The emitter is the SOURCE layer: it has
 * already resolved who the event concerns — a targeted key both sides agreed
 * on, and/or an explicit `to[]` (ownerIds / Brief 28 @-selectors / '*' /
 * 'human'). Delivery is policy-per-recipient: wake-awaiters on the key are
 * woken (durable, liveness-adaptive); the rest of `to[]` get one coord inbox
 * message (notify — never wakes).
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { deriveAgentRole, resolveAgentIdentity } from '../coordination/identity';
import { emitAwaitedEvent } from '../../events/await/engine';
import { sendMessage } from '../coordination/messages';
import { resolveWorkspaceHiveScope } from '../coordination/federation-scope';
import { registerAnnouncement, countActiveAwaitsByPrefixes, findNearMissKeys, type NearMissKey } from '../../events/await/store';
import { buildAnnouncedKey, defaultAnnounceScope, type AnnounceScopeKind } from '../../events/await/announce-key';
import { getPresence } from '../coordination/presence';
import { softText, clampText, LIMITS } from '../limits';

export default defineTool({
  name: 'events:emit',
  description:
    'Fire an event key through the await-event primitive: every agent with an events:await on the key is woken (durable delivery — pty-inject / session-resume / inbox ladder); an optional `to` list also gets a coord inbox notify (never wakes). Use the key your waiter registered. Reports `waiters` — ACTIVE await registrations matched (excludes extra `to[]`) — so `waiters:0` with no `to[]` means the emit reached no one.',
  guidance: {
    when: "Announcing that the thing a peer is blocked on has happened: work is done, an artifact landed, a decision resolved. Pair with events:await — the waiter registers the key, you emit it. (To WAKE a parked AGENT, prefer the higher-level verbs: coord:wake to nudge, coord:dispatch to assign+wake, coord:send {wake:'required'} to message+wake.)",
    notWhen:
      'General status narration — lifecycle auto-emits + work_items:complete cover it. Conversation — coord:send. Waking a specific agent — coord:wake / coord:dispatch (report woken/dead). No plausible awaiter and no `to` — the emit reaches no one (not a log).',
    chaining:
      'Catalogued key: peer events:await { event: K } → you work → events:emit { event: K, summary } → peer wakes. HAND-MINTED pair key: DECLARE-FIRST — events:emit { event: K, announce: true } → peer awaits the RETURNED key (copied, never re-typed — LATCHES for late registrants) → emit that key on completion.',
    seeAlso: [
      'events:await (a peer waits with this before you emit)',
      'events:status (see pending awaits for the event)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    event: z.string().min(1).max(200).describe('Exact event key to fire.'),
    summary: softText(LIMITS.ANNOTATION).optional().describe('One human line — rides the wake turn / notify summary. Auto-truncated to 2000 chars if longer.'),
    payload: z.unknown().optional().describe('Structured data carried on the wake (truncated at 400 chars in the turn text).'),
    to: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe("Additional NOTIFY audience: ownerIds, @plan:/@topic:/@object:/@file: selectors, '*' or 'human'. Wake-awaiters are excluded (their wake already carries it)."),
    scope: z
      .enum(['hive', 'local'])
      .optional()
      .describe(
        "P-009 (cross-machine-coord-parity): 'hive' ALSO federates this event to every machine of the workspace's shared Hive — each peer re-fires the key into ITS local await store, so a REMOTE machine's events:await on the same key wakes (rendezvous beyond inbox-wake: lock grants, artifact-ready, staging-advanced). Requires a resolvable hive scope (the result reports federated: plus federation_error: when none). Omit/'local' = today's machine-local emit.",
      ),
    announce: z
      .boolean()
      .optional()
      .describe(
        "EI-9270: DECLARE the gate instead of firing it — writes a discoverable, LATCHED announcement (\"this key WILL fire; await it\") that members find via events:catalog / coord:orient with zero messages. The event key is auto-prefixed from announceScope (fleet:<slug>:<gate>) so fleets' gates can't collide. Fire it later with a normal events:emit of the RETURNED key — that stamps the latch, so even an agent that registers AFTER the fire is told immediately. No wake, no notify, `to` not allowed.",
      ),
    logical_gate: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('announce only: stable identity for one logical gate; active declarations with another event key are rejected.'),
    announceScope: z
      .enum(['fleet', 'plan', 'harness', 'global'])
      .optional()
      .describe(
        "Discovery scope of the announcement (who SEES it): defaults to your narrowest context — your fleet, else your bound plan, else global. 'global' = visible to every agent (system-wide gates).",
      ),
    announceScopeRef: z
      .string()
      .max(120)
      .optional()
      .describe('The fleet/plan/harness slug for announceScope (defaults from your presence when omitted).'),
    expiresSec: z
      .number()
      .int()
      .positive()
      .max(30 * 24 * 60 * 60)
      .optional()
      .describe('announce only: seconds until the DECLARATION lapses if never fired (visible in events:status; not a latch). Omit = standing until fired/cancelled.'),
    expected_sha: z
      .string()
      .regex(/^[0-9a-f]{7,64}$/i)
      .optional()
      .describe('announce only: the commit/deploy SHA this gate is expected to prove. Mutually exclusive with expected_predicate.'),
    expected_predicate: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('announce only: a @papercusp/rules DataCondition expected to match the eventual emit payload. Mutually exclusive with expected_sha.'),
  }).superRefine((args, ctx) => {
    if (args.announce === true && (args.to?.length ?? 0) > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message:
          "events:emit — `announce` declares a gate; it wakes/notifies no one, so `to` is not allowed. Fire the returned key later to deliver.",
      });
    }
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);

    if (!args.announce && (args.expected_sha || args.expected_predicate || args.logical_gate)) {
      throw new Error('events:emit — expected_sha/expected_predicate/logical_gate describe a DECLARATION; pass announce:true or omit them.');
    }

    // ── EI-9270: announce = DECLARE, don't fire ─────────────────────────────
    if (args.announce) {
      if (args.to && args.to.length > 0) {
        throw new Error("events:emit — `announce` declares a gate; it wakes/notifies no one, so `to` is not allowed. Fire the returned key later to deliver.");
      }
      if (args.expected_sha && args.expected_predicate) {
        throw new Error('events:emit — announce accepts only one expected condition: expected_sha OR expected_predicate.');
      }
      // Default scope = the announcer's narrowest context (fleet → plan → global).
      let kind = args.announceScope as AnnounceScopeKind | undefined;
      let ref = args.announceScopeRef ?? null;
      if (!kind || ((kind === 'fleet' || kind === 'plan') && !ref)) {
        type PresenceLite = { fleetSlug?: string | null; currentPlanSlug?: string | null } | null;
        let presence: PresenceLite = null;
        try {
          presence = (await getPresence(identity.ownerId)) as PresenceLite;
        } catch { /* best-effort — fall through to global */ }
        if (!kind) {
          const d = defaultAnnounceScope({ fleetSlug: presence?.fleetSlug ?? null, planSlug: presence?.currentPlanSlug ?? null });
          kind = d.kind;
          ref = ref ?? d.ref;
        } else if (kind === 'fleet') {
          ref = ref ?? presence?.fleetSlug ?? null;
        } else if (kind === 'plan') {
          ref = ref ?? presence?.currentPlanSlug ?? null;
        }
      }
      if (kind !== 'global' && !ref) {
        throw new Error(`events:emit — announceScope '${kind}' needs a slug: pass announceScopeRef (your presence carries no ${kind} to default from).`);
      }
      const key = buildAnnouncedKey(args.event, { kind: kind!, ref: kind === 'global' ? null : ref });
      const role = ctx.role?.trim() || deriveAgentRole(identity)?.trim() || null;
      const boundTo = kind === 'fleet' && ref
        ? { kind: 'fleet-leadership', ref }
        : role
          ? { kind: 'role', ref: role }
          : null;
      const row = await registerAnnouncement({
        subscriberId: identity.ownerId,
        eventKey: key,
        note: clampText(args.summary, LIMITS.ANNOTATION) ?? null,
        scopeKind: kind!,
        scopeRef: kind === 'global' ? null : ref,
        expectedCondition: args.expected_sha
          ? { kind: 'sha', sha: args.expected_sha.toLowerCase() }
          : args.expected_predicate
            ? { kind: 'predicate', predicate: args.expected_predicate }
            : null,
        logicalGateKey: args.logical_gate?.trim() || null,
        expiresSec: args.expiresSec ?? null,
        boundTo,
      });
      // Best-effort "who is already armed on this key" — the leader's readiness read.
      let liveAwaiters: number | undefined;
      try {
        liveAwaiters = (await countActiveAwaitsByPrefixes([key])).get(key) ?? 0;
      } catch { /* omit */ }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              announced: true,
              event: key,
              generation: row.causalGeneration,
              scope: { kind, ref: kind === 'global' ? null : ref },
              ...(row.expectedCondition != null ? { expected: row.expectedCondition } : {}),
              ...(row.logicalGateKey != null ? { logical_gate: row.logicalGateKey } : {}),
              expires_ts: row.expiresTs,
              ...(liveAwaiters !== undefined ? { live_awaiters: liveAwaiters } : {}),
              advice: `Gate DECLARED as generation ${row.causalGeneration ?? '?'} (not fired). Members discover it via events:catalog / coord:orient and events:await "${key}". Fire it later with events:emit { event: "${key}" } — the fire also LATCHES this generation, so agents registering after the fire are told immediately. Inspect or resync with events:status { event: "${key}"${row.causalGeneration != null ? `, after_generation: ${row.causalGeneration}` : ''} }.`,
            }),
          },
        ],
      };
    }

    const result = await emitAwaitedEvent({
      key: args.event,
      summary: clampText(args.summary, LIMITS.ANNOTATION),
      payload: args.payload,
      to: args.to,
      source: identity.ownerId,
      workspaceId: identity.workspaceId ?? undefined,
    });
    // ── event-key-nearmiss-guard P-004: an emit that reached NO ONE (waiters:0,
    // no `to`) is the key-mismatch failure moment — advisory scan for a
    // near-identical active key. Fail-soft; zero cost on the happy path. ──
    let nearMisses: NearMissKey[] | undefined;
    if (result.waiters === 0 && (!args.to || args.to.length === 0)) {
      try {
        const found = await findNearMissKeys(args.event);
        if (found.length > 0) nearMisses = found;
      } catch { /* advisory only — never fail the emit */ }
    }
    // ── P-009 (cross-machine-coord-parity-and-trust-2026-07-01): federate the
    // event. The fed-event rides a NO-RECIPIENT hive-scoped coord row (persists
    // + federates via the mig-150 gate; empty `to` = zero inbox noise, audience
    // D-004). Each peer's coord-message projection re-fires the key into its
    // local await store — only registered watchers wake (no thunder-herd), and
    // the per-author wake budget applies on the receiving side. Best-effort:
    // the LOCAL emit above already happened; a federation miss is reported,
    // never thrown.
    let federated: boolean | undefined;
    let federationError: string | undefined;
    if (args.scope === 'hive') {
      federated = false;
      try {
        const ctxHarnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
        const ctxHarness =
          typeof ctxHarnessRaw === 'string' && ctxHarnessRaw && ctxHarnessRaw !== '*'
            ? ctxHarnessRaw
            : undefined;
        let scopeSlug = ctxHarness;
        if (!scopeSlug && identity.workspaceId && identity.workspaceId !== '*') {
          const resolved = await resolveWorkspaceHiveScope(identity.workspaceId);
          if (resolved.kind === 'one') scopeSlug = resolved.homeSlug;
          else federationError = resolved.kind === 'many' ? 'ambiguous_hive_scope' : 'no_hive_scope';
        } else if (!scopeSlug) {
          federationError = 'no_hive_scope';
        }
        if (scopeSlug) {
          // Bound the federated payload — a fed event is a signal, not a blob.
          let payload = args.payload;
          try {
            if (payload !== undefined && JSON.stringify(payload).length > 8_192) {
              payload = undefined;
              federationError = 'payload_too_large_dropped';
            }
          } catch {
            payload = undefined;
          }
          await sendMessage(identity, {
            to: [],
            summary: `[fed-event] ${args.event}`,
            harnessSlug: scopeSlug,
            extra: {
              fed_event: {
                key: args.event,
                ...(payload !== undefined ? { payload } : {}),
                ...(args.summary ? { summary: clampText(args.summary, LIMITS.ANNOTATION) } : {}),
                source: identity.ownerId,
              },
            },
          });
          federated = true;
        }
      } catch (e) {
        federationError = e instanceof Error ? e.message : String(e);
      }
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            event: result.key,
            woken: result.woken,
            notified: result.notified.length,
            waiters: result.waiters,
            msg_id: result.msgId,
            ...(federated !== undefined ? { federated } : {}),
            ...(federationError ? { federation_error: federationError } : {}),
            ...(nearMisses
              ? {
                  near_misses: nearMisses.map((m) => ({ key: m.eventKey, kind: m.kind, holders: m.holders })),
                  advice: `This emit reached no one (waiters:0) — but a near-identical key is active: "${nearMisses[0].eventKey}" (${nearMisses[0].kind === 'announce' ? 'a DECLARED gate' : `awaited by ${nearMisses[0].holders}`}). If you meant that key, re-emit it EXACTLY — normalized-near keys never rendezvous.`,
                }
              : {}),
          }),
        },
      ],
    };
  },
});
