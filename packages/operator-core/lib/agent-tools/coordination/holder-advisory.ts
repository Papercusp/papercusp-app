/**
 * holder-advisory.ts — P-027 / D-055 Tier A: the ONE way a CONTENTION POINT
 * attaches a holder's `HolderContext` to a refusal (or a queue position) it is
 * about to return.
 *
 * Plan: unified-agent-state-plane-2026-07-27, P-027 (items A2–A5; A1 — the
 * file-lock block message — shipped as P-012 in `locks/enrich-busy.ts`).
 * Rulings: D-055 (which surfaces, and which are refused), D-038 axis 5 / D-042
 * (consume P-026, never re-derive), D-056 (unreadable ⇒ ABSENT, never a distinct
 * error), D-094 (a HOLDER-level fact must never name the SUBJECT it renders on),
 * P-026 rule (f) (total — an enrichment never fails what it decorates).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ WHY THIS EXISTS AS A MODULE RATHER THAN SIX CALL SITES.
 *
 * P-027 renders the SAME projection at four more subjects than P-030 did — a
 * work-item claim refusal, a release request/decline, a lock-queue entry, and a
 * plan-item claim conflict — across six tool files in five directories. Each
 * needs the identical four steps: resolve a reader (fail CLOSED), resolve the
 * holder's context, subtract the subject (D-094), and swallow every error. Six
 * copies of that is the second-derivation trap D-038 axis 5 forbids: they agree
 * on the day they are written and drift afterwards, each looking correct alone.
 *
 * ⚠ IT LIVES IN `agent-tools/coordination/`, NOT IN `coord/`, AND THAT IS
 * DELIBERATE. `coord/holder-context.ts` is PURE — it takes its IO injected via
 * `HolderContextSources` precisely so the projection can be tested and reused
 * without a store. This module is the WIRING layer that binds that pure
 * projection to the real sources, so it belongs beside
 * `holder-context-sources.ts`. Putting it in `coord/` would make the pure module
 * import `agent-tools/`, inverting the layering the split exists to maintain.
 *
 * ⚠ EVERY INJECTION IS ADVISORY. Nothing here may change a refusal into a grant
 * or a grant into a refusal — these paths already own their semantics and this
 * only EXPLAINS them. That is P-027's acceptance criterion, and
 * `holder-advisory.test.ts` asserts it by running each call site's verdict with
 * the advisory resolving, throwing, and absent, and requiring the verdict to be
 * byte-identical in all three.
 */
import { z } from 'zod';
import {
  resolveHolderContext,
  forSubject,
  type HolderContext,
  type HolderContextSources,
} from '../../coord/holder-context';
import { holderContextSources } from './holder-context-sources';
import { resolveAgentIdentity } from './identity';
import { cellReaderFromCtx, type CellReaderCtxLike } from '../cell-reader-ctx';
import type { CellReader } from '../../cell-registry';

/**
 * The WIRE schema for the shared projection — declared ONCE, here, and imported
 * by every tool that returns a holder.
 *
 * ⚠ IT IS A SECOND PLACE THE SHAPE IS WRITTEN DOWN, AND THAT IS EXACTLY THE RISK.
 * A tool's zod `result` STRIPS undeclared keys (`work_items:list` already carries
 * a comment about a field silently blanked that way), so a schema that drifts
 * behind `HolderContext` does not fail — it quietly deletes the new field from
 * every response. D-093 adding `agreement`/`competing` is precisely such a
 * moment. `_holder-lens.test.ts` therefore asserts this key set EQUALS the
 * projection's, so the two cannot diverge; that assertion is what makes one
 * schema module safer than a literal inlined at each tool.
 *
 * ⚠ IT MOVED HERE FROM `work_items/_holder-lens.ts` (P-027). It was never
 * work-item-specific — it is the wire form of `HolderContext` — and leaving it
 * under `work_items/` would have forced `locks:queue` and `plan_items:claim` to
 * import from a private, underscore-prefixed work-item module to describe their
 * own results. One schema, one home, six importers.
 */
export const HOLDER_CONTEXT_SCHEMA = z.object({
  goalRef: z.string().nullable(),
  goalText: z.string().nullable(),
  assumptions: z.object({ count: z.number(), keys: z.array(z.string()) }),
  declaredAt: z.string().nullable(),
  stale: z.boolean().nullable(),
  agreement: z.string().nullable(),
  competing: z.array(z.string()),
});

/**
 * Ceiling on DISTINCT holders resolved for one call.
 *
 * Shared with the work-item lens for the reason the cap exists at all: it must
 * degrade by DISCLOSING LESS rather than by turning one read into an unbounded
 * per-holder fan-out. Measured live 2026-07-27: 18 held rows across 17 distinct
 * holders fleet-wide, so this cannot bite today — it is headroom for a fleet an
 * order of magnitude larger.
 */
export const HOLDER_ADVISORY_DISTINCT_CAP = 40;

/**
 * Resolve the {@link CellReader} for a holder-advisory call, or `null`.
 *
 * ⚠⚠ IT MUST NEVER THROW, AND THE FIRST VERSION OF THIS DID — caught by the
 * existing `work_items:get` suite, which is the only reason it is a helper.
 * `resolveAgentIdentity` THROWS for a caller it cannot attribute, and several
 * tools that use it declare `requirePrincipal: false` — i.e. an unattributed
 * caller is explicitly legitimate for them. Calling it unguarded turns "we cannot
 * name you, so you get no reader-relative state" (correct, and a no-op for the
 * read) into "your claim refusal fails" — an enrichment failing the operation it
 * decorates, which is the ONE thing P-026 rule (f) forbids.
 *
 * A null reader FAILS CLOSED downstream: `resolveHolderContext` refuses an
 * unidentified reader, so an unattributable caller simply sees no advisory.
 *
 * ⚠ RENAMED FROM `holderLensReader` (P-027). It was never lens-specific, and six
 * new call sites that are not lenses now depend on it; an alias kept beside the
 * new name would be exactly the deprecation shim this repo's conventions forbid.
 */
export function holderContextReader(ctx: CellReaderCtxLike): CellReader | null {
  try {
    return cellReaderFromCtx(
      resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]),
      ctx,
    ).reader;
  } catch {
    return null;
  }
}

/** What every friction-point injection passes. */
export interface HolderAdvisoryOpts {
  /** Owner id of the agent the reader is blocked BY. */
  holder: string | null | undefined;
  /** The BLOCKED caller's reader. Absent ⇒ no advisory (fails closed). */
  reader: CellReader | null | undefined;
  /**
   * The thing the reader is blocked ON — the item id, plan-item ref or lock path.
   *
   * ⚠ D-094: this is SUBTRACTED from `competing`, because a holder-level fact
   * rendered against a subject must never name that subject as its own rival.
   * Measured on 3 of 18 live rows — every multi-item holder — when P-030 shipped
   * this projection without the subtraction. Omit it only when the subject is not
   * an item ref at all (a lock path can never appear in `competing`).
   */
  subjectRef?: string | null;
  nowMs?: number;
  /** INJECTED for tests; defaults to the real stores. */
  sources?: HolderContextSources;
}

/**
 * Resolve ONE holder's advisory context for ONE subject.
 *
 * TOTAL (P-026 rule f): never throws and never rejects. A dead facts store, an
 * unreachable PG, an unregistered cell or an unidentifiable reader all cost the
 * advisory and NOTHING ELSE — the refusal this decorates is returned unchanged.
 *
 * Returns `null` when there is nothing disclosable to THIS reader, which is
 * byte-identical to "this holder declared no goal" (D-056: a refusal that LOOKS
 * different from an absence is a probe oracle for state the reader may not read).
 */
export async function resolveHolderAdvisory(
  opts: HolderAdvisoryOpts,
): Promise<HolderContext | null> {
  const holder = (opts.holder ?? '').trim();
  if (!holder || !opts.reader) return null;
  try {
    const ctx = await resolveHolderContext(
      holder,
      opts.reader,
      opts.sources ?? holderContextSources(),
      { nowMs: opts.nowMs },
    );
    return ctx ? forSubject(ctx, opts.subjectRef) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve MANY holders at once — one resolution per DISTINCT holder, capped.
 *
 * For the surfaces that render a LIST of contended rows (`locks:queue`'s active
 * locks + waiters, `scheduler:get_next`'s held-by `excludedBreakdown` rows),
 * where the same agent routinely holds several of the rows on screen.
 *
 * ⚠ THE SUBJECT IS SUBTRACTED PER ROW, NOT PER HOLDER — which is why this
 * returns a `forRow` re-projection rather than a finished map of contexts. One
 * holder's context lands on several rows of the SAME list, and D-094's defect is
 * only visible when it does: the holder-level `competing` list is correct, and
 * naming row B on row B is what makes it wrong. Resolve once, project per row.
 */
export async function resolveHolderAdvisoryMap(
  holders: readonly (string | null | undefined)[],
  reader: CellReader | null | undefined,
  opts: { nowMs?: number; sources?: HolderContextSources; distinctCap?: number } = {},
): Promise<{
  /** Re-project the resolved holder context onto one row's subject (D-094). */
  forRow: (holder: string | null | undefined, subjectRef?: string | null) => HolderContext | null;
  /** Distinct holders the cap prevented us from even attempting. */
  omitted: ReadonlySet<string>;
}> {
  const cap = opts.distinctCap ?? HOLDER_ADVISORY_DISTINCT_CAP;
  const distinct = [...new Set(holders.map((h) => (h ?? '').trim()).filter(Boolean))];
  const attempted = distinct.slice(0, cap);
  const omitted = new Set(distinct.slice(cap));
  const byHolder = new Map<string, HolderContext | null>();

  if (reader) {
    const sources = opts.sources ?? holderContextSources();
    await Promise.all(
      attempted.map(async (h) => {
        // `resolveHolderAdvisory` is total, but the subject is deliberately NOT
        // passed here: the subtraction is per-ROW and happens in `forRow` below.
        byHolder.set(h, await resolveHolderAdvisory({ holder: h, reader, sources, nowMs: opts.nowMs }));
      }),
    );
  }

  return {
    forRow: (holder, subjectRef) => {
      const ctx = byHolder.get((holder ?? '').trim()) ?? null;
      return ctx ? forSubject(ctx, subjectRef) : null;
    },
    omitted,
  };
}

export type { HolderContext };
