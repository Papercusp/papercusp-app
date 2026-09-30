// WI-10003404 / plan host-memory-reduction-2026-09-27 P-004 — the shared typecheck service.
//
// Every scoped `lint:tsc --files=<a few files>` used to pay a whole-project compile: 17,712 files,
// 13.4 GB peak and ~29 s for operator-core, per caller. N agents checking N different files paid
// N × 13 GB, and pc-heavy could only coalesce callers whose watermark a running compile satisfied
// (measured 2026-09-27, plan decision D-003).
//
// One long-lived tsgo API server (`scripts/tsc-service/server.mjs`, socket-activated user unit)
// keeps each project's program loaded and answers a scoped request by checking only the files the
// verdict can depend on: ~1 s refresh + ~1 s check at ~5 GB, shared by every caller. The gate
// asks it first and falls back to the full CLI compile whenever it is unavailable or refuses.
//
// This module is the part both sides share: which runs are eligible, which files a scoped verdict
// needs checked, how an API diagnostic is rendered in the CLI's own text format (so the gate's
// existing parser reads service output unchanged), and the socket client.
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';

/** Set to `0` to force the full CLI compile (the A/B control, and the escape hatch). */
export const TSC_SERVICE_ENV = 'PAPERCUSP_TSC_SERVICE';

/** A scoped request whose checked set exceeds this is refused; a full compile is cheaper then. */
export const TSC_SERVICE_MAX_CHECKED_FILES = Number(process.env.PAPERCUSP_TSC_SERVICE_MAX_FILES) || 1500;

/** Queue wait plus check. A refusal or timeout falls back to the CLI, so this bounds the loss. */
export const TSC_SERVICE_TIMEOUT_MS = Number(process.env.PAPERCUSP_TSC_SERVICE_TIMEOUT_MS) || 240_000;

/**
 * The unix socket the service listens on (systemd passes it pre-bound; see
 * apps/operator/scripts/systemd/papercup-tsc-service.socket, which must name the same path).
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function tscServiceSocketPath(env = process.env) {
  if (env.PAPERCUSP_TSC_SERVICE_SOCKET) return env.PAPERCUSP_TSC_SERVICE_SOCKET;
  const runtimeDir = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`;
  return join(runtimeDir, 'papercusp-tsc-service.sock');
}

/**
 * The tsconfig a gate's `tscCommand` compiles, or null when the command carries anything the
 * service does not reproduce. Deliberately a whitelist: every leg today is exactly
 * `npx tsc -p <cfg> --noEmit --incremental false`, and a new flag (say `--strict false`) would
 * change diagnostics the service cannot see, so it must fall back rather than guess.
 *
 * @param {string} tscCommand
 * @returns {string | null} the `-p` operand, as written
 */
export function serviceProjectFromTscCommand(tscCommand) {
  const tokens = String(tscCommand ?? '').trim().split(/\s+/);
  let i = 0;
  if (tokens[i] !== 'npx') return null;
  i += 1;
  if (tokens[i] === '--no-install') i += 1;
  if (tokens[i] !== 'tsc') return null;
  i += 1;
  let project = null;
  for (; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '-p' || token === '--project') {
      project = tokens[i + 1] ?? null;
      i += 1;
    } else if (token === '--incremental' || token === '--pretty') {
      if (tokens[i + 1] !== 'false') return null;
      i += 1;
    } else if (token !== '--noEmit') {
      return null;
    }
  }
  return project;
}

/**
 * Whether this gate run may ask the service. Only an explicit `--files` run qualifies: a bare
 * run, `--mine` (whose set is the whole tree's dirt), `--update` and `--seed` all need the
 * complete program and stay on the CLI, which is also faster for a full program (71 s via the
 * API vs 29 s for the CLI, measured).
 *
 * @param {{
 *   tscCommand: string,
 *   explicitFiles: Set<string> | null,
 *   argv: string[],
 *   root: string,
 *   serviceRoot?: string | null,
 *   env?: Record<string, string | undefined>,
 * }} opts
 * @returns {{ eligible: true, project: string } | { eligible: false, reason: string }}
 */
export function tscServiceEligibility({ tscCommand, explicitFiles, argv, root, serviceRoot = null, env = process.env }) {
  if (env[TSC_SERVICE_ENV] === '0') return { eligible: false, reason: `${TSC_SERVICE_ENV}=0` };
  if (explicitFiles === null || explicitFiles.size === 0) return { eligible: false, reason: 'not a --files run' };
  if (argv.includes('--update') || argv.includes('--seed')) return { eligible: false, reason: 'baseline write' };
  const project = serviceProjectFromTscCommand(tscCommand);
  if (project === null) return { eligible: false, reason: 'tscCommand has flags the service does not reproduce' };
  // The service holds ONE checkout's programs. Another checkout (the release tree, a scratch
  // copy) would open a second full program in the same 16 GB budget, so it takes the CLI.
  if (serviceRoot !== null && resolve(serviceRoot) !== resolve(root)) {
    return { eligible: false, reason: `service serves ${serviceRoot}, not ${root}` };
  }
  return { eligible: true, project: resolve(root, project) };
}

/**
 * Offsets of each line start. API diagnostic positions are UTF-16 offsets (measured: `pos` 229 for
 * an identifier at UTF-16 offset 229 / UTF-8 offset 241), so a JS string is the right unit.
 *
 * @param {string} text
 * @returns {number[]}
 */
export function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (ch === 13) {
      if (text.charCodeAt(i + 1) === 10) i += 1;
      starts.push(i + 1);
    } else if (ch === 10) {
      starts.push(i + 1);
    }
  }
  return starts;
}

/**
 * @param {number[]} starts
 * @param {number} pos
 * @returns {{ line: number, character: number }} both zero-based
 */
export function lineAndCharacter(starts, pos) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, character: pos - starts[lo] };
}

/**
 * @typedef {{
 *   fileName?: string,
 *   pos: number,
 *   end?: number,
 *   code: number,
 *   category: number,
 *   text: string,
 *   messageChain?: ApiDiagnostic[],
 * }} ApiDiagnostic
 */

/**
 * Render error diagnostics exactly as `tsc --pretty false` prints them:
 * `path(line,col): error TS<code>: <text>`, each message-chain level on its own line indented two
 * spaces deeper, and no related-information lines (the CLI omits those in this format). Paths are
 * relative to `root`, which is the gate's cwd, as the CLI's are.
 *
 * @param {ApiDiagnostic[]} diagnostics
 * @param {{ root: string, textFor: (fileName: string) => string | null }} opts
 * @returns {string}
 */
export function renderDiagnostics(diagnostics, { root, textFor }) {
  const startsByFile = new Map();
  const startsFor = (fileName) => {
    if (!startsByFile.has(fileName)) {
      const text = textFor(fileName);
      startsByFile.set(fileName, text === null ? null : lineStarts(text));
    }
    return startsByFile.get(fileName);
  };
  const chain = (links, depth) =>
    (links ?? []).map((link) => `\n${'  '.repeat(depth)}${link.text}${chain(link.messageChain, depth + 1)}`).join('');

  let out = '';
  for (const d of diagnostics) {
    if (d.category !== 1) continue;
    let location = '';
    if (d.fileName) {
      const starts = startsFor(d.fileName);
      const { line, character } = starts ? lineAndCharacter(starts, d.pos) : { line: 0, character: 0 };
      location = `${relative(root, d.fileName)}(${line + 1},${character + 1}): `;
    }
    out += `${location}error TS${d.code}: ${d.text}${chain(d.messageChain, 1)}\n`;
  }
  return out;
}

const IMPORT_SPECIFIER = /\b(?:from|import|require)\s*\(?\s*['"]([^'"\n]+)['"]/g;
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|d\.[cm]?ts)$/;

/**
 * The module keys a file can be imported by: its absolute path without extension, plus its
 * directory for an `index` file.
 *
 * @param {string} absFile
 * @returns {string[]}
 */
function moduleKeysFor(absFile) {
  const bare = absFile.replace(SOURCE_EXTENSION, '');
  return bare.endsWith('/index') ? [bare, bare.slice(0, -'/index'.length)] : [bare];
}

/**
 * Whether `content` (the text of `importerAbs`) imports any of `namedKeys`. A relative specifier
 * is resolved exactly. A bare one (a package subpath or a path alias) matches when it ends with
 * the named module's last two path segments: a superset, which only costs check time.
 *
 * @param {string} content
 * @param {string} importerAbs
 * @param {Set<string>} namedKeys absolute module keys (see moduleKeysFor)
 * @param {Set<string>} namedTails `<dir>/<name>` tails of the same keys
 * @returns {boolean}
 */
export function importsAnyModule(content, importerAbs, namedKeys, namedTails) {
  IMPORT_SPECIFIER.lastIndex = 0;
  let m;
  while ((m = IMPORT_SPECIFIER.exec(content)) !== null) {
    const specifier = m[1].replace(SOURCE_EXTENSION, '');
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      if (namedKeys.has(resolve(dirname(importerAbs), specifier))) return true;
    } else {
      const segments = specifier.split('/');
      if (segments.length >= 2 && namedTails.has(segments.slice(-2).join('/'))) return true;
    }
  }
  return false;
}

/**
 * The files a scoped verdict about `named` depends on, drawn from the project's program:
 *
 *   - the named files themselves;
 *   - files that textually reference a type/interface/class/enum a named file exports — the gate's
 *     cause-aware widening (EI-18756182128903253) attributes their regressions to the caller, so
 *     they must be checked, not just parsed;
 *   - direct importers of a named file, whose breakage the CLI run would have reported.
 *
 * The residual against a full compile is a TRANSITIVE importer (through a barrel or a package
 * entry point) whose error does not mention an exported type name. The green-checkpoint's bare
 * run still judges those; the gate banner says so.
 *
 * @param {{
 *   root: string,
 *   named: Iterable<string>,
 *   programFiles: readonly string[],
 *   typeNames: Set<string>,
 *   readText: (absFile: string) => string | null,
 * }} opts
 * @returns {{ files: string[], named: number, typeReferencing: number, importers: number, namedNotInProgram: string[] }}
 */
export function checkedSetFor({ root, named, programFiles, typeNames, readText }) {
  const rootPrefix = `${resolve(root)}/`;
  const namedAbs = new Set([...named].map((file) => resolve(root, file)));
  const namedKeys = new Set([...namedAbs].flatMap(moduleKeysFor));
  const namedTails = new Set([...namedKeys].map((key) => key.split('/').slice(-2).join('/')));
  const escaped = [...typeNames].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const typePattern = escaped.length > 0 ? new RegExp(`\\b(?:${escaped.join('|')})\\b`) : null;

  const files = [];
  let namedCount = 0;
  let typeReferencing = 0;
  let importers = 0;
  const inProgram = new Set();
  for (const abs of programFiles) {
    if (!abs.startsWith(rootPrefix) || abs.includes('/node_modules/')) continue;
    inProgram.add(abs);
    if (namedAbs.has(abs)) {
      files.push(abs);
      namedCount += 1;
      continue;
    }
    const content = readText(abs);
    if (content === null) continue;
    if (typePattern?.test(content)) {
      files.push(abs);
      typeReferencing += 1;
    } else if (importsAnyModule(content, abs, namedKeys, namedTails)) {
      files.push(abs);
      importers += 1;
    }
  }
  const namedNotInProgram = [...namedAbs].filter((abs) => !inProgram.has(abs)).map((abs) => relative(root, abs));
  return { files, named: namedCount, typeReferencing, importers, namedNotInProgram };
}

/**
 * Restrict a baseline map to the files a service run actually judged. Without this every
 * baselined file outside the checked set reads as "improved to 0" and the report lists hundreds
 * of phantom improvements.
 *
 * @param {Record<string, number>} baselineByFile
 * @param {Set<string>} judged
 * @returns {Record<string, number>}
 */
export function baselineWithinScope(baselineByFile, judged) {
  return Object.fromEntries(Object.entries(baselineByFile).filter(([file]) => judged.has(file)));
}

/**
 * @typedef {{
 *   ok: true,
 *   output: string,
 *   errorCount: number,
 *   checked: string[],
 *   counts: { named: number, typeReferencing: number, importers: number },
 *   namedNotInProgram: string[],
 *   snapshotAgeMs: number,
 *   queuedMs: number,
 *   checkMs: number,
 * } | { ok: false, reason: string, detail?: string }} TscServiceResponse
 */

/**
 * One request over the socket: a JSON line out, a JSON line back.
 *
 * @param {{ socketPath: string, request: Record<string, unknown>, timeoutMs?: number }} opts
 * @returns {Promise<TscServiceResponse>}
 */
export function requestTscService({ socketPath, request, timeoutMs = TSC_SERVICE_TIMEOUT_MS }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    const fail = (error) => {
      clearTimeout(timer);
      socket.destroy();
      rejectPromise(error);
    };
    const timer = setTimeout(() => fail(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        resolvePromise(JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        rejectPromise(error);
      }
    });
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('connection closed before an answer')));
  });
}

/**
 * The gate's side: ask the service to check `files` in `project`, returning null (with the
 * reason already printed) whenever the caller must fall back to the full compile.
 *
 * @param {{ root: string, project: string, files: string[], label: string, log?: (line: string) => void }} opts
 * @returns {Promise<Extract<TscServiceResponse, { ok: true }> | null>}
 */
export async function typecheckViaService({ root, project, files, label, log = (line) => console.error(line) }) {
  const socketPath = tscServiceSocketPath();
  try {
    const response = await requestTscService({ socketPath, request: { v: 1, root, project, files } });
    if (response.ok) return response;
    log(`⚠ TSC_SERVICE declined (${response.reason}${response.detail ? `: ${response.detail}` : ''}) — running the full ${label} compile instead.`);
  } catch (error) {
    log(`⚠ TSC_SERVICE unreachable at ${socketPath} (${error instanceof Error ? error.message : String(error)}) — running the full ${label} compile instead.`);
  }
  return null;
}

/**
 * The line a service-served run prints, so a reader knows this verdict came from the service and
 * how far it reached.
 *
 * @param {Extract<TscServiceResponse, { ok: true }>} response
 * @returns {string[]}
 */
export function formatTscServiceBanner(response) {
  const lines = [
    `TSC_SERVICE used=1 checked=${response.checked.length} named=${response.counts.named} ` +
      `typeReferencing=${response.counts.typeReferencing} importers=${response.counts.importers} ` +
      `errors=${response.errorCount} queuedMs=${response.queuedMs} checkMs=${response.checkMs} ` +
      `snapshotAgeMs=${response.snapshotAgeMs}`,
    `   (shared typecheck service: judged your files, files referencing their exported types, and their direct ` +
      `importers — not the whole project. A transitive importer is judged by the bare run; ` +
      `${TSC_SERVICE_ENV}=0 forces the full compile.)`,
  ];
  if (response.namedNotInProgram.length > 0) {
    lines.push(
      `   (${response.namedNotInProgram.length} named file(s) are not in this project's program, as with the CLI: ` +
        `${response.namedNotInProgram.slice(0, 5).join(', ')}${response.namedNotInProgram.length > 5 ? ', …' : ''})`,
    );
  }
  return lines;
}

/**
 * Read a file's text, or null when it cannot be read. The server's cached reader wraps this.
 *
 * @param {string} absFile
 * @returns {string | null}
 */
export function readTextOrNull(absFile) {
  try {
    return readFileSync(absFile, 'utf8');
  } catch {
    return null;
  }
}
