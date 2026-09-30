#!/usr/bin/env node
/**
 * papercusp-omp — CLI entry point.
 *
 * Usage:
 *   papercusp-omp connect --url <bundle-url> [--cwd <dir>]
 *
 * Tokens are NOT passed as flags (argv leaks to `ps`, shell history,
 * kernel audit — D-006). They are read from the environment:
 *   PAPERCUSP_BUNDLE_ACCESS_TOKEN   — required
 *   PAPERCUSP_BUNDLE_REFRESH_TOKEN  — required
 *   PAPERCUSP_BUNDLE_URL            — alternative to --url
 *   PAPERCUSP_OMP_CWD               — alternative to --cwd
 *   PAPERCUSP_AUTH_SESSION_ID       — optional; names the scratch dir
 *
 * The Papercusp desktop's "Launch agent" button sets these via Tauri's
 * Command::new(...).envs(...) — see the console-resolve envelope.
 */
import { randomUUID } from 'node:crypto';
import { connect } from './connect.js';

interface ParsedArgs {
  command: string | undefined;
  url: string | undefined;
  cwd: string | undefined;
  /** OMP session id to resume — passed through as `omp -r <id>`. */
  resume: string | undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    command: undefined,
    url: undefined,
    cwd: undefined,
    resume: undefined,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') {
      out.url = argv[++i];
    } else if (a === '--cwd') {
      out.cwd = argv[++i];
    } else if (a === '--resume' || a === '-r') {
      out.resume = argv[++i];
    } else if (a?.startsWith('--url=')) {
      out.url = a.slice('--url='.length);
    } else if (a?.startsWith('--cwd=')) {
      out.cwd = a.slice('--cwd='.length);
    } else if (a?.startsWith('--resume=')) {
      out.resume = a.slice('--resume='.length);
    } else if (a) {
      rest.push(a);
    }
  }
  out.command = rest[0];
  return out;
}

function usage(): void {
  process.stderr.write(
    [
      'papercusp-omp — launch an OMP agent scoped to a Papercusp workspace',
      '',
      'Usage:',
      '  papercusp-omp connect --url <bundle-url> [--cwd <dir>]',
      '',
      'Environment:',
      '  PAPERCUSP_BUNDLE_ACCESS_TOKEN   (required) short-lived access token',
      '  PAPERCUSP_BUNDLE_REFRESH_TOKEN  (required) refresh token, memory-only',
      '  PAPERCUSP_BUNDLE_URL            bundle URL (alternative to --url)',
      '  PAPERCUSP_OMP_CWD               working dir (alternative to --cwd)',
      '  PAPERCUSP_AUTH_SESSION_ID       optional scratch-dir name',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.command || args.command === 'help' || args.command === '--help') {
    usage();
    return args.command ? 0 : 1;
  }
  if (args.command !== 'connect') {
    process.stderr.write(`papercusp-omp: unknown command "${args.command}"\n`);
    usage();
    return 1;
  }

  const bundleUrl = args.url ?? process.env.PAPERCUSP_BUNDLE_URL;
  const accessToken = process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN;
  const refreshToken = process.env.PAPERCUSP_BUNDLE_REFRESH_TOKEN;
  const ompCwd = args.cwd ?? process.env.PAPERCUSP_OMP_CWD ?? process.cwd();
  const authSessionId =
    process.env.PAPERCUSP_AUTH_SESSION_ID ?? `pus-${randomUUID()}`;

  const missing: string[] = [];
  if (!bundleUrl) missing.push('--url or PAPERCUSP_BUNDLE_URL');
  if (!accessToken) missing.push('PAPERCUSP_BUNDLE_ACCESS_TOKEN');
  if (!refreshToken) missing.push('PAPERCUSP_BUNDLE_REFRESH_TOKEN');
  if (missing.length > 0) {
    process.stderr.write(`papercusp-omp: missing required input: ${missing.join(', ')}\n`);
    usage();
    return 1;
  }

  try {
    return await connect({
      bundleUrl: bundleUrl!,
      accessToken: accessToken!,
      refreshToken: refreshToken!,
      ompCwd,
      authSessionId,
      resumeSessionId: args.resume,
    });
  } catch (err) {
    process.stderr.write(
      `papercusp-omp: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`papercusp-omp: fatal: ${err}\n`);
    process.exit(1);
  },
);
