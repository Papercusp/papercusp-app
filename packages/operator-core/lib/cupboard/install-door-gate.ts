/**
 * install-door-gate — the ONE place a production Cupboard install door meets the
 * entitled-delivery release chain (shared-pot-dao-cupboard-v1-2026-09-04 D-045 §3a).
 *
 * WHY THIS EXISTS
 * ---------------
 * `install-runner.runInstallPlan` and `entitled-delivery` (entitlement check,
 * signed-package verification, dependency ordering, install/update/rollback,
 * yank semantics) had ZERO production importers: the eight
 * `agent-tools/cupboard/install-*.ts` doors each called their own `*-io` core and
 * never touched the release chain at all, so P-009's whole deliverable was dead
 * code in production (WI-2146273, WI-2146325).
 *
 * WHY ONE GATE RATHER THAN EIGHT WIRINGS
 * --------------------------------------
 * The refusal rules here are SECURITY properties — an unentitled install, a
 * tampered package, a yanked version — and D-001 reuse-first exists precisely so
 * a guard of that kind does not live in eight hand-maintained copies that drift.
 * Each door supplies only what it alone knows (its listing kind, the id/ref the
 * caller asked for, the installing subject); every rule is decided once, here,
 * and every door inherits a fix to it.
 *
 * THE FAIL-CLOSED RULE, STATED PLAINLY
 * ------------------------------------
 * A listing with no published release chain cannot be entitlement-checked, so
 * the gate splits on PRICE rather than pretending it can:
 *
 *  - PAID listing, no chain  → REFUSED (`paid-listing-without-release-chain`).
 *    This is the hole D-045 found: a purchase grants a ledger entitlement that
 *    `authorizeDelivery` can never see, so an unchecked paid install is a paid
 *    unit handed over for free. Refusing is strictly safer than installing.
 *  - FREE/unpriced listing, no chain → `unmanaged`: the door proceeds with its
 *    existing `*-io` path. Nothing is being given away, and refusing would break
 *    every install that works today for no safety gain.
 *  - Chain present (paid OR free) → `managed`: signature verification, then
 *    `planInstall`/`planRollback`, then `runInstallPlan`, which is where the
 *    entitlement and yank decisions are actually made.
 *
 * `loadReleaseChain` is the single named seam a chain arrives through. Today no
 * production writer publishes distribution state, so it returns null and the
 * split above is what runs; when P-016's `p2p/commerce-events` stream is
 * persisted, it feeds THIS seam rather than a second door.
 */
import {
  planInstall,
  planRollback,
  verifySignedPackage,
  type DependencyGraph,
  type EntitlementProjection,
  type InstalledRelease,
  type VerifySignedPackageDeps,
  type VerifySignedPackageInput,
} from './entitled-delivery';
import {
  runInstallPlan,
  type ApplyInput,
  type InstallRunnerDeps,
  type RunInstallResult,
} from './install-runner';

/** What a door knows about the listing it was asked to install. */
export interface DoorListingFacts {
  readonly listingKind: string;
  readonly listingRef: string;
  readonly listingId?: string;
  /** `free` | `one-time` | `subscription` | `per-use`; null/undefined ⇒ unpriced. */
  readonly priceModel?: string | null;
  /** null/undefined ⇒ no price set. */
  readonly priceAmountMicros?: number | null;
  readonly releaseVersion?: string | null;
}

/**
 * A listing is PAID when it declares a non-free price model AND a positive
 * amount. Both halves are required deliberately: a `one-time` model with no
 * amount is an unfinished storefront row, not a paid unit, and treating it as
 * paid would refuse installs no one is being charged for.
 */
export function listingIsPaid(listing: DoorListingFacts): boolean {
  const model = (listing.priceModel ?? '').trim().toLowerCase();
  if (model === '' || model === 'free') return false;
  const amount = listing.priceAmountMicros;
  return typeof amount === 'number' && Number.isFinite(amount) && amount > 0;
}

/** The release chain for ONE install, as the production seam hands it over. */
export interface DoorReleaseChain {
  /** `releaseRef()` of the target — `listingKind:listingRef:releaseVersion`. */
  readonly releaseRef: string;
  readonly graph: DependencyGraph;
  /** What this subject already has, keyed by release ref. */
  readonly installed: ReadonlyMap<string, InstalledRelease>;
  /** Folded from the accepted commerce events — never re-derived here. */
  readonly entitlements: EntitlementProjection;
  /** The received manifest + the identity the caller asked for. */
  readonly signedPackage: VerifySignedPackageInput;
  readonly targetContentHash?: string;
  /**
   * Refs needing no entitlement. Empty by default so a loader that forgets stays
   * fail-closed, exactly as `runInstallPlan` requires.
   */
  readonly freeReleaseRefs?: ReadonlySet<string>;
}

export interface InstallDoorGateDeps {
  /** null ⇒ this listing publishes no release chain (see the fail-closed rule). */
  readonly loadReleaseChain: (
    listing: DoorListingFacts,
    context: { readonly subject: string; readonly operation: InstallDoorOperation },
  ) => Promise<DoorReleaseChain | null> | DoorReleaseChain | null;
  readonly runner: InstallRunnerDeps;
  readonly verify: VerifySignedPackageDeps;
  /**
   * Apply an ENCRYPTED release: decrypt the retrieved ciphertext with
   * `openRetrievedArtifact` (D-044 §2c), then write it into place.
   *
   * Absent by default and REQUIRED for a distribution carrying an encryption
   * envelope, because the ordinary `runner.apply` would otherwise write
   * ciphertext to disk as if it were the unit — a corruption that looks like a
   * successful install. Refusing is the fail-closed half of the same rule that
   * refuses a paid listing with no chain.
   */
  readonly openArtifact?: (input: ApplyInput) => InstalledRelease | Promise<InstalledRelease>;
  readonly nowMs?: () => number;
}

export type InstallDoorOperation = 'install' | 'rollback';

export type InstallDoorRefusalCode =
  | 'paid-listing-without-release-chain'
  | 'package-unverified'
  | 'not-entitled'
  | 'release-yanked'
  | 'plan-failed'
  | 'install-failed';

export type InstallDoorDecision =
  | {
      readonly ok: true;
      readonly mode: 'unmanaged';
      /** Why the release chain did not apply — surfaced, never silent. */
      readonly detail: string;
    }
  | {
      readonly ok: true;
      readonly mode: 'managed';
      readonly releaseRef: string;
      readonly run: Extract<RunInstallResult, { readonly ok: true }>;
    }
  | {
      readonly ok: false;
      readonly code: InstallDoorRefusalCode;
      readonly detail: string;
      readonly releaseRef?: string;
      readonly run?: Extract<RunInstallResult, { readonly ok: false }>;
    };

export interface GateCupboardInstallInput {
  readonly listing: DoorListingFacts;
  /** Buyer/org/seat identity the entitlement is looked up under. */
  readonly subject: string;
  readonly operation?: InstallDoorOperation;
  readonly offline?: boolean;
}

/**
 * Map a run failure onto the door's own vocabulary.
 *
 * Entitlement and yank refusals are named distinctly because a door surfaces
 * them to a human differently — "you do not own this" and "this version was
 * withdrawn" are different next actions, and collapsing both into a generic
 * failure is what makes an install refusal unactionable.
 */
function refusalFor(code: string): InstallDoorRefusalCode {
  if (code === 'no-entitlement' || code === 'entitlement-expired' || code === 'entitlement-revoked') {
    return 'not-entitled';
  }
  if (code === 'release-yanked' || code === 'yank-retention-expired') return 'release-yanked';
  return 'install-failed';
}

/**
 * Decide — and, when a release chain exists, CARRY OUT — an install at the door.
 *
 * Order is deliberate and each step is a precondition of the next: price decides
 * whether a missing chain is fatal; the signature proves the manifest describes
 * the release that was asked for before any plan is built from it; the plan
 * classifies install vs update vs rollback and names the restore point before
 * anything is fetched; and only then does `runInstallPlan` authorize, retrieve
 * and apply.
 */
export async function gateCupboardInstall(
  deps: InstallDoorGateDeps,
  input: GateCupboardInstallInput,
): Promise<InstallDoorDecision> {
  const operation: InstallDoorOperation = input.operation ?? 'install';
  const chain = await deps.loadReleaseChain(input.listing, { subject: input.subject, operation });

  if (!chain) {
    if (listingIsPaid(input.listing)) {
      return {
        ok: false,
        code: 'paid-listing-without-release-chain',
        detail:
          `${input.listing.listingKind}:${input.listing.listingRef} is priced but publishes no release chain — ` +
          'its entitlement cannot be checked, so the bytes are not handed over',
      };
    }
    return {
      ok: true,
      mode: 'unmanaged',
      detail: `${input.listing.listingKind}:${input.listing.listingRef} is unpriced and publishes no release chain`,
    };
  }

  const verified = await verifySignedPackage(deps.verify, chain.signedPackage);
  if (!verified.ok) {
    return {
      ok: false,
      code: 'package-unverified',
      detail: `${verified.code}: ${verified.detail}`,
      releaseRef: chain.releaseRef,
    };
  }

  const planned =
    operation === 'rollback'
      ? planRollback({ target: chain.releaseRef, graph: chain.graph, installed: chain.installed })
      : planInstall({
          target: chain.releaseRef,
          graph: chain.graph,
          installed: chain.installed,
          ...(chain.targetContentHash !== undefined ? { targetContentHash: chain.targetContentHash } : {}),
        });
  if (!planned.ok) {
    return {
      ok: false,
      code: 'plan-failed',
      detail: `${planned.code}: ${planned.detail}`,
      releaseRef: chain.releaseRef,
    };
  }

  // Encryption is decided per APPLIED release, not once for the target: a plan
  // can carry a public dependency beside an encrypted target, so the choice
  // belongs at the apply boundary where the distribution manifest is in hand.
  const runner: InstallRunnerDeps = {
    ...deps.runner,
    apply: (applyInput) => {
      if (applyInput.distribution.encryption !== null) {
        if (!deps.openArtifact) {
          throw new Error(
            `${applyInput.releaseRef} is an encrypted release and no openArtifact seam is configured — ` +
              'openRetrievedArtifact must decrypt the bytes before they are applied (D-044 §2c)',
          );
        }
        return deps.openArtifact(applyInput);
      }
      return deps.runner.apply(applyInput);
    },
  };

  const run = await runInstallPlan(runner, {
    plan: planned,
    subject: input.subject,
    entitlements: chain.entitlements,
    installed: chain.installed,
    nowMs: (deps.nowMs ?? Date.now)(),
    ...(input.offline !== undefined ? { offline: input.offline } : {}),
    ...(chain.freeReleaseRefs ? { freeReleaseRefs: chain.freeReleaseRefs } : {}),
  });

  if (!run.ok) {
    return {
      ok: false,
      code: refusalFor(run.failure.code),
      detail: `${run.failure.releaseRef}: ${run.failure.code} — ${run.failure.detail}`,
      releaseRef: chain.releaseRef,
      run,
    };
  }

  return { ok: true, mode: 'managed', releaseRef: chain.releaseRef, run };
}
