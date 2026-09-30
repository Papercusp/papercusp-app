/**
 * unknown-tool-referral — moment-of-failure tool discoverability (EI-9011, generalized).
 *
 * When a tool call misses the registry (`unknown_tool`), the error text is the ONE carrier
 * every MCP client (Claude Code, OMP, codex) renders at the exact moment the agent needs
 * redirection — an initialize-instructions banner read 100k tokens earlier demonstrably
 * loses to this moment (EI-9011: the agent concluded a named tool "doesn't exist" after a
 * client-side ToolSearch miss and degraded to hand-rolled polling). So the unknown_tool
 * error carries:
 *   1. closest catalog matches (typo / format-variant recovery — `locks_acquire` vs
 *      `locks:acquire` vs `mcp__papercusp-su__locks_acquire` all normalize to the same key);
 *   2. the standing referral: tools:invoke calls ANY catalog tool by name without loading
 *      it; tools:find searches the FULL server-side catalog (not the client-advertised
 *      subset) and activates matches.
 *
 * Pure + registry-read-only. Shared by both `unknown_tool` emission sites in
 * _mcp-handler.ts (the tools:invoke dispatch engine + the tools/call fall-through).
 */
import { listAllProjectedTools, normalizeMcpName } from '@papercusp/agent-mcp';

/**
 * Normalize a tool name for comparison: strip the client's `mcp__<server>__`
 * wrapper and treat `:`, `_`, `.`, `-` as one separator (clients rewrite
 * `:` → `_` when advertising).
 *
 * ALIAS of the registry's canonical normalizer (tooldef `normalizeMcpName`) —
 * the SAME function tools:invoke uses to RESOLVE a name (WI-3930). Sharing one
 * implementation guarantees the name a miss SUGGESTS ("did you mean X?") is a
 * name tools:invoke can actually resolve; a second copy could silently drift and
 * suggest a form the resolver rejects. Kept as a named export for existing
 * callers/tests.
 */
export const normalizeToolName = normalizeMcpName;

/** Strip the client's `mcp__<server>__` advertising wrapper, if present. */
function stripClientWrapper(requested: string): string {
  return requested.replace(/^mcp__[A-Za-z0-9-]+__/, '');
}

/**
 * True when `requested` is shaped like a PLUGIN-contributed tool (`<plugin>.<verb>` —
 * design-phase.lint_spec, gitnexus.context, repomix.pack). Core tools are `<server>:<verb>`,
 * so the DOT is what separates the two families.
 *
 * Deliberately syntactic, not a hand-maintained plugin-name list: the whole point is that
 * this runs when the registry does NOT yet contain the tool, so there is nothing to match a
 * list against, and a stale list would be exactly the code-describing metadata the
 * derived-truth ladder forbids.
 *
 * NOTE: cannot be built on `normalizeToolName` — that normalizer folds `.` and `:` onto one
 * separator, which erases the very distinction being tested here.
 */
export function isPluginNamespacedToolName(requested: string): boolean {
  return stripClientWrapper(requested).includes('.');
}

/** Cheap similarity for suggestion ranking: exact-normalized ≫ substring ≫ token overlap. */
function scoreCandidate(requestedNorm: string, candidateNorm: string): number {
  if (candidateNorm === requestedNorm) return 1000;
  if (candidateNorm.includes(requestedNorm) || requestedNorm.includes(candidateNorm)) return 500;
  const reqTokens = new Set(requestedNorm.split(':').filter(Boolean));
  const candTokens = candidateNorm.split(':').filter(Boolean);
  let overlap = 0;
  for (const t of candTokens) {
    if (reqTokens.has(t)) overlap += 2;
    else if ([...reqTokens].some((r) => r.length >= 3 && (t.includes(r) || r.includes(t)))) overlap += 1;
  }
  return overlap;
}

/**
 * Up to `limit` closest MCP tool names for a requested name that missed the registry.
 * Empty when nothing scores above zero (an unrelated string earns no fabricated matches).
 */
export function suggestClosestToolNames(requested: string, limit = 3): string[] {
  const requestedNorm = normalizeToolName(requested);
  if (!requestedNorm) return [];
  const scored: Array<{ name: string; score: number }> = [];
  for (const t of listAllProjectedTools()) {
    const name = t.expose?.mcp?.name;
    if (!name) continue;
    const score = scoreCandidate(requestedNorm, normalizeToolName(name));
    if (score > 0) scored.push({ name, score });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((s) => s.name);
}

/**
 * Render the full unknown_tool error text: `unknown_tool: …` prefix (kept EXACTLY so
 * existing error-code matching keeps working), closest matches when any, and the referral.
 */
export function unknownToolReferral(requested: string): string {
  const suggestions = suggestClosestToolNames(requested);
  const didYouMean = suggestions.length > 0 ? ` Closest catalog matches: ${suggestions.join(', ')}.` : '';
  return (
    `unknown_tool: no tool named "${requested}".${didYouMean} ` +
    `Any catalog tool is callable WITHOUT loading it: tools:invoke { name, args }. ` +
    `tools:find("<intent or name>") searches the FULL server-side catalog (your client's ` +
    `own tool search only indexes the advertised subset — a miss there does not mean the ` +
    `tool doesn't exist) and activates matches for this session. ` +
    // EI-18752546668875973: a doc-cited name can genuinely miss for a THIRD reason besides
    // "typo" and "the doc is wrong" — the tool exists in source but hasn't reached THIS
    // operator's deployed code yet (a doc/prompt is spliced from the staging tree; this
    // endpoint may be serving an older release checkout). Naming that possibility here, at
    // the moment of failure, is cheaper than the misdiagnosis it prevents: an agent that
    // concludes "the doc/registry must be wrong" and goes on to file a bug against either.
    `If this name looks right and you recently saw it added/documented, it may exist in ` +
    `source but not be deployed to THIS operator yet (a red release gate stalls the ` +
    `staging→live window well past its normal <=15min) — check dev:pipeline_position before ` +
    `concluding the doc or the registry itself is wrong.` +
    // EI-22365453839629245: a FOURTH reason, specific to plugin-contributed tools and the one
    // most likely to be misdiagnosed. Plugin tools reach the projected registry through an
    // asynchronous sweep inside getPluginHost() (plugin-host-runtime.ts, SWEEP_BUDGET_MS) whose
    // tools land INCREMENTALLY — "tools registered before the cap stay live; a slow sweep
    // finishes in the background". The host restarts with the operator, so for a window after
    // every restart a plugin's verbs register one at a time: a SIBLING verb dispatches fine
    // while this one still misses. Both prior reasons above read as permanent ("typo" /
    // "not deployed"), so without this line the transient case gets filed as a real defect —
    // which is exactly how gitnexus once got misdiagnosed as down (host-bootstrap.ts, plugin-
    // system-hive-port-2026-06-11 P-012) and how this very ticket was filed.
    (isPluginNamespacedToolName(requested)
      ? ` This name is PLUGIN-shaped (<plugin>.<verb>). Plugin tools enter the registry via an ` +
        `ASYNCHRONOUS sweep in the plugin host, which restarts with the operator — so shortly ` +
        `after an operator restart a plugin verb can still be unregistered while a SIBLING verb ` +
        `of the same plugin dispatches fine. That makes this miss very likely TRANSIENT rather ` +
        `than a removed or broken tool. Check plugins:runtime_status for loaded plugins and load ` +
        `errors, then retry, before concluding the plugin is down or the tool does not exist.`
      : '')
  );
}
