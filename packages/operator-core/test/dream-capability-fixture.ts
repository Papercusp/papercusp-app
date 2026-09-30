import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getPilotCapabilityManifest } from '../lib/dream/capability-catalog';
import { capabilityHash, capabilityUnitHash, type CapabilityPacket } from '../lib/dream/capability-contracts';
import { CAPABILITY_DREAM_RESULT_VERSION, type CapabilityProposal } from '../lib/dream/capability-pass';
import {
  capabilityContentVersion,
  capabilityPairKey,
  CAPABILITY_SAMPLING_VERSION,
  DEFAULT_CAPABILITY_SAMPLING_POLICY,
  type CapabilitySamplingResult,
} from '../lib/dream/capability-sampler';
import {
  CAPABILITY_REVIEW_VERSION,
  capabilityProposalHash,
  capabilityReviewEvidenceHash,
  type CapabilityReviewResult,
  type CapabilityReviewSources,
} from '../lib/dream/capability-review';
import { newDreamCapabilityRun, type BeginCapabilityRunInput } from '../lib/dream/dream-run-provenance';
import type { DreamRun } from '../lib/dream/dream-run-store';

/** Real source bytes with a fixed reviewed proposal. No model or provider calls. */
export async function createDreamCapabilityFixture(workspaceId = 'ws-capability-sink', potSlug = 'papercusp', includeThird = false) {
  const packs = join(homedir(), '.papercusp', 'scratch', 'packs');
  await mkdir(packs, { recursive: true });
  const root = await mkdtemp(join(packs, 'dream-capability-ledger-'));
  await mkdir(join(root, 'evidence'));
  await writeFile(join(root, 'pack.xml'), 'bounded source pack');
  const scope = { workspaceId, potSlug, repositoryId: 'fixture-repo' };
  async function packet(label: 'A' | 'B' | 'C'): Promise<CapabilityPacket> {
    const unit = structuredClone(getPilotCapabilityManifest().units[0]!);
    Object.assign(unit, {
      id: 'capability:' + label,
      granularity: 'capability',
      branch: label,
      parentId: null,
      relatedUnitIds: [],
      overlapsUnitIds: [],
    });
    unit.evidence = [
      {
        id: 'code',
        kind: 'implementation',
        path: 'evidence/' + label + '.ts',
        anchor: 'function ' + label,
        proves: 'Current behavior.',
      },
      {
        id: 'test',
        kind: 'test',
        path: 'evidence/' + label + '.test.ts',
        anchor: 'expect(' + label + '())',
        proves: 'Executable contract.',
      },
    ];
    unit.purpose = [{ text: 'Produces ' + label + ' output.', status: 'observed', evidenceIds: ['code'] }];
    unit.mechanism = [{ text: 'Calls the ' + label + ' mechanism.', status: 'observed', evidenceIds: ['code'] }];
    unit.evaluation = [{ text: 'Checks output.', status: 'observed', evidenceIds: ['test'] }];
    for (const key of Object.keys(unit.contracts) as Array<keyof typeof unit.contracts>) unit.contracts[key] = [];
    const sources = await Promise.all(
      unit.evidence.map(async (e) => {
        const excerpt =
          e.kind === 'implementation'
            ? 'export function ' + label + '() { return "' + label + '"; }'
            : 'expect(' + label + '()).toBe("' + label + '");';
        await writeFile(join(root, e.path), excerpt);
        return {
          ...e,
          excerpt,
          sourceHash: capabilityHash(excerpt),
          excerptHash: capabilityHash(excerpt),
          startLine: 1,
          endLine: 1,
        };
      }),
    );
    return {
      schemaVersion: 'dream-capability-packet-v1',
      scope,
      unit,
      unitHash: capabilityUnitHash(unit),
      manifestRevision: 'ledger-fixture-v1',
      sources,
      extraction: {
        recipeVersion: 'scanned-anchors-and-radius-v2',
        promptVersion: 'manifest-facets-v1',
        capturedAt: '2026-09-07T14:00:00Z',
        sourceCommit: null,
        dirty: true,
        backend: 'text',
        indexHealth: 'unknown',
        artifactRef: join(root, 'pack.xml'),
        artifactHash: capabilityHash('bounded source pack'),
        durationMs: 0,
        securityScan: 'passed',
        costUsd: 0,
      },
      coverage: {
        status: 'partial',
        includedPaths: sources.map((s) => s.path),
        excluded: [],
        unresolved: [],
        truncated: false,
        note: 'Fixture scope only.',
      },
    };
  }
  const packets = await Promise.all([packet('A'), packet('B'), ...(includeThird ? [packet('C')] : [])]);
  const [a, b] = packets.map((packet) => ({ packet, contentVersion: capabilityContentVersion(packet) }));
  const selection = {
    a: a!,
    b: b!,
    c: null,
    pairKey: capabilityPairKey(a!, b!),
    attemptKey: 'a'.repeat(64),
    recipe: 'capability-capability' as const,
    relation: null,
  };
  const sampling: CapabilitySamplingResult = {
    status: 'selected',
    selection,
    log: {
      version: CAPABILITY_SAMPLING_VERSION,
      snapshotFingerprint: 'b'.repeat(64),
      seed: 'fixed-seed',
      promptVersion: 'capability-relational-v1',
      mode: 'structured',
      arity: 2,
      policy: { ...DEFAULT_CAPABILITY_SAMPLING_POLICY },
      exposures: {},
      now: 1788789600000,
      inputFingerprint: 'c'.repeat(64),
      requestedStrategy: 'uniform-cross-domain',
      strategy: 'uniform-cross-domain',
      fallback: null,
      exclusions: [],
      pairExclusions: { alias: 0, recipe: 0, cooldown: 0 },
      invalidRelations: 0,
      invalidThirdRoles: 0,
      thirdOutcome: 'off',
      draws: [],
      pathProbability: 1,
    },
  };
  const citation = (unit: 'A' | 'B') => ({ unit, evidenceId: 'code' });
  const candidate: CapabilityProposal = {
    beneficiary: 'Engineers testing combined behavior.',
    behavior: 'Combine the A output with the B check.',
    observed: [
      { claim: 'A produces an output.', sources: [citation('A')] },
      { claim: 'B supplies the check.', sources: [citation('B')] },
    ],
    hypothesis: 'The composition can detect a mismatch.',
    primaryContributions: {
      A: { uniqueContribution: 'Produces the input.', removalEffect: 'No input.', sources: [citation('A')] },
      B: { uniqueContribution: 'Checks the input.', removalEffect: 'No check.', sources: [citation('B')] },
    },
    thirdContribution: null,
    relations: [
      {
        kind: 'producer-consumer',
        from: citation('A'),
        to: citation('B'),
        mapping: 'Feed A into B.',
        preconditions: ['Compatible input.'],
        transferRisks: ['A changes.'],
      },
    ],
    assumptions: [],
    missingEvidence: ['Composition not run.'],
    priorArt: {
      knownRelatedWork: [],
      proposedDelta: 'A composed check rather than separate outputs.',
      verification: 'unverified',
    },
    experiment: {
      baseline: 'Separate outputs.',
      change: 'Compose A with B.',
      measurement: 'Count mismatches.',
      successCriterion: 'Detect the seeded mismatch.',
      falsifier: 'The seeded mismatch is missed.',
    },
  };
  const prior = {
    ref: 'plan:fixture',
    kind: 'plan' as const,
    scope,
    text: 'Prior checks each output separately.',
    contentHash: capabilityHash('Prior checks each output separately.'),
    sourceHash: capabilityHash('Prior checks each output separately.'),
    candidateHash: null,
    evidenceHash: null,
    locator: { kind: 'plan' as const, id: 'fixture' },
  };
  const sources: CapabilityReviewSources = {
    search: async () => {
      throw new Error('Sink must not run an ungoverned new review');
    },
    readCurrent: async () => prior,
  };
  const evidence = (label: 'A' | 'B') => [
    { ref: label + ':code', quote: packets[label === 'A' ? 0 : 1]!.sources[0]!.excerpt },
  ];
  const supported = { status: 'supported' as const, note: 'Supported.', evidence: evidence('A') };
  const review: CapabilityReviewResult = {
    schemaVersion: CAPABILITY_REVIEW_VERSION,
    candidateHash: capabilityProposalHash(candidate),
    evidenceHash: capabilityReviewEvidenceHash(selection),
    verdict: 'accept',
    reason: 'supported-delta',
    note: 'Bounded source-supported proposal.',
    coverage: {
      scope,
      globalNovelty: 'not-established',
      searches: [],
      packetIndexes: [],
      rerank: { attempted: false, reason: 'fixture' },
      unknown: [],
    },
    priorMatches: [prior],
    controls: {
      aOnly: { unchanged: false, note: 'No check.', evidence: evidence('A') },
      bOnly: { unchanged: false, note: 'No input.', evidence: evidence('B') },
    },
    judgment: {
      verdict: 'accept',
      note: 'Supported.',
      observations: candidate.observed.map((_, index) => ({ index, ...supported })),
      comparisons: [
        {
          ref: prior.ref,
          disposition: 'distinct',
          note: 'Adds composition.',
          evidence: [{ ref: 'prior:' + prior.ref, quote: prior.text }],
        },
      ],
      relation: supported,
      feasibility: supported,
      experiment: {
        executable: true,
        probe: 'Run the composed check.',
        baseline: 'Separate outputs.',
        falsifier: 'Missed mismatch.',
        evidence: [{ ref: 'B:test', quote: packets[1]!.sources[1]!.excerpt }],
      },
    },
    usage: { model: 'reviewer', costUsd: 0.06, inputTokens: 300, outputTokens: 30 },
  };
  const manifest = {
    ...getPilotCapabilityManifest(),
    revision: 'ledger-fixture-v1',
    units: packets.map((p) => p.unit),
  };
  const header: BeginCapabilityRunInput = {
    manifest,
    dreamerModel: 'dreamer',
    reviewerModel: 'reviewer',
    dreamPromptVersion: 'capability-relational-v1',
    reviewPromptVersion: CAPABILITY_REVIEW_VERSION,
  };
  const insight = {
    schemaVersion: CAPABILITY_DREAM_RESULT_VERSION,
    capability: candidate,
    text: candidate.behavior,
    requiresA: candidate.primaryContributions.A.uniqueContribution,
    requiresB: candidate.primaryContributions.B.uniqueContribution,
    actionable: candidate.experiment.change,
  };
  const provenance = {
    ...newDreamCapabilityRun(header),
    sampling,
    calls: (['generation', 'control-a', 'control-b', 'review'] as const).map((phase, i) => ({
      callId: phase,
      phase,
      model: i ? 'reviewer' : 'dreamer',
      reservedUsd: 0.1,
      status: 'settled' as const,
      usage: { model: i ? 'reviewer' : 'dreamer', costUsd: i ? 0.02 : 0.01, inputTokens: 100, outputTokens: 10 },
      error: null,
    })),
  };
  const run: DreamRun = {
    workspaceId,
    runId: 'fixture-run',
    cycleId: 'fixture-cycle',
    potSlug,
    mode: 'manual',
    status: 'running',
    fragmentRefs: [],
    fragmentKinds: [],
    pairing: null,
    similarity: null,
    dreamerModel: 'dreamer',
    reviewerModel: 'reviewer',
    dreamUsage: null,
    reviewUsage: null,
    outcome: { verdict: 'insight', insight, capabilityRun: provenance },
    review: review as unknown as Record<string, unknown>,
    routedRef: null,
    inputTokens: 400,
    outputTokens: 40,
    costUsd: 0.07,
    error: null,
    startedAt: '2026-09-07T14:00:00Z',
    completedAt: null,
    spendRecordedAt: null,
    updatedAt: '2026-09-07T14:00:00Z',
  };
  return {
    root,
    scope,
    packets,
    selection,
    sampling,
    candidate,
    review,
    sources,
    manifest,
    header,
    insight,
    provenance,
    run,
  };
}
