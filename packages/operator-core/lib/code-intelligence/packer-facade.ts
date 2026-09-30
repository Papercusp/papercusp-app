/**
 * The PACKING leg of the code-intelligence routing table (plan
 * `code-intelligence-routing-lsp-gitnexus-2026-08-20`, P-016; rulings D-005 and
 * D-040).
 *
 * A pack is EVIDENCE. Unlike every other leg in this layer — which answers a
 * question with a list of sites a reader can go verify — a packer hands a
 * reviewer or a model a document they then reason about *as if it were the
 * repository*. That difference drives every design choice below:
 *
 *  - **The engine is pinned, exactly.** The pre-P-016 plugin ran
 *    `npx repomix`, which resolves whatever is latest at call time. Two packs
 *    cut minutes apart could therefore come from different engines with
 *    different default ignore sets and a different secret scanner — and two
 *    packs that disagree would be indistinguishable from two trees that
 *    disagree. Both binaries resolve by EXPLICIT VENDOR PATH, never through
 *    PATH and never through `npx`, and the resolved version must EQUAL the pin
 *    (not merely parse) so a drifted vendor dir is a loud refusal.
 *
 *  - **The dangerous flags are unreachable by construction.** Both CLIs expose
 *    flags that would silently make a pack unsafe or non-reproducible:
 *    repomix's `--no-security-check` disables secret scanning, `--remote`
 *    clones an arbitrary third-party repository, `-o` writes a file into the
 *    tree behind the lock arbitration, `--no-gitignore` packs ignored files.
 *    code2prompt's `--hidden` packs dotfiles (`.env` among them), `--no-ignore`
 *    bypasses gitignore, and `-t` reads an arbitrary Handlebars template off
 *    disk. The arg builders are PURE functions that cannot emit any of them,
 *    which makes that a property of the argv the tests assert rather than a
 *    promise in a comment.
 *
 *  - **The secret deny-set is not overridable.** It is appended to the ignore
 *    set on EVERY pack, by both engines, after caller input — so no caller
 *    argument can shorten it.
 *
 *  - **A measured asymmetry the router must respect (D-040):** repomix runs a
 *    secret scanner; code2prompt 4.2.0 has none, anywhere in its option
 *    surface. The two packers are therefore NOT interchangeable on a tree that
 *    may hold credentials, and every pack states which protection it actually
 *    had via `provenance.securityScan` rather than leaving a consumer to
 *    assume.
 *
 * `fileCount` is `null` — never `0` — when the selection could not be parsed
 * out of the pack. This is the same discipline `isTrustworthyEmpty` encodes for
 * the read legs: an unparseable pack must not be reportable as an empty one,
 * because "I could not tell what went in" and "nothing went in" are different
 * answers and only one of them is evidence.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';

import {
  DEFAULT_RESOURCE_BUDGET,
  type CodeIntelAnswer,
  type CodeIntelBackend,
  type CodeIntelIntent,
  type SymbolSite,
} from './contracts.ts';

let execFileAsync: ((...args: any[]) => Promise<any>) | undefined;
const runExecFile = (...args: any[]) => (execFileAsync ??= promisify(execFile) as any)(...args);

// ───────────────────────── pinned engines ─────────────────────────

/** Vendor roots. Provisioned by P-016; never installed at runtime. */
export const REPOMIX_VENDOR_DIR = join(homedir(), '.papercusp', 'vendor', 'repomix');
export const CODE2PROMPT_VENDOR_DIR = join(homedir(), '.papercusp', 'vendor', 'code2prompt');

/**
 * The EXACT pinned versions.
 *
 * These are not documentation — `assertIsRepomix`/`assertIsCode2Prompt` compare
 * the binary's own `--version` output against them and refuse on mismatch. A
 * range would defeat the purpose: "pinned" has to mean the pack can name the
 * one engine that produced it.
 */
export const REPOMIX_PINNED_VERSION = '1.18.0';
export const CODE2PROMPT_PINNED_VERSION = '4.2.0';

export type PackerEngine = Extract<CodeIntelBackend, 'repomix' | 'code2prompt'>;

/** repomix ships as an npm package; its bin lands in the vendor node_modules. */
export function resolveRepomixBin(): string | null {
  const bin = join(REPOMIX_VENDOR_DIR, 'node_modules', '.bin', 'repomix');
  return existsSync(bin) ? bin : null;
}

/**
 * code2prompt is a Rust binary, installed from the pinned GitHub release asset.
 *
 * ⚠ Deliberately NOT the npm package called `code2prompt`. That name on npm
 * resolves to `github.com/puntorigen/code2prompt`, an unrelated NodeJS *library*
 * that ships no executable at all — a same-name impostor on a different
 * registry (D-040). This is the `sg` trap from D-039 one layer up, which is why
 * identity here is proven from the `--version` STRING and not from the fact
 * that something answered.
 */
export function resolveCode2PromptBin(): string | null {
  const bin = join(CODE2PROMPT_VENDOR_DIR, 'bin', 'code2prompt');
  return existsSync(bin) ? bin : null;
}

export interface EngineIdentity {
  readonly engine: PackerEngine;
  readonly bin: string;
  readonly version: string;
}

type IdentityVerdict = { ok: true; version: string } | { ok: false; reason: string };

/**
 * repomix prints a BARE semver (measured at 1.18.0: `1.18.0`).
 *
 * A bare semver is weak identity on its own — many tools print one — so the
 * check that carries the weight is equality with the pin. That is also the
 * check that catches the failure this leg actually exists to prevent: a vendor
 * dir that drifted off the pin (an `npm update`, a range that re-resolved)
 * still answers `--version` perfectly well, just with the wrong engine.
 */
export function assertIsRepomix(versionOutput: string): IdentityVerdict {
  const text = versionOutput.trim();
  const m = /^(\d+\.\d+\.\d+)$/m.exec(text);
  if (!m) {
    return {
      ok: false,
      reason:
        `the resolved repomix binary did not print a bare semver (it printed ` +
        `${JSON.stringify(text.slice(0, 80))}).`,
    };
  }
  if (m[1] !== REPOMIX_PINNED_VERSION) {
    return {
      ok: false,
      reason:
        `pinned repomix has DRIFTED: expected exactly ${REPOMIX_PINNED_VERSION}, found ${m[1]}. ` +
        `A pack names the engine that produced it, so a drifted vendor dir is refused rather ` +
        `than silently producing evidence attributed to the wrong version.`,
    };
  }
  return { ok: true, version: m[1] };
}

/** code2prompt prints `code2prompt <semver>` (measured at 4.2.0). */
export function assertIsCode2Prompt(versionOutput: string): IdentityVerdict {
  const text = versionOutput.trim();
  const m = /^code2prompt\s+(\d+\.\d+\.\d+)/.exec(text);
  if (!m) {
    return {
      ok: false,
      reason:
        `the resolved binary does not identify as code2prompt (it printed ` +
        `${JSON.stringify(text.slice(0, 80))}). The npm package of the same name is an ` +
        `unrelated NodeJS library that ships no executable — see D-040.`,
    };
  }
  if (m[1] !== CODE2PROMPT_PINNED_VERSION) {
    return {
      ok: false,
      reason:
        `pinned code2prompt has DRIFTED: expected exactly ${CODE2PROMPT_PINNED_VERSION}, found ${m[1]}.`,
    };
  }
  return { ok: true, version: m[1] };
}

const ENGINE_SPEC: Readonly<
  Record<PackerEngine, { resolve: () => string | null; assert: (out: string) => IdentityVerdict; dir: string }>
> = Object.freeze({
  repomix: { resolve: resolveRepomixBin, assert: assertIsRepomix, dir: REPOMIX_VENDOR_DIR },
  code2prompt: { resolve: resolveCode2PromptBin, assert: assertIsCode2Prompt, dir: CODE2PROMPT_VENDOR_DIR },
});

/** Resolve AND verify identity. Every pack goes through this. */
export async function packerIdentity(
  engine: PackerEngine,
  exec: ExecFn = defaultExec,
): Promise<{ ok: true; identity: EngineIdentity } | { ok: false; reason: string }> {
  const spec = ENGINE_SPEC[engine];
  const bin = spec.resolve();
  if (!bin) {
    return {
      ok: false,
      reason:
        `pinned ${engine} is not provisioned. Expected it under ${spec.dir}. Provision it (P-016) ` +
        `rather than falling back to a PATH or npx lookup — an unpinned packer produces evidence ` +
        `no one can attribute to a version.`,
    };
  }
  try {
    const { stdout } = await exec(bin, ['--version'], { timeoutMs: 10_000 });
    const verdict = spec.assert(stdout);
    return verdict.ok ? { ok: true, identity: { engine, bin, version: verdict.version } } : verdict;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ───────────────────────── safety sets ─────────────────────────

/**
 * Never packed, by either engine, regardless of caller arguments.
 *
 * Appended AFTER caller ignores so no argument can shorten the set. This is the
 * only protection a code2prompt pack has (it ships no scanner at all), and it
 * is defence-in-depth for repomix on top of Secretlint.
 */
export const SECRET_DENY_GLOBS: readonly string[] = Object.freeze([
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.keystore',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/id_ecdsa*',
  '**/.npmrc',
  '**/.netrc',
  '**/.pgpass',
  '**/credentials',
  '**/credentials.*',
  '**/secrets.*',
  '**/service-account*.json',
  '**/*.jks',
]);

/**
 * Flags the repomix argv may NEVER contain, and why each one matters.
 *
 * Asserted against every produced argv, for every input — including a caller
 * trying to smuggle one through an include or ignore pattern.
 */
export const REPOMIX_FORBIDDEN_FLAGS: readonly string[] = Object.freeze([
  '--no-security-check', // disables Secretlint — the whole reason repomix is the default packer
  '--remote', // clones an arbitrary third-party repo: network fetch + unreviewed content
  '--remote-branch',
  '--remote-trust-config', // executes config from a remote repo
  '-o', // writes a file, bypassing the PreToolUse lock arbitration
  '--output',
  '--split-output', // same, several files
  '--copy', // exfiltrates the pack to the system clipboard
  '--no-gitignore', // packs ignored files, which is where secrets live
  '--no-dot-ignore',
]);

/**
 * Flags the code2prompt argv may NEVER contain.
 *
 * `-O`/`--output-file` is absent from this list ON PURPOSE: the builder always
 * emits `-O -` (stdout) and never accepts a caller path, so the flag is present
 * with a value that cannot write. The test asserts that exact pairing rather
 * than the flag's absence.
 */
export const CODE2PROMPT_FORBIDDEN_FLAGS: readonly string[] = Object.freeze([
  '-c', // clipboard exfiltration
  '--clipboard',
  '--no-ignore', // bypasses gitignore
  '--hidden', // packs dotfiles — .env among them
  '-t', // reads an arbitrary Handlebars template off disk
  '--template',
  '--tui', // interactive; would hang a spawned process forever
  '-L', // follows symlinks out of the workspace
  '--follow-symlinks',
  '--absolute-paths', // leaks host filesystem layout into the evidence
]);

/**
 * The reviewer framings a caller may ask for.
 *
 * A CLOSED enum mapping to text we own, deliberately not code2prompt's `-t`
 * (which takes a filesystem path and would be both an arbitrary-file-read and a
 * template-injection surface). "Validate diff/pack templates" in P-016 is
 * therefore satisfied by construction: an unknown name cannot resolve, and the
 * test asserts every enum member yields non-empty text.
 */
export const PACK_TEMPLATES = Object.freeze({
  none: '',
  'code-review':
    '# Code Review\n\nReview the following for correctness, clarity, and maintainability. ' +
    'Flag bugs, security issues, performance regressions, and unclear naming. Cite file:line references.\n\n',
  'security-audit':
    '# Security Audit\n\nAudit the following for security vulnerabilities. Focus on input validation, ' +
    'authentication/authorization, secrets handling, injection risks, and unsafe deserialization.\n\n',
  'refactor-prep':
    '# Refactor Preparation\n\nAnalyze the following and produce a refactor plan: identify duplication, ' +
    'suggest extractions, propose architectural improvements, and include an impact analysis.\n\n',
} as const);

export type PackTemplate = keyof typeof PACK_TEMPLATES;

export function templateHeader(name: PackTemplate | undefined): string {
  if (!name) return '';
  return PACK_TEMPLATES[name] ?? '';
}

// ───────────────────────── arguments ─────────────────────────

export type PackerOp = 'pack' | 'diff';
export type PackFormat = 'markdown' | 'xml';

export interface PackerArgs {
  /** Repo-relative globs. REQUIRED and non-empty — see buildRepomixArgs. */
  readonly include: readonly string[];
  readonly ignore?: readonly string[];
  readonly rootPath: string;
  readonly format?: PackFormat;
  readonly template?: PackTemplate;
  /** `diff` only: the ref to diff against. */
  readonly baseRef?: string;
  /** repomix only: collapse bodies to signatures. */
  readonly compress?: boolean;
}

/**
 * The pack's own byte ceiling.
 *
 * A pack never enters an agent's context inline — it is written to scratch and
 * referenced — so this bounds the ARTIFACT, not a result payload. The budget's
 * `resultTokensMax` governs what this module returns to the caller, which is
 * provenance plus a preview.
 */
export const MAX_PACK_BYTES = 64 * 1024 * 1024;

/** Characters of the pack echoed back inline, well under resultTokensMax. */
export const PACK_PREVIEW_CHARS = Math.max(200, DEFAULT_RESOURCE_BUDGET.resultTokensMax);

/**
 * Refuse any caller pattern that could be READ AS A FLAG.
 *
 * Found by the smuggling cases in this module's tests, and it is a real hole
 * rather than a theoretical one: emitting `['--include', '--no-security-check']`
 * puts an attacker-controlled, flag-shaped token into argv, and whether the
 * engine's parser binds it as the value of `--include` or re-reads it as its own
 * option is a property of that parser's version — commander and clap both have
 * had both behaviours. A pack whose secret scanning depends on an argv parsing
 * quirk is not a pack anyone should trust.
 *
 * Two independent defences, because either alone would be a single point of
 * failure: this validation, and the `--flag=value` emission below (which is
 * unambiguous to every parser even if a pattern slipped through). A legitimate
 * glob never begins with `-`, so nothing useful is refused.
 */
function assertNotFlagShaped(patterns: readonly string[], field: string): void {
  for (const p of patterns) {
    if (p.startsWith('-')) {
      throw new Error(
        `${field} pattern ${JSON.stringify(p)} begins with '-' and could be parsed as an engine ` +
          `flag. Refused: a glob never starts with '-', and allowing one would make secret ` +
          `scanning depend on how the engine's argv parser resolves the ambiguity.`,
      );
    }
  }
}

function assertNoForbidden(argv: readonly string[], forbidden: readonly string[], engine: string): void {
  // Compare against the token, and against the `--flag=value` form, so a
  // forbidden flag cannot be smuggled through an attached value.
  for (const token of argv) {
    const head = token.split('=', 1)[0];
    if (forbidden.includes(head)) {
      throw new Error(
        `${engine} argv contained the forbidden flag ${head}. This is a bug in the arg builder, ` +
          `not a caller error — the builder is meant to make this unreachable.`,
      );
    }
  }
}

/**
 * Build repomix's argv. PURE.
 *
 * `include` is REQUIRED and must be non-empty. That is P-016's "explicit
 * include sets": with no include, repomix packs the entire working tree, which
 * on this monorepo is a multi-gigabyte document that is both useless as
 * evidence and a denial-of-service against whatever reads it. Refusing is
 * better than defaulting, because a silently-whole-repo pack looks exactly like
 * a correctly-scoped one until someone reads it.
 */
export function buildRepomixArgs(args: PackerArgs): string[] {
  if (args.include.length === 0) {
    throw new Error(
      'repomix requires an explicit, non-empty include set (P-016). Packing the whole tree by ' +
        'default produces evidence nobody scoped.',
    );
  }
  assertNotFlagShaped(args.include, 'include');
  assertNotFlagShaped(args.ignore ?? [], 'ignore');
  const ignore = [...(args.ignore ?? []), ...SECRET_DENY_GLOBS];
  // `--flag=value` throughout: an attached value is unambiguous to the parser,
  // so no emitted token can be re-read as an option.
  const argv = [
    '--stdout',
    '--quiet',
    `--style=${args.format === 'markdown' ? 'markdown' : 'xml'}`,
    `--include=${args.include.join(',')}`,
    `--ignore=${ignore.join(',')}`,
  ];
  if (args.compress) argv.push('--compress');
  assertNoForbidden(argv, REPOMIX_FORBIDDEN_FLAGS, 'repomix');
  return argv;
}

/**
 * Build code2prompt's argv. PURE.
 *
 * Always `-O -` (stdout): there is no caller-supplied output path anywhere in
 * this builder, so the engine cannot write into the shared tree behind the lock
 * arbitration.
 */
export function buildCode2PromptArgs(args: PackerArgs): string[] {
  if (args.include.length === 0) {
    throw new Error('code2prompt requires an explicit, non-empty include set (P-016).');
  }
  assertNotFlagShaped(args.include, 'include');
  assertNotFlagShaped(args.ignore ?? [], 'ignore');
  if (args.baseRef !== undefined) assertNotFlagShaped([args.baseRef], 'baseRef');
  const exclude = [...(args.ignore ?? []), ...SECRET_DENY_GLOBS];
  // Long `--flag=value` forms only. A short `-e <value>` would reintroduce the
  // detached-value ambiguity this builder exists to close, and `--output-file=-`
  // pins stdout in a form no parser can rebind.
  const argv = [
    args.rootPath,
    '--output-file=-',
    '--quiet',
    `--output-format=${args.format === 'xml' ? 'xml' : 'markdown'}`,
    `--include=${args.include.join(',')}`,
    `--exclude=${exclude.join(',')}`,
  ];
  if (args.baseRef) {
    // `--diff` is the working-tree diff; a base ref asks for a branch range.
    // Detached form on purpose: `--git-diff-branch` takes TWO values, which the
    // `=` form cannot express. Safe here only because assertNotFlagShaped above
    // has already guaranteed baseRef cannot begin with '-'.
    argv.push('--git-diff-branch', args.baseRef, 'HEAD');
  } else {
    argv.push('--diff');
  }
  assertNoForbidden(argv, CODE2PROMPT_FORBIDDEN_FLAGS, 'code2prompt');
  return argv;
}

// ───────────────────────── selection parsing ─────────────────────────

/**
 * Recover the file list from a produced pack.
 *
 * Returns `null` — never `[]` — when the format is not one this understands or
 * no file markers were found. A caller must be able to tell "the pack selected
 * nothing" from "I could not read the pack", because only the first is a
 * finding; reporting the second as `0` is the packing-plane version of the
 * confident-empty failure the read legs guard against.
 */
export function parseSelectedFiles(body: string, format: PackFormat): readonly string[] | null {
  const out: string[] = [];
  if (format === 'xml') {
    const re = /<file\s+path="([^"]+)"/g;
    for (let m = re.exec(body); m !== null; m = re.exec(body)) out.push(m[1]);
  } else {
    const re = /^#{1,3}\s+File:\s+(.+?)\s*$/gm;
    for (let m = re.exec(body); m !== null; m = re.exec(body)) out.push(m[1]);
  }
  if (out.length === 0) return null;
  return Array.from(new Set(out));
}

// ───────────────────────── provenance ─────────────────────────

export type SecurityScan =
  /** repomix: Secretlint ran (we can never pass --no-security-check) AND the deny-set applied. */
  | 'secretlint+deny-set'
  /** code2prompt: NO scanner exists in this engine; the deny-set is the only protection. */
  | 'deny-set-only';

export interface PackProvenance {
  readonly engine: PackerEngine;
  readonly engineVersion: string;
  readonly rootPath: string;
  /** HEAD at pack time. Null when the root is not a git checkout. */
  readonly commit: string | null;
  /**
   * True when the working tree differs from `commit`. A dirty pack is NOT
   * reproducible from the commit alone, and a consumer citing it as "the code
   * at <sha>" would be wrong — so this is stated, never inferred.
   */
  readonly dirty: boolean | null;
  readonly baseRef: string | null;
  readonly baseCommit: string | null;
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly denyGlobs: readonly string[];
  readonly template: PackTemplate;
  /** Null when the selection could not be parsed. Never coerced to 0. */
  readonly fileCount: number | null;
  readonly bytes: number;
  readonly chars: number;
  readonly securityScan: SecurityScan;
  readonly capturedAt: string;
}

export interface PackArtifact {
  /** Scratch path holding the full pack. Null when nothing was written. */
  readonly path: string | null;
  readonly preview: string;
  readonly provenance: PackProvenance;
}

export interface PackerResult {
  readonly answer: CodeIntelAnswer;
  readonly artifact: PackArtifact | null;
}

// ───────────────────────── injected effects ─────────────────────────

export interface ExecOpts {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
}
export type ExecFn = (bin: string, argv: readonly string[], opts?: ExecOpts) => Promise<{ stdout: string }>;

const defaultExec: ExecFn = async (bin, argv, opts) => {
  const { stdout } = await runExecFile(bin, [...argv], {
    cwd: opts?.cwd,
    timeout: opts?.timeoutMs ?? 180_000,
    maxBuffer: opts?.maxBuffer ?? MAX_PACK_BYTES,
  });
  return { stdout };
};

export interface PackerEffects {
  readonly exec: ExecFn;
  readonly writeArtifact: (body: string, engine: PackerEngine, format: PackFormat) => Promise<string>;
  readonly now: () => Date;
}

const defaultWriteArtifact = async (body: string, engine: PackerEngine, format: PackFormat): Promise<string> => {
  const dir = join(homedir(), '.papercusp', 'scratch', 'packs');
  await mkdir(dir, { recursive: true });
  const sha = createShortHash(body);
  const path = join(dir, `${engine}-${sha}-${Date.now()}.${format === 'xml' ? 'xml' : 'md'}`);
  await writeFile(path, body, 'utf8');
  return path;
};

function createShortHash(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 12);
}

export const DEFAULT_PACKER_EFFECTS: PackerEffects = Object.freeze({
  exec: defaultExec,
  writeArtifact: defaultWriteArtifact,
  now: () => new Date(),
});

// ───────────────────────── answers ─────────────────────────

const INTENT: CodeIntelIntent = 'pack';

function refusal(engine: PackerEngine, query: string, error: string, startedAt: number): PackerResult {
  return {
    answer: {
      backend: engine,
      intent: INTENT,
      query,
      sites: [],
      truncation: { truncated: false, totalAvailable: null, continuation: null },
      // NOT 'healthy': a refusal must never satisfy isTrustworthyEmpty, or
      // "the packer is not provisioned" reads as "the selection was empty".
      freshness: { health: 'unknown', indexedAt: null, staleVsDisk: null, indexedCommit: null },
      latencyMs: Date.now() - startedAt,
      error,
    },
    artifact: null,
  };
}

/** Resolve git facts for the provenance stamp. Never throws — absence is reported as null. */
export async function readGitProvenance(
  rootPath: string,
  baseRef: string | undefined,
  exec: ExecFn,
): Promise<{ commit: string | null; dirty: boolean | null; baseCommit: string | null }> {
  const git = async (argv: string[]): Promise<string | null> => {
    try {
      const { stdout } = await exec('git', argv, { cwd: rootPath, timeoutMs: 15_000 });
      return stdout.trim();
    } catch {
      return null;
    }
  };
  const commit = await git(['rev-parse', 'HEAD']);
  const status = commit === null ? null : await git(['status', '--porcelain']);
  const baseCommit = baseRef ? await git(['rev-parse', baseRef]) : null;
  return { commit, dirty: status === null ? null : status.length > 0, baseCommit };
}

/**
 * Produce a pack, or a diff-shaped reviewer prompt.
 *
 * NEVER writes into the workspace: the artifact goes to a scratch path outside
 * the tree, and neither arg builder can emit an engine flag that writes.
 * Refusals are ANSWERS — a disabled flag, an unprovisioned binary, a drifted
 * pin, an empty include set and a genuinely-empty selection are five distinct
 * states, and each returns something that says which.
 */
export async function packerFacade(
  op: PackerOp,
  args: PackerArgs,
  effects: PackerEffects = DEFAULT_PACKER_EFFECTS,
): Promise<PackerResult> {
  const started = Date.now();
  const engine: PackerEngine = op === 'diff' ? 'code2prompt' : 'repomix';
  const format: PackFormat = args.format ?? (op === 'diff' ? 'markdown' : 'xml');
  const query = `${op}:${args.include.join(',')}${args.baseRef ? ` vs ${args.baseRef}` : ''}`;

  if (!(await getFlag(FLAGS.CODE_INTEL_PACKERS, 'system').catch(() => false))) {
    return refusal(engine, query, `packing is disabled (${FLAGS.CODE_INTEL_PACKERS} is off)`, started);
  }
  if (args.include.length === 0) {
    return refusal(
      engine,
      query,
      'an explicit, non-empty include set is required (P-016): an unscoped pack of this monorepo is ' +
        'evidence nobody chose, and it is indistinguishable from a correctly-scoped one until read.',
      started,
    );
  }

  const id = await packerIdentity(engine, effects.exec);
  if (!id.ok) return refusal(engine, query, id.reason, started);

  let argv: string[];
  try {
    argv = engine === 'repomix' ? buildRepomixArgs(args) : buildCode2PromptArgs(args);
  } catch (err) {
    return refusal(engine, query, err instanceof Error ? err.message : String(err), started);
  }

  let body: string;
  try {
    const { stdout } = await effects.exec(id.identity.bin, argv, {
      cwd: args.rootPath,
      timeoutMs: 180_000,
      maxBuffer: MAX_PACK_BYTES,
    });
    body = stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = e.stderr?.trim() || e.message || String(err);
    return refusal(engine, query, detail.slice(0, 500), started);
  }

  const template = args.template ?? 'none';
  const document = templateHeader(template) + body;
  const selected = parseSelectedFiles(body, format);
  const git = await readGitProvenance(args.rootPath, args.baseRef, effects.exec);

  const provenance: PackProvenance = {
    engine,
    engineVersion: id.identity.version,
    rootPath: args.rootPath,
    commit: git.commit,
    dirty: git.dirty,
    baseRef: args.baseRef ?? null,
    baseCommit: git.baseCommit,
    include: [...args.include],
    ignore: [...(args.ignore ?? [])],
    denyGlobs: SECRET_DENY_GLOBS,
    template,
    fileCount: selected === null ? null : selected.length,
    bytes: Buffer.byteLength(document, 'utf8'),
    chars: document.length,
    securityScan: engine === 'repomix' ? 'secretlint+deny-set' : 'deny-set-only',
    capturedAt: effects.now().toISOString(),
  };

  const path = await effects.writeArtifact(document, engine, format);
  const sites: SymbolSite[] = (selected ?? []).map((p) => ({
    path: p,
    line1: null,
    kind: 'file',
    detail: null,
  }));

  return {
    answer: {
      backend: engine,
      intent: INTENT,
      query,
      sites,
      truncation: {
        // A pack that hit the byte ceiling is CUT, and saying so is the whole
        // point — a truncated pack read as complete is evidence of absence that
        // is really evidence of a buffer limit.
        truncated: provenance.bytes >= MAX_PACK_BYTES,
        totalAvailable: provenance.fileCount,
        continuation: null,
      },
      freshness: {
        // A packer reads the working tree on every run; there is no index to be
        // stale against. `staleVsDisk` therefore reports whether the tree is
        // dirty relative to the commit stamped in the provenance.
        health: 'healthy',
        indexedAt: provenance.capturedAt,
        staleVsDisk: git.dirty,
        indexedCommit: git.commit,
      },
      latencyMs: Date.now() - started,
      error: null,
    },
    artifact: { path, preview: document.slice(0, PACK_PREVIEW_CHARS), provenance },
  };
}
