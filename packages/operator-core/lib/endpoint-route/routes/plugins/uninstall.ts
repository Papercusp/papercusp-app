/**
 * POST /api/plugins/uninstall — papercusp plugin uninstall + runtime reset.
 * Ported from app/api/plugins/uninstall/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { spawn } from 'node:child_process';
import { triggerSnapshotEvent } from '../../../backup';
import { activeWorkspaceId } from '../../../workspace-registry';
import { resolvePapercuspCli } from '../../../papercusp-cli';
import { defineTool } from '@papercusp/agent-mcp';
import { runGovernedOperation } from '../../../resource-governor/execution';
import {
  removeReviewedCapabilityProviderBindings,
  reviewCapabilityProviderUninstall,
  type CapabilityProviderUninstallReview,
} from '../../../cupboard/capability-provider-uninstall';

const PAPERCUSP_BIN = resolvePapercuspCli();

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return runGovernedOperation(
    {
      workspaceId: activeWorkspaceId(),
      namespace: 'plugin-uninstall-cli',
      owner: 'plugins:uninstall',
      admissionClass: 'process',
      demand: { cpuWeight: 0.5, memoryBytes: 128 * 1024 * 1024, fileDescriptors: 3 },
      payloadRef: 'plugins:uninstall:cli',
      metadata: { binary: cmd },
    },
    async () =>
      new Promise((resolve) => {
        const child = spawn(cmd, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', (d) => (stdout += d.toString()));
        child.stderr.on('data', (d) => (stderr += d.toString()));
        child.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + String(e) }));
        child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
      }),
  );
}

function isValidSlug(s: string): boolean {
  return /^@?[a-z0-9][a-z0-9._/-]{0,127}$/i.test(s);
}

export interface PluginUninstallRouteDeps {
  reviewProvider: (slug: string) => Promise<CapabilityProviderUninstallReview>;
  removeBindings: (review: CapabilityProviderUninstallReview) => Promise<{
    removed: number;
    alreadyChanged: number;
  }>;
  snapshot: (slug: string, purgeGrants: boolean) => Promise<void>;
  runCli: (slug: string, purgeGrants: boolean) => Promise<{ code: number; stdout: string; stderr: string }>;
  resetRuntime: () => Promise<void>;
}

function productionDeps(): PluginUninstallRouteDeps {
  return {
    reviewProvider: reviewCapabilityProviderUninstall,
    removeBindings: removeReviewedCapabilityProviderBindings,
    snapshot: async (slug, purgeGrants) => {
      await triggerSnapshotEvent(activeWorkspaceId(), 'pre_destructive', {
        op: 'plugin_uninstall',
        slug,
        purgeGrants,
      }).catch(() => { /* snapshot failures retain the route's existing fail-soft posture */ });
    },
    runCli: (slug, purgeGrants) => {
      const args = ['plugin', 'uninstall', slug];
      if (purgeGrants) args.push('--purge-grants');
      return run(PAPERCUSP_BIN, args);
    },
    resetRuntime: async () => {
      try {
        const { _resetPluginHostForTests } = await import('../../../plugin-host-runtime');
        _resetPluginHostForTests();
      } catch { /* not initialized */ }
      try {
        const { _resetPluginApiRoutesForTests } = await import('../../../plugin-api-mount');
        _resetPluginApiRoutesForTests();
      } catch { /* not initialized */ }
    },
  };
}

/** Two-phase dependency review + exact-token confirmation around the existing CLI uninstall. */
export function createPluginUninstallHandler(deps: PluginUninstallRouteDeps = productionDeps()) {
  return async (req: Request): Promise<Response> => {
    let body: {
      slug?: string;
      purgeGrants?: boolean;
      capabilityReviewToken?: string;
    };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
    }
    const slug = String(body.slug ?? '').trim();
    if (!isValidSlug(slug)) {
      return Response.json({ ok: false, error: `invalid slug "${slug}"` }, { status: 400 });
    }

    let review: CapabilityProviderUninstallReview;
    try {
      review = await deps.reviewProvider(slug);
    } catch (error) {
      return Response.json({
        ok: false,
        error: 'provider_uninstall_review_failed',
        detail: error instanceof Error ? error.message : String(error),
      }, { status: 422 });
    }

    // A token is a consent receipt for the exact binding/identity graph shown.
    // Any graph drift simply returns the new review; no package bytes move.
    if (review.bindings.length > 0 && body.capabilityReviewToken !== review.reviewToken) {
      return Response.json({
        ok: false,
        error: 'provider_has_capability_dependents',
        detail: 'Review the affected pot bindings and installed identities before removing this provider.',
        review,
      }, { status: 409 });
    }

    const purgeGrants = body.purgeGrants === true;
    await deps.snapshot(slug, purgeGrants);
    const result = await deps.runCli(slug, purgeGrants);
    if (result.code !== 0) {
      return Response.json({
        ok: false,
        error: 'papercusp plugin uninstall failed',
        log: [result.stdout, result.stderr].filter(Boolean).join('\n'),
      }, { status: 500 });
    }

    let bindingRemoval: { removed: number; alreadyChanged: number };
    try {
      bindingRemoval = await deps.removeBindings(review);
    } catch (error) {
      return Response.json({
        ok: false,
        error: 'provider_removed_but_capability_unbind_failed',
        detail: error instanceof Error ? error.message : String(error),
        review,
        log: result.stdout,
      }, { status: 500 });
    }
    await deps.resetRuntime();

    return Response.json({
      ok: true,
      slug,
      log: result.stdout,
      review,
      bindingRemoval,
      // The same typed failure vocabulary P-005 consumes at runtime. Returning
      // it here lets the operator surface every unbound class and route rather
      // than collapsing the removal into an unnamed missing-tool condition.
      capabilityUnsatisfied: review.capabilityUnsatisfied,
    });
  };
}

export default defineTool({
  method: 'POST',
  path: '/plugins/uninstall',
  auth: 'loopback',
  handler: createPluginUninstallHandler(),
});
