/**
 * UI-path display projection for the plans:* READ payloads
 * (whole-app-sync-payload-audit-2026-07-19 P-005).
 *
 * `callPlansReadRaw` (read-dispatch.ts) is the SINGLE in-process dispatch that
 * feeds BOTH UI surfaces — the `/api/admin/plans/*` REST routes and the
 * `@papercusp/sync` `plans.*` live-query resolvers — and it always requests
 * `payloadTier:'full'` (WI-5078: the payload-tier HARD CEILING must NOT trim the
 * UI's reads, or plans:attention comes back as item-less group summaries and the
 * Queue/Overview/Inbox blank out). Agent/MCP sessions never reach this function
 * (they hit the tool via the MCP endpoint directly), so a projection here is
 * UI-only and cannot regress the agent-facing shapers.
 *
 * The `full` UI payloads measured (2026-07-19, :3170 sync path) were dominated
 * by two things the LIST/QUEUE scan views never render at full length:
 *   - plans:items ~2.9MB  — `item.text` 1.6MB, `coverage` 181KB (no UI consumer),
 *     `item.rawLine`/`item.unresolvedBlockers` ~20KB (not in the PlanItem UI type)
 *   - plans:list  ~910KB  — `nextAction` 221KB (the full `## Now` next line;
 *     PlanRail shows it CSS-clamped + a tooltip)
 * Both feeds are pure SCAN surfaces: the cross-plan `plans:items` list drives
 * counts + a clamped item list, and the DETAIL pane (PlanItemPreview) fetches
 * the full item body separately via `plans:get` (usePlan live). So we clip the
 * displayed text to a generous preview and drop the true non-display blobs.
 *
 * plans:attention IS now projected too (slim-plans-attention-sync-payload-2026-07-26
 * P-003) — it was the fattest UI read left at 1490KB (152 groups / 1096 items,
 * 97.9% of it the nested `items[]`). It gets a LIST/DETAIL split rather than a
 * blanket slim, because only part of the per-item payload is detail-tier. The
 * split was drawn by auditing every consumer, and TWO fields that look
 * detail-tier are not:
 *   - `ref` — read by a LIST-LEVEL filter (SessionChatModal's
 *     `isEscalationWithOptions` narrows the whole feed by `ref.options`), so
 *     dropping it silently empties the session-chat escalation cards. KEPT.
 *   - `report` — read by InboxPane's `buildDiscussDraft`, and it measured 0
 *     bytes in practice (no live item carries one). KEPT: no win, real risk.
 * P-003 later restored `actions` to the list projection: the Resolution Inbox
 * must paint its action strip from the selected list row rather than wait for a
 * second `plans.attentionItem` round-trip. The measured cost is 59,477 bytes in
 * a 1,033,734-byte 500-item response (5.8%, about 12KB at the normal 100-item
 * page), while removing the hydration stall from every action-bearing row.
 * `body` remains clipped (609KB → ~256KB; median 336B, p90 1282B, max 6431B
 * over 1097 items). `body` is CLIPPED rather than dropped because it
 * is not purely detail-tier either — InboxPane's client-side search haystack,
 * AdvOverviewTab's row tooltip and attention-card's question fallback all read
 * it, and dropping it would silently degrade inbox search to title-only.
 * The full `body` comes back on selection via the `plans.attentionItem`
 * resolver, which bypasses this projection (`uiProjection: false`) and merges
 * over the list row. Its `actions` field may merge too, but buttons no longer
 * depend on that detail response.
 *
 * The attention feed additionally OMITS NULL-VALUED KEYS at the item + group top
 * level (no-http-anywhere-2026-07-28 D-025 / WI-7039) — 154,971 B of a live
 * 1,062,144 B payload, 14.6%, and the third distinct payload bug class after the
 * unread field (D-023) and the unreachable field (D-024). See
 * {@link omitNullValues} for the wire-contract change that implies and why this
 * belongs in the resolver rather than the serializer.
 *
 * plans:list gets the same omit (WI-7045) — 125,553 B of a live 823,983 B / 934-row
 * payload, 15.2%, concentrated in a handful of optional columns that are null on
 * nearly every row (initiative 934/934, priority 932, scheduleKind 932, origin 928,
 * template 906, startStatus 903, maxImportance 743, owner + ownerIdentity 421).
 * Its consumer audit is wider than attention's single entrypoint — 39 non-test
 * files reachable from `PlanListRow` / `usePlanList` / the `plans.list` +
 * `plans.byHive` resolvers — and came back with ZERO sites in the four categories
 * {@link omitNullValues} breaks. The one `=== null` that looks like a hit
 * (plan-sorting.ts `comparePlans('progress')`) tests `planProgress()`'s OWN return
 * value, and that function's `if (!counts) return null` guard already treats a
 * missing `itemCounts` the same as a null one.
 *
 * STILL NOT extended into the nested identity objects HERE — and it CANNOT be,
 * which is worth stating precisely because the obvious patch looks like it works
 * (EI-19455103442009801). `avatarUrl` inside `lastEditor` / `ownerIdentity` was
 * null on 1,475/1,475 live occurrences (25,075 B, 3.5% of the read production
 * actually issues), so it IS worth cutting — but this projection is the wrong
 * layer for it. `enrichPlanListRows` (sync-resolver/plan-attribution.ts) runs
 * AFTER this function and `delete`s then RE-ATTACHES both keys, so a descent
 * added here is a structural NO-OP: it fires on rows that do not carry the
 * identity objects yet, and anything it did would be overwritten moments later.
 * Verified live — adding the descent here changed the payload by 0 bytes.
 *
 * ✅ THE CUT LIVES AT THE ATTACHMENT POINT instead: `enrichPlanListRows` strips a
 * null `avatarUrl` as it attaches, which is also where the WI-7045 "never write a
 * null back after the projection omitted it" rule already lives. One fix there
 * covers BOTH `plans.list` and `plans.byHive` (its only two production callers).
 *
 * ⚠ If you are here because you want to slim a NESTED object on the list feed,
 * check whether a later enricher owns that key before editing this file — the
 * `plans:items` descent below is genuine (nothing re-attaches `item`), so the two
 * cases look identical from here and are not.
 *
 * plans:get and every other verb pass through unchanged — plans:get IS the
 * full-fidelity detail read.
 */

/** Preview cap for the scan-list text fields — matches the standard agent tier's
 *  text cap so the tooltip preview length is consistent across surfaces. */
export const UI_TEXT_PREVIEW_MAX = 280;

/** True non-display fields carried on the FULL plans:items row (top-level) that
 *  no UI consumer reads. `archived` and `coverageDivergence` join the original
 *  two under WI-7086: the four consumers below read only `plan` and the nested
 *  `item`, and `archived` survives solely as a comment about the SERVER's
 *  ordering (PlanItemsList.tsx:140), never as a field anything branches on.
 *
 *  `specTriadMissing` joins them under WI-5910 — a server-derived gating
 *  annotation (items.ts:284, set only when `triad.gated`), same category as
 *  `blockedByIssues`. 325 B on the live `{status:'blocked'}` read; 0 B on
 *  `{actionable:true}`, which filters gated items out before this row is built.
 *
 *  ⚠ FALSE-POSITIVE GREP: `launch-on-plan.ts:121` reads `result.specTriadMissing`
 *  and looks like a live consumer. It is not — that is `PromotePlanResult`
 *  (plan-workitem-promotion-run.ts:88), a DIFFERENT object that never travels
 *  this feed. Confirm the OWNING TYPE, not the field name, before restoring it. */
const ITEMS_ROW_DROP = [
  'coverage',
  'blockedByIssues',
  'archived',
  'coverageDivergence',
  'specTriadMissing',
] as const;

/**
 * Fields on the nested `item` that no plans:items UI consumer reads — the parse
 * internals the PlanItem UI type already omitted, plus the WI-7086 additions.
 *
 * The read-set is the UNION across ALL FOUR live consumers, taken from their
 * sort/filter/count paths and not just their JSX (the WI-7085 lesson):
 *   PlanItemsList.tsx    id, text, importance, effectiveStatus (through
 *                        `itemPillStatus(item: { effectiveStatus })`), lastEditedBy
 *   PlansClient.tsx      id  — only as the `${plan}::${item.id}` dedupe key
 *   use-create-data.ts   id  — same key, plus a `typeof item.id === 'string'` guard
 *   HydratedWorkRefPill  id, effectiveStatus, text
 * None of the four DESTRUCTURES `item`, so no default-valued binding can hide a
 * read from the greps above.
 *
 * `needsHuman` and `storedStatus` look load-bearing and are not: every live call
 * site filters SERVER-side (`usePlanItems({ needsHuman: true })`, `{ actionable:
 * true }`, `{ status: 'blocked' }`), so the client never re-derives a predicate
 * it already asked the server to apply. `effectiveStatus` — the one status the
 * pill actually renders — is deliberately NOT dropped.
 *
 * `staleBlockedHint` joins them under WI-5910. It is set by the plan-parser
 * (libs/generic/plan-parser/src/effective-status.ts) only on items resolved
 * `blocked`, so it is invisible on the `{actionable:true}` worst case and costs
 * 4,759 B — 6.8% — of the live `{status:'blocked'}` read, which PlansClient.tsx:379
 * and use-create-data.ts:337 both mount unconditionally.
 *
 * ⚠ FALSE-POSITIVE GREP: `lint.ts:566` reads `staleBlockedHint` and is the only
 * hit outside the parser. It is not a consumer of this feed — it reads the hint
 * off its OWN `resolveEffectiveStatusForItems` call, server-side, and never
 * touches the projected UI rows.
 */
const ITEM_DROP = [
  'rawLine',
  'unresolvedBlockers',
  'storedStatus',
  'needsHuman',
  'phase',
  'blockedBy',
  'decisionRefs',
  'lineNumber',
  'authority',
  'riskTier',
  'staleBlockedHint',
] as const;

/**
 * Preview cap for an attention item's `body` in the LIST feed. Larger than
 * UI_TEXT_PREVIEW_MAX has diminishing returns (p90 is 1282B, so most of the
 * saving is already taken at 280) and smaller starts costing inbox search
 * recall; the full body is one `plans.attentionItem` fetch away.
 */
export const UI_ATTENTION_BODY_PREVIEW_MAX = 280;

function clipPreview(v: unknown, n: number): unknown {
  if (typeof v !== 'string') return v;
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
}

function omit(
  obj: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(obj)) {
    if (!keys.includes(k)) out[k] = val;
  }
  return out;
}

/**
 * Drop the keys whose value is `null` — SHALLOW, one level only.
 *
 * A `"key":null` pair costs its key name + 6 bytes and carries no information a
 * consumer cannot get from the key's absence. On the attention feed that is
 * 154,971 B of a 1,062,144 B payload (14.6%), measured live 2026-08-02: the
 * per-item optional fields are null on most rows (triageNote/triagedBy/
 * triagedAt on 1114, ownerAgentId on 994, ownerLabel on 1081, authorizer +
 * whyGated on 832, harnessSlug on 796).
 *
 * WHY SHALLOW. It is applied to the item and group TOP LEVEL only, never
 * recursively into `ref` — that is a discriminated union whose members a
 * consumer may narrow structurally, and it is worth 750 B.
 *
 * WHY HERE AND NOT IN THE SERIALIZER (no-http-anywhere-2026-07-28 D-025). This
 * runs in the RESOLVER path, so the rows the delta protocol hashes are the rows
 * that go on the wire. Stripping in `serializeJsonResponse` instead would strip
 * AFTER `negotiateRowsDelta` computed the full-view checksum over the unstripped
 * rows (rest-query.ts:83 vs :124) — the client recomputes that checksum over
 * what it received (delta-client.ts:81) and force-fulls on mismatch, so every
 * delta-enabled query would refetch full on every poll, forever.
 *
 * ⚠ THE CONTRACT THIS CHANGES: an omitted key reads as `undefined`, not `null`.
 * Truthiness (`??`, `?.`, `!!`, a ternary), `== null`, and `typeof x ===
 * 'string'` are unaffected; `=== null`, `'k' in row`, `hasOwnProperty` and
 * destructuring-with-default are NOT. Audited across every consumer of this
 * feed's single entrypoint (`plans-api.ts` `useSyncResource('plans.attention')`)
 * before landing: zero sites in any of those four categories. Re-run that audit
 * before applying this to another query — and declare the affected fields `?: T`
 * rather than `T | null` in the client wire type, which turns a future `=== null`
 * into a TS2367 no-overlap error instead of a silent always-false.
 */
function omitNullValues(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(obj)) {
    if (val !== null) out[k] = val;
  }
  return out;
}

/**
 * The null-omission half of the attention projection, for the DETAIL read
 * (`plans.attentionItem`), which deliberately bypasses `projectPlansReadForUi`
 * via `uiProjection: false` so it can keep `actions` and the unclipped `body`.
 *
 * It still needs THIS, so the two reads agree on one wire contract: the client's
 * `AttentionItem` declares the affected fields `?: T` (not `T | null`), and a
 * detail read that shipped `triageNote: null` against that declaration would
 * make it a lie in the opposite direction from the one D-025 set out to fix.
 * The byte saving on one item is noise; the uniform contract is the point.
 */
export function omitNullsForAttentionDetail(item: unknown): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  return omitNullValues(item as Record<string, unknown>);
}

function projectItems(data: Record<string, unknown>): Record<string, unknown> {
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items)) return data;
  const rows = items.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const r = omit(row as Record<string, unknown>, ITEMS_ROW_DROP);
    const item = r.item;
    if (item && typeof item === 'object') {
      const it = omit(item as Record<string, unknown>, ITEM_DROP);
      if ('text' in it) it.text = clipPreview(it.text, UI_TEXT_PREVIEW_MAX);
      // The nested item carries the nulls on this feed, so the omit has to reach
      // INTO it — `item` is a plain projected bag here, not a discriminated
      // union, so the `ref` caveat in {@link omitNullValues} does not apply.
      r.item = omitNullValues(it);
    }
    return omitNullValues(r);
  });
  return { ...data, items: rows };
}

/**
 * Slim a plans:list row: clip `nextAction` to a tooltip preview and omit
 * null-valued keys (see {@link omitNullValues} — 15.2% of this payload).
 *
 * The clip runs BEFORE the omit so a `nextAction: null` is dropped rather than
 * left as a clipped null; `clipPreview` passes non-strings through, so the two
 * compose in either order for a real string.
 */
function projectList(data: Record<string, unknown>): Record<string, unknown> {
  const plans = (data as { plans?: unknown }).plans;
  if (!Array.isArray(plans)) return data;
  const rows = plans.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const r = { ...(row as Record<string, unknown>) };
    if ('nextAction' in r) r.nextAction = clipPreview(r.nextAction, UI_TEXT_PREVIEW_MAX);
    return omitNullValues(r);
  });
  return { ...data, plans: rows };
}

/**
 * Slim the attention feed to its LIST shape: retain the small action
 * descriptors needed at pane paint, clip `body` to a search/tooltip preview,
 * and omit null-valued keys (see
 * {@link omitNullValues} — 14.6% of this payload). A clipped item is stamped
 * `bodyTruncated: true` so a consumer can tell "short body" from "clipped body"
 * without re-measuring the string.
 */
function projectAttention(data: Record<string, unknown>): Record<string, unknown> {
  const groups = (data as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return data;
  const projected = groups.map((group) => {
    if (!group || typeof group !== 'object') return group;
    const g = group as Record<string, unknown>;
    if (!Array.isArray(g.items)) return omitNullValues(g);
    const items = g.items.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const it = omitNullValues(item as Record<string, unknown>);
      const body = it.body;
      if (typeof body === 'string' && body.length > UI_ATTENTION_BODY_PREVIEW_MAX) {
        it.body = clipPreview(body, UI_ATTENTION_BODY_PREVIEW_MAX);
        it.bodyTruncated = true;
      }
      return it;
    });
    // The group's own null keys (`planSlug` on the synthetic Alerts buckets,
    // `harnessSlug` on cross-harness groups) go too — `items` is re-set after,
    // so it survives the omit regardless.
    return { ...omitNullValues(g), items };
  });
  return { ...data, groups: projected };
}

/**
 * Project a plans:* READ payload down to the UI display shape. `list`, `items`
 * and `attention` are slimmed; every other verb (get/search/revisions/runs/
 * lint/…) passes through byte-identical. `byHive` reuses the `list` read, so it
 * inherits the list slim automatically at its call site.
 *
 * Pure + defensive: a non-object payload, a tool error envelope, or a shape that
 * lacks the expected array passes through unchanged.
 */
export function projectPlansReadForUi(verb: string, data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const d = data as Record<string, unknown>;
  if (verb === 'items') return projectItems(d);
  if (verb === 'list') return projectList(d);
  if (verb === 'attention') return projectAttention(d);
  return data;
}
