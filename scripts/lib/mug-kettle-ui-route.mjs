/**
 * OFFERS A ROUTE INTO THE TIER, vs MERELY NAMES IT — the classification D7 of
 * `scripts/mug-kettle-surface-census.mjs` could not make, extracted here so it can be
 * falsified on fixtures instead of on the shared tree.
 *
 * WHY IT IS A MODULE AND NOT TEN MORE LINES IN THE CENSUS. Proving a guard can FAIL is
 * the only thing that distinguishes it from a guard that has merely never fired, and the
 * census offers no seam for that: it is a top-level script that scans ~7,200 real files
 * (33s quiet, ~58s under load — EI-20068047132832988), so the only way to make it see a
 * new mount is to WRITE ONE INTO THE TREE. That is the mutation-probe trap this repo has
 * already paid for: git-sync sweeps every few minutes and an exclusive lock does not
 * pause it, so a probe file can be committed while nothing goes wrong at all
 * (EI-19450431506682666). A pure function takes a string, so the fixture never exists on
 * disk.
 *
 * THE PROPERTY, stated so it survives a rename rather than keying on today's spellings —
 * the same discipline `check-ungated-mug-kettle.mjs` states for its role-door family:
 * the retirement gates what can OFFER A ROUTE INTO the retired tier. An equality test
 * against a role token READS a value the roster already returned; it cannot bring a pane
 * into being, and refusing to render it would hide what a live pane IS rather than
 * withhold a capability. A tab IDENTITY — an id/key/value that a router or tab strip can
 * select — can. So membership keys on the token's POSITION, never on its presence.
 */

/**
 * A quoted tier token in a position that DECLARES a selectable surface.
 *
 * The two alternatives are the two shapes an id reaches a router in: a keyed field
 * (`id: 'queen'`, `value="cup"`) or a bare element/argument (`['mug', …]`,
 * `setTab('cup')`). Both are conservative — an ordinary call argument matches, and
 * over-flagging is the safe direction for a guard.
 *
 * ⚠ IT MUST NOT MATCH `=== 'cup'`, which is the entire point. `[:=]` is ONE character
 * followed by `\s*["'`]`, so `kind === 'cup'` fails at the second `=` and no other start
 * position matches. Case-sensitive on purpose: `/i` would let `agentPaneKind` satisfy the
 * `kind` alternative through its own suffix, re-admitting the badge shape by the back
 * door. (`\b` already prevents that for the lowercase spelling — the belt is the case.)
 */
export const TIER_TAB_DECL_RE =
  /(?:\b(?:id|key|tab|tabId|value|kind|name|slug|pane|view|route|to|href)\s*[:=]\s*|[[,(]\s*)["'`](mug|kettle|cup|queen|pot-health|potHealth)["'`]/;

/** Any JSX element; the tier ruling is applied to the NAME by the caller's `namesTier`. */
export const TIER_JSX_RE = /<\s*([A-Z][A-Za-z0-9_]*)/g;

/**
 * Does this source OFFER a route into the retiring tier? Returns HOW, or null when the
 * file only names the tier (a read-only badge, a stat label).
 *
 * The JSX half is a recall GAIN, not a trade for the precision above: a file that renders
 * `<MugTab/>` mounts the tier whether or not a quoted token sits nearby. `LeftSidebar` is
 * caught today only by the `id: 'queen'` literal beside its `<MugTab/>` — had that id been
 * a constant, the mount itself was invisible to a token scan. It also closes the one hole
 * the position rule opens: `{tab === 'cup' ? <CupPane/> : null}` is all-comparison, so the
 * declaration half skips it, and the element half catches it anyway.
 *
 * @param {string} src  source with COMMENTS ALREADY MASKED (`stripCommentsOnly`). Passing
 *        raw source re-admits the comment-resident false positives that red-pinned the
 *        fleet gate once already (WI-37661) — a doc comment explaining a removed kettle
 *        glyph reads as a mount.
 * @param {(name: string) => string | null} namesTier  the census's own tier ruling,
 *        INJECTED rather than re-implemented. It carries the homonym and name-exclusion
 *        rulings (`AnimatedPapercuspCup` is brand art, `papercup` is the Sentinel role),
 *        and a second copy of those here is precisely the drift this repo has already
 *        filed four times over (EI-20091339613996367). A caller that cannot supply it
 *        does not have the ruling and should not be classifying.
 * @returns {string | null}
 */
export function offersTierRoute(src, namesTier) {
  const decl = TIER_TAB_DECL_RE.exec(src);
  if (decl) return `declares tab identity (${decl[0].replace(/\s+/g, ' ').trim().slice(0, 40)})`;
  // Fresh lastIndex per call: TIER_JSX_RE is module-scoped and /g, so a shared exec state
  // would make the SECOND call on the same input skip matches the first consumed.
  TIER_JSX_RE.lastIndex = 0;
  for (const m of src.matchAll(TIER_JSX_RE)) {
    if (namesTier(m[1])) return `mounts <${m[1]}>`;
  }
  return null;
}
