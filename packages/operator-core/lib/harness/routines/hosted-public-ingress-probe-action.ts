/**
 * Durable system action: the standing public-ingress probe for the hosted control plane
 * (WI-10004437).
 *
 * THE GAP THIS CLOSES. The app.papercusp.com tunnel ingress is hand-maintained outside the repo
 * (a cloudflared config in the owner's home), and its catch-all sends every unmatched path to the
 * session-gated portal. Four times a public route family the hosted plane serves was missing its
 * ingress rule, so outside callers got the portal's `portal_auth_required` 401 instead of the plane
 * (WI-10003292, P-014 F2/F3 = WI-10004436, WI-10005066). Each was found by hand, late, during an
 * end-to-end run; nothing in the tree could see the gap, because the gap is in a file the tree does
 * not own. `hosted-public-ingress.ts` derives the route families from the plane's own route keys and
 * checks them two ways; this action runs both checks on a cadence so a missing rule alerts on its own.
 *
 *   1. CONFIG — route every sample through the cloudflared ingress rules and flag one that does not
 *      land on the plane (or a provider-only family that does). Runs only where the config file
 *      exists: the tunnel config lives on the tunnel host alone, so an absent file is logged, not
 *      raised. Any other read failure throws.
 *   2. LIVE — GET every plane sample on the public origin and flag one the portal's session gate
 *      answered, or one that could not be reached. This is the ground truth and always runs.
 *
 * REPORTING. Findings THROW, like `hosted-lifecycle-reconcile-action.ts`: the routines engine records
 * `metadata.last_error`, and the improvements watchdog's `routine-failure` detector raises it. A probe
 * that checked ZERO samples also throws — an empty sample set would otherwise read as a clean pass.
 *
 * Configuration (env, each optional; the defaults are this deployment's):
 *   PAPERCUSP_HOSTED_PUBLIC_ORIGIN    public origin probed live (shared with the hosted runtimes)
 *   PAPERCUSP_HOSTED_INGRESS_CONFIG   cloudflared config holding the ingress rules
 *   PAPERCUSP_HOSTED_INGRESS_SERVICE  service URL the plane's rules must point at
 *
 * Injectable deps (mirrors hosted-lifecycle-reconcile-action.ts) so it is unit-testable offline.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  auditHostedIngressRules,
  parseCloudflaredIngressYaml,
  probeHostedPublicIngress,
  type HostedIngressFinding,
  type HostedIngressProbeFinding,
} from '../../endpoint-route/hosted-public-ingress';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export const HOSTED_PUBLIC_INGRESS_PROBE = 'hosted-public-ingress-probe';

export const DEFAULT_HOSTED_PUBLIC_ORIGIN = 'https://app.papercusp.com';
export const DEFAULT_HOSTED_INGRESS_SERVICE = 'http://localhost:3880';
export const defaultHostedIngressConfigPath = (): string =>
  path.join(homedir(), '.cloudflared', 'papercup-demos.yml');

export interface HostedPublicIngressProbeConfig {
  origin: string;
  configPath: string;
  controlPlaneService: string;
}

export function hostedPublicIngressProbeConfig(env: NodeJS.ProcessEnv = process.env): HostedPublicIngressProbeConfig {
  const pick = (value: string | undefined, fallback: string): string => value?.trim() || fallback;
  return {
    origin: pick(env.PAPERCUSP_HOSTED_PUBLIC_ORIGIN, DEFAULT_HOSTED_PUBLIC_ORIGIN),
    configPath: pick(env.PAPERCUSP_HOSTED_INGRESS_CONFIG, defaultHostedIngressConfigPath()),
    controlPlaneService: pick(env.PAPERCUSP_HOSTED_INGRESS_SERVICE, DEFAULT_HOSTED_INGRESS_SERVICE),
  };
}

export interface HostedPublicIngressProbeDeps {
  config: () => HostedPublicIngressProbeConfig;
  /** Returns the config text, or `null` when the file does not exist on this host. */
  readConfig: (configPath: string) => Promise<string | null>;
  probe: typeof probeHostedPublicIngress;
  log: (message: string) => void;
}

async function readConfigIfPresent(configPath: string): Promise<string | null> {
  try {
    return await readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    throw error;
  }
}

const describeConfigFinding = (f: HostedIngressFinding): string =>
  `config ${f.method} ${f.path} [${f.family}] ${f.problem} -> ${f.service ?? 'no rule'}` +
  (f.ruleNumber === null ? '' : ` (rule ${f.ruleNumber})`);

const describeLiveFinding = (f: HostedIngressProbeFinding): string =>
  `live GET ${f.path} [${f.family}] ${f.problem} status=${f.status ?? 'none'} ${f.detail.slice(0, 80)}`;

export function makeHostedPublicIngressProbeAction(overrides: Partial<HostedPublicIngressProbeDeps> = {}) {
  const deps: HostedPublicIngressProbeDeps = {
    config: () => hostedPublicIngressProbeConfig(),
    readConfig: readConfigIfPresent,
    probe: probeHostedPublicIngress,
    log: (message) => console.log(`[${HOSTED_PUBLIC_INGRESS_PROBE}] ${message}`),
    ...overrides,
  };
  return async (_ctx: SystemActionCtx): Promise<void> => {
    const config = deps.config();
    const hostname = new URL(config.origin).hostname;

    const configText = await deps.readConfig(config.configPath);
    const configAudit =
      configText === null
        ? null
        : auditHostedIngressRules({
            rules: parseCloudflaredIngressYaml(configText),
            hostname,
            controlPlaneService: config.controlPlaneService,
          });
    const live = await deps.probe({ origin: config.origin });

    const problems = [
      ...(configAudit?.findings ?? []).map(describeConfigFinding),
      ...live.findings.map(describeLiveFinding),
    ];
    const summary =
      `${hostname}: config=${configAudit ? `checked=${configAudit.checked} findings=${configAudit.findings.length}` : `absent(${config.configPath})`} ` +
      `live checked=${live.checked} findings=${live.findings.length}`;

    if (live.checked === 0 || (configAudit !== null && configAudit.checked === 0)) {
      throw new Error(`${HOSTED_PUBLIC_INGRESS_PROBE}: checked zero samples, so nothing was measured — ${summary}`);
    }
    if (problems.length > 0) {
      throw new Error(
        `${HOSTED_PUBLIC_INGRESS_PROBE}: ${problems.length} public route(s) do not reach the hosted control plane — ` +
          `${summary}; ${problems.join('; ')}`,
      );
    }
    deps.log(summary);
  };
}

registerSystemAction(HOSTED_PUBLIC_INGRESS_PROBE, makeHostedPublicIngressProbeAction());
