/**
 * UI display-projection for the `workItems.byHarness` sync feed
 * (precompute-sync-reads-phase2-compute-latency-2026-07-19 P-006;
 * widened to an ALLOW-LIST by no-http-anywhere-2026-07-28 P-028 / D-022).
 *
 * `workItems.byHarness` was the single largest sync payload found (3.79MB at
 * limit 2000). A prior audit nulled the per-row `payload` /
 * `terminalCompletionRef` / `terminalCompletionEvidence` blobs in the SHARED
 * listEnrichedWorkItems assembly (both transports), and P-006 blanked `summary`
 * here (avg ~694 chars, max ~346KB on the papercusp harness) — the grid never
 * renders, filters or searches it, and DetailPanel fetches the selected row's
 * full prose on demand via the `workItems.detail` query.
 *
 * WHY THIS IS AN ALLOW-LIST AND NOT A DENY-LIST
 * ---------------------------------------------
 * P-006's version blanked `summary` and spread everything else through. That is
 * a deny-list, so every field the shared `WorkItem` interface ever grows ships
 * to the grid forever — and the residue is not small. Measured 2026-08-02
 * against the live papercusp harness (500 rows of 16,126, through the same
 * `listEnrichedWorkItems` assembly this resolver reuses):
 *
 *   deny-list (summary blanked, everything else spread) .. 438,976 B  (429 KB)
 *   allow-list, the fields below only .................... 264,676 B  (258 KB)
 *                                                           −40%, ~177 KB / load
 *
 * Most of that residue is pure key-name overhead: `payload`,
 * `terminalCompletionRef` and `terminalCompletionEvidence` are already forced to
 * `null` by `slimListRow`, so they cost ~78 bytes/row to transmit nothing, and
 * `terminalOwner` / `completionAuthority` / `rankWriter` / `rankUpdatedAt` /
 * `createdAt` / `closedAt` / `takenAt` / `lastProgressAt` / `parent` /
 * `harness` / `planItemIds` are read by NO consumer of this query.
 *
 * THE CONSUMER CONTRACT
 * ---------------------
 * The kept set below is exactly `WorkItemsPanel`'s exported `WorkItemRow`, which
 * is the union of what every `workItems.byHarness` subscriber renders — the
 * complete set of call sites being:
 *   - `adv/harnesses/WorkItemsPanel.tsx`  — the grid (the widest reader)
 *   - `adv/harnesses/DetailPanel.tsx`     — the light fields, while
 *     `workItems.detail` (which carries the FULL row) is in flight
 *   - `adv/harnesses/AdvChatPanel.tsx`    — StartChatPicker: id/title/state
 *   - `adv/hud/HudView.tsx` + `hud-entity-board.ts` — `HudWorkItemInput`
 * (`AdvOverviewTab` deliberately never reads this query.)
 *
 * A panel that needs another field adds it HERE — which is the point: the wire
 * cost of a new `WorkItem` column becomes a decision instead of a default.
 *
 * SCOPE: the SYNC RESOLVER boundary ONLY. The shared `listEnrichedWorkItems`
 * loader and the `/api/harness/:slug/work-items` HTTP route (pui TUI) keep the
 * full row — the same "slim at the UI boundary, never the shared loader" pattern
 * as `coord-ui-projection.ts`.
 */

/**
 * The fields `workItems.byHarness` puts on the wire. Exported so a test can
 * assert the projection against it, and so widening it is a visible edit.
 *
 * `summary` is not listed here because it is never copied from the source row —
 * it is emitted as a PRESENT-BUT-EMPTY key (see below).
 */
export const WORK_ITEMS_LIST_UI_FIELDS = [
  'id',
  'kind',
  'family',
  'title',
  'state',
  'assignee',
  'assignedBy',
  'severity',
  'priority',
  'rank',
  // P-010 v2 route-side joins the grid renders. `planItemIds` is deliberately
  // absent — no consumer reads it; only `planSlug`.
  'planSlug',
  'spineRole',
  'spineStatus',
  'updatedAt',
  // Trust-badge provenance (Trust A4).
  'origin',
  'auditVerdict',
  'verifiedAuthorGithubUserId',
  'presentation',
] as const;

/**
 * Project each work-item list row down to {@link WORK_ITEMS_LIST_UI_FIELDS}
 * (plus a blanked `summary`, and row[0]'s `_meta` list total). A non-array — and
 * a non-object row — passes through defensively.
 */
export function projectWorkItemsListForUi(rows: unknown): unknown[] {
  if (!Array.isArray(rows)) return rows as unknown[];
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const src = row as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of WORK_ITEMS_LIST_UI_FIELDS) {
      // Copy only what the row actually has, so an absent field stays absent
      // rather than becoming an explicit `undefined`.
      if (k in src) out[k] = src[k];
    }
    // Keep the key present (consumers type summary as string) but empty, so the
    // wire cost is a few bytes instead of hundreds.
    out.summary = '';
    // The list total rides on row[0]._meta (the flat-row sync contract has no
    // envelope); attachListMeta ran BEFORE this projection, so carry it through.
    if ('_meta' in src) out._meta = src._meta;
    return out;
  });
}
