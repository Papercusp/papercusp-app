/**
 * plans:set-content-chunk — staged whole-document plan writes.
 *
 * Large plan bodies can exceed the agent provider's tool-call payload
 * limits before Papercusp ever receives the request. This companion to
 * plans:set-content lets agents stream the replacement body through small
 * MCP calls (begin → append* → commit). Only commit touches the real plan
 * file; it reuses plans:set-content's CAS, legacy-boundary, lint, lock,
 * and revision behavior.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock } from './with-plan-lock';
import { evaluateSetContent, type SetContentValue } from './set-content';
import { planItemTextDriftForWrite } from '../../plan-items/text-drift-report';
import type { ResolveIdentityCtx } from '../coordination/identity';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { parsePlan } from './parser';
import { clearStartedForTerminalPlan, isTerminalPlanStatus } from './plan-start-state';

const MAX_CHUNK_CHARS = 24_000;
const DRAFT_ID = /^[a-zA-Z0-9_-]{8,80}$/;
const DRAFT_DIR = path.join(os.tmpdir(), 'papercusp-plan-content-drafts');

const argsSchema = z.object({
  slug: z.string().min(1),
  harness: harnessArg,
  op: z.enum(['begin', 'append', 'commit', 'abort']),
  draftId: z
    .string()
    .regex(DRAFT_ID, 'draftId returned by plans:set-content-chunk begin')
    .optional(),
  chunk: z
    .string()
    .max(MAX_CHUNK_CHARS)
    .optional()
    .describe(
      `One slice of the replacement markdown. Keep chunks under ${MAX_CHUNK_CHARS} characters so the provider never has to send a huge tool call.`,
    ),
  expectedHash: z
    .string()
    .optional()
    .describe('The plans:get contentHash baseline. Provide on begin or commit; commit prefers the explicit value if both are present.'),
  rationale: z
    .string()
    .optional()
    .describe('Why this rewrite is happening. Provide on begin or commit; commit prefers the explicit value if both are present.'),
  allowShrink: z
    .boolean()
    .optional()
    .describe(
      'Commit rejects a body under 20% of the live plan as a probable mass deletion (`suspicious_shrink`) unless this is true. Provide on begin or commit; commit prefers the explicit value. On a suspicious_shrink rejection the draft is KEPT — re-commit with allowShrink: true if the shrink is intentional.',
    ),
  allowStatusRegression: z
    .boolean()
    .optional()
    .describe(
      'A commit with no expectedHash that would move an item BACKWARD off a terminal (done/dropped) status is rejected as `item_status_regression` (almost always a stale-read clobber of someone else\'s completed work) unless this is true. Provide on begin or commit; commit prefers the explicit value. On rejection the draft is KEPT — re-commit with allowStatusRegression: true if the regression is intentional, or start over from a fresh plans:get.',
    ),
});

type ChunkOp = z.infer<typeof argsSchema>['op'];

interface DraftMeta {
  draftId: string;
  slug: string;
  harnessSlug: string | null;
  expectedHash?: string;
  rationale?: string;
  allowShrink?: boolean;
  allowStatusRegression?: boolean;
  createdAt: string;
  updatedAt: string;
  bytes: number;
  chunks: number;
}

type ChunkValue =
  | {
      ok: true;
      op: ChunkOp;
      slug: string;
      draftId: string;
      bytes: number;
      chunks: number;
      contentHash?: string;
      warning?: string;
      filePath?: string;
      revision?: { seq: number } | null;
    }
  | {
      ok: false;
      code:
        | 'missing_draft_id'
        | 'missing_chunk'
        | 'draft_not_found'
        | 'draft_mismatch'
        | 'not_found'
        | 'stale'
        | 'suspicious_shrink'
        | 'would_orphan_frontmatter'
        | 'lint_failed'
        | 'item_status_regression';
      slug: string;
      draftId?: string;
      currentHash?: string;
      reason?: 'bytes' | 'structure';
      currentLength?: number;
      proposedLength?: number;
      priorItems?: number;
      priorDecisions?: number;
      droppedItems?: number;
      droppedDecisions?: number;
      errors?: unknown[];
      regressions?: { id: string; from: string; to: string }[];
    }
  | {
      ok: false;
      code: 'plan_status_change_requires_lifecycle_writer';
      slug: string;
      draftId: string;
      currentStatus: string | null;
      proposedStatus: string | null;
      writer: 'plans:set-plan-status' | 'plans:set-frontmatter';
      message: string;
    };

function nowISO(): string {
  return new Date().toISOString();
}

function makeDraftId(): string {
  return randomUUID();
}

function draftPaths(draftId: string): { meta: string; content: string } {
  if (!DRAFT_ID.test(draftId)) throw new Error(`invalid draft id ${JSON.stringify(draftId)}`);
  return {
    meta: path.join(DRAFT_DIR, `${draftId}.json`),
    content: path.join(DRAFT_DIR, `${draftId}.md`),
  };
}

async function readDraft(draftId: string): Promise<{ meta: DraftMeta; content: string } | null> {
  const files = draftPaths(draftId);
  try {
    const [metaRaw, content] = await Promise.all([
      fs.readFile(files.meta, 'utf8'),
      fs.readFile(files.content, 'utf8'),
    ]);
    return { meta: JSON.parse(metaRaw) as DraftMeta, content };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function writeDraft(meta: DraftMeta, content: string): Promise<void> {
  const files = draftPaths(meta.draftId);
  await fs.mkdir(DRAFT_DIR, { recursive: true });
  await Promise.all([
    fs.writeFile(files.meta, JSON.stringify(meta, null, 2), 'utf8'),
    fs.writeFile(files.content, content, 'utf8'),
  ]);
}

async function removeDraft(draftId: string): Promise<void> {
  const files = draftPaths(draftId);
  await Promise.all([
    fs.rm(files.meta, { force: true }),
    fs.rm(files.content, { force: true }),
  ]);
}

/** Drafts older than this are abandoned (crashed caller, never-committed
 *  stream) and swept by the lazy janitor below (audit P-043). */
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
/** The janitor is a cheap readdir+stat, but there's no reason to run it
 *  more than ~hourly per process. Process-local throttle, not state. */
const SWEEP_MIN_INTERVAL_MS = 60 * 60 * 1000;
let lastSweepAt = 0;

export async function sweepStaleDrafts(now = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(DRAFT_DIR);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
  let swept = 0;
  await Promise.all(
    names.map(async (name) => {
      const p = path.join(DRAFT_DIR, name);
      try {
        const st = await fs.stat(p);
        if (now - st.mtimeMs > DRAFT_TTL_MS) {
          await fs.rm(p, { force: true });
          swept += 1;
        }
      } catch {
        /* raced with a concurrent remove — fine */
      }
    }),
  );
  return swept;
}

function maybeSweepStaleDrafts(): void {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_MIN_INTERVAL_MS) return;
  lastSweepAt = now;
  void sweepStaleDrafts(now).catch(() => {
    /* best-effort janitor — never affects the caller's op */
  });
}

export function appendChunkToContent(content: string, chunk: string | undefined): string {
  return chunk === undefined ? content : content + chunk;
}

async function createDraft(args: z.infer<typeof argsSchema>, harnessSlug: string | undefined): Promise<ChunkValue> {
  maybeSweepStaleDrafts();
  const draftId = makeDraftId();
  const content = appendChunkToContent('', args.chunk);
  const meta: DraftMeta = {
    draftId,
    slug: args.slug,
    harnessSlug: harnessSlug ?? null,
    ...(args.expectedHash ? { expectedHash: args.expectedHash } : {}),
    ...(args.rationale ? { rationale: args.rationale } : {}),
    ...(args.allowShrink !== undefined ? { allowShrink: args.allowShrink } : {}),
    ...(args.allowStatusRegression !== undefined ? { allowStatusRegression: args.allowStatusRegression } : {}),
    createdAt: nowISO(),
    updatedAt: nowISO(),
    bytes: Buffer.byteLength(content, 'utf8'),
    chunks: args.chunk === undefined ? 0 : 1,
  };
  await writeDraft(meta, content);
  return { ok: true, op: 'begin', slug: args.slug, draftId, bytes: meta.bytes, chunks: meta.chunks };
}

async function appendDraft(args: z.infer<typeof argsSchema>, harnessSlug: string | undefined): Promise<ChunkValue> {
  if (!args.draftId) return { ok: false, code: 'missing_draft_id', slug: args.slug };
  if (args.chunk === undefined) return { ok: false, code: 'missing_chunk', slug: args.slug, draftId: args.draftId };
  const draft = await readDraft(args.draftId);
  if (!draft) return { ok: false, code: 'draft_not_found', slug: args.slug, draftId: args.draftId };
  if (draft.meta.slug !== args.slug || draft.meta.harnessSlug !== (harnessSlug ?? null)) {
    return { ok: false, code: 'draft_mismatch', slug: args.slug, draftId: args.draftId };
  }
  const content = appendChunkToContent(draft.content, args.chunk);
  const meta: DraftMeta = {
    ...draft.meta,
    updatedAt: nowISO(),
    bytes: Buffer.byteLength(content, 'utf8'),
    chunks: draft.meta.chunks + 1,
  };
  await writeDraft(meta, content);
  return { ok: true, op: 'append', slug: args.slug, draftId: args.draftId, bytes: meta.bytes, chunks: meta.chunks };
}

/**
 * Serialize a ChunkValue to the tool response. ALL failures carry a canonical
 * `error` key (= the code) so a client can switch on `data.error` uniformly —
 * matching edit.ts / set-content.ts and the `busy` path below. (EI-6: guard
 * failures used to emit `{ ok:false, code }` with no `error`, which a client
 * keying on `data.error` silently read as success.) `code` + the structured
 * fields are retained.
 */
function chunkResponse(value: ChunkValue) {
  const body = value.ok ? value : { error: value.code, ...value };
  return { content: [{ type: 'text' as const, text: JSON.stringify(body) }], isError: !value.ok };
}

function domainFailurePayload(v: SetContentValue, slug: string, draftId: string): ChunkValue {
  if (v.ok) {
    return { ok: true, op: 'commit', slug: v.slug, draftId, bytes: 0, chunks: 0, contentHash: v.contentHash };
  }
  if (v.code === 'stale') {
    return { ok: false, code: 'stale', slug, draftId, currentHash: v.currentHash };
  }
  if (v.code === 'lint_failed') {
    return { ok: false, code: 'lint_failed', slug, draftId, errors: v.errors };
  }
  if (v.code === 'suspicious_shrink') {
    return {
      ok: false,
      code: 'suspicious_shrink',
      slug,
      draftId,
      reason: v.reason,
      currentLength: v.currentLength,
      proposedLength: v.proposedLength,
      ...(v.reason === 'structure'
        ? {
            priorItems: v.priorItems,
            priorDecisions: v.priorDecisions,
            droppedItems: v.droppedItems,
            droppedDecisions: v.droppedDecisions,
          }
        : {}),
    };
  }
  if (v.code === 'item_status_regression') {
    return { ok: false, code: 'item_status_regression', slug, draftId, regressions: v.regressions };
  }
  if (v.code === 'plan_status_change_requires_lifecycle_writer') {
    return {
      ok: false,
      code: v.code,
      slug,
      draftId,
      currentStatus: v.currentStatus,
      proposedStatus: v.proposedStatus,
      writer: v.writer,
      message: v.message,
    };
  }
  return { ok: false, code: v.code, slug, draftId };
}

/**
 * Whether a failed commit should DELETE the draft (audit P-043).
 *
 * The draft is the caller's streamed work — destroy it only when the
 * CONTENT itself is terminally rejected (it cannot be re-committed as-is):
 * lint_failed / would_orphan_frontmatter (body must change → full
 * re-stream anyway) and not_found (no such plan to target).
 *
 * Keep it for every retryable outcome: `busy` (transient), `stale`
 * (re-commit the SAME draft with the fresh expectedHash), and
 * `suspicious_shrink` (re-commit with allowShrink: true). Abandoned
 * drafts are bounded by the TTL janitor either way.
 */
export function shouldRemoveDraftOnFailure(code: Extract<ChunkValue, { ok: false }>['code']): boolean {
  return code === 'lint_failed' || code === 'would_orphan_frontmatter' || code === 'not_found';
}

export default defineTool({
  name: 'plans:set-content-chunk',
  description:
    'Stage a large plans:set-content rewrite through small chunks. Use begin with expectedHash, append each markdown chunk, then commit. Commit validates/lints/CAS-writes exactly like plans:set-content, refuses lifecycle status changes, and records one revision. Use this instead of plans:set-content for large plan bodies that may trip provider/tool-call limits.',
  guidance: {
    when:
      'Writing or rewriting a large plan body. If the plan markdown is more than a few screens, use begin → append* → commit with chunks under 24k characters instead of sending one huge plans:set-content call.',
    notWhen:
      'Small raw-prose edits — plans:set-content is simpler. Lifecycle status changes, item status changes, Now updates, and decisions/items — use their dedicated verbs.',
    chaining:
      'plans:get { slug } → plans:set-content-chunk { op:"begin", slug, expectedHash: contentHash, chunk:firstPart, rationale } → append remaining chunks → commit. If commit returns stale, plans:get again and restart the draft.',
    seeAlso: [
      'plans:get (get the expectedHash first)',
      'plans:set-content (a single-shot whole-doc edit)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveCtxHarnessSlug(sctx);

    if (args.op === 'begin') {
      return chunkResponse(await createDraft(args, harnessSlug));
    }

    if (args.op === 'append') {
      return chunkResponse(await appendDraft(args, harnessSlug));
    }

    if (args.op === 'abort') {
      if (!args.draftId) {
        return chunkResponse({ ok: false, code: 'missing_draft_id', slug: args.slug });
      }
      await removeDraft(args.draftId);
      return chunkResponse({ ok: true, op: 'abort', slug: args.slug, draftId: args.draftId, bytes: 0, chunks: 0 });
    }

    if (!args.draftId) {
      return chunkResponse({ ok: false, code: 'missing_draft_id', slug: args.slug });
    }

    if (args.chunk !== undefined) {
      const appended = await appendDraft({ ...args, op: 'append' }, harnessSlug);
      if (!appended.ok) return chunkResponse(appended);
    }

    const draft = await readDraft(args.draftId);
    if (!draft) {
      return chunkResponse({ ok: false, code: 'draft_not_found', slug: args.slug, draftId: args.draftId });
    }
    if (draft.meta.slug !== args.slug || draft.meta.harnessSlug !== (harnessSlug ?? null)) {
      return chunkResponse({ ok: false, code: 'draft_mismatch', slug: args.slug, draftId: args.draftId });
    }

    const rev = planRevisionCapture(
      ctx as PlanRevisionCtx,
      args.slug,
      args.rationale ?? draft.meta.rationale,
      harnessSlug ? { harnessSlug } : {},
    );
    const result = await withPlanLock<SetContentValue>(
      ctx as never,
      {
        slug: args.slug,
        intent: 'plans:set-content-chunk commit',
        ...(harnessSlug ? { harnessSlug } : {}),
        afterWrite: rev.afterWrite,
      },
      (current) =>
        evaluateSetContent(current, draft.content, args.slug, args.expectedHash ?? draft.meta.expectedHash, {
          allowShrink: args.allowShrink ?? draft.meta.allowShrink,
          wholeDocumentRewrite: true,
          allowStatusRegression: args.allowStatusRegression ?? draft.meta.allowStatusRegression,
        }),
    );

    if (result.kind === 'busy') {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: 'busy',
            busy: result.busy.map((b) => ({
              path: b.path,
              owner_label: b.owner_label,
              intent: b.intent,
              expires_ts: b.expires_ts,
            })),
          }),
        }],
        isError: true,
      };
    }

    const payload = domainFailurePayload(result.value, args.slug, args.draftId);
    if (!payload.ok) {
      // Terminally-rejected content can never be re-committed — clean its
      // draft up here instead of leaking it until the TTL janitor
      // (audit P-043). Retryable failures keep the draft (see
      // shouldRemoveDraftOnFailure).
      if (shouldRemoveDraftOnFailure(payload.code)) {
        await removeDraft(args.draftId);
      }
      return chunkResponse(payload);
    }

    // Cross-store invariant: a committed body can carry a terminal frontmatter
    // status. If so, clear the operational started/paused row so a terminal
    // plan is never counted as "waiting". Best-effort — plans:list self-heals.
    if (isTerminalPlanStatus(parsePlan(draft.content, { filePath: `${args.slug}.md` }).frontmatter.status)) {
      try {
        await clearStartedForTerminalPlan(result.scope.workspaceId, result.scope.harnessSlug, args.slug);
      } catch {
        /* recovered by reconcileStartStatus on the next plans:list read */
      }
    }

    // WI-40825: same post-commit drift report as set-content / edit — a chunked
    // commit is a whole-document rewrite, so it is the writer most able to reword
    // many items at once without noticing who is executing them.
    const planItemDrift = await planItemTextDriftForWrite(
      ctx as ResolveIdentityCtx,
      args.slug,
      result.value.ok ? result.value.itemTextChanges : undefined,
      result.scope.harnessSlug,
    );

    await removeDraft(args.draftId);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          op: 'commit',
          ...(planItemDrift ? { planItemDrift } : {}),
          slug: result.value.ok ? result.value.slug : args.slug,
          draftId: args.draftId,
          bytes: draft.meta.bytes,
          chunks: draft.meta.chunks,
          contentHash: result.value.ok ? result.value.contentHash : undefined,
          // Surfacing (EI-83 fix #2): present only when the commit removed
          // items/decisions, even an allowed shrink.
          ...(result.value.ok && result.value.warning ? { warning: result.value.warning } : {}),
          ...(result.value.ok && result.value.nowStamped ? { nowStamped: true } : {}),
          filePath: result.filePath,
          revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
          ...(result.activationAudit ? { activationAudit: result.activationAudit } : {}),
          // Item-parse feedback (WI-3363), computed in evaluateSetContent.
          ...(result.value.ok ? result.value.parseFeedback : {}),
        }),
      }],
    };
  },
});
