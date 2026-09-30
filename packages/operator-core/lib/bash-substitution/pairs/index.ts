/**
 * The audited substitution pairs (plan `bash-to-tool-substitution-2026-07-26`).
 *
 * This is the single list the equivalence test walks and, per D-002, the list
 * that seeds `harness_shared.bash_tool_substitutions` (P-018) — so a pair that
 * is not exported here is neither tested nor enforced, and a pair added here is
 * automatically both.
 */

import { isBashPair } from '../types';
import type { BashSubstitutionPair, SubstitutionPair } from '../types';
import { AMBIENT_CONTEXT_PAIRS } from './ambient-context';
import { CODE_SEARCH_PAIRS } from './code-search';
import { DEPENDENCY_INSTALL_PAIRS } from './dependency-install';
import { FILE_READ_PAIRS } from './file-read';
import { GIT_READ_PAIRS } from './git-read';
import { LOGS_PAIRS } from './logs';
import { POSTGRES_PAIRS } from './postgres';
import { PROCESS_PAIRS } from './process';
import { SERVICE_PAIRS } from './service';
import { SQL_READ_NO_PAIR_DECISIONS, SQL_READ_PAIRS } from './sql-reads';
import { TESTS_PAIRS } from './tests';
import { TYPECHECK_PAIRS } from './typecheck';

export {
  SQL_READ_PAIRS,
  SQL_READ_NO_PAIR_DECISIONS,
  AMBIENT_CONTEXT_PAIRS,
  CODE_SEARCH_PAIRS,
  DEPENDENCY_INSTALL_PAIRS,
  FILE_READ_PAIRS,
  GIT_READ_PAIRS,
  LOGS_PAIRS,
  POSTGRES_PAIRS,
  PROCESS_PAIRS,
  SERVICE_PAIRS,
  TESTS_PAIRS,
  TYPECHECK_PAIRS,
};

/**
 * Every audited pair, in registry order.
 *
 * NOTE this list is not "the pairs we enforce" — it is "the pairs we have
 * EVIDENCE about", positive or negative. `PROCESS_PAIRS` carries a
 * `not-a-substitute` verdict and exists so the conclusion is durable and
 * re-derived on every test run; the routing generator filters it out of
 * CLAUDE.md, and the DB's `tier_requires_equivalence` keeps it at `observe`.
 * `TESTS_PAIRS` carries both kinds at once — two equivalent shapes plus
 * `tests.affected`, recorded negative for the same reason.
 */
export const ALL_PAIRS: SubstitutionPair[] = [
  ...FILE_READ_PAIRS,
  ...POSTGRES_PAIRS,
  ...PROCESS_PAIRS,
  ...SERVICE_PAIRS,
  ...GIT_READ_PAIRS,
  ...TESTS_PAIRS,
  ...LOGS_PAIRS,
  ...TYPECHECK_PAIRS,
  // P-026/P-027. The only pairs whose replacement is NOT a tool call: the answer
  // already rides on coord:orient's `host` block, so the advisory says "read what
  // you already have" rather than naming a verb to call.
  ...AMBIENT_CONTEXT_PAIRS,
  // WI-6445/WI-6457. The narrow definition-lookup pair is backed by the local
  // GitNexus graph. Its temporary hold was retired only after the durable hourly
  // re-index routine produced repeated successful analyze runs and graph canaries.
  ...CODE_SEARCH_PAIRS,
  // P-028. Blocks rather than teaches, on the PREFIX route: its intent IS the
  // violation (a bare install corrupts other agents' trees), so there is nothing
  // to substitute and no equivalence to prove — see its header for the D-003
  // authorization. Contrast the file-read family above, which blocks on the
  // CITATION route (D-044): an ordinary intent, mandated through the tool by an
  // owner rule, and admitted only because its verdict is `equivalent`.
  ...DEPENDENCY_INSTALL_PAIRS,
  // P-009. The first pairs drawn from the SQL corpus rather than the shell one —
  // same registry, same equivalence harness, same CLAUDE.md projection; only the
  // evidence and the matcher differ (P-007 / D-004). They are LAST because
  // registry order is the rendering order, and the shell rows are the ones an
  // agent meets most often.
  ...SQL_READ_PAIRS,
];

/**
 * The pairs the SHELL GATE enforces — everything in {@link ALL_PAIRS} drawn from
 * the bash corpus (plan `sql-escape-tool-routing-2026-08-12`, P-007).
 *
 * WHY THIS SPLIT EXISTS. `harness_shared.bash_tool_substitutions` is not a
 * generic registry that happens to be named after bash: it is read by the two
 * PreToolUse hooks, whose input is a raw SHELL COMMAND, and matched by
 * `matchCommandToSubstitutions`, which atomizes that command and tests each
 * pattern against the pieces. A SQL pair has no shell pattern to test — its
 * matcher is a relation resolved out of a query — so seeding one would put a row
 * in front of a matcher that cannot evaluate it. Not a crash; something worse: a
 * row that is silently never enforced while looking, in the table, exactly like
 * one that is.
 *
 * So the corpora part company HERE, at the one place a pair reaches the gate.
 * They stay together everywhere the machinery is genuinely shared — the
 * equivalence harness, the fixtures, the report, and the CLAUDE.md routing table,
 * which deliberately renders BOTH (an agent reading "use this verb instead"
 * should not have to know which corpus taught us that).
 */
export const BASH_GATE_PAIRS: BashSubstitutionPair[] = ALL_PAIRS.filter(isBashPair);
