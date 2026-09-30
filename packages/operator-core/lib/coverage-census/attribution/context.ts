/**
 * Test-attribution CONTEXT — who is calling, under which run, in which scope.
 *
 * Plan: deterministic-coverage-census-2026-08-17 (P-004).
 *
 * THE PROBLEM THIS SOLVES. P-003's providers answer "what surfaces exist". The census is
 * worthless without the other half — "which test exercised which surface" — and that binding
 * can only be observed at the moment the call happens, from inside the process serving it.
 * This module is the identity half of that observation: it decides whether attribution is ARMED
 * at all, and resolves the (run, test file, test case, scope) tuple an evidence row needs.
 *
 * ⚠ ARMING IS EXPLICIT AND DEFAULT-OFF, AND THAT IS DELIBERATE — NOT TIMIDITY.
 * This is not a product feature shipped dark (which the repo rightly bans); it is TEST-ONLY
 * instrumentation, and the arming switch is launch-time test config, which is exactly what env
 * is still for. Arming on "am I under vitest" instead would fire inside the UNIT layer, whose
 * `setup-no-real-pg.ts` rail forbids a real PG connection — the sink would then spend every
 * unit test failing to connect. Arming on "is a run group set" would silently arm any process
 * that inherited the env from a parent. So the switch is one env var, read once.
 *
 * WHY TWO SOURCES FOR THE TEST IDENTITY, IN THIS PRECEDENCE:
 *   1. HEADERS (`x-papercusp-test-*`) — the CROSS-PROCESS case: a test in one process drives an
 *      operator in another. The caller is the only one who knows which test it is, so it must
 *      say so on the wire. Explicit beats ambient, always.
 *   2. THE AMBIENT SLOT — the IN-PROCESS case: the Hono app / MCP dispatcher runs inside the
 *      vitest fork, so the current test is already known locally (written by the vitest setup
 *      file in `setup-vitest.ts`). No wire format can carry this, because there is no wire.
 * A call that resolves NEITHER still produces a row keyed to the run group with a null test
 * file — that is honest ("something in this run hit this surface") and is exactly the
 * `test_case IS NULL` case migration 846 documents as file-level-only evidence.
 *
 * WHY THE AMBIENT SLOT IS PINNED (`pinModuleState`) rather than a plain module-scoped `let`:
 * the setup file and the dispatcher hooks are reached by different specifiers under vitest's
 * loader (workspace symlink vs relative path), which is the documented module-record split.
 * A split here does not throw — it silently reads an ambient slot nobody ever wrote, so every
 * row lands with a null test file and the census looks like it merely has weak evidence. That
 * failure is indistinguishable from the real thing, which is why it gets the primitive rather
 * than a hand-rolled global.
 */

import { pinModuleState } from '@papercusp/module-singleton';

/** Header names carrying test identity across a process boundary. Lower-case: Hono normalizes. */
export const TEST_RUN_GROUP_HEADER = 'x-papercusp-test-run-group';
export const TEST_FILE_HEADER = 'x-papercusp-test-file';
export const TEST_CASE_HEADER = 'x-papercusp-test-case';

/** The one arming switch. Test config, not a product flag — see the file header. */
export const ATTRIBUTION_ENV = 'PAPERCUSP_TEST_ATTRIBUTION';

/**
 * The UNIT layer's rail (`libs/test-config/src/setup-no-real-pg.ts`), which forbids a real
 * PG connection.
 *
 * It gates the SINK'S STORE RESOLUTION, not arming — see `sink.ts`'s `resolveStore`. The
 * distinction is load-bearing and was got wrong once: disarming on this rail also suppresses
 * OBSERVATION, which breaks every unit test that exercises the hooks against an injected
 * fake store and needs no database at all. What the rail actually forbids is one specific
 * thing — opening a real connection — so that is the only thing it may veto.
 */
export const FORBID_REAL_PG_ENV = 'PAPERCUSP_FORBID_REAL_PG';

/** Which test is executing in THIS process, when the dispatcher runs inside the test fork. */
export interface AmbientTestContext {
  /** Repo-relative test file path, matching `test_runs.file_path` so the two join. */
  file: string | null;
  /** Full test name (`describe > it`), or null when only file-level identity is known. */
  case: string | null;
}

interface AttributionState {
  /** Written by the vitest setup file, read by the dispatcher hooks. Null between tests. */
  ambient: AmbientTestContext | null;
  /** Arming decision, resolved once per process. `null` = not yet resolved. */
  armed: boolean | null;
}

const state = pinModuleState<AttributionState>(
  '@papercusp/operator-core.coverage-census.attribution.context',
  () => ({ ambient: null, armed: null }),
);

/**
 * Is test attribution armed in this process?
 *
 * Cached after the first read, so the dispatcher hot path pays one boolean load. Tests that
 * need to flip it call {@link resetAttributionArmingForTests}; nothing else may, because a
 * mid-run flip would produce a run whose evidence covers only part of the suite — worse than
 * either all or none, since a partial census reads as a real coverage gap.
 */
export function isAttributionArmed(): boolean {
  if (state.armed === null) state.armed = process.env[ATTRIBUTION_ENV] === '1';
  return state.armed;
}

/** Re-read the arming env. Test-only seam — see {@link isAttributionArmed}. */
export function resetAttributionArmingForTests(): void {
  state.armed = null;
}

/**
 * The run this process belongs to. Reused from `testing:run` / the green-checkpoint gate /
 * the admin-UI runner, which ALL already stamp it (`PAPERCUSP_TEST_RUN_GROUP`) so their
 * `test_runs` rows are groupable. Minting a second id here would split evidence and run rows
 * into two correlation spaces that nothing could join.
 */
export function currentRunGroupId(): string | null {
  return process.env.PAPERCUSP_TEST_RUN_GROUP || null;
}

/** Set the ambient test identity. Called by the vitest setup file's `beforeEach`. */
export function setAmbientTestContext(ctx: AmbientTestContext | null): void {
  state.ambient = ctx;
}

export function getAmbientTestContext(): AmbientTestContext | null {
  return state.ambient;
}

/** Census scope for evidence rows — must match the scope the census wrote surfaces under. */
export interface AttributionScope {
  workspaceId: string;
  harnessSlug: string;
}

/**
 * Resolve the census scope — by DELEGATING to the same resolver the census itself uses to
 * scope the surfaces these rows join to (`../scope`, Decision D-011).
 *
 * ⚠ THIS FUNCTION USED TO RE-DERIVE THE SCOPE FROM ENV, AND THAT MADE THE WHOLE LAYER A
 * NO-OP. It mirrored the test-runs reporter's variables on the reasoning that a run's
 * `test_runs` rows and its evidence rows should land in one scope — but nothing sets those
 * variables: measured 2026-08-18, `harness_slug` was NULL on 100% of the 7,202 `test_runs`
 * rows written in the preceding 90 minutes, and neither live operator host had any of them
 * in its environment. So the "shared" scope was `(NULL, NULL)`, this function returned null
 * on every flush, and the sink dropped every buffer it ever filled. The full measurement is
 * in `../scope.ts`; the lesson is that a derivation agreeing with another derivation IN
 * PRINCIPLE is not evidence that either one resolves IN FACT.
 *
 * Deliberately ASYNC and dynamically imported. The scope module reaches the workspace
 * registry, and this file is on the import path of every Hono route stack — a static import
 * would pull that graph into a production request that will never attribute anything. The
 * dynamic import is reached only from {@link flushTrafficEvidence}, i.e. only in a process
 * that is armed AND has observed traffic, which keeps "inert when disarmed" literally true.
 *
 * Still returns `AttributionScope | null`: the resolver itself is total, but a throwing
 * registry read must never propagate into the request this layer is only describing. Null
 * therefore now means "scope resolution FAILED", not "scope was not configured".
 */
export async function resolveAttributionScope(): Promise<AttributionScope | null> {
  try {
    const { resolveCensusScope } = await import('../scope');
    return resolveCensusScope();
  } catch {
    return null;
  }
}

/** The caller identity for one observed call, however it was carried. */
export interface ResolvedCaller {
  runGroupId: string | null;
  testFile: string | null;
  testCase: string | null;
}

/** Minimal shape of the header bag — `Headers`, or anything with a `get`. */
export interface HeaderLike {
  get(name: string): string | null | undefined;
}

/**
 * Resolve WHO is calling: explicit headers first, ambient slot second, per the file header's
 * precedence rule. `headers` is omitted for the MCP path, which has no request object.
 */
export function resolveCaller(headers?: HeaderLike | null): ResolvedCaller {
  const header = (name: string): string | null => {
    if (!headers) return null;
    try {
      const v = headers.get(name);
      return typeof v === 'string' && v.length > 0 ? v : null;
    } catch {
      // A malformed/foreign header bag must never break the request it is decorating.
      return null;
    }
  };

  const ambient = state.ambient;
  return {
    runGroupId: header(TEST_RUN_GROUP_HEADER) ?? currentRunGroupId(),
    testFile: header(TEST_FILE_HEADER) ?? ambient?.file ?? null,
    testCase: header(TEST_CASE_HEADER) ?? ambient?.case ?? null,
  };
}

/**
 * The headers a cross-process test spreads into its request so the operator can attribute it.
 *
 * Exported rather than installed as a global `fetch` patch on purpose: a global patch would
 * decorate EVERY outbound request in the process — including ones to third-party hosts — and
 * leak the repo's test-file paths off-box. An explicit spread is one line at the call site and
 * cannot do that.
 */
export function testAttributionHeaders(): Record<string, string> {
  const caller = resolveCaller(null);
  const out: Record<string, string> = {};
  if (caller.runGroupId) out[TEST_RUN_GROUP_HEADER] = caller.runGroupId;
  if (caller.testFile) out[TEST_FILE_HEADER] = caller.testFile;
  if (caller.testCase) out[TEST_CASE_HEADER] = caller.testCase;
  return out;
}
