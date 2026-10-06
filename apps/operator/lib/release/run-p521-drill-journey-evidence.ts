/**
 * run-p521-drill-journey-evidence.ts — CLI for `deriveDrillJourneyEvidence()` (P-521, WI-10004750).
 *
 *   npx tsx apps/operator/lib/release/run-p521-drill-journey-evidence.ts \
 *     --drill <hive-git-physical-evidence v3 json> [--trust-anchor <trust json>] \
 *     --deb <installed .deb> --expected-deb-sha256 <hex from the release handoff> \
 *     --release 0.0.28-alpha --observer <ownerId> [--work-item WI-…] \
 *     [--journey <key> …] [--command '<drill command>'] [--out-dir docs/evidence]
 *     [--p202-transcript <p202-workdist.sh stdout> --p202-exit <rc> [--p202-started-at <iso>]]
 *
 * `--drill` and/or `--p202-transcript` (at least one). The P-202 LIVE-2 transcript
 * yields the `delegated-seat-lifecycle` journey (WI-10006413), which the drill cannot.
 *
 * Writes one `operational-test-evidence` document per journey into --out-dir, then
 * `run-p2p-candidate-manifest.ts --evidence-dir <out-dir>` binds them to the candidate.
 * Exit 0 = every written document passes; 1 = at least one fails; 2 = usage error.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { validatePhysicalDrillEvidence } from '@papercusp/operator-core/lib/sync/pot-git/physical-drill-evidence';
import { evidenceVerdict } from './p2p-candidate-evidence';
import { deriveDrillJourneyEvidence } from './p521-drill-journey-evidence';
import { deriveSeatJourneyEvidence } from './p202-seat-journey-evidence';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseArgs(argv: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`unexpected argument ${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} needs a value`);
    out.set(key.slice(2), [...(out.get(key.slice(2)) ?? []), value]);
    i += 1;
  }
  return out;
}

function main(): number {
  let args: Map<string, string[]>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String((err as Error).message));
    return 2;
  }
  const one = (key: string) => args.get(key)?.[0];
  const required = ['deb', 'expected-deb-sha256', 'release', 'observer'];
  const missing = required.filter((k) => !one(k));
  if (!one('drill') && !one('p202-transcript')) missing.push('drill (or --p202-transcript)');
  if (one('p202-transcript') && !/^\d+$/.test(one('p202-exit') ?? '')) missing.push('p202-exit (the driver exit status)');
  if (missing.length) {
    console.error(`missing required: ${missing.map((k) => `--${k}`).join(' ')}`);
    return 2;
  }

  const debPath = one('deb')!;
  const actualDebSha256 = sha256(readFileSync(debPath));
  const docs: Array<{ journey: string; fileName: string; doc: Record<string, unknown> }> = [];
  let validation: ReturnType<typeof validatePhysicalDrillEvidence> | null = null;

  const drillPath = one('drill');
  if (drillPath) {
    const drillBytes = readFileSync(drillPath);
    const drill = JSON.parse(drillBytes.toString('utf8')) as unknown;
    const anchorPath = one('trust-anchor');
    const anchor = anchorPath ? (JSON.parse(readFileSync(anchorPath, 'utf8')) as unknown) : undefined;
    validation = validatePhysicalDrillEvidence(drill, anchor);
    docs.push(
      ...deriveDrillJourneyEvidence({
        drill,
        drillPath: relative(process.cwd(), drillPath),
        drillSha256: sha256(drillBytes),
        validation,
        release: one('release')!,
        artifact: basename(debPath),
        actualDebSha256,
        expectedDebSha256: one('expected-deb-sha256')!,
        observer: one('observer')!,
        command: args.get('command') ?? [`hive-git-physical-scenario.sh run ${String((drill as { runId?: unknown }).runId ?? '?')}`],
        workItem: one('work-item'),
        journeys: args.get('journey'),
      }),
    );
  }

  const transcriptPath = one('p202-transcript');
  if (transcriptPath) {
    const transcriptBytes = readFileSync(transcriptPath);
    docs.push(
      deriveSeatJourneyEvidence({
        transcript: transcriptBytes.toString('utf8'),
        transcriptPath: relative(process.cwd(), transcriptPath),
        transcriptSha256: sha256(transcriptBytes),
        driverExitCode: Number(one('p202-exit')),
        release: one('release')!,
        artifact: basename(debPath),
        actualDebSha256,
        expectedDebSha256: one('expected-deb-sha256')!,
        observer: one('observer')!,
        command: ['papercusp-desktop/bin/vm-rig/p202-workdist.sh --i-accept-live-spawn'],
        workItem: one('work-item'),
        startedAt: one('p202-started-at'),
      }),
    );
  }

  const outDir = one('out-dir') ?? 'docs/evidence';
  mkdirSync(outDir, { recursive: true });
  let failed = 0;
  for (const { journey, fileName, doc } of docs) {
    const path = join(outDir, fileName);
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
    const { verdict, reason } = evidenceVerdict(doc);
    if (verdict !== 'pass') failed += 1;
    console.log(`P521_DRILL_JOURNEY\t${journey}\t${verdict}\t${path}\t${reason}`);
  }
  if (validation && !validation.ok) console.error(`drill evidence INVALID: ${validation.errors.join('; ')}`);
  return failed ? 1 : 0;
}

process.exitCode = main();
