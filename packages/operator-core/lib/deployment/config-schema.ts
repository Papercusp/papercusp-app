/**
 * The operator-side zod boundary schema for a `DeploymentConfig`.
 *
 * `cloud-deployment-layer-2026-06-06` P-003.
 *
 * The generic `@papercusp/deployment-driver` lib owns the TYPE; this is the
 * validator the operator applies where a deployment config crosses an authoring
 * boundary (harness:create, and later the Hive deploy tools). Kept thin — the
 * common envelope only; each driver narrows + validates its own `provider` block.
 */
import { z } from 'zod';
import {
  resolveDeploymentDriver,
  registeredDeploymentTargets,
  type DeploymentConfig,
} from '@papercusp/deployment-driver';
// Side-effect: register the cloud backends (LatitudeDriver) so a non-local
// target resolves at the harness:create boundary.
import './configure';

export const DeploymentConfigSchema = z.object({
  /** Selects the driver. `'local'` = run here (the default for every harness). */
  target: z.string().min(1).default('local'),
  /** Provider region (driver-specific vocabulary). */
  region: z.string().min(1).optional(),
  /** Provider instance size / plan slug (driver-specific). */
  size: z.string().min(1).optional(),
  /** VM (default for cloud) vs bare metal. */
  kind: z.enum(['vm', 'metal', 'local']).optional(),
  /** Opaque reference to the credential bundle to mount on the frame (P-011). */
  credentialRef: z.string().min(1).optional(),
  /** Logical id of the account whose credential this is (P-019/P-020) — a label set
   *  by deploy-time account selection, not a secret. */
  accountId: z.string().min(1).optional(),
  /** Opt-in frame desktop capability (`hive-frame-desktops-live-view` P-001/P-003):
   *  `true` (defaults: 4 Xvfb displays @ 1920x1080x24, one per agent slot) or
   *  `{ displays?, geometry? }` to tune the pool. Default off. */
  desktop: z
    .union([
      z.boolean(),
      z.object({
        displays: z.number().int().min(1).max(64).optional(),
        geometry: z
          .string()
          .regex(/^\d+x\d+x\d+$/, 'geometry must be WxHxDEPTH, e.g. 1920x1080x24')
          .optional(),
      }),
    ])
    .optional(),
  /** Provider-specific extras the selected driver narrows + validates. */
  provider: z.record(z.string(), z.unknown()).optional(),
});

export type DeploymentConfigInput = z.input<typeof DeploymentConfigSchema>;

/** The canonical local config (re-exported as the create-time default). */
export const LOCAL_DEPLOYMENT_CONFIG: DeploymentConfig = { target: 'local' };

export interface ParseDeploymentResult {
  ok: boolean;
  config: DeploymentConfig;
  /** Set when the target has no registered driver (a soft, fail-fast signal). */
  error?: string;
  registeredTargets?: string[];
}

/**
 * Validate + normalize a deployment input, defaulting to `{ target: 'local' }`.
 * Fails fast when a non-local target has no registered driver — creating a
 * harness pinned to a backend that isn't wired up would silently run it in the
 * wrong place. (A cloud backend registers its driver via `configureDeployment`
 * at operator bootstrap, so by the time it's a valid target, this passes.)
 */
export function parseDeploymentConfig(input: unknown): ParseDeploymentResult {
  const parsed = DeploymentConfigSchema.safeParse(input ?? { target: 'local' });
  if (!parsed.success) {
    return {
      ok: false,
      config: LOCAL_DEPLOYMENT_CONFIG,
      error: `invalid deployment config: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }
  const config = parsed.data as DeploymentConfig;
  if (config.target !== 'local') {
    try {
      resolveDeploymentDriver(config); // throws if no driver registered
    } catch {
      return {
        ok: false,
        config,
        error: `no deployment driver registered for target '${config.target}'`,
        registeredTargets: registeredDeploymentTargets(),
      };
    }
  }
  return { ok: true, config };
}
