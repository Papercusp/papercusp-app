/**
 * hive-epoch-boot-deps — the boot-scope COMPOSITION of the read-plane re-key apply/capture
 * deps (shared-hive-rekey-2026-06-19, K's lane / su-ee7e9). ONE call builds the crypto +
 * provider + owner|member key resolver + pending buffer + the decrypt gate / encrypt
 * capability — OR returns null when the re-key is not active for this harness. The two
 * thread sites stay one-liners:
 *   - boot.ts (decrypt gate → mergeOpts.applyImpl): `rekeyDeps ? rekeyDeps.epochGate(enforcedApply) : enforcedApply`.
 *   - wire-outbox.ts (encrypt capability → startOutboxDrain): `{ epochEncrypt: rekeyDeps?.epochEncrypt }`.
 *
 * CHEAP OFF-PATH (7dcd8's contract): `wireOutboxForHarness` runs for EVERY harness at boot,
 * most non-hive — so the FLAG is checked first (one cached read; default-off returns null
 * immediately, byte-for-byte today's behavior), and the LocalDevice / crypto / keychain are
 * touched ONLY for an active re-key hive. Call it ONCE per boot (328af invariant 2); store
 * the result in a boot-scope var both sites reference.
 *
 * This owns the "first real LocalDevice" build (the same device keypair the announce uses:
 * resolveLocalGithubIdentity → resolveDeviceKeychainId → loadOrGenerateDeviceKeypair), so
 * the unknown lives in one tested place. Pure composition of already-unit-tested components
 * (the gate/resolver/provider/buffer).
 */
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { createEpochKeyProvider } from './hive-epoch-key-provider';
import { createPgWrappedKeyLoader, hasRekeyEvidence } from './hive-epoch-keys-store';
import { createBundledEpochKeyProvider } from './bundled-epoch-key-provider';
import { chainEpochKeyProviders } from './epoch-key-provider-chain';
import { resolveSeedDir } from './restore-hive-seed';
import { resolveHiveEpochCrypto, type EpochKeyProvider } from './hive-epoch-serving';
import { getHiveEpoch } from './hive-epoch-state';
import { PendingEpochContent } from './pending-epoch-content';
import { isCanonicalHiveOwner } from '../../hive-identity';
import { potHomeSlugForHarness } from '../../hive-federation';
import { resolveDeviceKeychainId } from '../../identity/device-keychain-id';
import { loadOrGenerateDeviceKeypair } from '../../identity/attest';
import {
  buildEpochKeyResolver,
  buildEpochDecryptGate,
  buildEpochEncryptCapability,
  buildEpochKeySeek,
} from './hive-epoch-op-gate';
import type { EpochKeySeek } from './read-merge';
import { recordBootEvent, type BootHistoryKind } from './boot-history';
import type { OpEnvelope } from './op-envelope-types';
import type { EpochEncryptCapability } from './outbox-drain';

export interface HiveRekeyBootDeps {
  /** The Hive home slug (= potId) — also what the drain hook keys `pending.drainEpoch` on. */
  potHomeSlug: string;
  /** Wrap the per-pass enforcement stack OUTERMOST: `applyImpl = epochGate(enforcedApply)`. */
  epochGate: (inner: (op: OpEnvelope) => Promise<boolean>) => (op: OpEnvelope) => Promise<boolean>;
  /** Inject into `startOutboxDrain({ epochEncrypt })`. */
  epochEncrypt: EpochEncryptCapability;
  /** The shared deferral buffer — the drain hook (`onEpochKeyApplied`) calls `drainEpoch`. */
  pending: PendingEpochContent;
  /** D-016: whether this device resolves the epoch key now (a read; it never mints). The
   *  drain releases ops evicted under that epoch only when this says yes. */
  hasEpochKey: (potId: string, epoch: number) => Promise<boolean>;
  /**
   * P-524: inject into the merge options (`keySeek`) so a key miss fetches this device's
   * key row ahead of content. Absent when this box has no member device identity: a
   * bundled-seed-only install has no federated key row to seek.
   */
  keySeek?: EpochKeySeek;
}

/**
 * WI-3232 (offline pot): build the BUNDLED (offline) seed epoch-key provider when a seed
 * ships with this install, else null. Cheap: {@link resolveSeedDir} is an env/path check and
 * the provider reads epoch-keys.json LAZILY (only on first `keyForEpoch`), so attaching it
 * costs nothing until a decrypt actually needs it. Best-effort → null (a missing/unreadable
 * seed dir simply means no bundled fallback). A non-papercusp hive on a seeded install gets a
 * provider whose lookups all miss (its id is not in epoch-keys.json) ⇒ the chain stays
 * effectively member-only for it.
 */
function tryBuildBundledSeedProvider(): EpochKeyProvider | null {
  try {
    const resolved = resolveSeedDir();
    if (resolved.disabled || !resolved.seedDir) return null;
    return createBundledEpochKeyProvider(resolved.seedDir);
  } catch {
    return null;
  }
}

/**
 * Build the re-key apply/capture deps for a harness boot, or null when the re-key is NOT
 * active for it (flag off / definitively not a hive). Once re-key is enabled, an ambiguous
 * Hive-scope lookup or a confirmed Hive without a usable dependency set FAILS CLOSED: callers
 * must not confuse temporary key/identity/PG unavailability with permission to emit plaintext.
 */
export async function buildHiveRekeyBootDeps(opts: {
  workspaceId: string;
  harnessSlug: string;
}): Promise<HiveRekeyBootDeps | null> {
  // 1. Flag FIRST — the cheapest off-path (cached read). Explicitly OFF ⇒ null ⇒ unchanged.
  let rekeyEnabled: boolean;
  try {
    rekeyEnabled = await getFlag(FLAGS.POT_REKEY, 'system');
  } catch (e) {
    throwRekeyBootUnavailable(opts, 'resolve POT_REKEY state', e);
  }
  if (!rekeyEnabled) {
    // seed-57-drop diagnostic: this bail is BEFORE the try/dbg below, so it needs its own
    // guarded log — a flag off on the shipped build silently disables the whole decrypt gate.
    if (process.env.PAPERCUSP_EPOCH_BOOT_DEBUG)
      console.error('[epoch-boot]', 'GATE NOT BUILT: FLAGS.POT_REKEY off', {
        workspaceId: opts.workspaceId,
        harnessSlug: opts.harnessSlug,
      });
    return null;
  }
  // Steps 2-4 are fail-closed for ambiguity. POT_REKEY is default-ON, so a transient PG /
  // identity / keychain failure cannot mean "plaintext is allowed". The two explicit null
  // paths are the only safe off-paths: flag OFF, or a definitive non-Hive lookup.
  try {
    // seed-57-drop diagnostic (env-gated, off by default): the gate keys on the
    // workspace-resolved potHomeSlug — a fresh packaged install booting under the
    // 'default' workspace while the hive lives in 'papercusp-workspace' resolves null →
    // NO gate → encrypted content never decrypts → only plaintext rows project (the 57).
    // Set PAPERCUSP_EPOCH_BOOT_DEBUG=1 to dump the exact branch to stderr/serve.log.
    const dbg = process.env.PAPERCUSP_EPOCH_BOOT_DEBUG
      ? (msg: string, o?: unknown) => console.error('[epoch-boot]', msg, o ?? '')
      : () => {};
    // 2. The re-key applies only to a hive harness.
    const potHomeSlug = await potHomeSlugForHarness(opts.workspaceId, opts.harnessSlug);
    dbg('resolved', { workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug, potHomeSlug });
    if (!potHomeSlug) {
      dbg('GATE NOT BUILT: potHomeSlugForHarness → null (harness not a registered hive in this workspace)');
      return null;
    }
    // WI-3232 (offline pot): a BUNDLED seed epoch key is an OFFLINE key source needing NO
    // device identity / PG-wrapped row. Attached (as the chain's FALLBACK) whenever a seed
    // ships this hive's key, so a fresh NO-ADMISSION install decrypts the restored corestore
    // content through this SAME gate. Null on dev boxes + non-seed installs ⇒ the chain is
    // member-only, byte-for-byte today's behavior.
    const bundledProvider = tryBuildBundledSeedProvider();
    dbg('bundledProvider', { present: bundledProvider != null });

    // 3. This device's identity — the FIRST real LocalDevice (same keypair the announce
    //    uses). No local GitHub identity ⇒ no MEMBER (PG-wrapped) provider on this box; that
    //    is fine ONLY when the bundled seed provider can serve the key (the offline pot).
    const { resolveLocalGithubIdentity } = await import('../../identity/resolve-local-github-identity');
    const ident = await resolveLocalGithubIdentity();
    // No member key source AND no bundled key ⇒ this CONFIRMED Hive can resolve no epoch
    // key. Failing open here would let wire-outbox start without an encryptor and append
    // eligible content plaintext, violating the forward read cut.
    if (ident.kind !== 'ok' && !bundledProvider) {
      dbg('GATE FAILED CLOSED: no member identity AND no bundled provider (no epoch-key source)', {
        identKind: ident.kind,
      });
      throw new Error(`no epoch-key source for confirmed Hive (identity=${ident.kind})`);
    }

    // 4. Compose the (already unit-tested) crypto / provider / resolver / gate / capability.
    const crypto = await resolveHiveEpochCrypto(true);
    let memberProvider: EpochKeyProvider | null = null;
    let devicePubkeyBase64: string | null = null;
    if (ident.kind === 'ok') {
      const localDevice = await loadOrGenerateDeviceKeypair(resolveDeviceKeychainId(ident.githubUserId));
      devicePubkeyBase64 = localDevice.pubkeyBase64;
      // WI-2009 / wake-#5742 (v3 instrumentation, leg a): the SPLIT-IDENTITY class —
      // presence stamps one device pubkey while THIS tier resolves another (an OS
      // keychain unreadable in the service context → a different file-tier key, or a
      // per-boot regenerate). Record what the epoch tier ACTUALLY resolved + which
      // keychain tier(s) hold the id, so a mismatch is diagnosable from boot-history.
      try {
        const { keychainProbeTiers } = await import('../../identity/keychain');
        const tiers = await keychainProbeTiers(localDevice.keychainId);
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'epoch_boot_device',
          `pubkey=${localDevice.pubkeyBase64} keychainId=${localDevice.keychainId} tiers=secretTool:${tiers.secretTool},securityCli:${tiers.securityCli},file:${tiers.file}` +
            // Only emitted when true, so a healthy boot record is unchanged.
            (tiers.mirrorsDiverged
              ? ' MIRRORS_DIVERGED=true (the configured and legacy encrypted identity ' +
                'mirrors hold DIFFERENT device keys — every keychain load fails closed ' +
                'and the P2P substrates stay unbooted; converge both mirrors onto the ' +
                'ATTESTED pubkey before restart)'
              : ''),
        );
      } catch {
        /* diagnostics must never affect boot */
      }
      memberProvider = createEpochKeyProvider(
        crypto,
        createPgWrappedKeyLoader(opts.workspaceId, potHomeSlug),
        localDevice,
      );
    }
    // WI-3232: member (federated, all granted epochs) FIRST; bundled seed key (offline,
    // cutAtEpoch) as the fallback — see epoch-key-provider-chain. A one-provider chain is
    // transparent, so an online member with no seed is byte-for-byte unchanged.
    const provider = chainEpochKeyProviders([memberProvider, bundledProvider]);
    const resolveKey = buildEpochKeyResolver({
      crypto,
      provider,
      // WI-1981 wake-#5515: ownership = the held key MATCHES the hive's canonical
      // identity — never mere key presence. A stale divergent file-tier key made a
      // JOINER resolve isOwner=true here and MINT fresh-random epoch keys instead of
      // unwrapping the owner's wrapped rows → permanent mutual epoch_decrypt_fail
      // (proven live tower↔VM 2026-07-03, with NO re-mint of the hive key).
      isOwner: () => isCanonicalHiveOwner(opts.workspaceId, potHomeSlug),
    });
    const pending = new PendingEpochContent();
    // P-524: a member device looks ahead for its own key row when content arrives first.
    const seeker = devicePubkeyBase64 ? buildEpochKeySeek(devicePubkeyBase64) : null;
    const epochGate = buildEpochDecryptGate({
      crypto,
      resolveKey,
      potId: potHomeSlug,
      pending,
      // WI-808: surface the gate's otherwise-silent per-op verdict into boot-history so a
      // joiner content drop names its cause (decrypt-fail vs defer) instead of vanishing.
      onTrace: (phase, detail) => recordBootEvent(opts.workspaceId, opts.harnessSlug, phase as BootHistoryKind, detail),
      ...(seeker ? { onKeyMissing: seeker.onKeyMissing } : {}),
    });
    const epochEncrypt = buildEpochEncryptCapability({
      crypto,
      resolveKey,
      potId: potHomeSlug,
      getCurrentEpoch: () => getHiveEpoch(opts.workspaceId, potHomeSlug),
      // WI-4075: enables immediate (not just TTL-bound) cache invalidation on a local
      // epoch advance — see buildEpochEncryptCapability's doc comment.
      workspaceId: opts.workspaceId,
      // WI-2106: lets the gate tell "never re-keyed" (plaintext is correct) apart from
      // "epoch row hasn't backfilled yet" (plaintext would break the read cut). Without
      // this dep the gate keeps the old always-plaintext-at-baseline behavior.
      hasRekeyEvidence: () => hasRekeyEvidence(opts.workspaceId, potHomeSlug),
    });
    // WI-808: the gate IS installed (applyImpl will be epochGate(enforcedApply)). Records the
    // resolved potHomeSlug — which is the AAD `potId`, so a decrypt-fail's hive=… can be
    // compared owner↔joiner to confirm/refute the local-slug AAD-mismatch hypothesis.
    recordBootEvent(opts.workspaceId, opts.harnessSlug, 'epoch_gate_built', `potHomeSlug=${potHomeSlug}`);
    // seed-57-drop diagnostic: the SUCCESS path — the gate IS installed. If this prints yet the
    // fold still drops to 57, the bug is DOWNSTREAM of gate-build (resolver key / AAD / opId),
    // not the workspace-context bail; if it does NOT print, the gate never built (bail above).
    dbg('GATE BUILT', {
      potHomeSlug,
      memberProvider: memberProvider != null,
      bundledProvider: bundledProvider != null,
    });
    const hasEpochKey = (potId: string, epoch: number): Promise<boolean> =>
      provider.keyForEpoch(potId, epoch).then(
        () => true,
        () => false,
      );
    return {
      potHomeSlug,
      epochGate,
      epochEncrypt,
      pending,
      hasEpochKey,
      ...(seeker ? { keySeek: seeker.keySeek } : {}),
    };
  } catch (e) {
    throwRekeyBootUnavailable(opts, 'compose confirmed Hive dependencies', e);
  }
}

/**
 * Preserve WI-755's console-safe diagnostic channel while making the security verdict
 * unambiguous to every caller: dependency ambiguity is an error, never a plaintext mode.
 */
function throwRekeyBootUnavailable(
  opts: { workspaceId: string; harnessSlug: string },
  phase: string,
  cause: unknown,
): never {
  const detail = cause instanceof Error ? cause.message : String(cause);
  try {
    recordBootEvent(
      opts.workspaceId,
      opts.harnessSlug,
      'epoch_gate_skipped' as BootHistoryKind,
      `buildHiveRekeyBootDeps failed closed (${phase}): ${detail}`,
    );
  } catch {
    /* diagnostics must never mask the fail-closed verdict */
  }
  const error = new Error(`Hive re-key boot dependencies failed closed (${phase}): ${detail}`);
  (error as Error & { cause?: unknown }).cause = cause;
  throw error;
}

/**
 * Build JUST the member-side EpochKeyProvider for (workspace, potHomeSlug) — the
 * device-identity + crypto + provider slice that {@link buildHiveRekeyBootDeps} also
 * composes inline (steps 3–4a). Returns null when this box has no local device
 * identity (⇒ it can unwrap no epoch key). Best-effort: any resolution hiccup ⇒ null,
 * so the caller degrades to a cold path rather than failing.
 *
 * Consumer: the post-admission deferred-git-restore trigger (deferred-git-restore.ts,
 * plan hive-seed-bundle-2026-07-04 P-010) — a git seed sealed with keyRef via='epoch'
 * is decrypted with the hive epoch key at cutAtEpoch, which this provider unwraps from
 * THIS device's `hive_epoch_keys` row (guaranteed present for a fresh member by Q-4 /
 * grantEpochKeysToMembers). Not flag-gated: unlike the re-key gate it does no writes
 * and only READS a key the member already holds. (buildHiveRekeyBootDeps keeps its own
 * inline assembly to avoid churning that boot-critical path; the two could unify later.)
 */
export async function buildMemberEpochKeyProvider(opts: {
  workspaceId: string;
  potHomeSlug: string;
}): Promise<EpochKeyProvider | null> {
  try {
    const { resolveLocalGithubIdentity } = await import('../../identity/resolve-local-github-identity');
    const ident = await resolveLocalGithubIdentity();
    if (ident.kind !== 'ok') return null;
    const localDevice = await loadOrGenerateDeviceKeypair(resolveDeviceKeychainId(ident.githubUserId));
    const crypto = await resolveHiveEpochCrypto(true);
    return createEpochKeyProvider(crypto, createPgWrappedKeyLoader(opts.workspaceId, opts.potHomeSlug), localDevice);
  } catch {
    return null;
  }
}
