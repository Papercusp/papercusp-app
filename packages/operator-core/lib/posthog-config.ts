/**
 * Resolve PostHog connection info for the operator's server-side
 * feature-flag evaluation.
 *
 * Resolution order:
 *   1. Explicit env (PAPERCUSP_POSTHOG_HOST + PAPERCUSP_POSTHOG_KEY [+ optional
 *      PAPERCUSP_POSTHOG_PERSONAL_KEY for write/admin]).
 *   2. Discovery file at ~/.papercusp/posthog.json — written by the
 *      operator's PostHog Docker bootstrap (Phase 1 of the V1 flag plan).
 *   3. null — PostHog is not configured. The server still answers
 *      /api/flags/bootstrap with FLAG_DEFAULTS, so the app works.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { PostHogConfig } from '@papercusp/flags/server';
import { pinModuleState } from '@papercusp/module-singleton';

type Resolved = { config: PostHogConfig | null; source: string; testingFeatures: boolean };

let cached: Resolved | null = null;

export function getPosthogConfig(): PostHogConfig | null {
  return resolve().config;
}

export function isTestingFeaturesEnabled(): boolean {
  return resolve().testingFeatures;
}

export function getPosthogConfigWithSource(): Resolved {
  return resolve();
}

export function resetPosthogConfigForTest(): void {
  cached = null;
}

/**
 * Watch the discovery file so config edits (e.g. flipping
 * `testingFeatures` by hand, secret rotation) take effect without an
 * operator restart. Idempotent — only the first call installs the
 * watcher; subsequent calls are no-ops.
 *
 * Triggered as a side effect from flag-bus.ts on first import.
 */
// Watcher state pinned to globalThis per perf rule A18: under tsx this module
// can be instantiated twice (CJS + ESM specifier space), and a module-scoped
// flag then installs one fs.watch handle per instance on the same directory
// (observed live: 2× watchers per operator process, EI-255 census). ONE shared
// watcher fires every instance's invalidator, so each copy's `cached` +
// onConfigChange still work.
interface PosthogWatcherState {
  installed: boolean;
  invalidators: Array<() => void>;
}
// Pinned through @papercusp/module-singleton rather than a hand-rolled
// `globalThis[Symbol.for(...)]` pair, so the pin stays visible to
// listModuleDuplications() (EI-19479108855357092).
//
// ⚠ ONLY the watcher state is pinned — `cached` and `onConfigChange` below stay
// module-local BY DESIGN, and that is not a half-finished migration. This module
// deliberately ACCOMMODATES the split instead of collapsing it: one shared
// fs.watch handle fires every record's own invalidator (registered into the
// shared `invalidators` list at module init), which is what lets each record
// keep its own `cached` + `onConfigChange`. Folding those two into the pin would
// make `setOnConfigChange` last-writer-wins ACROSS records and render the
// invalidator list pointless — a behavior change, not a cleanup. Leave them.
const __watcherState = pinModuleState<PosthogWatcherState>(
  '@papercusp/operator-core.posthogConfigWatcher',
  () => ({ installed: false, invalidators: [] }),
);
let onConfigChange: (() => void) | null = null;
// THIS module instance's invalidator — registered once at module init.
__watcherState.invalidators.push(() => {
  cached = null;
  if (onConfigChange) onConfigChange();
});

export function setOnConfigChange(fn: () => void): void {
  onConfigChange = fn;
}

export function watchPosthogConfig(): void {
  if (__watcherState.installed) return;
  __watcherState.installed = true;
  const discoveryPath = path.join(os.homedir(), '.papercusp', 'posthog.json');
  const dir = path.dirname(discoveryPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.watch(dir, (_event, filename) => {
      if (filename !== 'posthog.json') return;
      for (const invalidate of __watcherState.invalidators) {
        try {
          invalidate();
        } catch {
          // never let the watcher die on a handler error
        }
      }
    });
  } catch {
    // best-effort; missing dir or unsupported FS just disables auto-reload
  }
}

function resolve(): Resolved {
  if (cached) return cached;

  // env override path — for CI/test or explicit dev opt-in
  const envHost = process.env.PAPERCUSP_POSTHOG_HOST;
  const envKey = process.env.PAPERCUSP_POSTHOG_KEY;
  const envPersonal = process.env.PAPERCUSP_POSTHOG_PERSONAL_KEY ?? envKey;
  const envLive = process.env.PAPERCUSP_POSTHOG_TESTING_FEATURES === 'true';
  if (envHost && envKey) {
    cached = {
      config: { host: envHost, projectKey: envKey, personalApiKey: envPersonal ?? envKey },
      source: 'env',
      testingFeatures: envLive,
    };
    return cached;
  }

  const discoveryPath = path.join(os.homedir(), '.papercusp', 'posthog.json');
  try {
    const raw = fs.readFileSync(discoveryPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PostHogConfig> & {
      host?: string;
      testingFeatures?: boolean;
    };
    // Default `testingFeatures` to FALSE: with PostHog discovered but not
    // opted in, we still serve flags from FLAG_DEFAULTS (bundled). The
    // user has to explicitly toggle live updates on for the operator to
    // make any outbound call to PostHog.
    const testingFeatures = parsed.testingFeatures === true;
    if (parsed.host && parsed.projectKey && parsed.personalApiKey) {
      cached = {
        config: {
          host: parsed.host,
          projectKey: parsed.projectKey,
          personalApiKey: parsed.personalApiKey,
        },
        source: testingFeatures ? 'discovery-file' : 'discovery-file-opt-out',
        testingFeatures,
      };
      return cached;
    }
  } catch {
    // missing or malformed — fall through to unconfigured
  }

  cached = { config: null, source: 'unconfigured', testingFeatures: false };
  return cached;
}
