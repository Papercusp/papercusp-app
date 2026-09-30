/**
 * hive-epoch-op-gate — the apply/capture CRYPTO GLUE for the read-plane re-key
 * (shared-hive-rekey-2026-06-19, K's lane / su-ee7e9). Brackets the federated op path
 * with epoch encryption, the two halves the other lanes inject into:
 *
 *   - buildEpochEncryptCapability → the `EpochEncryptCapability` the outbox drain (7dcd8)
 *     injects: encrypt a content op's payload under the CURRENT epoch key + stamp its epoch.
 *   - buildEpochDecryptGate → the apply-side gate (328af's `mergeOpts.applyImpl` stub):
 *     decrypt an epoch-stamped op BEFORE EN-4/EN-2/scopedApply see it (so policy/rate read
 *     PLAINTEXT); DEFER (J's PendingEpochContent) when the key hasn't arrived; the C-001
 *     read cut falls out for free — a removed member's key row never arrives, so its
 *     epoch-N+ content defers forever (bounded), never decrypted.
 *
 * Both halves share ONE epoch-key resolver (owner `deriveEpochKey` | member unwrap via the
 * EpochKeyProvider) + the SAME `deriveOpId` AAD + `potId` = the hive HOME slug, so
 * encrypt↔decrypt are symmetric. Pure glue over injected seams (crypto, the key resolver,
 * the current-epoch reader, the pending buffer) — fully unit-testable without PG/boot.
 *
 * Op-selection (WHICH ops get encrypted) is 7dcd8's `shouldEncryptOpForRekey`, applied in
 * the drain BEFORE `encryptOp` is called — this module never sees a control-plane op.
 */
import type { EpochKey, HiveEpochCrypto } from './hive-epoch-crypto';
import { randomUUID } from 'node:crypto';
import { currentStageAttempt, traceStageAwait, traceStageSync } from './stage-stall-log';
import type { OpEnvelope } from './op-envelope-types';
import type { LocalWriteOp } from './boot';
import type { EpochEncryptCapability } from './outbox-drain';
import type { PendingEpochContent } from './pending-epoch-content';
import { runWithDeferralSource } from './deferral-source';
import type { EpochKeyProvider } from './hive-epoch-serving';
import { encryptOpPayload, decryptOpPayload } from './hive-epoch-serving';
import { BASELINE_EPOCH, getEpochGeneration } from './hive-epoch-state';
import { EpochKeyUnavailableError } from './hive-epoch-key-provider';
import type { EpochKeyMiss, EpochKeySeek } from './read-merge';
import { HIVE_EPOCH_KEYS_TABLE_TAG, epochKeyRowKey } from './projections/hive-epoch-keys';

/** Resolve the epoch key for `(potId, epoch)` on THIS peer: owner derives, member
 *  unwraps. Rejects (EpochKeyUnavailableError) on a member whose wrapped row hasn't
 *  arrived — which the decrypt gate turns into a DEFER (the cut, when it never comes). */
export type EpochKeyResolver = (potId: string, epoch: number) => Promise<EpochKey>;

/**
 * Build the SHARED owner|member key resolver both halves use. The OWNER (holds the hive
 * private key → `isOwner` true) mints via `crypto.deriveEpochKey`; a MEMBER unwraps its
 * wrapped `hive_epoch_keys` row via the provider (which rejects EpochKeyUnavailableError
 * until the row arrives — never, for a removed member). Owner-ness is fixed per hive, so
 * it's resolved once + cached.
 */
export function buildEpochKeyResolver(deps: {
  crypto: HiveEpochCrypto;
  provider: EpochKeyProvider;
  isOwner: () => Promise<boolean>;
}): EpochKeyResolver {
  let ownerCache: boolean | undefined;
  // Epoch keys are IMMUTABLE per (hive, epoch) — a re-key advances the epoch NUMBER, it
  // never rotates an existing epoch's key. So a successfully-resolved key can be cached
  // for the resolver's lifetime: this keeps the per-op gate cost O(1) even though the
  // owner path now consults the provider (a PG/bundled lookup) before falling back to
  // deriveEpochKey. Only SUCCESSES are cached — a member miss must keep throwing so the
  // gate DEFERS and retries once the epoch-key row federates in.
  const keyCache = new Map<string, EpochKey>();
  return async (potId, epoch) => {
    const cacheKey = `${potId}:${epoch}`;
    const cached = keyCache.get(cacheKey);
    if (cached) {
      currentStageAttempt()?.cache('key-provider', 'hit');
      return cached;
    }
    if (ownerCache === undefined) ownerCache = await traceStageAwait('owner-check', () => deps.isOwner());
    let key: EpochKey;
    if (!ownerCache) {
      key = await traceStageAwait('key-provider', () => deps.provider.keyForEpoch(potId, epoch));
    } else {
      // OWNER. Resolve the AUTHORITATIVE distributed key FIRST — the provider chain
      // (federated `hive_epoch_keys` rows / the BUNDLED seed key) — and mint via
      // deriveEpochKey ONLY as the fallback for a genuinely NEW epoch this owner is
      // advancing to. `deriveEpochKey` is get-or-CREATE, correct ONLY for the epoch
      // ADVANCER; calling it to READ an already-existing epoch on a box that never minted
      // it — a fresh SEEDED install that adopts the shared hive identity
      // (DOGFOOD_PAPERCUSP_POT_SHARE → isOwner=true) but boots with an EMPTY epoch
      // keychain — MINTS a fresh-random DIVERGENT key that cannot decrypt the seed's
      // existing epoch-ciphertext. That is the WI-1981 epoch-poison class and the seed
      // "57-drop": the seed's epoch-1 content decrypts ONLY under the bundled key, never a
      // freshly-minted one, so a mint-at-read silently drops every encrypted row (the
      // gate's decrypt-fail is `return false`, no throw). Provider-FIRST also makes this
      // ROBUST to a keychain already poisoned by a prior mis-mint: the authoritative
      // bundled/federated key wins over a stale local `deriveEpochKey` residue. On a real
      // owner/advancer box (no bundled seed, no self-wrapped row) the provider simply
      // misses and we fall through to deriveEpochKey — its own minted key — unchanged.
      try {
        key = await traceStageAwait('key-provider', () => deps.provider.keyForEpoch(potId, epoch));
      } catch {
        key = await deps.crypto.deriveEpochKey(potId, epoch);
      }
    }
    keyCache.set(cacheKey, key);
    return key;
  };
}

/** The json-safe ciphertext envelope carried in an encrypted op's `value`. */
interface RekeyValue {
  __rekey: string; // base64(ciphertext)
}
function isRekeyValue(v: unknown): v is RekeyValue {
  return !!v && typeof v === 'object' && typeof (v as { __rekey?: unknown }).__rekey === 'string';
}
function encodeCiphertext(ct: Uint8Array): RekeyValue {
  return { __rekey: Buffer.from(ct).toString('base64') };
}
function decodeCiphertext(v: unknown): Uint8Array | null {
  return isRekeyValue(v) ? new Uint8Array(Buffer.from(v.__rekey, 'base64')) : null;
}
/** op `value` (arbitrary JSON) ↔ bytes for the AEAD payload. Stable, deterministic. */
function valueToBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value ?? null));
}
function bytesToValue(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes));
}

export interface EpochOpGateDeps {
  crypto: HiveEpochCrypto;
  /** owner-derive | member-unwrap — the shared resolver (built at boot). */
  resolveKey: EpochKeyResolver;
  /** the hive identity for the AAD + key id (= the hive HOME slug). */
  potId: string;
}

/**
 * The `EpochEncryptCapability` the outbox drain injects. The drain already filtered to
 * content ops (`shouldEncryptOpForRekey`) + put ops with a value, so we just encrypt.
 * Throwing EpochKeyUnavailableError here is intentional: the drain treats it like an
 * append failure (halt + retry) so a content op is NEVER federated in the clear.
 */
export function buildEpochEncryptCapability(
  deps: EpochOpGateDeps & {
    getCurrentEpoch: () => Promise<number>;
    /**
     * WI-4075: workspace id for the LOCAL epoch-generation invalidation registry
     * (hive-epoch-state.ts `getEpochGeneration`). Optional for back-compat with callers
     * that don't need immediate invalidation (unit tests exercising the TTL alone); every
     * real boot-deps caller passes it. When provided, a LOCAL `setHiveEpoch`/
     * `advanceHiveEpoch` (the boundary trigger) bumps the generation and this capability
     * re-reads `getCurrentEpoch` on its very next call regardless of the TTL — closing the
     * stale-cache window where post-boundary content could federate under the outgoing
     * epoch, or — at the 0→1 boundary specifically — in the CLEAR (see BASELINE_EPOCH
     * bypass below).
     */
    workspaceId?: string;
    /**
     * WI-2106: "has this hive EVER been re-keyed?" — the DISCRIMINATOR for the
     * `epoch === BASELINE_EPOCH` bypass below. Optional: omitted ⇒ the pre-WI-2106
     * behavior (always plaintext at baseline), which keeps every existing unit test and
     * any caller that predates this dep byte-identical. Every real boot-deps caller
     * passes it. Implementation must be MONOTONIC and fail-safe-false — see
     * hive-epoch-keys-store.ts `hasRekeyEvidence`.
     */
    hasRekeyEvidence?: () => Promise<boolean>;
  },
): EpochEncryptCapability {
  // EI-6945: `getCurrentEpoch` (getHiveEpoch → getHiveSetting) is an UNCACHED PG
  // SELECT against harness_shared.pot_settings, and `encryptOp` is called ONCE PER
  // ROW from outbox-drain's per-row loop (DEFAULT_DRAIN_BATCH=200) — so every
  // drained content row paid a full extra PG round-trip just to re-read a value
  // that changes ONLY on an explicit, rare, human/policy-driven re-key
  // (advanceHiveEpoch — member-remove / go-private). Under this harness's heavy
  // write/connection load this uncached per-row SELECT was the N+1 behind the
  // systemically-slow epoch-encrypt stage (confirmed live: stage-stall logs
  // showing per-row epoch-encrypt taking >15s with the STALLING ROW ID
  // ADVANCING pass to pass — not a single poison row — while substrate_outbox's
  // undrained depth grew unbounded). Cache the epoch for a short TTL: safe
  // because a re-key is never latency-sensitive to the sub-second level (the
  // decrypt gate's DEFER-until-key-arrives semantics already tolerate a content
  // op briefly encrypted under the outgoing epoch), and this bounds staleness to
  // well under the drain's own poll cadence.
  const EPOCH_CACHE_TTL_MS = 5000;
  let epochCache: { epoch: number; at: number; generation: number } | null = null;
  // EI-21838477202906344: a slow PG read can outlive the entire TTL. Stamp the
  // cache at successful completion (not request start), and share one in-flight
  // read per generation so overlapping drain passes cannot amplify a stalled
  // pool into another epoch-read N+1.
  let epochLoadInFlight: { generation: number; promise: Promise<number>; id: string } | null = null;
  const getCurrentEpochCached = async (): Promise<number> => {
    const now = Date.now();
    // WI-4075: the generation is the IMMEDIATE invalidation signal for a local epoch
    // advance; the TTL alone is only a safety bound for remote/cross-process staleness.
    // A cache hit requires BOTH the TTL to still be fresh AND the generation to be
    // unchanged since it was populated.
    const generation = deps.workspaceId !== undefined ? getEpochGeneration(deps.workspaceId, deps.potId) : 0;
    if (epochCache && now - epochCache.at < EPOCH_CACHE_TTL_MS && epochCache.generation === generation) {
      currentStageAttempt()?.cache('epoch-load', 'hit');
      return epochCache.epoch;
    }
    if (epochLoadInFlight?.generation === generation) {
      const shared = epochLoadInFlight;
      currentStageAttempt()?.cache('epoch-load', 'shared', shared.id);
      return traceStageAwait('epoch-load', () => shared.promise);
    }

    const id = randomUUID();
    currentStageAttempt()?.cache('epoch-load', 'miss', id);
    const promise = (async () => {
      const epoch = await traceStageAwait('epoch-load', () => deps.getCurrentEpoch());
      const completionGeneration =
        deps.workspaceId !== undefined ? getEpochGeneration(deps.workspaceId, deps.potId) : 0;
      if (completionGeneration === generation) {
        epochCache = { epoch, at: Date.now(), generation };
      }
      return epoch;
    })();
    epochLoadInFlight = { generation, promise, id };
    try {
      return await promise;
    } finally {
      if (epochLoadInFlight?.promise === promise) epochLoadInFlight = null;
    }
  };
  // WI-2106: the re-key-evidence probe is a PG read, and `encryptOp` runs ONCE PER ROW of
  // the drain batch (DEFAULT_DRAIN_BATCH=200) — exactly the N+1 shape EI-6945 removed from
  // the epoch read above, so it gets the same treatment. Two properties make this cheaper
  // than the epoch cache: the answer is MONOTONIC (false→true only, since rows are only
  // inserted), so a `true` LATCHES permanently and is never re-queried; and the probe only
  // runs at all when the epoch reads baseline. A `false` is re-checked on the same short
  // TTL, which bounds how long a just-arrived first epoch key goes unnoticed.
  let rekeyEvidenceLatched = false;
  let rekeyEvidenceCheckedAt = 0;
  const hasRekeyEvidenceCached = async (): Promise<boolean> => {
    if (rekeyEvidenceLatched) {
      currentStageAttempt()?.cache('baseline-evidence', 'hit');
      return true;
    }
    if (deps.hasRekeyEvidence === undefined) return false;
    const now = Date.now();
    if (rekeyEvidenceCheckedAt !== 0 && now - rekeyEvidenceCheckedAt < EPOCH_CACHE_TTL_MS) {
      currentStageAttempt()?.cache('baseline-evidence', 'hit');
      return false;
    }
    rekeyEvidenceCheckedAt = now;
    if (await traceStageAwait('baseline-evidence', () => deps.hasRekeyEvidence!())) {
      rekeyEvidenceLatched = true;
      return true;
    }
    return false;
  };
  return {
    async encryptOp(op: LocalWriteOp): Promise<{ epoch: number; value: unknown } | null> {
      const epoch = await getCurrentEpochCached();
      // WI-2102: epoch 0 = the PRE-re-key BASELINE (hive-epoch-state.ts) — content
      // federates PLAINTEXT (today's path), exactly as the decrypt gate's
      // `op.epoch == null` passthrough expects. Without this bypass a never-rekeyed
      // hive demanded an epoch-0 key on every drain: a MEMBER box threw
      // EpochKeyUnavailableError forever (no epoch-0 wrapped row is ever distributed
      // — epoch 0 predates distribution) wedging its whole outbox, and an OWNER box
      // minted a fresh-random epoch-0 key only IT holds and federated content no
      // member could ever decrypt (deferred forever at the decrypt gate). Net effect
      // on a 2-box pair: replication dead BOTH directions (the P-059 signature;
      // proven live on the gate rig 2026-07-03, inst-a/b.log 728+ drain failures).
      if (epoch === BASELINE_EPOCH) {
        // WI-2106: epoch 0 is AMBIGUOUS — `coerceEpoch` maps unset/malformed/genuinely-
        // baseline all to 0, and nothing writes the epoch row at hive CREATION (only the
        // re-key boundary does). So "0" means EITHER "never re-keyed, plaintext is
        // correct" OR "I don't know yet, and this hive may be at epoch 5" — the fresh
        // joiner of an already-re-keyed hive whose settings-row backfill lags. Federating
        // plaintext in the second case hands post-boundary content to the very member the
        // boundary revoked. Ask the discriminator; anything other than a POSITIVE proof of
        // a prior re-key keeps today's plaintext path, so a never-re-keyed hive (the norm)
        // is byte-identical and can never wedge.
        if (await hasRekeyEvidenceCached()) {
          // Proven re-keyed, yet the local epoch still reads baseline ⇒ the epoch row has
          // not backfilled. Fail CLOSED via the SAME mechanism the missing-key path
          // already uses: this throw is caught by the outbox drain as an append failure
          // (halt + retry — see this function's doc comment), so the op is neither
          // federated in the clear nor lost. When the epoch row lands, the retry reads the
          // real epoch and encrypts under it — the filing's option (a) "defer-then-encrypt"
          // achieved with existing machinery rather than a new buffer or a guessed timer.
          throw new EpochKeyUnavailableError(deps.potId, epoch, {
            devicePubkey: 'wi-2106-baseline-ambiguous',
          });
        }
        return null; // plaintext — no epoch stamp
      }
      const key = await deps.resolveKey(deps.potId, epoch);
      // OpIdentity (object) — encryptOpPayload derives the opId internally via buildOpAAD.
      const id = { tableTag: op.table, rowKey: op.hbKey, authorPubkey: op.writerPubkey ?? '' };
      const bytes = traceStageSync(currentStageAttempt(), 'serialize', () => valueToBytes(op.value));
      const ct = await encryptOpPayload(deps.crypto, bytes, { potId: deps.potId, epoch, id }, key);
      return { epoch, value: encodeCiphertext(ct) };
    },
  };
}

export interface EpochDecryptGateDeps extends EpochOpGateDeps {
  /** J's per-apply-loop deferral buffer (key-before-content ordering). */
  pending: PendingEpochContent;
  /**
   * WI-808 observability: a best-effort trace of the gate's per-op DECISION
   * (passthrough / defer / decrypt-fail / applied). The two failure paths
   * (defer, decrypt-fail) are otherwise SILENT — a federated content op that
   * never lands on a joiner left no signal, so the drop was indistinguishable
   * from the gate never being installed. Wired to recordBootEvent at boot.
   * Pure observability — a throw here must never alter the gate's verdict.
   */
  onTrace?: (phase: string, detail: string) => void;
  /**
   * P-524 (p2p-join-catchup-speed-2026-09-23 D-009 (b)): told each time an op defers for
   * want of the key for `(potId, epoch)`, so the fold can look ahead on the same log for
   * this device's key row ({@link buildEpochKeySeek}). A throw here must never alter the
   * gate's verdict.
   */
  onKeyMissing?: (potId: string, epoch: number) => void;
}

/**
 * The apply-side decrypt gate. `decryptGate(inner)` returns an ApplyFn that handles an
 * epoch-stamped op BEFORE `inner` (EN-4 → EN-2 → scopedApply) sees it:
 *   - epoch absent ⇒ plaintext / control-plane → `inner(op)` unchanged (today's path).
 *   - epoch present, key available ⇒ decrypt → `inner(plaintext op)`.
 *   - epoch present, key NOT local ⇒ DEFER (re-applied when the epoch-key row lands; a
 *     removed member's never lands → defers forever = the C-001 read cut).
 *   - epoch present, key present but decrypt fails (wrong epoch / tampered) ⇒ DROP.
 * Drain (re-applying deferred ops once a `hive_epoch_keys` row applies) is wired at boot
 * via the projection's `onEpochKeyApplied` hook → `pending.drainEpoch` → re-run here.
 */
export function buildEpochDecryptGate(
  deps: EpochDecryptGateDeps,
): (inner: (op: OpEnvelope) => Promise<boolean>) => (op: OpEnvelope) => Promise<boolean> {
  const trace = (phase: string, detail: string) => {
    try {
      deps.onTrace?.(phase, detail);
    } catch {
      // observability must never alter the gate verdict
    }
  };
  return (inner) =>
    async (op: OpEnvelope): Promise<boolean> => {
      // WI-808 DECISIVE ENTRY TRACE: fire for ANY op that looks encrypted — epoch
      // stamped OR value is a `{__rekey}` envelope. This resolves the ambiguity the
      // verdict-only traces left: if a content op REACHES the gate this fires (and the
      // detail shows whether `epoch` survived the wire); if it NEVER fires, the content
      // op is dropped UPSTREAM of the gate (merge/admission/routing), not here. A
      // ciphertext value with epoch==null is the "stamp lost on receive" smoking gun.
      const looksEncrypted = op.epoch != null || isRekeyValue(op.value);
      if (looksEncrypted) {
        trace(
          'epoch_gate_seen',
          `${op.table ?? '?'}/${(op.hbKey ?? '?').slice(0, 24)} epoch=${op.epoch ?? 'NULL'} rekeyVal=${isRekeyValue(op.value)} w${(op.writerPubkey ?? '?').slice(0, 8)}`,
        );
      }
      if (op.epoch == null) return inner(op); // plaintext / control-plane
      const ct = decodeCiphertext(op.value);
      if (!ct) return inner(op); // epoch-stamped but not our wrapper — permissive passthrough

      const where = `${op.table ?? '?'}/${(op.hbKey ?? '?').slice(0, 24)} e${op.epoch} w${(op.writerPubkey ?? '?').slice(0, 8)}`;
      let key: EpochKey;
      try {
        key = await deps.resolveKey(deps.potId, op.epoch);
      } catch (e) {
        // WI-898 F1: only a GENUINE absence (EpochKeyUnavailableError — no wrapped row
        // for this device at all, thrown on a null blob) means "key not yet local /
        // never will be" → defer. Any OTHER throw here is a TRANSIENT failure of the
        // resolve path itself (a PG deadlock/timeout/connection blip on the wrapped-key
        // SELECT under the held merge lock, or a keychain fault in derive/unwrap) — the
        // key for this epoch may already be sitting in PG. Deferring THAT is wrong: a
        // deferred op's merge cursor still advances past it (read-merge.ts) and there is
        // no steady-state re-fold, so the pending buffer + its key-arrival drain hook are
        // the ONLY recovery — but a key that's already present will never re-arrive to
        // trigger that drain, so the content strands until a process restart resets the
        // cursor (observed live: EI-9057-class re-files aside, this is the WI-893 Lane D
        // finding). RE-THROW instead: the membership guard already gets this right
        // (applyRecordingWinner, read-merge.ts) — a throw here propagates there, is
        // treated as transient, and is retried next pass WITHOUT the cursor advancing
        // (winner not recorded) until MAX_APPLY_THROWS, mirroring the correct path.
        if (!(e instanceof EpochKeyUnavailableError)) {
          trace(
            'epoch_resolve_transient',
            `${where} hive=${deps.potId} rethrow (not a genuine key-absence): ${(e as Error)?.message ?? e}`,
          );
          throw e;
        }
        // key not yet local (remaining member waiting; or removed member forever) → defer.
        trace('epoch_defer', `${where} hive=${deps.potId} no-key-yet: ${(e as Error)?.message ?? e}`);
        deps.pending.defer(op, deps.potId, op.epoch);
        try {
          deps.onKeyMissing?.(deps.potId, op.epoch);
        } catch {
          // the key seek only speeds convergence; it must never alter the gate verdict
        }
        return false;
      }

      // OpIdentity must match what encrypt sealed: same (table, hbKey, writerPubkey).
      const id = { tableTag: op.table ?? '', rowKey: op.hbKey ?? '', authorPubkey: op.writerPubkey ?? '' };
      let plaintext: Uint8Array;
      try {
        plaintext = await decryptOpPayload(deps.crypto, ct, { potId: deps.potId, epoch: op.epoch, id }, key);
      } catch (e) {
        // have a key but can't decrypt (wrong epoch / tampered AAD) → drop = read cut.
        // WI-808: this is the SILENT drop — most often an AAD mismatch (potId is the
        // LOCAL home slug, not a federated field, so it can differ owner↔joiner).
        trace('epoch_decrypt_fail', `${where} hive=${deps.potId} DROP: ${(e as Error)?.message ?? e}`);
        return false;
      }
      // Apply the now-PLAINTEXT op; clear `epoch` so downstream sees a normal op.
      trace('epoch_applied', `${where} hive=${deps.potId}`);
      return inner({ ...op, value: bytesToValue(plaintext), epoch: undefined });
    };
}

/**
 * P-524 (p2p-join-catchup-speed-2026-09-23 D-009 (b)) — the boot half of the key seek.
 * `onKeyMissing` goes to the decrypt gate and `keySeek` to the merge options. The gate
 * records each (hive, epoch) it had to defer for want of a key; the fold takes those after
 * each apply and looks ahead on that log for THIS device's wrapped key row
 * (`hive-epoch-keys`, keyed `${epoch}:${devicePubkeyBase64}` — the same pubkey the member
 * provider's PG lookup uses). Pure: no PG, no boot.
 */
export function buildEpochKeySeek(devicePubkeyBase64: string): {
  onKeyMissing: (potId: string, epoch: number) => void;
  keySeek: EpochKeySeek;
} {
  const missed = new Map<string, EpochKeyMiss>();
  const none: readonly EpochKeyMiss[] = [];
  return {
    onKeyMissing: (potId, epoch) => {
      const k = `${epoch}:${potId}`;
      if (!missed.has(k)) missed.set(k, { potId, epoch });
    },
    keySeek: {
      takeMisses: () => {
        if (missed.size === 0) return none;
        const out = [...missed.values()];
        missed.clear();
        return out;
      },
      suppliesKey: (env, miss) =>
        env.table === HIVE_EPOCH_KEYS_TABLE_TAG && env.hbKey === epochKeyRowKey(miss.epoch, devicePubkeyBase64),
    },
  };
}

/** A boot-scope drain-queue entry: a `(hive, epoch)` whose `hive_epoch_keys` row just
 *  applied this merge pass (recorded by the projection's `onEpochKeyApplied` hook). */
export interface DrainedEpoch {
  potHomeSlug: string;
  epoch: number;
}

/**
 * The DRAIN HOOK (shared-hive-rekey-2026-06-19) — the complement of the decrypt gate's
 * DEFER, and the pre-ship convergence guarantee the P-008 witness can't exercise (it
 * orders keys-first so it never defers).
 *
 * The gate defers an epoch-N content op into `pending` when its epoch-N key is not yet
 * local (production has no keys-before-content ordering: the merge applies on ARRIVAL, not
 * by a global cross-table HLC sort). This re-applies those deferred ops once the key row
 * lands. Boot wires the `hive_epoch_keys` projection's `onEpochKeyApplied(hive, epoch)` to
 * PUSH onto `drainQueue` (recording, NOT draining, so it never re-enters the apply that is
 * firing it), and calls this AFTER each merge pass: for each queued `(hive, epoch)`, pull
 * that bucket's deferred content (now decryptable) and re-run it through THIS pass's
 * `applyImpl` (decrypt → EN-4 → EN-2 → scopedApply — the SAME path).
 *
 * Bounded + non-re-entrant: a CONTENT op never fires `onEpochKeyApplied`, so re-applying
 * drained ops adds no new queue entries (no cascade); the queue is CONSUMED (spliced) so
 * each signal drains once. Best-effort: a re-apply throw must not abort the merge pass —
 * the ciphertext stays in the peer log, so a dropped re-apply re-defers on a later fold.
 *
 * Returns the number of deferred ops re-applied (observability / tests). Pure over its
 * injected deps (no boot, no PG) — fully unit-testable.
 */
export async function drainQueuedEpochContent(deps: {
  pending: PendingEpochContent;
  drainQueue: DrainedEpoch[];
  applyImpl: (op: OpEnvelope) => Promise<boolean>;
  /**
   * WI-10002487 — a re-apply that THROWS is caught so it cannot abort the merge pass,
   * but it must never be SILENT: the merge cursor already advanced past this op when it
   * deferred, so nothing re-reads it and a swallowed throw is unrecoverable content loss
   * that looks exactly like a successful drain. Defaults to a console.warn naming the op.
   */
  onReapplyError?: (op: OpEnvelope, err: unknown) => void;
  /**
   * D-016: whether THIS device resolves the epoch key now. The drain hook fires for any
   * device's key row, so a drain alone does not prove the key is local. Consulted only when
   * ops of that epoch were evicted and none of the drained ones decrypted.
   */
  hasEpochKey?: (potId: string, epoch: number) => Promise<boolean>;
}): Promise<number> {
  if (deps.drainQueue.length === 0) return 0;
  // Take + clear: a later pass re-queues on the next key apply. Snapshot so a re-apply
  // that (defensively) somehow re-queued can't grow the loop within one drain.
  const toDrain = deps.drainQueue.splice(0);
  let reapplied = 0;
  for (const { potHomeSlug, epoch } of toDrain) {
    let decrypted = false;
    for (const deferred of deps.pending.drainEpoch(potHomeSlug, epoch)) {
      try {
        // D-016: a re-defer keeps the op's own log position.
        if (await runWithDeferralSource(deferred.source, () => deps.applyImpl(deferred.op))) {
          reapplied++;
          decrypted = true;
        }
      } catch (err) {
        // best-effort — a re-apply failure must not abort the merge pass — but it is
        // reported, never swallowed (see onReapplyError).
        try {
          if (deps.onReapplyError) deps.onReapplyError(deferred.op, err);
          else
            console.warn(
              `[hive-epoch-op-gate] deferred epoch-content re-apply FAILED for ` +
                `${deferred.op.table ?? '?'}/${(deferred.op.hbKey ?? '?').slice(0, 48)} ` +
                `(hive=${potHomeSlug} epoch=${epoch}); the merge cursor is already past this op, ` +
                `so it will not re-apply by itself:`,
              err instanceof Error ? err.message : String(err),
            );
        } catch {
          // reporting must never abort the drain
        }
      }
    }
    // D-016: ops of this epoch evicted while its key was missing owe a re-read, but only
    // once this device can decrypt them. A decrypted re-apply proves it; otherwise ask.
    if (deps.pending.hasEvicted(potHomeSlug, epoch)) {
      let keyLocal = decrypted;
      if (!keyLocal && deps.hasEpochKey) {
        try {
          keyLocal = await deps.hasEpochKey(potHomeSlug, epoch);
        } catch {
          keyLocal = false; // a failed probe keeps the record for the next key row
        }
      }
      if (keyLocal) deps.pending.releaseEpoch(potHomeSlug, epoch);
    }
  }
  return reapplied;
}
