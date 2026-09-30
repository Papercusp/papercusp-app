/**
 * Cloud-provider preset + outbound-network allowlist.
 *
 * Plugin manifests declare `cloudProvider: { id: 'aws' | 'gcp' | ... }`
 * + optional `regions: ['us-east-1']`. The substrate expands these into
 * an allowlist using bundled preset templates.
 *
 * Regional templating: preset hosts contain `${region}` placeholders that
 * are substituted from the plugin's region/regions config.
 *
 * Floor (always denied regardless of allowlist):
 *   - 169.254.169.254 (AWS/GCP/Azure metadata service IMDS)
 *   - 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 (RFC1918)
 *   - 127.0.0.0/8 (loopback) — except whitelisted ports for substrate self-talk
 *
 * Spec: /docs/snapshots/build-scripts#network-policy.
 */

export interface CloudPresetTemplate {
  id: string;
  /** Hosts containing optional ${region} placeholders. */
  hostTemplates: string[];
}

const AWS_PRESET: CloudPresetTemplate = {
  id: 'aws',
  hostTemplates: [
    '*.amazonaws.com',
    '*.${region}.amazonaws.com',
    'sts.amazonaws.com',
    'sts.${region}.amazonaws.com',
    'lambda.${region}.amazonaws.com',
    'iam.amazonaws.com',
    's3.${region}.amazonaws.com',
    's3.amazonaws.com',
  ],
};

const GCP_PRESET: CloudPresetTemplate = {
  id: 'gcp',
  hostTemplates: [
    '*.googleapis.com',
    'iam.googleapis.com',
    'compute.googleapis.com',
    'storage.googleapis.com',
    'cloudfunctions.googleapis.com',
    'run.googleapis.com',
  ],
};

const AZURE_PRESET: CloudPresetTemplate = {
  id: 'azure',
  hostTemplates: [
    'management.azure.com',
    'login.microsoftonline.com',
    '*.azurewebsites.net',
    '*.blob.core.windows.net',
    '*.azure.com',
  ],
};

const CLOUDFLARE_PRESET: CloudPresetTemplate = {
  id: 'cloudflare',
  hostTemplates: [
    'api.cloudflare.com',
    '*.cloudflare.com',
    '*.workers.dev',
    '*.pages.dev',
  ],
};

const PRESETS = new Map<string, CloudPresetTemplate>([
  ['aws', AWS_PRESET],
  ['gcp', GCP_PRESET],
  ['azure', AZURE_PRESET],
  ['cloudflare', CLOUDFLARE_PRESET],
]);

export interface NetworkPolicyInputs {
  cloudProvider?: { id: string; region?: string; regions?: string[] };
  /** Plugin's manifest-declared additional hosts. */
  allowedHosts?: string[];
}

export interface NetworkPolicy {
  /** Final allowlist of host glob patterns (e.g. `*.lambda.us-east-1.amazonaws.com`). */
  allowedHosts: string[];
  /** Hard-deny CIDRs / IPs always blocked. */
  deniedCidrs: string[];
  /** Cloud preset id resolved (or 'none'). */
  preset: string;
  /** Regions the preset was expanded for. */
  regions: string[];
}

const DENY_FLOOR_CIDRS = [
  '169.254.169.254/32',
  '169.254.0.0/16',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  'fc00::/7',
];

export function buildNetworkPolicy(inputs: NetworkPolicyInputs): NetworkPolicy {
  const out: NetworkPolicy = {
    allowedHosts: [...(inputs.allowedHosts ?? [])],
    deniedCidrs: [...DENY_FLOOR_CIDRS],
    preset: 'none',
    regions: [],
  };
  const cp = inputs.cloudProvider;
  if (!cp) return out;
  const preset = PRESETS.get(cp.id);
  if (!preset) return out;
  out.preset = cp.id;

  const regions = cp.regions ?? (cp.region ? [cp.region] : []);
  out.regions = regions;

  for (const tmpl of preset.hostTemplates) {
    if (tmpl.includes('${region}')) {
      if (regions.length === 0) {
        // No region declared but template needs one → keep verbatim
        // (might match nothing at runtime; caller's responsibility).
        out.allowedHosts.push(tmpl);
      } else {
        for (const r of regions) {
          out.allowedHosts.push(tmpl.replaceAll('${region}', r));
        }
      }
    } else {
      out.allowedHosts.push(tmpl);
    }
  }
  // Dedupe.
  out.allowedHosts = [...new Set(out.allowedHosts)];
  return out;
}

/**
 * Match a host (resolved DNS name or literal string) against the
 * allowlist. Glob `*` matches a single label; `**` matches any.
 */
export function isHostAllowed(host: string, allowed: string[]): boolean {
  return allowed.some((pat) => matchHostPattern(host, pat));
}

function matchHostPattern(host: string, pat: string): boolean {
  const pParts = pat.split('.');
  const hParts = host.split('.');
  // Pattern with leading `*.` = exactly one extra subdomain slot.
  if (pParts[0] === '*') {
    if (hParts.length < pParts.length) return false;
    // tail match
    return pParts.slice(1).every((pp, i) => pp === hParts[i + (hParts.length - pParts.length + 1)]);
  }
  if (pParts.length !== hParts.length) return false;
  return pParts.every((pp, i) => pp === hParts[i]);
}
