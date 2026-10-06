/**
 * Self-describing release bytes — the R2 ORIGIN for recipe/plan/goal/template/rubric
 * listings (cupboard-release-pipeline-content-trust-2026-09-16 P-011).
 *
 * WHY THIS IS A SEPARATE ROUTE FILE
 *
 * `routes/listings.ts` carries P-010's spec evidence, and this surface has nothing to do
 * with catalog rows: it stores and serves BYTES by content address. Keeping it out of
 * listings.ts means a change here cannot re-stale that evidence.
 *
 * THE TRUST MODEL
 *
 * The address IS the verification. `PUT /artifacts/sha256/:hex` recomputes the Merkle root
 * of the received bytes with the SAME `buildArtifactPackage` the publisher and the
 * installer use — not a reimplementation, so the three can never disagree about what a
 * "content hash" means — and refuses 422 `content-address-mismatch` unless it equals
 * `:hex`. The Worker therefore never has to trust the uploader about WHAT the bytes are;
 * it only has to be authenticated enough to bound storage abuse (a GitHub bearer, the
 * same credential publishing already requires) and size-capped.
 *
 * Create-only: a second PUT of the same address is a no-op (200 `existed`), because the
 * bytes are by construction identical. There is no overwrite path.
 *
 * `GET /artifacts/sha256/:hex` is tokenless on purpose (installs of public listings are
 * tokenless) but serves ONLY objects this route wrote. R2 key space `artifacts/cupboard/
 * sha256/` is shared with the creator-draft flow, whose bytes are private and addressed
 * by a FLAT digest; the `origin` metadata stamp is what stops this route being a read
 * door onto a private draft whose hash an attacker happens to know.
 */
import { Hono } from 'hono';
import {
  cupboardArtifactKey,
} from '@papercusp/operator-core/lib/cupboard/artifact-store.ts';
import { buildArtifactPackage } from '@papercusp/operator-core/lib/p2p/artifact-package.ts';

import { AuthError, resolveGithubBearer } from '../auth.ts';
import type { Env } from '../env.ts';

/** A recipe/plan/goal dir archive is a handful of small text files; this is a ceiling, not a target. */
export const MAX_SELF_DESCRIBING_ARTIFACT_BYTES = 8 * 1024 * 1024;

/** The `customMetadata.origin` stamp that marks an object as written by THIS route. */
export const SELF_DESCRIBING_ORIGIN = 'self-describing-release';

const HEX64 = /^[0-9a-f]{64}$/;

export function selfDescribingArtifactsRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.put('/artifacts/sha256/:hex', async (c) => {
    const hex = c.req.param('hex').toLowerCase();
    if (!HEX64.test(hex)) return c.json({ error: 'invalid_content_hash' }, 400);

    let user: { id: number; login: string };
    try {
      user = await resolveGithubBearer(c.req.raw);
    } catch (e) {
      if (e instanceof AuthError) {
        return c.json({ error: e.reason, message: e.message }, e.reason === 'github_unreachable' ? 502 : 401);
      }
      throw e;
    }

    const declared = c.req.header('content-length');
    if (declared != null && Number(declared) > MAX_SELF_DESCRIBING_ARTIFACT_BYTES) {
      return c.json({ error: 'artifact_too_large', max_bytes: MAX_SELF_DESCRIBING_ARTIFACT_BYTES }, 413);
    }
    const bytes = Buffer.from(await c.req.raw.arrayBuffer());
    if (bytes.length === 0) return c.json({ error: 'artifact_empty' }, 400);
    if (bytes.length > MAX_SELF_DESCRIBING_ARTIFACT_BYTES) {
      return c.json({ error: 'artifact_too_large', max_bytes: MAX_SELF_DESCRIBING_ARTIFACT_BYTES }, 413);
    }

    // The same function the publisher addressed the bytes with. A mismatch means the
    // uploader is claiming an address the bytes do not hold — refuse, store nothing.
    const contentHash = `sha256:${hex}`;
    const actual = buildArtifactPackage(bytes).rootHash;
    if (actual !== contentHash) {
      return c.json({ error: 'content-address-mismatch', expected: contentHash, actual }, 422);
    }

    const key = cupboardArtifactKey(contentHash);
    const existing = await c.env.ARTIFACTS.head(key);
    if (existing) {
      // The key is shared with the (private) creator-draft flow. An object there that this
      // route did NOT write is not ours to claim or to report as stored.
      if (existing.customMetadata?.origin !== SELF_DESCRIBING_ORIGIN) {
        return c.json({ error: 'artifact_key_occupied' }, 409);
      }
      return c.json({ ok: true, existed: true, content_hash: contentHash, size_bytes: existing.size });
    }

    await c.env.ARTIFACTS.put(key, bytes, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: {
        origin: SELF_DESCRIBING_ORIGIN,
        contentHash,
        uploaderGithubUserId: String(user.id),
      },
    });
    return c.json({ ok: true, existed: false, content_hash: contentHash, size_bytes: bytes.length }, 201);
  });

  app.get('/artifacts/sha256/:hex', async (c) => {
    const hex = c.req.param('hex').toLowerCase();
    if (!HEX64.test(hex)) return c.json({ error: 'invalid_content_hash' }, 400);
    const object = await c.env.ARTIFACTS.get(cupboardArtifactKey(`sha256:${hex}`));
    if (!object || object.customMetadata?.origin !== SELF_DESCRIBING_ORIGIN) {
      return c.json({ error: 'not_found' }, 404);
    }
    return new Response(await object.arrayBuffer(), {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        // Content-addressed: the bytes at this URL can never change.
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  });

  return app;
}
