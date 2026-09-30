/**
 * announce — the signed peer-announce wire-format (Model B substrate, Stage 3).
 *
 * Per-peer Hypercore logs replicate over the swarm. On connect, peers exchange
 * a signed announce that binds a peer's log core to its device identity:
 *
 *   { device_pubkey, github_user_id, github_login, log_core_key, log_length?, ts, nonce?, sig }
 *
 *   - device_pubkey — the RAW 32-byte Ed25519 device public key, base64. This
 *     is the SAME string as the binding's `device_pubkey`
 *     (attest.ts / two-channel-verifier.ts), so a verified announce identifies
 *     a device whose binding the read-admission decision can then check.
 *   - log_core_key — the 64-hex Hypercore key of the peer's writable log
 *     (distinct from device_pubkey; one is identity, one is the core to read).
 *   - ts — epoch-ms timestamp (Date.now()) at announce-build time. Covered by
 *     the signature; `verifyAnnounce` rejects frames outside a ±windowMs
 *     freshness window (default 5 min), closing the replay-announce attack
 *     surface (D-007).
 *   - nonce — optional random string for additional replay resistance. Also
 *     covered by the signature.
 *   - sig — base64 Ed25519 signature over the canonical body (excluding `sig`).
 *
 * Crypto contract (Stage-0 spike, run-verified): Node-crypto Ed25519,
 * `sign(null, …)` / `verify(null, …)` (algorithm MUST be null for Ed25519),
 * with the raw-32-byte-base64 pubkey → SPKI-DER rebuild via the fixed 12-byte
 * Ed25519 prefix `302a300506032b6570032100`. This mirrors attest.ts's private
 * `verifyEd25519Signature` + `buildSpkiDerFromRawPubkey` and
 * two-channel-verifier.ts's `verifyContributorFileSignature` exactly, so the
 * announce sig is byte-compatible with the binding's signatures.
 *
 * attest.ts does not export those helpers (they're private and bound to the
 * AttestationGistBody schema), so the primitive is reimplemented here against
 * the announce body. The signer is INJECTED — tests pass a generated keypair;
 * production passes `bytes => signWithDeviceKey(keychainId, bytes)`.
 *
 * Canonicalization: the body is all primitives (no nested objects), so a fixed
 * field-ordered `JSON.stringify` is equivalent to JCS (RFC 8785) for this
 * schema. Field order: device_pubkey, github_user_id, github_login, log_core_key,
 * ts[, nonce].
 */

import { verify as nodeVerify, createPublicKey } from 'node:crypto';

/** The signed-over fields of an announce (everything except `sig`). */
export interface AnnounceBody {
  /** Raw 32-byte Ed25519 device public key, base64 (== binding device_pubkey). */
  device_pubkey: string;
  github_user_id: number;
  github_login: string;
  /** P-011 device-attestation gist id. The channel-2 anchor rides the SIGNED
   *  announce so a remote peer can admit via
   *  `verifyAttestation(attestation_gist_id, device_pubkey, github_user_id)`
   *  WITHOUT fetching a shared-repo contributor file — i.e. join needs no repo
   *  write (write-free join, `non-collaborator-join-fork-pr-2026-06-02`). It is
   *  covered by the signature, so it cannot be substituted in transit; and
   *  `verifyAttestation` pins gist `owner.id === github_user_id`, so a peer can
   *  only bind a gist it actually owns. */
  attestation_gist_id: string;
  /** 64-hex Hypercore key of the peer's writable log. */
  log_core_key: string;
  /**
   * Optional writer-side Hypercore length at announce-build time. This is a
   * signed, monotonic high-water hint for replication LIVENESS only: receivers
   * may use it to know that a locally caught-up-looking replica is actually
   * behind, but must never read or advance a merge cursor beyond the remote
   * core's locally available `length`. Absent on legacy peers.
   */
  log_length?: number;
  /** A-003 (a′): the ORIGIN harness slug this log belongs to. An instance may
   *  run several local harnesses on ONE hive topic (a hive's member harness +
   *  its hive-home harness, so hive_members/hive_settings federate), all sharing
   *  one announce channel that carries every local log's announce. Because
   *  read-admission is IDENTITY-only and every harness registers all
   *  projections, an inbound announce broadcast to all on-topic handlers would
   *  let one harness admit + apply another harness's log (cross-merge
   *  pollution). The receive-side filter (boot.ts onAnnounce) admits a frame iff
   *  `harness_slug === own slug` OR `=== joinerPotHomeSlug(self)` — so it must
   *  ride the SIGNED frame (cannot be spoofed to mis-route a log). OPTIONAL +
   *  backward-compatible: absent → omitted from the signing bytes (identical to
   *  a pre-(a′) frame), and the receive filter treats absent as the legacy
   *  single-harness path. */
  harness_slug?: string;
  /** Epoch-ms timestamp at announce-build time. Covered by sig; used for
   *  freshness check in verifyAnnounce (D-007 replay hardening). */
  ts: number;
  /** P-006 FederationScope disclosure (design §5.2, ratified D-017): the
   *  sender's SCOPED log declarations, disclosed PER CONNECTION to scope
   *  members only — the sender filters this list against each remote peer's
   *  verified identity BEFORE building the frame (sender-side scoping; a
   *  non-member never learns a scoped core key). Each entry is the canonical
   *  packed string `scope_id|log_core_key_hex|scope_epoch`
   *  (scope-disclosure.ts owns pack/parse) — an array of STRING PRIMITIVES so
   *  the fixed-field-order JCS-equivalence argument holds unchanged (the
   *  hive-announce `member_topics: string[]` precedent). OPTIONAL + additive
   *  and sig-covered only when non-empty, so an absent/empty field signs the
   *  exact bytes a pre-P-006 frame did (the harness_slug A-003 pattern).
   *  D-017 n1: a roster mutation re-discloses on LIVE connections — the
   *  connection layer re-announces with the updated list (scope-disclosure.ts
   *  computeRedisclosure). */
  scoped_logs?: string[];
  /** Optional random nonce for additional replay resistance. Covered by sig. */
  nonce?: string;
  /**
   * WI-10002600: own-log keys THIS device has retired and replaced with
   * `log_core_key` (an own-log fork recovery re-keys the log). A receiver drops
   * each listed key that it admitted from the SAME device.
   *
   * Deliberately NOT part of {@link announceSigningBytes}: an older receiver
   * builds its signing bytes from the fields it knows, so signing over this
   * field would make every older peer reject the recovered device's NEW log as
   * `bad_sig`. The list is authenticated by its own signature, `supersedes_sig`
   * (see {@link logSupersessionSigningBytes}), which older peers never read.
   */
  supersedes_log_keys?: string[];
  /** Base64 Ed25519 signature, by `device_pubkey`, over
   *  {@link logSupersessionSigningBytes}. Present iff `supersedes_log_keys` is. */
  supersedes_sig?: string;
}

/** A full announce frame as sent on the wire. */
export interface SignedAnnounce extends AnnounceBody {
  /** Base64 Ed25519 signature over `announceSigningBytes(body)`. */
  sig: string;
}

/** Fixed 12-byte Ed25519 SPKI DER prefix (matches attest.ts / two-channel-verifier.ts). */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Canonical signing bytes for an announce: field-ordered JSON of the body
 * EXCLUDING `sig`. All values are primitives so this equals JCS for the schema.
 * Field order: device_pubkey, github_user_id, github_login, attestation_gist_id,
 * log_core_key[, log_length], ts[, harness_slug][, nonce]. Optional fields are
 * included only when present, so an absent optional yields byte-identical bytes
 * to a frame that never had it.
 */
export function announceSigningBytes(body: AnnounceBody): Buffer {
  // Build ordered object — nonce only when present (undefined → omit key).
  const ordered: Record<string, string | number | string[]> = {
    device_pubkey: body.device_pubkey,
    github_user_id: body.github_user_id,
    github_login: body.github_login,
    attestation_gist_id: body.attestation_gist_id,
    log_core_key: body.log_core_key,
  };
  // WI-38376: the writer's signed log high-water. Conditional so legacy
  // announces retain their exact pre-field signing bytes.
  if (typeof body.log_length === 'number') {
    ordered.log_length = body.log_length;
  }
  ordered.ts = body.ts;
  // A-003 (a′): the origin harness slug, when present, is signed-over so it
  // cannot be spoofed to mis-route a log on the receive-side admission filter.
  // Conditional (like nonce) → absent yields byte-identical canonical bytes to a
  // pre-(a′) frame, so existing signatures verify unchanged (backward compat).
  if (typeof body.harness_slug === 'string') {
    ordered.harness_slug = body.harness_slug;
  }
  // P-006 §5.2 (D-017): scoped-log disclosures are signed-over when present so
  // a relay cannot graft/strip a scope disclosure in transit. Order-significant
  // string[] (the member_topics precedent); empty → omitted, so a frame with no
  // scoped logs signs byte-identical to a pre-P-006 frame (backward compat).
  if (Array.isArray(body.scoped_logs) && body.scoped_logs.length > 0) {
    ordered.scoped_logs = body.scoped_logs;
  }
  if (typeof body.nonce === 'string') {
    ordered.nonce = body.nonce;
  }
  return Buffer.from(JSON.stringify(ordered), 'utf8');
}

/**
 * Build a signed announce. The signer is injected so tests can use a generated
 * keypair and production passes `bytes => signWithDeviceKey(keychainId, bytes)`.
 * The signer returns the raw 64-byte Ed25519 signature; it's base64-encoded here.
 *
 * `opts.nowMs` overrides `Date.now()` for the `ts` field — useful in tests that
 * need a deterministic timestamp or want to simulate stale/future announces.
 * If `body` already contains `ts`, that value is REPLACED by the opts/default clock.
 */
export async function buildAnnounce(
  body: Omit<AnnounceBody, 'ts'> & { ts?: number },
  sign: (bytes: Buffer) => Promise<Buffer>,
  opts?: { nowMs?: number },
): Promise<SignedAnnounce> {
  const stamped: AnnounceBody = { ...body, ts: opts?.nowMs ?? Date.now() };
  const sig = (await sign(announceSigningBytes(stamped))).toString('base64');
  return { ...stamped, sig };
}

/** Default freshness window for announce frames (±5 min, clock-skew tolerant). */
export const DEFAULT_ANNOUNCE_WINDOW_MS = 5 * 60 * 1000;

/** Discriminated failure reason for {@link verifyAnnounceDetailed} — lets a caller tell
 *  WI-1662's clock-skew case (`stale_ts`) apart from a genuinely bad/forged signature
 *  (`bad_sig`), which a plain boolean collapses into one indistinguishable `false`. */
export type VerifyAnnounceReason = 'malformed' | 'stale_ts' | 'bad_pubkey' | 'bad_sig';

export interface VerifyAnnounceResult {
  ok: boolean;
  /** Present only when `ok` is false. */
  reason?: VerifyAnnounceReason;
}

/**
 * Verify an announce frame's `sig` against its `device_pubkey` (raw-32-byte
 * base64 → SPKI rebuild → nodeVerify) over `announceSigningBytes(frame)`.
 * Also checks that `frame.ts` is a number within `opts.windowMs` of
 * `opts.nowMs` (defaults: `Date.now()` and `DEFAULT_ANNOUNCE_WINDOW_MS`).
 *
 * Returns `{ ok: false, reason }` on any tamper, stale/future ts, bad shape,
 * or malformed input — never throws. `reason` is a discriminant so a caller
 * can tell WI-1662's clock-skew case (`'stale_ts'`) apart from a genuinely bad
 * signature (`'bad_sig'`) — the two are otherwise indistinguishable and a
 * skewed-clock peer gets silently dropped with zero diagnostic signal.
 *
 * D-007: the `ts` (and optional `nonce`) are covered by the signature, so
 * tampering either field breaks sig verification independently of the
 * freshness check.
 */
export function verifyAnnounceDetailed(
  frame: SignedAnnounce,
  opts?: { nowMs?: number; windowMs?: number },
): VerifyAnnounceResult {
  try {
    if (!frame || typeof frame !== 'object') return { ok: false, reason: 'malformed' };
    if (
      typeof frame.device_pubkey !== 'string' ||
      typeof frame.github_user_id !== 'number' ||
      typeof frame.github_login !== 'string' ||
      typeof frame.attestation_gist_id !== 'string' ||
      typeof frame.log_core_key !== 'string' ||
      typeof frame.sig !== 'string'
    ) {
      return { ok: false, reason: 'malformed' };
    }
    // P-006 §5.2: when present, scoped_logs must be an array of strings —
    // entry-level parsing/membership is the disclosure layer's job
    // (scope-disclosure.ts, fail-closed per entry), but a structurally alien
    // field is a malformed frame.
    if (
      frame.scoped_logs !== undefined &&
      (!Array.isArray(frame.scoped_logs) || frame.scoped_logs.some((e) => typeof e !== 'string'))
    ) {
      return { ok: false, reason: 'malformed' };
    }
    // WI-38376: a present writer high-water must be a representable,
    // non-negative integer. Reject malformed values before signature work so
    // NaN/Infinity cannot be canonicalized by JSON.stringify into `null`, and
    // fractional/negative hints can never poison the monotonic receiver map.
    if (
      frame.log_length !== undefined &&
      (!Number.isSafeInteger(frame.log_length) || frame.log_length < 0)
    ) {
      return { ok: false, reason: 'malformed' };
    }

    // D-007 freshness check: ts must be present and within the window.
    if (typeof frame.ts !== 'number') return { ok: false, reason: 'malformed' };
    const nowMs = opts?.nowMs ?? Date.now();
    const windowMs = opts?.windowMs ?? DEFAULT_ANNOUNCE_WINDOW_MS;
    if (Math.abs(nowMs - frame.ts) > windowMs) return { ok: false, reason: 'stale_ts' };

    const rawPubkey = Buffer.from(frame.device_pubkey, 'base64');
    if (rawPubkey.length !== 32) return { ok: false, reason: 'bad_pubkey' };

    const spkiDer = Buffer.concat([SPKI_PREFIX, rawPubkey]);
    const publicKey = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });

    const bytes = announceSigningBytes(frame);
    const sig = Buffer.from(frame.sig, 'base64');
    const sigOk = nodeVerify(null, bytes, publicKey, sig);
    return sigOk ? { ok: true } : { ok: false, reason: 'bad_sig' };
  } catch {
    return { ok: false, reason: 'bad_sig' };
  }
}

/**
 * Boolean-only convenience wrapper over {@link verifyAnnounceDetailed} for callers that
 * don't need the failure reason. Behavior-identical to the pre-WI-1662 implementation —
 * every existing caller/test keeps working unchanged.
 */
export function verifyAnnounce(
  frame: SignedAnnounce,
  opts?: { nowMs?: number; windowMs?: number },
): boolean {
  return verifyAnnounceDetailed(frame, opts).ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// WI-10002600: own-log supersession.
//
// After an own-log fork recovery the device writes to a brand-new log key.
// Every drop path on a receiver used to be DEVICE-level (revoke, published
// revoke, channel-2 reverify), and a re-keyed device keeps a valid binding, so
// the old key stayed admitted with no replicator for the rest of the receiver's
// process lifetime. The device now states, under its own key, which of its logs
// the announced log replaces.
// ─────────────────────────────────────────────────────────────────────────────

/** Domain tag, so a supersession signature can never be replayed as (or from)
 *  any other signed payload made with the device key. */
export const LOG_SUPERSESSION_DOMAIN = 'papercusp/log-supersession/v1';

/** Upper bound on keys one announce may retire. A device only re-keys on a
 *  fork recovery, so a real list is one or two entries long. */
export const MAX_SUPERSEDED_LOG_KEYS = 16;

const LOG_KEY_HEX = /^[0-9a-f]{64}$/;

/** Canonical bytes the device signs to retire `supersededLogKeys` in favour of
 *  `logCoreKey`. Binding the replacement key and device means a statement lifted
 *  onto another frame only ever re-asserts the same fact. */
export function logSupersessionSigningBytes(input: {
  device_pubkey: string;
  log_core_key: string;
  supersedes_log_keys: readonly string[];
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      domain: LOG_SUPERSESSION_DOMAIN,
      device_pubkey: input.device_pubkey,
      log_core_key: input.log_core_key,
      supersedes_log_keys: [...input.supersedes_log_keys],
    }),
    'utf8',
  );
}

/** Normalize a candidate supersession list: lowercase 64-hex, de-duplicated,
 *  never the replacement key itself, capped at {@link MAX_SUPERSEDED_LOG_KEYS}. */
export function normalizeSupersededLogKeys(keys: readonly string[], logCoreKey: string): string[] {
  const own = logCoreKey.toLowerCase();
  const out: string[] = [];
  for (const raw of keys) {
    const key = raw.toLowerCase();
    if (!LOG_KEY_HEX.test(key) || key === own || out.includes(key)) continue;
    out.push(key);
    if (out.length >= MAX_SUPERSEDED_LOG_KEYS) break;
  }
  return out;
}

/**
 * Sign a supersession for an announce body. Returns the two frame fields to
 * spread into the body, or `{}` when there is nothing to supersede (so a
 * device that never re-keyed sends exactly the frame it always did).
 */
export async function buildLogSupersession(
  body: { device_pubkey: string; log_core_key: string },
  supersededLogKeys: readonly string[],
  sign: (bytes: Buffer) => Promise<Buffer>,
): Promise<Pick<AnnounceBody, 'supersedes_log_keys' | 'supersedes_sig'>> {
  const keys = normalizeSupersededLogKeys(supersededLogKeys, body.log_core_key);
  if (keys.length === 0) return {};
  const sig = await sign(
    logSupersessionSigningBytes({
      device_pubkey: body.device_pubkey,
      log_core_key: body.log_core_key,
      supersedes_log_keys: keys,
    }),
  );
  return { supersedes_log_keys: keys, supersedes_sig: sig.toString('base64') };
}

export type LogSupersessionVerdict =
  | { status: 'absent' }
  | { status: 'valid'; keys: string[] }
  | { status: 'invalid'; reason: 'malformed' | 'bad_sig' };

/**
 * Verify a frame's supersession statement against its `device_pubkey`. Never
 * throws. `invalid` is NOT a reason to reject the announce itself: the announce
 * signature is checked separately, and a receiver simply ignores an unproven
 * supersession (the old log then stays admitted, exactly as before this field).
 */
export function verifyLogSupersession(frame: SignedAnnounce): LogSupersessionVerdict {
  const keys = frame.supersedes_log_keys;
  const sigB64 = frame.supersedes_sig;
  if (keys === undefined && sigB64 === undefined) return { status: 'absent' };
  try {
    if (
      !Array.isArray(keys) ||
      keys.length === 0 ||
      keys.length > MAX_SUPERSEDED_LOG_KEYS ||
      keys.some((k) => typeof k !== 'string' || !LOG_KEY_HEX.test(k)) ||
      typeof sigB64 !== 'string' ||
      typeof frame.device_pubkey !== 'string' ||
      typeof frame.log_core_key !== 'string'
    ) {
      return { status: 'invalid', reason: 'malformed' };
    }
    const rawPubkey = Buffer.from(frame.device_pubkey, 'base64');
    if (rawPubkey.length !== 32) return { status: 'invalid', reason: 'malformed' };
    const publicKey = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, rawPubkey]),
      format: 'der',
      type: 'spki',
    });
    const bytes = logSupersessionSigningBytes({
      device_pubkey: frame.device_pubkey,
      log_core_key: frame.log_core_key,
      supersedes_log_keys: keys,
    });
    if (!nodeVerify(null, bytes, publicKey, Buffer.from(sigB64, 'base64'))) {
      return { status: 'invalid', reason: 'bad_sig' };
    }
    const normalized = normalizeSupersededLogKeys(keys, frame.log_core_key);
    return normalized.length > 0 ? { status: 'valid', keys: normalized } : { status: 'invalid', reason: 'malformed' };
  } catch {
    return { status: 'invalid', reason: 'bad_sig' };
  }
}
