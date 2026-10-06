/**
 * Claim-time recall port (memory-delivery-unification-2026-07-12 P-008,
 * decision D-006): a work-item CLAIM is the moment the session's intent gets
 * maximally specific — so every claim verb (work_items:claim / claim_next /
 * pickup, scheduler:get_next, the plans:set-status→wip auto-claim,
 * coord:orient's planItems lane) piggybacks a targeted memory recall on its
 * response instead of making the agent pay a separate memory:search
 * round-trip it in practice never makes.
 *
 * One shared service, per D-006 — the ports differ only in query
 * construction + budget:
 *   - WHAT: one query per claimed item — `title — <summary head>` (the
 *     resolver's plan rung; D-005's no-mega-query rule), plus the parent
 *     plan's ## Now when a spare slot remains.
 *   - WHERE: the claimed items' dominant harness dims (hive-pool resolution
 *     stays inside injection.ts).
 *   - Admission: the ONE pipeline (floors · muted packs · tombstones ·
 *     session-epoch dedup · budget) via buildLaunchMemoryBlock; stamps the
 *     SHARED port-agnostic epoch ledger (port 'claim'), so an orient-then-
 *     claim sequence never double-injects the same memory.
 *   - Budget: ~3.5k chars — a claim response is not a brief.
 *
 * Never-throws + deadline-bounded (default 2s, env-tunable): a recall outage
 * or slow embed must never fail — or materially delay — a claim.
 *
 * Never-throws is NOT never-tells (WI-10004121): every null carries a typed
 * reason (`buildClaimRecallResult`), per-reason counts are readable in-process
 * (`readClaimRecallOutcomeStats`), and a deadline or error emits a throttled
 * warn. Before this, a deadline expiry and a thrown import were
 * indistinguishable from "no memory matched" in every artifact.
 */
import { pinModuleState } from '@papercusp/module-singleton';
import { resolveLaunchProfile, buildLaunchMemoryBlock } from './launch-profile';
import { dominantHarness } from './compact-reprime';
import { activeWorkspaceId } from '../workspace-registry';
import { getSessionUserOrDefault } from '../auth';

export interface ClaimRecallItem {
  id?: string | null;
  title?: string | null;
  /** Body head (the work-item summary) — folded into the query after the title. */
  summary?: string | null;
  harness?: string | null;
}

export interface ClaimRecallInput {
  /** Warm-session epoch-dedup identity (the claimer's ownerId). Optional —
   *  recall still runs without it, just un-stamped (no dedup ledger). */
  sessionId?: string | null;
  /**
   * The claimer's personal-scope memory identity (EI-18893248175645463 /
   * WI-6933 follow-up).
   *
   * ⚠ WI-6933: this is NOT the same identity as `sessionId`. `sessionId` is
   * the per-AGENT coord ownerId (`su-xxxx…`) used for epoch-dedup; every
   * `memory:remember` write and every OTHER buildLaunchMemoryBlock caller
   * (compact-reprime, turn-start) scopes the 'user' pool by the CANONICAL
   * `harness_shared.users.id` from `getSessionUserOrDefault()` (a single
   * shared row — 'default' on a single-user install) — a completely
   * different identity space. The original EI-18893248175645463 fix defaulted
   * this field to `sessionId` on the mistaken belief that "every existing
   * call site already passes [ownerId] as sessionId" was the SAME identity
   * turn-start/compact-reprime use — it isn't, so that fix threaded a
   * non-empty but PERMANENTLY WRONG scope: measured 2026-08-02 at 1161/1161
   * (100%) zero-hit on claim/create recalls asked WITH a real (non-empty)
   * scope, post-fix, because the scope key (an agent's own ownerId) never
   * matches any memory's actual stored scope (the canonical users.id).
   *
   * If left unset, this now resolves the canonical id via
   * `getSessionUserOrDefault()` — the SAME source turn-start/compact-reprime
   * already use — rather than falling back to `sessionId`. Pass explicitly
   * only when the caller has already resolved a DIFFERENT canonical user id
   * it wants queried instead. */
  userId?: string | null;
  workspaceId?: string | null;
  items: readonly ClaimRecallItem[];
  /** The parent plan's ## Now line (plan-bound claims) — fills a spare query slot. */
  planNow?: string | null;
  /** Epoch-ledger port stamp (default 'claim'; the create port passes 'create'). */
  port?: string;
  deadlineMs?: number;
  heading?: string;
}

export const CLAIM_RECALL_HEADING =
  'Claim recall (fuzzy memory — may be stale; verify before relying on it)';

/**
 * Transport-safe total budget for a claim-time recall block.  The result door
 * caps tool replies at roughly 1,500 tokens, and a claim may also carry its
 * compact work-item echo plus concurrency/prior-work warnings.  Keeping the
 * entire recall block to 1,200 characters preserves useful context without
 * allowing the advisory to make a one-item write reply unparsable.
 */
export const CLAIM_RECALL_BUDGET_CHARS = 1200;

/** Max summary-head chars folded into each per-item query (the query is a
 *  STATEMENT, not a document — launch-profile clamps to 300 total anyway). */
const SUMMARY_HEAD_CHARS = 200;

const DEFAULT_DEADLINE_MS = (() => {
  const raw = Number(process.env.PAPERCUSP_CLAIM_RECALL_DEADLINE_MS ?? '');
  return Number.isFinite(raw) && raw >= 0 ? raw : 2000;
})();

/** `title — <summary head>` (id fallback for a blank title). */
export function claimRecallQueryOf(it: ClaimRecallItem): string {
  const title = (it.title ?? '').trim() || (it.id ?? '').trim();
  if (!title) return '';
  const head = (it.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, SUMMARY_HEAD_CHARS);
  return head ? `${title} — ${head}` : title;
}

/** Keep the merged recall block within the claim response budget.  The
 * underlying launch-profile builder applies its budget per query, so a
 * multi-item claim could otherwise merge several full query budgets into one
 * reply.  Prefer complete memory lines; clip only the first oversized line so
 * a useful hint survives even when the provider returns one long entry. */
function boundClaimRecallBlock(block: string | null): string | null {
  if (!block || block.length <= CLAIM_RECALL_BUDGET_CHARS) return block;

  const lines = block.split('\n');
  const heading = lines.find((line) => line.startsWith('## ')) ?? '## Claim recall';
  let remaining = CLAIM_RECALL_BUDGET_CHARS - heading.length - 2;
  if (remaining <= 1) return heading.slice(0, CLAIM_RECALL_BUDGET_CHARS);

  const kept: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('- ')) continue;
    const separator = kept.length > 0 ? 1 : 0;
    if (line.length + separator <= remaining) {
      kept.push(line);
      remaining -= line.length + separator;
      continue;
    }
    if (kept.length === 0) {
      kept.push(`${line.slice(0, Math.max(1, remaining - 1))}…`);
    }
    break;
  }

  return kept.length > 0 ? `${heading}\n\n${kept.join('\n')}` : null;
}

/** Local deadline race (same posture as _mcp-handler's raceDeadline — kept
 *  local so memory/* never depends on the transport layer). 0 = unbounded. */
async function withDeadline<T>(deadlineMs: number, run: () => Promise<T>, onTimeout: () => T): Promise<T> {
  const p = run();
  if (!(deadlineMs > 0)) return p;
  p.catch(() => {}); // the orphaned branch must never surface as unhandledRejection
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), deadlineMs);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * WI-6933: resolve the canonical personal-scope memory identity when the
 * caller didn't pass one explicitly — the SAME source turn-start /
 * compact-reprime already use (`getSessionUserOrDefault().id`), never the
 * caller's `sessionId` (a different identity space — see the `userId` field
 * doc on `ClaimRecallInput`). Fails soft to `null` (scope simply omitted, the
 * pre-EI-18893248175645463 posture) — a lookup failure must never fail or
 * materially delay a claim any more than a recall failure does. */
async function resolveMemoryUserId(explicit: string | null | undefined): Promise<string | null> {
  if (explicit) return explicit;
  try {
    const user = await getSessionUserOrDefault();
    return user?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Why a claim-time recall produced (or did not produce) a block.
 *   - `ok`         — a block was returned.
 *   - `no-queries` — no claimed item had a title/id to query with.
 *   - `no-hits`    — the admission pipeline ran to completion and returned no
 *                    block (nothing past the floors, or its own fail-soft).
 *   - `deadline`   — the recall did not settle within `deadlineMs`.
 *   - `error`      — the recall chain threw (`errorClass` / `errorMessage`).
 */
export type ClaimRecallReason = 'ok' | 'no-queries' | 'no-hits' | 'deadline' | 'error';

export const CLAIM_RECALL_REASONS: readonly ClaimRecallReason[] = [
  'ok',
  'no-queries',
  'no-hits',
  'deadline',
  'error',
];

export interface ClaimRecallOutcome {
  reason: ClaimRecallReason;
  /** Wall time spent in the recall, including a deadline wait. */
  elapsedMs: number;
  /** The deadline in force for this call (0 = unbounded). */
  deadlineMs: number;
  port: string;
  errorClass?: string;
  errorMessage?: string;
}

export interface ClaimRecallResult {
  block: string | null;
  outcome: ClaimRecallOutcome;
}

export interface ClaimRecallOutcomeStats {
  counts: Record<ClaimRecallReason, number>;
  /** The most recent `deadline` or `error` outcome, with when it happened. */
  lastFailure: (ClaimRecallOutcome & { at: string }) | null;
}

const OUTCOME_WARN_WINDOW_MS = 5 * 60_000;
const ERROR_MESSAGE_MAX_CHARS = 300;

const outcomeState = pinModuleState('@papercusp/operator-core.claim-recall-outcomes', () => ({
  counts: Object.fromEntries(CLAIM_RECALL_REASONS.map((r) => [r, 0])) as Record<ClaimRecallReason, number>,
  lastFailure: null as (ClaimRecallOutcome & { at: string }) | null,
  warnedAt: 0,
  sinceWarn: 0,
  warnOptedInByTest: false,
}));

/** In-process per-reason counts since boot (or the last test reset). */
export function readClaimRecallOutcomeStats(): ClaimRecallOutcomeStats {
  return {
    counts: { ...outcomeState.counts },
    lastFailure: outcomeState.lastFailure ? { ...outcomeState.lastFailure } : null,
  };
}

/**
 * Test hook: zero the counters and the warn throttle. Passing
 * `{ optInToWarn: true }` makes the warn fire under the test runner (it is
 * silent there by default for the same reason as injection.ts's corpus warn:
 * `vitest-fail-on-console` turns a stray warn into a failure in every suite
 * that transitively claims a work-item).
 */
export function _resetClaimRecallOutcomeStatsForTests(opts: { optInToWarn?: boolean } = {}): void {
  for (const r of CLAIM_RECALL_REASONS) outcomeState.counts[r] = 0;
  outcomeState.lastFailure = null;
  outcomeState.warnedAt = 0;
  outcomeState.sinceWarn = 0;
  outcomeState.warnOptedInByTest = opts.optInToWarn === true;
}

const warnSuppressedByTestRunner = (): boolean =>
  Boolean(process.env.VITEST || process.env.NODE_ENV === 'test') && !outcomeState.warnOptedInByTest;

function noteOutcome(outcome: ClaimRecallOutcome): void {
  outcomeState.counts[outcome.reason] += 1;
  if (outcome.reason !== 'deadline' && outcome.reason !== 'error') return;
  outcomeState.lastFailure = { ...outcome, at: new Date().toISOString() };
  if (warnSuppressedByTestRunner()) return;
  outcomeState.sinceWarn += 1;
  const now = Date.now();
  if (now - outcomeState.warnedAt < OUTCOME_WARN_WINDOW_MS) return;
  const alsoSuppressed = outcomeState.sinceWarn - 1;
  const detail =
    outcome.reason === 'deadline'
      ? `deadlineMs=${outcome.deadlineMs}`
      : `class=${outcome.errorClass ?? 'unknown'} message=${JSON.stringify(outcome.errorMessage ?? '')}`;
  console.warn(
    `[claim-recall] recall returned no block: reason=${outcome.reason} port=${outcome.port} ` +
      `elapsedMs=${outcome.elapsedMs} ${detail}` +
      (alsoSuppressed > 0 ? ` — +${alsoSuppressed} more deadline/error nulls since last warn` : '') +
      `; re-warns at most once/${OUTCOME_WARN_WINDOW_MS / 60_000}min`,
  );
  outcomeState.warnedAt = now;
  outcomeState.sinceWarn = 0;
}

const TIMED_OUT = Symbol('claim-recall-timed-out');

/**
 * Build the claim-time recall block for just-claimed item(s), with the typed
 * reason it is (or is not) there. Never throws.
 */
export async function buildClaimRecallResult(input: ClaimRecallInput): Promise<ClaimRecallResult> {
  const started = Date.now();
  const deadlineMs = input.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const port = input.port ?? 'claim';
  const finish = (
    block: string | null,
    reason: ClaimRecallReason,
    extra: Pick<ClaimRecallOutcome, 'errorClass' | 'errorMessage'> = {},
  ): ClaimRecallResult => {
    const outcome: ClaimRecallOutcome = { reason, elapsedMs: Date.now() - started, deadlineMs, port, ...extra };
    noteOutcome(outcome);
    return { block, outcome };
  };
  try {
    const queries = input.items.map(claimRecallQueryOf).filter((q) => q.length > 0);
    if (queries.length === 0) return finish(null, 'no-queries');
    const workspaceId = input.workspaceId?.trim() || activeWorkspaceId();
    const profile = resolveLaunchProfile({
      harnessSlug: dominantHarness(
        input.items.map((it) => ({ harness: it.harness ?? null })),
      ),
      claimedItemTitles: queries,
      planNow: input.planNow ?? null,
    });
    const raw = await withDeadline<string | null | typeof TIMED_OUT>(
      deadlineMs,
      async () =>
        buildLaunchMemoryBlock({
          profile,
          workspaceId,
          userId: await resolveMemoryUserId(input.userId),
          budgetChars: CLAIM_RECALL_BUDGET_CHARS,
          limit: 4,
          ...(input.sessionId ? { session: { sessionId: input.sessionId, port } } : {}),
          heading: input.heading ?? CLAIM_RECALL_HEADING,
        }),
      () => TIMED_OUT,
    );
    if (raw === TIMED_OUT) return finish(null, 'deadline');
    const block = boundClaimRecallBlock(raw);
    return finish(block, block ? 'ok' : 'no-hits');
  } catch (err) {
    // never-throws: recall must never fail a claim — but it must say why.
    return finish(null, 'error', {
      errorClass: err instanceof Error ? err.constructor.name : typeof err,
      errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, ERROR_MESSAGE_MAX_CHARS),
    });
  }
}

/**
 * Build the claim-time recall block for just-claimed item(s). Returns null on
 * no material, no hits past the admission floors, timeout, or ANY failure —
 * `buildClaimRecallResult` carries the reason.
 */
export async function buildClaimRecallBlock(input: ClaimRecallInput): Promise<string | null> {
  return (await buildClaimRecallResult(input)).block;
}
