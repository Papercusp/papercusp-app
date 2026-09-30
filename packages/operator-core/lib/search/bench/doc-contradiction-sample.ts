/**
 * Labelled passage pairs for validating the doc-contradiction judge
 * (plan jev-decision-model-integration-2026-09-29, P-010; bar in decision D-017).
 *
 * Each pair is what the deterministic overlap leg hands the judge: two passages
 * from the documentation corpus that share wording. Gold labels use the Jev
 * judge's vocabulary (jev-contradiction-judge.ts):
 *
 *   opposite-instructions  following A and following B lead to incompatible actions
 *                          in a situation both cover
 *   compatible             same subject, both can be followed
 *   unrelated              the overlap is only shared wording
 *
 * `note` records why a pair has its label, so a per-kind error can be read off the
 * report. The compatible pairs are the hard negatives: redundant restatements,
 * more-specific versions, different emphasis, and same-subject passages that cover
 * different situations (several of those use "never" and "use X" wording that looks
 * opposed on the surface). Several unrelated pairs share a title or a phrase.
 *
 * Written in the style of this repository's agent guidance and labelled by the
 * implementer (su-f7ad1084, 2026-09-30) BEFORE any judge saw the pairs. That
 * authorship, and passages shorter than real doc sections, are stated limitations
 * of the measurement.
 *
 * Frozen: a change here changes what the D-017 numbers describe. Add a pair only
 * alongside a re-run, and never relabel a pair after seeing a verdict on it.
 */
import type { JudgeSection } from '../doc-contradiction-judge';
import type { JevContradictionLabel } from '../jev-contradiction-judge';

export type DocPairNote =
  | 'direct'
  | 'conditional'
  | 'redundant'
  | 'more-specific'
  | 'different-emphasis'
  | 'different-situation'
  | 'shared-wording';

export interface DocContradictionSamplePair {
  readonly id: string;
  readonly gold: JevContradictionLabel;
  readonly note: DocPairNote;
  readonly a: JudgeSection;
  readonly b: JudgeSection;
}

const pair = (
  id: string,
  gold: JevContradictionLabel,
  note: DocPairNote,
  a: readonly [string, string],
  b: readonly [string, string],
): DocContradictionSamplePair => ({
  id,
  gold,
  note,
  a: { id: `${id}:a`, title: a[0], content: a[1] },
  b: { id: `${id}:b`, title: b[0], content: b[1] },
});

const COMMIT_A = [
  'Commit discipline',
  'A background git-sync routine commits the whole shared tree and pushes it to origin/staging on a schedule. Do not run git add, git commit or git push yourself; leave your work in the tree and it lands on the remote within minutes.',
] as const;

const NUQS_A = [
  'UI state',
  'User-meaningful state such as the selected tab, an open dialog or the active filter goes in the URL through nuqs, not useState, so that agents can read and set it through ui:get_state and ui:dispatch.',
] as const;

const TESTS_A = [
  'Where tests go',
  'Every new test goes in exactly one of the four canonical frameworks: Vitest, Playwright, Cargo or the LLM scenario suite. Never add a new .mjs integration script or a tsx smoke script.',
] as const;

const MEMORY_A = [
  'Durable facts',
  'Write durable facts to the shared memory store with memory:remember. Never park them in a client-local memory file that the rest of the pot never sees.',
] as const;

const SYNC_A = [
  'Fetching data in components',
  'Read query data with useSyncQuery from @papercusp/sync. Never hand-roll fetch plus setInterval polling for query data; the sync library is the one audited path.',
] as const;

export const DOC_CONTRADICTION_SAMPLE: readonly DocContradictionSamplePair[] = [
  // ── opposite-instructions (14) ──────────────────────────────────────────────
  pair('o-commit', 'opposite-instructions', 'direct', COMMIT_A, [
    'Finishing a change',
    'When your change is complete, commit it with a descriptive message and push it to origin/staging yourself so peers can pull it. Work left uncommitted in the shared tree can be lost.',
  ]),
  pair(
    'o-flag-default',
    'opposite-instructions',
    'direct',
    ['Shipping flags', 'New feature flags default ON. Finished work sets the code default to enabled and verifies it live in the same task.'],
    [
      'Adding a flag',
      'Every new feature flag ships default OFF. Enable it for yourself with an override and let the owner flip the default once the feature has soaked for a week.',
    ],
  ),
  pair('o-test-location', 'opposite-instructions', 'direct', TESTS_A, [
    'Quick integration checks',
    'For a quick integration check of a new subsystem, add a small .mjs script under scripts/smoke/ and run it with node. It does not need to be registered with any test framework.',
  ]),
  pair(
    'o-browser',
    'opposite-instructions',
    'direct',
    [
      'Verifying the operator UI',
      'Verify operator UI changes inside the Tauri shell with tauri-agent-tools. Never point a browser at :3055 or :3070; the page there is not the product and gives a misleading result.',
    ],
    [
      'Verifying the operator UI',
      'To check that an operator page renders, open http://127.0.0.1:3070 in the verdict browser and take a screenshot for the work-item.',
    ],
  ),
  pair(
    'o-migration-number',
    'opposite-instructions',
    'direct',
    [
      'Migration numbers',
      'Reserve the next migration number with scripts/next-migration.mjs before writing the file. It takes an advisory lock, so two agents cannot pick the same number.',
    ],
    [
      'Migration numbers',
      'Pick the next migration number by listing libs/db/sql and adding one to the highest file name. No reservation step is needed.',
    ],
  ),
  pair(
    'o-kill',
    'opposite-instructions',
    'direct',
    [
      'Stopping a runaway process',
      'Never kill a process by name or pattern. Use processes:kill with the task id; it signals the whole cgroup and cannot reach a recycled pid.',
    ],
    [
      'Stopping a runaway process',
      'Stop a runaway job with pkill -f and the binary name; the pattern catches every child process that matches.',
    ],
  ),
  pair('o-nuqs', 'opposite-instructions', 'direct', NUQS_A, [
    'UI state',
    'Keep the selected tab and dialog open-state in local useState. Putting them in the URL clutters browser history, and agents do not need to see them.',
  ]),
  pair('o-sync', 'opposite-instructions', 'direct', SYNC_A, [
    'Fetching data in components',
    'A panel that needs fresh numbers should fetch its endpoint in a useEffect and re-fetch every five seconds with setInterval.',
  ]),
  pair(
    'o-gate-owner',
    'opposite-instructions',
    'conditional',
    [
      'A red gate',
      'When the release gate is red and a live agent already owns it, send your evidence once and stop. Do not work the gate in parallel with its owner.',
    ],
    [
      'A red gate',
      'When the release gate is red, every agent should start fixing the failing tests at once, even if someone is already on it; more hands green it faster.',
    ],
  ),
  pair(
    'o-typecheck-order',
    'opposite-instructions',
    'conditional',
    [
      'Typechecking',
      'Run lint:tsc last, after your final edit, including any edit you made to a test file to fix a failing test.',
    ],
    [
      'Typechecking',
      'Run lint:tsc once, before the test suites. A later edit to a test file does not need another typecheck, because vitest reports type errors when it runs the file.',
    ],
  ),
  pair('o-memory-store', 'opposite-instructions', 'direct', MEMORY_A, [
    'Durable facts',
    "Record durable facts in MEMORY.md in your client's memory directory. That file is the canonical store other agents read.",
  ]),
  pair(
    'o-force-deploy',
    'opposite-instructions',
    'conditional',
    [
      'Deploying while the gate is red',
      'Do not force-deploy past a red gate without owner sign-off, however small the change. Green the gate instead.',
    ],
    [
      'Deploying while the gate is red',
      'If your change is small and verified locally, force-deploy past the red gate with release:deploy op force. Small changes need no sign-off.',
    ],
  ),
  pair(
    'o-wait',
    'opposite-instructions',
    'direct',
    [
      'Waiting on a peer',
      'When you are blocked on a peer, arm events:await on the completion key and end your turn. Never poll for it in a sleep loop.',
    ],
    [
      'Waiting on a peer',
      "When you are blocked on a peer, poll their work-item every thirty seconds in a sleep loop until its state changes, so you react immediately.",
    ],
  ),
  pair(
    'o-worktree',
    'opposite-instructions',
    'direct',
    [
      'Branches',
      'Work directly on staging in the shared checkout. Do not create git worktrees or feature branches; coordinate through locks instead.',
    ],
    [
      'Branches',
      'Start each substantial change in its own git worktree on a feature branch, so your edits cannot collide with a peer working in the shared checkout.',
    ],
  ),

  // ── compatible: redundant (5) ───────────────────────────────────────────────
  pair('c-red-commit', 'compatible', 'redundant', COMMIT_A, [
    'Git in this repo',
    'You never commit or push here. git-sync sweeps the tree and pushes to origin/staging on its own schedule, so just leave your edits in place.',
  ]),
  pair(
    'c-red-kill',
    'compatible',
    'redundant',
    ['Stopping a process', 'Use processes:kill with the task id to stop a managed job.'],
    [
      'Stopping a process',
      'processes:kill with the task id is how to stop a managed job; it kills the whole process subtree.',
    ],
  ),
  pair('c-red-nuqs', 'compatible', 'redundant', NUQS_A, [
    'Where UI state lives',
    'If a user would care about it (a tab, a filter, a selected id), store it in the URL with nuqs rather than in useState.',
  ]),
  pair('c-red-tests', 'compatible', 'redundant', TESTS_A, [
    'Adding tests',
    'Tests belong in Vitest, Playwright, Cargo or the LLM scenario suite. An ad-hoc script is rejected by the P-038 lint.',
  ]),
  pair('c-red-memory', 'compatible', 'redundant', MEMORY_A, [
    'Remembering things',
    'memory:remember is the one shared store, and memory:search recalls from it. A client-local memory file is invisible to other agents.',
  ]),

  // ── compatible: more specific (5) ───────────────────────────────────────────
  pair(
    'c-spec-typecheck',
    'compatible',
    'more-specific',
    ['Typechecking', 'Typecheck your changes before you report them done.'],
    [
      'Typechecking',
      'Run npm run lint:tsc -- --files=<the files you edited> as the last step. A bare lint:tsc checks operator-core only.',
    ],
  ),
  pair(
    'c-spec-migration',
    'compatible',
    'more-specific',
    ['Schema changes', 'Schema changes go through numbered migrations. Never create tables at runtime.'],
    [
      'Schema changes',
      'Write the migration at the .DRAFT path the allocator prints, arm it with mv when it is finished and tested, then run pull-schema.',
    ],
  ),
  pair(
    'c-spec-ui',
    'compatible',
    'more-specific',
    ['Verifying UI', 'Verify UI changes yourself before calling them done.'],
    [
      'Verifying UI',
      'Boot the desktop with scripts/verify-tauri-headless.sh and assert with tauri-agent-tools check. Pass VERIFY_TAURI_ISOLATED_DB=1 before you exercise write paths.',
    ],
  ),
  pair(
    'c-spec-wait',
    'compatible',
    'more-specific',
    ['Waiting', 'Do not busy-wait on another agent.'],
    [
      'Waiting',
      "Use events:await with on_timeout set to wake, sized to the event's cadence. On a timeout, check whether the producer is still making progress.",
    ],
  ),
  pair(
    'c-spec-flags',
    'compatible',
    'more-specific',
    ['Feature flags', 'Feature flags are defined in libs/flags/src/types.ts and flipped in /admin/features.'],
    [
      'Feature flags',
      'Flip a flag in /admin/features. Do not edit PostHog directly, and do not add an environment boolean as a second switch.',
    ],
  ),

  // ── compatible: different emphasis (2) ──────────────────────────────────────
  pair(
    'c-emph-gate',
    'compatible',
    'different-emphasis',
    [
      'A red gate',
      "A red gate blocks every agent's deploys, which is why it matters that someone owns it promptly.",
    ],
    [
      'A red gate',
      'A red gate needs exactly one fixer. Check ownership first; if a live agent holds it, send your evidence and move on.',
    ],
  ),
  pair(
    'c-emph-force',
    'compatible',
    'different-emphasis',
    [
      'Force deploys',
      'Force-deploying past a red gate ships known-broken code, so prefer greening the gate and keep force as the last resort.',
    ],
    [
      'Force deploys',
      'A force deploy is loud and audited. Preview it with op status first, and pass confirm only after you have acknowledged the red tests.',
    ],
  ),

  // ── compatible: different situation (4) ─────────────────────────────────────
  pair(
    'c-sit-bash',
    'compatible',
    'different-situation',
    [
      'Editing files',
      'Never edit a tracked file with sed -i, a heredoc or a shell redirect. Use the Edit tool, so the lock hook runs before the write.',
    ],
    [
      'Following a log',
      'Use bash for a tail -f follow; the read tool has no streaming mode. For the last lines of a log, capability:read with tail is enough.',
    ],
  ),
  pair('c-sit-usestate', 'compatible', 'different-situation', NUQS_A, [
    'Transient UI state',
    'Loading flags, mid-edit drafts, hover and focus stay in useState. They are not user-meaningful and do not belong in the URL.',
  ]),
  pair('c-sit-stream', 'compatible', 'different-situation', SYNC_A, [
    'Byte streams',
    'A file download is a byte stream, not query data. Read it with a plain fetch stream rather than useSyncQuery.',
  ]),
  pair('c-sit-scratch-repo', 'compatible', 'different-situation', COMMIT_A, [
    'Scratch repositories',
    'Inside a throwaway repository you created under /tmp for an experiment, commit as often as you like. git-sync never touches it.',
  ]),

  // ── unrelated: shared wording (10) ──────────────────────────────────────────
  pair(
    'u-ports',
    'unrelated',
    'shared-wording',
    ['Ports', ':3070 serves the green main build from the release checkout.'],
    ['Ports', ':8788 is the inference gateway; LLM calls route through it so it can pick an account.'],
  ),
  pair(
    'u-schedule-spawn',
    'unrelated',
    'shared-wording',
    [
      'Scheduling',
      'Recurring durable work is a DBOS scheduled workflow. Do not add a bare setInterval.',
    ],
    ['Spawning', 'A detached spawn must be enrolled with managedSpawn. Do not add an unenrolled detached spawn.'],
  ),
  pair(
    'u-after-editing',
    'unrelated',
    'shared-wording',
    ['Tests after editing', 'After editing, run test:affected with --changed-paths set to the files you changed.'],
    ['Docs after editing', 'After editing a doc part, run the projector so the generated CLAUDE.md picks up the change.'],
  ),
  pair(
    'u-flags-blueprint',
    'unrelated',
    'shared-wording',
    ['Feature flags', 'Feature flags have one source, libs/flags/src/types.ts; never hand-edit a flag in PostHog.'],
    ['Agent roles', 'A new agent role extends a parent blueprint with blueprint:extend; never hand-write a prompt file.'],
  ),
  pair(
    'u-storage-scratch',
    'unrelated',
    'shared-wording',
    ['Storage policy', 'New durable state goes in Postgres. Do not add plain JSON state files.'],
    ['Scratch probes', 'Name a scratch probe file .mts, not .ts, so its top-level await compiles.'],
  ),
  pair(
    'u-close',
    'unrelated',
    'shared-wording',
    ['Owner directives', 'Close each of your own directives with orders:disposition when you finish it.'],
    ['Work-items', 'Close a work-item with work_items:complete and a structured completion record when you finish it.'],
  ),
  pair(
    'u-locks-coupling',
    'unrelated',
    'shared-wording',
    ['Locks', 'A PreToolUse hook claims a file lock before each edit and blocks the edit when a peer holds the file.'],
    ['Coupling', "coord:couple lets two agents see each other's working state; coord:decouple removes the edge."],
  ),
  pair(
    'u-find-pgrep',
    'unrelated',
    'shared-wording',
    ['find on this box', 'bfs rejects relative -newermt values such as "10 minutes ago"; pass an epoch timestamp instead.'],
    ['pgrep on this box', 'pgrep has no -q flag here; use pgrep -c to count matches instead.'],
  ),
  pair(
    'u-deploy-gitsync',
    'unrelated',
    'shared-wording',
    ['Deploys', 'release:deploy with op trigger ships the already-green pin to :3070.'],
    ['git-sync', 'git-sync:run fires the commit routine once, on demand.'],
  ),
  pair(
    'u-performance',
    'unrelated',
    'shared-wording',
    ['Performance', 'Avoid serial filesystem loops; batch the reads.'],
    ['Performance', 'Avoid duplicate React keys in a list; they cause remounts and lost state.'],
  ),
];
