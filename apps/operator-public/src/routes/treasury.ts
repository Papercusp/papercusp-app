/**
 * Authenticated production door for P-034 DAO treasury routing (acceptance
 * line 13).
 *
 * P-033 RECORDED a settlement's allocations; this ROUTES them. The chain of
 * refusals between the two is the whole item:
 *
 *   1. the batch must be FINAL, not merely claimed — a reorg can still drop a
 *      claim, and unlike an unwound claim there is no undoing a transfer that
 *      has already left the Safe;
 *   2. the recorded allocations must RECONCILE against the deployment's
 *      immutable split manifest, share by share — the numbers sat in a D1 row
 *      between claim and routing, and routing on the row alone would trust a
 *      value nothing re-checked;
 *   3. a Safe + Zodiac Roles v2 DEPLOYMENT must be recorded for the configured
 *      (chain, address) — a configured address is not evidence a Safe exists
 *      there, and funds sent to a typo are unrecoverable;
 *   4. `policyApproved` is derived HERE from those facts and is never read from
 *      the request body — a caller that could assert its own approval would
 *      make the P-023 policy check decorative;
 *   5. mainnet capital additionally requires the owner's explicit approval.
 *
 * Owner-gated by design (acceptance line 13): the Safe signers, the automation
 * key, and mainnet capital. Missing credentials answer 503 rather than
 * attempting a transfer that cannot be signed.
 */
import { Hono } from 'hono';
import {
  buildTreasuryTransferEvent,
  planTreasuryRouting,
  validateSafeDeployment,
  type SafeDeploymentRecord,
  type SafeTreasuryConfig,
  type TreasuryNetwork,
} from '@papercusp/operator-core/lib/p2p/treasury-controls.ts';
import {
  REVENUE_SHARES,
  reconcileSettlement,
  type RevenueShare,
  type SettlementReceipt,
} from '@papercusp/operator-core/lib/p2p/revenue-settlement.ts';
import {
  commerceEventSigningBytes,
  type CommerceEvent,
} from '@papercusp/operator-core/lib/p2p/commerce-events.ts';
import type { Env } from '../env.ts';
import { AuthError, isCupboardOperator, resolveGithubBearer } from '../auth.ts';
import { getSettlementBatch, type StoredSettlementBatch } from '../settlement-batch-store.ts';
import {
  appendCommerceEvent,
  nextCommerceEventSequence,
} from '../commerce-event-log-store.ts';
import {
  getSafeDeployment,
  getTreasuryTransferForShare,
  listBatchTreasuryTransfers,
  listSafeDeployments,
  recordSafeDeployment,
  recordTreasuryTransfer,
  type StoredSafeDeployment,
} from '../treasury-store.ts';
import {
  createViemSafeTreasuryAdapter,
  type SafeTreasuryAdapter,
} from '../treasury-adapter.ts';
import { resolveSplitConfig } from './settlements.ts';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Shares that may be routed into the DAO Safe.
 *
 * `creator`, `host` and `component` are PAYEE shares — money owed outward to a
 * person — so they are refused here rather than quietly swept into the
 * treasury. Their payout rail is a separate concern with a separate role.
 */
const TREASURY_ELIGIBLE_SHARES: readonly RevenueShare[] = ['dao', 'reserve', 'tax', 'operating'];

async function authenticate(
  request: Request,
): Promise<{ ok: true; principalId: string; userId: number } | { ok: false; reason: AuthError['reason'] }> {
  try {
    const user = await resolveGithubBearer(request);
    return { ok: true, principalId: `gh:${user.id}`, userId: user.id };
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, reason: error.reason };
    throw error;
  }
}

async function jsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function required(value: string | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseList(value: string | undefined): readonly string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export type TreasuryConfigResolution =
  | {
      readonly ok: true;
      readonly config: SafeTreasuryConfig;
      readonly routedShares: readonly RevenueShare[];
      readonly mainnetCapitalApproved: boolean;
    }
  | { readonly ok: false; readonly code: 'not-configured' | 'invalid-config'; readonly detail: string };

/**
 * Resolve the deployment's Safe treasury policy.
 *
 * The automation signer comes from the ADAPTER (the address derived from the
 * signing key), never from a var: a configured signer address that disagreed
 * with the key actually signing would make the owner-separation check assert
 * something about a signer that is not the one spending.
 */
export function resolveTreasuryConfig(env: Env, adapter: SafeTreasuryAdapter): TreasuryConfigResolution {
  const safeAddress = required(env.TREASURY_SAFE_ADDRESS);
  const owners = parseList(env.TREASURY_SAFE_OWNERS);
  const thresholdRaw = required(env.TREASURY_SAFE_THRESHOLD);
  const maxRaw = required(env.TREASURY_SETTLEMENT_MAX_MICROS);
  const daoTreasury = required(env.DAO_TREASURY_ADDRESS);

  const missing = [
    safeAddress ? null : 'TREASURY_SAFE_ADDRESS',
    owners.length > 0 ? null : 'TREASURY_SAFE_OWNERS',
    thresholdRaw ? null : 'TREASURY_SAFE_THRESHOLD',
    maxRaw ? null : 'TREASURY_SETTLEMENT_MAX_MICROS',
    daoTreasury ? null : 'DAO_TREASURY_ADDRESS',
    required(env.PAYMENT_CHANNEL_STABLECOIN) ? null : 'PAYMENT_CHANNEL_STABLECOIN',
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    return { ok: false, code: 'not-configured', detail: `treasury policy is unavailable; missing ${missing.join(', ')}` };
  }

  const threshold = Number(thresholdRaw);
  if (!Number.isSafeInteger(threshold) || threshold < 1) {
    return { ok: false, code: 'invalid-config', detail: `TREASURY_SAFE_THRESHOLD must be a positive integer, got '${thresholdRaw}'` };
  }
  // A SET but unparseable cap is an error, never a silent fallback: defaulting
  // a per-transfer spending cap the operator meant to set is exactly the
  // failure a cap exists to prevent.
  let maxAmountMicros: bigint;
  try {
    maxAmountMicros = BigInt(maxRaw as string);
  } catch {
    return { ok: false, code: 'invalid-config', detail: `TREASURY_SETTLEMENT_MAX_MICROS must be an integer, got '${maxRaw}'` };
  }
  if (maxAmountMicros <= 0n) {
    return { ok: false, code: 'invalid-config', detail: 'TREASURY_SETTLEMENT_MAX_MICROS must be positive' };
  }

  const configuredShares = parseList(env.TREASURY_ROUTED_SHARES);
  const routedShares: RevenueShare[] = [];
  for (const entry of configuredShares.length > 0 ? configuredShares : ['dao']) {
    if (!REVENUE_SHARES.includes(entry as RevenueShare)) {
      return { ok: false, code: 'invalid-config', detail: `TREASURY_ROUTED_SHARES contains unknown share '${entry}'` };
    }
    if (!TREASURY_ELIGIBLE_SHARES.includes(entry as RevenueShare)) {
      return {
        ok: false,
        code: 'invalid-config',
        detail: `TREASURY_ROUTED_SHARES may not route payee share '${entry}' into the DAO Safe`,
      };
    }
    routedShares.push(entry as RevenueShare);
  }

  const token = required(env.PAYMENT_CHANNEL_STABLECOIN) as string;
  if (!ADDRESS.test(token)) {
    return { ok: false, code: 'invalid-config', detail: 'PAYMENT_CHANNEL_STABLECOIN must be an EVM address' };
  }
  if (!ADDRESS.test(daoTreasury as string)) {
    return { ok: false, code: 'invalid-config', detail: 'DAO_TREASURY_ADDRESS must be an EVM address' };
  }

  const role = {
    enabled: true,
    maxAmountMicros,
    allowedRecipients: [daoTreasury as string],
    allowedTokens: [token],
  };
  // Only the `settlement` role is enabled for automation. The payout, reserve
  // and pause roles exist in the config so their bounds are explicit, and are
  // disabled so this door cannot reach them.
  const disabled = { ...role, enabled: false };
  const config: SafeTreasuryConfig = {
    chainId: adapter.chainId,
    safeAddress: safeAddress as string,
    owners,
    threshold,
    automationSigner: adapter.automationSigner,
    roles: {
      settlement: role,
      'host-payout': disabled,
      'reserve-transfer': disabled,
      'emergency-pause': disabled,
    },
  };
  return {
    ok: true,
    config,
    routedShares,
    // Defaults to REFUSE. Only the exact string 'true' opens the mainnet gate.
    mainnetCapitalApproved: required(env.TREASURY_MAINNET_CAPITAL_APPROVED) === 'true',
  };
}

/**
 * Rebuild the settlement receipt from its durable row, for re-reconciliation.
 *
 * `receiptHash` is carried through from the row rather than recomputed here on
 * purpose: `reconcileSettlement` recomputes it and compares, so recomputing it
 * on the way IN would make that comparison compare a value with itself and
 * always agree.
 */
function receiptFromBatch(batch: StoredSettlementBatch): SettlementReceipt {
  const allocationsMicros = {} as Record<RevenueShare, bigint>;
  for (const share of REVENUE_SHARES) allocationsMicros[share] = BigInt(batch.allocationsMicros[share]);
  return {
    settlementId: batch.settlementId,
    currency: 'stablecoin-micros',
    grossMicros: BigInt(batch.claimMicros),
    providerCostMicros: BigInt(batch.providerCostMicros),
    distributableMicros: BigInt(batch.distributableMicros),
    allocationsMicros,
    daoTreasury: batch.daoTreasury,
    splitManifestHash: batch.splitManifestHash,
    receiptHash: batch.receiptHash,
  };
}

function deploymentJson(deployment: StoredSafeDeployment) {
  return {
    chainId: deployment.chainId,
    safeAddress: deployment.safeAddress,
    rolesModuleAddress: deployment.rolesModuleAddress,
    rolesVersion: deployment.rolesVersion,
    deploymentTransactionHash: deployment.deploymentTxHash,
    network: deployment.network,
    owners: [...deployment.owners],
    threshold: deployment.threshold,
    automationSigner: deployment.automationSigner,
    deployedAtMs: deployment.deployedAtMs,
    recordedAtMs: deployment.recordedAtMs,
    recordedBy: deployment.recordedBy,
  };
}

function adapterFor(env: Env, injected: SafeTreasuryAdapter | undefined) {
  return injected ? { ok: true as const, adapter: injected } : createViemSafeTreasuryAdapter(env);
}

function treasuryStream(channelId: string): string {
  return `treasury:${channelId}`;
}

export function treasuryRoute(
  options: { adapter?: SafeTreasuryAdapter } = {},
): Hono<{ Bindings: Env }> {
  const route = new Hono<{ Bindings: Env }>();

  /**
   * Record an observed Safe + Zodiac Roles v2 deployment.
   *
   * Operator-gated, not merely authenticated: this is the record every routing
   * decision rests on, so writing it is an operator action attributed to a
   * GitHub id. The pilot records a TESTNET deployment; a mainnet record is
   * accepted here (so the fact is auditable) but routing against it still
   * requires the owner's approval gate.
   */
  route.post('/commerce/treasury/safe-deployments', async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401);
    // An empty CUPBOARD_OPERATOR_GITHUB_IDS means no operators, so this
    // endpoint 403s by default rather than accepting a deployment record from
    // any authenticated caller.
    if (!isCupboardOperator(auth.userId, c.env)) return c.json({ error: 'forbidden' }, 403);

    const body = await jsonObject(c.req.raw);
    if (!body) return c.json({ error: 'invalid_request' }, 400);
    const chainId = Number(body.chainId);
    const network = body.network;
    if (network !== 'testnet' && network !== 'mainnet') {
      return c.json({ error: 'invalid_request', detail: 'network must be testnet or mainnet' }, 400);
    }
    const owners = Array.isArray(body.owners) ? body.owners.filter((o): o is string => typeof o === 'string') : [];
    const threshold = Number(body.threshold);
    const deployment: SafeDeploymentRecord = {
      chainId,
      safeAddress: typeof body.safeAddress === 'string' ? body.safeAddress : '',
      rolesModuleAddress: typeof body.rolesModuleAddress === 'string' ? body.rolesModuleAddress : '',
      rolesVersion: 'v2',
      deploymentTxHash: typeof body.deploymentTransactionHash === 'string' ? body.deploymentTransactionHash : '',
      network: network as TreasuryNetwork,
      deployedAtMs: Number(body.deployedAtMs),
    };
    const valid = validateSafeDeployment(deployment);
    if (!valid.ok) return c.json({ error: valid.code, detail: valid.detail }, 400);
    const automationSigner = typeof body.automationSigner === 'string' ? body.automationSigner : '';
    if (!ADDRESS.test(automationSigner)) {
      return c.json({ error: 'invalid_request', detail: 'automationSigner must be an EVM address' }, 400);
    }
    if (owners.length === 0 || !owners.every((o) => ADDRESS.test(o))) {
      return c.json({ error: 'invalid_request', detail: 'owners must be a non-empty list of EVM addresses' }, 400);
    }
    if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > owners.length) {
      return c.json({ error: 'invalid_request', detail: 'threshold must be within the owner count' }, 400);
    }
    // The separation invariant, refused at RECORD time as well as at routing
    // time: a deployment whose automation key is an owner is not a deployment
    // this system will ever route through, so recording it would only preserve
    // a state the runtime rejects.
    if (owners.some((o) => o.toLowerCase() === automationSigner.toLowerCase())) {
      return c.json(
        {
          error: 'invalid_request',
          detail: 'automationSigner must not be a Safe owner; owner threshold control stays separate from automated roles',
        },
        400,
      );
    }

    const stored = await recordSafeDeployment(c.env.DB, {
      deployment,
      owners,
      threshold,
      automationSigner,
      recordedBy: auth.principalId,
      nowMs: Date.now(),
    });
    return c.json({ deployment: deploymentJson(stored) }, 201);
  });

  route.get('/commerce/treasury/safe-deployments', async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401);
    const deployments = await listSafeDeployments(c.env.DB);
    return c.json({ deployments: deployments.map(deploymentJson) }, 200);
  });

  /** Route a FINAL batch's reconciled treasury shares into the Safe. */
  route.post('/commerce/payment-channels/:channelId/settlements/:batchId/treasury', async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401);
    const channelId = c.req.param('channelId');
    const batchId = c.req.param('batchId');

    const availability = adapterFor(c.env, options.adapter);
    if (!availability.ok) return c.json({ error: availability.code, detail: availability.detail }, 503);
    const adapter = availability.adapter;
    const policy = resolveTreasuryConfig(c.env, adapter);
    if (!policy.ok) return c.json({ error: policy.code, detail: policy.detail }, 503);
    const split = resolveSplitConfig(c.env);
    if (!split.ok) return c.json({ error: split.code, detail: split.detail }, 503);

    const batch = await getSettlementBatch(c.env.DB, batchId);
    if (!batch || batch.channelId !== channelId || batch.principalId !== auth.principalId) {
      return c.json({ error: 'batch_not_found' }, 404);
    }
    // Acceptance line 14, carried forward: a CLAIM is not money received. A
    // reorg can still drop it, and a transfer out of the Safe cannot be unwound
    // the way an unwound claim can.
    if (batch.state !== 'final') {
      return c.json(
        { error: 'batch_not_final', state: batch.state, detail: 'treasury routing requires a settlement that has reached finality' },
        409,
      );
    }

    const reconciled = reconcileSettlement({
      receipt: receiptFromBatch(batch),
      splitManifest: split.manifest,
    });
    if (!reconciled.ok) {
      return c.json({ error: 'reconciliation_failed', code: reconciled.code, detail: reconciled.detail }, 409);
    }

    const deployment = await getSafeDeployment(c.env.DB, policy.config.chainId, policy.config.safeAddress);
    if (!deployment) {
      return c.json(
        {
          error: 'safe_deployment_unrecorded',
          detail: `no recorded Safe deployment for chain ${policy.config.chainId} at ${policy.config.safeAddress}`,
        },
        409,
      );
    }

    const plan = planTreasuryRouting({
      config: policy.config,
      deployment,
      reconciliation: reconciled.reconciliation,
      token: policy.config.roles.settlement.allowedTokens[0]!,
      role: 'settlement',
      routedShares: policy.routedShares,
      mainnetCapitalApproved: policy.mainnetCapitalApproved,
    });
    if (!plan.ok) return c.json({ error: 'routing_refused', code: plan.code, detail: plan.detail }, 409);

    const nowMs = Date.now();
    const routed: Awaited<ReturnType<typeof listBatchTreasuryTransfers>>[number][] = [];
    const alreadyRouted: string[] = [];
    const unprovenTransfers: string[] = [];

    for (const transfer of plan.transfers) {
      // Re-read before submitting. The unique index stops a double RECORD; only
      // this check stops a double SUBMISSION, and a duplicate transfer is money
      // that has already left the Safe by the time the index refuses the row.
      const existing = await getTreasuryTransferForShare(c.env.DB, transfer.settlementReceiptHash, transfer.share);
      if (existing) {
        alreadyRouted.push(transfer.share);
        routed.push(existing);
        continue;
      }

      let receipt;
      try {
        receipt = await adapter.submitTransfer({
          share: transfer.share,
          token: transfer.token,
          recipient: transfer.recipient,
          amountMicros: transfer.amountMicros,
          safeTxHash: transfer.safeTxHash,
        });
      } catch (error) {
        return c.json(
          {
            error: 'treasury_transfer_failed',
            share: transfer.share,
            detail: error instanceof Error ? error.message : String(error),
            routed: routed.map((entry) => entry.transferId),
          },
          502,
        );
      }

      // The funds have moved. The auditable receipt is written next, and a
      // proof that cannot be sequenced is REPORTED rather than swallowed —
      // never treated as a reason to pretend the transfer did not happen.
      const proof = await recordTreasuryProof(c.env.DB, adapter, {
        streamId: treasuryStream(channelId),
        transfer,
        reconciliation: reconciled.reconciliation,
        deployment,
        transaction: receipt,
        nowMs,
      });
      if (!proof.ok) unprovenTransfers.push(transfer.share);

      const stored = await recordTreasuryTransfer(c.env.DB, {
        transferId: `tt-${transfer.settlementReceiptHash.slice(0, 32)}-${transfer.share}`,
        batchId: batch.batchId,
        channelId,
        principalId: auth.principalId,
        settlementId: reconciled.reconciliation.settlementId,
        receiptHash: transfer.settlementReceiptHash,
        splitManifestHash: reconciled.reconciliation.splitManifestHash,
        share: transfer.share,
        role: transfer.role,
        chainId: deployment.chainId,
        safeAddress: deployment.safeAddress,
        rolesModuleAddress: deployment.rolesModuleAddress,
        token: transfer.token,
        recipient: transfer.recipient,
        amountMicros: transfer.amountMicros,
        safeTxHash: transfer.safeTxHash,
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber,
        proofEventId: proof.ok ? proof.event.eventId : null,
        nowMs,
      });
      if (!stored.ok) alreadyRouted.push(transfer.share);
      routed.push(stored.transfer);
    }

    return c.json(
      {
        batchId: batch.batchId,
        settlementId: reconciled.reconciliation.settlementId,
        receiptHash: reconciled.reconciliation.receiptHash,
        splitManifestHash: reconciled.reconciliation.splitManifestHash,
        network: deployment.network,
        safeAddress: deployment.safeAddress,
        transfers: routed.map(transferJson),
        alreadyRouted,
        // Non-empty means the money moved but its receipt is not on the event
        // log. Surfaced, never hidden behind the 200.
        unprovenTransfers,
      },
      200,
    );
  });

  route.get('/commerce/payment-channels/:channelId/settlements/:batchId/treasury', async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401);
    const batch = await getSettlementBatch(c.env.DB, c.req.param('batchId'));
    if (!batch || batch.channelId !== c.req.param('channelId') || batch.principalId !== auth.principalId) {
      return c.json({ error: 'batch_not_found' }, 404);
    }
    const transfers = await listBatchTreasuryTransfers(c.env.DB, batch.batchId);
    return c.json({ batchId: batch.batchId, transfers: transfers.map(transferJson) }, 200);
  });

  return route;
}

function transferJson(transfer: Awaited<ReturnType<typeof listBatchTreasuryTransfers>>[number]) {
  return {
    transferId: transfer.transferId,
    share: transfer.share,
    role: transfer.role,
    token: transfer.token,
    recipient: transfer.recipient,
    amountMicros: transfer.amountMicros,
    chainId: transfer.chainId,
    safeAddress: transfer.safeAddress,
    rolesModuleAddress: transfer.rolesModuleAddress,
    safeTxHash: transfer.safeTxHash,
    transactionHash: transfer.transactionHash,
    blockNumber: transfer.blockNumber,
    proofEventId: transfer.proofEventId,
    receiptHash: transfer.receiptHash,
    createdAtMs: transfer.createdAtMs,
  };
}

/**
 * Append the signed `revenue-split` treasury receipt to the P-016 log.
 *
 * A sequence collision is retried once against a freshly read watermark, the
 * same way `recordSettlementProof` handles it: two concurrent appends on one
 * stream is an ordinary race, not a failure of the transfer.
 */
async function recordTreasuryProof(
  db: D1Database,
  adapter: SafeTreasuryAdapter,
  input: {
    readonly streamId: string;
    readonly transfer: Parameters<typeof buildTreasuryTransferEvent>[0]['transfer'];
    readonly reconciliation: Parameters<typeof buildTreasuryTransferEvent>[0]['reconciliation'];
    readonly deployment: SafeDeploymentRecord;
    readonly transaction: { readonly transactionHash: string; readonly blockNumber: bigint };
    readonly nowMs: number;
  },
): Promise<{ ok: true; event: CommerceEvent } | { ok: false; detail: string }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sequence = await nextCommerceEventSequence(db, input.streamId);
    const unsigned = buildTreasuryTransferEvent({
      streamId: input.streamId,
      issuer: adapter.automationSigner,
      sequence,
      occurredAtMs: input.nowMs,
      transfer: input.transfer,
      reconciliation: input.reconciliation,
      deployment: input.deployment,
      transaction: input.transaction,
    });
    const signature = await adapter.signTreasuryProof(commerceEventSigningBytes(unsigned));
    const appended = await appendCommerceEvent(db, { ...unsigned, signature }, input.nowMs);
    if (appended.ok) return { ok: true, event: appended.event.event };
    if (appended.code !== 'sequence-conflict') return { ok: false, detail: appended.detail };
  }
  return { ok: false, detail: 'treasury receipt could not be sequenced onto the commerce event log' };
}
