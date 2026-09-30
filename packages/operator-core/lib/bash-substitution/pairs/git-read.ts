/**
 * Equivalence pair — the GIT-READ family (plan
 * `bash-to-tool-substitution-2026-07-26`, P-010).
 *
 * Population in the 7d corpus: 2,637 `git` atoms across 77 of 86 sessions, of
 * which 2,500 are READS (`log` 1,044 · `status` 434 · `diff` 272 · `show` 185 ·
 * `rev-parse` 151 · `branch` 133 · `merge-base` 103 · the long tail). Proposed
 * replacement: `capability:git` — 8 uses in the same window.
 *
 * ── The plan's premise does not survive contact with the tool ────────────────
 * P-010 asks us to "determine which git reads are genuinely tool-shaped
 * (is-my-edit-live → `dev:pipeline_position`) versus genuinely raw (ad-hoc `git
 * log -S`), and set the pattern boundary accordingly". That framing assumes
 * `capability:git` is a NARROW tool competing with raw git for a subset of the
 * family. It is not. Its entire argument surface is:
 *
 *   args: z.array(z.string()).min(1)   // git argv, verbatim
 *   cwd:  z.string().optional()        // absolute, or relative to the project dir
 *
 * and its handler spawns `git` with that argv directly — no shell. It is a
 * PASS-THROUGH. There is no "genuinely raw" git read it structurally cannot run;
 * `push` is the one refused subcommand and it is not a read.
 *
 * So the boundary is not between tool-shaped and raw reads. It is between
 * commands whose argv is LITERAL and commands whose argv is produced by the
 * SHELL — and that boundary is measurable:
 *
 *   2,401 of 2,500 reads (96.0%)  plain literal argv        → expressible
 *      99 of 2,500 reads ( 4.0%)  contain $(…) / $VAR / ``  → NOT expressible
 *     140 of 2,500 reads          use `git -C <dir>`        → expressible via `cwd`
 *
 * Verified live, not asserted: `capability:git { args:['log','--oneline','-3','--',
 * '<path>'] }` and `capability:git { args:['rev-parse','HEAD'], cwd:'…/papercup-release' }`
 * both returned correct output through the real tool (2026-07-26). The second
 * matters — 140 corpus atoms pass `-C` at a SIBLING worktree, and `cwd` reaches
 * it. (The `papercusp-capability-exec-sandbox` flag could confine that later; it
 * is default-OFF today, and scoring a hypothetical is not evidence.)
 *
 * ── Where argv is strictly BETTER than the shell form ────────────────────────
 * Not merely equal. The corpus contains commands the shell mangled:
 * `git grep -nEi "select .*from +(harness_shared` is a real atom — the `|` inside
 * the quoted regex ended the command as far as any line-splitting reader is
 * concerned. Passing argv removes the quoting layer that caused it. Likewise
 * `git for-each-ref 'refs/hive/*'` needs quotes ONLY to stop the shell globbing;
 * as argv the pattern is simply literal.
 *
 * ── Therefore: ONE pattern, not two ──────────────────────────────────────────
 * `dev:pipeline_position { path?, sha? }` IS a better ANSWER for one specific
 * question in this family — "is my edit live yet" — because it returns the
 * pipeline position rather than raw git output an agent must interpret. But it
 * must NOT become a second registry row: `matchCommandToSubstitutions` fires
 * EVERY matching row (one atom each), so two patterns both claiming `git log …`
 * would put two advisories on one command. The routing is expressed inside this
 * pair's advisory instead, which is what "set the pattern boundary accordingly"
 * amounts to once the tool turns out to be a pass-through.
 *
 * ── The tier caveat (why `equivalent` here is not a mandate) ─────────────────
 * This pair audits `equivalent`, and `maxTierFor` therefore PERMITS `advise`. It
 * should not automatically get it, and P-020 should treat this row differently
 * from the others. Every other equivalent pair offers a better ANSWER —
 * `capability:read` pages a file, `dev:pg_query` bounds a query. This one offers
 * the SAME answer, and its benefits are argv-safety plus being gated as `git`
 * rather than as arbitrary shell. That second benefit is role-dependent: it is
 * the whole point for a confined agent (see `agent-capability-confinement-2026-06-13`)
 * and close to a no-op for a superuser who already holds `capability:bash`. The
 * registry has no role dimension, so promoting this row to `advise` would fire
 * the largest single nudge in the whole registry (~2,500 calls/week, 77 of 86
 * sessions) at the smallest per-call benefit. `equivalent` records that the
 * substitution is FAITHFUL; it does not argue that it is worth making. Recorded
 * as plan D-011.
 */

import type { CoverageResult, BashSubstitutionPair } from '../types';

/**
 * Read-only git subcommands seen in the corpus, plus their close relatives.
 * Deliberately a closed list rather than "anything that is not a write": a new
 * git subcommand should have to be looked at before the registry claims it.
 */
export const READ_SUBCOMMANDS = [
  'status',
  'log',
  'diff',
  'show',
  'rev-parse',
  'merge-base',
  'branch',
  'ls-files',
  'blame',
  'describe',
  'cat-file',
  'shortlog',
  'for-each-ref',
  'rev-list',
  'ls-remote',
  'reflog',
  'check-ignore',
  'ls-tree',
  'remote',
  'config',
  'grep',
  'diff-tree',
  'name-rev',
  'symbolic-ref',
] as const;

/** Shell-produced argv: `$(…)`, `${…}`, `$VAR`, or a backtick substitution. */
const SHELL_SUBSTITUTION = /\$\(|\$\{|\$[A-Za-z_]|`/;

/** A repo-selecting global flag that maps onto `cwd`. */
const REPO_SELECTOR = /(?:^|\s)(?:-C\s+(\S+)|--git-dir[= ](\S+)|--work-tree[= ](\S+))/;

/**
 * Split a command atom into the argv the SHELL would have produced: split on
 * UNQUOTED whitespace, then remove one layer of quoting from each token.
 *
 * A naive `split(/\s+/)` is wrong here and wrong in a way that matters — it
 * turns `--format='%H %cI'` (one argv element) into two, and `-S "reclaimed dead
 * release-deploy"` into four. `cover()` would then have emitted an `expression`
 * that does NOT reproduce the command, which is exactly the self-deception
 * `types.ts` warns about: false evidence backing a true verdict is still false
 * evidence. Caught by reading the first derived sample rather than by a test,
 * which is why the per-atom expressions are printed when a pair is built.
 *
 * An UNTERMINATED quote is closed implicitly. That case is an `atomize`
 * artifact, not a real command: a `|` inside a quoted string (`git grep -nEi
 * "select .*from +(a|b)"`) makes the atomiser split mid-string, so the atom is a
 * fragment. Closing it keeps the expression a faithful rendering of the ATOM,
 * which is the unit this whole harness matches on.
 */
export function shellArgv(atom: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < atom.length; i += 1) {
    const ch = atom[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || current) out.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
  }
  if (started || current) out.push(current);
  return out;
}

/** The `git` subcommand, skipping global flags and their arguments. */
export function gitSubcommand(atom: string): string | null {
  const tokens = atom.trim().split(/\s+/).slice(1);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '-C' || token === '-c' || token === '--git-dir' || token === '--work-tree') {
      i += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    return token;
  }
  return null;
}

/**
 * P-010 — "read git state" → `capability:git`.
 *
 * ── Why the pattern excludes shell substitution ──────────────────────────────
 * `args` is a literal `string[]`; nothing expands it. `git -C "$DESK" rev-parse
 * HEAD` has no argv until the shell has resolved `$DESK`, so an agent given this
 * advisory would have to resolve it themselves before calling — which is a
 * different action, not a substitution. Per D-008 the fix for a mixed pattern is
 * to narrow it until the residue falls outside, and 4.0% of the family is that
 * residue.
 *
 * The `SHELL_SUBSTITUTION` branch in `cover()` is KEPT even though the pattern
 * should now exclude every atom that could reach it. It is a tripwire: if the
 * lookahead ever breaks, those atoms reach `cover()`, score NOT covered, the
 * verdict drops off `equivalent`, and the test fails loudly instead of quietly
 * advising a substitution that cannot be performed.
 */
export const gitReadPassthrough: BashSubstitutionPair = {
  id: 'git-read.passthrough',
  intentLabel: 'git-state-read',
  bashPattern: new RegExp(
    // `git`, then NO shell substitution anywhere in the atom, then any number of
    // repo-selecting global flags, then a read subcommand.
    String.raw`^git\s+(?![^\n]*(?:\$\(|\$\{|\$[A-Za-z_]|\x60))` +
      String.raw`(?:(?:-C|-c|--git-dir|--work-tree)[=\s]\s*\S+\s+)*` +
      `(?:${READ_SUBCOMMANDS.join('|')})\\b`,
  ),
  toolName: 'capability:git',
  advisoryText:
    'capability:git { args: [...], cwd? } runs the same git with argv and no shell — same answer, no quoting hazards, and gated as git rather than as arbitrary shell. Use cwd for `git -C <dir>`. For the specific question "is my edit live yet", dev:pipeline_position { path | sha } answers it directly instead of leaving you to read git output. Commands whose argv comes from the shell ($(…), $VAR) are NOT claimed — keep those in bash.',
  routing: {
    want: 'to read git state (status/log/diff/show/rev-parse/merge-base)',
    use: '`capability:git { args: ["log","--oneline","-5"], cwd? }` — argv, no shell, gated as git',
    insteadOf:
      '`git log --oneline -5` — bash is not WRONG here; the gain is argv-safety and git-scoped gating. Shell-substituted argv (`git -C "$D" …`) has no tool form. For "is my edit live", prefer `dev:pipeline_position { path }`',
  },
  expectedVerdict: 'equivalent',
  // D-011's tier caveat, now carried in the data instead of in the decision body
  // alone — which is what let a verdict-only promotion sweep this row into
  // `advise` by accident (D-042). `equivalent` records that the substitution is
  // faithful; it does not argue that it is worth making.
  holdAtObserve:
    'D-011: capability:git is an argv PASS-THROUGH, so this row offers the SAME answer rather than a ' +
    'better one — its benefits are argv-safety and being gated as `git` rather than as arbitrary shell. ' +
    'That second benefit is ROLE-DEPENDENT: the entire point for a confined agent, near-zero for a ' +
    'superuser already holding capability:bash. The registry has no role dimension, so promoting the ' +
    'largest pair in it (~2,500 calls/week, 77 of 86 sessions) would buy the smallest per-call benefit. ' +
    'Release when the registry gains a role dimension, or when someone makes the value argument explicitly.',
  cover(atom: string): CoverageResult {
    if (SHELL_SUBSTITUTION.test(atom)) {
      return {
        covered: false,
        reason: 'argv comes from the shell ($(…) / $VAR / backtick); capability:git takes a LITERAL string[] and expands nothing',
      };
    }
    const sub = gitSubcommand(atom);
    if (!sub) {
      return { covered: false, reason: 'no resolvable git subcommand' };
    }
    // A repo-selecting global flag becomes `cwd` — verified live against a
    // sibling worktree, which is where 140 corpus atoms point.
    const repo = REPO_SELECTOR.exec(atom);
    // A trailing stderr/stdout silencer is shell noise, not an argument — the
    // file-read family settled this already (`treats a stderr redirect as noise,
    // not as a write`). Strip it before tokenising.
    const denoised = atom.replace(/\s*(?:\d?>[>&]?\s*\S+)\s*$/, '');
    const tokens = shellArgv(denoised).slice(1);
    const argvTokens: string[] = [];
    let cwd: string | null = repo ? (repo[1] ?? repo[2] ?? repo[3] ?? null) : null;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === '-C' || token === '--git-dir' || token === '--work-tree') {
        cwd = tokens[i + 1] ?? cwd;
        i += 1;
        continue;
      }
      if (token === '-c') {
        i += 1;
        continue;
      }
      const inlineRepo = /^--(?:git-dir|work-tree)=(.+)$/.exec(token);
      if (inlineRepo) {
        cwd = inlineRepo[1];
        continue;
      }
      argvTokens.push(token);
    }
    if (argvTokens.length === 0) {
      return { covered: false, reason: 'no git arguments survive once global flags are removed' };
    }
    const argv = argvTokens.map((t) => JSON.stringify(t)).join(', ');
    return {
      covered: true,
      expression: `capability:git { args: [${argv}]${cwd ? `, cwd: ${JSON.stringify(cwd)}` : ''} }`,
    };
  },
};

/**
 * The WRITE side, recorded as data because it earns no pair — and because the
 * absence is the interesting part.
 *
 * 68 write atoms in seven days across a 77-session corpus, and `git push` does
 * not appear at all: `capability:git` refuses it, the fleet's Bash deny blocks
 * it, and CLAUDE.md says git-sync owns commit+push. Three independent guards on
 * the same rule, and the corpus shows zero attempts — the same shape P-009 found
 * for `systemctl restart` on the two units CLAUDE.md names. Where a rule is
 * written down AND mechanically enforced, the intent simply stops appearing.
 */
export const GIT_WRITE_FINDING = {
  writeAtoms: 68,
  pushAtoms: 0,
  note: 'git-sync owns commit+push; capability:git refuses push, the Bash gate denies it, CLAUDE.md documents it. Zero push attempts in 7d.',
} as const;

/** Every pair in the git-read family, in registry order. */
export const GIT_READ_PAIRS: BashSubstitutionPair[] = [gitReadPassthrough];
