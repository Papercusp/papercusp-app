/**
 * corpus.ts — deterministic op-stream generator for the p2p-perf suite (P-002).
 *
 * Generates seeded, reproducible streams of `PeerLogOp`s whose table mix and
 * row shapes model what real peer logs carry — the registered projections
 * (`projections/register-all.ts`). Every generated value PASSES its
 * projection's shape guard (`isXxxRow`) and every hbKey matches that
 * projection's `composeKey` convention, so a corpus can be driven through the
 * REAL apply path (the projection-write-cost bench does exactly that, and
 * `projection-write-cost.integration.test.ts` is the drift canary).
 *
 * Determinism is the point: the same `{seed, count, harnessSlug}` always
 * yields byte-identical ops, so two bench runs measure the same workload and
 * a regression is a code change, never corpus noise. (`corpus.test.ts` locks
 * it.)
 *
 * The mix models the registered projection set, cross-checked against the
 * live dogfood DB (2026-06-06: coord-messages/issues/plans outnumber feature
 * rows at rest; presence is ephemeral — high op frequency, near-zero rows at
 * rest; feature rows dominate by bytes). Weights are approximate by design —
 * what matters is that they stay FIXED so corpora are comparable across runs
 * and machines.
 */

import type { PeerLogOp } from '../peer-log';

/** Standard corpus sizes (P-002). 1M is the EI-79-validation tier — nightly /
 *  on-demand only; CI smoke uses the small ones. */
export const CORPUS_SIZES = [1_000, 10_000, 100_000, 1_000_000] as const;

/** Default harness slug baked into corpus rows. Projections silently drop
 *  rows whose harness_slug differs from their binding — benches that drive
 *  the real apply path must generate with THEIR harness slug. */
export const DEFAULT_CORPUS_HARNESS = 'perf';

/** mulberry32 — tiny, fast, deterministic PRNG (32-bit seed). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOREM =
  'the quick brown fox jumps over the lazy dog while the operator merges admitted peer logs into postgres projections without blocking the event loop';

function words(rnd: () => number, n: number): string {
  const pool = LOREM.split(' ');
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(pool[Math.floor(rnd() * pool.length)]);
  return out.join(' ');
}

interface BuildCtx {
  rnd: () => number;
  i: number;
  author: string;
  harness: string;
  ts: number;
}

interface OpKind {
  table: string;
  weight: number;
  /** Of this kind's ops, the fraction that are `del`s. */
  delRatio: number;
  /** Build the hbKey + a GUARD-PASSING row value for one op of this kind. */
  build(ctx: BuildCtx): { hbKey: string; value: unknown };
}

const fid = (rnd: () => number) => `F-${String(1 + Math.floor(rnd() * 400)).padStart(3, '0')}`;
const uid = (rnd: () => number) => 1000 + Math.floor(rnd() * 20);

/** The fixed kind mix. Weights sum to 100 for readability. Every `value`
 *  satisfies the corresponding projection's `isXxxRow` guard and every
 *  `hbKey` matches its `composeKey`. */
const OP_KINDS: OpKind[] = [
  {
    // Presence heartbeats — by far the most frequent op in a live log.
    // SharedPresenceRow; composeKey = `${github_user_id}/${machine_label}`.
    table: 'presence',
    weight: 34,
    delRatio: 0.02,
    build: ({ rnd, harness, ts, author }) => {
      const userId = uid(rnd);
      const machine = `box-${userId % 5}`;
      return {
        hbKey: `${userId}/${machine}`,
        value: {
          harness_slug: harness,
          github_user_id: userId,
          machine_label: machine,
          device_pubkey: author,
          intent: words(rnd, 6),
          current_view: rnd() < 0.5 ? null : `/harness/${harness}`,
          last_seen_at: ts,
          schema_version: 1,
        },
      };
    },
  },
  {
    // Feature rows — the byte-heavy kind. HarnessFeatureRow; composeKey = feature_id.
    table: 'features-by-id',
    weight: 22,
    delRatio: 0.03,
    build: ({ rnd, i, harness, ts }) => {
      const featureId = fid(rnd);
      return {
        hbKey: featureId,
        value: {
          harness_slug: harness,
          feature_id: featureId,
          title: words(rnd, 8),
          summary: words(rnd, 30),
          status: ['todo', 'doing', 'validating', 'passed', 'failing'][Math.floor(rnd() * 5)],
          attempts: Math.floor(rnd() * 5),
          claims: null,
          notes: words(rnd, 40),
          metadata: { source: 'p2p-perf-corpus', seq: i },
          kind: 'feature',
          project_id: null,
          expected_cost_cents: null,
          tags: ['perf'],
          needs_human_review: rnd() < 0.1,
          ts,
          created_ts: ts - 60_000,
          updated_ts: ts,
          parent_id: null,
          goal_id: null,
          taken_by: null,
          taken_at: null,
          expires_at: null,
        },
      };
    },
  },
  {
    // FeatureQueueRow; composeKey = `${github_user_id}/${feature_id}`.
    table: 'queue',
    weight: 8,
    delRatio: 0.25,
    build: ({ rnd, harness, ts }) => {
      const userId = uid(rnd);
      const featureId = fid(rnd);
      return {
        hbKey: `${userId}/${featureId}`,
        value: {
          harness_slug: harness,
          github_user_id: userId,
          feature_id: featureId,
          queued_at: ts,
          removed_at: rnd() < 0.2 ? ts : null,
          schema_version: 1,
        },
      };
    },
  },
  {
    // FeatureWorkingSetRow; composeKey = `${github_user_id}/${feature_id}`.
    table: 'working-set',
    weight: 8,
    delRatio: 0.25,
    build: ({ rnd, harness, ts }) => {
      const userId = uid(rnd);
      const featureId = fid(rnd);
      return {
        hbKey: `${userId}/${featureId}`,
        value: {
          harness_slug: harness,
          github_user_id: userId,
          feature_id: featureId,
          started_at: ts,
          cleared_at: rnd() < 0.3 ? ts : null,
          schema_version: 1,
        },
      };
    },
  },
  {
    // Claims are append-only (seq-keyed), so never del'd.
    // FeatureClaimRow; composeKey = `${feature_id}/${seq}`.
    table: 'claims',
    weight: 6,
    delRatio: 0,
    build: ({ rnd, i, harness, ts, author }) => {
      const featureId = fid(rnd);
      return {
        hbKey: `${featureId}/${i}`,
        value: {
          harness_slug: harness,
          feature_id: featureId,
          seq: i,
          claimer_pubkey: author,
          claimer_github_user_id: uid(rnd),
          claimed_at: ts,
          outcome: rnd() < 0.5 ? null : ['shipped', 'failed', 'released'][Math.floor(rnd() * 3)],
          schema_version: 1,
        },
      };
    },
  },
  {
    // HarnessIssueRow; composeKey = issue_id.
    table: 'issues',
    weight: 6,
    delRatio: 0.05,
    build: ({ rnd, harness, ts }) => {
      const issueId = `EI-${1 + Math.floor(rnd() * 120)}`;
      return {
        hbKey: issueId,
        value: {
          harness_slug: harness,
          issue_id: issueId,
          title: words(rnd, 10),
          // Values match the DB CHECK constraints (130-harness-issues-enums-canonical).
          severity: ['minor', 'major', 'critical'][Math.floor(rnd() * 3)],
          source: ['validator', 'worker', 'system'][Math.floor(rnd() * 3)],
          status: ['open', 'acknowledged', 'fixing', 'closed'][Math.floor(rnd() * 4)],
          found_at: ts,
          found_during: rnd() < 0.5 ? null : words(rnd, 3),
          repro: rnd() < 0.3 ? words(rnd, 20) : null,
          evidence: null,
          suggested_fix: rnd() < 0.3 ? words(rnd, 15) : null,
          code_pointer: null,
          linked_feature_id: rnd() < 0.2 ? fid(rnd) : null,
          attempts: Math.floor(rnd() * 3),
          notes: [],
          created_ts: ts - 30_000,
          updated_ts: ts,
        },
      };
    },
  },
  {
    // CoordMessageRow; composeKey = msg_id. Body is the CoordEnvelope (no notify_kind).
    table: 'coord-messages',
    weight: 10,
    delRatio: 0,
    build: ({ rnd, i, harness, ts, author }) => {
      const msgId = `perf-${author.slice(0, 6)}-${i}`;
      return {
        hbKey: msgId,
        value: {
          harness_slug: harness,
          msg_id: msgId,
          surface: ['messages', 'handoffs', 'escalations'][Math.floor(rnd() * 3)],
          writer_key: author.slice(0, 12),
          body: {
            ts: new Date(ts).toISOString(),
            msg_id: msgId,
            from: `su-${author.slice(0, 8)}`,
            to: ['*'],
            kind: 'message',
            summary: words(rnd, 15),
            ...(rnd() < 0.4 ? { body: words(rnd, 60) } : {}),
          },
          ts,
        },
      };
    },
  },
  {
    // HarnessPlanRow; composeKey = plan_slug.
    table: 'plans-by-slug',
    weight: 4,
    delRatio: 0.02,
    build: ({ rnd, i, harness, ts }) => {
      const planSlug = `perf-plan-${1 + Math.floor(rnd() * 30)}`;
      const content = words(rnd, 120);
      return {
        hbKey: planSlug,
        value: {
          harness_slug: harness,
          plan_slug: planSlug,
          content,
          content_hash: `h${(i * 2654435761) >>> 0}`,
          title: words(rnd, 9),
          status: ['draft', 'active', 'shipped'][Math.floor(rnd() * 3)],
          created: new Date(ts - 86_400_000).toISOString().slice(0, 10),
          updated: new Date(ts).toISOString().slice(0, 10),
          owner: null,
          supersedes: [],
          superseded_by: null,
          archived: false,
          is_legacy: false,
        },
      };
    },
  },
  {
    // ContributorRow; composeKey = String(github_user_id).
    table: 'contributors',
    weight: 2,
    delRatio: 0.05,
    build: ({ rnd, harness, ts }) => {
      const userId = uid(rnd);
      return {
        hbKey: String(userId),
        value: {
          harness_slug: harness,
          github_user_id: userId,
          github_username: `user-${userId}`,
          display_name: null,
          avatar_url: null,
          device_attestations: [],
          revoked_pubkeys: [],
          joined_at: ts - 86_400_000,
          last_seen_at: ts,
          binding_status: 'verified',
          channel1_verified_at: ts,
          channel2_verified_at: ts,
          channel2_branch_ref: null,
          binding_last_checked_at: ts,
          schema_version: 1,
        },
      };
    },
  },
];

const TOTAL_WEIGHT = OP_KINDS.reduce((a, k) => a + k.weight, 0);

function pickKind(rnd: () => number): OpKind {
  let r = rnd() * TOTAL_WEIGHT;
  for (const k of OP_KINDS) {
    r -= k.weight;
    if (r <= 0) return k;
  }
  return OP_KINDS[OP_KINDS.length - 1];
}

export interface CorpusOpts {
  seed: number;
  count: number;
  /** The generating peer's author pubkey (hex). Distinct per simulated peer. */
  authorPubkey: string;
  /** harness_slug baked into rows. MUST match the consuming projection
   *  binding when ops are driven through the real apply path. */
  harnessSlug?: string;
  /** Base epoch-ms for op timestamps. Ops get strictly-increasing ts from here. */
  baseTs?: number;
}

/**
 * Generate `count` deterministic ops. Streaming generator so 1M-op corpora
 * never materialize as one giant array unless the caller collects them.
 */
export function* generateCorpus(opts: CorpusOpts): Generator<PeerLogOp> {
  const rnd = mulberry32(opts.seed);
  const baseTs = opts.baseTs ?? 1_700_000_000_000;
  const harness = opts.harnessSlug ?? DEFAULT_CORPUS_HARNESS;
  for (let i = 0; i < opts.count; i++) {
    const kind = pickKind(rnd);
    const ts = baseTs + i;
    const { hbKey, value } = kind.build({ rnd, i, author: opts.authorPubkey, harness, ts });
    const isDel = rnd() < kind.delRatio;
    yield {
      type: isDel ? 'del' : 'put',
      table: kind.table,
      hbKey,
      // LWW ts: strictly increasing per author so the fold has a defined winner.
      ts,
      schema_version: 1,
      author_pubkey: opts.authorPubkey,
      ...(isDel ? {} : { value }),
    };
  }
}

/** Collect a corpus into an array (small sizes / tests). */
export function corpusArray(opts: CorpusOpts): PeerLogOp[] {
  return [...generateCorpus(opts)];
}
