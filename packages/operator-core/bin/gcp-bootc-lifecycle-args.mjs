/**
 * Pure input, argv, guest-script and evidence helpers for the P-305 bootc lifecycle proof.
 * Keeping these away from the executable makes every trust-bearing command testable without
 * a GCP call, a reboot, or a registry mutation.
 */
import { createHash } from 'node:crypto';

import { requireDigest, requireText } from './gcp-ephemeral.mjs';

export const P305_LIFECYCLE_SCHEMA_VERSION = 'papercusp-gcp-bootc-lifecycle-v1';
export const P305_RELEASE_REGISTRY_NAMESPACE = '127.0.0.1:5096/papercusp';
export const P305_RELEASE_REGISTRY_REPOSITORY = `${P305_RELEASE_REGISTRY_NAMESPACE}/workspace-host`;
export const P305_LIFECYCLE_MARKER = 'PAPERCUSP-P305-LIFECYCLE';
export const P305_HOST_PREPARE_DIAGNOSTIC_MARKER = 'PAPERCUSP-P305-HOST-PREPARE-DIAGNOSTIC';

const P305_HOST_PREPARE_STATUS_PREFIX = 'PAPERCUSP-P305-HOST-PREPARE-STATUS ';
const P305_HOST_PREPARE_JOURNAL_PREFIX = 'PAPERCUSP-P305-HOST-PREPARE-JOURNAL ';

const VERSION_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const BUCKET_RE = /^gs:\/\/[a-z0-9][a-z0-9._-]{1,221}[a-z0-9]$/;
const UPDATE_REFERENCE_RE =
  /^127\.0\.0\.1:5096\/papercusp\/workspace-host@sha256:([a-f0-9]{64})$/;

function requireVersion(value, path) {
  const version = requireText(value, path);
  if (!VERSION_RE.test(version)) throw new Error(`${path} must be a release basename`);
  return version;
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function parseP305UpdateReference(value, path = 'updateImageReference') {
  const reference = requireText(value, path);
  const match = UPDATE_REFERENCE_RE.exec(reference);
  if (!match) {
    throw new Error(
      `${path} must be an exact digest-pinned ${P305_RELEASE_REGISTRY_REPOSITORY} reference`,
    );
  }
  return {
    reference,
    repository: P305_RELEASE_REGISTRY_REPOSITORY,
    digest: `sha256:${match[1]}`,
  };
}

export function normalizeP305LifecycleInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('P-305 lifecycle input must be an object');
  }
  const stagingBucket = requireText(input.stagingBucket, 'stagingBucket').replace(/\/$/, '');
  if (!BUCKET_RE.test(stagingBucket)) throw new Error('stagingBucket must be an exact gs:// bucket URI');
  const update = parseP305UpdateReference(input.updateImageReference);
  const initialGceTarPath = requireText(input.initialGceTarPath, 'initialGceTarPath');
  if (!initialGceTarPath.startsWith('/')) throw new Error('initialGceTarPath must be absolute');

  return {
    projectId: requireText(input.projectId, 'projectId'),
    zone: requireText(input.zone, 'zone'),
    subnetwork: requireText(input.subnetwork, 'subnetwork'),
    stagingBucket,
    initialGceTarPath,
    initialGceTarSha256: requireDigest(input.initialGceTarSha256, 'initialGceTarSha256'),
    expectedInitialVersion: requireVersion(input.expectedInitialVersion, 'expectedInitialVersion'),
    expectedUpdateVersion: requireVersion(input.expectedUpdateVersion, 'expectedUpdateVersion'),
    updateImageReference: update.reference,
    updateRepository: update.repository,
    updateDigest: update.digest,
    machineType:
      input.machineType === undefined ? 'e2-standard-2' : requireText(input.machineType, 'machineType'),
  };
}

function markerLine(phase, expectedVersion, updateDigest) {
  return [
    `printf '${P305_LIFECYCLE_MARKER} phase=%s release=%s boot_id=%s sentinel_sha256=%s update_digest=%s\\n'`,
    shellQuote(phase),
    '"$actual_release"',
    '"$boot_id"',
    '"$sentinel_sha"',
    shellQuote(updateDigest),
  ].join(' ');
}

/** Recover bounded, typed host-prepare failure evidence before the disposable VM is destroyed. */
export function parseP305HostPrepareDiagnostics(stderr) {
  if (typeof stderr !== 'string' || stderr === '') return null;
  const lines = stderr.split(/\r?\n/);
  const marker = [...lines]
    .reverse()
    .find((line) => line.startsWith(`${P305_HOST_PREPARE_DIAGNOSTIC_MARKER} `));
  if (!marker) return null;
  const match = marker.match(
    /^PAPERCUSP-P305-HOST-PREPARE-DIAGNOSTIC phase=(initial|updated|rolled-back) active_state=([^\s]+) sub_state=([^\s]+) result=([^\s]+) exec_main_status=([^\s]+)$/,
  );
  if (!match) return null;
  const excerpt = (prefix) =>
    lines
      .filter((line) => line.startsWith(prefix))
      .map((line) => line.slice(prefix.length, prefix.length + 240))
      .slice(-6);
  return {
    phase: match[1],
    activeState: match[2],
    subState: match[3],
    result: match[4],
    execMainStatus: /^\d+$/.test(match[5]) ? Number(match[5]) : null,
    statusExcerpt: excerpt(P305_HOST_PREPARE_STATUS_PREFIX),
    journalExcerpt: excerpt(P305_HOST_PREPARE_JOURNAL_PREFIX),
  };
}

/**
 * Build the paired D-043/D-251 identity, ACL, signature and /var-persistence probe.
 * `initial` creates the sentinel and runs both signature controls; later phases must read
 * the exact same sentinel after a real reboot.
 */
export function buildP305PhaseProbeScript({
  phase,
  expectedVersion,
  updateImageReference,
  sentinelToken,
}) {
  if (!['initial', 'updated', 'rolled-back'].includes(phase)) throw new Error(`unsupported phase '${phase}'`);
  const version = requireVersion(expectedVersion, 'expectedVersion');
  const update = parseP305UpdateReference(updateImageReference);
  const token = requireDigest(sentinelToken, 'sentinelToken');
  const sentinelSha256 = createHash('sha256').update(token, 'utf8').digest('hex');
  const initial = phase === 'initial';

  return `#!/usr/bin/bash
set -euo pipefail

phase=${shellQuote(phase)}
expected_release=${shellQuote(version)}
update_ref=${shellQuote(update.reference)}
update_digest=${shellQuote(update.digest)}
sentinel_token=${shellQuote(token)}
expected_sentinel_sha=${shellQuote(sentinelSha256)}
sentinel_dir=/var/lib/papercusp/p305-lifecycle
sentinel_path="$sentinel_dir/$sentinel_token.sentinel"
runtime_root=/opt/papercusp
workspace_root=/srv/papercusp/workspaces
state_root=/var/lib/papercusp
service_user=papercusp
workspace_user=papercusp-workspace
agent_user=papercusp-agent
runtime_read_group=papercusp-runtime-read

fail() { printf 'PAPERCUSP-P305-FAIL phase=%s %s\\n' "$phase" "$*" >&2; exit 1; }
for command in bootc cut find getfacl getent grep journalctl mktemp openssl readlink rmdir runuser sed sha256sum skopeo stat systemctl tail; do
  command -v "$command" >/dev/null 2>&1 || fail "missing-command=$command"
done

if ! systemctl is-active --quiet papercusp-host-prepare.service; then
  active_state="$(systemctl show papercusp-host-prepare.service --property=ActiveState --value 2>/dev/null || true)"
  sub_state="$(systemctl show papercusp-host-prepare.service --property=SubState --value 2>/dev/null || true)"
  service_result="$(systemctl show papercusp-host-prepare.service --property=Result --value 2>/dev/null || true)"
  exec_main_status="$(systemctl show papercusp-host-prepare.service --property=ExecMainStatus --value 2>/dev/null || true)"
  active_state="\${active_state:-unknown}"
  sub_state="\${sub_state:-unknown}"
  service_result="\${service_result:-unknown}"
  exec_main_status="\${exec_main_status:-unknown}"
  { systemctl status papercusp-host-prepare.service --no-pager --full 2>&1 || true; } \
    | tail -n 6 | cut -c1-240 | sed 's/^/${P305_HOST_PREPARE_STATUS_PREFIX}/' >&2
  { journalctl --unit=papercusp-host-prepare.service --boot --no-pager --output=cat --lines=6 2>&1 || true; } \
    | cut -c1-240 | sed 's/^/${P305_HOST_PREPARE_JOURNAL_PREFIX}/' >&2
  printf '${P305_HOST_PREPARE_DIAGNOSTIC_MARKER} phase=%s active_state=%s sub_state=%s result=%s exec_main_status=%s\\n' \
    "$phase" "$active_state" "$sub_state" "$service_result" "$exec_main_status" >&2
  fail host-prepare-not-active
fi
actual_release="$(basename "$(readlink -f "$runtime_root/current")")"
[[ "$actual_release" == "$expected_release" ]] || fail "release=$actual_release expected=$expected_release"

for account in "$service_user" "$workspace_user" "$agent_user"; do
  getent passwd "$account" >/dev/null || fail "missing-account=$account"
done
if id -nG "$workspace_user" | tr ' ' '\\n' | grep -Fx papercusp >/dev/null; then
  fail workspace-user-in-service-group
fi
if id -nG "$agent_user" | tr ' ' '\\n' | grep -Fx papercusp >/dev/null; then
  fail agent-user-in-service-group
fi
for account in "$service_user" "$agent_user"; do
  id -nG "$account" | tr ' ' '\\n' | grep -Fx "$runtime_read_group" >/dev/null \
    || fail "runtime-read-group-missing=$account"
done
if id -nG "$workspace_user" | tr ' ' '\\n' | grep -Fx "$runtime_read_group" >/dev/null; then
  fail workspace-user-in-runtime-read-group
fi
[[ "$(getent group "$runtime_read_group" | cut -d: -f3)" == 912 ]] || fail runtime-read-gid-drift
runtime_member_count="$(getent group "$runtime_read_group" | cut -d: -f4 | tr ',' '\\n' | sed '/^$/d' | wc -l)"
[[ "$runtime_member_count" == 2 ]] || fail "runtime-read-member-count=$runtime_member_count"
runtime_release="$runtime_root/releases/$actual_release"
for path in "$runtime_root" "$runtime_root/releases" "$runtime_release"; do
  [[ "$(stat -c '%U:%G:%a' "$path")" == "root:$runtime_read_group:750" ]] \
    || fail "runtime-metadata=$path:$(stat -c '%U:%G:%a' "$path")"
done
[[ -z "$(find "$runtime_release" -xdev ! -group "$runtime_read_group" -print -quit)" ]] \
  || fail runtime-release-group-drift
runuser -u "$service_user" -- test -r "$runtime_root/current" || fail service-cannot-read-runtime
runuser -u "$service_user" -- test -x "$runtime_root/current" || fail service-cannot-traverse-runtime
runuser -u "$agent_user" -- test -r "$runtime_root/current" || fail agent-cannot-read-runtime
runuser -u "$agent_user" -- test -x "$runtime_root/current" || fail agent-cannot-traverse-runtime
if runuser -u "$workspace_user" -- test -r "$runtime_root/current"; then
  fail workspace-user-can-read-runtime
fi
runuser -u "$service_user" -- test -r "$state_root" || fail service-cannot-read-state
if runuser -u "$workspace_user" -- test -r "$state_root"; then fail workspace-user-can-read-state; fi
if runuser -u "$agent_user" -- test -r "$state_root"; then fail agent-user-can-read-state; fi

if getfacl -cp "$runtime_root" | grep -q '^user:papercusp-agent:'; then
  fail runtime-still-relies-on-named-user-acl
fi
workspace_acl="$(getfacl -cp "$workspace_root")"
for entry in \
  'user:papercusp:rwx' \
  'user:papercusp-workspace:rwx' \
  'user:papercusp-agent:rwx' \
  'default:user:papercusp:rwx' \
  'default:user:papercusp-workspace:rwx' \
  'default:user:papercusp-agent:rwx'; do
  grep -Fx "$entry" <<<"$workspace_acl" >/dev/null || fail "workspace-acl-missing=$entry"
done

probe_dir="$workspace_root/.p305-$sentinel_token-$phase"
runuser -u "$service_user" -- mkdir "$probe_dir" || fail service-cannot-create-workspace
runuser -u "$workspace_user" -- touch "$probe_dir/workspace-user" || fail workspace-user-cannot-write
runuser -u "$agent_user" -- touch "$probe_dir/agent-user" || fail agent-user-cannot-write
runuser -u "$service_user" -- touch "$probe_dir/service-user" || fail service-cannot-write
rm -f -- "$probe_dir/workspace-user" "$probe_dir/agent-user" "$probe_dir/service-user"
rmdir -- "$probe_dir" || fail workspace-probe-cleanup-failed

[[ "$(cat /usr/lib/papercusp/release-registry-namespace)" == ${shellQuote(P305_RELEASE_REGISTRY_NAMESPACE)} ]] \
  || fail registry-namespace-mismatch
grep -F '"127.0.0.1:5096/papercusp"' /etc/containers/policy.json >/dev/null \
  || fail signature-policy-namespace-missing
test -s /etc/pki/papercusp/release-signing.pub || fail release-public-key-missing

${
  initial
    ? `test ! -e "$sentinel_path" || fail sentinel-already-present
install -d -o root -g root -m 0700 "$sentinel_dir"
umask 077
printf '%s' "$sentinel_token" >"$sentinel_path"

# skopeo inspect resolves metadata but does not evaluate containers/image signature policy.
# Keep it only as the cheap reachability/digest control; bootc switch with
# --enforce-container-sigpolicy below is the positive signature-enforcement path.
observed_digest="$(skopeo inspect --tls-verify=false --format '{{.Digest}}' \
  "docker://$update_ref")" || fail update-reference-unreachable
[[ "$observed_digest" == "$update_digest" ]] || fail "signed-digest=$observed_digest expected=$update_digest"

wrong_copy_dir="$(mktemp -d /tmp/p305-wrong-copy.XXXXXX)" || fail wrong-key-copy-dir-create-failed
cleanup_signature_probe() {
  rm -f /tmp/p305-wrong-key.pem /tmp/p305-wrong-key.pub /tmp/p305-wrong-policy.json /tmp/p305-wrong.err
  find "$wrong_copy_dir" -mindepth 1 -delete 2>/dev/null || true
  rmdir -- "$wrong_copy_dir" 2>/dev/null || true
}
trap cleanup_signature_probe EXIT
openssl ecparam -name prime256v1 -genkey -noout -out /tmp/p305-wrong-key.pem >/dev/null 2>&1
openssl ec -in /tmp/p305-wrong-key.pem -pubout -out /tmp/p305-wrong-key.pub >/dev/null 2>&1
sed 's#/etc/pki/papercusp/release-signing.pub#/tmp/p305-wrong-key.pub#g' \
  /etc/containers/policy.json >/tmp/p305-wrong-policy.json
if skopeo copy --policy /tmp/p305-wrong-policy.json --src-tls-verify=false \
  "docker://$update_ref" "dir:$wrong_copy_dir" >/dev/null 2>/tmp/p305-wrong.err; then
  fail wrong-signing-key-was-accepted
fi
grep -Fqi 'cryptographic signature verification failed' /tmp/p305-wrong.err \
  || fail wrong-key-control-did-not-reach-signature-policy
[[ -z "$(find "$wrong_copy_dir" -mindepth 1 -print -quit)" ]] \
  || fail wrong-key-control-wrote-image
`
    : 'test -f "$sentinel_path" || fail persisted-sentinel-missing'
}

sentinel_sha="$(sha256sum "$sentinel_path" | awk '{print $1}')"
[[ "$sentinel_sha" == "$expected_sentinel_sha" ]] \
  || fail "sentinel-sha=$sentinel_sha expected=$expected_sentinel_sha"
boot_id="$(cat /proc/sys/kernel/random/boot_id)"
[[ "$boot_id" =~ ^[0-9a-f-]{36}$ ]] || fail invalid-boot-id
${phase === 'updated' ? 'bootc status --json | grep -F "$update_digest" >/dev/null || fail updated-digest-not-in-bootc-status' : ''}
${markerLine(phase, version, update.digest)}
`;
}

export function buildP305SwitchScript(updateImageReference) {
  const update = parseP305UpdateReference(updateImageReference);
  return `#!/usr/bin/bash
set -euo pipefail
update_ref=${shellQuote(update.reference)}
update_digest=${shellQuote(update.digest)}
registry_config_dir=/etc/containers/registries.conf.d
install -d -o root -g root -m 0755 "$registry_config_dir"
registry_config="$(mktemp --suffix=.conf "$registry_config_dir/papercusp-p305-loopback.XXXXXX")"
cleanup_registry_config() {
  rm -f -- "$registry_config"
}
trap cleanup_registry_config EXIT
cat >"$registry_config" <<'P305_REGISTRY_CONFIG'
[[registry]]
location = "${P305_RELEASE_REGISTRY_NAMESPACE}"
insecure = true
P305_REGISTRY_CONFIG
systemctl mask --runtime --now bootc-fetch-apply-updates.timer bootc-fetch-apply-updates.service >/dev/null 2>&1 || true
observed_digest="$(skopeo inspect --tls-verify=false --format '{{.Digest}}' \
  "docker://$update_ref")"
[[ "$observed_digest" == "$update_digest" ]]
bootc switch --enforce-container-sigpolicy "$update_ref"
cleanup_registry_config
trap - EXIT
bootc status --json | grep -F "$update_digest" >/dev/null
printf 'PAPERCUSP-P305-SWITCH staged_digest=%s\\n' "$update_digest"
`;
}

export function buildP305RollbackScript() {
  return `#!/usr/bin/bash
set -euo pipefail
systemctl mask --runtime --now bootc-fetch-apply-updates.timer bootc-fetch-apply-updates.service >/dev/null 2>&1 || true
bootc rollback
printf 'PAPERCUSP-P305-ROLLBACK queued=true\\n'
`;
}

export function parseP305PhaseMarker(stdout, expectedPhase) {
  const lines = String(stdout)
    .split(/\r?\n/)
    .filter((line) => line.startsWith(`${P305_LIFECYCLE_MARKER} `));
  if (lines.length !== 1) throw new Error(`expected exactly one ${P305_LIFECYCLE_MARKER} marker`);
  const fields = Object.fromEntries(
    lines[0]
      .slice(P305_LIFECYCLE_MARKER.length + 1)
      .split(' ')
      .map((entry) => entry.split('=', 2)),
  );
  if (fields.phase !== expectedPhase) throw new Error(`phase marker '${fields.phase}' does not match '${expectedPhase}'`);
  if (!VERSION_RE.test(fields.release ?? '')) throw new Error('phase marker carried an invalid release');
  if (!/^[0-9a-f-]{36}$/i.test(fields.boot_id ?? '')) throw new Error('phase marker carried an invalid boot id');
  requireDigest(fields.sentinel_sha256, 'phase.sentinel_sha256');
  requireDigest(fields.update_digest, 'phase.update_digest');
  return fields;
}
