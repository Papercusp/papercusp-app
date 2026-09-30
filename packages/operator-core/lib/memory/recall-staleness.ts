/**
 * Memory anchor-staleness AT RECALL TIME — the hand-off the nightly sweep never had.
 *
 * `memory/anchors.ts` extracts each memory's concrete referents at write time (file,
 * feature, plan, migration, symbol) and `memory/audit-memory-anchors.ts` re-checks
 * that they still resolve every night — a registered DBOS scheduled workflow at
 * `0 0 5 * * *`, kill-switched and load-shed — writing the verdict per anchor to
 * `harness_shared.memory_anchors.last_check_ok`.
 *
 * Until now that verdict reached exactly ONE consumer: `list-user-memories.ts`, i.e.
 * the human settings UI. The agent doing the recalling never saw it. So `CLAUDE.md`
 * instructs every agent that a recalled memory "reflects what was true when written
 * — if one names a file, function, or flag, verify it still exists", pushing onto
 * per-agent discipline a question the system had already answered at 05:00 that
 * morning. Measured 2026-08-08: 4,142 anchors swept, 437 broken across 354 distinct
 * memories, and not one of those verdicts was reachable from `memory:search`.
 * (WI-36046, workstream A step 3.)
 *
 * Two structural decisions are DELIBERATELY taken from the docs corpus's read-time
 * staleness (`@papercusp/docs-engine`'s `okf.ts`, shipped the same day under
 * `okf-frontmatter-adoption-2026-08-08` P-005), so the fleet ends up with ONE
 * vocabulary for "this source may have rotted" instead of two that coincidentally
 * mean the same thing on different corpora:
 *
 *  1. **Notable-only emission.** `okfTrustIsNotable` exists so a corpus that is
 *     entirely fine spends zero payload saying so. Same here: the ABSENCE of
 *     `staleness` on a hit MEANS "no dead anchors", and both the tool guidance and
 *     `memoryStalenessIsNotable` below state it, so absence is never read as
 *     "unknown".
 *  2. **A banner on the BODY, not only a sibling field.** `okfTrustBanner`'s
 *     rationale carries verbatim — an agent reads the CONTENT, and a field it may
 *     not look at cannot deliver "this is stale" at read time. Here that is
 *     load-bearing rather than belt-and-braces: `coord:orient`'s memory fold reduces
 *     every hit to `{ id, memory, score }` (orient.ts:918-922), so a sibling field is
 *     DISCARDED before the most-called recall surface we have ever renders it. The
 *     banner is PREPENDED, which is also what makes it survive orient's subsequent
 *     `slice(0, MEMORY_TEXT_CAP)`.
 *
 * What deliberately does NOT transfer is OKF's trust LADDER (`unverified` /
 * `machine-verified` / `human-verified`). A memory has exactly one verifier — the
 * nightly sweep — so a tier field here would be a constant wearing a type, and a
 * vacuous field is worse than an absent one. The ladder's load-bearing half, "when
 * was this last checked", is kept as `lastCheckedAt` (OKF's `verified.at`).
 *
 * FAIL-OPEN THROUGHOUT, by contract. The sweep may not have run, the table may not
 * exist, PG may be down, the backend may return non-uuid ids. Every one of those
 * degrades to "no staleness known" and renders recall EXACTLY as it does today.
 * Recall is never blocked, never fails, and never waits on this.
 */

import type { Sql } from 'postgres';

/** One referent of a memory that no longer resolves, as the nightly sweep found it. */
export interface MemoryBrokenAnchor {
  /** `file` | `feature` | `plan` | `migration` | `symbol` (see `anchors.ts`). */
  kind: string;
  value: string;
}

/**
 * The read-time verdict for ONE memory.
 *
 * Only ever constructed for a memory with at least one dead anchor — see the
 * notable-only decision in the module header — so `stale` is a literal `true`
 * rather than a boolean anyone has to test.
 */
export interface MemoryStaleness {
  stale: true;
  brokenAnchors: MemoryBrokenAnchor[];
  /** When the sweep last checked this memory's anchors (OKF's `verified.at`). */
  lastCheckedAt?: string;
}

/**
 * Hard cap on anchor rows pulled for one recall.
 *
 * A recall is capped at 20 hits and a memory carries a handful of anchors, so this
 * is far above any real fan-out; it exists so a pathological memory (a fact that
 * name-drops a hundred files) can never turn a bounded recall into an unbounded
 * read. Hitting it degrades to PARTIAL staleness, which is fail-open in the right
 * direction: some banners rather than a stalled recall.
 */
export const STALENESS_ANCHOR_ROW_CAP = 500;

/**
 * Total character budget for the NAMED-ANCHOR LIST in the banner, shared out among
 * however many anchors get named.
 *
 * A total rather than a per-entry cap because the distribution is lopsided in
 * practice: measured against the live corpus, 4 of 5 stale memories have exactly ONE
 * dead anchor, and a fixed per-entry cap spends the single-anchor case's budget on a
 * second entry that does not exist. Sharing the budget gives the common case a value
 * long enough to be recognisable and still bounds the worst case.
 *
 * Sized so the WORST case — two maximal entries plus an overflow count — keeps the
 * whole banner under half of `MEMORY_TEXT_CAP`. That bound is enforced by a
 * calibration test rather than trusted: an earlier 44-char value cap produced a
 * 165-char banner, which against orient's 200-char per-hit clip would have left ~35
 * characters of the memory it was warning about. A warning that crowds out its own
 * subject is not an improvement on no warning.
 */
const BANNER_LIST_CHARS = 48;
/**
 * How many dead anchors to NAME before collapsing the rest to `+N`.
 *
 * Two, deliberately. Naming more buys little — the structured `staleness` field
 * carries the complete list for any caller that keeps it — and every extra name is
 * charged against the body inside orient's cap.
 */
const BANNER_NAMED_ANCHORS = 2;

/**
 * Does this verdict carry signal worth spending payload on?
 *
 * The mirror of `okfTrustIsNotable`, and it is why absence of `staleness` on a hit
 * is meaningful rather than ambiguous: a verdict with no dead anchors is never
 * emitted, so a missing field MEANS "the sweep found nothing wrong (or has not run)"
 * — never "we did not look".
 */
export function memoryStalenessIsNotable(s: MemoryStaleness | undefined): boolean {
  return s !== undefined && s.brokenAnchors.length > 0;
}

/**
 * The one-line banner prepended to a stale memory's text at recall time.
 *
 * Kept TIGHT on purpose. `coord:orient` clips each folded hit to `MEMORY_TEXT_CAP`
 * (200 chars), so every character here is a character of the memory the agent does
 * not get to read. The job is to strip the memory's binding force and name what
 * rotted — not to explain itself at length; the structured `staleness` field carries
 * the full anchor list for callers that keep it.
 */
export function memoryStaleBanner(s: MemoryStaleness): string {
  const picked = s.brokenAnchors.slice(0, BANNER_NAMED_ANCHORS);
  // Share the list budget out, charging the ", " between entries to the budget too.
  const perEntry = Math.floor((BANNER_LIST_CHARS - (picked.length - 1) * 2) / picked.length);
  const named = picked.map((a) => `${a.kind}:${ellipsizeMiddle(a.value, Math.max(4, perEntry - a.kind.length - 1))}`);
  const rest = s.brokenAnchors.length - named.length;
  const list = rest > 0 ? `${named.join(', ')} +${rest}` : named.join(', ');
  return `⚠ STALE — dead anchors: ${list}. Verify, don't rely. `;
}

/**
 * Truncate keeping BOTH ends — the banner's job is to say WHICH referent rotted, and
 * either end alone routinely fails to.
 *
 * Measured against the live corpus, which is what settled this: dropping the head
 * rendered `experiment-registry-invocation-api-2026-06-14` as `…on-api-2026-06-14`
 * (a plan slug identified by its least distinctive part, the date) and
 * `libs/zero-harness/src/schema.ts` as `…ess/src/schema.ts` (a basename dozens of
 * packages share). Dropping the tail is just as bad the other way — every anchor here
 * starts with the same handful of repo prefixes. Keeping both ends is the only form
 * that stays unambiguous across paths AND dated slugs.
 */
function ellipsizeMiddle(v: string, budget: number): string {
  if (v.length <= budget) return v;
  if (budget <= 4) return v.slice(0, budget);
  const tail = Math.floor((budget - 1) / 2);
  return `${v.slice(0, budget - 1 - tail)}…${v.slice(-tail)}`;
}

/**
 * Load the STORED anchor verdicts for a set of memory ids.
 *
 * Reads only. The check itself is never computed here — the audit does `fs.stat`
 * plus PG lookups per anchor, and `coord:orient` is the most-called surface we have.
 * The nightly sweep exists precisely so recall can read a cached verdict, and that
 * split is the design; see the module header.
 *
 * Ids are compared as text because entry ids are opaque backend strings, not
 * guaranteed uuids (the same reason `list-user-memories.ts` casts) — a non-uuid id
 * simply matches nothing instead of erroring the query.
 *
 * Returns an empty map on ANY failure. Never throws.
 */
export async function loadMemoryStaleness(
  sql: Sql,
  ids: string[],
): Promise<Map<string, MemoryStaleness>> {
  const out = new Map<string, MemoryStaleness>();
  if (ids.length === 0) return out;
  try {
    type Row = {
      memory_id: string;
      kind: string | null;
      value: string | null;
      last_checked_at: Date | string | null;
    };
    // Only BROKEN anchors are pulled: a healthy anchor contributes nothing to a
    // notable-only verdict, and filtering in SQL keeps the row count proportional
    // to the problem rather than to the corpus.
    const rows = (await sql`
      SELECT memory_id::text AS memory_id, kind, value, last_checked_at
      FROM harness_shared.memory_anchors
      WHERE memory_id::text = ANY(${ids})
        AND last_check_ok = false
      ORDER BY memory_id, kind, value
      LIMIT ${STALENESS_ANCHOR_ROW_CAP}`) as unknown as Row[];

    for (const r of rows) {
      const kind = typeof r.kind === 'string' && r.kind.trim() ? r.kind.trim() : 'anchor';
      const value = typeof r.value === 'string' ? r.value.trim() : '';
      if (!value) continue;
      const existing = out.get(r.memory_id);
      const at = isoOrUndefined(r.last_checked_at);
      if (existing) {
        existing.brokenAnchors.push({ kind, value });
        // Most recent check across the memory's anchors — the sweep may have
        // touched them in different passes.
        if (at && (!existing.lastCheckedAt || at > existing.lastCheckedAt)) existing.lastCheckedAt = at;
      } else {
        out.set(r.memory_id, {
          stale: true,
          brokenAnchors: [{ kind, value }],
          ...(at ? { lastCheckedAt: at } : {}),
        });
      }
    }
  } catch {
    /* fail-open by contract: sweep never ran, table absent, PG down → no verdicts */
  }
  return out;
}

/**
 * Normalize a PG timestamp to ISO.
 *
 * Same reason `list-user-memories.ts` does it: the driver hands back a
 * `'2026-06-09 16:08:51.83-04'` string that Node parses and the WebKit webview does
 * not, so nothing downstream should ever see the raw form.
 */
function isoOrUndefined(v: unknown): string | undefined {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v.toISOString();
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  }
  return undefined;
}

/** A recall row, as both the full-tier wire shape and the tier-shaped one satisfy. */
type StaleableRow = { id?: unknown; memory?: unknown } & Record<string, unknown>;

/**
 * The verdict as it appears ON THE WIRE — snake_case, matching every other field in
 * this tool's response contract (`memory_truncated`, `payload_tier`, `degraded_reason`).
 */
export interface MemoryStalenessWire {
  stale: true;
  broken_anchors: MemoryBrokenAnchor[];
  last_checked_at?: string;
}

/**
 * Attach the verdict to the rows a recall is about to return: the structured
 * `staleness` field AND the banner on the body.
 *
 * Applied AFTER tier shaping on purpose. `shapeMemoryHit` clips the body to the
 * session tier's budget (280 chars at `trimmed`), and a banner inside that budget
 * would be competing with the memory for the same characters — worse, at `trimmed`
 * a long banner could crowd the body out entirely. Adding it on top keeps the tier
 * caps meaning what they say (a cap on the MEMORY) and guarantees the warning is
 * never itself clipped away, which is the one part that must not be lossy.
 *
 * Pure and total: rows without a verdict are returned untouched and by identity.
 */
export function applyMemoryStaleness<T extends StaleableRow>(
  rows: T[],
  verdicts: Map<string, MemoryStaleness>,
): Array<T & { staleness?: MemoryStalenessWire }> {
  if (verdicts.size === 0) return rows;
  return rows.map((row) => {
    const id = typeof row.id === 'string' ? row.id : undefined;
    if (!id) return row;
    const s = verdicts.get(id);
    if (!memoryStalenessIsNotable(s) || !s) return row;
    return {
      ...row,
      ...(typeof row.memory === 'string' ? { memory: `${memoryStaleBanner(s)}${row.memory}` } : {}),
      staleness: {
        stale: true,
        broken_anchors: s.brokenAnchors,
        ...(s.lastCheckedAt ? { last_checked_at: s.lastCheckedAt } : {}),
      },
    };
  });
}
