/**
 * Owner-facing text projection for curated signals (WI-37946).
 *
 * ## Why this exists
 *
 * Curated signals are composed from PRODUCER prose — work-item titles, blocked
 * reasons, escalation bodies, plan-lane-sync notes. Those producers are writing
 * an ENGINEERING record and are right to be precise: "held by ended session
 * su-12b70e95-84ce-4ea0-b546-8a692cdc949c" is exactly what an operator needs.
 *
 * The same string is then rendered to the OWNER as a notification. Measured
 * live on the rig (2026-08-11, pid 191771): 26 of 37 rendered feed rows carried
 * at least one raw internal identifier — full agent UUIDs, `system:*` actor
 * names, and repo-relative source paths rendered as owner-facing prose.
 *
 * So the fix is NOT to make producers less precise, and NOT to rewrite each
 * producer: it is one projection at the render seam. `signalBody()` in
 * `curation-loop.ts` is that seam — it is deliberately shared by
 * `formatSignalLine` (text/voice/search) and `signalToReportItem` (card) so the
 * two renditions never drift, which means one call here covers both.
 *
 * ## What this deliberately does NOT strip
 *
 * - **`WI-`/`EI-` ids and plan slugs.** These are short, stable, human-quotable
 *   references the owner can search on, and they are load-bearing INSIDE the
 *   prose ("root-cause EI-20185455308799001, the transient alert" does not
 *   survive having its subject deleted). Resolving them to titles is a
 *   RENDERER-side job with a live lookup — the `remark-work-refs` pill plugin
 *   (`apps/operator/app/_components/chat/`) already does exactly that in chat,
 *   and is the right surface to extend for the feed. A regex here would mangle
 *   sentences without resolving anything.
 * - **DB table/column names** (`coord_presence`, `work_items`). No regex
 *   separates a leaked table name from an ordinary noun with acceptable
 *   precision, and a false positive silently corrupts owner text.
 * - **The drill-in `ref`.** `signalToReportItem` passes `ref` through untouched,
 *   so the raw identifiers stay one click away — curation never hides (D-005).
 *
 * Both exclusions are scope decisions with rationale, recorded on WI-37946 —
 * not oversights.
 */

/** A full agent session id: `su-<8>-<4>-<4>-<4>-<12>`. */
const AGENT_UUID = /\bsu-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;

/**
 * `su-90cc5 (su-90cc5)` — the parenthetical that becomes redundant once the
 * full UUID beside an existing short handle has been shortened. Producers emit
 * `su-90cc5 (su-90cc5cbd-6f87-…)` precisely so an operator can copy the full
 * id; once shortened it is pure duplication.
 */
const REDUNDANT_PAREN_HANDLE = /\b(su-[0-9a-f]{5,8})\s*\(\1\)/g;

/** A `(system:plan-item-lane-sync)`-style trailing actor attribution. */
const SYSTEM_ACTOR = /\s*\(system:[a-z0-9][a-z0-9:._-]*\)/g;

/** A repo-relative source path — reduced to its basename. */
const REPO_PATH =
  /\b(?:packages|apps|libs|scripts)\/(?:[A-Za-z0-9._-]+\/)*([A-Za-z0-9._-]+\.(?:tsx?|mts|cts|mjs|cjs|jsx?|sql|css|md))\b/g;

/**
 * The compact display handle for an agent id — `su-90cc5`.
 *
 * Mirrors `shortOwnerLabel` in `agent-tools/loop/arm.ts`, which is what already
 * renders the `su · su-90cc5` label these signals appear beside; matching it
 * means a shortened UUID reads identically to the handle already next to it
 * (and is what makes REDUNDANT_PAREN_HANDLE collapse).
 */
export function shortAgentHandle(ownerId: string): string {
  return ownerId.slice(0, 8);
}

/**
 * Project one composed signal line into owner-facing text.
 *
 * Order matters: UUIDs are shortened FIRST so that the `X (X)` duplication the
 * shortening creates can then be collapsed.
 */
export function projectOwnerFacing(text: string): string {
  if (!text) return text;
  return text
    .replace(AGENT_UUID, (m) => shortAgentHandle(m))
    .replace(REDUNDANT_PAREN_HANDLE, '$1')
    .replace(SYSTEM_ACTOR, '')
    .replace(REPO_PATH, '$1');
}
