import { WORKSPACE_HOST_DATA_ROOT } from '@papercusp/deployment-driver';

/**
 * Where a workspace host's durable data disk is mounted, on every provider. The host bootstrap
 * installs the release, the embedded database and the agent state under this path, so it must be
 * mounted before the bootstrap runs.
 */
export const WORKSPACE_HOST_DURABLE_DATA_MOUNT_POINT = '/var/lib/papercusp';

export interface DurableFilesystemScriptInput {
  /**
   * The data disk's block device by a STABLE identity (`/dev/disk/by-id/...`), never a guessed
   * kernel name: the script formats the device when it carries no filesystem, so a wrong path
   * would format the wrong disk.
   */
  devicePath: string;
  /** How long to wait for the device to appear before failing. */
  deviceWaitSec: number;
  /** The controller-authored host bootstrap, run after the mount. */
  hostBootstrapScript?: string;
}

/**
 * The durable data mount, then the controller-authored host bootstrap (plan
 * aws-byoc-gcp-parity-2026-10-01 D-013 point 2: one renderer for GCP and AWS).
 *
 * The bootstrap runs AFTER the mount because it installs the release and its state under paths
 * that live on the durable disk; running it first would write the release onto the boot disk and
 * have the mount hide it. Every mount is also written to fstab with `nofail`, which is what keeps
 * the layout across a reboot on a provider that does not re-run this script at boot.
 */
export function renderDurableFilesystemScript(input: DurableFilesystemScriptInput): string {
  if (!/^\/dev\/disk\/by-id\/[A-Za-z0-9._:-]+$/.test(input.devicePath)) {
    throw new Error(`durable data device must be a /dev/disk/by-id path, got ${JSON.stringify(input.devicePath)}`);
  }
  if (!Number.isInteger(input.deviceWaitSec) || input.deviceWaitSec < 1) {
    throw new Error(`durable data device wait must be a positive whole number of seconds, got ${input.deviceWaitSec}`);
  }
  const userScript = input.hostBootstrapScript?.trim().replace(/^#![^\n]*(?:\n|$)/, '');
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `data_device='${input.devicePath}'`,
    `data_mount='${WORKSPACE_HOST_DURABLE_DATA_MOUNT_POINT}'`,
    `for attempt in $(seq 1 ${input.deviceWaitSec}); do test -b "$data_device" && break; sleep 1; done`,
    'test -b "$data_device"',
    'if ! blkid "$data_device" >/dev/null 2>&1; then mkfs.ext4 -F "$data_device"; fi',
    'data_uuid=$(blkid -s UUID -o value "$data_device")',
    'install -d -m 0750 "$data_mount"',
    'grep -q "^UUID=${data_uuid} " /etc/fstab || printf "UUID=%s %s ext4 defaults,nofail,discard 0 2\\n" "$data_uuid" "$data_mount" >> /etc/fstab',
    'mountpoint -q "$data_mount" || mount "$data_mount"',
    'resize2fs "$data_device"',
    'install -d -m 0750 "$data_mount"/{postgres,repositories,transcripts,workspaces}',
    // ⛔ WORKSPACE + AGENT HOMES MUST LAND ON THE DURABLE DISK (WI-10003296).
    //
    // Upgrades replace the boot disk while retaining only `data_device`. Both identities whose
    // state must survive that operation live below /home: the customer's SSH identity owns its
    // dotfiles and option-A agent credentials, and the isolated agent identity owns its native
    // agent homes. Keeping either on the image loses authentication on every routine upgrade even
    // though the workspace data itself survives.
    //
    // First adoption must use repair (which retains the boot disk) before a destructive upgrade.
    // Publish the first copy by same-filesystem rename: a failed/interrupted copy must never be
    // mistaken for a complete home on retry. Existing durable content, even empty, wins forever.
    // This state must be on disk: it is mounted before the bootstrap or database can start.
    '[[ -d /home && ! -L /home ]] || { echo "workspace home mount target is not a real directory" >&2; exit 1; }',
    'if [[ ! -e "$data_mount/home" && ! -L "$data_mount/home" ]]; then',
    '  home_seed="$(mktemp -d "$data_mount/.home-seed.XXXXXX")"',
    '  cp -a /home/. "$home_seed"/',
    '  mv -T -- "$home_seed" "$data_mount/home"',
    'fi',
    '[[ -d "$data_mount/home" && ! -L "$data_mount/home" ]] || { echo "durable home is not a real directory" >&2; exit 1; }',
    "install -d -m 0755 '/home'",
    'grep -q " /home none bind" /etc/fstab || printf "%s /home none bind 0 0\\n" "$data_mount/home" >> /etc/fstab',
    "mountpoint -q '/home' || mount --bind \"$data_mount/home\" '/home'",
    '[[ "$(stat -c %d:%i /home)" == "$(stat -c %d:%i "$data_mount/home")" ]] || { echo "workspace home is not backed by the durable directory" >&2; exit 1; }',
    // ⛔ CUSTOMER WORKSPACES MUST LAND ON THE DURABLE DISK (WI-2143796, proven on canary-14).
    //
    // WORKSPACE_HOST_DATA_ROOT is `/srv/papercusp/workspaces` — a path on the BOOT disk, which an
    // upgrade DELETES and recreates from the new image while retaining only the data disk.
    // Measured 2026-09-03 on GCP: a file written to that root as the customer SSH user was GONE
    // after a ledger-verified `succeeded|100` upgrade, while the data disk persisted untouched —
    // i.e. every customer workspace was destroyed by a routine image upgrade.
    //
    // Bind, rather than relocating WORKSPACE_HOST_DATA_ROOT itself, because the bootstrap builds a
    // deliberate permission boundary at that path — 0711 on /srv/papercusp so the workspace user can
    // traverse but not list, 0770 + named-user ACLs on the root itself — while $data_mount is
    // 0750 root:$SERVICE_GROUP with the workspace account deliberately NOT in that group (D-043:
    // keep runtime files root-owned and non-readable to the workspace user). Moving the root under
    // $data_mount would put customer workspaces behind a directory the customer is denied, or force
    // that boundary open. A bind mount keeps the entire published path, permission and ACL model
    // byte-identical and changes only which disk the bytes live on. The ACLs are stored in the ext4
    // filesystem on the data disk, so they survive the upgrade too.
    //
    // This runs BEFORE the user bootstrap (see the ordering contract above), so the bootstrap's own
    // `install -d`/`setfacl` on the workspace root write straight through to the durable disk.
    // fstab carries the bind so it survives reboot as well as instance recreation.
    `install -d -m 0711 '${WORKSPACE_HOST_DATA_ROOT.replace(/\/[^/]+$/, '')}'`,
    `install -d '${WORKSPACE_HOST_DATA_ROOT}'`,
    `grep -q " ${WORKSPACE_HOST_DATA_ROOT} none bind" /etc/fstab || printf "%s ${WORKSPACE_HOST_DATA_ROOT} none bind 0 0\\n" "$data_mount/workspaces" >> /etc/fstab`,
    `mountpoint -q '${WORKSPACE_HOST_DATA_ROOT}' || mount --bind "$data_mount/workspaces" '${WORKSPACE_HOST_DATA_ROOT}'`,
    ...(userScript ? ['', '# User-supplied bootstrap follows the durable mount.', userScript] : []),
    '',
  ].join('\n');
}
