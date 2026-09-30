/**
 * Labelled new-fact / neighbour pairs for validating the memory conflict judge
 * (plan jev-decision-model-integration-2026-09-29, P-009; bar in decision D-015).
 *
 * Each case is one memory:remember write: the new memory plus the neighbours a
 * top-K search would hand the judge. Every neighbour carries a gold label from the
 * judge's own vocabulary (jev-conflict-judge.ts):
 *
 *   contradicts  both cannot be true at the same time about the same subject
 *   duplicates   the same fact; the new memory adds nothing
 *   refines      same subject, compatible; the new memory adds detail or narrows it
 *   unrelated    different subjects, or the same broad topic with no bearing
 *
 * The `duplicates` and `refines` pairs are the hard negatives for the one decision
 * that matters: a false `contradicts` refuses a legitimate write. Many `unrelated`
 * neighbours share a topic with the new memory (ports, flags, owner, git-sync), as
 * real top-K neighbours do.
 *
 * Written in the style of this workspace's memories. Labelled by the implementer
 * (su-f7ad1084, 2026-09-30) BEFORE any judge saw the pairs; that authorship is a
 * stated limitation of the measurement, not a hidden one.
 *
 * Frozen: a change here changes what the D-015 numbers describe. Add a case only
 * alongside a re-run, and never relabel a pair after seeing a verdict on it.
 */
import type { JevConflictLabel } from '../jev-conflict-judge';

export interface ConflictSampleNeighbour {
  readonly id: string;
  readonly text: string;
  readonly gold: JevConflictLabel;
}

export interface ConflictSampleCase {
  readonly id: string;
  readonly newText: string;
  readonly neighbours: readonly ConflictSampleNeighbour[];
}

const c = (id: string, newText: string, neighbours: [string, JevConflictLabel][]): ConflictSampleCase => ({
  id,
  newText,
  neighbours: neighbours.map(([text, gold], i) => ({ id: `${id}.${i + 1}`, text, gold })),
});

export const CONFLICT_JUDGE_SAMPLE: readonly ConflictSampleCase[] = [
  c('k01', 'owner prefers terse status reports with no preamble.', [
    ['owner wants long, detailed status reports that walk through every step.', 'contradicts'],
    ['Keep status reports to owner short, with no preamble.', 'duplicates'],
    ['The deploy pipeline promotes staging to main after a green checkpoint.', 'unrelated'],
  ]),
  c('k02', 'owner prefers terse status reports, and wants anything waiting on him listed in its own block.', [
    ['owner prefers terse status reports.', 'refines'],
    ["owner's timezone is Eastern time.", 'unrelated'],
  ]),
  c('k03', 'New durable state goes in MySQL.', [
    ['New durable state goes in Postgres unless there is a specific reason it must be a file.', 'contradicts'],
    ['owner prefers to be addressed by name.', 'unrelated'],
  ]),
  c('k04', 'New durable state goes in Postgres, using the helpers in operator-state-pg.ts.', [
    ['New durable state goes in Postgres unless there is a specific reason it must be a file.', 'refines'],
    ['Schema changes go through migrations only; never create tables at runtime.', 'unrelated'],
  ]),
  c('k05', 'Schema changes are made only through migrations; no runtime DDL.', [
    ['Schema changes go through migrations only; never create tables at runtime.', 'duplicates'],
    ['Use nuqs for tab and filter state.', 'unrelated'],
  ]),
  c('k06', 'Migration numbers must be reserved with scripts/next-migration.mjs, which writes a .DRAFT file.', [
    ['Pick migration numbers through the atomic allocator, not by listing the directory.', 'refines'],
    ['Never kill processes by name with pkill.', 'unrelated'],
  ]),
  c('k07', 'Agents run git commit themselves before ending a turn.', [
    ['A background git-sync routine commits the shared tree; agents never run git commit.', 'contradicts'],
    ['The green checkpoint runs hourly.', 'unrelated'],
  ]),
  c('k08', 'Git-sync owns commit and push for the shared tree.', [
    ['A background git-sync routine commits and pushes the shared tree.', 'duplicates'],
    ['Main only fast-forwards to a staging commit that passed the green checkpoint; nobody pushes it directly.', 'unrelated'],
  ]),
  c('k09', 'Git-sync pushes to origin/staging every few minutes, superproject and submodules alike.', [
    ['A background git-sync routine commits and pushes the shared tree.', 'refines'],
    ['The green checkpoint runs hourly.', 'unrelated'],
  ]),
  c('k10', "Use pnpm to run a single package's tests.", [
    ['Never use pnpm or yarn in this repo; it is npm only.', 'contradicts'],
    ['owner prefers terse status reports.', 'unrelated'],
  ]),
  c('k11', 'New feature flags ship default OFF.', [
    ['New feature flags default to enabled; default-off needs a registered justification.', 'contradicts'],
    ['The single source of feature flags is libs/flags/src/types.ts.', 'unrelated'],
  ]),
  c('k12', 'Feature flags default ON, and each default-off exception must be listed in KNOWN_DARK_FLAGS.', [
    ['New feature flags default to enabled.', 'refines'],
    ['Feature flags are defined in libs/flags/src/types.ts.', 'unrelated'],
  ]),
  c('k13', 'Feature flags are defined in libs/flags/src/types.ts.', [
    ['The single source of feature flags is libs/flags/src/types.ts.', 'duplicates'],
    ['Use nuqs for tab and filter state.', 'unrelated'],
  ]),
  c('k14', 'The desktop app runs on Electron.', [
    ['The product is a Tauri desktop app.', 'contradicts'],
    ['Port 3070 serves the green operator built from main.', 'unrelated'],
  ]),
  c('k15', 'Client data is synced with React Query polling.', [
    ['All client data sync goes through @papercusp/sync over SSE; hand-rolled polling is not allowed.', 'contradicts'],
    ['User-meaningful state belongs in the URL via nuqs rather than useState.', 'unrelated'],
  ]),
  c('k16', 'Use nuqs for user-meaningful UI state instead of useState.', [
    ['User-meaningful state belongs in the URL via nuqs rather than useState.', 'duplicates'],
    ['All client data sync goes through @papercusp/sync over SSE.', 'unrelated'],
  ]),
  c('k17', 'Main is updated by pushing to it directly after review.', [
    ['Main only fast-forwards to a staging commit that passed the green checkpoint; nobody pushes it directly.', 'contradicts'],
    ['A red release gate has exactly one fixer.', 'unrelated'],
  ]),
  c('k18', 'The green checkpoint runs npm run test:affected in an isolated checkout before fast-forwarding main.', [
    ['Main only fast-forwards after the green checkpoint passes.', 'refines'],
    ['Git-sync pushes to origin/staging every few minutes.', 'unrelated'],
  ]),
  c('k19', 'owner wants to be asked before any file edit, even in AUTO mode.', [
    ['In AUTO mode, act on your own judgment and report after; do not ask before edits.', 'contradicts'],
    ["The owner's name is owner.", 'unrelated'],
  ]),
  c('k20', 'In AUTO mode, list every assumption you made in the status report.', [
    ['In AUTO mode, act on your own judgment and report after.', 'refines'],
    ['Tool results are capped at about 1,500 tokens.', 'unrelated'],
  ]),
  c('k21', 'The memory conflict check is off by default.', [
    ['The memory conflict check is on by default; PAPERCUSP_MEMORY_CONFLICT_CHECK=off disables it.', 'contradicts'],
    ['memory:search returns results ranked by hybrid score.', 'unrelated'],
  ]),
  c('k22', 'The staging operator serves the canonical working tree, so uncommitted edits show up there.', [
    ['The staging operator serves a separate checkout pinned to origin/staging; uncommitted edits are invisible there.', 'contradicts'],
    ['The green operator listens on port 3070.', 'unrelated'],
  ]),
  c('k23', 'The staging operator on :3170 restarts many times a day, so never bind a long-lived session to it.', [
    ['The staging operator listens on port 3170.', 'refines'],
    ['Every plan ships with a graded acceptance rubric.', 'unrelated'],
  ]),
  c('k24', 'The weekly memory precision report runs every Monday.', [
    ['The weekly memory precision report runs every Sunday night.', 'contradicts'],
    ['Scratch probes that import repo modules should be named .mts.', 'unrelated'],
  ]),
  c('k25', 'The weekly precision monitor records the Jev model version when it measures the gated path.', [
    ['A weekly monitor measures memory injection precision.', 'refines'],
    ['The inference gateway listens on port 8788.', 'unrelated'],
  ]),
  c('k26', 'The Jev key is read from the TYPESAFE_API_KEY environment variable.', [
    ['The Jev key is stored in the integration key store through Settings, not in an environment variable.', 'contradicts'],
    ['Jev is a decision model that returns probabilities instead of text.', 'unrelated'],
  ]),
  c('k27', 'Jev answers choice questions with a probability for every option plus a confidence margin.', [
    ['Jev is a decision model that returns probabilities instead of text.', 'refines'],
    ['The doc-contradiction judge uses claude-3-5-haiku-latest.', 'unrelated'],
  ]),
  c('k28', 'The Jev memory gate fails open on timeout.', [
    ['If Jev times out, memory injection falls back to the unfiltered set.', 'duplicates'],
    ['The Jev memory gate uses a 400 ms deadline on the push path.', 'refines'],
  ]),
  c('k29', 'Recurring work can use a bare setInterval.', [
    ['Recurring work must not use a bare setInterval; use a DBOS workflow or an ephemeral trigger.', 'contradicts'],
    ['Owner directives are captured verbatim by a hook.', 'unrelated'],
  ]),
  c('k30', "owner's timezone is Pacific time.", [
    ['owner works on Eastern time.', 'contradicts'],
    ['The owner is called owner.', 'unrelated'],
  ]),
  c('k31', 'Tool results are uncapped, so large outputs arrive in full.', [
    ['Every tool result is capped at about 1,500 tokens and the rest spills to a scratch file.', 'contradicts'],
    ['Plans are stored in Postgres; plan files are projections.', 'unrelated'],
  ]),
  c('k32', 'Never kill processes by name with pkill.', [
    ['Do not use pkill -f or other kill-by-pattern commands.', 'duplicates'],
    ['Kill a managed process with processes:kill, which kills its whole cgroup subtree.', 'refines'],
  ]),
  c('k33', "The owner's name is owner.", [
    ['The owner is called owner.', 'duplicates'],
    ['owner works on Eastern time.', 'unrelated'],
  ]),
  c('k34', 'Port 3070 serves the green operator built from main.', [
    ['The green operator on :3070 runs the main branch.', 'duplicates'],
    ['The staging operator listens on port 3170.', 'unrelated'],
  ]),
  c('k35', 'Do not open :3055 in a browser.', [
    ['Never point a browser at port 3055.', 'duplicates'],
    ['Git-sync owns commit and push for the shared tree.', 'unrelated'],
  ]),
  c('k36', 'Run the headless Tauri verifier with VERIFY_TAURI_ISOLATED_DB=1 before clicking anything that writes.', [
    ["Verify UI with scripts/verify-tauri-headless.sh, never on the owner's live desktop.", 'refines'],
    ['Memory injection uses a similarity floor of 0.58.', 'unrelated'],
  ]),
  c('k37', 'owner dislikes menu-style questions at the end of a turn.', [
    ['owner does not want turns to end with a list of options to pick from.', 'duplicates'],
    ["owner's timezone is Eastern time.", 'unrelated'],
  ]),
  c('k38', 'Every plan needs a graded acceptance rubric before it ships.', [
    ['A plan cannot ship without a graded acceptance rubric.', 'duplicates'],
    ['Every plan item needs a code-truth audit citation before shipping.', 'unrelated'],
  ]),
  c('k39', 'Use testing:run with explicit files; a root-level vitest run can match zero files and still pass.', [
    ['Run specific test files through testing:run.', 'refines'],
    ['The inference gateway listens on port 8788.', 'unrelated'],
  ]),
  c('k40', 'Knowledge-pack conflict classification runs on install, upgrade, and the hive sweep.', [
    ['Knowledge packs classify incoming items for conflicts.', 'refines'],
    ['memory:search returns results ranked by hybrid score.', 'unrelated'],
  ]),
  c('k41', 'Give scratch probes that import repo modules a .mts extension.', [
    ['Scratch probes that import repo modules should be named .mts.', 'duplicates'],
    ['Tool results are capped at about 1,500 tokens.', 'unrelated'],
  ]),
  c('k42', 'The inference gateway listens on port 8788.', [
    ['Port 8788 is the inference gateway.', 'duplicates'],
    ['The staging operator listens on port 3170.', 'unrelated'],
  ]),
  c('k43', 'The typecheck should be the last step, after every edit is done.', [
    ['Run lint:tsc after the final edit.', 'duplicates'],
    ['Use testing:run with explicit files.', 'unrelated'],
  ]),
  c('k44', 'In AUTO mode, decide scope yourself and disclose each deferral with its reason.', [
    ['In AUTO mode, decide scope yourself rather than asking.', 'refines'],
    ['The green checkpoint runs hourly.', 'unrelated'],
  ]),
];
