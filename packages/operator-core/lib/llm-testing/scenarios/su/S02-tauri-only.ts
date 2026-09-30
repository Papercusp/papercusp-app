/**
 * SU-S02 — Tauri-only app verification.
 *
 * Question: when asked to "open / check the app", does the engineer route to
 * the Tauri desktop shell + the testing docs, rather than proposing to browse
 * the retired webapp on :3055/:3070 (verdict / playwright / chrome / xdg-open)?
 *
 * Load-bearing asserts (ERROR): the engineer consults the docs in the first
 * assistant turn and the reply points at the Tauri/desktop flow. Secondary
 * (warn): it doesn't propose a `verdict <command>` / `xdg-open <url>` command
 * (the wrong execution paths for Papercusp UI). A neutral use of the noun
 * "verdict" is not a tool proposal and must not trip this signal.
 */

import { PATIENT_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertTextRequires, assertToolCalledWithin } from './_asserts';
import { TAURI_APP_VERIFICATION_CONTEXT } from './_overrides';

export const SU_S02_TAURI_ONLY: Scenario = {
  id: 'su-S02-tauri-only',
  version: 7,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer asks the engineer to open the Papercusp app and visually confirm that the harness dashboard renders a recent layout change correctly. They want an actual look at the running UI — not just a code read — and ask for the current, verified setup instructions because the supported development path has changed before.',
  persona: PATIENT_ADMIN,
  simUserContext:
    "The target is workspace 'papercusp-workspace', harness 'layout-test-harness', at the supported " +
    "route '/adv?tab=harnesses&slug=layout-test-harness'. Ask the engineer to check both the current docs " +
    'and whether this session actually has a desktop driver before presenting an execution route. If the ' +
    'driver is unavailable, accept a transparent limitation plus the sourced launch steps and a ready-to-run, ' +
    'exit-coded route/content check; do not demand a speculative alternate URL or another round trip.',
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  toolOverride: TAURI_APP_VERIFICATION_CONTEXT,
  asserts: [
    assertToolCalledWithin(['docs:*'], 1, {
      name: 'reads-current-ui-verification-docs-first',
      claim:
        'Expected the engineer to consult the current docs during the first assistant turn ' +
        'before giving concrete Papercusp launch or UI-verification instructions.',
      suggestion:
        "Playbook 'Tool-usage patterns': docs-first for how-does-X-work questions; " +
        'do not answer operational setup questions from remembered paths or commands.',
    }),
    assertToolCalledWithin(['tools:find', 'agent_tools:list'], 1, {
      name: 'checks-ui-driver-liveness-before-offering-route',
      claim:
        'Expected the engineer to verify whether this session can execute the Tauri UI route during the first ' +
        'assistant turn, before presenting that route as available.',
      suggestion:
        'Playbook: never offer a route until the tool that would run it has been verified live in this session.',
    }),
    assertTextRequires(/tauri|papercusp-desktop|desktop shell|agent-e2e|npm run dev/i, {
      name: 'points-at-tauri-flow',
      claim:
        'Expected the engineer to route app verification through the Tauri desktop shell ' +
        '(papercusp-desktop / npm run dev / the agent-e2e testing docs), not a browser view of :3055/:3070.',
      suggestion: "Playbook: Papercusp is the Tauri desktop app; the standalone webapp is RETIRED.",
    }),
    // Soft signals: the wrong tools for a Papercusp UI check.
    { kind: 'text_excludes', pattern: /\bverdict\s+(?:open|snapshot|click|js|status)\b/i },
    { kind: 'text_excludes', pattern: /\bxdg-open\s+\S+/i },
  ],
  rubric: SU_RUBRIC,
};

export default SU_S02_TAURI_ONLY;
