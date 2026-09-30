/**
 * P-019: promote:plan block handler.
 *
 * Parses the body of a ```promote:plan fenced block emitted by the
 * architect and creates a real plan by calling plans:new → plans:set-now
 * → plans:add-item × N → plans:add-decision × N in sequence.
 *
 * Exposed as the `plans:apply-plan-block` tool, reachable from the UI
 * via POST /api/admin/plans/apply-plan-block with body { blockContent }.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { handleHttpToolRequest } from '@papercusp/agent-mcp';
import { PROJECTED_DEPS } from '../../projected-tool-deps';
import { trackDetached } from '../../detached-imports';

/* ── Block parser ─────────────────────────────────────────────────── */

export interface ParsedPlanBlock {
  title: string;
  status: 'draft';
  summary: string;
  nowState: string;
  nowNext: string;
  phases: Array<{
    name: string;
    items: Array<{ text: string; blockedBy: string[] }>;
  }>;
  decisions: Array<{ title: string; body: string }>;
}

/**
 * Parse the raw body of a ```promote:plan block into a structured
 * representation. Returns null if the block is malformed.
 *
 * Expected format:
 * ```
 * TITLE: Short imperative title
 * STATUS: draft
 * SUMMARY: 1–3 sentences.
 * ---
 * ## Now
 *
 * **State:** One paragraph.
 * **Next:** One sentence.
 *
 * ## Phase 1 — Name
 *
 * - [ ] P-001 Item text
 *
 * ## Decisions
 *
 * ### D-001: Decision title
 * Rationale body.
 * ```
 */
export function parsePlanBlock(blockContent: string): ParsedPlanBlock | null {
  // Split on the first `---` line that separates header metadata from markdown body.
  const sepIdx = blockContent.indexOf('\n---\n');
  if (sepIdx === -1) return null;

  const headerRaw = blockContent.slice(0, sepIdx);
  const bodyRaw = blockContent.slice(sepIdx + 5); // skip "\n---\n"

  // Parse header key: value lines.
  const header: Record<string, string> = {};
  for (const line of headerRaw.split('\n')) {
    const m = /^([A-Z]+):\s*(.*)$/.exec(line.trim());
    if (m) header[m[1]] = m[2].trim();
  }

  const title = header['TITLE'];
  const summary = header['SUMMARY'] ?? '';
  if (!title) return null;

  // Parse Now block: **State:** ... **Next:** ...
  const nowMatch = /##\s+Now\b([\s\S]*?)(?=\n##\s|\s*$)/.exec(bodyRaw);
  let nowState = '';
  let nowNext = '';
  if (nowMatch) {
    const nowBody = nowMatch[1];
    const stateM = /\*\*State:\*\*\s+([\s\S]*?)(?=\n\*\*Next:\*\*|$)/.exec(nowBody);
    const nextM = /\*\*Next:\*\*\s+([\s\S]*?)(?=\n\*\*|$)/.exec(nowBody);
    nowState = stateM ? stateM[1].trim() : '';
    nowNext = nextM ? nextM[1].trim() : '';
  }

  // Parse phases: ## Phase N — Name sections.
  const phases: ParsedPlanBlock['phases'] = [];
  const phaseRE = /^##\s+(?:Phase\s+\d+\s*—\s*|Phase\s+\d+\s*[-–]\s*|Phase\s+\d+\s+)(.+)$/gm;
  const phaseMatches = Array.from(bodyRaw.matchAll(phaseRE));

  for (let i = 0; i < phaseMatches.length; i++) {
    const m = phaseMatches[i];
    const phaseName = `Phase ${i + 1} — ${m[1].trim()}`;
    const start = (m.index ?? 0) + m[0].length;
    const end =
      i + 1 < phaseMatches.length
        ? phaseMatches[i + 1].index ?? bodyRaw.length
        : bodyRaw.length;
    const phaseBody = bodyRaw.slice(start, end);

    const items: Array<{ text: string; blockedBy: string[] }> = [];
    for (const line of phaseBody.split('\n')) {
      // Match checklist items: - [ ] P-NNN text (blockedBy P-NNN, P-NNN)
      const itemM = /^-\s+\[[ x]\]\s+(?:P-\d{3,}\s+)?(.+)$/.exec(line.trim());
      if (!itemM) continue;
      let text = itemM[1].trim();
      const blockedBy: string[] = [];
      // Extract trailing "(blockedBy P-001, P-002)" annotation if present.
      const bbM = /\(blockedBy\s+(P-\d{3,}(?:,\s*P-\d{3,})*)\)$/.exec(text);
      if (bbM) {
        for (const ref of bbM[1].split(/,\s*/)) blockedBy.push(ref.trim());
        text = text.slice(0, bbM.index).trim();
      }
      if (text) items.push({ text, blockedBy });
    }
    if (items.length > 0) phases.push({ name: phaseName, items });
  }

  // Parse Decisions section: split on `### D-NNN:` headers.
  const decisions: ParsedPlanBlock['decisions'] = [];
  const decSectionM = /##\s+Decisions\b([\s\S]*)$/.exec(bodyRaw);
  if (decSectionM) {
    const decBody = decSectionM[1];
    // Split on lines that start a new ### D-NNN decision entry.
    const segments = decBody.split(/\n(?=###\s+D-\d{3,})/);
    for (const seg of segments) {
      const headerM = /^###\s+D-\d{3,}[:\s]+(.+)\n([\s\S]*)$/.exec(seg.trim());
      if (!headerM) continue;
      const dTitle = headerM[1].trim();
      const dBody = headerM[2].trim();
      if (dTitle && dBody) decisions.push({ title: dTitle, body: dBody });
    }
  }

  return {
    title,
    status: 'draft',
    summary,
    nowState,
    nowNext,
    phases,
    decisions,
  };
}

/* ── Orchestrator ─────────────────────────────────────────────────── */

const HOST_EXTRAS = {
  deps: PROJECTED_DEPS,
  log: () => {},
  validateSuperuser: () => true,
};

function buildAdminSp(harnessSlug?: string): URLSearchParams {
  const sp = new URLSearchParams({ superuser: '1', client: 'pc-admin-plan-block' });
  // R3-C: pass harness so ctx.harnessSlug is set on the dispatched tool
  // call. Without this, plans:new resolves to the primary harness and
  // the architect's plan lands in the wrong harness's plans dir.
  if (harnessSlug && harnessSlug.trim()) sp.set('harness', harnessSlug.trim());
  return sp;
}

async function callTool(
  verb: string,
  body: Record<string, unknown>,
  harnessSlug?: string,
): Promise<unknown> {
  const res = await handleHttpToolRequest(
    {
      method: 'POST',
      pathname: `/api/agent-tools/plans/${verb}`,
      searchParams: buildAdminSp(harnessSlug),
      headers: {},
      body,
    },
    HOST_EXTRAS,
  );
  if (res.status !== 200) {
    const b = res.body as Record<string, unknown> | undefined;
    const msg =
      (b?.error as string | undefined) ?? `plans:${verb} returned ${res.status}`;
    throw new Error(msg);
  }
  const b = res.body as { content?: Array<{ type: string; text?: string }> };
  const text = b.content?.find((c) => c.type === 'text')?.text ?? '{}';
  const parsed = JSON.parse(text) as Record<string, unknown>;
  // R21: MCP tools wrap their errors in { ok: false, error: '...' } inside
  // a 200 envelope. Surface those as throws so partial-failure plan creation
  // aborts cleanly (plan stays in draft state on disk per the documented
  // rollback contract) instead of silently succeeding with missing items.
  if (parsed && parsed.ok === false) {
    const err = typeof parsed.error === 'string' ? parsed.error : `plans:${verb} reported ok:false`;
    const code = typeof parsed.code === 'string' ? ` (${parsed.code})` : '';
    throw new Error(`${err}${code}`);
  }
  return parsed;
}

/**
 * Apply a parsed plan block: create the plan and populate it.
 * Returns { ok, slug } on success; throws on any tool failure.
 *
 * Rollback strategy: if any step after `plans:new` fails, the plan
 * file is left in its partial state (an empty template or with whatever
 * succeeded). This is safe because the plan is `status: draft` and not
 * yet in any queue. The caller can delete or ignore it.
 */
export async function applyPlanBlock(
  parsed: ParsedPlanBlock,
  harnessSlug?: string,
): Promise<{ slug: string }> {
  // 1. Create the plan stub.
  const newResult = (await callTool('new', {
    slug: toKebab(parsed.title),
    title: parsed.title,
    status: 'draft',
  }, harnessSlug)) as { ok?: boolean; slug?: string; error?: string };

  if (!newResult.ok || !newResult.slug) {
    throw new Error(newResult.error ?? 'plans:new failed');
  }
  const slug = newResult.slug;

  // 2. Set the Now block.
  if (parsed.nowState || parsed.nowNext) {
    await callTool('set-now', {
      slug,
      state: parsed.nowState || 'Plan freshly created by architect.',
      next: parsed.nowNext || 'Human reviews plan and approves.',
    }, harnessSlug);
  }

  // 3. Add items phase-by-phase.
  for (const phase of parsed.phases) {
    for (const item of phase.items) {
      await callTool('add-item', {
        slug,
        harness: harnessSlug || 'all',
        phase: phase.name,
        text: item.text,
        blockedBy: item.blockedBy.length > 0 ? item.blockedBy : undefined,
        // plans:add-item now requires an importance. The promote:plan block
        // doesn't carry per-item importance yet, so default to `normal`;
        // P-006 wires the architect/orchestrator to set it from the rubric
        // (e.g. `urgent` for a feature stuck after the debugger threshold).
        importance: 'normal',
      }, harnessSlug);
    }
  }

  // 4. Add decisions.
  for (const dec of parsed.decisions) {
    await callTool('add-decision', {
      slug,
      harness: harnessSlug || 'all',
      title: dec.title,
      body: dec.body,
    }, harnessSlug);
  }

  // await-event-primitive-2026-06-05 P-014 (D-006 #6): the draft is ready —
  // an awaitable event replaces the old "callers should poll/refresh" advice
  // (`events:await { event: 'plan:draft-ready:<slug>' }`). Fire-and-forget.
  void trackDetached(import('../../events/await/engine'))
    .then(({ emitAwaitedEvent }) =>
      emitAwaitedEvent({
        key: `plan:draft-ready:${slug}`,
        summary: `plan draft '${slug}' is ready`,
        payload: { slug, harnessSlug: harnessSlug ?? null },
        source: 'plan-blocks',
      }),
    )
    .catch(() => {});

  return { slug };
}

function toKebab(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/* ── Tool registration ────────────────────────────────────────────── */

export default defineTool({
  name: 'plans:apply-plan-block',
  description:
    'Parse and apply a ```promote:plan fenced block: creates a new draft plan via plans:new → plans:set-now → plans:add-item × N → plans:add-decision × N.',
  guidance: {
    when:
      'The architect (or any agent) emitted a ```promote:plan block and the human accepted it. Pass the raw block content (everything between the fences, excluding the fence lines themselves).',
    notWhen:
      'The plan already exists — use plans:set-content or the individual write verbs instead.',
    chaining: 'Returns { ok, slug }. Follow with plans:get to read the created plan.',
    seeAlso: [
      'plans:get (read the created plan)',
      'plans:set-content (edit an existing plan instead)',
      'plans:new (create a plan directly)',
    ],
  },
  capability: 'plans:write',
  // tool-call-batching-wrappers-2026-06-21 P-011 — composite marker: applies a
  // promote:plan block as plans:new + set-now + add-item×N + add-decision×N in one call.
  replaces: ['plans:new', 'plans:set-now', 'plans:add-item', 'plans:add-decision'],
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'operator', 'cup'],
  args: z.object({
    blockContent: z
      .string()
      .min(10)
      .describe(
        'Raw content of the ```promote:plan block (between the opening and closing fence lines, not including them).',
      ),
    harnessSlug: z
      .string()
      .optional()
      .describe(
        "Harness this plan should belong to. Used by the admin HTTP route to invalidate that harness's plansDrafts.bySlug subscription so the ProposalsPanel sees the new draft immediately. When omitted, no sync invalidation is fired — await the `plan:draft-ready:<slug>` event (events:await) instead of polling.",
      ),
  }),
  async handler(args) {
    const parsed = parsePlanBlock(args.blockContent);
    if (!parsed) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'block_parse_failed',
              detail:
                'Could not parse the promote:plan block. Make sure it has TITLE:, STATUS:, SUMMARY:, a --- separator, and a ## Now section.',
            }),
          },
        ],
      };
    }
    try {
      const { slug } = await applyPlanBlock(parsed, args.harnessSlug);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, slug }),
          },
        ],
      };
    } catch (e) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: e instanceof Error ? e.message : String(e),
            }),
          },
        ],
      };
    }
  },
});
