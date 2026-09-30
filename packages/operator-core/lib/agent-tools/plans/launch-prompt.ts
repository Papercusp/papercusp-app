/**
 * The kickoff first-turn text for a plan launch — a SINGLE pure source shared by
 * both delivery paths so they can never drift:
 *   - headless `plans:launch` (this lib's launch.ts) seeds it as the agent's first
 *     `role:'user'` turn;
 *   - the interactive `psu` launcher seeds it as the backend CLI's positional first
 *     turn for a scripted plan launch (improve-fleet-launch-autokickoff / EI-5503).
 *     bootstrap-su returns it on `kickoffPrompt`; the launcher delivers it.
 *
 * Deliberately dependency-free (no DB / runner / agent-mcp imports) so the bootstrap
 * route + any launcher can import it without pulling launch.ts's heavy module graph.
 */

/** The plan a launch is bound to — baked VERBATIM into the kickoff so the agent
 *  never has to recover the slug from context. Weak-model guard proven necessary
 *  2026-07-03: ornith leader session 10115 was handed "the plan" with no slug in
 *  the kickoff, failed to extract it from coord:orient's launched-by fact, called
 *  plans:get slug-less, listed plans twice, then PARKED on an interactive `ask`
 *  ("Which plan slug?") until killed. */
export interface LaunchPlanRef {
  slug: string;
  harness?: string | null;
}

function plansGetArgs(plan: LaunchPlanRef): string {
  const h = (plan.harness ?? '').trim();
  return `{ slug: "${plan.slug}"${h ? `, harness: "${h}"` : ''} }`;
}

/** coord:orient args for a plan-bound kickoff — the P-002 (WI-5228) orient-first
 *  entry point: orient folds the bound plan's `## Now` + next actionable item +
 *  the caller's claim state, so the lean kickoff points here instead of walking
 *  plans:get by hand. The slug stays VERBATIM (the plan binding is part of the
 *  irreducible delta — ornith session 10115 parked forever when a kickoff said
 *  "the plan" without naming it). */
function orientArgs(plan: LaunchPlanRef): string {
  return `{ intent: "<one line on what you're starting>", planSlug: "${plan.slug}" }`;
}

/**
 * kickoff-prompt-absorption-2026-07-17 P-004: how much guard text a kickoff
 * carries, keyed by backend/model family.
 *
 * - 'full' — every weak-model guard clause (the receipts live on the branches
 *   below: ornith sessions 9870/9885/9891/9981/10115, EI-7000). The DEFAULT for
 *   every caller that doesn't say, so pre-P-004 call sites stay byte-identical.
 * - 'lean' — the irreducible delta only (plan binding + orient pointer +
 *   completion integrity, plus the routing gate on the AUTO-off branch). Safe
 *   ONLY where the guarded behavior became STRUCTURAL:
 *     · the plans:get ceremony + "read ## Now, pick the next item" walk →
 *       coord:orient's plan-bound fold (P-002 / WI-5228);
 *     · "don't hunt a plan FILE with read/bash/find/grep" → the Claude Code
 *       PreToolUse plans-read-guard hook (P-003b / WI-5229) — claude-only;
 *     · "never call MCP tools from inside eval / don't invent an eval tool" →
 *       the server-side unknown-tool referral teaching error (P-003a / EI-9011).
 */
export type KickoffGuardProfile = 'full' | 'lean';

/**
 * pot-seat-pools-prose-ux-2026-07-18 P-007/P-013/P-014: a plain-data summary of
 * this workspace's pot-wide standing remote seat-offer inventory, resolved by
 * the (impure) caller via `plans/remote-seat-inventory.ts` and passed in here —
 * this module stays dependency-free (no DB import), per the file-level
 * discipline above.
 */
export interface RemoteSeatSummary {
  /** This workspace resolves to exactly one shared Hive (the plan's pot IS
   *  shared) — resolveWorkspaceHiveScope kind==='one'. False for none/many
   *  (ambiguous or purely local — never guess). */
  potShared: boolean;
  /** Distinct GitHub-identity donors with an OPEN standing seat-offer visible
   *  in this pot right now (fleet-scoped offers today; pot-scoped too once
   *  P-001 lands — the read is fleetSlug-agnostic, so it needs no change). */
  donorCount: number;
  /** Sum of advertised seat counts across those open offers. */
  totalSeats: number;
  /** P-013 ("donors named"): the offering hosts' friendly `hostLabel`s
   *  (SeatOfferPayload.hostLabel), deduped + sorted — never a GitHub identity
   *  (M19: account/identity stays local). Omitted/empty when no donor set a
   *  label; the clause below falls back to the anonymous count phrasing. */
  donorLabels?: string[];
}

/**
 * P-007 (named-verb discipline, sessions 9870/9865) + P-013 (seat-inventory
 * disclosure, named donors/counts, empty-inventory is not a dead end) + P-014
 * ("add your own slots?" ask) — ONE prompt-UX lane, folded into option (C)'s
 * text. `remoteSeats` omitted/null/unshared-pot ⇒ byte-identical to the
 * pre-P-007 static text (no regression for a local-only workspace).
 */
function remoteFleetOptionClause(remoteSeats?: RemoteSeatSummary | null): string {
  if (!remoteSeats || !remoteSeats.potShared) {
    return (
      'launch a fleet of agents to parallelize it (executed in ONE call with the ' +
      '`fleet:launch-on-plan` tool — never a hand-built psu command)'
    );
  }
  if (remoteSeats.donorCount > 0) {
    const slotWord = remoteSeats.totalSeats === 1 ? 'slot' : 'slots';
    const peerWord = remoteSeats.donorCount === 1 ? 'peer' : 'peers';
    const labels = remoteSeats.donorLabels?.filter((l) => l.trim().length > 0) ?? [];
    // P-013: name the donors when at least one offering host set a friendly
    // hostLabel; fall back to the anonymous count phrasing when none did (a
    // label is optional at delegate time — never invent one).
    const fromClause =
      labels.length > 0
        ? `from ${labels.join(', ')}`
        : `from ${remoteSeats.donorCount} ${peerWord} in this pot`;
    return (
      `launch a fleet — locally, or on the pot's remote seats (I see ${remoteSeats.totalSeats} agent ` +
      `${slotWord} available ${fromClause}) — executed in ONE ` +
      "call with the `fleet:launch-on-plan` tool (`placement:'remote'` for the pot's seats; omit or " +
      "`'local'` to stay on this machine — never a hand-built psu command). If they opt for remote, " +
      "also ask whether they'd like to add their own agent slots to this fleet too (`resource:delegate`) " +
      '— worth asking especially when the remote inventory is short. A refusal or non-arrival is ' +
      'debuggable with `p2p:trace`.'
    );
  }
  return (
    "launch a fleet — locally (this pot has no standing remote seat offers yet, so remote placement " +
    "isn't available right now; a peer would need to `resource:delegate` seats to this pot first, and " +
    "you can offer to relay that ask) — executed in ONE call with the `fleet:launch-on-plan` tool — " +
    'never a hand-built psu command'
  );
}

/**
 * The backend → guard-profile mapping (P-004): 'lean' ONLY for `claude` — the
 * one backend whose installed hook layer carries the P-003b plans-read guard.
 * `omp` (ornith/local) is the weak-model family P-004 explicitly keeps on full
 * text until measured unnecessary; `codex` is conservative-full (its CLI runs
 * no papercusp PreToolUse hooks). Unknown/null → 'full'.
 */
export function kickoffGuardProfileForAgent(
  agent: string | null | undefined,
): KickoffGuardProfile {
  return agent === 'claude' ? 'lean' : 'full';
}

/**
 * The first user turn for a launch — the supplied note, or a default kickoff when
 * the launch carried none. When `plan` is provided, the kickoff names the exact
 * slug (+ harness) and the literal `plans:get` args (appended to a custom note
 * too — the note author may not have restated the slug). Pure.
 */
export function deriveLaunchPromptText(
  note: string | null | undefined,
  autoMode = true,
  plan?: LaunchPlanRef | null,
  /** P-004: guard profile for the DEFAULT (no-note) kickoff branches. Omitted ⇒
   *  'full', so every pre-P-004 caller is byte-identical; bootstrap-su passes
   *  kickoffGuardProfileForAgent(agent). Lean applies only when a plan is bound
   *  (with no binding there is no orient target to point at instead). */
  guards: KickoffGuardProfile = 'full',
  /** pot-seat-pools-prose-ux-2026-07-18 P-007/P-013/P-014: pot-wide remote
   *  seat-offer inventory (resolved by the caller — see RemoteSeatSummary's
   *  doc). Only affects the AUTO-OFF routing-gate branches below; omitted ⇒
   *  today's static option (C) text (no behavior change for existing callers). */
  remoteSeats?: RemoteSeatSummary | null,
): string {
  const trimmed = (note ?? '').trim();
  if (trimmed.length > 0) {
    return plan
      ? `${trimmed}\n\n(You were launched on plan \`${plan.slug}\` — read it with the ` +
          `\`plans:get\` MCP tool, args ${plansGetArgs(plan)}.)`
      : trimmed;
  }
  const lean = guards === 'lean' && plan != null;
  // AUTO ON — a headless fleet member / no human at the keyboard: it MUST start
  // working the plan immediately or it parks idle. Keep the direct work order —
  // but carry the SAME weak-model guards as the AUTO-off branch (proven necessary
  // by the 2026-07-03 ornith fleet run): member session 9981 had NO plans:get
  // guidance here and burned its first turns hunting a plan FILE (4× `cat
  // docs/plans/…`, `find`, then a node -e read) before recovering via coord:orient;
  // and leader 9980, after two tool timeouts, marked an item done "based on prior
  // verification" that never happened (EI-7000) — hence the completion-integrity
  // clause.
  if (autoMode) {
    // P-004 lean (claude): the irreducible delta — plan binding (verbatim slug) +
    // orient pointer + completion integrity. Clauses REMOVED here, each with its
    // landed absorber:
    //  · "plans:get with EXACTLY these args / read ## Now / pick the next item"
    //    → coord:orient's plan-bound fold returns all three (P-002 / WI-5228);
    //  · "the plan lives in the coordination system, NOT on disk — do NOT hunt
    //    with read/bash/find/grep" → the PreToolUse plans-read-guard hook
    //    redirects those reads to plans:get at the point of failure (P-003b /
    //    WI-5229);
    //  · "NEVER call MCP tools from inside eval (NameError)" → the server-side
    //    unknown-tool referral teaching error (P-003a / EI-9011).
    // The completion-integrity clause (EI-7000) has NO structural absorber —
    // it stays in both profiles.
    if (lean && plan) {
      return (
        `Begin: advance the plan \`${plan.slug}\`. Orient FIRST: call the \`coord:orient\` ` +
        `MCP tool with ${orientArgs(plan)} — its response folds the plan's \`## Now\` block, ` +
        'the next actionable item, and your claim state; claim your lane and work that item. ' +
        'Completion integrity: mark an item done ONLY after the work was actually done and ' +
        'verified — a tool timeout or error means RETRY or report the blocker, never ' +
        'mark-done-anyway.'
      );
    }
    const readClause = plan
      ? `Begin: advance the plan \`${plan.slug}\`. Read it by calling the \`plans:get\` MCP ` +
        `tool with EXACTLY these args: ${plansGetArgs(plan)} — copy them verbatim; do NOT ` +
        'ask which plan or hunt for one. The plan lives in the coordination system, NOT on disk, so do '
      : 'Begin: advance this plan. Read it by calling the `plans:get` MCP tool with its ' +
        'slug (pass `harness`) — the plan lives in the coordination system, NOT on disk, so do ';
    return readClause +
      'NOT hunt for a plan file with `read`, `bash`, `find`, or `grep`. Call MCP tools ' +
      'directly (or via `tools:invoke { name, args }`) — NEVER from inside `eval` (the eval ' +
      'runtime has no `tools` object; that is a NameError). Then read the `## Now` block, ' +
      'pick up the next actionable item, and work it. Completion integrity: mark an item ' +
      'done ONLY after the work was actually done and verified — a tool timeout or error ' +
      'means RETRY or report the blocker, never mark-done-anyway.';
  }
  // AUTO OFF — a lead/solo agent WITH a human present. Per the persona routing
  // gate (WHAT/HOW/WHO), it must NOT silently start editing: read the plan, then
  // present the execution options and let the owner choose.
  //
  // Every clause is a weak-model guard proven necessary by a real ornith run:
  //  · "call the `plans:get` MCP tool … NOT … read/bash/find/grep" — session 9870
  //    burned 29 turns because "read it with the plans:get tool" made it call the
  //    `read` BUILTIN with path:"plans:get", then flail with `find`/`grep`/`ls`.
  //  · "invoke it via `tools:invoke` … do NOT invent an `eval`/`code` tool" — session
  //    9885 abused `lsp` and session 9891 DOOM-LOOPED calling a HALLUCINATED `eval`
  //    tool (26 no-op calls) instead of the real MCP tool; naming the reliable
  //    tools:invoke escape hatch + forbidding the invented tool breaks that loop.
  //  · "(C) … executed with the `fleet:launch-on-plan` tool" — sessions 9870/9865
  //    chose C, then never launched (the tool was hidden) or hand-built a broken psu
  //    command; naming the exact verb makes option C real.
  //  · Option (B) read "hand it to the Mug" until 2026-08-31 (EI-21972876172423322).
  //    That is the SAME defect as the 9870/9865 case in its terminal form: not an
  //    unnamed verb, but a nonexistent RECIPIENT. The Mug/Kettle/Cup tier is
  //    permanently retired — MUG_KETTLE_SYSTEM deleted, `mugKettleSystemEnabled()`
  //    a constant false, every spawn door and the D-017 actuators refusing — so an
  //    agent following this text offered the owner a menu whose middle option was a
  //    fabricated capability, discoverable as such only after they picked it. This
  //    text is consumed by plans/launch.ts, bootstrap-su.ts AND carry-respawn.ts, so
  //    it reached essentially every su. (B) is now the ALREADY-RUNNING fleet, which
  //    is also what makes it genuinely distinct from (C)'s launch-a-NEW-fleet.
  //    ⚠ Keep every option's recipient and verb REACHABLE — this gate's whole value
  //    is that the owner's choice can actually be executed the moment they make it.
  // P-004 lean (claude), AUTO-off: plan binding + orient pointer + the routing
  // gate. The routing gate + the named `fleet:launch-on-plan` verb are BEHAVIOR,
  // not tool-usage guards — no absorber landed for them, so they stay in both
  // profiles (sessions 9870/9865 chose option C and then never launched because
  // the verb went unnamed). Removed tool-usage guard clauses and their landed
  // absorbers: identical to the AUTO branch above (P-002 / WI-5228 orient fold,
  // P-003b / WI-5229 plans-read hook, P-003a / EI-9011 eval referral).
  if (lean && plan) {
    return (
      `You've been handed the plan \`${plan.slug}\` to implement. Read it FIRST via the ` +
      `\`coord:orient\` MCP tool with ${orientArgs(plan)} — its response folds the plan's ` +
      `\`## Now\` block + the next actionable item (\`plans:get\` ${plansGetArgs(plan)} for ` +
      'the full body). Then, BEFORE doing any work, go through your routing gate: outline ' +
      'the approach and present the execution options — (A) do it yourself, (B) hand it to ' +
      'an ALREADY-RUNNING fleet (`fleet:assignments` to see if one exists, `coord:dispatch` ' +
      `to hand it over), or (C) ${remoteFleetOptionClause(remoteSeats)} — recommend ` +
      'one based on the plan size, and confirm with the owner which to use. Do not start ' +
      'editing until they choose.'
    );
  }
  const gateReadClause = plan
    ? `You've been handed the plan \`${plan.slug}\` to implement. First read it by calling ` +
      `the \`plans:get\` MCP tool with EXACTLY these args: ${plansGetArgs(plan)} — copy them ` +
      'verbatim; do NOT ask which plan or hunt for one. The plan lives in the coordination system, NOT on disk, so '
    : "You've been handed a plan to implement. First read it by calling the `plans:get` " +
      "MCP tool with the plan's slug — the plan lives in the coordination system, NOT on disk, so ";
  return gateReadClause +
    'do NOT use the `read`, `bash`, `find`, or `grep` file tools and do NOT guess a `plan://` or ' +
    'file path. If a papercusp tool is not directly callable, invoke it via `tools:invoke` with ' +
    '`{ name, args }` (e.g. `tools:invoke { name: "plans:get", args: { slug, harness } }`) — do NOT ' +
    'route a tool call through `lsp`, do NOT invent an `eval`/`code` tool, and NEVER call MCP ' +
    'tools from INSIDE `eval` (the eval runtime has no `tools` object — that is a NameError). ' +
    'Then, BEFORE doing any work, go through your routing gate: outline the approach ' +
    'and present the execution options — (A) do it yourself, (B) hand it to an ALREADY-RUNNING ' +
    'fleet (`fleet:assignments` to see if one exists, `coord:dispatch` to hand it over), or (C) ' +
    `${remoteFleetOptionClause(remoteSeats)} — recommend one based on the ` +
    'plan size, and confirm with the owner which to use. Do not start editing until they choose.';
}
