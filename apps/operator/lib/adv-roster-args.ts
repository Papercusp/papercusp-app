/**
 * The ONE args shape for the `advRoster.list` sync query.
 *
 * WHY A HELPER AND NOT TEN LITERALS — react-query dedupes on the query key, and
 * the key IS the args object. Ten hand-written literals drifted into five
 * distinct keys, so the same roster was resolved and pushed five times per
 * window (no-http-anywhere-2026-07-28 P-026 / D-007 measured two of them at
 * 248 KB / 44 fetches and 231 KB / 37 fetches in one 53-minute session). Three
 * of those call sites even carried a comment claiming they shared an entry with
 * a sibling — they did not; one was missing `endedLimit` entirely, which is a
 * different key even though the resolver defaults it to the same value.
 *
 * `endedLimit` bounds ONLY the ended-sessions slice (`listEndedAdvSessions`);
 * active/pending/starting are unaffected. 50 is the resolver's own default and
 * a superset of the 20 the sidebar surfaces used to ask for — and every one of
 * those reads `active` only, so they were paying for a second full resolve to
 * receive FEWER of a field they discard.
 *
 * ⚠ `workspaceId` is NOT normalisable and must stay a parameter.
 * `scopePresenceToWorkspace(presence, null)` returns presence UNFILTERED, so
 * `null` means "every workspace" while a concrete id means "that workspace plus
 * GLOBAL". Collapsing the two would silently change which agents a surface
 * shows. Two keys therefore remain by design — one per scope.
 *
 * A fresh object per render is fine: TanStack v5 hashes keys structurally, so
 * content-equal args map to one query (pinned by usePollingQuery.test.tsx).
 * No `useMemo` needed at the call site.
 */

/** Ended-sessions slice size. The resolver's own default; the superset of every consumer's need. */
export const ADV_ROSTER_ENDED_LIMIT = 50;

/**
 * A `type`, deliberately not an `interface`: `SyncQueryOptions.args` is
 * `Record<string, unknown>`, and only a type alias gets TypeScript's implicit
 * index signature. An interface here compiles clean in isolation and then fails
 * at every call site with TS2322 — which a SCOPED typecheck can miss.
 */
export type AdvRosterArgs = {
  workspaceId: string | null;
  endedLimit: number;
};

/**
 * Canonical `advRoster.list` args.
 *
 * @param workspaceId `null`/`undefined` ⇒ workspace-WIDE (every workspace);
 *   a concrete id ⇒ scoped to that workspace + GLOBAL. Pass what your surface
 *   actually means — this is a semantic choice, not a formatting one.
 */
export function advRosterArgs(workspaceId?: string | null): AdvRosterArgs {
  return { workspaceId: workspaceId ?? null, endedLimit: ADV_ROSTER_ENDED_LIMIT };
}
