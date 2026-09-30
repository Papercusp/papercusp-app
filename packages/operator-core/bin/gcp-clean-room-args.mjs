/**
 * Argument construction for the clean-room instance, split out of
 * papercusp-gcp-clean-room.mjs so it can be unit-tested.
 *
 * The binary itself ends in a top-level `await main(...)`, so importing it from a test
 * would execute the CLI. Keeping the argv builder in this side-effect-free module is what
 * makes the flags assertable without booting a VM — and a plumbed-but-unread field is
 * otherwise invisible until it costs a real cloud boot (EI-21744781090863686).
 */

export const DEFAULT_CLEAN_ROOM_MACHINE_TYPE =
  process.env.PAPERCUSP_CLEAN_ROOM_MACHINE_TYPE?.trim() || 'e2-standard-2';

/**
 * The NETWORK TAG every clean-room instance carries, and the tag an IAP firewall rule must
 * target for the run to be reachable.
 *
 * Network tags are NOT labels. Labels (`--labels=`) are inert metadata for accounting;
 * firewall rules select instances by network tag (`--tags=`) and by nothing else. A
 * clean-room VM created without this tag is covered by no ingress rule at all, so IAP's
 * tcp:22 probe is dropped by the implied-deny — the instance still reaches RUNNING, only
 * the SSH path is dead, so the symptom is a full-budget `awaitOsLogin` timeout naming OS
 * Login rather than the firewall (EI-21749232930340104).
 */
export const CLEAN_ROOM_NETWORK_TAG = 'papercusp-clean-room';

/** The fixed range Google's IAP TCP-forwarding fleet connects FROM. Not configurable. */
export const IAP_TCP_FORWARDING_SOURCE_RANGE = '35.235.240.0/20';

function resourceName(value) {
  const normalized = String(value ?? '').trim().replace(/\/+$/, '');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function sameResourceName(left, right) {
  const leftName = resourceName(left);
  const rightName = resourceName(right);
  return leftName !== '' && rightName !== '' && leftName === rightName;
}

function allowsSshTcp22(allowed) {
  return (Array.isArray(allowed) ? allowed : []).some((entry) => {
    if (String(entry?.IPProtocol ?? '').toLowerCase() !== 'tcp') return false;
    const ports = entry?.ports;
    // gcloud omits `ports` entirely to mean ALL ports for that protocol.
    if (ports === undefined || ports === null) return true;
    if (!Array.isArray(ports) || ports.length === 0) return true;
    return ports.some((port) => {
      const spec = String(port).trim();
      if (spec === '22') return true;
      const range = /^(\d+)-(\d+)$/.exec(spec);
      return range ? Number(range[1]) <= 22 && 22 <= Number(range[2]) : false;
    });
  });
}

/**
 * Does this one firewall rule admit IAP SSH to an instance carrying `tag`?
 *
 * Pure on purpose: the whole point of the preflight is to be assertable without a cloud
 * call, and every one of the four ways a rule can silently fail to cover the clean room
 * (disabled, egress, wrong source range, tag-scoped elsewhere) is a data question.
 */
export function iapSshRuleAdmits(rule, tag = CLEAN_ROOM_NETWORK_TAG) {
  if (!rule || rule.disabled === true) return false;
  if (String(rule.direction ?? 'INGRESS').toUpperCase() !== 'INGRESS') return false;
  if (!allowsSshTcp22(rule.allowed)) return false;

  const sources = Array.isArray(rule.sourceRanges) ? rule.sourceRanges.map((r) => String(r).trim()) : [];
  // Accept the exact IAP range, or any broader rule that already contains it.
  if (!sources.includes(IAP_TCP_FORWARDING_SOURCE_RANGE) && !sources.includes('0.0.0.0/0')) return false;

  // No targetTags AND no targetServiceAccounts means the rule applies to EVERY instance in
  // the network, which covers the clean room without naming it.
  const targetTags = Array.isArray(rule.targetTags) ? rule.targetTags : [];
  const targetServiceAccounts = Array.isArray(rule.targetServiceAccounts) ? rule.targetServiceAccounts : [];
  if (targetTags.length === 0 && targetServiceAccounts.length === 0) return true;

  // A service-account-scoped rule can never cover the clean room: it is created
  // --no-service-account precisely so it carries no identity.
  return targetTags.includes(tag);
}

/**
 * Assert that SOME rule in `rules` admits IAP SSH to the clean room, or throw a refusal that
 * names the exact repair.
 *
 * This runs BEFORE the instance is created. Without it the identical misconfiguration costs
 * a billable VM plus the full 12-minute boot budget and then reports a message that sends
 * the reader to IAM instead of the firewall.
 */
export function assertIapSshReachable(rules, { networkName, projectId, tag = CLEAN_ROOM_NETWORK_TAG } = {}) {
  if ((Array.isArray(rules) ? rules : []).some((rule) => iapSshRuleAdmits(rule, tag))) return;
  const network = networkName ?? '<network>';
  throw new Error(
    `no INGRESS firewall rule on network '${network}' admits IAP SSH to the clean room: the run ` +
      `would boot a VM and then time out waiting for OS Login. Create one:\n` +
      `  gcloud compute firewall-rules create ${network}-clean-room-iap \\\n` +
      `    --project=${projectId ?? '<project>'} --network=${network} --direction=INGRESS \\\n` +
      `    --action=allow --rules=tcp:22 --source-ranges=${IAP_TCP_FORWARDING_SOURCE_RANGE} \\\n` +
      `    --target-tags=${tag}`,
  );
}

/**
 * Does this Cloud NAT configuration provide egress for `subnetwork`?
 *
 * Cloud NAT is regional: a NAT on a router in another region cannot serve the guest,
 * even when its policy names the same subnet. The two supported coverage modes are
 * deliberately explicit:
 *   - ALL_SUBNETWORKS_ALL_IP_RANGES covers every subnet in the router's region.
 *   - LIST_OF_SUBNETWORKS covers only a listed subnet, and that entry must include
 *     ALL_IP_RANGES (the bootstrap downloads arbitrary public HTTPS content).
 *
 * The predicate is pure so a malformed/mismatched response can be tested without a cloud
 * call. Callers should pass the router's observed region, not the requested region alone;
 * missing region evidence fails closed.
 */
export function cloudNatCoversSubnetwork(
  nat,
  { subnetwork, region, routerRegion } = {},
) {
  if (!nat || nat.disabled === true || nat.enabled === false) return false;
  if (String(nat.status ?? '').toUpperCase() === 'DISABLED') return false;

  if (region !== undefined) {
    const observedRegions = [routerRegion, nat.routerRegion, nat.region].filter(
      (value) => value !== undefined && value !== null && String(value).trim() !== '',
    );
    if (observedRegions.length === 0 || observedRegions.some((value) => !sameResourceName(value, region))) {
      return false;
    }
  }

  const mode = String(nat.sourceSubnetworkIpRangesToNat ?? '').trim().toUpperCase();
  if (mode === 'ALL_SUBNETWORKS_ALL_IP_RANGES') return true;
  if (mode !== 'LIST_OF_SUBNETWORKS') return false;

  const requestedSubnetwork = resourceName(subnetwork);
  if (!requestedSubnetwork) return false;

  return (Array.isArray(nat.subnetworks) ? nat.subnetworks : []).some((entry) => {
    if (!sameResourceName(entry?.name, requestedSubnetwork)) return false;
    const ranges = Array.isArray(entry?.sourceIpRangesToNat)
      ? entry.sourceIpRangesToNat.map((range) => String(range).trim().toUpperCase())
      : [];
    return ranges.includes('ALL_IP_RANGES');
  });
}

/**
 * Assert that at least one observed Cloud NAT covers the clean-room subnet.
 *
 * This is intentionally a refusal rather than a best-effort warning: with `--no-address`,
 * the bootstrap cannot install packages or download the public release bundle without NAT.
 * Booting first would spend the full VM budget and misreport the failure as an artifact or
 * guest problem.
 */
export function assertCloudNatEgressReachable(
  nats,
  { projectId, networkName, subnetwork, region } = {},
) {
  if (
    (Array.isArray(nats) ? nats : []).some((nat) =>
      cloudNatCoversSubnetwork(nat, { subnetwork, region, routerRegion: nat?.routerRegion }),
    )
  ) {
    return;
  }

  throw new Error(
    `no Cloud NAT in region '${region ?? '<region>'}' covers subnetwork '${subnetwork ?? '<subnetwork>'}' ` +
      `on network '${networkName ?? '<network>'}': the private clean-room guest has no public IP ` +
      `and cannot bootstrap without regional NAT. Configure Cloud NAT with ` +
      `ALL_SUBNETWORKS_ALL_IP_RANGES or LIST_OF_SUBNETWORKS/ALL_IP_RANGES before retrying ` +
      `(project=${projectId ?? '<project>'}).`,
  );
}

/** GCP resource labels accept lowercase letters, digits, `-` and `_`, up to 63 chars. */
function labelValue(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .slice(0, 63);
}

/**
 * Build the argv for `gcloud compute instances create` for a clean-room boot.
 *
 * `subnetwork` is REQUIRED and load-bearing. `--no-address` gives the instance no external
 * IP, so its ONLY route off the box is Cloud NAT on the subnetwork it lands in. Omitting
 * `--subnet` silently places it on the project's `default` network, which has no NAT and no
 * Private Google Access — leaving the fixture's bootstrap.sh with zero egress for its
 * `apt-get install` and its ~273MB bundle + detached-signature download from the public
 * Cupboard URL. `WorkspaceHostBootstrapRelease` mandates PUBLIC HTTPS bundle/signature URLs
 * and offers no local-file source, so that egress is inherent to the contract, not a
 * configuration preference.
 *
 * This does NOT weaken the gate. The property the canary asserts is
 * `publicIpv4Assigned === false` — no public INGRESS. Cloud NAT is egress-only and leaves
 * that property exactly as it was.
 *
 * `role` labels WHICH private-VM run created the instance, because two different subjects
 * share this argv: the post-build canary (`clean-room`, boots the built image) and the
 * pre-build bootstrap acceptance run (`bootstrap-acceptance`, boots stock Ubuntu). They are
 * indistinguishable in the GCP console otherwise, which matters precisely when auditing a
 * leaked instance to find out which run failed to tear itself down.
 */
export function buildCleanRoomInstanceCreateArgs({
  instanceName,
  projectId,
  zone,
  imageName,
  imageProject,
  subnetwork,
  fixtureId,
  machineType = DEFAULT_CLEAN_ROOM_MACHINE_TYPE,
  role = 'clean-room',
}) {
  if (typeof subnetwork !== 'string' || subnetwork.trim() === '') {
    throw new Error(
      'subnetwork is required to build clean-room instance args: --no-address without a ' +
        'NAT-backed subnet leaves the guest with no egress for the bootstrap download',
    );
  }
  return [
    'compute',
    'instances',
    'create',
    instanceName,
    `--project=${projectId}`,
    `--zone=${zone}`,
    `--machine-type=${machineType}`,
    `--image=${imageName}`,
    `--image-project=${imageProject}`,
    `--subnet=${subnetwork.trim()}`,
    '--no-address',
    '--no-service-account',
    '--no-scopes',
    '--metadata=enable-oslogin=TRUE',
    // NETWORK TAG, not a label. Firewall rules select instances by tag and by nothing else,
    // so without this the IAP tcp:22 rule cannot name the clean room and the implied-deny
    // drops the SSH probe (EI-21749232930340104). `assertIapSshReachable` verifies a rule
    // targeting this tag actually exists before the instance is created.
    `--tags=${CLEAN_ROOM_NETWORK_TAG}`,
    `--labels=papercusp-artifact=workspace-host,papercusp-role=${labelValue(role)},papercusp-fixture=${labelValue(fixtureId)}`,
    '--quiet',
  ];
}
