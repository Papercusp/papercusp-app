/**
 * Shared `--allowed-tools` list for the operator's claude-code spawns.
 *
 * The operator chat surfaces (operator-converse + one-shot tools)
 * use this so the operator's tool surface is identical across the
 * proactive scanner and the conversational brain. Adding a tool here
 * makes it available to the operator everywhere.
 *
 * Claude-code's allowed-tools format for MCP-projected tools is
 *   mcp__<server-name>__<tool-name>
 * where server-name comes from the mcpServers key (we always use
 * `agentmcp`) and tool-name is the dotted-or-colon-separated MCP name
 * exposed by the agent-mcp catalog or a registered plugin.
 */
export const ALL_AGENT_MCP_TOOLS: readonly string[] = [
  // Read-only world model
  'mcp__agentmcp__harness:list',
  'mcp__agentmcp__harness:membership',
  'mcp__agentmcp__harness:get',
  'mcp__agentmcp__harness:status',
  'mcp__agentmcp__tasks:list',
  'mcp__agentmcp__tasks:get',
  'mcp__agentmcp__tasks:create',
  // tasks:update / tasks:close — listed in earlier iterations but no
  // `defineTool` exists; removed to keep the brain's tool surface
  // honest. Add back when the handlers ship.
  'mcp__agentmcp__goals:list',
  'mcp__agentmcp__goals:get',
  // issues:list retired onto the unified work-item surface (coordination-unification-2026-06-23 P-009):
  'mcp__agentmcp__work_items:list',
  // The authoritative "what issue-family work is ACTUALLY claimable now" read
  // (claimable-read-tool-and-sql-encapsulation-audit-2026-07-21 P-001) — the SSOT floors
  // as a tool, so "how many bugs can we still claim / is this drain premature" is answered
  // without raw SQL. Read-only (never claims).
  'mcp__agentmcp__work_items:claimable',
  // Rubrics — the shared-standards store (rubric-driven-observations-2026-06-20
  // P-002). The brain consults active rubrics (the standards agents grade structured
  // observations against) — read-only here; propose/ratify are agent/Queen verbs.
  'mcp__agentmcp__rubrics:list',
  'mcp__agentmcp__rubrics:get',
  'mcp__agentmcp__rubrics:search',
  // The qualitative health TREND of a rubric over time (P-010) — per-criterion
  // rating direction (improving/worsening/stable) over the Overwatch scorecards.
  'mcp__agentmcp__rubrics:trend',
  // Scorecards — the READ side of the every-turn Overwatch scorecard
  // (plan-templates-and-rubric-v2-2026-06-20 P-013). The brain can see emitted
  // rubric scorecards back (completeness via nKeys/missingKeys, emission gaps via
  // the since window) — monitoring-the-monitor.
  'mcp__agentmcp__scorecards:list',
  // Evidence-first single-card drill-down for grading-integrity audits; the
  // default operator needs this when staging is unavailable.
  'mcp__agentmcp__scorecards:get',
  // The emission-freshness check (P-014b) — is the Overwatch emitting COMPLETE scorecards, or
  // silently skipping (stale) / truncating to partials (partial-only)? monitor-the-monitor.
  'mcp__agentmcp__scorecards:freshness',
  // Scan findings live in the self-improvement backlog (unify-agent-launches
  // D-005) — improvements:digest is the operator's "what did the scanner
  // find?" read surface, replacing the retired scans_list/scans_get.
  // improvements:triage is the Queen's type-routing tool (self-learning P-020).
  'mcp__agentmcp__improvements:digest',
  'mcp__agentmcp__improvements:triage',
  // The watchdog's own health/diagnostic read (watchdog-audit-2026-06-09
  // P-010) — "is the auto-capture loop running, what did it see/decline?".
  'mcp__agentmcp__improvements:watchdog-status',
  // Queen-weighting read (self-learning-frontier P-041 / FB-13, D-005): the
  // per-persona per-domain trust weights from recorded bets — what the brain
  // consults before taking a persona's stated confidence at face value.
  'mcp__agentmcp__calibration:summary',
  // The Queen's per-category autonomy ceilings (queen-autonomy-policy B-03):
  // what she may auto-decide vs. must route to the owner. Read-only here on
  // purpose — autonomy:policy_set is owner-authority (D-005: ceilings are the
  // owner's cap, not the Queen's to raise on herself), so it is deliberately
  // NOT on the brain's tool surface; the owner changes ceilings via the
  // settings page / an SU session.
  'mcp__agentmcp__autonomy:policy_get',
  // The decider gate (queen-autonomy-policy B-12 / P-070): per queue item, auto
  // (the Queen may decide without asking) vs gated (→ the owner Queue), with the
  // reasons. Behavior-neutral (always gated) until the owner arms the policy (P-092).
  'mcp__agentmcp__autonomy:decide',
  // The decision-disposition log (queen-autonomy-policy B-13 / P-111): the Queen
  // records what she chose for a considered item (act/defer/reject/route-to-research/
  // no-op) → the decision ledger + the owner's recent-auto-decisions feed.
  'mcp__agentmcp__autonomy:record_disposition',
  // The Queen's own decision-ledger read surface (B-13 / P-113): her reflective
  // view of what she has auto-decided / gated / deferred — summary (the shape) +
  // list (the rows).
  'mcp__agentmcp__decision_ledger:summary',
  'mcp__agentmcp__decision_ledger:list',
  'mcp__agentmcp__harness:escalation',
  'mcp__agentmcp__harness:pending_reviews',
  // Plans read surface — the needs-human inbox + importance the scanner
  // weights recommendations by (planning-attention-importance P-018).
  // plans:items { needsHuman: true } and plans:attention are already
  // importance-sorted; list/get give surrounding plan context. Read-only.
  'mcp__agentmcp__plans:list',
  'mcp__agentmcp__plans:get',
  'mcp__agentmcp__plans:items',
  'mcp__agentmcp__plans:attention',
  // Inbox-triage PASS — re-tier an attention item, audit the why; + message the
  // owning agent in their context (inbox-tiering-and-message-agent-2026-06-05).
  'mcp__agentmcp__inbox:triage',
  'mcp__agentmcp__coord:message-agent',
  // Spawn admission — the brain decides worth-it (unify-agent-spawn-chokepoint
  // P-005/P-006). `new_subagent:approve` is brain-gated (requireRoles); `request`
  // is the agent-initiated side (surfaced here so the brain sees the request shape).
  'mcp__agentmcp__new_subagent:request',
  'mcp__agentmcp__new_subagent:approve',
  'mcp__agentmcp__audit:list',
  'mcp__agentmcp__pending_events:list',
  // hindsight:recall removed 2026-05-31 — the tool was DEPRECATED 2026-05-09 and
  // is unwired (no importer registers it), so advertising it here just produced
  // "tool not found". Memory recall is features:get / features:history / features:search.
  'mcp__agentmcp__search:query',
  'mcp__agentmcp__search:fulltext',
  'mcp__agentmcp__search:semantic',
  // Personal Vault is NOT part of general recall. This explicit tool remains
  // server-side default-deny and resolves the plan-template/binding grant.
  'mcp__agentmcp__personal:search',

  // Pipeline state, read-only (state-plane-adoption-2026-08-02 P-004 / D-006). ONE
  // door onto the registered cells — today all five are release-pipeline cells
  // (gate.greenCheckpoint.verdict/.candidate, git.mainBehindStaging,
  // git.pipelinePosition, deploy.3070.sha). "Is the promotion pipeline stalled / why is
  // nothing shipping" is a governance question this brain repeatedly needs and had NO
  // way to answer: the surface carries no dev:*/release:* tools at all. state:read is
  // the cheap unified answer — read-only, audience-filtered per reader, and it projects
  // an existing resolver rather than deriving anything second.
  //
  // `state:subscribe` is deliberately NOT added. It arms a durable watch + WAKE, and
  // this surface carries no await/watch/wake tool of any kind (pending_events:list is a
  // read) — so a subscription taken here has no consumer. Add it only alongside a real
  // wake path.
  'mcp__agentmcp__state:read',

  // Storage usage (read) — answer "what's using disk / what's safe to trim".
  // The destructive storage:prune is owner-driven via Settings → Storage, not the
  // brain surface.
  'mcp__agentmcp__storage:usage',

  // Persistent memory layer (hybrid claude-file + mem0 store).
  // 4-kind schema: user / feedback / project / reference
  // (memory-taxonomy-and-debt-followups D-001).
  // Per-user scoped via session cookie; harness-shared via harness_slug.
  'mcp__agentmcp__memory:remember',
  'mcp__agentmcp__memory:search',
  'mcp__agentmcp__memory:list',
  'mcp__agentmcp__memory:forget',
  'mcp__agentmcp__memory:update',

  // Spawn primitives over the durable nursery (harness_shared.spawned_agents),
  // Brief 4 of agent-briefs-2026-06-05. These replaced the
  // @papercupai/orchestrator-spawn plugin's orchestrator_* tools, which were dead
  // on this surface (the plugin is not installed, and the standalone agent-mcp
  // server never ran the plugin loader — every call returned "tool not found").
  // They are BUILT-IN tools, so they exist on every surface; what's spawned shows
  // up in fleet:tree and is cancellable with fleet:cancel.
  //
  // ⚠ The cup-spawn entry WAS listed here and has been REMOVED. The
  // Mug/Kettle/cup nursery tier is PERMANENTLY retired: P-068 DELETED
  // `papercusp-mug-kettle-system`, so there is no flag to flip — `cup:spawn` no
  // longer registers and every call REFUSES. Naming an unregistered tool in an allowlist
  // is not inert: it red-pinned two invariants at once — tool-auth-gating's "every
  // operator-converse allowedTool resolves in the core registry" and tools-md-sync's
  // "every allowedTool has a catalog entry (no drift)" — because an allowlist entry
  // is a PROMISE to the chat surface that the tool is callable. Do NOT re-add it to
  // fix a "missing spawn tool" symptom; the supported fan-out is a FLEET
  // (`fleet:launch-on-plan`), and re-registering a retired tool would resurrect the
  // tier the owner deliberately switched off.
  //
  // ⚠⚠ AND DO NOT WRITE THE FULL `mcp__agentmcp__` + `cup:spawn` TOKEN ANYWHERE IN
  // THIS FILE, EVEN IN A COMMENT SAYING IT IS REMOVED. tools-md-sync.test.ts builds
  // the allowlist by REGEXING THIS FILE'S SOURCE TEXT
  // (`src.matchAll(/mcp__agentmcp__([a-zA-Z0-9_:.\-]+)/g)`), and a regex cannot tell
  // a live contract from prose ABOUT the contract — so a comment mentioning the
  // prefixed name silently re-adds the tool and the two invariants stay red. Cost me
  // a full re-run when I first documented this removal; the name is deliberately
  // written unprefixed above so it stays greppable by a human without being harvested.
  //
  // One-wake BATCH placement (queen-autonomous-execution B-07): affinity-ranked
  // fan of spawn + warm-inject across the fleet in a single call. Retained because
  // it still resolves in the registry — the audit flagged ONLY cup:spawn, so this
  // removal is scoped to what is actually orphaned rather than to the whole tier.
  'mcp__agentmcp__fleet:place_batch',
  // Live inference-pool capacity for sizing placement (queen-capacity-aware-dispatch P-003):
  // bee-tier dispatchBudget + per-tier caps + saturation — the read that mirrors place_batch's clamp.
  'mcp__agentmcp__fleet:capacity',
  'mcp__agentmcp__fleet:tree',
  'mcp__agentmcp__fleet:cancel',
  // The canonical "who's on what" state query (state-not-chat-fleet-state):
  // presence + claims unified, orphaned-claim signal included.
  'mcp__agentmcp__fleet:assignments',
  // The D-004 delegation write (agent-allocation-framework P-002): hand a fleet
  // an account pool / GPU (share-%) or agent seats (agent_slot, count-capped) —
  // "join fleet X and assign 5 xhigh opus seats" runs through THIS one tool.
  // This is the DONATE verb of the pot-seat-pools-prose-ux-2026-07-18 D-004
  // donate/spend/debug prose set ("offer two sonnet seats to the design pot").
  'mcp__agentmcp__resource:delegate',
  // pot-seat-pools-prose-ux-2026-07-18 P-013 — the READ counterpart: "what agent
  // seats are available?" had no chat-reachable answer before this (the /res
  // board is human-UI-only) — resource:delegate stays the one write path.
  'mcp__agentmcp__resource:offers',
  // pot-seat-pools-prose-ux-2026-07-18 P-006/D-004 — the rest of the
  // donate/spend/debug verb set the prose-first UX needs on the chat surface
  // (previously agent-reachable but NOT exposed here, so the brain could never
  // actually call them for a user's "launch on remote seats" / "why hasn't the
  // remote member arrived" request):
  //   donate (create the receiving fleet first) -> fleet:create
  //   spend  (cross-machine launch from a delegated seat-offer) -> fleet:request_remote_spawn
  //   debug  (why a refused/silent cross-peer action didn't run) -> p2p:trace
  // Each ships with its own per-tool `guidance` (when/notWhen/chaining) on the
  // tool definition itself (fleet_registry/create.ts, request-remote-spawn.ts,
  // p2p/trace.ts) — this array only decides chat-surface REACHABILITY.
  'mcp__agentmcp__fleet:create',
  'mcp__agentmcp__fleet:request_remote_spawn',
  'mcp__agentmcp__p2p:trace',

  // Tool introspection — answers "what can I call?". Companion to
  // tools/list with role+capability+quota metadata that the standard
  // MCP listing strips. Cheap, read-only, no ctx requirements.
  'mcp__agentmcp__agent_tools:list',

  // Agent ↔ UI control surface (commits 00f0bfc3, e548f121).
  // ui:list_clients + ui:get_state are read-only.
  // ui:dispatch writes a row to ui_intents that the browser tab's
  // dispatcher consumes via SSE. Defaults to ctx.uiClientId when
  // present (which requires the chat surface to pass &client=<id> in
  // the operator MCP URL — currently operator-converse does, others
  // need to follow). Even without ctx, agents can pass client_id
  // explicitly after a ui:list_clients call.
  'mcp__agentmcp__ui:list_clients',
  'mcp__agentmcp__ui:get_state',
  'mcp__agentmcp__ui:dispatch',
  // Agent ↔ TUI control surface — the pui (terminal workbench) analogue of
  // ui:dispatch. Lets the operator drive a running pui (switch tab, open the
  // chat pane, focus a worker's zellij pane, read its state) when the user is
  // talking through the terminal surface. The per-surface affordance block in
  // converse-prompt tells the brain to prefer this over ui:dispatch on the TUI.
  'mcp__agentmcp__tui:dispatch',
  // Model-driven choice cards. Renders question + buttons in the chat
  // instead of asking the question as free text. Fire-and-forget;
  // the user's click becomes the next user message. See
  // apps/operator/lib/agent-tools/chat/ask_choice.ts.
  'mcp__agentmcp__chat:ask_choice',

  // The Hive's self-declared wake (autoloop-pot-operator-rebuild-2026-06-05 P0).
  // The chat operator schedules/inspects/fires its own background wakes — the
  // user says "check the fleet in an hour" → pot:declare-wake; "wake up now" →
  // pot:wake. pot:status is read-only.
  'mcp__agentmcp__pot:declare-wake',
  'mcp__agentmcp__pot:wake',
  'mcp__agentmcp__pot:status',
  'mcp__agentmcp__loop:soak-report',
  // B-06 / P-010: the Queen's per-wake efficiency read (cache-hit ratio + turns/wake). Read-only.
  'mcp__agentmcp__pot:mug_efficiency',

  // The Hive's superpower surface (autoloop-pot-operator-rebuild-2026-06-05
  // P-004): discover the blueprint shapes (catalog), inspect/author one
  // (validate/extend), then create the harness whose blueprint carries its own
  // autoloop. harness:status (above) is the matching read-back.
  'mcp__agentmcp__blueprint:catalog',
  'mcp__agentmcp__blueprint:validate',
  'mcp__agentmcp__blueprint:extend',
  'mcp__agentmcp__harness:create',

  // app-templates-2026-07-04 (WI-3198) — the Cupboard app-template flow, now
  // reachable from chat (it was HTTP-only): browse templates, read a template's
  // GUIDE, and materialize one into a new harness + kick off a builder.
  'mcp__agentmcp__templates:list',
  'mcp__agentmcp__templates:get-guide',
  'mcp__agentmcp__templates:new-app',

  // cupboard-agent-tool-coverage-2026-07-14 (owner-directed): the FULL Cupboard
  // publish / install / browse / delist family, so an END USER drives every listing
  // kind (harness · blueprint · plugin · pack · knowledge-pack · template · app) by
  // simply ASKING the chat operator. Browse cross-kind → cupboard:search. Publish →
  // cupboard:publish-plugin (plugin+pack), publish-template, publish-app,
  // blueprint:publish, knowledge_packs:publish; harness/hive publish is
  // discovery:set_pot { visibility:'public' }. Install → cupboard:install-plugin
  // (plugin+pack), install-blueprint, install-template, knowledge_packs:install
  // (templates:new-app above materializes). Delist → cupboard:unpublish (one
  // listing) or discovery:set_pot { visibility:'private' } (a whole hive).
  'mcp__agentmcp__cupboard:search',
  'mcp__agentmcp__cupboard:publish-plugin',
  'mcp__agentmcp__cupboard:publish-template',
  'mcp__agentmcp__cupboard:publish-app',
  'mcp__agentmcp__cupboard:install-plugin',
  'mcp__agentmcp__cupboard:install-blueprint',
  'mcp__agentmcp__cupboard:install-template',
  'mcp__agentmcp__cupboard:install-app',
  'mcp__agentmcp__cupboard:unpublish',
  'mcp__agentmcp__discovery:set_pot',
  'mcp__agentmcp__blueprint:publish',
  'mcp__agentmcp__knowledge_packs:list',
  'mcp__agentmcp__knowledge_packs:publish',
  'mcp__agentmcp__knowledge_packs:install',

  // hive-tool-namespace-2026-06-08 — local hive lifecycle. The operator manages
  // its hives: list/get to inspect; create/update/dissolve to manage. create/
  // dissolve/update are root-only (the operator is root; bees are refused). Wake
  // stays pot:wake / pot:declare-wake; bee placement stays fleet:* (no aliases).
  'mcp__agentmcp__pot:list',
  'mcp__agentmcp__pot:get',
  'mcp__agentmcp__pot:create',
  // EI-1582 — wire an existing harness in as a Hive member (sets hive_slug).
  'mcp__agentmcp__pot:add-member',
  'mcp__agentmcp__pot:update',
  'mcp__agentmcp__pot:dissolve',
  // shared-hive-hardening-2026-06-13 P-012 — a joiner leaves a shared hive (root-only).
  'mcp__agentmcp__pot:leave',

  // cross-hive-boundary-2026-06-08 P-002 — the owner's cross-Hive admission
  // surface. discovery:pots finds a peer Hive's pubkey on the P2P directory;
  // pot:cross_grant sets/revokes/lists which peer Hives may send which kinds
  // (ask | work-request) INTO this Hive (default-deny allow-list, federates to
  // all of this Hive's Swarms). This is the conversational path for the owner to
  // say "let Hive X send us asks" — the sovereignty boundary between Hives.
  'mcp__agentmcp__discovery:pots',
  'mcp__agentmcp__pot:cross_grant',

  // hive-network-surface-2026-06-11 P-005 (B-07) — owner beacon-publish consent.
  // The conversational twin of the desktop consent UX: enable/disable/read
  // whether THIS Hive publishes a live status beacon to the directory
  // (owner-consent, default-OFF). Federates to all of this Hive's Swarms.
  'mcp__agentmcp__pot:beacon_consent',

  // hive-network-surface-2026-06-11 P-006 (B-08) — the aggregate Network board:
  // one row per other-hive context across the capability-tier ladder (this Swarm,
  // own other hives, federated peer Swarms, foreign directory hives + beacon +
  // our grants/asks). The Queen's "what is every other hive doing" read.
  'mcp__agentmcp__network:board',

  // hive-network-surface-2026-06-11 P-003 (B-04) — the INITIATING side of the
  // cross-Hive boundary: pot:ask / pot:request_work send a signed request to a
  // peer Hive (by pubkey, from discovery:pots) and record it in this Hive's ask
  // ledger; the peer's answer arrives async (events:await the answeredEvent key).
  // pot:asks reviews the ledger (pending / answered / declined). The owner and
  // Queen share these verbs to ask another Hive that owns a domain.
  'mcp__agentmcp__pot:ask',
  'mcp__agentmcp__pot:request_work',
  'mcp__agentmcp__pot:asks',
];

/**
 * Subset of ALL_AGENT_MCP_TOOLS that require an INTERACTIVE chat
 * surface — i.e., a real-time user the agent can solicit a response
 * from. These should NOT be in allowedTools for one-shot surfaces
 * like one-shot surfaces (which emit results, not chat turns) or
 * spawn-pi (which boots a workspace; no chat).
 *
 * If a chat-only tool is given to a one-shot surface, the model might
 * call it expecting an answer that will never come — the suggestion
 * stream incompletes; the operator stalls.
 *
 * Keep this list in sync with the `chat:*` namespace and any other
 * tool whose contract requires an interactive responder.
 */
export const INTERACTIVE_CHAT_TOOLS: readonly string[] = [
  'mcp__agentmcp__chat:ask_choice',
];

/**
 * The non-interactive subset — everything except INTERACTIVE_CHAT_TOOLS.
 * For one-shot surfaces that spawn an agent but
 * don't have a user-facing chat session.
 */
export const NON_INTERACTIVE_AGENT_MCP_TOOLS: readonly string[] =
  ALL_AGENT_MCP_TOOLS.filter((t) => !INTERACTIVE_CHAT_TOOLS.includes(t));

/**
 * Claude Code sanitizes the colon out of an MCP tool name before handing it
 * to the model (`chat:ask_choice` → `chat_ask_choice`), which is why the
 * prompt catalog advertises the underscore form (converse-prompt's
 * `toClaudeName`). A `tool_call` event therefore carries the SANITIZED name,
 * while every consumer — the chat-cards registry, the converse provider's
 * ask_choice gates, turn-answer — is keyed on the CANONICAL colon name.
 * Restoring it here, at ingest, keeps the persisted `operator_turns.tools[].name`
 * canonical instead of making each consumer reconcile a name that can be wrong.
 *
 * Built by inverting ALL_AGENT_MCP_TOOLS (the same source `toClaudeName`
 * mangles) so the mapping is EXACT. A blind `replace(/_/g, ':')` is wrong:
 * it would corrupt legitimately-underscored names (`work_items:create` →
 * `work:items:create`).
 */
const { sanitizedToCanonical, sanitizedCollisions } = ((): {
  sanitizedToCanonical: ReadonlyMap<string, string>;
  sanitizedCollisions: readonly string[];
} => {
  const map = new Map<string, string>();
  const collisions: string[] = [];
  for (const fullName of ALL_AGENT_MCP_TOOLS) {
    const canonical = fullName.replace(/^mcp__agentmcp__/, '');
    if (!canonical.includes(':')) continue;
    const sanitized = canonical.replace(/:/g, '_');
    const prior = map.get(sanitized);
    if (prior !== undefined && prior !== canonical) {
      // Two canonical names collapsing onto one sanitized form would make the
      // inverse ambiguous. Keep the first and surface it — the unit test
      // asserts this stays empty, so a colliding new tool reds in CI rather
      // than silently mis-resolving a card at runtime.
      collisions.push(sanitized);
      continue;
    }
    map.set(sanitized, canonical);
  }
  return { sanitizedToCanonical: map, sanitizedCollisions: collisions };
})();

/** Sanitized names that two canonical tools collide on. Must stay empty. */
export const SANITIZED_TOOL_NAME_COLLISIONS: readonly string[] = sanitizedCollisions;

/**
 * Recover the canonical agent-MCP tool name from whatever the model emitted:
 * strips the `mcp__agentmcp__` prefix and un-sanitizes the colon. Returns the
 * bare name unchanged when it isn't a known agent-MCP tool (a built-in like
 * `Read`, or a tool that never had a colon).
 */
export function canonicalToolName(name: string): string {
  const bare = name.startsWith('mcp__agentmcp__')
    ? name.replace(/^mcp__agentmcp__/, '')
    : name;
  return sanitizedToCanonical.get(bare) ?? bare;
}
