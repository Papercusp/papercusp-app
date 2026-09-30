/**
 * HMAC signing + verification for per-spawn MCP URLs.
 *
 * Today, the per-spawn URL bakes (workspace, harness, role, run, spawn,
 * feature?, chunk?, parent_spawn?) into query params, and the dispatcher
 * trusts them. That makes role escalation a one-liner — a worker that
 * wants operator-tier access just rewrites `?role=worker` to
 * `?role=operator` and calls. See docs/endpoint-system/superuser-mode.mdx
 * for the doc-level threat acknowledgement.
 *
 * This module adds:
 *   1. A 32-byte signing key in harness_shared.operator_secrets
 *      (auto-created on first use). PG storage instead of a flat file
 *      so the agent can't `cat ~/.papercusp/<file>` it.
 *   2. `signSpawnParams(params)` — appends `exp` + `sig` (base64url
 *      HMAC-SHA256) to a canonicalized param set.
 *   3. `verifySpawnParams(url)` — returns ok / failure with reason.
 *
 * Threat model (what this defends against):
 *   - Prompt-injected worker that ATTEMPTS to rewrite URL params to
 *     claim a higher role. Verification fails because the sig is over
 *     the original params. **This is the realistic threat.**
 *
 * Threat model (what this does NOT defend against):
 *   - Same-UID code that knows enough to query PG for the key and
 *     re-sign arbitrary params. The agent runs as the operator's UID
 *     and has libpq access; HMAC is friction, not enforcement.
 *   - Reading another spawn's `.mcp.json` and replaying it. Each
 *     `.mcp.json` is fully valid for its `exp` window. Mitigations:
 *     per-spawn worktree dir mode 0700, short exp windows.
 *   - Long replay window. Default `exp` is 24h; for short-lived spawns
 *     pass a smaller `ttlSec`.
 *
 * Coarse revocation: rotate via `rotateSpawnSigningKey()` (the
 * `/admin/spawn-signing/rotate` route — `remediate:true` by default, so it
 * also auto-relaunches the sessions it just invalidated, WI-3194). Every
 * in-flight signed URL fails its next call. Use sparingly — anything not
 * auto-remediated needs a manual re-spawn.
 *
 * ⚠ A PLAIN OPERATOR RESTART DOES **NOT** ROTATE THIS KEY (WI-4447,
 * verified 2026-07-20). The key lives in `operator_secrets`, a durable PG
 * row read fresh by `loadOrCreateKey()` on every process start — a
 * restarted process reloads the SAME value, so every previously-signed URL
 * keeps verifying. Restarting merely resets this process's local
 * `verifiedSpawns()` tracker (used only for rotation-strand vs. unverified
 * *classification* of a failure that already happened for some other
 * reason) — it is not itself a source of signature failures. Only an
 * explicit call to `rotateSpawnSigningKey()` changes `value_b64`. Bumping
 * the in-process cache after a manual PG UPDATE (outside this module) is
 * the one case restarting the operator is a valid *substitute* for — don't
 * read that as "restarting revokes."
 *
 * Spec: see also docs/endpoint-system/superuser-mode.mdx and the
 * spawn-mcp.ts side in libs/papercusp/packages/orchestrator (the
 * minting end).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getOrgPg, generated } from '@papercusp/db-org';
import type { AgentIdentity } from './agent-tools/coordination/identity';
import { eq, sql as dsql } from 'drizzle-orm';
// The signing PRIMITIVES (allowlist + canonicalize + HMAC) live in ONE shared
// module the orchestrator process imports too — so the rule can't drift between
// the two signers (unify-launch-mechanics follow-on, signing dedup). Only the
// per-process PG key-loading (below) stays local.
import { canonicalizeSpawnParams, hmacSpawnBytes } from '@papercusp/orchestrator/spawn-signing-core';
import { decodeOperatorSecretKey } from './operator-secret-key';

const os = generated.operatorSecretsInHarnessShared;
const sf = generated.spawnSigVerificationFailuresInHarnessShared;

const KEY_NAME = 'spawn-signing-key';

interface KeyCache {
  buf: Buffer;
  /** rotated_at from PG; cache invalidates when PG's value advances. */
  rotatedAt: number;
  loadedAt: number;
}

const __g = globalThis as unknown as { __papercuspSpawnSigningKey?: KeyCache | null };

/** Force a key reload on next signSpawnParams/verifySpawnParams. */
export function _resetSpawnSigningKeyCache(): void {
  __g.__papercuspSpawnSigningKey = null;
}

/**
 * Read the current key from PG. Honors PG's rotated_at so a rotate on
 * any other operator process invalidates this process's cache on the
 * next call. One extra PG row per signing/verifying call — negligible
 * compared to the rest of the MCP-call cost, and necessary to avoid
 * the multi-instance cache-coherence bug surfaced by the audit (any
 * concurrent admin-rotate from a sibling process would otherwise leave
 * this process serving a stale key for up to 5 minutes).
 *
 * The 5-minute TTL is kept as a safety net in case rotated_at can't be
 * read for some reason — but the rotated_at check is the primary
 * mechanism.
 */
async function loadOrCreateKey(): Promise<Buffer> {
  const { db } = getOrgPg();
  const rows = await db
    .select({ value_b64: os.valueB64, rotated_at: os.rotatedAt })
    .from(os)
    .where(eq(os.name, KEY_NAME))
    .limit(1);
  if (rows.length > 0) {
    const rotatedAt = new Date(rows[0].rotated_at as never).getTime();
    const cached = __g.__papercuspSpawnSigningKey;
    if (cached && cached.rotatedAt === rotatedAt && Date.now() - cached.loadedAt < 5 * 60 * 1000) {
      return cached.buf;
    }
    const buf = decodeOperatorSecretKey(rows[0].value_b64, KEY_NAME);
    __g.__papercuspSpawnSigningKey = { buf, rotatedAt, loadedAt: Date.now() };
    return buf;
  }

  // First run: mint a new key and persist. INSERT … ON CONFLICT
  // (which can race if two operator processes start simultaneously).
  const fresh = randomBytes(32);
  const fresh_b64 = fresh.toString('base64');
  await db.insert(os).values({ name: KEY_NAME, valueB64: fresh_b64 }).onConflictDoNothing();
  // Re-read to win-or-lose deterministically.
  const after = await db
    .select({ valueB64: os.valueB64, rotated_at: os.rotatedAt })
    .from(os)
    .where(eq(os.name, KEY_NAME))
    .limit(1);
  const rotatedAt = new Date(after[0]!.rotated_at as never).getTime();
  const buf = decodeOperatorSecretKey(after[0]!.valueB64, KEY_NAME);
  __g.__papercuspSpawnSigningKey = { buf, rotatedAt, loadedAt: Date.now() };
  return buf;
}

// canonicalize + hmac now come from the shared `@papercusp/orchestrator/spawn-signing-core`
// (imported above) — `canonicalizeSpawnParams` + `hmacSpawnBytes` — so this signer and the
// orchestrator's spawn-time signer use byte-identical rules. Local aliases keep the call
// sites below unchanged.
const canonicalize = canonicalizeSpawnParams;
const hmac = hmacSpawnBytes;

export interface SignedSpawnParams {
  exp: number;
  sig: string;
}

/**
 * Sign a spawn URL's param set in place: appends `exp` and `sig` to
 * the URLSearchParams instance. `ttlSec` defaults to 24h. Returns the
 * appended values for callers that want to log them.
 */
export async function signSpawnParams(
  params: URLSearchParams,
  opts: { ttlSec?: number; nowMs?: number } = {},
): Promise<SignedSpawnParams> {
  // PERMANENT by default (exp=0 sentinel) — no time-based re-minting (owner directive
  // 2026-07-01). A POSITIVE ttlSec still mints a bounded URL for callers that explicitly want one.
  const ttlSec = opts.ttlSec ?? 0;
  const nowMs = opts.nowMs ?? Date.now();
  const exp = ttlSec > 0 ? Math.floor(nowMs / 1000) + ttlSec : 0;

  params.set('exp', String(exp));
  // Strip any inbound `sig` before canonicalizing.
  params.delete('sig');

  const c = canonicalize(params);
  if (!c.ok) throw new Error(`spawn-signing: ${c.reason}`);

  const key = await loadOrCreateKey();
  const sig = hmac(key, c.canonical).toString('base64url');
  params.set('sig', sig);
  return { exp, sig };
}

export type VerifyResult = { ok: true; keySha256?: string } | { ok: false; reason: string };

/**
 * Verify a per-spawn URL's signature. Pass the whole URL (string or
 * URL); returns ok or a structured failure. On failure, callers should
 * log to spawn_sig_verification_failures (via `logVerificationFailure`)
 * and reject the request.
 */
export async function verifySpawnParams(input: URL | string, options?: { includeKeyDigest?: boolean }): Promise<VerifyResult> {
  const u = typeof input === 'string' ? new URL(input) : input;
  const sig = u.searchParams.get('sig');
  const expRaw = u.searchParams.get('exp');
  if (!sig) return { ok: false, reason: 'missing_sig' };
  if (!expRaw) return { ok: false, reason: 'missing_exp' };

  const exp = Number(expRaw);
  // exp === 0 is the PERMANENT sentinel (no time-based expiry). The sig still covers exp, so a
  // role-escalation rewrite still fails verification; only the TIME check is skipped. (2026-07-01:
  // the 24h TTL made agents' MCP URLs die daily and forced a re-mint that churned .mcp.json →
  // Claude Code re-approval → dark sessions. Revocation is now key-rotation, not expiry.)
  if (!Number.isFinite(exp) || exp < 0) return { ok: false, reason: 'invalid_exp' };
  if (exp !== 0 && exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };

  const c = canonicalize(u.searchParams);
  if (!c.ok) return { ok: false, reason: c.reason };

  const key = await loadOrCreateKey();
  const expected = hmac(key, c.canonical);
  let provided: Buffer;
  try {
    provided = Buffer.from(sig, 'base64url');
  } catch {
    return { ok: false, reason: 'invalid_sig_encoding' };
  }
  if (provided.length !== expected.length) return { ok: false, reason: 'invalid_signature' };
  if (!timingSafeEqual(provided, expected)) return { ok: false, reason: 'invalid_signature' };
  // Opt-in identity of the EXACT key verified above, not a later read that
  // could silently bridge a concurrent rotation. Never disclose the key.
  return options?.includeKeyDigest
    ? { ok: true, keySha256: createHash('sha256').update(key).digest('hex') }
    : { ok: true };
}

export interface VerificationFailureRecord {
  reason: string;
  claimedRole?: string | null;
  claimedHarness?: string | null;
  claimedWorkspace?: string | null;
  claimedSpawn?: string | null;
  expClaim?: number | null;
  remoteAddr?: string | null;
  userAgent?: string | null;
  /**
   * WI-3190: 'rotation_strand' (a previously-authenticated spawn whose key was
   * rotated out from under it — must be re-spawned) vs 'unverified' (first-seen /
   * malformed / escalation attempt). Lets the on-call dashboard filter the
   * actionable re-spawn queue instead of conflating strands with attacks.
   */
  classification?: FailureClassification | null;
}

/** Persist a verification failure for the dashboard / on-call review. */
export async function logVerificationFailure(rec: VerificationFailureRecord): Promise<void> {
  try {
    const { db } = getOrgPg();
    await db.insert(sf).values({
      reason: rec.reason,
      claimedRole: rec.claimedRole ?? null,
      claimedHarness: rec.claimedHarness ?? null,
      claimedWorkspace: rec.claimedWorkspace ?? null,
      claimedSpawn: rec.claimedSpawn ?? null,
      expClaim: rec.expClaim ?? null,
      remoteAddr: rec.remoteAddr ?? null,
      userAgent: rec.userAgent ?? null,
      classification: rec.classification ?? null,
    });
  } catch (err) {
    // Never fail the request because of audit-write failure; but log loud.

    console.warn('[spawn-signing] audit write failed', err);
  }
}

export interface RotationBlastRadius {
  rotatedAt: string;
  /**
   * How many distinct spawns THIS operator process had actively authenticated
   * (and therefore just invalidated). A cross-process rotate strands more than
   * this — this is the lower-bound this process can speak to authoritatively.
   */
  invalidatedSpawnCount: number;
  /** Up to 200 of the just-invalidated spawns, most-recently-active first. */
  invalidatedSpawns: Array<{ spawn: string; role: string | null; harness: string | null }>;
  /** Optional WI-3194 active recovery result when the caller opts into remediation. */
  remediation?: RotationRemediationSummary;
}

export interface RotationRemediationSkipped {
  spawn: string;
  reason: 'remediation_cap' | 'spawn_record_unavailable' | 'not_relaunchable' | 'cancel_failed' | 'relaunch_declined';
  detail?: string;
}

export interface RotationRemediationSummary {
  attemptedSpawnCount: number;
  cancelledSpawnCount: number;
  abortedLocalSpawnCount: number;
  relaunchedSpawnCount: number;
  relaunchedSpawns: string[];
  skipped: RotationRemediationSkipped[];
}

/**
 * Rotate the signing key. Every in-flight signed URL fails its next call after
 * this returns; the orchestrator will need to re-spawn anything affected.
 * Loopback + superuser-bearer gated at the route level.
 *
 * WI-3190: returns a BLAST-RADIUS report (and logs it loudly) so a rotate is an
 * ACCOUNTED-FOR revocation, not a silent one — the admin route surfaces it to
 * whoever triggered the rotate. We do NOT clear the verified-spawn set here: it
 * is exactly what lets each stranded spawn's NEXT (failing) call be recognised
 * as a rotation-strand rather than an attack (see classifyAndConsumeFailure).
 */
export interface RotateSpawnSigningKeyOptions {
  /**
   * WI-3194: actively stop/relaunch eligible nursery spawns whose currently
   * verified signed URL was just invalidated. The admin route opts in; direct
   * unit callers keep the historical rotate-only behavior.
   */
  remediate?: boolean;
  /** Safety cap for one rotate-triggered sweep. Default 25. */
  maxRemediationSpawns?: number;
}

const ROTATION_REMEDIATION_CAP = 25;

interface RotationRemediationRow {
  spawn_id: string;
  workspace_id: string;
  harness_slug: string;
  child_role: string;
  parent_spawn_id: string | null;
  parent_role: string | null;
  work_item_id: string | null;
  work_item_status: string | null;
  plan_slug: string | null;
  model_spec: string | null;
  model_tier: string | null;
  brief: string | null;
}

async function remediateRotatedSpawns(
  report: Pick<RotationBlastRadius, 'invalidatedSpawns'>,
  opts: { maxRemediationSpawns?: number } = {},
): Promise<RotationRemediationSummary> {
  const cap = Math.max(0, Math.min(opts.maxRemediationSpawns ?? ROTATION_REMEDIATION_CAP, ROTATION_REMEDIATION_CAP));
  const selected = report.invalidatedSpawns.slice(0, cap);
  const skipped: RotationRemediationSkipped[] = report.invalidatedSpawns.slice(cap).map((s) => ({
    spawn: s.spawn,
    reason: 'remediation_cap',
    detail: `rotation remediation is capped at ${cap} spawn(s) per rotate`,
  }));
  if (selected.length === 0) {
    return {
      attemptedSpawnCount: 0,
      cancelledSpawnCount: 0,
      abortedLocalSpawnCount: 0,
      relaunchedSpawnCount: 0,
      relaunchedSpawns: [],
      skipped,
    };
  }

  const ids = selected.map((s) => s.spawn);
  let rows: RotationRemediationRow[];
  let sql: unknown;
  let runSql: (<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>) | null = null;
  try {
    const pg = getOrgPg() as unknown as { sql?: unknown };
    sql = pg.sql;
    if (typeof sql !== 'function') throw new Error('org PG sql handle unavailable');
    runSql = sql as <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
    rows = (await runSql<RotationRemediationRow[]>`
      SELECT a.spawn_id, a.workspace_id, a.harness_slug, a.child_role,
             a.parent_spawn_id, a.parent_role,
             COALESCE(a.item_id, a.feature_id) AS work_item_id,
             f.status AS work_item_status,
             a.plan_slug, a.model_spec, a.model_tier, a.brief
        FROM harness_shared.spawned_agents AS a
        LEFT JOIN harness_shared.harness_features_consolidated AS f
          ON f.workspace_id = a.workspace_id
         AND f.harness_slug = a.harness_slug
         AND f.feature_id = COALESCE(a.item_id, a.feature_id)
       WHERE a.spawn_id = ANY(${ids}::text[])
         AND a.status IN ('running', 'restarting')`) as RotationRemediationRow[];
  } catch (err) {
    return {
      attemptedSpawnCount: 0,
      cancelledSpawnCount: 0,
      abortedLocalSpawnCount: 0,
      relaunchedSpawnCount: 0,
      relaunchedSpawns: [],
      skipped: [
        ...skipped,
        ...selected.map((s) => ({
          spawn: s.spawn,
          reason: 'spawn_record_unavailable' as const,
          detail: err instanceof Error ? err.message : String(err),
        })),
      ],
    };
  }

  const bySpawn = new Map(rows.map((r) => [r.spawn_id, r]));
  const [{ shouldRelaunchReclaimedSpawn }, { cancelSubtree }, { abortLocalSpawn }, { relaunchReclaimedSpawn }] =
    await Promise.all([
      import('./fleet/spawn-reclaim'),
      import('./fleet/nursery'),
      import('./fleet/operator-spawn'),
      import('./fleet/spawn-relaunch'),
    ]);

  let cancelledSpawnCount = 0;
  let abortedLocalSpawnCount = 0;
  let relaunchedSpawnCount = 0;
  const relaunchedSpawns: string[] = [];

  for (const inv of selected) {
    const row = bySpawn.get(inv.spawn);
    if (!row) {
      skipped.push({
        spawn: inv.spawn,
        reason: 'spawn_record_unavailable',
        detail: 'no active spawned_agents row matched this verified spawn',
      });
      continue;
    }
    const relaunchable = shouldRelaunchReclaimedSpawn({
      childRole: row.child_role,
      workItemId: row.work_item_id,
      workItemStatus: row.work_item_status,
    });
    if (!relaunchable) {
      skipped.push({
        spawn: inv.spawn,
        reason: 'not_relaunchable',
        detail: `${row.child_role}${row.work_item_status ? `/${row.work_item_status}` : ''}`,
      });
      continue;
    }

    try {
      // Synthetic in-process identity for the cancel's coord notice (mirrors
      // scorecard-emission-pulse's wedge-escalation identity).
      const rotationActor: AgentIdentity = {
        ownerId: 'spawn-signing-rotation',
        ownerLabel: 'system · spawn-signing-rotation',
        source: 'principal',
        workspaceId: row.workspace_id ?? null,
        userId: null,
      };
      const cancel = await cancelSubtree(sql as never, {
        workspaceId: row.workspace_id,
        rootSpawnId: row.spawn_id,
        reason:
          'spawn-signing key rotated; cancelling stranded old signed MCP credential before active remediation relaunch',
        actor: rotationActor,
      });
      cancelledSpawnCount += cancel.cancelled.length;
    } catch (err) {
      skipped.push({
        spawn: inv.spawn,
        reason: 'cancel_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (abortLocalSpawn(row.spawn_id)) abortedLocalSpawnCount += 1;
    const ok = await relaunchReclaimedSpawn(
      {
        spawnId: row.spawn_id,
        workspaceId: row.workspace_id,
        harnessSlug: row.harness_slug,
        childRole: row.child_role,
        parentSpawnId: row.parent_spawn_id,
        parentRole: row.parent_role,
        workItemId: row.work_item_id,
        workItemStatus: row.work_item_status,
        planSlug: row.plan_slug,
        modelSpec: row.model_spec,
        modelTier: row.model_tier,
        brief: row.brief,
      },
      {
        idempotencyKeyPrefix: 'spawn-signing-rotation-relaunch',
        kickoff:
          `Re-launched after spawn-signing key rotation invalidated the prior signed MCP URL ` +
          `(${row.spawn_id}); resume '${row.harness_slug}'.`,
      },
    );
    if (ok) {
      relaunchedSpawnCount += 1;
      relaunchedSpawns.push(row.spawn_id);
    } else {
      skipped.push({ spawn: inv.spawn, reason: 'relaunch_declined' });
    }
  }

  return {
    attemptedSpawnCount: selected.length,
    cancelledSpawnCount,
    abortedLocalSpawnCount,
    relaunchedSpawnCount,
    relaunchedSpawns,
    skipped,
  };
}

export async function rotateSpawnSigningKey(opts: RotateSpawnSigningKeyOptions = {}): Promise<RotationBlastRadius> {
  const { db } = getOrgPg();
  const fresh_b64 = randomBytes(32).toString('base64');
  await db
    .insert(os)
    .values({ name: KEY_NAME, valueB64: fresh_b64, rotatedAt: dsql`now()` as any })
    .onConflictDoUpdate({
      target: os.name,
      set: { valueB64: dsql`EXCLUDED.value_b64`, rotatedAt: dsql`now()` },
    });
  _resetSpawnSigningKeyCache();

  const m = verifiedSpawns();
  const invalidatedSpawns = Array.from(m.entries())
    .sort((a, b) => b[1].lastVerifiedMs - a[1].lastVerifiedMs)
    .slice(0, 200)
    .map(([spawn, meta]) => ({ spawn, role: meta.role, harness: meta.harness }));
  const report: RotationBlastRadius = {
    rotatedAt: new Date().toISOString(),
    invalidatedSpawnCount: m.size,
    invalidatedSpawns,
  };
  if (report.invalidatedSpawnCount > 0) {
    console.warn(
      `[spawn-signing][ROTATE] key rotated — ${report.invalidatedSpawnCount} live spawn(s) this ` +
        `operator was serving are now INVALIDATED and must be re-spawned (each fails its next MCP ` +
        `call with spawn_sig_invalid_signature): ` +
        invalidatedSpawns.map((s) => `${s.spawn}(${s.role ?? '?'}/${s.harness ?? '?'})`).join(', '),
    );
  }
  if (opts.remediate) {
    report.remediation = await remediateRotatedSpawns(report, {
      maxRemediationSpawns: opts.maxRemediationSpawns,
    });
    if (report.remediation.relaunchedSpawnCount > 0 || report.remediation.skipped.length > 0) {
      console.warn(
        `[spawn-signing][ROTATE] active remediation: relaunched ` +
          `${report.remediation.relaunchedSpawnCount}/${report.remediation.attemptedSpawnCount}; ` +
          `skipped=${report.remediation.skipped.length}`,
      );
    }
  }
  return report;
}

// ── Rotation-strand detection + self-recovery guidance (WI-3190) ─────────────
//
// A key rotation is a COARSE revocation: every in-flight signed spawn URL fails
// its next verify with `invalid_signature` — byte-identical to a role-escalation
// ATTEMPT. To tell an operational strand (a previously-authenticated agent whose
// key was rotated out from under it) from an attack, we remember the spawns THIS
// process has successfully verified. A later signature failure for one of them is
// definitively a strand (an attacker's forged URL was never verified), so we can
// classify it, alert on it (once), and account for a rotate's blast radius.

export interface VerifiedSpawnMeta {
  role: string | null;
  harness: string | null;
  workspace: string | null;
  lastVerifiedMs: number;
}

/** Cap on distinct tracked spawns (LRU-evicted); bounds memory on a long-lived host. */
const VERIFIED_SPAWNS_CAP = 4000;

const __gv = globalThis as unknown as {
  __papercuspVerifiedSpawns?: Map<string, VerifiedSpawnMeta>;
};
function verifiedSpawns(): Map<string, VerifiedSpawnMeta> {
  return (__gv.__papercuspVerifiedSpawns ??= new Map());
}

/** Test-only: reset the in-process verified-spawn tracker. */
export function _resetVerifiedSpawns(): void {
  __gv.__papercuspVerifiedSpawns = new Map();
}

/**
 * Record a spawn whose signed URL just verified OK — called from the MCP handler
 * on every successful verification. Insertion-order = recency (re-inserted on
 * refresh); evicts the oldest past the cap.
 */
export function recordVerifiedSpawn(meta: {
  spawn: string | null | undefined;
  role?: string | null;
  harness?: string | null;
  workspace?: string | null;
  nowMs?: number;
}): void {
  const spawn = meta.spawn;
  if (!spawn) return;
  const m = verifiedSpawns();
  m.delete(spawn);
  m.set(spawn, {
    role: meta.role ?? null,
    harness: meta.harness ?? null,
    workspace: meta.workspace ?? null,
    lastVerifiedMs: meta.nowMs ?? Date.now(),
  });
  if (m.size > VERIFIED_SPAWNS_CAP) {
    const overflow = m.size - VERIFIED_SPAWNS_CAP;
    let i = 0;
    for (const k of m.keys()) {
      m.delete(k);
      if (++i >= overflow) break;
    }
  }
}

export type FailureClassification = 'rotation_strand' | 'unverified';

/**
 * Classify a verification failure AND consume the strand signal (dedupe): the
 * FIRST signature/expiry failure for a spawn this process previously verified is
 * a `rotation_strand`; we then drop it from the tracker so subsequent failures
 * for the same dead spawn don't re-alert. Single sync call → atomic within a tick.
 */
export function classifyAndConsumeFailure(reason: string, spawn: string | null | undefined): FailureClassification {
  const revocationReason = reason === 'invalid_signature' || reason === 'expired';
  if (revocationReason && spawn && verifiedSpawns().has(spawn)) {
    verifiedSpawns().delete(spawn);
    return 'rotation_strand';
  }
  return 'unverified';
}

/**
 * Actionable self-recovery guidance for a spawn-signing rejection, appended to
 * the agent-visible error (WI-3190). A rotation-strand session CANNOT self-heal
 * by retrying — every native mcp__papercusp__* call keeps failing identically —
 * so it must switch transports or be re-spawned. Runbook: EI-1740/EI-1750.
 */
export function spawnSigFailureGuidance(reason: string): string {
  switch (reason) {
    case 'invalid_signature':
    case 'expired':
      return (
        'Your per-spawn signing credential is no longer valid — the spawn-signing key was rotated ' +
        '(coarse revocation), so EVERY native mcp__papercusp__* call from this session will keep ' +
        'failing identically. This session cannot self-heal by retrying. Recover NOW: route tool ' +
        'calls through scripts/mcp-call.mjs (superuser bearer — bypasses spawn-URL signing) and/or ' +
        'ask your leader/orchestrator to RE-SPAWN this session. Runbook: docs:search "mcp-call.mjs ' +
        'recovery" (EI-1740/EI-1750).'
      );
    case 'missing_sig':
    case 'missing_exp':
    case 'missing_sig_required_mode':
      return (
        "This session's spawn URL is missing its signature. If tool access was working and this " +
        'appeared abruptly, the signing key was likely rotated — recover via scripts/mcp-call.mjs ' +
        '(superuser bearer) or request a re-spawn. Otherwise the MCP URL is malformed.'
      );
    default:
      return (
        'Spawn-signature verification failed. If tool access was working and stopped abruptly, the ' +
        'signing key was likely rotated — recover via scripts/mcp-call.mjs (superuser bearer) or ' +
        'request a re-spawn (runbook EI-1740/EI-1750).'
      );
  }
}
