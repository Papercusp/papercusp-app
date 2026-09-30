/**
 * On-demand completion_ref re-check route.
 *
 *   POST /api/harness/:slug/completion-ref/recheck
 *
 * Wraps verifyHarnessFeatures() (papercusp-dogfood-v5 Phase 2 P-016e)
 * so the P-017 FeatureDetail UI's "Re-check verification" button has
 * an HTTP entry point. The verifier daemon also runs in the
 * background every 60s; this route is for the explicit user gesture
 * after a transient network outage or "did the divergence resolve?"
 * audit.
 *
 * Returns the VerificationResult so the UI can show
 * "checked N features, V verified, D divergent, E errors" in a
 * toast or panel.
 *
 * Auth: 'public' — same posture as sibling harness routes (the
 * loopback gate at the host layer is the trust boundary). Calling
 * this route only triggers `git ls-remote` against URLs already in
 * `completion_ref` rows; no new auth surface is opened.
 */

import { defineTool } from '@papercusp/agent-mcp';
import { resolveProject } from '../../../harness-core';

const completionRefRecheck = defineTool({
  method: 'POST',
  path: '/harness/:slug/completion-ref/recheck',
  auth: 'loopback',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolveProject(slug);
    if (!project) {
      return Response.json({ error: 'unknown project' }, { status: 404 });
    }
    const { verifyHarnessFeatures } = await import(
      '../../../harness/completion-ref-verifier'
    );
    const result = await verifyHarnessFeatures(project.slug);
    return Response.json({ ok: true, result });
  },
});

export default [completionRefRecheck];
