#!/usr/bin/env node
// scripts/schemathesis-routes.ts — P-024, plan design-to-code-coverage-seam-2026-09-02.
//
// Run Schemathesis over the `http-route` surfaces, generating positive,
// negative and stateful cases FROM the OpenAPI document, with zero
// per-endpoint maintenance.
//
//   npm run gate:schemathesis                       # against a running :3070
//   npm run gate:schemathesis -- --url http://127.0.0.1:3170
//   npm run gate:schemathesis -- --include-path-regex '^/api/health'
//   npm run gate:schemathesis -- --schema /tmp/openapi.json --json
//
// ── The toolchain judgement this item owed (D-049) ──
// Schemathesis is a PYTHON tool. npm cannot acquire it, so this gate adds a
// non-npm toolchain dependency, and that has to be answered out loud rather
// than by omission:
//
//   PINNED   — `SCHEMATHESIS_PIN` in the lib module is the single copy of the
//              intended version. Nothing else restates it.
//   ACQUIRED — `pipx run schemathesis==<pin>` needs no global install and no
//              virtualenv management, so CI acquires the pin by running it.
//              An already-installed module is used as-is when present.
//   ABSENT   — the gate REFUSES: exit 2, naming the remedy. It does NOT skip.
//
// That last line is the whole point. The plan's D-008 says a check that cannot
// fail is decoration; a gate that silently exits 0 when its dependency is
// missing is worse, because it reports success for work it never did. Note the
// plan's D-004 rejected a dependency in the analogous cover-agent case — that
// was an UNMAINTAINED OSS dependency reimplementable on in-repo surfaces.
// Schemathesis 4.x is actively maintained and implements property-based
// OpenAPI fuzzing with a Rust core; reimplementing it is not a day's work and
// would be a strictly worse instrument. Different situation, opposite call,
// stated deliberately rather than by silence.
//
// EXIT CODES — three-valued, matching the sibling gates:
//   0  PASS         — ran over at least one operation and found no violation
//   1  VIOLATIONS   — ran and found conclusive schema violations
//   2  UNAVAILABLE  — could not measure (toolchain absent, schema unreachable,
//                     server down, or a run that exercised nothing). NEVER
//                     collapsed into 0.

import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildGovernedProcessDemand,
  classifyGovernedTestProcessOutcome,
  governedProcessIdempotencyKey,
  runGovernedTestProcess,
} from './lib/governed-test-process.mjs';
import {
  SCHEMATHESIS_PIN,
  buildSchemathesisArgv,
  describeSchemathesisVerdict,
  judgeSchemathesisRun,
  parseSchemathesisReport,
  resolveSchemathesisToolchain,
  schemathesisExitCode,
  summarizeOpenApiSurface,
  type SchemathesisRunObservation,
  type SchemathesisToolchainProbe,
} from '../packages/operator-core/lib/schemathesis-http-routes.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const SCHEMATHESIS_PROCESS_TIMEOUT_MS = 30 * 60_000;
let processSequence = 0;

type GovernedProcessResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: string;
  timedOut?: boolean;
};

/**
 * Resolve binary presence without starting a shell solely to run `command -v`.
 * The actual Python and Schemathesis processes still go through the governed
 * process bridge below.
 */
function executableOnPath(bin: string): boolean {
  const names =
    process.platform === 'win32'
      ? [bin, ...String(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((ext) => `${bin}${ext}`)]
      : [bin];
  return String(process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .some((directory) =>
      names.some((name) => {
        try {
          accessSync(join(directory, name), constants.X_OK);
          return true;
        } catch {
          return false;
        }
      }),
    );
}

/** Run one external process behind a durable, full-lifetime process receipt. */
async function runProcess(
  command: string,
  args: string[],
  { timeoutMs = SCHEMATHESIS_PROCESS_TIMEOUT_MS, processKind = 'schemathesis-child' } = {},
): Promise<GovernedProcessResult> {
  const processIdentity = `${process.pid}:${processSequence++}:${command}:${JSON.stringify(args)}`;
  const demand = buildGovernedProcessDemand({
    diskBytes: MAX_CAPTURE_BYTES,
    fileDescriptors: 20,
  });

  try {
    return await runGovernedTestProcess(
      {
        workspaceId: process.env.PAPERCUSP_WORKSPACE_ID ?? process.env.PAPERCUSP_WORKSPACE,
        namespace: 'schemathesis-process',
        owner: `schemathesis:${process.pid}`,
        idempotencyKey: governedProcessIdempotencyKey('schemathesis', processIdentity),
        payloadRef: 'schemathesis-routes',
        timeoutMs,
        demand,
        metadata: {
          processKind,
          command,
          argv: args.join('\0'),
        },
        env: process.env,
        settle: classifyGovernedTestProcessOutcome,
      },
      (_admissionContext: unknown, governedEnv: NodeJS.ProcessEnv) =>
        new Promise<GovernedProcessResult>((resolveRun) => {
          const stdout: Buffer[] = [];
          const stderr: Buffer[] = [];
          let spawnError: Error | null = null;
          let timedOut = false;
          let child;
          try {
            child = spawn(command, args, {
              cwd: ROOT,
              env: governedEnv,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
          } catch (error) {
            spawnError = error instanceof Error ? error : new Error(String(error));
            resolveRun({
              stdout: '',
              stderr: spawnError.message,
              code: null,
              signal: null,
              spawnError: spawnError.message,
            });
            return;
          }

          const timeout =
            timeoutMs > 0
              ? setTimeout(() => {
                  timedOut = true;
                  child.kill('SIGTERM');
                }, timeoutMs)
              : null;
          timeout?.unref?.();
          child.stdout?.on('data', (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)));
          child.stderr?.on('data', (chunk: Buffer | string) => stderr.push(Buffer.from(chunk)));
          child.once('error', (error) => {
            spawnError = error instanceof Error ? error : new Error(String(error));
          });
          child.once('close', (code, signal) => {
            if (timeout) clearTimeout(timeout);
            resolveRun({
              stdout: Buffer.concat(stdout).toString('utf8'),
              stderr: Buffer.concat(stderr).toString('utf8'),
              code,
              signal,
              ...(spawnError ? { spawnError: spawnError.message } : {}),
              ...(timedOut ? { timedOut: true } : {}),
            });
          });
        }),
    );
  } catch (error) {
    return {
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      code: null,
      signal: null,
      spawnError: error instanceof Error ? error.message : String(error),
    };
  }
}

function processFailureDetail(result: GovernedProcessResult): string {
  return result.spawnError ?? (result.stderr.trim() || `process exited with code ${result.code ?? 'null'}`);
}

/** Probe the host toolchain. Every failure here is an observation, not a throw. */
async function probeToolchain(): Promise<SchemathesisToolchainProbe> {
  const pythonPresent = executableOnPath('python3');
  let moduleVersion: string | null = null;
  if (pythonPresent) {
    const result = await runProcess(
      'python3',
      ['-c', 'import schemathesis, sys; sys.stdout.write(schemathesis.__version__)'],
      { timeoutMs: 30_000, processKind: 'schemathesis-toolchain-probe' },
    );
    if (result.code === 0 && result.stdout.trim()) moduleVersion = result.stdout.trim();
  }
  return { pythonPresent, moduleVersion, pipxPresent: executableOnPath('pipx') };
}

/** Load the OpenAPI document from a URL or a local path. Null on any failure. */
async function loadSchema(location: string): Promise<{ doc: unknown; detail: string }> {
  if (/^https?:\/\//.test(location)) {
    // curl rather than fetch: the document is multi-megabyte and this keeps
    // the failure modes (DNS, refused, timeout) as one readable exit code.
    const result = await runProcess(
      'curl',
      ['-sS', '--fail', '--max-time', '60', location],
      { timeoutMs: 65_000, processKind: 'schemathesis-schema-fetch' },
    );
    if (result.code !== 0 || result.signal || result.spawnError) {
      return { doc: null, detail: `could not fetch ${location}: ${processFailureDetail(result)}` };
    }
    const body = result.stdout;
    try {
      return { doc: JSON.parse(body), detail: `fetched ${body.length} bytes from ${location}` };
    } catch (error) {
      return { doc: null, detail: `could not parse ${location}: ${(error as Error).message}` };
    }
  }

  const abs = resolve(ROOT, location);
  if (!existsSync(abs)) return { doc: null, detail: `schema not found: ${abs}` };
  try {
    const body = readFileSync(abs, 'utf8');
    return { doc: JSON.parse(body), detail: `read ${body.length} bytes from ${abs}` };
  } catch (err) {
    return { doc: null, detail: `could not parse ${abs}: ${(err as Error).message}` };
  }
}

/**
 * Read the NDJSON report schemathesis wrote, as raw text.
 *
 * It names the file itself (`ndjson-<UTC timestamp>.ndjson`), so this globs
 * rather than assuming a name. Empty string when nothing was written — which
 * the parser turns into `operationsTested: null`, i.e. a refusal.
 */
function readNdjsonReport(dir: string): string {
  if (!existsSync(dir)) return '';
  const files = readdirSync(dir).filter((f) => f.endsWith('.ndjson'));
  for (const file of files) {
    try {
      return readFileSync(join(dir, file), 'utf8');
    } catch {
      /* try the next one */
    }
  }
  return '';
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const argValue = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
  };
  const asJson = args.includes('--json');

  const baseUrl = argValue('--url') ?? 'http://127.0.0.1:3070';
  const schemaLocation = argValue('--schema') ?? `${baseUrl}/api/openapi.json`;
  const maxExamples = Number(argValue('--max-examples') ?? '5');
  const includePathRegex = argValue('--include-path-regex');
  const stateful = !args.includes('--no-stateful');

  const toolchain = resolveSchemathesisToolchain(await probeToolchain());
  const { doc, detail: schemaDetail } = await loadSchema(schemaLocation);
  const surface = summarizeOpenApiSurface(doc);

  let run: SchemathesisRunObservation | null = null;

  // Only spawn when there is something to spawn FOR. A missing toolchain or an
  // unreadable schema is already a refusal; running anyway would just produce a
  // second, less informative failure.
  if (toolchain.available && surface && surface.operations > 0) {
    const built = buildSchemathesisArgv({
      toolchain,
      schemaLocation,
      baseUrl,
      maxExamples,
      includePathRegex,
      stateful,
    });

    if (!built) {
      run = { exitCode: null, operationsTested: null, checksFailed: null, detail: 'no runnable argv' };
    } else {
      const reportDir = mkdtempSync(join(tmpdir(), 'schemathesis-report-'));
      try {
        const r = await runProcess(built.command, [...built.args, '--report-dir', reportDir], {
          timeoutMs: SCHEMATHESIS_PROCESS_TIMEOUT_MS,
          processKind: 'schemathesis-run',
        });
        const parsed = parseSchemathesisReport(readNdjsonReport(reportDir));
        run = {
          exitCode: r.code,
          operationsTested: parsed.operationsTested,
          checksFailed: parsed.checksFailed,
          detail: r.spawnError ? `spawn failed: ${r.spawnError}` : parsed.detail,
        };
      } finally {
        rmSync(reportDir, { recursive: true, force: true });
      }
    }
  }

  const verdict = judgeSchemathesisRun({ toolchain, surface, run });

  if (asJson) {
    console.log(JSON.stringify({ schemaLocation, baseUrl, schemaDetail, ...verdict }, null, 2));
  } else {
    console.log(describeSchemathesisVerdict(verdict));
    console.log(`  schema=${schemaLocation}`);
    console.log(`  base-url=${baseUrl}`);
    console.log(`  ${schemaDetail}`);
    console.log(`  toolchain=${toolchain.runner ?? 'none'} version=${toolchain.version ?? 'n/a'} (pin ${SCHEMATHESIS_PIN})`);
    if (surface) {
      console.log(
        `  surface: ${surface.operations} operations over ${surface.paths} paths, ` +
          `${surface.operationsWithSchema} with a schema, ${surface.componentSchemas} component schemas`,
      );
    }
    for (const note of verdict.notes) console.log(`  note: ${note}`);
    if (toolchain.remedy) console.log(`  remedy: ${toolchain.remedy}`);
    if (verdict.decision === 'unavailable') {
      console.log('  UNAVAILABLE is a REFUSAL, not a skip: this gate did not run, so nothing is proven.');
    }
  }

  return schemathesisExitCode(verdict);
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  },
);
