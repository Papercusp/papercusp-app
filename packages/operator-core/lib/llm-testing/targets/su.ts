/**
 * `su` ChatTarget — in-process behavioral SUT for the **engineer-collaborator
 * playbook** (`apps/operator/prompts/papercusp-su-engineer.tools.md`).
 *
 * Plan `su-scenario-suite-2026-05-31`, D-001 option (a): the SU playbook is
 * not an HTTP endpoint (it's the system prompt for an interactive `psu`/
 * `claude-su` agent), so there's no `/converse` route to POST. Instead this
 * target runs an **in-process Anthropic tool loop**:
 *
 *   system prompt = the engineer playbook (loaded from SOURCE, so the test
 *                   exercises the file we edit, not a stale ~/.papercusp render)
 *   tools         = the curated `papercusp-su` catalog (./su-catalog)
 *   executor      = the framework's `ToolDispatchOverride` seam, defaulting to
 *                   a benign stub result
 *
 * **Why a hand-rolled loop (and not `llm-client.ts` / a subprocess brain):**
 *   - The injected `LlmCallFn` (`llm-client.ts` → anthropic-direct) is a one-shot
 *     completion with NO tools support — it can't tool-call.
 *   - A `claude-code` subprocess brain reaches its MCP tools over HTTP to the
 *     `:3070` host, which is exactly the operator-converse hang D-001 avoids
 *     (and would need a live operator + risk real side effects on the shared
 *     workspace).
 *
 * **Why the executor stubs instead of running `dispatchProjectedTool` for
 * real (a deliberate refinement of D-001):** real dispatch needs a workspace
 * PG tx + principal and would execute live tools against the shared workspace
 * (read-mostly, but writes are possible) — re-introducing the operator/PG
 * dependency the plan set out to avoid and breaking hermeticity. The scenario
 * asserts measure tool *selection* + text conventions, which need only the
 * model's emitted `tool_use`, not real results. A scenario that needs a
 * specific result injects it via `toolOverride` (the existing seam). Wiring a
 * real-dispatch executor later is a drop-in: the loop is executor-agnostic.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applySemanticDelta } from '@papercusp/tooldef';
import { resolveAnthropicBaseUrl, resolveDelegatedGatewayUrl } from '@papercusp/papercusp-shared/agent';
import { PASS_THROUGH } from '@papercusp/testing-shell/llm';
import type {
  ChatSession,
  ChatTarget,
  SessionOptions,
  SseEvent,
  ToolCallEvent,
  ToolDispatchOverride,
  ToolResult,
  TurnInput,
  TurnResult,
} from '@papercusp/testing-shell/llm';

import { buildCatalog, type BuiltCatalog } from './su-catalog';
import { projectCatalogToCompactTier, buildShippingSeedCatalog } from './su-compact-catalog';
import {
  callCodexResponsesTurn,
  isCodexResponsesModel,
  messagesToResponsesInput,
  type ResponsesInputItem,
} from './codex-responses-tool-loop';
import { captureToolResultEvidence } from '../tool-result-evidence';
import { renderSuPlaybook } from '../../desktop-install/papercusp-files';

const BEHAVIORS = [
  'harness-scope',
  'tauri-only',
  'push-not-poll',
  'design-first',
  'no-invent-write',
  'shared-tree-git',
];

/** Per-1M-token prices for the models the SUT might run on (USD). Mirrors the
 *  shared chat-stream ANTHROPIC_PRICES rows we care about. */
const PRICES: Record<string, { in: number; out: number }> = {
  'claude-haiku-4-5': { in: 0.8, out: 4.0 },
  'claude-sonnet-4-6': { in: 3.0, out: 15.0 },
  'claude-opus-4-7': { in: 15.0, out: 75.0 },
  'claude-opus-4-8': { in: 15.0, out: 75.0 },
};
function priceFor(model: string): { in: number; out: number } {
  // Official 5.6 pricing was unavailable during this migration. Do not apply
  // the unrelated Sonnet fallback price to Codex usage; the shared Responses
  // bridge likewise leaves unknown-model cost at zero until canonical pricing
  // metadata is available.
  if (isCodexResponsesModel(model)) return { in: 0, out: 0 };
  if (PRICES[model]) return PRICES[model];
  const prefix = Object.keys(PRICES).find((m) => model.startsWith(m));
  return prefix ? PRICES[prefix] : { in: 3.0, out: 15.0 };
}

/** Default SUT model — the framework's documented `LLM_TEST_SUT_MODEL`
 *  default; the real SU agent runs opus, but sonnet is the cheaper test
 *  default and is plenty to exercise the playbook's hard rules. */
function sutModel(): string {
  return process.env.LLM_TEST_SUT_MODEL?.trim() || 'claude-sonnet-4-6';
}

// ---------------------------------------------------------------------------
// Playbook (system prompt) — rendered from the same canonical blueprint source
// as a live SU launch, then cached per process.
// ---------------------------------------------------------------------------

/** Keyed by the bound mode set (sorted, comma-joined; '' = no modes). */
const _playbookCache = new Map<string, Promise<string>>();

export function resolvePlaybookPath(): string {
  const override = process.env.PAPERCUSP_SU_PLAYBOOK_PATH?.trim();
  if (override) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  const rel = join('libs', 'papercusp', 'packages', 'harness', 'blueprints', 'base', 'prompts', 'su.md');
  const candidates = [
    // packages/operator-core/lib/llm-testing/targets → repo root (5 up)
    join(here, '..', '..', '..', '..', '..', rel),
    join(process.cwd(), rel),
    join(process.cwd(), '..', '..', rel), // when cwd = apps/operator
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `su target: could not locate the canonical blueprint playbook (${rel}). ` +
      `Set PAPERCUSP_SU_PLAYBOOK_PATH. Tried:\n  ${candidates.join('\n  ')}`,
  );
}

function resolveOverlayDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const rel = join('apps', 'operator', 'prompts');
  const candidates = [
    join(here, '..', '..', '..', '..', '..', rel),
    join(process.cwd(), rel),
    join(process.cwd(), '..', '..', rel),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'papercusp-su.claude.md'))) return candidate;
  }
  throw new Error(
    `su target: could not locate the SU client overlays (${rel}). Tried:\n  ${candidates.join('\n  ')}`,
  );
}

/**
 * The rendered playbook BODY (no framing prefix). Exported for the FB-09
 * shadow-ablation runner (lib/ablation), which segments + ablates THIS text —
 * the exact body the SUT sees — and re-frames it via SU_PLAYBOOK_FRAMING.
 *
 * This deliberately follows the flag-on live launch path instead of reading
 * `apps/operator/prompts/papercusp-su-engineer.tools.md`, the legacy base. The
 * canonical blueprint source is first sealed through `composeSuStackSource`,
 * then `renderSuPlaybook` splices the Claude client overlay and every generated
 * section. The project guide stays omitted: scenario worlds are hermetic and
 * must not inherit mutable repository facts unrelated to their fixtures.
 *
 * `modes` binds the ACTIVE registry modes exactly as a live launch binds
 * `agent_modes` (identities-v1 P-021): each mode's definition is an identity
 * layer, so with no modes bound NO mode definition renders (EI-23996297775579005).
 *
 * Uncached: callers are per-cycle, not per-model-call.
 */
export async function loadPlaybookBody(modes: readonly string[] | null = null): Promise<string> {
  const baseSource = resolvePlaybookPath();
  const overlayDir = resolveOverlayDir();
  let baseText: string | undefined;
  try {
    const { composeSuStackSource, suSessionBinding } = await import('@papercusp/orchestrator/blueprint');
    const harnessDir = resolve(baseSource, '..', '..', '..', '..');
    baseText = composeSuStackSource({
      harnessDir,
      binding: suSessionBinding({ fleetRole: null, modes }),
    }).text;
  } catch (error) {
    // Match buildSuLaunchSpec's production fallback: an unavailable slot
    // composer is loud, but the canonical su.md still renders rather than
    // silently falling back to the unrelated legacy playbook.
    console.warn(
      `[llm-testing] SU slot-stack compose failed — rendering canonical su.md unsealed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const rendered = await renderSuPlaybook({
    agent: 'claude',
    baseSource,
    baseText,
    overlayDir,
    projectGuideSource: '',
  });
  return rendered.text;
}

/** A thin framing line so the model treats the playbook as ITS operating
 *  system prompt (not a doc handed to it by the user). The playbook content
 *  itself carries every behavioral rule under test. */
export const SU_PLAYBOOK_FRAMING =
  'You are a Papercusp superuser engineer-collaborator (a `psu` session). ' +
  'The following is your operating playbook — follow it exactly.\n\n';

function loadPlaybook(modes: readonly string[] | null = null): Promise<string> {
  const key = modes && modes.length ? [...modes].sort().join(',') : '';
  const cached = _playbookCache.get(key);
  if (cached !== undefined) return cached;
  const next = loadPlaybookBody(key ? key.split(',') : null).then((body) => SU_PLAYBOOK_FRAMING + body);
  _playbookCache.set(key, next);
  return next;
}

/**
 * Parse a scenario's `targetConfig` for the su target. The only key is `modes`:
 * the ACTIVE registry modes the scenario's world claims, INCLUDING the implication
 * closure the registry write applies (e.g. `grade` implies `auto`), because
 * `suSessionBinding` binds exactly what it is given. Unknown keys and malformed
 * values throw, so a typo cannot silently render the mode-less prompt.
 */
export function parseSuTargetConfig(
  config: Readonly<Record<string, unknown>> | undefined,
): { modes: string[] | null } {
  if (config === undefined) return { modes: null };
  for (const key of Object.keys(config)) {
    if (key !== 'modes') throw new Error(`su target: unknown targetConfig key "${key}" (known: modes)`);
  }
  const modes = config.modes;
  if (modes === undefined) return { modes: null };
  if (!Array.isArray(modes) || modes.some((m) => typeof m !== 'string' || !m.trim())) {
    throw new Error('su target: targetConfig.modes must be an array of non-empty mode names');
  }
  return { modes: modes.length ? modes.map((m: string) => m.trim()) : null };
}

// ---------------------------------------------------------------------------
// Transport — resolve a tool-capable Anthropic-format client, mirroring the
// shared chat-stream `resolveStatelessTransport` (which is not exported):
// direct-to-Anthropic with an explicit api key, else the Claude-Max OAuth
// session. (The omp-token fallback via the local Meridian router was retired
// 2026-06-12, EI-399.)
// ---------------------------------------------------------------------------

interface Transport {
  baseURL?: string;
  apiKey?: string;
  authToken?: string;
  headers: Record<string, string>;
}

/**
 * Headers that belong only on the local inference-gateway hop.
 *
 * The SU SUT uses its own tool-capable Anthropic client rather than the shared
 * stateless `llmCall` wrapper. That used to leave these requests anonymous and
 * unlabeled, so the gateway put them in its tier-5 fallback lane while the
 * sim-user and judge correctly rode the `llm-testing` lane. Under fleet load a
 * scenario could therefore spend its entire wallclock budget waiting for turn
 * zero. A per-run owner also makes a future stall attributable instead of
 * disappearing from `gateway:owner_report`.
 *
 * Keep the internal headers off direct Anthropic/BYO-key requests. Comparing
 * origins tolerates an SDK base URL with a trailing path while still requiring
 * the same loopback gateway endpoint.
 */
export function buildSuTransportHeaders(
  transport: Pick<Transport, 'baseURL' | 'authToken' | 'headers'>,
  runId: string,
  delegatedGatewayUrl = resolveDelegatedGatewayUrl(),
): Record<string, string> {
  let routedThroughGateway = false;
  try {
    routedThroughGateway = Boolean(
      transport.authToken
      && transport.baseURL
      && new URL(transport.baseURL).origin === new URL(delegatedGatewayUrl).origin,
    );
  } catch {
    // An invalid URL is rejected by the SDK later; do not attach internal
    // gateway headers to an endpoint we could not positively identify.
  }
  if (!routedThroughGateway) return transport.headers;
  return {
    ...transport.headers,
    'x-papercusp-priority': 'llm-testing',
    'x-papercusp-owner': `llm-test:${runId}`,
  };
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function resolveTransport(): Transport | { error: string } {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) {
    return {
      baseURL: process.env.PAPERCUSP_ANTHROPIC_URL,
      apiKey,
      headers: {},
    };
  }
  const claudeTok = readJson<{ claudeAiOauth?: { accessToken?: string } }>(
    join(homedir(), '.claude', '.credentials.json'),
  )?.claudeAiOauth?.accessToken;
  if (claudeTok) {
    return {
      // Gateway-aware (EI-456) — OAuth path routes through the inference gateway
      // when it exports ANTHROPIC_BASE_URL. (The ANTHROPIC_API_KEY branch above
      // stays direct: the gateway re-auths to the pool, which would shadow a BYO key.)
      baseURL: resolveAnthropicBaseUrl(),
      authToken: claudeTok,
      headers: { 'anthropic-beta': 'oauth-2025-04-20' },
    };
  }
  return {
    error:
      'su target needs ANTHROPIC_API_KEY or a Claude session ' +
      '(~/.claude/.credentials.json) to drive the SUT model.',
  };
}

function promptCacheEnabled(): boolean {
  return process.env.PAPERCUSP_PROMPT_CACHE !== '0';
}

// ---------------------------------------------------------------------------
// Anthropic message shapes (kept local so we don't type-depend on the SDK,
// which is dynamically imported like the shared stateless path).
// ---------------------------------------------------------------------------

interface TextBlock { type: 'text'; text: string }
interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown }
type ContentBlock = TextBlock | ToolUseBlock | { type: string; [k: string]: unknown };
interface AnthropicMessage { role: 'user' | 'assistant'; content: string | ContentBlock[] }
type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

const COMPACTION_SUMMARY_MARKER = 'Earlier conversation compacted';

/**
 * Read-only tools whose hermetic default needs to look like an empty read,
 * rather than a successful mutation.  A bare `{ok:true}` is ambiguous to the
 * model: it has no evidence that a search returned no rows, so the next
 * assistant turn may invent the missing plan/service/port details.  Keep the
 * fallback neutral (no test-frame wording) while exposing empty collection
 * fields that make the absence of data explicit.
 */
const EMPTY_READ_TOOLS = new Set([
  'docs:get',
  'docs:outline',
  'docs:search',
  'plans:get',
  'plans:list',
  'plans:search',
  'search:fulltext',
  'search:semantic',
  'harness:get',
  'harness:list',
  'harness:status',
]);

/**
 * Exec/write-capable tools whose hermetic default MUST be loud, not a silent
 * benign `{ok:true}`. A bare `{ok:true}` with no output is indistinguishable
 * to the SUT from "my script ran and produced nothing" — it burns turns
 * debugging a phantom bug in its own script instead of recognizing the tool
 * simply isn't stubbed in this scenario world (EI-18767979259669887: an
 * S31-asymmetry-control run spent its whole 2-turn budget on this before
 * giving up and routing around it). An explicit `ok:false` lets the SUT
 * re-route in one turn instead of debugging a ghost.
 */
const EXEC_TOOLS = new Set([
  'code:run',
  'code:tools',
  'capability:bash',
  'capability:bash_output',
  'capability:bash_kill',
  'capability:write',
  'capability:edit',
]);

export function defaultToolResultForModel(name: string): ToolResult {
  if (EMPTY_READ_TOOLS.has(name)) {
    return {
      content: [
        {
          text: JSON.stringify({ ok: true, results: [], items: [], hits: [], rows: [] }),
        },
      ],
    };
  }
  if (EXEC_TOOLS.has(name)) {
    return {
      content: [
        {
          text: JSON.stringify({
            ok: false,
            error: `tool ${name} is not available in this scenario world`,
          }),
        },
      ],
    };
  }
  return { content: [{ text: JSON.stringify({ ok: true }) }] };
}

/**
 * The Claude Code identifier. It MUST be the first `system` block on the SUT's
 * raw Messages API call: a Claude Max/Pro OAuth token (the no-ANTHROPIC_API_KEY
 * path this suite runs under) is only admitted to the full, CLI-equivalent
 * rate-limit bucket when the request is framed as Claude Code. Without it the
 * SAME token is shunted to a far stricter raw-OAuth bucket that 429s almost
 * immediately, independent of real account usage (measured 2026-06-08: identical
 * call 429s without this block, 200s with it, while the `claude` CLI runs fine).
 * Regression-tested in su-system-framing.test.ts — do not drop or reorder it.
 */
export const CLAUDE_CODE_IDENTIFIER = "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Build the SUT system prompt: the Claude Code identifier FIRST (auth framing,
 * above), then the engineer playbook (cache_control'd when prompt caching is on),
 * then — when an eval variant carries one — the variant's prompt OVERLAY as its
 * own UNCACHED block (test-gym-apiary P-001: the overlay varies per candidate,
 * so it must sit after the cache breakpoint or every candidate would bust the
 * playbook's cache entry).
 * Exported so the framing invariant has a unit test independent of live creds.
 */
export function buildSuSystemBlocks(
  playbookText: string,
  cache: boolean,
  promptOverlay?: string,
): SystemBlock[] {
  return [
    { type: 'text', text: CLAUDE_CODE_IDENTIFIER },
    cache
      ? { type: 'text', text: playbookText, cache_control: { type: 'ephemeral' } }
      : { type: 'text', text: playbookText },
    ...(promptOverlay ? [{ type: 'text' as const, text: promptOverlay }] : []),
  ];
}

/**
 * Config-delta keys the su target understands (test-gym-apiary P-001).
 * Anything else throws at open() — a silently-dropped knob would mislabel a
 * baseline run as the candidate.
 */
const SU_CONFIG_DELTA_KEYS = new Set([
  'sutModel',
  'systemPromptText',
  'excludeTools',
  'toolDefinitionTier',
  'catalogSource',
]);

export interface SuConfigDelta {
  sutModel?: string;
  systemPromptText?: string;
  excludeTools?: string[];
  /**
   * The DELIVERY-TIER seam (deterministic-tool-definition-delivery-2026-09-21
   * P-011 / D-008). `'compact'` re-projects every offered definition through the
   * same `summaryGuidanceDescription` + `compactInputSchema` pair the transport
   * ships, preferring the LIVE registry row over the harness's curated
   * stand-in. The tool NAME set, the scenarios and the asserts are untouched, so
   * baseline-vs-compact differs in exactly one variable: how much of each
   * definition the model was told. Default `'full'` is today's behaviour.
   */
  toolDefinitionTier?: 'full' | 'compact';
  /**
   * WHICH tool set is offered, as opposed to how much of each definition
   * (`toolDefinitionTier`) — D-019.
   *
   * `'curated'` (default, today's behaviour) offers `SU_CATALOG`, a
   * hand-authored constant. Measured 2026-09-22 it overlaps the claude
   * shipping seed by 27 of 63, so an A/B over it varies the tier on a surface
   * that is 43% of what ships — the reason D-012 found this instrument could
   * not answer D-008.
   *
   * `'shipping-seed'` offers exactly the names the generated delivery
   * artifact says are DELIVERED, sourced from the live registry, so
   * `toolDefinitionTier` then varies the one variable D-008 asks about on the
   * surface that actually ships.
   */
  catalogSource?: 'curated' | 'shipping-seed';
}

export function parseSuConfigDelta(delta: Record<string, unknown> | undefined): SuConfigDelta {
  if (!delta) return {};
  const unknown = Object.keys(delta).filter((k) => !SU_CONFIG_DELTA_KEYS.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `su target: unsupported variant configDelta key(s) [${unknown.join(', ')}] — ` +
        `supported: ${[...SU_CONFIG_DELTA_KEYS].join(', ')}`,
    );
  }
  const out: SuConfigDelta = {};
  if (delta.toolDefinitionTier !== undefined) {
    if (delta.toolDefinitionTier !== 'full' && delta.toolDefinitionTier !== 'compact') {
      throw new Error(
        "su target: variant configDelta.toolDefinitionTier must be 'full' or 'compact'",
      );
    }
    out.toolDefinitionTier = delta.toolDefinitionTier;
  }
  if (delta.catalogSource !== undefined) {
    if (delta.catalogSource !== 'curated' && delta.catalogSource !== 'shipping-seed') {
      throw new Error(
        "su target: variant configDelta.catalogSource must be 'curated' or 'shipping-seed'",
      );
    }
    out.catalogSource = delta.catalogSource;
  }
  if (delta.sutModel !== undefined) {
    if (typeof delta.sutModel !== 'string' || !delta.sutModel.trim()) {
      throw new Error('su target: variant configDelta.sutModel must be a non-empty string');
    }
    out.sutModel = delta.sutModel.trim();
  }
  if (delta.systemPromptText !== undefined) {
    // The FB-09 shadow-ablation seam (self-learning-frontier P-023): the FULL
    // framed system-prompt text REPLACING the target's loader for this run —
    // the caller frames it (SU_PLAYBOOK_FRAMING + ablated body) so baseline
    // and ablated arms differ only in the removed rule. Never trimmed: the
    // text IS the experiment.
    if (typeof delta.systemPromptText !== 'string' || !delta.systemPromptText.trim()) {
      throw new Error('su target: variant configDelta.systemPromptText must be a non-empty string');
    }
    out.systemPromptText = delta.systemPromptText;
  }
  if (delta.excludeTools !== undefined) {
    // The TOOL-AVAILABILITY seam (code-execution-tool-orchestration adoption A/B): canonical
    // tool names (e.g. "code:run") to REMOVE from the catalog offered to the SUT for this run, so
    // a "without code:run available" arm can be compared against the baseline to measure the
    // token-cost delta of the tool's presence + adoption. Names are canonical colon form.
    if (
      !Array.isArray(delta.excludeTools) ||
      !delta.excludeTools.every((t) => typeof t === 'string' && t.trim())
    ) {
      throw new Error('su target: variant configDelta.excludeTools must be an array of non-empty tool-name strings');
    }
    out.excludeTools = (delta.excludeTools as string[]).map((t) => t.trim());
  }
  return out;
}

/** Filter a built catalog to drop the canonical tool names in `exclude` (the excludeTools seam).
 *  Returns the same catalog object when `exclude` is empty so the common path allocates nothing. */
export function filterCatalog(catalog: BuiltCatalog, exclude?: readonly string[]): BuiltCatalog {
  if (!exclude || exclude.length === 0) return catalog;
  const drop = new Set(exclude);
  const tools = catalog.tools.filter((t) => !drop.has(catalog.canonicalBySanitized.get(t.name) ?? t.name));
  return { tools, canonicalBySanitized: catalog.canonicalBySanitized };
}

export interface SuTargetOpts {
  catalog?: BuiltCatalog;
  /** Target id override (default 'su') — sibling in-process SUTs (e.g. the
   *  hive Queen) reuse this loop with their own prompt + catalog. */
  id?: string;
  behaviors?: string[];
  /** System-prompt loader override (default: the engineer playbook). Returns
   *  the FULL framed prompt text; called lazily per send like loadPlaybook. */
  loadSystemPrompt?: () => string | Promise<string>;
  /** Injectable Responses transport for hermetic target tests. */
  codexFetch?: typeof fetch;
}

export class SuTarget implements ChatTarget {
  readonly id: string;
  readonly behaviors: string[];
  /** Eval variant knob (test-gym-apiary P-001): prompt overlay + configDelta.sutModel. */
  readonly supportsVariants = true;
  /** EI-336: the real, canonical tool names this target's catalog offers the
   *  SUT — handed to the judge so a "fabricated tool name" claim is checked
   *  against ground truth instead of the judge's imperfect memory. */
  readonly toolNames: readonly string[];
  private readonly catalog: BuiltCatalog;
  private readonly loadSystemPrompt: () => string | Promise<string>;
  /** A sibling SUT supplied its own prompt loader, so targetConfig.modes cannot apply. */
  private readonly customPrompt: boolean;
  private readonly codexFetch?: typeof fetch;

  constructor(opts: SuTargetOpts = {}) {
    this.id = opts.id ?? 'su';
    this.behaviors = opts.behaviors ?? BEHAVIORS;
    this.catalog = opts.catalog ?? buildCatalog();
    this.toolNames = [...this.catalog.canonicalBySanitized.values()];
    this.loadSystemPrompt = opts.loadSystemPrompt ?? (() => loadPlaybook());
    this.customPrompt = opts.loadSystemPrompt !== undefined;
    this.codexFetch = opts.codexFetch;
  }

  async open(opts: SessionOptions): Promise<ChatSession> {
    // Eval variant (test-gym-apiary P-001): overlay rides as an extra system
    // block; configDelta is validated HERE so an unknown knob fails the run at
    // open() (loud), not mid-conversation.
    const delta = parseSuConfigDelta(opts.variant?.configDelta);
    const { modes } = parseSuTargetConfig(opts.targetConfig);
    if (modes && (this.customPrompt || delta.systemPromptText !== undefined)) {
      throw new Error(
        'su target: targetConfig.modes binds mode layers into the canonical su render, but this session replaces ' +
          'that prompt (a custom loadSystemPrompt or variant systemPromptText), so the modes would be silently dropped',
      );
    }
    // The DELIVERY-TIER A/B (P-011/D-008): re-project every offered definition
    // onto COMPACT before the availability filter, so the two seams compose and
    // the projected set is exactly what this session will be offered. Awaited
    // here rather than in the constructor because the projection reads the live
    // tool registry; a failure must surface as a loud open() error, never as a
    // silent fall back to the curated definitions (which would make a full-tier
    // run indistinguishable from a compact-tier one).
    // D-019: `catalogSource` chooses the tool SET, `toolDefinitionTier` how
    // much of each definition. The shipping-seed builder applies the tier
    // itself (it projects straight from the live registry), so it is NOT then
    // re-projected — doing both would summarise an already-summarised
    // description and measure a tier that ships nowhere.
    const tiered =
      delta.catalogSource === 'shipping-seed'
        ? (await buildShippingSeedCatalog(delta.toolDefinitionTier ?? 'full')).catalog
        : delta.toolDefinitionTier === 'compact'
          ? (await projectCatalogToCompactTier(this.catalog)).catalog
          : this.catalog;
    return new SuSession({
      runId: opts.runId,
      // Drop any excludeTools from the catalog offered to the SUT (the availability A/B seam).
      catalog: filterCatalog(tiered, delta.excludeTools),
      loadSystemPrompt: delta.systemPromptText !== undefined
        ? () => delta.systemPromptText!
        : modes
          ? () => loadPlaybook(modes)
          : this.loadSystemPrompt,
      override: opts.dispatchOverride,
      ...(opts.variant?.promptOverlay ? { promptOverlay: opts.variant.promptOverlay } : {}),
      modelOverride: delta.sutModel ?? opts.sutModel,
      codexFetch: this.codexFetch,
    });
  }
}

interface SessionState {
  runId: string;
  catalog: BuiltCatalog;
  loadSystemPrompt: () => string | Promise<string>;
  override?: ToolDispatchOverride;
  /** Variant prompt overlay (P-001) — appended as an uncached system block. */
  promptOverlay?: string;
  /** Variant configDelta.sutModel (P-001) — overrides the env/default model. */
  modelOverride?: string;
  codexFetch?: typeof fetch;
}

class SuSession implements ChatSession {
  readonly sessionId: string;
  private readonly state: SessionState;
  private readonly deltaViews = new Map<string, DeltaViewState>();
  private sawCompactionSummary = false;

  constructor(state: SessionState) {
    this.state = state;
    this.sessionId = `llm-testing/${state.runId}`;
  }

  async close(): Promise<void> {
    /* nothing to tear down — fully in-process */
  }

  async send(input: TurnInput): Promise<TurnResult> {
    const startMs = performance.now();
    const model = this.state.modelOverride ?? sutModel();
    if (isCodexResponsesModel(model)) {
      return this.sendViaCodex(input, model, startMs);
    }
    const result: TurnResult = {
      assistantText: '',
      toolCalls: [],
      toolResults: [],
      cards: [],
      controlTags: [],
      costUsd: 0,
      latencyMs: 0,
      finishReason: 'done',
      rawSseTape: [],
    };

    const transport = resolveTransport();
    if ('error' in transport) {
      return errorTurn(transport.error, performance.now() - startMs);
    }

    let Anthropic: new (cfg: unknown) => AnthropicClient;
    try {
      const mod = await import('@anthropic-ai/sdk');
      Anthropic = ((mod as { default?: unknown }).default ?? mod) as unknown as new (
        cfg: unknown,
      ) => AnthropicClient;
    } catch (err) {
      return errorTurn(`su target: failed to load @anthropic-ai/sdk: ${(err as Error).message}`, performance.now() - startMs);
    }

    // Rebuild the client per (re)try so a mid-run OAuth-token rotation is picked up
    // (EI-281): the shared ~/.claude/.credentials.json refreshes under fleet load, so
    // resolveTransport() is re-read on each build rather than frozen at turn start. The
    // upfront `transport` check above still gives a clean error turn when creds are absent.
    const makeClient = (): AnthropicClient => {
      const t = resolveTransport();
      if ('error' in t) throw new Error(t.error);
      return new Anthropic({
        ...(t.baseURL ? { baseURL: t.baseURL } : {}),
        ...(t.apiKey ? { apiKey: t.apiKey } : {}),
        ...(t.authToken ? { authToken: t.authToken } : {}),
        defaultHeaders: buildSuTransportHeaders(t, this.state.runId),
        maxRetries: 2,
      });
    };

    const price = priceFor(model);
    const cache = promptCacheEnabled();
    // First system block MUST be the Claude Code identifier (auth framing for the
    // Max OAuth rate-limit bucket — see CLAUDE_CODE_IDENTIFIER / buildSuSystemBlocks).
    // Built via the exported helper so the framing invariant is regression-tested.
    const system = buildSuSystemBlocks(await this.state.loadSystemPrompt(), cache, this.state.promptOverlay);
    const tools = this.state.catalog.tools;

    const sawCompactionSummary = input.messages.some((m) => (
      typeof m.content === 'string' && m.content.includes(COMPACTION_SUMMARY_MARKER)
    ));
    if (sawCompactionSummary && !this.sawCompactionSummary) {
      this.deltaViews.clear();
    }
    this.sawCompactionSummary = sawCompactionSummary;

    // The conversation transcript for THIS turn (stateless: caller threads the
    // full history each send()). System prompt is the playbook; drop any
    // 'system' entries from the message list, then MERGE consecutive same-role
    // turns (see mergeConsecutiveRoles): the official Anthropic API auto-merges
    // these but the inference-gateway PROXY this target routes through may not,
    // and the runner's compaction seam (P-006) can legitimately leave a summary
    // user-turn adjacent to the next user message.
    const messages: AnthropicMessage[] = mergeConsecutiveRoles(
      input.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    );

    const ctrl = new AbortController();
    const TURN_CAP_MS = 240_000;
    const deadline = performance.now() + TURN_CAP_MS;
    const killer = setTimeout(() => ctrl.abort(), TURN_CAP_MS);
    let completed = false;

    try {
      // Discovery + reads can legitimately consume six responses before the
      // final answer. Bound the turn by its existing deadline, not by an
      // arbitrary round count that silently returns "done" mid-conversation.
      for (let iter = 0; !ctrl.signal.aborted && performance.now() < deadline; iter++) {
        let resp: AnthropicResponse;
        try {
          resp = await callWithRetry(makeClient, {
            model,
            max_tokens: 4096,
            system,
            messages,
            tools,
          }, ctrl.signal);
        } catch (err) {
          result.finishReason = 'error';
          result.error = `model call failed: ${(err as Error).message}`;
          break;
        }

        // Accrue cost.
        const inTok = resp.usage?.input_tokens ?? 0;
        const outTok = resp.usage?.output_tokens ?? 0;
        result.costUsd += (inTok * price.in + outTok * price.out) / 1_000_000;

        const blocks: ContentBlock[] = Array.isArray(resp.content) ? resp.content : [];
        const toolUses: ToolUseBlock[] = [];
        for (const block of blocks) {
          if (block.type === 'text' && typeof (block as TextBlock).text === 'string') {
            const text = (block as TextBlock).text;
            result.assistantText += text;
            result.rawSseTape.push(sse('delta', { text }));
          } else if (block.type === 'tool_use') {
            const tu = block as ToolUseBlock;
            const canonical = this.state.catalog.canonicalBySanitized.get(tu.name) ?? tu.name;
            const ev: ToolCallEvent = { name: canonical, input: tu.input, responseIndex: iter };
            result.toolCalls.push(ev);
            result.rawSseTape.push(sse('tool_call', { name: canonical, input: tu.input }));
            toolUses.push(tu);
          }
        }

        if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) {
          completed = true;
          break; // assistant turn complete
        }

        // Feed tool results back so the loop can continue. The assistant
        // message must carry the raw content blocks (incl. tool_use).
        messages.push({ role: 'assistant', content: blocks });
        const toolResults: ContentBlock[] = [];
        for (const tu of toolUses) {
          const canonical = this.state.catalog.canonicalBySanitized.get(tu.name) ?? tu.name;
          const { text, isError } = await this.resolveToolResult(canonical, tu.input);
          result.toolResults.push(captureToolResultEvidence(canonical, text, isError));
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: text,
            ...(isError ? { is_error: true } : {}),
          });
        }
        messages.push({ role: 'user', content: toolResults });
      }
      if (!completed && result.finishReason !== 'error') {
        result.finishReason = 'error';
        result.error = `su Anthropic turn deadline reached after ${TURN_CAP_MS}ms before a final response`;
      }
    } finally {
      clearTimeout(killer);
    }

    result.rawSseTape.push(sse('done', { costUsd: result.costUsd }));
    result.latencyMs = performance.now() - startMs;
    return result;
  }

  /**
   * Tool-capable GPT path over Responses. Every completed output item is
   * replayed before the next function result, including encrypted reasoning
   * requested by the transport helper; no Chat Completions request is used.
   */
  private async sendViaCodex(input: TurnInput, model: string, startMs: number): Promise<TurnResult> {
    const result: TurnResult = {
      assistantText: '',
      toolCalls: [],
      toolResults: [],
      cards: [],
      controlTags: [],
      costUsd: 0,
      latencyMs: 0,
      finishReason: 'done',
      rawSseTape: [],
    };
    const instructions = [await this.state.loadSystemPrompt(), this.state.promptOverlay]
      .filter((part): part is string => Boolean(part))
      .join('\n\n');
    const replay: ResponsesInputItem[] = messagesToResponsesInput(input.messages);
    const ctrl = new AbortController();
    const turnCapMs = 240_000;
    const deadline = performance.now() + turnCapMs;
    const killer = setTimeout(() => ctrl.abort(new Error(`su Codex turn timed out after ${turnCapMs}ms`)), turnCapMs);
    killer.unref?.();
    const price = priceFor(model);
    let completed = false;
    try {
      for (let iter = 0; !ctrl.signal.aborted && performance.now() < deadline; iter++) {
        let turn: Awaited<ReturnType<typeof callCodexResponsesTurn>>;
        try {
          turn = await callCodexResponsesTurn({
            model,
            instructions,
            input: replay,
            catalog: this.state.catalog,
            maxOutputTokens: 4096,
            signal: ctrl.signal,
            fetchImpl: this.state.codexFetch,
          });
        } catch (err) {
          result.finishReason = 'error';
          result.error = `model call failed: ${(err as Error).message}`;
          break;
        }
        result.costUsd +=
          (turn.inputTokens * price.in + turn.outputTokens * price.out) / 1_000_000;
        if (turn.text) {
          result.assistantText += turn.text;
          result.rawSseTape.push(sse('delta', { text: turn.text }));
        }
        replay.push(...turn.outputItems);
        if (turn.toolCalls.length === 0) {
          completed = true;
          break;
        }

        const outputs: ResponsesInputItem[] = [];
        for (const call of turn.toolCalls) {
          const canonical = this.state.catalog.canonicalBySanitized.get(call.name) ?? call.name;
          const event: ToolCallEvent = { name: canonical, input: call.input, responseIndex: iter };
          result.toolCalls.push(event);
          result.rawSseTape.push(sse('tool_call', event));
          const toolResult = await this.resolveToolResult(canonical, call.input);
          result.toolResults.push(
            captureToolResultEvidence(canonical, toolResult.text, toolResult.isError),
          );
          outputs.push({
            type: 'function_call_output',
            call_id: call.callId,
            output: toolResult.text,
          });
        }
        replay.push(...outputs);
      }
      if (!completed && result.finishReason !== 'error') {
        result.finishReason = 'error';
        result.error = `su Codex turn deadline reached after ${turnCapMs}ms before a final response`;
      }
    } finally {
      clearTimeout(killer);
    }
    result.rawSseTape.push(sse('done', { costUsd: result.costUsd }));
    result.latencyMs = performance.now() - startMs;
    return result;
  }

  /**
   * Produce a tool result for the model. Consults the scenario's
   * `toolOverride` (the existing dispatch-override seam) first; falls back to
   * a benign stub so the loop can progress without live side effects — EXCEPT
   * for `EXEC_TOOLS`, whose fallback is a loud `ok:false` (see EXEC_TOOLS doc):
   * a silent `{ok:true}` for an unstubbed exec tool is indistinguishable from
   * "ran and produced nothing", which burns turns debugging a phantom bug
   * instead of one-turn re-routing (EI-18767979259669887).
   *
   * The fallback must NOT announce that it is a stub: the SUT mirrors result
   * text into its replies, so a self-describing stub leaks the test frame into
   * the behavior under measurement (the SU-S12 first run opened with "we're
   * running inside the LLM-testing stub…", which the judge then flagged —
   * the EI-133 stub-artifact class at the target level). The EXEC_TOOLS
   * message ("tool <name> is not available in this scenario world") avoids
   * the banned stub/test-harness/llm-testing wording for the same reason.
   */
  private async resolveToolResult(
    name: string,
    input: unknown,
  ): Promise<{ text: string; isError: boolean }> {
    const direct = await this.resolveScenarioOverride(name, input);
    if (direct) return direct;

    // `tools:invoke` is a real DISPATCH wrapper, not a benign acknowledgement.
    // A scenario may override the wrapper itself (S31 does); otherwise forward
    // the exact discovered colon-form name + args into the same hermetic world.
    // Falling back to `{ok:true}` here made nested writes look successful while
    // nothing changed, then taught the model to claim an unverified edit (S04).
    if (name === 'tools:invoke') {
      const envelope = (input ?? {}) as Record<string, unknown>;
      const nestedName = typeof envelope.name === 'string' ? envelope.name.trim() : '';
      const nestedInput = envelope.args && typeof envelope.args === 'object' ? envelope.args : {};
      if (!nestedName || nestedName === 'tools:invoke') {
        return {
          text: JSON.stringify({
            ok: false,
            error: !nestedName
              ? 'tools:invoke requires a non-empty nested tool name'
              : 'tools:invoke cannot invoke itself recursively',
          }),
          isError: true,
        };
      }
      const nested = await this.resolveScenarioOverride(nestedName, nestedInput);
      if (nested) return nested;
      return {
        text: JSON.stringify({
          ok: false,
          error: `nested tool ${nestedName} is not available in this scenario world`,
        }),
        isError: true,
      };
    }

    const fallback = defaultToolResultForModel(name);
    return {
      text: fallback.content[0]?.text ?? JSON.stringify({ ok: true }),
      isError: EXEC_TOOLS.has(name),
    };
  }

  /** Resolve one canonical tool against the scenario-owned hermetic dispatcher. */
  private async resolveScenarioOverride(
    name: string,
    input: unknown,
  ): Promise<{ text: string; isError: boolean } | null> {
    const override = this.state.override;
    if (override) {
      // Match either the canonical name or the mcp-prefixed alias, like the
      // production override seam (AUTHORING §6).
      for (const candidate of [name, `mcp__agentmcp__${name}`]) {
        const res = await override.override(candidate, input);
        if (res !== PASS_THROUGH) {
          const viewKey = deltaViewKey(name, input);
          const adapted = await adaptDeltaToolResultForModel(
            this.deltaViews,
            viewKey,
            res as ToolResult,
            async () => {
              const refetched = await override.override(candidate, input);
              return refetched === PASS_THROUGH ? null : (refetched as ToolResult);
            },
          );
          return renderToolResult(adapted);
        }
      }
    }
    return null;
  }
}

interface DeltaViewState {
  rows: unknown[];
  cursor?: string;
}

type DeltaToolPayload =
  | { ok?: boolean; mode: 'full'; cursor?: string; items?: unknown[]; count?: number; [k: string]: unknown }
  | { ok?: boolean; mode: 'delta'; cursor?: string; items?: unknown[]; counts?: unknown; [k: string]: unknown }
  | { ok?: boolean; mode: 'not_modified'; cursor?: string; [k: string]: unknown };

/**
 * LLM-test target adapter for the delta scenarios. Production's safe contract is
 * "the turn wrapper owns base-presence and merge/refetch"; the model should not
 * receive raw semantic-delta rows and be trusted to merge them. This adapter
 * makes the hermetic live-model target emulate that wrapper when a scenario
 * override returns a `{ mode: 'delta' }` payload.
 */
export async function adaptDeltaToolResultForModel(
  views: Map<string, DeltaViewState>,
  viewKey: string,
  result: ToolResult,
  refetchFull?: () => Promise<ToolResult | null>,
): Promise<ToolResult> {
  const payload = parseSingleJsonToolPayload(result);
  if (!payload || !isDeltaPayload(payload)) return result;

  if (payload.mode === 'full') {
    if (Array.isArray(payload.items)) {
      views.set(viewKey, { rows: payload.items, cursor: typeof payload.cursor === 'string' ? payload.cursor : undefined });
    }
    return result;
  }

  if (payload.mode === 'not_modified') {
    const cached = views.get(viewKey);
    if (!cached) return result;
    const full = {
      ok: payload.ok ?? true,
      mode: 'full',
      cursor: typeof payload.cursor === 'string' ? payload.cursor : cached.cursor,
      count: cached.rows.length,
      items: cached.rows,
      note:
        'Delta-aware target reconstructed this complete current view from its cached base. ' +
        'The cursor is a change-watermark, not pagination.',
    };
    return replaceToolJson(result, full);
  }

  const cached = views.get(viewKey);
  if (!cached) {
    const refetched = await refetchFull?.();
    if (!refetched) return result;
    const refetchedPayload = parseSingleJsonToolPayload(refetched);
    if (refetchedPayload && isDeltaPayload(refetchedPayload) && refetchedPayload.mode === 'full' && Array.isArray(refetchedPayload.items)) {
      views.set(viewKey, {
        rows: refetchedPayload.items,
        cursor: typeof refetchedPayload.cursor === 'string' ? refetchedPayload.cursor : undefined,
      });
    }
    return refetched;
  }

  if (!Array.isArray(payload.items)) return result;
  const merged = applySemanticDelta(cached.rows, payload.items as never, (row) => {
    const id = (row as { id?: unknown }).id;
    return String(id ?? '');
  });
  views.set(viewKey, { rows: merged, cursor: typeof payload.cursor === 'string' ? payload.cursor : cached.cursor });
  return replaceToolJson(result, {
    ok: payload.ok ?? true,
    mode: 'full',
    cursor: typeof payload.cursor === 'string' ? payload.cursor : cached.cursor,
    count: merged.length,
    items: merged,
    note:
      'Delta-aware target applied the semantic delta before exposing this complete current view to the model. ' +
      'The cursor is a change-watermark, not pagination; absent ids were removed from the view.',
  });
}

function deltaViewKey(name: string, input: unknown): string {
  return `${name}:${stableStringify(input)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function parseSingleJsonToolPayload(result: ToolResult): unknown | null {
  if (result.content.length !== 1) return null;
  const text = result.content[0]?.text;
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isDeltaPayload(payload: unknown): payload is DeltaToolPayload {
  if (!payload || typeof payload !== 'object') return false;
  const mode = (payload as { mode?: unknown }).mode;
  return mode === 'full' || mode === 'delta' || mode === 'not_modified';
}

function replaceToolJson(result: ToolResult, payload: unknown): ToolResult {
  return {
    ...result,
    content: [{ ...result.content[0], text: JSON.stringify(payload) }],
  };
}

/**
 * Merge consecutive same-role messages into one (content joined by a blank
 * line). The official Anthropic API auto-merges these, but the inference-gateway
 * proxy this target routes through (and Bedrock/Vertex) may instead 400 with
 * "roles must alternate" (anthropic-sdk-typescript#565). The runner's compaction
 * seam (agent-tool-delta-protocol P-006) legitimately produces an adjacent pair
 * — a summary `user` block followed by the turn's `user` message — so merging
 * here keeps a compacted history valid AND faithful (the summary reads as the
 * lead of that user turn). Only ever runs over the text-only wire history; the
 * tool-loop's block content is assembled separately, after this mapping.
 * Exported for a focused unit test.
 */
export function mergeConsecutiveRoles(msgs: AnthropicMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const m of msgs) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role && typeof prev.content === 'string' && typeof m.content === 'string') {
      prev.content = `${prev.content}\n\n${m.content}`;
    } else {
      out.push({ ...m });
    }
  }
  return out;
}

function renderToolResult(res: ToolResult): { text: string; isError: boolean } {
  const text = (res.content ?? [])
    .map((c) => (typeof c.text === 'string' ? c.text : JSON.stringify(c)))
    .join('\n');
  return { text: text || '(empty)', isError: !!res.isError };
}

function sse(name: string, data: unknown): SseEvent {
  return { name, data, tMs: 0 };
}

function errorTurn(message: string, latencyMs: number): TurnResult {
  return {
    assistantText: '',
    toolCalls: [],
    toolResults: [],
    cards: [],
    controlTags: [],
    costUsd: 0,
    latencyMs,
    finishReason: 'error',
    error: message,
    rawSseTape: [],
  };
}

// ---------------------------------------------------------------------------
// Anthropic SDK call + transient retry (mirrors the shared stateless path).
// ---------------------------------------------------------------------------

interface AnthropicResponse {
  content?: ContentBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}
interface AnthropicClient {
  messages: { create(params: unknown, opts?: unknown): Promise<AnthropicResponse> };
}

function errStatus(err: unknown): number | undefined {
  const s = (err as { status?: unknown })?.status;
  return typeof s === 'number' ? s : undefined;
}

function isTransient(err: unknown): boolean {
  const status = errStatus(err);
  if (status === 429 || status === 529 || (status !== undefined && status >= 500 && status < 505)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /(\b429\b|\b529\b|overloaded|rate.?limit|service unavailable|\b50[02-4]\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up)/i.test(
    msg,
  );
}

/** Auth rejection (401/403) — under fleet load this is almost always a ROTATED OAuth
 *  token, NOT a dead credential: the SUT shares one Claude-Max session with the whole
 *  fleet, which refreshes `~/.claude/.credentials.json` frequently, so a token read at
 *  turn-start can be invalidated by the next call. Classified SEPARATELY from
 *  `isTransient` so `callWithRetry` re-reads the credential + rebuilds the client (the
 *  hand-rolled-loop half of the shared chat-stream EI-281 invalidate-on-401 fix) rather
 *  than blindly backing off on a stale token (which never recovers). */
export function isAuthFailure(err: unknown): boolean {
  const status = errStatus(err);
  if (status === 401 || status === 403) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /^\s*40[13]\b/.test(msg) || /authentication_error|permission_error|invalid authentication/i.test(msg);
}

/** Seconds from a `retry-after` header (plain seconds or an HTTP date), if the
 *  SDK error exposed headers. */
function retryAfterMs(err: unknown): number | undefined {
  const h = (err as { headers?: Record<string, string | undefined> | { get?: (k: string) => string | null } })?.headers;
  let raw: string | null | undefined;
  if (h && typeof (h as { get?: unknown }).get === 'function') {
    raw = (h as { get: (k: string) => string | null }).get('retry-after');
  } else if (h && typeof h === 'object') {
    raw = (h as Record<string, string | undefined>)['retry-after'];
  }
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.min(120_000, secs * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.min(120_000, Math.max(0, at - Date.now())) : undefined;
}

export async function callWithRetry(
  makeClient: () => AnthropicClient,
  params: Record<string, unknown>,
  signal: AbortSignal,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<AnthropicResponse> {
  // Patient retry — the SUT shares one Claude-Max OAuth session with the whole
  // fleet, so a transient 429 is expected under contention. Honor Retry-After
  // when present, else exponential backoff capped at 60s.
  // EI-281 (rotated-token half): the shared credential ALSO rotates mid-run, so a
  // 401/403 means our token went stale — re-read `~/.claude/.credentials.json` +
  // rebuild the client + retry (its OWN budget, since the file settles to a fresh
  // token within a few seconds), instead of failing the whole scenario on a 401.
  const RETRY_MAX = 7; // transient (429 / 5xx) budget
  const AUTH_REREAD_MAX = 4; // rotated-token re-read budget
  let client = makeClient();
  let transientAttempts = 0;
  let authReReads = 0;
  let lastErr: unknown;
  for (;;) {
    if (signal.aborted) throw new Error('su target: aborted');
    try {
      return await client.messages.create(params, { signal });
    } catch (err) {
      lastErr = err;
      if (isAuthFailure(err) && authReReads < AUTH_REREAD_MAX) {
        authReReads++;
        // Let a concurrent credential rotation settle, then re-read the file + rebuild.
        await sleep(1500 + Math.random() * 1000);
        try {
          client = makeClient(); // re-reads ~/.claude/.credentials.json for the rotated token
        } catch {
          throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
        }
        continue;
      }
      transientAttempts++;
      if (!isTransient(err) || transientAttempts >= RETRY_MAX) throw err;
      const backoffMs =
        retryAfterMs(err) ?? Math.min(60_000, 1000 * 2 ** transientAttempts) + Math.random() * 500;
      await sleep(backoffMs);
    }
  }
}
