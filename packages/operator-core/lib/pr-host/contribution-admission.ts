/**
 * contribution-admission — the CODE-PLANE contributor-revocation gate for the
 * fork→PR path (PLAN pr-system-completion-dogfood, PR-5 item 4).
 *
 * ## The silent no-op this closes
 * SUBSTRATE revocation already shipped: an owner adds a target's device pubkeys
 * to `revoked_pubkeys` (hive-revoke-contributor.ts), and the boot-time read
 * admission union (`loadRevokedHivePubkeys`) denies those devices on every peer's
 * next read-merge — the target stops being able to FEDERATE content.
 *
 * But the CODE plane — a contributor's fork→PR arriving over GitHub — never
 * consulted that set. `tryAutoApprove`/`tryAutoMerge` (and the manual `reviewPr`
 * path) gate on trust-list + checks-green, never on revocation. So a revoked
 * contributor's PR still got auto-approved + merged: the
 * `non-collaborator-join-fork-pr` D-001 owner-revocation was a SILENT NO-OP on
 * contribution admission. This module is that gate.
 *
 * ## The predicate
 * `isHiveContributorRevoked` answers "has this GitHub user lost contribution
 * admission to this Hive?" — TRUE iff they ARE a bound member (≥1 device
 * attestation) but EVERY one of their bound device pubkeys is now in the Hive's
 * revoked union (no active device left). That is exactly the state
 * `revokeHiveContributor` produces (it adds ALL the target's device pubkeys to
 * the owner's `revoked_pubkeys`). A user with no member row / no devices is NOT
 * "revoked" here — that case is owned by the existing trust gate (an unknown
 * author is never trusted), not by revocation.
 *
 * ## How it wires in
 * The pure decision functions (`tryAutoApprove`/`tryAutoMerge`) take an
 * `authorRevoked` boolean and short-circuit to `skipped_revoked` BEFORE the
 * trust/checks gates — revocation is the strongest deny. The live chokepoints
 * (the manual `reviewPr` route today; PR-1's poll daemon once it lands) resolve
 * the PR author's revocation via this predicate and pass the boolean in.
 *
 * Every external read is an injected seam so the predicate is unit-testable with
 * no PG. FAIL-SAFE: a read error yields `false` (NOT revoked) — revocation layers
 * ON TOP of the trust/checks gates, so a transient membership-read failure must
 * not lock out a legitimate contributor; the trust gate still protects against an
 * untrusted author. The error is logged, never thrown.
 */
import type { Sql } from 'postgres';
import { loadHiveMemberDevicePubkeys, loadRevokedHivePubkeys } from '../hive-membership-store';
// EI-18777176681958978 (found by the branded-scope typecheck, NOT in the filing's site list):
// `potHomeSlug` reaches this gate from the PR-host caller as a LOCAL pot handle. Reading
// revocations under it on a joiner returns an EMPTY union, so this gate — whose whole job is
// denying a revoked contributor's PR — would admit every revoked device. The resolved scope is
// used for the DEVICE read too, since `pot_members` rows live under the same federated scope.
import { resolveFederatedPotScope, type FederatedPotScope } from '../federated-pot-scope';

export interface IsHiveContributorRevokedOpts {
  workspaceId: string;
  /** The Hive's home_slug (the hive_members PK handle). */
  potHomeSlug: string;
  /** The PR author's verified numeric GitHub user id. */
  githubUserId: number;
  /** Injected: the member's bound device pubkeys. Default: loadHiveMemberDevicePubkeys. */
  loadDevicePubkeys?: (
    workspaceId: string,
    potHomeSlug: string,
    githubUserId: number,
    sql?: Sql,
  ) => Promise<string[]>;
  /** Injected: the Hive's revoked-pubkey union. Default: loadRevokedHivePubkeys — called with
   *  the FEDERATED scope this fn resolves from `potHomeSlug` (EI-18777176681958978). */
  loadRevoked?: (
    workspaceId: string,
    potHomeSlug: FederatedPotScope,
    sql?: Sql,
  ) => Promise<Set<string>>;
  /** Injected logger (tests). */
  log?: (msg: string) => void;
  sql?: Sql;
}

/**
 * Has this GitHub user lost contribution admission to the Hive? TRUE iff they are
 * a bound member with ≥1 device but every device pubkey is in the revoked union.
 * Fail-safe: false on any read error (the trust gate still protects).
 */
export async function isHiveContributorRevoked(
  opts: IsHiveContributorRevokedOpts,
): Promise<boolean> {
  if (!opts.workspaceId || !opts.potHomeSlug) return false;
  if (!Number.isInteger(opts.githubUserId) || opts.githubUserId <= 0) return false;

  const loadDevicePubkeys = opts.loadDevicePubkeys ?? loadHiveMemberDevicePubkeys;
  const loadRevoked = opts.loadRevoked ?? loadRevokedHivePubkeys;

  try {
    // Resolve ONCE and use the same scope for both reads: the device attestations and the
    // revocation union are columns of the SAME pot_members row, so reading them under
    // different scopes could "find no devices" while a revocation for them exists (or
    // vice-versa). An injected `loadRevoked` seam is handed the resolved scope too — a test
    // stub sees a value equal to its own input whenever local == federated.
    const scope = await resolveFederatedPotScope(opts.workspaceId, opts.potHomeSlug, {
      ...(opts.sql ? { sql: opts.sql } : {}),
    });
    const devices = await loadDevicePubkeys(
      opts.workspaceId,
      scope,
      opts.githubUserId,
      opts.sql,
    );
    // No bound device ⇒ not a "revoked member" — the trust gate handles unknowns.
    if (devices.length === 0) return false;

    const revoked = await loadRevoked(opts.workspaceId, scope, opts.sql);
    // Revoked iff EVERY bound device is in the revoked union (no active device).
    return devices.every((pk) => revoked.has(pk));
  } catch (e) {
    opts.log?.(
      `[contribution-admission] revocation read failed for gh#${opts.githubUserId} on ${opts.potHomeSlug}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return false;
  }
}

/**
 * Resolve the Hive home slug a harness belongs to, for the code-plane gate.
 * A member project is registered with `hive_slug = <hive home slug>`
 * (_create_from_repo.ts) — so the harness's own registry row carries it. Returns
 * null for a solo/unbound harness (no Hive ⇒ no contributor revocation applies).
 * Best-effort: null on any resolution failure.
 */
export async function resolveHarnessPotHomeSlug(
  harnessSlug: string,
  resolveProject?: (slug: string) => Promise<unknown>,
): Promise<string | null> {
  try {
    const resolve =
      resolveProject ??
      (async (s: string) => (await import('../harness-core')).resolveProject(s));
    const project = (await resolve(harnessSlug)) as { hive_slug?: string | null } | null;
    const homeSlug = project?.hive_slug ?? null;
    return homeSlug && homeSlug.length > 0 ? homeSlug : null;
  } catch {
    return null;
  }
}

/**
 * Convenience for the live chokepoints: is the PR author a revoked contributor on
 * the Hive this harness belongs to? Resolves the harness→Hive link, then the
 * revocation predicate. False for a solo/unbound harness (no Hive) and false
 * fail-safe on any error.
 */
export async function isPrAuthorRevoked(opts: {
  workspaceId: string;
  harnessSlug: string;
  githubUserId: number;
  loadDevicePubkeys?: IsHiveContributorRevokedOpts['loadDevicePubkeys'];
  loadRevoked?: IsHiveContributorRevokedOpts['loadRevoked'];
  resolveProject?: (slug: string) => Promise<unknown>;
  /**
   * Observability probe (GAP review 2026-06-20): the per-harness SUBSTRATE revoked
   * set for a NON-hive shared harness. Default: loadRevokedPubkeys. See the
   * design-boundary note below.
   */
  probeLegacyRevocation?: (o: { workspaceId: string; harnessSlug: string }) => Promise<Set<string>>;
  log?: (msg: string) => void;
  sql?: Sql;
}): Promise<boolean> {
  const potHomeSlug = await resolveHarnessPotHomeSlug(opts.harnessSlug, opts.resolveProject);
  if (!potHomeSlug) {
    // ── DESIGN BOUNDARY (GAP review 2026-06-20 — pr5-impl + pr3-impl consensus, option (b)) ──
    // The code-plane contribution gate keys on HIVE membership BY DESIGN. A shared harness
    // that is NOT a hive member (`hive_slug` null) uses the SUBSTRATE device-revocation plane
    // (`contributors.revoked_pubkeys`, read-admission) — a DIFFERENT layer from "should this
    // GitHub PR merge to canonical." Wiring the substrate set into the PR-merge decision would
    // be a category error (PR-merge authority is the hive membership/trust model), and this
    // gate is fail-SAFE — it must never lock a solo-harness contributor out of their own PR.
    // So we do NOT change the decision (return false = not code-plane-revoked). BUT to avoid
    // silent rot if that assumed-dead non-hive fork→PR path ever goes live, we LOUDLY log when
    // such a harness nonetheless carries substrate revocations — so a regression is SEEN, not
    // silently auto-merged. (fork-pr-on-feature-pass technically accepts any shared harness, so
    // this is observability, not purely theoretical.)
    await probeLegacyRevocationObservability(opts);
    return false;
  }
  return isHiveContributorRevoked({
    workspaceId: opts.workspaceId,
    potHomeSlug,
    githubUserId: opts.githubUserId,
    ...(opts.loadDevicePubkeys ? { loadDevicePubkeys: opts.loadDevicePubkeys } : {}),
    ...(opts.loadRevoked ? { loadRevoked: opts.loadRevoked } : {}),
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.sql ? { sql: opts.sql } : {}),
  });
}

/**
 * Fail-safe observability for the non-hive design boundary above. Best-effort: a
 * non-empty per-harness substrate revoked set on a harness with no hive → a loud
 * warning. NEVER throws and NEVER changes a merge decision.
 */
async function probeLegacyRevocationObservability(opts: {
  workspaceId: string;
  harnessSlug: string;
  githubUserId: number;
  probeLegacyRevocation?: (o: { workspaceId: string; harnessSlug: string }) => Promise<Set<string>>;
  log?: (msg: string) => void;
}): Promise<void> {
  try {
    const probe =
      opts.probeLegacyRevocation ??
      (async (o: { workspaceId: string; harnessSlug: string }) => {
        const { loadRevokedPubkeys } = await import('../sync/hyperbee/load-revoked-pubkeys');
        return loadRevokedPubkeys(o);
      });
    const revoked = await probe({ workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug });
    if (revoked && revoked.size > 0) {
      const warn = opts.log ?? ((m: string) => console.warn(m));
      warn(
        `[contribution-admission] OBSERVABILITY: non-hive shared harness '${opts.harnessSlug}' has ` +
          `${revoked.size} substrate-revoked device pubkey(s), but the code-plane revocation gate is ` +
          `HIVE-ONLY by design — PR author gh#${opts.githubUserId} is NOT gated by it here. If this ` +
          `non-hive fork→PR path is live, the owner must also remove the contributor from ` +
          `trusted_authors (PR-merge authority is the hive/trust model, not the substrate set). ` +
          `(merge decision unchanged — observability only)`,
      );
    }
  } catch {
    /* best-effort observability — never throw, never affect the decision */
  }
}
