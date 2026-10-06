/**
 * Role system-prompt assembly.
 *
 * Builds the system prompt for an LLM call from four sources, in order:
 *
 *   1. `<role>.persona.md`        — character + behavior rules (the prompt
 *                                   chain, then the prompts dir — see below)
 *   2. Tools catalog              — per-tool guidance from the projection
 *                                   registry (single source of truth for
 *                                   "when/notWhen/chaining"). Rendered only
 *                                   for the tools the caller passes.
 *   3. `<role>.tools.md`          — cross-tool patterns + named workflows
 *                                   (optional — falls back to no playbook
 *                                   section when absent)
 *   4. Runtime context            — caller-supplied blocks (history,
 *                                   trigger, [may_ask_active] marker, etc.)
 *
 * Why three layers (persona + catalog + tools.md):
 *   - Per-tool guidance lives at the tool (`defineTool({ guidance })`) so
 *     one tool's "when to call me" is authored once across all roles.
 *   - Cross-tool patterns and workflows can't live at any single tool —
 *     they go in `<role>.tools.md`.
 *   - Behavior rules ("always call", "tier-high requires confirm") are
 *     about the AGENT's behavior pattern, not a tool's — they live in
 *     `<role>.persona.md`.
 *
 * WHERE A ROLE DOCUMENT COMES FROM (identities-v1-2026-08-30 P-023): the
 * persona / converse / tools documents of a chat-surface role resolve through
 * the SAME prompt chain the spawn tier resolves `blueprints/<id>/prompts/<role>.md`
 * with (`resolvePromptFile`): the blueprint extends-chain leaf-first with `base`
 * last, and within one id the tiers local → installed → built-in harness. The
 * chain form of a document is `blueprints/<id>/prompts/<role>.<kind>.md` — the
 * same dotted-suffix naming as the generic-prefix `<role>.base.md`. The prompts
 * dir (`apps/operator/prompts/<role>.<kind>.md`, `promptsDir()`) is retained as
 * the LOWEST-precedence file tier, so with no chain copy installed a role renders
 * byte-identical to the pre-P-023 direct file read, and an installed or hive-local
 * override of a chat persona wins over the built-in file without a code change.
 * The audience identities (`loadRoleModePersona`, P-021) resolve through the same
 * chain and have no file tier (an identity has ONE home).
 *
 * Caching:
 *   - Resolved role documents memoized per (role, kind, resolve context).
 *   - Catalog rendering memoized per-role, invalidated when any tool is
 *     registered (catalog version bump in the projection registry).
 *   - `PAPERCUSP_RELOAD_PROMPTS=1` env var (default on in NODE_ENV=development)
 *     disables ALL caches so editing a .md file shows up next request
 *     without restarting the dev server.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessRoot } from '@papercusp/harness/paths';
import {
  promptCandidates,
  resolvePromptFile,
  resolvePromptFiles,
  type PromptResolveContext,
} from '@papercusp/orchestrator/role-prompt';
import {
  listAllProjectedTools,
  projectedToolCorrectiveCalls,
  projectedToolAdmitted,
  projectedToolRegistryRevision,
  PROJECTED_TOOL_REGISTRY_SOURCE,
  type ProjectedTool,
} from '@papercusp/agent-mcp';
import {
  isPositionalReadEncoding,
  listPrePromptEntries,
  projectReadColumns,
  projectWriteColumns,
  renderWireSchemas,
} from '@papercusp/result-encoding';
import { renderCoordLegend } from './coord-schema';
import { renderFrictionTripwire } from './harness/improvements/friction-markers';
import { renderYieldPolicy } from './turn-yield-policy';
import { renderTestingStandard } from './testing-standard-policy';
import { renderAccountRoutingNote } from './account-routing-policy';
import { renderConcurrencyFirstNote } from './concurrency-first-policy';
import { renderEvidenceDisciplineNote } from './evidence-discipline-policy';
import { renderDeployPipelineNote } from './deploy-pipeline-policy';
import { renderCodeRunNudge } from './code-run-policy';
import { renderReuseFirstNudge } from './reuse-first-policy';
import { renderWorkRecordNote } from './work-record-policy';
import { renderPlanDisciplineNote } from './plan-discipline-policy';
import { renderObservationCaptureNote } from './observation-capture-policy';
import { renderWriteThroughNote } from './memory-flush-policy';
import { renderTurnEndObservation } from './turn-end-observation-policy';
import { renderFinishTheRolloutNote } from './finish-the-rollout-policy';
import { renderAgentActivityTruthNote } from './agent-activity-truth-policy';
import { renderWaitLoopNote } from './wait-loop-policy';
import { renderPeerWakeNote } from './peer-wake-policy';
import { renderCouplingNote } from './coupling-policy';
import { renderStatePlaneNote } from './state-plane-policy';
import { renderObservationRubricNudge } from './observation-rubric-policy';
import { renderModesPolicy } from './operating-modes-policy';
import { audienceIdentityDocument, resolveSuIdentityDocument } from '@papercusp/orchestrator/blueprint';
import { renderResultDoorSection } from './result-door-prompt';
import { renderWorkspaceMapSection } from './desktop-install/workspace-map';
import { renderPromotionModelSection } from './desktop-install/promotion-model';
import { describeServingGeneration, type ServingGeneration } from './serving-generation';
import {
  AUTO_MODE_MARKER,
  CLIENT_TOOLING_OVERLAY_MARKER,
  COMPACTION_MARKER,
  COORD_LEGEND_MARKER,
  PROJECT_GUIDE_MARKER,
  PROMOTION_MODEL_MARKER,
  RESULT_DOOR_MARKER,
  WIRE_SCHEMAS_MARKER,
  WORKSPACE_MAP_MARKER,
  spliceGeneratedSection,
} from './desktop-install/splice-tooling-overlay';

// Resolve at first call, not at module load. process.cwd() at module
// scope is visible to Turbopack's NFT tracer, which pulls the entire
// CWD into the route asset trace and trips
// "Encountered unexpected file in NFT list" → "Invalid segment
// configuration export detected" → build fails (caught 2026-05-11).
// Lazy resolution side-steps the tracer entirely.
//
// Path handling: process.cwd() is monorepo-root when the dev server is
// launched via `bin/overmind-all start` from the workspace root, but
// `apps/operator/` when next-server is launched directly from there
// (the common dev-server case). Try the longer path first; fall back
// to cwd-relative if the prompts dir is right next to cwd.
export function promptsDir(): string {
  // Explicit override — the packaged desktop (SP1 C5: serve.mjs with
  // cwd=sidecar/) sets PAPERCUSP_PROMPTS_DIR=<sidecar>/prompts, mirroring
  // PAPERCUSP_SPA_DIST / PAPERCUSP_DOCS_ROOT. Without it the cwd heuristics
  // below misfire there: sidecar/apps/operator/prompts EXISTS (it carries
  // only the desktop-install playbook) and would win over sidecar/prompts,
  // so persona loads would throw at boot.
  const fromEnv = process.env.PAPERCUSP_PROMPTS_DIR;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  // Integration-tree prompt root (decouple-agent-prompts-from-release-gate
  // P-002 / D-001): prefer the integration/staging checkout's operator prompts
  // so a chat-surface prompt edit (operator/oracle/sentinel persona/tools) goes
  // live WITHOUT a code-release promotion. PAPERCUSP_PROMPTS_DIR (above) is the
  // explicit direct override; this derives apps/operator/prompts from the
  // repo-root PAPERCUSP_INTEGRATION_ROOT. CODE stays on the running checkout.
  const integRoot = process.env.PAPERCUSP_INTEGRATION_ROOT?.trim();
  if (integRoot) {
    const fromInteg = join(integRoot, 'apps/operator/prompts');
    if (existsSync(fromInteg)) return fromInteg;
  }
  const fromRoot = join(process.cwd(), 'apps/operator/prompts');
  if (existsSync(fromRoot)) return fromRoot;
  const fromOperator = join(process.cwd(), 'prompts');
  if (existsSync(fromOperator)) return fromOperator;
  // cwd-independent fallback: anchor to THIS module's own location and walk
  // up to the repo root that owns apps/operator/prompts. The operator-core
  // carve (operator-core-headless-serve-2026-06-04) moved the route code into
  // packages/operator-core/lib/ while the prompts stayed at apps/operator/
  // prompts, so the cwd-relative forms above MISS when operator-core's own
  // package tests run (cwd=packages/operator-core) — every role's persona
  // load then throws. Anchoring to import.meta.url fixes that regardless of
  // cwd. (Lazy, inside the fn — keeps it out of module scope so the Turbopack
  // NFT tracer never sees it; see the note above.)
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    const candidate = join(dir, 'apps/operator/prompts');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Default to the monorepo-root cwd form so loaders that throw point at
  // the canonical path (less confusing in the error message).
  return fromRoot;
}

/** The roles with prompt sources under apps/operator/prompts/ — the subset
 *  of AGENT_ROLES this assembler can build prompts for. Pinned to the
 *  canonical set via `satisfies` (audit P-072): renaming/removing a role in
 *  agent-mcp's role-config breaks compilation HERE instead of silently
 *  orphaning its prompt files. Type-only dependency — no runtime import
 *  reaches the prompt layer. */
export const PROMPT_ROLES = [
  'operator',
  'oracle',
  'worker',
  'validator',
  'scoper',
  'reviewer',
  'debugger',
  'architect',
  'documenter',
  'curator',
  // G2 user-protection gate (P-006): read-only adversarial judgment role.
  'auditor',
  // Papercup-as-Herald: the papercup watcher is re-homed onto the always-on,
  // voice-first Herald — the SAME converse brain loaded with role='papercup'.
  // Its persona set (papercup.persona[.{engineer,novice}-mode].md / .converse.md /
  // .shell.md / .tools.md) ships under apps/operator/prompts/, so the assembler
  // must be able to build prompts for it (loadRole{Persona,Converse,ModePersona}).
  'papercup',
  // The hidden deep-brain half of the one "Papercup" identity
  // (voice-public-release-readiness-2026-07-12 P-014): the persistent
  // parked-until-woken heavy reasoner the fast front-end delegates real
  // investigation to over coord/wake. persona.md only — it never converses
  // with the user (no .converse.md / .shell.md; loadRoleConverse throwing for
  // it is correct: a converse surface pointing at papercup-deep is a bug).
  'papercup-deep',
] as const satisfies readonly import('@papercusp/agent-mcp').BuiltinAgentRole[];

export type Role = (typeof PROMPT_ROLES)[number];

export interface AssembledSection {
  name:
    | 'persona'
    | 'tools-catalog'
    | 'tools-playbook'
    | 'coord-legend'
    | 'friction-tripwire'
    | 'observation-rubric-nudge'
    | 'yield-policy'
    | 'testing-standard'
    | 'account-routing-note'
    | 'evidence-discipline-note'
    | 'concurrency-first-note'
    | 'deploy-pipeline-note'
    | 'reuse-first-nudge'
    | 'plan-discipline-note'
    | 'work-record-note'
    | 'observation-capture-note'
    | 'write-through-note'
    | 'turn-end-observation'
    | 'code-run-note'
    | 'finish-the-rollout-note'
    | 'agent-activity-truth-note'
    | 'wait-loop-note'
    | 'peer-wake-note'
    | 'coupling-note'
    | 'state-plane-note'
    | 'project-guide'
    | 'runtime';
  chars: number;
}

export interface AssembledPrompt {
  /** The assembled prompt, ready to send to the model. */
  text: string;
  /** For audit/debug — which sections contributed and their sizes. */
  sections: AssembledSection[];
  /** Profile metadata (present for the owned-loop target profile). */
  profile?: PromptProfile;
  baseSource?: string;
  projectGuideSource?: string;
  projectGuideTruncated?: boolean;
  omittedClientRemediation?: string[];
}

export type PromptProfile = 'default' | 'pui-loop';

/**
 * Profile-local ceiling for the injected project guide.
 *
 * A SAFETY BOUND against runaway growth, not a target: the guide is the repo `CLAUDE.md`,
 * projected from `harness_shared.harness_doc_parts`, and the pui-loop profile is meant to
 * deliver it WHOLE (`prompt-profile.test.ts` pins `projectGuideTruncated === false` on the
 * real file — a truncated guide silently drops rules for the owned loop). The previous
 * 96_000 was crossed by ordinary doc-part growth (measured 117,866 chars on 2026-09-05),
 * which red-pinned the fleet gate on a budget nobody had adjudicated. Sized with ~35%
 * headroom over that measurement; raise it again deliberately when the guide grows, or
 * trim doc parts — never let the truncation path become the steady state.
 */
export const PUI_LOOP_PROJECT_GUIDE_MAX_CHARS = 160_000;

export interface AssembleOptions {
  role: Role;
  /**
   * MCP tool names this role is allowed to call for the surface invoking
   * the assembly. For chat surfaces (operator, oracle) this is the
   * `allowedTools` array (stripped of the `mcp__agentmcp__` prefix). For
   * spawn-URL roles (worker etc.), the dispatcher determines allowance
   * — pass the full role-filtered catalog or omit to skip the catalog
   * section.
   */
  toolNames: string[];
  /** Optional caller-supplied blocks rendered after the tools playbook. */
  runtime?: Array<{ heading: string; body: string }>;
  /**
   * How the role's persona / tools documents resolve through the prompt chain
   * (P-023): the blueprint whose extends-chain is walked and the tiers searched
   * before the built-in harness. Omitted ⇒ the `base` chain over the built-in
   * tier, then the prompts dir — the workspace-level chat-surface default.
   */
  resolve?: ChatRoleResolveContext;
  /**
   * Alternate target profile. `pui-loop` uses the canonical su source and
   * generated sections while omitting client-only remediation before assembly.
   */
  profile?: PromptProfile;
  /** Repository root used to resolve the pui-loop project guide. */
  projectDir?: string;
  /** Explicit canonical su source for the pui-loop profile (tests/packaging). */
  baseSource?: string;
  /** Explicit guide source for the pui-loop profile. */
  projectGuideSource?: string;
  /** Already budgeted project-guide body for the pui-loop profile. */
  projectGuideText?: string;
  /** Maximum characters retained from the pui-loop project guide. */
  projectGuideMaxChars?: number;
  /** Optional pui-loop guide budget metadata (kept for callers' diagnostics). */
  projectGuideTruncated?: boolean;
  /** Hermetic override for the pui-loop tools catalog. */
  toolCatalogText?: string;
  /** Generation sampled by the async prompt boundary that is delivering this catalog. */
  servingGeneration?: ServingGeneration;
}

/* ─── Role documents through the prompt chain (cached unless PAPERCUSP_RELOAD_PROMPTS=1) ── */

function shouldBypassCache(): boolean {
  if (process.env.PAPERCUSP_RELOAD_PROMPTS === '1') return true;
  if (process.env.PAPERCUSP_RELOAD_PROMPTS === '0') return false;
  return process.env.NODE_ENV === 'development';
}

/** The document kinds a chat-surface role composes from: `<role>.<kind>.md`. */
export const CHAT_ROLE_DOCUMENT_KINDS = ['persona', 'converse', 'tools'] as const;
export type ChatRoleDocumentKind = (typeof CHAT_ROLE_DOCUMENT_KINDS)[number];

/**
 * How a chat-surface role's documents are resolved — the SAME shape the spawn tier
 * resolves `blueprints/<id>/prompts/<role>.md` with (`PromptResolveContext`), minus
 * the retired phase/dept axis: an optional blueprint (`blueprintId`, or a pre-resolved
 * `extendsChain`) whose chain is walked leaf-first with `base` last, and the tiers
 * (`blueprintRoots`: local → installed) searched before the built-in `harnessDir`.
 * Omitted ⇒ `{ harnessDir: harnessRoot() }`: the `base` chain over the built-in tier —
 * what every workspace-level chat surface (operator / oracle / papercup) resolves with.
 */
export type ChatRoleResolveContext = Partial<
  Pick<PromptResolveContext, 'harnessDir' | 'blueprintRoots' | 'blueprintId' | 'extendsChain'>
>;

export interface ChatRoleDocumentHit {
  /**
   * `chain` — a `blueprints/<id>/prompts/<role>.<kind>.md` found through the
   * extends-chain × tiers; `file` — the prompts-dir tier (`promptsDir()`), the
   * lowest-precedence fallback P-023 retains.
   */
  tier: 'chain' | 'file';
  /** Absolute path of the resolved document. */
  path: string;
  text: string;
}

function chatRoleResolveContext(ctx?: ChatRoleResolveContext): PromptResolveContext {
  return {
    harnessDir: ctx?.harnessDir ?? harnessRoot(),
    phase: '',
    dept: '',
    ...(ctx?.blueprintRoots ? { blueprintRoots: ctx.blueprintRoots } : {}),
    ...(ctx?.blueprintId ? { blueprintId: ctx.blueprintId } : {}),
    ...(ctx?.extendsChain ? { extendsChain: ctx.extendsChain } : {}),
  };
}

/** The prompts-dir (file tier) path of a chat-surface role document. */
export function chatRoleDocumentFilePath(role: Role, kind: ChatRoleDocumentKind): string {
  return join(promptsDir(), `${role}.${kind}.md`);
}

/**
 * Every path a chat-surface role document is looked up at, most specific first: the
 * chain candidates (`promptCandidates` — PURE: it walks `extendsChain`/`blueprintId`
 * as given and does not read blueprint.yaml, exactly like the spawn tier's listing),
 * then the file tier last. For diagnostics and tests; the resolver below is what
 * reads.
 */
export function chatRoleDocumentCandidates(
  role: Role,
  kind: ChatRoleDocumentKind,
  ctx?: ChatRoleResolveContext,
): string[] {
  return [
    ...promptCandidates(chatRoleResolveContext(ctx), `${role}.${kind}`),
    chatRoleDocumentFilePath(role, kind),
  ];
}

/**
 * Resolve ONE chat-surface role document through the prompt chain — the first
 * `blueprints/<id>/prompts/<role>.<kind>.md` the spawn tier's `resolvePromptFile`
 * finds (leaf-first across the extends-chain; within one id local → installed →
 * built-in) — falling back to the prompts-dir file. Null when neither tier holds it;
 * the caller decides whether that refuses (persona / converse) or is optional (tools).
 * Uncached; `loadChatRoleDocument` is the memoized entry.
 */
export function resolveChatRoleDocument(
  role: Role,
  kind: ChatRoleDocumentKind,
  ctx?: ChatRoleResolveContext,
): ChatRoleDocumentHit | null {
  const chain = resolvePromptFile(chatRoleResolveContext(ctx), `${role}.${kind}`);
  if (chain) return { tier: 'chain', path: chain, text: readFileSync(chain, 'utf8') };
  const file = chatRoleDocumentFilePath(role, kind);
  if (existsSync(file)) return { tier: 'file', path: file, text: readFileSync(file, 'utf8') };
  return null;
}

const roleDocumentCache = new Map<string, ChatRoleDocumentHit | null>();

function roleDocumentCacheKey(role: Role, kind: ChatRoleDocumentKind, ctx?: ChatRoleResolveContext): string {
  // The prompts dir is part of the key too: PAPERCUSP_PROMPTS_DIR / the integration
  // root can change between calls in the same process (tests do exactly that).
  return JSON.stringify([
    role,
    kind,
    ctx?.harnessDir ?? null,
    ctx?.blueprintRoots ?? null,
    ctx?.blueprintId ?? null,
    ctx?.extendsChain ?? null,
    promptsDir(),
  ]);
}

/** Memoized `resolveChatRoleDocument` (bypassed under PAPERCUSP_RELOAD_PROMPTS=1 / development). */
export function loadChatRoleDocument(
  role: Role,
  kind: ChatRoleDocumentKind,
  ctx?: ChatRoleResolveContext,
): ChatRoleDocumentHit | null {
  const key = roleDocumentCacheKey(role, kind, ctx);
  if (!shouldBypassCache() && roleDocumentCache.has(key)) {
    return roleDocumentCache.get(key)!;
  }
  const hit = resolveChatRoleDocument(role, kind, ctx);
  roleDocumentCache.set(key, hit);
  return hit;
}

function describeMiss(role: Role, kind: ChatRoleDocumentKind, ctx?: ChatRoleResolveContext): string {
  const file = chatRoleDocumentFilePath(role, kind);
  const chain = promptCandidates(chatRoleResolveContext(ctx), `${role}.${kind}`);
  return `${role}.${kind}.md not found at ${file} (nor at any of the prompt-chain candidates: ${chain.join(', ')})`;
}

export function loadRolePersona(role: Role, ctx?: ChatRoleResolveContext): string {
  const hit = loadChatRoleDocument(role, 'persona', ctx);
  if (!hit) {
    throw new Error(
      `prompt-assembly: ${describeMiss(role, 'persona', ctx)}. ` +
      `Every role must have a persona.md.`,
    );
  }
  return hit.text;
}

export function loadRoleToolsMd(role: Role, ctx?: ChatRoleResolveContext): string | null {
  return loadChatRoleDocument(role, 'tools', ctx)?.text ?? null;
}

/**
 * Load `<role>.converse.md` — the active-mode behavioral rules (silence
 * ladder, say/set_mode/sleep/spawn tag protocol). Required for chat-mode
 * roles that drive a conversation loop on the server (today: operator).
 *
 * Throws if the file is missing; chat-mode routes that call this should
 * already require it. If a role exists that doesn't use the converse
 * pattern, that role's route just doesn't call this.
 */
const modePersonaCache = new Map<string, string | null>();

/**
 * Load the AUDIENCE identity for a chat role + audience mode — the character overlay
 * that frames who the user is (engineer / novice) before the shared persona rules apply.
 * Injected as the first system section.
 *
 * identities-v1 P-021 (D-008 "unify the second axis"): the former
 * `apps/operator/prompts/<role>.persona.<mode>-mode.md` files are identities on the
 * exclusive `audience` slot — `blueprints/<role>.audience-<mode>/prompts/audience.md`
 * (`AUDIENCE_IDENTITY_DOCUMENTS`) — resolved THROUGH THE PROMPT CHAIN (`identityRoots`:
 * most specific tier first, the built-in harness last), so an installed override of an
 * audience wins over the built-in copy. An identity has ONE home: the prompts-dir path is
 * no longer consulted.
 *
 * Returns null for an unknown role/mode pair or an identity installed in no tier (opt-in
 * per role). Throws when a document exists but is unreadable.
 */
export function loadRoleModePersona(role: Role, mode: string, identityRoots?: readonly string[]): string | null {
  const key = `${role}:${mode}:${(identityRoots ?? []).join('|')}`;
  if (!shouldBypassCache() && modePersonaCache.has(key)) {
    return modePersonaCache.get(key)!;
  }
  const doc = audienceIdentityDocument(role, mode);
  const roots = identityRoots && identityRoots.length ? identityRoots : [harnessRoot()];
  const hit = doc ? resolveSuIdentityDocument(doc, roots) : null;
  const text = hit?.text ?? null;
  modePersonaCache.set(key, text);
  return text;
}

export function loadRoleConverse(role: Role, ctx?: ChatRoleResolveContext): string {
  const hit = loadChatRoleDocument(role, 'converse', ctx);
  if (!hit) {
    throw new Error(
      `prompt-assembly: ${describeMiss(role, 'converse', ctx)}. ` +
      `Required for chat-mode roles.`,
    );
  }
  return hit.text;
}

/**
 * Load the canonical compaction priorities — the preserve/drop body of
 * apps/operator/prompts/papercusp-compaction.base.md (agent-managed-compaction).
 * The operator converse-brain summarizer folds this into buildCompactionPrompt so
 * a prompt edit goes live without a code release (like the other prompt loaders).
 * Missing file ⇒ null (caller falls back to the built-in default). The leading
 * HTML comment and the trailing CLIENT-OVERLAY marker are stripped.
 */
let compactionPrioritiesCache: string | null | undefined;
export function loadCompactionPriorities(): string | null {
  if (!shouldBypassCache() && compactionPrioritiesCache !== undefined) {
    return compactionPrioritiesCache;
  }
  const path = join(promptsDir(), 'papercusp-compaction.base.md');
  let text: string | null = null;
  if (existsSync(path)) {
    text =
      readFileSync(path, 'utf8')
        .replace(/^<!--[\s\S]*?-->\s*/, '') // strip leading HTML comment
        .replace(/<!--\s*PAPERCUSP-COMPACTION:CLIENT-OVERLAY\s*-->\s*$/, '') // trailing marker
        .trim() || null;
  }
  compactionPrioritiesCache = text;
  return text;
}

/* ─── Catalog rendering ───────────────────────────────────────────────── */

/**
 * Render the per-tool catalog for the role. For each tool name in
 * `toolNames`:
 *   - look up the projected tool definition (which carries guidance)
 *   - merge byRole[role] over the base
 *   - emit a "- <name>\n  <description>\n  When: ...\n  Not when: ...\n  Chaining: ..."
 *     block; the guidance lines are omitted when empty so unmigrated
 *     tools render with description-only (backwards-identical to
 *     pre-guidance behavior).
 *
 * Sorted alphabetically by tool name so the prompt is stable across
 * runs (helpful for prompt-diffing in audits).
 *
 * `modality` (Phase 4 T3.1) filters the catalog by surface: when set
 * to 'voice', tools whose declared `modality` excludes 'voice' are
 * dropped. Tools without a declared modality default to text-only and
 * are filtered out of voice catalogs.
 */
export function renderToolsCatalog(
  role: Role,
  toolNames: string[],
  modality: 'text' | 'voice' = 'text',
  /**
   * Optional rewrite of the DISPLAYED tool name (lookup is unchanged — always
   * by the colon MCP-catalog name). The operator passes `:`→`_` so the catalog
   * advertises the same underscore names Claude Code actually presents to the
   * model (it sanitizes the colon out of `harness:status` → `harness_status`),
   * instead of colon names the model can't match (voice-persona P-005). Default
   * identity — every other role's catalog is byte-identical.
  */
  displayTransform?: (mcpName: string) => string,
  servingGeneration?: ServingGeneration,
): string {
  if (toolNames.length === 0) return '';

  const byMcpName = new Map<string, ProjectedTool>();
  for (const t of listAllProjectedTools()) {
    if (t.expose.mcp) byMcpName.set(t.expose.mcp.name, t);
  }

  const lines: string[] = [
    '## Available tools',
    '',
    `Executable contract: ${PROJECTED_TOOL_REGISTRY_SOURCE} · ${projectedToolRegistryRevision()}`,
    `Serving generation: ${servingGeneration ? describeServingGeneration(servingGeneration) : 'unknown (not sampled)'}`,
    '',
  ];
  const sorted = [...new Set(toolNames)].sort();

  // Bounded back-pointer (tool-call-batching-wrappers D-005c / P-010): build the inverse
  // index primitive→composite over the RENDERED, modality-passing set (only point at a
  // bundle the agent can actually reach). A primitive a composite `replaces` then gets a
  // single "Bundled by" line — fired at the point the agent reads the primitive — capped
  // (BACKPOINTER_CAP) to keep the catalog from bloating (D-006). The composite self-
  // advertises the other direction via its `chaining` ("Bundles: …").
  const bundledBy = new Map<string, string[]>();
  for (const name of sorted) {
    const t = byMcpName.get(name);
    if (!t || !t.replaces || t.replaces.length === 0) continue;
    if (!(t.modality ?? ['text', 'voice']).includes(modality)) continue;
    for (const prim of t.replaces) {
      const arr = bundledBy.get(prim) ?? [];
      arr.push(name);
      bundledBy.set(prim, arr);
    }
  }
  const BACKPOINTER_CAP = 2;

  let rendered = 0;
  for (const name of sorted) {
    const tool = byMcpName.get(name);
    if (!tool) {
      throw new Error(`prompt-assembly: requested tool is absent from the projected registry: ${name}`);
    }
    // Modality filter: a tool's `modality: readonly ('text'|'voice')[]`
    // declares which surfaces it makes sense from. Default
    // `['text', 'voice']` when absent — most tools are usable in
    // either surface, and the previous text-only default silently
    // emptied the voice catalog for any tool that didn't opt in
    // (round-13 E2E bug #36).
    const toolModality = tool.modality ?? ['text', 'voice'];
    if (!toolModality.includes(modality)) continue;
    rendered += 1;
    lines.push(`- \`${displayTransform ? displayTransform(name) : name}\``);
    lines.push(`  ${tool.description}`);
    const g = mergeRoleGuidance(tool.guidance, role);
    if (g?.when) lines.push(`  When: ${g.when}`);
    if (g?.notWhen) lines.push(`  Not when: ${g.notWhen}`);
    if (g?.chaining) lines.push(`  Chaining: ${g.chaining}`);
    // Corrective calls are resolved through the registry, which fails LOUDLY on a
    // redirect to a tool that does not exist — deliberately, and we keep that. But
    // this catalog is built from a ROLE-INDEPENDENT tool list, so it also renders
    // tools the current role cannot call, and `projectedToolCorrectiveCalls` throws
    // for that case too. The two are not the same: a missing tool is a registry
    // defect, a non-admitted one is ordinary role scoping. Without this guard, adding
    // `argRedirects` to any tool whose `agentRoles` exclude a rendering role crashes
    // that role's ENTIRE prompt build — measured: `agent_tools:list` (SU_ROLES) gained
    // redirects and took the whole `papercup`/Sentinel prompt down with it.
    // A rejected-arg remedy for a tool this role cannot reach is unreachable advice
    // anyway, so omitting it is also the right rendering.
    const correctiveCalls =
      projectedToolAdmitted(name, { role, modality }) &&
      Object.values(tool.guidance?.argRedirects ?? {}).some(
        (redirect) => typeof redirect === 'object' && redirect !== null,
      )
        ? projectedToolCorrectiveCalls(name, { role, modality })
        : [];
    for (const correction of correctiveCalls) {
      const correctiveName = displayTransform ? displayTransform(correction.tool) : correction.tool;
      lines.push(
        `  Correction for rejected \`${correction.rejectedArg}\`: ` +
          `\`${correctiveName} ${JSON.stringify(correction.args)}\`` +
          `${correction.note ? ` — ${correction.note}` : ''}`,
      );
    }
    const bundles = bundledBy.get(name);
    if (bundles && bundles.length > 0) {
      const shown = bundles
        .slice(0, BACKPOINTER_CAP)
        .map((n) => `\`${displayTransform ? displayTransform(n) : n}\``);
      const extra = bundles.length > BACKPOINTER_CAP ? ` (+${bundles.length - BACKPOINTER_CAP} more)` : '';
      lines.push(`  Bundled by: ${shown.join(', ')}${extra} — prefer the bundle to batch this call in one round-trip.`);
    }
    lines.push('');
  }
  if (rendered === 0) return '';
  return lines.join('\n').trimEnd();
}

/**
 * Render the "## Wire schemas" prompt legend (token-efficient-agent-io P-003):
 * the prompt-declared column schemas for every pre-prompt registry tool, derived
 * from each tool's OWN registered schema (output `data` for read, `args` for
 * write). Because the SAME `projectReadColumns`/`projectWriteColumns` drive the
 * read serializer and the write shim, the legend can't desync from the wire (the
 * anti-desync test asserts it). Returns '' when no registry tool has derivable
 * columns, so the marker collapses to nothing.
 *
 * `entryFilter` (context-trimming-tiers P-017): restrict the legend to a
 * subset of tools by name — the FLEET persona tier keeps the coordination/
 * work-item/plan/lock spine and drops every other entry. Omitted = all
 * entries (byte-identical to today).
 */
export function renderWireSchemasSection(entryFilter?: (name: string) => boolean): string {
  const byMcpName = new Map<string, ProjectedTool>();
  for (const t of listAllProjectedTools()) {
    if (t.expose.mcp) byMcpName.set(t.expose.mcp.name, t);
  }
  const entries = entryFilter
    ? listPrePromptEntries().filter((e) => entryFilter(e.name))
    : listPrePromptEntries();
  return renderWireSchemas(entries, (entry) => {
    const tool = byMcpName.get(entry.name);
    if (!tool) return {};
    // Declare read columns ONLY for the positional encodings (csv/tsv), whose
    // payload omits its own field names and so genuinely needs this legend. A
    // self-describing 'toon' read carries `fields[N]:` inline, so declaring its
    // columns here is dead prompt weight AND misleading — it instructs a
    // position→column mapping the wire no longer uses (EI-136). Same predicate
    // the read encoder gates on, so the two ends can't drift.
    const read =
      isPositionalReadEncoding(entry.read) && tool.outputJsonSchema
        ? projectReadColumns(tool.outputJsonSchema)
        : undefined;
    const write =
      entry.write === 'positional'
        ? projectWriteColumns(tool.inputSchema as Record<string, unknown>, {
            freeTextName: entry.freeTextArg,
            columnOverrides: entry.columnOverrides,
            columnNames: entry.writeColumnNames,
            requiredColumnNames: entry.writeRequiredColumnNames,
          })
        : undefined;
    return { read, write };
  });
}

function mergeRoleGuidance(
  raw:
    | {
        when?: string;
        notWhen?: string;
        chaining?: string;
        byRole?: Record<string, { when?: string; notWhen?: string; chaining?: string }>;
      }
    | undefined,
  role: Role,
): { when?: string; notWhen?: string; chaining?: string } | null {
  if (!raw) return null;
  const base = { when: raw.when, notWhen: raw.notWhen, chaining: raw.chaining };
  const override = raw.byRole?.[role];
  const merged = override ? { ...base, ...override } : base;
  if (!merged.when && !merged.notWhen && !merged.chaining) return null;
  return merged;
}

/* ─── pui-loop target profile ───────────────────────────────────────── */

function canonicalPuiLoopSuSource(): string {
  const source = resolvePromptFiles(
    { harnessDir: harnessRoot(), phase: '', dept: '' },
    'su',
  ).at(-1);
  if (!source) {
    throw new Error(
      `prompt-assembly: pui-loop canonical su prompt was not found under ${harnessRoot()}`,
    );
  }
  return source;
}

function removeMarkdownHeadingSection(
  text: string,
  heading: string,
): { text: string; removed: boolean } {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `(?:^|\\n)## ${escaped}\\n[\\s\\S]*?(?=\\n## |\\n# |$)`,
  );
  if (!re.test(text)) return { text, removed: false };
  return { text: text.replace(re, '\n'), removed: true };
}

function renderPuiLoopProjectGuide(guideText: string): string {
  const body = guideText.replace(/\n+$/, '').trim();
  if (!body) return '';
  return (
    '## Project guide — repo conventions\n\n' +
    "> The following is the working repo's project guide (`CLAUDE.md` at the\n" +
    '> repo root — the single editable source; `AGENTS.md` is a symlink to it).\n' +
    '> It is projected into this owned-loop profile from the canonical source;\n' +
    '> client-only remediation is deliberately excluded before assembly.\n\n' +
    body +
    '\n'
  );
}

export function projectGuideAtBudget(
  text: string,
  source: string,
  maxChars = PUI_LOOP_PROJECT_GUIDE_MAX_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const hardCut = Math.max(0, maxChars - 320);
  const newline = text.lastIndexOf('\n', hardCut);
  const cut = newline > hardCut * 0.8 ? newline : hardCut;
  return {
    text:
      `${text.slice(0, cut).replace(/\n+$/, '')}\n\n` +
      `> ⚠ Project guide truncated by the pui-loop prompt budget at ${maxChars} of ` +
      `${text.length} characters. Read the canonical source with \`capability:read\` ` +
      `when the omitted tail matters: ${source || '<project guide>'}\n`,
    truncated: true,
  };
}

/**
 * Project the canonical su SOURCE into the owned-loop profile before prompt
 * assembly. This is deliberately source-level: client-only layers are never
 * assembled and therefore cannot silently return when surrounding prose moves.
 */
function projectPuiLoopSuSource(base: string, toolNames: string[]): string {
  let out = base;

  // No client overlay exists inside the owned loop. The exact executable
  // surface is rendered from the projected registry below.
  out = out.split(CLIENT_TOOLING_OVERLAY_MARKER).join('');

  // The loop owns compaction and tool discovery in code, so those client
  // protocols are absent from this target by profile construction.
  out = out.split(COMPACTION_MARKER).join('');

  // Keep route A, but omit the client-native denial/explanation. Fleets remain
  // the explicit parallelism routes; there is simply no hidden client surface
  // for this in-process loop to remediate.
  out = out.replace(
    /  - \*\*A\. Yourself\*\* — you implement it directly, now, in this session\.[\s\S]*?(?=\n  - \*\*B\. Send)/,
    '  - **A. Yourself** — you implement it directly, now, in this session.',
  );

  // This bullet exists only to defend deferred CLI tool surfaces. The owned
  // loop receives the exact catalog it can execute, so the whole remediation
  // layer is omitted rather than rewritten after assembly.
  out = out.replace(
    /\n- \*\*NEVER OFFER A ROUTE YOU HAVE NOT CONFIRMED YOU CAN EXECUTE\.\*\*[\s\S]*?(?=\n- \*\*Ask the route EVEN)/,
    '\n',
  );

  // One historical observation still names the CLI discovery mechanism. It is
  // evidence, not an instruction, but retaining the marker would make the
  // profile's construction invariant impossible to assert mechanically.
  out = out.replaceAll('ToolSearch', 'deferred-tool discovery');

  out = spliceGeneratedSection(out, AUTO_MODE_MARKER, renderModesPolicy());
  out = spliceGeneratedSection(out, RESULT_DOOR_MARKER, renderResultDoorSection());
  out = spliceGeneratedSection(out, COORD_LEGEND_MARKER, renderCoordLegend());
  out = spliceGeneratedSection(
    out,
    WIRE_SCHEMAS_MARKER,
    renderWireSchemasSection((name) => toolNames.includes(name)),
  );
  out = spliceGeneratedSection(out, WORKSPACE_MAP_MARKER, renderWorkspaceMapSection());
  out = spliceGeneratedSection(out, PROMOTION_MODEL_MARKER, renderPromotionModelSection());
  out = out.split(PROJECT_GUIDE_MARKER).join('');

  // A future canonical su source may add optional generated markers. They are
  // internal projection syntax, never model-visible prompt content.
  out = out.replace(/<!--\s*PAPERCUSP-SU:[^>]+-->\n*/g, '');

  const leaked = [
    'ToolSearch',
    'NO_SUBAGENT_TOOLS_DENY',
    'Managing your own compaction',
    'While bypass permissions mode is active:',
  ].filter((needle) => out.includes(needle));
  if (leaked.length > 0) {
    throw new Error(
      `prompt-assembly: pui-loop source leaked client-remediation marker(s): ${leaked.join(', ')}`,
    );
  }

  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function assemblePuiLoopPrompt(opts: AssembleOptions): AssembledPrompt {
  const sections: AssembledSection[] = [];
  const parts: string[] = [];

  const baseSource = opts.baseSource ?? canonicalPuiLoopSuSource();
  const base = readFileSync(baseSource, 'utf8');
  const spine = projectPuiLoopSuSource(base, opts.toolNames);
  parts.push(spine);
  sections.push({ name: 'persona', chars: spine.length });

  // renderSuPlaybook injects these canonical shared notes for the same su
  // source. Keep that source parity here without routing through the client
  // playbook renderer.
  const sharedNotes: Array<[AssembledSection['name'], string]> = [
    ['deploy-pipeline-note', renderDeployPipelineNote()],
    ['wait-loop-note', renderWaitLoopNote()],
    ['peer-wake-note', renderPeerWakeNote()],
    ['coupling-note', renderCouplingNote()],
    ['state-plane-note', renderStatePlaneNote()],
  ];
  for (const [name, text] of sharedNotes) {
    if (!text) continue;
    parts.push(text);
    sections.push({ name, chars: text.length });
  }

  const projectGuideSource =
    opts.projectGuideSource ??
    (opts.projectDir
      ? [join(opts.projectDir, 'CLAUDE.md'), join(opts.projectDir, 'AGENTS.md')].find((candidate) =>
          existsSync(candidate),
        )
      : undefined) ??
    '';
  const rawGuide =
    opts.projectGuideText ??
    (projectGuideSource ? readFileSync(projectGuideSource, 'utf8') : '');
  // Apply profile-specific omissions BEFORE measuring the project-guide budget.
  // Budgeting the raw guide first can report/truncate content that this profile
  // immediately removes. The live CLAUDE.md exposed that ordering bug when the
  // removable bash/tool-discovery section alone pushed the raw source past 96k,
  // while the guide actually projected into the prompt remained well below it.
  const projectedRawGuide = removeMarkdownHeadingSection(
    rawGuide,
    'Reaching for bash? These reads already have a tool',
  ).text.replaceAll('ToolSearch', 'deferred-tool discovery');
  const guide = projectGuideAtBudget(
    projectedRawGuide,
    projectGuideSource,
    opts.projectGuideMaxChars,
  );
  const projectGuide = renderPuiLoopProjectGuide(guide.text);
  if (projectGuide) {
    parts.push(projectGuide);
    sections.push({ name: 'project-guide', chars: projectGuide.length });
  }

  const catalog = opts.toolCatalogText ?? renderToolsCatalog(opts.role, opts.toolNames, 'text', undefined, opts.servingGeneration);
  if (catalog) {
    parts.push(catalog);
    sections.push({ name: 'tools-catalog', chars: catalog.length });
  }

  if (opts.runtime && opts.runtime.length > 0) {
    const runtimeText = opts.runtime
      .map((r) => `## ${r.heading}\n\n${r.body}`)
      .join('\n\n---\n\n');
    parts.push(runtimeText);
    sections.push({ name: 'runtime', chars: runtimeText.length });
  }

  const text = parts.join('\n\n---\n\n');
  const leaked = [
    'ToolSearch',
    'NO_SUBAGENT_TOOLS_DENY',
    'Managing your own compaction',
    'While bypass permissions mode is active:',
  ].filter((needle) => text.includes(needle));
  if (leaked.length > 0) {
    throw new Error(
      `prompt-assembly: pui-loop prompt leaked client-remediation marker(s): ${leaked.join(', ')}`,
    );
  }
  return {
    text,
    sections,
    profile: 'pui-loop',
    baseSource,
    projectGuideSource,
    projectGuideTruncated: guide.truncated,
    omittedClientRemediation: [
      'client-compaction-strategy',
      'client-subagent-denial',
      'client-tool-discovery-workaround',
      'client-bash-preamble-override',
    ],
  };
}

/* ─── Top-level assembly ──────────────────────────────────────────────── */

export function assembleRolePrompt(opts: AssembleOptions): AssembledPrompt {
  if (opts.profile === 'pui-loop') return assemblePuiLoopPrompt(opts);

  const sections: AssembledSection[] = [];
  const parts: string[] = [];

  const persona = loadRolePersona(opts.role, opts.resolve);
  parts.push(persona);
  sections.push({ name: 'persona', chars: persona.length });

  const catalog = renderToolsCatalog(opts.role, opts.toolNames, 'text', undefined, opts.servingGeneration);
  if (catalog) {
    parts.push(catalog);
    sections.push({ name: 'tools-catalog', chars: catalog.length });
  }

  const playbook = loadRoleToolsMd(opts.role, opts.resolve);
  if (playbook) {
    parts.push(playbook);
    sections.push({ name: 'tools-playbook', chars: playbook.length });
  }

  // Coord-injection legend (token-efficient-coord-injection P-013). Role
  // sessions DO receive coord injection — the global Claude PostToolUse coord
  // hook fires on their `PAPERCUSP_SID` (set by bootstrap-role) — so they get the
  // positional `[coord+N]` blocks and need the SAME legend the psu playbook
  // carries to read them. Sourced from the one `COORD_LEGEND` (so it can't
  // desync from the renderer). Clients that don't inject just never see a block.
  const coordLegend = renderCoordLegend();
  if (coordLegend) {
    parts.push(coordLegend);
    sections.push({ name: 'coord-legend', chars: coordLegend.length });
  }

  // Friction trip-wire (self-learning-central P-001/A, D-006). The SUBJECTIVE
  // sibling of the watchdog: a near-zero one-line clause in the SHARED base every
  // role inherits, priming the model to file friction it *felt* (a workaround, a
  // misleading doc, a >3-attempt confusing failure) via improvements:capture the
  // moment it hits it — NOT a per-turn reflection pass. Sourced from the one
  // friction-markers module so the base, the su playbook, and the
  // completion-boundary reflect step can't desync.
  const frictionTripwire = renderFrictionTripwire();
  if (frictionTripwire) {
    parts.push(frictionTripwire);
    sections.push({ name: 'friction-tripwire', chars: frictionTripwire.length });
  }

  // Observation-rubric nudge (rubric-driven-observations-2026-06-20 P-005, D-001/D-003) — the
  // HOW-to-grade sibling of the friction trip-wire in the SHARED base every operator-launched role
  // inherits, mirroring the spawned-bee base (buildPromptParts). When filing a turn-end observation,
  // check rubrics:list first and file a STRUCTURED observation (rubricRef + per-criterion ratings +
  // mandatory evidence) if an active rubric fits; free-text stays first-class otherwise. Sourced from
  // the one OBSERVATION_RUBRIC_NUDGE constant (orchestrator) so this base + the spawned-bee base can't desync.
  const observationRubricNudge = renderObservationRubricNudge();
  if (observationRubricNudge) {
    parts.push(observationRubricNudge);
    sections.push({ name: 'observation-rubric-nudge', chars: observationRubricNudge.length });
  }

  // Yield policy (turn-lifecycle-control P-017, D-007/D-009) — the dual of the
  // friction trip-wire: the cooperative-yield behavior in the SHARED base every
  // operator-launched role inherits (on a turn:interrupt yield, checkpoint →
  // persist partial state → release locks → successor note → end the turn).
  // Sourced from the one YIELD_POLICY constant (orchestrator) so this base, the
  // spawned-bee base, and the su playbook can't desync.
  const yieldPolicy = renderYieldPolicy();
  if (yieldPolicy) {
    parts.push(yieldPolicy);
    sections.push({ name: 'yield-policy', chars: yieldPolicy.length });
  }

  // Multi-account inference note — the SHARED base every operator-launched role
  // inherits, mirroring the spawned-bee base. Kills the recurring mis-diagnosis of a
  // routing/config fault as a true capacity limit ("we hit the account limit") and
  // steers LLM-building work onto the account-routing system. Sourced from the one
  // ACCOUNT_ROUTING_NOTE constant (orchestrator) so the bases + su playbooks can't desync.
  const accountNote = renderAccountRoutingNote();
  if (accountNote) {
    parts.push(accountNote);
    sections.push({ name: 'account-routing-note', chars: accountNote.length });
  }

  // Evidence-discipline note — the GENERAL rule the account-routing note above is one instance of: a
  // likely-looking cause is a HYPOTHESIS to verify with hard evidence, never a fact to act on / report;
  // and when the evidence isn't obtainable, ADD the observability or FILE the means rather than assuming.
  // Sourced from the one EVIDENCE_DISCIPLINE_NOTE constant (orchestrator) so the bases + su playbooks can't desync.
  const evidenceNote = renderEvidenceDisciplineNote();
  if (evidenceNote) {
    parts.push(evidenceNote);
    sections.push({ name: 'evidence-discipline-note', chars: evidenceNote.length });
  }

  // Concurrency-first note — the SHARED base every operator-launched role inherits, the
  // behavioral dual of the account-routing note. Kills the "the box is too contended, wait for a
  // calmer window" back-off: the only legit block is TRUE verified resource exhaustion; every
  // other block is a BUG to investigate + fix (or file), never to wait out — and the design target
  // is hundreds-to-thousands of concurrent agents. Sourced from the one CONCURRENCY_FIRST_NOTE
  // constant (orchestrator) so the bases + su playbooks + su instance override can't desync.
  const concurrencyNote = renderConcurrencyFirstNote();
  if (concurrencyNote) {
    parts.push(concurrencyNote);
    sections.push({ name: 'concurrency-first-note', chars: concurrencyNote.length });
  }

  // Testing standard (the "write tests the project way" clause) — the SHARED base
  // every operator-launched role inherits, mirroring the spawned-bee base
  // (buildPrompt). Sourced from the one TESTING_STANDARD constant (orchestrator) so
  // this base, the spawned-bee base, and the su playbooks can't desync.
  const testingStandard = renderTestingStandard();
  if (testingStandard) {
    parts.push(testingStandard);
    sections.push({ name: 'testing-standard', chars: testingStandard.length });
  }

  // Deploy-pipeline note (the "your change ships via an async, self-healing pipeline; don't
  // babysit it or self-diagnose a stall" clause) — the SHARED base every operator-launched role
  // inherits, mirroring the spawned-bee base (buildPromptParts). Sourced from the one
  // DEPLOY_PIPELINE_NOTE constant (orchestrator) so this base + the spawned-bee base can't desync.
  const deployNote = renderDeployPipelineNote();
  if (deployNote) {
    parts.push(deployNote);
    sections.push({ name: 'deploy-pipeline-note', chars: deployNote.length });
  }

  // Reuse-first nudge (the soft "extend, don't fork" clause) — the SHARED base every
  // operator-launched role inherits, mirroring the spawned-bee base (buildPromptParts).
  // Before adding a new durable surface, search for an existing one to extend + prefer the
  // smallest extension; a new parallel surface duplicating an existing one is a top review
  // smell. Sourced from the one REUSE_FIRST_NUDGE constant (orchestrator) so this base, the
  // spawned-bee base, and the su persona base can't desync (agents-reuse-first-default P-001).
  const reuseFirstNudge = renderReuseFirstNudge();
  if (reuseFirstNudge) {
    parts.push(reuseFirstNudge);
    sections.push({ name: 'reuse-first-nudge', chars: reuseFirstNudge.length });
  }

  // Plan-discipline note (enforce-system-on-generic-work-2026-06-29 P-016) — the SHARED base every
  // operator-launched role inherits, mirroring the spawned-bee base (buildPromptParts). The bright-line
  // for WHEN a plan is required (>=2 work-items / interdependent steps / outlives a session / sequences
  // subsystems) vs. when it is over-applied ceremony (a one-shot fix). Sourced from the one
  // PLAN_DISCIPLINE_NOTE constant (orchestrator) so this base + the spawned-bee base can't desync.
  const planDisciplineNote = renderPlanDisciplineNote();
  if (planDisciplineNote) {
    parts.push(planDisciplineNote);
    sections.push({ name: 'plan-discipline-note', chars: planDisciplineNote.length });
  }

  // Work-record note (audit-trail discipline; owner ask 2026-06-23, sharpened 2026-06-29 with the
  // work-item PRECONDITION) — the SHARED base every operator-launched role inherits, mirroring the
  // spawned-bee base (buildPromptParts). Hold a work-item BEFORE your first code/deliverable edit; not
  // done until work_items:complete; every unit of work gets a record even when small (a tiny exception
  // task may be recorded AFTER finishing). Sourced from the one WORK_RECORD_NOTE constant (orchestrator)
  // so this base + the spawned-bee base can't desync.
  const workRecordNote = renderWorkRecordNote();
  if (workRecordNote) {
    parts.push(workRecordNote);
    sections.push({ name: 'work-record-note', chars: workRecordNote.length });
  }

  // Observation-capture note (enforce-system-on-generic-work-2026-06-29 P-017) — the SHARED base every
  // operator-launched role inherits, mirroring the spawned-bee base (buildPromptParts). The ROUTING
  // sibling of the friction trip-wire: capture what you notice the moment you notice it and route it —
  // signal → improvements:capture (with evidence), problem → issue/work-item, how-it-works → an
  // agent-insights doc. Sourced from the one OBSERVATION_CAPTURE_NOTE constant (orchestrator) so this
  // base + the spawned-bee base can't desync.
  const observationCaptureNote = renderObservationCaptureNote();
  if (observationCaptureNote) {
    parts.push(observationCaptureNote);
    sections.push({ name: 'observation-capture-note', chars: observationCaptureNote.length });
  }

  // Write-through note (compaction-context-loss-2026-07-05 P-004) — the SHARED base every
  // operator-launched role inherits, mirroring the spawned-bee base (buildPromptParts). Flush a
  // durable conclusion the MOMENT it forms (facts:assert for a standing conclusion,
  // work_items:checkpoint / loop:checkpoint for in-flight state) — not when the context fills; the
  // ~75% gauge nudge + compaction are the BACKSTOP, never the trigger (D-001: the carry system's
  // weakness is behavioral at the WRITE end). Sourced from the one WRITE_THROUGH_NOTE constant
  // (orchestrator) so this base + the spawned-bee base + the su playbooks + compaction-strategy.md
  // can't desync.
  const writeThroughNote = renderWriteThroughNote();
  if (writeThroughNote) {
    parts.push(writeThroughNote);
    sections.push({ name: 'write-through-note', chars: writeThroughNote.length });
  }

  // Turn-end observation pass (owner ask 2026-06-23) — the DELIBERATE end-of-turn reflection step
  // (the bee.md / su-playbook pass) generalized to every operator-launched role (operator / oracle /
  // sentinel previously had only the reactive friction-tripwire). Token-light: "routine turn ⇒ record
  // nothing". Injected ONLY here (the bee base + su playbooks carry their own) to avoid double-inject.
  const turnEndObservation = renderTurnEndObservation();
  if (turnEndObservation) {
    parts.push(turnEndObservation);
    sections.push({ name: 'turn-end-observation', chars: turnEndObservation.length });
  }

  // Code-run nudge (code-execution-tool-orchestration B-CX-3) — the SHARED base every
  // operator-launched role inherits, mirroring the spawned-bee base (buildPromptParts). Reach for
  // code:run to collapse a multi-step tool flow (loop/branch/filter/fan-out/retry over N) into ONE
  // call instead of N sequential MODEL turns (raw same-turn RPC count is not the cost); self-gated.
  // from the one CODE_RUN_NUDGE constant (orchestrator) so this base + the spawned-bee base can't desync.
  const codeRunNudge = renderCodeRunNudge();
  if (codeRunNudge) {
    parts.push(codeRunNudge);
    sections.push({ name: 'code-run-note', chars: codeRunNudge.length });
  }

  // Finish-the-rollout note (flags-default-on-reach-2026-06-21) — the SHARED base every
  // operator-launched role inherits, mirroring the spawned-bee base (buildPromptParts). A capability
  // built then left gated OFF (flag or env boolean) is INCOMPLETE, not done — turning the gate on is
  // the last step of the task. Sourced from the one FINISH_THE_ROLLOUT_NOTE constant (orchestrator) so
  // this base, the spawned-bee base, the su playbooks, and CLAUDE.md's flags section can't desync.
  const finishTheRolloutNote = renderFinishTheRolloutNote();
  if (finishTheRolloutNote) {
    parts.push(finishTheRolloutNote);
    sections.push({ name: 'finish-the-rollout-note', chars: finishTheRolloutNote.length });
  }

  // Agent-activity-truth note (agent-activity-liveness-truth-2026-06-21 P-004/P-006) — the SHARED
  // base every operator-launched role inherits, mirroring the spawned-bee base. "Who's doing what"
  // is a LIVE derived truth (fleet:assignments: claim + holder-liveness + progress), never a stale
  // coord broadcast that outlives the work — the incident class (a dead bee read as "covered" for ~1h).
  // Sourced from the one AGENT_ACTIVITY_TRUTH_NOTE constant (orchestrator) so this base + the
  // spawned-bee base can't desync.
  const agentActivityTruthNote = renderAgentActivityTruthNote();
  if (agentActivityTruthNote) {
    parts.push(agentActivityTruthNote);
    sections.push({ name: 'agent-activity-truth-note', chars: agentActivityTruthNote.length });
  }

  // Wait-loop note (owner directive 2026-06-23) — the SHARED base every operator-launched role
  // inherits, mirroring the spawned-bee base. When blocked on something that may never fire, arm a
  // recurring self-wake (loop:arm / declare-wake) and FIX what's preventing the firing instead of
  // sleeping forever on a bare event-await. Sourced from the one WAIT_LOOP_NOTE constant
  // (orchestrator) so this base, the spawned-bee base, and the su playbooks can't desync.
  const waitLoopNote = renderWaitLoopNote();
  if (waitLoopNote) {
    parts.push(waitLoopNote);
    sections.push({ name: 'wait-loop-note', chars: waitLoopNote.length });
  }

  // Peer-wake note (owner directive 2026-06-24) — the SHARED base every operator-launched role
  // inherits, mirroring the spawned-bee base. A parked agent sleeps until something re-invokes it, so
  // handing work off does not make a peer act; you can (and usually must) WAKE the peer you depend on
  // (coord:dispatch / coord:handoff for new work, coord:wake to resume an assigned lane) and verify it
  // landed. The active complement of the wait-loop note. Sourced from the one PEER_WAKE_NOTE constant
  // (orchestrator) so this base, the spawned-bee base, and the su playbooks can't desync.
  const peerWakeNote = renderPeerWakeNote();
  if (peerWakeNote) {
    parts.push(peerWakeNote);
    sections.push({ name: 'peer-wake-note', chars: peerWakeNote.length });
  }

  // Coupling note (owner directive 2026-07-27; unified-agent-state-plane P-031, D-061/D-062) — the
  // SHARED base every operator-launched role inherits, mirroring the spawned-bee base. Coupling is
  // the relevance gate on peer state and was DERIVED-only; coord:couple/coord:decouple are the
  // declaration path, either agent arg takes "self", and ANY agent may couple ANY two agents
  // (including a pair it is not part of). The note teaches the DECOUPLE trigger and the cost SHAPE —
  // per peer, per read, paid on BOTH sides — not just the couple verb. Sourced from the one
  // COUPLING_NOTE constant (orchestrator) so this base, the spawned-bee base, and the su playbooks
  // can't desync.
  const couplingNote = renderCouplingNote();
  if (couplingNote) {
    parts.push(couplingNote);
    sections.push({ name: 'coupling-note', chars: couplingNote.length });
  }

  // State-plane note — the SHARED base every operator-launched role inherits, mirroring the
  // spawned-bee base. The two agent-CHOICE behaviours of the unified state plane: READ a cell
  // (state:read / state:subscribe) rather than transcribing a value that can change under you,
  // and SAY what you want back (`expects`) / split a message that MIXES dispositions into
  // sections (premises, forYouBecause, youMayNotKnow, couldNotDetermine). Both shipped with
  // correct per-tool guidance and were still unreached (state:read 5 agents of 157; the
  // sectioned body 1 message in 30h, and that one the owner's GUI) — the playbook is what makes
  // an agent reach for a tool it has not already chosen. Sourced from the one STATE_PLANE_NOTE
  // constant (orchestrator) so this base, the spawned-bee base, and the su playbooks can't
  // desync. ⚠ D-016: a prompt is not an enforcement tier — the constant's doc-comment records
  // which halves carry a real gate (`expects`, cell registration) and which carries none.
  const statePlaneNote = renderStatePlaneNote();
  if (statePlaneNote) {
    parts.push(statePlaneNote);
    sections.push({ name: 'state-plane-note', chars: statePlaneNote.length });
  }

  if (opts.runtime && opts.runtime.length > 0) {
    const runtimeText = opts.runtime
      .map((r) => `## ${r.heading}\n\n${r.body}`)
      .join('\n\n---\n\n');
    parts.push(runtimeText);
    sections.push({ name: 'runtime', chars: runtimeText.length });
  }

  return {
    text: parts.join('\n\n---\n\n'),
    sections,
  };
}
