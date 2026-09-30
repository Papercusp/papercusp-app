/**
 * p2p/billing-matrix.ts — the X7 PER-MODE BILLING AUTHORITY TABLE (D-009)
 * (p2p-work-distribution-2026-07-02 P-204).
 *
 * Item spec (D-016): the billing matrix decides, PER MODE, WHICH meter is
 * authoritative for settlement — and there is NO relay/proxy in v1 (the
 * federated gateway leg is a QUOTA LEDGER, not a streaming relay).
 *
 *   (a) host-pays + allotments  [DEFAULT] — the host spent its OWN money, so its
 *       own SIGNED usage receipts are authoritative (M8). No third party to
 *       reconcile against.
 *   (b) pool-with-attribution — receipts PLUS provider-billing reconciliation,
 *       restricted to SINGLE-OWNER pools (M17). Two independent reasons, both
 *       recorded so relaxing M17 forces revisiting the authority model:
 *         · CREDENTIAL: a multi-owner pool mixes whose key paid.
 *         · METERING-TRUST: the spender SELF-REPORTS; receipts-authoritative
 *           alone would crown the self-interested party — provider billing is
 *           the disinterested cross-check.
 *   (c) provider-scoped capped keys — the provider's OWN billing is the
 *       independent meter (the cap is enforced by the provider, not us).
 *
 * PURE policy module (rollout-tiers.ts discipline): no PG, no IO. It encodes the
 * X7 table as data + the pure guards; the caller supplies the pool/gateway
 * context and acts on the result (e.g. picks which meter to settle from, or
 * emits a P-004 refusal). It never imports FLAGS or a store.
 */

export type BillingMode = 'host-pays' | 'pool-with-attribution' | 'provider-capped-key';
export const BILLING_MODES: readonly BillingMode[] = ['host-pays', 'pool-with-attribution', 'provider-capped-key'] as const;

export function isBillingMode(v: unknown): v is BillingMode {
  return typeof v === 'string' && (BILLING_MODES as readonly string[]).includes(v);
}

/** The meter whose numbers are TRUSTED for settlement in a given mode (X7). */
export type AuthoritativeMeter =
  | 'host-signed-receipts' // (a) the host spent its own money (M8)
  | 'receipts-plus-reconciliation' // (b) receipts cross-checked against provider billing
  | 'provider-billing'; // (c) the provider's own billing is the meter

export interface BillingModeSpec {
  readonly mode: BillingMode;
  readonly authoritativeMeter: AuthoritativeMeter;
  /** M17: this mode is restricted to SINGLE-OWNER pools. */
  readonly requiresSingleOwnerPool: boolean;
  /** WHY the meter is authoritative — recorded so relaxing a constraint forces a re-review. */
  readonly rationale: readonly string[];
}

/**
 * The X7 authority table — the single source of truth for per-mode settlement
 * authority. `as const satisfies` keeps it exhaustive over BillingMode.
 */
export const X7_AUTHORITY_TABLE = {
  'host-pays': {
    mode: 'host-pays',
    authoritativeMeter: 'host-signed-receipts',
    requiresSingleOwnerPool: false,
    rationale: ['M8: the host spent its OWN money — its signed usage receipts are the authoritative meter; there is no third party to reconcile against.'],
  },
  'pool-with-attribution': {
    mode: 'pool-with-attribution',
    authoritativeMeter: 'receipts-plus-reconciliation',
    requiresSingleOwnerPool: true,
    rationale: [
      'M17-credential: a multi-owner pool mixes whose key paid — attribution is only sound on a single-owner pool.',
      'M17-metering-trust: the spender self-reports; receipts alone would crown the self-interested party, so provider-billing reconciliation is the disinterested cross-check.',
    ],
  },
  'provider-capped-key': {
    mode: 'provider-capped-key',
    authoritativeMeter: 'provider-billing',
    requiresSingleOwnerPool: false,
    rationale: ["The provider enforces the cap and bills independently — the provider's billing is the meter; our receipts are advisory."],
  },
} as const satisfies Record<BillingMode, BillingModeSpec>;

/**
 * D-009 v1: the FEDERATED GATEWAY LEG IS A QUOTA LEDGER, never a streaming
 * relay/proxy (inference bytes never route through the pool/gateway control
 * plane). The only allowed leg kind in v1.
 */
export type GatewayLegKind = 'quota-ledger';
export const V1_GATEWAY_LEG: GatewayLegKind = 'quota-ledger';

export type BillingRefusalCode = 'unknown_billing_mode' | 'pool_not_single_owner' | 'relay_forbidden_v1';

export interface BillingContext {
  /** The pool this billing runs under, when the mode is pool-scoped (M17 read). */
  pool?: { singleOwner: boolean } | null;
  /** The federated gateway leg kind the caller intends to run (D-009 v1 = quota-ledger only). */
  gatewayLeg?: string | null;
}

export type ResolveBillingResult =
  | { ok: true; spec: BillingModeSpec }
  | { ok: false; code: BillingRefusalCode; detail: string };

/**
 * Resolve the authoritative meter for a billing mode, enforcing D-009 (no v1
 * relay) and M17 (pool-with-attribution → single-owner pools only). Loud,
 * structured refusals so the caller can emit a P-004 receipt.
 */
export function resolveBillingAuthority(mode: BillingMode, ctx: BillingContext = {}): ResolveBillingResult {
  if (!isBillingMode(mode)) {
    return { ok: false, code: 'unknown_billing_mode', detail: `unknown billing mode '${String(mode)}'` };
  }
  // D-009: v1 forbids a streaming/proxy relay — the federated leg is a quota ledger.
  if (ctx.gatewayLeg != null && ctx.gatewayLeg !== V1_GATEWAY_LEG) {
    return {
      ok: false,
      code: 'relay_forbidden_v1',
      detail: `v1 forbids a streaming/proxy gateway relay (got '${ctx.gatewayLeg}'); the federated leg is a quota ledger only — inference bytes never route through the pool (D-009).`,
    };
  }
  const spec = X7_AUTHORITY_TABLE[mode];
  // M17: pool-with-attribution is restricted to single-owner pools.
  if (spec.requiresSingleOwnerPool) {
    if (!ctx.pool) {
      return { ok: false, code: 'pool_not_single_owner', detail: `${mode} requires a single-owner pool context (M17); none provided.` };
    }
    if (!ctx.pool.singleOwner) {
      return {
        ok: false,
        code: 'pool_not_single_owner',
        detail: `${mode} is restricted to SINGLE-OWNER pools (M17): a multi-owner pool would crown the self-interested spender.`,
      };
    }
  }
  return { ok: true, spec };
}

/**
 * Are host-SIGNED receipts ALONE authoritative for settlement in this mode?
 * True only for host-pays (a). For pool-with-attribution (b) receipts must be
 * reconciled against provider billing; for provider-capped-key (c) the
 * provider's billing is the meter and receipts are advisory. Use this to decide
 * whether a settlement can close on receipts alone or must wait for a provider
 * reconciliation leg.
 */
export function isReceiptAloneAuthoritative(mode: BillingMode): boolean {
  return X7_AUTHORITY_TABLE[mode].authoritativeMeter === 'host-signed-receipts';
}

/** The authoritative meter for a mode (table lookup; total over BillingMode). */
export function authoritativeMeterFor(mode: BillingMode): AuthoritativeMeter {
  return X7_AUTHORITY_TABLE[mode].authoritativeMeter;
}
