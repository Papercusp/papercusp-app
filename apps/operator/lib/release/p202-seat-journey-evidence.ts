/**
 * p202-seat-journey-evidence.ts — turn ONE transcript of the P-202 LIVE-2 driver
 * (`papercusp-desktop/bin/vm-rig/p202-workdist.sh`) into the P-521
 * `delegated-seat-lifecycle` operational-test-evidence document (WI-10006413).
 *
 * The hive-git drill derivation (p521-drill-journey-evidence.ts) covers seven of the
 * eight P-521 journeys and deliberately refuses `delegated-seat-lifecycle`: that row
 * is proven by the LIVE-2 driver, which only prints human-readable WD lines. Without
 * this derivation a perfect LIVE-2 run never reaches the manifest, so the row reads
 * unmeasured and the profile refuses GO.
 *
 * Fail-closed rules:
 *   - every WD leg in `P202_SEAT_LEGS` must appear; a leg the transcript never shows
 *     is `missing` (evidenceVerdict: not run, never a pass);
 *   - a leg with any ✗ line is `fail`; with a SKIP line it is `skipped`; with a
 *     SETUP FAIL line it is `setup-fail` (a NO-VERDICT run is not a product verdict);
 *   - the exact-artifact assertion has the same rule as the drill derivation;
 *   - the driver's own tally line must agree with the per-leg reading, or the
 *     transcript is treated as untrustworthy.
 *
 * Pure: no I/O. The CLI (run-p521-drill-journey-evidence.ts --p202-transcript) reads
 * files and hashes.
 */

export const P202_SEAT_JOURNEY = 'delegated-seat-lifecycle' as const;

/**
 * Curated: the WD legs that back the P521-HARDENED-ACCEPTANCE "Trusted seats / F5 and
 * P202" row (host grant/offer, signed request, bounded spawn, backed work, receipt at
 * the origin, metering probe, revocation). Source: scenario-p202-workdist.sh.
 */
export const P202_SEAT_LEGS = ['WD-1', 'WD-2', 'WD-3', 'WD-4', 'WD-5', 'WD-6', 'WD-7', 'WD-8', 'WD-9'] as const;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const LEG_HEADER = /^\s*──\s*(WD-\d+)\b/;
const TALLY = /PASS=(\d+)\s+FAIL=(\d+)\s+SKIP=(\d+)\s+SETUP-FAIL=(\d+)/;
const RIG_LINE = /^\s*rig:\s*tower=(\S*)\s+vm=(\S*)\s+fleet=(\S*)\s+finished=(\S*)/;

type JsonRecord = Record<string, unknown>;

export interface SeatLegVerdict {
  leg: string;
  status: 'pass' | 'fail' | 'skipped' | 'setup-fail' | 'missing';
  pass: number;
  fail: number;
  skip: number;
  setup: number;
}

export interface SeatTranscriptReading {
  legs: SeatLegVerdict[];
  tally: { pass: number; fail: number; skip: number; setup: number } | null;
  /** Lines before the first WD header that report a SETUP FAIL (preflight). */
  preflightSetupFails: number;
  rig: { tower: string; vm: string; fleet: string; finishedAt: string } | null;
  overallPass: boolean;
}

/** Parse the driver's stdout into per-leg verdicts. Never throws. */
export function readSeatTranscript(transcript: string): SeatTranscriptReading {
  const counts = new Map<string, { pass: number; fail: number; skip: number; setup: number }>();
  let current: string | null = null;
  let preflightSetupFails = 0;
  let tally: SeatTranscriptReading['tally'] = null;
  let rig: SeatTranscriptReading['rig'] = null;
  let overallPass = false;
  for (const raw of transcript.split(/\r?\n/)) {
    const header = LEG_HEADER.exec(raw);
    if (header) {
      current = header[1];
      if (!counts.has(current)) counts.set(current, { pass: 0, fail: 0, skip: 0, setup: 0 });
      continue;
    }
    const line = raw.trim();
    const t = TALLY.exec(line);
    if (t && line.startsWith('P-202')) {
      tally = { pass: Number(t[1]), fail: Number(t[2]), skip: Number(t[3]), setup: Number(t[4]) };
      current = null;
      continue;
    }
    const r = RIG_LINE.exec(raw);
    if (r) {
      rig = { tower: r[1], vm: r[2], fleet: r[3], finishedAt: r[4] };
      continue;
    }
    if (line.startsWith('OVERALL: PASS')) overallPass = true;
    const kind = line.startsWith('✓')
      ? 'pass'
      : line.startsWith('✗')
        ? 'fail'
        : line.startsWith('⏭ SKIP')
          ? 'skip'
          : line.startsWith('⚠ SETUP FAIL')
            ? 'setup'
            : null;
    if (!kind) continue;
    if (current === null) {
      if (kind === 'setup') preflightSetupFails += 1;
      continue;
    }
    counts.get(current)![kind] += 1;
  }
  const legs = P202_SEAT_LEGS.map((leg): SeatLegVerdict => {
    const c = counts.get(leg);
    if (!c) return { leg, status: 'missing', pass: 0, fail: 0, skip: 0, setup: 0 };
    const status = c.fail
      ? 'fail'
      : c.setup
        ? 'setup-fail'
        : c.skip
          ? 'skipped'
          : c.pass
            ? 'pass'
            : 'missing';
    return { leg, status, ...c };
  });
  return { legs, tally, preflightSetupFails, rig, overallPass };
}

export interface SeatJourneyEvidenceInput {
  /** Full stdout of one p202-workdist.sh run, and where it was saved + its sha256. */
  transcript: string;
  transcriptPath: string;
  transcriptSha256: string;
  /** The driver's exit status (0 pass · 1 red · 2 NO VERDICT). */
  driverExitCode: number;
  release: string;
  artifact: string;
  actualDebSha256: string;
  expectedDebSha256: string;
  observer: string;
  command: string[];
  workItem?: string;
  startedAt?: string;
}

export interface SeatJourneyDoc {
  journey: typeof P202_SEAT_JOURNEY;
  fileName: string;
  doc: JsonRecord;
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Always returns ONE document; a bad run yields a failing or not-run document, never
 * none, so it stays visible in the manifest.
 */
export function deriveSeatJourneyEvidence(input: SeatJourneyEvidenceInput): SeatJourneyDoc {
  const reading = readSeatTranscript(input.transcript);
  const actual = input.actualDebSha256.toLowerCase();
  const expected = input.expectedDebSha256.toLowerCase();
  const artifactOk = SHA256_HEX.test(actual) && SHA256_HEX.test(expected) && actual === expected;

  const sum = reading.legs.reduce(
    (acc, l) => ({ pass: acc.pass + l.pass, fail: acc.fail + l.fail, skip: acc.skip + l.skip, setup: acc.setup + l.setup }),
    { pass: 0, fail: 0, skip: 0, setup: reading.preflightSetupFails },
  );
  const tallyAgrees =
    reading.tally !== null &&
    reading.tally.pass === sum.pass &&
    reading.tally.fail === sum.fail &&
    reading.tally.skip === sum.skip &&
    reading.tally.setup === sum.setup;
  const legsPass = reading.legs.every((l) => l.status === 'pass');
  const noVerdict = input.driverExitCode === 2 || sum.setup > 0;
  const driverPass = input.driverExitCode === 0 && reading.overallPass;
  const rigOk = !!reading.rig && !!reading.rig.tower && !!reading.rig.vm;

  const assertions = [
    {
      id: 'driver-overall-pass',
      passed: driverPass,
      evidence: `exit ${input.driverExitCode}; OVERALL: PASS line ${reading.overallPass ? 'present' : 'absent'}${noVerdict ? '; NO VERDICT (setup failed) — not a product verdict' : ''}`,
    },
    {
      id: 'tally-matches-legs',
      passed: tallyAgrees,
      evidence: reading.tally
        ? `driver tally PASS=${reading.tally.pass} FAIL=${reading.tally.fail} SKIP=${reading.tally.skip} SETUP-FAIL=${reading.tally.setup}; per-leg reading PASS=${sum.pass} FAIL=${sum.fail} SKIP=${sum.skip} SETUP-FAIL=${sum.setup}`
        : 'no driver tally line in the transcript',
    },
    {
      id: 'exact-artifact',
      passed: artifactOk,
      evidence: `DEB sha256 expect=${expected} actual=${actual} (actual computed over ${input.artifact})`,
    },
    {
      id: 'two-physical-hosts',
      passed: rigOk,
      evidence: reading.rig ? `tower=${reading.rig.tower} vm=${reading.rig.vm} fleet=${reading.rig.fleet}` : 'no rig line in the transcript',
    },
    {
      id: `legs-${P202_SEAT_LEGS.join('').replace(/WD-/g, '')}-pass`,
      passed: legsPass,
      evidence: reading.legs.map((l) => `${l.leg}:${l.status}`).join(', '),
    },
  ];
  const exitCode = assertions.every((a) => a.passed) ? 0 : 1;
  const runId = reading.rig?.fleet || 'unknown-run';
  const hosts = reading.rig
    ? [
        ...(reading.rig.tower ? [{ id: 'tower', hostname: reading.rig.tower }] : []),
        ...(reading.rig.vm ? [{ id: 'mac-vm', hostname: reading.rig.vm }] : []),
      ]
    : [];
  const doc: JsonRecord = {
    schemaVersion: 1,
    kind: 'operational-test-evidence',
    name: `P-521 ${P202_SEAT_JOURNEY} from P-202 LIVE-2 run ${runId} on ${input.release}`,
    framework: 'live',
    testLayer: 'e2e',
    evidencePlane: 'operational',
    plan: 'p2p-public-release-endgame-2026-09-01',
    planItem: 'P-521',
    ...(input.workItem ? { workItem: input.workItem } : {}),
    governingDecisions: ['p2p-public-release-endgame-2026-09-01#D-117', 'WI-10006413'],
    observer: input.observer,
    limitations: [
      'Derived by p202-seat-journey-evidence.ts from the p202-workdist.sh stdout; the transcript bytes are pinned in measuredBlobs.',
      'A skipped or setup-failed WD leg is not a pass: the row stays not-run until every WD leg is green.',
    ],
    subject: {
      release: input.release,
      artifact: input.artifact,
      debSha256: actual,
      expectedDebSha256: expected,
      topology: { hosts },
    },
    command: input.command,
    exitCode,
    driverExitCode: input.driverExitCode,
    startedAt: input.startedAt ?? null,
    finishedAt: reading.rig?.finishedAt || null,
    physicalRun: {
      runId,
      schemaVersion: 'p202-workdist-transcript/v1',
      window: { startedAt: input.startedAt ?? null, finishedAt: reading.rig?.finishedAt || null },
      legVerdicts: reading.legs.map((l) => ({ ...l })),
    },
    summary: `${P202_SEAT_JOURNEY}: ${reading.legs.filter((l) => l.status === 'pass').length}/${reading.legs.length} WD legs pass; driver exit ${input.driverExitCode}${noVerdict ? ' (NO VERDICT)' : ''}; artifact ${artifactOk ? 'exact' : 'MISMATCH'}`,
    assertions,
    measuredBlobs: [{ path: input.transcriptPath, sha256: input.transcriptSha256 }],
    p521Journey: P202_SEAT_JOURNEY,
  };
  return { journey: P202_SEAT_JOURNEY, fileName: `p521-p202-${safeId(runId)}-${P202_SEAT_JOURNEY}.json`, doc };
}
