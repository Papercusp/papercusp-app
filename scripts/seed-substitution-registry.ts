/**
 * seed-substitution-registry.ts — the missing CLI for the substitution registry
 * seeder (plan `bash-to-tool-substitution-2026-07-26`, P-018).
 *
 *   npm run seed:substitutions          # upsert every audited pair
 *   npm run seed:substitutions:check    # report drift; exit 1 if stale
 *
 * ── WHY THIS FILE HAD TO BE WRITTEN ─────────────────────────────────────────
 * `seedSubstitutionRegistry()` shipped with P-018 and had EXACTLY ONE caller in
 * the entire tree: its own integration test. Nothing ran it against the live
 * database — not a routine, not the deploy, not an npm script — so the rows the
 * PreToolUse gate reads were written once, by hand, and then never again.
 *
 * They rotted on schedule. D-017 built `dev:listening_ports`; D-018 re-pointed
 * the listening-socket pair at it; D-019 widened the service probes to :3170 and
 * :46229. CLAUDE.md tracked all three within the same change, because
 * `gen:tool-routing:check` fails the build when it drifts. The database tracked
 * none of them, because nothing checked and nothing ran. One row went on telling
 * agents "there is no tool form for ss/lsof/netstat today; keep using them"
 * after the tool existed.
 *
 * So this script is the caller, and `--check` is the gate that makes its absence
 * loud next time. The generalisation is worth more than the fix: A SEED SCRIPT
 * WITH NO CALLER IS NOT DORMANT, IT IS STALE — and "the code exists and is
 * documented as active" is not evidence it ever runs. Query for the row.
 *
 * ── --check IS NOW GATING, AND WHY THE OLD ARGUMENT DID NOT SURVIVE (D-046) ─
 * This section used to read "WHY --check IS ADVISORY, NOT A BUILD GATE", on the
 * grounds that it needs Postgres and "a check that reds the fleet gate whenever
 * PG is down would be removed within a week, and a removed check catches
 * nothing". The principle is right. The mechanism it feared was already dead:
 * the catch-all below has always exited 0 on an unreachable database, so PG
 * being down could not red anything, and the argument was defending against a
 * failure the code did not have.
 *
 * What the code DID have is the opposite failure, and a worse one. Exiting 0
 * meant a run that compared NOTHING was indistinguishable from a run that
 * compared everything and found it clean — a vacuous green, in a check whose
 * entire job is to notice that something silently did not happen. That is the
 * exact defect `scripts/lib/not-checked.mjs` was extracted to kill, and its
 * header names the shape: prose that says "NOT CHECKED" over an exit status that
 * says "pass", where the human reads the first and every script reads the second.
 *
 * So the two are now separated. `--check` exits:
 *
 *   0                 compared the pairs against real rows; they agree
 *   1                 compared them; they DISAGREE — re-seed (drift is real)
 *   EXIT_NOT_CHECKED  could not reach the database; NOTHING was compared
 *
 * Only the middle one is a finding. EI-20822558150340173 wired this into
 * `REPO_WIDE_INVARIANT_GUARDS` with `notCheckedIsNonGating: true`, so a DB-less
 * leg is reported as "examined NOTHING" and does not gate — the original concern
 * is honoured, without buying it at the price of a check that lies when it is
 * blind. Run it after any edit to `lib/bash-substitution/pairs/**` (D-020).
 */
// The exit status for "this run VERIFIED NOTHING", IMPORTED rather than re-declared as a
// local `2`. That file's own header is about this exact failure: three guards inherited the
// NOT-CHECKED prose by copy and quietly dropped the exit status, so each printed the warning
// and exited 0. A copied constant is how that happens; an imported one cannot be half-ported.
import { EXIT_NOT_CHECKED } from './lib/not-checked.mjs';
import { loadPairFixtures } from '../packages/operator-core/lib/bash-substitution/corpus';
import { BASH_GATE_PAIRS } from '../packages/operator-core/lib/bash-substitution/pairs';
import { fetchSubstitutionRows } from '../packages/operator-core/lib/bash-substitution/registry';
import {
  diffRegistry,
  expectedRows,
  formatDrift,
} from '../packages/operator-core/lib/bash-substitution/registry-drift';
import { promoteEarnedRows, seedSubstitutionRegistry } from '../packages/operator-core/lib/bash-substitution/seed';

const WORKSPACE_ID = process.env.PAPERCUSP_WORKSPACE_ID ?? 'papercusp-workspace';
const CHECK = process.argv.includes('--check');
const PROMOTE = process.argv.includes('--promote');
const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
  // BASH_GATE_PAIRS, not ALL_PAIRS: this seeds the SHELL gate's registry, and a
  // SQL pair has no shell pattern for the PreToolUse matcher to test (P-007).
  const fixtures = loadPairFixtures(BASH_GATE_PAIRS);

  // `--promote` is P-020's staged promotion (observe → advise) as a repeatable
  // command rather than a hand-written UPDATE. Dry-run unless --apply, and the
  // eligibility rules (incl. "a filed false positive pauses promotion") live in
  // promoteEarnedRows, not here — see its header.
  if (PROMOTE) {
    const outcomes = await promoteEarnedRows({ workspaceId: WORKSPACE_ID, apply: APPLY });
    if (outcomes.length === 0) {
      process.stdout.write('  no rows are eligible for promotion\n');
      return;
    }
    for (const o of outcomes) {
      process.stdout.write(`  ${o.from} → ${o.to}  ${o.intentLabel} → ${o.toolName}\n`);
    }
    // Promotions and hold-demotions are counted separately: reporting a demotion
    // as "promoted N rows to advise" is precisely the kind of line that gets
    // skimmed and believed.
    const up = outcomes.filter((o) => o.to === 'advise').length;
    const down = outcomes.length - up;
    const parts = [up > 0 ? `promoted ${up} to advise` : '', down > 0 ? `demoted ${down} held row(s) to observe` : '']
      .filter(Boolean)
      .join(', ');
    process.stdout.write(
      APPLY
        ? `✓ ${parts} in ${WORKSPACE_ID}\n  live PreToolUse gates refresh within ~30s (registry cache TTL)\n`
        : `\n  DRY RUN — ${parts}; re-run with --apply to commit\n`,
    );
    return;
  }

  if (CHECK) {
    const drifts = diffRegistry(expectedRows(fixtures), await fetchSubstitutionRows(WORKSPACE_ID));
    process.stdout.write(formatDrift(drifts));
    if (drifts.length > 0) {
      process.stderr.write('\n  run `npm run seed:substitutions` to re-derive the rows from the pairs\n');
      process.exit(1);
    }
    return;
  }

  const outcomes = await seedSubstitutionRegistry({ workspaceId: WORKSPACE_ID, fixtures });
  const inserted = outcomes.filter((o) => o.inserted).length;

  for (const o of outcomes) {
    process.stdout.write(
      `  ${o.inserted ? 'INSERT' : 'UPDATE'}  ${o.intentLabel} → ${o.toolName} ` +
        `(${o.verdict}, n=${o.sampleSize})\n`,
    );
  }
  process.stdout.write(
    `✓ seeded ${outcomes.length} substitution rows into ${WORKSPACE_ID} ` +
      `(${inserted} new, ${outcomes.length - inserted} updated)\n`,
  );
  // The operator caches registry rows for REGISTRY_CACHE_TTL_MS (30s) per
  // process. This script is a different process, so there is nothing local to
  // invalidate — the live gate picks the new rows up within one cache window.
  process.stdout.write('  live PreToolUse gates refresh within ~30s (registry cache TTL)\n');
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    // A verdict the harness cannot re-derive is a REAL failure and must be loud:
    // seeding past it would put a claim in the enforcement path that no sample
    // supports, which is the one thing D-001 forbids.
    if (/envelope and the evidence disagree/.test(msg)) {
      process.stderr.write(`✗ ${msg}\n`);
      process.exit(1);
    }
    // An unreachable database is not a code DEFECT, but it is not a PASS either:
    // nothing was compared, so nothing was proved. Exit EXIT_NOT_CHECKED so the
    // status carries that distinction instead of leaving it in prose the caller
    // never reads (see the header, and scripts/lib/not-checked.mjs).
    //
    // Deliberately the same verdict for `--check` and for a seed run: a seed that
    // could not reach the database wrote no rows, and reporting that as success
    // is the same lie one verb over.
    process.stdout.write(
      `⚠ NOT CHECKED — substitution registry ${CHECK ? 'check' : 'seed'} could not run: ${msg}\n` +
        '  This is NOT a clean bill: zero rows were compared, so the registry may be drifted.\n' +
        '  Re-run once Postgres is reachable.\n',
    );
    process.exit(EXIT_NOT_CHECKED);
  },
);
