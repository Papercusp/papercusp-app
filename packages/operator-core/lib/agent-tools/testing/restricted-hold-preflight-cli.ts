/**
 * Process face of the restricted-write fence for the RAW test router (WI-10005713, follow-up of
 * WI-10005634 — plan personal-data-reader-set-labels-2026-10-01, BAR R-11, Decision D-012).
 *
 * `testing:run` calls `restrictedHoldRefusal` in-process before it spawns `scripts/test-files.mjs`.
 * A raw `npm run test:file` reaches that router without `testing:run`, so the router spawns THIS
 * entry (via `node --import tsx`) before it starts vitest. One implementation, two doors: the
 * router never re-implements the census or the reach walk, so "refused by testing:run" and
 * "refused by the raw router" cannot drift apart.
 *
 * The host bundler (apps/operator/bin/bundle-restricted-hold-gate.mjs, WI-10005745) uses the
 * same entry in its bundle mode: an exact intersection of held paths with the bundle's inputs.
 *
 * The shell doors that boot the app from the live tree (papercusp-desktop/bin/tauri-guarded `dev`,
 * scripts/verify-tauri-headless.sh — WI-10005763) use its tree mode: any held write under a root.
 *
 * Usage:  node --import tsx restricted-hold-preflight-cli.ts <checkout-root> [test-file ...]
 *         node --import tsx restricted-hold-preflight-cli.ts --bundle-inputs <inputs.json> <checkout-root>
 *         (inputs.json = `{ "files": [abs...], "dirs": [abs...] }`)
 *         node --import tsx restricted-hold-preflight-cli.ts --tree <checkout-root> [<checkout-root> ...]
 * Output: exactly one stdout line `RESTRICTED_HOLD_PREFLIGHT <json>` where json is
 *         `{ "verdict": "admit" }` or `{ "verdict": "refuse", "error": ..., "hint": ... }`.
 * Exit:   0 admit · 3 refuse · 2 misuse. The router fails CLOSED on anything else (no line, bad
 *         JSON, a crash, a timeout), so a broken preflight can never read as an admit.
 */
import { readFile } from 'node:fs/promises';
import { RESTRICTED_HOLD_PREFLIGHT_EXIT, RESTRICTED_HOLD_PREFLIGHT_MARKER } from '../../../../../scripts/lib/restricted-hold-preflight.mjs';
import {
  restrictedHoldBundleRefusal,
  restrictedHoldRefusal,
  restrictedTreeHoldRefusal,
  type BundleInputs,
  type RestrictedHoldRefusal,
} from './restricted-hold-fence';
import type { RestrictedEditHolding } from '../../personal-vault/git-sync-hold';

function emit(payload: Record<string, unknown>, exitCode: number): void {
  // The census opens a Postgres pool that would keep the event loop alive; exit explicitly, but
  // only after stdout has flushed — a pipe write is asynchronous, and the router parses this line.
  process.stdout.write(`${RESTRICTED_HOLD_PREFLIGHT_MARKER} ${JSON.stringify(payload)}\n`, () => process.exit(exitCode));
}

function misuse(hint: string): void {
  emit({ verdict: 'refuse', error: 'restricted_hold_state_unknown', hint }, RESTRICTED_HOLD_PREFLIGHT_EXIT.misuse);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * TEST-ONLY census seam for every mode (EI-24917607035361603): unit tests drive
 * bundle-host.sh end to end, and its gate would otherwise open the real org-admin Postgres,
 * which the unit guard refuses, so every bundler test failed closed. The tree-door tests use it,
 * and the committed-source loader tests use it in router mode to force the closure worker fork
 * (WI-10005764). Honored only when BOTH
 * VITEST (set by vitest and inherited by everything a test spawns) and this variable are set;
 * a systemd/CLI bundle never has VITEST, so the live gate always reads the real census.
 * A file that is not a JSON array refuses (fail-closed), never admits.
 */
const TEST_CENSUS_ENV = 'PAPERCUSP_RESTRICTED_HOLD_CENSUS_FILE';

async function injectedTestCensus(): Promise<RestrictedEditHolding[] | 'invalid' | null> {
  const file = process.env[TEST_CENSUS_ENV];
  if (!process.env.VITEST || !file) return null;
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(parsed) ? (parsed as RestrictedEditHolding[]) : 'invalid';
  } catch {
    return 'invalid';
  }
}

async function readBundleInputs(path: string): Promise<BundleInputs | null> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object') return null;
  const { files, dirs } = parsed as { files?: unknown; dirs?: unknown };
  if (!isStringArray(files) || !isStringArray(dirs)) return null;
  return { files, dirs };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let refusal: RestrictedHoldRefusal | null;
  if (args[0] === '--bundle-inputs') {
    const [, inputsPath, root] = args;
    if (!inputsPath || !root) {
      misuse('restricted-hold bundle preflight needs --bundle-inputs <inputs.json> <checkout-root>');
      return;
    }
    const inputs = await readBundleInputs(inputsPath);
    if (!inputs) {
      misuse(`restricted-hold bundle preflight could not read ${inputsPath} as { files: string[], dirs: string[] }`);
      return;
    }
    const injected = await injectedTestCensus();
    if (injected === 'invalid') {
      misuse(`${TEST_CENSUS_ENV} must name a JSON array of restricted holdings ([] = nothing held)`);
      return;
    }
    refusal = await restrictedHoldBundleRefusal(root, inputs, injected ? { holdings: async () => injected } : {});
  } else if (args[0] === '--tree') {
    const roots = args.slice(1);
    if (roots.length === 0) {
      misuse('restricted-hold tree preflight needs --tree <checkout-root> [<checkout-root> ...]');
      return;
    }
    const injected = await injectedTestCensus();
    if (injected === 'invalid') {
      misuse(`${TEST_CENSUS_ENV} must name a JSON array of restricted holdings ([] = nothing held)`);
      return;
    }
    refusal = await restrictedTreeHoldRefusal(roots, injected ? { holdings: async () => injected } : {});
  } else {
    const [root, ...files] = args;
    if (!root) {
      misuse('restricted-hold preflight was started without a checkout root');
      return;
    }
    const injected = await injectedTestCensus();
    if (injected === 'invalid') {
      misuse(`${TEST_CENSUS_ENV} must name a JSON array of restricted holdings ([] = nothing held)`);
      return;
    }
    refusal = await restrictedHoldRefusal(root, files, injected ? { holdings: async () => injected } : {});
  }
  if (refusal) emit({ verdict: 'refuse', ...refusal }, RESTRICTED_HOLD_PREFLIGHT_EXIT.refuse);
  else emit({ verdict: 'admit' }, RESTRICTED_HOLD_PREFLIGHT_EXIT.admit);
}

main().catch((error: unknown) => {
  emit(
    {
      verdict: 'refuse',
      error: 'restricted_hold_state_unknown',
      hint: `restricted-hold preflight crashed; nothing was started or published (${error instanceof Error ? error.message : String(error)})`,
    },
    RESTRICTED_HOLD_PREFLIGHT_EXIT.refuse,
  );
});
