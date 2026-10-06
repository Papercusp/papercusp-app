import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { WORKSPACE_HOST_BOOTSTRAP_STATUS_CONSOLE_MARKER } from '@papercusp/deployment-driver';
import { renderDurableFilesystemScript } from './durable-filesystem-script';

/**
 * Delivery of the controller-rendered host bootstrap to an EC2 workspace host (plan
 * aws-byoc-gcp-parity-2026-10-01 D-013, WI-10005172).
 *
 * WHY NOT USERDATA: the realistic bootstrap is ~52.7 KB raw and ~14.8 KB gzip; EC2 UserData is
 * capped at 16 KiB raw, and the data volume is attached AFTER RunInstances, so a first-boot script
 * could neither carry the bootstrap nor rely on the volume being there. Instead, once the volume is
 * attached, the controller pushes gzip+base64(durable mount + bootstrap) over SSM Run Command
 * (AWS-RunShellScript). The wrapper verifies the payload's sha256, then starts it as a transient
 * systemd unit so it outlives the Run Command invocation.
 */

/** SSM document the push runs through; the instance profile's SSM agent executes it as root. */
export const AWS_HOST_BOOTSTRAP_SSM_DOCUMENT = 'AWS-RunShellScript';

/**
 * Ceiling on the base64 payload. SSM bounds a document plus its runtime parameters at 64 KB
 * (MaxDocumentSizeExceeded); this leaves room for AWS-RunShellScript and the wrapper lines. The
 * realistic payload measured ~20 KB encoded when this was set.
 */
export const AWS_HOST_BOOTSTRAP_ENCODED_PAYLOAD_MAX_BYTES = 48 * 1024;

/** The transient unit the bootstrap runs as; a re-push while it is still running is a no-op. */
export const AWS_HOST_BOOTSTRAP_UNIT = 'papercusp-workspace-host-bootstrap';

/** Root-only staging directory on the boot disk for the decoded script. */
export const AWS_HOST_BOOTSTRAP_STAGING_DIR = '/var/lib/papercusp-host-bootstrap';

/** The data volume can take a moment to surface as an NVMe device after the attach settles. */
export const AWS_DATA_DEVICE_WAIT_SEC = 300;

/** How long the wrapper itself may run; it only decodes, verifies, and starts the unit. */
export const AWS_HOST_BOOTSTRAP_PUSH_EXECUTION_TIMEOUT_SEC = 120;

const VOLUME_ID = /^vol-[0-9a-f]{8,17}$/;

/**
 * The stable device path of an attached EBS volume on a Nitro instance. The NVMe controller's
 * serial is the volume id without its hyphen, and udev publishes it under /dev/disk/by-id. The
 * attach request's `Device` name is NOT the guest's device name on Nitro, so it is never used.
 */
export function awsEbsNvmeDevicePath(volumeId: string): string {
  if (!VOLUME_ID.test(volumeId)) throw new Error(`aws_workspace_host_volume_id_invalid: ${JSON.stringify(volumeId)}`);
  return `/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${volumeId.replace('-', '')}`;
}

export interface AwsHostBootstrapPush {
  /** The lines passed as AWS-RunShellScript's `commands` parameter. */
  commands: readonly string[];
  /** sha256 of the decoded script the host will run. */
  scriptSha256: string;
  /** Size of the base64 payload carried in `commands`. */
  encodedPayloadBytes: number;
}

/**
 * Render the Run Command lines that install and start the durable mount + host bootstrap for one
 * attached data volume. Refuses a payload over the ceiling here, with the ceiling named, instead of
 * letting SSM reject it with a generic size error mid-provision.
 */
export function renderAwsHostBootstrapPush(input: { volumeId: string; hostBootstrapScript: string }): AwsHostBootstrapPush {
  if (!input.hostBootstrapScript.trim()) throw new Error('aws_workspace_host_bootstrap_empty');
  const script = renderDurableFilesystemScript({
    devicePath: awsEbsNvmeDevicePath(input.volumeId),
    deviceWaitSec: AWS_DATA_DEVICE_WAIT_SEC,
    hostBootstrapScript: input.hostBootstrapScript,
  });
  const scriptSha256 = createHash('sha256').update(script, 'utf8').digest('hex');
  const payload = gzipSync(Buffer.from(script, 'utf8'), { level: 9 }).toString('base64');
  if (payload.length > AWS_HOST_BOOTSTRAP_ENCODED_PAYLOAD_MAX_BYTES) {
    throw new Error(
      `aws_workspace_host_bootstrap_too_large: encoded payload is ${payload.length} bytes; ` +
        `the SSM push ceiling is ${AWS_HOST_BOOTSTRAP_ENCODED_PAYLOAD_MAX_BYTES} bytes`,
    );
  }
  const dir = AWS_HOST_BOOTSTRAP_STAGING_DIR;
  const unit = `${AWS_HOST_BOOTSTRAP_UNIT}.service`;
  // POSIX sh, not bash: AWS-RunShellScript runs `commands` under `sh` (dash on Ubuntu), so there is
  // no shebang and no pipefail. A damaged payload still fails closed — gunzip rejects it, and the
  // sha256 check rejects anything that decodes to the wrong script.
  const commands = [
    'set -eu',
    'umask 077',
    `install -d -m 0700 '${dir}'`,
    `printf '%s' '${payload}' | base64 -d | gunzip > '${dir}/bootstrap.sh.partial'`,
    `printf '%s  %s\\n' '${scriptSha256}' '${dir}/bootstrap.sh.partial' | sha256sum --check --strict --quiet`,
    `mv -f '${dir}/bootstrap.sh.partial' '${dir}/bootstrap.sh'`,
    `state="$(systemctl show -p ActiveState --value '${unit}' 2>/dev/null || true)"`,
    `case "$state" in active|activating|reloading) echo "${AWS_HOST_BOOTSTRAP_UNIT} is already $state"; exit 0;; esac`,
    // Supersede any report a previous run left on the console BEFORE the push returns, so the
    // controller never reads a stale outcome as this run's.
    `printf '%s %s\\n' ${WORKSPACE_HOST_BOOTSTRAP_STATUS_CONSOLE_MARKER} running > /dev/console 2>/dev/null || true`,
    `systemd-run --unit='${AWS_HOST_BOOTSTRAP_UNIT}' --collect --property=Type=exec /bin/bash '${dir}/bootstrap.sh'`,
    `echo "started ${AWS_HOST_BOOTSTRAP_UNIT} sha256=${scriptSha256}"`,
  ];
  return { commands, scriptSha256, encodedPayloadBytes: payload.length };
}
