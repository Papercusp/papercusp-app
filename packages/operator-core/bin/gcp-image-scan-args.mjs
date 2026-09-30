/**
 * Argument construction for the image-scanner VM.
 *
 * The scanner is a private-VM workload just like the clean-room canary: it reaches the
 * guest over IAP, needs egress through the caller-supplied NAT-backed subnet, and must
 * never receive a public IPv4 address. Keeping this argv builder side effect free makes
 * those properties testable without creating a billable GCP resource.
 */
import { CLEAN_ROOM_NETWORK_TAG } from './gcp-clean-room-args.mjs';

/** The scanner shares the existing IAP-only firewall rule with other private VMs. */
export const IMAGE_SCANNER_NETWORK_TAG = CLEAN_ROOM_NETWORK_TAG;

function requiredText(value, path) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path} is required to build image-scanner instance args`);
  }
  return value.trim();
}

/**
 * Build argv for `gcloud compute instances create` for the scanner VM.
 *
 * `subnetwork` is deliberately required. Without it, gcloud silently selects the project's
 * default VPC; that network carries the stock `default-allow-ssh` rule and is not the
 * private, NAT-backed network used by the release's other ephemeral VMs. `--no-address`
 * removes public ingress while the subnet supplies the scanner's egress path and the IAP
 * firewall rule supplies its only SSH path.
 */
export function buildImageScannerInstanceCreateArgs({
  instanceName,
  projectId,
  zone,
  machineType,
  imageFamily,
  imageProject,
  subnetwork,
  diskName,
  startupScriptPath,
}) {
  return [
    'compute',
    'instances',
    'create',
    requiredText(instanceName, 'instanceName'),
    `--project=${requiredText(projectId, 'projectId')}`,
    `--zone=${requiredText(zone, 'zone')}`,
    `--machine-type=${requiredText(machineType, 'machineType')}`,
    `--image-family=${requiredText(imageFamily, 'imageFamily')}`,
    `--image-project=${requiredText(imageProject, 'imageProject')}`,
    `--subnet=${requiredText(subnetwork, 'subnetwork')}`,
    '--no-address',
    '--no-service-account',
    '--no-scopes',
    '--metadata=enable-oslogin=TRUE',
    `--disk=name=${requiredText(diskName, 'diskName')},device-name=candidate,mode=ro,auto-delete=no`,
    `--metadata-from-file=startup-script=${requiredText(startupScriptPath, 'startupScriptPath')}`,
    // Firewall rules select NETWORK TAGS, not labels. Reuse the existing IAP-only rule
    // targeted at CLEAN_ROOM_NETWORK_TAG; the role label below remains scanner-specific.
    `--tags=${IMAGE_SCANNER_NETWORK_TAG}`,
    '--labels=papercusp-artifact=workspace-host,papercusp-role=image-scanner',
    '--quiet',
  ];
}
