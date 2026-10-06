/**
 * cache-policy.ts — provider-agnostic PROMPT-CACHE request-body rewrites
 * (gateway-cache-plane-shared-prefix-ttl-2026-07-19 P-001/P-003/P-005/P-008).
 *
 * WHY: prompt-cache entries are ORG-scoped, MODEL-scoped and EXACT-PREFIX-BYTE-scoped on both
 * providers, so every fleet session launched with the same tool-list variant COULD share one
 * boot-prefix cache entry instead of each paying its own ~60-70k write. Measured 2026-07-19
 * (97 sessions/48h): fleet read:write ratio 16.6:1, ~24% of write tokens still on the 5-minute
 * tier (an overage/billing-mode fallback the CLI exposes no knob for). The one place we can act
 * is the REQUEST BODY as it leaves this machine — hence these rewrites, applied by BOTH
 * forward points (the inference gateway for pool-routed sessions, and the transparent
 * cache-proxy for default-account sessions, which are the largest single sharing cohort).
 *
 * INVARIANTS (why this is safe to run on every request):
 *  - PURE + IN-PLACE on an already-parsed body; never touches responses.
 *  - IDEMPOTENT: re-running on an already-rewritten body is a no-op (an existing ttl/key/
 *    breakpoint is respected, never doubled).
 *  - NEVER EXCEEDS the provider's breakpoint budget (Anthropic hard-caps at 4 cache_control
 *    markers per request; a 5th is a 400). We count first and skip injection when full.
 *  - CLIENT INTENT WINS: an explicit client-set ttl / prompt_cache_key / breakpoint is left
 *    alone. We only fill in what the client omitted.
 *  - Kill-switched by the callers via env, so a bad interaction is one restart from reverted.
 */

/** Anthropic hard limit — a 5th `cache_control` marker in one request is a 400. */
export const ANTHROPIC_MAX_BREAKPOINTS = 4;
/** Published by each serving process; a changed policy must advance this identity. */
export const CACHE_POLICY_VERSION = '2026-09-24-ttl-order-budget-v2';

/** The extended cache tier [owner 2026-07-19 "just enable 1h everywhere"]. Accepted values
 *  are '5m' (default when absent) and '1h'. 1h writes cost 2× base input vs 1.25× for 5m, and
 *  read at the same ~0.1×, so the tier pays for itself after ~3 reads — the fleet's measured
 *  median session takes 63 requests. */
export const ANTHROPIC_EXTENDED_TTL = '1h';

/**
 * Stable/volatile boundary sentinel (gateway-cache-plane-shared-prefix-ttl-2026-07-19 P-004).
 *
 * The psu launcher appends the assembled playbook via `--append-system-prompt-file`, and Claude
 * Code MERGES it into its own big system text block with a single cache_control at the block's
 * END. So the block is one cache unit: because it ends with per-session content (the launch
 * context — plan slug/title/now), the ENTIRE ~66k-token block (Claude base + the stable playbook)
 * is a per-session cache entry and is WRITTEN FRESH every launch, even though the playbook body is
 * byte-identical across a cohort (same agent/profile/tier/hive — renderSuPlaybook is deterministic).
 *
 * role-launch-spec.ts emits this sentinel at the seam between the stable playbook and the
 * per-session launch context. `splitSystemAtBoundary` then splits the block there and moves the
 * cache_control to the STABLE side — so the ~66k playbook prefix becomes an org-shared cache entry
 * while only the small launch-context tail writes per session.
 *
 * MEASURED 2026-07-19 (real 150k-char playbook, two sessions, differing launch context): a
 * subsequent cohort session's write dropped 89,261 → 8,299 tokens and its cache READ rose
 * 9,724 → 75,984. This is the opposite of the P-003 tools-span breakpoint, which measured a no-op.
 *
 * An HTML comment so a leak (proxy off / a path that doesn't split) is inert — models ignore it.
 */
export const PSU_CACHE_BOUNDARY = '<!--PSU_CACHE_BOUNDARY-->';

export interface AnthropicCacheStats {
  /** The body object was mutated (caller must re-serialize). */
  changed: boolean;
  /** How many existing cache_control markers were upgraded to the extended ttl. */
  ttlUpgraded: number;
  /** cache_control markers present BEFORE our injection (the budget denominator). */
  breakpointsBefore: number;
  /** We added the shared tools-span breakpoint (P-003). */
  toolsBreakpointInjected: boolean;
  /** We wanted the tools breakpoint but the client already used all 4 slots. */
  toolsBreakpointSkippedNoBudget: boolean;
  /** We wanted the tools breakpoint but EVERY tool is defer_loading (tool-search sessions):
   *  a tool may not carry both `defer_loading` and `cache_control` — the API 400s. */
  toolsBreakpointSkippedAllDeferred: boolean;
  /** Adding the requested tools marker would put a short TTL before a long TTL. */
  toolsBreakpointSkippedTtlOrder?: boolean;
  /** P-004: the stable/volatile system-block split happened this request (set by the buffer
   *  wrapper, not applyAnthropicCachePolicy — the split runs one layer up). */
  boundarySplit?: boolean;
  /** WI-10005042 (D-078): the per-owner system tail was relocated into the first user turn.
   *  Present only when the relocation pass was requested (absent ≠ ran and declined). */
  tailRelocated?: boolean;
  /** What the relocation pass did about the shared-block breakpoint: `added`, `existing`
   *  (the client already marked that block), or a `skipped-*` reason. */
  tailBreakpoint?: 'added' | 'existing' | 'skipped-budget' | 'skipped-ttl-order';
  /** Per-tool `defer_loading` pass (agent-launch-context-cost-2026-09-18 P-002). Present only
   *  when `deferLargeTools` was requested; absent means the pass did not run, which is NOT the
   *  same as a pass that ran and deferred nothing. */
  toolDeferral?: ToolDeferralStats;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Every object in an Anthropic request body that may legally carry a `cache_control` marker,
 *  in RENDER ORDER (tools → system → messages) — the order that defines prefix nesting. */
function cacheableBlocks(body: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const push = (v: unknown) => {
    if (isRecord(v)) out.push(v);
  };
  if (Array.isArray(body.tools)) body.tools.forEach(push);
  if (Array.isArray(body.system)) body.system.forEach(push);
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!isRecord(m)) continue;
      if (Array.isArray(m.content)) m.content.forEach(push);
    }
  }
  return out;
}

/** True when a tool is marked for deferred loading (tool-search). Such a tool may NOT carry a
 *  `cache_control` marker — the pairing is a hard 400. Treated as deferred on ANY truthy value
 *  so a future spelling (e.g. an object form) fails CLOSED rather than re-breaking sessions. */
export function isDeferredTool(tool: unknown): boolean {
  return isRecord(tool) && Boolean(tool.defer_loading);
}

/**
 * The server-side BM25 tool-search tool
 * (docs "Server Tools": type `tool_search_tool_bm25_20251119`, name `tool_search_tool_bm25`).
 *
 * WHY THIS IS NOT OPTIONAL WHEN WE DEFER. A deferred tool's schema is not in the request; the
 * model reaches it by CALLING a tool-search tool. Defer without one in the body and those tools
 * are simply UNREACHABLE — the request succeeds, and the capability silently disappears. psu
 * launches deny native `ToolSearch`, so no search tool is present by default: if this gateway
 * defers, this gateway must inject.
 */
export const TOOL_SEARCH_BM25_TOOL = {
  type: 'tool_search_tool_bm25_20251119',
  name: 'tool_search_tool_bm25',
} as const;

/** Every tool-search variant (bm25 and regex), by `type` or by `name`. */
export function isToolSearchTool(tool: unknown): boolean {
  if (!isRecord(tool)) return false;
  const type = typeof tool.type === 'string' ? tool.type : '';
  const name = typeof tool.name === 'string' ? tool.name : '';
  return type.startsWith('tool_search_tool_') || name.startsWith('tool_search_tool_');
}

/**
 * A SERVER tool — declared by `type` with no `input_schema` (web_search, code_execution,
 * tool_search_*, memory, bash, …) rather than a client tool with a JSON schema.
 *
 * Used to keep a cache breakpoint OFF a server tool: `cache_control` on one is unvalidated here,
 * and the injected search tool would otherwise become the last tool and therefore the anchor.
 * Deliberately narrower than "has a type": a client tool that also carries `input_schema` stays
 * markable, which is what keeps the pre-existing tool-search fixtures behaving as before.
 */
export function isServerTool(tool: unknown): boolean {
  return isRecord(tool) && typeof tool.type === 'string' && tool.input_schema === undefined;
}

/** Index of the last tool that can legally anchor a cache breakpoint, or -1 when none can. */
export function findLastNonDeferredToolIndex(tools: readonly unknown[]): number {
  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i];
    if (!isRecord(tool)) continue;
    if (isDeferredTool(tool)) continue;
    if (isServerTool(tool)) continue; // never anchor the prefix on a server tool
    return i;
  }
  return -1;
}

/** Serialized size of one tool definition, in bytes. Unserializable → 0 (never a defer candidate). */
export function toolSerializedBytes(tool: unknown): number {
  try {
    const json = JSON.stringify(tool);
    return typeof json === 'string' ? Buffer.byteLength(json, 'utf8') : 0;
  } catch {
    return 0;
  }
}

/**
 * Default size above which a tool is worth deferring, in serialized bytes.
 *
 * ⚠ 1200 IS A MEASURED VALUE. DO NOT "TIDY" IT TO A ROUNDER NUMBER.
 * The first version of this constant was 8,000, derived from the 895-tool CATALOG (20 tools over
 * 8 KB, 356,320 B, 29.1% of catalog bytes). A live both-arms A/B on 2026-09-18 showed that
 * reasoning was measuring the wrong population: a psu SESSION advertises ~119 tools with a quite
 * different size distribution, and at 8,000 B almost nothing qualifies.
 *
 * Three headless psu launches, identical in every respect except this threshold
 * (plan `agent-launch-context-cost-2026-09-18` D-002):
 *   control (deferral off) 169,167 launch tokens
 *   threshold 8000         163,508   (−3.3%  — the catalog-derived value, near-worthless)
 *   threshold 1200         115,273   (−31.9% — 45 tools / 142,012 B deferred)
 *
 * Raising this back toward 8,000 silently returns the feature to a ~3% no-op that still looks
 * enabled in config — the most expensive failure shape available here, because it reads as
 * working. Re-measure with `npm run measure:launch-cost` before changing it.
 */
export const DEFAULT_DEFER_MIN_TOOL_BYTES = 1200;

/**
 * P-009(d) — THE single read site for the deferral kill switch, shared by BOTH forward points.
 *
 * `inference-gateway/gateway.ts` (gateway-routed sessions) and
 * `apps/operator/lib/cache-proxy/proxy.ts` (default-account sessions) are SEPARATE PROCESSES
 * reading the SAME env var. While each re-implemented the read inline, editing one polarity —
 * or restarting one service without the other — split the fleet into fixed and unfixed halves
 * with nothing to catch it. Both now import this, so the two planes cannot disagree by
 * construction rather than by assertion.
 *
 * Default ON since 2026-09-18 (D-016, owner-directed); `PAPERCUSP_GATEWAY_DEFER_LARGE_TOOLS=0`
 * is the kill switch. The polarity is `!== '0'` and NOT `=== '1'`: a revert to the latter
 * restores the landed-and-inert state that D-002 closed on, which is the specific regression
 * P-009 exists to prevent.
 */
export function deferLargeToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPERCUSP_GATEWAY_DEFER_LARGE_TOOLS !== '0';
}

/**
 * Companion read for the deferral byte threshold — same one-site rule as
 * {@link deferLargeToolsEnabled}, and duplicated inline at both forward points before P-009(d).
 * Returns undefined when unset/invalid so the caller falls back to
 * {@link DEFAULT_DEFER_MIN_TOOL_BYTES}.
 */
export function deferMinToolBytesFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const n = Number(env.PAPERCUSP_GATEWAY_DEFER_MIN_TOOL_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export interface ToolDeferralStats {
  /** Tools this pass newly marked `defer_loading`. */
  toolsDeferred: number;
  /** Serialized bytes of the tools this pass deferred. */
  toolsDeferredBytes: number;
  /** We appended the BM25 tool-search tool because deferred tools needed a way to be reached. */
  searchToolInjected: boolean;
  /** Eligible-by-size tools left alone because they already carry `cache_control` (EI-16980). */
  skippedCacheControl: number;
  /** We held the smallest candidate back so at least one client tool stays non-deferred. */
  heldBackToKeepNonDeferred: boolean;
}

/**
 * Mark oversized tools `defer_loading` and guarantee they remain reachable, IN PLACE.
 *
 * ⚠ THREE INVARIANTS, EACH A HARD API FAILURE IF BROKEN. All three are tested.
 *  1. NEVER `defer_loading` + `cache_control` on the same tool. The API rejects the whole request
 *     with a 400 ("Tools with defer_loading cannot use prompt caching"). This is not theoretical:
 *     EI-16980 shipped exactly that pairing and every affected session failed outright. Claude
 *     Code marks a tool itself, so a body arriving here may ALREADY carry one — which is why the
 *     rule is implemented as "skip a tool that has cache_control", not "strip its cache_control".
 *     Stripping would silently discard the client's own caching intent to serve ours.
 *  2. NEVER defer every tool — the API returns 400 `All tools have defer_loading set`. If the
 *     candidate set would leave no non-deferred CLIENT tool, the smallest candidate is held back.
 *     The injected search tool is deliberately NOT counted as satisfying this: resting the
 *     invariant on a tool we appended makes an unrelated future change to the injection able to
 *     break the request.
 *  3. NEVER defer the search tool itself — same 400 family, and it is the one tool that must be
 *     inline for any of the others to be recoverable.
 *
 * Returns the stats; does nothing and reports zeros when `body.tools` is absent or empty.
 */
export function applyToolDeferral(
  body: Record<string, unknown>,
  opts: { minToolBytes?: number } = {},
): ToolDeferralStats {
  const minToolBytes = opts.minToolBytes ?? DEFAULT_DEFER_MIN_TOOL_BYTES;
  const stats: ToolDeferralStats = {
    toolsDeferred: 0,
    toolsDeferredBytes: 0,
    searchToolInjected: false,
    skippedCacheControl: 0,
    heldBackToKeepNonDeferred: false,
  };

  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) return stats;

  // Candidates: large CLIENT tools that are not already deferred, not a search tool, and — the
  // EI-16980 rule — not already carrying a cache_control marker.
  const candidates: { tool: Record<string, unknown>; bytes: number }[] = [];
  let nonDeferredClientTools = 0;
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    const alreadyDeferred = isDeferredTool(tool);
    const serverTool = isServerTool(tool);
    if (!alreadyDeferred && !serverTool) nonDeferredClientTools++;
    if (alreadyDeferred || isToolSearchTool(tool) || serverTool) continue;
    const bytes = toolSerializedBytes(tool);
    if (bytes <= minToolBytes) continue;
    if (isRecord(tool.cache_control)) {
      stats.skippedCacheControl++;
      continue;
    }
    candidates.push({ tool, bytes });
  }

  // Invariant 2: keep at least one non-deferred client tool. Hold back the SMALLEST candidate —
  // it is the one whose deferral buys the least.
  let toDefer = candidates;
  if (candidates.length > 0 && candidates.length >= nonDeferredClientTools) {
    const sorted = [...candidates].sort((a, b) => a.bytes - b.bytes);
    toDefer = sorted.slice(1);
    stats.heldBackToKeepNonDeferred = true;
  }

  for (const { tool, bytes } of toDefer) {
    tool.defer_loading = true;
    stats.toolsDeferred++;
    stats.toolsDeferredBytes += bytes;
  }

  // Reachability: any deferred tool in the body — ours or the client's — needs a search tool.
  const anyDeferred = tools.some((tool) => isDeferredTool(tool));
  if (anyDeferred && !tools.some((tool) => isToolSearchTool(tool))) {
    // Appended, not prepended: the tools array is prefix position 0, so adding at the END leaves
    // the longest possible shared cache prefix intact. `findLastNonDeferredToolIndex` skips
    // server tools, so this never becomes the breakpoint anchor.
    tools.push({ ...TOOL_SEARCH_BM25_TOOL });
    stats.searchToolInjected = true;
  }

  return stats;
}

/** An ephemeral cache_control marker, if this block carries one. */
function ephemeralMarker(block: Record<string, unknown>): Record<string, unknown> | null {
  const cc = block.cache_control;
  if (!isRecord(cc)) return null;
  if (cc.type !== 'ephemeral') return null; // an unknown/other type is not ours to touch
  return cc;
}

/**
 * Apply the fleet prompt-cache policy to a parsed Anthropic `/v1/messages` body, IN PLACE.
 *
 * 1. TTL (P-001): omitted TTLs get the extended tier only before any short marker.
 *    A client-set ttl (either value) is left alone — client intent wins. After a short
 *    marker, an omitted TTL stays at the provider's 5m default to preserve legal ordering.
 * 2. Shared tools breakpoint (P-003) — OFF BY DEFAULT, see `injectToolsBreakpoint`. The theory
 *    was that the `tools` array (prefix position 0, byte-identical across same-variant sessions)
 *    would be shareable only if we marked its end, because the earliest client breakpoint sits
 *    after the per-session system prompt. MEASURED 2026-07-19 AND DISPROVEN: a controlled A/B
 *    (two `claude -p` runs with deliberately different system prompts, one through a proxy with
 *    the injection and one without) produced IDENTICAL usage — write_1h=31426, read=9724 in both
 *    arms. Claude Code's own breakpoint placement already yields that shared span, so the
 *    injection bought nothing while costing a production incident (a tool carrying both
 *    defer_loading and cache_control is a hard 400 — EI-16980). Kept, tested and flag-gated
 *    rather than deleted because the psu case is NOT the case measured: a psu playbook puts
 *    per-session bytes EARLY in the system prompt, where the shared span may genuinely collapse
 *    to the tools array. Re-enable only alongside P-004 (prefix stabilization) AND a measured
 *    read-delta — never on theory alone, which is exactly how this went wrong the first time.
 */
export function applyAnthropicCachePolicy(
  body: Record<string, unknown>,
  /** `injectToolsBreakpoint` defaults to FALSE (measured no-op — see the header). Pass true to
   *  opt in; the callers gate it behind PAPERCUSP_CACHE_TOOLS_BREAKPOINT=1. */
  opts: {
    ttl?: string;
    injectToolsBreakpoint?: boolean;
    /** P-002: mark oversized tools `defer_loading` and inject the BM25 search tool. Default OFF. */
    deferLargeTools?: boolean;
    deferMinToolBytes?: number;
  } = {},
): AnthropicCacheStats {
  const ttl = opts.ttl ?? ANTHROPIC_EXTENDED_TTL;
  const stats: AnthropicCacheStats = {
    changed: false,
    ttlUpgraded: 0,
    breakpointsBefore: 0,
    toolsBreakpointInjected: false,
    toolsBreakpointSkippedNoBudget: false,
    toolsBreakpointSkippedAllDeferred: false,
  };

  // ORDER IS LOAD-BEARING: the deferral pass runs FIRST so that everything downstream sees the
  // post-deferral tool list. Specifically, `findLastNonDeferredToolIndex` below must not pick an
  // anchor we are about to mark `defer_loading` — that pairing is the EI-16980 hard 400.
  if (opts.deferLargeTools === true) {
    const deferral = applyToolDeferral(body, { minToolBytes: opts.deferMinToolBytes });
    stats.toolDeferral = deferral;
    if (deferral.toolsDeferred > 0 || deferral.searchToolInjected) stats.changed = true;
  }

  const blocks = cacheableBlocks(body);
  let shortMarkerSeen = false;
  for (const b of blocks) {
    const cc = ephemeralMarker(b);
    if (!cc) continue;
    stats.breakpointsBefore++;
    if (typeof cc.ttl === 'string' && cc.ttl.length > 0) {
      if (cc.ttl === '5m') shortMarkerSeen = true;
      continue; // explicit client intent
    }
    if (shortMarkerSeen && ttl === '1h') continue;
    cc.ttl = ttl;
    if (ttl === '5m') shortMarkerSeen = true;
    stats.ttlUpgraded++;
    stats.changed = true;
  }

  // Top-level automatic caching (`cache_control` on the request itself) occupies a slot too:
  // the API auto-places it on the last cacheable block. Count it, and upgrade its ttl.
  const topLevel = isRecord(body.cache_control) && body.cache_control.type === 'ephemeral' ? body.cache_control : null;
  if (topLevel) {
    stats.breakpointsBefore++;
    if (!(typeof topLevel.ttl === 'string' && topLevel.ttl.length > 0) && !(shortMarkerSeen && ttl === '1h')) {
      topLevel.ttl = ttl;
      stats.ttlUpgraded++;
      stats.changed = true;
    }
  }

  if (opts.injectToolsBreakpoint === true) {
    const tools = body.tools;
    if (Array.isArray(tools) && tools.length > 0) {
      // A tool marked `defer_loading` CANNOT also carry `cache_control` — the API rejects the
      // whole request with a 400 ("Tools with defer_loading cannot use prompt caching"), so the
      // naive "mark the last tool" can land on a deferred tool and break the session outright.
      // ⚠ DO NOT ASSUME WHICH SESSIONS HAVE DEFERRED TOOLS. This comment used to read "every
      // tool-search session (the fleet forces ENABLE_TOOL_SEARCH=true) defers most of its
      // catalog"; that premise is FALSE for psu sessions and has been since the 2026-09-11
      // ToolSearch lockout — native deferral is conditional on ToolSearch existing, so psu
      // sessions defer almost nothing from the CLIENT side (P-007). The guard below is still
      // load-bearing, just for different reasons than it was written for: claude ships a
      // deferred `advisor` (and, before P-007, a `DeferredToolPlaceholder`) regardless, and the
      // gateway's own opt-in deferral marks tools here. Which is exactly why the code tests the
      // tools rather than the session type. Mark the LAST NON-DEFERRED tool instead: it ends a stable,
      // org-shareable prefix (tools render in order at position 0) and is always legal.
      // If every tool is deferred there is no legal anchor — skip, and record why.
      const idx = findLastNonDeferredToolIndex(tools);
      if (idx === -1) {
        stats.toolsBreakpointSkippedAllDeferred = true;
      } else {
        const anchor = tools[idx];
        if (isRecord(anchor) && !isRecord(anchor.cache_control)) {
          if (stats.breakpointsBefore < ANTHROPIC_MAX_BREAKPOINTS) {
            const at = blocks.indexOf(anchor);
            const priorShort = blocks.slice(0, at).some((b) => {
              const marker = ephemeralMarker(b);
              return marker && (marker.ttl === '5m' || marker.ttl === undefined);
            });
            const anchorTtl = priorShort && ttl === '1h' ? '5m' : ttl;
            const laterLong = blocks.slice(at + 1).some((b) => ephemeralMarker(b)?.ttl === '1h') || topLevel?.ttl === '1h';
            if (anchorTtl === '5m' && laterLong) {
              stats.toolsBreakpointSkippedTtlOrder = true;
            } else {
              anchor.cache_control = { type: 'ephemeral', ttl: anchorTtl };
              stats.toolsBreakpointInjected = true;
              stats.changed = true;
            }
          } else {
            // At budget: a 5th marker is a 400. Skipping costs the shared span, never the request.
            stats.toolsBreakpointSkippedNoBudget = true;
          }
        }
      }
    }
  }

  return stats;
}

export interface SplitBoundaryResult {
  /** The new system array when a split happened; null when nothing changed. */
  system: unknown[] | null;
  /** True when a block was split at the sentinel. */
  split: boolean;
  /** Index in `system` of the volatile tail block the split created (absent when the sentinel
   *  carried no tail, or nothing split). The relocation pass keys off it. */
  tailIndex?: number;
}

/**
 * Split the FIRST system text block containing {@link PSU_CACHE_BOUNDARY} into a stable prefix
 * and a volatile tail (P-004), moving the cache_control to the stable side so it becomes an
 * org-shared cache entry. Pure; returns `{system:null}` (no-op) for anything it can't safely do.
 *
 * SAFETY — this restructures the system array in front of every psu request, so it fails toward
 * no-op, NEVER toward a broken request:
 *  - only a real array of blocks with a real sentinel-carrying text block is touched;
 *  - the sentinel is DROPPED (the model never sees it) and the two halves concatenate to exactly
 *    the original text minus the sentinel — no byte of prompt content is lost or reordered;
 *  - the cache_control is MOVED from the original block onto the stable half (budget-neutral); if
 *    the original had none, one is added only when the 4-marker budget has room, else no marker
 *    (still correct, just unshared);
 *  - an empty stable half (sentinel at block start) is refused — there is nothing to share.
 */
export function splitSystemAtBoundary(
  system: unknown,
  ttl: string = ANTHROPIC_EXTENDED_TTL,
  context: { markersOutsideSystem?: number; laterLongMarker?: boolean } = {},
): SplitBoundaryResult {
  if (!Array.isArray(system)) return { system: null, split: false };
  const idx = system.findIndex(
    (b) => isRecord(b) && b.type === 'text' && typeof b.text === 'string' && b.text.includes(PSU_CACHE_BOUNDARY),
  );
  if (idx === -1) return { system: null, split: false };
  const block = system[idx] as Record<string, unknown>;
  const text = block.text as string;
  const at = text.indexOf(PSU_CACHE_BOUNDARY);
  const before = text.slice(0, at);
  const after = text.slice(at + PSU_CACHE_BOUNDARY.length);
  if (before.trim().length === 0) return { system: null, split: false }; // nothing stable to share

  // Count existing cache_control markers to respect the 4-cap when the block had none of its own.
  const existingMarkers = system.reduce((n, b) => (isRecord(b) && isRecord(b.cache_control) ? n + 1 : n), 0);
  const movedCc = isRecord(block.cache_control) ? block.cache_control : null;

  const stableBlock: Record<string, unknown> = { ...block, text: before };
  if (movedCc) {
    stableBlock.cache_control = movedCc; // budget-neutral move from the (now-removed) full block
  } else if (existingMarkers + (context.markersOutsideSystem ?? 0) < ANTHROPIC_MAX_BREAKPOINTS) {
    const priorShort = system.slice(0, idx).some((b) => isRecord(b) && ephemeralMarker(b)?.ttl === '5m');
    const stableTtl = priorShort && ttl === '1h' ? '5m' : ttl;
    if (stableTtl === '5m' && (context.laterLongMarker ||
      system.slice(idx + 1).some((b) => isRecord(b) && ephemeralMarker(b)?.ttl === '1h'))) {
      return { system: null, split: false };
    }
    stableBlock.cache_control = { type: 'ephemeral', ttl: stableTtl };
  } else {
    return { system: null, split: false }; // no budget to add one; splitting would gain nothing
  }
  const out = [...system];
  if (after.length > 0) {
    const tailBlock: Record<string, unknown> = { ...block, text: after };
    delete tailBlock.cache_control; // the tail is small per-session content — not worth caching
    out.splice(idx, 1, stableBlock, tailBlock);
    return { system: out, split: true, tailIndex: idx + 1 };
  }
  out.splice(idx, 1, stableBlock);
  return { system: out, split: true };
}

/**
 * WI-10005042 / plan cache-efficiency-and-accounting-2026-09-23 D-078+D-079 — relocate the
 * per-owner system TAIL (launch brief, mode text, instruction-precedence, carry document) out of
 * the system prefix and into the first user turn, right after message 0's FIRST block.
 *
 * WHY. Provider prefix order is tools → system → messages. The per-owner tail sits in system, so
 * it precedes message 0 and every byte after it — including message 0's 138 KB first block, which
 * MEASURED byte-identical across 22/24 owners — can only ever be written inside an owner-unique
 * prefix. Moving the tail behind that shared block makes the shared prefix
 * `tools + system[stable] + msg0.block0` and lets a breakpoint on block 0 turn a per-owner WRITE
 * (~35-40K tokens) into a READ for every same-form, same-tools startup after the first.
 *
 * SEMANTICS (D-079). The relocated text is wrapped in a `<system-reminder>` that states it
 * carries the system prompt's authority. Authority is COMPUTED and enforced at the dispatch seat,
 * never taken from where this text sits (kernel: "Identity text is never an input to authority"),
 * so the move changes no enforced permission; whether the MODEL weights it the same is a QUALITY
 * question this pure function cannot answer — hence DEFAULT OFF ({@link relocateSystemTailEnabled})
 * until a D-073-gated bounded experiment measures it.
 *
 * STATELESS BY DESIGN (R1). Whether the tail moves depends ONLY on the shape of this request
 * body — never on turn number or on the 4-breakpoint budget. If it depended on either, turn 1 and
 * turn 2 of one conversation would lay the prefix out differently and the whole conversation
 * cache would be rewritten at the transition. Only the breakpoint ADD is budget-dependent.
 *
 * FAILS TOWARD NO-OP. Anything it cannot do safely returns `{ relocated:false }` without touching
 * the body: tail not the LAST system block, message 0 not a user turn with an array content,
 * a non-text tail/anchor block, an empty tail.
 */
export const RELOCATED_TAIL_OPEN =
  '<system-reminder>\nOperator launch context — relocated here from the system prompt so the shared ' +
  'prefix above it can be prompt-cached. It carries the SAME authority as the system prompt.\n\n';
export const RELOCATED_TAIL_CLOSE = '\n</system-reminder>';

/** Default OFF: a quality-unproven authority-semantics change gated on a bounded experiment.
 *  `PAPERCUSP_GATEWAY_RELOCATE_SYSTEM_TAIL=1` arms it. One read shared by the gateway and the
 *  cache-proxy (both call `rewriteAnthropicCacheBody`), so the two planes cannot disagree. */
export function relocateSystemTailEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPERCUSP_GATEWAY_RELOCATE_SYSTEM_TAIL === '1';
}

export interface RelocateTailResult {
  relocated: boolean;
  /** Why nothing moved (set only when `relocated` is false). */
  reason?: string;
  breakpoint?: 'added' | 'existing' | 'skipped-budget' | 'skipped-ttl-order';
}

/** Relocate `body.system[tailIndex]` into `body.messages[0]`. Mutates `body` ONLY on success. */
export function relocateSystemTailToFirstUserTurn(
  body: Record<string, unknown>,
  tailIndex: number,
  ttl: string = ANTHROPIC_EXTENDED_TTL,
): RelocateTailResult {
  const no = (reason: string): RelocateTailResult => ({ relocated: false, reason });
  const system = body.system;
  if (!Array.isArray(system)) return no('system-not-array');
  if (tailIndex !== system.length - 1) return no('tail-not-last-system-block');
  const tail = system[tailIndex];
  if (!isRecord(tail) || tail.type !== 'text' || typeof tail.text !== 'string') return no('tail-not-text');
  if (tail.text.trim().length === 0) return no('tail-empty');
  if (isRecord(tail.cache_control)) return no('tail-carries-marker');
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return no('no-messages');
  const first = messages[0];
  if (!isRecord(first) || first.role !== 'user' || !Array.isArray(first.content) || first.content.length === 0) {
    return no('first-message-not-user-array');
  }
  const anchor = first.content[0];
  if (!isRecord(anchor) || anchor.type !== 'text' || typeof anchor.text !== 'string') return no('anchor-not-text');

  const wrapped = { type: 'text', text: RELOCATED_TAIL_OPEN + tail.text + RELOCATED_TAIL_CLOSE };
  const newAnchor: Record<string, unknown> = { ...anchor };
  const newContent = [newAnchor, wrapped, ...first.content.slice(1)];
  const newMessages = [{ ...first, content: newContent }, ...messages.slice(1)];

  // Breakpoint on the shared anchor block. Render order: tools → system(without the tail) →
  // messages, so "before the anchor" is tools + system + nothing in messages.
  let breakpoint: NonNullable<RelocateTailResult['breakpoint']>;
  if (ephemeralMarker(newAnchor)) {
    breakpoint = 'existing';
  } else {
    const trial: Record<string, unknown> = {
      ...body,
      system: system.slice(0, tailIndex),
      messages: newMessages,
    };
    const blocks = cacheableBlocks(trial);
    const markers = blocks.filter((b) => isRecord(b.cache_control)).length + (isRecord(body.cache_control) ? 1 : 0);
    if (markers >= ANTHROPIC_MAX_BREAKPOINTS) {
      breakpoint = 'skipped-budget';
    } else {
      const anchorAt = blocks.indexOf(newAnchor);
      const priorShort = blocks.slice(0, anchorAt).some((b) => ephemeralMarker(b)?.ttl === '5m');
      const anchorTtl = priorShort && ttl === '1h' ? '5m' : ttl;
      const laterLong =
        blocks.slice(anchorAt + 1).some((b) => ephemeralMarker(b)?.ttl === '1h') ||
        ephemeralMarker(body)?.ttl === '1h';
      if (anchorTtl === '5m' && laterLong) {
        breakpoint = 'skipped-ttl-order'; // a short marker may not precede a long one
      } else {
        newAnchor.cache_control = { type: 'ephemeral', ttl: anchorTtl };
        breakpoint = 'added';
      }
    }
  }

  body.system = system.slice(0, tailIndex);
  body.messages = newMessages;
  return { relocated: true, breakpoint };
}

/** Buffer-level wrapper: parse → policy → re-serialize. Returns the ORIGINAL buffer untouched
 *  when the body is not JSON, is not an object, or the policy changed nothing (so a no-op
 *  request forwards byte-identically). Never throws. */
export function rewriteAnthropicCacheBody(
  bodyBuf: Buffer,
  opts: {
    ttl?: string;
    injectToolsBreakpoint?: boolean;
    splitBoundary?: boolean;
    /** WI-10005042: relocate the per-owner system tail behind message 0's shared first block.
     *  Undefined → {@link relocateSystemTailEnabled} (default OFF). Needs `splitBoundary`. */
    relocateSystemTail?: boolean;
    deferLargeTools?: boolean;
    deferMinToolBytes?: number;
  } = {},
): { body: Buffer; stats: AnthropicCacheStats | null } {
  if (!bodyBuf.length) return { body: bodyBuf, stats: null };
  try {
    const parsed = JSON.parse(bodyBuf.toString('utf8')) as unknown;
    if (!isRecord(parsed)) return { body: bodyBuf, stats: null };
    // P-004 split runs BEFORE the ttl/breakpoint policy so the stable half it creates gets the
    // ttl upgrade too. A no-op split leaves the body for the policy alone.
    let splitDone = false;
    let tailReloc: RelocateTailResult | null = null;
    if (opts.splitBoundary) {
      const tools = Array.isArray(parsed.tools) ? parsed.tools.filter(isRecord) : [];
      const outside = cacheableBlocks({ tools: parsed.tools, messages: parsed.messages })
        .filter((b) => isRecord(b.cache_control)).length + (isRecord(parsed.cache_control) ? 1 : 0);
      const requestedTtl = opts.ttl ?? ANTHROPIC_EXTENDED_TTL;
      const priorShort = tools.some((b) => ephemeralMarker(b)?.ttl === '5m');
      const splitTtl = priorShort && requestedTtl === '1h' ? '5m' : requestedTtl;
      // An inserted short system marker must also precede no explicit long
      // message/automatic marker. Existing caller markers are never rewritten.
      const laterLong = cacheableBlocks({ messages: parsed.messages }).some((b) => ephemeralMarker(b)?.ttl === '1h') ||
        ephemeralMarker(parsed)?.ttl === '1h';
      const r = splitSystemAtBoundary(parsed.system, splitTtl, {
        markersOutsideSystem: outside,
        laterLongMarker: laterLong,
      });
      if (r.system) {
        parsed.system = r.system;
        splitDone = r.split;
        // D-078/D-079: chained AFTER the split — it relocates the tail block the split created.
        if (r.tailIndex !== undefined && (opts.relocateSystemTail ?? relocateSystemTailEnabled())) {
          tailReloc = relocateSystemTailToFirstUserTurn(parsed, r.tailIndex, requestedTtl);
        }
      }
    }
    const stats = applyAnthropicCachePolicy(parsed, opts);
    if (stats) stats.boundarySplit = splitDone;
    if (stats && tailReloc) {
      stats.tailRelocated = tailReloc.relocated;
      if (tailReloc.breakpoint) stats.tailBreakpoint = tailReloc.breakpoint;
    }
    if (!stats.changed && !splitDone) return { body: bodyBuf, stats };
    return { body: Buffer.from(JSON.stringify(parsed), 'utf8'), stats };
  } catch {
    return { body: bodyBuf, stats: null };
  }
}

// ── OpenAI / codex ───────────────────────────────────────────────────────────

/**
 * OpenAI splits prompt-cache control by model GENERATION (developers.openai.com prompt-caching
 * guide, read 2026-07-19):
 *  - 'modern' (gpt-5.6+): retention is `prompt_cache_options.ttl` (only '30m' is accepted), cache
 *    WRITES cost 1.25× (no longer free), and explicit `prompt_cache_breakpoint` markers exist.
 *  - 'legacy' (gpt-5.5 and earlier, incl. gpt-5.x, gpt-4.1, gpt-4o): retention is
 *    `prompt_cache_retention: '24h'` and writes are FREE — so retention there is pure upside.
 * Sending the wrong family's parameter is a request error, hence this discriminator.
 */
export type OpenAiCacheGeneration = 'modern' | 'legacy';

/** Parse the `gpt-<major>[.<minor>]` version out of a model id (tolerating suffixes like
 *  `-codex`, `-mini`, dated snapshots). Unrecognized ids are treated as 'legacy' — the
 *  conservative choice, since legacy params are the wider-supported pair. */
export function openAiCacheGeneration(model: unknown): OpenAiCacheGeneration {
  if (typeof model !== 'string') return 'legacy';
  const m = /gpt-(\d+)(?:\.(\d+))?/i.exec(model);
  if (!m) return 'legacy';
  const major = Number(m[1]);
  const minor = Number(m[2] ?? 0);
  if (!Number.isFinite(major)) return 'legacy';
  if (major > 5) return 'modern';
  if (major === 5 && minor >= 6) return 'modern';
  return 'legacy';
}

export interface OpenAiCacheStats {
  changed: boolean;
  generation: OpenAiCacheGeneration;
  /** legacy: prompt_cache_retention was set by us. */
  retentionSet: boolean;
  /** modern: prompt_cache_options.ttl was set by us. */
  ttlSet: boolean;
  /** prompt_cache_key was set by us (routing affinity). */
  cacheKeySet: boolean;
}

/**
 * Apply the fleet prompt-cache policy to a parsed OpenAI request body, IN PLACE.
 *
 * `cacheKey` (P-008) steers prefix-hash ROUTING: OpenAI hashes ~the first 256 tokens to pick a
 * cache shard, and `prompt_cache_key` is combined with that hash — so same-variant sessions
 * sharing a key land on the same shard and share entries. ⚠ The guide caps a single key at
 * ~15 requests/minute before it starts missing, so callers pass a key that already includes a
 * shard bucket (see `shardedCacheKey`).
 */
export function applyOpenAiCachePolicy(
  body: Record<string, unknown>,
  opts: { cacheKey?: string; injectRetention?: boolean } = {},
): OpenAiCacheStats {
  const generation = openAiCacheGeneration(body.model);
  const stats: OpenAiCacheStats = { changed: false, generation, retentionSet: false, ttlSet: false, cacheKeySet: false };

  // The public OpenAI API accepts the generation-specific retention controls below. The
  // ChatGPT-subscription backend does not; its gateway caller disables only this injection
  // while retaining prompt_cache_key affinity and response-side usage telemetry.
  if (opts.injectRetention === false) {
    // Provider-native caching has no request-side retention control on this transport.
  } else if (generation === 'legacy') {
    // Writes are free on this family — extended retention is strictly beneficial.
    if (body.prompt_cache_retention === undefined) {
      body.prompt_cache_retention = '24h';
      stats.retentionSet = true;
      stats.changed = true;
    }
  } else {
    // '30m' is the only accepted value today; writes cost 1.25× here, so this is a real
    // (small) tradeoff rather than free — kept because a 30m floor still beats the 5–10min
    // in-memory eviction a busy shard otherwise gives us.
    const existing = body.prompt_cache_options;
    if (existing === undefined) {
      body.prompt_cache_options = { ttl: '30m' };
      stats.ttlSet = true;
      stats.changed = true;
    } else if (isRecord(existing) && existing.ttl === undefined) {
      existing.ttl = '30m';
      stats.ttlSet = true;
      stats.changed = true;
    }
  }

  if (opts.cacheKey && body.prompt_cache_key === undefined) {
    body.prompt_cache_key = opts.cacheKey;
    stats.cacheKeySet = true;
    stats.changed = true;
  }

  return stats;
}

/**
 * Build a sharded `prompt_cache_key`: `<variant>-<bucket>`. Sharing is maximized by ONE key per
 * variant, but OpenAI degrades a key past ~15 req/min — so we spread across `shards` buckets,
 * chosen by a STABLE hash of `sessionId` (a session keeps its bucket for life, so its own
 * conversation prefix keeps hitting). Fewer shards = more sharing; more shards = more headroom.
 */
export function shardedCacheKey(variant: string, sessionId: string, shards: number): string {
  const n = Number.isFinite(shards) && shards > 0 ? Math.floor(shards) : 1;
  if (n === 1) return `${variant}-0`;
  let h = 2166136261; // FNV-1a — stable across processes (Math.random/hashCode would not be)
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${variant}-${Math.abs(h) % n}`;
}

/** Buffer-level wrapper for the OpenAI path. Same no-op-safety contract as the Anthropic one. */
export function rewriteOpenAiCacheBody(
  bodyBuf: Buffer,
  opts: { cacheKey?: string; injectRetention?: boolean } = {},
): { body: Buffer; stats: OpenAiCacheStats | null } {
  if (!bodyBuf.length) return { body: bodyBuf, stats: null };
  try {
    const parsed = JSON.parse(bodyBuf.toString('utf8')) as unknown;
    if (!isRecord(parsed)) return { body: bodyBuf, stats: null };
    const stats = applyOpenAiCachePolicy(parsed, opts);
    if (!stats.changed) return { body: bodyBuf, stats };
    return { body: Buffer.from(JSON.stringify(parsed), 'utf8'), stats };
  } catch {
    return { body: bodyBuf, stats: null };
  }
}
