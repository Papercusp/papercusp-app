/**
 * P-028 — dependency install, and the plan's FIRST `tier=deny` row.
 *
 * ── WHY THIS ONE BLOCKS WHEN EVERY OTHER ROW ONLY TEACHES ───────────────────
 * Every other pair in this registry is a COST argument: bash works, a tool is
 * cheaper. This one is a CORRECTNESS argument. `node_modules` is unsynchronized
 * global mutable state on a tree ~50 agents share, so one agent's bare
 * `npm install` rewrites `node_modules/.bin` out from under every other agent's
 * in-flight test run, and two OVERLAPPING installs can leave a package durably
 * half-written — a `dist/` with only `.d.ts` files, which does not self-heal
 * (EI-18662389554660036, EI-18666853411437489). The damage lands on OTHER
 * agents, minutes later, wearing a disguise ("cannot find module"), which is
 * exactly the class an advisory the author is free to ignore cannot fix.
 *
 * D-003 reserves `deny` for rules that ALREADY EXISTED INDEPENDENTLY — the gate
 * may enforce policy, never invent it. That precondition is met here and
 * nowhere else in this plan: CLAUDE.md has mandated `npm run install:safe` in
 * prose since the incident. So this row does not create a rule; it gives an
 * existing one a mechanism. That authorization is carried in the DATA rather
 * than in a commit message — the `policy-violation:` intent prefix is the
 * escape hatch migration 665's `tier_requires_equivalence` already reserves for
 * exactly this, and it is what tells a future reader the deny was authorized by
 * a pre-existing rule rather than unlocked by an equivalence score.
 *
 * ── WHY THE PATTERN IS NARROWER THAN THE PROBLEM ────────────────────────────
 * A deny is a HARD BLOCK, so its false-positive budget is ~0: a wrongly-blocked
 * agent's only remaining moves are to route around the guard (which the
 * playbook forbids) or to stall. Two measured classes of false positive are
 * therefore excluded STRUCTURALLY, in the pattern, per D-008 — never left to
 * `cover()` to apologise for after the fact:
 *
 *  1. ATOMIZER ARTIFACTS (D-038). 24 of the 60 install-shaped atoms in the 7d
 *     corpus are not installs at all — they are the right-hand FRAGMENT of a
 *     `grep -E "npm install|npm ci" <file>` split on the `|` INSIDE the quoted
 *     pattern. Denying those would block agents from GREPPING for a running
 *     install, which is the exact mid-install diagnostic this repo's own
 *     guidance prescribes when a test dies with `vitest: not found`. Blocking
 *     the diagnostic for the incident is worse than the incident.
 *  2. A DIFFERENT TREE. `--prefix` is npm's explicit target selector. The
 *     wrapper intentionally does not reinterpret it, so prefixed scratch-tree
 *     installs remain exempt.
 *
 * Both fall out of ONE readable rule instead of a thicket of lookaheads: the
 * pattern matches flags, ordinary package operands, redirects and a trailing
 * `&`, while still rejecting quotes/backslashes from atomizer fragments. Named
 * packages are now included because EI-20412068513394843 proved the old
 * assumption false: `npm install --no-save … verdict-cli` ran in the shared
 * SideStage root and rewrote the same live `node_modules`. Managed trees now
 * expose the same root-targetable `install:safe`; callers that truly mean a
 * scratch tree can state that target with `--prefix`, which remains exempt.
 */
import type { CoverageResult, BashSubstitutionPair } from '../types';

/**
 * The verb, then flags / conservative unquoted operands / redirects / a
 * trailing `&`, to end of atom.
 *
 * Anchored at BOTH ends on purpose. `$` is what drops the quote fragments and
 * the `\`-continuation fragments the atomizer produces from a grep, and the
 * conservative operand alphabet is what admits normal npm package specs while
 * still dropping the quote/backslash fragments produced by grep atomization.
 */
const WHOLE_TREE_REIFY =
  /^npm\s+(?:install|ci|i)(?!.*(?:--dry-run|--prefix)\b)(?:\s+(?:--?[A-Za-z][\w-]*(?:=\S+)?|@?[A-Za-z0-9][A-Za-z0-9._~*/:@+^=-]*|[0-9]?>>?\s*\S+|[0-9]?>&[0-9]|&))*\s*$/;

/**
 * Shapes that make no change to `node_modules`, so the mutex they bypass is
 * guarding nothing. `--dry-run` is npm's own documented no-op; `--prefix`
 * retargets the install at a caller-selected scratch tree and stays explicit.
 *
 * Excluded by {@link WHOLE_TREE_REIFY} itself, so `cover()` never sees one in
 * practice. The check stays anyway: a `cover()` that would score a command it
 * cannot actually express is the failure D-001 exists to prevent, and stating
 * the limit twice is cheaper than discovering later that the pattern drifted
 * and the envelope silently started lying.
 */
const NON_MUTATING = /--dry-run\b|--prefix\b/;

export const unsafeDependencyInstall: BashSubstitutionPair = {
  id: 'deps.unsafe-install',
  // The `policy-violation:` prefix is load-bearing, not decorative — see the
  // header. It is the DB-level marker that this row's tier was authorized by a
  // pre-existing rule (D-003) rather than unlocked by an equivalence score.
  intentLabel: 'policy-violation:unsafe-dependency-install',
  bashPattern: WHOLE_TREE_REIFY,
  toolName: 'npm run install:safe',
  advisoryText:
    'A bare `npm install`/`npm ci` on this SHARED tree rewrites node_modules under every other agent mid-run, and two overlapping installs can leave a package durably half-written. Run `npm run install:safe` instead — same npm, same flags and package operands (`npm run install:safe -- install --no-save pkg`), serialized behind a repo-root fs-mutex and dependency-verified before the lock drops. Installing into a DIFFERENT scratch tree remains allowed when you state it with `--prefix`.',
  routing: {
    want: 'to install dependencies in this shared tree',
    use: '`npm run install:safe` (or `npm run install:safe -- ci` / `-- install --legacy-peer-deps`) — serializes concurrent agents behind an fs-mutex, then verifies every declared dep actually landed on disk',
    insteadOf:
      'a bare `npm install` / `npm ci` — including a named-package add — because it rewrites `node_modules/.bin` under every other agent\'s in-flight test run. ⚠ NOT claimed: explicit `--prefix` scratch installs or `--dry-run`',
  },
  // `unaudited` since P-002 (2026-08-02), and this is a DOWNGRADE ON PURPOSE, not
  // a regression. Correcting the atomizer (D-047) shrank this pattern's population
  // from 28 atoms to 18 across 8 sessions — below the census floor of >= 20 atoms —
  // because ten of the twenty-eight were never commands an agent ran: they were
  // `npm install` lines sitting inside heredoc bodies and quoted scripts, which the
  // old newline-splitting atomizer promoted into atoms of their own.
  //
  // So no verdict can honestly be derived here any more, and `auditPair` rightly
  // refuses to record one. That changes NOTHING about enforcement: this row's
  // `deny` is authorized by D-003 as a rule that already existed independently of
  // this plan, never by the verdict, and `renderRoutingBlock` keeps documenting it
  // for exactly that reason. The honest reading is "the guard is right, the corpus
  // is simply too thin to re-derive it" — which is also why widening the pattern to
  // manufacture a passing population would be the wrong repair.
  expectedVerdict: 'unaudited',
  // The plan's only row that enters above `observe`. Authorized by D-003, NOT
  // by the green verdict above — see the header. `assertPolicyTier` enforces
  // that the `policy-violation:` intent prefix is present before this is honoured.
  policyTier: 'deny',
  cover(atom: string): CoverageResult {
    if (NON_MUTATING.test(atom)) {
      return {
        covered: false,
        reason:
          'makes no change to node_modules (--dry-run) or explicitly targets another tree (--prefix)',
      };
    }
    // `install:safe` is a pass-through: `main()` forwards argv to npm verbatim
    // and defaults to `install`, so every flag shape here is expressible. `ci`
    // and `i` reach it as an explicit subcommand after `--`.
    const sub = /^npm\s+(ci|i)\b/.exec(atom)?.[1];
    const rest = atom
      .replace(/^npm\s+(?:install|ci|i)/, '')
      .replace(/\s*[0-9]?>>?\s*\S+|\s*[0-9]?>&[0-9]|\s*&\s*$/g, '')
      .trim();
    const args = [sub === 'ci' ? 'ci' : rest ? 'install' : '', rest].filter(Boolean).join(' ');
    return {
      covered: true,
      expression: args ? `npm run install:safe -- ${args}` : 'npm run install:safe',
    };
  },
};

export const DEPENDENCY_INSTALL_PAIRS: BashSubstitutionPair[] = [unsafeDependencyInstall];
