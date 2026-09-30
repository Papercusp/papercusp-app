/**
 * P-045 — the hosted door that mirrors a PUBLIC Cupboard release to GitHub
 * Releases (D-056; replaces IPFS as the optional mirror named in D-053).
 *
 * R2 stays the hot copy and the ORIGIN of the bytes: this route never accepts
 * an upload, it copies what the operator already holds. That ordering is the
 * point — the mirror can only ever publish bytes that already passed the
 * hosted publish path, so the mirror cannot become a second, unchecked way in.
 *
 * Two refusals are deliberate and both fail CLOSED:
 *   - an unconfigured deployment answers 503 (`not_configured`), never an
 *     unauthenticated attempt — the same shape as the Stripe secrets (P-010);
 *   - a PRIVATE listing answers 409 and never reaches the network, because a
 *     public copy cannot be recalled once taken (D-022/D-035 ruling 3).
 *
 * The published result is returned as a `DistributionSource` for the caller to
 * record as a `cache-mirrored` event. This route deliberately does NOT write
 * that event itself: distribution facts belong on the hive log (D-055), not to
 * a Worker route, and a mirror that recorded its own authority would be exactly
 * the coupling D-035 ruling 2 forbids.
 */

import {
  cupboardArtifactKey,
  contentHashHex,
} from '@papercusp/operator-core/lib/cupboard/artifact-store.ts';
import { validateDistributionManifest } from '@papercusp/operator-core/lib/p2p/artifact-distribution.ts';
import {
  publishGithubReleaseMirror,
  type GithubMirrorPublishCode,
} from '@papercusp/operator-core/lib/p2p/github-release-mirror.ts';
import { Hono } from 'hono';

import type { Env } from '../env.ts';
import { requireOperator } from './admin.ts';

export interface ReleaseMirrorConfig {
  readonly token: string;
  readonly repo: { readonly owner: string; readonly repo: string };
}

export type ReleaseMirrorConfigError = 'missing_token' | 'missing_repo' | 'malformed_repo';

/**
 * Resolve the owner-installed deploy inputs. Returns the REASON on failure so an
 * operator sees which half is missing; "not configured" alone has sent people
 * hunting for the wrong secret.
 */
export function resolveReleaseMirrorConfig(
  env: Pick<Env, 'GITHUB_RELEASE_MIRROR_TOKEN' | 'GITHUB_RELEASE_MIRROR_REPO'>,
): { ok: true; config: ReleaseMirrorConfig } | { ok: false; reason: ReleaseMirrorConfigError } {
  const token = env.GITHUB_RELEASE_MIRROR_TOKEN?.trim();
  if (!token) return { ok: false, reason: 'missing_token' };
  const slug = env.GITHUB_RELEASE_MIRROR_REPO?.trim();
  if (!slug) return { ok: false, reason: 'missing_repo' };
  const parts = slug.split('/');
  if (parts.length !== 2 || !parts[0]?.trim() || !parts[1]?.trim()) {
    return { ok: false, reason: 'malformed_repo' };
  }
  return { ok: true, config: { token, repo: { owner: parts[0], repo: parts[1] } } };
}

const STATUS_FOR: Readonly<Record<GithubMirrorPublishCode, number>> = {
  'private-not-mirrored': 409,
  'missing-token': 503,
  'invalid-repo': 503,
  'invalid-manifest': 400,
  'content-address-mismatch': 409,
  'too-large': 413,
  'github-error': 502,
};

export function releaseMirrorRoute(options: { fetchImpl?: typeof fetch } = {}): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // POST /admin/release-mirror — publish an already-stored public release's
  // bytes to the GitHub Releases mirror. Idempotent: re-posting the same
  // manifest returns the existing asset rather than re-uploading it.
  app.post('/admin/release-mirror', async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;

    let body: { manifest?: unknown };
    try {
      body = (await c.req.json()) as { manifest?: unknown };
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const shape = validateDistributionManifest(body?.manifest);
    if (!shape.ok) return c.json({ error: 'invalid_manifest', code: shape.code, detail: shape.detail }, 400);
    const manifest = shape.manifest;

    // Checked BEFORE the configuration read: whether this deployment can reach
    // GitHub is irrelevant to whether a private artifact may be mirrored, and
    // answering 503 here would imply that configuring it would help.
    if (manifest.visibility === 'private') {
      return c.json(
        {
          error: 'private_not_mirrored',
          detail: 'a private listing is never published to the public mirror; public copies cannot be recalled once taken',
        },
        409,
      );
    }

    const configured = resolveReleaseMirrorConfig(c.env);
    if (!configured.ok) return c.json({ error: 'not_configured', reason: configured.reason }, 503);

    const storageKey = cupboardArtifactKey(manifest.release.contentHash);
    const stored = await c.env.ARTIFACTS.get(storageKey);
    if (!stored) {
      // R2 is the hot copy and the origin. No object, nothing to mirror.
      return c.json({ error: 'artifact_not_stored', storageKey }, 404);
    }
    const bytes = Buffer.from(await stored.arrayBuffer());

    const result = await publishGithubReleaseMirror(
      { fetchImpl: options.fetchImpl ?? fetch, token: configured.config.token },
      { manifest, bytes, repo: configured.config.repo, nowMs: Date.now() },
    );
    if (!result.ok) {
      return c.json({ error: result.code, detail: result.detail }, STATUS_FOR[result.code] as 400);
    }

    return c.json({
      ok: true,
      rootHash: manifest.rootHash,
      rootHashHex: contentHashHex(manifest.rootHash),
      reused: result.reused,
      locator: result.locator,
      tag: result.tag,
      assetName: result.assetName,
      // Hand back the descriptor to record as a `cache-mirrored` event upstream.
      source: result.source,
    });
  });

  return app;
}
