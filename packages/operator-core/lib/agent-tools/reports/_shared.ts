/**
 * _shared.ts — the one place the `reports:*` verbs agree on identity, visibility,
 * argument vocabulary, refusal mapping and the UI path (plan
 * reports-library-2026-09-15, P-003).
 *
 * ## Why so much lives here rather than in each verb
 * Five verbs each re-deciding "who is asking" or "what counts as a valid kind" is
 * five chances to drift, and drift in a visibility/provenance rule is silent and
 * permissive. Each verb therefore composes these helpers instead of re-deriving.
 *
 * Server-only.
 */
import { z } from 'zod';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolvePotHomeSlug } from '../../pot/wake';
import { trackDetached } from '../../detached-imports';
import {
  REPORT_KINDS,
  REPORT_SUBJECT_KINDS,
  REPORT_VISIBILITIES,
  ReportBodyTooLargeError,
  type ReportOrigin,
  type ReportRecord,
  type ReportViewer,
} from '../../report-library';

/** The sync query the Reports tab reads; invalidated after every write. */
export const REPORTS_SYNC_QUERY = 'reports.library';

/**
 * Enum vocabularies DERIVED from the store's own exported constants, never
 * retyped. A hand-copied literal union here would be a second copy of a truth the
 * store (and the migration's CHECK constraints) already own — exactly the
 * code-describing-metadata drift the derived-truth ladder forbids. Adding a kind
 * to the store now widens these schemas automatically.
 */
export const zReportKind = z.enum(REPORT_KINDS);
export const zReportVisibility = z.enum(REPORT_VISIBILITIES);
export const zReportSubjectKind = z.enum(REPORT_SUBJECT_KINDS);

export const zReportSubject = z
  .object({
    kind: zReportSubjectKind.describe('what the report is ABOUT'),
    ref: z.string().min(1).max(400).optional().describe('required for every kind except `none`'),
    label: z.string().min(1).max(400).optional().describe('human label for the subject'),
  })
  .describe('axis 2 — what the report is about; independent of origin and visibility');

/**
 * The ctx fields these verbs read, as a structural subset rather than the host's
 * full tool-context type: the verbs need four identity fields and nothing else,
 * and naming only those keeps the tool layer from quietly growing a dependency on
 * the rest of the dispatch context.
 */
export interface ReportsCtx {
  workspaceId?: string | null;
  harnessSlug?: string | null;
  ownerId?: string | null;
  runId?: string | null;
  uiClientId?: string | null;
  principal?: { workspaceId?: string | null } | null;
}

export function resolveWorkspaceId(ctx: ReportsCtx): string {
  return ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
}

/**
 * The calling agent's ownerId — the value BOTH axis-1 provenance and the R-7 read
 * gate key on, so it has exactly one resolver.
 *
 * `ctx.ownerId` is NOT a field of the host's `UnifiedToolContext`: some dispatch
 * paths attach one, most do not. Reading it directly therefore compiles only where
 * the context type happens to declare it, and — worse — yields `undefined` at
 * runtime everywhere else, which would stamp every published report with a NULL
 * author while still succeeding. `resolveAgentIdentity` is the canonical resolver
 * (superuser session id, power-user auth session, bearer principal), so it is the
 * fallback whenever the context did not carry an explicit ownerId.
 *
 * Fail-soft: `resolveAgentIdentity` throws on a malformed power-user context, and
 * an unattributed report is a better outcome than a failed publish — the author is
 * one field of the record, not its reason for existing.
 */
export function resolveOwnerId(ctx: ReportsCtx): string | null {
  if (ctx.ownerId) return ctx.ownerId;
  try {
    // One documented cast at one seam: ReportsCtx is deliberately a narrower
    // structural subset than ResolveIdentityCtx, and this is the only call that
    // needs the wider shape.
    return resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId ?? null;
  } catch {
    return null;
  }
}

/**
 * Stamp axis 1 (ORIGIN) from the calling session — the server-side half of R-2.
 *
 * This function is the ONLY producer of a `ReportOrigin` on the tool path, and it
 * reads exclusively from ctx: no argument of any `reports:*` verb can reach it.
 * That is the structural guarantee behind "origin is never caller-supplied" —
 * provenance is the axis a reader uses to decide how much to trust a report, so a
 * caller able to name its own author id could forge exactly the field that makes
 * the report trustworthy.
 */
export function stampOrigin(ctx: ReportsCtx): ReportOrigin {
  return {
    // NOT `ctx.harnessSlug ?? null`: under operator/superuser scope that field is
    // the `'*'` wildcard, which is TRUTHY but is not a registered harness — so the
    // nullish fallback lets `'*'` win and stamps provenance with a harness that does
    // not exist. Because origin is the axis a reader trusts, that failure is silent:
    // the report publishes fine and simply belongs to nobody. resolveConcreteHarnessSlug
    // returns null for the wildcard, so a non-harness-scoped publish is honestly
    // unattributed rather than attributed to a phantom.
    harnessSlug: resolveConcreteHarnessSlug(null, ctx),
    authorOwnerId: resolveOwnerId(ctx),
    authorSessionRef: ctx.runId ?? ctx.uiClientId ?? null,
  };
}

/**
 * Who is asking, for the R-7 read gate.
 *
 * `isOwner` is deliberately NEVER set on this agent-tool surface. `isOwner` means
 * "the human owner", who reads through the Reports tab; an agent session — even a
 * superuser one — is an agent, and gets the matrix: every `workspace` report, the
 * `pot` reports written in its own pot, and everything it authored. Granting
 * agents the owner bypass here would make `owner` visibility mean nothing, since
 * essentially every reader of this surface is an agent.
 */
export function resolveViewer(ctx: ReportsCtx): ReportViewer {
  return {
    isOwner: false,
    ownerId: resolveOwnerId(ctx),
    // Same wildcard trap as stampOrigin, but on the READ side, where it is worse: a
    // `'*'` potSlug matches no pot, so the `pot`-visibility branch of the R-7 matrix
    // silently returns nothing and reads as "this pot has no reports" rather than as a
    // scope error. resolvePotHomeSlug skips `*`/`all`, falls through to the env home,
    // and canonicalises.
    potSlug: resolvePotHomeSlug(null, ctx.harnessSlug),
  };
}

/** The owner-facing deep link for a report. Single definition, reused by the UI item. */
export function reportUiPath(reportId: string): string {
  return `/reports/${encodeURIComponent(reportId)}`;
}

/**
 * The ONE wire projection for a report, shared by every `reports:*` response.
 *
 * It exists to keep one vocabulary at the group's boundary. The args of these
 * verbs are snake_case and R-1 names the published id `report_id`, but
 * `ReportRecord` is a camelCase domain object — so spreading the record into a
 * response (the obvious shortcut) makes `reports:publish` answer `report_id` while
 * `reports:list` answers `reportId` for the identical field. Callers then key off
 * whichever they met first and silently read `undefined` from the other verb.
 * Mapping explicitly here costs a few lines and makes that impossible.
 *
 * `body_bytes` is carried on every row precisely BECAUSE the body is not: it is how
 * a caller tells a stub from a 400KB audit before paying to fetch it.
 */
/**
 * The wire projection as a runtime schema, so every `reports:*` verb can state its
 * response STRUCTURALLY (`result:` → the derived `outputJsonSchema`) instead of only
 * describing it in `guidance.returns` prose — the direction
 * guidance-output-schema-live-guard enforces.
 *
 * This is deliberately the CANONICAL shape, with `toReportWire` typed by
 * `z.infer<typeof zReportWire>` below, rather than a hand-written second copy of the
 * mapper's return. A schema transcribed alongside the mapper would be exactly the
 * code-describing-metadata drift the derived-truth ladder forbids: the two would agree
 * on the day they were written and silently diverge on the first field added. Typing
 * the producer by the schema makes divergence a COMPILE error instead.
 */
export const zReportWire = z.object({
  report_id: z.string(),
  workspace_id: z.string(),
  title: z.string(),
  summary: z.string(),
  kind: zReportKind,
  subject: z.object({
    kind: zReportSubjectKind,
    ref: z.string().nullable(),
    label: z.string().nullable(),
  }),
  origin: z.object({
    harness_slug: z.string().nullable(),
    author_owner_id: z.string().nullable(),
    author_session_ref: z.string().nullable(),
  }),
  visibility: zReportVisibility,
  supersedes_report_id: z.string().nullable(),
  lineage_id: z.string(),
  source: z.string(),
  tags: z.array(z.string()),
  published_at: z.string(),
  updated_at: z.string(),
  retired_at: z.string().nullable(),
  path: z.string(),
  body_bytes: z.number().int().nonnegative(),
});

export function toReportWire(report: ReportRecord): z.infer<typeof zReportWire> {
  return {
    report_id: report.reportId,
    workspace_id: report.workspaceId,
    title: report.title,
    summary: report.summary,
    kind: report.kind,
    subject: { kind: report.subject.kind, ref: report.subject.ref, label: report.subject.label },
    origin: {
      harness_slug: report.origin.harnessSlug,
      author_owner_id: report.origin.authorOwnerId,
      author_session_ref: report.origin.authorSessionRef,
    },
    visibility: report.visibility,
    supersedes_report_id: report.supersedesReportId,
    lineage_id: report.lineageId,
    source: report.source,
    tags: report.tags,
    published_at: report.publishedAt,
    updated_at: report.updatedAt,
    retired_at: report.retiredAt,
    path: reportUiPath(report.reportId),
    body_bytes: Buffer.byteLength(report.bodyMd, 'utf8'),
  };
}

/** The list projection: the wire record WITHOUT the (possibly 512KB) body. */
export const toReportSummary = toReportWire;

/** The single-report projection: the wire record WITH its body. */
export function toReportFull(report: ReportRecord) {
  return { ...toReportWire(report), body_md: report.bodyMd };
}

export interface ReportRefusal {
  ok: false;
  error: string;
  message: string;
  bytes?: number;
  limitBytes?: number;
  overageBytes?: number;
}

/**
 * Map a store error to a structured refusal.
 *
 * The store already validates enum membership, the subject-ref requirement and the
 * 512KB body cap, and throws named errors for each; re-validating those here would
 * be a second copy of the same rules. This translates rather than re-decides — and
 * it preserves {@link ReportBodyTooLargeError}'s overage numbers, because R-1's
 * whole point is that an over-cap body is refused WITH its overage so the caller
 * knows how much to cut, instead of being silently truncated.
 */
export function toRefusal(err: unknown): ReportRefusal {
  if (err instanceof ReportBodyTooLargeError) {
    return {
      ok: false,
      error: 'body_too_large',
      message: err.message,
      bytes: err.bytes,
      limitBytes: err.limitBytes,
      overageBytes: err.overageBytes,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/^invalid report /.test(message)) return { ok: false, error: 'invalid_field', message };
  if (/^report subject\.ref is required/.test(message)) return { ok: false, error: 'subject_ref_required', message };
  if (/^cannot supersede /.test(message)) return { ok: false, error: 'supersedes_not_found', message };
  if (/^report (title|workspaceId) is required/.test(message)) return { ok: false, error: 'invalid_field', message };
  return { ok: false, error: 'publish_failed', message };
}

/**
 * Fire-and-forget the Reports-tab invalidation after a write.
 *
 * Detached on purpose: a report IS published once the row commits, so a slow or
 * unavailable SSE bus must not fail the call or make the caller retry a write that
 * already succeeded. The cost is that the tab refreshes late, which is recoverable;
 * a false failure is not.
 */
export function invalidateReportsSync(log?: (m: string) => void): void {
  void trackDetached(import('../../sync-sse'))
    .then(({ notifySyncInvalidate }) => notifySyncInvalidate(REPORTS_SYNC_QUERY, {}))
    .catch((e) => log?.(`reports sync invalidate failed: ${e instanceof Error ? e.message : e}`));
}
