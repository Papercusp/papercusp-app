/**
 * doc-projection.ts — shared plumbing for the `gen-doc-*` Starlight projection
 * generators (starlight-projection-generators-2026-06-05, Brief 29).
 *
 * Each `gen-doc-<x>.ts` script reads a code/registry/PG source, builds a Markdown
 * page string, and calls `emitOrCheck()`. That single helper handles:
 *   - write mode (default): write the page to apps/operator-docs/src/content/docs/reference/<x>.md
 *   - `--check` mode: compare the freshly-projected page to the committed file and
 *     report drift. Gating projectors exit non-zero on drift; advisory ones (heavy
 *     import / PG-dependent / high-churn) only warn (see D-002).
 *
 * Pages are emitted as **.md, not .mdx** on purpose: projected content (tool names
 * like `coord:inbox`, blueprint specs with `<`/`{`) would trip MDX's JSX parser.
 * CommonMark `.md` renders them as text. Starlight's docsLoader accepts both.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { homedir, hostname, userInfo } from 'node:os';
// The ONE generic-account list, pinned equal to the release gate's (WI-10004233).
import { GENERIC_ACCOUNTS, isGenericHost } from './identity-leak-patterns.mjs';
import { loadOwnerIdentityEnv } from '../../apps/operator/lib/release/owner-identity-env';

/** Repo root: scripts/lib/doc-projection.ts → ../../ */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where every projected reference page lands. */
export const REFERENCE_DIR = join(
  REPO_ROOT,
  'apps',
  'operator-docs',
  'src',
  'content',
  'docs',
  'reference',
);

const CHECK = process.argv.includes('--check');

/**
 * A table-cell-safe rendering of free text: collapse whitespace (a cell can't
 * span lines) and escape the pipe + backslash that would break the column.
 */
export function cell(text: string | null | undefined): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .trim();
}

/** The standard "this file is generated" banner, identical in spirit to BORROWABLE.md. */
export function generatedBanner(scriptName: string): string {
  return [
    `> **Generated — do not edit by hand.** Run \`npm run gen:doc-projections\` (or \`npm run ${scriptName}\`).`,
    `> Source: \`scripts/${scriptName.replace(/^gen:doc-/, 'gen-doc-')}.ts\`. Part of \`starlight-projection-generators-2026-06-05\` (Brief 29).`,
  ].join('\n');
}

/** A Starlight frontmatter block (title + description + sidebar order). */
export function frontmatter(opts: {
  title: string;
  description: string;
  sidebarOrder?: number;
  /**
   * EI-10937: pass `false` for a generated AGGREGATOR page (an index/catalog that
   * concatenates every other page's title+description). Such a page contains the
   * vocabulary of the whole corpus, so it lexically matches EVERY query and buries
   * the one doc that actually answers it — `reference/agent-insights-index` (304KB)
   * and `reference/plans-index` (276KB) did exactly that, at 30× the 10.1KB corpus
   * mean. `searchable: false` keeps them off docs:search while leaving them fully
   * reachable via the sidebar, docs:get, and the outline. They are navigation, not
   * answers.
   */
  searchable?: boolean;
}): string {
  const lines = ['---', `title: ${yamlScalar(opts.title)}`, `description: ${yamlScalar(opts.description)}`];
  if (opts.searchable === false) {
    lines.push('searchable: false');
  }
  if (opts.sidebarOrder !== undefined) {
    lines.push('sidebar:', `  order: ${opts.sidebarOrder}`);
  }
  lines.push('---');
  return lines.join('\n');
}

/** Quote a YAML scalar safely for frontmatter (handles `:`, `#`, quotes). */
function yamlScalar(s: string): string {
  const v = s.replace(/\s+/g, ' ').trim();
  // Always double-quote and escape embedded quotes/backslashes — simplest safe form.
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Build-box identity, resolved exactly as `audit-release-bundle.py:identity_literals()`
 * does — same sources, same exclusions. The two MUST agree: this scrubs what that
 * audit greps for, and a scrubber that cleans a DIFFERENT set than the auditor checks
 * is a false-green waiting to happen.
 */
type IdentityLit = { key: string; value: string; placeholder: string; caseInsensitive?: boolean };
function identityLiterals(): IdentityLit[] {
  const out: IdentityLit[] = [];
  const push = (
    key: string,
    value: string | undefined,
    placeholder: string,
    skip: string[] = [],
    caseInsensitive = false,
  ) => {
    const v = (value ?? '').trim();
    if (v && !skip.includes(v)) out.push({ key, value: v, placeholder, caseInsensitive });
  };
  try {
    push('build-user-name', userInfo().username, '<build-user>', [...GENERIC_ACCOUNTS]);
  } catch {
    /* no passwd entry — nothing to scrub */
  }
  push('build-home-path', homedir(), '$HOME', ['/root', '/', '/home']);
  const host = hostname();
  if (host && !isGenericHost(host)) push('build-hostname', host, '<build-host>');
  // The owner's ASSERTED identity (release-identity.env, loaded exactly as the release cut
  // loads it; an exported variable wins over the file). Explicit values REPLACE the git
  // guess for their class, as `audit-release-bundle.py:identity_literals()` does. Without
  // this the scrub only knew `git config user.name`, which on this box is the git-sync
  // bot (EI-20583328178472869), so the owner's name reached the generated plans and
  // insights indexes while the auditor kept hunting for it (WI-10004366).
  const ownerEnv: NodeJS.ProcessEnv = { ...process.env };
  loadOwnerIdentityEnv({ env: ownerEnv });
  const explicit = {
    'build-git-name': explicitOwnerValues(ownerEnv.PAPERCUSP_RELEASE_OWNER_NAME),
    'build-git-email': explicitOwnerValues(ownerEnv.PAPERCUSP_RELEASE_OWNER_EMAIL),
  };
  for (const [key, cfg, placeholder] of [
    ['build-git-email', 'user.email', '<owner-email>'],
    ['build-git-name', 'user.name', 'the owner'],
  ] as const) {
    if (explicit[key].length > 0) {
      // Case-INSENSITIVE, like the release gate (EI-20589264759185712): a plan slug carries
      // the name lower-cased. literalPattern() still keeps a SHORT name case-sensitive.
      explicit[key].forEach((v, i) => push(i === 0 ? key : `${key}-${i + 1}`, v, placeholder, [], true));
      continue;
    }
    try {
      push(key, execFileSync('git', ['config', '--get', cfg], { encoding: 'utf8', timeout: 5000 }), placeholder);
    } catch {
      /* not configured */
    }
  }
  return out;
}

/** Mirrors `audit-release-bundle.py:explicit_owner_values` — ONE rule: split on comma or
 *  semicolon only (never whitespace: "Jane Doe" is one name), trim, de-dup in order. */
export function explicitOwnerValues(raw: string | undefined): string[] {
  return [...new Set((raw ?? '').split(/[,;]/).map((v) => v.trim()).filter(Boolean))];
}

/** Mirrors `audit-release-bundle.py:needs_word_boundary` — a short git user.name
 *  must match as a whole word or it rewrites half the corpus (e.g. a name that is
 *  also a common substring would hit "<name>.avi", "<name>cenna"). */
function literalPattern(lit: string, caseInsensitive = false): RegExp {
  const esc = lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const short = lit.length < 6 && /^[a-z0-9]+$/i.test(lit);
  // Case-SENSITIVE, like the audit: a word-boundary match hits "Jane Doe", not "video.jane".
  // A SHORT literal stays case-sensitive even when the caller asks otherwise: a 3-letter
  // first name folded to lower case hits file extensions and ordinary words.
  return new RegExp(short ? `\\b${esc}\\b` : esc, caseInsensitive && !short ? 'gi' : 'g');
}

/**
 * Strip build-box identity from a projected page.
 *
 * WHY THIS EXISTS (WI-4419 — it red the 0.0.9 cut, correctly): these generators
 * project PG plan/work-item content into SHIPPED docs, and agents are *required* by
 * the directive-provenance convention to stamp `[owner:<name> <date>]` on plans and
 * checkpoints. So the owner's real name and home path flow, by design, from a carry
 * surface into a doc that ships to beta testers. Scrubbing the generated .md by hand
 * is useless — the next `gen:doc-projections` puts it right back. The projection is
 * the only place that closes the class.
 *
 * The `[owner:` rewrite keeps the provenance TIER and DATE and drops only the NAME,
 * which is the fix `scripts/check-no-owner-name-tags.mjs` mandates:
 *     [owner:Jane 2026-07-13]  ->  [owner 2026-07-13]
 */
export function scrubBuildIdentity(content: string): string {
  // Named provenance tag first — the dominant case, and the one with a sanctioned
  // replacement that preserves meaning. `[owner:Jane …]` -> `[owner …]`.
  let out = content.replace(/\[owner:\s*[A-Za-z][A-Za-z0-9._'-]*/g, '[owner');
  // LONGEST literal first: the username is a SUBSTRING of the home path
  // (`<user>` ⊂ `/home/<user>`), so scrubbing it first would leave
  // `/home/<build-user>` instead of `$HOME` — the PII is gone either way, but the
  // more specific literal must win or the output is quietly wrong.
  for (const { value, placeholder, caseInsensitive } of identityLiterals().sort((a, b) => b.value.length - a.value.length)) {
    out = out.replace(literalPattern(value, caseInsensitive), placeholder);
  }
  return out;
}

export interface EmitResult {
  /** true when --check found the committed file already matches the projection. */
  upToDate: boolean;
}

/**
 * Write the page (default) or, under `--check`, compare against the committed file.
 *
 * @param fileName  bare file name under reference/ (e.g. 'blueprint-catalog.md')
 * @param content   the full page string (frontmatter + body); a trailing newline is enforced
 * @param opts.advisory  when true, a `--check` mismatch warns + returns instead of exiting 1
 *                       (heavy/churny projectors per D-002)
 */
export function emitOrCheck(
  fileName: string,
  content: string,
  opts: { advisory?: boolean } = {},
): EmitResult {
  // Scrub BEFORE both the --check compare and the write, so the projection and the
  // committed file are judged on the same (scrubbed) bytes — otherwise --check would
  // report permanent drift against a file it can never reproduce.
  const scrubbed = scrubBuildIdentity(content);
  const out = scrubbed.endsWith('\n') ? scrubbed : scrubbed + '\n';
  const target = join(REFERENCE_DIR, fileName);

  if (CHECK) {
    let current = '';
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      /* missing → stale */
    }
    if (current === out) {
      process.stdout.write(`✓ reference/${fileName} is up to date\n`);
      return { upToDate: true };
    }
    const msg = `reference/${fileName} is stale — run \`npm run gen:doc-projections\``;
    if (opts.advisory) {
      process.stdout.write(`⚠ ${msg} (advisory — not gating)\n`);
      return { upToDate: false };
    }
    process.stderr.write(`✗ ${msg}\n`);
    process.exit(1);
  }

  mkdirSync(REFERENCE_DIR, { recursive: true });
  writeFileSync(target, out);
  process.stdout.write(`✓ wrote reference/${fileName}\n`);
  return { upToDate: true };
}

/** True when the script was invoked with `--check`. */
export const isCheck = CHECK;
