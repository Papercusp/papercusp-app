/**
 * Exclude-at-read for session transcripts.
 * Plan personal-data-reader-set-labels-2026-10-01 P-013 (WI-10005552), D-006 point 3.
 *
 * Papercusp does not WRITE an agent's transcript — the CLI does — so the
 * seal-at-write rule (P-006 / P-012) cannot reach it. Instead every agent-facing
 * read of a transcript (sessions:search, sessions:read, consult routing) runs its
 * turns through this module before returning them:
 *
 *   A turn recorded by agent A at time t is WITHHELD from every caller other than
 *   A when t falls inside one of A's disclosure windows
 *   [delivered_at, released_at) — released windows included, because the content
 *   was in A's context while the window was open.
 *
 * A withheld turn is COUNTED, never silently dropped: each surface reports the
 * tally on its result (`withheldReceipt`).
 *
 * A COUNT MUST NOT DEPEND ON THE QUERY. If a search reported "1 hit withheld"
 * only when the query matched a restricted turn, a caller could confirm any
 * guess about that turn's text without ever reading it. So the query-driven
 * surfaces (sessions:search, consult routing) exclude restricted turns INSIDE
 * the matching SQL (`restrictedTurnSql`), before any ranking or LIMIT. The
 * count they report covers the caller's whole scope, whatever the query
 * (`countRestrictedTurnsInScope`, `restrictedTranscriptSummary`). Only
 * sessions:read, which selects turns by position rather than by content,
 * counts per returned turn.
 *
 * Two fail-closed rules:
 *   - A turn with NO recorded owner cannot be attributed to an agent, so it is
 *     withheld whenever ANY other agent's disclosure window covers its time.
 *     With no disclosures in the ledger this changes nothing.
 *   - If the ledger cannot be read, the read is refused with
 *     `disclosure_ledger_unavailable` rather than served unfiltered.
 *
 * `restrictedTranscriptOwners` is the owner-level form used by consult, whose
 * answer session forks an expert's WHOLE transcript: an expert who has held any
 * disclosure is not a routable transcript source at all.
 */
import type postgres from 'postgres';
import { DisclosureRefused } from './disclosure-ledger';

type Db = postgres.Sql | postgres.TransactionSql;

/** One disclosure window in epoch-ms; `to === null` while the disclosure is active. */
export interface DisclosureWindow {
  from: number;
  to: number | null;
}

/** What a read surface knows about one transcript turn. */
export interface TranscriptTurnStamp {
  /** `session_turns.owner` — the agent identity that recorded the turn. */
  owner: string | null | undefined;
  /** When the turn was recorded: `session_turns.ts`, falling back to `ingested_at`. */
  at: string | Date | null | undefined;
}

export type WithholdReason = 'disclosure-window' | 'unattributed';

export interface WithheldTally {
  turns: number;
  byReason: Record<WithholdReason, number>;
}

export const D006_TRANSCRIPT_RULE =
  "D-006 (personal-data-reader-set-labels): turns another agent recorded while it held personal data " +
  "under a restricted privacy level are withheld from every reader but that agent.";

function toMs(at: string | Date | null | undefined): number | null {
  if (at == null) return null;
  const ms = at instanceof Date ? at.getTime() : Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

function normOwner(owner: string | null | undefined): string | null {
  const trimmed = owner?.trim();
  return trimmed ? trimmed : null;
}

function covers(windows: readonly DisclosureWindow[], at: number | null): boolean {
  if (windows.length === 0) return false;
  // A turn with no time cannot be placed outside a window: fail closed.
  if (at === null) return true;
  return windows.some((w) => at >= w.from && (w.to === null || at < w.to));
}

export function emptyTally(): WithheldTally {
  return { turns: 0, byReason: { 'disclosure-window': 0, unattributed: 0 } };
}

export function addTally(into: WithheldTally, from: WithheldTally): WithheldTally {
  into.turns += from.turns;
  into.byReason['disclosure-window'] += from.byReason['disclosure-window'];
  into.byReason.unattributed += from.byReason.unattributed;
  return into;
}

/** The per-caller decision, built once per read from the ledger. Pure after construction. */
export class TranscriptExclusion {
  constructor(
    private readonly selfOwners: ReadonlySet<string>,
    private readonly windowsByOwner: ReadonlyMap<string, DisclosureWindow[]>,
    /** Every other agent's windows, loaded only when an unattributed turn needs them. */
    private readonly anyOwnerWindows: readonly DisclosureWindow[],
  ) {}

  /** Why this turn is withheld from the caller, or null when it may be shown. */
  withholds(stamp: TranscriptTurnStamp): WithholdReason | null {
    const owner = normOwner(stamp.owner);
    const at = toMs(stamp.at);
    if (owner === null) return covers(this.anyOwnerWindows, at) ? 'unattributed' : null;
    if (this.selfOwners.has(owner)) return null;
    return covers(this.windowsByOwner.get(owner) ?? [], at) ? 'disclosure-window' : null;
  }

  /**
   * Why a WHOLE transcript span is withheld from the caller: any window of its
   * owner (any other agent's, when the owner is unknown) overlapping
   * [from, to]. A surface that cannot place individual turns — a raw-file grep —
   * uses this so the decision depends on the session, never on the query.
   * An unknown bound is open (fail closed). Load the exclusion with an untimed
   * stamp per owner so every window of that owner is present.
   */
  withholdsSpan(span: { owner: string | null | undefined; from: string | Date | number | null | undefined; to: string | Date | number | null | undefined }): WithholdReason | null {
    const owner = normOwner(span.owner);
    const from = typeof span.from === 'number' ? span.from : toMs(span.from);
    const to = typeof span.to === 'number' ? span.to : toMs(span.to);
    const overlaps = (windows: readonly DisclosureWindow[]) =>
      windows.some((w) => (to === null || w.from <= to) && (from === null || w.to === null || w.to > from));
    if (owner === null) return overlaps(this.anyOwnerWindows) ? 'unattributed' : null;
    if (this.selfOwners.has(owner)) return null;
    return overlaps(this.windowsByOwner.get(owner) ?? []) ? 'disclosure-window' : null;
  }

  /** Partition `turns`, keeping order. */
  partition<T>(turns: readonly T[], stampOf: (turn: T) => TranscriptTurnStamp): { kept: T[]; withheld: WithheldTally } {
    const kept: T[] = [];
    const withheld = emptyTally();
    for (const turn of turns) {
      const reason = this.withholds(stampOf(turn));
      if (reason === null) {
        kept.push(turn);
      } else {
        withheld.turns += 1;
        withheld.byReason[reason] += 1;
      }
    }
    return { kept, withheld };
  }
}

function ledgerUnavailable(error: unknown): DisclosureRefused {
  return new DisclosureRefused(
    'disclosure_ledger_unavailable',
    `transcript read refused: the disclosure ledger could not be read (${(error as Error)?.message ?? error})`,
  );
}

/**
 * Load the decision for `stamps` as read by a caller whose identities are
 * `selfOwnerIds` (the caller's ownerId, plus its respawn chain when the surface
 * already resolved one). Issues no query when every turn is the caller's own.
 */
export async function loadTranscriptExclusion(
  sql: Db,
  params: { selfOwnerIds: ReadonlyArray<string | null | undefined>; stamps: readonly TranscriptTurnStamp[] },
): Promise<TranscriptExclusion> {
  const selfOwners = new Set(params.selfOwnerIds.map(normOwner).filter((o): o is string => o !== null));
  const owners = new Set<string>();
  let unattributedFrom: number | null = null;
  let unattributedTo: number | null = null;
  let unattributedUntimed = false;
  for (const stamp of params.stamps) {
    const owner = normOwner(stamp.owner);
    if (owner !== null) {
      if (!selfOwners.has(owner)) owners.add(owner);
      continue;
    }
    const at = toMs(stamp.at);
    if (at === null) {
      unattributedUntimed = true;
    } else {
      unattributedFrom = unattributedFrom === null ? at : Math.min(unattributedFrom, at);
      unattributedTo = unattributedTo === null ? at : Math.max(unattributedTo, at);
    }
  }
  const self = [...selfOwners];
  const windowsByOwner = new Map<string, DisclosureWindow[]>();
  const anyOwnerWindows: DisclosureWindow[] = [];
  try {
    if (owners.size > 0) {
      const rows = await sql<Array<{ owner: string; from: Date; to: Date | null }>>`
        SELECT agent_owner_id AS owner, delivered_at AS "from", released_at AS "to"
          FROM harness_shared.personal_disclosures
         WHERE agent_owner_id = ANY(${[...owners]}::text[])`;
      for (const row of rows) {
        const list = windowsByOwner.get(row.owner) ?? [];
        list.push({ from: new Date(row.from).getTime(), to: row.to ? new Date(row.to).getTime() : null });
        windowsByOwner.set(row.owner, list);
      }
    }
    if (unattributedUntimed || unattributedFrom !== null) {
      // An untimed unattributed turn can sit in any window; otherwise only windows
      // overlapping the unattributed turns' time span can cover one.
      const lo = unattributedUntimed ? null : new Date(unattributedFrom!);
      const hi = unattributedUntimed ? null : new Date(unattributedTo!);
      const rows = await sql<Array<{ from: Date; to: Date | null }>>`
        SELECT delivered_at AS "from", released_at AS "to"
          FROM harness_shared.personal_disclosures
         WHERE agent_owner_id <> ALL(${self}::text[])
           AND (${hi}::timestamptz IS NULL OR delivered_at <= ${hi}::timestamptz)
           AND (${lo}::timestamptz IS NULL OR released_at IS NULL OR released_at > ${lo}::timestamptz)`;
      for (const row of rows) {
        anyOwnerWindows.push({ from: new Date(row.from).getTime(), to: row.to ? new Date(row.to).getTime() : null });
      }
    }
  } catch (error) {
    throw ledgerUnavailable(error);
  }
  return new TranscriptExclusion(selfOwners, windowsByOwner, anyOwnerWindows);
}

/** Load the decision and partition `turns` in one call. */
export async function withholdRestrictedTurns<T>(
  sql: Db,
  params: { selfOwnerIds: ReadonlyArray<string | null | undefined> },
  turns: readonly T[],
  stampOf: (turn: T) => TranscriptTurnStamp,
): Promise<{ kept: T[]; withheld: WithheldTally }> {
  if (turns.length === 0) return { kept: [], withheld: emptyTally() };
  const exclusion = await loadTranscriptExclusion(sql, {
    selfOwnerIds: params.selfOwnerIds,
    stamps: turns.map(stampOf),
  });
  return exclusion.partition(turns, stampOf);
}

type Fragment = postgres.PendingQuery<postgres.Row[]>;

const QUALIFIER = /^[a-z_][a-z0-9_]*$/;

/** `qualifier` as an escaped identifier, so `${q}.owner` renders `"st".owner`. */
function ident(sql: Db, qualifier: string, who: string): Fragment {
  if (!QUALIFIER.test(qualifier)) throw new Error(`${who}: invalid qualifier ${qualifier}`);
  return (sql as postgres.Sql)(qualifier) as unknown as Fragment;
}

function selfList(selfOwnerIds: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(selfOwnerIds.map(normOwner).filter((o): o is string => o !== null))];
}

/**
 * SQL that is TRUE when the transcript row `qualifier` (a `session_turns` or
 * `session_turn_parts` alias or table name) is withheld from a caller whose
 * identities are `selfOwnerIds`: the same rule as `TranscriptExclusion.withholds`.
 * Put `NOT (…)` of it inside a matching query so a restricted turn never
 * competes for a result slot.
 */
export function restrictedTurnSql(
  sql: Db,
  qualifier: string,
  selfOwnerIds: ReadonlyArray<string | null | undefined>,
): Fragment {
  const q = ident(sql, qualifier, 'restrictedTurnSql');
  const self = selfList(selfOwnerIds);
  const at = sql`COALESCE(${q}.ts, ${q}.ingested_at)` as unknown as Fragment;
  return sql`(
    EXISTS (SELECT 1 FROM harness_shared.personal_disclosures d
             WHERE d.agent_owner_id = ${q}.owner
               AND d.agent_owner_id <> ALL(${self}::text[])
               AND d.delivered_at <= ${at}
               AND (d.released_at IS NULL OR ${at} < d.released_at))
    OR ((${q}.owner IS NULL OR btrim(${q}.owner) = '')
        AND EXISTS (SELECT 1 FROM harness_shared.personal_disclosures d
                     WHERE d.agent_owner_id <> ALL(${self}::text[])
                       AND d.delivered_at <= ${at}
                       AND (d.released_at IS NULL OR ${at} < d.released_at)))
  )` as unknown as Fragment;
}

/**
 * How many `session_turns` rows inside `scope` are withheld from the caller —
 * a count that does not depend on any query text. `scope` is a predicate over
 * the alias `st`. Driven from the (small) disclosure ledger so the transcript
 * index is reached only through its (owner, ts) index.
 */
export async function countRestrictedTurnsInScope(
  sql: Db,
  params: { selfOwnerIds: ReadonlyArray<string | null | undefined>; scope: Fragment },
): Promise<WithheldTally> {
  const self = selfList(params.selfOwnerIds);
  try {
    const [row] = await sql<Array<{ owned: number; unattributed: number }>>`
      SELECT
        (SELECT count(DISTINCT (st.workspace_id, st.source_kind, st.session_id, st.turn_idx))::int
           FROM harness_shared.personal_disclosures d
           JOIN harness_shared.session_turns st
             ON st.owner = d.agent_owner_id
            AND COALESCE(st.ts, st.ingested_at) >= d.delivered_at
            AND (d.released_at IS NULL OR COALESCE(st.ts, st.ingested_at) < d.released_at)
          WHERE d.agent_owner_id <> ALL(${self}::text[])
            AND ${params.scope}) AS owned,
        (SELECT count(DISTINCT (st.workspace_id, st.source_kind, st.session_id, st.turn_idx))::int
           FROM harness_shared.personal_disclosures d
           JOIN harness_shared.session_turns st
             ON (st.owner IS NULL OR btrim(st.owner) = '')
            AND COALESCE(st.ts, st.ingested_at) >= d.delivered_at
            AND (d.released_at IS NULL OR COALESCE(st.ts, st.ingested_at) < d.released_at)
          WHERE d.agent_owner_id <> ALL(${self}::text[])
            AND ${params.scope}) AS unattributed`;
    const owned = Number(row?.owned ?? 0);
    const unattributed = Number(row?.unattributed ?? 0);
    return { turns: owned + unattributed, byReason: { 'disclosure-window': owned, unattributed } };
  } catch (error) {
    throw ledgerUnavailable(error);
  }
}

/** SQL that is TRUE when `qualifier`'s owner has EVER held a disclosure (consult's owner-level rule). */
export function restrictedOwnerSql(sql: Db, qualifier: string): Fragment {
  const q = ident(sql, qualifier, 'restrictedOwnerSql');
  return sql`EXISTS (SELECT 1 FROM harness_shared.personal_disclosures d WHERE d.agent_owner_id = ${q}.owner)` as unknown as Fragment;
}

/**
 * Consult's owner-level rule. Its answer session forks a routed expert's WHOLE
 * transcript, so a per-turn filter cannot make that fork safe: an expert who has
 * ever held a disclosure (active or released) is not a routable source at all.
 * Routing excludes such experts in SQL (`restrictedOwnerSql`); this returns the
 * query-independent count it reports — every such agent other than
 * `excludeOwners`, and every turn they recorded in `workspaceId`'s index.
 */
export async function restrictedTranscriptSummary(
  sql: Db,
  params: { workspaceId: string; excludeOwners: ReadonlyArray<string | null | undefined> },
): Promise<{ owners: number; turns: number }> {
  const exclude = selfList(params.excludeOwners);
  try {
    const [row] = await sql<Array<{ owners: number; turns: number }>>`
      WITH restricted AS (
        SELECT DISTINCT agent_owner_id AS owner
          FROM harness_shared.personal_disclosures
         WHERE agent_owner_id <> ALL(${exclude}::text[])
      )
      SELECT (SELECT count(*)::int FROM restricted) AS owners,
             (SELECT count(*)::int
                FROM harness_shared.session_turns st
                JOIN restricted r ON st.owner = r.owner
               WHERE st.workspace_id = ${params.workspaceId} OR st.workspace_id = 'default') AS turns`;
    return { owners: Number(row?.owners ?? 0), turns: Number(row?.turns ?? 0) };
  } catch (error) {
    throw ledgerUnavailable(error);
  }
}

/**
 * The receipt a read surface spreads into its result; empty when nothing was
 * withheld. `breakdown` names where the withheld turns came from (non-zero
 * entries only). A turn can sit in two buckets — for example both in a
 * search's scope and in a returned hit's context window — so the total may
 * count it twice; it never counts a withheld turn zero times.
 */
export function withheldReceipt(
  tally: WithheldTally,
  breakdown: Record<string, number> = {},
): { withheld?: { restricted_turns: number; unattributed_turns?: number; rule: string } & Record<string, number | string> } {
  if (tally.turns === 0) return {};
  const parts = Object.fromEntries(Object.entries(breakdown).filter(([, n]) => n > 0));
  return {
    withheld: {
      restricted_turns: tally.turns,
      ...(tally.byReason.unattributed > 0 ? { unattributed_turns: tally.byReason.unattributed } : {}),
      ...parts,
      rule: D006_TRANSCRIPT_RULE,
    },
  };
}
