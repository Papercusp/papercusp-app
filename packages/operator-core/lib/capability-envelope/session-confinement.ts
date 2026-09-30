/**
 * session-confinement — the launch-declared, PRIVILEGE-INDEPENDENT tool denial
 * (directed-pair-work-items-2026-08-25 P-003, ruling D-015).
 *
 * WHY THIS EXISTS AND WHY IT IS NOT `ROLE_ENVELOPES`
 * -------------------------------------------------
 * The directed pair (D-001/D-003) needs a handful of tools to be genuinely
 * unreachable by the IMPLEMENTER — completion authority and self-direction belong
 * to the director. D-004 assumed a launch-time denial like NO_SUBAGENT_TOOLS_DENY
 * would do it. It does not, and neither does the role envelope. Measured, not assumed:
 *
 *   1. `--disallowedTools` is CLIENT-side. `spawn-mcp.ts` says it outright at the
 *      superuser-spawn door: "Dispatch capability is unchanged — isSuperuser still
 *      bypasses role gates; only the advertised list narrows." A denied tool stays
 *      dispatchable through `tools:invoke { name }`.
 *   2. `evaluateCapabilityEnvelope` returns `{ withinEnvelope: true, applied: false }`
 *      on `ctx.isSuperuser || ctx.isPowerUser` BEFORE it reads the role — so
 *      `ROLE_ENVELOPES` never evaluates for an su-tier member at all.
 *   3. The implementer MUST be su-tier: `coord:*` is resolveAgentIdentity-gated, and
 *      the whole call-response contract is `coord:send` evidence replies. Demoting it
 *      to a signed spawn removes the channel the design runs on.
 *   4. The envelope's grain is CAPABILITY, not tool. `work_items:complete` and
 *      `scheduler:get_next` both declare `capability:'work_items:write'` — shared by
 *      43 tools including `checkpoint`, `comment`, `claim`, `create`. Denying that
 *      capability to block `complete` would strand the implementer's own progress
 *      recording.
 *
 * D-015's reading: the superuser exemption is not wrong, it is keyed on the wrong
 * predicate for this population. `policy.ts` justifies it as "supervised human
 * sessions keep native-tool ergonomics; the policy is the safety net precisely where
 * there is no human." A directed implementer is exactly a session with NO human; it
 * is su-tier only as a side-effect of needing coord identity. So rather than punch a
 * hole in that exemption, this is a SEPARATE and differently-shaped gate:
 *
 *   ROLE ENVELOPE          = a PRIVILEGE CEILING. "How much are you trusted with?"
 *                            Correctly exempts supervised humans.
 *   SESSION CONFINEMENT    = a SELF-IMPOSED NARROWING declared by the launcher.
 *                            "What did the thing that started you promise you would
 *                            not do?" Privilege is irrelevant to that question.
 *
 * TWO STRUCTURAL GUARANTEES, BOTH BY CONSTRUCTION RATHER THAN BY DISCIPLINE
 * ------------------------------------------------------------------------
 *  A. It CANNOT be bypassed by privilege, because it never receives privilege.
 *     `evaluateSessionConfinement` takes no `ctx`, no `isSuperuser`, no `role`. There
 *     is no privilege check to get wrong, and no future edit can "just add one" without
 *     failing the guard test that pins this module's imports and identifiers.
 *  B. It CANNOT widen, because there is no allow dimension. `SessionToolConfinement`
 *     has `denyTools` and nothing else. The worst a malformed or hostile confinement
 *     can do is deny more. (Same invariant `dynamic-tool-confinement` holds, reached
 *     the same way: remove the widening vocabulary rather than police its use.)
 *
 * ⚠ THE WIRING INVARIANT THAT MAKES OR BREAKS THIS
 * ------------------------------------------------
 * This module is the pure DECISION. It is worth nothing until it is consulted at the
 * dispatch seat that `tools:invoke` ALSO traverses. Consulting it only at the outer
 * MCP tool-call boundary reproduces exactly the theatre it exists to replace: the
 * agent simply routes the denied verb through `tools:invoke` and the gate never runs.
 * `assertConfinementCoversIndirectDispatch` below is the executable statement of that
 * requirement; the seat wiring is a TCB edit and ships as such.
 *
 * Server-or-bundle-safe: pure, no I/O.
 */
import { matchesAny } from './policy';

/**
 * A denial declared by whatever launched the session, travelling WITH the session.
 *
 * Deliberately has no `allowTools`: see guarantee (B). Deliberately carries `imposedBy`
 * and `reason` so a refusal can tell the agent who bound it and why — a wall with no
 * explanation gets probed, a wall with a reason gets respected and reported upward,
 * which is the behaviour the directed pair actually wants.
 */
export interface SessionToolConfinement {
  /** Tool-name globs this session may never invoke, at any privilege level. */
  readonly denyTools: readonly string[];
  /** Why this session is confined — surfaced verbatim in the refusal. */
  readonly reason: string;
  /** Who imposed it (the launching director/fleet), for audit and for the refusal text. */
  readonly imposedBy: string;
}

export interface SessionConfinementDecision {
  /** False ⇒ refuse the call. */
  readonly allowed: boolean;
  /** Whether a confinement was actually present and evaluated (false ⇒ unconfined session). */
  readonly applied: boolean;
  /** Human-readable refusal, including the imposer and their stated reason. */
  readonly reason?: string;
  /** The specific glob that matched — so a refusal is debuggable, not just a wall. */
  readonly matchedGlob?: string;
}

const ALLOWED: SessionConfinementDecision = { allowed: true, applied: true };
const UNCONFINED: SessionConfinementDecision = { allowed: true, applied: false };

/**
 * The key a tool name is MATCHED on: `mcp__<server>__` prefix stripped, and `:`
 * folded to `_`.
 *
 * Clients mangle `server:verb` into `mcp__<server>__server_verb`. A denial that caught
 * only one spelling would be bypassable by invoking the other — the same class of hole
 * as the client-side deny this replaces — so both must land on one key.
 *
 * ⚠ Reversing the mangling is NOT how to do that, and the attempt is a trap worth
 * recording: `server_verb` is ambiguous whenever either half contains an underscore.
 * Splitting on the first underscore turns `work_items_complete` into `work:items_complete`;
 * splitting on the last turns `scheduler_get_next` into `scheduler_get:next`. There is no
 * split that is right for both, because the information was destroyed by the mangling.
 *
 * So instead of reconstructing the colon, both sides FOLD toward the mangled form, which
 * is lossy in the safe direction: the fold can only make two distinct names collide, and
 * a collision on a DENY list can only ever deny more, never less (guarantee B). A name
 * that must stay reachable is therefore protected by the collateral tests, not by luck.
 */
export function toDenyMatchKey(toolName: string): string {
  let name = toolName.trim();
  if (name.startsWith('mcp__')) {
    const sep = name.indexOf('__', 'mcp__'.length);
    if (sep >= 0) name = name.slice(sep + 2);
  }
  return name.replaceAll(':', '_');
}

/**
 * The whole gate. Note the argument shape: there is no `ctx`, no `isSuperuser`, no
 * `role`. That absence IS guarantee (A) — it is not an oversight, and the guard test
 * fails if a later edit introduces one.
 */
export function evaluateSessionConfinement(args: {
  toolName: string;
  confinement?: SessionToolConfinement | null;
}): SessionConfinementDecision {
  const { toolName, confinement } = args;
  if (!confinement || confinement.denyTools.length === 0) return UNCONFINED;

  const key = toDenyMatchKey(toolName);
  for (const glob of confinement.denyTools) {
    // Both sides folded to the same key, so either spelling the caller used matches.
    if (matchesAny(key, [toDenyMatchKey(glob)])) {
      return {
        allowed: false,
        applied: true,
        matchedGlob: glob,
        reason:
          `tool "${toolName.trim()}" is denied for this session by ${confinement.imposedBy}: ` +
          `${confinement.reason} (matched "${glob}"). This denial is declared at launch and ` +
          `is not liftable from inside the session — if this milestone genuinely requires ` +
          `this tool, that is a finding to report upward, not an obstacle to route around.`,
      };
    }
  }
  return ALLOWED;
}

/**
 * The D-004 minimum set, plus the two classes without which the denial is decorative.
 * Every entry carries the reason it is here; an unexplained denial is one nobody dares
 * remove later even when it turns out to be wrong.
 */
export const DIRECTED_IMPLEMENTER_DENY_TOOLS: readonly string[] = [
  // ── D-004 minimum set ────────────────────────────────────────────────────────
  // Completion authority is the director's; the implementer REPORTS evidence and the
  // director decides whether it closes. This is the single most important entry: it is
  // what makes "the director verifies" structural rather than aspirational (D-002).
  'work_items:complete',
  // Self-direction. The implementer executes the milestone it was handed; it never
  // picks its own next one (D-001 — the director gates milestone boundaries).
  'scheduler:get_next',
  // A wake source of its own turns call-response back into an autonomous loop, which
  // is the one structural property the whole design rests on (D-001/D-004).
  'loop:arm',

  // ── Same class as scheduler:get_next — self-acquisition by another door ──────
  'work_items:claim_next',

  // ── Self-lift / self-graduation: a denial an agent can remove is not a denial ──
  // Mirrors dynamic-tool-confinement's no-minting floor for the same reason: without
  // these, everything above is one tool call away from being undone.
  'capability_envelope:*',
  'capability:grant*',
  'capability:revoke*',
  // Tier is risk CLASSIFICATION, and papercuspTierFor consults the runtime override
  // BEFORE the baked table — so a self-re-tier is a self-lift by another door. Globbed
  // rather than exact (`capability_tier:set`): deny-widening is the safe direction for a
  // no-escalation floor, and it covers any future `capability_tier:` sibling for free.
  //
  // ⚠ EI-21475119505876554: this entry read `capability:set-tier` until 2026-08-26 — a
  // name that resolves to NO tool. It denied nothing while reading exactly like coverage.
  // Removed alongside it: `capability:set_protected`, dead for a stronger reason — there
  // is no protected-floor mutation tool in ANY spelling (`capability_envelope:set_role`
  // is the only envelope tool, and its own notWhen states the universal protected floor
  // is not mutable through it). Nothing was narrowed by dropping it.
  //
  // Both survived because a dead deny entry is SILENT by construction: denying too much
  // fails loudly the first time real work is blocked; denying too little fails never.
  // Hence the catalog PIN in session-confinement.test.ts — this list is no longer
  // trusted to be right, it is checked.
  'capability_tier:*',
  'meta:define-*',
  'tools:scaffold',
];

/** Build the confinement a directed implementer launches with. */
export function directedImplementerConfinement(args: {
  /** The coupled director's session id — named in every refusal. */
  directorSid: string;
  /**
   * What this engagement is scoped to, named verbatim in every refusal — the plan the pair
   * launched on, or a single work item when the pair was launched for exactly one.
   *
   * Deliberately NOT a work-item id (it was, until P-004): a confinement is declared at LAUNCH
   * and lasts the session, while the work items it will work arrive one at a time from the
   * director over that session's life. Naming an item here would either be a lie at launch —
   * there is no item yet — or force the confinement to be rewritten per directive, which is a
   * mutable security rail, the thing this design exists to avoid.
   */
  scope: string;
}): SessionToolConfinement {
  return {
    denyTools: DIRECTED_IMPLEMENTER_DENY_TOOLS,
    imposedBy: `pair-director ${args.directorSid}`,
    reason:
      `you are the directed implementer for ${args.scope}; completion authority and ` +
      `work selection belong to the director (D-002/D-004)`,
  };
}

/**
 * The executable statement of the wiring invariant in this module's header.
 *
 * A confinement wired only at the outer tool-call boundary is bypassed by
 * `tools:invoke { name: '<denied verb>' }`. This asserts the gate refuses the INNER
 * name, which is only true if the seat that consults it is the one indirect dispatch
 * also passes through. Called by the guard test; exported so the dispatch wiring can
 * assert it against its own seat rather than trusting a comment.
 */
export function assertConfinementCoversIndirectDispatch(
  evaluate: (toolName: string) => SessionConfinementDecision,
): void {
  const denied = evaluate('work_items:complete');
  if (denied.allowed) {
    throw new Error(
      'session confinement is not consulted at the dispatch seat: a denied tool was allowed. ' +
        'A gate that only runs at the outer tool-call boundary is bypassed by tools:invoke ' +
        'and is exactly the theatre D-015 replaced.',
    );
  }
}
