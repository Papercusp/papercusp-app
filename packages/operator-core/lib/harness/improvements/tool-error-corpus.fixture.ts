/**
 * tool-error-corpus.fixture.ts — a committed snapshot of the LIVE high-volume
 * distinct error shapes from `harness_shared.tool_invocations`, each pinned to
 * the `ToolErrorClass` it must classify as
 * (watchdog-and-exposed-systems-improvement-2026-06-18 P-011).
 *
 * Most rows were sampled 2026-06-18 from the dev workspace over a 14-day window
 * (≈298k error/timeout rows). `n` is the bucket's occurrence count at capture —
 * it ranks "how much a misclassification would FLOOD a lane", not a live value;
 * it's here for legibility, not asserted. The shapes (error_code / status /
 * message-prefix) are the load-bearing part and rarely change.
 * The nested checkpoint-refusal row was added 2026-10-01 from a 24h sample (n=15).
 * The acceptance-BAR vetting refusal was added 2026-10-01 from the repeated
 * watchdog sample (n=3) to keep caller-authored readiness failures out of the
 * structural repair lane.
 * The reviewer-model allowlist refusal was added 2026-10-03 from EI-24950089856585512.
 * Kernel identity-ceiling refusals were added 2026-10-01 from a 24h sample
 * (n=33/16) to keep expected no-grant identities out of the structural lane.
 * The operator admission-shed row was added 2026-10-02 from the retryable
 * `loop_pressure_critical` response captured in EI-24856174754316507.
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
  {
    n: 1, errorCode: '-32000', status: 'request shed',
    message: 'operator MCP admission is saturated — request shed; reason=loop_pressure_critical',
    expectedClass: 'transient',
    note: 'the operator admission gate explicitly shed this call for critical loop pressure; retryable shared backpressure, not a per-tool bug',
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
    n: 1, errorCode: 'invalid_args', status: 'invalid_input',
    message: 'Nested code:run rejected timeoutSec=60 because the live maximum is 45 seconds; use 45 or less.',
    expectedClass: 'caller',
    note: '`timeoutSec` is an argument name, not an elapsed-timeout outcome; preserve the caller classification (EI-25198945153644636)',
  },
  {
    n: 3, errorCode: 'mcp_auth_failed', status: 'error',
    message: 'superuser_invalid_bearer',
    expectedClass: 'caller',
    note: 'MCP auth gate recorded an invalid-bearer refusal before dispatch; keep this credential rejection out of the structural bug lane (EI-24772367245361033)',
  },
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
  {
    n: 15, errorCode: 'handler_error', status: 'error',
    message: '{"ok":false,"error":"checkpoint_replace_would_drop_rows","errorCode":"checkpoint_replace_would_drop_rows","retryable":true}',
    expectedClass: 'caller',
    note: 'nested tools:invoke wrapper preserves a deliberate checkpoint safety refusal in JSON error_message; it is caller-directed, not structural',
  },
  {
    n: 14, errorCode: 'handler_error', status: 'error',
    message: '{"ok":false,"requested":false,"error":"flush-required","tripwires":[{"kind":"missing-checkpoint","subject":"WI-10004595"}]}',
    expectedClass: 'caller',
    note: 'nested tools:invoke wrapper preserves the intentional compaction flush-gate refusal; missing checkpoints are an actionable caller precondition, not a structural tool defect',
  },
  {
    n: 1, errorCode: 'rubric-not-found', status: 'error',
    message: 'rubric not found',
    expectedClass: 'caller',
    note: 'rubrics:get rejected an unsupported rubricRef@revision form; revision is supplied separately as a numeric argument',
  },
  {
    n: 3, errorCode: 'handler_error', status: 'error',
    message: 'acceptance BAR contract is not ready for vetting — 7 of 7 BAR(s) blocking, 0 clean: R-1: bar_snapshot_role_invalid; R-2: bar_snapshot_role_invalid; R-3: bar_snapshot_role_invalid; R-4: bar_snapshot_role_invalid; R-5: bar_snapshot_role_invalid; R-6: bar_snapshot_role_invalid; R-7: bar_snapshot_role_invalid',
    expectedClass: 'caller',
    note: 'the caller-authored BAR roles fail lifecycle pre-vetting; deterministic readiness refusal is caller input, not a structural tool defect',
  },
  {
    n: 1, errorCode: 'handler_error', status: 'error',
    message: 'reviewer_model_not_allowed: codex/gpt-6.1-sol is absent from the workspace expert allowlist',
    expectedClass: 'caller',
    note: 'explicit reviewer-model allowlist refusal for the caller-selected model; do not promote it as a structural tool bug (EI-24950089856585512)',
  },
  {
    n: 3, errorCode: 'unauthorized', status: 'error',
    message: 'coord:ask is owner-UI-only; agents must use coord:send or coord:message-agent.',
    expectedClass: 'caller',
    note: 'agent invocation of an owner-UI-only surface is an expected permission precondition; keep the generic unauthorized workspace-scope error structural (D-007)',
  },
  {
    n: 33, errorCode: 'authorization_denied', status: 'error',
    message: 'Kernel preflight denied tool "sessions:ingest-gate-event": Identity capability (unresolved): outside-ceiling (sessions:ingest-gate-event)',
    expectedClass: 'caller',
    note: 'the caller identity has no authored grant for this tool; expected kernel refusal, not a structural tool defect',
  },
  {
    n: 16, errorCode: 'authorization_denied', status: 'error',
    message: 'Kernel preflight denied tool "journal:record-turn": Identity capability (unresolved): outside-ceiling (journal:record-turn)',
    expectedClass: 'caller',
    note: 'the caller identity has no authored grant for this tool; expected kernel refusal, not a structural tool defect',
  },
  {
    n: 3, errorCode: 'handler_error', status: 'error',
    message: 'missing_capability: Principal "system:judge" lacks capability "intel:read" (tool: dev:pg_query) — This is a judge-scoped MCP session; this principal lacks intel:read for dev:pg_query. `tools:invoke` preserves the same judge principal, so do not retry it in this session: it will be denied identically. Use a separate authorized su/operator session through the papercusp-su MCP server to invoke the tool.',
    expectedClass: 'caller',
    note: 'tools:invoke preserves the judge principal and wraps this expected missing_capability refusal as handler_error; the preserved code prefix must route to caller, not the structural bug lane',
  },
  {
    n: 1, errorCode: 'handler_error', status: 'error',
    message: 'watch:create — predicate registration failed its inline first eval (unwound): predicate_shape_mismatch: observed hex SHA is 40 characters but the operand is 10 characters; they are strict-prefix forms. Supply the same SHA width before registering this predicate.',
    expectedClass: 'caller',
    note: 'state:subscribe delegates predicate registration; a strict-prefix SHA operand is an intentional caller-input refusal that prevents a false wake, not a structural tool defect (EI-24876630811914890)',
  },
  {
    n: 1, errorCode: 'context_mismatch', status: 'rejected',
    message: 'Patch verification could not find the expected workspace-map heading and path lines in apps/operator/prompts/pot-instances/papercup-pot.su.md; no files were changed.',
    expectedClass: 'caller',
    note: 'apply_patch rejected mismatched expected hunk context before writing; refresh the current file text (EI-24740711211595015)',
  },
  {
    n: 1, errorCode: 'verification_failed', status: '',
    message: 'A three-file resource-governor repair patch was rejected before writing because I matched a long project-doc-parts disposition line with abbreviated text. Corrected patch will anchor on the unique array terminator and use short exact hunks.',
    expectedClass: 'caller',
    note: 'the report identifies abbreviated patch context as the caller error; no Papercusp tool defect is evidenced (EI-23737545927303638)',
  },
  {
    n: 1, errorCode: 'verification-failed', status: 'patch-context-mismatch',
    message: 'A one-file patch was rejected because one expected source line did not match exactly. The patch applied nothing. Re-read the exact line context and reformulate the single-file patch.',
    expectedClass: 'caller',
    note: 'the patch tool refused stale/mismatched hunk context before writing; re-read the exact source lines (EI-25197457482157766)',
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
