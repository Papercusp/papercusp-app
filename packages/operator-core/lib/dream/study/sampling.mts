import { capabilityHash } from '../../dream/capability-contracts.ts';
import { type CapabilitySamplingSnapshot, type CapabilityStructuralRelation, type CapabilityThirdRole } from '../../dream/capability-sampler.ts';

const scope = 'mechanism:memory.hive-scope';
const revisions = 'capability:plans.spec-revisions';
const budget = 'mechanism:dream.cost-admission';
const pack = 'capability:code.secret-scanned-pack';
// These are testable transfer hypotheses, not assertions of existing integrations.
const mappings = [
  { a: scope, b: pack, c: revisions, kind: 'producer-consumer', role: 'enabling-mechanism',
    rationale: 'Hypothesis: hive filtering can constrain the explicit repository/include set consumed by source packing.',
    precondition: 'Resolve allowed harnesses to repository paths; retain the packer security scan and explicit include contract.',
    contribution: 'An immutable expected-revision contract could version the chosen confinement and packing policy.',
    removal: 'Removing C leaves confinement and packing without revision-addressed policy history.' },
  { a: scope, b: revisions, c: pack, kind: 'transferable-invariant', role: 'consumer',
    rationale: 'Hypothesis: hive confinement can constrain which scoped behavioral revisions a caller may retrieve.',
    precondition: 'Map the session hive and harness membership to the revision store identity; registry freshness remains external.',
    contribution: 'A source pack can consume the confined revision selection as auditable code-evidence input.',
    removal: 'Removing C leaves scoped revision selection without an executable source-packing consumer.' },
  { a: budget, b: revisions, c: pack, kind: 'complementary-lifecycle', role: 'enabling-mechanism',
    rationale: 'Hypothesis: admission decisions can reference the exact immutable revision of their configured behavioral budget contract.',
    precondition: 'Preserve both atomic monetary reservation and expected-revision writes; a revision record alone cannot enforce billing.',
    contribution: 'A security-scanned source pack can provide attributable implementation evidence for the budget contract revision.',
    removal: 'Removing C removes the attributable source evidence bundle while retaining admission and revision history.' },
  { a: budget, b: pack, c: scope, kind: 'complementary-lifecycle', role: 'constraint',
    rationale: 'Hypothesis: the admission-before-work invariant can govern paid source-evidence processing after safe packing.',
    precondition: 'Packing itself is local; identify an actually paid downstream consumer and meter it without disabling the scanner.',
    contribution: 'Hive membership filtering constrains which repositories may contribute to the metered evidence workflow.',
    removal: 'Removing C loses hive confinement of the input population; cost and secret-scanning constraints remain.' },
  { a: revisions, b: pack, c: scope, kind: 'producer-consumer', role: 'constraint',
    rationale: 'Hypothesis: immutable behavioral contract revisions can select and document the exact source pack supporting an experiment.',
    precondition: 'Adapt source artifact identity into an existing scoped spec clause without treating the clause as an access-control mechanism.',
    contribution: 'Hive filtering constrains the repository population eligible for the revision-addressed source pack.',
    removal: 'Removing C leaves versioned packing without a hive-membership constraint on candidate repositories.' },
] as const;

export function studySampling(snapshot: CapabilitySamplingSnapshot, arm: 'uniform-pair' | 'structured-pair' | 'structured-triple') {
  const units = new Map(snapshot.eligible.map(e => [e.packet.unit.id, e]));
  const relations: CapabilityStructuralRelation[] = [];
  const thirdRoles: CapabilityThirdRole[] = [];
  for (const m of mappings) for (const [aId, bId] of [[m.a,m.b],[m.b,m.a]]) {
    const a = units.get(aId!), b = units.get(bId!), c = units.get(m.c);
    if (!a || !b || !c) throw new Error('Frozen study annotation unit is missing');
    const base = { aId: aId!, bId: bId!, aVersion: a.contentVersion, bVersion: b.contentVersion };
    relations.push({ ...base, kind: m.kind, rationale: m.rationale, preconditions: [m.precondition],
      aEvidenceIds: a.packet.sources.map(s => s.id), bEvidenceIds: b.packet.sources.map(s => s.id) });
    thirdRoles.push({ ...base, cId: m.c, cVersion: c.contentVersion, role: m.role,
      contribution: m.contribution, removalEffect: m.removal, evidenceIds: c.packet.sources.map(s => s.id) });
  }
  const sampler = {
    mode: arm === 'uniform-pair' ? 'random-control' as const : 'structured' as const,
    arity: arm === 'structured-triple' ? 3 as const : 2 as const,
    // The finite manual study deliberately repeats pairs for comparison. Production
    // defaults retain their 24-hour anti-repetition cooldown.
    policy: { cooldownMs: 0 },
    ...(arm === 'uniform-pair' ? {} : { relations, thirdRoles }),
  };
  return { sampler, annotationHash: capabilityHash(JSON.stringify({ sourceSnapshot: snapshot.fingerprint, mappings, sampler })) };
}
