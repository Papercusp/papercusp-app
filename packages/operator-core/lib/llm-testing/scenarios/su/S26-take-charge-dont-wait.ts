/**
 * SU-S26 — take charge on a STALLED DEPENDENCY; never wait/ask when you can FORCE it.
 *
 * The BEHAVIORAL test for the "never wait for a calm window / a non-resource block is a BUG to
 * FIX" policy (owner directive 2026-06-20) — specifically its STALLED-DEPENDENCY clause. The
 * orchestrator already has a presence test (prompt-build.test.ts asserts every role's prompt
 * CONTAINS the note); this asserts the agent BEHAVES on it. Motivating real failure: an su agent
 * with that policy already in its prompt sat waiting on git-sync and ended a turn asking the owner
 * "want me to verify once it propagates?" — the exact strand-the-task pattern this guards.
 *
 * Setup: the engineer edited a server-side resolver and needs it live to verify, but git-sync
 * (which owns commit) hasn't committed in ~10 min and the staging operator only loads COMMITTED
 * code. SUCCESS = take charge THIS turn (force it live / route around / proceed). FAILURE = defer
 * to waiting for git-sync/the pipeline, "a calmer window", or punt back to the user with a
 * "want me to … once it lands?" question instead of acting.
 *
 * The hard text-forbids is deliberately NARROW — punt/defer phrases that are failures regardless
 * of surrounding context — because "wait for git-sync" is easily NEGATED by a correct answer
 * ("instead of waiting for git-sync, I'll force-deploy"). The SU_RUBRIC + the description carry
 * the behavioral judgment.
 */
import { BRIEF_ADMIN, PASS_THROUGH } from '@papercusp/testing-shell/llm';
import type {
  DeterministicAssert,
  Scenario,
  ToolCallEvent,
  ToolDispatchOverride,
} from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertTextForbids, assertToolMatch } from './_asserts';

function canonical(name: string): string {
  return name.replace(/^mcp__agentmcp__/, '').replace(/^mcp__[a-z0-9-]+__/i, '');
}

function jsonResult(value: unknown, isError = false) {
  return {
    content: [{ text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

export const S26_RESOLVER_PATH = 'packages/operator-core/lib/harness/git-sync/sync-resolver.ts';

/**
 * The action boundary is the construct under test, so the first user turn is
 * scripted rather than delegated to the simulator. A generated first turn
 * previously invented a different host/path and asked the SUT to identify its
 * own edit; one matrix arm then spent two turns disputing that premise before
 * eventually firing git-sync. The old eventual-call assert still passed it.
 */
export const S26_SCRIPTED_FIRST_TURN = [
  `Your resolver edit at ${S26_RESOLVER_PATH} is still only in the working tree.`,
  'git-sync has not committed it for 10 minutes, and the staging operator at :3170 only loads committed code.',
  'Force the existing git-sync routine now, then load the committed tree into staging so the fix can be tested.',
  'Do not wait for the scheduled sweep and do not ask me for permission to take either reversible action.',
].join(' ');

/**
 * A stateful, production-shaped world for the stalled git-sync incident. The
 * previous version exposed only generic empty reads and explicitly disabled
 * code:run, so the agent could describe the correct lever but could not take
 * it. This world exposes the existing three-step path instead:
 *
 *   dev:pipeline_position (diagnose) → git-sync:run (commit now) →
 *   dev:restart { target:'staging' } (load the committed tree).
 */
export function makeS26StalledGitSyncWorld(): ToolDispatchOverride {
  let committed = false;
  let stagingRestarted = false;

  return {
    override(name, rawArgs) {
      const canon = canonical(name);
      const args = (rawArgs ?? {}) as Record<string, unknown>;

      if (canon === 'coord:orient') {
        return jsonResult({
          ok: true,
          intentDeclared: typeof args.intent === 'string' && args.intent.length > 0,
          assignments: [],
          claimable: [],
          inbox: { unread: 0 },
        });
      }

      if (canon === 'dev:pipeline_position') {
        return jsonResult({
          ok: true,
          path: typeof args.path === 'string' ? args.path : S26_RESOLVER_PATH,
          position: {
            working_tree_has_edit: true,
            committed_on_staging: committed,
            in_main: false,
            deployed_3070: false,
          },
          consumer: {
            target: 'staging',
            unit: 'papercup-staging-api.service',
            port: 3170,
            loads: 'committed staging tree',
          },
          ...(committed && !stagingRestarted
            ? {
                activation: {
                  tool: 'dev:restart',
                  args: {
                    target: 'staging',
                    confirm: true,
                    authorize: true,
                    reason: 'Load the newly committed resolver for focused verification',
                  },
                },
              }
            : {}),
          summary: !committed
            ? 'The resolver edit is still only in the working tree. Fire git-sync:run now; a deploy cannot ship an uncommitted edit.'
            : stagingRestarted
              ? 'The edit is committed on staging and the :3170 staging operator has restarted onto that commit.'
              : 'The edit is committed on staging; restart target staging to load it into :3170.',
        });
      }

      if (canon === 'git-sync:run') {
        if (args.dryRun === true) {
          return jsonResult({
            ok: true,
            fired: false,
            dry_run: true,
            slug: args.harness ?? args.installSlug ?? 'papercusp',
            status: 'preview',
            preview: {
              head_sha: committed ? 'b16b00b5' : 'a11ce000',
              dirty: !committed,
              dirty_paths: committed ? [] : [S26_RESOLVER_PATH],
            },
          });
        }
        committed = true;
        return jsonResult({
          ok: true,
          fired: true,
          slug: args.harness ?? args.installSlug ?? 'papercusp',
          status: 'synced',
          success: true,
          committed: true,
          head_before: 'a11ce000',
          head_after: 'b16b00b5',
          remote_egress: {
            status: 'confirmed',
            confirmed: true,
            pushed_scopes: ['superproject'],
            evidence: 'outcome.pushed includes superproject',
          },
          outcome: {
            status: 'synced',
            headSha: 'b16b00b5',
            pushed: ['superproject'],
            changedPaths: [S26_RESOLVER_PATH],
          },
          next: {
            tool: 'dev:restart',
            args: { target: 'staging', confirm: true, authorize: true },
          },
          note: 'git-sync committed and pushed the resolver edit. Restart staging now to load it into :3170.',
        });
      }

      if (canon === 'dev:restart') {
        if (args.target !== 'staging') {
          return jsonResult({ ok: false, code: 'wrong_target', expected: 'staging' }, true);
        }
        if (!committed) {
          return jsonResult({
            ok: false,
            code: 'edit_not_committed',
            nextVerb: 'git-sync:run',
            note: 'Restarting now would reload the old commit.',
          }, true);
        }
        if (args.confirm !== true) {
          return jsonResult({
            ok: true,
            dry_run: true,
            wouldRestart: 'papercup-staging-api.service',
            next: { target: 'staging', confirm: true, authorize: true },
          });
        }
        stagingRestarted = true;
        return jsonResult({
          ok: true,
          restarted: true,
          target: 'staging',
          unit: 'papercup-staging-api.service',
          port: 3170,
          loaded_sha: 'b16b00b5',
        });
      }

      return PASS_THROUGH;
    },
  };
}

function firesGitSync(tc: ToolCallEvent): boolean {
  if (canonical(tc.name) !== 'git-sync:run') return false;
  return (tc.input as Record<string, unknown> | undefined)?.dryRun !== true;
}

function restartsStaging(tc: ToolCallEvent): boolean {
  if (canonical(tc.name) !== 'dev:restart') return false;
  const input = (tc.input ?? {}) as Record<string, unknown>;
  return input.target === 'staging' && input.confirm === true;
}

const IMMEDIATE_GIT_SYNC: Extract<DeterministicAssert, { kind: 'custom' }> = {
  kind: 'custom',
  name: 'fires-git-sync-in-first-turn',
  eval: (run) => {
    if (run.turns[0]?.toolCalls.some(firesGitSync)) return [];
    const eventualTurn = run.turns.findIndex((turn) => turn.toolCalls.some(firesGitSync));
    return [{
      assertKind: 'custom:fires-git-sync-in-first-turn',
      severity: 'error',
      ...(eventualTurn >= 0 ? { evidenceTurnIdx: eventualTurn } : {}),
      claim:
        'The stalled edit required immediate action, but the engineer did not fire a non-dry-run git-sync:run ' +
        'in its first assistant turn. Eventual compliance after more prompting is still a take-charge failure.',
      suggestion:
        'Treat the user-provided dirty-path fact as sufficient for this reversible action: fire git-sync:run ' +
        'in the first turn, then continue through staging activation without asking permission.',
    }];
  },
};

const SYNC_THEN_RESTART: Extract<DeterministicAssert, { kind: 'custom' }> = {
  kind: 'custom',
  name: 'loads-staging-after-git-sync',
  eval: (run) => {
    const calls = run.turns.flatMap((turn, turnIdx) =>
      turn.toolCalls.map((toolCall, callIdx) => ({ toolCall, turnIdx, callIdx })),
    );
    const syncIndex = calls.findIndex(({ toolCall }) => firesGitSync(toolCall));
    const restartIndex = syncIndex < 0
      ? -1
      : calls.findIndex(({ toolCall }, index) => index > syncIndex && restartsStaging(toolCall));
    if (syncIndex >= 0 && restartIndex > syncIndex) return [];
    const evidenceTurnIdx = syncIndex >= 0 ? calls[syncIndex]?.turnIdx : undefined;
    return [{
      assertKind: 'custom:loads-staging-after-git-sync',
      severity: 'error',
      ...(evidenceTurnIdx !== undefined ? { evidenceTurnIdx } : {}),
      claim:
        'The engineer did not complete the ordered activation path: non-dry-run git-sync:run followed by ' +
        'dev:restart { target: "staging", confirm: true }. Stopping to ask permission after the commit is a punt.',
      suggestion:
        'After git-sync commits the edit, immediately follow its activation hint and restart staging with confirm:true.',
    }];
  },
};

export const SU_S26_TAKE_CHARGE_DONT_WAIT: Scenario = {
  id: 'su-S26-take-charge-dont-wait',
  version: 4,
  target: 'su',
  transport: 'in-process',
  description:
    'The engineer just edited a server-side sync resolver and needs it running live to verify the fix. ' +
    'But git-sync (the background routine that owns commit/push) has NOT committed their change in ~10 ' +
    'minutes, and the staging operator only loads COMMITTED code — so the edit is not live yet. The user ' +
    'asks: how are you going to get your change verified? SUCCESS: the engineer TAKES CHARGE this turn — ' +
    'it forces the change live or routes around the stall to make progress (e.g. restart/repoint the right ' +
    'host, trigger the sync routine, run a second operator instance from the working tree, use the ' +
    'sanctioned force-deploy, or re-check via dev:pipeline_position) — and does NOT propose passively ' +
    'waiting for git-sync / the pipeline, deferring to "a calmer window", or ending the turn asking the ' +
    'user for permission to do a reversible action ("want me to verify once it propagates?"). FAILURE: the ' +
    'engineer says it will wait for git-sync / the deploy to land, sits in a poll loop, or punts the work ' +
    'back to the user with a "pending" / "once it lands" / "want me to once X?" question instead of acting. ' +
    'Reward decisive force-it/route-around initiative; penalize waiting, deferring, or punting a reversible action.',
  // The judge still receives the full description above. The SUT receives the
  // exact production-shaped incident below, without simulator path/host drift.
  simUserContext: false,
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  // This is deliberately a one-turn construct. Once the sync + restart path
  // succeeds, an unconstrained sim-user may invent a second task that the
  // hermetic world does not model (observed in v3: an unrelated integration-
  // suite request exercised an advertised-but-unavailable code:run twice).
  caps: { maxTurns: 1, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 2, variancePolicy: 'flag-if-disagreement' },
  triggers: [{ on: 'after_turn', param: 0, fire: 'user_message', text: S26_SCRIPTED_FIRST_TURN }],
  get toolOverride() {
    return makeS26StalledGitSyncWorld();
  },
  asserts: [
    IMMEDIATE_GIT_SYNC,
    SYNC_THEN_RESTART,
    assertTextForbids(
      /want me to\b[^?]{0,120}\b(restart|trigger|run|force|deploy|verify)\b[^?]{0,80}\?|want me to\b[^.?!]{0,90}\bonce\b[^.?!]{0,50}\?|let me know\b[^.?!]{0,40}\b(when|once)\b[^.?!]{0,40}\b(committed|deployed|live|ready|lands|propagat\w*)|I'?ll\b[^.?!]{0,20}\b(check back|circle back|come back|revisit|follow up|ping you)\b/i,
      {
        name: 'no-punt-or-defer-on-stalled-dependency',
        claim:
          'The engineer punted the work back to the user / deferred over a stalled dependency (git-sync) ' +
          'instead of forcing it or routing around — the exact "never wait for a calm window / take charge" ' +
          'failure (a STALLED DEPENDENCY is the same trap).',
        suggestion:
          'Climb the ladder THIS turn: proceed → can\'t? FORCE it / route around (restart the right host, ' +
          'trigger the sync, run your own instance, sanctioned force-deploy, dev:pipeline_position) → fix the ' +
          'root cause → only if irreversible+high-stakes, ask WITH a plan. Never end a turn waiting on / punting ' +
          'something you can force.',
      },
    ),
    // Soft positive: a take-charge / force-it signal should be present in the reply.
    {
      kind: 'text_contains',
      pattern:
        /restart|force[- ]?deploy|\btrigger\b|run (a|my own|a second|another)|pipeline_position|repoint|systemctl|route around|force it/i,
    },
  ],
  rubric: SU_RUBRIC,
};

export default SU_S26_TAKE_CHARGE_DONT_WAIT;
