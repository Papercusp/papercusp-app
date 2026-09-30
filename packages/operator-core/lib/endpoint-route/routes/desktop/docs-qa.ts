/**
 * POST /api/desktop/docs-qa — retrieval-augmented "Ask a question" over the
 * REAL /internal/docs. Backs BOTH the terminal onboarding tutorial's
 * "Ask a question" and the Ctrl+/ search palette's ask mode. (WI-2844.)
 *
 * WHY THIS EXISTS — the failure it fixes:
 * The tutorial's Q&A used to shell out to a user-installed `claude`/`codex`/
 * `omp` CLI (`which(1)`), which (a) is ABSENT in a clean release build (a fresh
 * user hasn't installed one) → "no agent backend", and (b) even when present, a
 * bare `claude -p` has none of the papercusp docs MCP tools, so it could not
 * actually search our real docs.
 *
 * THE DESIGN — agentic-primary, RAG-fallback (owner-directed 2026-07-06):
 *   PRIMARY (agentic): spawn the operator's configured backend agent with our
 *      REAL docs:search / docs:get / docs:outline MCP tools (buildDocsMcpConfig —
 *      an ISOLATED, builtin-free spawn scoped to docs reads) + the RAW user
 *      question. The agent finds and reads the right /internal/docs pages ITSELF,
 *      then answers. No server-side doc-picking — which used to force a
 *      foundational doc (branding.mdx) into every answer and mislabel concepts by
 *      their skin name ("a Pot is a visual identity" instead of "a project").
 *      Citations come from the pages the agent actually reads (docs:get).
 *   FALLBACK (RAG): when no agentmcp / superuser-token is available (an
 *      unprovisioned build), retrieve in-process (retrieveDocsContext) and ground
 *      a tool-less prompt (composeDocsQaPrompt) so it never hard-fails.
 *   Either path streams the answer over SSE; `needs_backend` (→ Setup) when no
 *   backend is configured at all.
 *
 *   POST /desktop/docs-qa
 *     body { question: string, sectionTitle?: string, docSlugs?: string[], currentPath?: string }
 *     → SSE: citation {slug,title,url} · delta {text} · needs_backend {} ·
 *            error {message} · done {}
 *
 * Gated on FLAGS.DOCS_QA (default ON). OFF ⇒ 404 (keyword search still works).
 * `auth: {}` — matches the sibling /desktop/* endpoints the tutorial runner and
 * the desktop webviews already call.
 */
import { sseResponse } from '@papercusp/sse';
import { defineTool } from '@papercusp/agent-mcp';
import { searchDocs } from '@papercusp/docs-engine';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { engineeringAdapter } from '../../../agent-tools/docs/_engineering-adapter';
import { runAgentChat, type RunAgentChatOptions } from '../../../agent-chat-stream';
import { surfaceBackend, surfaceModel } from '../../../agent-config';
import { claudeSignedIn, codexSignedIn, ompSignedIn } from '../../../agent-auth-detect';
import { activeWorkspaceId } from '../../../workspace-registry';
import { readSystemPrincipal } from '../../../system-principal';
import { operatorApiBase } from '../../../operator-api-base';

const NOT_FOUND = () => new Response(null, { status: 404 });

async function docsQaEnabled(): Promise<boolean> {
  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  return getFlag(FLAGS.DOCS_QA, 'system');
}

/**
 * Is there ANY agent backend the operator can drive a turn on? Reuses the same
 * sign-in detection as /desktop/agent-auth-status (the Setup wizard's llm-auth
 * step). `PAPERCUSP_FAKE_LLM=1` always counts (the deterministic test seam).
 * Kept exported + pure-ish so tests can assert the needs_backend gate.
 */
export function backendAvailable(): boolean {
  if (process.env.PAPERCUSP_FAKE_LLM === '1') return true;
  try { if (claudeSignedIn()) return true; } catch { /* fs error → keep checking */ }
  try { if (codexSignedIn()) return true; } catch { /* */ }
  try { if (ompSignedIn()) return true; } catch { /* */ }
  return false;
}

export const DOCS_QA_MCP_TOOLS = ['docs:search', 'docs:get', 'docs:outline'] as const;

export type DocsQaMcpConfig = {
  mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
};

function readDocsQaSuperuserToken(): string | null {
  try {
    const tokenPath = join(homedir(), '.papercusp', 'superuser-token');
    const token = readFileSync(tokenPath, 'utf8').trim();
    return token.length >= 16 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Build the docs-only MCP surface used by the upcoming agentic docs-QA path.
 * It deliberately reuses the oracle principal/token bridge, but narrows the
 * listed MCP catalog to docs reads so the spawned agent can search and fetch
 * docs without inheriting the broad oracle/operator tool surface.
 */
export async function buildDocsMcpConfig(opts: {
  uiClientId?: string | null;
  baseUrl?: string;
  workspaceId?: string;
  readPrincipal?: typeof readSystemPrincipal;
  readToken?: () => string | null;
} = {}): Promise<DocsQaMcpConfig | null> {
  const readPrincipal = opts.readPrincipal ?? readSystemPrincipal;
  const principal = await readPrincipal('oracle', opts.workspaceId);
  if (!principal?.bearer) return null;
  const superuserToken = opts.readToken ? opts.readToken() : readDocsQaSuperuserToken();
  if (!superuserToken) return null;

  const baseUrl = opts.baseUrl ?? operatorApiBase();
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const toolsParam = DOCS_QA_MCP_TOOLS.join(',');
  const clientParam = opts.uiClientId ? `&client=${encodeURIComponent(opts.uiClientId)}` : '';
  const mcpUrl =
    `${baseUrl}/api/mcp?superuser=1` +
    `&workspace=${encodeURIComponent(workspaceId)}` +
    `&tools=${encodeURIComponent(toolsParam)}` +
    clientParam;

  return {
    mcpServers: {
      agentmcp: {
        command: 'npx',
        args: [
          '-y',
          'mcp-remote@latest',
          mcpUrl,
          '--header',
          `Authorization:Bearer ${superuserToken}`,
        ],
      },
    },
  };
}

export interface DocsContextBlock {
  slug: string;
  title: string;
  url: string;
  text: string;
}

/**
 * Retrieve the doc context for a question: the top keyword hits (excerpt), plus
 * the FULL body of the top `deepen` hits (truncated) for richer grounding, plus
 * any section-linked docSlugs the caller passed. In-process, no MCP. Bounded so
 * the composed prompt stays small.
 */
// Foundational docs seeded into EVERY tutorial/palette retrieval so core-vocabulary
// questions are always grounded, even when keyword search ranks them out. Two pages,
// two complementary jobs (both owner-reported 2026-07-05):
//   - `branding`        — the display LEXICON (Pot=project, Papercup=operator,
//     Mug=brain, …). Without it, "what is a pot" hallucinated.
//   - `harness/glossary` — the authoritative CONCEPT definitions (Harness · one
//     managed work pipeline; Blueprint; Bee; Queen; Work item; Spine; …), each
//     traceable to code. Without it, "what is a harness" force-mapped the concept
//     into the coffee lexicon and wrongly answered "it's the Mug/brain". The glossary
//     gives the model a correct one-line definition for every core term.
// These are always fetched at FULL body (see foundationalBodyChars) so a "what is X"
// question always has X's real definition in context.
export const FOUNDATIONAL_DOC_SLUGS = ['branding', 'harness/glossary'] as const;

export async function retrieveDocsContext(
  question: string,
  opts: { docSlugs?: string[]; limit?: number; deepen?: number; bodyChars?: number; foundationalBodyChars?: number; foundationalSlugs?: readonly string[]; signal?: AbortSignal } = {},
): Promise<DocsContextBlock[]> {
  const limit = opts.limit ?? 6;
  const deepen = opts.deepen ?? 3;
  const bodyChars = opts.bodyChars ?? 2200;
  // Foundational glossary/lexicon docs get a much larger slice so the WHOLE
  // alphabetical glossary survives (a 2200-char cap truncates it around "C" and
  // loses Harness/Queen/Work-item — the very terms newcomers ask about).
  const foundationalBodyChars = opts.foundationalBodyChars ?? 9000;
  const foundational = opts.foundationalSlugs ?? FOUNDATIONAL_DOC_SLUGS;
  const foundationalSet = new Set<string>(foundational);
  const adapter = engineeringAdapter;

  let hits: Array<{ slug: string; url?: string; title?: string; excerpt?: string }> = [];
  try {
    const res = await searchDocs(adapter, { query: question, limit }, opts.signal ? { signal: opts.signal } : {});
    hits = Array.isArray(res?.hits) ? res.hits : [];
  } catch { hits = []; }

  // Seed with section-linked slugs (deduped, first) so the current section is
  // always represented even if it didn't rank for the raw query tokens, then the
  // foundational lexicon doc(s), then the ranked search hits.
  const orderedSlugs: string[] = [];
  const seen = new Set<string>();
  for (const s of opts.docSlugs ?? []) {
    if (s && !seen.has(s)) { seen.add(s); orderedSlugs.push(s); }
  }
  for (const s of foundational) {
    if (s && !seen.has(s)) { seen.add(s); orderedSlugs.push(s); }
  }
  // Auto-generated index/listing pages (reference/*-index, …) are just tables of
  // links with no real prose — they add noise to the prompt and, worse, PRIME the
  // model to confabulate: an index that merely LISTS `hive:declare-wake` is what led
  // Opus to invent a non-existent `pot:declare-wake` for "what's a pot" (owner-
  // reported 2026-07-05b). Drop them from the ranked search hits (never from the
  // intentional foundational/section-linked seeds above).
  const isNoiseSlug = (slug: string): boolean => /(^|\/)[a-z0-9-]*-index$/i.test(slug);
  for (const h of hits) {
    if (h.slug && !seen.has(h.slug) && !isNoiseSlug(h.slug)) { seen.add(h.slug); orderedSlugs.push(h.slug); }
  }

  const blocks: DocsContextBlock[] = [];
  let deepened = 0;
  for (const slug of orderedSlugs) {
    const hit = hits.find((h) => h.slug === slug);
    let title = hit?.title ?? slug;
    let url = hit?.url ?? `/internal/docs/${slug}`;
    let text = hit?.excerpt ?? '';
    const isFoundational = foundationalSet.has(slug);
    // Foundational glossary/lexicon docs are ALWAYS fetched at full body (never a thin
    // excerpt) with a larger cap. Other blocks: fuller body for the first `deepen`, or
    // whenever the excerpt was empty.
    if (isFoundational || deepened < deepen || !text) {
      try {
        const page = await adapter.getPage(slug);
        if (page) {
          title = page.title || title;
          url = page.url || url;
          const body = await adapter.getContent(page);
          if (body) {
            text = body.replace(/\s+/g, ' ').trim().slice(0, isFoundational ? foundationalBodyChars : bodyChars);
            if (!isFoundational) deepened += 1;
          }
        }
      } catch { /* keep the excerpt */ }
    }
    if (text) blocks.push({ slug, title, url, text });
    if (blocks.length >= limit) break;
  }
  return blocks;
}

/** Compose the grounded, retrieval-augmented prompt. Pure — unit-tested. */
export function composeDocsQaPrompt(
  question: string,
  ctx: { sectionTitle?: string; currentPath?: string; blocks: DocsContextBlock[] },
): string {
  const docBlock = ctx.blocks.length
    ? ctx.blocks
        .map((b) => `### ${b.title} (/internal/docs/${b.slug})\n${b.text}`)
        .join('\n\n')
    : '(no closely-matching pages were retrieved — answer from your general knowledge of Papercusp instead)';
  const section = ctx.sectionTitle
    ? `The user is currently reading the "${ctx.sectionTitle}" section of the onboarding tutorial.\n`
    : ctx.currentPath
      ? `The user is currently on: ${ctx.currentPath}\n`
      : '';
  // Prompt intent. Two owner-reported failure classes this guards against:
  //  (2026-07-05a) answers read like a canned "static search" that deflects with
  //    "the documentation excerpt provided doesn't cover this" — fixed by the
  //    knowledgeable-teammate framing + general-knowledge fallback + the ban on
  //    leaking the retrieval mechanism.
  //  (2026-07-05b) even a strong model (Opus) CONFABULATES for a NEWCOMER: it
  //    invents verb names (`pot:declare-wake`), fabricates deprecation histories,
  //    and dumps retired internals (main-loop.ts, _retired/…) that a first-time
  //    user neither needs nor can trust. Fixed by: newcomer calibration, a
  //    lead-with-a-plain-definition rule, an explicit ban on inventing
  //    tool/verb/path/flag names or histories not present verbatim in the
  //    reference, and a ban on volunteering internal/retired detail unprompted.
  return (
    'You are a knowledgeable Papercusp teammate helping a user during onboarding. ' +
    'Answer their ONE question directly, helpfully, and in a natural voice — the way ' +
    'a colleague who knows the product well would explain it out loud.\n\n' +
    section +
    '\n## Reference material (your primary source of truth)\n\n' +
    `${docBlock}\n\n` +
    '## How to answer\n\n' +
    'You are talking to a NEWCOMER still learning Papercusp. Give them the plain, ' +
    'current, user-facing answer — not an internals tour.\n\n' +
    '- For a "what is X" question, LEAD with ONE plain sentence defining X in everyday ' +
    'terms, then add at most 2–3 short sentences of the most useful context. Keep the ' +
    'whole answer brief; stop when the question is answered.\n' +
    '- CRITICAL: many core terms name a PRODUCT CONCEPT first and are ALSO the label of a ' +
    'visual theme / branding / lexicon skin. "Pot" is primarily a PROJECT (the top-level ' +
    'thing you create and run agents in) and only incidentally the name of the default ' +
    'lexicon; "Swarm" is a concept and also a skin name; etc. Define the PRODUCT CONCEPT — ' +
    'what X IS and what it does for the user — and do NOT lead by calling X a "visual ' +
    'identity", "branding", "theme", "skin", "look and feel", "vocabulary", or "lexicon" ' +
    'unless the user EXPLICITLY asked about appearance or branding. If a reference page is ' +
    'about branding/skins, use it only for the term’s display name, never as the ' +
    'definition of what the concept IS.\n' +
    '- Answer immediately, with no preamble. You have NO tools and cannot look anything ' +
    'up — never narrate a process or say "let me check" / "let me confirm".\n' +
    '- Ground every factual claim in the reference material above. Do NOT invent tool, ' +
    'command, or verb names (anything shaped like `x:y`), file paths, flags, or feature/' +
    'deprecation histories that do not appear verbatim above — if you are unsure a ' +
    'specific technical detail is real, LEAVE IT OUT. A short answer with no invented ' +
    'specifics is far better than a longer one that guesses.\n' +
    '- Do NOT volunteer internal implementation detail, source-file paths, code ' +
    'identifiers, or deprecated/retired/historical features unless the user explicitly ' +
    'asks — a newcomer does not need them, and they are the #1 thing that makes an ' +
    'answer feel wrong.\n' +
    '- Where the reference is thin, still give the best genuinely useful answer you can ' +
    'from it plus your general knowledge of Papercusp — do NOT refuse, stall, or dead-end.\n' +
    '- NEVER mention "the excerpts", "the provided documentation", "the retrieved ' +
    'docs", or that anything was looked up — the user cannot see any of that. Just ' +
    'answer as if you simply know it.\n' +
    '- When a specific page backs your answer, cite it inline by its ' +
    '`/internal/docs/<slug>` path so the user can read more.\n' +
    '- Only if the question is genuinely outside Papercusp entirely, say what you do ' +
    'know and point to the nearest area — never reply that "the docs don\'t cover this".\n\n' +
    `## Question\n\n${question}`
  );
}

/**
 * System prompt for the AGENTIC path: the agent has our real docs:search /
 * docs:get tools and finds + reads the right pages ITSELF, instead of being
 * force-fed a server-picked doc set (owner-directed 2026-07-06). Same answer
 * shaping as composeDocsQaPrompt (newcomer calibration, concept-first,
 * anti-confabulation, no retrieval leakage) — but retrieval is the agent's job.
 */
export function composeAgenticDocsSystemPrompt(ctx: { sectionTitle?: string; currentPath?: string }): string {
  const section = ctx.sectionTitle
    ? `The user is currently reading the "${ctx.sectionTitle}" section of the onboarding tutorial.\n`
    : ctx.currentPath
      ? `The user is currently on: ${ctx.currentPath}\n`
      : '';
  return (
    'You are a knowledgeable Papercusp teammate helping a user during onboarding. ' +
    'Answer their ONE question directly, helpfully, and in a natural voice — the way ' +
    'a colleague who knows the product well would explain it out loud.\n\n' +
    section +
    '\n## Finding the answer\n\n' +
    'You have Papercusp documentation-search tools scoped to Papercusp’s OWN docs. ' +
    'CRITICAL: every `docs:search`, `docs:get`, and `docs:outline` call MUST include the ' +
    'argument `harness: "all"` — that is what points the tools at the Papercusp framework ' +
    'docs. Omit it and the call is REJECTED with `harness_required` and you get nothing ' +
    'back. Before you answer:\n' +
    '1. Call `docs:search { harness: "all", query: <the user’s question> }`; if the first ' +
    'results look thin, refine the query and search again (still passing `harness: "all"`).\n' +
    '2. Read the most relevant page(s) with `docs:get { harness: "all", slugs: [...] }` ' +
    'before answering — always try `harness/glossary` when the question is "what is X" for ' +
    'a short/ambiguous term, since it is the authoritative one-line definition for every ' +
    'core Papercusp term.\n' +
    '3. Base your answer on what those real pages actually say.\n' +
    '4. Do ALL of your searching and reading FIRST, back-to-back, with NO text output ' +
    'in between tool calls — never narrate what you are about to do ("let me check…", ' +
    '"I need to…", "let me try…"). Only after you are done searching do you write your ' +
    'one final answer, as plain running text. Any words you emit before your last tool ' +
    'call are shown directly to the user as your answer, so a mid-search narration line ' +
    'IS a broken, confusing answer — never emit one.\n' +
    '- Many short, everyday-sounding words (bee, pot, mug, queen, hive, cup, swarm, …) ' +
    'are ALSO first-class Papercusp product terms with a specific meaning here. When the ' +
    'question is "what is X" for one of these, ALWAYS assume the Papercusp meaning is ' +
    'wanted and search/ground your answer in the docs — do NOT answer with the generic ' +
    'dictionary/everyday meaning of the word instead of looking it up.\n\n' +
    '## How to answer\n\n' +
    'You are talking to a NEWCOMER still learning Papercusp. Give the plain, current, ' +
    'user-facing answer — not an internals tour.\n' +
    '- Your docs tools are ALWAYS pre-scoped to Papercusp’s own docs via `harness: "all"`. ' +
    'NEVER ask the user which harness, project, workspace, or scope they are in, and NEVER ' +
    'tell them you lack access, permissions, or context — if any tool call returns ' +
    '`harness_required` or a scope/permission error, just RETRY the SAME call with ' +
    '`harness: "all"` added. A newcomer cannot answer a scope question and must never see one.\n' +
    '- For a "what is X" question, LEAD with ONE plain sentence defining X in everyday ' +
    'terms (what it IS and does for the user), then at most 2–3 short sentences of the ' +
    'most useful context. Keep it brief; stop when the question is answered.\n' +
    '- CRITICAL: many core terms name a PRODUCT CONCEPT and are ALSO the label of a ' +
    'visual theme / branding / lexicon skin. "Pot" is primarily a PROJECT (the top-level ' +
    'thing you create and run agents in) and only incidentally the name of the default ' +
    'lexicon; "Swarm" is a concept and also a skin name. Define the PRODUCT CONCEPT — and ' +
    'do NOT lead by calling X a "visual identity", "branding", "theme", "skin", "look and ' +
    'feel", "vocabulary", or "lexicon" unless the user EXPLICITLY asked about appearance ' +
    'or branding. A page that is about branding/skins gives you the term’s display name, ' +
    'never the definition of what the concept IS.\n' +
    '- Ground every factual claim in the docs you read. Do NOT invent tool, command, or ' +
    'verb names (anything shaped like `x:y`), file paths, flags, or feature/deprecation ' +
    'histories that the docs do not state — if unsure, LEAVE IT OUT.\n' +
    '- Do NOT volunteer internal implementation detail, source-file paths, code ' +
    'identifiers, or deprecated/retired features unless the user explicitly asks.\n' +
    '- Answer immediately, in a natural voice. NEVER mention "the docs", "the search", ' +
    'or that you looked anything up — the user cannot see any of that; just answer as if ' +
    'you simply know it. No "let me check", no preamble.\n' +
    '- When a specific page backs your answer, cite it inline by its `/internal/docs/<slug>` path.\n' +
    '- If the docs are thin, still give the best genuinely useful answer you can from them ' +
    'plus your general knowledge of Papercusp — do NOT refuse, stall, or dead-end.'
  );
}

/** Doc slugs the agent chose to READ (docs:get) — surfaced to the UI as citations. */
export function slugsFromDocsToolCall(name: string, input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const i = input as Record<string, unknown>;
  const out: string[] = [];
  const push = (v: unknown) => { if (typeof v === 'string' && v.trim()) out.push(v.trim()); };
  if (name === 'docs:get' || name.endsWith('docs:get')) {
    push(i.slug);
    if (Array.isArray(i.slugs)) for (const s of i.slugs) push(s);
  }
  return out;
}

/**
 * Buffers agentic-path answer text and discards it whenever a tool call
 * lands — the model can still narrate ("let me search…") between tool calls
 * despite composeAgenticDocsSystemPrompt's no-preamble instruction, since a
 * system prompt is a request, not an enforcement mechanism. Mechanically
 * suppresses that narration: only the text segment that survives to
 * `flush()` with no further tool call after it is ever forwarded to the
 * client (WI-3218).
 */
export function createAgenticAnswerBuffer() {
  let buf = '';
  return {
    delta(text: string): void {
      buf += text;
    },
    toolCall(): void {
      buf = '';
    },
    flush(): string {
      const out = buf;
      buf = '';
      return out;
    },
  };
}

const docsQa = defineTool({
  method: 'POST',
  path: '/desktop/docs-qa',
  auth: {},
  // Pure SSE transport — don't flood route_invocations per question.
  sampleRate: 0,
  async handler(req) {
    if (!(await docsQaEnabled())) return NOT_FOUND();
    const body = await req.json().catch(() => ({}));
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) return Response.json({ error: 'question required' }, { status: 400 });
    const sectionTitle = typeof body.sectionTitle === 'string' ? body.sectionTitle : undefined;
    const currentPath = typeof body.currentPath === 'string' ? body.currentPath : undefined;
    const docSlugs = Array.isArray(body.docSlugs)
      ? body.docSlugs.filter((s: unknown): s is string => typeof s === 'string').slice(0, 8)
      : [];

    return sseResponse({
      signal: req.signal,
      setup: async (sink) => {
        // No configured backend → tell the caller to set one up (route to Setup).
        if (!backendAvailable()) {
          sink.event('needs_backend', {
            message:
              'No agent backend is configured yet. Sign in to an agent (Claude, Codex, or OMP) ' +
              'in Setup to ask questions — keyword search works without one.',
          });
          sink.close();
          return;
        }

        const backend = await surfaceBackend('oracle');
        const model = await surfaceModel('oracle');

        // PRIMARY: agentic retrieval. Give the agent our real docs:search /
        // docs:get tools + the RAW question and let it find + read the right
        // pages itself (owner-directed 2026-07-06). This removes the
        // deterministic-RAG failure where a force-injected foundational doc
        // (branding.mdx) framed a concept by its skin name ("a Pot is a visual
        // identity"). FALLBACK: the in-process RAG path when no agentmcp /
        // superuser-token is available (unprovisioned build), so it never
        // hard-fails.
        const mcpConfig = await buildDocsMcpConfig({ uiClientId: null });
        const agentic = mcpConfig !== null;
        // Observability: which retrieval path served this question (agentic vs RAG fallback).
        console.log(`[docs-qa] path=${agentic ? 'agentic' : 'rag'} q=${JSON.stringify(question).slice(0, 100)}`);

        // NEVER hang the caller: a HARD cap + a FIRST-TOKEN cap degrade a stalled
        // backend to an `error` instead of an infinite spinner (owner-reported
        // 2026-07-05). Agentic runs make docs:search tool calls BEFORE the first
        // answer token, so the first-token deadline is RE-ARMED on each tool_call
        // (the agent is making progress) and the caps are larger. Chains off
        // req.signal so a client disconnect still tears the spawn down.
        const ac = new AbortController();
        const onReqAbort = () => ac.abort();
        req.signal?.addEventListener('abort', onReqAbort);
        const HARD_MS = agentic ? 150_000 : 90_000;
        const FIRST_TOKEN_MS = agentic ? 60_000 : 35_000;
        let sawDelta = false;
        const hardTimer = setTimeout(() => ac.abort(), HARD_MS);
        let firstTokenTimer: ReturnType<typeof setTimeout> | null = null;
        const armFirstToken = () => {
          if (firstTokenTimer) clearTimeout(firstTokenTimer);
          firstTokenTimer = setTimeout(() => {
            if (!sawDelta) ac.abort();
          }, FIRST_TOKEN_MS);
        };
        const clearFirstToken = () => {
          if (firstTokenTimer) {
            clearTimeout(firstTokenTimer);
            firstTokenTimer = null;
          }
        };
        armFirstToken();

        // Assemble the run options for whichever path is available.
        let runOpts: RunAgentChatOptions;
        if (mcpConfig) {
          runOpts = {
            systemPromptText: composeAgenticDocsSystemPrompt({ sectionTitle, currentPath }),
            promptText: question,
            ...(model ? { model } : {}),
            ...(backend ? { backend } : {}),
            mcpConfig,
            allowedTools: DOCS_QA_MCP_TOOLS.map((t) => `mcp__agentmcp__${t}`),
            toolEventFilter: (raw: string) =>
              raw.startsWith('mcp__agentmcp__') ? raw.slice('mcp__agentmcp__'.length) : null,
            isolateConfig: true,
            disallowBuiltins: true,
            permissionMode: 'bypassPermissions',
            signal: ac.signal,
          };
        } else {
          // Fallback: retrieve in-process + ground a tool-less prompt.
          let blocks: DocsContextBlock[] = [];
          try {
            blocks = await retrieveDocsContext(question, { docSlugs, signal: req.signal });
          } catch { blocks = []; }
          for (const b of blocks) sink.event('citation', { slug: b.slug, title: b.title, url: b.url });
          runOpts = {
            promptText: composeDocsQaPrompt(question, { sectionTitle, currentPath, blocks }),
            ...(model ? { model } : {}),
            ...(backend ? { backend } : {}),
            allowedTools: [],
            permissionMode: 'bypassPermissions',
            signal: ac.signal,
          };
        }
        // gateway-priority-tiers (WI-4542): docs-qa is a synchronous human-waiting stream (the
        // tutorial's "Ask a question" / Ctrl+/ search palette) — tag it 'interactive' so it rides
        // the protected tier-1 admission lane instead of the untagged default band, on EITHER path.
        runOpts.priority = 'interactive';

        const citedSlugs = new Set<string>();
        let answerText = '';
        const citeSlug = (slug: string) => {
          const clean = slug.replace(/[).,;:]+$/, '').trim();
          if (clean && !citedSlugs.has(clean)) {
            citedSlugs.add(clean);
            sink.event('citation', { slug: clean, title: clean, url: `/internal/docs/${clean}` });
          }
        };
        // Agentic path only: buffer + discard-on-tool_call so narration text
        // the model emits between tool calls never reaches the client (see
        // createAgenticAnswerBuffer). The RAG fallback path never emits
        // tool_call events, so it is unaffected and keeps streaming live.
        const agenticBuffer = createAgenticAnswerBuffer();
        try {
          for await (const ev of runAgentChat(runOpts)) {
            if (ev.type === 'delta') {
              if (!sawDelta) {
                sawDelta = true;
                clearFirstToken();
              }
              if (agentic) {
                agenticBuffer.delta(ev.text);
              } else {
                answerText += ev.text;
                sink.event('delta', { text: ev.text });
              }
            } else if (ev.type === 'tool_call') {
              // The agent is searching/reading — progress. Re-arm the first-token
              // deadline so a multi-search turn is never killed early, and surface
              // the pages it actually reads (docs:get) as citations.
              if (!sawDelta) armFirstToken();
              if (agentic) agenticBuffer.toolCall();
              for (const slug of slugsFromDocsToolCall(ev.name, ev.input)) citeSlug(slug);
            } else if (ev.type === 'error') {
              sink.event('error', { message: ev.message });
            }
          }
          if (agentic) {
            const flushed = agenticBuffer.flush();
            if (flushed) {
              answerText += flushed;
              sink.event('delta', { text: flushed });
            }
          }
        } catch (err) {
          // A client disconnect (req.signal) also lands here via ac — only
          // surface an error if the client is still listening.
          if (!req.signal?.aborted) {
            sink.event('error', {
              message: ac.signal.aborted
                ? "The docs assistant timed out. It may be rate-limited — try again, or check that you're signed in under Setup."
                : err instanceof Error
                  ? err.message
                  : String(err),
            });
          }
        } finally {
          clearTimeout(hardTimer);
          clearFirstToken();
          req.signal?.removeEventListener('abort', onReqAbort);
        }
        // Best-effort citations from pages the agent referenced inline in its
        // answer (it retrieves via docs:search/outline, which don't carry a slug
        // on the tool_call event). Deduped against any docs:get citations above.
        for (const m of answerText.matchAll(/\/internal\/docs\/([a-z0-9][a-z0-9/_-]*)/gi)) {
          citeSlug(m[1]);
        }
        if (!sawDelta && !req.signal?.aborted && !ac.signal.aborted) {
          // Backend produced nothing (auth expired, crashed) — give the caller a
          // graceful, non-empty signal to fall back on.
          sink.event('error', {
            message: 'The agent did not return an answer. It may be rate-limited or need re-authentication in Setup.',
          });
        }
        sink.close();
      },
    });
  },
});

export default docsQa;
