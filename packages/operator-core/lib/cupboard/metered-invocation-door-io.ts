/**
 * Client transport for the P-031 metering doors
 * (shared-pot-dao-cupboard-v1-2026-09-04, requirement line 5).
 *
 * The hosted `metered-usage` route is the AUTHORITY on whether a billable unit
 * may be served — it holds the durable channel and the published terms (D-055).
 * This module is the payer's and seller's side of that conversation, and it runs
 * the SAME pure interception (`p2p/metered-invocation.ts`) locally first.
 *
 * Running it twice is deliberate, not redundant. The local pass refuses a
 * cap-exhausted, replayed or regressed unit BEFORE the round trip, while
 * refusing is still free; the hosted pass refuses it again against state the
 * client cannot forge. Neither is trusted to stand in for the other: a client
 * that skipped the local pass would burn a request to learn what it already
 * knew, and a hosted door that trusted the local pass would accept whatever a
 * modified client asserted.
 *
 * SIGNING SEAM. `openMeteredInvocation`/`closeMeteredInvocation` are pure and
 * take a SYNCHRONOUS signer, but every real key here is behind an async
 * keychain (`identity/hive-keypair.ts`). So each is evaluated twice over
 * identical inputs: once to capture the canonical bytes, then — after the async
 * signature comes back — once more to produce the real artifact. Both functions
 * are pure, so the second evaluation is the first one plus a signature; nothing
 * is committed in between, and the fixed `nowMs`/`occurredAtMs` keeps the two
 * passes byte-identical.
 */
import {
  closeMeteredInvocation,
  declareMeter,
  openMeteredInvocation,
  type BillableUnit,
  type MeterDeclaration,
  type MeteredRefusalCode,
  type PerUseTermsInput,
} from '../p2p/metered-invocation';
import type { CumulativePaymentVoucher, MicrochargeChannel } from '../p2p/microcharge';
import { resolveCupboardBaseUrl } from './base-url';

/** Reused verbatim from the checkout door so both share one transport seam. */
export interface MeteredTransportDeps {
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
  /** Override the GitHub bearer; omitted in production, supplied by tests. */
  readonly authToken?: string;
}

/**
 * Produces a signature over canonical bytes. Production binds this to the hive
 * key (`signWithHiveKey(workspaceId, hiveSlug, bytes)`); tests supply their own.
 */
export type MeteredByteSigner = (bytes: Buffer) => Promise<string> | string;

export const METERED_INVOCATIONS_PATH = '/commerce/metered-invocations';
export const CHANNEL_USAGE_PATH = '/commerce/payment-channels';

export type MeteredDoorErrorCode =
  | MeteredRefusalCode
  | 'gh_auth_required'
  | 'transport_error'
  | 'invalid_request'
  | 'invalid_voucher'
  | 'unauthorized'
  | 'forbidden'
  | 'unknown_channel'
  | 'unknown_offer'
  | 'inactive_offer'
  | 'not_metered'
  | 'channel_not_open'
  | 'already-settled'
  | string;

export interface MeteredDoorFailure {
  readonly ok: false;
  readonly code: MeteredDoorErrorCode;
  readonly detail: string;
  /** 0 when the request never left this process (local refusal or transport). */
  readonly status: number;
  readonly refusedBy: 'local-interception' | 'hosted-door' | 'transport';
}

/** One usage receipt as the hosted door renders it — amounts are decimal strings. */
export interface UsageReceiptWire {
  readonly channelId: string;
  readonly usageNonce: string;
  readonly offerId: string;
  readonly payer: string;
  readonly seller: string;
  readonly releaseRef: string;
  readonly meterUnit: string;
  readonly meterQuantity: string;
  readonly unitPriceMicros: string;
  readonly priceVersion: string;
  readonly splitManifestHash: string;
  readonly reservedMicros: string;
  readonly amountMicros: string | null;
  readonly cumulativeClaimMicros: string;
  /** Canonical field of the signed voucher — needed to re-derive its digest. */
  readonly expiresAtMs: number;
  readonly voucherDigest: string;
  /** The payer's signature over the voucher; the seller's claim to the money. */
  readonly voucherSignature: string;
  readonly receiptSignature: string | null;
  readonly state: 'reserved' | 'settled';
  readonly reservedAtMs: number;
  readonly settledAtMs: number | null;
}

export interface ChannelUsageWire {
  readonly channelId: string;
  readonly escrowMicros: string;
  readonly committedMicros: string;
  readonly receipts: readonly UsageReceiptWire[];
}

const fail = (
  code: MeteredDoorErrorCode,
  detail: string,
  status: number,
  refusedBy: MeteredDoorFailure['refusedBy'],
): MeteredDoorFailure => ({ ok: false, code, detail, status, refusedBy });

async function resolveBearer(deps: MeteredTransportDeps): Promise<{ ok: true; token: string } | MeteredDoorFailure> {
  if (deps.authToken !== undefined) return { ok: true, token: deps.authToken };
  const { getGhAuthToken } = await import('../identity/gh-token');
  const resolved = await getGhAuthToken();
  if (resolved.kind !== 'ok') {
    return fail('gh_auth_required', 'no GitHub token is available to authenticate the metering request', 401, 'transport');
  }
  return { ok: true, token: resolved.token };
}

interface HostedCall {
  readonly path: string;
  readonly method: 'GET' | 'POST';
  readonly body?: unknown;
  readonly expect: readonly number[];
}

async function callHostedDoor(
  call: HostedCall,
  deps: MeteredTransportDeps,
): Promise<{ ok: true; payload: Record<string, unknown> } | MeteredDoorFailure> {
  const bearer = await resolveBearer(deps);
  if ('ok' in bearer && bearer.ok !== true) return bearer as MeteredDoorFailure;
  const token = (bearer as { token: string }).token;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = (deps.baseUrl ?? resolveCupboardBaseUrl()).replace(/\/+$/, '');

  let response: Response;
  try {
    response = await fetchImpl(`${base}${call.path}`, {
      method: call.method,
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
    });
  } catch (err) {
    return fail('transport_error', err instanceof Error ? err.message : String(err), 0, 'transport');
  }

  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  const payload = (parsed ?? {}) as Record<string, unknown>;

  if (!call.expect.includes(response.status)) {
    return fail(
      typeof payload.error === 'string' ? payload.error : `http_${response.status}`,
      typeof payload.detail === 'string' ? payload.detail : `the metering door answered ${response.status}`,
      response.status,
      'hosted-door',
    );
  }
  return { ok: true, payload };
}

/**
 * Rebuild the payer's view of the channel from the hosted usage read.
 *
 * This mirrors the Worker's own `loadMicrochargeChannel` derivation on purpose:
 * the cumulative claim a new voucher must exceed is the HIGHEST claim already
 * observed, not the count of receipts. Deriving it from the receipts rather than
 * tracking it locally is what makes a client that missed a unit (a crash, a
 * concurrent seat) recover the right base instead of regressing into a refusal.
 */
export function channelFromUsage(usage: ChannelUsageWire): MicrochargeChannel {
  const reservations: Record<string, bigint> = {};
  const receipts: Record<string, string> = {};
  let lastCumulativeMicros = 0n;
  for (const r of usage.receipts) {
    const claim = BigInt(r.cumulativeClaimMicros);
    if (claim > lastCumulativeMicros) lastCumulativeMicros = claim;
    if (r.state === 'reserved') reservations[r.usageNonce] = BigInt(r.reservedMicros);
    else receipts[r.usageNonce] = r.voucherDigest;
  }
  return {
    channelId: usage.channelId,
    escrowMicros: BigInt(usage.escrowMicros),
    committedMicros: BigInt(usage.committedMicros),
    lastCumulativeMicros,
    reservations,
    receipts,
  };
}

export async function readChannelUsage(
  channelId: string,
  deps: MeteredTransportDeps = {},
): Promise<{ ok: true; usage: ChannelUsageWire } | MeteredDoorFailure> {
  const called = await callHostedDoor(
    { path: `${CHANNEL_USAGE_PATH}/${encodeURIComponent(channelId)}/usage`, method: 'GET', expect: [200] },
    deps,
  );
  if (!('usage' in called) && called.ok !== true) return called as MeteredDoorFailure;
  const payload = (called as { payload: Record<string, unknown> }).payload;
  return { ok: true, usage: payload as unknown as ChannelUsageWire };
}

/** Amounts cross the JSON boundary as decimal STRINGS: micros can exceed 2^53. */
function voucherWire(voucher: CumulativePaymentVoucher): Record<string, unknown> {
  return {
    channelId: voucher.channelId,
    payer: voucher.payer,
    seller: voucher.seller,
    releaseRef: voucher.releaseRef,
    usageNonce: voucher.usageNonce,
    meterQuantity: String(voucher.meterQuantity),
    pricePerUnitMicros: String(voucher.pricePerUnitMicros),
    priceVersion: voucher.priceVersion,
    splitManifestHash: voucher.splitManifestHash,
    expiresAtMs: voucher.expiresAtMs,
    cumulativeClaimMicros: String(voucher.cumulativeClaimMicros),
    signature: voucher.signature,
  };
}

export interface ReserveMeteredUnitInput {
  readonly channelId: string;
  readonly offerId: string;
  /** The published per-use terms, as `cupboard:checkout`'s preflight returned them. */
  readonly terms: PerUseTermsInput;
  readonly payer: string;
  readonly seller: string;
  readonly releaseRef: string;
  readonly usageNonce: string;
  readonly quantity: bigint;
  readonly expiresAtMs: number;
  readonly nowMs?: number;
  readonly signVoucher: MeteredByteSigner;
}

export interface ReserveMeteredUnitOk {
  readonly ok: true;
  readonly meter: MeterDeclaration;
  readonly voucher: CumulativePaymentVoucher;
  readonly reservedMicros: bigint;
  readonly receipt: UsageReceiptWire;
}

/**
 * INTERCEPTION POINT — reserve one billable unit before the seller executes it.
 *
 * Order is load-bearing: declare the meter, read the channel, refuse locally,
 * sign, and only then POST. A unit that cannot produce a `MeterDeclaration`
 * never reaches the network, which is what stops an unpriced unit from being
 * served on the assumption that the hosted door will catch it.
 */
export async function reserveMeteredUnit(
  input: ReserveMeteredUnitInput,
  deps: MeteredTransportDeps = {},
): Promise<ReserveMeteredUnitOk | MeteredDoorFailure> {
  const declared = declareMeter(input.terms);
  if (!declared.ok) return fail(declared.code, declared.detail, 0, 'local-interception');

  const usage = await readChannelUsage(input.channelId, deps);
  if (usage.ok !== true) return usage;
  const channel = channelFromUsage(usage.usage);

  const unit: BillableUnit = {
    payer: input.payer,
    seller: input.seller,
    releaseRef: input.releaseRef,
    usageNonce: input.usageNonce,
    quantity: input.quantity,
    expiresAtMs: input.expiresAtMs,
  };
  const nowMs = input.nowMs ?? Date.now();

  // Pass 1 captures the canonical bytes and runs every local refusal.
  let voucherBytes: Buffer | null = null;
  const probe = openMeteredInvocation({
    channel,
    meter: declared.meter,
    unit,
    nowMs,
    signVoucher: (bytes) => {
      voucherBytes = bytes;
      return 'probe';
    },
  });
  if (!probe.ok) return fail(probe.code, probe.detail, 0, 'local-interception');
  if (!voucherBytes) {
    return fail('unsigned-voucher', 'the interception never requested a voucher signature', 0, 'local-interception');
  }

  const signature = await input.signVoucher(voucherBytes);
  if (typeof signature !== 'string' || !signature.trim()) {
    return fail('unsigned-voucher', 'the payer signer returned no signature for the cumulative voucher', 0, 'local-interception');
  }

  // Pass 2 is pass 1 plus the real signature — same pure inputs, same bytes.
  const opened = openMeteredInvocation({ channel, meter: declared.meter, unit, nowMs, signVoucher: () => signature });
  if (!opened.ok) return fail(opened.code, opened.detail, 0, 'local-interception');

  const called = await callHostedDoor(
    {
      path: METERED_INVOCATIONS_PATH,
      method: 'POST',
      body: { channelId: input.channelId, offerId: input.offerId, voucher: voucherWire(opened.voucher) },
      expect: [201],
    },
    deps,
  );
  if (called.ok !== true) return called;

  return {
    ok: true,
    meter: declared.meter,
    voucher: opened.voucher,
    reservedMicros: opened.reservedMicros,
    receipt: (called.payload.receipt ?? {}) as UsageReceiptWire,
  };
}

export interface SettleMeteredUnitInput {
  readonly channelId: string;
  readonly usageNonce: string;
  /** Units actually served; defaults to the reserved quantity. Never more. */
  readonly actualQuantity?: bigint;
  readonly occurredAtMs?: number;
  readonly signReceipt: MeteredByteSigner;
}

export interface SettleMeteredUnitOk {
  readonly ok: true;
  readonly amountMicros: bigint;
  readonly receipt: UsageReceiptWire;
}

/**
 * INTERCEPTION POINT — settle the units actually served, after execution.
 *
 * The reserved voucher is rebuilt from the hosted receipt rather than from
 * anything the seller kept in memory, so a seller that restarted mid-unit
 * settles the same reservation instead of minting a second one.
 */
export async function settleMeteredUnit(
  input: SettleMeteredUnitInput,
  deps: MeteredTransportDeps = {},
): Promise<SettleMeteredUnitOk | MeteredDoorFailure> {
  const usage = await readChannelUsage(input.channelId, deps);
  if (usage.ok !== true) return usage;

  const reserved = usage.usage.receipts.find((r) => r.usageNonce === input.usageNonce);
  if (!reserved) {
    return fail('unknown-reservation', `no reservation for usage nonce '${input.usageNonce}'`, 0, 'local-interception');
  }
  if (reserved.state === 'settled') {
    return fail('already-settled', `usage nonce '${input.usageNonce}' was already settled`, 0, 'local-interception');
  }

  const channel = channelFromUsage(usage.usage);
  const voucher: CumulativePaymentVoucher = {
    channelId: reserved.channelId,
    payer: reserved.payer,
    seller: reserved.seller,
    releaseRef: reserved.releaseRef,
    usageNonce: reserved.usageNonce,
    meterQuantity: BigInt(reserved.meterQuantity),
    pricePerUnitMicros: BigInt(reserved.unitPriceMicros),
    priceVersion: reserved.priceVersion,
    splitManifestHash: reserved.splitManifestHash,
    // Read back, never substituted: `expiresAtMs` is hashed into the voucher
    // digest the receipt binds to, so a fabricated value would settle against a
    // voucher the payer never signed. Expiry is not re-checked here — the unit
    // was admitted at reservation — this is the DIGEST's input, not a deadline.
    expiresAtMs: reserved.expiresAtMs,
    cumulativeClaimMicros: BigInt(reserved.cumulativeClaimMicros),
    signature: reserved.voucherSignature,
  };

  const occurredAtMs = input.occurredAtMs ?? Date.now();
  const quantityArg = input.actualQuantity != null ? { actualQuantity: input.actualQuantity } : {};

  let receiptBytes: Buffer | null = null;
  const probe = closeMeteredInvocation({
    channel,
    voucher,
    ...quantityArg,
    occurredAtMs,
    signReceipt: (bytes) => {
      receiptBytes = bytes;
      return 'probe';
    },
  });
  if (!probe.ok) return fail(probe.code, probe.detail, 0, 'local-interception');
  if (!receiptBytes) {
    return fail('unsigned-receipt', 'the interception never requested a receipt signature', 0, 'local-interception');
  }

  const signature = await input.signReceipt(receiptBytes);
  if (typeof signature !== 'string' || !signature.trim()) {
    return fail('unsigned-receipt', 'the seller signer returned no signature for the usage receipt', 0, 'local-interception');
  }

  const closed = closeMeteredInvocation({
    channel,
    voucher,
    ...quantityArg,
    occurredAtMs,
    signReceipt: () => signature,
  });
  if (!closed.ok) return fail(closed.code, closed.detail, 0, 'local-interception');

  const called = await callHostedDoor(
    {
      path: `${METERED_INVOCATIONS_PATH}/${encodeURIComponent(input.usageNonce)}/settle`,
      method: 'POST',
      body: {
        channelId: input.channelId,
        receiptSignature: signature,
        ...(input.actualQuantity != null ? { actualQuantity: String(input.actualQuantity) } : {}),
      },
      expect: [200],
    },
    deps,
  );
  if (called.ok !== true) return called;

  return { ok: true, amountMicros: closed.amountMicros, receipt: (called.payload.receipt ?? {}) as UsageReceiptWire };
}
