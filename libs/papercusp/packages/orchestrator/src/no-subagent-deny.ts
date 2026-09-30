/**
 * Subagent-fanout deny for spawned agent sessions (owner request, 2026-07-01).
 *
 * A bee / pipeline role / headless fleet worker that can call the built-in
 * subagent-launch tool can recursively spawn work OUTSIDE the orchestrator's
 * own spawn graph — invisible to fleet:assignments, uncontrolled cost, and a
 * second fan-out mechanism competing with the one the substrate can actually
 * see. So every AGENT session (headless fleet/orchestrator spawns, wake-
 * executor resumes, interactive `psu --role` panes/bees) denies it.
 *
 * **The tool's name changed under us — verified empirically, don't trust
 * either name blindly.** The fleet's original deny-list only listed `Task`
 * (verified live against claude 2.1.158, see
 * agent-insights/claude-code-headless-permissions.mdx) — but on claude
 * 2.1.198 the same tool is named `Agent`, and re-verifying live on
 * 2026-07-01 (`--disallowedTools Task` + an instructed subagent spawn that
 * DID write its marker file) confirmed the `Task` entry had become a silent
 * no-op: the fleet's own subagent-fanout guard was NOT actually blocking
 * fanout. `--disallowedTools Agent` DID block it (denial message: "Agent
 * exists but is not enabled in this context"). Both names are carried here
 * so the deny survives either CLI generation — disallowing a tool name that
 * doesn't exist in a given build is a no-op, never an error.
 *
 * Scope (owner mandate 2026-07-02): subagent fanout is now DENIED BY DEFAULT
 * for EVERY Claude agent — headless orchestrator spawns, wake-executor resumes,
 * interactive `psu --role` panes/bees, AND the human `psu su` collaborator. The
 * ONLY way to keep the tool is an explicit opt-IN at launch: `psu
 * --allow-subagents` (a CLI flag), a `fleet:launch-on-plan { allowSubagents:
 * true }` arg, or the psu picker's Subagents toggle (default: Disabled).
 * Background/headless spawns + resumes take no opt-in — they always deny (a bee
 * that could recursively spawn work outside the orchestrator's spawn graph is
 * invisible to fleet:assignments + uncontrolled). This INVERTED the prior
 * posture (default-OFF deny with a `--no-subagents` opt-OUT and a
 * human-keeps-it-by-default carve-out — mirror of native-scheduler-lockout
 * D-003, which the subagent deny no longer follows).
 *
 * psu-launcher.mjs (plain-node, can't import TS) duplicates the rendered
 * literal; the lockstep test in apps/operator/lib/psu-launcher.test.ts pins
 * the two copies together — mirrors the native-scheduler-deny pattern.
 */

/** Tools that fan out subagents OUTSIDE the orchestrator's spawn graph — all
 *  denied together. `Task`/`Agent` = the built-in subagent-launch tool under its
 *  two observed names (`Task` pre-rename, `Agent` as of claude 2.1.198+).
 *  `Workflow` = the SEPARATE multi-agent orchestration tool: added 2026-07-05
 *  after a subagents-denied `psu --resume` session was still able to fan out via
 *  Workflow (the deny listed only Task/Agent, and Workflow is a distinct
 *  top-level tool — not a rename of the subagent tool — so it slipped the guard).
 *  Same uncontrolled-fanout concern, so the same deny. Disallowing a name absent
 *  in a given CLI build is a harmless no-op, so carrying all three is safe;
 *  verify a NEW name live before trusting it (as Task/Agent were). */
export const NO_SUBAGENT_TOOLS_DENY = ['Task', 'Agent', 'Workflow'] as const;

/** The ready-to-append argv token (claude CLI). Single `=` token — the flag
 *  is variadic (`<tools...>`) and the space form greedily eats every
 *  following token, including a trailing positional prompt. */
export function noSubagentToolsDenyFlag(): string {
  return `--disallowedTools=${NO_SUBAGENT_TOOLS_DENY.join(',')}`;
}
