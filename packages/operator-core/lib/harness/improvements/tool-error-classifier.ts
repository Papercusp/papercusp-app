/**
 * tool-error-classifier.ts — the SINGLE source of truth for how a failed
 * `harness_shared.tool_invocations` row is classified into a `ToolErrorClass`.
 *
 * The classification is consumed in TWO places that used to be "kept in sync"
 * by a comment and DRIFTED in practice
 * (watchdog-and-exposed-systems-improvement-2026-06-18 P-011):
 *   1. `classifyToolError` — the TS reference fn (the documented oracle).
 *   2. the SQL `CASE` that `watchdog.ts collectToolErrorSignals` runs to
 *      classify rows in-DB at scale.
 *
 * The drift was real: a `handler_error` row whose message starts
 * `"invalid_args: …"` classified `caller` in SQL (`LIKE 'invalid_args:%'`) but
 * `structural` in the TS fn (its error-code branch never checked the message
 * prefix). 100+ high-volume rows/day disagreed between the two.
 *
 * FIX: both the TS fn AND the SQL CASE are now GENERATED from one ordered
 * `TOOL_ERROR_RULES` table — they cannot drift by construction. The fixture
 * regression test (tool-error-classifier.test.ts) locks the live high-volume
 * buckets to their correct class; the integration test
 * (tool-error-classifier.integration.test.ts) runs the GENERATED SQL CASE over
 * the corpus and asserts row-by-row agreement with `classifyToolError`.
 *
 * ── Pattern dual-engine constraint (load-bearing) ─────────────────────────────
 * Every `messagePattern` below is a string that MUST be a valid regular
 * expression in BOTH:
 *   • Postgres `~*` (POSIX ERE, case-insensitive), and
 *   • JS `new RegExp(pattern, 'i')`.
 * The constructs we use — `|`, `?`, `*`, `+`, `^`, `(…)`, `[ _-]`, literal
 * chars — mean the same thing in both engines, so one string drives both. Do
 * NOT use engine-specific syntax (JS `\s`/`\d`/`\b`/lookarounds, or POSIX
 * `[[:alpha:]]` classes) — those would make the two engines disagree, which is
 * the very thing this module exists to prevent. `compileRulePatterns()` (run at
 * module load + asserted in the test) fails fast if a pattern won't compile as
 * a JS RegExp.
 */

/**
 * A failed tool call's class. Each deserves a different FIRE bar + destination:
 *   - structural — a real bug/misconfig (the tool, a missing table, a wiring
 *     gap). Fires on FEW occurrences OR a high error-rate → auto-implement.
 *   - transient  — timeout / load / shared-infra exhaustion. Volume-gated.
 *   - caller     — the caller sent bad input, lacks a role, or was rejected at the MCP auth gate (DX/auth). kind=change.
 *   - rate-limit — an EXTERNAL provider rate-limit / quota (OpenAI embed TPM
 *     429). Capacity, not a code bug → infra/owner, never the auto-implement lane.
 */
export type ToolErrorClass = 'structural' | 'transient' | 'caller' | 'rate-limit';

/** The default class when no rule matches. */
export const DEFAULT_TOOL_ERROR_CLASS: ToolErrorClass = 'structural';

/**
 * One classification rule. A row matches the rule when ANY of its predicate
 * kinds match: `error_code ∈ errorCodes`, `status ∈ statuses`, or the
 * `error_message` matches `messagePattern` (case-insensitive). Rules are
 * evaluated IN ORDER; the first match wins. The table is the single source for
 * both the TS fn and the SQL CASE.
 */
export interface ToolErrorRule {
  /** The class to assign on a match (never `structural` — that is the fallback). */
  readonly class: Exclude<ToolErrorClass, 'structural'>;
  /** Exact `error_code` matches (any). */
  readonly errorCodes?: readonly string[];
  /** Exact `status` matches (any). */
  readonly statuses?: readonly string[];
  /** Dual-engine POSIX-ERE / JS pattern matched against `error_message` (case-insensitive). */
  readonly messagePattern?: string;
  /** One-line human rationale (docs / test legibility). */
  readonly why: string;
}

// ── The shared message patterns (dual-engine; see the module header) ──────────

/** A timeout, including one that surfaced as `handler_error`
 *  ("exceeded timeout … handler returned but signal had aborted"). Word boundaries
 *  keep argument names such as `timeoutSec` from looking like a timeout outcome. */
export const TIMEOUT_MESSAGE_PATTERN =
  'exceeded timeout([^a-zA-Z]|$)|(^|[^a-zA-Z])timed? *out([^a-zA-Z]|$)';

/** Caller-side auth/arg/scope error in the MESSAGE: a retained
 *  `missing_capability:` prefix from a nested `tools:invoke` refusal, or an `invalid_args:` prefix
 *  (regardless of the row's error_code — this is the bit the old TS fn missed),
 *  including the `invalid_input: invalid_args:` wrapper from a nested
 *  `tools:invoke` refusal,
 *  the intentional scratch-reference line-window size refusal
 *  (scratch_line_window_too_large), or the explicitly caller-side JSON reasons
 *  for absent scratch evidence and missing tenant-scope controls,
 *  the checkpoint replacement safety refusal that requires explicit retirement
 *  of carried safety rows,
 *  an explicit compaction flush-gate refusal that requires a checkpoint,
 *  an explicit reviewer-model allowlist refusal,
 *  a missing / unregistered harness, a registered standalone harness passed
 *  to the Hive-scoped plan store, a desktop-only capability called before its
 *  sandbox lease was provisioned, or a pre-vetting refusal caused by the
 *  caller-authored acceptance BAR contract. A missing WORKSPACE-scope
 *  ("requires a workspace-scoped call") is deliberately NOT here — a
 *  workspace-scoping gap is treated as `structural` (a wiring gap worth catching
 *  at the low bar), and the fingerprint separates it from anything it used to mask. */
export const CALLER_MESSAGE_PATTERN =
  '^missing_capability:|^invalid_input: *invalid_args:|^invalid_args:|^reviewer_model_not_allowed:|scratch_line_window_too_large|"reason":"(evidence_class_not_found|tenant_scope_required|positive_control_tenant_scope_required)"|checkpoint_replace_would_drop_rows|"error":"flush-required"|No harness specified|not registered in (any workspace|harness_shared)|resolvePlanScope:.*is not a Hive home|no sandbox desktop is leased|acceptance BAR contract is not ready for vetting|predicate_shape_mismatch:';

/** An EXTERNAL provider rate-limit / quota (OpenAI embedding TPM 429,
 *  "Rate limit reached", surfaced as `openai_embed_failed_429`). CAPACITY, not a
 *  code bug — must not fall through to `structural` (P-002). */
export const RATE_LIMIT_MESSAGE_PATTERN =
  'openai_embed_failed_429|rate[ _-]?limit[ _-]?(reached|exceeded)|tokens per min|requests per min|too many requests';

/** The operator's own MCP admission bulkhead returns a retryable shed response
 *  when the event loop is critical or its in-flight capacity is full. That is
 *  backpressure from the shared admission gate, not a per-tool implementation
 *  defect. */
export const OPERATOR_ADMISSION_TRANSIENT_MESSAGE_PATTERN =
  'operator MCP admission is saturated|reason=(loop_pressure_critical|operator_admission_capacity)';

/** Shared-infra exhaustion (PG `max_connections` / DB-unavailable), an operator
 *  shutdown-window response, and a stale-pooled-connection reset against
 *  PgBouncer. These recur identically in SHAPE across tools during a wedge /
 *  shutdown / idle-reap race, but are transient LOAD/infra, not per-tool bugs —
 *  defer to the volume bar so a brief interruption stops mis-filing structural
 *  tool-bug EIs.
 *
 *  `CONNECTION_CLOSED` / `CONNECT_TIMEOUT` are postgres-js-invented codes
 *  ("write CONNECTION_CLOSED 127.0.0.1:6432") for a pooled connection PgBouncer
 *  idle-reaped server-side, or the pool's own connect() timing out — the exact
 *  codes `connect-retry.ts` already treats as provably-transient and retries
 *  (EI-9279). Matching on them here cannot mask an unrelated application error
 *  (they are postgres-js's own codes), and keeps the classifier in lockstep with
 *  the retry helper so a transient reset that slips past the retry stops being
 *  mis-filed as a structural tool bug (EI-11010). */
export const INFRA_TRANSIENT_MESSAGE_PATTERN =
  'too many clients already|remaining connection slots are reserved|too many connections|the database system is (starting up|shutting down|in recovery|not yet accepting)|server( is)? shutting down|terminating connection due to|ECONNREFUSED|ECONNRESET|CONNECTION_CLOSED|CONNECT_TIMEOUT|connection terminated|could not connect to server';

/**
 * The ordered classification table. ORDER IS SIGNIFICANT — earlier rules win.
 * The precedence mirrors the historical hand-written logic exactly, with the
 * one intended correction that an `invalid_args:`-prefixed message classifies
 * `caller` regardless of its error_code (the drift that motivated P-011).
 */
export const TOOL_ERROR_RULES: readonly ToolErrorRule[] = [
  {
    class: 'transient',
    errorCodes: ['timeout'],
    statuses: ['timeout'],
    messagePattern: TIMEOUT_MESSAGE_PATTERN,
    why: 'a timeout (incl. one surfaced as handler_error) is load, not a tool bug',
  },
  {
    class: 'caller',
    errorCodes: [
      'invalid_args', 'invalid_input', 'role_not_allowed', 'missing_capability',
      'quota_exceeded', 'harness_required', 'checkpoint_replace_would_drop_rows',
      'flush-required', 'rubric-not-found', 'reviewer_model_not_allowed',
      'dynamic_import_unsupported', 'mcp_auth_failed', 'evidence_class_not_found',
      'tenant_scope_required', 'positive_control_tenant_scope_required',
    ],
    statuses: ['role-not-allowed'],
    messagePattern: CALLER_MESSAGE_PATTERN,
    why: 'the caller sent bad input, chose a reviewer outside the expert allowlist, attempted an import in the import-free code:run sandbox, lacked a role, was rejected at the MCP auth gate, named no (or an unregistered) harness, or hit an explicit flush or scratch-reference window-size precondition — not a tool bug',
  },
  {
    class: 'caller',
    messagePattern:
      'patch verification could not find the expected|patch was rejected before writing because .*abbreviated text|patch was rejected because one expected source line did not match exactly',
    why: 'the patch tool deliberately refused a hunk whose expected source context did not match; refresh the exact file context instead of filing a Papercusp structural defect',
  },
  {
    class: 'caller',
    messagePattern: 'Identity capability \\(unresolved\\): outside-ceiling',
    why: 'the kernel refused a call outside the caller identity’s authored capability ceiling; this expected authorization refusal is not a tool implementation defect',
  },
  {
    class: 'caller',
    messagePattern: 'coord:ask is owner-UI-only',
    why: 'coord:ask deliberately denies direct agent calls; this owner-UI-only permission refusal is caller-side, while generic unauthorized workspace-scope failures remain structural',
  },
  {
    class: 'rate-limit',
    messagePattern: RATE_LIMIT_MESSAGE_PATTERN,
    why: 'an EXTERNAL provider rate-limit / quota (OpenAI embed TPM 429) — capacity, not a code bug',
  },
  {
    class: 'transient',
    messagePattern: OPERATOR_ADMISSION_TRANSIENT_MESSAGE_PATTERN,
    why: 'the operator MCP admission gate returned retryable backpressure under critical loop pressure or full capacity — not a per-tool defect',
  },
  {
    class: 'transient',
    errorCodes: ['sidecar_required_unavailable'],
    messagePattern: INFRA_TRANSIENT_MESSAGE_PATTERN,
    why: 'shared-infra exhaustion (PG max_connections / DB unavailable / embedding sidecar unavailable) — load, not a per-tool bug',
  },
];

/**
 * Tool-error classes that carry an error-shape FINGERPRINT in their dedup key
 * (watchdog-and-exposed-systems-improvement-2026-06-18 P-012). Originally only
 * `structural` was fingerprinted (P-003); `caller` and `transient` are added so
 * genuinely DIFFERENT same-class modes under one tool stop collapsing onto a
 * single key and masking each other (e.g. `plans:new` rejecting `note too big`
 * vs `status invalid option` vs `paths too small` — distinct DX fixes that used
 * to share one `plans:new:caller` EI). `rate-limit` is deliberately EXCLUDED:
 * every provider-429 under a tool is the SAME capacity concern, so fingerprinting
 * it would FRAGMENT one EI into many — the opposite of dedup.
 *
 * Both the SQL fingerprint CASE (`toolErrorFingerprintSqlCase`) and the TS key
 * builder read this set, so they cannot drift on which classes are fingerprinted.
 */
export const FINGERPRINTED_TOOL_ERROR_CLASSES: ReadonlySet<ToolErrorClass> =
  new Set<ToolErrorClass>(['structural', 'caller', 'transient']);

/** Compile every rule's messagePattern as a JS RegExp once. Throws (at module
 *  load) if a pattern is not a valid JS regex — the cheap half of the
 *  dual-engine guarantee (the SQL `~*` half is proven by the integration test). */
function compileRulePatterns(): { rule: ToolErrorRule; re: RegExp | null }[] {
  return TOOL_ERROR_RULES.map((rule) => ({
    rule,
    re: rule.messagePattern ? new RegExp(rule.messagePattern, 'i') : null,
  }));
}

const COMPILED_RULES = compileRulePatterns();

/**
 * Pure: classify one tool failure by walking `TOOL_ERROR_RULES` in order and
 * returning the first rule whose error_code / status / message matches; falls
 * back to `structural`. This is the TS half of the single source — the SQL CASE
 * (`toolErrorClassSqlCase`) is generated from the same table.
 */
export function classifyToolError(
  errorCode: string | null | undefined,
  status: string | null | undefined,
  errorMessage: string | null | undefined,
): ToolErrorClass {
  const code = errorCode ?? '';
  const st = status ?? '';
  const msg = errorMessage ?? '';
  for (const { rule, re } of COMPILED_RULES) {
    if (code && rule.errorCodes && rule.errorCodes.includes(code)) return rule.class;
    if (st && rule.statuses && rule.statuses.includes(st)) return rule.class;
    if (msg && re && re.test(msg)) return rule.class;
  }
  return DEFAULT_TOOL_ERROR_CLASS;
}

/** A postgres.js tagged-template fn. Typed structurally + generically so this
 *  module needn't import `@papercusp/db-org` (keeps it unit-testable without PG):
 *  the caller passes the real `getOrgPg().sql`, and the value-binding / fragment
 *  composition is what postgres.js already does throughout watchdog.ts.
 *
 *  The values are `any[]` (not `unknown[]`) deliberately: this one type must
 *  accept BOTH the real postgres `Sql` (whose params are the stricter
 *  `Serializable`) AND the test's debug tag — `any` is the bivariant form both
 *  satisfy; `unknown[]` would make the real `Sql` non-assignable. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SqlTag<T> = (strings: TemplateStringsArray, ...values: any[]) => T;

/** OR together one rule's predicates into a single SQL boolean fragment. */
function ruleConditionSql<T>(sql: SqlTag<T>, rule: ToolErrorRule): T {
  const preds: T[] = [];
  if (rule.errorCodes?.length) preds.push(sql`error_code = ANY(${rule.errorCodes as string[]}::text[])`);
  if (rule.statuses?.length) preds.push(sql`status = ANY(${rule.statuses as string[]}::text[])`);
  if (rule.messagePattern) preds.push(sql`error_message ~* ${rule.messagePattern}`);
  if (preds.length === 0) return sql`FALSE`;
  return preds.reduce((a, b) => sql`${a} OR ${b}`);
}

/**
 * Generate the `CASE … END` SQL fragment that classifies a row into a
 * `ToolErrorClass`, from the SAME `TOOL_ERROR_RULES` table the TS fn walks. The
 * fragment references the bare columns `error_code`, `status`, `error_message`,
 * so embed it where those are in scope (the `fail` CTE of
 * `collectToolErrorSignals`). The result is `CASE WHEN … THEN '<class>' … ELSE
 * 'structural' END`.
 */
export function toolErrorClassSqlCase<T>(sql: SqlTag<T>): T {
  let whens = sql``;
  for (const rule of TOOL_ERROR_RULES) {
    whens = sql`${whens} WHEN ${ruleConditionSql(sql, rule)} THEN ${rule.class}`;
  }
  return sql`CASE${whens} ELSE ${DEFAULT_TOOL_ERROR_CLASS} END`;
}

/**
 * Pure: the normalized error-shape FINGERPRINT — the first 6 alpha tokens of the
 * digit-stripped, punctuation-collapsed, lowercased message, joined with `-`.
 * Returns null when the message has no alpha content.
 *
 * MIRROR of `toolErrorFingerprintSqlCase`'s SQL expression — the two MUST agree
 * (proven row-by-row by the integration test). This TS form lets the key-
 * migration routine recompute a fingerprint from an EI's stored sample without
 * a round-trip to PG.
 */
export function toolErrorFingerprint(message: string | null | undefined): string | null {
  const skeleton = (message ?? '')
    .toLowerCase()
    .replace(/[0-9]+/g, '')
    .replace(/[^a-z]+/g, ' ')
    .trim();
  if (!skeleton) return null;
  const fp = skeleton.split(' ').filter(Boolean).slice(0, 6).join('-');
  return fp || null;
}

/**
 * Generate the SQL fragment that computes the error-shape fingerprint for the
 * fingerprinted classes (and NULL otherwise). The class membership comes from
 * `FINGERPRINTED_TOOL_ERROR_CLASSES`, so SQL + TS cannot drift on which classes
 * are fingerprinted. The arithmetic mirrors `toolErrorFingerprint` exactly
 * (parity proven by the integration test). References the bare `class` /
 * `error_message` columns, so embed where they are in scope (the `tagged` CTE).
 */
export function toolErrorFingerprintSqlCase<T>(sql: SqlTag<T>): T {
  const classes = [...FINGERPRINTED_TOOL_ERROR_CLASSES];
  return sql`CASE WHEN class = ANY(${classes}::text[]) THEN
    nullif(array_to_string((string_to_array(
      trim(regexp_replace(regexp_replace(lower(coalesce(error_message, '')), '[0-9]+', '', 'g'), '[^a-z]+', ' ', 'g')),
    ' '))[1:6], '-'), '')
  ELSE NULL END`;
}

/** The dedup key for a repeated-tool-error signal: `<tool>:<class>` plus a
 *  `:<fingerprint>` segment for the fingerprinted classes (when a fingerprint
 *  was derivable). Single source for the live collector AND the key-migration
 *  routine, so a migrated key matches what the next tick produces. */
export function toolErrorSignalKey(
  toolName: string,
  klass: ToolErrorClass,
  fingerprint: string | null | undefined,
): string {
  const fp = FINGERPRINTED_TOOL_ERROR_CLASSES.has(klass) && fingerprint ? fingerprint : null;
  return fp ? `${toolName}:${klass}:${fp}` : `${toolName}:${klass}`;
}

/**
 * Agent-side report used by the probation intake. The invocation ledger can
 * independently corroborate the stable `signalKey`; the remaining dimensions
 * sharpen the per-reporter fingerprint so unlike client/schema generations do
 * not look like independent reproductions of one defect.
 */
export interface SuspectedToolFailure {
  toolName: string;
  errorCode?: string;
  status?: string;
  message: string;
  schemaRevision?: string;
  fieldPath?: string;
  runtimeVersion?: string;
  reproduced?: boolean;
  clearServerMismatch?: boolean;
  hardInternal?: boolean;
  /**
   * Inspectable evidence that a caller-shaped refusal is actually a tool defect.
   *
   * The three legacy booleans above remain useful shorthand for non-caller
   * classes, but a caller classification is itself evidence that the tool
   * rejected its input. Overriding that classification therefore needs more
   * than another boolean: it must state the expected and observed contracts so
   * the next reader can check the claim instead of inheriting an assertion.
   */
  directEvidence?: ToolFailureDirectEvidence;
}

export const TOOL_FAILURE_DIRECT_EVIDENCE_KINDS = [
  'valid-input-reproduction',
  'server-contract-mismatch',
  'hard-internal',
] as const;

export interface ToolFailureDirectEvidence {
  kind: (typeof TOOL_FAILURE_DIRECT_EVIDENCE_KINDS)[number];
  expected: string;
  actual: string;
}

/**
 * A tool-failure class that is DOCUMENTED, EXTERNAL, and has no papercusp fix
 * surface — the report is real, but nothing in this repository can act on it.
 *
 * Why this table exists (WI-2143658). The probation intake's identity is
 * `<tool>:<class>:<first 6 words of the reporter's message>`, and for an AGENT
 * report that message is free prose. So one such class fragments across many
 * identities instead of coalescing onto a single row: measured 2026-09-03, the
 * Codex `exec_command` parallel-launch race alone had produced 272 rows
 * carrying 138 DISTINCT identities, at 5-17 claimable filings/day for three
 * weeks — every one a duplicate of an investigation already closed four times.
 *
 * A match does NOT discard the report. It only denies the direct-evidence
 * bypass (`reproduced` / `clearServerMismatch` / `hardInternal`), so the row
 * lands in ordinary non-claimable probation carrying its doc citation instead
 * of minting a claimable bug. Two properties follow, and both are deliberate:
 *   • signal is preserved — the observation lane still records every report; and
 *   • the invocation-ledger watchdog can still PROMOTE the row on genuine
 *     sustained repetition, which is exactly the escalation condition the doc
 *     itself names ("if it becomes reliably reproducible, escalate upstream").
 * So this suppresses the duplicate-filing flood WITHOUT suppressing the
 * evidence that would justify escalating.
 *
 * ⚠ Match CONSERVATIVELY and fail OPEN. A miss costs one duplicate row (todays
 * behaviour); a false match hides a real papercusp defect inside a row triage
 * has been told to ignore, which is far more expensive. Prefer a pattern that
 * under-matches. In particular `exclude` exists to keep a genuinely DIFFERENT
 * class out even when its prose looks similar.
 *
 * Patterns follow this module's dual-engine convention (see the header): plain
 * POSIX-ERE-and-JS-compatible syntax only, so a rule stays portable if it is
 * ever pushed down into the SQL CASE.
 */
export interface KnownExternalToolFailureClass {
  /** Stable id, recorded on the row so a later audit can find every match. */
  id: string;
  /** The agent-insights doc that already adjudicated this class. */
  docSlug: string;
  /** Tool names this applies to (exact, lowercased). */
  toolNames: readonly string[];
  /** Message MUST match this for the class to apply. */
  match: string;
  /** Message must NOT match this — the discriminator against nearby classes. */
  exclude?: string;
  /** One line for the triager reading the filed row. */
  note: string;
}

export const KNOWN_EXTERNAL_TOOL_FAILURE_CLASSES: readonly KnownExternalToolFailureClass[] = [
  {
    id: 'codex-exec-command-parallel-launch-race',
    docSlug: 'agent-insights/codex-exec-command-parallel-launch-race',
    // Codex-NATIVE tools. `exec_command` bypasses the papercusp managed command
    // family entirely, so no code here implements the failing spawner.
    toolNames: ['exec_command', 'functions.exec', 'functions.exec_command'],
    // The distinctive invariant across every reported spelling of this class is
    // the "unified exec/shell/process" phrase naming Codex's own spawner. The
    // cosmetic error-code spellings (CreateProcess, CreateProcess_ENOENT,
    // CREATE_PROCESS_NO_SUCH_FILE) vary per Codex build, so they are NOT
    // required — requiring them would under-match reports that omit the code.
    match: 'unified[ _-]?(exec|shell|process)',
    // The SEPARATE mistyped-workdir class is not "already-fixed": the linked
    // insight says nonexistent-workdir behavior still reproduces and remains
    // outside Papercusp's fix surface. Its disposition is "use the correct
    // path", not "retry sequentially" — the doc is explicit that the two must
    // not be conflated. Any mention of a workdir/path problem therefore drops
    // the match back to normal handling.
    exclude: 'workdir|working directory|misspell|mistyped|typo|nonexistent (path|directory)',
    note:
      'Codex CLI client-side process-spawn race under concurrent launch. No papercusp code implements this spawner; ' +
      'independently investigated and closed 4x. Retry the SAME call sequentially instead of in a parallel batch.',
  },
];

function matchesPattern(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(value);
  } catch {
    // A malformed pattern must never break a filing: fail OPEN (no match).
    return false;
  }
}

/**
 * Return the documented external class this report matches, or null. Null is
 * the safe default and is returned for anything uncertain.
 */
export function matchKnownExternalToolFailure(
  input: Pick<SuspectedToolFailure, 'toolName' | 'message'>,
): KnownExternalToolFailureClass | null {
  const tool = (input.toolName ?? '').trim().toLowerCase();
  const message = input.message ?? '';
  if (!tool || !message) return null;
  for (const klass of KNOWN_EXTERNAL_TOOL_FAILURE_CLASSES) {
    if (!klass.toolNames.includes(tool)) continue;
    if (!matchesPattern(klass.match, message)) continue;
    if (klass.exclude && matchesPattern(klass.exclude, message)) continue;
    return klass;
  }
  return null;
}

export interface NormalizedToolFailure {
  class: ToolErrorClass;
  /** Exact key emitted by the repeated-tool-error watchdog. */
  watchdogKey: string;
  /** Stable lifecycle identity, deliberately independent of reporter message shape. */
  classKey: string;
  /** Schema/field contract identity used by the class lifecycle. */
  contractFingerprint: string;
  /** Deployed/runtime revision that emitted the report. */
  deployedRevision: string;
  /** Full client/schema-aware correlation identity retained in the payload. */
  correlationFingerprint: string;
  messageFingerprint: string | null;
  direct: boolean;
  /**
   * Set when the report matches a documented external class with no papercusp
   * fix surface. When set, `direct` is forced false — see the table above.
   */
  knownExternal: KnownExternalToolFailureClass | null;
}

function correlationSegment(value: string | null | undefined, fallback: string): string {
  const normalized = (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || fallback;
}

/**
 * The stable identity for one tool-failure defect class.
 *
 * `watchdogKey` remains the invocation/report identity and intentionally includes
 * the message fingerprint. This key does not include the message shape: differently-
 * worded reports for the same tool/error-code/class/contract/revision must share one
 * lifecycle item, while a different error code, schema, or deployed revision must
 * start a new class. Unknown dimensions remain explicit so missing metadata cannot
 * collapse unrelated reports together.
 */
export interface ToolFailureClassIdentity {
  classKey: string;
  contractFingerprint: string;
  deployedRevision: string;
}

export function toolFailureClassIdentity(
  input: Pick<SuspectedToolFailure, 'toolName' | 'errorCode' | 'schemaRevision' | 'fieldPath' | 'runtimeVersion'>,
  failureFamily: ToolErrorClass,
): ToolFailureClassIdentity {
  const tool = correlationSegment(input.toolName, 'unknown-tool');
  const errorCode = correlationSegment(input.errorCode, 'error-code-unknown');
  const contractFingerprint = [
    correlationSegment(input.schemaRevision, 'schema-unknown'),
    correlationSegment(input.fieldPath, 'field-unknown'),
  ].join('~');
  const deployedRevision = correlationSegment(input.runtimeVersion, 'runtime-unknown');
  return {
    classKey: `repeated-tool-error-class:${tool}:${failureFamily}:${errorCode}:${contractFingerprint}:${deployedRevision}`,
    contractFingerprint,
    deployedRevision,
  };
}

/**
 * The FILING identity for automatically captured tool failures
 * (review-system-rework-reduction-2026-09-23 D-010): one tracker row per tool,
 * failure family, error code and field path. It deliberately OMITS the contract
 * and deployed revision. Those stay in `classKey`, which remains the
 * corroboration identity and is tallied per class inside the row, so a failure on
 * build N+1 counts onto the same row without corroborating build N's report. Keyed
 * on the class, one live defect minted a new row per build (~27 a day). Unknown
 * dimensions stay explicit, exactly as in `classKey`.
 */
export function toolFailureSignatureKey(
  input: Pick<SuspectedToolFailure, 'toolName' | 'errorCode' | 'fieldPath'>,
  failureFamily: ToolErrorClass,
): string {
  const tool = correlationSegment(input.toolName, 'unknown-tool');
  const errorCode = correlationSegment(input.errorCode, 'error-code-unknown');
  const fieldPath = correlationSegment(input.fieldPath, 'field-unknown');
  return `tool-failure-signature:${tool}:${failureFamily}:${errorCode}:${fieldPath}`;
}

const TOOL_FAILURE_SIGNATURE_PREFIX = 'tool-failure-signature:';
const TOOL_ERROR_CLASS_VALUES: readonly ToolErrorClass[] = ['structural', 'transient', 'caller', 'rate-limit'];

/**
 * Inverse of {@link toolFailureSignatureKey}. Tool names and field paths may themselves
 * contain `:` (`coord:glance`), so the key is split on its ONE enumerated segment, the
 * failure family, never by position. Returns null for anything the builder cannot emit.
 */
export function parseToolFailureSignatureKey(
  key: string | null | undefined,
): { toolName: string; failureFamily: ToolErrorClass; errorCode: string; fieldPath: string } | null {
  if (!key || !key.startsWith(TOOL_FAILURE_SIGNATURE_PREFIX)) return null;
  const rest = key.slice(TOOL_FAILURE_SIGNATURE_PREFIX.length);
  let best: { at: number; family: ToolErrorClass } | null = null;
  for (const family of TOOL_ERROR_CLASS_VALUES) {
    const at = rest.indexOf(`:${family}:`);
    if (at > 0 && (best === null || at < best.at)) best = { at, family };
  }
  if (!best) return null;
  const toolName = rest.slice(0, best.at);
  const tail = rest.slice(best.at + best.family.length + 2);
  const sep = tail.indexOf(':');
  if (sep <= 0 || sep === tail.length - 1) return null;
  return { toolName, failureFamily: best.family, errorCode: tail.slice(0, sep), fieldPath: tail.slice(sep + 1) };
}

/** Convenience key builder used by callers that already know the failure family. */
export function toolFailureClassKey(
  input: Pick<SuspectedToolFailure, 'toolName' | 'errorCode' | 'schemaRevision' | 'fieldPath' | 'runtimeVersion'>,
  failureFamily: ToolErrorClass,
): string {
  return toolFailureClassIdentity(input, failureFamily).classKey;
}

/**
 * Normalize one agent-reported tool failure for probation/corroboration.
 *
 * `watchdogKey` deliberately uses the same tool/class/message-shape identity as
 * the invocation-ledger collector. `correlationFingerprint` additionally pins
 * error code, schema revision, field path, and runtime version for the
 * independent-agent leg. A non-caller report may use the legacy direct-evidence
 * flags; a caller report must supply inspectable expected/actual evidence to
 * override the classification. An unknown one-off never becomes claimable
 * merely because the classifier's safe fallback is structural.
 *
 * WI-2143658: that bypass is denied for a DOCUMENTED EXTERNAL class. An honest
 * reporter attesting `reproduced: true` about a known Codex-side race is
 * telling the truth — it did recur — but the attestation was minting a
 * claimable duplicate of an investigation already closed four times. The report
 * still lands (non-claimable probation, doc citation attached) and the
 * invocation watchdog can still promote it on sustained repetition.
 *
 * EI-22142216567407511: a caller classification may no longer be overridden
 * by one of the legacy booleans alone. `reproduced` only proves that an input
 * rejection recurs, while `clearServerMismatch` / `hardInternal` were equally
 * uninspectable assertions. A caller-shaped server defect still has an escape:
 * structured `directEvidence` names expected versus actual behavior. The row
 * otherwise remains in probation, where independent reporters and the
 * invocation-ledger watchdog can still promote a recurring affordance defect.
 */
export function normalizeSuspectedToolFailure(input: SuspectedToolFailure): NormalizedToolFailure {
  const klass = classifyToolError(input.errorCode, input.status, input.message);
  const messageFingerprint = toolErrorFingerprint(input.message);
  const signalKey = toolErrorSignalKey(input.toolName.trim(), klass, messageFingerprint);
  const classIdentity = toolFailureClassIdentity(input, klass);
  const correlationFingerprint = [
    correlationSegment(input.toolName, 'unknown-tool'),
    correlationSegment(input.errorCode, klass),
    correlationSegment(input.schemaRevision, 'schema-unknown'),
    correlationSegment(input.fieldPath, 'field-unknown'),
    correlationSegment(input.runtimeVersion, 'runtime-unknown'),
    correlationSegment(messageFingerprint, 'message-unknown'),
  ].join('|');
  const knownExternal = matchKnownExternalToolFailure(input);
  const legacyAttested =
    input.reproduced === true || input.clearServerMismatch === true || input.hardInternal === true;
  const structuredAttested = input.directEvidence !== undefined;
  const attested = structuredAttested || (legacyAttested && klass !== 'caller');
  return {
    class: klass,
    watchdogKey: `repeated-tool-error:${signalKey}`,
    classKey: classIdentity.classKey,
    contractFingerprint: classIdentity.contractFingerprint,
    deployedRevision: classIdentity.deployedRevision,
    correlationFingerprint,
    messageFingerprint,
    // A documented external class never bypasses probation, however the
    // reporter attested it — the attestation is honest, the row is a duplicate.
    direct: attested && !knownExternal,
    knownExternal,
  };
}
