/**
 * P-001: supplementary, frozen cases for selective graph adoption.
 * Reuses CorpusCase/PinnedSite and the existing code-intel-bench graders;
 * the earlier ACCEPTANCE_CORPUS remains unchanged.
 *
 * Materialize SOURCE_COMMIT for every arm. Verify these blob identities before
 * timing; a different checkout is a fixture failure, never a backend failure.
 */
import { createHash } from 'node:crypto';
import type { CorpusCase, PinnedSite } from './acceptance-corpus';

export const SELECTIVE_SOURCE_COMMIT = 'e4400622e1721fb0b72514bcf4479dc2f1726231';
export const SELECTIVE_SOURCE_BLOBS: Readonly<Record<string, string>> = Object.freeze({
  'packages/operator-core/lib/scheduler/claim-spec-store.ts': 'cbece0f0a4f76bd6c9108ed66d34d2aab2acd732',
  'packages/operator-core/lib/scheduler/get-next.ts': '09395497e51b18d1b15d479d282cf1c65c759f9d',
  'packages/operator-core/lib/agent-tools/plans/spec-evidence-store.ts': '5a3ee8993536c1a496cd3ee2ee04c71018038296',
  'packages/operator-core/lib/design-compare/acceptance.ts': 'fcecb7fddb0062690d36c5537a1bdd094f14827f',
  'packages/operator-core/lib/work-items.ts': 'e734a5dd87fda39cc3d6b325cb93ecbaa1075006',
  'packages/operator-core/lib/endpoint-route/routes/cupboard-publish-blueprint.ts': '51c0f8a3ac494fe6cd2598e8ad9766a3762fb4e2',
  'scripts/publish-official-blueprints.mts': '28bf7581a79bae83c04a49e52664c33064aaa266',
});

const spec = 'packages/operator-core/lib/agent-tools/plans/spec-evidence-store.ts';
const claim = 'packages/operator-core/lib/scheduler/claim-spec-store.ts';
const next = 'packages/operator-core/lib/scheduler/get-next.ts';
const design = 'packages/operator-core/lib/design-compare/acceptance.ts';
const site = (path: string, line1: number, symbolOnLine: string): PinnedSite =>
  ({ path, line1, symbolOnLine });

export interface SelectiveCorpusCase extends CorpusCase {
  /** Starting information supplied equally to every arm; never the answer. */
  readonly task: string;
  /** Source call sites corroborating the expected relation, separate from answers. */
  readonly corroboration: readonly PinnedSite[];
  readonly sourceRef: string;
}

export const SELECTIVE_ACCEPTANCE_CORPUS: readonly SelectiveCorpusCase[] = Object.freeze([
  {
    id: 'selective-scheduler-edge', planCase: 1, intent: 'callees',
    title: 'Navigate the scheduler claim path', query: 'getNextForBee',
    task: 'Find the helper that performs work selection from getNextForBee and inspect its current source.',
    gradeMode: 'must-contain',
    expectedSites: [site(next, 2779, 'export async function getNextWorkItem')],
    corroboration: [site(claim, 548, 'export async function getNextForBee'), site(claim, 689, 'await getNextWorkItem')],
    eligibleBackends: ['lsp-adapter', 'gitnexus', 'ripgrep'],
    falsifies: 'An unrelated same-name result or an uncorroborated edge does not locate the actual claim path.',
    sourceRef: 'docs/evidence/gitnexus-agent-log-audit-2026-09-12.md#case-1',
  },
  {
    id: 'selective-fingerprint-chain', planCase: 2, intent: 'callees',
    title: 'Follow the production evidence fingerprint chain', query: 'listSpecEvidence',
    task: 'Trace listSpecEvidence to the function that hashes the declared source files. Resolve ambiguous production/test identities.',
    gradeMode: 'must-contain',
    expectedSites: [
      site(spec, 98, 'export async function measureRepoFilesEvidenceAtRoot'),
      site(spec, 74, 'async function fingerprintRepoFileSet'),
    ],
    corroboration: [site(spec, 902, 'export async function listSpecEvidence'), site(spec, 1011, 'await measureRepoFilesEvidenceAtRoot'), site(spec, 104, 'fingerprintRepoFileSet(repoRoot')],
    eligibleBackends: ['lsp-adapter', 'gitnexus', 'ripgrep'],
    falsifies: 'A direct-callee-only response or a test stub cannot establish the two-edge production path.',
    sourceRef: 'docs/evidence/gitnexus-agent-log-audit-2026-09-12.md#case-2',
  },
  {
    id: 'selective-external-consumer', planCase: 3, intent: 'callers',
    title: 'Find the design-acceptance consumer of shared measurement', query: 'measureRepoFilesEvidenceAtRoot',
    task: 'Identify affected production consumers before changing the shared measurement helper; report unchecked behavior separately.',
    gradeMode: 'must-contain',
    expectedSites: [
      site(spec, 123, 'export async function measureRepoFilesEvidence'),
      site(spec, 902, 'export async function listSpecEvidence'),
      site(design, 120, 'export async function measureDesignAcceptance'),
    ],
    corroboration: [site(design, 122, 'await measureRepoFilesEvidenceAtRoot')],
    eligibleBackends: ['lsp-adapter', 'gitnexus', 'ripgrep'],
    falsifies: 'Missing the cross-file design consumer fails recall. A file-level test link is not a resolved function caller.',
    sourceRef: 'docs/evidence/gitnexus-agent-log-audit-2026-09-12.md#case-3',
  },
  {
    id: 'selective-route-boundary', planCase: 4, intent: 'text-search',
    title: 'Resolve the public URL to the registered handler', query: '/api/cupboard/publish-blueprint',
    task: 'Find the POST handler for this URL and explain the API prefix boundary using source or the route registry.',
    gradeMode: 'must-contain',
    expectedSites: [site('packages/operator-core/lib/endpoint-route/routes/cupboard-publish-blueprint.ts', 48, "path: '/cupboard/publish-blueprint'")],
    corroboration: [
      site('packages/operator-core/lib/endpoint-route/routes/cupboard-publish-blueprint.ts', 47, "method: 'POST'"),
      site('scripts/publish-official-blueprints.mts', 217, '/api/cupboard/publish-blueprint'),
    ],
    eligibleBackends: ['ripgrep', 'gitnexus', 'lsp-adapter'],
    falsifies: 'An empty route graph does not prove no handler exists; a current-text/registry fallback must identify it.',
    sourceRef: 'docs/evidence/gitnexus-agent-log-audit-2026-09-12.md#case-4',
  },
  {
    id: 'selective-exact-index-symbol', planCase: 5, intent: 'symbol-search',
    title: 'Detect a source symbol omitted from the index', query: 'claimNextIssueWorkItem',
    task: 'Locate this existing declaration. If the graph misses it, verify source at its indexed revision before attributing the miss to freshness.',
    gradeMode: 'must-contain',
    expectedSites: [site('packages/operator-core/lib/work-items.ts', 7991, 'export async function claimNextIssueWorkItem')],
    corroboration: [],
    eligibleBackends: ['ripgrep', 'gitnexus', 'lsp-adapter'],
    falsifies: 'Fresh/empty or non-truncated graph output is insufficient evidence of absence from source.',
    sourceRef: 'docs/evidence/gitnexus-revised-assessment-2026-09-13.md#3',
  },
]);

/** Historical observations only: never present this as the current live index. */
export const SELECTIVE_HISTORICAL_BASELINE = Object.freeze({
  report: 'docs/evidence/gitnexus-revised-assessment-2026-09-13.md',
  observedAt: '2026-09-14T01:24:00Z/2026-09-14T01:30:00Z',
  sourceCommit: '1656f7bb7fee6b11c46f418ab5132da9352c52e2',
  indexCommit: '29d342360971f0297b0b9f36816a878a935e78b7',
  indexBuiltAt: '2026-09-13T10:49:40.083Z',
  backendVersion: '1.6.9',
  disposition: 'stale/degraded; scheduler and external-consumer positives; exact-index symbol miss; degraded LSP omitted design consumer',
  comparableTiming: false,
});

/**
 * Disposable micro-repository for ambiguous names, barrel resolution, and dirty
 * edit/delete/update experiments. No agent hooks or second permanent index.
 */
export const SELECTIVE_MUTATION_FIXTURE: Readonly<Record<string, string>> = Object.freeze({
  'core.ts': 'export function shared(value: number) { return value + 1; }\n',
  'barrel.ts': "export { shared as calculate } from './core';\n",
  'consumer.ts': "import { calculate } from './barrel';\nexport function consume() { return calculate(1); }\n",
  'unrelated.ts': 'export function shared(value: string) { return value.toUpperCase(); }\n',
});

export const SELECTIVE_PROPERTY_CONTROLS = Object.freeze([
  { id: 'ambiguity', action: 'Query shared without a file, then anchor core.ts.', falsifier: 'Choosing the unrelated string function without disambiguation passes.' },
  { id: 'reexport', action: 'Find callers of core.ts shared through barrel.ts calculate.', falsifier: 'Missing consumer.ts consume is accepted as complete.' },
  { id: 'dirty-edit', action: 'Remove the calculate call in consumer.ts without committing; query before and after refresh.', falsifier: 'The old edge is labeled current or refresh leaves it present.' },
  { id: 'dirty-delete', action: 'Delete consumer.ts without committing; query before and after refresh.', falsifier: 'A deleted consumer is labeled current or remains after refresh.' },
  { id: 'refresh-failure', action: 'Inject a failing refresh on a disposable index, then query its prior serving snapshot.', falsifier: 'A failed build publishes success/freshness or destroys the previous usable snapshot.' },
  { id: 'concurrent-refresh', action: 'Request two refreshes concurrently on the disposable index and query during the handover.', falsifier: 'Writers overlap or readers see a partially published database.' },
  { id: 'child-crash', action: 'Terminate the disposable graph child during a request, then issue a fresh bounded request.', falsifier: 'The pending request hangs, returns clean absence, or the next request cannot recover.' },
] as const);

/** Verify the supplied frozen source, including byte identity and pinned lines. */
export function verifySelectiveSnapshot(read: (path: string) => Buffer): string[] {
  const failures: string[] = [];
  const sources = new Map<string, string>();
  for (const [path, expected] of Object.entries(SELECTIVE_SOURCE_BLOBS)) {
    try {
      const bytes = read(path);
      const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (actual !== expected) failures.push(`${path}: blob differs from ${SELECTIVE_SOURCE_COMMIT}`);
      sources.set(path, bytes.toString('utf8'));
    } catch {
      failures.push(`${path}: frozen source unavailable`);
    }
  }
  for (const kase of SELECTIVE_ACCEPTANCE_CORPUS) {
    for (const pin of [...kase.expectedSites, ...kase.corroboration]) {
      if (!sources.get(pin.path)?.split('\n')[pin.line1 - 1]?.includes(pin.symbolOnLine)) {
        failures.push(`${kase.id}: ${pin.path}:${pin.line1} no longer contains ${pin.symbolOnLine}`);
      }
    }
  }
  return failures;
}
