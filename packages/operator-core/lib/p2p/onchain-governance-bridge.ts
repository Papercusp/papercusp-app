/**
 * On-chain governance bridge (P-024).
 *
 * Shared-pot P2P ratification is the product's source-of-truth decision layer. A
 * governance round finalizes off-chain (`governance-round.ts`) and produces a
 * `FinalizationCertificate`; ONLY finalized treasury or contract actions are then
 * mirrored on-chain, through the existing bounded adapters. The bridge is one-way
 * by construction: it consumes a certificate and emits a chain request, and there
 * is no input path by which chain state can admit, reverse, or amend a decision.
 *
 * Two properties this module exists to enforce:
 *  - a decision the pot did NOT ratify can never reach a chain adapter; and
 *  - a chain submission that fails does NOT invalidate the ratified decision
 *    (`decisionStanding` stays true) — the mirror is retried, not re-voted.
 *
 * Token-based ON-CHAIN voting (OpenZeppelin Governor + Timelock, with votes cast
 * and tallied on-chain rather than mirrored) is a documented later option, to be
 * evaluated only if on-chain vote tallying is actually required. It is deliberately
 * NOT built here: adopting it would move the decision layer on-chain and invert the
 * one-way property above.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { verifyFinalizationCertificate, type FinalizationCertificate } from '../agent-tools/plans/governance-round';
import { authorizeTreasuryTransfer, type SafeTreasuryConfig, type TreasuryTransferRequest } from './treasury-controls';
import { buildEvmBatchSettlementRequest, type EvmBatchSettlementRequest, type EvmSettlementConfig } from './evm-settlement';
import type { PaymentChannelState } from './payment-channel';
import type { RefusalContract } from '../capability-envelope/refusal-contract-types';

/** Finalized actions that MAY be mirrored on-chain. */
export const MIRRORABLE_ACTION_KINDS = ['treasury-transfer', 'settlement-batch'] as const;
export type MirrorableActionKind = (typeof MIRRORABLE_ACTION_KINDS)[number];

/** Decisions that stay P2P-authoritative and are never mirrored on-chain. */
export const P2P_ONLY_DECISION_KINDS = ['plan-admission', 'policy-amendment', 'membership-change', 'pause-revoke'] as const;
export type P2POnlyDecisionKind = (typeof P2P_ONLY_DECISION_KINDS)[number];

export type BridgeAction =
  | { readonly kind: 'treasury-transfer'; readonly treasury: SafeTreasuryConfig; readonly request: TreasuryTransferRequest }
  | {
      readonly kind: 'settlement-batch';
      readonly evm: EvmSettlementConfig;
      readonly channel: PaymentChannelState;
      readonly amountMicros: bigint;
      readonly voucherDigests: readonly string[];
    }
  | { readonly kind: P2POnlyDecisionKind };

export interface MirrorRequest {
  readonly certificate: FinalizationCertificate;
  /**
   * The certificate hash the action was authorized under. Must equal
   * `certificate.certificateHash`; this is what stops an action ratified in one
   * round from being replayed under a different round's certificate.
   */
  readonly authorizedByCertificateHash: string;
  readonly action: BridgeAction;
}

export interface MirrorPlan {
  /** Deterministic identity of this mirror — the idempotency key for submission. */
  readonly mirrorId: string;
  readonly roundId: string;
  readonly certificateHash: string;
  readonly kind: MirrorableActionKind;
  readonly chainId: number;
  readonly safeTxHash: string | null;
  readonly settlement: EvmBatchSettlementRequest | null;
}

export type BridgeRefusalCode =
  | 'certificate-not-admitted'
  | 'certificate-tampered'
  | 'decision-not-mirrorable'
  | 'action-not-bound-to-certificate'
  | 'treasury-refused'
  | 'settlement-refused';

export type BridgeResult =
  | { ok: true; plan: MirrorPlan }
  | {
      ok: false;
      code: BridgeRefusalCode;
      detail: string;
      /** WI-10005197: what would LIFT this refusal. Present on the treasury / settlement policy refusals. */
      refusal?: RefusalContract;
    };

export function isMirrorableActionKind(kind: string): kind is MirrorableActionKind {
  return (MIRRORABLE_ACTION_KINDS as readonly string[]).includes(kind);
}

function mirrorId(certificateHash: string, kind: MirrorableActionKind, body: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(canonicalJson({ body, certificateHash, kind })).digest('hex');
}

/**
 * Build the on-chain mirror for a finalized decision, or refuse. Pure: it never
 * submits anything — submission is the injected edge (`executeOnChainMirror`).
 */
export function planOnChainMirror(input: MirrorRequest): BridgeResult {
  const { certificate, action } = input;
  if (!verifyFinalizationCertificate(certificate)) {
    return { ok: false, code: 'certificate-tampered', detail: 'finalization certificate hash does not match its contents' };
  }
  if (input.authorizedByCertificateHash !== certificate.certificateHash) {
    return { ok: false, code: 'action-not-bound-to-certificate', detail: 'action was authorized under a different governance round' };
  }
  if (!certificate.admitted) {
    return { ok: false, code: 'certificate-not-admitted', detail: `round ${certificate.roundId} was not admitted: ${certificate.reason}` };
  }
  // Narrow on the action itself, not via a predicate over `action.kind`: a type
  // predicate on a property does not narrow the parent union, and the settlement
  // arm below needs the discriminated member, not the widened one.
  if (action.kind === 'treasury-transfer') {
    const authorized = authorizeTreasuryTransfer(action.treasury, action.request);
    if (!authorized.ok) {
      return {
        ok: false,
        code: 'treasury-refused',
        detail: `${authorized.code}: ${authorized.detail}`,
        refusal: {
          observed: { treasuryCode: authorized.code, role: action.request.role, chainId: String(action.treasury.chainId) },
          liftsWhen:
            'the transfer request satisfies the treasury policy rule named in observed.treasuryCode (role enabled, ' +
            'policy approved, token and recipient on the allowlist, amount within the role cap and bound to a ' +
            'settlement receipt). Re-sending the SAME request cannot lift it: the requester corrects the request, ' +
            'or the treasury OWNERS change the Safe/Roles configuration through a new governance round',
          whoCanMakeItTrue: ['another-agent', 'owner'],
        },
      };
    }
    const body = {
      amountMicros: action.request.amountMicros.toString(),
      recipient: action.request.recipient.toLowerCase(),
      role: action.request.role,
      safeTxHash: authorized.safeTxHash,
      token: action.request.token.toLowerCase(),
    };
    return {
      ok: true,
      plan: {
        mirrorId: mirrorId(certificate.certificateHash, 'treasury-transfer', body),
        roundId: certificate.roundId,
        certificateHash: certificate.certificateHash,
        kind: 'treasury-transfer',
        chainId: action.treasury.chainId,
        safeTxHash: authorized.safeTxHash,
        settlement: null,
      },
    };
  }

  if (action.kind !== 'settlement-batch') {
    return { ok: false, code: 'decision-not-mirrorable', detail: `'${action.kind}' is a P2P-authoritative decision and is never mirrored on-chain` };
  }

  const built = buildEvmBatchSettlementRequest({
    config: action.evm,
    channel: action.channel,
    amountMicros: action.amountMicros,
    voucherDigests: action.voucherDigests,
  });
  if (!built.ok) {
    return {
      ok: false,
      code: 'settlement-refused',
      detail: `${built.code}: ${built.detail}`,
      refusal: {
        observed: { settlementCode: built.code, voucherCount: String(action.voucherDigests.length) },
        liftsWhen:
          'the batch-settlement request is buildable: the EVM settlement config, payment channel and voucher ' +
          'digests satisfy the rule named in observed.settlementCode. Re-sending the SAME batch cannot lift it: ' +
          'the requester rebuilds the batch from a valid channel state, or the settlement OWNER corrects the EVM config',
        whoCanMakeItTrue: ['another-agent', 'owner'],
      },
    };
  }
  return {
    ok: true,
    plan: {
      mirrorId: mirrorId(certificate.certificateHash, 'settlement-batch', { requestHash: built.request.requestHash }),
      roundId: certificate.roundId,
      certificateHash: certificate.certificateHash,
      kind: 'settlement-batch',
      chainId: built.request.chainId,
      safeTxHash: null,
      settlement: built.request,
    },
  };
}

/** Submitting the transaction is an injected edge — this module never opens an RPC connection. */
export interface OnChainSubmitter {
  submit(plan: MirrorPlan): Promise<{ ok: true; txHash: string } | { ok: false; detail: string }>;
}

/** Records which mirrors already executed, so a replayed certificate cannot double-spend. */
export interface MirrorLedger {
  has(mirrorId: string): Promise<boolean> | boolean;
  record(mirrorId: string, txHash: string): Promise<void> | void;
}

export type MirrorExecution =
  | { ok: true; mirrorId: string; txHash: string; replayed: boolean; decisionStanding: true }
  | { ok: false; code: BridgeRefusalCode; detail: string; decisionStanding: false; refusal?: RefusalContract }
  | { ok: false; code: 'submission-failed'; detail: string; mirrorId: string; decisionStanding: true };

/**
 * Mirror a finalized decision on-chain, at most once.
 *
 * `decisionStanding` reports whether the P2P decision survives this outcome. A
 * submission failure leaves it TRUE — the chain is a mirror, so a failed mirror is
 * retried, never re-voted. It is false only when the bridge refused before ever
 * reaching the chain, because in that case no ratified decision was in hand.
 */
export async function executeOnChainMirror(input: {
  request: MirrorRequest;
  submitter: OnChainSubmitter;
  ledger: MirrorLedger;
}): Promise<MirrorExecution> {
  const planned = planOnChainMirror(input.request);
  if (!planned.ok) {
    return {
      ok: false,
      code: planned.code,
      detail: planned.detail,
      decisionStanding: false,
      ...(planned.refusal ? { refusal: planned.refusal } : {}),
    };
  }

  const { plan } = planned;
  if (await input.ledger.has(plan.mirrorId)) {
    return { ok: true, mirrorId: plan.mirrorId, txHash: '', replayed: true, decisionStanding: true };
  }
  const submitted = await input.submitter.submit(plan);
  if (!submitted.ok) {
    return { ok: false, code: 'submission-failed', detail: submitted.detail, mirrorId: plan.mirrorId, decisionStanding: true };
  }
  await input.ledger.record(plan.mirrorId, submitted.txHash);
  return { ok: true, mirrorId: plan.mirrorId, txHash: submitted.txHash, replayed: false, decisionStanding: true };
}

/** In-memory ledger for tests and single-process pilots; production supplies a durable one. */
export function createInMemoryMirrorLedger(): MirrorLedger & { entries(): ReadonlyMap<string, string> } {
  const seen = new Map<string, string>();
  return {
    has: (id) => seen.has(id),
    record: (id, txHash) => {
      seen.set(id, txHash);
    },
    entries: () => seen,
  };
}
