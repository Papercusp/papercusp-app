/** Safe/Zodiac-style bounded treasury controls (P-023). */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import type { RevenueShare, SettlementReconciliation } from './revenue-settlement';
import type { CommerceEvent } from './commerce-events';

export type TreasuryRole = 'settlement' | 'host-payout' | 'reserve-transfer' | 'emergency-pause';
export interface SafeTreasuryConfig {
  readonly chainId: number;
  readonly safeAddress: string;
  readonly owners: readonly string[];
  readonly threshold: number;
  /**
   * The key the AUTOMATION signs role-bounded transfers with (P-034).
   *
   * Kept distinct from `owners` by `validateTreasuryConfig`, which is what
   * "owner threshold control separate from automated roles" means in practice:
   * a Zodiac role grants this signer a bounded, allowlisted spend through the
   * roles module, and nothing more. If the same key were also a Safe owner it
   * would additionally count toward the owner threshold, so a compromise of the
   * always-online automation key would erode the offline owner control that is
   * supposed to sit above it.
   */
  readonly automationSigner: string;
  readonly roles: Readonly<Record<TreasuryRole, { readonly enabled: boolean; readonly maxAmountMicros: bigint; readonly allowedRecipients: readonly string[]; readonly allowedTokens: readonly string[] }>>;
}

export type TreasuryConfigResult = { ok: true } | { ok: false; code: 'invalid-config'; detail: string };
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function validateTreasuryConfig(config: SafeTreasuryConfig): TreasuryConfigResult {
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0 || !ADDRESS.test(config.safeAddress)) return { ok: false, code: 'invalid-config', detail: 'chainId and safeAddress are required' };
  if (config.owners.length === 0 || new Set(config.owners.map((o) => o.toLowerCase())).size !== config.owners.length || !Number.isSafeInteger(config.threshold) || config.threshold < 1 || config.threshold > config.owners.length) return { ok: false, code: 'invalid-config', detail: 'owners must be unique and threshold must be within owner count' };
  if (!ADDRESS.test(config.automationSigner)) return { ok: false, code: 'invalid-config', detail: 'automationSigner must be an EVM address' };
  // Owner threshold control separate from automated roles (P-034). An
  // automation key that is ALSO an owner counts toward the owner threshold, so
  // compromising the always-online signer would erode the offline control meant
  // to sit above it. Refuse the configuration rather than the transfer: by the
  // time a transfer is authorized, the separation is already gone.
  if (config.owners.some((owner) => owner.toLowerCase() === config.automationSigner.toLowerCase())) {
    return { ok: false, code: 'invalid-config', detail: 'automationSigner must not be a Safe owner; automated roles are bounded separately from owner threshold control' };
  }
  for (const role of ['settlement', 'host-payout', 'reserve-transfer', 'emergency-pause'] as const) {
    const spec = config.roles[role];
    if (!spec || spec.maxAmountMicros < 0n || spec.allowedTokens.some((t) => !ADDRESS.test(t)) || spec.allowedRecipients.some((r) => !ADDRESS.test(r))) return { ok: false, code: 'invalid-config', detail: `invalid ${role} role bounds` };
  }
  return { ok: true };
}

export interface TreasuryTransferRequest {
  readonly role: TreasuryRole;
  readonly token: string;
  readonly recipient: string;
  readonly amountMicros: bigint;
  readonly settlementReceiptHash: string;
  readonly policyApproved: boolean;
}

export type TreasuryAuthorization = { ok: true; safeTxHash: string; request: TreasuryTransferRequest } | { ok: false; code: 'config-invalid' | 'role-disabled' | 'policy-not-approved' | 'token-not-allowed' | 'recipient-not-allowed' | 'amount-exceeds-role-cap' | 'invalid-request'; detail: string };

/** Authorize a bounded transfer; submitting the Safe transaction remains an injected edge. */
export function authorizeTreasuryTransfer(config: SafeTreasuryConfig, request: TreasuryTransferRequest): TreasuryAuthorization {
  const valid = validateTreasuryConfig(config);
  if (!valid.ok) return { ok: false, code: 'config-invalid', detail: valid.detail };
  const role = config.roles[request.role];
  if (!role?.enabled) return { ok: false, code: 'role-disabled', detail: `treasury role '${request.role}' is disabled` };
  if (!request.policyApproved) return { ok: false, code: 'policy-not-approved', detail: 'treasury transfer requires explicit policy approval' };
  if (!ADDRESS.test(request.token) || !role.allowedTokens.map((t) => t.toLowerCase()).includes(request.token.toLowerCase())) return { ok: false, code: 'token-not-allowed', detail: 'token is outside the role allowlist' };
  if (!ADDRESS.test(request.recipient) || !role.allowedRecipients.map((r) => r.toLowerCase()).includes(request.recipient.toLowerCase())) return { ok: false, code: 'recipient-not-allowed', detail: 'recipient is outside the role allowlist' };
  if (request.amountMicros <= 0n || request.amountMicros > role.maxAmountMicros || !request.settlementReceiptHash.trim()) return { ok: false, code: 'amount-exceeds-role-cap', detail: 'amount must be positive, within role cap, and bound to a settlement receipt' };
  const txBody = { amountMicros: request.amountMicros.toString(), chainId: config.chainId, recipient: request.recipient.toLowerCase(), role: request.role, safeAddress: config.safeAddress.toLowerCase(), settlementReceiptHash: request.settlementReceiptHash, token: request.token.toLowerCase() };
  return { ok: true, safeTxHash: createHash('sha256').update(canonicalJson(txBody)).digest('hex'), request };
}

// ─────────────────────────────────────────────────────────────────────────────
// P-034 — routing a RECONCILED settlement to a DEPLOYED Safe
// ─────────────────────────────────────────────────────────────────────────────

export type TreasuryNetwork = 'testnet' | 'mainnet';

/**
 * A Safe + Zodiac Roles v2 deployment that has actually been observed on chain.
 *
 * The routing door requires one of these before it will move anything, which is
 * the difference between "we configured a Safe address" and "a Safe exists at
 * that address on that chain, with a roles module, and here is the transaction
 * that put it there". A typo in a configured address is otherwise indetectable
 * until funds are sent to it, and on chain that is not recoverable.
 */
export interface SafeDeploymentRecord {
  readonly chainId: number;
  readonly safeAddress: string;
  /** Zodiac Roles modifier enabled on the Safe; the automation signs through it. */
  readonly rolesModuleAddress: string;
  readonly rolesVersion: 'v2';
  readonly deploymentTxHash: string;
  readonly network: TreasuryNetwork;
  readonly deployedAtMs: number;
}

export type SafeDeploymentResult = { ok: true } | { ok: false; code: 'invalid-deployment'; detail: string };
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export function validateSafeDeployment(deployment: SafeDeploymentRecord): SafeDeploymentResult {
  if (!Number.isSafeInteger(deployment.chainId) || deployment.chainId <= 0) return { ok: false, code: 'invalid-deployment', detail: 'chainId must be a positive integer' };
  if (!ADDRESS.test(deployment.safeAddress)) return { ok: false, code: 'invalid-deployment', detail: 'safeAddress must be an EVM address' };
  if (!ADDRESS.test(deployment.rolesModuleAddress)) return { ok: false, code: 'invalid-deployment', detail: 'rolesModuleAddress must be an EVM address' };
  // Only Roles v2 is accepted. v1 has a different, weaker scoping model, and
  // silently accepting it would mean the role bounds asserted here are not the
  // bounds actually enforced on chain.
  if (deployment.rolesVersion !== 'v2') return { ok: false, code: 'invalid-deployment', detail: 'only Zodiac Roles v2 is supported' };
  if (deployment.safeAddress.toLowerCase() === deployment.rolesModuleAddress.toLowerCase()) return { ok: false, code: 'invalid-deployment', detail: 'rolesModuleAddress must differ from safeAddress' };
  if (!TX_HASH.test(deployment.deploymentTxHash)) return { ok: false, code: 'invalid-deployment', detail: 'deploymentTxHash must be a 32-byte transaction hash' };
  if (deployment.network !== 'testnet' && deployment.network !== 'mainnet') return { ok: false, code: 'invalid-deployment', detail: 'network must be testnet or mainnet' };
  if (!Number.isSafeInteger(deployment.deployedAtMs) || deployment.deployedAtMs <= 0) return { ok: false, code: 'invalid-deployment', detail: 'deployedAtMs must be a positive timestamp' };
  return { ok: true };
}

/** One share of a reconciled settlement, routed as a single bounded transfer. */
export interface PlannedTreasuryTransfer {
  readonly share: RevenueShare;
  readonly role: TreasuryRole;
  readonly token: string;
  readonly recipient: string;
  readonly amountMicros: bigint;
  readonly settlementReceiptHash: string;
  readonly safeTxHash: string;
}

export type TreasuryRoutingRefusalCode =
  | 'config-invalid'
  | 'deployment-invalid'
  | 'deployment-chain-mismatch'
  | 'deployment-safe-mismatch'
  | 'mainnet-capital-not-approved'
  | 'no-routable-share'
  | 'transfer-not-authorized';

export type TreasuryRoutingResult =
  | { readonly ok: true; readonly transfers: readonly PlannedTreasuryTransfer[] }
  | { readonly ok: false; readonly code: TreasuryRoutingRefusalCode; readonly detail: string };

/**
 * Plan the treasury transfers a reconciled settlement authorizes (P-034).
 *
 * `policyApproved` is set HERE, from evidence, and is never accepted from a
 * caller: a settlement that reconciled against the immutable manifest, against a
 * Safe deployment recorded on the matching chain, and past the mainnet-capital
 * gate is approved; anything else refuses. Passing the flag inward from a
 * request body would make `authorizeTreasuryTransfer`'s approval check
 * decorative — the caller would simply assert the approval it needed.
 *
 * Zero-amount shares are skipped rather than refused: a split that allocates 0
 * bps to a routed share is a legitimate configuration, and a zero transfer would
 * spend gas to move nothing. If NO share is routable the whole plan refuses,
 * because silently doing nothing reads to the caller as a successful routing.
 */
export function planTreasuryRouting(input: {
  readonly config: SafeTreasuryConfig;
  readonly deployment: SafeDeploymentRecord;
  readonly reconciliation: SettlementReconciliation;
  readonly token: string;
  readonly role: TreasuryRole;
  readonly routedShares: readonly RevenueShare[];
  /** Owner-gated. Mainnet capital moves only when the owner has said so. */
  readonly mainnetCapitalApproved: boolean;
}): TreasuryRoutingResult {
  const config = validateTreasuryConfig(input.config);
  if (!config.ok) return { ok: false, code: 'config-invalid', detail: config.detail };
  const deployment = validateSafeDeployment(input.deployment);
  if (!deployment.ok) return { ok: false, code: 'deployment-invalid', detail: deployment.detail };
  if (input.deployment.chainId !== input.config.chainId) {
    return { ok: false, code: 'deployment-chain-mismatch', detail: `deployment is on chain ${input.deployment.chainId}, treasury is configured for ${input.config.chainId}` };
  }
  if (input.deployment.safeAddress.toLowerCase() !== input.config.safeAddress.toLowerCase()) {
    return { ok: false, code: 'deployment-safe-mismatch', detail: 'recorded deployment is for a different Safe address' };
  }
  if (input.deployment.network === 'mainnet' && !input.mainnetCapitalApproved) {
    return { ok: false, code: 'mainnet-capital-not-approved', detail: 'moving mainnet capital requires explicit owner approval' };
  }

  const transfers: PlannedTreasuryTransfer[] = [];
  for (const share of input.routedShares) {
    const amountMicros = input.reconciliation.allocationsMicros[share] ?? 0n;
    if (amountMicros <= 0n) continue;
    const authorized = authorizeTreasuryTransfer(input.config, {
      role: input.role,
      token: input.token,
      recipient: input.reconciliation.daoTreasury,
      amountMicros,
      settlementReceiptHash: input.reconciliation.receiptHash,
      policyApproved: true,
    });
    if (!authorized.ok) {
      return { ok: false, code: 'transfer-not-authorized', detail: `${share}: ${authorized.detail}` };
    }
    transfers.push({
      share,
      role: input.role,
      token: input.token,
      recipient: input.reconciliation.daoTreasury,
      amountMicros,
      settlementReceiptHash: input.reconciliation.receiptHash,
      safeTxHash: authorized.safeTxHash,
    });
  }
  if (transfers.length === 0) {
    return { ok: false, code: 'no-routable-share', detail: 'the reconciled settlement allocates nothing to the routed treasury shares' };
  }
  return { ok: true, transfers };
}

/**
 * Build the auditable DAO treasury receipt for a routed transfer (P-034).
 *
 * Reuses the existing `revenue-split` commerce event kind rather than adding an
 * eighth: `COMMERCE_EVENT_KINDS` already declares it, `ledger-p2p-bridge.ts`
 * already routes it to the per-use rollup, and a new kind would have needed
 * both to change for a fact the existing one names exactly.
 *
 * The caller signs the returned bytes (`commerceEventSigningBytes`); this
 * module never holds a key — the same contract as `buildSettlementProofEvent`.
 *
 * `idempotencyKey` is (receipt hash, share), matching the durable unique index
 * on `treasury_transfers`, so a replayed routing collides on the event log for
 * the same reason it collides in the table.
 */
export function buildTreasuryTransferEvent(input: {
  readonly streamId: string;
  readonly issuer: string;
  readonly sequence: number;
  readonly occurredAtMs: number;
  readonly transfer: PlannedTreasuryTransfer;
  readonly reconciliation: SettlementReconciliation;
  readonly deployment: SafeDeploymentRecord;
  readonly transaction: { readonly transactionHash: string; readonly blockNumber: bigint };
}): Omit<CommerceEvent, 'signature'> {
  const allocations: Record<string, string> = {};
  for (const [share, amount] of Object.entries(input.reconciliation.allocationsMicros)) {
    allocations[share] = amount.toString();
  }
  const key = `treasury:${input.reconciliation.receiptHash}:${input.transfer.share}`;
  return {
    eventId: key,
    streamId: input.streamId,
    kind: 'revenue-split',
    version: 1,
    issuer: input.issuer,
    sequence: input.sequence,
    occurredAtMs: input.occurredAtMs,
    idempotencyKey: key,
    payload: {
      settlementId: input.reconciliation.settlementId,
      receiptHash: input.reconciliation.receiptHash,
      // The manifest hash makes the receipt auditable against the split the
      // payer signed, not merely against the numbers we chose to record.
      splitManifestHash: input.reconciliation.splitManifestHash,
      providerCostMicros: input.reconciliation.providerCostMicros.toString(),
      distributableMicros: input.reconciliation.distributableMicros.toString(),
      allocationsMicros: allocations,
      share: input.transfer.share,
      role: input.transfer.role,
      amountMicros: input.transfer.amountMicros.toString(),
      token: input.transfer.token,
      recipient: input.transfer.recipient,
      chainId: input.deployment.chainId,
      safeAddress: input.deployment.safeAddress,
      rolesModuleAddress: input.deployment.rolesModuleAddress,
      rolesVersion: input.deployment.rolesVersion,
      network: input.deployment.network,
      safeTxHash: input.transfer.safeTxHash,
      transactionHash: input.transaction.transactionHash,
      blockNumber: input.transaction.blockNumber.toString(),
    },
  };
}
