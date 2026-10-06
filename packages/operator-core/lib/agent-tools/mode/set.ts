/**
 * mode:set — enter/exit an official session mode, for yourself OR a peer
 * (modes-and-intake-ux-2026-07-05 P-006; D-003 guardrails, D-006 axes).
 *
 * Modes are first-class data (harness_shared.agent_modes), not prompt prose:
 * peers see your modes in coord:presence / coord:orient, and every transition
 * is audited (agent_mode_changes). Semantics enforced by the store:
 *   - AXES: same-axis modes auto-switch (setting drain clears ideate — both
 *     recorded); cross-axis modes stack (auto + ideate is the canonical pair).
 *   - OWNER-STICKY (D-003): a mode armed with ownerDirected (the human owner
 *     explicitly instructed it) cannot be overridden by a PEER — the attempt
 *     is refused and DOWNGRADED to a request message the target/owner sees.
 *   - PEER-SET delivery: reason is mandatory; the target gets a coord message
 *     carrying the reason AND the mode's full contract, and the change takes
 *     effect at ITS next turn boundary (coord:orient re-injects active
 *     contracts each wake — nothing changes mid-turn).
 *
 * On a SELF-set the response carries the full mode contract (P-008: the
 * always-present prompt holds only the one-line index; the contract loads at
 * activation — read it NOW, it is binding while the mode is on).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity, ADMIN_COORD_UI_OWNER } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { sendMessage } from '../coordination/messages';
import { modeById, MODES, modeImpliesAutonomy, modeRequiresSubject, resolveImpliedModes } from '../../modes/registry';
import { getSelectedModeDefinitions, type SelectedModeDefinition } from '../../agent-identities/source';
import { setMode, getModeSubject, getModes } from '../../modes/store';
import { goalHolderPolicyProblem, readGoalLaunchSettings } from '../../goal-launch-settings';
import { assertFact, retractFact, FACT_BODY_MAX_CHARS } from '../../agent-facts/store';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { refreshControlAnchorAfterMutation } from '../coordination/control-anchor';
import { attestModeControlConsumerView } from '../coordination/control-anchor-consumer-view';
import { deactivateLoopForGoal, getLoopStatus } from '../../harness/routines/loop';
import { notifyGoalHolderHandoff } from '../../goals/holder-handoff';

const MODE_IDS = MODES.map((m) => m.id);

/**
 * Key prefix for the standing fact a mode's `instructions` are asserted under
 * (session-chat-popup-timestamps-and-modes-2026-08-09 D-002).
 *
 * One key PER MODE, not one per call: the fact is an UPSERT target, so
 * re-scoping a running drain overwrites the standing instruction rather than
 * stacking a second one beside it — and turning the mode off has exactly one
 * key to retract.
 */
export const MODE_INSTRUCTIONS_KEY_PREFIX = 'mode-instructions:';

export function modeInstructionsFactKey(modeId: string): string {
  return `${MODE_INSTRUCTIONS_KEY_PREFIX}${modeId}`;
}

/**
 * The fact body. OPERATIVE CLAUSE FIRST, provenance last — deliberately, because
 * the store hard-clips at FACT_BODY_MAX_CHARS and the caller's `instructions`
 * may be longer than everything else here combined. Clipping the "who set it"
 * tail costs an anchor; clipping the instruction itself would silently change
 * what the agent is told to do.
 */
export function renderModeInstructionsFact(opts: {
  modeId: string;
  instructions: string;
  ownerDirected: boolean;
  setBy: string;
}): string {
  const who = opts.ownerDirected ? 'the owner' : opts.setBy;
  return (
    `${opts.modeId.toUpperCase()} SCOPE — while '${opts.modeId}' is on, obey this verbatim: ` +
    `${opts.instructions.trim()} ` +
    `(set by ${who}; retracted when the mode is turned off)`
  );
}

/**
 * WI-6949 — the wake-source guard, fired at the ACTION-POINT that creates the hazard.
 *
 * An autonomy mode is an AUTHORIZATION posture ("act, don't ask"); it is NOT a wake
 * source. The engine loop is. An agent that registers AUTO while an interactive owner is
 * present is safe only for as long as the owner keeps replying — the moment they walk
 * away, that agent's only wake source silently disappears and the next turn it ends is
 * its last. A carry-respawn does NOT rescue it: a respawn restores CONTEXT, not a TURN.
 *
 * The playbook already carries a well-written "end-of-turn test" for exactly this
 * (operating-modes-policy.ts), and it did not prevent the 2026-08-02 incident, for two
 * structural reasons worth recording here because they generalize:
 *
 *   1. That rule is anchored to a CESSATION, not an action. Every other rule in the
 *      playbook hangs off something you DO, so something prompts the check. Nothing
 *      prompts you at "about to end the turn" — there is no tool call there.
 *   2. The hazard is created at a TRANSITION nothing marks (owner-present →
 *      owner-absent), but the rule is evaluated at the turn boundary — by which point
 *      dozens of correctly-ended interactive turns have established the opposite prior.
 *
 * So the check belongs HERE: `mode:set` IS the transition. This returns a warning rather
 * than refusing, because a genuinely one-shot AUTO task ("do this now, finish it this
 * turn") needs no loop and must not be blocked.
 */
export function wakeSourceWarning(opts: {
  modeId: string;
  axis: string;
  enabled: boolean;
  loopActive: boolean;
}): string | null {
  if (!opts.enabled) return null;
  // The autonomy axis covers auto + cold-auto; an overlay may also IMPLY auto
  // (drain, goal). Both readings live in the registry — never re-spell the list.
  const impliesAutonomy = opts.axis === 'autonomy' || modeImpliesAutonomy(opts.modeId);
  if (!impliesAutonomy || opts.loopActive) return null;
  return (
    `⚠ NO WAKE SOURCE. '${opts.modeId}' is an AUTHORIZATION posture — it does not make you run. ` +
    'The engine loop is the recurrence mechanism, and you have none armed, so an interactive owner ' +
    'is currently your ONLY wake source. The moment they stop replying, the next turn you end is ' +
    'your last: nothing re-wakes you, and a carry-respawn restores CONTEXT, not a TURN. ' +
    'If this mode is meant to outlive the owner sitting there — which is what "keep going" / ' +
    '"do this from start to finish" / any open-ended directive means — arm the recurrence NOW: ' +
    'loop:arm { intervalSec: 60, goal, workItem }. Ignore this ONLY if you will genuinely finish ' +
    'inside this turn.'
  );
}

/**
 * WI-7302 part 2 — the SYMMETRIC case of `wakeSourceWarning` above.
 *
 * That one fires when you are ABOUT to lose your wake source (registering an
 * autonomy mode with no loop armed). It has no counterpart for the state that
 * actually stranded a fleet on 2026-08-02: you HAD a wake source, and it is
 * gone now. Nothing re-checks after the transition, so the loss is silent.
 *
 * Two design points, both load-bearing:
 *
 *  1. It keys on `wakeSource === 'none'`, NOT on `!loop.active`. The loop-only
 *     reading is the tempting one — it is what the sibling above uses — and it
 *     is WRONG here: a session correctly parked on `events:await
 *     { work-item:claimable }` has no armed loop and is still perfectly
 *     wakeable. The member contract explicitly PRESCRIBES that park, so a
 *     loop-only check would cry wolf precisely at sanctioned behaviour, and a
 *     warning that fires on correct behaviour is worse than no warning.
 *
 *  2. The registered MODE is what makes this actionable, and it is why no
 *     tombstone is needed to answer "did I once have a loop?". The useful
 *     question is not what you HAD, it is what you are SUPPOSED to have — and
 *     an `auto`/`drain` registration is exactly the durable statement that this
 *     session intends to outlive its owner. Modes live in their own store, so a
 *     wipe of `routines` does not take them with it.
 *
 * UNKNOWN (`wakeSource` absent — the leg degraded) returns null: a failed query
 * must never be able to tell a healthy session that it is about to die.
 */
export function wakeSourceLostWarning(opts: {
  modes: readonly string[];
  wakeSource?: 'loop' | 'event' | 'none';
}): string | null {
  if (opts.wakeSource !== 'none') return null;
  const autonomy = opts.modes.filter((m) => modeImpliesAutonomy(m));
  if (autonomy.length === 0) return null;
  return (
    `⚠ WAKE SOURCE GONE. You are registered '${autonomy.join("' + '")}' — an autonomy posture that is ` +
    'meant to outlive an owner sitting there — but NOTHING will wake you unprompted: no armed engine ' +
    'loop, and no standing events:await. The next turn you end is your last, and a carry-respawn ' +
    'restores CONTEXT, not a TURN. Re-arm now: loop:arm { intervalSec, goal } — or, if you are ' +
    'deliberately waiting on a condition, park properly with events:await so something can wake you. ' +
    "If you are genuinely finishing inside this turn, exit the mode with mode:set { mode: '<active mode>', enabled: false, reason: '<why>' } instead of leaving " +
    'a mode registered on a session that cannot act on it.'
  );
}

/**
 * D-003's REPORTING half: say, in one line, what the agent now holds.
 *
 * The cascade is worth little if its effect is invisible — an agent that cannot
 * see it entered AUTO will still write "should I proceed?", which is the exact
 * behaviour the implication exists to remove. So the outcome is rendered as a
 * statement of current posture ("you now hold …"), never as a suggestion.
 *
 * `axis-held` is spelled out rather than folded into "already": being left in
 * COLD-AUTO when you asked for something implying AUTO is a real and useful
 * distinction, and an agent reading "auto: already on" when it is actually in
 * cold-auto has been told something false.
 */
export function renderImpliedNote(
  modeId: string,
  implied: readonly { mode: string; status: string; by?: string; error?: string }[],
): string | null {
  if (!implied.length) return null;
  const parts = implied.map((i) => {
    switch (i.status) {
      case 'set': return `${i.mode} (entered now)`;
      case 'already-on': return `${i.mode} (already on)`;
      case 'axis-held': return `${i.mode} — NOT applied: '${i.by}' already holds that axis and satisfies it`;
      case 'skipped': return `${i.mode} — SKIPPED: ${i.error ?? 'refused'}`;
      default: return `${i.mode} — ⚠ FAILED: ${i.error ?? 'unknown error'}`;
    }
  });
  const failed = implied.filter((i) => i.status === 'failed' || i.status === 'skipped');
  const held = implied
    .filter((i) => i.status === 'set' || i.status === 'already-on')
    .map((i) => i.mode);
  return (
    `'${modeId}' IMPLIES ${implied.map((i) => i.mode).join(' + ')} — applied for you by the system, ` +
    `not something to go do: ${parts.join('; ')}. ` +
    (held.length ? `You now hold: ${[modeId, ...held].join(', ')}. Their contracts are binding on you NOW. ` : '') +
    (failed.length
      ? '⚠ The starred entries did NOT apply — you are in a partial posture; re-run mode:set to repair it (a re-entry is idempotent and repairs missing rows).'
      : '')
  ).trim();
}

export default defineTool({
  name: 'mode:set',
  profile: 'engineer',
  description:
    // DERIVED, never hand-listed: this sentence spelled its own mode list and
    // had already fallen behind the registry (it omitted `test` the moment TEST
    // landed, and `goal` before that). MODE_IDS is the same array that builds
    // the `mode` z.enum below, so the description cannot disagree with what the
    // argument actually accepts (goal-mode-hardening-2026-08-10 P-008).
    `Enter/exit an official session mode (${MODE_IDS.join(' | ')}) for yourself or a peer. ` +
    '{ mode, reason, enabled?, instructions?, agent?, ownerDirected? }. Same-axis modes AUTO-SWITCH (result carries switchedFrom); ' +
    'cross-axis modes stack. Peer-set: reason is delivered to the target with the mode contract. An owner-directed ' +
    'incumbent REFUSES peer overrides. Such an override is downgraded to a request message (stickyConflict:true). Self-set returns the ' +
    'full binding contract — read it. Audited in agent_mode_changes.',
  guidance: {
    when:
      'The user (or your judgment under AUTO) puts the session in a mode — "auto mode", "ideate", "drain the backlog", ' +
      '"grade X" — or you need to redirect a peer\'s operating posture with a reason they will see. Pass ' +
      'ownerDirected:true ONLY when the human owner explicitly instructed this mode — it arms the sticky guard peers cannot override.',
    notWhen:
      'Transient per-task instructions that end with the turn — modes are standing session state. Never mode:set a peer ' +
      'to dodge coordination (the reason is delivered and audited); never pass ownerDirected on your own initiative.',
    chaining:
      'mode:set → read the returned contract (self) · coord:orient re-injects active contracts each wake · mode:get { agent } ' +
      'to inspect anyone · exiting: mode:set { mode, enabled:false, reason }. A stickyConflict result means the incumbent is ' +
      'owner-directed: your reason was delivered as a REQUEST — do not retry, wait for the target/owner.',
    /* EI-20356723237531047: same targeted-key drift as mode:get, and this tool is
       the one mode:get's own `chaining` sends you to — so leaving it alone would
       just move the retry one hop down the recommended path. `ownerId` is a declared
       alias below; these redirects cost ZERO prompt weight (uncounted, like `returns`)
       and are paid only when a caller actually gets it wrong. */
    argRedirects: {
      owner: 'agent',
      ownerIds: 'agent',
      agentId: 'agent',
    },
    /* UNCOUNTED by the prompt-weight budget (description + when/notWhen/chaining
       only), and demand-loaded via tools:find — which is exactly where response
       shape belongs: a caller needs it after deciding to call, not in every
       system prompt. The 34-char breach that moved this here is the documented
       failure mode for editing a live tool's description (P-011). */
    returns:
      'ok, mode, axis, target, enabled, noop, switchedFrom, stickyConflict; contract on a self-set enable. ' +
      'IMPLIED MODES (D-003): a mode that implies others enters them FOR you — goal ⇒ auto + ideate, drain ⇒ auto — so ' +
      '`implied[]` reports { mode, status: set | already-on | axis-held (by: the mode holding that axis, e.g. cold-auto, ' +
      'left alone) | skipped | failed }, `impliedNote` states the resulting posture in one line, and `impliedContracts` ' +
      'carries the contracts of newly-entered modes (self-set) — they are binding on you immediately, so read them. ' +
      'A re-entry is idempotent and REPAIRS a missing implied row, which is the fix for a `failed` entry.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  // EI-20228048404089857: this handler never reads ctx.tx and awaits mode,
  // fact, control-anchor, delivery, and wake operations. Retaining the
  // ambient workspace transaction across those independent control-plane
  // awaits pins an org-app pool slot and can make mode:set time out under
  // fleet load. See ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    mode: z.enum(MODE_IDS as [string, ...string[]]).describe('the mode id'),
    reason: z.string().min(1).max(2000).describe('why — MANDATORY; delivered to a peer target verbatim'),
    instructions: z
      .string()
      .max(4000)
      .optional()
      .describe(
        `SCOPE INSTRUCTIONS that must survive compaction — e.g. drain "all bugs except the ones related to the p2p features". Delivered with the mode change AND asserted as a standing fact on the target (key '${MODE_INSTRUCTIONS_KEY_PREFIX}<mode>'), so it is re-injected VERBATIM on every wake until the mode is turned off, which retracts it. Clipped at ${FACT_BODY_MAX_CHARS} chars. Use \`reason\` for WHY the mode changed; use this for WHAT the mode is scoped to.`,
      ),
    subject: z
      .string()
      .max(200)
      .optional()
      .describe(
        'WHAT this mode is about — required for a subject-requiring mode (goal: the harness_shared.goals.id). ' +
          'Omit to leave an incumbent subject untouched. Prefer goals:start / goals:create, which open the goal ' +
          'AND stamp this atomically; pass it here only when re-registering a mode whose goal already exists.',
      ),
    enabled: z.boolean().optional().describe('default true; false ⇒ exit the mode'),
    agent: z.string().max(120).optional().describe('target ownerId (exact, e.g. su-…); omit for yourself'),
    ownerId: z
      .string()
      .max(120)
      .optional()
      .describe(
        'Compatibility alias for `agent`, for callers carrying the roster/presence field name; normalized to `agent` before use. Pass one or the other — `agent` wins if both are given.',
      ),
    ownerDirected: z
      .boolean()
      .optional()
      .describe('the human owner explicitly instructed this mode (self-set only) — arms the owner-sticky guard'),
  }),
  result: z
    .object({
      ok: z.unknown().optional(),
      mode: z.unknown().optional(),
      axis: z.unknown().optional(),
      target: z.unknown().optional(),
      enabled: z.unknown().optional(),
      noop: z.unknown().optional(),
      switchedFrom: z.unknown().optional(),
      stickyConflict: z.unknown().optional(),
      status: z.unknown().optional(),
      contract: z.unknown().optional(),
      implied: z.unknown().optional(),
      impliedNote: z.unknown().optional(),
      impliedContracts: z.unknown().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    // Normalize the alias at the boundary so the self/peer split, the sticky
    // guard and delivery below all consume the canonical `agent` selector only.
    const target = (args.agent ?? args.ownerId)?.trim() || ident.ownerId;
    const isSelf = target === ident.ownerId;
    const enabled = args.enabled !== false;
    const def = modeById(args.mode);
    if (!def) return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: `unknown mode '${args.mode}'` }) }] };

    // The admin coord/mode UI (P-003/P-004) acts on the owner's behalf when it
    // sets a mode on the agent session the human is chatting with — a PEER-set
    // (setBy !== ownerId) that nonetheless carries verified owner authority.
    // resolveAgentIdentity already ties this ownerId to the admin route's
    // synthesized `?client=` (never client-suppliable from an ordinary agent
    // context), so this is a tool-layer-VERIFIED check, not a trusted claim.
    const callerIsOwnerAuthority = ident.ownerId === ADMIN_COORD_UI_OWNER;
    const ownerAuthorized = isSelf || callerIsOwnerAuthority;
    // EI-22179589084262757 — resolveConcreteWorkspaceId, NOT `ident.workspaceId ?? 'default'`.
    // `ident.workspaceId` is `'*'` for a superuser session that chose no workspace
    // (_mcp-handler's `workspaceId || '*'` fallback), and `'*'` is TRUTHY, so the old
    // `??` let it through: the wildcard is a read-scoping sentinel and is never a
    // storable workspace value — a row stamped with it is invisible to every
    // concrete-workspace read (see resolveConcreteWorkspaceId's contract, EI-3409/WI-892).
    // MEASURED 2026-09-02 before this fix: harness_shared.agent_modes held 95 rows under
    // '*' across 48 distinct owners (plus 6 'default', 2 'papercusp'), i.e. 48 agents had
    // registered a mode that no concrete read could see — the "a registered mode survives
    // compaction" contract failing silently. The same variable feeds the mode row AND the
    // mode-instructions fact below, which is why it is fixed here rather than at either
    // write: fixing only one would SPLIT a session's mode row and its instructions across
    // two workspaces, which is worse than being consistently wrong.
    const workspaceId = resolveConcreteWorkspaceId(ident.workspaceId);

    // A GOAL holder owns the work being judged. Its own session cannot become
    // the GRADE/TEST verifier; ordinary implementation tests remain available.
    if (enabled && isSelf && (def.id === 'grade' || def.id === 'test')) {
      let rows: Awaited<ReturnType<typeof getModes>>;
      try {
        rows = await getModes(workspaceId, target);
      } catch (error) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'goal_verifier_authority_unreadable', detail: error instanceof Error ? error.message : String(error) }) }] };
      }
      if (rows.some((row) => row.mode === 'goal')) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'goal_holder_self_verification_refused', detail: `Launch a separate ${def.id.toUpperCase()} verifier with capability:launch-agent { goalVerifier:'${def.id}' }.` }) }] };
      }
    }

    // Capture the incumbent GOAL subject before clearing it. The mode row is
    // deleted by setMode, so this is the only point where the surrendered
    // authority can still be joined to its armed loop.
    let incumbentSubject: string | null = null;
    if (modeRequiresSubject(def.id)) {
      try {
        incumbentSubject = await getModeSubject(workspaceId, target, def.id);
      } catch {
        incumbentSubject = null;
      }
    }

    /* EI-20015592992797890 — the door that could enter GOAL mode unattributed.
       `subject` is what every downstream consumer joins on (work_items.goal_id is
       stamped FROM it; the goal stop attributes sessions BY it), and it is
       tri-state in the store: `undefined` PRESERVES the incumbent. So the check
       is on the RESULTING row, not on the argument — a reason-only
       re-registration of an already-attributed session must keep working, which
       is why this reads the incumbent before refusing.

       Measured cause: goals:start and goals:create both stamp the subject (and
       roll back / report when they cannot), while this tool admitted `goal` with
       no way to supply one. The result was not an error but SILENCE — one live
       mode='goal' row with subject NULL, which zeroed both the stamping path and
       the stop path while every surface looked healthy. */
    const supplied = args.subject?.trim() || null;
    if (enabled && modeRequiresSubject(def.id)) {
      // Read the incumbent ONCE — both this guard and the holder-policy guard
      // below need it, and for the same reason: each must tell a genuine ATTACH
      // apart from a re-registration of a session that is already attached.
      // Fail CLOSED: a read error must not admit an unattributed entry, since
      // that is the exact silent state this guard exists to prevent.
      const effective = supplied ?? incumbentSubject;
      if (!effective) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: `mode '${def.id}' requires a subject`,
                detail:
                  `'${def.id}' is ABOUT something, and nothing downstream works without knowing what: ` +
                  'work_items.goal_id is stamped from agent_modes.subject and the goal stop attributes ' +
                  'sessions by it, so entering the mode with no subject does not fail — it silently ' +
                  'zeroes both while every surface still looks healthy (EI-20015592992797890).',
                fix:
                  `Use goals:start (opens the goal AND spawns its agent already in ${def.id} mode) or ` +
                  `goals:create, both of which stamp the subject atomically. Pass subject:'<goals.id>' here ` +
                  'ONLY to re-register a mode whose goal already exists.',
              }),
            },
          ],
        };
      }

      /* ── The holder-policy ATTACH boundary (goal-live-holder-guarantee
         2026-08-18 P-003, D-008) ───────────────────────────────────────────
         Attaching a session to a goal is the moment somebody takes
         responsibility for holding it, so it is the second place the goal must
         have answered "do I need a live holder". `goals:create` / `goals:start`
         cover goals born after P-003; this covers the ones that already exist,
         which — measured 2026-08-19 — is all 18 of them, none carrying a holder
         key.

         SCOPED TO A CHANGING SUBJECT ON PURPOSE, and this is the load-bearing
         line. The guard above records why: `subject` is tri-state and a
         reason-only re-registration of an already-attached session must keep
         working. A holder check that fired on every mode:set would refuse those
         too — i.e. it would break the live GOAL-mode agents whose goals are
         exactly the undeclared population, turning a declaration gate into an
         outage. So it fires only when a NEW subject is being attached, which is
         the boundary the item names.

         Fails CLOSED on an unreadable goal, like its sibling above: an attach
         admitted because the read failed leaves precisely the state this
         prevents. The three outcomes are distinguished so the message is never
         a guess — `readGoalLaunchSettings` returns a null budget only when no
         row matched, which separates "no such goal" from "goal with no policy"
         at no extra read. */
      const attaching = Boolean(supplied) && supplied !== incumbentSubject;
      if (attaching && def.id === 'goal') {
        const stored = await readGoalLaunchSettings(effective);
        const refusal =
          stored.error != null
            ? `could not read goal '${effective}' launch settings: ${stored.error}`
            : stored.budget == null
              ? `no goal '${effective}' exists to attach to`
              : goalHolderPolicyProblem(stored.settings);
        if (refusal) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  error: `goal '${effective}' has no declared holder policy`,
                  detail:
                    `${refusal} Attaching is where somebody becomes the holder, so it is where the ` +
                    'question has to be answered: a goal that requires a live holder without anyone ' +
                    'having chosen that is how a goal sits reading `active` for days with nothing ' +
                    'pursuing it (the 08-16 escalation this plan closes).',
                  fix:
                    `Declare it, then attach: goals:update { id: '${effective}', ` +
                    "holder: { requireLive: true } } for a goal a session owns, or " +
                    '{ requireLive: false } for one driven by routines rather than a held session. ' +
                    'That door merges the holder policy into the goal\'s existing launch settings, so ' +
                    'it will not disturb a declared ceiling.',
                }),
              },
            ],
          };
        }
      }
    }

    // A mode write must not bind a selected identity whose source or prompt has
    // changed since approval. Resolve the whole implication closure once before
    // the mutation so self and peer delivery use the same selected revision.
    let selected = new Map<string, SelectedModeDefinition>();
    if (enabled) {
      try {
        selected = await getSelectedModeDefinitions([def.id, ...resolveImpliedModes(def.id)]);
      } catch (error) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({
          ok: false, mode: def.id, error: 'selected-mode-definition-unavailable',
          detail: error instanceof Error ? error.message : String(error),
        }) }] };
      }
    }
    const selectedContract = (id: string) => selected.get(id)?.contract ??
      '[selected definition unavailable; run mode:get { contracts: true }]';

    const res = await setMode({
      workspaceId,
      ownerId: target,
      modeId: def.id,
      enabled,
      reason: args.reason,
      setBy: ident.ownerId,
      ownerDirected: args.ownerDirected,
      callerIsOwnerAuthority,
      // Tri-state: omitted ⇒ leave the incumbent's subject untouched.
      ...(supplied ? { subject: supplied } : {}),
    });

    let goalHandoffNotice: Awaited<ReturnType<typeof notifyGoalHolderHandoff>> | null = null;
    let goalHandoffNoticeError: string | null = null;
    if (res.ok && res.goalElection?.predecessorOwnerId) {
      try {
        goalHandoffNotice = await notifyGoalHolderHandoff(workspaceId, res.goalElection);
      } catch (error) {
        goalHandoffNoticeError = error instanceof Error ? error.message : String(error);
        console.warn(
          `[mode:set] GOAL handoff notice failed for ${res.goalElection.goalId} ` +
            `${res.goalElection.predecessorOwnerId} -> ${res.goalElection.ownerId}: ${goalHandoffNoticeError}`,
        );
      }
    }

    // EI-21123319355080521: clearing GOAL authority must also stop the matching
    // armed loop. Do this only after the mode clear commits, and match on the
    // structured loop goal so an unrelated AUTO loop for the same owner survives.
    let goalLoopDeactivated: boolean | null = null;
    if (res.ok && !res.noop && !enabled && def.id === 'goal' && incumbentSubject) {
      try {
        goalLoopDeactivated = await deactivateLoopForGoal(target, incumbentSubject, {
          reason: `mode 'goal' cleared — authority '${incumbentSubject}' revoked`,
          actor: ident.ownerId,
        });
      } catch (e) {
        // The mode clear already landed; keep it successful while surfacing that
        // the loop-side cleanup needs attention rather than hiding the failure.
        console.warn(
          `[mode:set] goal loop deactivation failed for owner=${target} subject=${incumbentSubject}: ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    const control = res.ok && !res.noop
      ? await refreshControlAnchorAfterMutation({
          ownerId: target,
          workspaceId: ident.workspaceId ?? 'default',
          origin: args.ownerDirected && ownerAuthorized ? 'owner' : 'agent',
          actorId: ident.ownerId,
          source: 'mode:set',
          ownerDirected: Boolean(args.ownerDirected && ownerAuthorized),
        })
      : null;
    // WI-10005199 (EI-23770243810745552): `agent_modes` is the WRITE target, but the
    // turn-start hook and dispatch seat read the projected `control_state->modes`, and
    // that projection is fail-soft (a timed-out refresh returns null while the mode
    // write stays committed). Attest the read the consumer will actually do.
    // Exception-only: an agreeing read adds nothing to the result.
    const controlConsumerView = res.ok && !res.noop
      ? attestModeControlConsumerView({ modeId: def.id, enabled }, control)
      : null;

    // WI-6949: an applied autonomy mode with no armed loop leaves the TARGET with no
    // wake source. Read the target's loop (not the caller's) so a peer-set warns about
    // the agent that will actually go inert. Fail-soft — a loop-read hiccup must never
    // fail an applied mode change, so a read error simply suppresses the advisory.
    let wakeWarning: string | null = null;
    if (res.ok && !res.noop && enabled) {
      try {
        const loop = await getLoopStatus(target);
        wakeWarning = wakeSourceWarning({
          modeId: def.id,
          axis: def.axis,
          enabled,
          loopActive: loop?.active === true,
        });
      } catch { /* fail-soft */ }
    }

    /* ── D-002: SCOPE INSTRUCTIONS OUTLIVE THEIR DELIVERY ────────────────────
       [owner 2026-08-09, asked whether drain instructions should be the
       message, a standing fact, or both] — "Both."

       The message below is the PUSH: the agent is told now. It is not enough on
       its own. A drain runs for hours across several compactions, and a reason
       delivered once is gone by the second one — which is precisely how a scope
       instruction quietly stops being obeyed while the mode still reads ON. The
       fact is the DURABILITY half: scoped to the target, folded verbatim into
       every future orient/brief until retracted.

       WHY THIS LIVES IN THE TOOL AND NOT IN THE CHAT UI THAT ASKED FOR IT. The
       durability problem belongs to mode:set's delivery, not to one browser
       surface, so putting it here buys three things a client-side pair of calls
       cannot:
         - RETRACTION IS TOTAL. Every path that disables the mode clears the
           instruction — an agent exiting drain itself, an su clearing a peer,
           the popup's Off row. A client-side retract only covers the button it
           is wired to, and D-002 is explicit that a stale standing instruction
           delivered verbatim on every wake is WORSE than none.
         - IT CANNOT OUTLIVE A REFUSED WRITE. Gated on `res.ok`, so an
           owner-sticky refusal (stickyConflict) leaves no standing instruction
           for a mode change that never applied. Two client calls race exactly
           there.
         - NO NEW BROWSER-FACING FACTS DOOR. The alternative is an
           /api/admin/facts/assert proxy — a general fact-writing surface opened
           for one narrow use.

       Deliberately NOT gated on `!res.noop`: re-scoping a RUNNING drain (same
       mode, new instructions) is a no-op mode-wise and is exactly the case that
       must still rewrite the fact. Upserting on one key per mode is what makes
       that safe.

       `instructions` OMITTED and `instructions: ''` mean different things on
       purpose: omitted leaves any standing instruction alone (a caller that
       predates this field must not silently clear one), empty explicitly clears
       it — which is what the popup sends when the owner empties the box.

       Fail-soft, like the delivery below and for the same reason: the mode
       change is already applied and audited, so a facts hiccup degrades the
       change to its pre-D-002 behaviour rather than failing a write that landed. */
    const instructions = args.instructions?.trim();
    let instructionsFact: 'asserted' | 'retracted' | 'failed' | null = null;
    if (res.ok) {
      const scopeRef = target;
      try {
        if (enabled && instructions) {
          await assertFact({
            scope: 'owner',
            scopeRef,
            key: modeInstructionsFactKey(def.id),
            body: renderModeInstructionsFact({
              modeId: def.id,
              instructions,
              ownerDirected: Boolean(args.ownerDirected && ownerAuthorized),
              setBy: ident.ownerId,
            }),
            // P-001/P-002 (facts-require-explicit-expiry-2026-09-02) — the LIFETIME
            // declaration, which this write previously left to the silent 7d default.
            // A mode's standing instructions are normative ("while this mode is on, do
            // X"), so kind:'convention' is the honest modality AND the correct
            // lifetime: it makes them permanent, and it takes them out of the
            // cap-eviction population. Both matter here, because this row's lifecycle
            // is RETRACT-driven — the `else` branch below clears it when the mode is
            // disabled. Under the old default a long-running mode silently lost its
            // instructions after a week (or to an eviction) while still reporting
            // enabled, which is exactly the "policy retracted by a cap" failure P-028
            // exempts conventions from.
            kind: 'convention',
            // A plain anchor, NOT the platform-verified 'owner-turn' token: that
            // one is resolved by the facts tool layer, and claiming it from here
            // would badge the fact with provenance nothing verified.
            sourceRef: `mode:set '${def.id}' by ${ident.ownerId}`,
            createdBy: ident.ownerId,
            // The SAME concrete id the mode row above was written under (resolved once,
            // at the top of the handler). Previously this spread `ident.workspaceId`
            // straight through, so a `'*'` session stamped its instructions fact with the
            // wildcard and no concrete read could fold it back.
            workspaceId,
          });
          instructionsFact = 'asserted';
        } else if (!enabled || instructions === '') {
          const removed = await retractFact({
            scope: 'owner',
            scopeRef,
            key: modeInstructionsFactKey(def.id),
            retractedBy: ident.ownerId,
            reason: `mode '${def.id}' instructions cleared`,
            // Must resolve identically to the assert above, or a clear would look up a
            // different workspace than the one the instruction was written to and
            // silently fail to retract it.
            workspaceId,
          });
          if (removed) instructionsFact = 'retracted';
        }
      } catch (e) {
        // EI-19952118814692217: this used to be a bare `catch {}` — the error was
        // discarded entirely, so a broken assert/retract was undiagnosable from
        // logs (every downstream signal — the mode write, the UI, the peer wake —
        // still said success, because they are all downstream of the mode write,
        // which DID succeed). Fail-soft still degrades the response rather than
        // rolling back the applied mode change; it just stops doing so silently.
        instructionsFact = 'failed';
        console.warn(
          `[mode:set] standing-instructions fact ${enabled && instructions ? 'assert' : 'retract'} failed for ` +
            `mode '${def.id}' scopeRef=${scopeRef}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    type WakeOutcome =
      | {
          woken: number;
          staged: number;
          stagedTargets?: string[];
          fanoutCapped?: string[];
          timedOutTargets?: string[];
        }
      | { failed: true };
    let wakeOutcome: WakeOutcome | null = null;

    // Peer-set: deliver the why (+ contract on enable) — or the downgraded
    // REQUEST when the owner-sticky guard refused the write. Fail-soft: a
    // delivery hiccup never rolls back an applied mode change.
    if (!isSelf && (res.ok || res.stickyConflict)) {
      const verb = !res.ok ? 'REQUESTS (owner-sticky refused)' : enabled ? 'set you to' : 'cleared';
      try {
        await sendMessage(ident, {
          to: [target],
          summary: `mode: ${ident.ownerId} ${verb} '${def.id}' — ${args.reason.slice(0, 140)}`,
          body:
            `${ident.ownerId} ${verb} mode '${def.id}' (${def.axis} axis).\nReason: ${args.reason}` +
            /* The instruction is the operative half of this message, so it gets
               its own labelled line rather than being folded into the reason —
               and it is repeated here even though it also stands as a fact,
               because this delivery is what reaches the agent MID-RUN. */
            (res.ok && enabled && instructions
              ? `\n\nSCOPE INSTRUCTIONS — obey verbatim while this mode is on:\n${instructions}` +
                (instructionsFact === 'asserted'
                  ? `\n(Also standing as a fact on you, key '${modeInstructionsFactKey(def.id)}', re-injected every wake until this mode is turned off.)`
                  : '')
              : '') +
            (res.ok && res.switchedFrom ? `\nAuto-switched from same-axis mode '${res.switchedFrom}'.` : '') +
            /* D-003: a peer-set target learns about its implied modes HERE, and
               gets their contracts too — it never sees the tool result, so
               without this it would be silently bound by rules it was never
               handed. Same reason the primary contract is attached below. */
            (res.ok && res.implied?.length
              ? `\n\n${renderImpliedNote(def.id, res.implied)}` +
                res.implied
                  .filter((i) => i.status === 'set')
                  .map((i) => `\n\nBinding contract — '${i.mode}':\n\n${selectedContract(i.mode)}`)
                  .join('')
              : '') +
            (res.ok && enabled ? `\nEffective from your NEXT turn. Binding contract:\n\n${selectedContract(def.id)}` +
              `\nSource revision: ${selected.get(def.id)?.sourceRevision}; definition revision: ${selected.get(def.id)?.contractRevision}` : '') +
            (wakeWarning ? `\n\n${wakeWarning}` : ''),
          extra: { mode_change: { mode: def.id, enabled, applied: res.ok === true, stickyConflict: res.stickyConflict === true, by: ident.ownerId } },
        });
      } catch { /* fail-soft */ }

      /* WAKE the target — session-chat-popup-timestamps-and-modes-2026-08-09
         P-004. [owner 2026-08-09] "chanfing the mode didnt send a message to the
         [agent] shouldnt mode changes also automatically message the agent?"

         The message above was ALREADY being sent; what was missing is that
         `sendMessage` is the raw append-to-outbox seam and does not wake anyone
         (the wake lives one layer up, in coord:send's own tool). So a mode set
         on a LIVE, working agent sat unread in its inbox until that agent
         happened to take another turn — which, for an agent parked on an
         `events:await`, can be a very long time. The owner flips a posture and
         nothing observable happens, which is indistinguishable from the write
         having failed.

         A mode change is precisely the kind of message that must not wait for
         the next turn: it CHANGES THE CONTRACT the agent is operating under, and
         every turn it takes before reading it is a turn taken under the old one.

         Fail-soft, and deliberately AFTER the applied write: waking is a
         courtesy on top of a durable inbox row, so a wake failure must never
         roll back or fail an applied mode change. A miss simply degrades to the
         pre-existing behavior — the agent reads it on its next turn. */
      try {
        const { wakeRecipients } = await import('../coordination/inbox-wake');
        const result = await wakeRecipients([target], {
          summary: `mode '${def.id}' ${enabled ? 'set' : 'cleared'} by ${ident.ownerId}`,
          source: 'mode:set',
          workspaceId: ident.workspaceId ?? undefined,
        });
        wakeOutcome = {
          woken: result.woken,
          staged: result.staged,
          ...(result.stagedTargets?.length ? { stagedTargets: result.stagedTargets } : {}),
          ...(result.fanoutCapped?.length ? { fanoutCapped: result.fanoutCapped } : {}),
          ...(result.timedOutTargets?.length ? { timedOutTargets: result.timedOutTargets } : {}),
        };
      } catch {
        // Fail-soft — the durable inbox row already landed above, but callers
        // must still be able to distinguish a wake failure from a fired wake.
        wakeOutcome = { failed: true };
      }
    }

    const payload: Record<string, unknown> = {
      ok: res.ok,
      mode: def.id,
      axis: def.axis,
      target,
      enabled,
      noop: res.noop ?? false,
      ...(goalLoopDeactivated !== null ? { goalLoopDeactivated } : {}),
      switchedFrom: res.switchedFrom ?? null,
      stickyConflict: res.stickyConflict ?? false,
      ...(res.goalElection ? { goalElection: res.goalElection } : {}),
      ...(res.goalElectionConflict ? { goalElectionConflict: res.goalElectionConflict } : {}),
      ...(goalHandoffNotice ? { goalHandoffNotice } : {}),
      ...(goalHandoffNoticeError ? { goalHandoffNoticeError } : {}),
      ...(res.stickyConflict ? { note: 'incumbent is owner-directed; your reason was delivered as a REQUEST — do not retry' } : {}),
      /* Whether entering this mode changed the AUTONOMY posture — the same
         reading `wakeSourceWarning` gates on above, published so out-of-process
         callers stop re-deriving it. The userpromptsubmit provenance hook is the
         caller that forced this: it announces an auto-registered mode to the
         agent, and its announcement said "the ask-first default is SUSPENDED"
         for EVERY mode. That is true of auto and drain and false of ideate and
         audit, which imply nothing — so the hook was telling agents entering a
         read-only or ideation posture that they had been granted autonomy.
         A Python hook cannot import the registry, so the honest options were a
         second hardcoded list of autonomy-implying ids (the drift generator this
         repo names explicitly) or this field. `modeImpliesAutonomy` reads the
         `implies` closure, so a mode that gains or loses autonomy updates this
         answer with no second edit. */
      impliesAutonomy: def.axis === 'autonomy' || modeImpliesAutonomy(def.id),
      ...(res.ok && enabled && isSelf ? {
        contract: selectedContract(def.id),
        definitionRevision: selected.get(def.id)?.contractRevision,
        sourceRevision: selected.get(def.id)?.sourceRevision,
      } : {}),
      /* D-003 — the cascade is reported, never inferred. `impliedNote` is the
         line an agent actually reads; `implied` is the machine-readable detail.
         The CONTRACTS of newly-entered modes ride along on a self-set for the
         same reason `contract` above does: the agent is now bound by rules it
         has never read, and "read it NOW" only works if it is here. */
      ...(res.implied?.length
        ? {
            implied: res.implied,
            impliedNote: renderImpliedNote(def.id, res.implied),
            ...(isSelf
              ? {
                  impliedContracts: Object.fromEntries(
                    res.implied
                      .filter((i) => i.status === 'set')
                      .map((i) => [i.mode, selectedContract(i.mode)])
                      .filter(([, c]) => c),
                  ),
                }
              : {}),
          }
        : {}),
      /* Reported so a caller can SEE the durability half landed. 'failed' is
         surfaced rather than swallowed: the mode still applied, but the
         instruction is now push-only and will not survive the agent's next
         compaction — which the caller can act on (re-send it, or retry). */
      ...(instructionsFact
        ? { instructionsFact, instructionsFactKey: modeInstructionsFactKey(def.id) }
        : {}),
      ...(wakeOutcome ? { wake: wakeOutcome } : {}),
      ...(wakeWarning ? { wakeSource: 'owner-only', wakeSourceWarning: wakeWarning } : {}),
      ...(control ? { controlGeneration: control.generation } : {}),
      ...(controlConsumerView?.divergedFromWrite ? { controlConsumerView } : {}),
      ...(res.error ? { error: res.error } : {}),
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  },
});
