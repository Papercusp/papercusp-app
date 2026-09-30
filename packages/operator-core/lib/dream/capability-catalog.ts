import { adminRegistry } from '../testing-domains-registry';
import { parseCapabilityManifest, type CapabilityClaim, type CapabilityUnit } from './capability-contracts';

const observed = (text: string, ...evidenceIds: string[]): CapabilityClaim => ({
  text,
  status: 'observed',
  evidenceIds,
});
const unknown = (text: string): CapabilityClaim => ({ text, status: 'unknown', evidenceIds: [] });
const emptyContracts = () => ({
  inputs: [],
  outputs: [],
  events: [],
  state: [],
  guarantees: [],
  prerequisites: [],
  failureModes: [],
  resourceConstraints: [],
});
const root = 'packages/operator-core/lib/';
const units: CapabilityUnit[] = [
  {
    id: 'mechanism:memory.hive-scope',
    granularity: 'mechanism',
    name: 'Confine recall fan-out to a hive',
    homeDomain: 'memory',
    relatedDomains: ['harness'],
    parentId: null,
    branch: 'recall-scope',
    relatedUnitIds: [],
    overlapsUnitIds: [],
    purpose: [observed('Confined recall retains harnesses in the session hive.', 'scope-code')],
    mechanism: [
      observed('Resolve candidate harnesses through registry membership and filter sibling hives.', 'scope-code'),
    ],
    evaluation: [
      observed('Fixtures cover sibling exclusion, unknown candidates and unscoped pass-through.', 'scope-tests'),
    ],
    contracts: {
      ...emptyContracts(),
      inputs: [observed('Registry entries, candidate harness slugs and an optional session harness.', 'scope-code')],
      outputs: [
        observed(
          'A fresh filtered list; an unscoped or standalone session keeps the input candidates.',
          'scope-code',
          'scope-tests',
        ),
      ],
      guarantees: [observed('A hive-confined session excludes unknown candidates and sibling hives.', 'scope-tests')],
      prerequisites: [
        unknown(
          'Registry freshness and correctness are external prerequisites, not established by these pure fixtures.',
        ),
      ],
    },
    evidence: [
      {
        id: 'scope-code',
        kind: 'implementation',
        path: root + 'memory/hive-scope.ts',
        anchor: 'export function narrowHarnessSlugsToSessionHive(',
        proves: 'Registry-based filtering and unscoped behavior.',
      },
      {
        id: 'scope-tests',
        kind: 'test',
        path: root + 'memory/hive-scope.test.ts',
        anchor: "it('drops a sibling hive entirely from a confined fan-out'",
        proves: 'Sibling exclusion under a concrete session hive; adjacent cases cover unknown and unscoped inputs.',
      },
    ],
  },
  {
    id: 'capability:plans.spec-revisions',
    granularity: 'capability',
    name: 'Append immutable behavioral contract revisions',
    homeDomain: 'plans',
    relatedDomains: [],
    parentId: null,
    branch: 'spec-revisions',
    relatedUnitIds: [],
    overlapsUnitIds: [],
    purpose: [
      observed(
        'Preserve contract history while accepting changes only against the expected revision.',
        'revision-code',
      ),
    ],
    mechanism: [
      observed(
        'A transaction serializes revision writes and returns a conflict for a stale expected revision.',
        'revision-code',
      ),
    ],
    evaluation: [
      observed(
        'A real-database fixture checks immutable append, exact reads and one-winner concurrent revision writes.',
        'revision-tests',
      ),
    ],
    contracts: {
      ...emptyContracts(),
      inputs: [observed('A scoped spec identity, expected revision and full behavioral clause.', 'revision-code')],
      outputs: [
        observed('A stale expected revision receives a structured conflict with the actual revision.', 'revision-code'),
      ],
      state: [
        observed('Current revision advances while prior accepted content remains addressable.', 'revision-tests'),
      ],
      prerequisites: [
        unknown(
          'Database availability and the complete ownership guard require additional evidence beyond this excerpt.',
        ),
      ],
    },
    evidence: [
      {
        id: 'revision-code',
        kind: 'implementation',
        path: root + 'agent-tools/plans/spec-clauses-store.ts',
        anchor: 'if (input.expectedRevision !== actualRevision)',
        proves: 'Compare-and-swap refusal in the row-locked revision transaction.',
      },
      {
        id: 'revision-tests',
        kind: 'test',
        path: root + 'agent-tools/plans/spec-clauses-store.integration.test.ts',
        anchor: "it('supports deterministic no-op, revision append, exact reads, and one-winner concurrent CAS'",
        proves: 'Real Postgres revision history and competing writers.',
      },
    ],
  },
  {
    id: 'mechanism:dream.cost-admission',
    granularity: 'mechanism',
    name: 'Admit a bounded Dream cycle',
    homeDomain: 'dream',
    relatedDomains: ['learnings'],
    parentId: null,
    branch: 'budget',
    relatedUnitIds: [],
    overlapsUnitIds: [],
    purpose: [
      observed(
        'Prevent a new Dream cycle when the shared governor or rolling spend ceiling refuses it.',
        'budget-code',
      ),
    ],
    mechanism: [observed('Combine shared per-cycle admission with rolling workspace Dream spend.', 'budget-code')],
    evaluation: [
      observed('Fixtures cover disabled governor, shared refusal and the exact rolling ceiling.', 'budget-tests'),
    ],
    contracts: {
      ...emptyContracts(),
      inputs: [observed('Workspace and pot scope with bounded cycle configuration.', 'budget-code')],
      outputs: [observed('An allow/refuse verdict includes the available cycle and rolling budget.', 'budget-code')],
      resourceConstraints: [
        unknown('Admission estimates do not by themselves prove a strict ceiling on eventual billed usage.'),
      ],
    },
    evidence: [
      {
        id: 'budget-code',
        kind: 'implementation',
        path: root + 'dream/dream-governor.ts',
        anchor: 'export async function preflightDreamCycle(',
        proves: 'Shared and rolling admission checks.',
      },
      {
        id: 'budget-tests',
        kind: 'test',
        path: root + 'dream/dream-governor.test.ts',
        anchor: "it('refuses at the workspace-wide rolling ceiling",
        proves: 'Refusal at the configured rolling ceiling and exact time-window query.',
      },
    ],
  },
  {
    id: 'capability:code.secret-scanned-pack',
    granularity: 'capability',
    name: 'Pack explicitly scoped source evidence',
    homeDomain: 'papercusp-su',
    relatedDomains: ['packaged'],
    parentId: null,
    branch: 'code-evidence',
    relatedUnitIds: [],
    overlapsUnitIds: [],
    purpose: [
      observed(
        'Produce a source pack from an explicit nonempty include set with attributable engine provenance.',
        'pack-code',
      ),
    ],
    mechanism: [
      observed('Pinned packer identity and fixed denial rules restrict the pack command.', 'pack-code', 'pack-policy'),
    ],
    evaluation: [observed('Fixtures reject flag smuggling and prevent disabling the security scan.', 'pack-tests')],
    contracts: {
      ...emptyContracts(),
      inputs: [observed('Explicit repository scope and include selection.', 'pack-code')],
      outputs: [observed('Refusal or an artifact with source and engine provenance.', 'pack-code')],
      prerequisites: [
        unknown(
          'The pinned repomix executable must be installed and its scanner must finish before a packet is admissible.',
        ),
      ],
      failureModes: [
        observed('Empty include selection or unverified engine identity produces a refusal.', 'pack-code'),
      ],
      guarantees: [observed('The repomix argument builder cannot disable security scanning.', 'pack-tests')],
    },
    evidence: [
      {
        id: 'pack-code',
        kind: 'implementation',
        path: root + 'code-intelligence/packer-facade.ts',
        anchor: 'export async function packerFacade(',
        proves: 'Selection, pinned engine verification and refusal flow.',
      },
      {
        id: 'pack-policy',
        kind: 'implementation',
        path: root + 'code-intelligence/packer-facade.ts',
        anchor: 'export function buildRepomixArgs(',
        proves: 'Fixed deny set and safe attached packer arguments.',
      },
      {
        id: 'pack-tests',
        kind: 'test',
        path: root + 'code-intelligence/packer-facade.test.ts',
        anchor: "it('secret-scanning can never be disabled",
        proves: 'No-security-check is excluded from every constructed repomix argument vector.',
      },
    ],
  },
];

/** A reviewed seed manifest, not a new registry service or a census of the repository. */
export function getPilotCapabilityManifest() {
  return parseCapabilityManifest(
    {
      schemaVersion: 'dream-capability-manifest-v1',
      revision: 'pilot-2026-09-07-v1',
      domainSource: 'testing-domains-registry',
      coverage: {
        status: 'partial',
        unmapped: [
          'Every behavior outside the explicitly listed units remains uncatalogued.',
          'Parent capability boundaries for the initial mechanisms have not been established.',
        ],
        note: 'Existing test-domain identities organize sampling; their globs prove neither behavioral boundaries nor complete coverage. Null parentage means no asserted parent, not no wider subsystem.',
      },
      units,
    },
    adminRegistry.map((domain) => domain.id),
  );
}

/** Target the observed review/recovery failure classes while retaining the frozen
 * study population above. These are source-backed units, not a repository census. */
export function getCurrentCapabilityManifest() {
  const pilot = getPilotCapabilityManifest();
  const additions: CapabilityUnit[] = [
    {
      id: 'mechanism:scout.phase-deadline', granularity: 'mechanism',
      name: 'Bound downstream model phases without inventing queue telemetry',
      homeDomain: 'scout', relatedDomains: ['dream'], parentId: null, branch: 'phase-deadline',
      relatedUnitIds: ['mechanism:dream.cost-admission'], overlapsUnitIds: [],
      purpose: [observed('Cancel a phase at its deadline even when a buffered transport supplies no response-start hook.', 'deadline-tests')],
      mechanism: [observed('Compose a child abort signal with admission and generation budgets and race it against the transport.', 'deadline-code', 'deadline-cancel')],
      evaluation: [observed('A never-resolving transport is aborted; missing response telemetry remains explicitly ambiguous.', 'deadline-tests')],
      contracts: {
        ...emptyContracts(),
        inputs: [observed('Injected model transport, parent signal, generation cap and absolute cycle deadline.', 'deadline-code')],
        outputs: [observed('Model response or deadline/abort error; the child signal carries cancellation.', 'deadline-cancel', 'deadline-tests')],
        guarantees: [observed('Absent response hooks do not establish lack of capacity or generation.', 'deadline-tests')],
        prerequisites: [unknown('Provider transport must honor abort for cancellation to stop its remote work.')],
        failureModes: [unknown('A rejected local promise does not prove that the provider incurred no cost.')],
        resourceConstraints: [observed('Admission budget reserves the configured generation cap within the cycle deadline.', 'deadline-code')],
      },
      evidence: [
        { id: 'deadline-code', kind: 'implementation', path: root + 'scout/llm-deadline.ts', anchor: 'export async function callScoutPhaseLlm(', proves: 'Phase inputs and admission budget derivation.' },
        { id: 'deadline-cancel', kind: 'implementation', path: root + 'scout/llm-deadline.ts', anchor: 'return await Promise.race([', proves: 'Transport receives the child abort signal and races deadline rejection.' },
        { id: 'deadline-tests', kind: 'test', path: root + 'scout/critics.test.ts', anchor: "'does not infer capacity or generation from missing response telemetry", proves: 'Buffered transport cancellation and honest ambiguous diagnostics.' },
      ],
    },
    {
      id: 'capability:dream.source-freshness', granularity: 'capability',
      name: 'Revalidate captured capability evidence against current source',
      homeDomain: 'dream', relatedDomains: ['packaged'], parentId: null, branch: 'source-freshness',
      relatedUnitIds: ['capability:code.secret-scanned-pack'], overlapsUnitIds: [],
      purpose: [observed('Refuse stale, missing or changed source evidence before it can support a review.', 'freshness-tests')],
      mechanism: [observed('Check packet scope/version, then hash current source bytes and compare cited excerpt lines.', 'freshness-code', 'freshness-bytes')],
      evaluation: [observed('Implementation/test edits, renames and deletions invalidate captured packets.', 'freshness-tests')],
      contracts: {
        ...emptyContracts(),
        inputs: [observed('Captured packet, current root/scope/unit, manifest revision and extraction bounds.', 'freshness-code')],
        outputs: [observed('A fresh verdict or a reason identifying invalid scope or changed evidence.', 'freshness-code', 'freshness-bytes')],
        guarantees: [observed('Working-tree source changes invalidate evidence even without a changed commit label.', 'freshness-tests')],
        prerequisites: [unknown('The chosen anchors and contract claims still require semantic review; byte freshness does not prove correctness.')],
        failureModes: [observed('Missing implementation or test evidence makes a rebuilt packet unavailable.', 'freshness-tests')],
        resourceConstraints: [observed('Current packet and excerpt budgets are checked before admitting cached evidence.', 'freshness-bytes')],
      },
      evidence: [
        { id: 'freshness-code', kind: 'implementation', path: root + 'dream/capability-packets.ts', anchor: 'export async function verifyCapabilityPacket(', proves: 'Scope, unit, manifest and extraction identity checks.' },
        { id: 'freshness-bytes', kind: 'implementation', path: root + 'dream/capability-packets.ts', anchor: 'JSON.stringify(packet).length > maxPacketChars ||', proves: 'Bounded packet/excerpts and current source hash checks.' },
        { id: 'freshness-tests', kind: 'test', path: root + 'dream/capability-packets.test.ts', anchor: "'invalidates $change of cited $kind evidence'", proves: 'Edits, renames and deletes of both source kinds invalidate prior evidence.' },
      ],
    },
    {
      id: 'mechanism:coord.event-fire-receipt', granularity: 'mechanism',
      name: 'Retain durable evidence that an event key fired',
      homeDomain: 'papercusp-su', relatedDomains: [], parentId: null, branch: 'event-fire-receipt',
      relatedUnitIds: [], overlapsUnitIds: [],
      purpose: [observed('Keep one durable event receipt even as repeated fires update its latest payload.', 'fire-tests')],
      mechanism: [observed('Upsert a workspace/key row, preserving first fire time while advancing count and last payload.', 'fire-code')],
      evaluation: [observed('Real PostgreSQL tests check one-row replay, preserved first time, incremented count and latest payload.', 'fire-tests')],
      contracts: {
        ...emptyContracts(),
        inputs: [observed('Event key plus optional firing identity and payload in the ambient event workspace.', 'fire-code')],
        outputs: [observed('A key lookup returns its stored fire receipt or null.', 'fire-read')],
        state: [observed('First-fired time is retained while last-fired metadata advances.', 'fire-tests')],
        guarantees: [observed('Repeated writes keep one row per workspace/key.', 'fire-code', 'fire-tests')],
        prerequisites: [unknown('Correct workspace context and a functioning PostgreSQL store are required.')],
        failureModes: [unknown('A fire receipt does not prove that a waiter woke or completed work; caller-side best-effort writes may fail.')],
      },
      evidence: [
        { id: 'fire-code', kind: 'implementation', path: root + 'events/await/store.ts', anchor: 'export async function recordKeyFire(', proves: 'Workspace-scoped event receipt upsert.' },
        { id: 'fire-read', kind: 'implementation', path: root + 'events/await/store.ts', anchor: 'export async function getKeyFireLatch(', proves: 'Workspace/key lookup, independent of waiter state.' },
        { id: 'fire-tests', kind: 'test', path: root + 'events/await/store.integration.test.ts', anchor: "it('a second recordKeyFire on the SAME key upserts in place", proves: 'One-row repeated-fire storage and immutable first-fired timestamp.' },
      ],
    },
  ];
  return parseCapabilityManifest({
    ...pilot, revision: 'problem-focused-2026-09-27-v1', units: [...pilot.units, ...additions],
    coverage: { ...pilot.coverage, note: pilot.coverage.note + ' This targeted extension covers review deadlines, stale evidence and durable event receipts; all other behavior remains unknown.' },
  }, adminRegistry.map(domain => domain.id));
}
