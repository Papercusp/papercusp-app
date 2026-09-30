#!/usr/bin/env node
/**
 * check-documented-test-run-cwd.mjs — fail-loud guard against documented test
 * commands that only work from an UNSTATED working directory (EI-21463787319820028).
 *
 * Test-file headers document how to run the file (`Run: npx vitest run …`). A
 * command whose `--config` / file paths resolve ONLY from a package directory
 * (e.g. packages/operator-core) fails at the repo root with a missing-config
 * error BEFORE any test runs — and the natural fallback retry under the default
 * root config then collects half the tree and times out. Both failure modes
 * look like "this test is broken" instead of "I ran it from the wrong place".
 *
 * THE CONTRACT this guard enforces on every documented `Run:` command:
 *   - EITHER the command states its working directory explicitly (`cd <dir> …`,
 *     or a "(from <dir>)" tail) and every extension-bearing path exists
 *     relative to that directory,
 *   - OR the command is repository-root-executable as written (the canonical
 *     `npm run test:file -- packages/…` form).
 *
 *   node scripts/check-documented-test-run-cwd.mjs
 *
 * Scope: tracked *.ts/*.mts source; only comment lines shaped `* Run:` (plus
 * their `\`-continuation lines inside the same comment block) are commands —
 * prose mentioning vitest is ignored. Extensionless positional args are vitest
 * NAME FILTERS, not paths, and are not existence-checked. The predicate is
 * exported + unit-tested
 * (packages/operator-core/lib/documented-test-run-cwd-guard.test.ts) so the
 * "fails on an unstated-cwd command" property is durably verified, not only
 * green-on-clean-tree.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { listTrackedFiles } from './lib/tracked-files.mjs';
import { stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

/** Comment-line command opener: `* Run: <command>`. */
const RUN_LINE = /^\s*\*\s*Run:\s*(\S.*\S|\S)\s*$/;

/**
 * Extract documented `Run:` commands (with their `\` continuations) from a
 * file's text. Returns [{ line, command }].
 * @param {string} text
 * @param {string} [fileName] source path — enables string-literal masking
 * @returns {{ line: number, command: string }[]}
 */
export function extractDocumentedRunCommands(text, fileName) {
  const out = [];
  const lines = text.split('\n');
  // EI-20045405992394901: RUN_LINE is a raw text match, so a `* Run: npx vitest …`
  // sitting inside a STRING or template literal — prose ABOUT this rule, or a test
  // fixture quoting it — parsed as a real documented command and minted a phantom
  // offender against a path that was never meant to exist.
  //
  // stripCommentsOnly BLANKS comments and leaves strings standing, which is exactly
  // the discriminator needed here: this guard's subject IS comment text, so a match
  // that SURVIVES the mask was never a comment (it is code or a string) and must be
  // skipped. Masking is opt-in via fileName so the pure unit tests, which pass bare
  // text with no path to parse, keep exercising the extractor directly.
  const maskedLines = fileName ? stripCommentsOnly(text, fileName).split('\n') : null;
  for (let i = 0; i < lines.length; i++) {
    const m = RUN_LINE.exec(lines[i]);
    if (!m) continue;
    if (maskedLines && (maskedLines[i] ?? '').trim() !== '') continue;
    const first = m[1];
    // Only vitest/test-file invocations — other `Run:` prose is not this guard's concern.
    if (!/\b(vitest|npm run test)\b/.test(first)) continue;
    let command = first;
    const startLine = i + 1;
    // `\`-terminated fragments continue on following comment lines.
    while (/\\\s*$/.test(command) && i + 1 < lines.length && /^\s*\*/.test(lines[i + 1])) {
      i += 1;
      command = command.replace(/\\\s*$/, '') + ' ' + lines[i].replace(/^\s*\*\s?/, '').trim();
    }
    out.push({ line: startLine, command });
  }
  return out;
}

/**
 * Validate ONE documented command against the tree. Returns an error string,
 * or null when the command is executable as documented.
 * @param {string} rawCommand
 * @param {(p: string) => boolean} exists path-exists probe (injectable for tests)
 */
export function judgeDocumentedRunCommand(rawCommand, exists = (p) => existsSync(join(ROOT, p))) {
  let command = String(rawCommand).trim();
  // A whole-command backtick quote (`…`) — grade the contents, drop the quotes.
  if (command.startsWith('`')) {
    const end = command.indexOf('`', 1);
    command = (end === -1 ? command.slice(1) : command.slice(1, end)).trim();
  }
  // A parenthesized "(from <dir>)" tail also states the working directory.
  let declaredCwd = null;
  const fromMatch = /\(\s*from\s+([^\s)]+)\s*\)/.exec(command);
  if (fromMatch) {
    declaredCwd = fromMatch[1].replace(/\.?$/, '');
    command = command.replace(fromMatch[0], ' ').trim();
  }
  // Form 1 — explicit cwd: `cd <dir> [&&|;] …` (also tolerates a trailing `\` join).
  const cdMatch = /^cd\s+(\S+)\s*(?:&&|;)\s*(.*)$/.exec(command);
  let cwd = declaredCwd ?? '.';
  let body = command;
  if (cdMatch) {
    const dir = cdMatch[1].replace(/\\$/, '');
    if (!exists(dir)) return `stated working directory '${dir}' does not exist`;
    cwd = dir;
    body = cdMatch[2].trim();
  }
  // Collect every filesystem reference: --config/-c values and extension-bearing args.
  const refs = [];
  const cfg = /(?:--config|-c)[= ](\S+)/.exec(body);
  if (cfg) refs.push(cfg[1]);
  for (const rawToken of body.split(/\s+/)) {
    const token = rawToken.replace(/\\$/g, '').replace(/[`,.;]+$/, '').trim();
    if (!token || /^(-|--)/.test(token)) continue; // flags
    if (/^(npx|node|npm|run|vitest|exec|test:file)$/.test(token)) continue;
    if (/^[A-Z_][A-Z0-9_]*=/.test(token)) continue; // env assignment prefix
    // Only extension-bearing refs are provable filesystem paths; bare words are
    // vitest name filters and resolve regardless of cwd.
    if (!/\.[A-Za-z]+$/.test(token)) continue;
    if (/^https?:/.test(token)) continue;
    refs.push(token);
  }
  for (const ref of refs) {
    const target = cwd === '.' ? ref : `${cwd.replace(/\/$/, '')}/${ref}`;
    if (!exists(target)) {
      return cwd === '.'
        ? `no working directory stated and '${ref}' does not exist at the repo root — state it (e.g. prefix "cd packages/<pkg> && ")`
        : `path '${ref}' does not exist under stated working directory '${cwd}'`;
    }
  }
  return null;
}

/** @returns {string[]} human-readable violations */
export function findViolations(files, read = (f) => readFileSync(f, 'utf8')) {
  const violations = [];
  for (const file of files) {
    let text = '';
    try {
      text = read(file);
    } catch {
      continue;
    }
    for (const { line, command } of extractDocumentedRunCommands(text, file)) {
      const err = judgeDocumentedRunCommand(command);
      if (err) violations.push(`${file}:${line} — ${err}\n    command: ${command}`);
    }
  }
  return violations;
}

// ── CLI entry ────────────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('check-documented-test-run-cwd.mjs')) {
  const { files: allFiles } = listTrackedFiles();
  const files = allFiles
    .filter((f) => /^(packages\/|apps\/|libs\/)/.test(f))
    .filter((f) => /\.(ts|mts)$/.test(f));
  const violations = findViolations(files);
  if (violations.length > 0) {
    console.error(
      `check-documented-test-run-cwd: ${violations.length} documented Run: command(s) are not executable as written:\n\n` +
        violations.join('\n\n') +
        '\n\nFix: state the working directory ("Run: cd packages/<pkg> && npx vitest …") or use the root-executable form ("Run: npm run test:file -- <root-relative-path>").',
    );
    process.exit(1);
  }
  console.log(
    `check-documented-test-run-cwd: ${files.length} files scanned, all documented Run: commands are executable as written.`,
  );
}
