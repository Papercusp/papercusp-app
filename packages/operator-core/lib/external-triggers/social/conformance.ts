/**
 * Social adapter conformance kit
 * (social-platform-integrations-2026-08-23 P-003).
 *
 * WHAT MAKES N PLATFORMS TRACTABLE. Ten adapters written ten different ways is
 * ten sets of bugs. This kit is the alternative: one executable definition of
 * what "a correct social adapter" means, which every adapter must pass
 * unmodified. When a platform needs the kit CHANGED to accommodate it, that is
 * a finding about the abstraction and must be recorded — not quietly patched
 * per adapter.
 *
 * WHY IT IS A PURE FUNCTION, NOT A vitest `describe`. Returning a structured
 * report instead of calling `it()` keeps this file free of a test-framework
 * import (so it can live in lib/ without dragging vitest into anything that
 * imports it) and, more importantly, makes the SAME checks runnable outside a
 * test run. P-002 requires each declared capability to be ATTESTED against a
 * real provider response rather than merely asserted; the way that happens is
 * by pointing this same kit at a live account later. A `describe`-shaped kit
 * could only ever run under vitest.
 *
 * The checks come directly from the failure modes P-001 measured, not from a
 * generic testing checklist. Each one exists because a specific platform makes
 * it easy to get wrong.
 */
import { validateDatatypePayload } from '../../datatype-payload-validation';
import {
  isCoherentReconcileResult,
  type SocialAdapter,
  type SocialNormalizedEvent,
  type SocialReconcileResult,
} from './adapter-contract';

export interface SocialConformanceFinding {
  check: string;
  detail: string;
}

export interface SocialConformanceReport {
  platformId: string;
  checksRun: string[];
  checksSkipped: { check: string; why: string }[];
  failures: SocialConformanceFinding[];
  ok: boolean;
}

/**
 * The world a harness manages on the adapter's behalf. Implementations back
 * this with an in-memory fake provider for unit runs, or with a real account
 * for a live attestation run.
 */
export interface SocialConformanceHarness<World> {
  /** Fresh adapter + provider world. Called once per check so checks cannot leak into each other. */
  create(): Promise<{ adapter: SocialAdapter; world: World }>;
  /** Add `count` new items provider-side. Returns their external ids, oldest first. */
  publish(world: World, count: number): Promise<string[]>;
  /**
   * Force the provider to refuse the stored cursor on the next reconcile, as
   * Bluesky does past its retention window. Omit for a platform where a cursor
   * genuinely cannot be refused; the check is then skipped and SAID to be.
   */
  expireCursor?(world: World): Promise<void>;
  /** Make the next provider call return a rate-limit response, then recover. */
  rateLimitOnce?(world: World): Promise<void>;
  /** A credential value that must never appear in emitted output. */
  secret: string;
  /** The canonical `social-post` payload schema to validate emissions against. */
  payloadSchema: Record<string, unknown> | null;
}

async function drain(
  adapter: SocialAdapter,
  cursor: unknown | null,
): Promise<{ result: SocialReconcileResult; events: SocialNormalizedEvent[] }> {
  const events: SocialNormalizedEvent[] = [];
  const result = await adapter.reconcile({
    cursor,
    async emit(event) {
      events.push(event);
    },
  });
  return { result, events };
}

function containsSecret(value: unknown, secret: string): boolean {
  if (!secret) return false;
  return JSON.stringify(value ?? null).includes(secret);
}

/**
 * Run every conformance check against one adapter.
 *
 * Never throws for a conformance failure — failures are returned so a caller can
 * report all of them at once. It DOES propagate an unexpected harness error,
 * because that means the check itself could not run, which is not the same as
 * the adapter failing it.
 */
export async function runSocialAdapterConformance<World>(
  harness: SocialConformanceHarness<World>,
): Promise<SocialConformanceReport> {
  const failures: SocialConformanceFinding[] = [];
  const checksRun: string[] = [];
  const checksSkipped: { check: string; why: string }[] = [];
  let platformId = 'unknown';

  const fail = (check: string, detail: string) => failures.push({ check, detail });

  // ── cold start ────────────────────────────────────────────────────────────
  // A first connect has no cursor. The adapter must not treat that as "nothing
  // to do" — that is how an integration silently ignores everything that
  // existed before it was installed.
  checksRun.push('cold-start');
  {
    const { adapter, world } = await harness.create();
    platformId = adapter.platformId;
    const ids = await harness.publish(world, 3);
    const { result, events } = await drain(adapter, null);

    if (events.length !== ids.length) {
      fail('cold-start', `expected ${ids.length} events on cold start, got ${events.length}`);
    }
    if (!isCoherentReconcileResult(result)) {
      fail('cold-start', `incoherent result: path=${result.path} backfillReason=${result.backfillReason}`);
    }
    if (result.emitted !== events.length) {
      fail('cold-start', `result.emitted=${result.emitted} disagrees with ${events.length} emitted events`);
    }

    // ── payload validates against the canonical datatype ────────────────────
    // D-004: adapters do not invent their own post shape. A payload that fails
    // its canonical schema is a delivery failure, not a silently-mutated shape.
    checksRun.push('payload-matches-canonical-datatype');
    for (const event of events) {
      const validation = validateDatatypePayload(harness.payloadSchema, event.payload);
      if (!validation.ok) {
        fail(
          'payload-matches-canonical-datatype',
          `event ${event.externalId} failed social-post validation: ${validation.errors.join('; ')}`,
        );
        break;
      }
    }

    // ── dedupe keys are stable and provider-derived ─────────────────────────
    // A dedupeKey containing wall-clock time or randomness looks fine in a
    // single run and defeats replay dedupe entirely on the second one, which is
    // the run nobody tests.
    checksRun.push('dedupe-keys-unique-and-stable');
    const keys = events.map((e) => e.dedupeKey);
    if (new Set(keys).size !== keys.length) {
      fail('dedupe-keys-unique-and-stable', `duplicate dedupe keys within one pass: ${keys.join(', ')}`);
    }
    const replay = await drain(adapter, null);
    const replayKeys = replay.events.map((e) => e.dedupeKey);
    if (replayKeys.join('|') !== keys.join('|')) {
      fail(
        'dedupe-keys-unique-and-stable',
        `dedupe keys changed across two identical passes — they must derive from provider facts, not time or randomness (${keys.join(',')} vs ${replayKeys.join(',')})`,
      );
    }

    // ── the credential never leaves the adapter ─────────────────────────────
    // D-019 rejected direct provider calls partly because a token in an emitted
    // payload reaches the transcript, then the compaction summary, then memory.
    checksRun.push('credential-never-emitted');
    for (const event of events) {
      if (containsSecret(event, harness.secret)) {
        fail('credential-never-emitted', `event ${event.externalId} carries the credential`);
        break;
      }
    }
    if (containsSecret(result.cursor, harness.secret)) {
      fail('credential-never-emitted', 'the persisted cursor carries the credential');
    }
  }

  // ── offline gap is closed exactly once ────────────────────────────────────
  // The central promise of the whole trigger substrate: a desktop that was
  // asleep must not lose events, and must not replay them twice either.
  checksRun.push('offline-gap-closed-exactly-once');
  {
    const { adapter, world } = await harness.create();
    await harness.publish(world, 2);
    const first = await drain(adapter, null);

    const missed = await harness.publish(world, 3);
    const second = await drain(adapter, first.result.cursor);

    const seen = second.events.map((e) => e.externalId);
    const lost = missed.filter((id) => !seen.includes(id));
    if (lost.length > 0) {
      fail('offline-gap-closed-exactly-once', `events published during the gap were never emitted: ${lost.join(', ')}`);
    }
    const duplicated = seen.filter((id, i) => seen.indexOf(id) !== i);
    if (duplicated.length > 0) {
      fail('offline-gap-closed-exactly-once', `events emitted more than once: ${duplicated.join(', ')}`);
    }
    if (!isCoherentReconcileResult(second.result)) {
      fail(
        'offline-gap-closed-exactly-once',
        `incoherent result: path=${second.result.path} backfillReason=${second.result.backfillReason}`,
      );
    }
  }

  // ── an already-current source emits nothing ───────────────────────────────
  // The other half of the previous check. An adapter that re-emits the whole
  // world on every pass "loses nothing" and is still broken: it would re-fire
  // every binding on every reconnect.
  checksRun.push('no-op-reconcile-emits-nothing');
  {
    const { adapter, world } = await harness.create();
    await harness.publish(world, 2);
    const first = await drain(adapter, null);
    const second = await drain(adapter, first.result.cursor);
    if (second.events.length !== 0) {
      fail(
        'no-op-reconcile-emits-nothing',
        `expected 0 events when already current, got ${second.events.length} — every reconnect would re-fire bindings`,
      );
    }
    if (second.result.emitted !== 0) {
      fail('no-op-reconcile-emits-nothing', `result.emitted=${second.result.emitted} for a no-op pass`);
    }
  }

  // ── cursor-unusable falls back rather than losing the gap ─────────────────
  // THE check this kit exists for (D-005). Bluesky refuses a cursor older than
  // its retention window; Mastodon has no cursor at all. The wrong behaviour —
  // shrug and start from live — is invisible, because it emits zero events and
  // looks exactly like "nothing happened while we were away".
  if (harness.expireCursor) {
    checksRun.push('cursor-unusable-falls-back-to-backfill');
    const { adapter, world } = await harness.create();
    await harness.publish(world, 2);
    const first = await drain(adapter, null);

    const missed = await harness.publish(world, 3);
    await harness.expireCursor(world);
    const second = await drain(adapter, first.result.cursor);

    if (second.result.path !== 'backfill') {
      fail(
        'cursor-unusable-falls-back-to-backfill',
        `expected path='backfill' after the cursor was refused, got '${second.result.path}' — starting from live here silently loses the gap`,
      );
    }
    if (!second.result.backfillReason) {
      fail('cursor-unusable-falls-back-to-backfill', 'backfill path did not state a backfillReason');
    }
    const seen = second.events.map((e) => e.externalId);
    const lost = missed.filter((id) => !seen.includes(id));
    if (lost.length > 0) {
      fail(
        'cursor-unusable-falls-back-to-backfill',
        `backfill did not recover the gap; missing: ${lost.join(', ')}`,
      );
    }
  } else {
    checksSkipped.push({
      check: 'cursor-unusable-falls-back-to-backfill',
      why: 'harness declares no expireCursor: this platform cannot refuse a cursor',
    });
  }

  // ── unreadable persisted state is not a cold start ────────────────────────
  // A non-null cursor that a newer/older adapter cannot parse is still a
  // previous connection's state. Treating it as null and reporting cold-start
  // hides the recovery path and can silently lose the gap. Every adapter must
  // use its bounded backfill and identify the local invalid-cursor condition as
  // rejected state, even when the provider itself never saw the cursor.
  checksRun.push('unreadable-cursor-falls-back-to-backfill');
  {
    const { adapter, world } = await harness.create();
    const ids = await harness.publish(world, 3);
    const { result, events } = await drain(adapter, { __unreadable_social_cursor__: true });

    if (result.path !== 'backfill') {
      fail(
        'unreadable-cursor-falls-back-to-backfill',
        `expected path='backfill' for an unreadable persisted cursor, got '${result.path}' — reporting cold-start hides recovery`,
      );
    }
    if (result.backfillReason !== 'cursor-rejected') {
      fail(
        'unreadable-cursor-falls-back-to-backfill',
        `expected backfillReason='cursor-rejected' for an unreadable persisted cursor, got '${result.backfillReason ?? 'undefined'}'`,
      );
    }
    const lost = ids.filter((id) => !events.some((event) => event.externalId === id));
    if (lost.length > 0) {
      fail(
        'unreadable-cursor-falls-back-to-backfill',
        `backfill did not recover events after an unreadable persisted cursor; missing: ${lost.join(', ')}`,
      );
    }
  }

  // ── rate limiting is absorbed, not propagated ─────────────────────────────
  if (harness.rateLimitOnce) {
    checksRun.push('rate-limit-is-absorbed');
    const { adapter, world } = await harness.create();
    const ids = await harness.publish(world, 2);
    await harness.rateLimitOnce(world);
    try {
      const { events } = await drain(adapter, null);
      const seen = events.map((e) => e.externalId);
      const lost = ids.filter((id) => !seen.includes(id));
      if (lost.length > 0) {
        fail('rate-limit-is-absorbed', `events lost across a rate-limit response: ${lost.join(', ')}`);
      }
    } catch (error) {
      fail('rate-limit-is-absorbed', `reconcile threw instead of backing off: ${(error as Error).message}`);
    }
  } else {
    checksSkipped.push({
      check: 'rate-limit-is-absorbed',
      why: 'harness declares no rateLimitOnce',
    });
  }

  return {
    platformId,
    checksRun,
    checksSkipped,
    failures,
    ok: failures.length === 0,
  };
}

/** One-line human summary of a report, for a test message or a live attestation log. */
export function formatConformanceReport(report: SocialConformanceReport): string {
  if (report.ok) {
    const skipped = report.checksSkipped.length ? `, ${report.checksSkipped.length} skipped` : '';
    return `${report.platformId}: ${report.checksRun.length} checks passed${skipped}`;
  }
  const lines = report.failures.map((f) => `  - [${f.check}] ${f.detail}`);
  return `${report.platformId}: ${report.failures.length} conformance failure(s)\n${lines.join('\n')}`;
}
