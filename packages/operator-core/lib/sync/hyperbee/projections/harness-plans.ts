/**
 * Hyperbee → PG projection for `harness_shared.harness_plans`.
 *
 * Plan: plans-pg-canonical-migration-2026-06-03 (Stage 2 — federation). Plans
 * went PG-canonical and federate as papercup-harness content over the same
 * peer-log machinery as features/issues (D-004). The per-harness Hyperbee key
 * is the `plan_slug` (the harness is implicit per-Hyperbee).
 *
 * Federated fields = the DOCUMENT: the canonical markdown `content` + its hash +
 * the frontmatter index (title/status/dates/owner/initiative/supersedes) + archived/is_legacy.
 * NOT federated (machine-local): `workspace_id` (set from the local projection's
 * bound workspace), `version` (the local CAS counter — bumped on a remote apply),
 * the `op_*` operational dispatch state (started/paused/priority — each machine
 * manages its own started set), and `created_at`/`updated_at`/`_search`.
 *
 * harness_plans has NO jsonb columns (content is TEXT, supersedes is text[]), so
 * no jsonb-binding dance is needed — unlike features/issues.
 */

import { getOrgPg } from '@papercusp/db-org';
import { canonicalHarnessSlug } from '../../../harness/operator-home-harness';
import type postgres from 'postgres';
import { FLAGS } from '@papercusp/flags';
import type { TableProjection, ProvenanceContext } from '../projection';
import { observeMergedOp } from '../clobber-events';
import { decideMemberContentOp } from '../member-content-guard';
import type { PendingMembershipContent } from '../pending-membership-content';
import { summarizeForcedPast } from '../../../agent-tools/plans/forced-past-stamp';
import { guardAcceptanceBarTemplateDataWrite } from '../../../agent-tools/plans/rubric-loss-guard';
// LEAF import, deliberately NOT `plans/source` (WI-2141279): a projection module is in
// the perf peer-child's import graph, and `plans/source` transitively reaches
// `agent-tools/locks/configure`, which calls into the stubbed `@papercusp/db-org` at
// module top level and kills the child before it can emit `ready`.
import { deriveIndexFromContent } from '../../../agent-tools/plans/derive-index';
import { writePlanIndexRows } from '../../../agent-tools/plans/plan-index-rows';
import { withPlanDependencyAdmissionTransaction } from '../../../agent-tools/plans/plan-dependency-admission-transaction';
import {
  decideContentWriteAuthority,
  resolveContentWriteMode,
  type ContentWriteMode,
} from '../content-write-authority';

/**
 * P-007 — clobber detection for plans. A REMOTE plan apply (origin='remote')
 * reports the merged op to the clobber tracker; if this device made a LOCAL write
 * to the same plan_slug within the 60s window (recorded by the CDC drain,
 * outbox-drain.ts), it fires a `clobber` event so the user is told "your edit
 * raced X's" instead of losing it silently. The pubkey is the receiver-stamped,
 * unforgeable source identity (provenance.authorPubkey = sourceLogKeyHex, D-004) —
 * never the local own-log key, so a remote apply never self-clobbers. No-op for a
 * local apply or a provenance-less (legacy) op. Pure tracker call; never throws
 * into the projection loop.
 */
function flagPlanClobber(planSlug: string, provenance?: ProvenanceContext): void {
  if (!provenance || provenance.origin !== 'remote' || !planSlug) return;
  if (!provenance.authorPubkey || typeof provenance.ts !== 'number') return;
  try {
    observeMergedOp({
      table: 'plans-by-slug',
      hbKey: planSlug,
      ts: provenance.ts,
      pubkey: provenance.authorPubkey,
    });
  } catch {
    // clobber detection is best-effort observability — never break federation.
  }
}

/**
 * Wire-shape of a plan row in Hyperbee — the federated subset of harness_plans.
 * Defensive on every field: a remote op with a malformed shape is dropped
 * (decodeValue → null) rather than crashing the projection loop.
 */
export interface HarnessPlanRow {
  harness_slug: string;
  plan_slug: string;
  content: string;
  content_hash: string;
  title: string | null;
  status: string | null;
  created: string | null;
  updated: string | null;
  owner: string | null;
  /** P-015 initiative grouping label. Optional on the wire for back-compat —
   *  a peer predating P-015 omits it; we tolerate absence and default to null. */
  initiative?: string | null;
  /** mig 329/331/714 — plan-template provenance, auto-promote policy, and the plan's
   *  declared input schema. Part of the plan's definition, so they federate (a peer/authority
   *  that reads, promotes or STARTS the plan needs them — else they land NULL, data loss:
   *  a peer missing input_schema would compute an empty required-set and let a plan start
   *  with no arguments). OPTIONAL on the wire (pre-329/331/714 back-compat).
   *  template_data + promote_policy + input_schema are JSONB blobs, opaque to the projection. */
  template?: string | null;
  template_data?: unknown;
  promote_policy?: unknown;
  input_schema?: unknown;
  /** EI-21467654382027859 — the SAME argument as input_schema above, applied to the
   *  three columns that were left behind when it landed. A plan's declared OUTPUT
   *  shape, its property schema, and its property VALUES are all part of the plan's
   *  definition: a peer that reads, promotes or ships the plan needs them, and today
   *  they land NULL on every peer. `properties` carries a jsonb_typeof(...) = 'object'
   *  CHECK locally, so a peer must never receive a non-object here.
   *  OPTIONAL on the wire like their siblings — a peer predating them omits the keys,
   *  and a required field would drop that peer's plan rows entirely. */
  output_schema?: unknown;
  property_schema?: unknown;
  properties?: unknown;
  /** Optional redundant wire value from post-861 peers. It is deliberately
   *  opaque and ignored: receivers recompute the index from canonical content. */
  forced_past?: unknown;
  supersedes: string[];
  superseded_by: string | null;
  archived: boolean;
  is_legacy: boolean;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

export function isHarnessPlanRow(input: unknown): input is HarnessPlanRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (!isString(r.harness_slug) || r.harness_slug.length === 0) return false;
  if (!isString(r.plan_slug) || r.plan_slug.length === 0) return false;
  if (!isString(r.content)) return false;
  if (!isString(r.content_hash)) return false;
  if (!isStringOrNull(r.title)) return false;
  if (!isStringOrNull(r.status)) return false;
  if (!isStringOrNull(r.created)) return false;
  if (!isStringOrNull(r.updated)) return false;
  if (!isStringOrNull(r.owner)) return false;
  // Optional (back-compat): a pre-P-015 peer omits initiative entirely.
  if (r.initiative !== undefined && !isStringOrNull(r.initiative)) return false;
  // mig 329/331 — optional on the wire; template is text, the other two are JSONB blobs (accept anything).
  if (r.template !== undefined && !isStringOrNull(r.template)) return false;
  if (!isStringOrNull(r.superseded_by)) return false;
  if (!Array.isArray(r.supersedes) || !r.supersedes.every((s) => typeof s === 'string')) return false;
  if (typeof r.archived !== 'boolean') return false;
  if (typeof r.is_legacy !== 'boolean') return false;
  return true;
}

export interface HarnessPlansProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of the global getOrgPg().sql. */
  sql?: postgres.Sql;
  /**
   * Test seam — the per-PART federation gate (default: getFlag(PLAN_PART_FEDERATION,'system')).
   * plan-federation-regrain-2026-06-13 D-004: when ON, the per-part recompose
   * (projections/harness-plan-parts.ts) is the SOLE writer of harness_plans
   * content + scalars, so this whole-blob projection drops to BOOTSTRAP-ONLY
   * (INSERT … ON CONFLICT DO NOTHING) — it can create a never-seen plan but
   * never UPDATE an existing one, so a stale whole-blob snapshot can never
   * clobber a per-part merge. When OFF, the whole-blob path is authoritative
   * (the full upsert) exactly as before.
   */
  isFlagOn?: () => Promise<boolean>;
  /** WI-259 P-002: hive-home slug when this harness is a hive MEMBER (cross-member content is
   *  membership-gated only when set); undefined for a non-hive / owned-home harness. */
  potHomeSlug?: string;
  /** WI-259 P-002: resolve an op's VERIFIED source-log device pubkey from its receiver-stamped
   *  sourceLogKeyHex (boot's admittedIdentities); threaded via RegisterAllOpts. */
  resolveAuthorDevice?: (sourceLogKeyHex: string) => string | null;
  /** WI-259 P-004: the content-before-membership defer buffer. When the membership guard would
   *  DROP a cross-member op ONLY because the author's hive_members row hasn't federated yet, the
   *  op is buffered here (keyed on the author device) + re-applied when that member joins — not
   *  lost. Undefined ⇒ today's drop (no buffer wired). Threaded via RegisterAllOpts. */
  pendingMemberContent?: PendingMembershipContent;
  /** P-018 / D-012 — resolve the content write-authority mode for this hive. Default: read the
   *  owner-signed policy for opts.potHomeSlug (resolveContentWriteMode) — so a trusted/allowlist
   *  hive stays 'member' (today's behavior, inert) and an `open`/author-scoped hive enforces
   *  per-row ownership. Injectable for tests. Called ONLY on cross-member REMOTE ops (the only
   *  path author-scoping gates), so own-slug/local applies pay nothing. */
  resolveWriteMode?: () => Promise<ContentWriteMode>;
  /** P-018 — identities (unforgeable source-log device) with override authority: the hive owner +
   *  moderators, allowed to overwrite/delete any row (takedown/repair). Default: none. */
  resolvePrivilegedIdentities?: () => Promise<ReadonlySet<string>>;
}

/** Default write-mode resolver: the owner-signed hive policy for this member harness's hive-home.
 *  Absent potHomeSlug (non-hive harness) or no policy ⇒ 'member' (today's behavior). */
async function defaultResolveWriteMode(opts: HarnessPlansProjectionOpts): Promise<ContentWriteMode> {
  if (!opts.potHomeSlug) return 'member';
  try {
    const { getHivePolicy } = await import('../../../hive-policy-store');
    const resolved = await getHivePolicy(opts.workspaceId, opts.potHomeSlug, opts.sql);
    return resolveContentWriteMode(resolved?.policy ?? null);
  } catch {
    // Fail-safe to today's behavior on any read error — never break federation over a policy read.
    return 'member';
  }
}

/**
 * P-018 / D-012 — author-scoped write authority for a cross-member REMOTE plan op. Returns whether
 * the op may apply, and whether the caller should BIND this op's identity as the plan's owner
 * (first-write). Keyed on the UNFORGEABLE `sourceLogDevice` (same identity the membership guard
 * uses), NEVER the forgeable author field. `member` mode (trusted hives) always allows + never
 * binds — byte-identical to today.
 */
async function authorizePlanWrite(
  opts: HarnessPlansProjectionOpts,
  sql: postgres.Sql,
  harnessSlug: string,
  planSlug: string,
  sourceLogDevice: string,
): Promise<{ ok: boolean; bindOwner: boolean }> {
  const mode = opts.resolveWriteMode ? await opts.resolveWriteMode() : await defaultResolveWriteMode(opts);
  if (mode === 'member') return { ok: true, bindOwner: false };
  const [row] = (await sql`
    SELECT owner_author_pubkey FROM harness_shared.harness_plans
     WHERE workspace_id = ${opts.workspaceId} AND harness_slug = ${harnessSlug} AND plan_slug = ${planSlug}
  `) as unknown as Array<{ owner_author_pubkey: string | null }>;
  const privileged = opts.resolvePrivilegedIdentities ? await opts.resolvePrivilegedIdentities() : undefined;
  const decision = decideContentWriteAuthority({
    mode,
    ownerIdentity: row?.owner_author_pubkey ?? null,
    opIdentity: sourceLogDevice,
    privilegedIdentities: privileged,
  });
  return {
    ok: decision.decision === 'allow',
    bindOwner: decision.decision === 'allow' && decision.bindOwner,
  };
}

async function planPartFederationOn(opts: HarnessPlansProjectionOpts): Promise<boolean> {
  if (opts.isFlagOn) return opts.isFlagOn();
  const { getFlag } = await import('@papercusp/flags/server');
  return getFlag(FLAGS.PLAN_PART_FEDERATION, 'system');
}

function composeKey(row: HarnessPlanRow): string {
  // Per-harness Hyperbee → key is just plan_slug.
  return row.plan_slug;
}

/**
 * WI-5720 — canonicalize the AUTHORED harness_slug at the wire boundary.
 *
 * A plan row applies under `row.harness_slug` (writeToPg), so a peer or log-replay
 * that still tags a RETIRED slug re-materialises the plan under a dead harness — one
 * with no registered Pot, invisible in the Pot's plan list, and impossible to drain.
 * Migration 359 closed this on the OUTBOUND capture path only; observed inbound on
 * 2026-07-01→07-09, which re-created 78 `papercup` plan rows months after the rename
 * was declared complete.
 *
 * Canonicalizing here (rather than at each write site) means every downstream
 * consumer — the membership guard, the write-authority check, the PG upsert, the
 * per-part recompose — sees the live slug. Collisions stay safe: the existing
 * `ON CONFLICT … DO NOTHING` (bootstrap path) / LWW-guarded `DO UPDATE` decide
 * whether the incoming op wins, exactly as for any other op on that plan.
 * A non-retired slug passes through byte-identical (same object reference).
 */
function canonicalizeRowSlug(row: HarnessPlanRow): HarnessPlanRow {
  const canonical = canonicalHarnessSlug(row.harness_slug);
  return canonical === row.harness_slug ? row : { ...row, harness_slug: canonical };
}

function decodeValue(raw: unknown): HarnessPlanRow | null {
  return isHarnessPlanRow(raw) ? canonicalizeRowSlug(raw) : null;
}

async function writeToPg(
  opts: HarnessPlansProjectionOpts,
  row: HarnessPlanRow,
  provenance: ProvenanceContext,
): Promise<void> {
  // WI-259 P-002 membership guard (see member-content-guard.ts): own-slug applies; a cross-member
  // op applies iff its VERIFIED source-log device ∈ the hive's CURRENT members. resolveAuthorDevice
  // maps the immutable sourceLogKeyHex (provenance.authorPubkey for a remote op) → the admit-verified device.
  const sourceLogDevice = provenance?.authorPubkey
    ? (opts.resolveAuthorDevice?.(provenance.authorPubkey) ?? null)
    : null;
  const memberDecision = await decideMemberContentOp(row.harness_slug, opts, sourceLogDevice);
  if (memberDecision !== 'apply') {
    // WI-259 P-004: a cross-member op the guard drops ONLY because the author's hive_members row
    // hasn't federated to this peer yet (decision 'defer', author device known) is BUFFERED + re-
    // applied when that member joins (the onMemberApplied drain), instead of lost to the advancing
    // merge cursor. A genuine non-member's op also defers, but the buffer's TTL evicts it (D-007).
    if (memberDecision === 'defer' && sourceLogDevice && opts.pendingMemberContent) {
      opts.pendingMemberContent.defer(
        {
          authorDevice: sourceLogDevice,
          tableTag: 'plans-by-slug',
          rowKey: composeKey(row),
          fedHlc: provenance?.fedHlc ?? null,
          fedTs: provenance?.ts ?? null,
          reapply: () => writeToPg(opts, row, provenance),
        },
        Date.now(),
      );
    }
    if (memberDecision === 'drop' && !sourceLogDevice && provenance?.authorPubkey && opts.pendingMemberContent) {
      opts.pendingMemberContent.deferUnresolvedSourceLog(
        {
          sourceLogKey: provenance.authorPubkey,
          tableTag: 'plans-by-slug',
          rowKey: composeKey(row),
          fedHlc: provenance?.fedHlc ?? null,
          fedTs: provenance?.ts ?? null,
          reapply: () => writeToPg(opts, row, provenance),
        },
        Date.now(),
      );
    }
    return;
  }
  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance.origin;
  const fedTs = provenance?.ts ?? null;
  const fedHlc = provenance?.fedHlc ?? null;
  // The markdown log is canonical. Never trust the optional wire-side index:
  // an older peer may omit it and a stale/malformed sender may disagree with
  // content. Recomputing once at projection time keeps the bounded column true
  // without making every plans:get/list call parse the document.
  const forcedPast = summarizeForcedPast(row.content);
  // P-018 / D-012 — author-scoped write authority. Only a cross-member REMOTE op is gated (a local
  // op is the operator's own write; own-slug is already 'apply'). In a trusted hive the mode is
  // 'member' → always ok, owner never bound (byte-identical to today). In an open/author-scoped
  // hive, a non-owner member's overwrite is REJECTED here, and the first writer binds owner.
  let ownerToBind: string | null = null;
  if (origin === 'remote' && sourceLogDevice) {
    const auth = await authorizePlanWrite(opts, sql, row.harness_slug, row.plan_slug, sourceLogDevice);
    if (!auth.ok) return;
    if (auth.bindOwner) ownerToBind = sourceLogDevice;
  }
  const partFederationOn = await planPartFederationOn(opts);
  const admission = await withPlanDependencyAdmissionTransaction(
    {
      sql,
      workspaceId: opts.workspaceId,
      harnessSlug: row.harness_slug,
      planSlug: row.plan_slug,
      candidateContent: row.content,
      candidateStatus: row.status,
    },
    async (tx) => {
      // P-004/D-005: a federated whole-plan replay is another direct
      // template_data writer. Do not let a remote/migration payload delete or
      // rewrite a started acceptance BAR; canonicalize provenance to the local
      // stored contract before the upsert. Per-part bootstrap inserts have no
      // existing row to overwrite and remain no-clobber.
      let templateDataForWrite = row.template_data;
      if (!partFederationOn && row.template_data !== undefined) {
        const currentRows = await tx<Array<{ template_data: unknown }>>`
          SELECT template_data
            FROM harness_shared.harness_plans
           WHERE workspace_id = ${opts.workspaceId}
             AND harness_slug = ${row.harness_slug}
             AND plan_slug = ${row.plan_slug}
           LIMIT 1
        `;
        const currentTemplateData = currentRows[0]?.template_data;
        if (currentTemplateData !== undefined && currentTemplateData !== null) {
          const guarded = guardAcceptanceBarTemplateDataWrite({
            slug: row.plan_slug,
            storedTemplateData: currentTemplateData,
            nextTemplateData: row.template_data,
            actorId: sourceLogDevice,
          });
          templateDataForWrite = guarded.data;
        }
      }
      // plan-federation-regrain D-004: when per-part federation is ON, the
      // recompose owns content + scalars. This whole-blob path is bootstrap-only.
      if (partFederationOn) {
        const inserted = await tx<Array<{ plan_slug: string }>>`
          INSERT INTO harness_shared.harness_plans
            (workspace_id, harness_slug, plan_slug, content, content_hash, version,
             title, status, created, updated, owner, initiative, template, template_data, promote_policy, input_schema,
             output_schema, property_schema, properties, forced_past, supersedes, superseded_by,
             archived, is_legacy, author_pubkey, owner_author_pubkey, origin, fed_ts, fed_hlc)
          VALUES
            (${opts.workspaceId}, ${row.harness_slug}, ${row.plan_slug}, ${row.content}, ${row.content_hash}, 0,
             ${row.title}, ${row.status}, ${row.created}, ${row.updated}, ${row.owner}, ${row.initiative ?? null},
             ${row.template ?? null}, ${templateDataForWrite == null ? null : JSON.stringify(templateDataForWrite)}::text::jsonb, ${row.promote_policy == null ? null : JSON.stringify(row.promote_policy)}::text::jsonb,
             ${row.input_schema == null ? null : JSON.stringify(row.input_schema)}::text::jsonb,
             ${row.output_schema == null ? null : JSON.stringify(row.output_schema)}::text::jsonb,
             COALESCE(${row.property_schema == null ? null : JSON.stringify(row.property_schema)}::text::jsonb, '{}'::jsonb),
             COALESCE(${row.properties == null ? null : JSON.stringify(row.properties)}::text::jsonb, '{}'::jsonb),
             ${forcedPast == null ? null : JSON.stringify(forcedPast)}::text::jsonb,
             ${row.supersedes}, ${row.superseded_by},
             ${row.archived}, ${row.is_legacy}, ${authorPubkey}, ${ownerToBind}, ${origin}, ${fedTs}, ${fedHlc})
          ON CONFLICT (workspace_id, harness_slug, plan_slug) DO NOTHING
          RETURNING plan_slug
        `;
        // A bootstrap insert creates the plan row without passing through the
        // local write chokepoint, so seed its derived index in the same tx. An
        // existing row is owned by per-part recomposition; never derive from a
        // stale whole-blob snapshot over that row's index.
        if (inserted.length > 0) {
          await writePlanIndexRows(
            tx as unknown as Parameters<typeof writePlanIndexRows>[0],
            { workspaceId: opts.workspaceId, harnessSlug: row.harness_slug, planSlug: row.plan_slug },
            deriveIndexFromContent(row.content),
          );
        }
        return;
      }

      // workspace_id is the LOCAL projection's bound workspace. version is the
      // local CAS counter; op_* remains machine-local and is preserved on update.
      const written = await tx<Array<{ plan_slug: string }>>`
        INSERT INTO harness_shared.harness_plans
          (workspace_id, harness_slug, plan_slug, content, content_hash, version,
           title, status, created, updated, owner, initiative, template, template_data, promote_policy, input_schema,
           output_schema, property_schema, properties, forced_past, supersedes, superseded_by,
           archived, is_legacy, author_pubkey, owner_author_pubkey, origin, fed_ts, fed_hlc)
        VALUES
          (${opts.workspaceId}, ${row.harness_slug}, ${row.plan_slug}, ${row.content}, ${row.content_hash}, 0,
           ${row.title}, ${row.status}, ${row.created}, ${row.updated}, ${row.owner}, ${row.initiative ?? null},
           ${row.template ?? null}, ${templateDataForWrite == null ? null : JSON.stringify(templateDataForWrite)}::text::jsonb, ${row.promote_policy == null ? null : JSON.stringify(row.promote_policy)}::text::jsonb,
           ${row.input_schema == null ? null : JSON.stringify(row.input_schema)}::text::jsonb,
           ${row.output_schema == null ? null : JSON.stringify(row.output_schema)}::text::jsonb,
           COALESCE(${row.property_schema == null ? null : JSON.stringify(row.property_schema)}::text::jsonb, '{}'::jsonb),
           COALESCE(${row.properties == null ? null : JSON.stringify(row.properties)}::text::jsonb, '{}'::jsonb),
           ${forcedPast == null ? null : JSON.stringify(forcedPast)}::text::jsonb,
           ${row.supersedes}, ${row.superseded_by},
           ${row.archived}, ${row.is_legacy}, ${authorPubkey}, ${ownerToBind}, ${origin}, ${fedTs}, ${fedHlc})
        ON CONFLICT (workspace_id, harness_slug, plan_slug) DO UPDATE SET
          content       = EXCLUDED.content,
          content_hash  = EXCLUDED.content_hash,
          version       = harness_shared.harness_plans.version + 1,
          title         = EXCLUDED.title,
          status        = EXCLUDED.status,
          created       = EXCLUDED.created,
          updated       = EXCLUDED.updated,
          owner         = EXCLUDED.owner,
          initiative    = EXCLUDED.initiative,
          template       = EXCLUDED.template,
          template_data  = EXCLUDED.template_data,
          promote_policy = EXCLUDED.promote_policy,
          input_schema   = EXCLUDED.input_schema,
          output_schema  = EXCLUDED.output_schema,
          property_schema = COALESCE(
            ${row.property_schema == null ? null : JSON.stringify(row.property_schema)}::text::jsonb,
            harness_shared.harness_plans.property_schema),
          properties      = COALESCE(
            ${row.properties == null ? null : JSON.stringify(row.properties)}::text::jsonb,
            harness_shared.harness_plans.properties),
          forced_past    = EXCLUDED.forced_past,
          supersedes    = EXCLUDED.supersedes,
          superseded_by = EXCLUDED.superseded_by,
          archived      = EXCLUDED.archived,
          is_legacy     = EXCLUDED.is_legacy,
          author_pubkey = EXCLUDED.author_pubkey,
          origin        = EXCLUDED.origin,
          fed_ts        = EXCLUDED.fed_ts,
          fed_hlc       = EXCLUDED.fed_hlc
        WHERE harness_shared.fed_order_key(EXCLUDED.fed_hlc, EXCLUDED.fed_ts) >= harness_shared.fed_order_key(harness_shared.harness_plans.fed_hlc, harness_shared.harness_plans.fed_ts)
        RETURNING plan_slug
      `;
      if (written.length > 0) {
        await writePlanIndexRows(
          tx as unknown as Parameters<typeof writePlanIndexRows>[0],
          { workspaceId: opts.workspaceId, harnessSlug: row.harness_slug, planSlug: row.plan_slug },
          deriveIndexFromContent(row.content),
        );
      }
    },
  );
  if (!admission.admitted) {
    console.warn(
      `[plan-dependency-admission] rejected federated whole-plan write for '${row.plan_slug}': ` +
        admission.verdict.diagnostics.map((diagnostic) => diagnostic.message).join('; '),
    );
    return;
  }
  flagPlanClobber(row.plan_slug, provenance);
}

async function deleteFromPg(
  opts: HarnessPlansProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
  provenance?: ProvenanceContext,
): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  // P-018 / D-012 — author-scoped DELETE authority. A tombstone for a plan is honored only if its
  // UNFORGEABLE source-log author OWNS the plan (or is privileged) — this is the core fix for "a
  // stranger-member can delete anyone's plan" in an open hive. Only cross-member REMOTE deletes are
  // gated; a local delete is the operator's own. In 'member' mode this is a no-op (today's behavior).
  // WI-41277 class (residual: WI-471233): never infer a local origin from an ABSENT
  // context. This is behaviourally identical to the previous form, which coalesced a
  // missing origin to the local literal before comparing (that coalesced value and an
  // undefined one both compare unequal to 'remote'), but it drops the fail-open SHAPE
  // the explicit-provenance contract forbids: absence now reads as "unknown origin,
  // therefore not authorizable", never as "local, therefore trusted".
  if (provenance?.origin === 'remote') {
    const sourceLogDevice = provenance?.authorPubkey
      ? (opts.resolveAuthorDevice?.(provenance.authorPubkey) ?? null)
      : null;
    if (sourceLogDevice) {
      const auth = await authorizePlanWrite(opts, sql, opts.harnessSlug, key, sourceLogDevice);
      if (!auth.ok) return; // a non-owner cannot delete this plan
    }
  }
  await sql`
    DELETE FROM harness_shared.harness_plans
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      AND plan_slug = ${key}
      -- guard the delete by the SAME fed_order_key() order as the put guard (EI-1698).
      AND (
        (${hlc}::text IS NULL AND ${ts}::bigint IS NULL)
        OR harness_shared.fed_order_key(${hlc}::text, ${ts}::bigint) >= harness_shared.fed_order_key(fed_hlc, fed_ts)
      )
  `;
}

export function buildHarnessPlansProjection(
  opts: HarnessPlansProjectionOpts,
): TableProjection<HarnessPlanRow> {
  return {
    tableTag: 'plans-by-slug',
    // EI-117: CDC-captured table — own-log ops are replays; see TableProjection.skipOwnOps.
    skipOwnOps: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc, provenance) => deleteFromPg(opts, key, delTs, delHlc, provenance),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isHarnessPlanRow,
  flagPlanClobber,
};
