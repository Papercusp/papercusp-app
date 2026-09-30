/** Authenticated creator artifact drafts (shared-pot DAO plan P-007).
 *
 * A draft is the private, reviewable boundary between an authenticated creator
 * and the public listing table. The upload URL is a short-lived capability: it
 * is backed by a one-time token hash in D1, writes to the existing R2 bucket,
 * and is consumed after a hash/size check. This keeps the hosted R2 path today
 * while preserving the provider-neutral ArtifactStore seam for a later move.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../env.ts';
import {
  audit,
  getCreatorDraft,
  insertCreatorDraft,
  listCreatorDrafts,
  markHarnessUnlisted,
  setCreatorDraftArtifact,
  setCreatorDraftState,
  insertHarness,
  normalizeListingKind,
  type CreatorDraftRow,
  type ListingKind,
} from '../db.ts';
import { AuthError, isCupboardOperator, resolveGithubBearer } from '../auth.ts';

const HASH_RE = /^sha256:[0-9a-f]{64}$/i;
const REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const CONTENT_TYPE_RE = /^[^\s/]+\/[A-Za-z0-9.+-]+(?:\s*;.*)?$/;
const MAX_DRAFT_BYTES = 512 * 1024 * 1024;
const UPLOAD_TTL_MS = 15 * 60 * 1000;

interface DraftManifest {
  listing_kind: ListingKind;
  listing_ref?: string | null;
  github_repository_id: number;
  github_owner: string;
  github_name: string;
  github_url: string;
  title: string;
  description?: string | null;
  topic_hex?: string | null;
  project_ref?: string | null;
  blueprint_kind?: string | null;
  provides_tools?: unknown;
  // The CONSUMPTION half of the tool axis (migration 033 / WI-10001747). It is
  // declared and mapped beside `provides_tools` deliberately: this route is the
  // SECOND publish path into `harnesses`, and the original defect was exactly a
  // field one path carried and the other silently dropped.
  uses_tools?: unknown;
  provides_events?: unknown;
  requires_events?: unknown;
  requires_rubrics?: unknown;
  hive_pubkey?: string | null;
  hive_title?: string | null;
  delivery_type?: 'standalone' | 'bundle' | null;
  latest_json_url?: string | null;
  release_repo?: string | null;
  icon_url?: string | null;
  platforms?: unknown;
  artifact: {
    content_hash: string;
    size_bytes: number;
    content_type: string;
  };
}

interface CreateDraftBody {
  manifest?: unknown;
  listing_kind?: unknown;
  listing_ref?: unknown;
  title?: unknown;
  description?: unknown;
  github_repository_id?: unknown;
  github_owner?: unknown;
  github_name?: unknown;
  github_url?: unknown;
  artifact?: unknown;
}

function uuidv4(): string {
  return crypto.randomUUID();
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string | ArrayBuffer): Promise<string> {
  const input = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return hex(await crypto.subtle.digest('SHA-256', input));
}

function token(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function jsonBody(c: Context<{ Bindings: Env }>): Promise<CreateDraftBody> {
  return c.req.json<CreateDraftBody>().catch(() => ({}));
}

function error(c: Context<{ Bindings: Env }>, field: string, reason: string, status = 400): Response {
  return c.json({ error: 'invalid_field', field, reason }, status as 400);
}

function authError(c: Context<{ Bindings: Env }>, e: unknown): Response | null {
  if (e instanceof AuthError) return c.json({ error: 'auth', reason: e.reason }, 401);
  return null;
}

function draftResponse(draft: CreatorDraftRow, uploadUrl?: string): Record<string, unknown> {
  return {
    id: draft.id,
    state: draft.state,
    listing_kind: draft.listing_kind,
    listing_ref: draft.listing_ref,
    title: draft.title,
    description: draft.description,
    artifact: draft.artifact_content_hash
      ? {
          content_hash: draft.artifact_content_hash,
          size_bytes: draft.artifact_size_bytes,
          content_type: draft.artifact_content_type,
          storage_key: draft.artifact_key,
        }
      : null,
    review: draft.reviewed_at
      ? { reviewed_at: draft.reviewed_at, reviewed_by: draft.reviewed_by_github_user_id, reason: draft.review_reason }
      : null,
    published_listing_id: draft.published_listing_id,
    created_at: draft.created_at,
    updated_at: draft.updated_at,
    ...(uploadUrl ? { upload_url: uploadUrl, upload_expires_at: draft.upload_expires_at } : {}),
  };
}

function validateManifest(raw: unknown): { ok: true; manifest: DraftManifest } | { ok: false; field: string; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, field: 'manifest', reason: 'object_required' };
  const value = raw as Record<string, unknown>;
  const kind = normalizeListingKind(value.listing_kind);
  if (!kind) return { ok: false, field: 'listing_kind', reason: 'unknown_kind' };
  const listingRef = value.listing_ref == null ? null : value.listing_ref;
  if (kind !== 'harness' && (typeof listingRef !== 'string' || !REF_RE.test(listingRef))) {
    return { ok: false, field: 'listing_ref', reason: 'required_safe_ref' };
  }
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  if (!title || title.length > 200) return { ok: false, field: 'title', reason: 'non_empty_max_200' };
  const description = value.description == null ? null : value.description;
  if (description != null && (typeof description !== 'string' || description.length > 1000)) {
    return { ok: false, field: 'description', reason: 'string_max_1000' };
  }
  if (!Number.isSafeInteger(value.github_repository_id) || (value.github_repository_id as number) <= 0) {
    return { ok: false, field: 'github_repository_id', reason: 'positive_integer_required' };
  }
  for (const field of ['github_owner', 'github_name', 'github_url'] as const) {
    if (typeof value[field] !== 'string' || !value[field].trim() || value[field].length > 500) {
      return { ok: false, field, reason: 'non_empty_string_required' };
    }
  }
  const artifact = value.artifact;
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return { ok: false, field: 'artifact', reason: 'object_required' };
  }
  const a = artifact as Record<string, unknown>;
  if (typeof a.content_hash !== 'string' || !HASH_RE.test(a.content_hash)) {
    return { ok: false, field: 'artifact.content_hash', reason: 'sha256_hash_required' };
  }
  if (!Number.isSafeInteger(a.size_bytes) || (a.size_bytes as number) <= 0 || (a.size_bytes as number) > MAX_DRAFT_BYTES) {
    return { ok: false, field: 'artifact.size_bytes', reason: `positive_integer_max_${MAX_DRAFT_BYTES}` };
  }
  if (typeof a.content_type !== 'string' || !CONTENT_TYPE_RE.test(a.content_type)) {
    return { ok: false, field: 'artifact.content_type', reason: 'mime_type_required' };
  }
  return {
    ok: true,
    manifest: {
      ...(value as Omit<DraftManifest, 'listing_kind' | 'listing_ref' | 'title' | 'description' | 'artifact'>),
      listing_kind: kind,
      listing_ref: listingRef as string | null,
      title,
      description: description as string | null,
      github_repository_id: value.github_repository_id as number,
      github_owner: value.github_owner as string,
      github_name: value.github_name as string,
      github_url: value.github_url as string,
      artifact: {
        content_hash: (a.content_hash as string).toLowerCase(),
        size_bytes: a.size_bytes as number,
        content_type: a.content_type as string,
      },
    },
  };
}

async function requireUser(c: Context<{ Bindings: Env }>): Promise<{ id: number; login: string } | Response> {
  try {
    return await resolveGithubBearer(c.req.raw);
  } catch (e) {
    return authError(c, e) ?? Promise.reject(e);
  }
}

async function ownerOrOperator(
  c: Context<{ Bindings: Env }>,
  draft: CreatorDraftRow,
): Promise<{ id: number; login: string } | Response> {
  const user = await requireUser(c);
  if (user instanceof Response) return user;
  if (user.id === draft.owner_github_user_id || isCupboardOperator(user.id, c.env)) return user;
  return c.json({ error: 'forbidden' }, 403);
}

export function creatorDraftsRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // Create a private creator draft and mint a one-time, expiring upload URL.
  app.post('/creator-drafts', async (c) => {
    const user = await requireUser(c);
    if (user instanceof Response) return user;
    const body = await jsonBody(c);
    const parsed = validateManifest(body.manifest ?? body);
    if (!parsed.ok) return error(c, parsed.field, parsed.reason);
    const manifest = parsed.manifest;
    const now = Date.now();
    const id = uuidv4();
    const uploadToken = token();
    const expires = now + UPLOAD_TTL_MS;
    const manifestJson = JSON.stringify(manifest);
    await insertCreatorDraft(c.env.DB, {
      id,
      owner_github_user_id: user.id,
      owner_github_login: user.login,
      listing_kind: manifest.listing_kind,
      listing_ref: manifest.listing_ref ?? null,
      title: manifest.title,
      description: manifest.description ?? null,
      manifest_json: manifestJson,
      provenance_json: JSON.stringify({
        pipeline: 'creator-draft-v1',
        owner_github_user_id: user.id,
        owner_github_login: user.login,
        manifest_sha256: await sha256(manifestJson),
        created_at: now,
      }),
      upload_token_hash: await sha256(uploadToken),
      upload_expires_at: expires,
      created_at: now,
    });
    const draft = await getCreatorDraft(c.env.DB, id);
    if (!draft) return c.json({ error: 'draft_create_failed' }, 500);
    const uploadUrl = `${new URL(c.req.url).origin}/creator-drafts/${encodeURIComponent(id)}/artifact?token=${uploadToken}`;
    await audit(c.env.DB, now, 'creator_draft_created', { id, owner_github_user_id: user.id, listing_kind: manifest.listing_kind });
    return c.json(draftResponse(draft, uploadUrl), 201);
  });

  // GET a draft: the owner sees private metadata; operators may inspect it.
  app.get('/creator-drafts/:id', async (c) => {
    const draft = await getCreatorDraft(c.env.DB, c.req.param('id'));
    if (!draft) return c.json({ error: 'not_found' }, 404);
    const auth = await ownerOrOperator(c, draft);
    if (auth instanceof Response) return auth;
    return c.json(draftResponse(draft));
  });

  // Upload bytes to the existing R2 bucket. The capability is single-use and
  // the object is create-only by convention: a second upload cannot overwrite
  // a content-addressed artifact or silently change a submitted draft.
  app.put('/creator-drafts/:id/artifact', async (c) => {
    const draft = await getCreatorDraft(c.env.DB, c.req.param('id'));
    if (!draft) return c.json({ error: 'not_found' }, 404);
    if (draft.state !== 'draft') return c.json({ error: 'draft_not_uploadable', state: draft.state }, 409);
    const supplied = c.req.header('x-upload-token') ?? new URL(c.req.url).searchParams.get('token') ?? '';
    if (!supplied || !draft.upload_token_hash || draft.upload_expires_at == null || Date.now() >= draft.upload_expires_at) {
      return c.json({ error: 'upload_token_expired' }, 410);
    }
    if ((await sha256(supplied)) !== draft.upload_token_hash) return c.json({ error: 'upload_token_invalid' }, 403);
    const manifest = JSON.parse(draft.manifest_json) as DraftManifest;
    const key = `artifacts/cupboard/sha256/${manifest.artifact.content_hash.slice('sha256:'.length)}`;
    if (await c.env.ARTIFACTS.head(key)) return c.json({ error: 'artifact_exists' }, 409);
    const declaredLength = c.req.header('content-length');
    if (declaredLength != null && Number(declaredLength) !== manifest.artifact.size_bytes) {
      return c.json({ error: 'artifact_size_mismatch', expected: manifest.artifact.size_bytes }, 400);
    }
    const bytes = await c.req.raw.arrayBuffer();
    if (bytes.byteLength !== manifest.artifact.size_bytes) {
      return c.json({ error: 'artifact_size_mismatch', expected: manifest.artifact.size_bytes, actual: bytes.byteLength }, 400);
    }
    const actualHash = `sha256:${await sha256(bytes)}`;
    if (actualHash !== manifest.artifact.content_hash) {
      return c.json({ error: 'artifact_hash_mismatch', expected: manifest.artifact.content_hash, actual: actualHash }, 400);
    }
    await c.env.ARTIFACTS.put(key, bytes, {
      httpMetadata: { contentType: manifest.artifact.content_type },
      customMetadata: { draftId: draft.id, contentHash: actualHash, ownerGithubUserId: String(draft.owner_github_user_id) },
    });
    const changes = await setCreatorDraftArtifact(c.env.DB, draft.id, {
      key,
      contentHash: actualHash,
      sizeBytes: bytes.byteLength,
      contentType: manifest.artifact.content_type,
      now: Date.now(),
    });
    if (changes !== 1) return c.json({ error: 'draft_upload_race' }, 409);
    await audit(c.env.DB, Date.now(), 'creator_draft_artifact_uploaded', { id: draft.id, artifact_key: key, content_hash: actualHash });
    return c.json({ ok: true, id: draft.id, artifact: { storage_key: key, content_hash: actualHash, size_bytes: bytes.byteLength } });
  });

  // Submit for maintainer review after the artifact is present and rechecked.
  app.post('/creator-drafts/:id/submit', async (c) => {
    const draft = await getCreatorDraft(c.env.DB, c.req.param('id'));
    if (!draft) return c.json({ error: 'not_found' }, 404);
    const user = await ownerOrOperator(c, draft);
    if (user instanceof Response) return user;
    if (draft.state !== 'draft') return c.json({ error: 'invalid_state', state: draft.state }, 409);
    if (!draft.artifact_key || !draft.artifact_content_hash || draft.artifact_size_bytes == null) {
      return c.json({ error: 'artifact_required' }, 409);
    }
    const stored = await c.env.ARTIFACTS.head(draft.artifact_key);
    if (!stored || stored.size !== draft.artifact_size_bytes) return c.json({ error: 'artifact_missing_or_changed' }, 409);
    const changes = await setCreatorDraftState(c.env.DB, draft.id, 'draft', 'submitted', Date.now());
    if (changes !== 1) return c.json({ error: 'state_changed' }, 409);
    await audit(c.env.DB, Date.now(), 'creator_draft_submitted', { id: draft.id, submitted_by_github_user_id: user.id });
    return c.json({ ok: true, id: draft.id, state: 'submitted' });
  });

  // Owner/maintainer yank or revoke a published draft. Both transitions unlist
  // the public row; revoke is permanent and is retained in the audit trail.
  for (const action of ['yank', 'revoke'] as const) {
    app.post(`/creator-drafts/:id/${action}`, async (c) => {
      const draft = await getCreatorDraft(c.env.DB, c.req.param('id'));
      if (!draft) return c.json({ error: 'not_found' }, 404);
      const user = await ownerOrOperator(c, draft);
      if (user instanceof Response) return user;
      if (!draft.published_listing_id) return c.json({ error: 'not_published' }, 409);
      if (action === 'yank' && draft.state === 'yanked') return c.json({ ok: true, already_yanked: true });
      if (action === 'revoke' && draft.state === 'revoked') return c.json({ ok: true, already_revoked: true });
      if (draft.state !== 'published' && !(action === 'revoke' && draft.state === 'yanked')) {
        return c.json({ error: 'invalid_state', state: draft.state }, 409);
      }
      const now = Date.now();
      await markHarnessUnlisted(c.env.DB, draft.published_listing_id, `creator_draft:${draft.id}:${action}`, now);
      const from = draft.state;
      const to = action === 'yank' ? 'yanked' : 'revoked';
      const changes = await setCreatorDraftState(c.env.DB, draft.id, from, to, now);
      if (changes !== 1) return c.json({ error: 'state_changed' }, 409);
      await audit(c.env.DB, now, `creator_draft_${action}ed`, { id: draft.id, listing_id: draft.published_listing_id, by_github_user_id: user.id });
      return c.json({ ok: true, id: draft.id, state: to });
    });
  }

  // Maintainer queue and review endpoint. Approval publishes through the same
  // authoritative insertHarness primitive as normal listings.
  app.get('/admin/creator-drafts', async (c) => {
    const op = await requireOperatorForDraft(c);
    if (op instanceof Response) return op;
    const raw = new URL(c.req.url).searchParams.get('state');
    const state = raw === 'draft' || raw === 'submitted' || raw === 'approved' || raw === 'rejected' || raw === 'published' || raw === 'yanked' || raw === 'revoked'
      ? raw
      : 'submitted';
    const drafts = await listCreatorDrafts(c.env.DB, { state });
    return c.json({ state, drafts: drafts.map((d) => draftResponse(d)) });
  });

  app.post('/admin/creator-drafts/:id/review', async (c) => {
    const op = await requireOperatorForDraft(c);
    if (op instanceof Response) return op;
    const draft = await getCreatorDraft(c.env.DB, c.req.param('id'));
    if (!draft) return c.json({ error: 'not_found' }, 404);
    if (draft.state !== 'submitted') return c.json({ error: 'not_submitted', state: draft.state }, 409);
    let body: { decision?: unknown; reason?: unknown } = {};
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
    if (body.decision !== 'approve' && body.decision !== 'reject') return error(c, 'decision', 'approve_or_reject');
    if (body.reason != null && (typeof body.reason !== 'string' || body.reason.length > 1000)) return error(c, 'reason', 'string_max_1000');
    const now = Date.now();
    if (body.decision === 'reject') {
      const changes = await setCreatorDraftState(c.env.DB, draft.id, 'submitted', 'rejected', now, { reviewedBy: op.id, reviewReason: (body.reason as string | undefined)?.trim() || null });
      if (changes !== 1) return c.json({ error: 'state_changed' }, 409);
      await audit(c.env.DB, now, 'creator_draft_review_rejected', { id: draft.id, operator_github_user_id: op.id });
      return c.json({ ok: true, id: draft.id, state: 'rejected' });
    }
    const manifest = JSON.parse(draft.manifest_json) as DraftManifest;
    if (!draft.artifact_content_hash || !draft.artifact_key || draft.artifact_size_bytes == null) return c.json({ error: 'artifact_required' }, 409);
    const listingId = uuidv4();
    try {
      await insertHarness(c.env.DB, {
        id: listingId,
        listing_kind: manifest.listing_kind,
        project_ref: manifest.project_ref ?? null,
        listing_ref: manifest.listing_kind === 'harness' ? null : (manifest.listing_ref ?? null),
        github_repository_id: manifest.github_repository_id,
        github_owner: manifest.github_owner,
        github_name: manifest.github_name,
        github_url: manifest.github_url,
        title: manifest.title,
        description: manifest.description ?? null,
        topic_hex: manifest.topic_hex ?? null,
        publisher_github_user_id: draft.owner_github_user_id,
        publisher_github_login: draft.owner_github_login,
        provides_tools: Array.isArray(manifest.provides_tools) ? JSON.stringify(manifest.provides_tools) : null,
        uses_tools: Array.isArray(manifest.uses_tools) ? JSON.stringify(manifest.uses_tools) : null,
        provides_events: Array.isArray(manifest.provides_events) ? JSON.stringify(manifest.provides_events) : null,
        requires_events: Array.isArray(manifest.requires_events) ? JSON.stringify(manifest.requires_events) : null,
        requires_rubrics: Array.isArray(manifest.requires_rubrics) ? JSON.stringify(manifest.requires_rubrics) : null,
        hive_pubkey: manifest.hive_pubkey ?? null,
        hive_title: manifest.hive_title ?? null,
        blueprint_kind: manifest.blueprint_kind ?? null,
        review_status: 'approved',
        delivery_type: manifest.delivery_type ?? null,
        latest_json_url: manifest.latest_json_url ?? null,
        release_repo: manifest.release_repo ?? null,
        icon_url: manifest.icon_url ?? null,
        platforms: Array.isArray(manifest.platforms) ? JSON.stringify(manifest.platforms) : null,
        created_at: now,
      });
    } catch {
      return c.json({ error: 'listing_publish_conflict' }, 409);
    }
    const changes = await setCreatorDraftState(c.env.DB, draft.id, 'submitted', 'published', now, { reviewedBy: op.id, reviewReason: (body.reason as string | undefined)?.trim() || null, publishedListingId: listingId });
    if (changes !== 1) return c.json({ error: 'state_changed_after_publish', listing_id: listingId }, 409);
    await audit(c.env.DB, now, 'creator_draft_published', { id: draft.id, listing_id: listingId, operator_github_user_id: op.id, review_status: 'approved' });
    return c.json({ ok: true, id: draft.id, state: 'published', listing_id: listingId, review_status: 'approved' });
  });

  return app;
}

async function requireOperatorForDraft(c: Context<{ Bindings: Env }>): Promise<{ id: number; login: string } | Response> {
  try {
    const user = await resolveGithubBearer(c.req.raw);
    if (!isCupboardOperator(user.id, c.env)) return c.json({ error: 'forbidden', reason: 'not_an_operator' }, 403);
    return user;
  } catch (e) {
    return authError(c, e) ?? Promise.reject(e);
  }
}
