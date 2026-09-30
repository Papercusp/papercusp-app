import { z } from 'zod';
import {
  CapabilityManifestSchema,
  CapabilityPacketSchema,
  capabilityHash,
  type CapabilityManifest,
  type CapabilityPacket,
} from './capability-contracts';
import { verifyCapabilityPacket, type BuildCapabilityPacketInput } from './capability-packets';

export const CAPABILITY_SAMPLING_VERSION = 'domain-structural-v1';
type Scope = CapabilityPacket['scope'];
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const boundedText = z.string().trim().min(1).max(2_000);
const identity = z.string().trim().min(1).max(160);
const version = z.string().regex(/^[a-f0-9]{64}$/);

export interface EligibleCapability {
  packet: CapabilityPacket;
  contentVersion: string;
}
export interface CapabilitySamplingSnapshot {
  schemaVersion: 'dream-eligible-capabilities-v1';
  scope: Scope;
  manifestRevision: string;
  fingerprint: string;
  eligible: EligibleCapability[];
  exclusions: { unitId: string; reason: string }[];
}

/** Description/prompt edits cannot reset source-version cooldowns. */
export function capabilityContentVersion(packet: CapabilityPacket): string {
  return capabilityHash(
    JSON.stringify(
      [...new Map(packet.sources.map((s) => [s.path, [s.path, s.sourceHash]])).values()].sort((a, b) =>
        compare(JSON.stringify(a), JSON.stringify(b)),
      ),
    ),
  );
}
function sameScope(a: Scope, b: Scope): boolean {
  return a.workspaceId === b.workspaceId && a.potSlug === b.potSlug && a.repositoryId === b.repositoryId;
}
function snapshotFingerprint(snapshot: Omit<CapabilitySamplingSnapshot, 'fingerprint'>): string {
  return capabilityHash(
    JSON.stringify({
      scope: [snapshot.scope.workspaceId, snapshot.scope.potSlug, snapshot.scope.repositoryId],
      manifestRevision: snapshot.manifestRevision,
      eligible: snapshot.eligible.map((e) => [e.packet.unit.id, e.packet.unitHash, e.contentVersion]),
      exclusions: snapshot.exclusions,
    }),
  );
}

/** Revalidate disk evidence once when assembling a sampling population, before any draw. */
export async function buildCapabilitySamplingSnapshot(
  input: { rootPath: string; scope: Scope; manifest: CapabilityManifest; packets: readonly unknown[] },
  verify: (
    packet: unknown,
    input: BuildCapabilityPacketInput,
  ) => ReturnType<typeof verifyCapabilityPacket> = verifyCapabilityPacket,
): Promise<CapabilitySamplingSnapshot> {
  const manifest = CapabilityManifestSchema.parse(input.manifest);
  if (input.packets.length > 200) throw new RangeError('Sampling population exceeds 200 packets');
  if (Object.values(input.scope).some((s) => !s.trim())) throw new RangeError('Sampling scope is required');
  const exclusions: CapabilitySamplingSnapshot['exclusions'] = [];
  const packets = new Map<string, CapabilityPacket[]>();
  const unitIds = new Set(manifest.units.map((u) => u.id));
  if (unitIds.size !== manifest.units.length) throw new RangeError('Duplicate manifest unit');
  for (const value of input.packets) {
    const parsed = CapabilityPacketSchema.safeParse(value);
    if (!parsed.success) {
      exclusions.push({ unitId: 'invalid-packet', reason: 'Invalid packet contract' });
      continue;
    }
    const packet = parsed.data;
    if (!sameScope(packet.scope, input.scope) || !unitIds.has(packet.unit.id)) {
      exclusions.push({ unitId: packet.unit.id, reason: 'Outside allowed scope or manifest' });
      continue;
    }
    packets.set(packet.unit.id, [...(packets.get(packet.unit.id) ?? []), packet]);
  }
  const eligible: EligibleCapability[] = [];
  await Promise.all(
    manifest.units.map(async (unit) => {
      const candidates = packets.get(unit.id) ?? [];
      if (candidates.length !== 1) {
        exclusions.push({
          unitId: unit.id,
          reason: candidates.length ? 'Ambiguous duplicate packets' : 'Missing packet',
        });
        return;
      }
      const packet = candidates[0]!;
      // This check remains explicit even with an injected verifier.
      if (packet.coverage.truncated || packet.coverage.unresolved.length) {
        exclusions.push({ unitId: unit.id, reason: 'Materially incomplete evidence' });
        return;
      }
      try {
        const checked = await verify(packet, {
          rootPath: input.rootPath,
          scope: input.scope,
          unit,
          manifestRevision: manifest.revision,
        });
        if (!checked.fresh) {
          exclusions.push({ unitId: unit.id, reason: checked.reason });
          return;
        }
        eligible.push({ packet, contentVersion: capabilityContentVersion(packet) });
      } catch {
        exclusions.push({ unitId: unit.id, reason: 'Source verification unavailable' });
      }
    }),
  );
  eligible.sort((a, b) => compare(a.packet.unit.id, b.packet.unit.id));
  exclusions.sort((a, b) => compare(a.unitId + ':' + a.reason, b.unitId + ':' + b.reason));
  const snapshot = {
    schemaVersion: 'dream-eligible-capabilities-v1' as const,
    scope: { ...input.scope },
    manifestRevision: manifest.revision,
    eligible,
    exclusions,
  };
  return { ...snapshot, fingerprint: snapshotFingerprint(snapshot) };
}

const StructuralRelationSchema = z
  .object({
    aId: identity,
    bId: identity,
    aVersion: version,
    bVersion: version,
    kind: z.enum(['purpose-mechanism', 'transferable-invariant', 'producer-consumer', 'complementary-lifecycle']),
    rationale: boundedText,
    preconditions: z.array(boundedText).min(1).max(8),
    aEvidenceIds: z.array(identity).min(1).max(24),
    bEvidenceIds: z.array(identity).min(1).max(24),
  })
  .strict();
export type CapabilityStructuralRelation = z.infer<typeof StructuralRelationSchema>;
export const CapabilityThirdRoleSchema = z
  .object({
    aId: identity,
    bId: identity,
    cId: identity,
    aVersion: version,
    bVersion: version,
    cVersion: version,
    role: z.enum(['constraint', 'consumer', 'enabling-mechanism']),
    contribution: boundedText,
    removalEffect: boundedText,
    evidenceIds: z.array(identity).min(1).max(24),
  })
  .strict();
export type CapabilityThirdRole = z.infer<typeof CapabilityThirdRoleSchema>;
export type CapabilityStrategy =
  | 'structural-cross-domain'
  | 'uniform-cross-domain'
  | 'same-domain-other-branch'
  | 'random-control';
const strategies: CapabilityStrategy[] = [
  'structural-cross-domain',
  'uniform-cross-domain',
  'same-domain-other-branch',
];
export interface CapabilitySamplingPolicy {
  strategyWeights: [number, number, number];
  thirdRate: number;
  underexplorationBonus: number;
  cooldownMs: number;
}
export const DEFAULT_CAPABILITY_SAMPLING_POLICY: Readonly<CapabilitySamplingPolicy> = Object.freeze({
  strategyWeights: [0.5, 0.3, 0.2] as [number, number, number],
  thirdRate: 0.2,
  underexplorationBonus: 1,
  cooldownMs: 24 * 60 * 60_000,
});
export interface CapabilitySamplingOptions {
  seed: string;
  promptVersion: string;
  now: number;
  mode?: 'structured' | 'random-control';
  arity?: 2 | 3 | 'mixed';
  allowSubsystem?: boolean;
  policy?: Partial<CapabilitySamplingPolicy>;
  /** Prior exposure, not acceptance/quality feedback; frozen into the policy input. */
  exposures?: Readonly<Record<string, number>>;
  history?: readonly { pairKey: string; selectedAt: number }[];
  relations?: readonly unknown[];
  thirdRoles?: readonly unknown[];
}
export interface CapabilityDraw {
  stage: string;
  selected: string;
  eligibleCount: number;
  selectedWeight: number;
  totalWeight: number;
  probability: number;
  random: number;
}
export interface CapabilitySelection {
  a: EligibleCapability;
  b: EligibleCapability;
  c: { entry: EligibleCapability; declaration: CapabilityThirdRole } | null;
  pairKey: string;
  attemptKey: string;
  recipe: 'capability-capability' | 'capability-mechanism' | 'subsystem-experiment';
  relation: CapabilityStructuralRelation | null;
}
export interface CapabilitySamplingLog {
  version: typeof CAPABILITY_SAMPLING_VERSION;
  snapshotFingerprint: string;
  /** Recorded population, rather than a denominator inferred from sequential draw sizes. */
  eligibleUnitIds?: string[];
  seed: string;
  promptVersion: string;
  mode: 'structured' | 'random-control';
  arity: 2 | 3 | 'mixed';
  policy: CapabilitySamplingPolicy;
  exposures: Record<string, number>;
  now: number;
  inputFingerprint: string;
  requestedStrategy: CapabilityStrategy;
  strategy: CapabilityStrategy;
  fallback: string | null;
  exclusions: CapabilitySamplingSnapshot['exclusions'];
  pairExclusions: { alias: number; recipe: number; cooldown: number };
  invalidRelations: number;
  invalidThirdRoles: number;
  thirdOutcome: 'off' | 'not-drawn' | 'unavailable' | 'selected';
  draws: CapabilityDraw[];
  /** Probability of this recorded draw path, not the marginal across fallback strategies. */
  pathProbability: number;
}
export type CapabilitySamplingResult =
  | { status: 'selected'; selection: CapabilitySelection; log: CapabilitySamplingLog }
  | {
      status: 'no-pair';
      reason: 'insufficient-units' | 'no-eligible-pair' | 'no-third-candidate';
      log: CapabilitySamplingLog;
    };

function aliases(a: EligibleCapability, b: EligibleCapability): boolean {
  const au = a.packet.unit,
    bu = b.packet.unit;
  if (
    au.id === bu.id ||
    au.overlapsUnitIds.includes(bu.id) ||
    bu.overlapsUnitIds.includes(au.id) ||
    au.parentId === bu.id ||
    bu.parentId === au.id
  )
    return true;
  const hashes = (e: EligibleCapability) =>
    new Set(e.packet.sources.filter((s) => s.kind === 'implementation').map((s) => s.excerptHash));
  const ah = hashes(a),
    bh = hashes(b);
  return [...ah].filter((h) => bh.has(h)).length / Math.min(ah.size, bh.size) >= 0.8;
}
export function capabilityPairKey(a: EligibleCapability, b: EligibleCapability): string {
  if (!sameScope(a.packet.scope, b.packet.scope)) throw new RangeError('Pair crosses scope');
  const members = [
    [a.packet.unit.id, a.contentVersion],
    [b.packet.unit.id, b.contentVersion],
  ].sort((x, y) => compare(x[0]!, y[0]!));
  return capabilityHash(
    JSON.stringify({
      scope: [a.packet.scope.workspaceId, a.packet.scope.potSlug, a.packet.scope.repositoryId],
      members,
    }),
  );
}
function recipe(
  a: EligibleCapability,
  b: EligibleCapability,
  allowSubsystem: boolean,
): CapabilitySelection['recipe'] | null {
  const kinds = [a.packet.unit.granularity, b.packet.unit.granularity];
  if (kinds.includes('subsystem')) return allowSubsystem ? 'subsystem-experiment' : null;
  if (!kinds.includes('capability')) return null;
  return kinds.includes('mechanism') ? 'capability-mechanism' : 'capability-capability';
}
function refsExist(entry: EligibleCapability, refs: string[]): boolean {
  return refs.length > 0 && refs.every((ref) => entry.packet.sources.some((s) => s.id === ref));
}
function resolvePolicy(override: Partial<CapabilitySamplingPolicy> = {}): CapabilitySamplingPolicy {
  const p = {
    ...DEFAULT_CAPABILITY_SAMPLING_POLICY,
    ...override,
    strategyWeights: [...(override.strategyWeights ?? DEFAULT_CAPABILITY_SAMPLING_POLICY.strategyWeights)] as [
      number,
      number,
      number,
    ],
  };
  if (
    p.strategyWeights.length !== 3 ||
    p.strategyWeights.some((n) => !Number.isFinite(n) || n < 0) ||
    Math.abs(p.strategyWeights.reduce((a, b) => a + b, 0) - 1) > 1e-9
  )
    throw new RangeError('Strategy probabilities must sum to one');
  for (const n of [p.thirdRate, p.underexplorationBonus])
    if (!Number.isFinite(n) || n < 0 || n > 1)
      throw new RangeError('Rates and underexploration bonus must be in [0, 1]');
  if (!Number.isSafeInteger(p.cooldownMs) || p.cooldownMs < 0) throw new RangeError('Invalid cooldown');
  return p;
}

/** Pure draw over an already verified snapshot; generation/review still recheck source freshness. */
export function sampleCapabilityCombination(
  snapshot: CapabilitySamplingSnapshot,
  options: CapabilitySamplingOptions,
): CapabilitySamplingResult {
  if (
    !options.seed.trim() ||
    options.seed.length > 200 ||
    !options.promptVersion.trim() ||
    options.promptVersion.length > 160 ||
    !Number.isFinite(options.now)
  )
    throw new RangeError('Seed, prompt version and time are required');
  const arity = options.arity ?? 'mixed',
    mode = options.mode ?? 'structured';
  if (![2, 3, 'mixed'].includes(arity) || !['structured', 'random-control'].includes(mode))
    throw new RangeError('Only pair/triple sampling is supported');
  const policy = resolvePolicy(options.policy);
  if ((options.relations?.length ?? 0) > 2_000 || (options.thirdRoles?.length ?? 0) > 2_000)
    throw new RangeError('Structural hint budget exceeded');
  if (
    snapshot.schemaVersion !== 'dream-eligible-capabilities-v1' ||
    snapshot.eligible.length > 200 ||
    snapshot.fingerprint !== snapshotFingerprint(snapshot)
  )
    throw new RangeError('Invalid sampling snapshot');
  const entries = snapshot.eligible;
  const byId = new Map(entries.map((e) => [e.packet.unit.id, e]));
  if (
    byId.size !== entries.length ||
    entries.some(
      (e) =>
        !sameScope(e.packet.scope, snapshot.scope) ||
        e.contentVersion !== capabilityContentVersion(e.packet) ||
        e.packet.coverage.truncated ||
        e.packet.coverage.unresolved.length > 0 ||
        !CapabilityPacketSchema.safeParse(e.packet).success,
    )
  )
    throw new RangeError('Invalid eligible packet identity');
  const exposures = Object.fromEntries(
    entries.map((e) => [e.packet.unit.id, options.exposures?.[e.packet.unit.id] ?? 0]),
  );
  if (Object.values(exposures).some((n) => !Number.isSafeInteger(n) || n < 0))
    throw new RangeError('Exposure counts must be non-negative integers');
  const relations = (options.relations ?? [])
    .flatMap((raw) => {
      const r = StructuralRelationSchema.safeParse(raw);
      if (!r.success) return [];
      const a = byId.get(r.data.aId),
        b = byId.get(r.data.bId);
      return a &&
        b &&
        a.contentVersion === r.data.aVersion &&
        b.contentVersion === r.data.bVersion &&
        refsExist(a, r.data.aEvidenceIds) &&
        refsExist(b, r.data.bEvidenceIds)
        ? [r.data]
        : [];
    })
    .sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  const thirdRoles = (options.thirdRoles ?? [])
    .flatMap((raw) => {
      const r = CapabilityThirdRoleSchema.safeParse(raw);
      if (!r.success) return [];
      const a = byId.get(r.data.aId),
        b = byId.get(r.data.bId),
        c = byId.get(r.data.cId);
      return a &&
        b &&
        c &&
        (options.allowSubsystem || c.packet.unit.granularity !== 'subsystem') &&
        a.contentVersion === r.data.aVersion &&
        b.contentVersion === r.data.bVersion &&
        c.contentVersion === r.data.cVersion &&
        refsExist(c, r.data.evidenceIds) &&
        !aliases(a, c) &&
        !aliases(b, c) &&
        !aliases(a, b)
        ? [r.data]
        : [];
    })
    .sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  // The cycle persists the input snapshot/hints under this identity for replay;
  // a seed alone never claims to reproduce a changed eligibility population.
  const inputFingerprint = capabilityHash(JSON.stringify({ snapshot: snapshot.fingerprint, options }));
  const log: CapabilitySamplingLog = {
    version: CAPABILITY_SAMPLING_VERSION,
    snapshotFingerprint: snapshot.fingerprint,
    eligibleUnitIds: entries.map(e => e.packet.unit.id),
    seed: options.seed,
    promptVersion: options.promptVersion,
    mode,
    arity,
    policy,
    exposures,
    now: options.now,
    inputFingerprint,
    requestedStrategy: 'random-control',
    strategy: 'random-control',
    fallback: null,
    exclusions: [...snapshot.exclusions],
    pairExclusions: { alias: 0, recipe: 0, cooldown: 0 },
    invalidRelations: (options.relations?.length ?? 0) - relations.length,
    invalidThirdRoles: (options.thirdRoles?.length ?? 0) - thirdRoles.length,
    thirdOutcome: arity === 2 ? 'off' : 'not-drawn',
    draws: [],
    pathProbability: 1,
  };
  let counter = 0;
  const pick = <T>(
    stage: string,
    values: readonly T[],
    id: (v: T) => string,
    weight: (v: T) => number = () => 1,
  ): T => {
    const weights = values.map(weight),
      totalWeight = weights.reduce((a, b) => a + b, 0);
    if (!values.length || totalWeight <= 0) throw new RangeError('Empty draw population');
    const random = parseInt(capabilityHash(JSON.stringify([options.seed, counter++])).slice(0, 13), 16) / 2 ** 52;
    let cursor = random * totalWeight,
      index = weights.length - 1;
    for (let i = 0; i < weights.length; i++) {
      cursor -= weights[i]!;
      if (cursor < 0) {
        index = i;
        break;
      }
    }
    const value = values[index]!,
      probability = weights[index]! / totalWeight;
    log.draws.push({
      stage,
      selected: id(value),
      eligibleCount: values.length,
      selectedWeight: weights[index]!,
      totalWeight,
      probability,
      random,
    });
    log.pathProbability *= probability;
    return value;
  };
  const requested =
    mode === 'random-control'
      ? 'random-control'
      : pick(
          'strategy',
          strategies,
          (s) => s,
          (s) => policy.strategyWeights[strategies.indexOf(s)]!,
        );
  log.requestedStrategy = log.strategy = requested;
  if (entries.length < 2) return { status: 'no-pair', reason: 'insufficient-units', log };
  const history = options.history ?? [];
  if (history.length > 10_000 || history.some((h) => !Number.isFinite(h.selectedAt)))
    throw new RangeError('Invalid bounded cooldown history');
  const cooling = new Set(history.filter((h) => h.selectedAt > options.now - policy.cooldownMs).map((h) => h.pairKey));
  type Pair = { a: EligibleCapability; b: EligibleCapability; pairKey: string; recipe: CapabilitySelection['recipe'] };
  const pairs: Pair[] = [];
  for (let i = 0; i < entries.length; i++)
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]!,
        b = entries[j]!;
      if (aliases(a, b)) {
        log.pairExclusions.alias++;
        continue;
      }
      const chosenRecipe = recipe(a, b, options.allowSubsystem ?? false);
      if (!chosenRecipe) {
        log.pairExclusions.recipe++;
        continue;
      }
      const pairKey = capabilityPairKey(a, b);
      if (cooling.has(pairKey)) {
        log.pairExclusions.cooldown++;
        continue;
      }
      pairs.push({ a, b, pairKey, recipe: chosenRecipe }, { a: b, b: a, pairKey, recipe: chosenRecipe });
    }
  const relationFor = (p: Pair) => relations.find((r) => r.aId === p.a.packet.unit.id && r.bId === p.b.packet.unit.id);
  const forStrategy = (strategy: CapabilityStrategy) =>
    pairs.filter((p) => {
      const a = p.a.packet.unit,
        b = p.b.packet.unit;
      if (strategy === 'random-control') return true;
      if (strategy === 'same-domain-other-branch') return a.homeDomain === b.homeDomain && a.branch !== b.branch;
      return a.homeDomain !== b.homeDomain && (strategy === 'uniform-cross-domain' || !!relationFor(p));
    });
  let candidates = forStrategy(requested);
  if (!candidates.length && requested !== 'random-control') {
    for (const fallback of ['uniform-cross-domain', 'same-domain-other-branch'] as const) {
      candidates = forStrategy(fallback);
      if (candidates.length) {
        log.strategy = fallback;
        log.fallback = 'No eligible pair for ' + requested;
        break;
      }
    }
  }
  if (!candidates.length) return { status: 'no-pair', reason: 'no-eligible-pair', log };
  const unitWeight = (e: EligibleCapability) => 1 + policy.underexplorationBonus / (1 + exposures[e.packet.unit.id]!);
  const distinct = (values: string[]) => [...new Set(values)].sort(compare);
  let pair: Pair;
  if (mode === 'random-control') {
    pair = pick('uniform-ordered-pair', candidates, (p) => p.a.packet.unit.id + '>' + p.b.packet.unit.id);
  } else {
    const domain = pick('anchor-domain', distinct(candidates.map((p) => p.a.packet.unit.homeDomain)), (s) => s);
    const anchors = entries.filter((e) => e.packet.unit.homeDomain === domain && candidates.some((p) => p.a === e));
    const a = pick('anchor-unit', anchors, (e) => e.packet.unit.id, unitWeight);
    const partners = candidates.filter((p) => p.a === a);
    const partnerDomain = pick('partner-domain', distinct(partners.map((p) => p.b.packet.unit.homeDomain)), (s) => s);
    pair = pick(
      'partner-unit',
      partners.filter((p) => p.b.packet.unit.homeDomain === partnerDomain),
      (p) => p.b.packet.unit.id,
      (p) => unitWeight(p.b),
    );
  }
  let c: CapabilitySelection['c'] = null;
  const wantThird =
    arity === 3 ||
    (arity === 'mixed' &&
      pick('third-presence', [false, true], String, (present) => (present ? policy.thirdRate : 1 - policy.thirdRate)));
  if (wantThird) {
    const roles = [
      ...new Map(
        thirdRoles
          .filter((r) => r.aId === pair.a.packet.unit.id && r.bId === pair.b.packet.unit.id)
          .map((r) => [JSON.stringify(r), r]),
      ).values(),
    ];
    if (!roles.length) {
      log.thirdOutcome = 'unavailable';
      if (arity === 3) return { status: 'no-pair', reason: 'no-third-candidate', log };
    } else {
      const cId = pick('third-unit', distinct(roles.map((r) => r.cId)), (s) => s);
      const declaration = pick(
        'third-role',
        roles.filter((r) => r.cId === cId),
        (r) => r.role + ':' + r.removalEffect,
      );
      c = { entry: byId.get(cId)!, declaration };
      log.thirdOutcome = 'selected';
    }
  }
  const attemptKey = capabilityHash(
    JSON.stringify({
      pairKey: pair.pairKey,
      direction: [pair.a.packet.unit.id, pair.b.packet.unit.id],
      c: c ? [c.entry.packet.unit.id, c.entry.contentVersion, c.declaration.role] : null,
      promptVersion: options.promptVersion,
    }),
  );
  return {
    status: 'selected',
    selection: {
      ...pair,
      recipe: c?.entry.packet.unit.granularity === 'subsystem' ? 'subsystem-experiment' : pair.recipe,
      c,
      attemptKey,
      relation: log.strategy === 'structural-cross-domain' ? (relationFor(pair) ?? null) : null,
    },
    log,
  };
}
