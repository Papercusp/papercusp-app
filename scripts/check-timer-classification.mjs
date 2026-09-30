#!/usr/bin/env node
/**
 * check-timer-classification.mjs — fail-loud guard against a NEW timer registration
 * (`managedSetInterval` / `PeriodicCheck`) landing without a declared D-004
 * push-don't-poll classification (P-011, stop-discarded-dedup-and-audit-server-
 * polling-2026-07-26).
 *
 * D-004 sorts every recurring timer into three buckets — 'must-sample' (no event
 * source exists), 'timeout-reaper' (the passage of time IS the trigger), or
 * 'violation' (recomputes derived state a store already emits change events for).
 * The C1-C4 audit lanes (P-014..P-017) hand-classified all ~104 timers that existed
 * on 2026-07-26, but that verdict lived only in plan/work-item prose — nothing
 * stopped it from going stale the moment a NEW timer was added elsewhere. This guard
 * closes that gap the same way `lint:no-raw-setinterval` (P-007/P-008) closed the
 * "is it even visible" gap: a shrink-only BASELINE grandfathers the pre-existing
 * unclassified call sites; a NEW site outside the baseline that doesn't pass
 * `classification: '<must-sample|timeout-reaper|violation>'` fails the build.
 *
 * visibility != control (same principle as no-raw-setinterval): this guard does NOT
 * forbid registering a 'violation'-classified timer — it only forbids OMITTING the
 * classification. Whether a violation should exist at all is a design review question
 * for whoever reads the code / schedule:inventory, not something a lint can decide.
 *
 *   node scripts/check-timer-classification.mjs
 *
 * DETECTION is TEXTUAL (not an AST parse), mirroring check-no-raw-setinterval.mjs:
 * find each `managedSetInterval(` call, extract its balanced-paren argument text, and
 * check whether that text contains the substring `classification:` (matches both a
 * literal `classification: 'must-sample'` and a threaded `classification:
 * check.classification` — the in-process-periodic.ts seam does the latter, since its
 * PeriodicCheck interface makes `classification` REQUIRED and this guard only needs
 * to confirm the option was PASSED, not re-validate the enum value TS already pins).
 *
 * GRANULARITY: like check-no-raw-setinterval's BASELINE, grandfathering is FILE-level,
 * not call-site-level — a baselined file with ONE unclassified call could in principle
 * grow a second unclassified call without tripping this guard. Accepted tradeoff for
 * parity with the established convention; a call-site-level baseline (keyed by
 * file:startOffset) would catch that but adds real complexity for a marginal gain the
 * shrink-to-empty discipline (this BASELINE going to zero) removes entirely anyway.
 *
 * ── TWO POPULATIONS, ONE TAXONOMY ─────────────────────────────────────────────────
 *
 * HOST timers (`managedSetInterval`) are covered by the scan described above.
 *
 * CLIENT timers (raw `setInterval` in the webview) are covered by the CLIENT scan below.
 * They were previously excluded outright, on the stated rationale that ".tsx browser
 * timers use the client sync layer, not managedSetInterval". Measured 2026-08-09 (P-026)
 * that rationale is FALSE: 59 raw `setInterval` sites across 53 client files, of which
 * only 10 carried any annotation at all. A client poller against an event-driven store is
 * the SAME defect D-004 names — `notifySyncInvalidate` already pushes those updates — so
 * it belongs under the same taxonomy, not a second one with a competing vocabulary.
 *
 * WHY THIS GUARD AND NOT `lint:no-raw-setinterval`: the two partition by REACHABILITY,
 * not by preference. That guard's job is REGISTRY VISIBILITY (`schedule:inventory`), which
 * a webview timer structurally cannot have — it runs in the renderer and cannot reach the
 * host registry — so it excludes `.tsx` wholesale and allowlists browser/client `.ts` by
 * name. Those exclusions are precisely this scan's scope: the population that guard hands
 * off is the population nothing was checking. `client-timer-classification.test.ts` asserts
 * the handoff stays airtight, so a file cannot fall between the two.
 *
 * CLIENT DECLARATION FORM is a COMMENT, not an option — there is no call seam to pass one
 * through, and inventing a client wrapper purely to carry an argument would be a large
 * refactor for a declaration a comment already expresses. This formalizes the convention
 * the P-058 audit already left in the tree ("Documented polling exception (audit P-058):
 * …", "the documented UI-timer exception …") into something machine-checkable:
 *
 *     // timer-classification: ui-timer — relative-time re-render, no data read
 *     const t = setInterval(() => setNow(Date.now()), 1000);
 *
 * The client vocabulary adds `ui-timer` to the D-004 three: a pure render tick that reads
 * NO store (re-rendering "3m ago" labels). D-005 already blessed exactly this shape, and 18
 * of the 59 measured sites are it — a guard that flagged them would be pure noise, and a
 * noisy guard gets disabled, which is the failure D-004 explicitly warns about.
 *
 * THE VERDICT IS "DID YOU DECLARE?", NEVER "IS YOUR CLASSIFICATION RIGHT". A lint cannot
 * tell a legitimate external probe from a lazy poll; only a reader can. The heuristic that
 * split clock-ticks from data-reads was used ONLY to seed CLIENT_BASELINE from a measured
 * population — it never decides a verdict, so its false positives cost nothing.
 *
 * EXCLUDED (never scanned): vendored / build output / _retired / tests / non-source.
 *
 * ALLOWLIST_DIRS (permanently allowed): the registry's own impl + test files (the
 *   `classification:` option they define/exercise, not a call site needing one).
 *
 * BASELINE (TEMPORARY — shrink to EMPTY as each file gets a real audited
 *   classification, same discipline as no-raw-setinterval's P-008 codemod): the 74
 *   files with a `managedSetInterval(` call as of 2026-07-26 (P-011), none of which
 *   were in scope for the C1/C2 audit lanes (those covered in-process-periodic.ts +
 *   produced the master tally, not a per-call-site classification for every one of
 *   these). NEW files may NOT be added here.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

export const ALLOWLIST_DIRS = [
  'libs/generic/scheduled-registry/', // the registry impl itself + its own tests
];

export const ALLOWLIST = new Set([
  // This guard itself: its own comments/detection text mention `managedSetInterval(`
  // and `classification:` literally, exactly as check-no-raw-setinterval allowlists
  // its own definition site.
  'scripts/check-timer-classification.mjs',
  // Its sibling guard's console.error prose literally contains the string
  // "managedSetInterval(name, ms, fn, { category })" as a usage hint — a textual
  // false positive, not a real unclassified call site.
  'scripts/check-no-raw-setinterval.mjs',
]);

/**
 * BASELINE (TEMPORARY — must shrink to EMPTY): files whose `managedSetInterval(` call(s)
 * do not yet declare a `classification`. Seeded 2026-07-26 (P-011) from the tracked tree
 * at that date. Do NOT add new entries — a new call site must classify itself; an
 * existing baselined file should be REMOVED from this set as part of whatever change
 * next touches its timer (classify it then, don't leave it for a dedicated sweep).
 */
export const BASELINE = new Set([
  'apps/operator/bin/serve.ts',
  'packages/operator-core/lib/agent-tools/locks/acquire.ts',
  'packages/operator-core/lib/agent-tools/locks/file-lock-authority-wiring.ts',
  'packages/operator-core/lib/auth-config-overrides.ts',
  'packages/operator-core/lib/blueprint/launch-blueprint.ts',
  'packages/operator-core/lib/capability-envelope-overrides.ts',
  'packages/operator-core/lib/capability-tier-overrides.ts',
  'packages/operator-core/lib/claude-credential-sync.ts',
  'packages/operator-core/lib/cross-hive-swarm-transport.ts',
  'packages/operator-core/lib/dbos/bootstrap.ts',
  'packages/operator-core/lib/dbos/dbos-executor-reaper.ts',
  'packages/operator-core/lib/dbos/durable-spawn.ts',
  'packages/operator-core/lib/dbos/ephemeral-executor.ts',
  'packages/operator-core/lib/deployment/frame-view.ts',
  'packages/operator-core/lib/device-push-credentials.ts',
  'packages/operator-core/lib/device-voice-ws.ts',
  'packages/operator-core/lib/endpoint-route/routes/agent-mcp/run-command-sse.ts',
  'packages/operator-core/lib/endpoint-route/routes/harness/streams.ts',
  'packages/operator-core/lib/endpoint-route/routes/pty/index.ts',
  'packages/operator-core/lib/endpoint-route/routes/transport/_mcp-handler.ts',
  'packages/operator-core/lib/endpoint-route/routes/tui/intents-stream.ts',
  'packages/operator-core/lib/endpoint-route/routes/ui/intents-stream.ts',
  'packages/operator-core/lib/event-loop-lag-monitor.ts',
  'packages/operator-core/lib/events/await/engine.ts',
  'packages/operator-core/lib/events/await/predicate-watch.ts',
  'packages/operator-core/lib/events/await/psu-pty-discovery.ts',
  'packages/operator-core/lib/expirable-registry.ts',
  'packages/operator-core/lib/fleet/chat-spawn-tracking.ts',
  'packages/operator-core/lib/fleet/operator-spawn.ts',
  'packages/operator-core/lib/harness-fs-watcher.ts',
  'packages/operator-core/lib/harness-state/git-export/drainer.ts',
  'packages/operator-core/lib/harness-status-sweep.ts',
  'packages/operator-core/lib/harness/structural-error-verifier.ts',
  'packages/operator-core/lib/hive-directory.ts',
  'packages/operator-core/lib/inference-gateway/gateway-sidecar-spawn.ts',
  'packages/operator-core/lib/inference-gateway/gateway.ts',
  'packages/operator-core/lib/inference-gateway/stall-waker-loop.ts',
  'packages/operator-core/lib/loop-pressure-governor.ts',
  'packages/operator-core/lib/memory-watchdog.ts',
  'packages/operator-core/lib/overwatch/escalation-aging-alarm.ts',
  'packages/operator-core/lib/overwatch/loop.ts',
  'packages/operator-core/lib/provision/runner.ts',
  'packages/operator-core/lib/pty-bridge.ts',
  'packages/operator-core/lib/pty-ws.ts',
  'packages/operator-core/lib/quota-overrides.ts',
  'packages/operator-core/lib/red-queen/engine-death.ts',
  'packages/operator-core/lib/release/git-sync-stall-watchdog.ts',
  'packages/operator-core/lib/release/green-stall-watchdog.ts',
  'packages/operator-core/lib/release/origin-freshness-watchdog.ts',
  'packages/operator-core/lib/release/worktree-coverage-watchdog.ts',
  'packages/operator-core/lib/sync/hyperbee/boot.ts',
  'packages/operator-core/lib/sync/hyperbee/cluster-booted-handles-sync.ts',
  'packages/operator-core/lib/sync/hyperbee/federation-join-stall-watchdog.ts',
  'packages/operator-core/lib/sync/hyperbee/outbox-drain.ts',
  'packages/operator-core/lib/sync/hyperbee/substrate-eviction-reaper.ts',
  'packages/operator-core/lib/sync/hyperbee/swarm.ts',
  'packages/operator-core/lib/sync/hyperbee/topic-gossip.ts',
  'packages/operator-core/lib/sync/hyperbee/wire-outbox.ts',
  'packages/operator-core/lib/sync/pot-git/peer-dial-registry.ts',
  'packages/operator-core/lib/system-health/carry-drill-drop-watchdog.ts',
  'packages/operator-core/lib/system-health/cluster-lag-watchdog.ts',
  'packages/operator-core/lib/system-health/codex-rollout-persistence-watchdog.ts',
  'packages/operator-core/lib/system-health/cold-boot-drill-autorunner.ts',
  'packages/operator-core/lib/system-health/compaction-compliance-watchdog.ts',
  'packages/operator-core/lib/system-health/condition-staleness-alarm.ts',
  'packages/operator-core/lib/system-health/lag-self-restart.ts',
  'packages/operator-core/lib/system-health/liveness-alarm.ts',
  'packages/operator-core/lib/system-health/mcp-dark-watchdog.ts',
  'packages/operator-core/lib/system-health/single-primary-check.ts',
  'packages/operator-core/lib/telemetry-buffer-config.ts',
  'packages/operator-core/lib/txn-timeouts-config.ts',
  'packages/operator-core/lib/voice-engine-health.ts',
  'packages/operator-core/lib/voice-node/operator-voice-host.ts',
  'packages/operator-core/lib/voice-node/screen-track/screen-publisher.ts',
  'packages/operator-core/lib/voice-node/sentinel-says-pump.ts',
  'packages/plugin-loader/src/daemon/supervisor.ts',
]);

/**
 * Browser/client `.ts` files (non-.tsx) that run in the WEBVIEW, not the host.
 *
 * Kept as an explicit list rather than sniffed from content: `window.`/`useEffect` markers
 * appear in server files in strings and comments, and a sniffer's false positives would
 * land on NEW files — the only ones this guard actually gates. These are exactly the
 * entries `check-no-raw-setinterval.mjs` exports as BROWSER_CLIENT_ALLOWLIST (its
 * SEPARATE_PROCESS_ALLOWLIST — the :8788 gateway, the systemd watchdogs, the perf children —
 * is deliberately NOT here: those are host-shaped, just in another process).
 *
 * This set and that one must stay EQUAL: `client-timer-classification.test.ts` asserts it
 * in both directions, so the handoff cannot silently develop a hole (a file exempt there
 * and unclaimed here is checked by NEITHER guard). Verified falsifiable 2026-08-09 by
 * mutation probe — adding an entry there and not here fails that test, exit 1.
 */
export const CLIENT_TS_FILES = new Set([
  'apps/operator/app/_components/SetupWizard/useWizardStatuses.ts',
  'apps/operator/app/_components/voice/voice-leader.ts',
  'apps/operator/app/_components/useWslGateBlocking.ts',
  'apps/operator/app/admin/plans/plans-api.ts',
  'apps/operator/app/admin/testing/_lib/vitals-recorder.ts',
  'apps/operator/lib/ui/use-ui-presence.ts',
  'apps/operator-vite/src/lib/video/camera-capture.ts',
  'packages/operator-core/lib/operator-window-sync.ts',
  'packages/operator-core/lib/voice-engines/deepgram.ts',
]);

/** True iff `f` is CLIENT code (webview), i.e. in scope for the raw-timer classification scan. */
export const isClientFile = (f) => f.endsWith('.tsx') || CLIENT_TS_FILES.has(f);

/** The classification vocabulary. `ui-timer` is client-only (D-005): a pure render tick. */
export const CLASSIFICATIONS = ['must-sample', 'timeout-reaper', 'violation', 'ui-timer'];

/**
 * CLIENT_BASELINE (TEMPORARY — must shrink to EMPTY, same discipline as BASELINE above):
 * client files carrying a raw `setInterval` with no `timer-classification:` declaration as
 * of 2026-08-09 (P-026). GENERATED, not hand-listed — regenerate with:
 *
 *   node scripts/check-timer-classification.mjs --emit-client-baseline
 *
 * Seeding it from a measured scan rather than a hand-run grep is deliberate: this repo has
 * corrected a guard's population upward three times, each time because the measurement
 * matched a spelling instead of the thing (see CLAUDE.md § shared-lib singletons). NEW
 * files may NOT be added here — a new client timer must declare its own classification.
 */
export const CLIENT_BASELINE = new Set([
  'apps/operator-vite/src/components/NavigationProgress.tsx',
  'apps/operator-vite/src/components/VersionBadge.tsx',
  'apps/operator-vite/src/components/adv/AdvFramesTab.tsx',
  'apps/operator-vite/src/components/adv/AgentsRunningPill.tsx',
  'apps/operator-vite/src/components/adv/FleetRateControl.tsx',
  'apps/operator-vite/src/components/adv/HealthTab.tsx',
  'apps/operator-vite/src/components/env-switcher/EnvSwitcherBar.tsx',
  'apps/operator-vite/src/components/left-sidebar/AccountsTab.tsx',
  'apps/operator-vite/src/components/left-sidebar/MugHeartbeat.tsx',
  'apps/operator-vite/src/components/left-sidebar/OverwatchTab.tsx',
  'apps/operator-vite/src/lib/video/camera-capture.ts',
  'apps/operator-vite/src/routes/admin/dogfood-substrate.tsx',
  'apps/operator/app/_components/AuthSignInCards.tsx',
  'apps/operator/app/_components/OnboardingConsole.tsx',
  'apps/operator/app/_components/OperatorActionLog.tsx',
  'apps/operator/app/_components/OperatorActiveToggle.tsx',
  'apps/operator/app/_components/OperatorPanel.tsx',
  'apps/operator/app/_components/SetupWizard/StepAgents.tsx',
  'apps/operator/app/_components/SetupWizard/StepEmbeddedPg.tsx',
  'apps/operator/app/_components/SetupWizard/StepGit.tsx',
  'apps/operator/app/_components/SetupWizard/StepLocalModel.tsx',
  'apps/operator/app/_components/SetupWizard/StepMobilePairing.tsx',
  'apps/operator/app/_components/SetupWizard/useWizardStatuses.ts',
  'apps/operator/app/_components/UpdateChip.tsx',
  'apps/operator/app/_components/chat/HydratedWorkRefPill.tsx',
  'apps/operator/app/_components/chat/SessionChatModal.tsx',
  'apps/operator/app/_components/chat/message-timestamp.tsx',
  'apps/operator/app/_components/useWslGateBlocking.ts',
  'apps/operator/app/_components/voice/VoiceAppBridge.tsx',
  'apps/operator/app/_components/voice/voice-leader.ts',
  'apps/operator/app/admin/_components/CommandCard.tsx',
  'apps/operator/app/admin/plans/LockBanner.tsx',
  'apps/operator/app/admin/plans/plans-api.ts',
  'apps/operator/app/admin/testing/_components/MemoryTab.tsx',
  'apps/operator/app/admin/testing/_components/TestRunsTab.tsx',
  'apps/operator/app/admin/testing/_lib/vitals-recorder.ts',
  'apps/operator/app/adv/harnesses/AdvGitGraphPanel.tsx',
  'apps/operator/app/adv/harnesses/AdvSyncHealthPanel.tsx',
  'apps/operator/app/adv/hud/HudView.tsx',
  'apps/operator/app/adv/sessions/AdvSessionsClient.tsx',
  'apps/operator/app/coord/CoordDashboard.tsx',
  'apps/operator/app/dev/_components/BackupsTab.tsx',
  'apps/operator/app/dev/_components/IpcTab.tsx',
  'apps/operator/app/dev/_components/PgTab.tsx',
  'apps/operator/app/dev/_components/ProcessesTab.tsx',
  'apps/operator/app/dev/_components/RightRail.tsx',
  'apps/operator/app/dev/_components/StudioTab.tsx',
  'apps/operator/app/harness/AgentInspectorModal.tsx',
  'apps/operator/app/harness/insights/BootHistoryTableClient.tsx',
  'apps/operator/app/harness/insights/SubstrateSummaryCardClient.tsx',
  'apps/operator/app/installed/kpis/page.tsx',
  'apps/operator/app/settings/deploy-accounts/page.tsx',
  'apps/operator/app/settings/mobile/page.tsx',
  'apps/operator/app/settings/voice/page.tsx',
  'apps/operator/lib/ui/use-ui-presence.ts',
  'libs/generic/git-graph/src/GitGraphPanel.tsx',
  'libs/testing-shell/src/web/LiveWebPanel.tsx',
  'packages/operator-core/lib/operator-window-sync.ts',
]);

export const isExcluded = (f) =>
  f.startsWith('_retired/') ||
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  f.includes('/.next/') ||
  f.includes('/build/') ||
  f.includes('/storybook-static/') ||
  f.includes('/code-server/') ||
  // WI-6666: bundled sidecar BUILD OUTPUT (esbuild-minified serve.mjs), not source — only
  // reachable once the enumerator recurses into submodules (papercusp-desktop). Sibling
  // guards (check-no-raw-setinterval, check-no-control-bytes) already carry this exclusion.
  f.includes('/env-sidecars/') ||
  // WI-212675: `apps/operator/dist-sidecar/` is the esbuild-bundled embed-sidecar output —
  // the SAME class of wholesale-regenerated build artifact as env-sidecars/ above, and
  // already excluded by at least 8 sibling content guards (check-no-raw-setinterval,
  // check-no-control-bytes [as of this same fix], check-no-eager-execfile-promisify,
  // check-no-module-scope-flag-subscribe, check-no-deployed-liveness-read,
  // check-no-hand-rolled-module-pin, check-no-unthreaded-apply,
  // check-no-unhosted-remote-core). A minified bundle cannot carry a D-004 classification
  // comment and is not hand-authored source to classify.
  f.includes('/dist-sidecar/') ||
  f.includes('/spa/assets/') ||
  f.includes('/holepunch-spike/') ||
  /\.(test|spec)\.[cm]?tsx?$/.test(f) ||
  // P-026: `.tsx` is no longer excluded — it IS the client population (see the header).
  !/\.(tsx|ts|mjs|cjs)$/.test(f);

/** Strip block (incl. JSDoc) + line comments so a prose mention doesn't confuse detection. */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Strip comments AND the CONTENTS of string/template literals, in ONE pass.
 *
 * WHY THIS EXISTS (EI-19989853369726696): the host scan used to run `stripComments`
 * alone, which leaves string literals intact — so a call-shaped token appearing in
 * PROSE inside a string was parsed as a real call site. That is not hypothetical and
 * it was not cheap: `apps/operator/lib/release/green-checkpoint.ts` contains the error
 * text of a DIFFERENT guard —
 *
 *     '... a new recurring timer bypassed managedSetInterval (P-008) ...'
 *
 * The detector regex is /\bmanagedSetInterval\s*\(/, and `\s*\(` happily matches the
 * space before `(P-008)`. The scan then extracted `P-008` as that "call's" argument
 * text, found no `classification:` in it, and reported a phantom offender — red-pinning
 * the fleet gate on a file that does not even IMPORT managedSetInterval. A guard whose
 * own failure message is quoted in another file will keep doing this, so the fix
 * belongs in the scanner, not in a reword of the quoting file.
 *
 * ONE pass rather than strip-comments-then-strip-strings, because the two are mutually
 * escaping: `//` inside a string does not start a comment ("http://x" must survive as a
 * string, not silently truncate the rest of the line), and a quote inside a comment does
 * not start a string (`// don't` would otherwise open an unterminated literal and eat
 * the file). Chaining two independent regex passes gets both of those wrong.
 *
 * `${...}` template expressions are preserved AS CODE — a real call can legitimately
 * live inside one, and dropping them would trade this false POSITIVE for a false
 * NEGATIVE, which is the worse direction for a guard.
 *
 * The delimiters are kept (contents emptied) so nothing new is concatenated across a
 * removal. Argument-level detection is unaffected: the check looks for the `classification:`
 * KEY, which is code, never the string VALUE — `{ classification: 'must-sample' }` still
 * reads as `{ classification: '' }` and still matches.
 *
 * KNOWN LIMIT, stated rather than papered over: a regex literal containing a quote or a
 * slash (`/'/`) can still confuse this, since telling a regex from division needs real
 * parsing. That is the same class of approximation `findManagedSetIntervalCalls` already
 * documents ("without a real AST parse"), and it fails toward the pre-existing behaviour.
 */
export function stripCommentsAndStrings(text) {
  let out = '';
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];

    if (c === '/' && c2 === '/') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }

    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    if (c === '"' || c === "'") {
      out += c;
      i += 1;
      while (i < n && text[i] !== c && text[i] !== '\n') {
        i += text[i] === '\\' ? 2 : 1;
      }
      out += c;
      i += 1;
      continue;
    }

    if (c === '`') {
      out += '`';
      i += 1;
      while (i < n && text[i] !== '`') {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === '$' && text[i + 1] === '{') {
          out += '${';
          i += 2;
          let depth = 1;
          const exprStart = i;
          while (i < n && depth > 0) {
            if (text[i] === '{') depth += 1;
            else if (text[i] === '}') depth -= 1;
            if (depth === 0) break;
            i += 1;
          }
          out += text.slice(exprStart, i);
          out += '}';
          i += 1;
          continue;
        }
        i += 1;
      }
      out += '`';
      i += 1;
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
}

/**
 * Find the balanced-paren text of every `managedSetInterval(...)` CALL in `text`
 * (after comments AND string literals are stripped — see stripCommentsAndStrings for
 * why strings must go too; a call-shaped token quoted in prose is not a call site).
 * Returns an array of the substrings between the
 * call's opening `(` and its matching closing `)`, INCLUSIVE of nested parens —
 * good enough for a textual "does this call's arguments mention `classification:`"
 * check without a real AST parse (mirrors the simplicity of check-no-raw-setinterval).
 *
 * Stripping strings also HARDENS the balanced-paren walk below: an unbalanced paren
 * inside a string (`'oops :-('`) previously threw the depth counter off and could run
 * the argument text to the end of the file.
 */
export function findManagedSetIntervalCalls(text) {
  const clean = stripCommentsAndStrings(text);
  const calls = [];
  const re = /\bmanagedSetInterval\s*\(/g;
  let m;
  while ((m = re.exec(clean))) {
    const start = re.lastIndex; // just after the opening '('
    let depth = 1;
    let i = start;
    for (; i < clean.length && depth > 0; i++) {
      if (clean[i] === '(') depth += 1;
      else if (clean[i] === ')') depth -= 1;
    }
    calls.push(clean.slice(start, i - 1));
  }
  return calls;
}

/** True iff `text` contains at least one `managedSetInterval(...)` call missing `classification:`. */
export function hasUnclassifiedCall(text) {
  return findManagedSetIntervalCalls(text).some((argText) => !/\bclassification\s*:/.test(argText));
}

/** A `timer-classification: <bucket>` declaration comment, e.g. `// timer-classification: ui-timer — why`. */
export const CLIENT_DECL_RE = new RegExp(`timer-classification\\s*:\\s*(${CLASSIFICATIONS.join('|')})\\b`);

/**
 * Raw client timer sites in `text` that lack a nearby classification declaration.
 *
 * Comments are NOT stripped here (unlike the host scan) — the declaration LIVES in a
 * comment, so stripping them would delete the very thing being looked for. A prose mention
 * of `setInterval(` inside a comment could therefore be counted as a call site; that is the
 * safe direction (it asks for a declaration that costs one line), and the `managedSetInterval`
 * negative-lookbehind below keeps the host wrapper out of this scan.
 *
 * PROXIMITY, not enclosing-scope: a declaration counts when it appears within
 * DECL_LOOKBACK_LINES above the call, or on the call's own line. The P-058 comments already
 * in the tree sit 1-4 lines above their call (often with an intervening `if`/`useEffect`),
 * so a strict "line immediately above" rule would reject the established convention, and a
 * real scope analysis needs an AST this guard deliberately does not carry.
 */
export const DECL_LOOKBACK_LINES = 6;

export function findUndeclaredClientTimers(text) {
  const lines = text.split('\n');
  const hits = [];
  const re = /(?<!managed)(?<![\w$.])(?:window\s*\.\s*)?setInterval\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    const from = Math.max(0, i - DECL_LOOKBACK_LINES);
    const window_ = lines.slice(from, i + 1).join('\n');
    if (!CLIENT_DECL_RE.test(window_)) hits.push(i + 1);
  }
  return hits;
}

/**
 * Scan the tracked tree for offenders (excludes vendored/tests/.tsx + ALLOWLIST + BASELINE).
 *
 * WI-6666: enumerates via the shared `listTrackedFiles` helper, which recurses into
 * submodules. A bare `git ls-files` does NOT — it emits one gitlink entry per submodule —
 * so this guard previously printed a clean verdict having scanned none of the 39
 * submodules (including libs/generic/scheduled-registry's own tests and the bundled
 * desktop sidecar). Returns the coverage report alongside the offenders so `main` can
 * state what it could not check instead of implying a clean tree.
 */
export function findOffenders() {
  const { files: tracked, unscanned } = listTrackedFiles(ROOT);

  const offenders = [];
  const clientOffenders = [];
  for (const f of tracked) {
    if (isExcluded(f)) continue;
    if (ALLOWLIST.has(f)) continue;
    if (ALLOWLIST_DIRS.some((p) => f.startsWith(p))) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
    } catch {
      continue;
    }
    if (isClientFile(f)) {
      if (CLIENT_BASELINE.has(f)) continue;
      const lines = findUndeclaredClientTimers(text);
      if (lines.length > 0) clientOffenders.push({ file: f, lines });
      continue;
    }
    if (BASELINE.has(f)) continue;
    if (hasUnclassifiedCall(text)) offenders.push(f);
  }
  return { offenders, clientOffenders, unscanned };
}

function main() {
  const { offenders, clientOffenders, unscanned } = findOffenders();

  // `--emit-client-baseline`: print the CLIENT_BASELINE literal for the CURRENT tree, so the
  // grandfather set is always re-seeded from a measured scan instead of a hand-run grep.
  if (process.argv.includes('--emit-client-baseline')) {
    const files = clientOffenders.map((o) => o.file).sort();
    console.log(`export const CLIENT_BASELINE = new Set([`);
    for (const f of files) console.log(`  '${f}',`);
    console.log(`]);`);
    console.error(`\n(${files.length} client file(s) with an undeclared raw timer)`);
    process.exit(0);
  }

  if (clientOffenders.length > 0) {
    const sites = clientOffenders.reduce((n, o) => n + o.lines.length, 0);
    console.error(`✗ ${sites} raw client setInterval() site(s) with no timer-classification declaration:`);
    console.error("  Declare one in a comment within 6 lines above the call, e.g.");
    console.error("    // timer-classification: ui-timer — relative-time re-render, no data read");
    console.error(`  Buckets: ${CLASSIFICATIONS.join(' | ')}.`);
    console.error('  `ui-timer` = a pure render tick that reads no store (D-005). If the timer READS');
    console.error('  data a store already pushes (plans, locks, work-items — notifySyncInvalidate),');
    console.error("  it is a 'violation': declare it honestly rather than relabelling it to look clean.");
    console.error('  See D-004 (stop-discarded-dedup-and-audit-server-polling-2026-07-26).\n');
    for (const o of clientOffenders) console.error(`    ${o.file}:${o.lines.join(',')}`);
    console.error('');
  }

  if (offenders.length === 0 && clientOffenders.length === 0) {
    const parts = [];
    if (BASELINE.size > 0) parts.push(`${BASELINE.size} host`);
    if (CLIENT_BASELINE.size > 0) parts.push(`${CLIENT_BASELINE.size} client`);
    const note = parts.length > 0 ? ` (${parts.join(' + ')} file(s) still in the shrink-to-empty BASELINEs — P-011/P-026)` : '';
    console.log(`✓ no NEW unclassified timer${note}.` + describeUnscanned(unscanned));
    process.exit(0);
  }
  if (offenders.length === 0) {
    console.error(
      `  ${clientOffenders.length} client file(s). See plan stop-discarded-dedup-and-audit-server-polling-2026-07-26 (P-026).`,
    );
    process.exit(1);
  }
  console.error('✗ NEW managedSetInterval(...) call(s) missing a D-004 classification:');
  console.error('  Pass { category, classification: \'must-sample\' | \'timeout-reaper\' | \'violation\' }');
  console.error('  from @papercusp/scheduled-registry — see D-004 (stop-discarded-dedup-and-audit-');
  console.error('  server-polling-2026-07-26) for the three-bucket test.\n');
  for (const o of offenders) console.error('    ' + o);
  console.error(
    `\n  ${offenders.length} offender(s). See plan stop-discarded-dedup-and-audit-server-polling-2026-07-26 (P-011).`,
  );
  process.exit(1);
}

const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  main();
}
