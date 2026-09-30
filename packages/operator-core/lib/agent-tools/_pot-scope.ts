/**
 * Explicit POT-scope resolution for pot-scoped CREATE-side tools
 * (domain-generic-hive-architecture-2026-06-18 P-022/P-023/P-024).
 *
 * The sibling of `_harness-scope.ts`, one level up the scope hierarchy: where
 * `resolveHarnessScope` answers "which harness", this answers "which POT". Under
 * D-009 (pot ↔ harness 1:1: a pot IS its `kind:'hive'` home harness), a pot is
 * identified by its home-harness slug, and a MEMBER harness resolves to its pot's
 * home slug via `potHomeSlugForHarness` (the resolver collapses member → home, so
 * callers never enumerate members — Q1 ruling).
 *
 * The scope model is AUTO-RESOLVE-THEN-REQUIRE (P-024), deliberately gentler than
 * harness-scope's bare require, so live ops don't start 400-ing mid-flight:
 *   1. explicit `pot` arg                           → that pot
 *   2. no arg, resolve the acting session's harness → its home-pot slug
 *   3. neither resolves                             → `none` (the caller errors)
 * So a normally-scoped cup/su (concrete `ctx.harnessSlug`) AUTO-RESOLVES to its
 * pot with no arg; only a genuinely pot-less create-op (e.g. a Mug/overwatch at
 * bare operator scope with no resolvable home) must pass an explicit `pot` or errors.
 * Reads stay workspace-wide (Mug/overwatch survey across pots — Q2 ruling); only
 * CREATE-side ops gate on this.
 *
 * `resolvePotScope` is ASYNC (unlike the pure `resolveHarnessScope`) because the
 * member→home collapse is a PG read; the resolver is INJECTED so tools unit-test
 * with a fake (no PG) — the gym:judge / DI pattern used across lib/. Returning (no
 * throw) so each tool maps `none` onto its own error shape.
 *
 * NOTE — `harness_kind:'hive'` and the `hive_slug` registry field are the
 * PERSISTED substrate this resolver reads; they are a separate, wider rename
 * slice (packages/operator-core/lib/harness-registry.ts + siblings, not under
 * agent-tools/) and are deliberately left unrenamed here (cup-lexicon-full-
 * rename-2026-07-09 D-005).
 */

import { z } from 'zod';
import { isAllHarnessSentinel } from './_harness-scope';
import { potHomeSlugForHarness } from '../hive-federation';

/**
 * Reusable optional `pot` arg for pot-scoped create-side tools. Omitting it is
 * the COMMON case (auto-resolved from the session's harness); a workspace-spanning
 * caller (Mug/overwatch) with no resolvable home passes it explicitly.
 */
export const potArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Pot to scope this to (the pot home-harness slug). Omit in a harness-scoped ' +
      'session — it auto-resolves from your harness (a member harness resolves to its ' +
      "pot's home). A workspace-spanning caller (Mug/overwatch) that can't auto-resolve " +
      'must pass an explicit pot.',
  );

export type PotScope = { kind: 'pot'; slug: string } | { kind: 'none' };

/** Resolver signature (injectable for tests): harness slug → its pot home slug, or null. */
export type PotHomeResolver = (workspaceId: string, harnessSlug: string) => Promise<string | null>;

/**
 * Resolve pot scope (auto-resolve-then-require, P-024). Precedence:
 *   1. explicit non-sentinel `pot` arg           → `{ kind: 'pot', slug }`
 *   2. no arg, concrete `ctx.harnessSlug` + ws    → resolve home-pot; `{ pot }` if found
 *   3. otherwise                                  → `{ kind: 'none' }`
 *
 * An `all`/`'*'` sentinel in the arg is NOT a pot (pots are concrete) — it falls
 * through to auto-resolve from the harness, then `none`. Injected `resolveHomeSlug`
 * defaults to the production `potHomeSlugForHarness`.
 */
export async function resolvePotScope(
  argPot: string | null | undefined,
  ctx: { workspaceId?: string | null; harnessSlug?: string | null } | null | undefined,
  resolveHomeSlug: PotHomeResolver = potHomeSlugForHarness,
): Promise<PotScope> {
  const arg = argPot?.trim();
  if (arg && !isAllHarnessSentinel(arg)) return { kind: 'pot', slug: arg };

  const harness = ctx?.harnessSlug?.trim();
  const ws = ctx?.workspaceId?.trim();
  if (harness && !isAllHarnessSentinel(harness) && ws) {
    try {
      const home = await resolveHomeSlug(ws, harness);
      if (home) return { kind: 'pot', slug: home };
    } catch {
      /* resolver miss → fall through to none (the caller errors) */
    }
  }
  return { kind: 'none' };
}

/** Shared detail string for the `hive_required` error a gated create-op returns.
 *  (The error CODE stays `hive_required` — a repo-wide error-code contract shared
 *  by resource/delegate.ts, pot/get.ts, pot/update.ts, pot/dissolve.ts and others
 *  outside this slice's scope; only the message wording + this constant's own
 *  binding name are pot-lexicon here.) */
export const POT_REQUIRED_DETAIL =
  'No pot resolvable for this create-side op. Every artifact (work item, plan, ' +
  'assignment, observation) belongs to a POT. A harness-scoped session auto-resolves ' +
  'its pot; a workspace-spanning caller (e.g. overwatch) must pass an explicit ' +
  '`pot` (the pot home-harness slug) on this call.';
