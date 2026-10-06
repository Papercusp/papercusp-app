/**
 * work_items:admit core (enterprise-data-sources-2026-10-01 P-020 / D-004 / D-030).
 *
 * The ONE path by which DATA becomes WORK. A person promoting a source by hand and a
 * per-data-source admission rule both land here. This module owns what is common to every
 * source kind:
 *
 *   - idempotency. Admission is keyed on (workspace, source kind, source key), and so is
 *     harness_shared.work_admissions' UNIQUE. A transaction-scoped advisory lock on that identity
 *     serialises concurrent admits of one source (createWorkItem runs on its own pool, so a
 *     plain INSERT ... ON CONFLICT afterwards could leave an orphan item behind a lost race).
 *   - covering. A resolver may declare covering identities (a chat message's thread). All of
 *     them are looked up in one query; an existing admission is returned instead of minting.
 *   - attribution. Every admission row names the person or the rule that admitted it.
 *   - the record link. A record source links the minted item to the record's own row with the
 *     existing descriptive rel 'about' (D-030 point 5).
 *   - field authority. The external system owns title, description and assignee; Papercusp
 *     owns agent-side state. `refreshAdmittedFromSource` re-syncs external-owned fields from
 *     the source and nothing else; `refuseExternalOwnedPatch` refuses a Papercusp edit to them.
 *   - write-back, through the resolver's capability (server-side coordinates only).
 *
 * Admitted items are issue-family (change by default, bug or task on request): those are the
 * kinds whose title/body updateWorkItem can re-sync. Feature-family pipeline work is reached
 * from an admitted change with work_items:promote, never by admitting straight into it.
 */
import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import {
  createWorkItem as defaultCreateWorkItem,
  linkWorkItem as defaultLinkWorkItem,
  resolveWorkItemRef as defaultResolveWorkItemRef,
  updateWorkItem as defaultUpdateWorkItem,
  type CreateWorkItemInput,
} from '../work-items';
import {
  DEFAULT_FIELD_AUTHORITY,
  getAdmissionSource,
  isAdmissionRefusal,
  type AdmissionDb,
  type AdmissionRow,
  type AdmissionSourceIdentity,
  type AdmissionSourceResolver,
  type AdmissionTransitionResult,
  type AdmissionWriteBackResult,
  type Admitter,
  type FieldAuthority,
} from './admission-sources';
import { recordAdmissionWriteBack } from './write-back-ledger';
import {
  isTicketStatusCategory,
  TICKET_STATUS_CATEGORIES,
  type TicketStatusCategory,
} from '../data-sources/ticket-vocabulary';

/** Issue-family kinds an admission may mint. */
export const ADMITTED_KINDS = ['change', 'bug', 'task'] as const;
export type AdmittedKind = (typeof ADMITTED_KINDS)[number];

/** Upper bound on the body excerpt copied onto the minted item. */
export const ADMISSION_BODY_MAX = 8000;
/** Upper bound on a write-back text. */
export const ADMISSION_WRITE_BACK_MAX = 4000;

export interface AdmitInput {
  workspaceId: string;
  harness: string;
  /** The caller's raw source: `{ kind, ...kindSpecificRef }`. */
  source: Record<string, unknown>;
  admitter: Admitter;
  /** Optional title override. Without one the source's own title is used. */
  title?: string;
  kind?: AdmittedKind;
}

export interface AdmitDeps {
  sql?: AdmissionDb & { begin?: unknown };
  createWorkItem?: (input: CreateWorkItemInput) => Promise<{ id: string } | unknown>;
  linkWorkItem?: typeof defaultLinkWorkItem;
  resolveWorkItemRef?: typeof defaultResolveWorkItemRef;
}

export type AdmitResult =
  | {
      ok: true;
      reason: 'admitted' | 'existing' | 'covered';
      workItemId: string;
      admission: AdmissionRow;
      linkedRecord?: string | null;
    }
  | { ok: false; code: string; message: string };

interface AdmissionDbRow {
  id: string;
  workspace_id: string;
  work_item_id: string;
  data_source_id: string | null;
  source_kind: string;
  source_key: string;
  source_ref: Record<string, unknown> | null;
  field_authority: Record<string, unknown> | null;
  admitted_via: 'person' | 'rule';
  admitted_by: string;
  rule_id: string | null;
  created_at: Date | string;
}

export function toAdmissionRow(r: AdmissionDbRow): AdmissionRow & { fieldAuthority: FieldAuthority } {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    workItemId: r.work_item_id,
    dataSourceId: r.data_source_id,
    sourceKind: r.source_kind,
    sourceKey: r.source_key,
    sourceRef: r.source_ref ?? {},
    admittedVia: r.admitted_via,
    admittedBy: r.admitted_by,
    ruleId: r.rule_id,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    fieldAuthority: normaliseFieldAuthority(r.field_authority),
  };
}

function normaliseFieldAuthority(raw: unknown): FieldAuthority {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const list = (v: unknown, fallback: readonly string[]) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [...fallback];
  return {
    external: list(obj.external, DEFAULT_FIELD_AUTHORITY.external),
    papercusp: list(obj.papercusp, DEFAULT_FIELD_AUTHORITY.papercusp),
  };
}

/** The attribution string stored as the work item's creator and the admission's admitted_by. */
export function admitterLabel(admitter: Admitter): string {
  return admitter.via === 'person' ? admitter.actorId : `admission-rule:${admitter.ruleId}`;
}

function lockKey(workspaceId: string, kind: string, key: string): string {
  // hashtextextended collides only on the 64-bit hash; the UNIQUE constraint is the backstop.
  return createHash('sha256').update(`${workspaceId}\u0000${kind}\u0000${key}`).digest('hex');
}

function refusal(code: string, message: string): AdmitResult {
  return { ok: false, code, message };
}

function createdId(created: unknown): string | null {
  if (created && typeof created === 'object' && typeof (created as { id?: unknown }).id === 'string') {
    return (created as { id: string }).id;
  }
  return null;
}

/**
 * Admits one source into work. Returns the existing admission when the source (or a source
 * covering it) is already admitted, so a retry, a re-poll or two concurrent admits converge on
 * one work item.
 */
export async function admitWorkItem(input: AdmitInput, deps: AdmitDeps = {}): Promise<AdmitResult> {
  const kindRaw = typeof input.source?.kind === 'string' ? input.source.kind.trim() : '';
  if (!kindRaw) return refusal('admission_source_invalid', 'source.kind is required');
  const resolver = getAdmissionSource(kindRaw);
  if (!resolver) return refusal('admission_source_unknown', `no admission source is registered for kind '${kindRaw}'`);
  const workKind: AdmittedKind = input.kind ?? 'change';
  if (!(ADMITTED_KINDS as readonly string[]).includes(workKind)) {
    return refusal('admission_kind_invalid', `admitted work must be one of ${ADMITTED_KINDS.join(', ')}`);
  }
  const rawRef = Object.fromEntries(Object.entries(input.source).filter(([k]) => k !== 'kind'));
  let ref: unknown;
  try {
    ref = resolver.parseRef(rawRef);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return refusal('admission_source_invalid', message.replace(/^admission_source_invalid:\s*/, ''));
  }

  const sql = (deps.sql ?? getOrgPg().sql) as ReturnType<typeof getOrgPg>['sql'];
  const create = deps.createWorkItem ?? defaultCreateWorkItem;
  const link = deps.linkWorkItem ?? defaultLinkWorkItem;
  const resolveRef = deps.resolveWorkItemRef ?? defaultResolveWorkItemRef;
  const by = admitterLabel(input.admitter);

  return (await sql.begin(async (tx) => {
    const resolved = await resolver.resolve(
      { db: tx, workspaceId: input.workspaceId, harness: input.harness, admitter: input.admitter },
      ref,
    );
    if (isAdmissionRefusal(resolved)) return refusal(resolved.code, resolved.message);
    if (input.admitter.via === 'rule' && resolved.dataSourceId !== input.admitter.dataSourceId) {
      return refusal('outside_rule_scope', 'the source does not belong to the admitting rule\'s data source');
    }

    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(input.workspaceId, kindRaw, resolved.sourceKey)}, 0))`;

    const identities: AdmissionSourceIdentity[] = [{ kind: kindRaw, key: resolved.sourceKey }, ...(resolved.coveredBy ?? [])];
    const kinds = identities.map((i) => String(i.kind));
    const keys = identities.map((i) => i.key);
    const existing = await tx<AdmissionDbRow[]>`
      SELECT a.* FROM harness_shared.work_admissions a
        JOIN unnest(${kinds}::text[], ${keys}::text[]) AS w(kind, key)
          ON a.source_kind = w.kind AND a.source_key = w.key
       WHERE a.workspace_id = ${input.workspaceId}`;
    if (existing.length > 0) {
      const own = existing.find((r) => r.source_kind === kindRaw && r.source_key === resolved.sourceKey);
      const hit = own ?? existing[0]!;
      return { ok: true as const, reason: own ? ('existing' as const) : ('covered' as const), workItemId: hit.work_item_id, admission: toAdmissionRow(hit) };
    }

    const title = (input.title?.trim() || resolved.title.trim() || resolved.sourceKey).slice(0, 300);
    const body = [resolved.body.slice(0, ADMISSION_BODY_MAX), resolved.permalink ? `Source: ${resolved.permalink}` : '']
      .filter(Boolean)
      .join('\n\n');
    const created = await create({
      kind: workKind,
      title,
      summary: body,
      harness: input.harness,
      workspaceId: input.workspaceId,
      createdBy: by,
    });
    const workItemId = createdId(created);
    if (!workItemId) return refusal('admission_create_failed', 'createWorkItem returned no id');

    let linkedRecord: string | null = null;
    if (resolved.recordWorkItemId) {
      const dst = await resolveRef(resolved.recordWorkItemId, input.harness);
      if (!dst) throw new Error(`admission_record_unresolvable:${resolved.recordWorkItemId}`);
      const linked = await link(workItemId, dst, 'about', { harness: input.harness, by });
      if ('error' in linked) throw new Error(`admission_link_failed:${linked.error}`);
      linkedRecord = resolved.recordWorkItemId;
    }

    const fieldAuthority = resolved.fieldAuthority ?? DEFAULT_FIELD_AUTHORITY;
    const [row] = await tx<AdmissionDbRow[]>`
      INSERT INTO harness_shared.work_admissions
        (workspace_id, work_item_id, harness_slug, data_source_id, source_kind, source_key, source_ref,
         field_authority, admitted_via, admitted_by, rule_id)
      VALUES
        (${input.workspaceId}, ${workItemId}, ${input.harness}, ${resolved.dataSourceId}, ${kindRaw},
         ${resolved.sourceKey}, ${tx.json(resolved.sourceRef as never)},
         ${tx.json({ external: [...fieldAuthority.external], papercusp: [...fieldAuthority.papercusp] } as never)},
         ${input.admitter.via}, ${by}, ${input.admitter.via === 'rule' ? input.admitter.ruleId : null})
      RETURNING *`;
    return { ok: true as const, reason: 'admitted' as const, workItemId, admission: toAdmissionRow(row!), linkedRecord };
  })) as AdmitResult;
}

/** Every admission whose work item is `workItemId` (normally one). */
export async function admissionsForWorkItem(
  workspaceId: string,
  workItemId: string,
  sql: AdmissionDb = getOrgPg().sql,
): Promise<Array<AdmissionRow & { fieldAuthority: FieldAuthority }>> {
  const rows = await sql<AdmissionDbRow[]>`
    SELECT * FROM harness_shared.work_admissions
     WHERE workspace_id = ${workspaceId} AND work_item_id = ${workItemId}
     ORDER BY created_at`;
  return rows.map(toAdmissionRow);
}

/** Every admission of one source, by its identity. */
export async function admissionsForSource(
  workspaceId: string,
  identity: AdmissionSourceIdentity,
  sql: AdmissionDb = getOrgPg().sql,
): Promise<Array<AdmissionRow & { fieldAuthority: FieldAuthority }>> {
  const rows = await sql<AdmissionDbRow[]>`
    SELECT * FROM harness_shared.work_admissions
     WHERE workspace_id = ${workspaceId} AND source_kind = ${String(identity.kind)} AND source_key = ${identity.key}`;
  return rows.map(toAdmissionRow);
}

/** Work-item patch field -> the authority field it edits. */
const PATCH_FIELD_AUTHORITY: Record<string, string> = { title: 'title', body: 'description', summary: 'description' };

/**
 * Refuses a Papercusp-side patch that edits a field the external system owns on an admitted
 * work item. Returns null when the patch is allowed (or the item was never admitted).
 */
export async function refuseExternalOwnedPatch(
  workspaceId: string,
  workItemId: string,
  patchFields: readonly string[],
  sql: AdmissionDb = getOrgPg().sql,
): Promise<{ code: 'field_owned_by_source'; message: string; fields: string[] } | null> {
  const touched = patchFields.map((f) => PATCH_FIELD_AUTHORITY[f]).filter((f): f is string => Boolean(f));
  if (touched.length === 0) return null;
  const admissions = await admissionsForWorkItem(workspaceId, workItemId, sql);
  if (admissions.length === 0) return null;
  const owned = new Set(admissions.flatMap((a) => a.fieldAuthority.external));
  const blocked = patchFields.filter((f) => owned.has(PATCH_FIELD_AUTHORITY[f] ?? ''));
  if (blocked.length === 0) return null;
  return {
    code: 'field_owned_by_source',
    message: `${blocked.join(', ')} on ${workItemId} is owned by its source (${admissions[0]!.sourceKind} ${admissions[0]!.sourceKey}); change it there, or write back a note with work_items:admit { op:'write-back' }`,
    fields: blocked,
  };
}

/**
 * Re-syncs the external-owned fields (title, description) of every work item admitted from
 * `identity` after the source changed. Papercusp-owned state is never touched.
 */
export async function refreshAdmittedFromSource(
  workspaceId: string,
  identity: AdmissionSourceIdentity,
  snapshot: { title?: string; body?: string; permalink?: string | null },
  deps: { sql?: AdmissionDb; updateWorkItem?: typeof defaultUpdateWorkItem } = {},
): Promise<{ refreshed: string[]; skipped: Array<{ workItemId: string; reason: string }> }> {
  const update = deps.updateWorkItem ?? defaultUpdateWorkItem;
  const sql = deps.sql ?? getOrgPg().sql;
  const admissions = await admissionsForSource(workspaceId, identity, sql);
  const refreshed: string[] = [];
  const skipped: Array<{ workItemId: string; reason: string }> = [];
  if (admissions.length === 0) return { refreshed, skipped };
  // The current external-owned values, so an unchanged source writes nothing (the issue body
  // lives in work_items.summary).
  const current = new Map(
    (
      await sql<Array<{ feature_id: string; title: string | null; summary: string | null }>>`
        SELECT feature_id, title, summary FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId} AND feature_id = ANY(${admissions.map((a) => a.workItemId)}::text[])`
    ).map((r) => [r.feature_id, r] as const),
  );
  for (const a of admissions) {
    const owned = new Set(a.fieldAuthority.external);
    const patch: { title?: string; body?: string; confirmShrink?: boolean } = {};
    if (owned.has('title') && snapshot.title?.trim()) patch.title = snapshot.title.trim().slice(0, 300);
    if (owned.has('description') && typeof snapshot.body === 'string') {
      patch.body = [snapshot.body.slice(0, ADMISSION_BODY_MAX), snapshot.permalink ? `Source: ${snapshot.permalink}` : '']
        .filter(Boolean)
        .join('\n\n');
      patch.confirmShrink = true;
    }
    if (!patch.title && patch.body === undefined) {
      skipped.push({ workItemId: a.workItemId, reason: 'nothing_external_owned' });
      continue;
    }
    const now = current.get(a.workItemId);
    if (!now) {
      skipped.push({ workItemId: a.workItemId, reason: 'work_item_missing' });
      continue;
    }
    if (patch.title === (now.title ?? '')) delete patch.title;
    if (patch.body === (now.summary ?? '')) {
      delete patch.body;
      delete patch.confirmShrink;
    }
    if (!patch.title && patch.body === undefined) {
      skipped.push({ workItemId: a.workItemId, reason: 'unchanged' });
      continue;
    }
    const res = await update(a.workItemId, patch, a.admittedBy, {});
    if (res.ok) refreshed.push(a.workItemId);
    else skipped.push({ workItemId: a.workItemId, reason: res.reason });
  }
  return { refreshed, skipped };
}

export interface WriteBackDeps {
  /** The resolver for a source kind; the process-wide registration by default (tests inject). */
  resolverFor?: (kind: string) => AdmissionSourceResolver<unknown> | undefined;
  /**
   * The lifecycle event this write answers (lifecycle.ts). When set, the write is ledgered under
   * it even when the source reports nothing changed, so the event is not written again.
   */
  lifecycleKey?: string;
}

type WriteBackRefusal = { ok: false; code: string; message: string };

const CAPABILITY_UNSUPPORTED = 'provider_capability_unsupported';

/**
 * A provider that lacks the capability is an expected, named refusal (D-007: report the
 * unsupported capability explicitly), not a crash. Matched by message so a duplicated module
 * record of the error class cannot defeat it.
 */
function capabilityRefusal(err: unknown): WriteBackRefusal | null {
  const message = err instanceof Error ? err.message : '';
  return message.startsWith(`${CAPABILITY_UNSUPPORTED}:`) ? { ok: false, code: CAPABILITY_UNSUPPORTED, message } : null;
}

/**
 * Writes a plain-text note back to the source of an admitted work item, through the source
 * resolver's capability. The caller passes only the internal work item id; the external
 * coordinates come from the durable admission row (slack-flagship.ts pattern). Every write is
 * ledgered with the provider's update id (write-back-ledger.ts) for echo suppression.
 */
export async function writeBackAdmission(
  workspaceId: string,
  workItemId: string,
  text: string,
  sql: AdmissionDb = getOrgPg().sql,
  deps: WriteBackDeps = {},
): Promise<
  | {
      ok: true;
      posted: boolean;
      alreadyPosted?: boolean;
      externalRef?: string | null;
      updateId?: string | null;
      sourceKind: string;
    }
  | WriteBackRefusal
> {
  const body = text.trim();
  if (!body) return { ok: false, code: 'write_back_text_required', message: 'text is required' };
  if (body.length > ADMISSION_WRITE_BACK_MAX) {
    return { ok: false, code: 'write_back_text_too_long', message: `text is limited to ${ADMISSION_WRITE_BACK_MAX} characters` };
  }
  const [admission] = await admissionsForWorkItem(workspaceId, workItemId, sql);
  if (!admission) return { ok: false, code: 'not_admitted', message: `${workItemId} was not admitted from a data source` };
  const resolver = (deps.resolverFor ?? getAdmissionSource)(String(admission.sourceKind));
  if (!resolver?.writeBack) {
    return { ok: false, code: 'write_back_unsupported', message: `source kind '${admission.sourceKind}' has no write-back capability` };
  }
  let res: AdmissionWriteBackResult;
  try {
    res = await resolver.writeBack({ db: sql, admission, text: body });
  } catch (err) {
    const refusal = capabilityRefusal(err);
    if (refusal) return refusal;
    throw err;
  }
  if (res.posted && (!res.alreadyPosted || deps.lifecycleKey)) {
    await recordAdmissionWriteBack(sql, {
      admission,
      action: 'comment',
      updateId: res.updateId,
      externalRef: res.externalRef,
      lifecycleKey: deps.lifecycleKey,
    });
  }
  return { ok: true, sourceKind: String(admission.sourceKind), ...res };
}

/**
 * Moves the source of an admitted work item to a canonical workflow category (for example
 * `in-progress` on claim, `done` on completion), through the source resolver's
 * `<datatype>.transition` capability. Only the status moves; the source-owned title,
 * description and assignee are never sent. Ledgered like {@link writeBackAdmission}.
 */
export async function transitionAdmission(
  workspaceId: string,
  workItemId: string,
  toCategory: string,
  sql: AdmissionDb = getOrgPg().sql,
  deps: WriteBackDeps = {},
): Promise<
  | { ok: true; transitioned: boolean; toCategory: TicketStatusCategory; updateId?: string | null; externalRef?: string | null; sourceKind: string }
  | WriteBackRefusal
> {
  const category = toCategory.trim();
  if (!isTicketStatusCategory(category)) {
    return {
      ok: false,
      code: 'transition_category_invalid',
      message: `toCategory must be one of ${TICKET_STATUS_CATEGORIES.join('|')}`,
    };
  }
  const [admission] = await admissionsForWorkItem(workspaceId, workItemId, sql);
  if (!admission) return { ok: false, code: 'not_admitted', message: `${workItemId} was not admitted from a data source` };
  const resolver = (deps.resolverFor ?? getAdmissionSource)(String(admission.sourceKind));
  if (!resolver?.transition) {
    return { ok: false, code: 'transition_unsupported', message: `source kind '${admission.sourceKind}' has no workflow to move` };
  }
  let res: AdmissionTransitionResult;
  try {
    res = await resolver.transition({ db: sql, admission, toCategory: category });
  } catch (err) {
    const refusal = capabilityRefusal(err);
    if (refusal) return refusal;
    throw err;
  }
  if (res.transitioned || deps.lifecycleKey) {
    await recordAdmissionWriteBack(sql, {
      admission,
      action: 'transition',
      updateId: res.updateId,
      externalRef: res.externalRef,
      detail: { toCategory: category, changed: res.transitioned },
      lifecycleKey: deps.lifecycleKey,
    });
  }
  return { ok: true, sourceKind: String(admission.sourceKind), toCategory: category, ...res };
}
