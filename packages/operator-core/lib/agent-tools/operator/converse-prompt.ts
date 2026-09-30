/**
 * Prompt composition for the operator:converse tool. Moved out of
 * apps/operator/app/api/agent-mcp/operator-converse/route.ts so the
 * tool can call it directly and stay self-contained for IPC dispatch.
 *
 * The prompt assembles:
 *   - operator.converse.md + operator.persona.md (role docs)
 *   - per-tool catalog (renderToolsCatalog) — only the operator-visible
 *     tools, both _ and . name forms (claude-code vs registry)
 *   - operator.tools.md (cross-tool playbook)
 *   - mem0 pre-turn user/workspace memory (best-effort)
 *   - history-budget-trimmed conversation transcript
 *   - modality + trigger + may_ask_active hint sections
 */

import { selectHistoryWithinBudget } from '../../operator-converse-history';
import { loadVoicePrefs } from '../../voice-prefs';
import { ALL_AGENT_MCP_TOOLS } from '../../operator-mcp-tools';
import {
  loadRolePersona,
  loadRoleModePersona,
  loadRoleToolsMd,
  loadRoleConverse,
  renderToolsCatalog,
  type Role,
} from '../../prompt-assembly';
import { buildMemoryContextBlock, lastUserContext } from '../../memory/injection';
import { activeWorkspaceId } from '../../workspace-registry';
import { loadHarnessRegistry } from '../../harness-registry';
import {
  buildPlanContextSection,
  buildWorkItemDossierSections,
  CONTEXT_SECTION_BUDGET_MS,
  renderUiContextSection,
  withTimeoutBudget,
} from '../../chat-context-sections';
import type { ConverseHostTrust } from './converse-toolset';

export interface ConverseInput {
  messages?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  trigger?: 'user_message' | 'quiet_wait_resume' | 'open_canvas' | 'user_says_ready' | 'user_welcomed' | 'continue' | 'sentinel_scan';
  welcomed_user?: { display_name?: string };
  mayAskActive?: boolean;
  modality?: 'voice' | 'text';
  /** Which persona the converse brain assumes — the Sentinel re-home seam.
   *  Defaults to 'operator' (fully backward-compatible). 'sentinel' loads
   *  the Sentinel persona set (sentinel.persona[.<mode>-mode].md / .converse.md /
   *  .tools.md) instead, so the SAME brain becomes the always-on voice-first
   *  Sentinel. Constrained to PROMPT_ROLES (the roles with a persona set under
   *  apps/operator/prompts/); an unknown role would throw in loadRolePersona. */
  role?: Role;
  /** Who the operator is talking to. Controls the persona overlay injected
   *  as the first system section. Defaults to 'engineer'. */
  audienceMode?: 'engineer' | 'novice';
  /** Which rendering surface this turn is for. 'desktop' (web/Tauri UI, the
   *  default) vs 'tui' (the pui terminal workbench). The PERSONA is identical
   *  across surfaces (one role, one persona — tui-operator-surface D-001); only
   *  surface-appropriate AFFORDANCES are injected per turn (D-003). */
  surface?: 'desktop' | 'tui';
  /** The pui's workbench owner key (its tui_dispatch client_id), passed through
   *  on TUI turns so the affordance block can name the exact target. */
  uiClientId?: string;
  /** The shared PG conversation this turn belongs to. When present (desktop /
   *  device / TUI surfaces all send it) and the workspace runs in 'compaction'
   *  context mode, the prompt gains the rolling summary of every turn older
   *  than the verbatim window (operator-context-compaction-2026-06-05).
   *  Absent (legacy voice ask_operator, llm-testing) ⇒ window-only behavior. */
  conversationId?: string;
  /** WI-5071 session reuse: relocate the per-turn-VARYING memory recall (and
   *  the sentinel read-context) from the SYSTEM sections into the USER
   *  sections. A resumed claude session needs a byte-stable system prompt —
   *  both so the systemHash invalidation check compares persona/catalog
   *  changes (not every turn's fresh recall) and so the Anthropic prompt-cache
   *  prefix survives across turns. Default false ⇒ byte-identical legacy
   *  layout (memory in system). */
  memoryInUser?: boolean;
  /** Who is on the other end of this turn (papercup-chat-one-component-one-
   *  contract-2026-09-06 P-005, D-007 §2). 'owner' (default — byte-identical
   *  legacy) = the workspace owner's desktop / TUI / device: every context
   *  section. 'public' = the portal behind its per-user boundary: ONLY what
   *  that boundary allows — memory scoped to the signed-in user, the UI context
   *  the surface sent — never the workspace-internal sentinel/fleet digest, the
   *  bound work-item's dossier / plan context, or the server-resolved subject
   *  record. */
  hostTrust?: ConverseHostTrust;
  /** The hosting surface's current UI context (the agent-chats seam's
   *  `body.context`, ≤ UI_CONTEXT_MAX_CHARS). Orientation data, never
   *  authority — rendered as one quoted JSON string. */
  uiContext?: string;
  /** The tool surface this turn actually has (allowed-tools or colon form).
   *  The catalog advertises EXACTLY this set so listed == callable on both
   *  trusts. Default: ALL_AGENT_MCP_TOOLS (the owner working set). */
  toolNames?: readonly string[];
}

export interface ConverseSessionUser {
  id: string;
  username: string;
  display_name: string;
  has_password: boolean;
}

export interface BuiltOperatorPrompt {
  /** Persona + tool catalog + tool playbook + memory. The stable spec
      sent as omp's --system-prompt so the model assumes the Operator
      identity rather than meta-commenting on it. */
  systemPromptText: string;
  /** This turn's context: conversation history + modality + trigger
      + may_ask_active hint. Sent as the positional user message so
      omp's chat loop sees it as the user's turn. */
  userPromptText: string;
  /** WI-5071: `userPromptText` MINUS the history-carrying sections
      (compacted summary + verbatim transcript) — the prompt for a turn on a
      RESUMED claude session, which already holds the prior turns verbatim.
      Equal to `userPromptText` when the turn had no history sections. */
  userPromptTextDelta: string;
}

export async function buildOperatorPrompt(
  input: ConverseInput,
  sessionUser: ConverseSessionUser | null,
): Promise<BuiltOperatorPrompt> {
  // Sub-phase timing (reply-latency instrumentation, grade-loop 2026-07-16):
  // buildOperatorPrompt was measured at ~18s of a ~22s turn (turn-timings
  // buildPromptMs) with no visibility into WHICH phase pays it. One log line
  // per turn; grep `prompt-phases` in the operator log.
  const tP0 = Date.now();
  const prefs = await loadVoicePrefs().catch(() => null);
  const budget = prefs?.operatorHistoryTokenBudget ?? 40000;
  const messages = selectHistoryWithinBudget(
    (input.messages ?? []).filter(
      (m) => m && typeof m.role === 'string' && typeof m.content === 'string',
    ),
    budget,
  );

  // Rolling conversation summary (operator-context-compaction-2026-06-05).
  // In 'compaction' mode (the default) the verbatim window above stays the
  // recency floor and the PG-stored summary of everything older rides as a
  // separate section — so the brain remembers the gist of the WHOLE
  // conversation. Best-effort: no conversationId / no summary yet / a read
  // failure all degrade to exactly the legacy window behavior.
  const contextMode = prefs?.operatorContextMode ?? 'compaction';
  // A scoped client sends only the conversation id. Resolve the bound subject
  // on the server and keep this lookup concurrent with the existing summary /
  // memory gathers so work-item context does not add a serial prompt phase.
  // Host trust (D-007 §2): 'owner' is the byte-identical legacy layout; 'public'
  // keeps every workspace-internal section out of the prompt (see ConverseInput).
  const hostTrust: ConverseHostTrust = input.hostTrust === 'public' ? 'public' : 'owner';
  const subjectContextPromise: Promise<string | null> = input.conversationId && hostTrust === 'owner'
    ? import('../../operator-conversation-subject')
        .then(({ buildOperatorConversationSubjectContext }) =>
          buildOperatorConversationSubjectContext(
            input.conversationId!,
            activeWorkspaceId(),
          ),
        )
        .catch((err) => {
          console.warn(
            '[converse-prompt] conversation subject read failed (omitting the section):',
            err instanceof Error ? err.message : String(err),
          );
          return null;
        })
    : Promise.resolve(null);
  // P-005 (D-007 §2): the agent-chats seam's work-item dossier + in-flight
  // checkpoint + plan-context sections, keyed off the conversation's work-item
  // binding (the seam's `chat.feature_id`), built by the SAME shared builders
  // (chat-context-sections.ts). Owner trust only — a public user's per-user
  // boundary does not extend to workspace work-item state. Kicked off here so
  // it runs concurrently with the summary / memory / sentinel gathers; every
  // leg is best-effort and budgeted, so a miss degrades the sections, never
  // the turn.
  //
  // ONE dynamic import of the conversations module, shared by this leg and the
  // rolling-summary read below. Two CONCURRENT `import()`s of the same
  // vi.mock'd module race inside vitest's mocker and the loser is handed the
  // REAL module (measured 2026-09-06: the summary read opened a live PG pool
  // under converse-prompt-compaction.test.ts while this leg got the mock).
  // Created only when a consumer below will await it (so a rejected import is
  // always caught by that consumer, never an unhandled rejection).
  const conversationsModule =
    input.conversationId && (hostTrust === 'owner' || contextMode === 'compaction')
      ? import('../../operator-conversations')
      : null;
  const boundItemContextPromise: Promise<{ dossier: string[]; plan: string | null }> =
    conversationsModule && hostTrust === 'owner'
      ? (async () => {
          try {
            const { getConversationById } = await conversationsModule;
            const ws = activeWorkspaceId();
            const conv = await getConversationById(input.conversationId!, ws);
            if (!conv || conv.subjectKind !== 'work-item' || !conv.harnessSlug || !conv.subjectRef) {
              return { dossier: [], plan: null };
            }
            const [dossier, plan] = await Promise.all([
              buildWorkItemDossierSections({ workspaceId: ws, harness: conv.harnessSlug, workItemId: conv.subjectRef }),
              withTimeoutBudget(
                buildPlanContextSection({ harness: conv.harnessSlug, workItemId: conv.subjectRef }),
                CONTEXT_SECTION_BUDGET_MS,
              ),
            ]);
            return { dossier, plan: plan ?? null };
          } catch {
            /* best-effort — the brain still has its read tools */
            return { dossier: [], plan: null };
          }
        })()
      : Promise.resolve({ dossier: [], plan: null });
  let compactedSummary: string | null = null;
  if (contextMode === 'compaction' && input.conversationId && conversationsModule) {
    try {
      const { readConversationSummary } = await conversationsModule;
      const s = await readConversationSummary(input.conversationId);
      if (s?.summaryText && s.summaryText.trim()) compactedSummary = s.summaryText.trim();
    } catch (err) {
      console.warn(
        '[converse-prompt] summary read failed (window fallback):',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  const tHistSummary = Date.now();
  const modality: 'voice' | 'text' = input.modality === 'voice' ? 'voice' : 'text';
  const trigger = input.trigger ?? 'user_message';
  const mayAskActive = !!input.mayAskActive;
  const audienceMode = input.audienceMode ?? 'engineer';
  // The persona the brain assumes — the Sentinel re-home seam. Defaults
  // to 'operator' (byte-identical to the pre-seam behavior); 'sentinel' loads the
  // Sentinel persona set instead. The catalog/playbook stay role-keyed too so each
  // persona gets its own tools.md.
  const role: Role = input.role ?? 'operator';

  // SYSTEM sections (stable persona spec — set as omp --system-prompt)
  const systemSections: string[] = [];

  // Audience-mode overlay first — frames who the user is before shared rules.
  const modeOverlay = loadRoleModePersona(role, audienceMode);
  if (modeOverlay) {
    systemSections.push(modeOverlay);
  } else {
    console.warn(`[converse-prompt] No audience identity found for role="${role}" audienceMode="${audienceMode}" — blueprints/${role}.audience-${audienceMode}/prompts/audience.md is installed in no tier of the prompt chain (identities-v1 P-021).`);
  }

  systemSections.push(loadRoleConverse(role));
  systemSections.push(loadRolePersona(role));

  // Look the catalog up by the colon MCP-catalog name (the registry key), but
  // DISPLAY the underscore form below — Claude Code sanitizes the colon out of
  // an MCP tool name (`harness:status` → `harness_status`) before handing it to
  // the model, so the catalog must advertise the name the model actually sees
  // (voice-persona P-005). The earlier dotted-variant entries were dead: they
  // never matched the colon-keyed registry, so they only ever rendered nothing.
  // The set this TURN actually has (converse.ts selects it per role + trust and
  // passes it in) — the owner working set when the caller gave none.
  const operatorToolNames = (input.toolNames ?? ALL_AGENT_MCP_TOOLS).map((fullName) =>
    fullName.replace(/^mcp__agentmcp__/, ''),
  );
  const toClaudeName = (mcpName: string): string => mcpName.replace(/:/g, '_');
  // Phase 4 T3.1: pass modality so the catalog filters out tools
  // that don't declare 'voice' support when this turn is voice-side.
  // Today chat_ask_choice is the load-bearing example — buttons are
  // invisible to a voice user, so the tool declares modality:['text']
  // and gets dropped from the voice catalog automatically (replaces
  // the manual NOTE in the trigger sections below).
  const catalog = renderToolsCatalog(role, operatorToolNames, modality, toClaudeName);
  if (catalog) systemSections.push(catalog);

  // Tool-calling contract (voice-persona P-005/P-009). The brain runs on
  // claude-code with a SMALL, directly-loaded MCP surface — the catalog above
  // is every tool it has, already loaded, NOT deferred. The historical failure
  // mode was the brain `ToolSearch`-ing colon names (`harness:status`) that
  // never resolved (claude-code presents the sanitized underscore form), firing
  // 4+ searches per turn and occasionally looping to the wall-clock cap. This
  // note + the underscore-named catalog close that gap.
  systemSections.push(
    `## Calling tools\n\n` +
      `Every tool you can call is listed in **Available tools** above — they are ` +
      `ALREADY LOADED and ready to call directly. Three hard rules:\n` +
      `- **Never call \`ToolSearch\`.** Your tools are not deferred; searching ` +
      `finds nothing new and wastes the turn. Just call the tool.\n` +
      `- **Use the exact catalog name — underscores, never colons.** It is ` +
      `\`harness_status\`, not \`harness:status\`; \`chat_ask_choice\`, not ` +
      `\`chat:ask_choice\`. Don't retry name variants; the catalog name is the ` +
      `only form that resolves.\n` +
      `- **The catalog is your ENTIRE tool surface — there are no built-ins.** ` +
      `You have no \`Bash\`, no \`Task\`, no file or shell access, and they will ` +
      `not work if you try. Never emit a \`Bash(...)\` call as a comment or ` +
      `no-op. If no catalog tool does what you need, say so in your \`<say>\` ` +
      `instead of improvising a tool.` +
      (hostTrust === 'public'
        ? `\n- **This is a PUBLIC surface.** The catalog above is the complete set ` +
          `for this host; a tool named anywhere else in these instructions but ` +
          `absent from the catalog does not exist here — never try it, say what ` +
          `you cannot do instead.`
        : ''),
  );

  const playbook = loadRoleToolsMd(role);
  if (playbook) systemSections.push(playbook);
  const tPersona = Date.now();

  // Operator memory pre-turn injection — best-effort, via the shared
  // helper. Same source of truth as architect/brainstorm prompts; each
  // surface picks its own user/workspace scope.
  // Falls through silently when mem0 is unavailable.
  // Operator chat has no specific harness in scope, so fan out the
  // memory recall across every harness in the workspace. Failures
  // here are non-fatal — the injection helper is best-effort.
  let harnessSlugs: string[] = [];
  if (hostTrust === 'owner') {
    try {
      const reg = await loadHarnessRegistry(activeWorkspaceId());
      harnessSlugs = reg.projects.map((p) => p.slug);
    } catch { /* leave empty — recall just skips the harness pool */ }
  }
  // Kicked off WITHOUT awaiting — the sentinel read-context below is an
  // independent gather, and the two were measured SEQUENTIAL at ~11.3s +
  // ~11.6s (prompt-phases, 2026-07-16), the dominant phases of a ~23s prompt
  // build on a ~22s p50 turn. Running them in parallel halves the prompt-build
  // wall clock; section ORDER in the prompt is unchanged (memory is pushed
  // before sentinel below).
  //
  // P-010: the build sits behind the operator SWR cache with the caller's wait
  // deadline-capped (getMemoryBlockBounded). buildMemoryContextBlock's internal
  // 5s per-op cap saturated on every search miss on a loaded box (pass-7 drill:
  // searchMs 5001–5114) — a typed turn paid 5s AND injected nothing. Now a turn
  // serves the previous build instantly (soft TTL 0 ⇒ always revalidate with
  // THIS turn's query in background) or gives up the section after the cold
  // deadline; a sentinel_scan turn has no human waiting, so it takes a generous
  // deadline and warms the cache for typed turns instead.
  //
  // Public trust (D-007 §2): recall is scoped to the signed-in user ONLY — no
  // harness / hive pools (harnessSlugs stays empty above; hiveSlugs suppressed
  // below) — and there is NO recall at all without a user: an anonymous public
  // turn must never read anyone's memory.
  const memBlockPromise: Promise<string | null> = (async () => {
    if (hostTrust === 'public' && !sessionUser?.id) return null;
    try {
      const { getMemoryBlockBounded } = await import('../../memory/injection-block-cache');
      // Stale recall must never bleed across a different role/trust/user/conversation.
      const memScopeKey = `${role}:${hostTrust}:${sessionUser?.id ?? 'anon'}:${input.conversationId ?? 'window'}`;
      return await getMemoryBlockBounded(
        activeWorkspaceId(),
        memScopeKey,
        () =>
          buildMemoryContextBlock({
            userId: sessionUser?.id ?? null,
            workspaceId: activeWorkspaceId(),
            harnessSlugs,
            ...(hostTrust === 'public' ? { hiveSlugs: [] } : {}),
            queryContext: lastUserContext(messages, 3),
            // The Sentinel's recall heading mirrors the operator one but names its own role
            // so an injected fact reads as the Sentinel's memory, not "Operator memory".
            ...(role === 'papercup' ? { heading: 'Sentinel memory (relevant entries)' } : {}),
          }),
        input.trigger === 'sentinel_scan' ? { deadlineMs: 60_000 } : undefined,
      );
    } catch (err) {
      console.warn(
        '[converse-prompt] memory block build failed (omitting the section):',
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  })();

  // SENTINEL read-context. The Sentinel watches the WHOLE
  // system, so it walks in already understanding the live state — escalations,
  // anomalies, progress, "what's worth surfacing" — built from the READY-MADE
  // digests (curation:feed salience ranking, the Overwatch anomaly brief, the
  // state-of-pot corpus digest, the live fleet), NOT re-derived from raw coord.
  // GUARDED on role==='sentinel' so the operator path is byte-identical (it never
  // gathers, never imports the sentinel module). Fail-soft: a gather error degrades
  // to no section — the turn never blocks on it (mirrors the memory block above).
  // Owner trust only: the fleet/anomaly digest is workspace-internal state
  // (D-007 §2 — never crosses the public per-user boundary).
  const sentinelBlockPromise: Promise<string | null> =
    role === 'papercup' && hostTrust === 'owner'
      ? (async () => {
          try {
            // Cached + deadline-bounded (P-009, evidence EI-13193): the raw gather
            // measured ~6.5–10.8s per turn with no bound — the dominant prompt-build
            // phase once WI-5094 killed the memory-embed cost. getSentinelBlockBounded
            // serves fresh/stale from the operator SWR cache and caps a cold miss at
            // SENTINEL_BLOCK_COLD_DEADLINE_MS (section omitted this turn; the
            // single-flight build serves the next). A sentinel_scan turn has no human
            // waiting, so it takes a generous deadline and warms the cache for typed
            // turns instead.
            const { getSentinelBlockBounded } = await import('../../papercup/sentinel-block-cache');
            const wsId = activeWorkspaceId();
            // The primary hive the anomalies leg addresses: the first registered harness
            // in the workspace (the operator chat has no single harness in scope).
            // Best-effort — an empty pool falls back to the workspace id.
            const primaryHive = harnessSlugs[0] ?? wsId;
            return await getSentinelBlockBounded(
              wsId,
              primaryHive,
              async () => {
                const { gatherSentinelContext, renderSentinelContext, buildSentinelContextDeps, sentinelScopeLabel } =
                  await import('../../papercup/papercup-context');
                const { isWorkspaceCoordinationOn } = await import('../../workspace-brain-scope');
                // Heading scope LABEL: when the workspace-brain re-key is ON the summary's
                // digest legs already span every hive (D-008), so present it as
                // workspace-scoped rather than mislabeled with one harness. OFF =
                // byte-identical (the primary hive). Only the LABEL changes — the anomalies
                // leg's potSlug (overwatch addressing) stays primaryHive.
                const scopeLabel = sentinelScopeLabel(wsId, primaryHive, await isWorkspaceCoordinationOn());
                const ctxInput = await gatherSentinelContext(buildSentinelContextDeps(wsId, primaryHive), { potSlug: scopeLabel });
                const ctxBlock = renderSentinelContext(ctxInput);
                return ctxBlock.trim() ? ctxBlock : null;
              },
              input.trigger === 'sentinel_scan' ? { deadlineMs: 60_000 } : undefined,
            );
          } catch (err) {
            console.warn(
              '[converse-prompt] sentinel read-context build failed (omitting the section):',
              err instanceof Error ? err.message : String(err),
            );
            return null;
          }
        })()
      : Promise.resolve(null);

  const memBlock = await memBlockPromise;
  const memoryInUser = !!input.memoryInUser;
  if (memBlock && !memoryInUser) systemSections.push(memBlock);
  const tMem = Date.now();

  const sentinelBlock = await sentinelBlockPromise;
  if (sentinelBlock && !memoryInUser) systemSections.push(sentinelBlock);
  const tSentinel = Date.now();

  const subjectContextBlock = await subjectContextPromise;
  const tSubject = Date.now();

  const boundItemContext = await boundItemContextPromise;
  const uiContextBlock = renderUiContextSection(input.uiContext);
  const tContext = Date.now();

  // USER sections (this turn's context — sent as the positional message).
  // historySections carry the conversation PAST (rolling summary + verbatim
  // transcript window). A RESUMED claude session already holds those turns
  // natively, so the delta prompt (userPromptTextDelta) omits exactly this
  // list and nothing else (WI-5071).
  const historySections: string[] = [];
  const userSections: string[] = [];

  if (compactedSummary) {
    historySections.push(
      `## Earlier conversation (compacted)\n\n` +
        `The verbatim transcript below covers only recent turns. Everything ` +
        `earlier was compacted into this rolling summary — treat it as your ` +
        `memory of the older conversation (decisions, preferences, named ` +
        `artifacts, open threads):\n\n${compactedSummary}`,
    );
  }

  if (messages.length > 0) {
    const transcript = messages
      .map((m) => `[${m.role}]\n${m.content}`)
      .join('\n\n');
    historySections.push(`## Conversation history (oldest first; last ${messages.length} turns)\n\n${transcript}`);
  }

  // WI-5071 delta-only tail: the CURRENT user utterance reaches the brain via
  // the history transcript above (its last [user] entries) — the trigger
  // section only says "the user just said something", it never carries the
  // text. A resumed session already holds every PRIOR turn but has not seen
  // the messages since its last reply, so the delta prompt must carry exactly
  // that tail (everything after the last assistant message) or the brain gets
  // a turn with no utterance at all. Full-prompt turns skip this section —
  // the transcript already contains the tail.
  const newTurnMessages = (() => {
    let lastAssistant = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        lastAssistant = i;
        break;
      }
    }
    return messages.slice(lastAssistant + 1);
  })();
  const deltaOnlySections: string[] = [];
  if (newTurnMessages.length > 0) {
    deltaOnlySections.push(
      `## New message(s) this turn\n\n` +
        newTurnMessages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n'),
    );
  }

  // WI-5071: with memoryInUser the varying recall blocks ride in the USER
  // prompt (present in BOTH the full and delta variants) so the system
  // prompt stays byte-stable for session reuse + prompt-cache hits.
  if (memoryInUser && memBlock) userSections.push(memBlock);
  if (memoryInUser && sentinelBlock) userSections.push(sentinelBlock);
  // Always a USER section: the canonical work-item state can change between
  // turns, and resumed brain sessions must receive the fresh record in their
  // delta prompt too. Global conversations return null and stay byte-identical.
  if (subjectContextBlock) userSections.push(subjectContextBlock);
  // P-005 (D-007 §2): the seam's sections in the seam's order — the dossier
  // (+ in-flight checkpoint) LEADS the task framing, then plan context, then
  // the surface's UI context. USER sections, like the subject record: they vary
  // per turn, and a resumed brain session must receive the fresh record in its
  // delta prompt too. Empty on a global conversation / public trust.
  for (const section of boundItemContext.dossier) userSections.push(section);
  if (boundItemContext.plan) userSections.push(boundItemContext.plan);
  if (uiContextBlock) userSections.push(uiContextBlock);

  const triggerLines: Record<NonNullable<ConverseInput['trigger']>, string> = {
    user_message: `Trigger: user_message — the user just said something. React per the ladder.

OUTPUT-SHAPE CHECK: if your reply would name 2 or more options and ask the user to choose, do NOT write it as prose — CALL chat_ask_choice with those options as buttons (2-3 typical, 6 max; mark a recommended pick with style: 'primary'). The buttons ARE the question: no prose option list, no trailing "Which?". This applies to ANY pick-one shape, including "give me options", "what should I do next", and your own idea of offering alternatives.

WORKED EXAMPLE — user says "What should I focus on next? Give me a few concrete options to pick from":
  ✅ chat_ask_choice({ question: "What next?", options: [
       { id: "stall", label: "Unstick the placement stall", style: "primary" },
       { id: "rubric", label: "Grade the overdue release rubric" },
       { id: "esc", label: "Triage the aging escalations" }] })
  ❌ <say>"Three picks: the stall, the rubric, or the escalations. Which?"</say>   ← WRONG — a prose dead-end with nothing to click (WI-4950). Call the tool instead.`,
    quiet_wait_resume: 'Trigger: quiet_wait_resume — the user just re-engaged after a long silence. Reference where you left off in your first sentence, then continue the thread.',
    continue: `Trigger: continue — you emitted \`<continue/>\` on the prior turn, signaling more user-visible progress. Pick up where you left off.

You may emit another \`<continue/>\` if the multi-step work isn't done yet — narrate progress in a \`<say>\` before the tag. When the task is finished, end naturally (no \`<continue/>\` on the last turn) and the runtime will auto-scan in active mode.

If you realize the work is actually complete and there's nothing more to narrate, end with a brief terminal \`<say>\` summarizing what's done. Do not loop on no-op continues.`,
    open_canvas: `Trigger: open_canvas — fresh chat with no prior history.

STEP 1: Use MCP tools (harness_list / harness_status / issues_list / harness_escalation / harness_pending_reviews / audit_list) AND/OR your full conversation history above to find what's actionable.

STEP 2: Decide the OUTPUT SHAPE — cards or text. **PREFER CARDS.**

CARDS (use this whenever possible) — emit \`chat_ask_choice\` if you can name ≥2 distinct things the user could pick between. Includes:
  - 2 named items + "something else" (3 options total) ← THIS COUNTS, use cards
  - 3 active threads (use 3 options, no "other")
  - 2 specific escalations to triage
Button labels ≤80 chars. ≤3 options total. Mark one option with style: 'primary' if you have a recommended pick. The buttons ARE the prompt; do NOT also write the question as text. chat_ask_choice BLOCKS until the user picks — you'll receive {picks:[{option_id,label},...]} as the tool result and can react to it in the same turn.

WORKED EXAMPLE — DO emit cards for this:
  User's last context: "rust port and marketplace pipeline were both active."
  ✅ chat_ask_choice({ question: "Pick up where you left off?", options: [
       { id: "rust", label: "Check rust port status", style: "primary" },
       { id: "marketplace", label: "Check marketplace pipeline" },
       { id: "other", label: "Something else" }] })
  ❌ <say>"Want to check status on one, or pick something else?"</say>   ← AMBIGUOUS, USE CARDS

TEXT (fallback) — use plain <say> ONLY when:
  - There is exactly ONE obvious action ("Sheets has 3 escalations — open the latest?")
  - The situation is genuinely open-ended discussion (no comparables exist)
  - Fresh install / nothing set up: "Nothing set up here yet. Want to create your first harness?"

FORBIDDEN: generic greetings like "Hi, what can I help with" / "How can I help you today" / "Let me know what you need" — never start that way regardless of card vs text.

NOTE: chat_ask_choice works in both text and voice. Voice users hear fallbackText (the question + options) and click on the chat surface. For voice-answerable cards (the silence-nudge Ready card sets voiceAnswerable:true), the user can also speak their pick.`,

    user_says_ready: `Trigger: user_says_ready — the user is open to suggestions. Fires from THREE entry points:
  (a) the user typed "ready" / "next" / "what now?" / "go"
  (b) the user clicked "Generate ideas" in the chat composer
  (c) you just finished a task in active mode and the runtime auto-fired this trigger to check what's actionable next

ALL THREE entry points expect the same behavior: do investigation in THIS ONE TURN (multi-tool MCP calls within a single turn are fine and expected — no need to chain), and produce one of:

  - \`chat_ask_choice\` with 2-3 specific options the user could pick next
  - \`<sleep duration_minutes="N"/>\` if there is genuinely nothing worth surfacing right now (entry point (c) only — for (a) and (b) the user explicitly asked, so always produce a card or short concrete answer)

**Do NOT emit \`<continue/>\` from this trigger.** Idle-scan work is one turn. Do not auto-execute side-effecting actions from this trigger — surface the suggestion as a card and let the user approve.

**Do NOT emit a terminal \`<say>\` without a card AND without a \`<sleep>\`.** That would loop back into another auto-fire. Either emit a card OR a sleep — never bare text from an entry-point-(c) auto-fire.

STEP 1: Re-read the full history above for specific scope ("remember yesterday's X", "continue with Y"). If no specific reference, use MCP tools (harness_list / harness_status / issues_list / harness_escalation / harness_pending_reviews) to find what's actionable. All within this turn.

STEP 2: Emit a card. **PREFER CARDS for this trigger** — when you have 2-3 distinct things to surface, the card is the right output. Button labels ≤80 chars. ≤3 options. Mark one option with style: 'primary' if you have a recommended pick.

WORKED EXAMPLE:
  Recent thread mentioned: sheets escalation, marketplace pipeline.
  ✅ chat_ask_choice({ question: "What's the priority?", options: [
       { id: "sheets", label: "Look at sheets escalation", style: "primary" },
       { id: "market", label: "Resume marketplace pipeline" },
       { id: "wiki", label: "Decide what to do with wiki" }] })
  ❌ <say>"Want to look at sheets, or maybe the marketplace?"</say>   ← USE CARDS

NOTE: chat_ask_choice works in both text and voice. Voice users hear the question + option labels as a spoken list and click on screen.`,

    user_welcomed: `Trigger: user_welcomed — the user just logged in${input.welcomed_user?.display_name ? ` as **${input.welcomed_user.display_name}**` : ''}. Open with a warm, NAMED greeting in your FIRST SENTENCE (e.g. "Welcome back, ${input.welcomed_user?.display_name ?? 'there'}.").

Then deliver substance via the same suggestions flow as user_says_ready: use MCP tools (harness_list / harness_status / issues_list / harness_escalation / harness_pending_reviews) to find what's actionable, emit chat_ask_choice with ≤3 options when you have distinct comparables, or plain <say> with a single concrete suggestion otherwise.

NEVER say "Hi, what can I help with" or any generic greeting — always anchor on a concrete fact + a concrete option.

NOTE: chat_ask_choice works in both text and voice. Voice users hear the question + option labels as a spoken list and click on screen.`,

    sentinel_scan: `Trigger: sentinel_scan — a PROACTIVE Sentinel sweep. NO human spoke; the server-side voice-host woke you on a timer to decide whether anything in the live system is worth surfacing RIGHT NOW. This is the Sentinel's "decide to speak" moment.

You are looking at the FLEET-STATUS context above (anomalies / live signals / standing patterns / fleet progress). Decide, with a HIGH bar, whether ONE thing genuinely deserves a spoken interruption:

  - If something is salient (a fresh blocker, a critical anomaly, a decision waiting on the human), emit ONE brief \`<say>\` surfacing the SINGLE most important item — calm, one fact, offer to go deeper ("…want the details?"). Voice constraints apply (≤220 chars, one <say>, plain language, grounded in the context — never invent).
  - If nothing rises to the bar, stay SILENT: emit NO \`<say>\` at all (an empty / tag-only turn). Silence is the correct and common outcome — a confused Sentinel that narrates noise is worse than one that waits.

Do NOT emit \`<continue/>\` from this trigger — a sweep is one turn. Do NOT ask a question or open a card unless a genuine decision is waiting on the human. Surface FLEET status, never the old operator workspace-suggestions flow.`,
  };

  userSections.push(
    `## Modality\n\nOutput surface: **${modality}**.\n\n` +
      (modality === 'voice'
        ? 'You are speaking to a voice user — every <say> is read aloud by TTS, so brevity is a HARD constraint, not a style preference. (1) EXACTLY ONE <say> per turn — only the FIRST <say> is ever spoken, so a second one (even reworded) is dead text; never restate or rephrase a <say> you already emitted this turn. LENGTH: ≤220 characters HARD / 1–2 short sentences — aim under 180; if you are near the cap, cut a clause rather than squeeze. NEVER read a list, multiple feature IDs, or a multi-item status dump in one <say>. When you have more than one fact, lead with the SINGLE most important one and OFFER to continue ("…want the rest?") — put the remainder in a later turn or a card, never in a longer <say>. If you also emit a card this turn, your <say> is ONLY a brief lead-in ("Which one?") — every option, candidate, and detail lives IN the card, NEVER spilled into a second <say>; a second <say> is dead text the user never hears. (2) ONE QUESTION per turn — never stack two. (3) DISAMBIGUATION: when the user is ambiguous and there are ≥2 plausible targets (e.g. "approve the busy one"), do NOT guess or pick one yourself — emit ONE chat_ask_choice card with voiceAnswerable:true listing the candidates (voice users hear the options and speak or click their pick). Disambiguate FIRST: at most 1-2 quick lookups to NAME the candidates, then the card — never sweep every status surface before asking. The card replaces speech — pair it with at most a short lead-in <say> ("Which one?"), NEVER a spoken list of the same options. CALL the chat_ask_choice tool for real — never write the call out as text or a code block in your reply; written-out calls do nothing and the user sees raw code. Even when your lookup identifies ONE clear best candidate for an indirect reference ("the busy one"), confirm it VIA A CARD (your pick as the primary option, the runner-up second) — never via a bare spoken yes/no question; the card is what a voice user can answer hands-free. A plain <say> with no card is acceptable only when the user named the target explicitly and unambiguously. chat_ask_choice supports ≤6 short options. (4) GROUNDED: never state a count or status before the tool result that supports it has come back — call the tool first, then speak the result; never invent a number and silently correct it next turn (if you have not fetched the COMPLETE set, say you are still getting the full count rather than guess a number you will have to revise). Speak ONLY what a tool result literally contains — never embellish with a mechanism, root cause, failure mode, or system/store name you did not read from a result (do NOT explain WHY a bug happens or name the component involved unless a tool result said so). Equally: never name or act on a project, harness, or work item that neither the user nor a tool result has surfaced in this conversation — if you are not sure it exists, look it up first. If a tool call fails or returns nothing, SAY you could not check ("I\'m having trouble reading that right now") — never substitute a guess, and never keep revising your story turn over turn. (5) PLAIN LANGUAGE — say only what a non-engineer can hear and act on. NEVER read aloud: internal jargon or raw IDs (not "F-FMT-002 dash-delimited parsing" / "dig the chunks"), AND code, shell commands, environment-variable names or their literal values, config/file syntax, URLs, or anything backtick-quoted — a voice user hears "heroku config colon set DATABASE underscore URL equals…" as gibberish. When the honest answer needs a literal command, snippet, path, or value, DESCRIBE the step in plain words ("set it in your hosting environment settings") and OFFER to send the exact text in writing ("want the exact command typed in the chat?") — never speak the literal in your <say>. (This is about WORDING, not output shape: it does NOT mean emit a card — keep your normal single-<say> turn.) Say what a thing means ("the formatting fix", "the items waiting on you"), never the symbol itself.'
        : 'You are talking to a user reading the chat sidebar. PICK-ONE RULE: whenever your reply would name 2 or more options and ask the user to choose, you MUST CALL chat_ask_choice to render clickable buttons. Never enumerate choices in prose and end with "which?" or another free-text pick-one question. The buttons replace the prose list. Use plain <say> text only when the response is informational or the question is genuinely open-ended.'),
  );

  // Per-surface affordances (tui-operator-surface D-003). The persona is the
  // same across desktop and TUI; only the surface-appropriate control tools are
  // injected per turn. On the TUI the web UI is absent, so steer the brain to
  // the pui control surface (tui_dispatch) and away from web-only affordances.
  if (input.surface === 'tui') {
    const clientId = typeof input.uiClientId === 'string' && input.uiClientId.trim()
      ? input.uiClientId.trim()
      : null;
    const clientLine = clientId
      ? `Its \`client_id\` is **${clientId}** — pass that to every tui_dispatch call.`
      : 'Resolve its `client_id` with `tui_list_clients` if you need to target it (usually your turn already carries it).';
    userSections.push(
      `## Surface — terminal workbench (pui)\n\n` +
        `You are speaking through the **pui terminal workbench**, NOT the desktop web UI. ${clientLine}\n\n` +
        `Drive this surface with the \`tui_dispatch\` tool (the TUI analogue of \`ui_dispatch\`). Intents:\n` +
        `- \`open_chat\` ({}) — focus this operator chat pane.\n` +
        `- \`set_tab\` ({tab:"Operator"|"Plans"|"Inbox"|"Sessions"|"Harnesses"|"Docs"|"Activity"|"Testing"|"Config"|"Plugins"|"Settings"|"Fleet"}) — switch the workbench tab; e.g. set_tab "Sessions" or "Fleet" to show the live fleet.\n` +
        `- \`set_harness\` ({slug}) — change the active harness.\n` +
        `- \`select\` ({list, index}) — move a selection within a tab's list.\n` +
        `- \`focus_pane\` ({pane_id}) — focus a worker's zellij pane (pane ids come from \`get_state\`).\n` +
        `- \`get_state\` ({}) — read the workbench state (active tab, selections, counts, live panes).\n\n` +
        `Rules for this surface: (1) prefer \`tui_dispatch\` over \`ui_dispatch\` — the web UI isn't present here. ` +
        `(2) For a yes/no, accept/reject, or pick-one-of decision, CALL \`chat_ask_choice\` — the terminal renders it as an inline card the user answers with arrow/number keys, and the tool returns the pick (same as the desktop). Use plain \`<say>\` text only for open-ended questions. ` +
        `(3) Keep \`<say>\` concise — it renders in a terminal pane.`,
    );
  }

  userSections.push(`## Trigger\n\n${triggerLines[trigger]}`);

  if (mayAskActive) {
    userSections.push(`## [may_ask_active]\n\nThe runtime allows you to ask "Do you want me to go back into active mode?" at the end of your reply this turn — turns_in_last_2_min ≥ 3 AND sleep timer expired. Use only if it fits.`);
  }

  // Closing nudge so the model knows the spec ends and it should act now.
  // Text modality carries a FINAL pick-one self-check at maximum salience (the
  // very end of the prompt): the mid-prompt PICK-ONE RULE alone was empirically
  // ignored on trigger=user_message (WI-4950 re-repro 2026-07-16).
  userSections.push(
    modality === 'text'
      ? 'Respond now per your operator instructions and trigger above. FINAL CHECK before you emit: if your reply enumerates two or more options and asks the user to pick, you MUST call chat_ask_choice with those options instead — on this surface a prose option list is a dead-end with nothing to click.'
      : 'Respond now per your operator instructions and trigger above.',
  );

  console.log(
    `[converse-prompt] prompt-phases historySummaryMs=${tHistSummary - tP0} ` +
      `personaCatalogMs=${tPersona - tHistSummary} memoryMs=${tMem - tPersona} ` +
      `sentinelMs=${tSentinel - tMem} subjectMs=${tSubject - tSentinel} ` +
      `contextMs=${tContext - tSubject} renderMs=${Date.now() - tContext} ` +
      `role=${role} trust=${hostTrust}`,
  );

  return {
    systemPromptText: systemSections.join('\n\n---\n\n'),
    userPromptText: [...historySections, ...userSections].join('\n\n---\n\n'),
    userPromptTextDelta: [...deltaOnlySections, ...userSections].join('\n\n---\n\n'),
  };
}

export type { ConverseInput as OperatorConverseInput };
