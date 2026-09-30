/**
 * EI-19415249247575123 — a `not_found` returned while this process is KNOWN to have talked
 * to the wrong Postgres cluster must not read as a clean absence.
 *
 * ## The bug this closes
 *
 * `libs/papercusp/libs/db/src/store-identity.ts` already detects the wrong-store condition
 * and already says exactly the right thing about it — `describeStoreIdentityMismatch()`
 * contains, verbatim: *"Any 'not found' / empty result returned since this point is NOT
 * evidence of data loss. It is a correct answer from the wrong database."*
 *
 * So this was never a missing mechanism. It was **a mechanism nobody on the answering path
 * consulted**: before this module the latch had exactly two consumers (`dev/pg_health.ts`
 * and `loop/status.ts`), and both are *diagnostics* — you have to already suspect a problem
 * to call them, which is precisely the state a clean `not_found` prevents you from reaching.
 * Meanwhile ~60 files under `agent-tools/` emit a `not_found`-shaped verdict and none of
 * them looked at it.
 *
 * The failure mode is therefore not "an error was unclear". It is that a degraded system
 * returned a **well-formed, confident, plausible wrong answer** — the single most expensive
 * shape available here, because an agent that trusts it concludes its plan/work-item was
 * deleted and may recreate it or redirect its lane. That is the concrete history:
 * EI-19413194783966160 (a `plans:get` not_found on a plan that was healthy in PG,
 * root-caused to the `~/.papercusp/embedded-pg.json` repoint of EI-19415283166388163).
 *
 * ## Why it lives at the MCP result seam
 *
 * `_mcp-handler.ts` is where every model-facing agent-tool result converges (the same
 * reason `applyResultDoor` and the workspace/harness clamp are applied there). One edit
 * covers all ~60 emitting files *and every future one* — wiring 60 call sites would be the
 * opposite of reuse-first, and would re-open the class silently the next time a tool grows
 * a `not_found`.
 *
 * Lives in its own module rather than inline in `_mcp-handler.ts` so it can be unit tested
 * without importing the whole MCP handler (and its tool catalog + PG deps) — the same
 * rationale as its sibling `idle-tx-warning.ts`.
 */

import type { ResultDoorSkipReason } from '@papercusp/tooldef';
import { describeStoreIdentityMismatch, storeIdentityViolation } from '@papercusp/db-org';

/**
 * May prose be APPENDED to this tool's result body?
 *
 * WI-37843. This used to be spelled `!projected.skipResultDoor` at the call
 * site, which quietly asserted that "skips the size door" implies "cannot
 * accept prose". Those are different properties, and once a MODEL-FACING tool
 * needed the door exemption (coord:orient, whose full payload is the point),
 * the conflation started suppressing a warning its reader most needs — a
 * bootstrap read is exactly where "this not_found may be a correct answer from
 * the WRONG database" changes what the agent does next.
 *
 * Only a PROGRAMMATIC consumer needs a byte-clean body: it `json.loads`s the
 * raw text, so any appended prose makes the parse throw and the caller fails
 * open silently (EI-19386201256023240). Everyone else — doored or not — is a
 * model, and gets the prose.
 *
 * Named and exported rather than inlined so the rule is assertable on its own,
 * without standing up the MCP handler to observe it.
 */
export function mayAnnotateResultText(skipResultDoor: ResultDoorSkipReason | undefined): boolean {
  return skipResultDoor !== 'programmatic-caller';
}

/** The minimal result shape this module touches (mirrors result-door.ts's doorable type). */
export interface StoreIdentitySuspectResult {
  content: ReadonlyArray<{ type?: string; text?: string } | Record<string, unknown>>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/** Injectable, so a test can drive the state machine without a real PG pool. */
export interface StoreIdentitySuspectDeps {
  violation: typeof storeIdentityViolation;
  describe: typeof describeStoreIdentityMismatch;
}

const defaultDeps: StoreIdentitySuspectDeps = {
  violation: storeIdentityViolation,
  describe: describeStoreIdentityMismatch,
};

/**
 * Matches a `not_found`-shaped VERDICT, deliberately keyed on the field name rather than
 * on the bare token.
 *
 * Precision over recall, on purpose. A bare /not_found/ would also fire on a tool whose
 * *description*, guidance or documentation prose merely mentions the string — annotating a
 * perfectly good result with a scary warning and teaching readers to ignore the warning.
 * The keyed form matches what the emitting sites actually serialize:
 *
 *   { ok: false, error: 'not_found' }        -> "error":"not_found"
 *   { ok: false, code: 'item_not_found' }    -> "code":"item_not_found"
 *
 * NOT matched, deliberately: an empty collection (`results: []`). Under a latched violation
 * an empty list IS equally untrustworthy, but "empty" is indistinguishable from the
 * overwhelmingly common legitimate empty answer, so matching it would annotate most of the
 * fleet's traffic and destroy the signal. The null/empty-shaped case is instead covered at
 * the two surfaces that already consult the latch directly (`dev:pg_health`, `loop:status`).
 */
const NOT_FOUND_VERDICT = /"(?:error|code|reason|status|verdict)"\s*:\s*"[a-zA-Z]*_?not_?found"/i;

/** True when `text` carries a not_found-shaped verdict. Exported for the recurrence guard. */
export function looksLikeNotFoundVerdict(text: string): boolean {
  return NOT_FOUND_VERDICT.test(text);
}

/**
 * The banner prepended to a suspect result.
 *
 * PREPENDED, not appended (the result-door appends its footer): the door's footer is a
 * pointer to a spill — secondary information that is fine to read last. This banner
 * *inverts the meaning of the answer beneath it*, so it must be impossible to read the
 * answer without first reading the warning.
 */
export function storeIdentitySuspectBanner(detail: string): string {
  return (
    `🚨 THIS "NOT FOUND" IS NOT EVIDENCE OF ABSENCE — read before acting on the result below.\n` +
    `This process has talked to a DIFFERENT Postgres cluster than the one it pinned, so the\n` +
    `answer below may be a correct response from the WRONG database. Do NOT conclude the\n` +
    `object was deleted or archived, and do NOT re-create, "restore" or redirect a lane on\n` +
    `the strength of it. Treat this result as UNKNOWN, not as absent.\n` +
    `${detail}\n` +
    `--- original tool result follows (EI-19415249247575123) ---\n`
  );
}

/**
 * Annotate a `not_found`-shaped result when — and only when — this process has a latched
 * store-identity violation.
 *
 * Ordering is deliberate: the latch is checked FIRST. `violation()` is a module-level
 * variable read, so the entire hot-path cost for the overwhelmingly common healthy case is
 * one null check — no regex, no serialization, no allocation. Result inspection happens
 * only in the already-broken case.
 *
 * @param annotateText when false, only `_meta` is stamped and the body is left byte-identical.
 *   Pass `!projected.skipResultDoor`: a tool whose near-exclusive caller is programmatic
 *   (a shell hook `json.loads`-ing the raw body) must keep a parseable body, exactly as
 *   EI-19386201256023240 established for the result door. Machine callers get the
 *   machine-readable `_meta` marker; model-facing callers get the prose they will actually read.
 *
 * Fail-soft: any error while inspecting or annotating returns the ORIGINAL result untouched.
 * This sits on the universal MCP result path — it must never be able to break a tool call.
 */
export function annotateStoreIdentitySuspectResult<T extends StoreIdentitySuspectResult>(
  result: T,
  annotateText: boolean = true,
  deps: StoreIdentitySuspectDeps = defaultDeps,
): T {
  try {
    // Latch first — see above. Non-null only after two successfully-read, genuinely
    // disagreeing store identities, so this is a rare and serious condition.
    const violation = deps.violation();
    if (!violation) return result;

    const items = result.content;
    if (!Array.isArray(items) || items.length === 0) return result;

    const firstTextIdx = items.findIndex(
      (it): it is { type?: string; text?: string } =>
        typeof (it as { text?: unknown } | null)?.text === 'string',
    );
    if (firstTextIdx < 0) return result;

    const originalText = (items[firstTextIdx] as { text?: string }).text ?? '';
    if (!looksLikeNotFoundVerdict(originalText)) return result;

    const detail = deps.describe(violation.pinned, violation.observed);

    const suspectMeta = {
      storeIdentitySuspect: {
        // The caller-facing verdict: this is the field a programmatic consumer reads.
        verdict: 'not-found-is-unreliable' as const,
        reason:
          'a store-identity violation is latched, so this not_found may be a correct answer from the wrong database',
        pinned: violation.pinned,
        observed: violation.observed,
        detail,
        issue: 'EI-19415249247575123',
      },
    };

    if (!annotateText) {
      return { ...result, _meta: { ...(result._meta ?? {}), ...suspectMeta } };
    }

    const annotated = items.slice();
    annotated[firstTextIdx] = {
      ...(items[firstTextIdx] as Record<string, unknown>),
      text: `${storeIdentitySuspectBanner(detail)}${originalText}`,
    };

    return {
      ...result,
      _meta: { ...(result._meta ?? {}), ...suspectMeta },
      content: annotated,
    };
  } catch {
    // Never let a diagnostic break the call it is diagnosing.
    return result;
  }
}
