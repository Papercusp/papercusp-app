/**
 * P-010 admission control (mcp-reliability-hardening-2026-07-11).
 *
 * When the request-worker event loop is CRITICALLY saturated, dispatching yet
 * another `tools/call` only deepens the saturation (every tool is main-thread
 * work). Shed it PRE-DISPATCH with HTTP 429 + Retry-After: the tool never runs
 * (no side effect ⇒ a retry is write-safe), and the resilient MCP proxy (P-005)
 * ABSORBS the 429 — drains, waits Retry-After, retries within its window — so the
 * agent just waits a beat instead of seeing an error (the same shape that makes a
 * deploy restart invisible).
 *
 * Only POST `tools/call` is shed; initialize / tools/list / notifications / ping /
 * resources / prompts are cheap protocol traffic and MUST stay live (they carry
 * discovery + recovery). Gated on the CRITICAL band only — `elevated` still admits
 * (that band drives background-tick shedding, not request rejection). Fail-open: no
 * lag monitor ⇒ loopPressure() is 'ok' ⇒ never sheds. Env kill-switch
 * PAPERCUSP_MCP_ADMISSION_CONTROL=0; Retry-After default 1s (pressure clears fast
 * once we stop admitting — the proxy clamps its own wait regardless).
 *
 * Lives in its own module (not inline in _mcp-handler.ts) so the pure decision
 * logic is unit-testable without pulling the handler's heavy side-effect graph
 * (it registers every first-party tool on import).
 */
import { normalizeMcpName } from '@papercusp/tooldef';
import { parseProjection, PROJECTION_ARG } from '../../../result-projection';
import type { LoopPressure } from '../../../event-loop-lag-monitor';

export const ADMISSION_CONTROL_ENABLED = process.env.PAPERCUSP_MCP_ADMISSION_CONTROL !== '0';
export const ADMISSION_RETRY_AFTER_SEC = Math.max(
  1,
  Number(process.env.PAPERCUSP_MCP_ADMISSION_RETRY_AFTER_SEC) || 1,
);

/**
 * EI-21392098254217280 — the proxy has an admission ceiling, but the operator
 * worker used to accept an unbounded number of requests after they crossed the
 * proxy boundary. A CPU-bound worker could therefore spend all of its event
 * loop budget on MCP handshakes and tool dispatches before any one request had
 * a chance to finish. Keep the defaults deliberately below the proxy's global
 * ceiling: this is a per-worker guard, not a replacement for the proxy's
 * cross-worker bulkhead.
 */
function intEnv(name: string, fallback: number, min = 0): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.max(min, Math.trunc(parsed)) : fallback;
}

export const OPERATOR_ADMISSION_MAX_IN_FLIGHT = intEnv('PAPERCUSP_MCP_OPERATOR_MAX_IN_FLIGHT', 64);
export const OPERATOR_ADMISSION_CONTROL_PLANE_RESERVE = intEnv(
  'PAPERCUSP_MCP_OPERATOR_CONTROL_PLANE_RESERVE',
  8,
);
export const OPERATOR_ADMISSION_DIAGNOSTIC_RESERVE = intEnv(
  'PAPERCUSP_MCP_OPERATOR_DIAGNOSTIC_RESERVE',
  2,
);
export const OPERATOR_ADMISSION_MAX_HANDSHAKES = intEnv(
  'PAPERCUSP_MCP_OPERATOR_MAX_HANDSHAKES',
  OPERATOR_ADMISSION_CONTROL_PLANE_RESERVE,
);

export type McpAdmissionClass = 'ordinary' | 'handshake' | 'diagnostic' | 'other';

export interface McpAdmissionCapacity {
  maxInFlight: number;
  controlPlaneReserve: number;
  diagnosticReserve: number;
  maxHandshakes: number;
}

export interface McpAdmissionSnapshot {
  inFlight: number;
  handshakesInFlight: number;
  diagnosticsInFlight: number;
  ordinaryInFlight: number;
}

export interface McpAdmissionLease {
  classification: McpAdmissionClass;
  release: () => void;
}

export interface McpAdmissionDecision {
  response: Response | null;
  lease: McpAdmissionLease | null;
  classification: McpAdmissionClass;
}

const DEFAULT_CAPACITY: McpAdmissionCapacity = {
  maxInFlight: OPERATOR_ADMISSION_MAX_IN_FLIGHT,
  controlPlaneReserve: OPERATOR_ADMISSION_CONTROL_PLANE_RESERVE,
  diagnosticReserve: OPERATOR_ADMISSION_DIAGNOSTIC_RESERVE,
  maxHandshakes: OPERATOR_ADMISSION_MAX_HANDSHAKES,
};

let admissionSnapshot: McpAdmissionSnapshot = {
  inFlight: 0,
  handshakesInFlight: 0,
  diagnosticsInFlight: 0,
  ordinaryInFlight: 0,
};

export function getMcpAdmissionSnapshot(): McpAdmissionSnapshot {
  return { ...admissionSnapshot };
}

/** Test-only reset. The gate is process-local state by design. */
export function resetMcpAdmissionForTests(): void {
  admissionSnapshot = {
    inFlight: 0,
    handshakesInFlight: 0,
    diagnosticsInFlight: 0,
    ordinaryInFlight: 0,
  };
}

/**
 * EI-20241040709445172 — diagnostics needed to prove or recover from critical
 * pressure must not be rejected by the pressure gate itself. Keep this list
 * deliberately narrow: both tools are read-only and internally bounded, so
 * admitting them cannot add an unbounded unit of work to the saturated loop.
 *
 * The outer MCP proxy has the matching capacity-reserve list. This inner gate
 * still needs its own exemption because direct ptool/staging calls bypass that
 * proxy, and because a proxy-reserved request can otherwise be shed here after
 * it reaches the operator. `scheduler:get_next`, `loop:status`, and bounded `dev:telemetry`
 * are included below as recovery calls. The scheduler self-pull claims at most one item and
 * its handler has an
 * explicit whole-call deadline, but it is admitted only for its known, bounded
 * argument shape (unlike a generic ordinary tools/call).
 */
/**
 * EI-21574538947513211 adds `dev:dogfood_substrate_status`, measured: a bounded 149-index
 * `ownLogProbe` walk at concurrency 20 drew 94 explicit retryable -32000 sheds with reason
 * `loop_pressure_critical`. That is this gate rejecting the very tool used to OBSERVE the
 * pressure it is reacting to — the failure mode the exemption above exists to prevent, arriving
 * through the one diagnostic that was never listed.
 *
 * It meets the stated bar rather than widening it. `attachOwnLogProbe` takes a SINGLE
 * non-negative `index` and performs exactly one `handle.ownLog.get(index)` against an
 * ALREADY-OPEN Corestore — its own contract is that it "never opens a second Corestore or joins
 * transport just to inspect a row", and a relocated handle routes over the bounded
 * `substrate:getOwnLogOp` RPC. The tool is read-only throughout. The 149-index figure was the
 * CALLER issuing 149 separate cheap calls, not one unbounded unit of work; per-call cost is what
 * this list is about.
 *
 * ⚠ Know what listing a tool actually grants — it is BOTH legs, not just the pressure one.
 * `isCriticalPressureDiagnosticCall` is read by `classifyMcpBody` (⇒ never pressure-shed) AND by
 * `classifyMcpRequest` (⇒ classified 'diagnostic', which `shouldShedForCapacity` returns false
 * for). `diagnosticReserve` is a floor carved out of the ORDINARY ceiling for diagnostics, NOT a
 * cap on them, so a listed tool is bounded only by the global `maxInFlight`. Do not add anything
 * here whose per-call cost you have not read. `tools:find` is the bounded catalog-discovery door
 * used to locate recovery tools and already has a proxy-side control-plane reservation; direct
 * ptool/staging calls need the same inner exemption. `capability:read` is admitted only for a
 * single byte page from an authorized scratch spill, so result-door recovery can proceed while
 * pressure is critical without opening the broad file-read surface. `work_items:get` is admitted
 * only for one item with the default shallow read; bulk, detail, and thread reads remain shed
 * under critical pressure. `scorecards:list` is admitted only for an exact rubric+subject audit
 * read; broad history remains shed. `rubrics:get` is admitted only for one rubric (the full
 * criteria body is required by a judge); multi-rubric reads remain shed. A judge's
 * `scorecards:emit` is admitted only for one terminal grading-integrity audit of one scorecard;
 * ordinary scorecard writes remain shed. A judge's complete `scorecards:evaluate` payload is
 * admitted only when its ratings/instrument shape is bounded; ordinary complete evaluations
 * remain shed. The five read-only judge audit probes
 * (`plans:evaluate-spec-test-adequacy`, `gates:degenerate-check`,
 * `plans:get-specs`, `plans:get-spec-evidence`, and the exact-ID `issues:list` read) are
 * admitted only for the judge role and bounded argument shapes;
 * their ordinary callers remain shed. `work_items:checkpoint` is admitted only for a single
 * item, because a bounded durability write is needed to preserve successor state during the
 * pressure condition; bulk checkpoint batches remain shed. `scorecards:get` is admitted only
 * for one bounded issue-id evidence read. `improvements:capture` is admitted only for the
 * tool-failure shorthand, whose nested metadata is bounded and is the required recovery record
 * for a shed tool call; ordinary captures remain shed. `events:status` is admitted only for
 * one exact await id or event-key inspection; broad active-await lists and the fleet-wide meter
 * remain shed. `dev:telemetry` requires an explicit small result page so its aggregate query
 * cannot become an unbounded pressure escape hatch. `coord:inbox` is admitted only for an
 * explicit small page with a directed or unanswered-directed filter; broad/default and
 * enriched forms remain shed because they can expand the mailbox derive.
 */
const CRITICAL_PRESSURE_DIAGNOSTIC_TOOLS = new Set(
  [
    'dev:service_health',
    'dev:pg_query',
    'dev:pg_active_queries',
    'dev:dogfood_substrate_status',
    'backup:snapshot_list',
    'coord:whoami',
    'facts:list',
    'coord:declare-intent',
    'coord:inbox',
    'locks:list',
    'locks:queue',
    'tools:find',
    'plans:get',
    'plans:search',
    'docs:get',
    'docs:search',
    'search:fulltext',
    'work_items:get',
    'work_items:list',
    'work_items:complete',
    'work_items:search',
    'git-sync:run',
    'session:request-compaction',
    'testing:run-status',
    'sessions:search',
    'sessions:timeline',
    'loop:status',
    'loop:checkpoint',
    'logs:read',
    'notifications:recent',
    'testing:runs',
  ].map(normalizeMcpName),
);
const DEV_TELEMETRY_NAME = normalizeMcpName('dev:telemetry');
const CRITICAL_DEV_TELEMETRY_MAX_HOURS = 24;
const CRITICAL_DEV_TELEMETRY_MAX_LIMIT = 50;
const CRITICAL_DEV_TELEMETRY_MAX_WORKSPACE_IDS = 32;
const CRITICAL_DEV_TELEMETRY_MAX_STRING_CHARS = 120;
const DEV_TELEMETRY_TRANSPORTS = new Set(['http', 'mcp', 'ipc', 'in_process', 'unknown']);
const SCHEDULER_GET_NEXT_NAME = normalizeMcpName('scheduler:get_next');
const LOOP_STATUS_NAME = normalizeMcpName('loop:status');
const LOOP_ARM_NAME = normalizeMcpName('loop:arm');
const LOOP_CHECKPOINT_NAME = normalizeMcpName('loop:checkpoint');
const EVENTS_STATUS_NAME = normalizeMcpName('events:status');
const CRITICAL_SCHEDULER_MAX_HARNESS_CHARS = 200;
const CRITICAL_SCHEDULER_MAX_HELD_PATH_CHARS = 512;
const CRITICAL_SCHEDULER_MAX_HELD_PATHS = 500;
const CRITICAL_SCHEDULER_STATES = new Set(['open', 'failing']);
const CRITICAL_LOOP_STATUS_MAX_STRING_CHARS = 120;
const CRITICAL_LOOP_ARM_MAX_STRING_CHARS = 120;
const CRITICAL_LOOP_ARM_MAX_GOAL_CHARS = 500;
const CRITICAL_LOOP_ARM_MAX_INTERVAL_SEC = 15 * 60;
const CRITICAL_LOOP_CHECKPOINT_MAX_ARGUMENT_CHARS = 16_000;
const CRITICAL_LOOP_CHECKPOINT_MAX_FIELD_CHARS = 8_000;
const CRITICAL_LOOP_CHECKPOINT_MAX_ARRAY_ITEMS = 12;
const CRITICAL_EVENTS_STATUS_MAX_EVENT_CHARS = 200;
const CRITICAL_FACTS_LIST_MAX_KEY_CHARS = 200;
const CRITICAL_FACTS_LIST_MAX_SCOPE_REF_CHARS = 120;
const TOOLS_INVOKE_NAME = normalizeMcpName('tools:invoke');
const COORD_SEND_NAME = normalizeMcpName('coord:send');
const COORD_WHOAMI_NAME = normalizeMcpName('coord:whoami');
const COORD_DECLARE_INTENT_NAME = normalizeMcpName('coord:declare-intent');
const COORD_INBOX_NAME = normalizeMcpName('coord:inbox');
const FACTS_LIST_NAME = normalizeMcpName('facts:list');
const BACKUP_SNAPSHOT_LIST_NAME = normalizeMcpName('backup:snapshot_list');
const CAPABILITY_BASH_OUTPUT_NAME = normalizeMcpName('capability:bash_output');
const WORK_ITEMS_COMMENT_NAME = normalizeMcpName('work_items:comment');
const LOCKS_LIST_NAME = normalizeMcpName('locks:list');
const LOCKS_QUEUE_NAME = normalizeMcpName('locks:queue');
const LOCKS_RELEASE_NAME = normalizeMcpName('locks:release');
const WORK_ITEMS_GET_NAME = normalizeMcpName('work_items:get');
const WORK_ITEMS_LIST_NAME = normalizeMcpName('work_items:list');
const WORK_ITEMS_COMPLETE_NAME = normalizeMcpName('work_items:complete');
const CRITICAL_WORK_ITEMS_LIST_MAX_HARNESS_CHARS = 80;
const CRITICAL_WORK_ITEMS_LIST_MAX_LIMIT = 20;
const CRITICAL_WORK_ITEMS_LIST_MAX_STATES = 2;
const CRITICAL_WORK_ITEMS_LIST_MAX_STATE_CHARS = 40;
const CRITICAL_WORK_ITEMS_COMPLETE_MAX_ID_CHARS = 200;
const CRITICAL_WORK_ITEMS_COMPLETE_MAX_HARNESS_CHARS = 80;
const CRITICAL_WORK_ITEMS_COMPLETE_MAX_STATE_CHARS = 40;
const CRITICAL_WORK_ITEMS_COMPLETE_MAX_BOUNDARY_NOTE_CHARS = 2_000;
const CRITICAL_WORK_ITEMS_COMPLETE_MAX_ARGUMENT_CHARS = 64_000;
const CRITICAL_WORK_ITEMS_COMPLETE_MAX_STRING_CHARS = 8_000;
const CRITICAL_WORK_ITEMS_COMPLETE_MAX_ARRAY_ITEMS = 100;
const CRITICAL_WORK_ITEMS_COMPLETE_MAX_OBJECT_KEYS = 64;
const CRITICAL_WORK_ITEMS_COMPLETE_MAX_NESTING = 8;
// `work_items:get`'s bounded thread path clamps its effective window to 10
// posts. Keep the pressure exception at that effective bound; full detail,
// bulk reads, and larger caller requests remain on the ordinary shed path.
const CRITICAL_WORK_ITEMS_GET_THREAD_LIMIT_MAX = 10;
const CRITICAL_WORK_ITEMS_COMPLETE_FLAT_FIELDS = new Set([
  'workItem',
  'title',
  'summary',
  'status',
  'whatLanded',
  'migrations',
  'tests',
  'verification',
  'rootCauseVerification',
  'coverage',
  'filesChanged',
  'filesDeleted',
  'testsRun',
  'testResult',
  'verifiedHow',
  'addedTests',
  'selfReview',
  'deploy',
  'deferred',
  'coordNotes',
  'planSlug',
  'agent',
  'duplicateOf',
]);
const DOCS_GET_NAME = normalizeMcpName('docs:get');
const CRITICAL_DOCS_GET_MAX_SLUG_CHARS = 512;
const CRITICAL_DOCS_GET_MAX_HEADING_CHARS = 256;
const CRITICAL_DOCS_GET_MAX_HARNESS_CHARS = 120;
const DOCS_SEARCH_NAME = normalizeMcpName('docs:search');
const CRITICAL_DOCS_SEARCH_MAX_QUERY_CHARS = 200;
const CRITICAL_DOCS_SEARCH_MAX_HARNESS_CHARS = 120;
const CRITICAL_DOCS_SEARCH_MAX_LIMIT = 20;
const SEARCH_FULLTEXT_NAME = normalizeMcpName('search:fulltext');
const CRITICAL_SEARCH_FULLTEXT_MAX_QUERY_CHARS = 400;
const CRITICAL_SEARCH_FULLTEXT_MAX_HARNESS_CHARS = 120;
const CRITICAL_SEARCH_FULLTEXT_MAX_LIMIT = 5;
const CRITICAL_SEARCH_FULLTEXT_SCOPES = new Set([
  'escalations',
  'brainstorm',
  'turns',
  'decisions',
  'work_item',
  'session_turn',
  'coord_message',
]);
const WORK_ITEMS_SEARCH_NAME = normalizeMcpName('work_items:search');
const CRITICAL_WORK_ITEMS_SEARCH_MAX_QUERY_CHARS = 400;
const CRITICAL_WORK_ITEMS_SEARCH_MAX_HARNESS_CHARS = 80;
const CRITICAL_WORK_ITEMS_SEARCH_MAX_KIND_CHARS = 80;
const CRITICAL_WORK_ITEMS_SEARCH_MAX_LIMIT = 20;
const RECIPES_SEARCH_NAME = normalizeMcpName('recipes:search');
const CRITICAL_RECIPES_SEARCH_MAX_QUERY_CHARS = 400;
const CRITICAL_RECIPES_SEARCH_MAX_LIMIT = 20;
const PLANS_SEARCH_NAME = normalizeMcpName('plans:search');
const CRITICAL_PLANS_SEARCH_MAX_QUERY_CHARS = 400;
const CRITICAL_PLANS_SEARCH_MAX_SLUG_CHARS = 200;
const CRITICAL_PLANS_SEARCH_MAX_HARNESS_CHARS = 120;
const CRITICAL_PLANS_SEARCH_MAX_LIMIT = 20;
const CRITICAL_PLANS_SEARCH_MAX_SCOPES = 6;
const CRITICAL_PLANS_SEARCH_SCOPES = new Set(['slug', 'title', 'now', 'items', 'decisions', 'prose']);
const GIT_SYNC_RUN_NAME = normalizeMcpName('git-sync:run');
const CRITICAL_GIT_SYNC_RUN_MAX_SCOPE_CHARS = 120;
const CRITICAL_GIT_SYNC_RUN_MAX_REASON_CHARS = 1_000;
const SESSION_REQUEST_COMPACTION_NAME = normalizeMcpName('session:request-compaction');
const CRITICAL_SESSION_COMPACTION_FOCUS_MAX_CHARS = 600;
const CRITICAL_SESSION_COMPACTION_CONTINUE_NOTE_MAX_CHARS = 1_000;
const CRITICAL_SESSION_COMPACTION_REASON_MAX_CHARS = 600;
const LOGS_READ_NAME = normalizeMcpName('logs:read');
const NOTIFICATIONS_RECENT_NAME = normalizeMcpName('notifications:recent');
const TESTING_RUNS_NAME = normalizeMcpName('testing:runs');
const CRITICAL_LOGS_READ_MAX_UNITS = 3;
const CRITICAL_LOGS_READ_MAX_LIMIT = 50;
const CRITICAL_LOGS_READ_MAX_GREP_CHARS = 200;
const CRITICAL_LOG_LEVELS = new Set(['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug']);
const CRITICAL_LOG_SCOPES = new Set(['user', 'system', 'all']);
const CRITICAL_NOTIFICATIONS_RECENT_MAX_LIMIT = 50;
const CRITICAL_TESTING_RUNS_MAX_IDS = 25;
const CRITICAL_TESTING_RUNS_MAX_STATUS = 6;
const CRITICAL_TESTING_RUNS_MAX_SINCE_HOURS = 24;
const CRITICAL_TESTING_RUNS_MAX_LIMIT = 25;
const CRITICAL_TESTING_RUN_STATUSES = new Set(['pass', 'fail', 'skip', 'cancelled', 'error', 'running']);
const CRITICAL_TESTING_RUN_SOURCES = new Set(['ci', 'local', 'admin-ui', 'mutation-probe']);
const TESTING_RUN_STATUS_NAME = normalizeMcpName('testing:run-status');
const CRITICAL_TESTING_RUN_STATUS_MAX_RUN_ID_CHARS = 120;
const ACTIVITY_TOOL_LOG_NAME = normalizeMcpName('activity:tool-log');
const CRITICAL_ACTIVITY_TOOL_LOG_MAX_SCOPE_CHARS = 256;
const CRITICAL_ACTIVITY_TOOL_LOG_MAX_BOUNDARY_CHARS = 64;
const CRITICAL_ACTIVITY_TOOL_LOG_MAX_LINES = 40;
const CRITICAL_ACTIVITY_TOOL_LOG_MAX_TOP_K = 8;
const ACTIVITY_TOOL_LOG_ISO_BOUNDARY_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const SESSIONS_SEARCH_NAME = normalizeMcpName('sessions:search');
const CRITICAL_SESSIONS_SEARCH_MAX_QUERY_CHARS = 500;
const CRITICAL_SESSIONS_SEARCH_MAX_LIMIT = 5;
const CRITICAL_SESSIONS_SEARCH_MAX_CONTEXT = 2;
const SESSIONS_TIMELINE_NAME = normalizeMcpName('sessions:timeline');
const CRITICAL_SESSIONS_TIMELINE_MAX_OWNER_CHARS = 120;
const CRITICAL_SESSIONS_TIMELINE_MAX_BOUND_CHARS = 40;
const CRITICAL_SESSIONS_TIMELINE_MAX_LIMIT = 100;
const CRITICAL_SESSIONS_TIMELINE_MAX_TOOL_CHARS = 160;
const CRITICAL_SESSIONS_TIMELINE_MAX_STATUS_CHARS = 80;
const CRITICAL_SESSIONS_TIMELINE_MAX_GOAL_REF_CHARS = 200;
const CRITICAL_SESSIONS_TIMELINE_MAX_CURSOR_CHARS = 512;
const WORK_ITEMS_SET_STATE_NAME = normalizeMcpName('work_items:set_state');
const PLANS_GET_NAME = normalizeMcpName('plans:get');
const WORK_ITEMS_CHECKPOINT_NAME = normalizeMcpName('work_items:checkpoint');
const SCORECARDS_LIST_NAME = normalizeMcpName('scorecards:list');
const SCORECARDS_EVALUATE_NAME = normalizeMcpName('scorecards:evaluate');
const SCORECARDS_GET_NAME = normalizeMcpName('scorecards:get');
const SCORECARDS_EMIT_NAME = normalizeMcpName('scorecards:emit');
const RUBRICS_GET_NAME = normalizeMcpName('rubrics:get');
const IMPROVEMENTS_CAPTURE_NAME = normalizeMcpName('improvements:capture');
const EVALUATE_SPEC_TEST_ADEQUACY_NAME = normalizeMcpName('plans:evaluate-spec-test-adequacy');
const DEGENERATE_CHECK_NAME = normalizeMcpName('gates:degenerate-check');
const GET_SPECS_NAME = normalizeMcpName('plans:get-specs');
const GET_SPEC_EVIDENCE_NAME = normalizeMcpName('plans:get-spec-evidence');
const ISSUES_LIST_NAME = normalizeMcpName('issues:list');
const CRITICAL_SCORECARDS_LIST_MAX_ROWS = 50;
const CRITICAL_SCORECARDS_GET_ISSUE_ID_MAX = 120;
const CRITICAL_ISSUES_LIST_MAX_QUERY_CHARS = 120;
const CRITICAL_ISSUES_LIST_MAX_LIMIT = 10;
const CRITICAL_SCORECARDS_EVALUATE_MAX_RATINGS = 64;
const CRITICAL_SCORECARDS_EVALUATE_MAX_SNAPSHOTS = 64;
const CRITICAL_SCORECARDS_EVALUATE_MAX_ARGUMENT_CHARS = 64_000;
const CRITICAL_TOOL_FAILURE_MESSAGE_MAX = 4_000;
const CRITICAL_TOOL_FAILURE_DIRECT_EVIDENCE_MAX = 2_000;
const CRITICAL_JUDGE_AUDIT_MAX_ROWS = 25;
const CRITICAL_JUDGE_AUDIT_MAX_ARRAY_ITEMS = 25;
const CRITICAL_JUDGE_AUDIT_MAX_MIN_DECISIONS = 100_000;
const CRITICAL_JUDGE_AUDIT_MAX_SINCE_HOURS = 24;
const CAPABILITY_READ_NAME = normalizeMcpName('capability:read');
const CRITICAL_CAPABILITY_READ_MAX_BYTES = 4_096;
const CRITICAL_CAPABILITY_READ_MAX_CONTENT_INDEXES = 64;
const COORD_PRESENCE_NAME = normalizeMcpName('coord:presence');
const COORD_ROSTER_NAME = normalizeMcpName('coord:roster');
const CRITICAL_TARGET_OWNER_MAX_STRING_CHARS = 120;
const CRITICAL_TARGET_OWNER_MAX_COUNT = 50;
const CRITICAL_BACKUP_SNAPSHOT_LIST_MAX_LIMIT = 50;
const CRITICAL_LOCKS_LIST_MAX_LIMIT = 50;
const CRITICAL_LOCKS_QUEUE_MAX_PATHS = 50;
const CRITICAL_LOCKS_QUEUE_MAX_PATH_CHARS = 1_024;
const CRITICAL_LOCKS_QUEUE_MAX_EXTERNAL_PATH_CHARS = 4_096;
const CRITICAL_LOCKS_QUEUE_MAX_DOMAIN_CHARS = 4_096;
const CRITICAL_LOCKS_QUEUE_MAX_OWNER_CHARS = 120;
const CRITICAL_LOCKS_RELEASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CRITICAL_COORD_SEND_MAX_SUMMARY_CHARS = 600;
const CRITICAL_COORD_SEND_MAX_BODY_CHARS = 600;
const CRITICAL_WORK_ITEM_COMMENT_MAX_ID_CHARS = 200;
const CRITICAL_WORK_ITEM_COMMENT_MAX_BODY_CHARS = 600;
const CRITICAL_WORK_ITEM_APPROVAL_BODY_MAX_CHARS = 8_192;
const CRITICAL_WORK_ITEM_APPROVAL_MAX_BARS = 32;
const CRITICAL_WORK_ITEM_APPROVAL_HASH_RE = /^[a-f0-9]{64}$/;
const CRITICAL_BASH_OUTPUT_ID_MAX_CHARS = 256;
const CRITICAL_DECLARE_INTENT_MAX_INTENT_CHARS = 600;
const CRITICAL_DECLARE_INTENT_MAX_PLAN_CHARS = 200;
const CRITICAL_DECLARE_INTENT_MAX_HARNESS_CHARS = 120;
const CRITICAL_DECLARE_INTENT_MAX_ITEMS = 40;
const CRITICAL_COORD_INBOX_MAX_LIMIT = 10;
const CRITICAL_WORK_ITEMS_SET_STATE_MAX_ID_CHARS = 200;
const CRITICAL_WORK_ITEMS_SET_STATE_MAX_STATE_CHARS = 40;
const CRITICAL_WORK_ITEMS_SET_STATE_MAX_HARNESS_CHARS = 80;
const CRITICAL_WORK_ITEMS_SET_STATE_MAX_EVIDENCE_CHARS = 2_000;
const CRITICAL_WORK_ITEMS_SET_STATE_MAX_ASSUMPTION_KEYS = 10;
const CRITICAL_WORK_ITEMS_SET_STATE_MAX_ASSUMPTION_KEY_CHARS = 120;

const PLAN_CLASS_RUBRIC_REFS = new Set([
  'plan-class-feature-ship',
  'plan-class-bugfix',
  'plan-class-migration',
  'plan-class-investigation',
]);
const SPEC_EVIDENCE_KINDS = new Set([
  'test',
  'fixture',
  'coverage-census',
  'mutation',
  'counterexample',
  'check',
  'manual',
  'operational',
]);
const TOOL_FAILURE_DIRECT_EVIDENCE_KINDS = new Set([
  'valid-input-reproduction',
  'server-contract-mismatch',
  'hard-internal',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedPositiveInt(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;
}

function isBoundedStringArray(value: unknown, max = CRITICAL_JUDGE_AUDIT_MAX_ARRAY_ITEMS): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= max &&
    value.every((entry) => typeof entry === 'string' && entry.trim().length > 0)
  );
}

function isBoundedEvidenceCurrent(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > CRITICAL_JUDGE_AUDIT_MAX_ARRAY_ITEMS) return false;
  return value.every((entry) => {
    if (!isRecord(entry)) return false;
    if (typeof entry.evidenceKind !== 'string' || !SPEC_EVIDENCE_KINDS.has(entry.evidenceKind)) return false;
    if (
      typeof entry.evidenceRef !== 'string' ||
      entry.evidenceRef.trim().length === 0 ||
      entry.evidenceRef.length > 2_000
    ) {
      return false;
    }
    if (
      typeof entry.sourceFingerprint !== 'string' ||
      entry.sourceFingerprint.trim().length === 0 ||
      entry.sourceFingerprint.length > 256
    ) {
      return false;
    }
    for (const field of ['testFingerprint', 'fixtureFingerprint', 'rubricFingerprint', 'environmentFingerprint']) {
      if (
        entry[field] !== undefined &&
        entry[field] !== null &&
        (typeof entry[field] !== 'string' || (entry[field] as string).length > 256)
      ) {
        return false;
      }
    }
    return true;
  });
}

function isBoundedJudgeEvaluateArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  if (typeof args.slug !== 'string' || args.slug.trim().length === 0) return false;
  if (typeof args.classRef !== 'string' || !PLAN_CLASS_RUBRIC_REFS.has(args.classRef)) return false;
  if (!isBoundedPositiveInt(args.limit, CRITICAL_JUDGE_AUDIT_MAX_ROWS)) return false;
  if (args.harness !== undefined && (typeof args.harness !== 'string' || args.harness.trim().length === 0))
    return false;
  for (const field of ['workItemIds', 'evidenceRefs', 'specIds']) {
    if (args[field] !== undefined && !isBoundedStringArray(args[field])) return false;
  }
  if (
    args.planItemIds !== undefined &&
    (!isBoundedStringArray(args.planItemIds) || !args.planItemIds.every((id) => /^P-\d{3,}$/.test(id)))
  ) {
    return false;
  }
  if (args.current !== undefined) {
    const current = args.current;
    if (Array.isArray(current)) {
      if (!isBoundedEvidenceCurrent(current)) return false;
    } else if (
      !isRecord(current) ||
      typeof current.supplied !== 'boolean' ||
      !isBoundedEvidenceCurrent(current.fingerprints)
    ) {
      return false;
    }
  }
  if (args.specRevision !== undefined && !isBoundedPositiveInt(args.specRevision, Number.MAX_SAFE_INTEGER))
    return false;
  if (
    args.specFingerprint !== undefined &&
    (typeof args.specFingerprint !== 'string' || args.specFingerprint.trim().length === 0)
  ) {
    return false;
  }
  if ((args.specRevision === undefined) !== (args.specFingerprint === undefined)) return false;
  if (args.replaySnapshot !== undefined && typeof args.replaySnapshot !== 'boolean') return false;
  if (args.includeDraft !== undefined && typeof args.includeDraft !== 'boolean') return false;
  if (args.evaluatorBuild !== undefined && !isRecord(args.evaluatorBuild)) return false;
  if (args.now !== undefined && (typeof args.now !== 'string' || args.now.trim().length === 0)) return false;
  // listSpecClauses is uncapped unless the evaluator narrows it through exact
  // evidence/spec selectors. Require both an explicit evidence page cap and a
  // selector so this recovery exception cannot admit the generic evaluator path.
  return ['workItemIds', 'evidenceRefs', 'specIds'].some((field) => args[field] !== undefined);
}

function isBoundedJudgeDegenerateCheckArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  for (const field of ['sinceHours', 'minDecisions']) {
    if (args[field] !== undefined && typeof args[field] !== 'number') return false;
  }
  const sinceHours = args.sinceHours;
  if (
    sinceHours !== undefined &&
    (typeof sinceHours !== 'number' ||
      !Number.isFinite(sinceHours) ||
      sinceHours <= 0 ||
      sinceHours > CRITICAL_JUDGE_AUDIT_MAX_SINCE_HOURS)
  ) {
    return false;
  }
  if (
    args.minDecisions !== undefined &&
    !isBoundedPositiveInt(args.minDecisions, CRITICAL_JUDGE_AUDIT_MAX_MIN_DECISIONS)
  ) {
    return false;
  }
  return true;
}

function isBoundedJudgeSpecEvidenceArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  if (typeof args.slug !== 'string' || args.slug.trim().length === 0) return false;
  if (args.harness !== undefined && (typeof args.harness !== 'string' || args.harness.trim().length === 0))
    return false;
  if (!isBoundedPositiveInt(args.limit, CRITICAL_JUDGE_AUDIT_MAX_ROWS)) return false;
  for (const field of ['workItemIds', 'specIds', 'sourceValIds', 'evidenceRefs']) {
    if (args[field] !== undefined && !isBoundedStringArray(args[field])) return false;
  }
  if (
    args.evidenceKinds !== undefined &&
    (!isBoundedStringArray(args.evidenceKinds, 8) || !args.evidenceKinds.every((kind) => SPEC_EVIDENCE_KINDS.has(kind)))
  ) {
    return false;
  }
  if (
    args.currentness !== undefined &&
    (!isBoundedStringArray(args.currentness, 3) ||
      !args.currentness.every((value) => value === 'current' || value === 'stale' || value === 'unknown'))
  ) {
    return false;
  }
  if (args.current !== undefined && !isBoundedEvidenceCurrent(args.current)) return false;
  const hasSelector = ['workItemIds', 'specIds', 'sourceValIds', 'evidenceKinds', 'evidenceRefs', 'currentness'].some(
    (field) => args[field] !== undefined,
  );
  return hasSelector;
}

/**
 * A judge's grading audit also needs the canonical clause read, but
 * `plans:get-specs` has no result-page limit of its own. Admit only a bounded
 * current read with an explicit selector; history and selector-free reads stay
 * on the ordinary pressure-shed path.
 */
function isBoundedJudgeGetSpecsArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set(['harness', 'slug', 'specIds', 'revision', 'includeHistory']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  if (
    typeof args.slug !== 'string' ||
    args.slug.trim().length === 0 ||
    args.slug.length > CRITICAL_PLANS_SEARCH_MAX_SLUG_CHARS
  ) {
    return false;
  }
  if (
    args.harness !== undefined &&
    !isBoundedCriticalText(args.harness, CRITICAL_PLANS_SEARCH_MAX_HARNESS_CHARS, true)
  ) {
    return false;
  }
  if (args.includeHistory !== undefined && args.includeHistory !== false) return false;
  if (args.revision !== undefined && !isBoundedPositiveInt(args.revision, Number.MAX_SAFE_INTEGER)) return false;
  return (
    isBoundedStringArray(args.specIds) &&
    (args.specIds as string[]).every((id) => id.length <= CRITICAL_PLANS_SEARCH_MAX_SLUG_CHARS)
  );
}

/**
 * A grading-integrity audit needs to re-read one authoritative issue after a
 * validator or scorecard points at it. `issues:list` normally performs a page
 * plus an unbounded total count and its `q` filter is a title/body substring,
 * so reserve the critical-pressure lane only for the exact production issue-id
 * shape, with the body explicitly requested and a small result page. Other
 * filters, rollups, and free-text searches stay on the ordinary shed path.
 */
export function isBoundedJudgeIssuesListArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set(['q', 'includeBody', 'limit']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  if (
    typeof args.q !== 'string' ||
    args.q.length === 0 ||
    args.q.length > CRITICAL_ISSUES_LIST_MAX_QUERY_CHARS ||
    !/^EI-[0-9]+$/.test(args.q)
  ) {
    return false;
  }
  if (args.includeBody !== true) return false;
  return (
    Number.isInteger(args.limit) &&
    (args.limit as number) >= 1 &&
    (args.limit as number) <= CRITICAL_ISSUES_LIST_MAX_LIMIT
  );
}

function isBoundedScratchCapabilityReadArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const record = args as Record<string, unknown>;
  const paths = [record.uri, record.file_path].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (paths.length !== 1) return false;
  const path = paths[0];
  // Result-door uses `.spill` for self-describing scratch references and `.md`
  // for the ordinary text spill path. Both are recoverable scratch pages and
  // must remain available under critical pressure; requiring either extension
  // keeps arbitrary scratch files outside the recovery reserve.
  const scratchSpill =
    path.startsWith('papercusp://scratch/') ||
    /(?:^|[/\\])\.papercusp[/\\]scratch[/\\].+\.(?:spill|md)$/.test(path);
  if (!scratchSpill) return false;

  // Structured content selection is a valid recovery mode for stable result-door
  // references. Keep it separate from byte paging so critical pressure admits only
  // the bounded selector and cannot be widened with another window or evidence mode.
  if (record.content_indexes !== undefined) {
    if (
      !Array.isArray(record.content_indexes) ||
      record.content_indexes.length < 1 ||
      record.content_indexes.length > CRITICAL_CAPABILITY_READ_MAX_CONTENT_INDEXES ||
      record.content_indexes.some((index) => !Number.isInteger(index) || index < 0)
    ) return false;
    if (record.raw !== undefined && typeof record.raw !== 'boolean') return false;
    for (const field of ['offset', 'limit', 'tail', 'byte_offset', 'byte_limit', 'evidence_class']) {
      if (record[field] !== undefined) return false;
    }
    return Object.keys(record).every((field) =>
      ['uri', 'file_path', 'content_indexes', 'raw'].includes(field),
    );
  }

  if (!Number.isInteger(record.byte_offset) || (record.byte_offset as number) < 0) return false;
  if (
    !Number.isInteger(record.byte_limit) ||
    (record.byte_limit as number) < 1 ||
    (record.byte_limit as number) > CRITICAL_CAPABILITY_READ_MAX_BYTES
  ) return false;
  for (const field of ['offset', 'limit', 'tail', 'raw', 'content_indexes', 'evidence_class']) {
    if (record[field] !== undefined) return false;
  }
  return true;
}

function isBoundedWorkItemsGetArgs(args: unknown): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const record = args as {
    id?: unknown;
    ids?: unknown;
    detail?: unknown;
    threadLimit?: unknown;
  };
  const singleId = typeof record.id === 'string' && record.id.trim().length > 0 && record.ids === undefined;
  const singleIds = Array.isArray(record.ids)
    && record.ids.length === 1
    && typeof record.ids[0] === 'string'
    && record.id === undefined;
  if (!singleId && !singleIds) return false;
  const boundedThread =
    typeof record.threadLimit === 'number' &&
    Number.isInteger(record.threadLimit) &&
    record.threadLimit >= 1 &&
    record.threadLimit <= CRITICAL_WORK_ITEMS_GET_THREAD_LIMIT_MAX;
  const detailDisabled = record.detail === undefined || record.detail === false || record.detail === 'summary';
  const detailEnabled = record.detail === true || record.detail === 'full';
  // The handler gives an explicit bounded threadLimit precedence over
  // detail:true, so this combination is still the cheap thread-window path.
  // A detail request without that bound must remain shed.
  if (!detailDisabled && !(detailEnabled && boundedThread)) return false;
  if (record.threadLimit !== undefined && record.threadLimit !== 0 && !boundedThread) return false;
  return true;
}

/**
 * `work_items:list` is the post-timeout reconciliation read for a caller's
 * currently held work. Its ordinary form can scan both work-item families and
 * return up to 500 rows, so it must not become a critical-pressure escape hatch
 * for backlog browsing. Require an explicit caller-owned selector and a small
 * page; allow only the cheap lifecycle filters needed to distinguish an open
 * claim from a terminal/retryable state. `assignee:'self'` and `mine:true` are
 * the two published spellings of the same caller-relative filter.
 */
export function isBoundedWorkItemsListArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set([
    'harness',
    'assignee',
    'mine',
    'state',
    'states',
    'notTerminal',
    'limit',
    'includeObservations',
  ]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;

  if (args.mine !== undefined && args.mine !== true) return false;
  if (args.assignee !== undefined && args.assignee !== 'self') return false;
  if (args.mine !== true && args.assignee !== 'self') return false;
  if (
    args.harness !== undefined &&
    !isBoundedCriticalText(args.harness, CRITICAL_WORK_ITEMS_LIST_MAX_HARNESS_CHARS, true)
  ) {
    return false;
  }
  if (
    !Number.isInteger(args.limit) ||
    (args.limit as number) < 1 ||
    (args.limit as number) > CRITICAL_WORK_ITEMS_LIST_MAX_LIMIT
  ) {
    return false;
  }
  if (args.state !== undefined && args.states !== undefined) return false;
  const stateFilter = args.state ?? args.states;
  if (stateFilter !== undefined) {
    const states = Array.isArray(stateFilter) ? stateFilter : [stateFilter];
    if (
      states.length < 1 ||
      states.length > CRITICAL_WORK_ITEMS_LIST_MAX_STATES ||
      !states.every((state) =>
        isBoundedCriticalText(state, CRITICAL_WORK_ITEMS_LIST_MAX_STATE_CHARS, true),
      )
    ) {
      return false;
    }
  }
  if (args.notTerminal !== undefined && args.notTerminal !== true) return false;
  if (args.includeObservations !== undefined && args.includeObservations !== false) return false;
  return true;
}

function isBoundedWorkItemsCompleteJson(value: unknown, depth = 0): boolean {
  if (depth > CRITICAL_WORK_ITEMS_COMPLETE_MAX_NESTING) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= CRITICAL_WORK_ITEMS_COMPLETE_MAX_STRING_CHARS;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    return (
      value.length <= CRITICAL_WORK_ITEMS_COMPLETE_MAX_ARRAY_ITEMS &&
      value.every((entry) => isBoundedWorkItemsCompleteJson(entry, depth + 1))
    );
  }
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length <= CRITICAL_WORK_ITEMS_COMPLETE_MAX_OBJECT_KEYS &&
    keys.every(
      (key) => key.length <= 120 && isBoundedWorkItemsCompleteJson(value[key], depth + 1),
    )
  );
}

/**
 * `work_items:complete` is a durable continuation write, and the outer MCP
 * proxy already gives it a bounded priority lane. Keep the inner pressure
 * exception to one single-item completion envelope so a valid terminal,
 * record-only, or `validateOnly` call can finish/reconcile while critical
 * pressure is active without admitting the normal bulk or arbitrary-payload
 * surface. Flat completion aliases are accepted because the handler gathers
 * them into `completion` before schema validation.
 */
export function isBoundedWorkItemsCompleteArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set([
    'id',
    'harness',
    'state',
    'boundaryNote',
    'completion',
    'outputPayload',
    'specAdequacy',
    'validateOnly',
    'assumptions',
    ...CRITICAL_WORK_ITEMS_COMPLETE_FLAT_FIELDS,
  ]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  if (
    typeof args.id !== 'string' ||
    args.id.trim().length === 0 ||
    args.id.length > CRITICAL_WORK_ITEMS_COMPLETE_MAX_ID_CHARS
  ) {
    return false;
  }
  if (
    args.harness !== undefined &&
    (typeof args.harness !== 'string' || args.harness.length > CRITICAL_WORK_ITEMS_COMPLETE_MAX_HARNESS_CHARS)
  ) {
    return false;
  }
  if (
    args.state !== undefined &&
    (typeof args.state !== 'string' ||
      args.state.trim().length === 0 ||
      args.state.length > CRITICAL_WORK_ITEMS_COMPLETE_MAX_STATE_CHARS)
  ) {
    return false;
  }
  if (
    args.boundaryNote !== undefined &&
    (typeof args.boundaryNote !== 'string' ||
      args.boundaryNote.trim().length === 0 ||
      args.boundaryNote.length > CRITICAL_WORK_ITEMS_COMPLETE_MAX_BOUNDARY_NOTE_CHARS)
  ) {
    return false;
  }
  if (args.validateOnly !== undefined && typeof args.validateOnly !== 'boolean') return false;
  if (args.assumptions !== undefined) {
    if (args.assumptions === 'none') {
      // Explicitly no assumptions is a valid terminal declaration.
    } else if (
      !Array.isArray(args.assumptions) ||
      args.assumptions.length < 1 ||
      args.assumptions.length > 10 ||
      !args.assumptions.every(
        (key) =>
          typeof key === 'string' &&
          key.trim().length > 0 &&
          key.length <= 120,
      )
    ) {
      return false;
    }
  }

  const hasCompletionObject = isRecord(args.completion);
  const hasFlatCompletion = Object.keys(args).some((key) => CRITICAL_WORK_ITEMS_COMPLETE_FLAT_FIELDS.has(key));
  if (!hasCompletionObject && !hasFlatCompletion) return false;
  if (args.completion !== undefined && !hasCompletionObject) return false;
  if (args.outputPayload !== undefined && !isBoundedWorkItemsCompleteJson(args.outputPayload)) return false;
  if (args.specAdequacy !== undefined && !isBoundedWorkItemsCompleteJson(args.specAdequacy)) return false;

  let encoded: string;
  try {
    encoded = JSON.stringify(args);
  } catch {
    return false;
  }
  return encoded.length <= CRITICAL_WORK_ITEMS_COMPLETE_MAX_ARGUMENT_CHARS && isBoundedWorkItemsCompleteJson(args);
}

/**
 * `docs:get` is the canonical runbook read needed to recover a stalled lane,
 * but its normal schema can batch ten pages and page a large source. Keep the
 * critical-pressure exception to one bounded slug and the engine's own capped
 * single-page controls. Unknown/enriched fields, batches, and a partial source
 * slice remain on the retryable path so the recovery reserve cannot become a
 * document export lane.
 */
export function isBoundedDocsGetArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set(['slugs', 'heading', 'offset', 'source', 'harness']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  if (
    !Array.isArray(args.slugs) ||
    args.slugs.length !== 1 ||
    !isBoundedCriticalText(args.slugs[0], CRITICAL_DOCS_GET_MAX_SLUG_CHARS, true)
  ) {
    return false;
  }
  if (
    args.heading !== undefined &&
    !isBoundedCriticalText(args.heading, CRITICAL_DOCS_GET_MAX_HEADING_CHARS, true)
  ) {
    return false;
  }
  if (
    args.offset !== undefined &&
    (!Number.isSafeInteger(args.offset) || (args.offset as number) < 0)
  ) {
    return false;
  }
  if (args.source !== undefined && typeof args.source !== 'boolean') return false;
  // The docs engine refuses this combination: a heading slice is not a whole
  // canonical document, so do not reserve pressure capacity for it.
  if (args.source === true && args.heading !== undefined) return false;
  if (
    args.harness !== undefined &&
    !isBoundedCriticalText(args.harness, CRITICAL_DOCS_GET_MAX_HARNESS_CHARS, true)
  ) {
    return false;
  }
  return true;
}

/**
 * `docs:search` is the keyword lookup used when a recovery runbook's slug is
 * unknown, but its default semantic leg and filesystem-backed corpus scan can
 * add substantial work under critical pressure. Admit only the lexical-only
 * form with the tool schema's bounded query/page limits and an optional
 * bounded harness selector; semantic and enriched forms remain retryable.
 */
export function isBoundedDocsSearchArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set(['query', 'limit', 'harness', 'semantic']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  if (!isBoundedCriticalText(args.query, CRITICAL_DOCS_SEARCH_MAX_QUERY_CHARS, true)) return false;
  if (
    args.limit !== undefined &&
    (!Number.isInteger(args.limit) ||
      (args.limit as number) < 1 ||
      (args.limit as number) > CRITICAL_DOCS_SEARCH_MAX_LIMIT)
  ) {
    return false;
  }
  if (
    args.harness !== undefined &&
    !isBoundedCriticalText(args.harness, CRITICAL_DOCS_SEARCH_MAX_HARNESS_CHARS, true)
  ) {
    return false;
  }
  return args.semantic === false;
}

/**
 * `search:fulltext` is the lexical recovery door for prose and issue triage,
 * but its normal no-scope form fans out across every corpus and its filter bag
 * can trigger identity/fleet/session resolution. Keep the critical-pressure
 * exception to one explicit source, a short query, a five-row page, and an
 * optional bounded harness selector. Filter/enrichment fields and the `all`
 * scope stay on the retryable path.
 */
export function isBoundedSearchFulltextArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set(['query', 'scope', 'harness_slug', 'limit']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  if (!isBoundedCriticalText(args.query, CRITICAL_SEARCH_FULLTEXT_MAX_QUERY_CHARS, true)) return false;
  if (
    !Array.isArray(args.scope) ||
    args.scope.length !== 1 ||
    !isBoundedCriticalText(args.scope[0], 40, true) ||
    !CRITICAL_SEARCH_FULLTEXT_SCOPES.has(args.scope[0])
  ) {
    return false;
  }
  if (
    args.harness_slug !== undefined &&
    !isBoundedCriticalText(args.harness_slug, CRITICAL_SEARCH_FULLTEXT_MAX_HARNESS_CHARS, true)
  ) {
    return false;
  }
  if (
    args.limit !== undefined &&
    (!Number.isInteger(args.limit) ||
      (args.limit as number) < 1 ||
      (args.limit as number) > CRITICAL_SEARCH_FULLTEXT_MAX_LIMIT)
  ) {
    return false;
  }
  return true;
}

/**
 * `work_items:search` is the duplicate-detection read used during triage, but
 * its default semantic leg can invoke the embedder and its normal result limit
 * reaches 200 rows before the response shaper runs. Admit only the cheap
 * lexical-only form with a small result page and bounded source filters while
 * critical pressure is active. Explicit `includeObservations:false` is the
 * harmless compatibility spelling of the default; observations and all other
 * enrichment remain on the retryable path.
 */
export function isBoundedWorkItemsSearchArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set(['query', 'harness', 'kind', 'limit', 'semantic', 'includeObservations']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  if (!isBoundedCriticalText(args.query, CRITICAL_WORK_ITEMS_SEARCH_MAX_QUERY_CHARS, true)) return false;
  if (args.semantic !== false) return false;
  if (
    args.harness !== undefined &&
    !isBoundedCriticalText(args.harness, CRITICAL_WORK_ITEMS_SEARCH_MAX_HARNESS_CHARS, true)
  ) {
    return false;
  }
  if (
    args.kind !== undefined &&
    !isBoundedCriticalText(args.kind, CRITICAL_WORK_ITEMS_SEARCH_MAX_KIND_CHARS, true)
  ) {
    return false;
  }
  if (
    args.limit !== undefined &&
    (!Number.isInteger(args.limit) ||
      (args.limit as number) < 1 ||
      (args.limit as number) > CRITICAL_WORK_ITEMS_SEARCH_MAX_LIMIT)
  ) {
    return false;
  }
  if (args.includeObservations !== undefined && args.includeObservations !== false) return false;
  return true;
}

/**
 * `recipes:search` normally acquires an embedder for its semantic leg. During
 * critical pressure, reserve only the explicit lexical-only recovery form:
 * require a small query and result page, and reject the context bag so this
 * exception cannot turn into an authority-enriched search lane.
 */
export function isBoundedRecipesSearchArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set(['query', 'limit', 'semantic']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  if (!isBoundedCriticalText(args.query, CRITICAL_RECIPES_SEARCH_MAX_QUERY_CHARS, true)) return false;
  if (args.semantic !== false) return false;
  return isBoundedPositiveInt(args.limit, CRITICAL_RECIPES_SEARCH_MAX_LIMIT);
}

/**
 * `plans:search` is the plan/decision lookup used to recover context, but its
 * default semantic leg invokes the embedder and its normal page can return 50
 * plans after scanning a 200-row candidate set. Keep that recovery path alive
 * under critical pressure only for the cheap lexical leg, with bounded query,
 * scope, and result-page arguments. Legacy `q` and a single-string scope are
 * accepted because the tool normalizes those forms before its strict schema.
 */
export function isBoundedPlansSearchArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set([
    'query',
    'q',
    'slug',
    'scope',
    'limit',
    'includeArchived',
    'includeLegacy',
    'harness',
    'semantic',
  ]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;

  if (
    args.query !== undefined &&
    !isBoundedCriticalText(args.query, CRITICAL_PLANS_SEARCH_MAX_QUERY_CHARS, true)
  ) {
    return false;
  }
  if (args.q !== undefined && !isBoundedCriticalText(args.q, CRITICAL_PLANS_SEARCH_MAX_QUERY_CHARS, true)) {
    return false;
  }
  if (
    args.slug !== undefined &&
    !isBoundedCriticalText(args.slug, CRITICAL_PLANS_SEARCH_MAX_SLUG_CHARS, true)
  ) {
    return false;
  }
  if (args.query === undefined && args.q === undefined && args.slug === undefined) return false;

  if (args.scope !== undefined) {
    const scopes = typeof args.scope === 'string' ? [args.scope] : args.scope;
    if (
      !Array.isArray(scopes) ||
      scopes.length > CRITICAL_PLANS_SEARCH_MAX_SCOPES ||
      !scopes.every((scope) => typeof scope === 'string' && CRITICAL_PLANS_SEARCH_SCOPES.has(scope))
    ) {
      return false;
    }
  }
  if (
    args.limit !== undefined &&
    (!Number.isInteger(args.limit) ||
      (args.limit as number) < 1 ||
      (args.limit as number) > CRITICAL_PLANS_SEARCH_MAX_LIMIT)
  ) {
    return false;
  }
  for (const field of ['includeArchived', 'includeLegacy']) {
    if (args[field] !== undefined && typeof args[field] !== 'boolean') return false;
  }
  // The default is semantic search; requiring the explicit false is what keeps
  // this exception on the bounded lexical path during critical pressure.
  if (args.semantic !== false) return false;
  if (
    args.harness !== undefined &&
    !isBoundedCriticalText(args.harness, CRITICAL_PLANS_SEARCH_MAX_HARNESS_CHARS, true)
  ) {
    return false;
  }
  return true;
}

/**
 * `git-sync:run` has a read-only preview branch used to inspect the selected
 * checkout after a commit notification, while its normal form fires the
 * commit+push action. Admit only the preview branch during critical pressure;
 * keep the two scope aliases mutually exclusive and cap every caller-supplied
 * string so this recovery exception cannot become a synchronization lane.
 */
export function isBoundedGitSyncRunArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set(['installSlug', 'harness', 'dryRun', 'reason']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  if (args.dryRun !== true) return false;

  const scopes = ['installSlug', 'harness'].filter((field) => args[field] !== undefined);
  if (scopes.length > 1) return false;
  for (const field of scopes) {
    if (!isBoundedCriticalText(args[field], CRITICAL_GIT_SYNC_RUN_MAX_SCOPE_CHARS, true)) return false;
  }
  if (
    args.reason !== undefined &&
    !isBoundedCriticalText(args.reason, CRITICAL_GIT_SYNC_RUN_MAX_REASON_CHARS, true)
  ) {
    return false;
  }
  return true;
}

/**
 * `session:request-compaction` is the recovery boundary for the current
 * context, so it must remain callable while critical pressure sheds ordinary
 * MCP traffic. Keep the exception to the published, bounded wire shape: the
 * optional prompt/annotation strings are capped, legacy booleans retain their
 * boolean type, and `resumeMode` accepts only its documented compatibility
 * literal. The handler still performs the host, carry, and lineage checks.
 */
export function isBoundedSessionRequestCompactionArgs(args: unknown): boolean {
  if (args === undefined) return true;
  if (!isRecord(args)) return false;
  const allowed = new Set(['focus', 'autoContinue', 'resumeMode', 'reason', 'respawn', 'continueNote']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  for (const [field, max] of [
    ['focus', CRITICAL_SESSION_COMPACTION_FOCUS_MAX_CHARS],
    ['continueNote', CRITICAL_SESSION_COMPACTION_CONTINUE_NOTE_MAX_CHARS],
    ['reason', CRITICAL_SESSION_COMPACTION_REASON_MAX_CHARS],
  ] as const) {
    if (args[field] !== undefined && (typeof args[field] !== 'string' || args[field].length > max)) return false;
  }
  for (const field of ['autoContinue', 'respawn'] as const) {
    if (args[field] !== undefined && typeof args[field] !== 'boolean') return false;
  }
  return args.resumeMode === undefined || args.resumeMode === 'same';
}

/**
 * `logs:read` can walk a large journal when it is unscoped, and its normal row
 * ceiling is 1,000. Keep the critical-pressure reserve to one small page with
 * a unit/identifier or explicit time-window selector. The selector is required
 * so an omitted/default call cannot turn the reserve into a host-wide journal
 * scan; all accepted fields are checked here because this gate runs before Zod.
 */
export function isBoundedLogsReadArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set(['unit', 'identifier', 'since', 'until', 'grep', 'level', 'limit', 'scope']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;

  if (args.unit !== undefined) {
    const units = Array.isArray(args.unit) ? args.unit : [args.unit];
    if (
      units.length < 1 ||
      units.length > CRITICAL_LOGS_READ_MAX_UNITS ||
      !units.every((unit) => isBoundedCriticalText(unit, 200, true))
    ) {
      return false;
    }
  }
  for (const [field, max] of [
    ['identifier', 200],
    ['since', 100],
    ['until', 100],
  ] as const) {
    if (args[field] !== undefined && !isBoundedCriticalText(args[field], max, true)) return false;
  }
  if (args.grep !== undefined && !isBoundedCriticalText(args.grep, CRITICAL_LOGS_READ_MAX_GREP_CHARS, true)) {
    return false;
  }
  if (args.level !== undefined && (typeof args.level !== 'string' || !CRITICAL_LOG_LEVELS.has(args.level))) {
    return false;
  }
  if (args.scope !== undefined && (typeof args.scope !== 'string' || !CRITICAL_LOG_SCOPES.has(args.scope))) {
    return false;
  }
  if (!isBoundedPositiveInt(args.limit, CRITICAL_LOGS_READ_MAX_LIMIT)) return false;

  // Without a unit/identifier, the handler requires `since` to avoid walking
  // every unit. Preserve that same safety boundary in the pressure reserve.
  return args.unit !== undefined || args.identifier !== undefined || args.since !== undefined;
}

/**
 * `notifications:recent` already defaults to a 50-row query, so an omitted
 * argument object is bounded. Reject larger explicit pages, unknown fields,
 * and invalid levels before reserving the critical diagnostic lane.
 */
export function isBoundedNotificationsRecentArgs(args: unknown): boolean {
  if (args === undefined) return true;
  if (!isRecord(args)) return false;
  const allowed = new Set(['level', 'limit']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  if (
    args.level !== undefined &&
    (typeof args.level !== 'string' ||
      !new Set(['default', 'info', 'success', 'warning', 'error', 'loading', 'all']).has(args.level))
  ) {
    return false;
  }
  if (args.limit !== undefined && !isBoundedPositiveInt(args.limit, CRITICAL_NOTIFICATIONS_RECENT_MAX_LIMIT)) {
    return false;
  }
  return true;
}

/**
 * `testing:runs` performs a ledger read plus a total/latest-per-file query, so
 * a small `limit` alone is not enough to bound the work. Require one selective
 * identity/time selector, cap rows and exact-id lookups, and keep the published
 * enums/compatibility aliases explicit. A testRunIds-only read may omit limit
 * because the handler derives it from the bounded id list.
 */
export function isBoundedTestingRunsArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set([
    'testRunIds',
    'filePath',
    'commitSha',
    'runGroup',
    'runGroupId',
    'status',
    'source',
    'since',
    'sinceHours',
    'workspace',
    'harness',
    'rollup',
    'latestPerFile',
    'limit',
  ]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;

  if (args.testRunIds !== undefined) {
    if (
      !Array.isArray(args.testRunIds) ||
      args.testRunIds.length < 1 ||
      args.testRunIds.length > CRITICAL_TESTING_RUNS_MAX_IDS ||
      !args.testRunIds.every((id) => Number.isSafeInteger(id) && id > 0)
    ) {
      return false;
    }
  }
  for (const [field, max] of [
    ['filePath', 400],
    ['commitSha', 80],
    ['runGroup', 200],
    ['runGroupId', 200],
    ['since', 64],
    ['workspace', 120],
    ['harness', 120],
  ] as const) {
    if (args[field] !== undefined && !isBoundedCriticalText(args[field], max, true)) return false;
  }
  if (
    args.status !== undefined &&
    (!Array.isArray(args.status) ||
      args.status.length < 1 ||
      args.status.length > CRITICAL_TESTING_RUNS_MAX_STATUS ||
      !args.status.every((status) => typeof status === 'string' && CRITICAL_TESTING_RUN_STATUSES.has(status)))
  ) {
    return false;
  }
  if (args.source !== undefined && (typeof args.source !== 'string' || !CRITICAL_TESTING_RUN_SOURCES.has(args.source))) {
    return false;
  }
  if (
    args.sinceHours !== undefined &&
    (typeof args.sinceHours !== 'number' ||
      !Number.isFinite(args.sinceHours) ||
      args.sinceHours <= 0 ||
      args.sinceHours > CRITICAL_TESTING_RUNS_MAX_SINCE_HOURS)
  ) {
    return false;
  }
  if (args.rollup !== undefined && args.rollup !== 'commit' && args.rollup !== 'runGroup') return false;
  if (args.latestPerFile !== undefined && typeof args.latestPerFile !== 'boolean') return false;
  if (args.limit !== undefined && !isBoundedPositiveInt(args.limit, CRITICAL_TESTING_RUNS_MAX_LIMIT)) return false;

  const hasSelectiveSelector = [
    'testRunIds',
    'filePath',
    'commitSha',
    'runGroup',
    'runGroupId',
    'since',
    'sinceHours',
  ].some((field) => args[field] !== undefined);
  if (!hasSelectiveSelector) return false;

  // The handler defaults to 30 rows. Exact IDs derive a smaller effective
  // limit from their own bounded list; every other form must state its cap.
  return args.limit !== undefined || args.testRunIds !== undefined;
}

/**
 * `testing:run-status` is the documented recovery read after a detached
 * `testing:run` timeout. Its handler reads one store-backed snapshot keyed by
 * one run id and the snapshot's output is already bounded. Keep the critical
 * pressure exemption to the exact one-field schema so arbitrary fields cannot
 * turn the recovery reserve into an unbounded testing surface.
 */
export function isBoundedTestingRunStatusArgs(args: unknown): boolean {
  if (!isRecord(args) || Object.keys(args).some((key) => key !== 'runId')) return false;
  return (
    typeof args.runId === 'string' &&
    args.runId.trim().length > 0 &&
    args.runId.length <= CRITICAL_TESTING_RUN_STATUS_MAX_RUN_ID_CHARS
  );
}

function isBoundedActivityToolLogBoundary(value: unknown): value is string {
  return (
    isBoundedCriticalText(value, CRITICAL_ACTIVITY_TOOL_LOG_MAX_BOUNDARY_CHARS, true) &&
    ACTIVITY_TOOL_LOG_ISO_BOUNDARY_RE.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/**
 * `activity:tool-log` is the compact recovery view for reconstructing what a
 * session or owner actually did. Its normal handler is already decayed and
 * line-bounded, but an unscoped call can still scan the whole activity ledger.
 * Keep the critical-pressure reserve to one explicit owner/session scope and
 * the handler's default-sized display budgets; the normal schema remains the
 * final authority after admission.
 */
export function isBoundedActivityToolLogArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set(['owner', 'session_id', 'since', 'until', 'max_lines', 'top_k']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;

  const hasOwner = args.owner !== undefined;
  const hasSession = args.session_id !== undefined;
  if (!hasOwner && !hasSession) return false;
  if (
    hasOwner &&
    !isBoundedCriticalText(args.owner, CRITICAL_ACTIVITY_TOOL_LOG_MAX_SCOPE_CHARS, true)
  ) {
    return false;
  }
  if (
    hasSession &&
    !isBoundedCriticalText(args.session_id, CRITICAL_ACTIVITY_TOOL_LOG_MAX_SCOPE_CHARS, true)
  ) {
    return false;
  }
  for (const field of ['since', 'until']) {
    if (args[field] !== undefined && !isBoundedActivityToolLogBoundary(args[field])) return false;
  }
  if (
    args.max_lines !== undefined &&
    (!Number.isInteger(args.max_lines) ||
      (args.max_lines as number) < 5 ||
      (args.max_lines as number) > CRITICAL_ACTIVITY_TOOL_LOG_MAX_LINES)
  ) {
    return false;
  }
  if (
    args.top_k !== undefined &&
    (!Number.isInteger(args.top_k) ||
      (args.top_k as number) < 1 ||
      (args.top_k as number) > CRITICAL_ACTIVITY_TOOL_LOG_MAX_TOP_K)
  ) {
    return false;
  }
  return true;
}

/**
 * `sessions:search` is the documented post-compaction self-recall door, but
 * its default hybrid mode can acquire an embedding and its general filter bag
 * can search the whole session corpus. Keep the critical-pressure exemption to
 * the exact cheap recovery shape: one verbatim query over the caller's own
 * respawn chain, with a small result/context page and no coord corpus or
 * pagination. The normal handler remains authoritative for the full schema
 * after pressure recovers.
 */
export function isBoundedSessionsSearchArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set(['query', 'mode', 'session', 'limit', 'context', 'include_coord']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  if (
    typeof args.query !== 'string' ||
    args.query.trim().length === 0 ||
    args.query.length > CRITICAL_SESSIONS_SEARCH_MAX_QUERY_CHARS
  ) {
    return false;
  }
  if (args.mode !== 'verbatim' || args.session !== 'self') return false;
  if (args.include_coord !== undefined && args.include_coord !== false) return false;
  if (
    args.limit !== undefined &&
    (!Number.isInteger(args.limit) ||
      (args.limit as number) < 1 ||
      (args.limit as number) > CRITICAL_SESSIONS_SEARCH_MAX_LIMIT)
  ) {
    return false;
  }
  if (
    args.context !== undefined &&
    (!Number.isInteger(args.context) ||
      (args.context as number) < 0 ||
      (args.context as number) > CRITICAL_SESSIONS_SEARCH_MAX_CONTEXT)
  ) {
    return false;
  }
  return true;
}

/**
 * facts:list supports broad pages and version history, but recovery needs one
 * exact live fact. Its no-versions key branch reads at most one live version
 * plus bounded typed-slot aliases. Admit only a canonical scope/key selector
 * and an optional bounded scopeRef/full-body flag.
 */
export function isBoundedFactsListArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set(['scope', 'scopeRef', 'key', 'full']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  if (!['workspace', 'role', 'owner', 'harness', 'work_item'].includes(args.scope as string)) return false;
  if (
    typeof args.key !== 'string' ||
    args.key.trim().length === 0 ||
    args.key.length > CRITICAL_FACTS_LIST_MAX_KEY_CHARS
  ) {
    return false;
  }
  if (
    args.scopeRef !== undefined &&
    (typeof args.scopeRef !== 'string' ||
      args.scopeRef.trim().length === 0 ||
      args.scopeRef.length > CRITICAL_FACTS_LIST_MAX_SCOPE_REF_CHARS)
  ) {
    return false;
  }
  if (args.scope === 'workspace' && args.scopeRef !== undefined) return false;
  if (args.full !== undefined && typeof args.full !== 'boolean') return false;
  return true;
}

/**
 * `sessions:timeline` is the historical recovery read used to reconstruct a
 * stale wake's actual tool/coord activity, but its normal page may request up
 * to 300 merged entries from three sources. Keep the critical-pressure
 * exception to one owner and a bounded page, with only the published filters
 * and cursor controls. Invalid, expanded, and unknown fields stay on the
 * ordinary pressure-shed path so this recovery reserve cannot become an
 * unrestricted timeline export lane.
 */
export function isBoundedSessionsTimelineArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  // `projection` is reserved dispatch metadata, accepted both on a direct
  // tools/call and inside tools:invoke's nested target args. The dispatcher
  // validates and strips it before sessions:timeline sees its input schema;
  // mirror that normalization here so a bounded diagnostic is not shed just
  // because the caller asks the proxy to reduce its result.
  const timelineArgs = { ...args };
  if (PROJECTION_ARG in timelineArgs) {
    if (!parseProjection(timelineArgs[PROJECTION_ARG]).ok) return false;
    delete timelineArgs[PROJECTION_ARG];
  }
  const allowed = new Set([
    'owner',
    'since',
    'until',
    'limit',
    'kinds',
    'tool',
    'status',
    'goalRef',
    'include_auto',
    'group_repeated',
    'cursor',
  ]);
  if (Object.keys(timelineArgs).some((key) => !allowed.has(key))) return false;
  if (
    typeof timelineArgs.owner !== 'string' ||
    timelineArgs.owner.trim().length === 0 ||
    timelineArgs.owner.length > CRITICAL_SESSIONS_TIMELINE_MAX_OWNER_CHARS
  ) {
    return false;
  }
  for (const field of ['since', 'until'] as const) {
    if (
      timelineArgs[field] !== undefined &&
      (typeof timelineArgs[field] !== 'string' ||
        timelineArgs[field].trim().length === 0 ||
        timelineArgs[field].length > CRITICAL_SESSIONS_TIMELINE_MAX_BOUND_CHARS)
    ) {
      return false;
    }
  }
  if (
    timelineArgs.limit !== undefined &&
    (!Number.isInteger(timelineArgs.limit) ||
      (timelineArgs.limit as number) < 1 ||
      (timelineArgs.limit as number) > CRITICAL_SESSIONS_TIMELINE_MAX_LIMIT)
  ) {
    return false;
  }
  if (
    timelineArgs.kinds !== undefined &&
    (!Array.isArray(timelineArgs.kinds) ||
      timelineArgs.kinds.length > 3 ||
      timelineArgs.kinds.some((kind) => !['turn', 'tool', 'coord'].includes(kind as string)))
  ) {
    return false;
  }
  for (const [field, max] of [
    ['tool', CRITICAL_SESSIONS_TIMELINE_MAX_TOOL_CHARS],
    ['status', CRITICAL_SESSIONS_TIMELINE_MAX_STATUS_CHARS],
    ['goalRef', CRITICAL_SESSIONS_TIMELINE_MAX_GOAL_REF_CHARS],
    ['cursor', CRITICAL_SESSIONS_TIMELINE_MAX_CURSOR_CHARS],
  ] as const) {
    if (
      timelineArgs[field] !== undefined &&
      (typeof timelineArgs[field] !== 'string' ||
        timelineArgs[field].trim().length === 0 ||
        timelineArgs[field].length > max)
    ) {
      return false;
    }
  }
  if (timelineArgs.include_auto !== undefined && typeof timelineArgs.include_auto !== 'boolean') return false;
  if (timelineArgs.group_repeated !== undefined && typeof timelineArgs.group_repeated !== 'boolean') return false;
  return true;
}

/**
 * `work_items:set_state` is the retryable lifecycle writer used to settle a
 * claim during a drain, but its normal schema also accepts two bulk forms and
 * terminal evidence/assumption payloads. Keep the critical-pressure reserve to
 * exactly one target, while validating the bounded fields that can otherwise
 * make the admitted request expensive before Zod rejects it. Mixed selectors,
 * batches, and ignored top-level fields remain on the ordinary shed path.
 */
export function isBoundedWorkItemsSetStateArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;

  const fieldNames = new Set([
    'id',
    'state',
    'harness',
    'decision',
    'ids',
    'items',
    'completionRef',
    'reason',
    'note',
    'assumptions',
    'force',
  ]);
  if (Object.keys(args).some((key) => !fieldNames.has(key))) return false;

  const boundedString = (value: unknown, max: number, required = false): value is string =>
    typeof value === 'string' &&
    value.length <= max &&
    (!required || value.trim().length > 0);

  const validateOptionalFields = (record: Record<string, unknown>): boolean => {
    if (
      record.harness !== undefined &&
      !boundedString(record.harness, CRITICAL_WORK_ITEMS_SET_STATE_MAX_HARNESS_CHARS)
    ) {
      return false;
    }
    for (const field of ['completionRef', 'reason', 'note']) {
      if (
        record[field] !== undefined &&
        !boundedString(record[field], CRITICAL_WORK_ITEMS_SET_STATE_MAX_EVIDENCE_CHARS, true)
      ) {
        return false;
      }
    }
    if (record.assumptions !== undefined) {
      if (record.assumptions === 'none') {
        // Explicitly no assumptions is a valid terminal declaration.
      } else if (
        !Array.isArray(record.assumptions) ||
        record.assumptions.length < 1 ||
        record.assumptions.length > CRITICAL_WORK_ITEMS_SET_STATE_MAX_ASSUMPTION_KEYS ||
        !record.assumptions.every((key) =>
          boundedString(key, CRITICAL_WORK_ITEMS_SET_STATE_MAX_ASSUMPTION_KEY_CHARS, true),
        )
      ) {
        return false;
      }
    }
    if (record.force !== undefined && typeof record.force !== 'boolean') return false;
    if (record.decision !== undefined) {
      if (!isRecord(record.decision)) return false;
      const decision = record.decision;
      if (Object.keys(decision).some((key) => !['riskTier', 'authority'].includes(key))) return false;
      if (
        decision.riskTier !== undefined &&
        !['trivial', 'low', 'moderate', 'high', 'critical'].includes(decision.riskTier as string)
      ) {
        return false;
      }
      if (decision.authority !== undefined && !['system', 'owner'].includes(decision.authority as string)) {
        return false;
      }
    }
    return true;
  };

  const validateTarget = (record: Record<string, unknown>): boolean =>
    boundedString(record.id, CRITICAL_WORK_ITEMS_SET_STATE_MAX_ID_CHARS, true) &&
    boundedString(record.state, CRITICAL_WORK_ITEMS_SET_STATE_MAX_STATE_CHARS, true) &&
    validateOptionalFields(record);

  const hasInlineTarget = args.id !== undefined;
  const hasIdsTarget = args.ids !== undefined;
  const hasItemsTarget = args.items !== undefined;
  if (Number(hasInlineTarget) + Number(hasIdsTarget) + Number(hasItemsTarget) !== 1) return false;

  if (hasItemsTarget) {
    // The item's own fields carry the target. A top-level harness is the only
    // shared/default field that remains unambiguous in this form.
    if (Object.keys(args).some((key) => key !== 'items' && key !== 'harness')) return false;
    if (
      args.harness !== undefined &&
      !boundedString(args.harness, CRITICAL_WORK_ITEMS_SET_STATE_MAX_HARNESS_CHARS)
    ) {
      return false;
    }
    return (
      Array.isArray(args.items) &&
      args.items.length === 1 &&
      isRecord(args.items[0]) &&
      Object.keys(args.items[0]).every((key) => fieldNames.has(key) && !['ids', 'items'].includes(key)) &&
      validateTarget(args.items[0])
    );
  }

  if (hasIdsTarget) {
    if (args.id !== undefined || args.items !== undefined || !Array.isArray(args.ids) || args.ids.length !== 1) {
      return false;
    }
    return (
      boundedString(args.ids[0], CRITICAL_WORK_ITEMS_SET_STATE_MAX_ID_CHARS, true) &&
      boundedString(args.state, CRITICAL_WORK_ITEMS_SET_STATE_MAX_STATE_CHARS, true) &&
      validateOptionalFields(args)
    );
  }

  if (args.ids !== undefined || args.items !== undefined) return false;
  return validateTarget(args);
}

/**
 * `coord:declare-intent` is the required post-compaction presence/lane
 * re-declaration, so it must remain usable while the operator is shedding
 * ordinary calls. Keep the recovery exception to the bounded core declaration
 * shape: intent, an optional plan/harness, and at most the schema's 40 P-NNN
 * lane ids. Enriched file/goal/exclusion payloads stay on the ordinary path.
 */
export function isBoundedCoordDeclareIntentArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set(['intent', 'current_plan_slug', 'items', 'harness']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  if (
    typeof args.intent !== 'string' ||
    args.intent.trim().length === 0 ||
    args.intent.length > CRITICAL_DECLARE_INTENT_MAX_INTENT_CHARS
  ) {
    return false;
  }
  if (
    args.current_plan_slug !== undefined &&
    args.current_plan_slug !== null &&
    (typeof args.current_plan_slug !== 'string' ||
      args.current_plan_slug.trim().length === 0 ||
      args.current_plan_slug.length > CRITICAL_DECLARE_INTENT_MAX_PLAN_CHARS)
  ) {
    return false;
  }
  if (
    args.harness !== undefined &&
    (typeof args.harness !== 'string' ||
      args.harness.trim().length === 0 ||
      args.harness.length > CRITICAL_DECLARE_INTENT_MAX_HARNESS_CHARS)
  ) {
    return false;
  }
  if (args.items === undefined) return true;
  if (
    !Array.isArray(args.items) ||
    args.items.length > CRITICAL_DECLARE_INTENT_MAX_ITEMS ||
    !args.items.every((item) => typeof item === 'string' && /^P-\d{3,}$/.test(item))
  ) {
    return false;
  }
  return args.items.length === 0 || typeof args.current_plan_slug === 'string';
}

/**
 * `capability:bash_output` is the recovery/status door for a background task,
 * but its optional filter/peek/tail controls can turn a pressure diagnostic into
 * an arbitrarily expensive output read. Keep the critical-pressure exception to
 * exactly one bounded job handle and no output modifiers. The normal handler
 * still accepts the full schema once pressure recovers.
 */
export function isBoundedBashOutputArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set(['bash_id', 'task_id']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;

  const validId = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0 && value.length <= CRITICAL_BASH_OUTPUT_ID_MAX_CHARS;
  if (args.bash_id !== undefined && !validId(args.bash_id)) return false;
  if (args.task_id !== undefined && !validId(args.task_id)) return false;
  return (args.bash_id !== undefined) !== (args.task_id !== undefined);
}

/**
 * `plans:get` is a composite read whose default/full forms can load an entire
 * plan, its decisions, and history decorations. The critical-pressure recovery
 * exception is limited to one heading-narrowed read: a caller can inspect the
 * Decisions section or one P-NNN subsection, while bulk slugs, selectors,
 * full-mode payloads, and ship-readiness evaluation remain shed. `detail:'full'`
 * is accepted only alongside explicit `mode:'sections'`, because the handler's
 * canonical mode takes precedence over that compatibility alias.
 */
function isBoundedPlansGetArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set(['slug', 'harness', 'heading', 'mode', 'detail']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  if (!isBoundedCriticalText(args.slug, 200, true)) return false;
  if (
    args.harness !== undefined &&
    !isBoundedCriticalText(args.harness, CRITICAL_LOOP_STATUS_MAX_STRING_CHARS, true)
  ) {
    return false;
  }
  if (!isBoundedCriticalText(args.heading, 120, true)) return false;
  const heading = args.heading.trim().toLowerCase();
  if (heading !== 'decisions' && !/^p-\d{3,}$/.test(heading)) return false;
  if (args.mode !== undefined && args.mode !== 'sections') return false;
  if (
    args.detail !== undefined &&
    !(
      args.detail === false ||
      args.detail === 'summary' ||
      (args.mode === 'sections' && (args.detail === true || args.detail === 'full'))
    )
  ) {
    return false;
  }
  return true;
}

/**
 * `locks:queue` is the file-lock ownership read needed to make safe progress,
 * but its unfiltered form can scan every checkout and its completed-waiter
 * option adds a 24-hour history read. Keep the critical-pressure exemption to
 * an explicit, bounded path filter so recovery can inspect the files it is
 * about to touch without opening a workspace-wide diagnostic lane.
 */
export function isBoundedLocksQueueArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set(['coordination_domain', 'paths', 'external_paths', 'owner', 'include_completed']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;

  const validPaths =
    args.paths === undefined ||
    (Array.isArray(args.paths) &&
      args.paths.length <= CRITICAL_LOCKS_QUEUE_MAX_PATHS &&
      args.paths.every(
        (path) =>
          typeof path === 'string' &&
          path.trim().length > 0 &&
          path.length <= CRITICAL_LOCKS_QUEUE_MAX_PATH_CHARS,
      ));
  const validExternalPaths =
    args.external_paths === undefined ||
    (Array.isArray(args.external_paths) &&
      args.external_paths.length <= CRITICAL_LOCKS_QUEUE_MAX_PATHS &&
      args.external_paths.every(
        (path) =>
          typeof path === 'string' &&
          path.trim().length > 0 &&
          path.length <= CRITICAL_LOCKS_QUEUE_MAX_EXTERNAL_PATH_CHARS,
      ));
  if (!validPaths || !validExternalPaths) return false;

  const hasPaths = Array.isArray(args.paths) && args.paths.length > 0;
  const hasExternalPaths = Array.isArray(args.external_paths) && args.external_paths.length > 0;
  if (!hasPaths && !hasExternalPaths) return false;

  if (
    args.coordination_domain !== undefined &&
    (typeof args.coordination_domain !== 'string' ||
      args.coordination_domain.trim().length === 0 ||
      args.coordination_domain.length > CRITICAL_LOCKS_QUEUE_MAX_DOMAIN_CHARS)
  ) {
    return false;
  }
  if (
    args.owner !== undefined &&
    (typeof args.owner !== 'string' ||
      args.owner.trim().length === 0 ||
      args.owner.length > CRITICAL_LOCKS_QUEUE_MAX_OWNER_CHARS)
  ) {
    return false;
  }
  // The active-lock read is the recovery surface; completed waiters are a
  // separate history query and stay on the ordinary retryable path.
  if (args.include_completed !== undefined && args.include_completed !== false) return false;
  return true;
}

/**
 * `backup:snapshot_list` is the authoritative recovery read for an in-flight
 * backup, but its normal limit reaches 500 rows. Keep the critical-pressure
 * reserve to the handler default (when arguments are omitted/empty) or an
 * explicit page of at most 50 snapshots; unknown fields and larger pages stay
 * on the ordinary retryable path.
 */
export function isBoundedBackupSnapshotListArgs(args: unknown): boolean {
  if (args === undefined) return true;
  if (!isRecord(args)) return false;
  if (Object.keys(args).some((key) => key !== 'limit')) return false;
  return args.limit === undefined || isBoundedPositiveInt(args.limit, CRITICAL_BACKUP_SNAPSHOT_LIST_MAX_LIMIT);
}

/**
 * `locks:list` normally permits a full registry browse (currently hundreds of
 * resources), or a `q` filter without a page cap. Under critical pressure,
 * admit one exact resource read or a bounded registry browse. A browse must
 * carry `limit <= 50`; `q` is optional with that limit, while resource mixed
 * with `q`/`limit` and selector-free reads remain shed.
 */
export function isBoundedLocksListArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set(['resource', 'q', 'limit']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;

  const hasResource = args.resource !== undefined;
  const hasQuery = args.q !== undefined;
  const hasLimit = args.limit !== undefined;
  if (hasResource) {
    return Object.keys(args).length === 1 && isBoundedCriticalText(args.resource, 200, true);
  }
  if (!hasLimit || !isBoundedPositiveInt(args.limit, CRITICAL_LOCKS_LIST_MAX_LIMIT)) return false;
  if (hasQuery && !isBoundedCriticalText(args.q, 200, true)) return false;
  return true;
}

/**
 * `locks:release` is needed to clear one held lock during critical-pressure
 * recovery, but its bulk, path-only, cross-domain, publish, and native-proof
 * forms can fan out into multiple transactions or side effects. Reserve only
 * the owner-checked single UUID form. The normal handler remains authoritative
 * for ownership and lock-plane validation after admission.
 */
export function isBoundedLocksReleaseArgs(args: unknown): boolean {
  if (!isRecord(args) || Object.keys(args).length !== 1 || !Object.hasOwn(args, 'lock_id')) return false;
  return typeof args.lock_id === 'string' && CRITICAL_LOCKS_RELEASE_UUID.test(args.lock_id);
}

/**
 * Keep the telemetry rollup available for pressure diagnosis, but require the small,
 * explicit page used by recovery callers. The handler's default limit is 100 and its
 * schema permits a 168-hour/500-row query, both of which are too broad for the critical
 * reserve. `hours` may be omitted because the handler default is the allowed 24-hour window.
 */
export function isBoundedDevTelemetryArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set(['workspaceIds', 'transports', 'hours', 'limit']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  if (
    !Number.isInteger(args.limit) ||
    (args.limit as number) < 1 ||
    (args.limit as number) > CRITICAL_DEV_TELEMETRY_MAX_LIMIT
  ) {
    return false;
  }
  if (
    args.hours !== undefined &&
    (!Number.isInteger(args.hours) ||
      (args.hours as number) < 1 ||
      (args.hours as number) > CRITICAL_DEV_TELEMETRY_MAX_HOURS)
  ) {
    return false;
  }
  if (args.workspaceIds !== undefined && args.workspaceIds !== null) {
    if (
      !Array.isArray(args.workspaceIds) ||
      args.workspaceIds.length > CRITICAL_DEV_TELEMETRY_MAX_WORKSPACE_IDS ||
      !args.workspaceIds.every(
        (id) => typeof id === 'string' && id.trim().length > 0 && id.length <= CRITICAL_DEV_TELEMETRY_MAX_STRING_CHARS,
      )
    ) {
      return false;
    }
  }
  if (args.transports !== undefined && args.transports !== null) {
    if (
      !Array.isArray(args.transports) ||
      args.transports.length > DEV_TELEMETRY_TRANSPORTS.size ||
      !args.transports.every(
        (transport) => typeof transport === 'string' && DEV_TELEMETRY_TRANSPORTS.has(transport),
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * `scheduler:get_next` is the authoritative fleet self-pull and is already
 * reserved by the outer MCP proxy. Direct ptool/staging calls still pass
 * through this inner gate, so admit only the exact bounded request surface
 * documented by the handler: one claim, at most 500 short held paths, and the
 * two claimable states. Unknown keys are rejected rather than allowing a large
 * opaque payload to ride the critical-pressure recovery lane.
 */
function isBoundedSchedulerGetNextArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set(['harness', 'heldPaths', 'states', 'rigAvailable', 'ignoreContextPressure']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  if (
    args.harness !== undefined &&
    (typeof args.harness !== 'string' ||
      args.harness.trim().length === 0 ||
      args.harness.length > CRITICAL_SCHEDULER_MAX_HARNESS_CHARS)
  ) {
    return false;
  }
  if (args.heldPaths !== undefined) {
    if (
      !Array.isArray(args.heldPaths) ||
      args.heldPaths.length > CRITICAL_SCHEDULER_MAX_HELD_PATHS ||
      !args.heldPaths.every(
        (path) => typeof path === 'string' && path.length <= CRITICAL_SCHEDULER_MAX_HELD_PATH_CHARS,
      )
    ) {
      return false;
    }
  }
  if (
    args.states !== undefined &&
    (!Array.isArray(args.states) ||
      args.states.length > 20 ||
      !args.states.every((state) => typeof state === 'string' && CRITICAL_SCHEDULER_STATES.has(state)))
  ) {
    return false;
  }
  for (const field of ['rigAvailable', 'ignoreContextPressure']) {
    if (args[field] !== undefined && typeof args[field] !== 'boolean') return false;
  }
  return true;
}

/**
 * Targeted presence reads are bounded by the explicit owner selector. The
 * underlying snapshot assembler switches to a point/finite-set query for these
 * selectors; a project-only or otherwise broad presence read must remain on the
 * ordinary pressure-shed path. Keep the compatibility aliases equivalent while
 * rejecting mixed singular/plural forms and oversized selector values.
 */
export function isBoundedCoordPresenceArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set([
    'scope',
    'pot',
    'workspace',
    'owner',
    'ownerId',
    'owners',
    'ownerIds',
    'include_detail',
    'include_cursor',
    'include_coupling',
    'since',
  ]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;

  const singular = ['owner', 'ownerId'].filter((field) => args[field] !== undefined);
  const plural = ['owners', 'ownerIds'].filter((field) => args[field] !== undefined);
  if (singular.length + plural.length !== 1) return false;

  const selected = singular[0] ?? plural[0];
  if (selected === 'owner' || selected === 'ownerId') {
    const value = args[selected];
    if (
      typeof value !== 'string' ||
      value.trim().length === 0 ||
      value.length > CRITICAL_TARGET_OWNER_MAX_STRING_CHARS
    ) {
      return false;
    }
  } else {
    const value = args[selected];
    if (
      !Array.isArray(value) ||
      value.length < 1 ||
      value.length > CRITICAL_TARGET_OWNER_MAX_COUNT ||
      !value.every(
        (owner) =>
          typeof owner === 'string' &&
          owner.trim().length > 0 &&
          owner.length <= CRITICAL_TARGET_OWNER_MAX_STRING_CHARS,
      )
    ) {
      return false;
    }
  }

  if (
    args.scope !== undefined &&
    (typeof args.scope !== 'string' || !['hive', 'workspace', 'all'].includes(args.scope))
  ) {
    return false;
  }
  for (const field of ['pot', 'workspace']) {
    if (
      args[field] !== undefined &&
      (typeof args[field] !== 'string' ||
        args[field].trim().length === 0 ||
        args[field].length > CRITICAL_TARGET_OWNER_MAX_STRING_CHARS)
    ) {
      return false;
    }
  }
  for (const field of ['include_detail', 'include_cursor', 'include_coupling']) {
    if (args[field] !== undefined && typeof args[field] !== 'boolean') return false;
  }
  if (
    args.since !== undefined &&
    (typeof args.since !== 'string' || args.since.length > 64)
  ) {
    return false;
  }
  return true;
}

/**
 * `coord:roster` shares the presence snapshot for its live/members lenses, but
 * claims/history and project-only reads have different cost and semantics. Only
 * an owner-targeted live or members read is safe to carry through the critical
 * pressure reserve. Optional liveness/detail filters remain bounded and are
 * validated here rather than turning the reserve into a broad roster escape.
 */
export function isBoundedCoordRosterArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set([
    'view',
    'scope',
    'pot',
    'workspace',
    'owner',
    'include_detail',
    'include_stale',
    'project',
    'states',
    'since',
  ]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  if (
    typeof args.owner !== 'string' ||
    args.owner.trim().length === 0 ||
    args.owner.length > CRITICAL_TARGET_OWNER_MAX_STRING_CHARS
  ) {
    return false;
  }
  if (args.view !== undefined && !['live', 'members'].includes(args.view as string)) return false;
  if (
    args.scope !== undefined &&
    (typeof args.scope !== 'string' || !['hive', 'workspace', 'all'].includes(args.scope))
  ) {
    return false;
  }
  for (const field of ['pot', 'workspace']) {
    if (
      args[field] !== undefined &&
      (typeof args[field] !== 'string' ||
        args[field].trim().length === 0 ||
        args[field].length > CRITICAL_TARGET_OWNER_MAX_STRING_CHARS)
    ) {
      return false;
    }
  }
  if (args.project !== undefined && !['ids', 'liveness', 'full'].includes(args.project as string)) return false;
  for (const field of ['include_detail', 'include_stale']) {
    if (args[field] !== undefined && typeof args[field] !== 'boolean') return false;
  }
  if (args.states !== undefined) {
    const states = ['live', 'parked', 'draining', 'suspect', 'ended', 'recorded'];
    if (
      !Array.isArray(args.states) ||
      args.states.length > states.length ||
      !args.states.every((state) => typeof state === 'string' && states.includes(state))
    ) {
      return false;
    }
  }
  if (
    args.since !== undefined &&
    (typeof args.since !== 'string' || args.since.length > 64)
  ) {
    return false;
  }
  return true;
}

/**
 * `coord:inbox` is the recovery read for an overdue directed-mail wake, but
 * its selective filters still perform a full mailbox derive. Require an
 * explicit small page and at least one of the two directed-mail predicates;
 * broad/default, ambient, sender, and body-expanding reads remain retryable
 * under critical pressure.
 */
export function isBoundedCoordInboxArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set(['limit', 'directed', 'unanswered_only']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  if (
    !Number.isInteger(args.limit) ||
    (args.limit as number) < 1 ||
    (args.limit as number) > CRITICAL_COORD_INBOX_MAX_LIMIT
  ) {
    return false;
  }
  const directed = args.directed === true;
  const unanswered = args.unanswered_only === true;
  if (!directed && !unanswered) return false;
  if (args.directed !== undefined && !directed) return false;
  if (args.unanswered_only !== undefined && !unanswered) return false;
  return true;
}

/**
 * `loop:status` is a read-only recovery probe needed to reconcile a resumed
 * fleet member, but its admission exception must still reject opaque payloads
 * before schema parsing. The handler accepts only these three owner-scoped
 * strings (plus the compatibility harness string), each capped by its tool
 * schema; an omitted arguments object is equivalent to `{}`.
 */
function isBoundedLoopStatusArgs(args: unknown): boolean {
  if (args === undefined) return true;
  if (!isRecord(args)) return false;
  const allowed = new Set(['harness', 'ownerId', 'owner']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  return ['harness', 'ownerId', 'owner'].every(
    (field) =>
      args[field] === undefined ||
      (typeof args[field] === 'string' && args[field].length <= CRITICAL_LOOP_STATUS_MAX_STRING_CHARS),
  );
}

/**
 * `events:status` is a recovery read, but its unfiltered form renders every active
 * await, recent delivery, composed tree, and subscription for the caller. Keep the
 * critical-pressure reserve to one exact await registration or one exact event-key
 * inspection. The fleet-wide meter is deliberately excluded because it performs an
 * aggregate read unrelated to the caller's exact recovery target.
 */
export function isBoundedEventsStatusArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set(['meter', 'await_id', 'event', 'after_generation']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  if (args.meter !== undefined && typeof args.meter !== 'boolean') return false;
  if (args.meter === true) return false;

  const hasAwaitId = args.await_id !== undefined;
  const hasEvent = args.event !== undefined;
  if (hasAwaitId === hasEvent) return false;

  if (hasAwaitId) {
    const awaitId = args.await_id;
    return (
      typeof awaitId === 'number' &&
      Number.isSafeInteger(awaitId) &&
      awaitId > 0 &&
      args.after_generation === undefined
    );
  }

  if (
    typeof args.event !== 'string' ||
    args.event.trim().length === 0 ||
    args.event.length > CRITICAL_EVENTS_STATUS_MAX_EVENT_CHARS
  ) {
    return false;
  }
  const afterGeneration = args.after_generation;
  return (
    afterGeneration === undefined ||
    (typeof afterGeneration === 'number' && Number.isSafeInteger(afterGeneration) && afterGeneration >= 0)
  );
}

/**
 * Keep the loop's own recovery arm available while critical pressure is shedding
 * ordinary writes. This is deliberately the smallest useful WORK-loop shape:
 * the required short cadence and goal, with only bounded identity/carry fields.
 * Custom wake prompts, monitor/gated loops, blocker metadata, and owner overrides
 * stay on the retryable path because they add extra orchestration or can target a
 * different session. The loop handler still performs its normal schema and scope
 * checks after admission.
 */
export function isBoundedLoopArmArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set(['intervalSec', 'goal', 'harness', 'workItem', 'carry', 'continuation', 'mode']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  if (
    !Number.isInteger(args.intervalSec) ||
    (args.intervalSec as number) < 60 ||
    (args.intervalSec as number) > CRITICAL_LOOP_ARM_MAX_INTERVAL_SEC
  ) {
    return false;
  }
  if (!isBoundedCriticalText(args.goal, CRITICAL_LOOP_ARM_MAX_GOAL_CHARS, true)) return false;
  if (
    args.harness !== undefined &&
    !isBoundedCriticalText(args.harness, CRITICAL_LOOP_ARM_MAX_STRING_CHARS, true)
  ) {
    return false;
  }
  if (
    args.workItem !== undefined &&
    args.workItem !== null &&
    !isBoundedCriticalText(args.workItem, CRITICAL_LOOP_ARM_MAX_STRING_CHARS, true)
  ) {
    return false;
  }
  if (args.carry !== undefined && !['warm', 'cold'].includes(args.carry as string)) return false;
  if (args.continuation !== undefined && args.continuation !== 'settle') return false;
  if (args.mode !== undefined && args.mode !== 'work') return false;
  return true;
}

/**
 * A single checkpoint is the smallest durable recovery write: it preserves the
 * successor state needed to resume after the pressure condition clears. Keep the
 * exemption to one identified item so a bulk checkpoint request cannot turn the
 * pressure reserve into an unbounded write lane. The checkpoint tool validates the
 * operation-specific fields and body/check-row caps after admission.
 */
function isBoundedWorkItemsCheckpointArgs(args: unknown): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const record = args as { id?: unknown; items?: unknown };
  const single =
    typeof record.id === 'string' &&
    record.id.trim().length > 0 &&
    record.items === undefined;
  if (single) return true;
  if (record.id !== undefined || !Array.isArray(record.items) || record.items.length !== 1) {
    return false;
  }
  const item = record.items[0];
  return (
    item !== null &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    typeof (item as { id?: unknown }).id === 'string' &&
    ((item as { id: string }).id).trim().length > 0
  );
}

/**
 * A loop checkpoint is the smallest durable continuation write for an su
 * session, so it must remain available while ordinary MCP calls are shed.
 * Keep the pressure exception to the caller's own note-shaped fields and a
 * bounded total payload; row retirement, learned cross-item writes, reads,
 * and owner overrides remain on the ordinary retryable path.
 */
export function isBoundedLoopCheckpointArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set([
    'note',
    'checkpoint',
    'did',
    'left',
    'insight',
    'next',
    'keyInsight',
    'nextAction',
    'goal',
    'workItem',
    'harness',
    'walls',
    'checks',
    'expectedHash',
  ]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;

  const encoded = (() => {
    try {
      return JSON.stringify(args);
    } catch {
      return null;
    }
  })();
  if (!encoded || encoded.length > CRITICAL_LOOP_CHECKPOINT_MAX_ARGUMENT_CHARS) return false;

  const textFields = ['note', 'did', 'left', 'insight', 'next', 'keyInsight', 'nextAction', 'goal', 'workItem'];
  for (const field of textFields) {
    const value = args[field];
    if (
      value !== undefined &&
      value !== null &&
      !isBoundedCriticalText(value, CRITICAL_LOOP_CHECKPOINT_MAX_FIELD_CHARS)
    ) {
      return false;
    }
  }
  if (args.checkpoint !== undefined) {
    const checkpoint = args.checkpoint;
    if (typeof checkpoint === 'string') {
      if (!isBoundedCriticalText(checkpoint, CRITICAL_LOOP_CHECKPOINT_MAX_FIELD_CHARS)) return false;
    } else if (isRecord(checkpoint)) {
      const checkpointKeys = new Set(['did', 'left', 'insight', 'next', 'goal', 'keyInsight', 'nextAction']);
      if (Object.keys(checkpoint).some((key) => !checkpointKeys.has(key))) return false;
      for (const value of Object.values(checkpoint)) {
        if (value !== undefined && value !== null && !isBoundedCriticalText(value, CRITICAL_LOOP_CHECKPOINT_MAX_FIELD_CHARS)) {
          return false;
        }
      }
    } else {
      return false;
    }
  }
  if (
    args.harness !== undefined &&
    !isBoundedCriticalText(args.harness, 120, true)
  ) {
    return false;
  }
  if (
    args.expectedHash !== undefined &&
    args.expectedHash !== null &&
    (typeof args.expectedHash !== 'string' || !/^[0-9a-f]{12}$/i.test(args.expectedHash))
  ) {
    return false;
  }
  for (const field of ['walls', 'checks']) {
    const value = args[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length > CRITICAL_LOOP_CHECKPOINT_MAX_ARRAY_ITEMS) return false;
    let encodedRows: string;
    try {
      encodedRows = JSON.stringify(value);
    } catch {
      return false;
    }
    if (encodedRows.length > CRITICAL_LOOP_CHECKPOINT_MAX_FIELD_CHARS) return false;
  }
  const writeKeys = new Set([
    'note',
    'checkpoint',
    'did',
    'left',
    'insight',
    'next',
    'keyInsight',
    'nextAction',
    'goal',
    'walls',
    'checks',
  ]);
  return Object.keys(args).some((key) => {
    if (!writeKeys.has(key)) return false;
    const value = args[key];
    return value !== undefined && value !== null;
  });
}

function isBoundedCriticalText(value: unknown, max: number, oneLine = false): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= max &&
    (!oneLine || (!value.includes('\n') && !value.includes('\r')))
  );
}

/**
 * Preserve the smallest useful coordination message while critical pressure is
 * shedding ordinary tools. This is intentionally stricter than coord:send's
 * normal schema: one concrete recipient (or the single bounded
 * @fleet-leader:<slug> audience used to reach a fleet's durable leader), one
 * plain text section, and only the core envelope fields. Wakes, other audience
 * selectors, replies, provenance, and other enrichment remain on the retryable
 * path so this reserve cannot become a second coordination/bulkhead lane.
 */
export function isBoundedCoordSendArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set(['to', 'summary', 'expects', 'body']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  if (!Array.isArray(args.to) || args.to.length !== 1) return false;
  const recipient = args.to[0];
  const fleetLeaderPrefix = '@fleet-leader:';
  const isBoundedFleetLeaderSelector =
    isBoundedCriticalText(recipient, CRITICAL_TARGET_OWNER_MAX_STRING_CHARS, true) &&
    recipient.startsWith(fleetLeaderPrefix) &&
    isBoundedCriticalText(
      recipient.slice(fleetLeaderPrefix.length),
      CRITICAL_TARGET_OWNER_MAX_STRING_CHARS - fleetLeaderPrefix.length,
      true,
    );
  if (
    !isBoundedCriticalText(recipient, CRITICAL_TARGET_OWNER_MAX_STRING_CHARS, true) ||
    recipient === '*' ||
    recipient === 'human' ||
    (recipient.startsWith('@') && !isBoundedFleetLeaderSelector)
  ) {
    return false;
  }
  if (!isBoundedCriticalText(args.summary, CRITICAL_COORD_SEND_MAX_SUMMARY_CHARS, true)) return false;
  if (!['ack', 'answer', 'action', 'none'].includes(args.expects as string)) return false;
  if (args.expects !== 'none' && args.expects !== 'ack' && args.body === undefined) return false;
  if (args.body === undefined) return true;
  if (!Array.isArray(args.body) || args.body.length !== 1) return false;
  const section = args.body[0];
  return (
    isRecord(section) &&
    Object.keys(section).length === 1 &&
    isBoundedCriticalText(section.text, CRITICAL_COORD_SEND_MAX_BODY_CHARS)
  );
}

/**
 * `coord:whoami` is the identity probe needed to diagnose coordination
 * failures, but its critical-pressure exception must remain strictly no-args.
 * MCP permits omitting `arguments` for an empty object schema; an explicit
 * empty object is equivalent. Any supplied field stays on the retryable path.
 */
function isBoundedCoordWhoamiArgs(args: unknown): boolean {
  return args === undefined || (isRecord(args) && Object.keys(args).length === 0);
}

function isBoundedWorkItemComment(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    isBoundedCriticalText(value.id, CRITICAL_WORK_ITEM_COMMENT_MAX_ID_CHARS, true) &&
    (isBoundedCriticalText(value.body, CRITICAL_WORK_ITEM_COMMENT_MAX_BODY_CHARS) ||
      isBoundedAcceptanceBarApprovalBody(value.body))
  );
}

/**
 * A started acceptance-BAR amendment's reviewer receipt is intentionally posted
 * verbatim to the work-item thread. A multi-BAR receipt is larger than the
 * ordinary 600-character critical-pressure comment reserve, but it is still a
 * bounded, low-entropy recovery write. Admit only the exact preview shape so a
 * long arbitrary comment cannot turn the reserve into a second bulkhead lane.
 */
function isBoundedAcceptanceBarApprovalBody(value: unknown): value is string {
  if (
    !isBoundedCriticalText(value, CRITICAL_WORK_ITEM_APPROVAL_BODY_MAX_CHARS) ||
    value.length <= CRITICAL_WORK_ITEM_COMMENT_MAX_BODY_CHARS
  ) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  const allowed = new Set(['schemaVersion', 'kind', 'rubricRef', 'subjectPlan', 'bars']);
  if (Object.keys(parsed).some((key) => !allowed.has(key))) return false;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.kind !== 'acceptance-bar-amendment-approval' ||
    !isBoundedCriticalText(parsed.rubricRef, CRITICAL_WORK_ITEM_COMMENT_MAX_ID_CHARS, true) ||
    !isBoundedCriticalText(parsed.subjectPlan, CRITICAL_WORK_ITEM_COMMENT_MAX_ID_CHARS, true)
  ) {
    return false;
  }
  if (!Array.isArray(parsed.bars) || parsed.bars.length < 1 || parsed.bars.length > CRITICAL_WORK_ITEM_APPROVAL_MAX_BARS) {
    return false;
  }
  const keys = new Set<string>();
  return parsed.bars.every((bar) => {
    if (!isRecord(bar) || Object.keys(bar).length !== 3) return false;
    if (!isBoundedCriticalText(bar.barKey, CRITICAL_WORK_ITEM_COMMENT_MAX_ID_CHARS, true)) return false;
    if (keys.has(bar.barKey)) return false;
    keys.add(bar.barKey);
    return [bar.priorBarHash, bar.nextBarHash].every(
      (hash) => hash === null || (typeof hash === 'string' && CRITICAL_WORK_ITEM_APPROVAL_HASH_RE.test(hash)),
    ) && (bar.priorBarHash !== null || bar.nextBarHash !== null);
  });
}

/**
 * Admit only one inline comment or one-item batch during critical pressure.
 * `comment` is a useful normal-path alias, but deliberately excluded here so
 * the reserve has one unambiguous text field and no handler-side enrichment.
 */
export function isBoundedWorkItemsCommentArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const hasInline = args.id !== undefined || args.body !== undefined;
  const hasItems = args.items !== undefined;
  if (hasInline === hasItems) return false;
  if (hasItems) {
    return Array.isArray(args.items) && args.items.length === 1 && isBoundedWorkItemComment(args.items[0]);
  }
  return Object.keys(args).length === 2 && isBoundedWorkItemComment(args);
}

/**
 * A grading-integrity audit needs one scorecard's complete evidence while the
 * operator is under pressure. Require both selective predicates and reject a
 * deliberately wide page so this recovery exemption cannot become a history
 * export lane. The default page remains acceptable because the exact
 * rubric+subject pair is the audit's bounded identity; callers that override it
 * are capped at a small page.
 */
export function isBoundedScorecardsListArgs(args: unknown): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const record = args as Record<string, unknown>;
  const rubricRef = typeof record.rubricRef === 'string' && record.rubricRef.trim().length > 0;
  const subjectRef = typeof record.subjectRef === 'string' && record.subjectRef.trim().length > 0;
  if (!rubricRef || !subjectRef) return false;
  if (
    record.limit !== undefined &&
    (!Number.isInteger(record.limit) ||
      (record.limit as number) < 1 ||
      (record.limit as number) > CRITICAL_SCORECARDS_LIST_MAX_ROWS)
  ) {
    return false;
  }
  for (const field of ['sourceHive', 'harness', 'since']) {
    if (record[field] !== undefined && typeof record[field] !== 'string') return false;
  }
  for (const field of ['includeSynthesized', 'includeSuperseded', 'includeRetracted']) {
    if (record[field] !== undefined && typeof record[field] !== 'boolean') return false;
  }
  return true;
}

/**
 * `scorecards:evaluate` is a read-only grading preflight, but its optional
 * ratings/instrument payloads can be arbitrarily large and make the evaluator
 * do the full validation path. Reserve the skeleton form used to discover
 * criterion keys, plus the separately bounded complete form for a judge's
 * grading-integrity pass; ordinary complete evaluations remain sheddable.
 */
export function isBoundedScorecardsEvaluateArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set(['rubricRef', 'sourceHive', 'ratings']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  if (
    typeof args.rubricRef !== 'string' ||
    args.rubricRef.trim().length === 0 ||
    args.rubricRef.length > 120
  ) {
    return false;
  }
  if (
    args.sourceHive !== undefined &&
    (typeof args.sourceHive !== 'string' ||
      args.sourceHive.trim().length === 0 ||
      args.sourceHive.length > 120)
  ) {
    return false;
  }
  if (args.ratings !== undefined && (!isRecord(args.ratings) || Object.keys(args.ratings).length !== 0)) {
    return false;
  }
  return true;
}

function isBoundedScorecardText(value: unknown, max: number, min = 1): value is string {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max;
}

/**
 * A judge's second `scorecards:evaluate` call validates the complete ratings
 * payload before the terminal grading-integrity emit. Keep that read on the
 * critical-pressure reserve, but only for the signed judge-role routing hint
 * and a field-bounded payload. The admission gate cannot resolve the principal
 * yet; the downstream signed-role verifier remains authoritative.
 */
export function isBoundedJudgeScorecardsEvaluateArgs(args: unknown, requestUrl?: string): boolean {
  if (!isJudgeRoleRequest(requestUrl) || !isRecord(args)) return false;
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(args);
  } catch {
    return false;
  }
  if (!encoded || encoded.length > CRITICAL_SCORECARDS_EVALUATE_MAX_ARGUMENT_CHARS) return false;

  const allowed = new Set(['rubricRef', 'sourceHive', 'ratings', 'instrumentSnapshots', 'testedSha']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  if (!isBoundedScorecardText(args.rubricRef, 120)) return false;
  if (args.sourceHive !== undefined && !isBoundedScorecardText(args.sourceHive, 120)) return false;

  if (!isRecord(args.ratings)) return false;
  const ratingKeys = Object.keys(args.ratings);
  if (ratingKeys.length < 1 || ratingKeys.length > CRITICAL_SCORECARDS_EVALUATE_MAX_RATINGS) return false;
  for (const key of ratingKeys) {
    if (!isBoundedScorecardText(key, 200)) return false;
    const rating = args.ratings[key];
    if (!isRecord(rating)) return false;
    const ratingFields = new Set(['rating', 'evidence', 'suggestion', 'remediation', 'disregard']);
    if (Object.keys(rating).some((field) => !ratingFields.has(field))) return false;
    if (!isBoundedScorecardText(rating.rating, 120) || !isBoundedScorecardText(rating.evidence, 4_000)) {
      return false;
    }
    if (rating.suggestion !== undefined && !isBoundedScorecardText(rating.suggestion, 2_000)) return false;
    if (rating.remediation !== undefined && !isBoundedScorecardText(rating.remediation, 300, 2)) return false;
    if (rating.disregard !== undefined && !isBoundedScorecardText(rating.disregard, 600, 10)) return false;
  }

  if (args.instrumentSnapshots !== undefined) {
    if (!isRecord(args.instrumentSnapshots)) return false;
    const snapshotKeys = Object.keys(args.instrumentSnapshots);
    if (snapshotKeys.length > CRITICAL_SCORECARDS_EVALUATE_MAX_SNAPSHOTS) return false;
    for (const key of snapshotKeys) {
      if (!isBoundedScorecardText(key, 200)) return false;
      const snapshot = args.instrumentSnapshots[key];
      if (!isRecord(snapshot)) return false;
      const snapshotFields = new Set(['verdict', 'measuredAt', 'window', 'value', 'evidenceRef', 'provenance']);
      if (Object.keys(snapshot).some((field) => !snapshotFields.has(field))) return false;
      if (!['pass', 'fail', 'unknown'].includes(snapshot.verdict as string)) return false;
      if (!isBoundedScorecardText(snapshot.measuredAt, 120)) return false;
      if (snapshot.evidenceRef !== undefined && !isBoundedScorecardText(snapshot.evidenceRef, 500)) return false;
      if (
        snapshot.provenance !== undefined &&
        !['self-reported', 'platform-computed'].includes(snapshot.provenance as string)
      ) {
        return false;
      }
    }
  }

  if (
    args.testedSha !== undefined &&
    (typeof args.testedSha !== 'string' || !/^[0-9a-f]{7,64}$/i.test(args.testedSha))
  ) {
    return false;
  }
  return true;
}

/**
 * `scorecards:get` is the evidence-first read used by grading-integrity audits.
 * Its handler accepts one issue id plus an optional criterion page cursor and
 * performs one bounded projection per call. Keep the critical-pressure
 * exemption tied to that paginated identity rather than the broader scorecards
 * history reader.
 */
function isBoundedScorecardsGetArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const keys = Object.keys(args);
  if (keys.some((key) => !['issueId', 'criterionKey', 'evidenceOffset'].includes(key))) return false;
  if (
    typeof args.issueId !== 'string' ||
    args.issueId.trim().length === 0 ||
    args.issueId.length > CRITICAL_SCORECARDS_GET_ISSUE_ID_MAX
  ) {
    return false;
  }
  if (args.criterionKey !== undefined) {
    if (
      typeof args.criterionKey !== 'string' ||
      args.criterionKey.trim().length === 0 ||
      args.criterionKey.length > 200
    ) {
      return false;
    }
  }
  if (args.evidenceOffset !== undefined) {
    if (!Number.isInteger(args.evidenceOffset) || (args.evidenceOffset as number) < 0) return false;
    // The handler cannot resume a page without knowing which criterion owns it.
    if (args.criterionKey === undefined) return false;
  }
  return true;
}

function isBoundedToolFailureString(value: unknown, max: number, required = false): value is string {
  if (value === undefined && !required) return true;
  return typeof value === 'string' && value.length <= max && (!required || value.trim().length > 0);
}

/**
 * Preserve the incident record for an admission shed without opening the full
 * capture surface under critical pressure. The shorthand derives its title/body
 * from one strict, field-bounded `toolFailure` object; any authored capture fields
 * remain on the ordinary pressure-shed path and can be retried after recovery.
 */
function isBoundedImprovementsCaptureArgs(args: unknown): boolean {
  if (!isRecord(args) || Object.keys(args).some((key) => key !== 'toolFailure')) return false;
  const failure = args.toolFailure;
  if (!isRecord(failure)) return false;
  if (!isBoundedToolFailureString(failure.toolName, 160, true)) return false;
  if (!isBoundedToolFailureString(failure.message, CRITICAL_TOOL_FAILURE_MESSAGE_MAX, true)) return false;
  for (const [field, max] of [
    ['errorCode', 160],
    ['schemaRevision', 160],
    ['fieldPath', 300],
    ['runtimeVersion', 160],
  ] as const) {
    if (!isBoundedToolFailureString(failure[field], max)) return false;
  }
  if (failure.status !== undefined) {
    const status = failure.status;
    if (
      !(
        (typeof status === 'string' && status.length <= 80) ||
        (typeof status === 'number' && Number.isFinite(status) && String(status).length <= 80)
      )
    ) {
      return false;
    }
  }
  for (const field of ['reproduced', 'clearServerMismatch', 'hardInternal']) {
    if (failure[field] !== undefined && typeof failure[field] !== 'boolean') return false;
  }
  if (failure.directEvidence !== undefined) {
    const evidence = failure.directEvidence;
    if (!isRecord(evidence) || Object.keys(evidence).some((key) => !['kind', 'expected', 'actual'].includes(key))) {
      return false;
    }
    if (
      typeof evidence.kind !== 'string' ||
      !TOOL_FAILURE_DIRECT_EVIDENCE_KINDS.has(evidence.kind) ||
      !isBoundedToolFailureString(evidence.expected, CRITICAL_TOOL_FAILURE_DIRECT_EVIDENCE_MAX, true) ||
      !isBoundedToolFailureString(evidence.actual, CRITICAL_TOOL_FAILURE_DIRECT_EVIDENCE_MAX, true)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * A judge needs the complete criteria body from one rubric while the operator is
 * under critical pressure. Keep the exemption to a single lookup: rubrics:get
 * also accepts a bulk `rubricRefs` form whose full criteria bodies would turn the
 * recovery reserve into a history/export lane.
 */
function isBoundedRubricsGetArgs(args: unknown): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const record = args as Record<string, unknown>;
  const singleAliases = ['rubricRef', 'ref', 'slug', 'id'].filter(
    (field) => typeof record[field] === 'string' && (record[field] as string).trim().length > 0,
  );
  const rubricRefs = record.rubricRefs;
  const singleRubricRefs =
    Array.isArray(rubricRefs) &&
    rubricRefs.length === 1 &&
    typeof rubricRefs[0] === 'string' &&
    rubricRefs[0].trim().length > 0;
  if ((singleAliases.length === 0) === !singleRubricRefs || singleAliases.length > 1) return false;
  if (rubricRefs !== undefined && !singleRubricRefs) return false;
  if (
    record.revision !== undefined &&
    (!Number.isInteger(record.revision) || (record.revision as number) < 1)
  ) {
    return false;
  }
  if (record.harness !== undefined && typeof record.harness !== 'string') return false;
  return true;
}

/**
 * The MCP admission gate runs before the handler resolves the signed principal, so it cannot
 * inspect `ctx.principal`. The role query is still useful as a narrow routing hint here: the
 * signed-spawn verifier will reject a forged role before dispatch. Require the exact judge role
 * and the full bounded audit shape before reserving capacity for a scorecard write.
 */
function isJudgeRoleRequest(requestUrl?: string): boolean {
  if (!requestUrl) return false;
  try {
    return new URL(requestUrl, 'http://127.0.0.1').searchParams.get('role')?.trim() === 'judge';
  } catch {
    return false;
  }
}

function isBoundedJudgeGradingAuditEmitArgs(args: unknown, requestUrl?: string): boolean {
  if (!isJudgeRoleRequest(requestUrl) || !args || typeof args !== 'object' || Array.isArray(args)) return false;
  const record = args as { rubricRef?: unknown; terminal?: unknown; subject?: unknown };
  if (record.rubricRef !== 'grading-integrity' || record.terminal !== true) return false;
  if (!record.subject || typeof record.subject !== 'object' || Array.isArray(record.subject)) return false;
  const subject = record.subject as { kind?: unknown; ref?: unknown };
  return subject.kind === 'scorecard' && typeof subject.ref === 'string' && subject.ref.trim().length > 0;
}

function isCriticalPressureDiagnostic(toolName: unknown, args?: unknown, requestUrl?: string): boolean {
  if (typeof toolName !== 'string') return false;
  const normalized = normalizeMcpName(toolName);
  if (normalized === BACKUP_SNAPSHOT_LIST_NAME) return isBoundedBackupSnapshotListArgs(args);
  if (normalized === COORD_WHOAMI_NAME) return isBoundedCoordWhoamiArgs(args);
  if (normalized === COORD_DECLARE_INTENT_NAME) return isBoundedCoordDeclareIntentArgs(args);
  if (normalized === COORD_SEND_NAME) return isBoundedCoordSendArgs(args);
  if (normalized === CAPABILITY_BASH_OUTPUT_NAME) return isBoundedBashOutputArgs(args);
  if (normalized === WORK_ITEMS_COMMENT_NAME) return isBoundedWorkItemsCommentArgs(args);
  if (normalized === LOCKS_LIST_NAME) return isBoundedLocksListArgs(args);
  if (normalized === LOCKS_QUEUE_NAME) return isBoundedLocksQueueArgs(args);
  if (normalized === LOCKS_RELEASE_NAME) return isBoundedLocksReleaseArgs(args);
  if (normalized === COORD_PRESENCE_NAME) return isBoundedCoordPresenceArgs(args);
  if (normalized === COORD_ROSTER_NAME) return isBoundedCoordRosterArgs(args);
  if (normalized === COORD_INBOX_NAME) return isBoundedCoordInboxArgs(args);
  if (normalized === DEV_TELEMETRY_NAME) return isBoundedDevTelemetryArgs(args);
  if (normalized === ACTIVITY_TOOL_LOG_NAME) return isBoundedActivityToolLogArgs(args);
  if (normalized === SCHEDULER_GET_NEXT_NAME) return isBoundedSchedulerGetNextArgs(args);
  if (normalized === LOOP_STATUS_NAME) return isBoundedLoopStatusArgs(args);
  if (normalized === LOOP_ARM_NAME) return isBoundedLoopArmArgs(args);
  if (normalized === LOOP_CHECKPOINT_NAME) return isBoundedLoopCheckpointArgs(args);
  if (normalized === FACTS_LIST_NAME) return isBoundedFactsListArgs(args);
  if (normalized === EVENTS_STATUS_NAME) return isBoundedEventsStatusArgs(args);
  if (normalized === CAPABILITY_READ_NAME) return isBoundedScratchCapabilityReadArgs(args);
  if (normalized === WORK_ITEMS_LIST_NAME) return isBoundedWorkItemsListArgs(args);
  if (normalized === WORK_ITEMS_COMPLETE_NAME) return isBoundedWorkItemsCompleteArgs(args);
  if (normalized === WORK_ITEMS_CHECKPOINT_NAME) return isBoundedWorkItemsCheckpointArgs(args);
  if (normalized === WORK_ITEMS_SET_STATE_NAME) return isBoundedWorkItemsSetStateArgs(args);
  if (normalized === PLANS_GET_NAME) return isBoundedPlansGetArgs(args);
  if (normalized === DOCS_GET_NAME) return isBoundedDocsGetArgs(args);
  if (normalized === PLANS_SEARCH_NAME) return isBoundedPlansSearchArgs(args);
  if (normalized === DOCS_SEARCH_NAME) return isBoundedDocsSearchArgs(args);
  if (normalized === SEARCH_FULLTEXT_NAME) return isBoundedSearchFulltextArgs(args);
  if (normalized === SCORECARDS_LIST_NAME) return isBoundedScorecardsListArgs(args);
  if (normalized === SCORECARDS_EVALUATE_NAME) {
    return isBoundedScorecardsEvaluateArgs(args) || isBoundedJudgeScorecardsEvaluateArgs(args, requestUrl);
  }
  if (normalized === SCORECARDS_GET_NAME) return isBoundedScorecardsGetArgs(args);
  if (normalized === SCORECARDS_EMIT_NAME) return isBoundedJudgeGradingAuditEmitArgs(args, requestUrl);
  if (normalized === RUBRICS_GET_NAME) return isBoundedRubricsGetArgs(args);
  if (normalized === IMPROVEMENTS_CAPTURE_NAME) return isBoundedImprovementsCaptureArgs(args);
  if (normalized === EVALUATE_SPEC_TEST_ADEQUACY_NAME) {
    return isJudgeRoleRequest(requestUrl) && isBoundedJudgeEvaluateArgs(args);
  }
  if (normalized === DEGENERATE_CHECK_NAME) {
    return isJudgeRoleRequest(requestUrl) && isBoundedJudgeDegenerateCheckArgs(args);
  }
  if (normalized === GET_SPECS_NAME) {
    return isJudgeRoleRequest(requestUrl) && isBoundedJudgeGetSpecsArgs(args);
  }
  if (normalized === ISSUES_LIST_NAME) {
    return isJudgeRoleRequest(requestUrl) && isBoundedJudgeIssuesListArgs(args);
  }
  if (normalized === RECIPES_SEARCH_NAME) {
    return isBoundedRecipesSearchArgs(args);
  }
  if (normalized === GET_SPEC_EVIDENCE_NAME) {
    return isJudgeRoleRequest(requestUrl) && isBoundedJudgeSpecEvidenceArgs(args);
  }
  if (!CRITICAL_PRESSURE_DIAGNOSTIC_TOOLS.has(normalized)) return false;
  if (normalized === WORK_ITEMS_GET_NAME) return isBoundedWorkItemsGetArgs(args);
  if (normalized === WORK_ITEMS_SEARCH_NAME) return isBoundedWorkItemsSearchArgs(args);
  if (normalized === GIT_SYNC_RUN_NAME) return isBoundedGitSyncRunArgs(args);
  if (normalized === SESSION_REQUEST_COMPACTION_NAME) return isBoundedSessionRequestCompactionArgs(args);
  if (normalized === LOGS_READ_NAME) return isBoundedLogsReadArgs(args);
  if (normalized === NOTIFICATIONS_RECENT_NAME) return isBoundedNotificationsRecentArgs(args);
  if (normalized === TESTING_RUNS_NAME) return isBoundedTestingRunsArgs(args);
  if (normalized === TESTING_RUN_STATUS_NAME) return isBoundedTestingRunStatusArgs(args);
  if (normalized === SESSIONS_SEARCH_NAME) return isBoundedSessionsSearchArgs(args);
  if (normalized === SESSIONS_TIMELINE_NAME) return isBoundedSessionsTimelineArgs(args);
  return true;
}

function isCriticalPressureDiagnosticCall(message: unknown, requestUrl?: string): boolean {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  const params = (message as { params?: { name?: unknown; arguments?: unknown } }).params;
  if (!params || typeof params.name !== 'string') return false;
  const normalizedName = normalizeMcpName(params.name);
  if (normalizedName === TOOLS_INVOKE_NAME) {
    const invokeArgs = params.arguments;
    if (!invokeArgs || typeof invokeArgs !== 'object' || Array.isArray(invokeArgs)) return false;
    const target = (invokeArgs as { name?: unknown; args?: unknown }).name;
    return isCriticalPressureDiagnostic(target, (invokeArgs as { args?: unknown }).args, requestUrl);
  }
  return isCriticalPressureDiagnostic(params.name, params.arguments, requestUrl);
}

const MCP_HANDSHAKE_METHODS = new Set(['initialize', 'ping', 'tools/list']);
export const MCP_HEALTH_PROBE_CLIENT = 'mcp-health';

function isMcpHealthProbe(requestUrl: string | undefined): boolean {
  if (!requestUrl) return false;
  try {
    return new URL(requestUrl, 'http://127.0.0.1').searchParams.get('client') === MCP_HEALTH_PROBE_CLIENT;
  } catch {
    return false;
  }
}

/**
 * Classify a peeked MCP POST body: is it (or a batch containing) a `tools/call`?
 * That's the only sheddable shape — every other JSON-RPC method is cheap protocol
 * traffic we keep serving even when saturated. The narrow bounded diagnostic set
 * above is also admitted so the pressure condition remains observable/recoverable.
 * Also returns the request id to echo in the JSON-RPC error envelope (first
 * sheddable tools/call id in a batch; null if none).
 * PURE + unit-tested.
 */
export function classifyMcpBody(bodyText: string, requestUrl?: string): { sheddable: boolean; id: string | number | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { sheddable: false, id: null }; // unparseable → let the handler reject it (never shed blind)
  }
  const msgs = Array.isArray(parsed) ? parsed : [parsed];
  let id: string | number | null = null;
  let sheddable = false;
  for (const m of msgs) {
    if (m && typeof m === 'object' && (m as { method?: unknown }).method === 'tools/call') {
      if (isCriticalPressureDiagnosticCall(m, requestUrl)) continue;
      sheddable = true;
      const mid = (m as { id?: unknown }).id;
      if (id === null && (typeof mid === 'string' || typeof mid === 'number')) id = mid;
    }
  }
  return { sheddable, id };
}

/**
 * Classify the bounded part of the MCP transport. The `other` class remains
 * fail-open: notifications and resource/prompt traffic are cheap protocol
 * work, while initialize/tools/list/ping and tools/call are the traffic that
 * can create the observed CPU queue. A named health probe is diagnostic even
 * though it is an initialize request, so it retains the diagnostic reserve.
 */
export function classifyMcpRequest(bodyText: string, requestUrl?: string): McpAdmissionClass {
  if (isMcpHealthProbe(requestUrl)) return 'diagnostic';
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return 'other';
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  let ordinaryToolCall = false;
  let diagnosticToolCall = false;
  let handshake = messages.length > 0;
  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      handshake = false;
      continue;
    }
    const method = (message as { method?: unknown }).method;
    if (typeof method !== 'string') {
      handshake = false;
      continue;
    }
    if (MCP_HANDSHAKE_METHODS.has(method)) continue;
    handshake = false;
    if (method !== 'tools/call') continue;
    if (isCriticalPressureDiagnosticCall(message, requestUrl)) diagnosticToolCall = true;
    else ordinaryToolCall = true;
  }
  if (ordinaryToolCall) return 'ordinary';
  if (diagnosticToolCall) return 'diagnostic';
  if (handshake) return 'handshake';
  return 'other';
}

/** The load-shed decision (PURE): shed iff admission control is enabled AND the loop
 *  is in the CRITICAL band. Method-level sheddability is decided separately (needs the
 *  body); this is the cheap gate checked first so the common case never reads the body. */
export function shouldShedForPressure(pressure: LoopPressure, enabled: boolean): boolean {
  return enabled && pressure === 'critical';
}

/** Pure capacity decision used by the live gate and its focused regression tests. */
export function shouldShedForCapacity(
  classification: McpAdmissionClass,
  snapshot: McpAdmissionSnapshot,
  capacity: McpAdmissionCapacity = DEFAULT_CAPACITY,
): boolean {
  if (capacity.maxInFlight <= 0 || classification === 'other') return false;
  if (snapshot.inFlight >= capacity.maxInFlight) return true;
  if (classification === 'handshake' && capacity.maxHandshakes > 0 && snapshot.handshakesInFlight >= capacity.maxHandshakes) {
    return true;
  }
  if (classification === 'diagnostic') return false;
  const reserved = Math.max(0, capacity.controlPlaneReserve) + Math.max(0, capacity.diagnosticReserve);
  const ordinaryCeiling = Math.max(1, capacity.maxInFlight - reserved);
  if (classification === 'ordinary') return snapshot.inFlight >= ordinaryCeiling;
  // A regular handshake can consume the control-plane reserve, but it may not
  // consume the diagnostic reserve.
  const handshakeCeiling = Math.max(1, capacity.maxInFlight - Math.max(0, capacity.diagnosticReserve));
  return snapshot.inFlight >= handshakeCeiling;
}

/** The 429 backpressure response the proxy absorbs. A JSON-RPC error envelope so a
 *  direct (non-proxy) client still gets a structured, retryable signal. */
export function admissionShedResponse(
  id: string | number | null,
  retryAfterSec: number = ADMISSION_RETRY_AFTER_SEC,
  reason = 'loop_pressure_critical',
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message: 'operator MCP admission is saturated — request shed, retry shortly',
        data: { retryable: true, reason },
      },
    }),
    {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterSec) },
    },
  );
}

function releaseAdmission(classification: McpAdmissionClass): void {
  admissionSnapshot = {
    inFlight: Math.max(0, admissionSnapshot.inFlight - 1),
    handshakesInFlight: Math.max(
      0,
      admissionSnapshot.handshakesInFlight - (classification === 'handshake' ? 1 : 0),
    ),
    diagnosticsInFlight: Math.max(
      0,
      admissionSnapshot.diagnosticsInFlight - (classification === 'diagnostic' ? 1 : 0),
    ),
    ordinaryInFlight: Math.max(
      0,
      admissionSnapshot.ordinaryInFlight - (classification === 'ordinary' ? 1 : 0),
    ),
  };
}

function acquireCapacity(classification: McpAdmissionClass): McpAdmissionLease | null {
  if (shouldShedForCapacity(classification, admissionSnapshot)) return null;
  if (classification === 'other') return null;
  admissionSnapshot = {
    inFlight: admissionSnapshot.inFlight + 1,
    handshakesInFlight: admissionSnapshot.handshakesInFlight + (classification === 'handshake' ? 1 : 0),
    diagnosticsInFlight: admissionSnapshot.diagnosticsInFlight + (classification === 'diagnostic' ? 1 : 0),
    ordinaryInFlight: admissionSnapshot.ordinaryInFlight + (classification === 'ordinary' ? 1 : 0),
  };
  let released = false;
  return {
    classification,
    release: () => {
      if (released) return;
      released = true;
      releaseAdmission(classification);
    },
  };
}

/**
 * Acquire the operator-side lease. The original Request body is never
 * consumed: classification peeks through `clone()`, leaving mcp-handler's
 * parser untouched. A malformed/unreadable body is admitted so the protocol
 * layer can return its own structured parse error rather than a misleading
 * overload response.
 */
export async function acquireAdmission(
  req: Request,
  pressure: LoopPressure,
  enabled: boolean,
): Promise<McpAdmissionDecision> {
  if (req.method !== 'POST' || !enabled) {
    return { response: null, lease: null, classification: 'other' };
  }
  let bodyText: string;
  try {
    bodyText = await req.clone().text();
  } catch {
    return { response: null, lease: null, classification: 'other' };
  }
  return acquireMcpBodyAdmission(bodyText, req.url, pressure, enabled);
}

/** Same operator bulkhead for native protocol transports; no HTTP intermediary. */
export function acquireMcpBodyAdmission(
  bodyText: string,
  requestUrl: string,
  pressure: LoopPressure,
  enabled: boolean,
): McpAdmissionDecision {
  if (!enabled) return { response: null, lease: null, classification: 'other' };
  const classification = classifyMcpRequest(bodyText, requestUrl);
  const { sheddable, id } = classifyMcpBody(bodyText, requestUrl);
  if (sheddable && shouldShedForPressure(pressure, enabled)) {
    return {
      response: admissionShedResponse(id, ADMISSION_RETRY_AFTER_SEC, 'loop_pressure_critical'),
      lease: null,
      classification,
    };
  }
  const lease = acquireCapacity(classification);
  if (classification !== 'other' && !lease) {
    const idForResponse = sheddable ? id : null;
    return {
      response: admissionShedResponse(idForResponse, ADMISSION_RETRY_AFTER_SEC, 'operator_admission_capacity'),
      lease: null,
      classification,
    };
  }
  return { response: null, lease, classification };
}

/**
 * Hold an admitted request's capacity lease for the complete handler turn.
 * The transport must not release the lease after the admission decision but
 * before mcp-handler has finished its CPU-bound handshake/dispatch work.
 */
export async function withMcpAdmission(
  req: Request,
  pressure: LoopPressure,
  enabled: boolean,
  run: () => Promise<Response>,
): Promise<Response> {
  const decision = await acquireAdmission(req, pressure, enabled);
  if (decision.response) return decision.response;
  try {
    return await run();
  } finally {
    decision.lease?.release();
  }
}

/**
 * Admission gate (testable core): returns a 429 Response to shed, or null to admit.
 * Peeks the body via `req.clone()` so the ORIGINAL `req` stays intact for the handler.
 * `pressure`/`enabled` are injected so this is unit-testable without booting a monitor.
 */
export async function evaluateAdmission(
  req: Request,
  pressure: LoopPressure,
  enabled: boolean,
): Promise<Response | null> {
  const decision = await acquireAdmission(req, pressure, enabled);
  decision.lease?.release();
  return decision.response;
}
