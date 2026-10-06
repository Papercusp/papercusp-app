/**
 * p521-drill-journey-evidence.ts — turn ONE physical hive-git drill run
 * (`hive-git-physical-evidence/v3`, legs A-J) into per-journey
 * `operational-test-evidence` documents that `deriveJourneyEvidence()` binds to a
 * release candidate (p2p-public-release-endgame-2026-09-01 P-521, WI-10004750).
 *
 * Before this module, a drill run reached the P-521 manifest only through a
 * hand-authored evidence document plus a `p521-journey-mapping` doc (run 34, D-083).
 * This module DERIVES the documents from the run itself:
 *
 *   - the journey a document declares comes from `DRILL_LEG_JOURNEYS` (the one curated
 *     table below, with each row's governing decision);
 *   - `physicalRun.legVerdicts` holds ONLY that journey's legs, so a reader sees which
 *     legs back which journey;
 *   - `subject.debSha256` is the sha256 the CLI COMPUTED over the installed `.deb`, never
 *     a typed value. The `exact-artifact` assertion compares it with the expected digest
 *     from the release handoff. A mismatch fails the document, and because the computed
 *     digest is not a candidate member, the manifest also reads it as other-artifact;
 *   - the drill's own validator (`validatePhysicalDrillEvidence`) is all-or-nothing over
 *     A-J by design ("same-run A-J"), so its verdict is a `drill-evidence-valid`
 *     assertion on EVERY document: an invalid run supports no journey.
 *
 * Pure: no I/O. The CLI (run-p521-drill-journey-evidence.ts) reads files and hashes.
 */

/** Curated: which drill legs back which P-521 journey, and the decision that says so. */
export const DRILL_LEG_JOURNEYS: ReadonlyArray<{ journey: string; legs: readonly string[]; decision: string }> = [
  // D-083: the run-34 mapping declared discovery/git-consistency/github on the whole A-G run.
  { journey: 'discovery-join', legs: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], decision: 'p2p-public-release-endgame-2026-09-01#D-083' },
  { journey: 'git-consistency-signed-scope', legs: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], decision: 'p2p-public-release-endgame-2026-09-01#D-083' },
  { journey: 'github-bridge', legs: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], decision: 'p2p-public-release-endgame-2026-09-01#D-083' },
  // D-081: leg H is the F3 serving-identity journey.
  { journey: 'serving-identity-restart', legs: ['H'], decision: 'p2p-public-release-endgame-2026-09-01#D-081' },
  // D-082: leg G proves the canonical-staging sink; leg I is the rest of the protected-effect set.
  { journey: 'protected-effect-fencing', legs: ['G', 'I'], decision: 'p2p-public-release-endgame-2026-09-01#D-082' },
  // WI-10003961: leg J is the F4 bounded-outage / replay journey.
  { journey: 'replicated-write-outage-replay', legs: ['J'], decision: 'WI-10003961' },
];

export const DRILL_EVIDENCE_SCHEMA = 'hive-git-physical-evidence/v3' as const;

const SHA256_HEX = /^[0-9a-f]{64}$/;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface DrillValidation {
  ok: boolean;
  errors: string[];
  summary: string;
}

export interface DrillJourneyEvidenceInput {
  /** Parsed drill evidence document (v3). */
  drill: unknown;
  /** Repo-relative (or absolute) path of the drill evidence file, and the sha256 of its bytes. */
  drillPath: string;
  drillSha256: string;
  /** Result of `validatePhysicalDrillEvidence(drill, trustAnchor)`. */
  validation: DrillValidation;
  /** Release under test, e.g. `0.0.28-alpha`. */
  release: string;
  /** Basename of the installed artifact, e.g. `Papercusp Server_0.0.28_amd64.deb`. */
  artifact: string;
  /** sha256 the caller COMPUTED over the installed artifact bytes. */
  actualDebSha256: string;
  /** sha256 the release handoff names for that artifact. */
  expectedDebSha256: string;
  /** Who produced the documents (an ownerId). */
  observer: string;
  /** The command that ran the drill, recorded verbatim. */
  command: string[];
  workItem?: string;
  /** Restrict output to these journeys (default: every journey in DRILL_LEG_JOURNEYS). */
  journeys?: readonly string[];
}

export interface DrillJourneyDoc {
  journey: string;
  /** Suggested file name: `p521-drill-<runId>-<journey>.json`. */
  fileName: string;
  doc: JsonRecord;
}

function safeRunId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * One document per journey. Throws only on a programming error (unknown journey key);
 * an invalid drill or a wrong artifact produces FAILING documents, never no documents,
 * so a bad run stays visible in the manifest instead of reading as unmeasured.
 */
export function deriveDrillJourneyEvidence(input: DrillJourneyEvidenceInput): DrillJourneyDoc[] {
  const drill = isRecord(input.drill) ? input.drill : {};
  const runId = typeof drill.runId === 'string' && drill.runId ? drill.runId : 'unknown-run';
  const window = isRecord(drill.window) ? drill.window : {};
  const allLegs = (Array.isArray(drill.legVerdicts) ? drill.legVerdicts : []).filter(isRecord);
  const topology = isRecord(drill.topology) ? drill.topology : null;

  const wanted = input.journeys ?? DRILL_LEG_JOURNEYS.map((row) => row.journey);
  const rows = wanted.map((journey) => {
    const row = DRILL_LEG_JOURNEYS.find((r) => r.journey === journey);
    if (!row) throw new Error(`no drill legs are mapped to journey '${journey}'`);
    return row;
  });

  const actual = input.actualDebSha256.toLowerCase();
  const expected = input.expectedDebSha256.toLowerCase();
  // Run 3+ drills record the deb they ran on at `subject.debSha256` (su-81ee2033, 2026-10-01).
  // When present it must name the same bytes, or the drill exercised a different artifact
  // from the one these docs certify. Absent (older drills) = not checked, not a failure.
  const drillSubject = isRecord(drill.subject) ? drill.subject : {};
  const drillDeb = typeof drillSubject.debSha256 === 'string' ? drillSubject.debSha256.toLowerCase() : null;
  const drillDebOk = drillDeb === null || drillDeb === actual;
  const artifactOk =
    SHA256_HEX.test(actual) && SHA256_HEX.test(expected) && actual === expected && drillDebOk;

  return rows.map((row) => {
    const scoped = row.legs.map((leg) => {
      const found = allLegs.find((l) => l.leg === leg);
      // A leg the run never recorded is reported as `missing`, which evidenceVerdict
      // treats as not-run (unknown), never as a pass.
      return found ? { ...found } : { leg, status: 'missing' };
    });
    const legsPass = scoped.every((l) => l.status === 'pass');
    const assertions = [
      {
        id: 'drill-evidence-valid',
        passed: input.validation.ok,
        evidence: input.validation.ok
          ? input.validation.summary
          : `${input.validation.summary}: ${input.validation.errors.slice(0, 20).join('; ')}`,
      },
      {
        id: 'exact-artifact',
        passed: artifactOk,
        evidence:
          `DEB sha256 expect=${expected} actual=${actual} (actual computed over ${input.artifact})` +
          (drillDeb === null ? '; drill subject.debSha256 not recorded' : `; drill subject.debSha256=${drillDeb}`),
      },
      {
        id: `legs-${row.legs.join('')}-pass`,
        passed: legsPass,
        evidence: scoped.map((l) => `${String(l.leg)}:${String(l.status)}`).join(', '),
      },
    ];
    const exitCode = assertions.every((a) => a.passed) ? 0 : 1;
    const doc: JsonRecord = {
      schemaVersion: 1,
      kind: 'operational-test-evidence',
      name: `P-521 ${row.journey} from physical drill run ${runId} on ${input.release}`,
      framework: 'live',
      testLayer: 'e2e',
      evidencePlane: 'operational',
      plan: 'p2p-public-release-endgame-2026-09-01',
      planItem: 'P-521',
      ...(input.workItem ? { workItem: input.workItem } : {}),
      governingDecisions: [row.decision],
      observer: input.observer,
      limitations: [
        `Derived by p521-drill-journey-evidence.ts from ${DRILL_EVIDENCE_SCHEMA} run ${runId}; the drill evidence bytes are pinned in measuredBlobs.`,
        'The drill validator is all-or-nothing over legs A-J, so any invalid leg fails every journey derived from this run.',
      ],
      subject: {
        release: input.release,
        artifact: input.artifact,
        debSha256: actual,
        expectedDebSha256: expected,
        ...(topology ? { topology } : {}),
      },
      command: input.command,
      exitCode,
      startedAt: window.startedAt ?? null,
      finishedAt: window.finishedAt ?? null,
      physicalRun: {
        runId,
        schemaVersion: drill.schemaVersion ?? null,
        window,
        legVerdicts: scoped,
      },
      summary: `${row.journey}: legs ${row.legs.join(',')} ${legsPass ? 'pass' : 'NOT all pass'}; drill ${input.validation.ok ? 'valid' : 'INVALID'}; artifact ${artifactOk ? 'exact' : 'MISMATCH'}`,
      assertions,
      measuredBlobs: [{ path: input.drillPath, sha256: input.drillSha256 }],
      p521Journey: row.journey,
    };
    return { journey: row.journey, fileName: `p521-drill-${safeRunId(runId)}-${row.journey}.json`, doc };
  });
}
