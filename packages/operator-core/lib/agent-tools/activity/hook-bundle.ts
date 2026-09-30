/**
 * Delta-aware coordination payload folded into activity:report for native hooks.
 *
 * A busy OMP session used to pay three automatic MCP round trips around its
 * manual calls: activity:report, coord:inbox, and coord:glance.  The activity
 * report is the unavoidable heartbeat, so it now carries a caller generation
 * and conditionally hydrates the other two surfaces server-side.  A quiet run
 * still performs one cheap MAX(id) generation read per heartbeat, but performs
 * O(1) inbox/glance hydrations until coordination state actually changes.
 *
 * The host epoch is part of the generation.  An operator restart therefore
 * cannot accidentally accept a pre-restart client cursor even when the latest
 * coord_event_log id is unchanged.
 *
 * ⚠ THAT CLAIM IS NOW MEASURED, NOT ASSUMED.  Whether the O(1) path is actually
 * taken was unobservable until P-005 — the `changed` outcome was computed, acted
 * on and discarded, so the optimization's own effectiveness could only be
 * inferred.  Every fold now emits a `coordFold` census onto this call's existing
 * `tool_invocations` row; see ./coord-fold-census.ts for the record shape, the
 * read query, and the two readings that are easy to get confidently wrong.
 * Per D-001 of observation-and-recall-surface-honesty-2026-08-16, this hook path
 * is not to be "optimized" on an inferred ratio — it runs synchronously for
 * every agent on every tool call, where a wrong change silently drops
 * coordination delivery instead of failing loudly.
 */

import { getOrgPg } from '@papercusp/db-org';
import inboxTool from '../coordination/tools/inbox';
import glanceTool from '../coordination/tools/glance';
import { coordScopeWorkspace } from '../coordination/log';
import {
  ackAndRead as ackReadCursor,
  stage as stageReadCursor,
  type AckResult,
  type CursorState,
} from '../coordination/read-cursors';
import { pickUnreadCursor, readWatermark as readCoordWatermark } from '../coordination/watermarks';
import { censusCoordFold, coordFoldObserverFor, type CoordFoldCensus } from './coord-fold-census';

export const ACTIVITY_HOOK_BUNDLE_SCHEMA = 'activity-hook-bundle-v1';
export const INBOX_CURSOR_SURFACE = 'inbox';
/**
 * Activity rows the bundle's glance leg renders its `display` block from. It MUST equal the
 * Claude statusline's `ACTIVITY_WINDOW` (apps/operator/scripts/hooks/cc/statusline-fleet.sh):
 * the statusline now prints this cached glance instead of issuing its own coord:glance RPC
 * (P-012, review-system-rework-reduction-2026-09-23), and `renderStatusDisplay` derives the
 * peer chip from these rows before `display_only` blanks them. With 0 the reused display
 * would silently read "solo". Pinned by hook-bundle-statusline-parity.test.ts.
 */
export const HOOK_BUNDLE_GLANCE_ACTIVITY_LIMIT = 12;
const HOST_EPOCH = `${process.pid.toString(36)}-${Date.now().toString(36)}`;

export interface ActivityHookBundleRequest {
  generation?: string | null;
  since_ts?: string | null;
  force_resync?: boolean;
  /**
   * "My GLANCE snapshot aged out — refresh that leg." NOT a resync.
   *
   * The client used to express this by setting `force_resync`, which is a
   * request to replace EVERYTHING. Measured over a 3h window, that made
   * force-resync 61% of all folds (1,946 of 3,170) while only 12.7% of folds
   * advanced this owner's inbox: a display cache with a 15s TTL was dragging the
   * DELIVERY leg through a full hydration several times a minute. Splitting the
   * two lets glance take a coarse cadence without rationing inbox, whose
   * staleness is a correctness problem rather than a cosmetic one (WI-10002436,
   * compromise B).
   *
   * Strictly additive: a client that still sends `force_resync` keeps the old
   * replace-everything semantics, so an older hook against a newer operator is
   * unaffected.
   */
  glance_stale?: boolean;
}

export interface ActivityHookBundleSurface {
  inbox?: Record<string, unknown>;
  glance?: Record<string, unknown>;
}

export interface ActivityHookBundle {
  schemaVersion: typeof ACTIVITY_HOOK_BUNDLE_SCHEMA;
  generation: string;
  changed: boolean;
  complete: boolean;
  surfaces?: ActivityHookBundleSurface;
  provenance: {
    source: 'activity:report';
    ownerId: string;
    observedAt: string;
  };
  resync: {
    on: string[];
    strategy: 'replace-full-never-merge-behind';
    request: { generation: null; force_resync: true };
  };
}

type ToolContext = Parameters<typeof inboxTool.handler>[1];
type OrgSql = ReturnType<typeof getOrgPg>['sql'];

export interface CoordGenerationDelta {
  afterId: string;
  throughId: string;
}

export interface ActivityHookBundleDeps {
  generation: () => Promise<string>;
  /**
   * Exact owner-recipient check over one same-host generation interval.
   * Only an explicit `false` may suppress hydration; absence, throws, and any
   * non-boolean result fail open to the existing full fold.
   */
  ownerRelevantDelta?: (ownerId: string, afterId: string, throughId: string) => Promise<boolean>;
  inbox: (sinceTs: string | null | undefined, ctx: ToolContext) => Promise<Record<string, unknown> | null>;
  glance: (ctx: ToolContext) => Promise<Record<string, unknown> | null>;
  /** Server-owned two-phase cursor for the windowed inbox surface. */
  readInboxCursor: (ownerId: string) => Promise<AckResult>;
  stageInboxCursor: (ownerId: string, next: CursorState) => Promise<void>;
  /** Legacy watermark bridge used only until the server cursor has a committed floor. */
  readWatermark: (ownerId: string) => Promise<{
    messages_since_ts?: string | null;
    messages_shown_ts?: string | null;
  }>;
  now: () => Date;
  /**
   * P-005 instrument sink. OPTIONAL on purpose: it defaults to the ctx-derived
   * observer inside the fold (the ctx is not reachable from the static
   * `defaultDeps`), and making it required would strand every existing
   * caller/test that builds this object literally.
   */
  observe?: (census: CoordFoldCensus) => void;
}

function parseToolPayload(result: unknown): Record<string, unknown> | null {
  const r = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> } | null;
  if (!r || r.isError) return null;
  const text = r.content?.find((part) => part.type === 'text' && typeof part.text === 'string')?.text;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseCoordGeneration(value: string | null | undefined): { epoch: string; id: bigint } | null {
  if (typeof value !== 'string') return null;
  const separator = value.lastIndexOf(':');
  if (separator <= 0 || separator === value.length - 1) return null;
  const epoch = value.slice(0, separator);
  const rawId = value.slice(separator + 1);
  if (!/^\d+$/.test(rawId)) return null;
  try {
    return { epoch, id: BigInt(rawId) };
  } catch {
    return null;
  }
}

/**
 * Return the indexed id interval that is safe to inspect instead of hydrating.
 * A restart (different epoch), malformed cursor, or non-forward id is not a
 * usable interval and therefore keeps the existing fail-open full hydrate.
 */
export function sameHostCoordGenerationDelta(
  clientGeneration: string | null | undefined,
  serverGeneration: string,
): CoordGenerationDelta | null {
  const client = parseCoordGeneration(clientGeneration);
  const server = parseCoordGeneration(serverGeneration);
  if (!client || !server || client.epoch !== server.epoch || client.id >= server.id) return null;
  return { afterId: client.id.toString(), throughId: server.id.toString() };
}

/**
 * The same recipient membership predicate as readInbox's PG fast path, bounded
 * by the already-indexed coord_event_log primary key. The boolean row is
 * required: an unreadable result is uncertainty and must hydrate, never skip.
 */
export async function hasOwnerRelevantCoordDelta(
  ownerId: string,
  afterId: string,
  throughId: string,
  sqlOverride?: OrgSql,
): Promise<boolean> {
  const sql = sqlOverride ?? getOrgPg().sql;
  const rows = await sql<Array<{ relevant: boolean }>>`
    SELECT EXISTS (
      SELECT 1
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${coordScopeWorkspace()}
         AND id > ${afterId}::bigint
         AND id <= ${throughId}::bigint
         AND surface = 'messages'
         AND jsonb_typeof(body->'to') = 'array'
         -- Keep JSONB membership in PostgreSQL's native operator form so the
         -- coord_event_log recipient GIN index can answer this predicate. The
         -- equivalent JSONB membership function form falls back to a parallel
         -- sequential scan of the messages surface.
         AND ((body->'to') ? ${ownerId} OR (body->'to') ? '*')
    ) AS relevant
  `;
  const relevant = rows[0]?.relevant;
  if (typeof relevant !== 'boolean') {
    throw new Error('owner-relevant coordination delta query returned no boolean verdict');
  }
  return relevant;
}

async function currentGeneration(): Promise<string> {
  const rows = await getOrgPg().sql<Array<{ max_id: string }>>`
    SELECT COALESCE(MAX(id), 0)::text AS max_id
      FROM harness_shared.coord_event_log
     WHERE workspace_id = ${coordScopeWorkspace()}
  `;
  return `${HOST_EPOCH}:${rows[0]?.max_id ?? '0'}`;
}

const defaultDeps: ActivityHookBundleDeps = {
  generation: currentGeneration,
  ownerRelevantDelta: hasOwnerRelevantCoordDelta,
  // A missing durable baseline is an intentional full inbox baseline: the
  // server must not inherit the old client hook's `now` seed and skip mail.
  // Once a floor exists, keep the windowed read bounded by that server-owned
  // cursor.
  // D-013 R2: `coord:inbox` no longer takes an agent-facing `since_ts`. This is
  // the DELIVERY path — it owns the server-side cursor for surface 'inbox' — so
  // it passes its committed floor through the internal seam instead. Agents get
  // a VIEW; only a caller holding a real cursor gets a delta.
  inbox: async (sinceTs, ctx) => {
    return parseToolPayload(
      await inboxTool.handler(
        (sinceTs ? { __deliveryFloorTs: sinceTs } : {}) as Parameters<typeof inboxTool.handler>[0],
        ctx,
      ),
    );
  },
  glance: async (ctx) =>
    parseToolPayload(
      await glanceTool.handler(
        {
          audience: 'user',
          activity_limit: HOOK_BUNDLE_GLANCE_ACTIVITY_LIMIT,
          display_only: true,
        } as Parameters<typeof glanceTool.handler>[0],
        ctx as Parameters<typeof glanceTool.handler>[1],
      ),
    ),
  readInboxCursor: (ownerId) => ackReadCursor(ownerId, INBOX_CURSOR_SURFACE),
  stageInboxCursor: (ownerId, next) => stageReadCursor(ownerId, INBOX_CURSOR_SURFACE, next),
  readWatermark: (ownerId) => readCoordWatermark(ownerId),
  now: () => new Date(),
};

function nonEmptyTimestamp(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Choose the first-call inbox floor during migration from the old client file
 * cursor to the server cursor.
 *
 * A client timestamp is only a hint: when the durable watermark is absent we
 * must read a full baseline, because a client can have seeded itself to `now`
 * without ever showing the backlog. When a durable floor exists, an older
 * client hint is safe (it may duplicate) but a newer one is never allowed to
 * skip past the durable receipt.
 */
export function guardedLegacyInboxFloor(
  clientSinceTs: string | null | undefined,
  durableSinceTs: string | null,
): string | null {
  if (!durableSinceTs) return null;
  const client = nonEmptyTimestamp(clientSinceTs);
  if (!client || client <= durableSinceTs) return client ?? durableSinceTs;
  return durableSinceTs;
}

function committedInboxFloor(cursor: AckResult): string | null {
  if (cursor.baseline) return null;
  const value = cursor.committed?.since_ts;
  return nonEmptyTimestamp(value);
}

function inboxNewestTimestamp(inbox: Record<string, unknown> | null): string | null {
  const summary = inbox?.summary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
  return nonEmptyTimestamp((summary as Record<string, unknown>).newest_ts);
}

/**
 * Make ANY census sink unable to fail the fold.
 *
 * `coordFoldObserverFor` already guards the sink it builds, but a caller that
 * INJECTS `deps.observe` bypasses that guard entirely — and this runs
 * synchronously in a hook on every tool call for every agent in the fleet. The
 * protection therefore belongs at the use site, where it covers every sink
 * regardless of origin, rather than only inside one constructor.
 */
function safeObserve(
  sink: ((census: CoordFoldCensus) => void) | undefined,
): ((census: CoordFoldCensus) => void) | undefined {
  if (!sink) return undefined;
  return (census: CoordFoldCensus) => {
    try {
      sink(census);
    } catch {
      /* an instrument that can break what it measures is worse than none */
    }
  };
}

/** How much the hydrated inbox surface actually carried; null when unreadable. */
function inboxTotalCount(inbox: Record<string, unknown> | null): number | null {
  const summary = inbox?.summary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
  const total = (summary as Record<string, unknown>).total;
  return typeof total === 'number' && Number.isFinite(total) ? total : null;
}

/**
 * Did the inbox floor MOVE — i.e. did this hydration deliver mail this owner had
 * not already received?
 *
 * ⚠ This is NOT "the fold was worth it". The fold also replaces `glance`, whose
 * inputs move for reasons unrelated to this owner's mail. See the caveat in
 * coord-fold-census.ts: `changed AND NOT inboxAdvanced` is an UPPER BOUND on
 * what a per-owner inbox gate would have skipped, never a count of wasted work.
 */
function inboxDidAdvance(inbox: Record<string, unknown> | null, sinceTs: string | null): boolean {
  const newest = inboxNewestTimestamp(inbox);
  if (newest === null) return false;
  return sinceTs === null || newest > sinceTs;
}

/**
 * Return a stamped bundle.  Matching generations intentionally return no
 * surfaces: the client keeps its last full snapshot.  On mismatch both
 * surfaces are replaced together.  A partial hydrate is marked incomplete and
 * the client must retain its old generation so the next heartbeat retries.
 */
export async function buildActivityHookBundle(
  ownerId: string,
  request: ActivityHookBundleRequest,
  ctx: ToolContext,
  deps: ActivityHookBundleDeps = defaultDeps,
): Promise<ActivityHookBundle> {
  // P-005 (D-001): census EVERY fold, quiet ones included — the ratio is the
  // whole point, and a census that recorded only the expensive folds could not
  // report the one thing it exists to report. The sink rides `ctx.metadata` onto
  // the `tool_invocations` row this call already writes, so it costs no extra
  // query and no extra latency on the path being measured.
  const observe = safeObserve(deps.observe ?? coordFoldObserverFor(ctx));
  const startedMs = deps.now().getTime();

  // ACK the previous delivery before deciding whether this heartbeat is quiet.
  // The call itself is the ACK; if the prior turn died, its pending floor is
  // promoted and the next changed heartbeat re-reads from that floor.
  const [generation, inboxCursor] = await Promise.all([deps.generation(), deps.readInboxCursor(ownerId)]);
  let changed = request.force_resync === true || request.generation !== generation;
  if (changed && request.force_resync !== true && deps.ownerRelevantDelta) {
    const delta = sameHostCoordGenerationDelta(request.generation, generation);
    if (delta) {
      try {
        // Only an exact negative result closes the second gate. Any thrown or
        // malformed outcome keeps `changed=true`, preserving fail-open delivery.
        const relevant = await deps.ownerRelevantDelta(ownerId, delta.afterId, delta.throughId);
        if (relevant === false) changed = false;
      } catch {
        /* relevance uncertainty hydrates through the existing path */
      }
    }
  }
  // THE SPLIT (WI-10002436 compromise B). `changed` is, and stays, the INBOX
  // gate — every condition above it is untouched, so delivery cannot regress by
  // construction. The glance leg simply stops being welded to it: a client whose
  // display cache aged out now refreshes THAT leg alone instead of forcing the
  // inbox through a hydration it did not need.
  //
  // `glanceOnly` is deliberately `!changed && …`: when the inbox gate is already
  // open both surfaces hydrate together exactly as before.
  const glanceOnly = !changed && request.glance_stale === true;
  const gateMs = deps.now().getTime() - startedMs;
  const base: Omit<ActivityHookBundle, 'complete' | 'surfaces'> = {
    schemaVersion: ACTIVITY_HOOK_BUNDLE_SCHEMA,
    generation,
    changed,
    provenance: {
      source: 'activity:report' as const,
      ownerId,
      observedAt: deps.now().toISOString(),
    },
    resync: {
      on: ['schema-version-mismatch', 'generation-mismatch', 'surface-missing', 'operator-restart'],
      strategy: 'replace-full-never-merge-behind' as const,
      request: { generation: null, force_resync: true as const },
    },
  };
  if (!changed && !glanceOnly) {
    observe?.(
      censusCoordFold({
        changed,
        complete: true,
        forceResync: request.force_resync === true,
        reqGen: request.generation,
        gen: generation,
        foldMs: deps.now().getTime() - startedMs,
        gateMs,
        // The saving the optimization exists to deliver, recorded as a hard 0
        // rather than omitted — an absent field and a zero read identically.
        hydrateMs: 0,
        inboxAdvanced: false,
        inboxTotal: null,
        glanceOnly: false,
      }),
    );
    return { ...base, complete: true };
  }

  if (glanceOnly) {
    // The display leg, alone. Deliberately NOT reached: the watermark read, the
    // inbox hydration, and above all `stageInboxCursor` — advancing the delivery
    // cursor here would mark mail as received that this fold never assembled.
    //
    // `complete` still governs the client's generation advance, and the inbox
    // gate that produced `changed === false` is the same one whose quiet path
    // already advances it, so this returns the same generation that path would.
    // A failed glance hydrate yields `complete: false`, which makes the client
    // retry rather than bank a snapshot it did not get.
    const glance = await deps.glance(ctx).catch(() => null);
    const endedGlanceMs = deps.now().getTime();
    observe?.(
      censusCoordFold({
        changed,
        complete: glance !== null,
        forceResync: request.force_resync === true,
        reqGen: request.generation,
        gen: generation,
        foldMs: endedGlanceMs - startedMs,
        gateMs,
        hydrateMs: endedGlanceMs - startedMs - gateMs,
        // The inbox leg did not run, so it cannot have advanced and carried no
        // rows. `null` is "the leg did not run", which is exactly the case here.
        inboxAdvanced: false,
        inboxTotal: null,
        glanceOnly: true,
      }),
    );
    return {
      ...base,
      complete: glance !== null,
      ...(glance ? { surfaces: { glance } } : {}),
    };
  }

  const legacyWatermark = await deps.readWatermark(ownerId).catch(() => null);
  const durableLegacyFloor = legacyWatermark
    ? pickUnreadCursor(legacyWatermark.messages_since_ts, legacyWatermark.messages_shown_ts)
    : null;
  // Once the server cursor has a committed state, it is authoritative and the
  // client request is ignored. On the migration baseline, use the legacy
  // receipt but never let a client-supplied `since_ts` move it forward.
  const sinceTs = inboxCursor.baseline
    ? guardedLegacyInboxFloor(request.since_ts, durableLegacyFloor)
    : committedInboxFloor(inboxCursor);

  const [inbox, glance] = await Promise.all([
    deps.inbox(sinceTs, ctx).catch(() => null),
    deps.glance(ctx).catch(() => null),
  ]);
  let complete = inbox !== null && glance !== null;
  if (complete) {
    // Do not advance the server cursor until both replacement surfaces were
    // assembled. A stage failure is an incomplete fold: the client retains its
    // generation and the next heartbeat re-delivers from the same committed
    // floor, preserving at-least-once delivery.
    try {
      await deps.stageInboxCursor(ownerId, {
        since_ts: inboxNewestTimestamp(inbox) ?? sinceTs,
      });
    } catch {
      complete = false;
    }
  }
  const endedMs = deps.now().getTime();
  observe?.(
    censusCoordFold({
      changed,
      complete,
      forceResync: request.force_resync === true,
      reqGen: request.generation,
      gen: generation,
      foldMs: endedMs - startedMs,
      gateMs,
      // Everything past the gate decision: the watermark read, both surface
      // hydrations and the cursor stage. gateMs + hydrateMs therefore accounts
      // for the whole fold, leaving no unattributed remainder to guess at.
      hydrateMs: endedMs - startedMs - gateMs,
      inboxAdvanced: inboxDidAdvance(inbox, sinceTs),
      inboxTotal: inboxTotalCount(inbox),
      // The inbox gate opened, so both legs hydrated together on this path.
      glanceOnly: false,
    }),
  );
  return {
    ...base,
    complete,
    surfaces: {
      ...(inbox ? { inbox } : {}),
      ...(glance ? { glance } : {}),
    },
  };
}
