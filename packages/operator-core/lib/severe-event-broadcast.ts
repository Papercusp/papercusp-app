/**
 * severe-event-broadcast — a process-level watchdog's "tell every running agent" rail.
 *
 * The gap this closes: the pipeline stall watchdogs (green-stall-watchdog, git-sync-stall-
 * watchdog) alarmed only via `notifyAttention` — an OWNER-facing toast. If the owner isn't
 * looking, a SEVERE pipeline event (green-checkpoint not producing greens; git-sync firing but
 * not committing — code silently stranding for hours) sat unclaimed. A fleet of agents IS
 * running and any of them could green the gate / rescue the stranded work — but they never saw
 * it.
 *
 * This broadcasts the event to ALL running agents (`to:['*']`) INJECT-ONLY (no wake): every
 * agent sees it in its inbox on its NEXT turn (via the always-armed inbox rail), so someone
 * claims it — WITHOUT a storm of forced wake-ups mid-turn (owner-requested: wake=false). It is
 * the coordination-floor complement to the owner toast, not a replacement.
 *
 * Best-effort + fail-soft: a broadcast failure must NEVER break the watchdog sweep that calls it.
 */
import { sendMessage } from './agent-tools/coordination/messages';
import { wakeRecipients } from './agent-tools/coordination/inbox-wake';
import type { AgentIdentity } from './agent-tools/coordination/identity';

/** The system identity severe-event broadcasts are attributed to (mirrors the
 *  hive-owner-key-health escalation identity — a workspace-level system sender). */
const SEVERE_EVENT_IDENTITY: AgentIdentity = {
  ownerId: 'system-watchdog',
  ownerLabel: 'system-watchdog',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

/**
 * The ownership/routing leg (EI-10060, a follow-up to EI-9939's flap suppression):
 * ADDITIVE to the unconditional `to:['*']` broadcast below — it never replaces it.
 * When present, a SEPARATE directed message + best-effort wake also goes to the
 * resolved responsible party, so they get a full-fidelity, expected-to-act-or-ack
 * notice instead of relying on the ambient broadcast (which digest-suppresses after
 * EI-9939's flap threshold like everyone else's). Build via
 * `resolveSevereEventOwner()` (severe-event-owner.ts) — this module never resolves
 * ownership itself, only routes to what the caller already resolved.
 */
export interface SevereEventRoute {
  /** A coord:send audience selector ('@role:<slot>' / '@fleet-leader:<slug>') or a
   *  concrete ownerId. */
  ownerSelector: string;
  /** Human-readable — who/why, folded into the directed message's body. */
  reason: string;
}

export interface SevereEventBroadcast {
  /** One-line inbox summary — what's wrong + that it's claimable. */
  summary: string;
  /** Optional fuller body (evidence + the recommended first step). */
  body?: string;
  /** Ambient category for coord:inbox filtering (default 'severe-event'). */
  category?: string;
  /**
   * Condition-lifecycle key (WI-1444): a stable identifier for the CONDITION this
   * broadcast reports (e.g. `git-sync-stall:<install_slug>`). When the condition
   * later clears, the emitter calls broadcastSevereEventResolved with the SAME
   * key — the coord:inbox read then annotates this alarm `resolved:true`, so an
   * agent waking hours later never burns a turn investigating a dead condition.
   * Omit for one-off events with no meaningful recovery.
   */
  conditionKey?: string;
  /**
   * WI-6228: this emitter alarms ONCE per episode and stays SILENT until recovery
   * (the `if (alerted) continue; // one-shot until recovery` pattern shared by
   * origin-freshness, green-stall, git-sync-stall, gate-canary and
   * federation-join-stall). Declaring it stops the condition-staleness
   * reconciler from reading that deliberate silence as "the signal cleared".
   *
   * Why the EMITTER must declare it: `last_seen` is derived purely from alarm
   * broadcasts, so a one-shot condition's `last_seen` freezes at its first alarm
   * even while the condition is continuously observed and worsening. The
   * signal-absence guard (condition-staleness-alarm.ts guard #3) then resolves it
   * after `absenceMs` — a FALSE GREEN that is *guaranteed*, not probabilistic, for
   * any one-shot condition outlasting that window. Measured live 2026-07-26:
   * `origin-freshness:papercusp` alarmed once at 21:13:41Z during a fleet-wide git
   * egress freeze and was auto-resolved at 23:13:48Z — 120m+7s later, to the
   * second — while the outage was still live; the genuine RECOVERED broadcast did
   * not land until 23:39:42Z. Only the emitter knows whether it re-alarms; the
   * guard cannot infer it from the envelope stream.
   */
  oneShot?: boolean;
  /** EI-10060: the resolved responsible party, if any. See {@link SevereEventRoute}. */
  route?: SevereEventRoute;
}

/**
 * WI-7309: identity of the PROCESS that emitted an alarm.
 *
 * Stamped on every severe-event broadcast because on this box the emitter's AGE is the
 * decisive forensic fact and nothing else in the envelope carries it. Long-lived
 * `tsx bin/hono-host.ts` hosts run from the STAGING tree with no hot-reload, so each
 * executes a frozen snapshot of the code from whenever it started (measured 2026-08-03:
 * one at 8.4h, one at 7.8 DAYS). A fix can therefore be committed, green-gated, deployed
 * and verified live by every available check — `--is-ancestor`, blob identity, served sha
 * — while one of those hosts keeps paging the PRE-FIX text forever. No deploy reaches it.
 *
 * Without these fields attribution has to be reconstructed indirectly, from in-memory
 * streak arithmetic cross-referenced against `ps` by hand. That cost two agents ~1h on
 * 2026-08-03 and still ended UNDETERMINED. With them it is a field read.
 */
export interface SevereEventEmitter {
  pid: number;
  /**
   * ISO time this PROCESS started — THE discriminator. A process that started before
   * your fix landed has not loaded it, whatever the deployed sha reports.
   */
  startedAt: string;
  uptimeSec: number;
  /** cwd of the emitting process: WHICH CHECKOUT it executes from (staging vs release). */
  cwd: string;
}

/** Snapshot the current process's identity. Never throws — an alarm must still fire. */
export function severeEventEmitter(): SevereEventEmitter {
  let uptimeSec = 0;
  let cwd = '(unknown)';
  let pid = -1;
  try {
    uptimeSec = Math.max(0, Math.round(process.uptime()));
  } catch {
    /* best-effort: an unusable clock must never suppress the alarm */
  }
  try {
    cwd = process.cwd();
  } catch {
    /* best-effort */
  }
  try {
    if (typeof process.pid === 'number') pid = process.pid;
  } catch {
    /* best-effort */
  }
  return { pid, startedAt: new Date(Date.now() - uptimeSec * 1000).toISOString(), uptimeSec, cwd };
}

/**
 * One-line trailer appended to the alarm BODY. The structured `extra.emitter` is what SQL
 * queries; this is what an agent reading coord:inbox actually sees, so it carries the
 * INTERPRETATION RULE and not only the raw numbers — the rule is the part that was missing.
 */
export function renderSevereEventEmitter(e: SevereEventEmitter): string {
  const h = Math.floor(e.uptimeSec / 3600);
  const m = Math.floor((e.uptimeSec % 3600) / 60);
  const age = h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
  return (
    `\n\n— emitted by pid ${e.pid}, process started ${e.startedAt} (up ${age}), cwd ${e.cwd}. ` +
    `If that start time PREDATES the fix you are checking, this process never loaded it ` +
    `(no hot-reload) and no deploy will reach it — restart that host instead of re-investigating the alarm.`
  );
}

/**
 * The Mug role slot, INLINED rather than imported from placement-watchdog's
 * `MUG_COORD_SLOT` — same precedent as scout/nudge-recipient.ts: this is a comparison
 * against a wire constant, and importing that module here would drag the placement
 * watchdog into every severe-event broadcast path.
 */
const MUG_ROLE_SLOT = '@role:mug';

/**
 * WI-37625 — gate the DELIVERY, not the decision to send (D-027).
 *
 * `resolveSevereEventOwner` routes two condition classes (`health-tick-stale`,
 * `dead-routines`) at `@role:mug`. That slot is drained by exactly one consumer
 * (`pot/mug-brief-launch.ts`, at Mug spawn), so with the spawn gate closed (D-018) a
 * severe-event route lands somewhere nothing reads — the condition is still detected,
 * still broadcast to `*`, but the ROUTED "you are on the hook" leg silently dead-ends,
 * which is the exact dual failure EI-10060 existed to close.
 *
 * The fix belongs HERE and not in the registry for two measured reasons:
 *   1. `resolveSevereEventOwner` is deliberately PURE/SYNC (its doc-comment prizes this,
 *      so `@fleet-leader:` never goes stale relative to a leadership change), and the
 *      retirement flag is async — gating there would infect it with I/O.
 *   2. The Scout ladder does not fit either: `SEVERE_EVENT_IDENTITY.workspaceId` is
 *      `null` and `resolveNudgeRecipient` is workspace-scoped, so there is no workspace
 *      to resolve a live su against. `human` is the honest fallback — these two classes
 *      ("a frozen health tick blinds fleet placement", "dead routines stall placement")
 *      are owner-worthy by construction, and the module's own step 3 already says an
 *      unresolved condition should escalate toward human attention.
 *
 * When the tier is switched back ON for testing the legacy slot is preserved unchanged.
 */
async function gateMugSelector(
  route: SevereEventRoute,
): Promise<{ selector: string; reason: string }> {
  if (route.ownerSelector !== MUG_ROLE_SLOT) {
    return { selector: route.ownerSelector, reason: route.reason };
  }
  let enabled = true;
  try {
    const { mugKettleSystemEnabled } = await import('./pot/started');
    enabled = await mugKettleSystemEnabled();
  } catch {
    // Fail SAFE toward the legacy slot: if we cannot read the flag we must not silently
    // redirect a severe event to the owner (that would page a human on a flag hiccup).
    enabled = true;
  }
  if (enabled) return { selector: route.ownerSelector, reason: route.reason };
  return {
    selector: 'human',
    reason:
      `${route.reason} — the Mug tier is retired, so this routed to you instead of ` +
      `'${MUG_ROLE_SLOT}', a slot only a Mug spawn drains`,
  };
}

/**
 * Best-effort directed route: a durable message to the gated owner selector + a
 * best-effort wake of whoever that selector resolves to LIVE right now (mirrors
 * `wakeMug`'s two-halves pattern in pot/placement-watchdog.ts — a direct wake for
 * a currently-live holder, a durable send for a role slot with none yet). Never
 * throws; a routing failure must never break the underlying broadcast.
 */
async function deliverRoute(route: SevereEventRoute, summary: string, body: string | undefined): Promise<void> {
  try {
    const { selector, reason } = await gateMugSelector(route);
    const env = await sendMessage(SEVERE_EVENT_IDENTITY, {
      to: [selector],
      summary: `[routed: ${reason}] ${summary}`,
      body,
      expectsReply: true,
    });
    if (env.to.length > 0) {
      await wakeRecipients(env.to, { summary, source: 'severe-event-broadcast' }).catch(() => {});
    }
  } catch (e) {

    console.warn(`[severe-event-broadcast] route delivery failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Broadcast a SEVERE pipeline event to every running agent, inject-only (no wake). Seen on the
 * recipient's next turn so someone claims it. Never throws.
 */
export async function broadcastSevereEvent(ev: SevereEventBroadcast): Promise<boolean> {
  try {
    // No `wake` option ⇒ plain inject (the owner-requested wake=false): lands in every agent's
    // inbox for their next turn, no forced re-invoke storm.
    // WI-7309: emitter identity is stamped UNCONDITIONALLY — an alarm whose emitter is
    // unknown is an alarm nobody can attribute, and attribution is the expensive part.
    const emitter = severeEventEmitter();
    const body = `${ev.body ?? ''}${renderSevereEventEmitter(emitter)}`;
    await sendMessage(SEVERE_EVENT_IDENTITY, {
      to: ['*'],
      summary: ev.summary,
      body,
      category: ev.category ?? 'severe-event',
      extra: {
        emitter,
        ...(ev.conditionKey
          ? {
              condition_key: ev.conditionKey,
              // WI-6228: carried on the envelope so the condition fold can mark the
              // state one_shot without any per-family knowledge.
              ...(ev.oneShot ? { one_shot: true } : {}),
            }
          : {}),
      },
    });
    if (ev.route) await deliverRoute(ev.route, ev.summary, body);
    return true;
  } catch (e) {

    console.warn(`[severe-event-broadcast] failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export interface SevereEventResolution {
  /** The SAME conditionKey the original broadcastSevereEvent carried. */
  conditionKey: string;
  /** One-line all-clear (e.g. "git-sync RECOVERED on papercusp — commits landing again."). */
  summary: string;
  /** Optional detail (what recovered it / evidence). */
  body?: string;
}

/**
 * Broadcast that a previously-alarmed severe condition has CLEARED (WI-1444). Every prior
 * broadcast carrying the same `condition_key` is annotated `resolved:true` at coord:inbox
 * read time, so stale alarms self-supersede instead of sending late readers chasing dead
 * conditions. Inject-only, same rail as the alarm. Never throws.
 */
export async function broadcastSevereEventResolved(res: SevereEventResolution): Promise<boolean> {
  try {
    await sendMessage(SEVERE_EVENT_IDENTITY, {
      to: ['*'],
      summary: res.summary,
      body: res.body,
      category: 'severe-event-resolved',
      extra: { resolves_condition: res.conditionKey, condition_key: res.conditionKey },
    });
    return true;
  } catch (e) {

    console.warn(`[severe-event-broadcast] resolve failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export interface SevereEventResolutionMany {
  /** The conditionKeys of EVERY alarm this ONE message supersedes. */
  conditionKeys: string[];
  /** One-line all-clear covering all of them (e.g. "git-sync RECOVERED on 6 harnesses …"). */
  summary: string;
  /** Optional detail. */
  body?: string;
}

/**
 * Broadcast that SEVERAL previously-alarmed conditions have cleared in ONE message
 * (EI-9030b) — instead of one recovery notice per condition, which spams every
 * agent's inbox when a shared root-cause (e.g. a DBOS engine wedge) recovers many
 * harnesses at once. Carries `resolves_conditions` (plural array); coord:inbox's
 * `annotateResolvedConditions` supersedes every listed condition's prior alarm.
 * A single key stays byte-equivalent to `broadcastSevereEventResolved` for readers
 * that key on the singular field (both `resolves_condition` + the plural are stamped).
 * Inject-only, same rail as the alarm. Never throws; a 0-key call is a no-op.
 */
export async function broadcastSevereEventResolvedMany(res: SevereEventResolutionMany): Promise<boolean> {
  if (res.conditionKeys.length === 0) return true;
  try {
    await sendMessage(SEVERE_EVENT_IDENTITY, {
      to: ['*'],
      summary: res.summary,
      body: res.body,
      category: 'severe-event-resolved',
      extra: {
        resolves_conditions: res.conditionKeys,
        // Stamp the singular fields too (first key) so a reader that only knows the
        // singular shape still supersedes at least the primary condition.
        resolves_condition: res.conditionKeys[0],
        condition_key: res.conditionKeys[0],
      },
    });
    return true;
  } catch (e) {

    console.warn(`[severe-event-broadcast] resolve-many failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
