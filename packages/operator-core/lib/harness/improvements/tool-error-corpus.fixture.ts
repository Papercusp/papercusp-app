/**
 * tool-error-corpus.fixture.ts — a committed snapshot of the LIVE high-volume
 * distinct error shapes from `harness_shared.tool_invocations`, each pinned to
 * the `ToolErrorClass` it must classify as
 * (watchdog-and-exposed-systems-improvement-2026-06-18 P-011).
 *
 * Sampled 2026-06-18 from the dev workspace over a 14-day window
 * (≈298k error/timeout rows). `n` is the bucket's occurrence count at capture —
 * it ranks "how much a misclassification would FLOOD a lane", not a live value;
 * it's here for legibility, not asserted. The shapes (error_code / status /
 * message-prefix) are the load-bearing part and rarely change.
 *
 * This fixture is the corpus for BOTH:
 *   - tool-error-classifier.test.ts (pure: classifyToolError must agree per row), and
 *   - tool-error-classifier.integration.test.ts (the GENERATED SQL CASE run over
 *     these rows in real PG must agree with classifyToolError row-by-row).
 *
 * Refresh procedure (when the live distribution shifts materially): re-run the
 * bucket query in the test header and re-pin any NEW high-volume shape to its
 * correct class. A new shape that lands in the wrong class is exactly the
 * regression this fixture exists to catch.
 */
import type { ToolErrorClass } from './tool-error-classifier';

export interface ToolErrorCorpusRow {
  /** Bucket occurrence count at capture (ranking only — not asserted). */
  readonly n: number;
  readonly errorCode: string | null;
  readonly status: string;
  /** A representative real error_message for the bucket. */
  readonly message: string;
  /** The class this shape MUST classify as. */
  readonly expectedClass: ToolErrorClass;
  /** Why — legibility for the next maintainer; flags the borderline calls. */
  readonly note: string;
}

export const TOOL_ERROR_CORPUS: readonly ToolErrorCorpusRow[] = [
  // ── transient: timeouts (by far the highest-volume shape) ──────────────────
  {
    n: 287629, errorCode: null, status: 'timeout',
    message: 'tool "plans:list" exceeded timeout of 60s (handler returned but signal had aborted)',
    expectedClass: 'transient',
    note: 'plain timeout (status=timeout) — load, never a tool bug',
  },
  {
    n: 41, errorCode: 'timeout', status: 'timeout',
    message: 'tool "memory:remember" exceeded timeout of 60s (handler returned but signal had aborted)',
    expectedClass: 'transient',
    note: 'first-class timeout error_code',
  },
  {
    n: 59, errorCode: null, status: 'timeout',
    message: 'tool "chat:ask_choice" exceeded timeout of 60s (handler returned but signal had aborted)',
    expectedClass: 'transient',
    note: 'interactive tool timeout',
  },

  // ── transient: shared-infra exhaustion (PG-wedge collateral) ───────────────
  {
    n: 365, errorCode: 'handler_error', status: 'error',
    message: 'sorry, too many clients already',
    expectedClass: 'transient',
    note: 'PG max_connections — recurs across every tool during a wedge; NOT a per-tool bug (the EI-1331..1344 collateral)',
  },
  {
    n: 266, errorCode: 'handler_error', status: 'error',
    message: 'remaining connection slots are reserved for roles with the SUPERUSER attribute',
    expectedClass: 'transient',
    note: 'PG superuser-reserved slots — shared-infra load',
  },
  {
    n: 2, errorCode: 'handler_error', status: 'error',
    message: 'write CONNECTION_CLOSED 127.0.0.1:6432',
    expectedClass: 'transient',
    note: 'postgres-js reaped a stale pooled connection PgBouncer (:6432) idle-closed server-side — provably transient (connect-retry.ts retries this exact code); MUST NOT file as a structural tool bug (EI-11010)',
  },
  {
    n: 1, errorCode: 'handler_error', status: 'error',
    message: 'write CONNECT_TIMEOUT 127.0.0.1:6432',
    expectedClass: 'transient',
    note: "postgres-js's pool connect() timed out — the sibling connection-setup code connect-retry.ts treats identically; transient, not a tool bug",
  },
  {
    n: 6, errorCode: 'handler_error', status: 'error',
    message: 'server shutting down',
    expectedClass: 'transient',
    note: 'operator shutdown-window response — transient lifecycle state, not a structural coord:glance bug (EI-20257122293248893)',
  },
  {
    n: 1, errorCode: 'sidecar_required_unavailable', status: 'degraded',
    message: 'sidecar_required_unavailable: semantic search sidecar at http://127.0.0.1:3384 aborted; lexical-only fallback returned',
    expectedClass: 'transient',
    note: 'shared embedding sidecar outage — degraded lexical fallback is infrastructure availability, not a per-tool structural bug',
  },

  // ── rate-limit: external provider 429 (capacity, not a code bug) ────────────
  {
    n: 388, errorCode: 'handler_error', status: 'error',
    message: 'openai_embed_failed_429: {\n    "error": {\n        "message": "Rate limit reached for text-embedding-3-small in organization org-ow9x7tJAs2Np on tokens per min (TPM)"',
    expectedClass: 'rate-limit',
    note: 'OpenAI embed TPM 429 — must NOT fall through to structural (P-002)',
  },
  {
    n: 70, errorCode: 'handler_error', status: 'error',
    message: 'openai_embed_failed_429: {\n    "error": {\n        "message": "Request too large for text-embedding-3-small in organization org-ow9x7tJAs2Npk on tokens per min (TPM)"',
    expectedClass: 'rate-limit',
    note: 'same capacity concern, different message body — stays one rate-limit class (NOT fingerprinted)',
  },

  // ── caller: bad input / scope (DX, not a tool bug) ─────────────────────────
  {
    n: 835, errorCode: 'handler_error', status: 'error',
    message: "resolvePlanScope: harness 'shared-hive-test' is not registered in harness_shared.projects in any workspace, so its plan workspace cannot be resolved",
    expectedClass: 'caller',
    note: 'unregistered harness — caller named a harness that does not exist',
  },
  {
    n: 3, errorCode: 'handler_error', status: 'error',
    message: "resolvePlanScope: plans are Hive-scoped, but 'sidestage-mobile' is not a Hive home and does not belong to one in workspace 'papercusp-workspace'. Add it to a Hive or pass the Hive home slug explicitly; refusing to create/read a non-Hive-scoped plan.",
    expectedClass: 'caller',
    note: 'registered standalone harness — caller must pass the Hive home that owns the plan store (EI-20459566365031398)',
  },
  {
    n: 39, errorCode: 'harness_required', status: 'error',
    message: 'No harness specified. `harness` is a per-call arg — pass it on THIS call (you don\'t need a differently-scoped session): a concrete slug for a managed harness',
    expectedClass: 'caller',
    note: 'harness_required error_code',
  },
  {
    n: 150, errorCode: null, status: 'error',
    message: 'invalid_args: note: Too big: expected string to have <=400 characters',
    expectedClass: 'caller',
    note: 'invalid_args: prefix, no error_code',
  },
  {
    // THE DRIFT REGRESSION GUARD: same message as above but with a handler_error
    // error_code. The old TS fn classified this `structural` (its error_code
    // branch never checked the `invalid_args:` message prefix) while the SQL said
    // `caller` (LIKE 'invalid_args:%'). The table-driven classifier makes them agree.
    n: 118, errorCode: 'handler_error', status: 'error',
    message: 'invalid_args: note: Too big: expected string to have <=400 characters',
    expectedClass: 'caller',
    note: 'P-011 DRIFT GUARD: handler_error + invalid_args: message — was structural in TS, caller in SQL; now caller in both',
  },
  {
    n: 36, errorCode: null, status: 'error',
    message: 'invalid_args: state: Invalid input: expected string, received undefined; next: Too big: expected string to have <=800 characters',
    expectedClass: 'caller',
    note: 'distinct caller mode under the same tool as the note-too-big one — P-012 fingerprint must separate them',
  },
  {
    n: 34, errorCode: null, status: 'error',
    message: 'invalid_args: status: Invalid option: expected one of "draft"|"ready"|"shipped"|"superseded"',
    expectedClass: 'caller',
    note: 'another distinct caller mode',
  },
  {
    n: 30, errorCode: 'handler_error', status: 'error',
    message: 'invalid_args: paths: Too small: expected array to have >=1 items',
    expectedClass: 'caller',
    note: 'handler_error + invalid_args: again',
  },
  {
    n: 30, errorCode: 'handler_error', status: 'error',
    message: 'invalid_args: wait.max_sec: Too big: expected number to be <=300',
    expectedClass: 'caller',
    note: 'yet another distinct caller mode (P-012 separation)',
  },
  {
    n: 5, errorCode: 'handler_error', status: 'error',
    message: 'capability:computer — no sandbox desktop is leased to this agent. A desktop must be provisioned first',
    expectedClass: 'caller',
    note: 'desktop-only capability used before provisioning its required lease — caller precondition, not a structural tool defect',
  },

  // ── structural: genuine bugs/misconfig (the low-bar auto-implement lane) ────
  {
    n: 2809, errorCode: 'handler_error', status: 'error',
    message: 'column "initiative" does not exist',
    expectedClass: 'structural',
    note: 'a real bug — a missing column; SHOULD reach the fix lane',
  },
  {
    n: 16, errorCode: null, status: 'error',
    message: 'new row for relation "engineer_issues" violates check constraint "engineer_issues_state_check"',
    expectedClass: 'structural',
    note: 'a real constraint-violation bug',
  },

  // ── structural by DESIGN (deliberate; D-007 / the CALLER_MESSAGE_PATTERN note) ──
  {
    n: 81, errorCode: null, status: 'error',
    message: 'built-in tool "memory:search" requires authenticated request (bearer + workspace tx)',
    expectedClass: 'structural',
    note: 'auth/scope wiring gap — deliberately structural (a wiring gap worth catching at the low bar)',
  },
  {
    n: 29, errorCode: null, status: 'error',
    message: 'built-in tool "memory:search" requires a workspace-scoped call — this session has no workspace transaction. Scope the session to a workspace',
    expectedClass: 'structural',
    note: 'workspace-scope gap — deliberately structural per D-007 (NOT folded into caller)',
  },
  {
    n: 22, errorCode: 'unauthorized', status: 'error',
    message: 'built-in tool "memory:search" requires a workspace-scoped call — this session has no workspace transaction. Scope the session to a workspace',
    expectedClass: 'structural',
    note: 'unauthorized code is not in the caller set — stays structural (design intent)',
  },
  {
    n: 28, errorCode: null, status: 'error',
    message: 'resolveAgentIdentity: superuser context is missing uiClientId — re-run install-standalone-mcp.sh to mint a ?client= id',
    expectedClass: 'structural',
    note: 'client-setup error — currently structural (a candidate caller refinement, deferred to P-006/P-007 territory)',
  },
  {
    // BORDERLINE (disclosed): a validation reject with no `invalid_args:` prefix.
    // Arguably caller, but kept structural to match current behavior — reclassifying
    // bare validation messages is a P-006/P-007 caller-DX refinement, out of P-011 scope.
    n: 141, errorCode: null, status: 'error',
    message: 'channel name too long',
    expectedClass: 'structural',
    note: 'BORDERLINE: bare validation reject (no invalid_args: prefix) — kept structural; flagged as a future caller-DX candidate',
  },
];
