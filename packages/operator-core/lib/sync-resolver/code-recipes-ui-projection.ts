/**
 * code-recipes-ui-projection.ts — the UI-read projection for the `codeRecipes`
 * sync query (WI-7085).
 *
 * `codeRecipes` was the FATTEST sync read in the tree: 2,936,018 B for 1,000 rows
 * measured live on :3070 (2026-08-02), ~11.7x the 250 KB payload budget, with no
 * SYNC_READ_ALLOWLIST entry — so it was a live budget violation that nothing had
 * ever measured.
 *
 * It is NOT the fabricated-row class (WI-7083): distinct `id` = 1000 across 1000
 * rows, ratio 1.0000, so every row is real. It is the UNREAD FIELD class (D-023),
 * in its purest form yet — two thirds of the row shape is never rendered:
 *
 *   script      2,309,736 B  79.21%   <- removed at the SQL, not here (see below)
 *   createdBy      51,857 B   1.78%
 *   createdAt      42,901 B   1.47%
 *   updatedAt      42,901 B   1.47%
 *   potSlug        21,000 B   0.72%
 *   hasEmbedding   19,000 B   0.65%
 *   mergedInto     17,000 B   0.58%   (null on 1000/1000)
 *   tags            9,000 B   0.31%
 *
 * The `script` body is dropped one layer DOWN, in `listRecipes` itself
 * (code-recipes-store.ts): no list caller has ever read it — `recipes:list`, the
 * learning-retain read and this resolver each projected it back off — so selecting
 * it was waste on the Postgres→node leg too, not just on the wire. Fixing it there
 * rather than here is what makes that saving real on both legs.
 *
 * What remains is an ALLOW-LIST rather than the deny-list used by the plans
 * projection (agent-tools/plans/ui-read-projection.ts). A deny-list is right when
 * the consumer set is wide and mostly-rendering; here the read set is a single
 * component with an exhaustively auditable surface, and an allow-list means a
 * column added to `code_recipes` later cannot silently re-inflate this payload.
 *
 * The keep set is every field RecipesClient.tsx touches — render AND the
 * client-side sort/filter/count paths, which are easy to miss because they read
 * fields the markup never shows:
 *   render:  id · title · description · authorRole · runCount · successCount ·
 *            lastRunAt · status · promotedTool · toolsUsed · distinctAgents
 *   sort:    runCount · id · successCount · title · lastRunAt   (SORT_VALUES)
 *   filter:  status                                             (STATUS_VALUES)
 *   counts:  status
 *
 * `distinctAgents` is in the keep set even though the resolver does not currently
 * supply it (the client reads it through a cast and renders '—'). An allow-list
 * that omitted it would silently swallow the field the day someone wires the
 * enrichment up — exactly the trap this file exists to prevent.
 *
 * NULL KEYS (D-025) are omitted on top of the allow-list: `promotedTool` is null
 * on 1000/1000 rows (19,000 B of literal `"promotedTool":null`). Its only consumer
 * is `{r.promotedTool ? … : null}`, which cannot distinguish absent from null, so
 * the omission is invisible to the UI. `mergedInto` is null on 1000/1000 too and
 * is not read at all, so the allow-list drops it outright.
 *
 * Server-only.
 */

/**
 * Every field any `codeRecipes` consumer reads. Audited against the ONE consumer,
 * RecipesClient.tsx (apps/operator-vite/src/components/admin/) — the only
 * `useSyncQuery({ queryName: 'codeRecipes' })` call site in the tree.
 */
export const CODE_RECIPE_UI_FIELDS = [
  'id',
  'title',
  'description',
  'authorRole',
  'toolsUsed',
  'runCount',
  'successCount',
  'lastRunAt',
  'status',
  'promotedTool',
  // Read by the client through a cast; not yet supplied by the resolver. Kept so
  // wiring the enrichment up later does not require also remembering this list.
  'distinctAgents',
] as const;

const KEEP = new Set<string>(CODE_RECIPE_UI_FIELDS);

/**
 * Project one recipe row to the UI read set, omitting null-valued keys (D-025).
 *
 * Null-omission is a WIRE-CONTRACT change: a consumer that distinguishes `null`
 * from `undefined` — `'k' in row`, `Object.keys`, a `=== null` test, or a
 * destructuring default that must NOT apply — would break. Audited for this row
 * shape: the client's only optional-field reads are `r.description ? …`,
 * `r.authorRole ? …` and `r.promotedTool ? …`, all truthiness tests that treat
 * absent and null identically.
 */
function projectObject(row: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!KEEP.has(k) || v === null) continue;
    out[k] = v;
  }
  return out;
}

export function projectCodeRecipeRow(row: unknown): unknown {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  return projectObject(row);
}

/**
 * Project a whole `codeRecipes` result set. Returns `Record<string, unknown>[]`
 * (not `unknown[]`) so the result stays assignable to `attachListMeta`, which
 * stamps `_meta` onto row[0] and therefore requires objects.
 */
export function projectCodeRecipeRows(rows: readonly object[]): Record<string, unknown>[] {
  return rows.map(projectObject);
}
