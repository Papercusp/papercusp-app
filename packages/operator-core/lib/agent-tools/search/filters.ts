/**
 * Structured search filters — the host-side half of @papercusp/search's
 * filter bag (session-search-scope-2026-07-05 P-002, D-002 + D-003).
 *
 * The generic lib stays domain-free: it takes a flat `owners` set + scalar
 * turn filters. THIS module resolves the Papercusp domain concepts into that
 * shape:
 *   * owner:'self'   → the caller's coord ownerId (resolveAgentIdentity)
 *   * fleet:<slug>   → the fleet's EVER-members from the APPEND-ONLY
 *                      fleet_membership_events ledger (D-002: never live
 *                      presence — ended members lose their fleet_slug and get
 *                      presence-reaped, which would silently drop exactly the
 *                      dead members a postmortem needs)
 *   * session:'self' → the caller's live transcript (self-session.ts), which
 *                      is ALSO force-tailed (ingestFileNow) so the last
 *                      minutes are indexed at read time — the client-neutral
 *                      compaction-recovery freshness guarantee.
 */

import { z } from 'zod';
import type { Sql } from 'postgres';
import type { SearchFilters } from '@papercusp/search';
import { withBoundedTimeout } from '../../bounded-timeout';
import {
  parseSessionSelector,
  refreshResolvedSessionBeforeRead,
  SESSION_READ_REFRESH_TIMEOUT_MS,
} from '../sessions/_shared';
import type { SelfSession } from '../../search/self-session';

/** Shared zod arg fragments for search:fulltext / search:semantic / sessions:search. */
export const searchFilterArgs = {
  owner: z
    .string()
    .max(120)
    .optional()
    .describe(
      "Restrict to turns/messages attributed to one agent ownerId. Pass 'self' for the calling agent.",
    ),
  fleet: z
    .string()
    .max(80)
    .optional()
    .describe(
      'Restrict to agents who were EVER members of this fleet (resolved from the append-only membership ledger — includes dead/ended members; a postmortem-safe filter).',
    ),
  speaker: z
    .enum(['user', 'assistant'])
    .optional()
    .describe('Restrict transcript hits to one side of the conversation.'),
  turn_origin: z
    .enum(['owner-typed', 'owner-dialog', 'agent-injected', 'machine-surface', 'synthetic', 'unenrolled-origin', 'not-user-turn'])
    .optional()
    .describe(
      "Restrict transcript hits to the PERSISTED turn-origin verdict — which is stricter than the verdict a hit DISPLAYS. " +
      "For file-backed CLI sessions (claude/omp/codex), an uncorrelated typed prompt remains 'unenrolled-origin' because a clean " +
      "CLI row proves neither owner nor machine authorship. A hook-authenticated prompt-origin stamp can correlate the exact row " +
      "by source, session, prompt hash, and time (currently Claude hook stamps), upgrading it to persisted 'owner-typed'. " +
      "This filter can therefore match exact authenticated rows but may be sparse; a zero is NOT evidence that the owner said " +
      "nothing. For recall of residual candidates use owner_candidates:true, then read each hit before attributing it.",
    ),
  owner_only: z
    .boolean()
    .optional()
    .describe(
      "Restrict hits to turns whose authorship is PROVEN owner speech (persisted 'owner-typed' or 'owner-dialog'). High precision, " +
      "very low recall: file-backed CLI typed directives remain 'unenrolled-origin' when no matching hook-authenticated " +
      "prompt-origin stamp exists, but an exact authenticated row can be persisted as 'owner-typed'. A zero here is NOT evidence " +
      "the owner said nothing — use owner_candidates:true to recall residual candidates.",
    ),
  owner_candidates: z
    .boolean()
    .optional()
    .describe(
      "Widen to turns that COULD be owner speech: proven owner turns PLUS 'unenrolled-origin' — the bucket a typed owner directive " +
      "lands in on file-backed sessions when no matching hook-authenticated prompt-origin stamp exists; exact matched rows are " +
      "promoted to persisted 'owner-typed' and are already included by owner_only. Use it for RECALL when owner_only returns a " +
      "sparse or residual-only result. " +
      "⚠ CANDIDATES, NOT PROOF, and the gap is large: 'unenrolled-origin' means only 'no machine envelope was found', which is also " +
      "true of machine text that never carried one. Measured 2026-08-24 over 13,917 real claude rows, at least 7,637 (55%) are " +
      "machine-shaped — Kettle/Mug system prompts, '[await-event] … fired' wake injections, '/compact …' directives, harness retry " +
      "text — sitting beside genuine owner turns. So a hit here is a CANDIDATE to read, never evidence on its own, and a NON-empty " +
      "result is not confirmation any more than an empty one is denial. Read each hit's provenance and its text before attributing " +
      "anything to the owner. What this filter does buy is real but bounded: it drops the ~112k rows PROVABLY machine (agent-injected, " +
      "machine-surface) plus assistant turns, so the loop-fire replays that make an unfiltered search read an agent's own words back " +
      "as the owner's are gone.",
    ),
  session: z
    .string()
    .max(200)
    .optional()
    .describe(
      "Restrict to one session id. Pass 'self' for the calling agent's CURRENT session — your pre-compaction turns are searchable this way (they survive on disk).",
    ),
  source_kind: z
    .enum(['claude', 'omp', 'codex', 'agent_chat'])
    .optional()
    .describe('Restrict transcript hits to one client/source.'),
  since: z.string().max(40).optional().describe('ISO timestamp lower bound (inclusive).'),
  until: z.string().max(40).optional().describe('ISO timestamp upper bound (exclusive).'),
};

export interface SearchFilterArgValues {
  owner?: string;
  fleet?: string;
  speaker?: 'user' | 'assistant';
  turn_origin?: 'owner-typed' | 'owner-dialog' | 'agent-injected' | 'machine-surface' | 'synthetic' | 'unenrolled-origin' | 'not-user-turn';
  owner_only?: boolean;
  owner_candidates?: boolean;
  session?: string;
  source_kind?: 'claude' | 'omp' | 'codex' | 'agent_chat';
  since?: string;
  until?: string;
}

export interface ResolvedSearchFilters {
  /** undefined when no filter arg was passed — the no-narrowing fast path. */
  filters?: SearchFilters;
  /** Set when session:'self' resolved to a live transcript (for live-tail + read-back). */
  selfSession?: SelfSession | null;
}

function isoOrUndefined(v: string | undefined): string | undefined {
  if (!v) return undefined;
  return Number.isNaN(new Date(v).getTime()) ? undefined : v;
}

/**
 * Resolve tool-arg filters → the engine's SearchFilters. `callerOwnerId` backs
 * the 'self' sugars; pass '' when the surface has no agent identity (filters
 * needing 'self' then resolve to nothing rather than erroring).
 */
export async function resolveSearchFilters(
  sql: Sql,
  args: SearchFilterArgValues,
  callerOwnerId: string,
  opts?: { workspaceId?: string; liveTailSelf?: boolean },
): Promise<ResolvedSearchFilters> {
  const anySet =
    args.owner || args.fleet || args.speaker || args.turn_origin || args.owner_only !== undefined ||
    args.owner_candidates !== undefined ||
    args.session || args.source_kind || args.since || args.until;
  if (!anySet) return {};

  const owners = new Set<string>();
  if (args.owner) owners.add(args.owner === 'self' ? callerOwnerId : args.owner);

  if (args.fleet) {
    // EVER-members from the append-only ledger (session-search-scope-2026-07-05 D-002).
    // The query itself lives in fleet-membership-store's `fleetEverMembers` — the module
    // that owns the ledger — so this surface and every other ever-member consumer
    // (work_items:burn_down's deltaBy) resolve membership through ONE oracle rather than
    // each carrying its own copy of the workspace-fallback predicate.
    const { fleetEverMembers } = await import('../../fleet-membership-store');
    const members = await fleetEverMembers(args.fleet, { workspaceId: opts?.workspaceId }, sql);
    for (const id of members) owners.add(id);
    // An unknown fleet resolves to NO owners — surface that as an impossible
    // filter (empty results) rather than silently ignoring the narrowing.
    if (members.size === 0 && !args.owner) owners.add('__no_such_fleet__');
  }

  let sessionId = args.session;
  let sourceKind = args.source_kind;
  if (sessionId && sessionId !== 'self') {
    const selector = parseSessionSelector(sessionId, sourceKind);
    sessionId = selector.sessionId;
    sourceKind = selector.sourceKind;
  }
  let selfSession: ResolvedSearchFilters['selfSession'];
  if (args.session === 'self') {
    const { resolveSelfSession } = await import('../../search/self-session');
    const resolved = await withBoundedTimeout(
      () => resolveSelfSession(callerOwnerId),
      {
        fallback: null,
        timeoutMs: SESSION_READ_REFRESH_TIMEOUT_MS,
        label: 'sessions:self resolve',
      },
    );
    selfSession = resolved.value;
    // session:'self' recall must span the caller's WHOLE respawn chain, not a
    // single native session: a cold carry-respawn scatters the agent's history
    // across MANY transcripts (WI-5644). So owner-scope it — NEVER pin
    // filters.sessionId to one native id (that silently dropped all pre-respawn
    // turns, the exact pre-compaction history this sugar promises to recover).
    //
    // WI-5681: session_turns.owner is keyed by the transcript's ISOLATION-DIR
    // owner (session-ingest derives it from the file path `/session-claude/<x>/`),
    // which DIVERGES from the caller's current coord ownerId after a
    // carry-respawn/identity rebind (the isolation dir is named by the coord id
    // AT LAUNCH). Owner-scoping by callerOwnerId ALONE then matched ZERO rows —
    // the regression that made this sugar return nothing for a respawned session.
    // Add BOTH the coord id AND the resolved transcript's isolation-dir owner, so
    // the filter matches what ingest actually wrote regardless of drift.
    if (callerOwnerId) owners.add(callerOwnerId);
    const isoOwner = selfSession?.filePath.match(/\/session-claude\/([^/]+)\//)?.[1];
    if (isoOwner) owners.add(isoOwner);
    sessionId = undefined;
    if (selfSession && opts?.liveTailSelf !== false) {
      // Read-time freshness (D-002): force-tail the caller's CURRENT transcript
      // (resolveSelfSession now returns the newest/live one) so the last minutes
      // are indexed before we search. One file — bounded + cheap.
      await refreshResolvedSessionBeforeRead(selfSession, callerOwnerId, {}, 'sessions:self refresh');
    }
  }

  const filters: SearchFilters = {};
  if (owners.size) filters.owners = [...owners];
  if (args.speaker) filters.speaker = args.speaker;
  if (args.turn_origin) filters.turnOrigin = args.turn_origin;
  if (args.owner_only !== undefined) filters.ownerOnly = args.owner_only;
  if (args.owner_candidates !== undefined) filters.ownerCandidates = args.owner_candidates;
  if (sessionId && sessionId !== 'self') filters.sessionId = sessionId;
  if (sourceKind) filters.sourceKind = sourceKind;
  const since = isoOrUndefined(args.since);
  const until = isoOrUndefined(args.until);
  if (since) filters.since = since;
  if (until) filters.until = until;

  return { filters: Object.keys(filters).length ? filters : undefined, selfSession };
}
