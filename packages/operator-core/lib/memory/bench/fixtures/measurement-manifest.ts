/** Synthetic protocol fixtures. These qualify guards, never real-model bars. */
import type { HeldoutQuery } from '../candidate-hybrid-bench';
import { candidateProfile, measurementOwner, FROZEN_MEASUREMENT_CONTRACTS, MEASUREMENT_BARS, MEASUREMENT_CLASSES, type MeasurementManifest } from '../measurement-manifest';

export function independentCohortFixture() {
  const entries = [{ key: 'a', text: 'original source A', kind: 'fact', metadata: { cluster: 'source-a' } },
    { key: 'b', text: 'original source B', kind: 'fact', metadata: { cluster: 'source-b' } }];
  const queries: HeldoutQuery[] = ['calibration', 'test'].flatMap((partition, i) => MEASUREMENT_CLASSES.map((cls, j) => ({
    id: `${partition}-${j}`, class: cls, query: `${cls} independent question ${i}`, partition: partition as 'calibration' | 'test',
    group: cls === 'hard-negative' ? `absent-${i}` : `source-${i ? 'b' : 'a'}`, expected: cls === 'hard-negative' ? [] : [i ? 'b' : 'a'],
  })));
  const fingerprint = { path: '/private/judge.json', sha256: 'a'.repeat(64), bytes: 1 };
  const proof = { formatVersion: 1, authority: 'independent-blind-transport', candidateRankingsExposed: false,
    frozenAt: '2026-01-01T00:00:00.000Z', snapshotSha256: '1'.repeat(64), labelsSha256: '2'.repeat(64),
    judges: [1, 2].map((n) => ({ model: 'synthetic-protocol-judge', revision: 'fixture-v1', transport: `fixture-${n}`,
      promptSha256: '3'.repeat(64), raw: { ...fingerprint, path: `/private/judge-${n}.json` } })),
    queryIds: queries.map((q) => q.id), ambiguous: [], excluded: [], agreement: 1 };
  return { entries, queries, proof };
}
export function measurementManifestFixture(privateRoot: string, sourceCommit = 'a'.repeat(40)): MeasurementManifest {
  const { entries, queries } = independentCohortFixture();
  const f = { path: '/private/input.json', sha256: '1'.repeat(64), bytes: 1 };
  const arms: MeasurementManifest['arms'] = (['mdenseon', 'gemma', 'harrier'] as const).map((model) => ({
    id: model, model, profile: candidateProfile(model), modelRev: `${model}-fixture-v1`, artifactRevision: `${model}-fixture-v1`,
    artifacts: { graph: f, tokenizer: f, config: f, weightLayout: 'inline', weights: [] }, prompts: { query: 'query: ', document: 'document: ' },
    tokenizer: { backend: 'synthetic', version: 'fixture-v1' },
    runtime: { name: 'synthetic-protocol-worker', version: 'fixture-v1', wire: 'node-onnx-worker', source: f },
    execution: { device: 'cpu', dtype: 'fp32', intraOpThreads: 4, interOpThreads: 1,
      transport: 'local-http-client-worker', cache: 'bypass' },
  }));
  return { formatVersion: 1, plan: 'mdenseon-adoption-measurements-2026-10-01', runId: 'synthetic-protocol', ownerId: measurementOwner(),
    frozenAt: '2026-01-02T00:00:00.000Z', seed: 'protocol-fixture-v1', sourceCommit,
    privateRoot, evidencePath: 'docs/evidence/synthetic-protocol.json', contracts: { ...FROZEN_MEASUREMENT_CONTRACTS },
    inputs: { snapshot: f, labels: f, judgments: f, census: f }, arms,
    datasets: (['memory', 'prose'] as const).map((corpus) => ({ corpus, snapshot: 'snapshot', labels: 'labels', judgments: 'judgments', census: 'census',
      keys: entries.map((e) => e.key), queryIds: queries.map((q) => q.id) })),
    cells: MEASUREMENT_BARS.map((bar) => ({ id: bar, bar, armId: 'mdenseon', corpus: 'memory',
      inputIds: ['snapshot', 'labels', 'judgments', 'census'], parameters: { route: 'canonical-lexical-hybrid' }, output: bar })),
  };
}
