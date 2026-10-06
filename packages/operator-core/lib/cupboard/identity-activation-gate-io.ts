/**
 * I/O half of the identity activation gate (agent-economy-flywheel-2026-08-30
 * P-016, decision D-011). The decision itself is pure and lives in
 * `identity-activation-gate.ts`; this module gathers its inputs:
 *
 *   1. which stack layers resolve to an installed Cupboard identity release
 *      (local file reads: the same `extends` resolver the launch compiler uses,
 *      so a project-local layer that shadows an installed id is never priced);
 *   2. each release's pricing, from the hosted offers, with the last verdict
 *      cached in `harness_shared.identity_release_funding` so a free release keeps
 *      launching while the hosted Cupboard is unreachable;
 *   3. funds, re-read from the hosted Cupboard on every activation: the prepaid
 *      balance and the payment channel bound to the release (owner-only read).
 *
 * A stack with no installed release does no database or network work at all, so
 * ordinary launches pay nothing for the gate.
 *
 * Every activating door calls `assertIdentityActivationFunded` (or
 * `admitIdentityActivation` when it must shape its own refusal). The door list is
 * pinned by `identity-activation-gate-doors.test.ts`.
 */
import { isAbsolute, relative, sep } from 'node:path';
import type { Sql } from 'postgres';
import { pinModuleState } from '@papercusp/module-singleton';
import { resolveCupboardBaseUrl } from './base-url';
import {
  evaluateIdentityActivation,
  identityReleasePricing,
  IdentityActivationRefusedError,
  type FundingChannelView,
  type IdentityActivationDecision,
  type IdentityOfferView,
  type IdentityPricingVerdict,
  type InstalledIdentityReleaseLayer,
  type PrepaidBalanceView,
  type Readout,
} from './identity-activation-gate';
import { identityReleaseSkuRef, isIdentityReleaseSkuRef } from './identity-per-use-offer';
import {
  readIdentityReleaseFunding,
  recordIdentityReleasePricing,
  type IdentityReleaseFundingRow,
} from './identity-release-funding-store';

export const COMMERCE_PER_USE_OFFERS_PATH = '/commerce/offers?pricing=per-use';
export const PREPAID_BALANCE_PATH = '/commerce/prepaid-credits/balance';
export const PAYMENT_CHANNEL_PATH = '/commerce/payment-channels';
/** A pricing verdict younger than this is used without asking the hosted offers again. */
export const IDENTITY_PRICING_CACHE_TTL_MS = 10 * 60 * 1000;
/** Bound on each hosted read, so an unreachable Cupboard cannot hang a launch. */
export const IDENTITY_GATE_HOSTED_TIMEOUT_MS = 8_000;

export interface IdentityActivationGateIo {
  resolveLayers(stack: readonly string[], repoDir: string | undefined): Promise<InstalledIdentityReleaseLayer[]>;
  readOffers(): Promise<Readout<IdentityOfferView[]>>;
  readPrepaid(): Promise<Readout<PrepaidBalanceView>>;
  readChannel(channelId: string): Promise<Readout<FundingChannelView | null>>;
  readFunding(workspaceId: string, skuRefs: readonly string[]): Promise<Map<string, IdentityReleaseFundingRow>>;
  recordPricing(workspaceId: string, skuRef: string, verdict: IdentityPricingVerdict): Promise<void>;
  nowMs(): number;
}

const gateState = pinModuleState('@papercusp/operator-core.cupboard.identity-activation-gate-io', () => ({
  overrides: null as Partial<IdentityActivationGateIo> | null,
}));

/** Replace parts of the gate's I/O (tests); `null` restores production. */
export function configureIdentityActivationGateIo(overrides: Partial<IdentityActivationGateIo> | null): void {
  gateState.overrides = overrides;
}

// ── Hosted transport ────────────────────────────────────────────────────────

export interface HostedReadDeps {
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
  /** Override the GitHub bearer; omitted in production, supplied by tests. */
  readonly authToken?: string;
  readonly timeoutMs?: number;
}

async function hostedGet(
  path: string,
  opts: { auth: boolean },
  deps: HostedReadDeps = {},
): Promise<{ ok: true; status: number; payload: Record<string, unknown> } | { ok: false; detail: string }> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.auth) {
    let token = deps.authToken;
    if (token === undefined) {
      const { getGhAuthToken } = await import('../identity/gh-token');
      const resolved = await getGhAuthToken();
      if (resolved.kind !== 'ok') return { ok: false, detail: 'gh_auth_required: no GitHub token to authenticate to the Cupboard' };
      token = resolved.token;
    }
    headers.Authorization = `Bearer ${token}`;
  }
  const base = (deps.baseUrl ?? resolveCupboardBaseUrl()).replace(/\/+$/, '');
  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(`${base}${path}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(deps.timeoutMs ?? IDENTITY_GATE_HOSTED_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, detail: `transport_error: ${error instanceof Error ? error.message : String(error)}` };
  }
  let payload: Record<string, unknown> = {};
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch { /* an unparseable body is judged by its status below */ }
  return { ok: true, status: response.status, payload };
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function offerFromWire(raw: unknown): IdentityOfferView | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.offerId !== 'string' || typeof o.skuRef !== 'string') return null;
  const p = o.perUse as Record<string, unknown> | null | undefined;
  const perUse = p && typeof p === 'object' && finite(p.unitPriceMicros) && typeof p.meterUnit === 'string' &&
    typeof p.priceVersion === 'string' && typeof p.splitManifestHash === 'string'
    ? { unitPriceMicros: p.unitPriceMicros, meterUnit: p.meterUnit, priceVersion: p.priceVersion,
        splitManifestHash: p.splitManifestHash }
    : null;
  return { offerId: o.offerId, skuRef: o.skuRef, active: o.active === true, productActive: o.productActive === true, perUse };
}

export async function readHostedIdentityOffers(deps: HostedReadDeps = {}): Promise<Readout<IdentityOfferView[]>> {
  const res = await hostedGet(COMMERCE_PER_USE_OFFERS_PATH, { auth: false }, deps);
  if (!res.ok) return res;
  if (res.status !== 200 || !Array.isArray(res.payload.offers)) {
    return { ok: false, detail: `the Cupboard offers read answered ${res.status}` };
  }
  const offers = res.payload.offers.map(offerFromWire).filter((o): o is IdentityOfferView => o !== null);
  // Only identity releases matter here; keep the rest out of the verdict entirely.
  return { ok: true, value: offers.filter((o) => isIdentityReleaseSkuRef(o.skuRef)) };
}

export async function readHostedPrepaidBalance(deps: HostedReadDeps = {}): Promise<Readout<PrepaidBalanceView>> {
  const res = await hostedGet(PREPAID_BALANCE_PATH, { auth: true }, deps);
  if (!res.ok) return res;
  const balance = res.payload.balance as Record<string, unknown> | undefined;
  if (res.status !== 200 || !balance || !finite(balance.availableMicros) || !finite(balance.debtMicros)) {
    return { ok: false, detail: `the Cupboard prepaid balance read answered ${res.status}` };
  }
  return { ok: true, value: { availableMicros: balance.availableMicros, debtMicros: balance.debtMicros } };
}

/**
 * Re-read one bound channel. The hosted read is owner-only and answers 404 both
 * for an unknown channel and for someone else's, so either becomes `null`: an
 * unfunded layer, never an error that could be retried into a pass.
 */
export async function readHostedPaymentChannel(
  channelId: string,
  deps: HostedReadDeps = {},
): Promise<Readout<FundingChannelView | null>> {
  const res = await hostedGet(`${PAYMENT_CHANNEL_PATH}/${encodeURIComponent(channelId)}`, { auth: true }, deps);
  if (!res.ok) return res;
  if (res.status === 404) return { ok: true, value: null };
  const channel = res.payload.channel as Record<string, unknown> | undefined;
  if (res.status !== 200 || !channel || typeof channel.channelId !== 'string' || typeof channel.state !== 'string' ||
      !finite(channel.escrowMicros) || !finite(channel.committedMicros)) {
    return { ok: false, detail: `the Cupboard channel read answered ${res.status}` };
  }
  return {
    ok: true,
    value: {
      channelId: channel.channelId,
      state: channel.state,
      escrowMicros: channel.escrowMicros,
      committedMicros: channel.committedMicros,
    },
  };
}

// The local store (harness_shared.identity_release_funding) lives in the leaf
// `identity-release-funding-store.ts`, so the commerce checkout door can bind a
// channel without pulling this module's layer resolver into the Worker build.

// ── Layer resolution ────────────────────────────────────────────────────────

function insideDir(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The stack layers that resolve to an ACTIVE Cupboard-installed identity release.
 * Resolution uses the launch compiler's own `extends` order (project-local →
 * installed → built-in), so only a layer the launch will actually load from the
 * installed tier counts. An installed directory without a release record was not
 * installed from a Cupboard release and is never priced.
 *
 * Each stack entry's whole `extends` chain is walked (D-012): a local or built-in
 * layer that extends an installed priced identity loads that identity too, so it
 * is charged and refused under the stack entry that pulled it in.
 */
export async function resolveInstalledIdentityReleaseLayers(
  stack: readonly string[],
  repoDir: string | undefined,
): Promise<InstalledIdentityReleaseLayer[]> {
  if (stack.length === 0) return [];
  const [{ stackBindingFromRefs, resolveLayers }, { INSTALLED_BLUEPRINTS_DIR, operatorResolveExtends }, { localDirs }, { readBlueprintLifecycle }, { parse: parseYaml }, { readFile }] =
    await Promise.all([
      import('@papercusp/orchestrator/blueprint'),
      import('../blueprint/installed-blueprints'),
      import('../agent-identities/source'),
      import('./blueprint-release'),
      import('yaml'),
      import('node:fs/promises'),
    ]);
  const installedDir = INSTALLED_BLUEPRINTS_DIR();
  const resolve = operatorResolveExtends({ localDirs: localDirs(repoDir) });
  const activeRelease = new Map<string, Promise<{ id: string; version: string } | null>>();
  const releaseOf = (id: string) => {
    let pending = activeRelease.get(id);
    if (!pending) {
      pending = readBlueprintLifecycle(installedDir, id).then((lifecycle) => lifecycle.active, () => null);
      activeRelease.set(id, pending);
    }
    return pending;
  };
  const out: InstalledIdentityReleaseLayer[] = [];
  for (const layer of stackBindingFromRefs(stack).layers) {
    const file = resolve(layer.id);
    if (!file) continue;
    const layerRef = `${layer.slot}:${layer.id}`;
    // The launch compiler already resolved this same chain, so a parse failure
    // here is a real fault: it propagates and refuses the activation rather than
    // silently skipping a layer that could be priced.
    const raw = parseYaml(await readFile(file, 'utf8')) as Record<string, unknown>;
    const chain = resolveLayers(raw, resolve, file).layers;
    const charged = new Set<string>();
    for (const member of chain) {
      if (!member.sourcePath || !insideDir(installedDir, member.sourcePath)) continue;
      const active = await releaseOf(member.id);
      if (!active) continue;
      const identity = { id: active.id, version: active.version };
      const skuRef = identityReleaseSkuRef(identity);
      if (charged.has(skuRef)) continue;
      charged.add(skuRef);
      out.push({ layerRef, identity, skuRef });
    }
  }
  return out;
}

// ── The gate ────────────────────────────────────────────────────────────────

function productionIo(): IdentityActivationGateIo {
  const sql = async () => (await import('@papercusp/db-org')).getOrgPg().sql as unknown as Sql;
  return {
    resolveLayers: resolveInstalledIdentityReleaseLayers,
    readOffers: () => readHostedIdentityOffers(),
    readPrepaid: () => readHostedPrepaidBalance(),
    readChannel: (channelId) => readHostedPaymentChannel(channelId),
    readFunding: async (workspaceId, skuRefs) => readIdentityReleaseFunding(await sql(), workspaceId, skuRefs),
    recordPricing: async (workspaceId, skuRef, verdict) => recordIdentityReleasePricing(await sql(), workspaceId, skuRef, verdict),
    nowMs: () => Date.now(),
  };
}

function gateIo(): IdentityActivationGateIo {
  return { ...productionIo(), ...(gateState.overrides ?? {}) };
}

export interface IdentityActivationRequest {
  /** The launch stack exactly as compiled (`LaunchArtifactResult.stack`). */
  readonly stack: readonly string[];
  /** The launch cwd, so project-local layers shadow installed ids as they do at compile time. */
  readonly repoDir?: string;
  readonly workspaceId: string;
}

function cachedVerdict(row: IdentityReleaseFundingRow | undefined): IdentityPricingVerdict | null {
  if (!row?.pricingState || row.pricingCheckedAtMs === null) return null;
  if (row.pricingState === 'free') return { kind: 'free' };
  if (row.pricingOfferId && row.pricingUnitMicros && row.pricingUnitMicros > 0) {
    return { kind: 'priced', offerId: row.pricingOfferId, unitPriceMicros: row.pricingUnitMicros };
  }
  return null;
}

/** Decide whether the stack may be activated. Never throws for a refusal. */
export async function admitIdentityActivation(request: IdentityActivationRequest): Promise<IdentityActivationDecision> {
  const io = gateIo();
  const layers = await io.resolveLayers(request.stack, request.repoDir);
  if (layers.length === 0) return { ok: true, charged: [] };

  const skuRefs = [...new Set(layers.map((layer) => layer.skuRef))];
  let funding = new Map<string, IdentityReleaseFundingRow>();
  let fundingReadError: string | null = null;
  try {
    funding = await io.readFunding(request.workspaceId, skuRefs);
  } catch (error) {
    fundingReadError = error instanceof Error ? error.message : String(error);
  }

  const now = io.nowMs();
  const cached = new Map(skuRefs.map((sku) => [sku, cachedVerdict(funding.get(sku))]));
  const allFresh = skuRefs.every((sku) => {
    const row = funding.get(sku);
    return cached.get(sku) && row?.pricingCheckedAtMs !== null && row?.pricingCheckedAtMs !== undefined &&
      now - row.pricingCheckedAtMs < IDENTITY_PRICING_CACHE_TTL_MS;
  });

  const pricing = new Map<string, IdentityPricingVerdict>();
  if (allFresh) {
    for (const sku of skuRefs) pricing.set(sku, cached.get(sku)!);
  } else {
    const offers = await io.readOffers();
    for (const sku of skuRefs) {
      if (offers.ok) {
        const verdict = identityReleasePricing(sku, offers.value);
        pricing.set(sku, verdict);
        if (!fundingReadError) await io.recordPricing(request.workspaceId, sku, verdict).catch(() => undefined);
      } else {
        // The hosted offers are unreachable: a release last seen free stays free; a
        // release last seen priced keeps its price (its funds are re-read below);
        // a release never read is unverifiable.
        pricing.set(sku, cached.get(sku) ?? {
          kind: 'unverifiable',
          detail: `the Cupboard offers could not be read (${offers.detail}) and no earlier verdict is recorded`,
        });
      }
    }
  }

  const priced = layers.filter((layer) => pricing.get(layer.skuRef)?.kind === 'priced');
  if (priced.length === 0) return evaluateIdentityActivation({ layers, pricing, prepaid: null, channels: new Map() });

  const prepaid = await io.readPrepaid();
  const channels = new Map<string, Readout<FundingChannelView | null>>();
  for (const layer of priced) {
    if (channels.has(layer.skuRef)) continue;
    if (fundingReadError) {
      channels.set(layer.skuRef, { ok: false, detail: `the local funding binding could not be read (${fundingReadError})` });
      continue;
    }
    const channelId = funding.get(layer.skuRef)?.channelId;
    channels.set(layer.skuRef, channelId ? await io.readChannel(channelId) : { ok: true, value: null });
  }
  return evaluateIdentityActivation({ layers, pricing, prepaid, channels });
}

/** The door form: resolve when the stack may be activated, else throw the typed refusal. */
export async function assertIdentityActivationFunded(
  request: IdentityActivationRequest,
): Promise<Extract<IdentityActivationDecision, { ok: true }>> {
  const decision = await admitIdentityActivation(request);
  if (!decision.ok) throw new IdentityActivationRefusedError(decision);
  return decision;
}
