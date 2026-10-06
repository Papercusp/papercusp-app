import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import {
  WORKSPACE_HOST_CREDENTIAL_DELIVERY_ENTRYPOINT,
  WORKSPACE_HOST_PUI_COMPANION_PATH,
  WORKSPACE_HOST_PUI_ENTRYPOINT,
  WORKSPACE_HOST_PUI_INSTALL_MANIFEST_PATH,
  workspaceHostReleaseAddressingErrors,
} from './workspace-host-build-manifest';
import { WORKSPACE_HOST_OMP_LOCAL_MODEL } from "./workspace-host-agent-authentication";
import { WORKSPACE_HOST_AGENT_HOME_OMP_LOCAL_MODELS_YML } from './workspace-host-agent-home';
import { WORKSPACE_HOST_CREDENTIAL_DELIVERY_ARGV } from "./workspace-host-credential-delivery";
import { WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV } from "./workspace-host-remote-initializer";
import { assertWorkspaceHostSecretIsolation } from './workspace-host-test-harness';
import {
  APPARMOR_PROFILE_DIR,
  APPARMOR_RESTRICT_UNPRIVILEGED_USERNS_SYSCTL,
  BWRAP_BIN,
  BWRAP_USERNS_GRANT_FUNCTION,
  BWRAP_USERNS_PROBE_ARGS,
  bwrapUsernsGrantShellLines,
} from './bwrap-userns-grant';

/**
 * Provider-neutral bootstrap contract for a durable Papercusp workspace host.
 *
 * The cloud adapter supplies a signed public Server bundle and runs the emitted
 * script as root on stock Ubuntu 24.04. Credentials are deliberately absent:
 * cloud, Git, and agent credentials arrive later through their typed runtime
 * channels and are never rendered into a VM image, startup script, or
 * attestation.
 */
export const WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION =
  'papercusp-workspace-host-bootstrap-v2';
export const WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION = '24.04';

/**
 * The two host models that coexist through the bootc port (P-306; D-280 ordered the PORT before
 * D-262 condition 2 for exactly this reason).
 *
 * `ubuntu-release-bundle` is the shipped model: an Ubuntu 24.04 VM, `apt-get install` for host
 * prerequisites, and a release delivered as a signed tarball that is downloaded, digest-checked,
 * minisign-verified, extracted, and swapped in by moving a symlink.
 *
 * `bootc-image` is the ported model: the host BOOTS the product image, so the package set and
 * the release are already in `/usr` before the first line of this script runs, and an update is
 * `bootc upgrade` — pull, stage into the inactive deployment slot, atomic reboot, `bootc
 * rollback` to undo.
 *
 * ⛔ Neither member may be collapsed away to quiet the types. They describe two hosts that are
 * genuinely both live during the transition, and the whole hazard this union exists to prevent
 * is one model attesting the other's properties.
 */
export const WORKSPACE_HOST_MODELS = [
  'ubuntu-release-bundle',
  'bootc-image',
] as const;
export type WorkspaceHostModel = (typeof WORKSPACE_HOST_MODELS)[number];
export const DEFAULT_WORKSPACE_HOST_MODEL: WorkspaceHostModel =
  'ubuntu-release-bundle';

/**
 * The bootc base the product image is built FROM (`infra/images/bootc/workspace-host.Containerfile`,
 * P-306 half A). Pinned here because the attested `bootc-base-image` check compares the booted
 * deployment's origin against it.
 */
export const WORKSPACE_HOST_BOOTC_BASE_IMAGE =
  'quay.io/centos-bootc/centos-bootc:stream10';

/**
 * The ONE containers signature policy a bootc pull actually consults — D-286.
 *
 * This is not a default or a convention; it is the only path with any effect, and pinning it is
 * what makes D-262 condition 2 ("that policy MUST be asserted by the bootstrap's own verify
 * phase") mean something. MEASURED on the base, with paired controls
 * (`p306-signature-policy-probe.sh` probes D-F):
 *
 * - With no `--policy` flag, `/etc/containers/policy.json` IS consulted: the base's shipped
 *   permissive policy accepts an unsigned image (exit 0), and replacing that same file with
 *   `reject` turns the identical command into "rejected by policy" (exit 1).
 * - A perfectly valid policy at ANY OTHER path is IGNORED without `--policy` — the unsigned copy
 *   still fails, so the other file demonstrably gates nothing.
 * - `bootc upgrade --help` exposes ZERO policy flags, so bootc cannot be pointed elsewhere even
 *   deliberately.
 *
 * Hence the validation below requires EQUALITY rather than merely an absolute path. A render
 * that asserted a well-formed `sigstoreSigned` policy at, say,
 * `/usr/lib/papercusp/release-signature-policy.json` would pass every check it performs and
 * attest `signatureVerified: true` while the pull went through the base's permissive default —
 * a policy that is present, correct, and consulted by nothing. That is D-262's own trap
 * (a mechanism "present, looks adopted, inert until configured") reproduced one level up, and
 * it is exactly the unbacked-boolean class D-252 exists to remove.
 */
export const WORKSPACE_HOST_CONTAINERS_POLICY_PATH = '/etc/containers/policy.json';

/**
 * The update path each model actually performs — declared as a PAIRING, not as two independent
 * unions, and this is the load-bearing part.
 *
 * A bare `updateMode: 'signed-atomic-release-swap' | 'bootc-atomic-image-swap'` union accepts a
 * bootc host that reports `signed-atomic-release-swap`: a claim to have verified a minisign
 * signature over a tarball it never downloaded. That is D-262's trap in miniature — an attested
 * property no code performs — so the union is expressed as a map keyed by model and the
 * validator checks the PAIR, never mere membership.
 */
export const WORKSPACE_HOST_UPDATE_MODE_BY_MODEL = {
  'ubuntu-release-bundle': 'signed-atomic-release-swap',
  'bootc-image': 'bootc-atomic-image-swap',
} as const satisfies Record<WorkspaceHostModel, string>;
export type WorkspaceHostUpdateMode =
  (typeof WORKSPACE_HOST_UPDATE_MODE_BY_MODEL)[WorkspaceHostModel];

export const WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_PREFIX =
  'PAPERCUSP_WORKSPACE_HOST_ATTESTATION=';
/**
 * Emitted by the bootc model INSTEAD of an attestation when the run staged a new deployment and
 * rebooted (P-306).
 *
 * A distinct prefix rather than a `status` field inside the attestation, because the two
 * documents make incompatible claims: an attestation asserts observed properties of a running
 * host, and a host that is rebooting into a deployment it has never executed can assert none of
 * them. Folding "staged" into the attestation would produce a document claiming `status:
 * 'healthy'` about a system that does not yet exist.
 */
export const WORKSPACE_HOST_BOOTSTRAP_STAGED_PREFIX =
  'PAPERCUSP_WORKSPACE_HOST_STAGED=';
export const DEFAULT_WORKSPACE_HOST_SERVICE_USER = 'papercusp';
export const DEFAULT_WORKSPACE_HOST_WORKSPACE_USER = 'papercusp-workspace';
/**
 * The THIRD identity (D-248). Runs the bundled agent CLIs: reads the signed runtime, owns the
 * delivered agent credential homes, writes the scoped workspace root — and is NOT the SSH
 * account, which is what lets D-043's "keep runtime files non-readable to the workspace user"
 * hold exactly as written while the agents remain runnable.
 */
export const DEFAULT_WORKSPACE_HOST_AGENT_USER = 'papercusp-agent';
/**
 * The bootc image's immutable runtime-read capability (D-314): the group that owns the 0750
 * `/opt/papercusp` parents, declared with exactly two members (service + agent) by
 * `infra/images/bootc/papercusp-sysusers.conf` and re-verified on every boot by
 * `papercusp-host-prepare.sh`. On that model it is the agent identity's ONLY path to the
 * runtime (no named-user ACL survives a container commit), so the bootstrap must keep the agent
 * in it rather than clear its supplementary groups (WI-10006173).
 */
export const WORKSPACE_HOST_BOOTC_RUNTIME_READ_GROUP = 'papercusp-runtime-read';
export const WORKSPACE_HOST_RUNTIME_ROOT = '/opt/papercusp';
export const WORKSPACE_HOST_STATE_ROOT = '/var/lib/papercusp';
/**
 * Root-only bootstrap bookkeeping (WI-10006299). The completion marker lived under
 * $RUNTIME_ROOT, which is read-only on a bootc image (/opt is part of the image), so a
 * bootc bootstrap died on its last step. It is not under $STATE_ROOT either: the service
 * user owns that, and could forge the marker to make a later boot skip its restart.
 */
export const WORKSPACE_HOST_BOOTSTRAP_STATE_DIR = '/var/lib/papercusp-bootstrap';
export const WORKSPACE_HOST_DATA_ROOT = '/srv/papercusp/workspaces';
/** Private key and host pin for the operator's loopback PTY hop into the customer identity. */
export const WORKSPACE_HOST_HOSTED_PTY_SSH_KEY = `${WORKSPACE_HOST_STATE_ROOT}/hosted-pty-ssh/id_ed25519`;
export const WORKSPACE_HOST_HOSTED_PTY_KNOWN_HOSTS = `${WORKSPACE_HOST_STATE_ROOT}/hosted-pty-ssh/known_hosts`;
/**
 * Written by the specialised bootc image build from the exact namespace used in
 * both containers policy and registries.d.  Reading this pin avoids deriving a
 * policy key from an OCI reference (and accidentally dropping an explicit
 * registry port or checking the leaf repository when policy is namespace-wide).
 */
export const WORKSPACE_HOST_BOOTC_RELEASE_REGISTRY_SCOPE_PATH =
  '/usr/lib/papercusp/release-registry-namespace';
/**
 * WI-10005830: where `/usr/local` must resolve on a bootc host.
 *
 * On the bootc base `/usr/local` is a real directory inside the read-only `/usr`, so every runtime
 * install the bootstrap makes there (the privileged conduits below, native OMP, the ollama
 * runtime, the customer agent toolchain) died with EROFS — the first AWS bootc clean room that got
 * past install-runtime died on the initializer conduit. The image links `/usr/local` to this
 * machine-local root (`infra/images/bootc/workspace-host.Containerfile`), the layout the base's
 * own `rpm-ostree-0-integration-opt-usrlocal.conf` dropin already creates `/var/usrlocal` for,
 * and `validate-host` asserts the link before anything writes through it. The bundle model keeps
 * an ordinary writable `/usr/local` and never consults this.
 */
export const WORKSPACE_HOST_BOOTC_USR_LOCAL_TARGET = '/var/usrlocal';
/**
 * The `ollama` service account's home, which is also where it stores pulled models. The bundle
 * model keeps the upstream installer's `/usr/share/ollama` (live GCP hosts already carry it); a
 * bootc host cannot create a home under the read-only `/usr`, so it uses machine-local `/var/lib`.
 */
export const WORKSPACE_HOST_OLLAMA_HOME_BY_MODEL = {
  'ubuntu-release-bundle': '/usr/share/ollama',
  'bootc-image': '/var/lib/ollama',
} as const satisfies Record<WorkspaceHostModel, string>;
export const WORKSPACE_HOST_REMOTE_INITIALIZER_CONDUIT =
  "/usr/local/bin/papercusp-workspace-host-initialize";
export const WORKSPACE_HOST_CREDENTIAL_DELIVERY_CONDUIT =
  "/usr/local/bin/papercusp-workspace-host-deliver-credential";
export const WORKSPACE_HOST_PRIVILEGED_CONDUIT_SUDOERS =
  "/etc/sudoers.d/papercusp-workspace-host-conduits";

/**
 * D-403: the hosted desktop connector's enrollment seam. The SSH account runs the conduit; the
 * conduit runs the root PROGRAM through sudo, which redeems ONE single-use ticket (read from
 * stdin) at the control plane and writes the bearer it receives into the service's optional
 * EnvironmentFile. Rendered only when the bootstrap is given a control-plane origin.
 */
export const WORKSPACE_HOST_CONNECTOR_ENROLLMENT_CONDUIT =
  "/usr/local/bin/papercusp-workspace-host-enroll-connector";
export const WORKSPACE_HOST_CONNECTOR_ENROLLMENT_PROGRAM =
  "/usr/local/libexec/papercusp-workspace-host-enroll-connector";
export const WORKSPACE_HOST_CONNECTOR_ENROLLMENT_PROTOCOL_VERSION =
  "papercusp-workspace-host-connector-enrollment-v1";
export const WORKSPACE_HOST_CONNECTOR_ENROLLMENT_ARGV = [
  "--protocol-version",
  WORKSPACE_HOST_CONNECTOR_ENROLLMENT_PROTOCOL_VERSION,
] as const;
/**
 * Read by PID 1 before the service drops privileges, so the file is root-only and the service
 * user never needs to read it. Optional in the unit (`-` prefix): an unenrolled host is unchanged.
 */
export const WORKSPACE_HOST_CONNECTOR_ENVIRONMENT_FILE =
  "/etc/papercusp/hosted-connector.env";

/**
 * Shared libraries supplied by Ubuntu 24.04's glibc runtime.
 *
 * These are deliberately an explicit, small baseline rather than an
 * "ignore anything that looks system-provided" heuristic. A new SONAME must
 * either be shipped inside the signed bundle or acquire an explicit apt
 * provider below, otherwise publication fails closed.
 */
export const WORKSPACE_HOST_GLIBC_SONAMES = [
  'ld-linux-aarch64.so.1',
  'ld-linux-x86-64.so.2',
  'libc.so.6',
  'libdl.so.2',
  'libm.so.6',
  'libpthread.so.0',
  'librt.so.1',
  'libutil.so.1',
  'libresolv.so.2',
] as const;

/**
 * SONAME providers for external native-addon dependencies on Ubuntu 24.04.
 *
 * This is the one contract shared by the publication-time readelf check and
 * the generated host bootstrap. Keeping the provider map beside the apt
 * package list prevents a release guard from passing against a package that
 * the clean-room image never installs.
 */
export const WORKSPACE_HOST_NATIVE_SONAME_TO_APT_PACKAGE = {
  'libasound.so.2': 'libasound2t64',
  'libatomic.so.1': 'libatomic1',
  'libgcc_s.so.1': 'libgcc-s1',
  'liblz4.so.1': 'liblz4-1',
  'libssl.so.3': 'libssl3',
  'libstdc++.so.6': 'libstdc++6',
  'libz.so.1': 'zlib1g',
  'libzstd.so.1': 'libzstd1',
} as const;
export type WorkspaceHostNativeSoname =
  keyof typeof WORKSPACE_HOST_NATIVE_SONAME_TO_APT_PACKAGE;

/** Host packages unrelated to native addon loading. */
export const WORKSPACE_HOST_BOOTSTRAP_SYSTEM_APT_PACKAGES = [
  "acl",
  // Codex's workspace-write sandbox runs every tool command through bwrap; without it every
  // command fails while the run reports success. The `agent-sandbox-userns` check proves it works
  // (WI-10004636).
  "bubblewrap",
  "ca-certificates",
  "curl",
  // The release's content bootstrap shallow-clones the first-party bundle with git
  // (offline-content-bundle-install-io.ts gitCloneShallow). Stock Ubuntu images ship git, so
  // this was never named, and the bootc image (Stream 9) booted without it (WI-10005779).
  "git",
  "jq",
  "minisign",
  "openssh-server",
  "sudo",
  "ufw",
  "unattended-upgrades",
] as const;

/** Packages required by the external SONAME providers above. */
export const WORKSPACE_HOST_BOOTSTRAP_NATIVE_RUNTIME_APT_PACKAGES = [
  'libasound2t64',
  'libatomic1',
  'libgcc-s1',
  'liblz4-1',
  'libssl3',
  'libstdc++6',
  'libzstd1',
  'zlib1g',
] as const;

/**
 * Wall-clock bounds for every networked apt call a host script makes. They are argv-compatible
 * with `apt-get update` / `apt-get install`, so a call site reads `retry 5 apt_install -y …`.
 * `apt_install` fetches under the bound and installs from the local cache without one, because
 * killing dpkg mid-configure leaves a state every later attempt refuses. Exit 124 (timed out)
 * is an ordinary failure to the caller's `retry`.
 */
export const WORKSPACE_HOST_APT_UPDATE_TIMEOUT_SEC = 180;
export const WORKSPACE_HOST_APT_FETCH_TIMEOUT_SEC = 600;
export const APT_BOUNDED_HELPER_LINES: readonly string[] = [
  `apt_update() { timeout -k 30 ${WORKSPACE_HOST_APT_UPDATE_TIMEOUT_SEC} apt-get update "$@"; }`,
  `apt_install() { timeout -k 30 ${WORKSPACE_HOST_APT_FETCH_TIMEOUT_SEC} apt-get install --download-only "$@" && apt-get install "$@"; }`,
];

/**
 * curl has no default timeout at all, so the same stalled connection hangs a download forever.
 * A speed floor (not a total `--max-time`) aborts a stall without capping a large artifact on a
 * slow link; curl's `--retry` treats that abort as transient.
 */
export const WORKSPACE_HOST_CURL_STALL_GUARD = '--connect-timeout 20 --speed-limit 1024 --speed-time 60';

/**
 * Complete apt contract for the generated Ubuntu 24.04 bootstrap.
 *
 * Publication checks should compare their derived provider set against this
 * exact list; the bootstrap below renders this same value.
 */
export const WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES = [
  ...WORKSPACE_HOST_BOOTSTRAP_SYSTEM_APT_PACKAGES,
  ...WORKSPACE_HOST_BOOTSTRAP_NATIVE_RUNTIME_APT_PACKAGES,
] as const;
export type WorkspaceHostBootstrapAptPackage =
  (typeof WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES)[number];

/**
 * Node runtime installed into the AGENT identity's OWN home, for the vendor agent CLIs (D-263).
 *
 * ⚠ This is the SECOND Node on the host and that is deliberate — do not "simplify" it away by
 * pointing the agent at the bundled one. The release bundle's Node lives at
 * `$RELEASE_DIR/bin/node`, in the SAME directory as the psu wrappers named `claude`/`codex`/`omp`,
 * and `AGENT_RUNTIME_PATH` excludes that directory on purpose: a wrapper on the resolve PATH makes
 * `command -v codex` succeed on a host with no vendor runtime at all (the D-247 confusion). Putting
 * the release bin on the agent's PATH to obtain `node` would re-open exactly that hole.
 *
 * And the bundle could not have supplied `npm` regardless: it ships a BARE `node` binary with no
 * npm beside it (verified against the r20 artifact — no `npm`, `npx` or `npm-cli.js` anywhere in
 * the tree), while the apt contract above deliberately ships no nodejs/npm either. `@openai/codex`
 * is published as a ~13KB JS shim whose `bin` is `bin/codex.js` with the real binary in a
 * per-platform optional dependency, so the agent identity needs `npm` to INSTALL it and `node` to
 * RUN it. One official Node tarball supplies both.
 *
 * Pinned to the same version the bundle carries, so a host runs ONE Node version even though it
 * holds two copies. `.tar.gz` and not `.tar.xz`: the apt contract has no `xz-utils`.
 *
 * The tarball is checksum-pinned HERE rather than trusted from the network, which is strictly
 * stronger than the surrounding vendor installers (`curl | bash` for Claude, a bare download for
 * omp) — a compromised or swapped upstream artifact fails the comparison instead of executing.
 * Bumping the version REQUIRES replacing these digests from `https://nodejs.org/dist/v<version>/SHASUMS256.txt`.
 */
export const WORKSPACE_HOST_AGENT_NODE_VERSION = '24.18.1';
export const WORKSPACE_HOST_AGENT_NODE_SHA256: Readonly<Record<'x64' | 'arm64', string>> = {
  x64: '9f5eb6ac21845a66c493c91a253b1da32fd684e89e9b7202d4936982336be4ca',
  arm64: 'df224555a083b918e46260cc969838501b9f9a87140c1195e5b9597b56d5dae2',
};

/**
 * Third-party agent toolchain the CUSTOMER workspace account runs its agents from (plan
 * byoc-cloud-workspaces-gcp-aws-azure-2026-08-22 D-421/D-423, WI-10003195).
 *
 * Customer-driven agents (the portal chat brain, New Session) run as the workspace account, and
 * D-043 makes the Papercusp runtime unreadable to that account — so neither the release's Node nor
 * its psu wrappers are usable there. This directory holds root-owned, world-executable copies of
 * the open-source Node and the vendor agent CLIs the agent identity installed (the same bytes a
 * customer gets from npm / the vendor installer), and NOTHING else: no Papercusp code, and no
 * credential. It sits outside `WORKSPACE_HOST_RUNTIME_ROOT` on purpose.
 */
export const WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_ROOT = '/usr/local/lib/papercusp-agent-toolchain';
export const WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN = `${WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_ROOT}/bin`;

/**
 * WI-10005362: the shared typecheck service's systemd USER template units (one instance per
 * checkout, the instance being the systemd-escaped checkout path). The operator sets
 * `PAPERCUSP_TSC_SERVICE_UNIT_TEMPLATE=<this base>` on hosted agents only when the socket unit file
 * exists, and the checkout's own `scripts/lib/tsc-service.mjs` starts the instance on demand.
 */
export const WORKSPACE_HOST_TSC_SERVICE_UNIT_TEMPLATE = 'papercusp-tsc-service';
export const WORKSPACE_HOST_TSC_SERVICE_SOCKET_UNIT_FILE = `/etc/systemd/user/${WORKSPACE_HOST_TSC_SERVICE_UNIT_TEMPLATE}@.socket`;
export const WORKSPACE_HOST_TSC_SERVICE_UNIT_FILE = `/etc/systemd/user/${WORKSPACE_HOST_TSC_SERVICE_UNIT_TEMPLATE}@.service`;

/**
 * The pinned local-inference runtime (D-266).
 *
 * OMP is credential-free BY CONTRACT — the agent-home bundle sets `files.omp: null` because
 * inventing an auth file would turn absence of credentials into fabricated authentication state
 * (D-245) — and that contract's other half says it "must prove readiness by local inference".
 * Nothing implemented that half, so `omp` could not pass on any host this bootstrap built and the
 * canary sat at 5/6. This installs the half that was missing.
 *
 * WHY THE GPU BUNDLES ARE EXCLUDED. The upstream tarball is ~1.4 GiB, of which MEASURED 2.0 GiB
 * on disk is `cuda_v12` + `cuda_v13` + `vulkan`. A workspace host is a CPU-only e2-standard-2, so
 * every byte of that is dead weight on the boot disk. Extracting without them yields a MEASURED
 * 68 MiB install that serves the model in 1.26s — verified end to end on 2026-09-03 by extracting
 * this exact pinned artifact, serving it, pulling the model and generating.
 *
 * Bumping the version REQUIRES replacing these digests from the release's own `sha256sum.txt`
 * (or the GitHub release API's asset `digest`), exactly as the Node pin above does. The digest is
 * the trust boundary: this is a root install, and pinning it is what makes a swapped upstream
 * artifact fail the comparison instead of executing. `curl | sh` — the vendor's own documented
 * install path — is deliberately NOT used here for that reason.
 */
export const WORKSPACE_HOST_OLLAMA_VERSION = '0.33.3';
export const WORKSPACE_HOST_OLLAMA_SHA256: Readonly<Record<'x64' | 'arm64', string>> = {
  x64: 'c13cea8f3389db4145f8a6cb88d1747242a48639d7c13e3bda7c1ebdc6eebb2f',
  arm64: '4425a112af999ae6572c1ce211fbabeaca7bab23ed5860972acdfc0cc2358420',
};

export interface WorkspaceHostNativeDependencyProvider {
  soname: string;
  aptPackage: string;
}

export interface WorkspaceHostNativeDependencyCoverageInput {
  /** The union of NEEDED SONAMEs read from every bundled `*.node`. */
  neededSonames: Iterable<string>;
  /** SONAMEs whose shared objects are shipped inside the release bundle. */
  bundleInternalSonames?: Iterable<string>;
  /** Defaults to WORKSPACE_HOST_GLIBC_SONAMES; override only for another image ABI. */
  glibcSonames?: Iterable<string>;
  /** Defaults to WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES. */
  aptPackages?: Iterable<string>;
}

export interface WorkspaceHostNativeDependencyCoverage {
  ok: boolean;
  neededSonames: readonly string[];
  bundleInternalSonames: readonly string[];
  glibcSonames: readonly string[];
  /** NEEDED SONAMEs not satisfied by the bundle or glibc baseline. */
  externalSonames: readonly string[];
  /** External SONAMEs without an explicit provider mapping. */
  unknownSonames: readonly string[];
  /** Unique apt packages required by mapped external SONAMEs. */
  requiredAptPackages: readonly string[];
  /** Required provider packages absent from the supplied apt contract. */
  missingAptPackages: readonly string[];
  providers: readonly WorkspaceHostNativeDependencyProvider[];
}

function normalizedSonames(values: Iterable<string>): string[] {
  return [
    ...new Set(
      [...values]
        .map((value) => normalizeWorkspaceHostSoname(value))
        .filter((value) => value.length > 0),
    ),
  ].sort();
}

function normalizedAptPackages(values: Iterable<string>): string[] {
  return [
    ...new Set(
      [...values]
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ].sort();
}

/**
 * Normalize a SONAME copied from readelf or a hand-built test fixture.
 *
 * `readelf -d` emits `Shared library: [libfoo.so.1]`; accepting the bracketed
 * form here keeps the parser and the evaluator on the same canonical keys.
 */
export function normalizeWorkspaceHostSoname(value: string): string {
  const trimmed = value.trim();
  const bracketed = /^\[([^\]]+)\]$/.exec(trimmed);
  return (bracketed?.[1] ?? trimmed).trim();
}

/**
 * Parse the NEEDED entries emitted by `readelf -d`.
 *
 * Other dynamic-section entries are intentionally ignored. Returning a sorted
 * union makes publication manifests reproducible even when archive traversal
 * order changes.
 */
export function parseWorkspaceHostReadelfNeeded(
  readelfOutput: string,
): readonly string[] {
  const matches = readelfOutput.matchAll(
    /Shared library:\s*\[([^\]]+)\]/g,
  );
  return normalizedSonames([...matches].map((match) => match[1] ?? ''));
}

/**
 * Evaluate whether a bundle's native-addon NEEDED union is covered.
 *
 * The evaluator is deliberately pure so publication can run it over the
 * archive's measured bytes, while bootstrap generation can consume the same
 * apt contract without importing a shell/process adapter.
 */
export function evaluateWorkspaceHostNativeDependencyCoverage(
  input: WorkspaceHostNativeDependencyCoverageInput,
): WorkspaceHostNativeDependencyCoverage {
  const neededSonames = normalizedSonames(input.neededSonames);
  const bundleInternalSonames = normalizedSonames(
    input.bundleInternalSonames ?? [],
  );
  const glibcSonames = normalizedSonames(
    input.glibcSonames ?? WORKSPACE_HOST_GLIBC_SONAMES,
  );
  const ignored = new Set([...bundleInternalSonames, ...glibcSonames]);
  const externalSonames = neededSonames.filter(
    (soname) => !ignored.has(soname),
  );
  const providers = externalSonames.flatMap((soname) => {
    const aptPackage =
      WORKSPACE_HOST_NATIVE_SONAME_TO_APT_PACKAGE[
        soname as WorkspaceHostNativeSoname
      ];
    return aptPackage ? [{ soname, aptPackage }] : [];
  });
  const unknownSonames = externalSonames.filter(
    (soname) =>
      !Object.prototype.hasOwnProperty.call(
        WORKSPACE_HOST_NATIVE_SONAME_TO_APT_PACKAGE,
        soname,
      ),
  );
  const requiredAptPackages = normalizedAptPackages(
    providers.map(({ aptPackage }) => aptPackage),
  );
  const suppliedAptPackages = new Set(
    normalizedAptPackages(
      input.aptPackages ?? WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES,
    ),
  );
  const missingAptPackages = requiredAptPackages.filter(
    (aptPackage) => !suppliedAptPackages.has(aptPackage),
  );

  return {
    ok: unknownSonames.length === 0 && missingAptPackages.length === 0,
    neededSonames,
    bundleInternalSonames,
    glibcSonames,
    externalSonames,
    unknownSonames,
    requiredAptPackages,
    missingAptPackages,
    providers,
  };
}

/** Replaced by the sha256 of the rendered bootstrap; see service_restart_needed (WI-10004242). */
const WORKSPACE_HOST_BOOTSTRAP_FINGERPRINT_PLACEHOLDER = '__PAPERCUSP_BOOTSTRAP_FINGERPRINT__';

/** Ordered, observable phases of every generated install/upgrade/rollback. */
export const WORKSPACE_HOST_BOOTSTRAP_PHASES = [
  'validate-host',
  'harden-os',
  'verify-release',
  'install-runtime',
  'migrate-database',
  'configure-service',
  'attest-health',
] as const;
export type WorkspaceHostBootstrapPhase =
  (typeof WORKSPACE_HOST_BOOTSTRAP_PHASES)[number];

/**
 * Out-of-band channels through which a bootstrap reports its own lifecycle, so a controller can
 * see a terminal failure WITHOUT SSH (WI-10002837). SSH cannot carry that report: the workspace
 * key is authorized after `harden-os` installs packages, so a fresh host that dies there is
 * unreachable, and the controller used to wait out its whole readiness budget on a script that
 * had already exited.
 *
 * - `gce-guest-attributes`: PUT to the GCE metadata server's guest attributes, which the
 *   controller reads through `compute.instances.getGuestAttributes`.
 * - `ec2-console-output`: one marker line written to `/dev/console`, which EC2 captures as the
 *   instance's serial console output; the controller reads it through `ec2:GetConsoleOutput` and
 *   takes the LAST marker line ({@link parseEc2ConsoleBootstrapStatus}). EC2 has no guest-writable
 *   metadata store, and the console is the one channel already granted for host-key pinning.
 */
export const WORKSPACE_HOST_BOOTSTRAP_STATUS_CHANNELS = [
  'gce-guest-attributes',
  'ec2-console-output',
] as const;
export type WorkspaceHostBootstrapStatusChannel =
  (typeof WORKSPACE_HOST_BOOTSTRAP_STATUS_CHANNELS)[number];

/** Where the `gce-guest-attributes` report lives: `<namespace>/<key>`. */
export const WORKSPACE_HOST_BOOTSTRAP_STATUS_GUEST_ATTRIBUTE_NAMESPACE =
  'papercusp';
export const WORKSPACE_HOST_BOOTSTRAP_STATUS_GUEST_ATTRIBUTE_KEY = 'bootstrap';

/**
 * The token that opens every `ec2-console-output` report line: `<marker> <report>`. The console
 * also carries kernel, cloud-init and journal output, so the marker is what tells a report apart
 * from anything else that happens to print the word `failed`.
 */
export const WORKSPACE_HOST_BOOTSTRAP_STATUS_CONSOLE_MARKER =
  'PAPERCUSP_BOOTSTRAP_STATUS';

/** The longest die() message a report carries; the serial console has the full log. */
export const WORKSPACE_HOST_BOOTSTRAP_STATUS_ERROR_MAX_CHARS = 300;

export type WorkspaceHostBootstrapReportedStatus =
  | { state: 'running' }
  | { state: 'succeeded' }
  | {
      state: 'failed';
      exitCode: number;
      /** The phase that was running, or null if the script died before the first one. */
      phase: string | null;
      /** The die() message, or null when the script was stopped by `set -e` instead. */
      error: string | null;
    };

/**
 * Parse one bootstrap status report. Anything that is not a report this bootstrap writes parses
 * to null, so a foreign or truncated value reads as "no report" (keep waiting), never as a failure.
 */
export function parseWorkspaceHostBootstrapReportedStatus(
  value: string,
): WorkspaceHostBootstrapReportedStatus | null {
  if (value === 'running' || value === 'succeeded') return { state: value };
  const match = /^failed exit=(\d{1,3}) phase=(\S*) error=(.*)$/s.exec(value);
  if (!match) return null;
  return {
    state: 'failed',
    exitCode: Number(match[1]),
    phase: match[2] || null,
    error: match[3] || null,
  };
}

/**
 * Read the bootstrap's status from an EC2 instance's console output (the `ec2-console-output`
 * channel). The LAST marker line wins, because every run opens with `running` and a later run's
 * report supersedes an earlier one's. Serial consoles end lines with `\r\n` and may interleave
 * kernel output before the marker, so the marker is found anywhere in the line and carriage
 * returns are dropped. A last marker whose report does not parse yields null (keep waiting) —
 * never an older report, which would resurrect a superseded outcome.
 */
export function parseEc2ConsoleBootstrapStatus(
  consoleText: string,
): WorkspaceHostBootstrapReportedStatus | null {
  const token = `${WORKSPACE_HOST_BOOTSTRAP_STATUS_CONSOLE_MARKER} `;
  const lines = consoleText.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].replace(/\r/g, '');
    const at = line.lastIndexOf(token);
    if (at < 0) continue;
    return parseWorkspaceHostBootstrapReportedStatus(line.slice(at + token.length));
  }
  return null;
}

/**
 * Checks EVERY host model must attest, whatever delivered the bits.
 *
 * Membership here is a claim that the property is model-invariant, not that the observation is:
 * `node-runtime` is established by execing the bundled Node on an Ubuntu host and the image's
 * Node on a bootc host, but the attested property — "the Node that will run the operator meets
 * the floor" — is the same property, and a host that fails it is broken under either model.
 */
export const WORKSPACE_HOST_BOOTSTRAP_SHARED_CHECKS = [
  "node-runtime",
  "embedded-postgres-migration",
  "agent-cli-prerequisites",
  "pui-generation",
  "pui-operator-freshness",
  "loopback-service",
  "service-identity",
  "runtime-permissions",
  "workspace-identity",
  "workspace-acl",
  "privileged-conduits",
  "ssh-forwarding-policy",
  // D-238's property, finally NAMED. `harden-os` already refuses to render a brick, but that
  // guard fires five phases before `healthy` is claimed and appeared NOWHERE in the attestation —
  // so the single property whose absence made the original host unrecoverable was invisible in
  // the document that asserts the host is fine (EI-22185970114422986).
  "workspace-ssh-authorized-keys",
  // The agent account can create the user/pid/net namespaces Codex's sandbox needs. Shared, not
  // Ubuntu-only: the bootc base needs no AppArmor grant, but it still has to ship bubblewrap and
  // allow unprivileged user namespaces, and a host that cannot is just as broken (WI-10004636).
  "agent-sandbox-userns",
] as const;

/**
 * The checks that exist ONLY on one host model, because only that model performs the
 * observation. This is the split D-262 condition 2 could not be written without.
 *
 * The Ubuntu three are the release-tarball trust chain: an OS-release assertion, a sha256 over a
 * downloaded file, and a minisign verification of a detached signature. NONE of the three has a
 * bootc analogue that this script performs — the release IS the booted image, and its signature
 * was checked by the containers policy during the pull, by skopeo, before any code of ours ran
 * (D-279 proved that policy is enforced and fails closed).
 *
 * So a bootc host that attested `bundle-signature: true` would be asserting a minisign check no
 * line of its bootstrap executes. It gets `image-signature` instead — a DIFFERENT name for a
 * different observation — precisely so the two can never be confused for one another.
 */
export const WORKSPACE_HOST_BOOTSTRAP_MODEL_CHECKS = {
  'ubuntu-release-bundle': [
    "ubuntu-24.04",
    "bundle-digest",
    "bundle-signature",
  ],
  'bootc-image': [
    "bootc-base-image",
    "image-digest",
    "image-signature",
    // D-283's open risk, made observable. Whether `/opt` is image content on a BOOTED host could
    // not be settled inside a container, so `papercusp-host-prepare.service` asserts it at boot
    // and fails closed. That unit is also what re-applies the `/opt/papercusp` ACLs on EVERY
    // boot — they live in the deployment root, which `bootc upgrade` REPLACES, while `/var`
    // persists. An upgraded host whose unit did not run has the right files and the wrong
    // access, and reports healthy throughout unless this check names it.
    "host-prepare-unit",
  ],
} as const satisfies Record<WorkspaceHostModel, readonly string[]>;

/**
 * Every check name in the contract — the NAME SPACE, deliberately not "the checks to attest".
 *
 * It is spelled `_CHECK_NAMES` because its predecessor was called `WORKSPACE_HOST_BOOTSTRAP_CHECKS`
 * and two call sites mapped it wholesale to `{ name, ok: true }`. Under one host model that was
 * merely optimistic; under two it is a correctness bug, because the union of both models' names
 * is a set no single host can establish. Anything that needs the list a HOST must attest calls
 * `workspaceHostBootstrapChecks(model)` — which is the only function that returns one.
 */
export const WORKSPACE_HOST_BOOTSTRAP_CHECK_NAMES = [
  ...WORKSPACE_HOST_BOOTSTRAP_SHARED_CHECKS,
  ...WORKSPACE_HOST_BOOTSTRAP_MODEL_CHECKS['ubuntu-release-bundle'],
  ...WORKSPACE_HOST_BOOTSTRAP_MODEL_CHECKS['bootc-image'],
] as const;
export type WorkspaceHostBootstrapCheckName =
  (typeof WORKSPACE_HOST_BOOTSTRAP_CHECK_NAMES)[number];

/**
 * The EXACT set of checks a host of this model must attest — no more, no less.
 *
 * "No more" is not pedantry. The validator's old check loop required each expected name to be
 * present and `ok`, and separately rejected duplicates and malformed entries — but it never
 * rejected an EXTRA well-formed name. With one model that was harmless; with two it is the hole
 * a bootc host walks through carrying `bundle-signature: true`. `validateWorkspaceHost-
 * BootstrapAttestation` therefore asserts set EQUALITY against this function's result.
 */
export function workspaceHostBootstrapChecks(
  hostModel: WorkspaceHostModel,
): readonly WorkspaceHostBootstrapCheckName[] {
  return [
    ...WORKSPACE_HOST_BOOTSTRAP_SHARED_CHECKS,
    ...WORKSPACE_HOST_BOOTSTRAP_MODEL_CHECKS[hostModel],
  ];
}

/**
 * The host-side observation that ESTABLISHES each attested check (EI-22185970114422986).
 *
 * `checks` is serialized into the attestation by the RENDERER — `{ name, ok: true }` for every
 * name above — before the host has executed a single line, and
 * `validateWorkspaceHostBootstrapAttestation` then requires each one to be `ok: true`, which the
 * renderer guaranteed. Read literally, that array can never report a failure of any named
 * property. Apply the diagnostic this item was filed for — *if the check half silently did
 * nothing, would this run still report success?* — and the answer was yes, for every name.
 *
 * The design INTENT is sound and is kept: each check corresponds to a `die` guard earlier in the
 * script, so reaching `attest-health` at all is the proof. What was missing is anything BINDING a
 * name to its guard. A name added with no guard is attested `ok: true` for a property nobody
 * measured; a guard deleted from the render leaves its name attesting on nothing. Both are
 * silent, and both are the same shape as the lockout this item was filed for.
 *
 * This map is that binding, and `workspace-host-bootstrap.test.ts` fails the build when any
 * fragment is absent from the rendered script. It is a PIN, not a derivation (derived-truth
 * ladder rung 2): the fragment proves the observation is still EMITTED, not that it observes the
 * right thing. So bind the narrowest fragment that would disappear if the guard were removed.
 */
export const WORKSPACE_HOST_BOOTSTRAP_CHECK_EVIDENCE: Readonly<
  Record<WorkspaceHostBootstrapCheckName, string>
> = {
  "ubuntu-24.04": `|| die "Ubuntu ${WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION} is required"`,
  "bundle-digest": '"$BUNDLE_SHA256" "$BUNDLE_PATH" | sha256sum --check --strict -',
  "bundle-signature": 'minisign -Vm "$BUNDLE_PATH" -x "$SIGNATURE_PATH"',
  // The bootc four. Each fragment is the narrowest line that would DISAPPEAR if its guard were
  // removed — same rule as the Ubuntu three above, applied to a render whose observations are
  // reads of the booted deployment rather than checks over a downloaded file.
  "bootc-base-image": '"$BOOTC_BASE_IMAGE" != "$BOOTED_BASE_IMAGE"',
  "image-digest": '"$BOOTED_IMAGE_DIGEST" != "$EXPECTED_IMAGE_DIGEST"',
  "image-signature": 'containers-policy does not require a signature for',
  "host-prepare-unit":
    'systemctl is-active --quiet papercusp-host-prepare.service',
  "node-runtime": "bundled Node runtime is below the required floor",
  "embedded-postgres-migration": '"$RELEASE_DIR/$MIGRATE_ENTRYPOINT" --database-root',
  "agent-cli-prerequisites": '"$CLAUDE_ENTRYPOINT" "$CODEX_ENTRYPOINT" "$OMP_ENTRYPOINT"',
  "pui-generation": "missing or empty PUI install manifest",
  "pui-operator-freshness": '"$RUNTIME_ROOT/current/$PUI_ENTRYPOINT" doctor',
  "loopback-service": 'systemctl is-active --quiet "$SERVICE_NAME.service"',
  "service-identity": "--property User --value",
  "runtime-permissions": "runtime release tree must not be world-readable",
  "workspace-identity": "workspace SSH user belongs to sudo",
  "workspace-acl": "workspace SSH user cannot write the scoped workspace root",
  "privileged-conduits": "conduit interpreter is missing or not executable",
  "ssh-forwarding-policy": 'grep -Fx "allowtcpforwarding local"',
  "workspace-ssh-authorized-keys":
    "workspace authorized_keys is unreadable or empty at attest time",
  "agent-sandbox-userns": "agent sandbox cannot create a user namespace",
};

export interface WorkspaceHostBootstrapRelease {
  /** Stable, shell-safe release identifier (for example `2026.8.22-1`). */
  version: string;
  /** Public HTTPS Server-bundle tarball. Query credentials are forbidden. */
  bundleUrl: string;
  /** SHA-256 of the compressed bundle. */
  bundleSha256: string;
  /** Public HTTPS detached minisign signature. */
  signatureUrl: string;
  /** Public minisign verification key; never a private signing key. */
  signingPublicKey: string;
  /** SHA-256 of `signingPublicKey`, pinning the exact public trust root. */
  signingKeySha256: string;
}

/** Paths are relative to the immutable extracted Server release directory. */
export interface WorkspaceHostBootstrapEntrypoints {
  install: string;
  rollback: string;
  node: string;
  migrate: string;
  operator: string;
  health: string;
  psu: string;
  /** Native PUI executable installed with its companion + generation manifest. */
  pui: string;
  claude: string;
  codex: string;
  omp: string;
  /**
   * The remote initializer the controller spawns per initialization step. A bundle without it
   * installs and reports healthy, then fails every initialization at the far end — which is
   * exactly the silent failure the `remote-initializer` check exists to convert into a loud one.
   */
  remoteInitializer: string;
  /**
   * The credential-delivery program the controller spawns to place material on the host. Required
   * for the same reason `remoteInitializer` is: a bundle without it installs, reports healthy, and
   * then fails every `git` and `agent` bind at the far end with a message that cannot distinguish
   * "this host cannot receive material" from "delivery was attempted and lost" (D-215).
   */
  credentialDelivery: string;
}

export const DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS: Readonly<WorkspaceHostBootstrapEntrypoints> =
  {
    install: 'bin/papercusp-install',
    rollback: 'bin/papercusp-rollback',
    node: 'bin/node',
    migrate: 'bin/papercusp-migrate',
    operator: 'bin/papercusp-server',
    health: 'bin/papercusp-health',
    psu: 'bin/psu',
    pui: WORKSPACE_HOST_PUI_ENTRYPOINT,
    claude: 'bin/claude',
    codex: 'bin/codex',
    omp: 'bin/omp',
    remoteInitializer: 'bin/papercusp-remote-initializer',
    credentialDelivery: WORKSPACE_HOST_CREDENTIAL_DELIVERY_ENTRYPOINT,
  };

export interface WorkspaceHostBootstrapService {
  /** systemd unit basename, without `.service`. */
  name: string;
  /** Operator HTTP port. The generated service always binds it to 127.0.0.1. */
  port: number;
  user?: string;
  group?: string;
}

/**
 * Three identities, each with exactly one job, none of them sharing another's group.
 *
 * - `service`  — runs the operator; owns `$STATE_ROOT` (embedded PG, delivered material).
 * - `workspace` — the SSH login account; workspace/data ONLY, zero runtime read (D-043).
 * - `agent`    — runs the bundled agent CLIs; reads the signed runtime, owns the agent
 *   credential homes, writes the scoped workspace root. Non-login (D-248).
 */
export interface WorkspaceHostBootstrapIsolation {
  /** SSH login account that can access customer workspace/data only. */
  workspaceUser?: string;
  /** Primary group for the SSH account; must differ from the service group. */
  workspaceGroup?: string;
  /**
   * Non-login account the bundled agent CLIs execute as. Must differ from BOTH other
   * identities: sharing the service identity would hand it the credential/state root, and
   * sharing the SSH identity is the exact contradiction D-248 exists to remove.
   */
  agentUser?: string;
  /** Primary group for the agent account; must differ from the service and SSH groups. */
  agentGroup?: string;
}

/**
 * One vendor agent runtime to install on the host, as an already-resolved argv.
 *
 * WHY THIS EXISTS (D-259). The release bundle ships psu WRAPPERS named `claude`, `codex` and
 * `omp` — 539 bytes each, re-execing `scripts/psu.mjs --agent=<basename>` — NOT the vendor CLIs.
 * psu does not bundle a backend either: it RESOLVES one from well-known dirs and aborts the
 * launch when it finds none. So a host with no vendor runtime cannot start ANY agent, and
 * P-046's all-three-agent canary is unmeetable. This closes that gap.
 *
 * THE SPECS ARE NOT REBUILT HERE. The caller evaluates the ONE existing spec table
 * (`buildFrameworkInstallSpec`, which is pure) at render time and passes the concrete result, so
 * this generic lib stays domain-free and the install commands can never drift from the ones the
 * desktop onboarding uses.
 *
 * A NEW BUNDLED ENTRYPOINT WAS REJECTED DELIBERATELY: it would require a fresh bundle and image,
 * which D-237 forbids. The bootstrap is rendered per-provision, so an inlined argv reaches a
 * fresh host with no rebake — the same property that carried the D-246 ACL fix to canary-06.
 */
export interface WorkspaceHostAgentRuntimeInstall {
  /** Which backend this installs; also the bare name the post-install resolve probes for. */
  agent: 'claude' | 'codex' | 'omp';
  /** Executable to run. Never a shell string — argv is passed through without re-splitting. */
  command: string;
  args: readonly string[];
}

/**
 * What the bootc model needs that the tarball model does not (P-306 half B).
 *
 * REQUIRED whenever `hostModel: 'bootc-image'`, enforced in `validateInput`. The typed
 * discriminated union lives on the ATTESTATION, which is the trust boundary D-262 condition 2 is
 * about; the input keeps one shape with a runtime requirement, so the ~40 existing call sites
 * and fixtures that construct an Ubuntu input keep compiling untouched.
 */
export interface WorkspaceHostBootcRelease {
  /** Registry-qualified product image ref, e.g. `registry/papercusp/workspace-host:2026.9.4-1`. */
  image: string;
  /** Manifest digest to pin (`sha256:…`). The pull is by digest; the tag is provenance only. */
  imageDigest: string;
  /** Base the product image was built FROM. Defaults to `WORKSPACE_HOST_BOOTC_BASE_IMAGE`. */
  baseImage?: string;
  /**
   * Path of the containers signature policy the host must be running under. MUST equal
   * {@link WORKSPACE_HOST_CONTAINERS_POLICY_PATH} — it is a field rather than a constant only so
   * that the attestation carries the path it actually asserted, rather than a reader having to
   * assume it.
   *
   * NOT a policy this script writes: an image whose signature is only checked by a policy the
   * same run installed has a window in which it was checked by nothing. The policy belongs to
   * the image (P-308), and this render ASSERTS it is present and requires a signature for the
   * release repository — a read, which is the strongest honest claim from inside the host.
   *
   * The equality check is D-286: any other path is a file the pull never consults, so asserting
   * it would be green over nothing. See the constant for the measurement.
   */
  signaturePolicyPath: string;
}

export interface WorkspaceHostBootstrapInput {
  contractVersion: typeof WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION;
  action: 'install' | 'upgrade' | 'rollback';
  hostId: string;
  /**
   * Which host model this render targets. Omitted means `ubuntu-release-bundle` — the shipped
   * model — so every existing caller keeps its current behaviour verbatim (P-306).
   */
  hostModel?: WorkspaceHostModel;
  /** Required when `hostModel` is `'bootc-image'`; rejected otherwise. */
  bootc?: WorkspaceHostBootcRelease;
  release: WorkspaceHostBootstrapRelease;
  /** Durable migration identity expected after the bundled migration command succeeds. */
  migrationId: string;
  minimumNodeMajor: number;
  service: WorkspaceHostBootstrapService;
  isolation?: WorkspaceHostBootstrapIsolation;
  /**
   * OpenSSH public keys authorized for the workspace SSH account. REQUIRED and non-empty.
   *
   * `harden-os` locks this host down to `AuthenticationMethods publickey` +
   * `AllowUsers $WORKSPACE_USER`, and the workspace account is created with `usermod --lock`.
   * A render with no key therefore produces a host that is unreachable by construction — sshd
   * accepts public keys only, for exactly one account, and that account has none. Provider
   * metadata cannot rescue it either: the GCP provider sets `block-project-ssh-keys=TRUE` and
   * `enable-oslogin=TRUE` unconditionally, so `ssh-keys` metadata is ignored, and the workspace
   * account is a plain local user that OS Login's `google_authorized_keys` never answers for.
   *
   * This field is required rather than optional precisely because the failure is silent: the
   * bootstrap succeeds, attests `status:"healthy"`, and only the NEXT connection discovers the
   * host was bricked. Measured on p046-canary-04, 2026-09-02 (D-238).
   */
  workspaceAuthorizedKeys: readonly string[];
  entrypoints?: Partial<WorkspaceHostBootstrapEntrypoints>;
  /**
   * Vendor agent runtimes to install as the AGENT identity during `install-runtime` (D-259).
   *
   * Omitted or empty means no install is attempted, and the attestation then continues to declare
   * `agentRuntimesVerifiedByBootstrap: false` — which is the HONEST reading for such a host, and
   * exactly what every host built before this field reported. Supplying installs is what lets the
   * bootstrap make that claim true, because each one is followed by a resolve that must succeed.
   *
   * ⚠ SUPPLY-CHAIN NOTE, deliberately surfaced rather than buried: the vendor install scripts
   * these argvs run fetch code over the network (the Claude installer is a `curl … | bash`), which
   * is a weaker trust posture than the digest+minisign verification this bootstrap applies to its
   * OWN bundle. It is not a NEW trust relationship — it is the same vendor and the same script the
   * desktop onboarding already runs — but it is a real asymmetry, and vendoring the runtimes into
   * the signed bundle is the stronger long-term answer once an image rebake is permitted again.
   */
  agentRuntimeInstalls?: readonly WorkspaceHostAgentRuntimeInstall[];
  /**
   * D-403: install the desktop connector's enrollment conduit, bound to this control plane.
   * The origin is baked into the root program here, never read from its stdin, so an enrollment
   * request cannot redirect where the host sends its ticket. Omitted means no conduit.
   */
  hostedConnector?: WorkspaceHostBootstrapHostedConnector;
  /**
   * Report `running` / `succeeded` / `failed` out of band (WI-10002837). Omitted means the host
   * reports nothing and a controller can only learn of a failure by timing out.
   */
  statusChannel?: WorkspaceHostBootstrapStatusChannel;
  /** Persistable labels only. Secret-shaped keys and private-key values are rejected. */
  publicMetadata?: Readonly<Record<string, unknown>>;
}

export interface WorkspaceHostBootstrapHostedConnector {
  /** Bare HTTPS origin of the hosted control plane, e.g. `https://app.papercusp.com`. */
  controlPlaneOrigin: string;
}

export interface WorkspaceHostBootstrapAttestationCheck {
  name: WorkspaceHostBootstrapCheckName;
  ok: true;
}

/**
 * The attested document, parameterised by host model (P-306).
 *
 * Generic rather than two hand-written interfaces so the ~30 model-invariant properties are
 * declared ONCE — the point of the port is that a bootc host proves the same isolation
 * properties, not fewer. What varies is threaded through `M`: the update mode is resolved from
 * the pairing map, and the model-specific provenance field is attached by the union below.
 */
export interface WorkspaceHostBootstrapAttestationShape<
  M extends WorkspaceHostModel,
> {
  contractVersion: typeof WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION;
  hostId: string;
  action: WorkspaceHostBootstrapInput['action'];
  /** The discriminant. Which host model produced this document (P-306). */
  hostModel: M;
  observedAt: string;
  status: 'healthy';
  migration: {
    id: string;
    applied: true;
  };
  runtime: {
    nodeMajor: number;
    minimumNodeMajor: number;
    psu: true;
    pui: true;
    /**
     * PRESENT AND EXECUTABLE — which is the entire claim bootstrap is entitled to make.
     *
     * These were `claude: true, codex: true, omp: true` directly under `runtime`, read by every
     * caller as "this host can run Claude/Codex/OMP". They never meant that. The only thing
     * behind them is `test -x` on `bin/{claude,codex,omp}`, and those three files are 539-byte
     * psu LAUNCHER wrappers — the host ships no vendor CLI at all and nothing installs one
     * (D-252, measured on the r19 bundle). A field whose NAME claims a product property and
     * whose VALUE measures a file permission is the unbacked-boolean class P-046 exists to
     * remove; it is the same defect as the old `runtimeReadableByWorkspaceUser` (D-251).
     */
    agentLaunchers: {
      claude: true;
      codex: true;
      omp: true;
    };
    /**
     * Bootstrap NEVER establishes that an agent runtime is installed and authenticated, so it
     * attests the negative rather than staying silent — silence reads as "not checked", and a
     * reader then supplies the optimistic default this constant exists to deny.
     *
     * The authority for the positive is the readiness probe in
     * `workspace-host-agent-authentication.ts`, run later by the initializer, which reaches a
     * real authenticated surface and scores "exit 0 but unparseable" as a FAILURE.
     */
    agentRuntimesVerifiedByBootstrap: false;
    /**
     * Whether this bootstrap INSTALLED the vendor agent runtimes and resolved each one (D-259).
     *
     * Strictly narrower than the field above, and deliberately a separate one. `install-runtime`
     * runs each configured install as the agent identity and then RESOLVES the binary, dying if it
     * is absent — so a true here is backed by a resolve that passed. It still says nothing about
     * authentication, which is why the `Verified` field remains a hardcoded false: conflating the
     * two is how the launcher wrappers came to be mistaken for working agent CLIs in the first
     * place (D-247).
     *
     * False on any host provisioned without `agentRuntimeInstalls` — including every host built
     * before D-259, which genuinely had no vendor runtime at all.
     */
    agentRuntimesInstalledByBootstrap: boolean;
    /**
     * Absolute path of each installed vendor runtime, as resolved ON the host after install.
     *
     * Present only alongside `agentRuntimesInstalledByBootstrap: true`. This is what lets the
     * readiness probe exec the VENDOR binary directly instead of shelling `bin/<agent>`, which is
     * the psu wrapper and swallows the probe's arguments (D-259 Defect 2).
     */
    agentRuntimes?: Partial<Record<'claude' | 'codex' | 'omp', string>>;
  };
  service: {
    name: string;
    user: string;
    group: string;
    bindHost: '127.0.0.1';
    port: number;
    active: true;
  };
  isolation: {
    workspaceUser: string;
    workspaceGroup: string;
    /** The third identity (D-248): non-login, runs the bundled agent CLIs. */
    agentUser: string;
    agentGroup: string;
    runtimeRoot: typeof WORKSPACE_HOST_RUNTIME_ROOT;
    stateRoot: typeof WORKSPACE_HOST_STATE_ROOT;
    workspaceRoot: typeof WORKSPACE_HOST_DATA_ROOT;
    // FALSE, and back to false deliberately. D-246 flipped this to `true` because the SSH account
    // was then the agent-running identity, which made the runtime read unavoidable — and that
    // violated the D-043 owner ruling. D-248 splits the identity instead, so the property D-043
    // names holds as written AND the agents run. Read the pair below together: the read moved to
    // the agent identity, it did not disappear.
    runtimeReadableByWorkspaceUser: false;
    runtimeWritableByWorkspaceUser: false;
    runtimeReadableByAgentUser: true;
    runtimeWritableByAgentUser: false;
    /**
     * The customer's SSH login cannot read the delivered agent credential home. On a BYOC host
     * that account is the customer's access path, so this is the property that decides whether
     * platform agent credentials are exposed to them — not a mode bit, an asserted negative.
     */
    agentHomeReadableBySshUser: false;
    workspaceWritableByService: true;
    workspaceWritableBySshUser: true;
    workspaceWritableByAgentUser: true;
    sudo: false;
    serviceGroupMember: false;
    operatorIngress: 'ssh-local-forward';
    /** Resolved from the PAIRING map, so a model can only ever claim its own update path. */
    updateMode: (typeof WORKSPACE_HOST_UPDATE_MODE_BY_MODEL)[M];
  };
  checks: readonly WorkspaceHostBootstrapAttestationCheck[];
}

/**
 * ⛔ Do NOT flatten these back into one interface with two optional fields. The whole reason
 * `ubuntuVersion` and `bootcImage` are attached per-member is that each is REQUIRED on its own
 * model and MEANINGLESS on the other: an Ubuntu host has no image digest to report, and
 * "24.04" is not a fact about a CentOS-Stream-9 bootc deployment. Two optionals would make both
 * absences legal and hand every reader an `undefined` to guess at.
 */
export type WorkspaceHostBootstrapAttestation =
  | (WorkspaceHostBootstrapAttestationShape<'ubuntu-release-bundle'> & {
      ubuntuVersion: typeof WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION;
      /**
       * The signed-tarball trust chain. `signatureVerified` here means MINISIGN verified a
       * detached signature over the downloaded bundle, using a public key pinned by digest.
       */
      release: {
        version: string;
        source: string;
        bundleSha256: string;
        signingKeySha256: string;
        signatureVerified: true;
      };
    })
  | (WorkspaceHostBootstrapAttestationShape<'bootc-image'> & {
      /** The base the product image was built FROM, as the booted deployment reports it. */
      bootcBaseImage: string;
      /**
       * The image trust chain — a DIFFERENT chain, named differently on purpose.
       *
       * `signatureVerified` here means the pull went through a containers `sigstoreSigned`
       * policy that D-279 proved is enforced and fails closed. There is no bundle digest and no
       * minisign key: the transport verified the image before bootc ever staged it, and there is
       * no later moment at which this host could re-check that signature itself. Reporting the
       * policy PATH is what makes the claim auditable rather than merely asserted.
       */
      release: {
        version: string;
        /** Registry-qualified image ref this deployment booted. */
        source: string;
        /** Manifest digest the booted deployment is pinned to (`sha256:…`). */
        imageDigest: string;
        /** The containers policy file that gated the pull (D-279). */
        signaturePolicyPath: string;
        signatureVerified: true;
      };
    });

export interface WorkspaceHostBootstrapAttestationValidation {
  ok: boolean;
  errors: readonly string[];
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_RELEASE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SAFE_LINUX_NAME = /^[a-z_][a-z0-9_-]{0,30}$/;
const SAFE_SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;
const SAFE_ENTRYPOINT = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const SHA256 = /^[a-fA-F0-9]{64}$/;
/**
 * A REGISTRY-QUALIFIED image reference — the leading `(?:\/…)+` makes at least one slash
 * mandatory, which is the point rather than a side effect. A bare `centos-bootc:stream9`
 * resolves against whatever unqualified-search registries the host happens to have configured,
 * so the ref that gets pulled is decided by host config rather than by us; on a machine whose
 * search list leads somewhere else that is a silent substitution of the entire OS.
 */
const SAFE_IMAGE_REF =
  /^[a-z0-9][a-z0-9._-]*(?::\d{1,5})?(?:\/[a-z0-9][a-z0-9._-]*)+(?::[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/;
/** A pinned manifest digest. Tags move; this does not. */
const SAFE_IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
/** Absolute, traversal-free, shell-safe: every segment must OPEN with an alphanumeric, so
 * neither `..` nor an empty segment can appear anywhere in the path. */
const SAFE_ABSOLUTE_PATH = /^(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){1,16}$/;

function requireCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

function requireSafeId(value: string, label: string): void {
  requireCondition(
    SAFE_ID.test(value),
    `${label} must be a non-empty stable identifier`,
  );
}

function requireSha256(value: string, label: string): void {
  requireCondition(
    SHA256.test(value),
    `${label} must be a 64-character SHA-256 digest`,
  );
}

function requirePublicHttpsUrl(value: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid public HTTPS URL`);
  }
  requireCondition(parsed.protocol === 'https:', `${label} must use HTTPS`);
  requireCondition(
    !parsed.username && !parsed.password,
    `${label} must not contain credentials`,
  );
  requireCondition(
    !parsed.search && !parsed.hash,
    `${label} must not contain query credentials or fragments`,
  );
}

function requireEntrypoint(value: string, label: string): void {
  requireCondition(
    SAFE_ENTRYPOINT.test(value) &&
      !value.startsWith('/') &&
      !value.split('/').some((part) => part === '.' || part === '..'),
    `${label} must be a safe relative release path`,
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function assertNoSecretShapedMetadata(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoSecretShapedMetadata(entry, `${path}[${index}]`),
    );
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const tokens = key
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    const tokenSet = new Set(tokens);
    const secretShaped =
      ['secret', 'token', 'password', 'passphrase'].some((token) =>
        tokenSet.has(token),
      ) ||
      ((tokenSet.has('api') ||
        tokenSet.has('access') ||
        tokenSet.has('private')) &&
        tokenSet.has('key'));
    requireCondition(
      !secretShaped,
      `Secret-shaped field '${path}.${key}' is forbidden in bootstrap metadata`,
    );
    assertNoSecretShapedMetadata(entry, `${path}.${key}`);
  }
}

function normalizedEntrypoints(
  overrides: Partial<WorkspaceHostBootstrapEntrypoints> | undefined,
): WorkspaceHostBootstrapEntrypoints {
  const entrypoints = {
    ...DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS,
    ...overrides,
  };
  for (const [name, value] of Object.entries(entrypoints))
    requireEntrypoint(value, `entrypoints.${name}`);
  return entrypoints;
}

interface ValidatedBootstrapInput {
  hostModel: WorkspaceHostModel;
  /** Present exactly when `hostModel === 'bootc-image'`, with `baseImage` defaulted. */
  bootc?: Required<Pick<WorkspaceHostBootcRelease, 'baseImage'>> &
    WorkspaceHostBootcRelease;
  entrypoints: WorkspaceHostBootstrapEntrypoints;
  serviceUser: string;
  serviceGroup: string;
  workspaceUser: string;
  workspaceGroup: string;
  agentUser: string;
  agentGroup: string;
  workspaceAuthorizedKeys: readonly string[];
  agentRuntimeInstalls: readonly WorkspaceHostAgentRuntimeInstall[];
  /** The normalized origin (`URL.origin`), or null when no conduit is rendered. */
  connectorOrigin: string | null;
  statusChannel: WorkspaceHostBootstrapStatusChannel | null;
}

function normalizedStatusChannel(
  value: unknown,
): WorkspaceHostBootstrapStatusChannel | null {
  if (value === undefined) return null;
  requireCondition(
    (WORKSPACE_HOST_BOOTSTRAP_STATUS_CHANNELS as readonly unknown[]).includes(value),
    `statusChannel must be one of: ${WORKSPACE_HOST_BOOTSTRAP_STATUS_CHANNELS.join(', ')}`,
  );
  return value as WorkspaceHostBootstrapStatusChannel;
}

/** A bare HTTPS origin: no path, query, fragment or credentials. Returns `URL.origin`. */
function requireHttpsOrigin(value: string, label: string): string {
  requirePublicHttpsUrl(value, label);
  const parsed = new URL(value);
  requireCondition(parsed.pathname === '/', `${label} must be a bare origin with no path`);
  return parsed.origin;
}

function validateInput(
  input: WorkspaceHostBootstrapInput,
): ValidatedBootstrapInput {
  requireCondition(
    input.contractVersion === WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
    `Unsupported workspace-host bootstrap contract '${input.contractVersion}'`,
  );
  requireCondition(
    ['install', 'upgrade', 'rollback'].includes(input.action),
    `Unsupported bootstrap action '${input.action}'`,
  );
  requireSafeId(input.hostId, 'hostId');
  const hostModel = input.hostModel ?? DEFAULT_WORKSPACE_HOST_MODEL;
  requireCondition(
    (WORKSPACE_HOST_MODELS as readonly string[]).includes(hostModel),
    `Unsupported workspace-host model '${hostModel}'`,
  );
  // Both directions are refused, and the second one matters as much as the first. A `bootc`
  // block on an Ubuntu render is an image ref and digest that NOTHING in that script reads — the
  // caller believes it pinned an image and pinned nothing, which is the quiet half of this
  // failure and the one no error message would otherwise ever mention.
  requireCondition(
    hostModel === 'bootc-image' ? input.bootc !== undefined : true,
    "hostModel 'bootc-image' requires a bootc release descriptor",
  );
  requireCondition(
    hostModel === 'bootc-image' || input.bootc === undefined,
    `bootc release descriptor is only valid with hostModel 'bootc-image', not '${hostModel}'`,
  );
  const bootc = input.bootc
    ? {
        ...input.bootc,
        baseImage: input.bootc.baseImage ?? WORKSPACE_HOST_BOOTC_BASE_IMAGE,
      }
    : undefined;
  if (bootc) {
    requireCondition(
      SAFE_IMAGE_REF.test(bootc.image),
      'bootc.image must be a registry-qualified image reference',
    );
    requireCondition(
      SAFE_IMAGE_REF.test(bootc.baseImage),
      'bootc.baseImage must be a registry-qualified image reference',
    );
    requireCondition(
      SAFE_IMAGE_DIGEST.test(bootc.imageDigest),
      "bootc.imageDigest must be a 'sha256:<64 hex>' manifest digest",
    );
    requireCondition(
      SAFE_ABSOLUTE_PATH.test(bootc.signaturePolicyPath),
      'bootc.signaturePolicyPath must be an absolute path',
    );
    // EQUALITY, not merely absoluteness — D-286. Asserting a policy at any other path is a check
    // over a file the pull never reads: it would pass, and attest `signatureVerified: true`,
    // while the image was admitted by the base's permissive default. Refusing here is the only
    // place the render can tell the two apart, because from inside the host a correct-looking
    // policy at the wrong path is indistinguishable from a correct one.
    requireCondition(
      bootc.signaturePolicyPath === WORKSPACE_HOST_CONTAINERS_POLICY_PATH,
      `bootc.signaturePolicyPath must be ${WORKSPACE_HOST_CONTAINERS_POLICY_PATH} — the only policy a bootc pull consults; a policy anywhere else gates nothing`,
    );
  }
  requireCondition(
    SAFE_RELEASE.test(input.release.version),
    'release.version must be shell-safe',
  );
  requirePublicHttpsUrl(input.release.bundleUrl, 'release.bundleUrl');
  requirePublicHttpsUrl(input.release.signatureUrl, 'release.signatureUrl');
  requireSha256(input.release.bundleSha256, 'release.bundleSha256');
  // requirePublicHttpsUrl only proves the URL is well-formed, credential-free HTTPS. It does NOT
  // tie the URL to the digest this release pins, so on its own it accepts a mutable
  // `.../latest.tgz` next to a perfectly valid bundleSha256 — and that URL is interpolated into
  // an install script that runs as root. D-106 puts the addressing rule in one shared place;
  // bootstrap adjudicates it against the release's OWN pins, which is the strongest claim it can
  // make without the build manifest. Run it after requireSha256 so the digest is known well-formed.
  const releaseAddressingErrors = workspaceHostReleaseAddressingErrors(
    input.release,
    {
      sha256: input.release.bundleSha256,
      version: input.release.version,
      subject: 'the digest this release pins',
    },
  );
  requireCondition(
    releaseAddressingErrors.length === 0,
    `release provenance: ${releaseAddressingErrors.join('; ')}`,
  );
  requireSha256(input.release.signingKeySha256, 'release.signingKeySha256');
  requireCondition(
    input.release.signingPublicKey.trim().length > 0,
    'release.signingPublicKey must not be empty',
  );
  requireSafeId(input.migrationId, 'migrationId');
  requireCondition(
    Number.isSafeInteger(input.minimumNodeMajor) &&
      input.minimumNodeMajor >= 20 &&
      input.minimumNodeMajor <= 99,
    'minimumNodeMajor must be a supported integer between 20 and 99',
  );
  requireCondition(
    SAFE_SERVICE.test(input.service.name),
    'service.name must be a safe systemd unit basename',
  );
  requireCondition(
    Number.isSafeInteger(input.service.port) &&
      input.service.port >= 1024 &&
      input.service.port <= 65_535,
    'service.port must be an unprivileged TCP port',
  );
  const serviceUser = input.service.user ?? DEFAULT_WORKSPACE_HOST_SERVICE_USER;
  const serviceGroup = input.service.group ?? serviceUser;
  const workspaceUser =
    input.isolation?.workspaceUser ?? DEFAULT_WORKSPACE_HOST_WORKSPACE_USER;
  const workspaceGroup = input.isolation?.workspaceGroup ?? workspaceUser;
  const agentUser =
    input.isolation?.agentUser ?? DEFAULT_WORKSPACE_HOST_AGENT_USER;
  const agentGroup = input.isolation?.agentGroup ?? agentUser;
  requireCondition(
    SAFE_LINUX_NAME.test(serviceUser) && serviceUser !== 'root',
    'service.user must be a safe Linux name',
  );
  requireCondition(
    SAFE_LINUX_NAME.test(serviceGroup) && serviceGroup !== 'root',
    'service.group must be a safe Linux name',
  );
  requireCondition(
    SAFE_LINUX_NAME.test(workspaceUser) && workspaceUser !== 'root',
    'isolation.workspaceUser must be a safe non-root Linux name',
  );
  requireCondition(
    SAFE_LINUX_NAME.test(workspaceGroup) && workspaceGroup !== 'root',
    'isolation.workspaceGroup must be a safe non-root Linux name',
  );
  requireCondition(
    SAFE_LINUX_NAME.test(agentUser) && agentUser !== 'root',
    'isolation.agentUser must be a safe non-root Linux name',
  );
  requireCondition(
    SAFE_LINUX_NAME.test(agentGroup) && agentGroup !== 'root',
    'isolation.agentGroup must be a safe non-root Linux name',
  );
  requireCondition(
    workspaceUser !== serviceUser,
    'workspace SSH user must differ from the runtime service user',
  );
  requireCondition(
    workspaceGroup !== serviceGroup,
    'workspace SSH group must differ from the runtime service group',
  );
  // The whole point of the third identity is that it is a THIRD one. Collapsing it onto either
  // existing account silently restores the contradiction D-248 diagnoses — onto the SSH account
  // it re-grants runtime read to the customer's login (D-043), and onto the service account it
  // hands the agent runtime $STATE_ROOT, which holds embedded PG and every delivered credential.
  requireCondition(
    agentUser !== workspaceUser && agentUser !== serviceUser,
    'agent identity must differ from both the workspace SSH user and the runtime service user',
  );
  requireCondition(
    agentGroup !== workspaceGroup && agentGroup !== serviceGroup,
    'agent group must differ from both the workspace SSH group and the runtime service group',
  );
  assertWorkspaceHostSecretIsolation(
    input.publicMetadata ?? {},
    'bootstrap.publicMetadata',
  );
  assertNoSecretShapedMetadata(
    input.publicMetadata ?? {},
    'bootstrap.publicMetadata',
  );
  return {
    hostModel,
    bootc,
    entrypoints: normalizedEntrypoints(input.entrypoints),
    serviceUser,
    serviceGroup,
    workspaceUser,
    workspaceGroup,
    agentUser,
    agentGroup,
    workspaceAuthorizedKeys: normalizedAuthorizedKeys(
      input.workspaceAuthorizedKeys,
    ),
    agentRuntimeInstalls: normalizedAgentRuntimeInstalls(
      input.agentRuntimeInstalls,
    ),
    connectorOrigin: input.hostedConnector
      ? requireHttpsOrigin(
          input.hostedConnector.controlPlaneOrigin,
          'hostedConnector.controlPlaneOrigin',
        )
      : null,
    statusChannel: normalizedStatusChannel(input.statusChannel),
  };
}

/**
 * Validate the D-259 agent-runtime installs.
 *
 * Absent is legal and means "this host installs no vendor runtime" — the attestation then says so
 * rather than claiming otherwise. What is NOT legal is a malformed or duplicated entry: each is
 * rendered into a root bootstrap as an argv run under `runuser`, so a blank command or a repeated
 * agent is a render-time error, never something to discover on a host.
 */
function normalizedAgentRuntimeInstalls(
  installs: readonly WorkspaceHostAgentRuntimeInstall[] | undefined,
): readonly WorkspaceHostAgentRuntimeInstall[] {
  if (installs === undefined) return [];
  requireCondition(
    Array.isArray(installs),
    'bootstrap.agentRuntimeInstalls must be an array when provided',
  );
  const seen = new Set<string>();
  for (const install of installs) {
    requireCondition(
      typeof install === 'object' &&
        install !== null &&
        (install.agent === 'claude' ||
          install.agent === 'codex' ||
          install.agent === 'omp'),
      "bootstrap.agentRuntimeInstalls[].agent must be 'claude', 'codex' or 'omp'",
    );
    requireCondition(
      typeof install.command === 'string' && install.command.trim().length > 0,
      'bootstrap.agentRuntimeInstalls[].command must be a non-empty string',
    );
    requireCondition(
      // `Array.isArray` widens a readonly string[] to any[], so annotate the callback parameter
      // rather than letting it land as an implicit any under noImplicitAny.
      Array.isArray(install.args) &&
        install.args.every((arg: unknown) => typeof arg === 'string'),
      'bootstrap.agentRuntimeInstalls[].args must be an array of strings',
    );
    requireCondition(
      !seen.has(install.agent),
      `bootstrap.agentRuntimeInstalls has a duplicate entry for '${install.agent}'`,
    );
    seen.add(install.agent);
  }
  return installs.map((install) => ({
    agent: install.agent,
    command: install.command,
    args: [...install.args],
  }));
}

/**
 * A plain OpenSSH public key: `<type> <base64>` with an optional free-text comment.
 *
 * Deliberately NOT the full authorized_keys grammar — an options prefix
 * (`command="…"`, `permitopen=…`) is refused rather than passed through, because the
 * sshd hardening this bootstrap writes is the security boundary and a per-key option
 * would silently reshape it.
 */
const SSH_PUBLIC_KEY =
  /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}(?: [^\r\n]*)?$/;

function normalizedAuthorizedKeys(
  keys: readonly string[] | undefined,
): readonly string[] {
  requireCondition(
    Array.isArray(keys) && keys.length > 0,
    'workspaceAuthorizedKeys must list at least one OpenSSH public key — harden-os sets ' +
      'AuthenticationMethods publickey and AllowUsers $WORKSPACE_USER, so a render with no key ' +
      'produces a host that is unreachable by construction (D-238)',
  );
  const normalized = (keys as readonly string[]).map((key) =>
    typeof key === 'string' ? key.trim() : '',
  );
  normalized.forEach((key, index) => {
    requireCondition(
      SSH_PUBLIC_KEY.test(key),
      `workspaceAuthorizedKeys[${index}] must be one plain OpenSSH public key line ` +
        `('<type> <base64> [comment]', no authorized_keys options and no newline)`,
    );
  });
  const unique = [...new Set(normalized)];
  requireCondition(
    unique.length === normalized.length,
    'workspaceAuthorizedKeys must not repeat a key',
  );
  return unique;
}

function assignment(name: string, value: string): string {
  return `${name}=${shellQuote(value)}`;
}

/**
 * D-403: the desktop connector's enrollment seam, as three slices of the bootstrap.
 *
 * `install` writes the SSH-side conduit and the root program. The program's header is an
 * UNQUOTED heredoc so the bootstrap's own `$WORKSPACE_ROOT` / `$SERVICE_NAME` land in it as
 * literals; the body is a QUOTED heredoc so nothing in it expands at render time.
 *
 * What the program does, and why each part is shaped the way it is:
 * - the ticket arrives on stdin and reaches curl through `--config -`, never through argv,
 *   because `/proc/<pid>/cmdline` is world-readable;
 * - the origin is this function's argument, never input, so a request cannot redirect it;
 * - the bearer is written to a root-only file that PID 1 reads before dropping privileges;
 * - the receipt names the generation and nothing derived from the bearer.
 *
 * The program deliberately contains no `*`: the sibling conduit test forbids sudoers wildcards
 * across this whole region, and a shell glob here would be indistinguishable from one.
 */
function connectorEnrollmentLines(origin: string): {
  install: string[];
  sudoersAliases: string[];
  sudoersGrant: string;
} {
  const [flag, version] = WORKSPACE_HOST_CONNECTOR_ENROLLMENT_ARGV;
  const refused = 'echo "connector enrollment: refused argv" >&2; exit 64;';
  return {
    install: [
      'install -d -o root -g root -m 0755 "$(dirname "$CONNECTOR_ENROLLMENT_PROGRAM")"',
      'install -o root -g root -m 0755 /dev/null "$CONNECTOR_ENROLLMENT_CONDUIT"',
      "cat > \"$CONNECTOR_ENROLLMENT_CONDUIT\" <<'PAPERCUSP_CONNECTOR_CONDUIT'",
      "#!/bin/sh",
      "set -eu",
      `[ "$#" -eq 2 ] && [ "$1" = ${shellQuote(flag)} ] && [ "$2" = ${shellQuote(version)} ] || { ${refused} }`,
      `exec /usr/bin/sudo -n -- ${shellQuote(WORKSPACE_HOST_CONNECTOR_ENROLLMENT_PROGRAM)} "$@"`,
      "PAPERCUSP_CONNECTOR_CONDUIT",
      'install -o root -g root -m 0700 /dev/null "$CONNECTOR_ENROLLMENT_PROGRAM"',
      'cat > "$CONNECTOR_ENROLLMENT_PROGRAM" <<PAPERCUSP_CONNECTOR_PROGRAM_HEADER',
      "#!/bin/sh",
      assignment("ORIGIN", origin),
      'WORKSPACE_ROOT="$WORKSPACE_ROOT"',
      'SERVICE="$SERVICE_NAME.service"',
      assignment("ENVIRONMENT_FILE", WORKSPACE_HOST_CONNECTOR_ENVIRONMENT_FILE),
      "PAPERCUSP_CONNECTOR_PROGRAM_HEADER",
      "cat >> \"$CONNECTOR_ENROLLMENT_PROGRAM\" <<'PAPERCUSP_CONNECTOR_PROGRAM'",
      "set -eu",
      "umask 077",
      `[ "$#" -eq 2 ] && [ "$1" = ${shellQuote(flag)} ] && [ "$2" = ${shellQuote(version)} ] || { ${refused} }`,
      'IFS= read -r TICKET || { echo "connector enrollment: no ticket on stdin" >&2; exit 65; }',
      "printf '%s\\n' \"$TICKET\" | grep -Eqx 'ht_[A-Za-z0-9_-]{43}' || { echo \"connector enrollment: refused ticket\" >&2; exit 65; }",
      'RESPONSE="$(mktemp)"',
      'STAGED=""',
      "trap 'rm -f \"$RESPONSE\" ${STAGED:+\"$STAGED\"}' EXIT",
      "STATUS=\"$(printf 'header = \"x-papercusp-connector-ticket: %s\"\\n' \"$TICKET\" | curl --config - --silent --show-error --proto '=https' --max-time 30 --request POST --header 'content-type: application/json' --data '{}' --output \"$RESPONSE\" --write-out '%{http_code}' \"$ORIGIN/api/hosted/connectors/register\")\" || { echo \"connector enrollment: could not reach $ORIGIN\" >&2; exit 69; }",
      '[ "$STATUS" = "200" ] || { echo "connector enrollment: $ORIGIN refused the ticket (HTTP $STATUS)" >&2; exit 77; }',
      "BEARER=\"$(grep -o '\"bearer\":\"hc_[A-Za-z0-9_-]\\{43\\}\"' \"$RESPONSE\" | head -n 1 | cut -d '\"' -f 4)\"",
      "GENERATION=\"$(grep -o '\"generation\":[0-9]\\{1,\\}' \"$RESPONSE\" | head -n 1 | cut -d ':' -f 2)\"",
      '[ -n "$BEARER" ] && [ -n "$GENERATION" ] || { echo "connector enrollment: $ORIGIN answered without a credential" >&2; exit 76; }',
      'STAGED="$(mktemp "$ENVIRONMENT_FILE.XXXXXX")"',
      "printf 'PAPERCUSP_HOSTED_CONNECTOR_BEARER=%s\\nPAPERCUSP_HOSTED_CONTROL_PLANE_URL=%s\\nPAPERCUSP_HOSTED_WORKSPACE_ROOT=%s\\n' \"$BEARER\" \"$ORIGIN\" \"$WORKSPACE_ROOT\" > \"$STAGED\"",
      'chmod 0600 "$STAGED"',
      'mv -f "$STAGED" "$ENVIRONMENT_FILE"',
      'STAGED=""',
      'systemctl restart "$SERVICE" || { echo "connector enrollment: $SERVICE did not restart" >&2; exit 75; }',
      `printf '{"protocolVersion":"%s","generation":%s,"registered":true}\\n' ${shellQuote(version)} "$GENERATION"`,
      "PAPERCUSP_CONNECTOR_PROGRAM",
    ],
    sudoersAliases: [
      `Cmnd_Alias PAPERCUSP_WORKSPACE_HOST_CONNECTOR = ${WORKSPACE_HOST_CONNECTOR_ENROLLMENT_PROGRAM} ${WORKSPACE_HOST_CONNECTOR_ENROLLMENT_ARGV.join(" ")}`,
      "Defaults!PAPERCUSP_WORKSPACE_HOST_CONNECTOR env_reset, !setenv",
    ],
    sudoersGrant: ", PAPERCUSP_WORKSPACE_HOST_CONNECTOR",
  };
}

/**
 * Install the vendor agent runtimes as the AGENT identity (D-259).
 *
 * Each already-resolved argv runs under `runuser`, and is then followed by a RESOLVE that must
 * succeed. The resolve is the whole point: an install that exits 0 while leaving nothing on disk
 * is precisely the unbacked boolean this work exists to remove, so the attestation's
 * `agentRuntimesInstalledByBootstrap` is only ever true downstream of a resolve that passed.
 *
 * ⛔ That is `Installed`, NOT `Verified`. `agentRuntimesVerifiedByBootstrap` stays a hardcoded
 * `false` and D-252's validator still refuses anything else. A passing resolve proves the binary
 * is PRESENT and EXECUTABLE; it proves nothing about whether anyone has authenticated it, and the
 * two claims collapsing into one is how the wrappers came to be mistaken for working agent CLIs.
 *
 * PATH is set explicitly and DELIBERATELY EXCLUDES the release's own `bin/`. That directory holds
 * the psu wrappers named `claude`/`codex`/`omp`; leaving it on PATH would let the resolve find a
 * WRAPPER and report success while no vendor runtime existed — the exact confusion that made
 * D-247 read as a probe bug across three sessions. The dirs included are where these installers
 * actually land: `~/.local/bin` (the Claude installer and the omp download) and
 * `~/.papercusp/runtime/node_modules/.bin` (the codex `npm install --prefix` target).
 *
 * The resolved absolute path is captured per agent so the canary's readiness probe can exec the
 * VENDOR binary directly instead of shelling the wrapper.
 */
/**
 * Install Node (and therefore npm) into the agent identity's own `~/.local`, BEFORE any vendor
 * agent install runs (D-263).
 *
 * WHY THIS EXISTS — the failure it removes was expensive to read, so it is worth stating plainly.
 * The codex install argv is the DESKTOP onboarding script, reused verbatim by this host
 * (`buildFrameworkInstallSpec`), and it opens with `npm init -y`. On a developer's machine npm is
 * simply there. On this host it is nowhere: not in the apt contract, and not in the bundle, which
 * ships a bare `node` with no npm. So bootstrap died at `bash: line 4: npm: command not found` ->
 * `agent runtime install failed: codex`, ABORTING before `/usr/local/bin/papercusp-workspace-host-initialize`
 * was ever installed — which surfaced downstream as every canary failing `0/6` with a bare
 * `exit 127 ... No such file or directory`. That error names a MISSING FILE, so it reads as a
 * packaging defect in the 2GB bundle; the bundle was fine and verified. A missing-file error at
 * step 0 is more often an aborted predecessor than a bad package.
 *
 * Extraction is limited to `bin/` and `lib/` (the tarball also carries docs/headers that nothing
 * here needs) and lands in `$AGENT_HOME/.local`, which `AGENT_RUNTIME_PATH` ALREADY resolves — so
 * this adds no new PATH entry and cannot widen the resolve surface. Re-running is a no-op once the
 * pinned version is present, keeping the bootstrap replay-safe.
 */
function agentNodeRuntimeInstallLines(): string[] {
  const version = WORKSPACE_HOST_AGENT_NODE_VERSION;
  const script = [
    "set -euo pipefail",
    'target="$HOME/.local"',
    // Idempotent: a replay (or an upgrade re-running this bootstrap) re-downloads nothing.
    `if [ "$("$target/bin/node" --version 2>/dev/null || true)" = "v${version}" ]; then exit 0; fi`,
    'case "$(uname -m)" in',
    `  x86_64) arch=x64; sum=${WORKSPACE_HOST_AGENT_NODE_SHA256.x64};;`,
    `  aarch64) arch=arm64; sum=${WORKSPACE_HOST_AGENT_NODE_SHA256.arm64};;`,
    // Fail closed and NAME the architecture: a silent skip here would hand the codex install the
    // same "npm: command not found" this function exists to remove.
    '  *) echo "unsupported architecture for the agent Node runtime: $(uname -m)" >&2; exit 1;;',
    "esac",
    `dir="node-v${version}-linux-$arch"`,
    'tmp="$target/.node-install"',
    'rm -rf "$tmp"',
    'mkdir -p "$tmp" "$target"',
    `curl -fsSL --retry 3 ${WORKSPACE_HOST_CURL_STALL_GUARD} -o "$tmp/node.tar.gz" "https://nodejs.org/dist/v${version}/$dir.tar.gz"`,
    // The pin is the trust boundary: a swapped upstream tarball fails here rather than executing.
    'printf "%s  %s\\n" "$sum" "$tmp/node.tar.gz" | sha256sum -c - >/dev/null',
    'tar -xzf "$tmp/node.tar.gz" -C "$target" --strip-components=1 "$dir/bin" "$dir/lib"',
    'rm -rf "$tmp"',
    // Assert both halves rather than assuming the extract produced them: npm is a symlink into
    // lib/, so an extract that took bin/ alone would leave a `node` that works and an `npm` that
    // dangles — the exact shape that fails later, inside the codex install, reading as codex's bug.
    '"$target/bin/node" --version >/dev/null',
    '"$target/bin/npm" --version >/dev/null',
  ].join("\n");
  return [
    "",
    `# D-263: the vendor agent CLIs need npm to install and node to run; the host has neither`,
    `# (apt ships none, and the bundle's Node is a bare binary in the wrapper dir PATH excludes).`,
    `echo "==> installing agent Node runtime v${version}" >&2`,
    `runuser -u "$AGENT_USER" -- env HOME="$AGENT_HOME" PATH="$AGENT_RUNTIME_PATH" /bin/bash -c ${shellQuote(
      script,
    )} || die ${shellQuote(`agent Node runtime install failed (v${version})`)}`,
  ];
}

function agentRuntimeInstallLines(
  installs: readonly WorkspaceHostAgentRuntimeInstall[],
): string[] {
  if (installs.length === 0) return [];
  const lines: string[] = [
    "",
    "# D-259: the release bundle ships psu WRAPPERS named claude/codex/omp, not the vendor CLIs,",
    "# and psu resolves a real backend from well-known dirs. Without these installs psu aborts",
    "# every agent launch, so the host cannot run an agent at all.",
    'AGENT_RUNTIME_PATH="$AGENT_HOME/.local/bin:$AGENT_HOME/.papercusp/runtime/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
    // Ordered BEFORE the vendor installs: codex's own installer shells `npm`, so this is a
    // prerequisite of the loop below rather than one more entry in it.
    ...agentNodeRuntimeInstallLines(),
  ];
  for (const install of installs) {
    const argv = [install.command, ...install.args].map(shellQuote).join(" ");
    lines.push(
      `runuser -u "$AGENT_USER" -- env HOME="$AGENT_HOME" PATH="$AGENT_RUNTIME_PATH" ${argv} || die ${shellQuote(
        `agent runtime install failed: ${install.agent}`,
      )}`,
    );
  }
  for (const install of installs) {
    const varName = `AGENT_RUNTIME_${install.agent.toUpperCase()}`;
    lines.push(
      `${varName}="$(runuser -u "$AGENT_USER" -- env HOME="$AGENT_HOME" PATH="$AGENT_RUNTIME_PATH" /bin/bash -c ${shellQuote(
        `command -v ${install.agent}`,
      )} || true)"`,
      `[[ -n "$${varName}" ]] || die ${shellQuote(
        `agent runtime did not resolve after install: ${install.agent}`,
      )}`,
    );
  }
  return lines;
}

/** Publish only the credential-free OMP executable and model registry to the customer identity. */
function workspaceOmpRuntimeInstallLines(
  installs: readonly WorkspaceHostAgentRuntimeInstall[],
): string[] {
  if (!installs.some((install) => install.agent === 'omp')) return [];
  const models = Buffer.from(WORKSPACE_HOST_AGENT_HOME_OMP_LOCAL_MODELS_YML, 'utf8').toString('base64');
  const installModels = [
    'set -euo pipefail',
    'umask 077',
    'mkdir -p "$HOME/.omp/agent"',
    `printf %s ${shellQuote(models)} | base64 -d > "$HOME/.omp/agent/models.yml"`,
    'chmod 0600 "$HOME/.omp/agent/models.yml"',
  ].join('\n');
  return [
    '',
    '# The agent home holds platform credentials. Copy only the standalone public OMP executable.',
    '[[ "$AGENT_RUNTIME_OMP" == "$AGENT_HOME/.local/bin/omp" && -f "$AGENT_RUNTIME_OMP" && ! -L "$AGENT_RUNTIME_OMP" ]] || die "vendor OMP is not the expected standalone executable"',
    'install -m 0755 -o root -g root -- "$AGENT_RUNTIME_OMP" /usr/local/bin/omp',
    `runuser -u "$WORKSPACE_USER" -- env HOME="/home/$WORKSPACE_USER" /bin/bash -c ${shellQuote(installModels)} || die "customer OMP model registry install failed"`,
    'runuser -u "$WORKSPACE_USER" -- test -x /usr/local/bin/omp || die "customer cannot execute native OMP"',
    'runuser -u "$WORKSPACE_USER" -- test ! -r "$AGENT_HOME" || die "customer OMP path exposes platform agent credentials"',
  ];
}

/**
 * Publish the customer agent toolchain (D-423, WI-10003195) — see
 * {@link WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_ROOT}.
 *
 * Runs after the agent-identity installs and resolves above, and copies FROM them: the pinned Node
 * (a standalone binary), codex's npm `node_modules` tree (the `bin/codex.js` shim plus its
 * per-platform binary), and claude's resolved native executable. OMP is already published at
 * `/usr/local/bin/omp` and is linked in. The tree is staged at `.next`, owned by root, made
 * world-readable-and-executable, and swapped in whole, so a replay or an upgrade never leaves a
 * half-written toolchain behind.
 *
 * The verify half is the point: the customer account must be able to EXECUTE each published CLI,
 * and must NOT be able to read the Papercusp release or the platform agent home (D-043). A copy
 * that dragged a credential file along dies here instead of publishing it.
 */
/**
 * Plan agent-capacity-and-cost-gcp-2026-09-30 D-031 ruling 2: publish the heavy-job admission pair
 * (the node --require preload and pc-heavy.sh, which is self-contained) into the customer toolchain,
 * so hosted agents' tsc/vitest wait for a memory slot. One root-owned read-only script plus a
 * preload: no runtime, no credential, no control-plane logic (D-031's reading of D-043). Copied
 * only when the release carries BOTH files, and the bootstrap log says which way it went; the
 * operator sets the activating env only when both are present in the published toolchain
 * (<toolchain root>/lib/heavy-admission/, read by hostedHeavyAdmissionEnv in operator-core's
 * workspace-host/hosted-agent-identity.ts).
 */
function customerHeavyAdmissionInstallLines(): string[] {
  return [
    'if [[ -f "$RELEASE_DIR/scripts/heavy-admission.cjs" && -f "$RELEASE_DIR/scripts/pc-heavy.sh" ]]; then',
    '  install -d -m 0755 -o root -g root -- "$TOOLCHAIN_NEXT/lib" "$TOOLCHAIN_NEXT/lib/heavy-admission"',
    '  install -m 0644 -o root -g root -- "$RELEASE_DIR/scripts/heavy-admission.cjs" "$TOOLCHAIN_NEXT/lib/heavy-admission/heavy-admission.cjs"',
    '  install -m 0755 -o root -g root -- "$RELEASE_DIR/scripts/pc-heavy.sh" "$TOOLCHAIN_NEXT/lib/heavy-admission/pc-heavy.sh"',
    '  echo "PAPERCUSP_HEAVY_ADMISSION status=installed"',
    'else',
    '  echo "PAPERCUSP_HEAVY_ADMISSION status=absent reason=release-lacks-scripts (hosted agents run heavy jobs unadmitted)"',
    'fi',
  ];
}

/**
 * WI-10005362 (plan agent-capacity-and-cost-gcp-2026-09-30, D-021's lever): install the shared
 * typecheck service as systemd USER template units, so every hosted agent's scoped
 * `lint:tsc --files` in a papercusp checkout is answered by one loaded tsgo program (~1.5 s) instead
 * of a full compile (measured on a spot e2-standard-16: 312 CPU-s, 14 GB peak per check).
 *
 * A template because the host's checkouts are cloned under the workspace root AFTER this script ran,
 * so no fixed-ROOT unit (the tower's papercup-tsc-service) can name them. The instance is the
 * systemd-escaped checkout path (`%f` resolves it back); the checkout's own client starts it on
 * demand in the agent account's user manager (agents run over a loopback SSH login, so pam_systemd
 * provides one). It runs the CHECKOUT's own server script with the toolchain's Node, as the
 * customer: no Papercusp runtime code and no credential cross (D-043).
 *
 * Memory: one operator-core program is 5-9 GiB loaded. MemoryMax is a quarter of host RAM clamped to
 * 10-16 GiB, and hosts under 24 GiB get no service (the bootstrap removes the units, so the operator
 * stops advertising them). The service's RSS lowers MemAvailable, which pc-heavy's admission reads
 * live, so the two budgets cannot double-book. A killed or refused service costs speed, never a
 * verdict: the client falls back to the full compile.
 */
export function customerTscServiceInstallLines(
  paths: { readonly unitDir?: string; readonly meminfo?: string } = {},
): string[] {
  const base = WORKSPACE_HOST_TSC_SERVICE_UNIT_TEMPLATE;
  const unitDir = paths.unitDir ?? posix.dirname(WORKSPACE_HOST_TSC_SERVICE_SOCKET_UNIT_FILE);
  const socketUnit = posix.join(unitDir, `${base}@.socket`);
  const serviceUnit = posix.join(unitDir, `${base}@.service`);
  return [
    '',
    '# WI-10005362: the shared typecheck service, one user-unit instance per papercusp checkout.',
    `MEM_TOTAL_GIB=$(( $(awk '/^MemTotal:/{print $2}' ${shellQuote(paths.meminfo ?? '/proc/meminfo')}) / 1048576 ))`,
    'if (( MEM_TOTAL_GIB >= 24 )); then',
    '  TSC_MAX_GIB=$(( MEM_TOTAL_GIB / 4 )); (( TSC_MAX_GIB > 16 )) && TSC_MAX_GIB=16; (( TSC_MAX_GIB < 10 )) && TSC_MAX_GIB=10',
    '  TSC_HIGH_GIB=$(( TSC_MAX_GIB - 2 )); TSC_RSS_RESET_GIB=$(( TSC_MAX_GIB - 4 ))',
    '  TSC_MAX_PROJECTS=1; (( TSC_MAX_GIB >= 14 )) && TSC_MAX_PROJECTS=2',
    `  install -d -m 0755 -o root -g root -- ${shellQuote(unitDir)}`,
    `  cat > ${shellQuote(`${socketUnit}.next`)} <<PAPERCUSP_TSC_SOCKET`,
    '[Unit]',
    'Description=Papercusp shared typecheck service socket for %f (WI-10005362)',
    '',
    '[Socket]',
    `ListenStream=%t/${base}-%i.sock`,
    'SocketMode=0600',
    'PAPERCUSP_TSC_SOCKET',
    `  cat > ${shellQuote(`${serviceUnit}.next`)} <<PAPERCUSP_TSC_SERVICE`,
    '[Unit]',
    'Description=Papercusp shared typecheck service for %f (WI-10005362)',
    `Requires=${base}@%i.socket`,
    `After=${base}@%i.socket`,
    'ConditionPathExists=%f/scripts/tsc-service/server.mjs',
    '',
    '[Service]',
    'Type=simple',
    'Environment=PATH=$TOOLCHAIN_ROOT/bin:/usr/local/bin:/usr/bin:/bin',
    'Environment=PAPERCUSP_TSC_SERVICE_ROOT=%f',
    'Environment=PAPERCUSP_TSC_SERVICE_IDLE_SEC=1200',
    'Environment=PAPERCUSP_TSC_SERVICE_RSS_RESET_GIB=$TSC_RSS_RESET_GIB',
    'Environment=PAPERCUSP_TSC_SERVICE_MAX_PROJECTS=$TSC_MAX_PROJECTS',
    'WorkingDirectory=%f',
    'ExecStart=$TOOLCHAIN_ROOT/bin/node %f/scripts/tsc-service/server.mjs',
    'Restart=on-failure',
    'RestartSec=2',
    'Nice=10',
    'CPUWeight=50',
    'MemoryAccounting=yes',
    'MemoryHigh=${TSC_HIGH_GIB}G',
    'MemoryMax=${TSC_MAX_GIB}G',
    'MemorySwapMax=0',
    'PAPERCUSP_TSC_SERVICE',
    `  chown root:root -- ${shellQuote(`${socketUnit}.next`)} ${shellQuote(`${serviceUnit}.next`)}`,
    `  chmod 0644 -- ${shellQuote(`${socketUnit}.next`)} ${shellQuote(`${serviceUnit}.next`)}`,
    `  mv -f -- ${shellQuote(`${socketUnit}.next`)} ${shellQuote(socketUnit)}`,
    `  mv -f -- ${shellQuote(`${serviceUnit}.next`)} ${shellQuote(serviceUnit)}`,
    '  echo "PAPERCUSP_TSC_SERVICE status=installed memoryMaxGiB=$TSC_MAX_GIB maxProjects=$TSC_MAX_PROJECTS"',
    'else',
    `  rm -f -- ${shellQuote(socketUnit)} ${shellQuote(serviceUnit)}`,
    '  echo "PAPERCUSP_TSC_SERVICE status=absent reason=host-memory-below-24GiB memTotalGiB=$MEM_TOTAL_GIB (hosted agents pay a full compile per scoped typecheck)"',
    'fi',
  ];
}

function customerAgentToolchainInstallLines(
  installs: readonly WorkspaceHostAgentRuntimeInstall[],
): string[] {
  if (installs.length === 0) return [];
  const has = (agent: WorkspaceHostAgentRuntimeInstall['agent']) =>
    installs.some((install) => install.agent === agent);
  const customerRun = (command: string) =>
    `runuser -u "$WORKSPACE_USER" -- env HOME="/home/$WORKSPACE_USER" PATH="$TOOLCHAIN_ROOT/bin:/usr/local/bin:/usr/bin:/bin" timeout 120 ${command}`;
  const lines: string[] = [
    '',
    '# D-423: customer-driven agents run as the workspace account (D-421), which D-043 bars from the',
    '# Papercusp runtime. Publish root-owned copies of the open-source Node and the vendor agent CLIs',
    '# OUTSIDE the runtime root — never Papercusp code, never a credential.',
    `TOOLCHAIN_ROOT=${shellQuote(WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_ROOT)}`,
    'TOOLCHAIN_NEXT="$TOOLCHAIN_ROOT.next"',
    'rm -rf --one-file-system -- "$TOOLCHAIN_NEXT"',
    'install -d -m 0755 -o root -g root -- "$TOOLCHAIN_NEXT" "$TOOLCHAIN_NEXT/bin"',
    '[[ -f "$AGENT_HOME/.local/bin/node" && ! -L "$AGENT_HOME/.local/bin/node" ]] || die "agent Node runtime is not the expected standalone executable"',
    'install -m 0755 -o root -g root -- "$AGENT_HOME/.local/bin/node" "$TOOLCHAIN_NEXT/bin/node"',
  ];
  if (has('codex')) {
    lines.push(
      '[[ "$AGENT_RUNTIME_CODEX" == "$AGENT_HOME/.papercusp/runtime/node_modules/.bin/codex" ]] || die "vendor codex did not resolve inside the agent npm runtime prefix"',
      'mkdir -p -- "$TOOLCHAIN_NEXT/codex"',
      'cp -R -P -- "$AGENT_HOME/.papercusp/runtime/node_modules" "$TOOLCHAIN_NEXT/codex/node_modules"',
      'ln -s ../codex/node_modules/.bin/codex "$TOOLCHAIN_NEXT/bin/codex"',
    );
  }
  if (has('claude')) {
    lines.push(
      'CLAUDE_REAL="$(readlink -f -- "$AGENT_RUNTIME_CLAUDE")"',
      '[[ "$CLAUDE_REAL" == "$AGENT_HOME/"* && -f "$CLAUDE_REAL" ]] || die "vendor claude did not resolve to a file inside the agent home"',
      'install -m 0755 -o root -g root -- "$CLAUDE_REAL" "$TOOLCHAIN_NEXT/bin/claude"',
    );
  }
  if (has('omp')) {
    lines.push('ln -s /usr/local/bin/omp "$TOOLCHAIN_NEXT/bin/omp"');
  }
  lines.push(...customerHeavyAdmissionInstallLines());
  lines.push(
    'chown -R -h root:root -- "$TOOLCHAIN_NEXT"',
    'chmod -R go-w,a+rX -- "$TOOLCHAIN_NEXT"',
    'if find "$TOOLCHAIN_NEXT" \\( -name auth.json -o -name .credentials.json \\) -print -quit | grep -q .; then die "customer agent toolchain would publish an agent credential file"; fi',
    'rm -rf --one-file-system -- "$TOOLCHAIN_ROOT.previous"',
    'if [[ -e "$TOOLCHAIN_ROOT" ]]; then mv -T -- "$TOOLCHAIN_ROOT" "$TOOLCHAIN_ROOT.previous"; fi',
    'mv -T -- "$TOOLCHAIN_NEXT" "$TOOLCHAIN_ROOT"',
    'rm -rf --one-file-system -- "$TOOLCHAIN_ROOT.previous"',
    `${customerRun('node --version')} >/dev/null || die "customer cannot execute the agent toolchain Node"`,
  );
  if (has('codex')) {
    lines.push(`${customerRun('codex --version')} >/dev/null || die "customer cannot execute codex from the agent toolchain"`);
  }
  if (has('claude')) {
    lines.push(`${customerRun('claude --version')} >/dev/null || die "customer cannot execute claude from the agent toolchain"`);
  }
  lines.push(
    'runuser -u "$WORKSPACE_USER" -- test ! -r "$RELEASE_DIR" || die "customer account can read the Papercusp release (D-043)"',
    'runuser -u "$WORKSPACE_USER" -- test ! -r "$AGENT_HOME" || die "customer agent toolchain path exposes the platform agent home"',
  );
  lines.push(...customerTscServiceInstallLines());
  return lines;
}

/**
 * Install the local-inference runtime OMP proves its readiness against (D-266).
 *
 * Gated on OMP actually being installed: a host that runs no OMP has nothing to prove by local
 * inference, and ~450 MiB of runtime plus model is not worth staging on it.
 *
 * The model name is IMPORTED from the probe's own module rather than restated here. These are two
 * halves of one fact — the installer must place exactly what the probe asks for — and a second
 * copy of a model tag is precisely the kind that drifts silently, leaving a host that pulled one
 * model failing a probe that requested another.
 *
 * ORDERING, PER D-264: this phase's own apt step and this unit's own start are service mutations,
 * so nothing after them may ASSUME service state. The readiness poll below is not defensive
 * padding — `systemctl enable --now` returns once systemd has forked the unit, not once the HTTP
 * API is accepting connections, and the pull that follows talks to that API. Without the poll the
 * pull races the daemon and fails on a host where nothing is actually wrong.
 */
function localInferenceRuntimeInstallLines(
  installs: readonly WorkspaceHostAgentRuntimeInstall[],
  hostModel: WorkspaceHostModel,
): string[] {
  if (!installs.some((install) => install.agent === 'omp')) return [];
  const version = WORKSPACE_HOST_OLLAMA_VERSION;
  const model = WORKSPACE_HOST_OMP_LOCAL_MODEL;
  const endpoint = 'http://127.0.0.1:11434';
  return [
    '',
    '# D-266: OMP is credential-free BY CONTRACT (D-245 — inventing an auth file would fabricate',
    '# authentication state), and the other half of that contract is that it proves readiness by',
    '# LOCAL INFERENCE. Nothing implemented this half, so `omp` could not pass on any host this',
    '# bootstrap built and the canary sat at 5/6 with a failure that read as a credential fault.',
    `echo "==> installing local-inference runtime (ollama v${version})" >&2`,
    'case "$(uname -m)" in',
    `  x86_64) OLLAMA_ARCH=amd64; OLLAMA_SUM=${WORKSPACE_HOST_OLLAMA_SHA256.x64};;`,
    `  aarch64) OLLAMA_ARCH=arm64; OLLAMA_SUM=${WORKSPACE_HOST_OLLAMA_SHA256.arm64};;`,
    // Fail closed and NAME the architecture, exactly as the Node runtime install does: a silent
    // skip here would hand the OMP probe a missing runtime and report it as a credential fault.
    '  *) die "unsupported architecture for the local-inference runtime: $(uname -m)";;',
    'esac',
    // The upstream artifact is zstd-compressed and stock Ubuntu 24.04 ships no unzstd.
    'command -v unzstd >/dev/null 2>&1 || DEBIAN_FRONTEND=noninteractive retry 5 apt_install -y -qq zstd >/dev/null || die "zstd install failed (needed to unpack the local-inference runtime)"',
    // MEASURED on canary-11 (2026-09-03): a GCE startup-script runs as root with NO $HOME, and the
    // ollama CLI PANICS at construction when it is unset — `envconfig.Models()` (config.go:120) is
    // reached from `NewCLI()` before any subcommand runs, so EVERY ollama CLI call dies instantly:
    //     panic: $HOME is not defined
    // That is why canary-10's `ollama pull` failed in 26ms with an empty console. It also silently
    // defeated the version guard below: `ollama --version` panicked to empty stdout, so the
    // comparison never matched and the runtime was re-downloaded and re-extracted on every boot.
    // The SERVER is unaffected (systemd derives HOME from User=), so this is a CLI-only fault and
    // is fixed per-invocation rather than by exporting HOME across the whole bootstrap.
    'OLLAMA_CLI_HOME="${HOME:-/root}"',
    // The guard is BOTH halves deliberately. Matching only the CLI version made the install
    // non-idempotent in the one direction that matters: a host carrying /usr/local/bin/ollama at
    // the right version but an absent or half-extracted lib/ollama skips extraction entirely and
    // boots a runtime that cannot serve. Requiring the runner too makes a broken tree self-heal.
    `if [[ "$(HOME="$OLLAMA_CLI_HOME" /usr/local/bin/ollama --version 2>/dev/null | tr -d '\\r')" != "ollama version is ${version}" || ! -x /usr/local/lib/ollama/llama-server ]]; then`,
    '  OLLAMA_TMP="$WORK_DIR/ollama.tar.zst"',
    `  curl -fsSL --retry 3 ${WORKSPACE_HOST_CURL_STALL_GUARD} --proto "=https" --tlsv1.2 -o "$OLLAMA_TMP" "https://github.com/ollama/ollama/releases/download/v${version}/ollama-linux-$OLLAMA_ARCH.tar.zst" || die "local-inference runtime download failed"`,
    // The pin is the trust boundary — this is a ROOT install. Verified BEFORE extraction, which
    // is also why the artifact is downloaded to disk rather than streamed through tar: a stream
    // would have to extract the bytes in order to hash them.
    '  printf "%s  %s\\n" "$OLLAMA_SUM" "$OLLAMA_TMP" | sha256sum -c - >/dev/null || die "local-inference runtime digest mismatch"',
    // MEASURED 2026-09-03: cuda_v12 (1.2G) + cuda_v13 (828M) + vulkan (47M) are 2.0G of a 2.1G
    // install and are dead weight on a CPU-only host. Excluding them yields a 68M install that
    // still serves the model — verified by extracting this pinned artifact and generating.
    '  tar --use-compress-program=unzstd -xf "$OLLAMA_TMP" -C /usr/local --exclude="lib/ollama/cuda_v*" --exclude="lib/ollama/vulkan" --exclude="lib/ollama/rocm*" || die "local-inference runtime extract failed"',
    '  rm -f "$OLLAMA_TMP"',
    'fi',
    // MEASURED on canary-12 (2026-09-03): this script runs under `umask 027` (set in the preamble,
    // so it is in force for the extraction above). tar as root preserves the mode RECORDED for
    // each entry, but a parent directory it has to CREATE implicitly is made with the umask —
    // so `/usr/local/lib/ollama` landed `drwxr-x--- root root` while `/usr/local/bin/ollama`
    // kept its archived 0755. The server therefore STARTED (it could exec the binary) and then
    // could not traverse its own runtime dir, reporting `llama-server binary not found` for a
    // path that was right there.
    //
    // Two things made that expensive to see, and both are why this is a normalization rather
    // than a one-line chmod on the happy path. The bootstrap's own `[[ -x ]]` assertion below
    // runs as ROOT, which bypasses directory permission bits, so it passes on exactly the tree
    // that is broken for the service. And reproducing the extraction locally under the default
    // umask 022 yields 0755, so the artifact looks innocent — the fault is in the umask this
    // script sets, not in what was downloaded.
    //
    // Deliberately OUTSIDE the install `if`, for the same reason the version guard checks the
    // runner: a host that already carries a 0750 tree must self-heal on its next boot rather
    // than stay broken because the version happened to match. `a+rX` is the safe form — it adds
    // execute for directories and for files that already have it, so it cannot make a data file
    // executable.
    'chmod -R a+rX /usr/local/lib/ollama || die "could not normalize local-inference runtime permissions"',
    '[[ -x /usr/local/bin/ollama ]] || die "local-inference runtime did not resolve after install"',
    // MEASURED on canary-10 (2026-09-03): ollama starts, serves /api/version 200 and registers a
    // CPU inference device even when the llama-server RUNNER is missing — so the runtime looks
    // healthy and the FIRST symptom is an opaque `ollama pull` failure 26ms later with nothing on
    // stderr. That cost a whole VM to learn nothing. Assert the runner positively, and NAME what
    // is actually on disk, so the next failure diagnoses itself from the serial console.
    'if [[ ! -x /usr/local/lib/ollama/llama-server ]]; then',
    '  echo "[workspace-host-bootstrap] ERROR: local-inference runner missing at /usr/local/lib/ollama/llama-server" >&2',
    '  echo "[workspace-host-bootstrap] /usr/local/lib/ollama actually contains:" >&2',
    '  ls -la /usr/local/lib/ollama >&2 2>&1 || echo "  (directory absent)" >&2',
    '  die "local-inference runner (llama-server) missing after install"',
    'fi',
    'getent group ollama >/dev/null || groupadd --system ollama || die "could not create the ollama group"',
    `getent passwd ollama >/dev/null || useradd --system --gid ollama --home-dir ${WORKSPACE_HOST_OLLAMA_HOME_BY_MODEL[hostModel]} --create-home --shell /usr/sbin/nologin ollama || die "could not create the ollama account"`,
    'cat > /etc/systemd/system/ollama.service <<PAPERCUSP_OLLAMA',
    '[Unit]',
    'Description=Papercusp local-inference runtime',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    'ExecStart=/usr/local/bin/ollama serve',
    'User=ollama',
    'Group=ollama',
    'Restart=always',
    'RestartSec=3',
    // Loopback ONLY. The probe reaches this over 127.0.0.1 and nothing else may: an inference
    // endpoint bound to a routable address is an unauthenticated model server on the internet.
    'Environment=OLLAMA_HOST=127.0.0.1:11434',
    'Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    'PAPERCUSP_OLLAMA',
    'systemctl daemon-reload || die "could not reload systemd after writing the ollama unit"',
    'systemctl enable --now ollama || die "could not start the local-inference runtime"',
    // D-264: `enable --now` returns when systemd has forked the unit, NOT when its API accepts
    // connections. The pull below talks to that API, so it must wait for the socket, not the unit.
    'OLLAMA_READY=0',
    'for _ in $(seq 1 60); do',
    `  if curl -fsS ${endpoint}/api/version >/dev/null 2>&1; then OLLAMA_READY=1; break; fi`,
    '  sleep 1',
    'done',
    '[[ "$OLLAMA_READY" == "1" ]] || die "local-inference runtime did not become ready within 60s"',
    `echo "==> pulling local-inference model ${model}" >&2`,
    // NEVER swallow the runtime's own diagnosis. canary-10 failed on this exact line in 26ms with
    // an empty console, which made a real failure undiagnosable without SSH to a host whose OS
    // Login was itself broken. Capture the CLI's output and echo it before dying.
    `if ! HOME="$OLLAMA_CLI_HOME" timeout 900 /usr/local/bin/ollama pull ${shellQuote(model)} > "$WORK_DIR/ollama-pull.log" 2>&1; then`,
    '  echo "[workspace-host-bootstrap] ERROR: local-inference model pull failed; ollama reported:" >&2',
    '  tail -40 "$WORK_DIR/ollama-pull.log" >&2 2>/dev/null || echo "  (no output captured)" >&2',
    `  die ${shellQuote(`local-inference model pull failed: ${model}`)}`,
    'fi',
    // Assert the model is actually resolvable rather than trusting the pull's exit status — this
    // is the one fact the OMP probe depends on, and it is cheap to state positively.
    `HOME="$OLLAMA_CLI_HOME" /usr/local/bin/ollama show ${shellQuote(model)} >/dev/null 2>&1 || die ${shellQuote(
      `local-inference model did not resolve after pull: ${model}`,
    )}`,
  ];
}

/**
 * `validate-host` — prove the machine is the host model this render was built for.
 *
 * The bootc arm reads `bootc status --format=json --format-version 1` (SPELLING VERIFIED against
 * bootc 1.16.6 in the base image: it is `--format=json`, not `--json`) and refuses to continue
 * unless the document actually yielded a ref and a digest. That guard is not ceremony: every
 * extraction here is `// empty`-defaulted, so a renamed field would otherwise leave both
 * variables empty, and an empty-vs-empty digest comparison SUCCEEDS — a schema change would
 * present as a host that passed its pinning check while nothing was pinned.
 */
function hostModelValidateLines(v: ValidatedBootstrapInput): string[] {
  if (v.hostModel === 'ubuntu-release-bundle') {
    return [
      '# shellcheck disable=SC1091',
      'source /etc/os-release',
      `[[ "${'${ID:-}'}" == 'ubuntu' && "${'${VERSION_ID:-}'}" == '${WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION}' ]] || die "Ubuntu ${WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION} is required"`,
    ];
  }
  const bootc = v.bootc as NonNullable<ValidatedBootstrapInput['bootc']>;
  return [
    'command -v bootc >/dev/null 2>&1 || die "bootc is required on a bootc-image host"',
    'command -v jq >/dev/null 2>&1 || die "jq is required to read bootc status"',
    'BOOTC_STATUS="$(bootc status --format=json --format-version 1)"',
    'BOOTC_HOST_TYPE="$(printf "%s" "$BOOTC_STATUS" | jq -r ".status.type // empty")"',
    '[[ -n "$BOOTC_HOST_TYPE" ]] || die "host is not a bootc deployment (bootc status reports no booted type)"',
    'BOOTED_IMAGE_REF="$(printf "%s" "$BOOTC_STATUS" | jq -r ".status.booted.image.image.image // empty")"',
    'BOOTED_IMAGE_DIGEST="$(printf "%s" "$BOOTC_STATUS" | jq -r ".status.booted.image.imageDigest // empty")"',
    '[[ -n "$BOOTED_IMAGE_REF" && -n "$BOOTED_IMAGE_DIGEST" ]] || die "bootc status reported no booted image ref and digest — the status schema may have changed"',
    // The base the image was built FROM is not derivable from `bootc status`, which reports what
    // the host booted and never what that image derives from. The image records it under /usr
    // (workspace-host.Containerfile), which is image content: replaced atomically by an upgrade
    // and not writable on the running host.
    assignment('BOOTC_BASE_IMAGE', bootc.baseImage),
    'BOOTED_BASE_IMAGE="$(cat /usr/lib/papercusp/base-image 2>/dev/null || true)"',
    '[[ -n "$BOOTED_BASE_IMAGE" ]] || die "booted image does not record its base at /usr/lib/papercusp/base-image"',
    'if [[ "$BOOTC_BASE_IMAGE" != "$BOOTED_BASE_IMAGE" ]]; then die "booted image was built from $BOOTED_BASE_IMAGE, not the expected $BOOTC_BASE_IMAGE"; fi',
    // WI-10005830: every later phase installs under /usr/local (conduits, OMP, the ollama runtime,
    // the customer toolchain). On this model that is only writable because the image links it to
    // machine-local storage, so assert the link HERE, before the first write, and name the cause —
    // otherwise the host dies phases later on a bare EROFS from whichever install comes first.
    `[[ -L /usr/local && "$(readlink -f /usr/local)" == ${shellQuote(WORKSPACE_HOST_BOOTC_USR_LOCAL_TARGET)} ]] || die "/usr/local does not link to ${WORKSPACE_HOST_BOOTC_USR_LOCAL_TARGET} on the booted image, so every runtime install under it would hit the read-only /usr (WI-10005830)"`,
    // The image's tmpfiles dropin creates these at boot; creating them here too keeps the install
    // phases independent of whether systemd-tmpfiles has run yet. Explicit mode, because this
    // script runs under umask 027 and secure_path directories must be traversable.
    'install -d -o root -g root -m 0755 /usr/local/bin /usr/local/sbin /usr/local/lib /usr/local/libexec',
  ];
}

/**
 * `harden-os` — the package/firewall/auto-update third of the phase. The identity creation and
 * sshd hardening that follow are model-invariant and stay in the main render.
 *
 * The bootc arm ASSERTS instead of installing, and that is a design consequence rather than an
 * optimisation. Installing would write to a read-only `/usr`; more importantly a firewall
 * enabled by a bootstrap is a firewall that was ABSENT for every boot preceding it, whereas one
 * shipped in the image is up before anything can reach the host. So the checks here observe
 * that the image did its job — each `die` names a host that must not proceed.
 */
function hostModelHardenLines(
  v: ValidatedBootstrapInput,
): { head: string[]; tail: string[] } {
  if (v.hostModel === 'ubuntu-release-bundle') {
    return {
      head: [
        'export DEBIAN_FRONTEND=noninteractive',
        // `--error-on=any`: without it an unreachable archive is only a `W:` line and exit 0, so the
        // failure surfaced one command later as `E: Unable to locate package minisign` (WI-10002837).
        'retry 10 apt_update -qq --error-on=any || die "package index refresh failed after 10 attempts: the Ubuntu archive is unreachable from this host"',
      ],
      tail: [
        'ufw default deny incoming',
        'ufw default allow outgoing',
        'ufw allow 22/tcp',
        'ufw --force enable',
        'systemctl enable --now unattended-upgrades.service',
      ],
    };
  }
  return {
    head: [
      // Positive control on the package set: the image's own build probe already asserts every
      // mapped package, so re-listing them here would duplicate a check without strengthening
      // it. What the IMAGE cannot prove is that this booted host is running that image, and
      // validate-host has just established exactly that by digest.
      'log "package set supplied by the image (see infra/images/bootc/RPM-EQUIVALENCE.md); nothing to install"',
    ],
    tail: [
      // `nft list table` and not `systemctl is-active nftables.service`: a unit can be active
      // having loaded an empty or partial ruleset, and an unfiltered host is indistinguishable
      // from a filtered one until someone connects to a port that should be closed.
      'nft list table inet papercusp_workspace_host >/dev/null 2>&1 || die "firewall table \'inet papercusp_workspace_host\' is not loaded — the host is UNFILTERED"',
      // Download-only (D-281). Asserting `apply_updates = no` matters more than the timer:
      // applying in place writes to a read-only /usr and desynchronizes the running system from
      // the image it attests to be, which is what `bootc upgrade` exists to do properly.
      'systemctl is-enabled --quiet dnf-automatic.timer || die "dnf-automatic.timer is not enabled"',
      'grep -Fxq "apply_updates = no" /etc/dnf/automatic.conf || die "dnf-automatic is not download-only; in-place updates would desynchronize the deployment from its image"',
    ],
  };
}

/**
 * `verify-release` + `install-runtime` for the bootc model — the update path this port exists to
 * build (D-262's second surviving argument for bootc).
 *
 * What replaces `curl + sha256 + minisign + extract + symlink-swap`:
 *
 * - **Verification moves EARLIER and OUT of this script.** The image was checked by a containers
 *   `sigstoreSigned` policy during the pull, by skopeo, before bootc staged anything — D-279
 *   proved that path is enforced and fails closed, and proved the base's SHIPPED default policy
 *   accepts unsigned images, which is why the policy's PRESENCE is asserted rather than assumed.
 *   There is no later moment at which a booted host could re-verify that signature itself, so
 *   the honest claim is a read of the policy that gated the pull, reported by path.
 * - **The swap is a REBOOT, not a symlink move.** `ln -sfn` could switch a live process tree in
 *   place; an image swap cannot, and pretending otherwise is where a port like this goes wrong.
 *   When the booted digest already matches, there is nothing to do and the run proceeds to
 *   attest. When it does not, the run stages and reboots — and does NOT attest.
 * - **`bootc rollback` retains the previous deployment**, which is why no `restore_previous` trap
 *   is rendered here: the undo is a property of the deployment slots, not of this script's
 *   error handling, and it survives the script being killed mid-run.
 */
function bootcReleaseLines(
  v: ValidatedBootstrapInput,
  action: WorkspaceHostBootstrapInput['action'],
  hostId: string,
): string[] {
  const bootc = v.bootc as NonNullable<ValidatedBootstrapInput['bootc']>;
  const imageRepository = workspaceHostBootcImageRepository(bootc.image);
  // Pull BY DIGEST. The tag rides along as provenance only: a tag is mutable, so switching to
  // `image:tag` and then attesting the digest that arrived would attest whatever the registry
  // happened to be serving, which is a description of the outcome rather than a constraint on it.
  const pinnedImage = workspaceHostBootcPinnedImageRef(bootc);
  return [
    assignment('EXPECTED_IMAGE', bootc.image),
    assignment('EXPECTED_IMAGE_REPO', imageRepository),
    assignment('EXPECTED_IMAGE_DIGEST', bootc.imageDigest),
    assignment('EXPECTED_IMAGE_PINNED', pinnedImage),
    assignment('SIGNATURE_POLICY_PATH', bootc.signaturePolicyPath),
    assignment(
      'SIGNATURE_POLICY_SCOPE_PATH',
      WORKSPACE_HOST_BOOTC_RELEASE_REGISTRY_SCOPE_PATH,
    ),
    '[[ -s "$SIGNATURE_POLICY_PATH" ]] || die "containers signature policy is missing at $SIGNATURE_POLICY_PATH"',
    '[[ -s "$SIGNATURE_POLICY_SCOPE_PATH" ]] || die "release registry policy scope pin is missing at $SIGNATURE_POLICY_SCOPE_PATH"',
    'EXPECTED_POLICY_SCOPE="$(cat "$SIGNATURE_POLICY_SCOPE_PATH")"',
    // The image build installs one namespace-scoped policy entry, not a leaf-repository entry.
    // Prove the requested repository is inside that exact namespace before consulting it: a
    // sibling namespace must not inherit this signature claim, while a registry port remains a
    // byte-for-byte part of the key.
    'case "$EXPECTED_IMAGE_REPO" in "$EXPECTED_POLICY_SCOPE"|"$EXPECTED_POLICY_SCOPE"/*) ;; *) die "release image repository $EXPECTED_IMAGE_REPO is outside the signed policy namespace $EXPECTED_POLICY_SCOPE" ;; esac',
    // `jq -e` exits non-zero on a false/null result, so a policy that has no entry for this
    // namespace, or one whose entry is `insecureAcceptAnything`, both fail here rather than
    // reading as verified. The `default` fallback is deliberately NOT consulted: the base ships
    // a permissive default (D-279 probe C), so falling back to it is the trap, not the answer.
    `jq -e --arg scope "$EXPECTED_POLICY_SCOPE" '((.transports.docker[$scope] // []) | map(select(.type == "sigstoreSigned")) | length) > 0' "$SIGNATURE_POLICY_PATH" >/dev/null || die "containers-policy does not require a signature for $EXPECTED_POLICY_SCOPE"`,
    '',
    `phase '${WORKSPACE_HOST_BOOTSTRAP_PHASES[3]}'`,
    'if [[ "$BOOTED_IMAGE_DIGEST" != "$EXPECTED_IMAGE_DIGEST" ]]; then',
    '  log "booted deployment is $BOOTED_IMAGE_DIGEST; pinned image is $EXPECTED_IMAGE_DIGEST"',
    ...(action === 'rollback'
      ? [
          // `bootc rollback` swaps the boot order back to the retained deployment. It takes no
          // image argument by design — the previous deployment is whatever the host actually ran
          // before, which is the only thing a rollback can honestly mean.
          '  bootc rollback',
          '  STAGED_REF="$(bootc status --format=json --format-version 1 | jq -r ".status.rollback.image.image.image // empty")"',
        ]
      : [
          // `--retain` keeps the current deployment bootable, which is what makes the rollback
          // above possible on the next run. Without it a bad upgrade has nothing to fall back to.
          '  bootc switch --retain "$EXPECTED_IMAGE_PINNED"',
          '  STAGED_REF="$EXPECTED_IMAGE_PINNED"',
        ]),
    `  printf '%s{"hostId":"%s","action":"%s","stagedImage":"%s","rebooting":true}\\n' ${shellQuote(WORKSPACE_HOST_BOOTSTRAP_STAGED_PREFIX)} ${shellQuote(hostId)} ${shellQuote(action)} "$STAGED_REF"`,
    '  log "staged; rebooting into the new deployment. The attestation is produced by the NEXT run, after the reboot."',
    '  systemctl reboot',
    // `systemctl reboot` returns as soon as the job is queued, so without this the script would
    // keep running against the deployment it just replaced and emit an attestation for it.
    '  exit 0',
    'fi',
    'RELEASE_DIR="$RUNTIME_ROOT/releases/$RELEASE_VERSION"',
    // No extract, no chown, no chmod, no setfacl. The release tree is image content on this
    // model, and its ACLs are (re)applied on EVERY boot by papercusp-host-prepare.service —
    // which is also the unit that fails closed on D-283's open question of whether /opt survives
    // as image content on a booted host. Re-applying them here would either duplicate that work
    // or, if /opt is genuinely read-only, fail for a reason that has nothing to do with the
    // release.
    '[[ -d "$RELEASE_DIR" ]] || die "release $RELEASE_VERSION is not present in the booted image at $RELEASE_DIR"',
    'systemctl is-active --quiet papercusp-host-prepare.service || die "papercusp-host-prepare.service did not complete on this boot — runtime ACLs and machine-local roots are unverified"',
  ];
}

/**
 * The status report (WI-10002837): `running` first, then `succeeded` or
 * `failed exit=<n> phase=<phase> error=<die message>` from the EXIT trap. A rebooted host re-runs
 * this script, so its first act overwrites whatever the previous boot left behind.
 *
 * Delivery is best-effort by construction: a report that cannot be delivered must never change
 * the bootstrap's own outcome, so every send ends in `|| true` and the trap re-exits with the
 * original status. With no channel, `report_status` is a no-op and nothing leaves the host.
 */
function statusReportLines(
  channel: WorkspaceHostBootstrapStatusChannel | null,
): string[] {
  const url =
    'http://169.254.169.254/computeMetadata/v1/instance/guest-attributes/' +
    `${WORKSPACE_HOST_BOOTSTRAP_STATUS_GUEST_ATTRIBUTE_NAMESPACE}/${WORKSPACE_HOST_BOOTSTRAP_STATUS_GUEST_ATTRIBUTE_KEY}`;
  // The console report is ONE line: a die message with a newline would otherwise split the
  // report and the parser would read only its head.
  const deliver =
    channel === 'gce-guest-attributes'
      ? 'report_status() { curl --silent --max-time 5 --output /dev/null --request PUT ' +
        `--header "Metadata-Flavor: Google" --data-binary "$1" ${shellQuote(url)} || true; }`
      : channel === 'ec2-console-output'
        ? `report_status() { printf '%s %s\\n' ${WORKSPACE_HOST_BOOTSTRAP_STATUS_CONSOLE_MARKER} ` +
          `"\${1//[$'\\r\\n']/ }" > /dev/console 2>/dev/null || true; }`
        : 'report_status() { :; }';
  return [
    'BOOTSTRAP_PHASE=""',
    'BOOTSTRAP_ERROR=""',
    deliver,
    'report_outcome() { if [[ "$1" -eq 0 ]]; then report_status succeeded; else ' +
      `report_status "failed exit=$1 phase=$BOOTSTRAP_PHASE error=\${BOOTSTRAP_ERROR:0:${WORKSPACE_HOST_BOOTSTRAP_STATUS_ERROR_MAX_CHARS}}"; fi; }`,
    `trap 'status=$?; report_outcome "$status"; exit "$status"' EXIT`,
    'report_status running',
  ];
}

/**
 * Emit a deterministic, replay-safe root bootstrap for install, upgrade, or
 * rollback. The release bundle supplies Node, embedded Postgres tooling and psu, plus the psu
 * WRAPPERS named after the agent CLIs; the vendor agent runtimes themselves are installed at
 * provision time from `input.agentRuntimeInstalls` (D-259). apt installs only host
 * security/verification prerequisites.
 *
 * ⚠ On the bootc model an `upgrade` or `rollback` that must change the booted deployment STAGES
 * it and REBOOTS, emitting `WORKSPACE_HOST_BOOTSTRAP_STAGED_PREFIX` instead of an attestation.
 * That is not an incomplete run: an atomic image swap cannot be observed by the kernel that is
 * being replaced, so the attestation is necessarily produced by the NEXT run, after the reboot.
 * Callers must treat a staged marker as "converging", never as a failure and never as success.
 */
export function buildWorkspaceHostBootstrap(
  input: WorkspaceHostBootstrapInput,
): string {
  const validated = validateInput(input);
  const {
    hostModel,
    entrypoints,
    serviceUser,
    serviceGroup,
    workspaceUser,
    workspaceGroup,
    agentUser,
    agentGroup,
    workspaceAuthorizedKeys,
    agentRuntimeInstalls,
    connectorOrigin,
    statusChannel,
  } = validated;
  const harden = hostModelHardenLines(validated);
  const connectorEnrollment = connectorOrigin ? connectorEnrollmentLines(connectorOrigin) : null;
  const digest = input.release.bundleSha256.toLowerCase();
  const signingKeyDigest = input.release.signingKeySha256.toLowerCase();
  // PER MODEL, not the whole name space. Rendering the union would make a bootc host attest
  // `bundle-signature` — the exact "attested property no code performs" this port is unwinding.
  const checksJson = JSON.stringify(
    workspaceHostBootstrapChecks(hostModel).map((name) => ({ name, ok: true })),
  );
  const hostedPtySmoke = [
    `test "$(id -un)" = ${shellQuote(workspaceUser)}`,
    `test ! -r ${shellQuote(WORKSPACE_HOST_STATE_ROOT)}`,
    `test ! -r ${shellQuote(`${WORKSPACE_HOST_STATE_ROOT}/embedded-pg`)}`,
    `test ! -r ${shellQuote(`/home/${agentUser}`)}`,
    `test -w ${shellQuote(WORKSPACE_HOST_DATA_ROOT)}`,
    ...(agentRuntimeInstalls.some((install) => install.agent === 'omp')
      ? ['test -x /usr/local/bin/omp']
      : []),
  ].join(' && ');
  // The three model-specific slices of the attestation jq. They are built as a matched TRIPLE —
  // args, discriminant fields, release object — because they have to stay consistent with one
  // another: a `--arg` without its field renders nothing, and a field without its `--arg` makes
  // jq exit non-zero mid-attestation. Keeping them adjacent is what makes that reviewable.
  const isBootcModel = hostModel === 'bootc-image';
  const modelJqArgs = isBootcModel
    ? '--arg bootcBaseImage "$BOOTED_BASE_IMAGE" --arg source "$BOOTED_IMAGE_REF" --arg imageDigest "$BOOTED_IMAGE_DIGEST" --arg signaturePolicyPath "$SIGNATURE_POLICY_PATH" '
    : '--arg ubuntuVersion "$VERSION_ID" --arg source "$BUNDLE_URL" --arg bundleSha256 "$BUNDLE_SHA256" --arg signingKeySha256 "$SIGNING_KEY_SHA256" ';
  const modelJqFields = isBootcModel
    ? `hostModel:"${hostModel}",bootcBaseImage:$bootcBaseImage,`
    : `hostModel:"${hostModel}",ubuntuVersion:$ubuntuVersion,`;
  // `signatureVerified:true` appears in BOTH, and means two different things — minisign over a
  // downloaded tarball on one model, a containers sigstore policy that gated the pull on the
  // other. That is why the surrounding fields differ rather than being generalised into shared
  // names: a reader who sees `imageDigest` and `signaturePolicyPath` cannot mistake the claim
  // for the minisign one, whereas a shared `digest`/`verifiedBy` pair invites exactly that.
  const modelReleaseJqField = isBootcModel
    ? 'release:{version:$releaseVersion,source:$source,imageDigest:$imageDigest,signaturePolicyPath:$signaturePolicyPath,signatureVerified:true}'
    : 'release:{version:$releaseVersion,source:$source,bundleSha256:$bundleSha256,signingKeySha256:$signingKeySha256,signatureVerified:true}';
  // D-259: INSTALLED is a strictly narrower claim than VERIFIED, and they must not be conflated.
  // This render installs the vendor runtimes and RESOLVES each one (the resolve `die`s otherwise,
  // so reaching the attestation is the proof) — that establishes they are present and executable.
  // It establishes NOTHING about whether they are authenticated, which is why
  // `agentRuntimesVerifiedByBootstrap` stays hardcoded false and D-252's validator assertion that
  // refuses the optimistic lie is left exactly as it was. The authority for the authenticated
  // claim remains the readiness probe in workspace-host-agent-authentication.ts.
  const agentRuntimesInstalled = agentRuntimeInstalls.length > 0;
  const jqName = (agent: string): string =>
    `agentRuntime${agent[0].toUpperCase()}${agent.slice(1)}`;
  const agentRuntimeJqArgs = agentRuntimeInstalls
    .map(
      (install) =>
        `--arg ${jqName(install.agent)} "$AGENT_RUNTIME_${install.agent.toUpperCase()}" `,
    )
    .join("");
  const agentRuntimeJqFields = agentRuntimeInstalls.length
    ? `,agentRuntimes:{${agentRuntimeInstalls
        .map((install) => `${install.agent}:$${jqName(install.agent)}`)
        .join(",")}}`
    : "";

  const lines = [
    "#!/usr/bin/env bash",
    `# Generated by ${WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION}; contains public provenance only.`,
    "set -Eeuo pipefail",
    "umask 027",
    assignment("CONTRACT_VERSION", input.contractVersion),
    assignment("BOOTSTRAP_ACTION", input.action),
    assignment("HOST_ID", input.hostId),
    assignment("RELEASE_VERSION", input.release.version),
    assignment("BUNDLE_URL", input.release.bundleUrl),
    assignment("BUNDLE_SHA256", digest),
    assignment("SIGNATURE_URL", input.release.signatureUrl),
    assignment("SIGNING_KEY_SHA256", signingKeyDigest),
    assignment(
      "SIGNING_PUBLIC_KEY_B64",
      base64(input.release.signingPublicKey),
    ),
    assignment("MIGRATION_ID", input.migrationId),
    `MINIMUM_NODE_MAJOR=${input.minimumNodeMajor}`,
    assignment("SERVICE_NAME", input.service.name),
    `SERVICE_PORT=${input.service.port}`,
    assignment("SERVICE_USER", serviceUser),
    assignment("SERVICE_GROUP", serviceGroup),
    assignment("WORKSPACE_USER", workspaceUser),
    // Base64 so the key material cannot interact with shell quoting, and so a comment
    // containing spaces or quotes round-trips byte-for-byte into authorized_keys.
    assignment(
      "WORKSPACE_AUTHORIZED_KEYS_B64",
      base64(`${workspaceAuthorizedKeys.join("\n")}\n`),
    ),
    assignment("WORKSPACE_GROUP", workspaceGroup),
    assignment("AGENT_USER", agentUser),
    assignment("AGENT_GROUP", agentGroup),
    assignment("AGENT_HOME", `/home/${agentUser}`),
    assignment("RUNTIME_ROOT", WORKSPACE_HOST_RUNTIME_ROOT),
    assignment("STATE_ROOT", WORKSPACE_HOST_STATE_ROOT),
    assignment("BOOTSTRAP_STATE_DIR", WORKSPACE_HOST_BOOTSTRAP_STATE_DIR),
    assignment("WORKSPACE_ROOT", WORKSPACE_HOST_DATA_ROOT),
    assignment("HOSTED_PTY_SSH_KEY", WORKSPACE_HOST_HOSTED_PTY_SSH_KEY),
    assignment("HOSTED_PTY_KNOWN_HOSTS", WORKSPACE_HOST_HOSTED_PTY_KNOWN_HOSTS),
    assignment("INSTALL_ENTRYPOINT", entrypoints.install),
    assignment("ROLLBACK_ENTRYPOINT", entrypoints.rollback),
    assignment("NODE_ENTRYPOINT", entrypoints.node),
    assignment("MIGRATE_ENTRYPOINT", entrypoints.migrate),
    assignment("OPERATOR_ENTRYPOINT", entrypoints.operator),
    assignment("HEALTH_ENTRYPOINT", entrypoints.health),
    assignment("PSU_ENTRYPOINT", entrypoints.psu),
    assignment("PUI_ENTRYPOINT", entrypoints.pui),
    assignment("PUI_COMPANION_PATH", WORKSPACE_HOST_PUI_COMPANION_PATH),
    assignment(
      "PUI_INSTALL_MANIFEST_PATH",
      WORKSPACE_HOST_PUI_INSTALL_MANIFEST_PATH,
    ),
    assignment("CLAUDE_ENTRYPOINT", entrypoints.claude),
    assignment("CODEX_ENTRYPOINT", entrypoints.codex),
    assignment("OMP_ENTRYPOINT", entrypoints.omp),
    assignment("REMOTE_INITIALIZER_ENTRYPOINT", entrypoints.remoteInitializer),
    assignment(
      "CREDENTIAL_DELIVERY_ENTRYPOINT",
      entrypoints.credentialDelivery,
    ),
    assignment(
      "REMOTE_INITIALIZER_CONDUIT",
      WORKSPACE_HOST_REMOTE_INITIALIZER_CONDUIT,
    ),
    assignment(
      "CREDENTIAL_DELIVERY_CONDUIT",
      WORKSPACE_HOST_CREDENTIAL_DELIVERY_CONDUIT,
    ),
    assignment(
      "PRIVILEGED_CONDUIT_SUDOERS",
      WORKSPACE_HOST_PRIVILEGED_CONDUIT_SUDOERS,
    ),
    ...(connectorEnrollment
      ? [
          assignment("CONNECTOR_ENROLLMENT_CONDUIT", WORKSPACE_HOST_CONNECTOR_ENROLLMENT_CONDUIT),
          assignment("CONNECTOR_ENROLLMENT_PROGRAM", WORKSPACE_HOST_CONNECTOR_ENROLLMENT_PROGRAM),
        ]
      : []),
    "",
    'log() { printf "[workspace-host-bootstrap] %s\\n" "$1"; }',
    // Both record what the status report (below) says about a failure.
    // Every die on an SELinux host carries the boot's AVC denials (WI-10006258): a bootc failure
    // whose real cause is a label otherwise reads as an unexplained refusal, and each unexplained
    // refusal cost a ~45 min clean-room cycle. Silent where SELinux is absent (Ubuntu).
    'selinux_denials() {',
    '  command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled || return 0',
    '  echo "[workspace-host-bootstrap] --- SELinux denials this boot ---"',
    // Kernel ring + audit log only: AVC denials land in one of the two (auditd present or
    // not), and a whole-boot `journalctl -b` scan measured 10.7s on a busy host.
    '  { journalctl -b -k --no-pager -o cat 2>/dev/null; cat /var/log/audit/audit.log 2>/dev/null; } | grep -F "avc:" | grep -F denied | tail -n 10 | cut -c1-400 || echo "(none)"',
    '}',
    'die() { log "ERROR: $1" >&2; BOOTSTRAP_ERROR="$1"; selinux_denials >&2 || true; exit 1; }',
    'phase() { log "phase:$1"; BOOTSTRAP_PHASE="$1"; }',
    // Bounded retry for the few commands that reach the network before anything else has. A fresh
    // boot can lose its first egress attempts (WI-10002837: every archive fetch failed ~110s after
    // boot, the host re-ran the same bootstrap fine minutes later), and a single try turned that
    // blip into a dead host. Logs go to stderr so a caller's `>/dev/null` cannot hide them.
    'retry() { local max="$1" attempt=1; shift; until "$@"; do (( attempt >= max )) && return 1; log "attempt $attempt/$max failed, retrying in $(( attempt * 5 ))s: $*" >&2; sleep $(( attempt * 5 )); attempt=$(( attempt + 1 )); done; }',
    // WI-10002863, measured on avi-test 2026-09-24: ONE `apt-get update` ran ~30 min on a first
    // boot (06:44:59 -> ~07:14:40Z) and apt's own Acquire timeouts never ended it, so `retry` had
    // no failure to retry and the controller's 1200s bootstrap wait expired first. Every networked
    // apt call is therefore wall-clock bounded. The install FETCHES under the bound
    // (`--download-only`, safe to kill) and then unpacks from the local cache unbounded, so the
    // bound can never interrupt dpkg mid-configure and wedge every later attempt.
    ...(hostModel === 'ubuntu-release-bundle' ? APT_BOUNDED_HELPER_LINES : []),
    ...statusReportLines(statusChannel),
    "",
    `phase '${WORKSPACE_HOST_BOOTSTRAP_PHASES[0]}'`,
    '[[ "${EUID}" -eq 0 ]] || die "bootstrap must run as root"',
    ...hostModelValidateLines(validated),
    "",
    `phase '${WORKSPACE_HOST_BOOTSTRAP_PHASES[1]}'`,
    ...harden.head,
    // Native runtime packages are distinct from build tooling. The exported apt contract above
    // is the source of truth for every mapped external SONAME; keep this rendered install line
    // derived from it so publication and a clean Ubuntu host cannot drift. The initially
    // measured defect was libatomic.so.1 (package libatomic1), which is present on boxes with a
    // compiler installed and therefore reproduced on clean guests but not developer machines.
    //
    // The failure it produced was maximally misleading: require-addon catches the dlopen error
    // and CONTINUES (`catch (err) { cause = err; continue }`, require-addon/lib/node.js), then
    // reports "Cannot find addon '.'" with a candidate list. So a missing SHARED LIBRARY is
    // reported as a missing ADDON FILE — while the file is present, correctly sized, correctly
    // owned and readable by the service user. Do not remove these without re-running the readelf
    // union over the bundle's *.node files; --no-install-recommends means nothing pulls them in.
    // …and on the bootc model this install does not happen at all: the same package set is a
    // dnf layer in the image, traced name-by-name in infra/images/bootc/RPM-EQUIVALENCE.md.
    ...(hostModel === 'ubuntu-release-bundle'
      ? [
          `retry 5 apt_install -y --no-install-recommends ${WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES.join(" ")} || die "runtime package install failed after 5 attempts"`,
          // Stock Ubuntu 24.04 restricts unprivileged user namespaces, so the bubblewrap installed
          // above cannot sandbox anything until AppArmor grants it `userns`. The function never
          // fails the bootstrap itself; the `agent-sandbox-userns` probe below decides that.
          ...bwrapUsernsGrantShellLines(
            '# Managed by the papercusp workspace-host bootstrap (WI-10004636).',
          ),
          `${BWRAP_USERNS_GRANT_FUNCTION} ${APPARMOR_PROFILE_DIR} ${APPARMOR_RESTRICT_UNPRIVILEGED_USERNS_SYSCTL} ${BWRAP_BIN}`,
        ]
      : []),
    // A recreated image may allocate different numeric IDs to the same named accounts. `/home`
    // is deliberately durable (WI-10003296), so reconcile only entries carrying the historical
    // home owner/group IDs. Root-owned files stay root-owned, and a root-owned HOME with a
    // mismatched account fails closed instead of recursively handing privileged files to a user.
    'repair_persisted_home_ownership() {',
    '  local user="$1" group="$2" target_home="$3" expected_uid expected_gid current_uid current_gid',
    '  [[ -e "$target_home" || -L "$target_home" ]] || return 0',
    '  [[ -d "$target_home" && ! -L "$target_home" ]] || die "persisted home is not a real directory: $target_home"',
    '  expected_uid="$(id -u "$user")"',
    '  expected_gid="$(getent group "$group" | cut -d: -f3)"',
    '  current_uid="$(stat -c %u "$target_home")"',
    '  current_gid="$(stat -c %g "$target_home")"',
    '  [[ "$expected_uid" =~ ^[0-9]+$ && "$expected_gid" =~ ^[0-9]+$ && "$expected_uid" != "0" && "$expected_gid" != "0" ]] || die "persisted home account identity is invalid: $target_home"',
    '  [[ "$current_uid" != "0" ]] || die "persisted home has unexpected root owner: $target_home"',
    '  [[ "$current_gid" != "0" ]] || die "persisted home has unexpected root group: $target_home"',
    '  if [[ "$current_uid" != "$expected_uid" ]]; then',
    '    chown -R -h --from="$current_uid" "$expected_uid" -- "$target_home"',
    '  fi',
    '  if [[ "$current_gid" != "$expected_gid" ]]; then',
    '    chown -R -h --from=":$current_gid" ":$expected_gid" -- "$target_home"',
    '  fi',
    '}',
    'getent group "$SERVICE_GROUP" >/dev/null || groupadd --system "$SERVICE_GROUP"',
    'id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --gid "$SERVICE_GROUP" --home-dir "$STATE_ROOT" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"',
    'usermod --lock --shell /usr/sbin/nologin "$SERVICE_USER"',
    'getent group "$WORKSPACE_GROUP" >/dev/null || groupadd "$WORKSPACE_GROUP"',
    'id -u "$WORKSPACE_USER" >/dev/null 2>&1 || useradd --gid "$WORKSPACE_GROUP" --home-dir "/home/$WORKSPACE_USER" --create-home --shell /bin/bash "$WORKSPACE_USER"',
    'usermod --lock --gid "$WORKSPACE_GROUP" --groups "" --home "/home/$WORKSPACE_USER" --shell /bin/bash "$WORKSPACE_USER"',
    'repair_persisted_home_ownership "$WORKSPACE_USER" "$WORKSPACE_GROUP" "/home/$WORKSPACE_USER"',
    'if id -nG "$WORKSPACE_USER" | tr " " "\\n" | grep -Fx "$SERVICE_GROUP" >/dev/null; then die "workspace SSH user must not belong to the runtime service group"; fi',
    // The THIRD identity (D-248). It exists so that exactly one account both reads the signed
    // runtime and holds the agent credentials, and that account is NOT the customer's SSH login.
    // `--shell /usr/sbin/nologin` + `usermod --lock` because nothing ever logs in as it: the
    // privileged conduits invoke it via `runuser`, so it needs no password, no shell and no key.
    'getent group "$AGENT_GROUP" >/dev/null || groupadd --system "$AGENT_GROUP"',
    'id -u "$AGENT_USER" >/dev/null 2>&1 || useradd --system --gid "$AGENT_GROUP" --home-dir "$AGENT_HOME" --create-home --shell /usr/sbin/nologin "$AGENT_USER"',
    // Supplementary groups are SET, not merely cleared. ubuntu: none (the runtime grant is the
    // named-user ACL below). bootc: exactly the image's runtime-read group, because that is the
    // agent's only route through the 0750 /opt/papercusp parents; clearing it left every agent
    // CLI unexecutable and made papercusp-host-prepare refuse the next boot (WI-10006173).
    `usermod --lock --gid "$AGENT_GROUP" --groups ${
      hostModel === 'bootc-image' ? `"${WORKSPACE_HOST_BOOTC_RUNTIME_READ_GROUP}"` : '""'
    } --home "$AGENT_HOME" --shell /usr/sbin/nologin "$AGENT_USER"`,
    'repair_persisted_home_ownership "$AGENT_USER" "$AGENT_GROUP" "$AGENT_HOME"',
    // Two memberships, refused for two different reasons. $SERVICE_GROUP would hand the agent
    // runtime $STATE_ROOT — embedded PG and every delivered credential. $WORKSPACE_GROUP would
    // let the SSH account reach the agent's 0700 credential home through the group bits, which
    // is the leak the third identity is for.
    'if id -nG "$AGENT_USER" | tr " " "\\n" | grep -Fx "$SERVICE_GROUP" >/dev/null; then die "agent identity must not belong to the runtime service group"; fi',
    'if id -nG "$AGENT_USER" | tr " " "\\n" | grep -Fx "$WORKSPACE_GROUP" >/dev/null; then die "agent identity must not belong to the workspace SSH group"; fi',
    'if id -nG "$WORKSPACE_USER" | tr " " "\\n" | grep -Fx "$AGENT_GROUP" >/dev/null; then die "workspace SSH user must not belong to the agent group"; fi',
    // Prove the AGENT account (the one that runs the bundled CLIs) can sandbox, rather than that
    // bwrap is merely installed: without a usable user namespace Codex's workspace-write sandbox
    // fails every tool command while the run reports success (WI-10004636, plan D-012).
    `sandbox_probe_err="$(runuser -u "$AGENT_USER" -- ${BWRAP_BIN} ${BWRAP_USERNS_PROBE_ARGS.join(" ")} 2>&1)" || die "agent sandbox cannot create a user namespace as $AGENT_USER: \${sandbox_probe_err:-bwrap exited non-zero}"`,
    'install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$STATE_ROOT" "$STATE_ROOT/embedded-pg"',
    // WI-10005754: on the bootc model the runtime root is immutable image content. D-314 bakes its
    // access as root:papercusp-runtime-read:750 and papercusp-host-prepare.service verifies that
    // metadata on every boot (refusing a named-user ACL), so this script must not write it:
    // `install -d` dies with EROFS on /opt, and the setfacl below would contradict D-314.
    ...(hostModel === 'ubuntu-release-bundle'
      ? [
          'install -d -o root -g "$SERVICE_GROUP" -m 0750 "$RUNTIME_ROOT" "$RUNTIME_ROOT/releases" /etc/papercusp',
        ]
      : [
          'install -d -o root -g "$SERVICE_GROUP" -m 0750 /etc/papercusp',
          '[[ -d "$RUNTIME_ROOT/releases" ]] || die "image-provided runtime root $RUNTIME_ROOT/releases is absent on this bootc deployment"',
        ]),
    // The AGENT identity must TRAVERSE the runtime root, because it is the account that runs the
    // bundled agent CLIs: `bind-credential` delivers Claude/Codex/OMP material into its 0700
    // home, and the agent probes execute `$RUNTIME_ROOT/current/bin/{claude,codex,omp}` as this
    // very user. Shipping the runtime root as 0750 root:$SERVICE_GROUP while the account is
    // created with `--groups ""` made those two facts contradictory, and every agent failed
    // identically with `env: 'claude': Permission denied` (exit 126) six steps into a live
    // canary — read as three independent credential faults, which is what made it expensive
    // (D-246, measured on p046-canary-05).
    //
    // The grant is aimed at $AGENT_USER, NOT $WORKSPACE_USER. D-246 originally pointed it at the
    // SSH account because that account was the agent-running identity, and that violated the
    // D-043 owner ruling ("keep runtime files root-owned/non-readable to the workspace user").
    // Splitting the identity is what lets both hold: the runtime is readable by whoever executes
    // it, and the customer's login is not that identity. The verify phase asserts BOTH halves.
    //
    // A NAMED-USER ACL, not group membership and not a world-readable tree: the checks above
    // assert this account is NOT in $SERVICE_GROUP and the verify phase re-asserts it, because
    // that group also gates $STATE_ROOT (embedded PG, delivered credentials) and /etc/papercusp.
    // Traverse-and-read is the entire grant; root stays sole owner and sole writer, so the
    // immutability the 0750 was reaching for is carried by ownership, not by the read bits.
    ...(hostModel === 'ubuntu-release-bundle'
      ? ['setfacl -m "u:$AGENT_USER:r-x" "$RUNTIME_ROOT" "$RUNTIME_ROOT/releases"']
      : []),
    "install -d -o root -g root -m 0711 /srv/papercusp",
    'install -d -o root -g root -m 0770 "$WORKSPACE_ROOT"',
    'setfacl --remove-all "$WORKSPACE_ROOT"',
    'setfacl --remove-default "$WORKSPACE_ROOT"',
    // All three identities write the scoped workspace root, and the DEFAULT ACL is what makes
    // that survive: a file the agent creates inherits the SSH user's rwx entry (and vice versa),
    // so the customer can edit what the agent wrote over SSH without either side chown-ing.
    'setfacl -m "u:$SERVICE_USER:rwx,u:$WORKSPACE_USER:rwx,u:$AGENT_USER:rwx,m::rwx,o::---" "$WORKSPACE_ROOT"',
    'setfacl -d -m "u:$SERVICE_USER:rwx,u:$WORKSPACE_USER:rwx,u:$AGENT_USER:rwx,m::rwx,o::---" "$WORKSPACE_ROOT"',
    'install -d -o "$WORKSPACE_USER" -g "$WORKSPACE_GROUP" -m 0700 "/home/$WORKSPACE_USER"',
    // 0700 and owned by an account whose group the SSH user is not in. This is the directory
    // `bind-credential` writes Claude/Codex/OMP material into; on the pre-D-248 shape it was the
    // SSH account's own home, so on a BYOC host the customer's login owned and could read the
    // platform's agent credentials (observed on p046-canary-05).
    'install -d -o "$AGENT_USER" -g "$AGENT_GROUP" -m 0700 "$AGENT_HOME"',
    'ln -sfn "$WORKSPACE_ROOT" "/home/$WORKSPACE_USER/workspaces"',
    'chown -h "$WORKSPACE_USER:$WORKSPACE_GROUP" "/home/$WORKSPACE_USER/workspaces"',
    // Authorize the controller BEFORE the sshd hardening below takes effect. The config that
    // follows sets `AuthenticationMethods publickey` and `AllowUsers $WORKSPACE_USER`, and the
    // workspace account is `usermod --lock`ed, so once it is reloaded the ONLY way in is a key
    // in this file. Writing it afterwards would leave a window in which the host is already
    // hardened and not yet reachable; failing to write it at all bricks the host (D-238).
    'install -d -o "$WORKSPACE_USER" -g "$WORKSPACE_GROUP" -m 0700 "/home/$WORKSPACE_USER/.ssh"',
    'printf %s "$WORKSPACE_AUTHORIZED_KEYS_B64" | base64 -d > "/home/$WORKSPACE_USER/.ssh/authorized_keys"',
    // A separate local key lets the unprivileged operator service start a PTY under the existing
    // customer SSH identity. Re-add it on every bootstrap because controller keys are reset above.
    'install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0700 "$(dirname "$HOSTED_PTY_SSH_KEY")"',
    'if [[ ! -f "$HOSTED_PTY_SSH_KEY" ]]; then runuser -u "$SERVICE_USER" -- ssh-keygen -q -t ed25519 -N "" -f "$HOSTED_PTY_SSH_KEY" || die "hosted PTY key generation failed"; fi',
    '[[ ! -L "$HOSTED_PTY_SSH_KEY" && "$(stat -c %U:%G:%a "$HOSTED_PTY_SSH_KEY")" == "$SERVICE_USER:$SERVICE_GROUP:600" ]] || die "hosted PTY private key ownership or mode is unsafe"',
    'HOSTED_PTY_PUB="$(runuser -u "$SERVICE_USER" -- ssh-keygen -y -f "$HOSTED_PTY_SSH_KEY")" || die "hosted PTY public key is invalid"',
    'printf \'restrict,pty,from="127.0.0.1" %s\\n\' "$HOSTED_PTY_PUB" >> "/home/$WORKSPACE_USER/.ssh/authorized_keys"',
    // Pin the local sshd host key. StrictHostKeyChecking in the PTY launcher rejects any drift.
    '[[ -s /etc/ssh/ssh_host_ed25519_key.pub ]] || die "loopback sshd host key is absent"',
    'printf \'127.0.0.1 %s\\n\' "$(awk \'{print $1 " " $2}\' /etc/ssh/ssh_host_ed25519_key.pub)" > "$HOSTED_PTY_KNOWN_HOSTS"',
    'chown "$SERVICE_USER:$SERVICE_GROUP" "$HOSTED_PTY_KNOWN_HOSTS"',
    'chmod 0600 "$HOSTED_PTY_KNOWN_HOSTS"',
    'chown "$WORKSPACE_USER:$WORKSPACE_GROUP" "/home/$WORKSPACE_USER/.ssh/authorized_keys"',
    'chmod 0600 "/home/$WORKSPACE_USER/.ssh/authorized_keys"',
    // Fail loudly here rather than at the next connection: an empty authorized_keys and a
    // correctly-hardened sshd are indistinguishable from a healthy host until someone tries
    // to reach it, which is exactly how this went undetected.
    'test -s "/home/$WORKSPACE_USER/.ssh/authorized_keys" || die "workspace authorized_keys is empty; the host would be unreachable after sshd hardening"',
    // SELinux hosts (bootc): ~/.ssh and authorized_keys were created above by THIS script's
    // domain (the SSM agent's), so they carry whatever that domain's create rules give them,
    // not the policy's ssh_home_t, and sshd_t may be refused reading them (WI-10006258).
    // Relabel to the policy default, logging both labels so a run shows which one sshd saw.
    'if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; then',
    '  log "selinux labels before restorecon: $(stat -L -c "%n=%C" "/home/$WORKSPACE_USER" "/home/$WORKSPACE_USER/.ssh" "/home/$WORKSPACE_USER/.ssh/authorized_keys" 2>&1 | paste -sd " " -)"',
    '  restorecon -RF "/home/$WORKSPACE_USER/.ssh" || die "could not restore the SELinux labels of the workspace .ssh directory"',
    '  log "selinux labels after restorecon: $(stat -L -c "%n=%C" "/home/$WORKSPACE_USER/.ssh" "/home/$WORKSPACE_USER/.ssh/authorized_keys" 2>&1 | paste -sd " " -)"',
    'fi',
    // 05-, not 60-: sshd keeps the FIRST value it reads for each keyword, and CentOS (bootc)
    // ships 50-redhat.conf with `X11Forwarding yes`, so a 60- drop-in silently lost that key
    // (WI-10006176, measured with in-image `sshd -T`). Sorting before every vendor drop-in
    // makes these values win on both bases. The legacy name is removed so an upgraded host
    // does not keep a stale copy.
    "rm -f /etc/ssh/sshd_config.d/60-papercusp-workspace.conf",
    "cat > /etc/ssh/sshd_config.d/05-papercusp-workspace.conf <<PAPERCUSP_SSH",
    "# Managed by Papercusp workspace-host bootstrap.",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "AuthenticationMethods publickey",
    "PermitRootLogin no",
    "PubkeyAuthentication yes",
    "AllowUsers $WORKSPACE_USER",
    "AllowTcpForwarding local",
    "AllowStreamLocalForwarding no",
    "PermitOpen 127.0.0.1:$SERVICE_PORT",
    "GatewayPorts no",
    "X11Forwarding no",
    "PermitTunnel no",
    "PAPERCUSP_SSH",
    // `sshd -t` stats the privilege-separation directory before it will validate anything, and
    // /run/sshd is a systemd RuntimeDirectory that systemd DELETES whenever ssh.service stops.
    // The apt step earlier in this same phase stops it whenever it UPGRADES openssh-server, so
    // whether this line works depends on whether that boot happened to pull an openssh update —
    // which is why it passed on p046-canary-07 and failed on p046-canary-08 six hours later
    // ("3 upgraded", then `Missing privilege separation directory: /run/sshd` and exit 255,
    // aborting bootstrap in phase:harden-os with the workspace already keyed but unhardened).
    // Recreating it makes the config test depend on the CONFIG rather than on the runtime state
    // of a unit this phase just restarted. Idempotent: the unit recreates it on the next start.
    "install -d -m 0755 -o root -g root /run/sshd",
    "sshd -t",
    // reload-or-restart, not reload: after that same upgrade ssh.service can be left STOPPED, and
    // `systemctl reload` of a stopped unit FAILS — which under `set -euo pipefail` would abort
    // here, one line past the trap above, for the same underlying reason.
    "systemctl reload-or-restart ssh 2>/dev/null || systemctl reload-or-restart sshd",
    ...harden.tail,
    "",
    `phase '${WORKSPACE_HOST_BOOTSTRAP_PHASES[2]}'`,
    // The two update paths. ⛔ The bundle arm below is NOT legacy awaiting deletion — it is what
    // every provisioned host runs today, and both models are live through the transition
    // (D-280). It is kept verbatim, in place, with its comments attached to their lines.
    ...(hostModel === 'bootc-image'
      ? bootcReleaseLines(validated, input.action, input.hostId)
      : [
    // These run as root: the SSH account deliberately cannot inspect runtime/state. Emit the
    // census before downloading, and measure the verified tar's allocated footprint before
    // extraction. Compressed length (and gzip's wrapping 32-bit size) cannot size a release.
    'bundle_storage_diagnostics() {',
    '  log "storage:current=$(readlink -f "$RUNTIME_ROOT/current" 2>/dev/null || true)"',
    '  df -PB1 "$RUNTIME_ROOT/releases" /var/tmp >&2 || true',
    '  df -Pi "$RUNTIME_ROOT/releases" >&2 || true',
    '  local path',
    '  for path in "$RUNTIME_ROOT"/releases/* "$RUNTIME_ROOT"/releases/.[!.]* /var/tmp/papercusp-bootstrap.* "$STATE_ROOT" "$WORKSPACE_ROOT" /var/log; do',
    '    [[ -e "$path" ]] || continue',
    '    du -x -s -B1 -- "$path" >&2 || true',
    '  done',
    '}',
    'check_bundle_storage() {',
    '  local block_size archive_storage archive_bytes archive_inodes available_bytes available_inodes required_bytes required_inodes',
    '  block_size="$(stat -f -c %S "$RUNTIME_ROOT/releases")"',
    '  [[ "$block_size" =~ ^[1-9][0-9]*$ ]] || die "cannot measure release filesystem block size"',
    '  archive_storage="$(LC_ALL=C tar --list --gzip --verbose --numeric-owner --quoting-style=escape --file "$BUNDLE_PATH" | awk -v block="$block_size" \'{ bytes += int(($3 + block - 1) / block) * block + block; entries++ } END { printf "%.0f %.0f\\n", bytes, entries }\')" || die "cannot measure verified release archive"',
    '  read -r archive_bytes archive_inodes <<< "$archive_storage"',
    '  available_bytes="$(df -PB1 "$RUNTIME_ROOT/releases" | awk \'NR == 2 { print $4 }\')"',
    '  available_inodes="$(df -Pi "$RUNTIME_ROOT/releases" | awk \'NR == 2 { print $4 }\')"',
    '  for value in "$archive_bytes" "$archive_inodes" "$available_bytes" "$available_inodes"; do',
    '    [[ "$value" =~ ^[0-9]+$ ]] || die "cannot measure release storage capacity"',
    '  done',
    // Leave room for logs/database writes while the old service is still running. Account for
    // block rounding and directory/link metadata above, and an inode reserve independently.
    '  required_bytes=$((archive_bytes + 536870912))',
    '  required_inodes=$((archive_inodes + 1024))',
    '  log "storage:required_bytes=$required_bytes available_bytes=$available_bytes required_inodes=$required_inodes available_inodes=$available_inodes"',
    '  if (( available_bytes < required_bytes || available_inodes < required_inodes )); then',
    '    bundle_storage_diagnostics',
    '    die "insufficient release storage; extraction was not started and current runtime was preserved"',
    '  fi',
    '}',
    // The r7 census found five complete releases consuming 23 GB on a 30 GB root disk.
    // Bound that history before another download. The active tree is the rollback target for
    // this attempt; also retain the newest other complete tree for an existing fallback and
    // any explicitly requested rollback release. Unrecognized directories are never garbage.
    'prune_bundle_releases() {',
    '  local release_root current candidate leaf modified fallback="" newest=-1',
    '  local -a candidates=()',
    '  [[ -e "$RUNTIME_ROOT/current" || -L "$RUNTIME_ROOT/current" ]] || return 0',
    '  release_root="$(readlink -f "$RUNTIME_ROOT/releases")"',
    '  [[ "$release_root" == "$RUNTIME_ROOT/releases" ]] || die "refusing retention through a symlinked release root"',
    '  current="$(readlink -f "$RUNTIME_ROOT/current")" || die "cannot resolve current release for retention"',
    '  [[ "$current" == "$release_root/"* && "${current#"$release_root/"}" != */* && -d "$current" ]] || die "current release is outside the managed release directory"',
    '  for candidate in "$release_root"/*; do',
    '    [[ -d "$candidate" && ! -L "$candidate" ]] || continue',
    '    leaf="${candidate##*/}"',
    '    [[ "$leaf" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || continue',
    '    [[ "$(stat -c %u "$candidate")" == 0 ]] || continue',
    '    [[ -x "$candidate/$INSTALL_ENTRYPOINT" && -x "$candidate/$NODE_ENTRYPOINT" ]] || continue',
    '    mountpoint -q -- "$candidate" && continue',
    '    candidates+=("$candidate")',
    '    [[ "$candidate" != "$current" && "$candidate" != "$RELEASE_DIR" ]] || continue',
    '    modified="$(stat -c %Y "$candidate")"',
    '    [[ "$modified" =~ ^[0-9]+$ ]] || die "cannot measure release age for retention"',
    '    if (( modified > newest )); then newest="$modified"; fallback="$candidate"; fi',
    '  done',
    '  for candidate in "${candidates[@]}"; do',
    '    [[ "$candidate" != "$current" && "$candidate" != "$fallback" && "$candidate" != "$RELEASE_DIR" ]] || continue',
    '    log "storage:pruning-release=$candidate"',
    '    rm -rf --one-file-system -- "$candidate"',
    '  done',
    '}',
    // Hold this through EXIT cleanup and inherit it in curl/tar. A second bootstrap cannot
    // classify an in-flight release as historical, even if its original launcher has exited.
    'exec 9>"$RUNTIME_ROOT/.bootstrap.lock"',
    'flock -n 9 || die "another workspace-host bootstrap is still running"',
    'bundle_storage_diagnostics',
    'RELEASE_DIR="$RUNTIME_ROOT/releases/$RELEASE_VERSION"',
    'prune_bundle_releases',
    'WORK_DIR="$(mktemp -d /var/tmp/papercusp-bootstrap.XXXXXX)"',
    'BUNDLE_PATH="$WORK_DIR/server-bundle.tgz"',
    'SIGNATURE_PATH="$WORK_DIR/server-bundle.tgz.minisig"',
    'PUBLIC_KEY_PATH="$WORK_DIR/bootstrap-public.key"',
    'STAGE_DIR=""',
    'PREVIOUS_TARGET="$(readlink -f "$RUNTIME_ROOT/current" 2>/dev/null || true)"',
    "SWITCHED=0",
    "restore_previous() {",
    '  [[ "$SWITCHED" -eq 1 && -n "$PREVIOUS_TARGET" && -d "$PREVIOUS_TARGET" ]] || return 0',
    '  ln -sfn "$PREVIOUS_TARGET" "$RUNTIME_ROOT/current.next"',
    '  mv -Tf "$RUNTIME_ROOT/current.next" "$RUNTIME_ROOT/current"',
    '  systemctl restart "$SERVICE_NAME.service" || true',
    "}",
    "cleanup() {",
    "  status=$?",
    '  if [[ "$status" -ne 0 ]]; then restore_previous; fi',
    '  [[ -z "$STAGE_DIR" || ! -d "$STAGE_DIR" ]] || rm -rf -- "$STAGE_DIR"',
    '  rm -rf -- "$WORK_DIR"',
    // This trap replaces the one statusReportLines installed, so it must report too.
    '  report_outcome "$status"',
    '  exit "$status"',
    "}",
    "trap cleanup EXIT",
    `curl --fail --silent --show-error --location --retry 3 ${WORKSPACE_HOST_CURL_STALL_GUARD} --proto "=https" --tlsv1.2 "$BUNDLE_URL" --output "$BUNDLE_PATH"`,
    `curl --fail --silent --show-error --location --retry 3 ${WORKSPACE_HOST_CURL_STALL_GUARD} --proto "=https" --tlsv1.2 "$SIGNATURE_URL" --output "$SIGNATURE_PATH"`,
    'printf "%s  %s\\n" "$BUNDLE_SHA256" "$BUNDLE_PATH" | sha256sum --check --strict -',
    'printf "%s" "$SIGNING_PUBLIC_KEY_B64" | base64 --decode > "$PUBLIC_KEY_PATH"',
    'printf "%s  %s\\n" "$SIGNING_KEY_SHA256" "$PUBLIC_KEY_PATH" | sha256sum --check --strict -',
    'minisign -Vm "$BUNDLE_PATH" -x "$SIGNATURE_PATH" -p "$PUBLIC_KEY_PATH" >/dev/null',
    "",
    `phase '${WORKSPACE_HOST_BOOTSTRAP_PHASES[3]}'`,
    'if [[ ! -d "$RELEASE_DIR" ]]; then',
    '  check_bundle_storage',
    '  STAGE_DIR="$(mktemp -d "$RUNTIME_ROOT/releases/.${RELEASE_VERSION}.XXXXXX")"',
    '  tar --extract --gzip --file "$BUNDLE_PATH" --directory "$STAGE_DIR" --no-same-owner --no-same-permissions',
    '  mv -T "$STAGE_DIR" "$RELEASE_DIR"',
    '  STAGE_DIR=""',
    "fi",
    'chown -R "root:$SERVICE_GROUP" "$RELEASE_DIR"',
    'chmod -R g-w,o-rwx "$RELEASE_DIR"',
    'find "$RELEASE_DIR" -type d -exec chmod g+rx {} +',
    'find "$RELEASE_DIR" -type f -exec chmod g+r {} +',
    // Extend the runtime-root grant across the extracted release (D-246, retargeted from the SSH
    // account to the agent identity by D-248). Ordered after the chmod
    // pass deliberately: on a file that carries an ACL, chmod's group bits address the ACL MASK
    // rather than the group entry, so a mask-narrowing chmod landing after this line would clamp
    // the grant away. MEASURED (2026-09-02, /tmp probe over this exact sequence): with the three
    // chmods above as written the mask is `r-x` in EITHER order, because `g-w`, `g+rx` and `g+r`
    // are all additive — so this ordering is not load-bearing TODAY and no live bug depends on
    // it. It is kept because a later edit to an assigning form (`chmod g=r`) would silently clamp
    // execute, and the resulting failure is invisible until an agent CLI refuses to run.
    //
    // `X` (capital) grants execute only on directories and on files that already carry an
    // execute bit, so this reproduces the group grant for one named user without making data
    // files executable. The agent CLIs are thin wrappers that re-exec `$BIN/node` and read
    // `$ROOT/scripts/psu.mjs`, so the grant has to span the tree rather than the three
    // entrypoints; the group already has exactly this access, and root stays the only writer.
    'setfacl -R -m "u:$AGENT_USER:rX" "$RELEASE_DIR"',
        ]),
    // ── Model-invariant from here: whatever delivered the release tree, these are the same
    // observations over the same paths, and a bootc host must satisfy every one of them.
    'for entrypoint in "$INSTALL_ENTRYPOINT" "$ROLLBACK_ENTRYPOINT" "$NODE_ENTRYPOINT" "$MIGRATE_ENTRYPOINT" "$OPERATOR_ENTRYPOINT" "$HEALTH_ENTRYPOINT" "$PSU_ENTRYPOINT" "$PUI_ENTRYPOINT" "$CLAUDE_ENTRYPOINT" "$CODEX_ENTRYPOINT" "$OMP_ENTRYPOINT" "$REMOTE_INITIALIZER_ENTRYPOINT" "$CREDENTIAL_DELIVERY_ENTRYPOINT"; do',
    '  [[ -x "$RELEASE_DIR/$entrypoint" ]] || die "missing executable release entrypoint: $entrypoint"',
    "done",
    '[[ -s "$RELEASE_DIR/$PUI_COMPANION_PATH" ]] || die "missing or empty PUI companion: $PUI_COMPANION_PATH"',
    '[[ -s "$RELEASE_DIR/$PUI_INSTALL_MANIFEST_PATH" ]] || die "missing or empty PUI install manifest: $PUI_INSTALL_MANIFEST_PATH"',
    // Content installed by this entrypoint is runtime state, not immutable
    // release material. Run the whole install contract as the service identity
    // so every persisted prompt/blueprint/template/rubric remains writable on
    // later upgrades without a recursive root-owned chown repair.
    'runuser -u "$SERVICE_USER" -- env HOME="$STATE_ROOT" "$RELEASE_DIR/$INSTALL_ENTRYPOINT" --action "$BOOTSTRAP_ACTION" --release-root "$RELEASE_DIR" --state-root "$STATE_ROOT"',
    'if [[ "$BOOTSTRAP_ACTION" == "rollback" ]]; then',
    ...(hostModel === 'ubuntu-release-bundle'
      ? [
          '  "$RELEASE_DIR/$ROLLBACK_ENTRYPOINT" --from "$PREVIOUS_TARGET" --to "$RELEASE_DIR" --state-root "$STATE_ROOT"',
        ]
      : [
          // ⛔ FAILS CLOSED, deliberately, and this is the safe direction rather than a gap left
          // open. `bootc rollback` has already returned the OS to the previous deployment; the
          // DATABASE has not moved, so the schema is still the newer one while the code is the
          // older one. Skipping this step silently would leave exactly that mismatch behind a
          // successful-looking rollback.
          //
          // `$PREVIOUS_TARGET` is a symlink readback and has no bootc analogue: the previous
          // release tree lives in the other ostree deployment, not at `$RUNTIME_ROOT/releases`,
          // so resolving it needs a deployment-path lookup that cannot be written blind — it has
          // to be exercised on a booted bootc host, which is P-305's leg. P-307 owns the release
          // layer this depends on.
          '  die "bootc-image rollback cannot run the database rollback step yet: the previous release tree is in the other ostree deployment, not at $RUNTIME_ROOT/releases. The OS rolled back; the database did NOT. Resolve the previous deployment path (P-305/P-307) before using rollback on this host model."',
        ]),
    "fi",
    'NODE_VERSION="$("$RELEASE_DIR/$NODE_ENTRYPOINT" --version)"',
    'NODE_MAJOR="${NODE_VERSION#v}"',
    'NODE_MAJOR="${NODE_MAJOR%%.*}"',
    '[[ "$NODE_MAJOR" =~ ^[0-9]+$ && "$NODE_MAJOR" -ge "$MINIMUM_NODE_MAJOR" ]] || die "bundled Node runtime is below the required floor"',
    ...agentRuntimeInstallLines(agentRuntimeInstalls),
    ...localInferenceRuntimeInstallLines(agentRuntimeInstalls, hostModel),
    ...workspaceOmpRuntimeInstallLines(agentRuntimeInstalls),
    ...customerAgentToolchainInstallLines(agentRuntimeInstalls),
    "",
    `phase '${WORKSPACE_HOST_BOOTSTRAP_PHASES[4]}'`,
    '"$RELEASE_DIR/$MIGRATE_ENTRYPOINT" --database-root "$STATE_ROOT/embedded-pg" --migration-id "$MIGRATION_ID"',
    "",
    `phase '${WORKSPACE_HOST_BOOTSTRAP_PHASES[5]}'`,
    // The swap, and the one place the two models differ most sharply.
    //
    // On the bundle model this IS the release swap: rename-over-symlink is atomic, so no reader
    // ever sees a half-switched `current`, and `restore_previous` can put it back.
    //
    // On bootc there is nothing to swap. `current` is image content, fixed when the image was
    // built, and the atomic switch already happened at the reboot. Writing it here would fail on
    // a read-only deployment root — and would be wrong even if it succeeded, because a `current`
    // that a running host can repoint is precisely the mutability an image-based host exists to
    // remove. So the line becomes an ASSERTION that the image is internally consistent.
    ...(hostModel === 'ubuntu-release-bundle'
      ? [
          'ln -sfn "$RELEASE_DIR" "$RUNTIME_ROOT/current.next"',
          'mv -Tf "$RUNTIME_ROOT/current.next" "$RUNTIME_ROOT/current"',
          'SWITCHED=1',
        ]
      : [
          '[[ -L "$RUNTIME_ROOT/current" || -d "$RUNTIME_ROOT/current" ]] || die "$RUNTIME_ROOT/current is absent from the booted image — the release layer (P-307) has not been baked into this image"',
          'CURRENT_TARGET="$(readlink -f "$RUNTIME_ROOT/current")"',
          'RELEASE_TARGET="$(readlink -f "$RELEASE_DIR")"',
          '[[ "$CURRENT_TARGET" == "$RELEASE_TARGET" ]] || die "booted image points $RUNTIME_ROOT/current at $CURRENT_TARGET, but this bootstrap was rendered for release $RELEASE_VERSION at $RELEASE_TARGET"',
        ]),
    // The SSH identity deliberately cannot traverse the immutable runtime or credential root. Two
    // root-owned wrappers are therefore the ONLY privilege seam. Each accepts exactly the fixed
    // protocol argv and sudoers repeats that exact allowlist; variable material remains on stdin.
    //
    // BOTH programs are Node scripts carrying a `#!/usr/bin/env node` shebang, and the sudoers
    // entries below pin `env_reset, !setenv` — so the interpreter is resolved against sudo's
    // `secure_path` (`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin` on
    // stock Ubuntu 24.04), NOT the caller's PATH. The runtime this host is pinned to is the
    // BUNDLED one at `$RUNTIME_ROOT/current/<node>`, which is deliberately not on that list, so
    // dispatching through the shebang made every privileged invocation die with
    // `/usr/bin/env: 'node': No such file or directory` (exit 127) before a single byte of the
    // request was read — measured live on p046-canary-03, 2026-09-02. Naming the bundled
    // interpreter explicitly is also the stronger contract: it keeps the privileged seam pinned to
    // the signed release's own Node rather than to whatever a future image happens to put on
    // `secure_path`, which a PATH symlink would silently hand it.
    'install -o root -g root -m 0755 /dev/null "$REMOTE_INITIALIZER_CONDUIT"',
    "cat > \"$REMOTE_INITIALIZER_CONDUIT\" <<'PAPERCUSP_INITIALIZER_CONDUIT'",
    "#!/bin/sh",
    "set -eu",
    '[ "$#" -eq 3 ] || { echo "initializer conduit: refused argv" >&2; exit 64; }',
    `[ "$1" = ${shellQuote(WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV[0])} ] && [ "$2" = ${shellQuote(WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV[1])} ] && [ "$3" = ${shellQuote(WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV[2])} ] || { echo "initializer conduit: refused argv" >&2; exit 64; }`,
    `exec /usr/bin/sudo -n -- ${shellQuote(`${WORKSPACE_HOST_RUNTIME_ROOT}/current/${entrypoints.node}`)} ${shellQuote(`${WORKSPACE_HOST_RUNTIME_ROOT}/current/${entrypoints.remoteInitializer}`)} "$@"`,
    "PAPERCUSP_INITIALIZER_CONDUIT",
    'install -o root -g root -m 0755 /dev/null "$CREDENTIAL_DELIVERY_CONDUIT"',
    "cat > \"$CREDENTIAL_DELIVERY_CONDUIT\" <<'PAPERCUSP_DELIVERY_CONDUIT'",
    "#!/bin/sh",
    "set -eu",
    '[ "$#" -eq 3 ] || { echo "credential delivery conduit: refused argv" >&2; exit 64; }',
    `[ "$1" = ${shellQuote(WORKSPACE_HOST_CREDENTIAL_DELIVERY_ARGV[0])} ] && [ "$2" = ${shellQuote(WORKSPACE_HOST_CREDENTIAL_DELIVERY_ARGV[1])} ] && [ "$3" = ${shellQuote(WORKSPACE_HOST_CREDENTIAL_DELIVERY_ARGV[2])} ] || { echo "credential delivery conduit: refused argv" >&2; exit 64; }`,
    `exec /usr/bin/sudo -n -- ${shellQuote(`${WORKSPACE_HOST_RUNTIME_ROOT}/current/${entrypoints.node}`)} ${shellQuote(`${WORKSPACE_HOST_RUNTIME_ROOT}/current/${entrypoints.credentialDelivery}`)} "$@"`,
    "PAPERCUSP_DELIVERY_CONDUIT",
    ...(connectorEnrollment?.install ?? []),
    'chown root:root "$REMOTE_INITIALIZER_CONDUIT" "$CREDENTIAL_DELIVERY_CONDUIT"',
    'chmod 0755 "$REMOTE_INITIALIZER_CONDUIT" "$CREDENTIAL_DELIVERY_CONDUIT"',
    'cat > "$PRIVILEGED_CONDUIT_SUDOERS" <<PAPERCUSP_CONDUIT_SUDOERS',
    // The allowlist must repeat the conduit's argv EXACTLY, interpreter included: sudo matches the
    // whole command vector, so pinning only the script would refuse the very invocation above.
    `Cmnd_Alias PAPERCUSP_WORKSPACE_HOST_INITIALIZER = ${WORKSPACE_HOST_RUNTIME_ROOT}/current/${entrypoints.node} ${WORKSPACE_HOST_RUNTIME_ROOT}/current/${entrypoints.remoteInitializer} ${WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV.join(" ")}`,
    `Cmnd_Alias PAPERCUSP_WORKSPACE_HOST_DELIVERY = ${WORKSPACE_HOST_RUNTIME_ROOT}/current/${entrypoints.node} ${WORKSPACE_HOST_RUNTIME_ROOT}/current/${entrypoints.credentialDelivery} ${WORKSPACE_HOST_CREDENTIAL_DELIVERY_ARGV.join(" ")}`,
    "Defaults!PAPERCUSP_WORKSPACE_HOST_INITIALIZER env_reset, !setenv",
    "Defaults!PAPERCUSP_WORKSPACE_HOST_DELIVERY env_reset, !setenv",
    ...(connectorEnrollment?.sudoersAliases ?? []),
    `$WORKSPACE_USER ALL=(root) NOPASSWD: PAPERCUSP_WORKSPACE_HOST_INITIALIZER, PAPERCUSP_WORKSPACE_HOST_DELIVERY${connectorEnrollment?.sudoersGrant ?? ""}`,
    "PAPERCUSP_CONDUIT_SUDOERS",
    'chown root:root "$PRIVILEGED_CONDUIT_SUDOERS"',
    'chmod 0440 "$PRIVILEGED_CONDUIT_SUDOERS"',
    'visudo -cf "$PRIVILEGED_CONDUIT_SUDOERS" >/dev/null',
    // WI-10006110: the unit used to declare no start budget, so systemd's generic 90s
    // DefaultTimeoutStartSec bounded a FIRST boot (embedded-PG initdb, migrations, content
    // install) that ExecStartPost's health poll must see finish. Every AWS bootc clean room
    // died there ("start-post operation timed out", 6.35s CPU in 90s: waiting, not computing).
    // TEMPORARY MITIGATION until the start sampler below names what the wait is; durable fix
    // = remove that wait, tracked on WI-10006110. The budget is explicit so a slow start is
    // a measured number in the bootstrap log, never systemd's silent default.
    "SERVICE_START_TIMEOUT_SEC=600",
    // ExecStartPost's papercusp-health has its OWN budget (PAPERCUSP_HEALTH_TIMEOUT_SEC,
    // default 120s, max 600). chain8 measured it giving up at 120s, long before the 600s
    // TimeoutStartSec, so the start budget above never applied. Derive it from the start budget,
    // 30s short, so the probe reports its own error before systemd kills it.
    "SERVICE_HEALTH_TIMEOUT_SEC=$((SERVICE_START_TIMEOUT_SEC - 30))",
    'cat > "/etc/systemd/system/$SERVICE_NAME.service" <<PAPERCUSP_SERVICE',
    "[Unit]",
    "Description=Papercusp durable workspace host",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "TimeoutStartSec=$SERVICE_START_TIMEOUT_SEC",
    "Environment=PAPERCUSP_HEALTH_TIMEOUT_SEC=$SERVICE_HEALTH_TIMEOUT_SEC",
    "User=$SERVICE_USER",
    "Group=$SERVICE_GROUP",
    "WorkingDirectory=$STATE_ROOT",
    "Environment=PAPERCUSP_BIND_HOST=127.0.0.1",
    "Environment=PAPERCUSP_PORT=$SERVICE_PORT",
    // A host runs no resilient MCP proxy, so the operator's own loopback port IS the
    // stable endpoint for long-lived sessions. Unset, resolveLongLivedSessionMcpBaseUrl
    // falls back to the dev box's :9071 proxy and every hosted New Session boots
    // against a dead address before discovery rescues it (WI-10003189, r51).
    "Environment=PAPERCUSP_MCP_PROXY_BASE=http://127.0.0.1:$SERVICE_PORT",
    "Environment=PAPERCUSP_EMBEDDED_PG_ROOT=$STATE_ROOT/embedded-pg",
    "Environment=PAPERCUSP_WORKSPACE_ROOT=$WORKSPACE_ROOT",
    "Environment=PUI_COMPANION_WASM=$RUNTIME_ROOT/current/$PUI_COMPANION_PATH",
    "Environment=PUI_INSTALL_MANIFEST=$RUNTIME_ROOT/current/$PUI_INSTALL_MANIFEST_PATH",
    // P-309 CONTENT ROOTS — installed from the existing Cupboard bundle into
    // persistent machine-local state before the service starts. Static UI/docs
    // remain release-pinned; prompts/blueprints/templates/rubrics do not ship in
    // the vm-release payload and survive an offline service restart here.
    //
    // WorkingDirectory remains the STATE root (the only writable place the
    // service owns), so every filesystem content resolver is pinned explicitly:
    // no cwd probe and no immutable-release fallback can silently reintroduce
    // bundled content after the vm-release directories are removed.
    //
    // PAPERCUSP_PROMPT_ROOT is the HARNESS-shaped prompt root (`<root>/blueprints/<id>/
    // prompts/<role>.md`) that resolvePromptFiles reads through promptHarnessRoot().
    // Without it the su persona lookup falls to harnessRoot() — the immutable release,
    // which no longer carries blueprints — finds no su.md, falls back to the legacy
    // apps/operator/prompts playbook no host ships, and every New Session dies at
    // boot with `renderSuPlaybook: base playbook ... not found` (WI-10003189, r51).
    "Environment=PAPERCUSP_HOME=$STATE_ROOT/.papercusp",
    "Environment=PAPERCUSP_PROMPT_ROOT=$STATE_ROOT/.papercusp",
    "Environment=PAPERCUSP_PROMPTS_DIR=$STATE_ROOT/.papercusp/blueprints/base/prompts",
    "Environment=PAPERCUSP_SPA_DIST=$RUNTIME_ROOT/current/spa",
    "Environment=PAPERCUSP_DOCS_ROOT=$RUNTIME_ROOT/current/internal-docs",
    // WI-10004899: the cut packs precomputed doc_sections vectors into the bundle, so a fresh
    // host applies them instead of embedding ~15k sections on its own CPU (WI-10004455). A
    // bundle cut before the seed existed has no such dir; applyShippedDocVectorSeed fails open.
    "Environment=PAPERCUSP_DOC_VECTOR_SEED_DIR=$RUNTIME_ROOT/current/doc-vector-seed",
    "Environment=PAPERCUSP_TEMPLATES_DIR=$STATE_ROOT/.papercusp/templates",
    "Environment=PAPERCUSP_RUBRICS_DIR=$STATE_ROOT/.papercusp/rubrics",
    // D-403: the connector bearer, once enrolled. Optional (`-`), so the unit starts unchanged
    // before enrollment; read by PID 1, so the file stays root-only.
    ...(connectorEnrollment ? [`EnvironmentFile=-${WORKSPACE_HOST_CONNECTOR_ENVIRONMENT_FILE}`] : []),
    "ExecStart=$RUNTIME_ROOT/current/$OPERATOR_ENTRYPOINT",
    "ExecStartPost=$RUNTIME_ROOT/current/$HEALTH_ENTRYPOINT --host 127.0.0.1 --port $SERVICE_PORT",
    "Restart=on-failure",
    "RestartSec=5s",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectHome=true",
    "ProtectSystem=strict",
    "ReadOnlyPaths=$RUNTIME_ROOT",
    "ReadWritePaths=$STATE_ROOT $WORKSPACE_ROOT",
    "RestrictSUIDSGID=true",
    "LockPersonality=true",
    "UMask=0027",
    "StandardOutput=journal",
    "StandardError=journal",
    "SyslogIdentifier=papercusp-workspace",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "PAPERCUSP_SERVICE",
    "systemctl daemon-reload",
    // A failed unit start otherwise dies with systemd's generic "Job for ... failed because
    // the control process exited with error code", which names the JOB and not the cause —
    // and the clean-room VM tears itself down before anyone can read its journal. Emit the
    // status and journal INTO the bootstrap's own output so the cause travels with the
    // failure instead of dying with the instance.
    "service_diagnostics() {",
    '  echo "[workspace-host-bootstrap] --- systemctl status $SERVICE_NAME.service ---" >&2',
    '  systemctl status "$SERVICE_NAME.service" --no-pager --full 2>&1 | tail -40 >&2 || true',
    // -o cat, and deliberately NOT -x: systemd's catalog prose ("Subject:/Defined-By:/Support:"
    // blocks) is ~8 lines of boilerplate per event and crowded the SERVICE's own stderr out of
    // the captured window entirely on the first run that had diagnostics at all. What is wanted
    // here is the process's output explaining why ExecStart exited, not systemd's explanation
    // of what a unit is.
    '  echo "[workspace-host-bootstrap] --- journalctl -u $SERVICE_NAME.service (service output) ---" >&2',
    '  journalctl -u "$SERVICE_NAME.service" --no-pager --no-hostname -o cat -n 200 2>&1 | tail -200 >&2 || true',
    // Native-addon inventory. The server loads prebuilt .node addons out of the extracted
    // release tree, and a failure to load one reports only the CANDIDATE PATHS it searched —
    // never whether the file is absent, unreadable, or present-but-rejected. Those three have
    // completely different causes and the error cannot distinguish them, so the question has
    // to be answered from the guest's own filesystem before the instance is destroyed.
    //
    // Measured (P-046, 2026-08-29): a boot failed with "Cannot find addon '.'" whose FIRST
    // candidate was a path that demonstrably exists in the signed bundle, dlopens under the
    // bundled Node, survives the bootstrap's exact chown/chmod treatment, and loads correctly
    // under a faithful local replica of this very unit's sandbox. Every hypothesis that could
    // be tested off-guest was eliminated; only the guest's extracted tree was left, and no
    // instrumentation existed to look at it.
    '  echo "[workspace-host-bootstrap] --- native addon inventory under $RELEASE_DIR ---" >&2',
    '  echo "extracted .node count: $(find "$RELEASE_DIR" -name "*.node" -type f 2>/dev/null | wc -l)" >&2',
    '  find "$RELEASE_DIR" -name "*.node" -type f -printf "%10s %M %u:%g %p\\n" 2>/dev/null | head -40 >&2 || true',
    '  echo "release tree entries: $(find "$RELEASE_DIR" 2>/dev/null | wc -l)" >&2',
    '  df -Pk "$RELEASE_DIR" 2>&1 | tail -2 >&2 || true',
    // The inventory above answers "is the file THERE" and cannot answer "does it LOAD" — two
    // questions with different causes and different fixes that require-addon collapses into
    // one indistinguishable "Cannot find addon" string. So attempt the load and print the
    // error it swallows into `cause`. Two properties of this probe are load-bearing:
    //   * it runs AS THE SERVICE USER, because the inventory runs as root and is therefore
    //     structurally blind to any permission the service user lacks; and
    //   * it reports unresolved SHARED LIBRARIES, because a missing one (libatomic.so.1 —
    //     see the apt install above) is reported by require-addon as a missing ADDON FILE.
    // A `find` whose stderr is discarded cannot distinguish "no matches" from "could not
    // traverse", so a zero count is explicitly marked as possibly-understated rather than
    // being allowed to read as a confident absence.
    '  ADDON_FIND_ERR="$(find "$RELEASE_DIR" -name "*.node" -type f 2>&1 >/dev/null)"',
    '  [[ -z "$ADDON_FIND_ERR" ]] || echo "WARNING: find reported errors; the .node count above may be UNDERSTATED: $ADDON_FIND_ERR" >&2',
    '  echo "[workspace-host-bootstrap] --- addon load probe (as $SERVICE_USER) ---" >&2',
    '  ADDON_PATH="$(find "$RELEASE_DIR" -name "rocksdb-native.node" -type f 2>/dev/null | head -1)"',
    '  NODE_BIN="$(find "$RELEASE_DIR" -type f -name node -perm -u+x 2>/dev/null | head -1)"',
    '  echo "addon: ${ADDON_PATH:-<not found>}" >&2',
    '  echo "node:  ${NODE_BIN:-<not found>}" >&2',
    '  if [[ -n "$ADDON_PATH" ]]; then',
    '    echo "--- unresolved shared libraries (a dlopen failure is reported as a MISSING ADDON) ---" >&2',
    '    ldd "$ADDON_PATH" 2>&1 | grep -i "not found" >&2 || echo "(ldd reports no missing libraries)" >&2',
    "  fi",
    '  if [[ -n "$ADDON_PATH" && -n "$NODE_BIN" ]]; then',
    `    runuser -u "$SERVICE_USER" -- "$NODE_BIN" -e 'try{require(process.argv[1]);console.error("ADDON LOADED OK")}catch(e){console.error("ADDON LOAD FAILED:",e&&e.message);if(e&&e.cause)console.error("CAUSE:",String(e.cause))}' "$ADDON_PATH" 2>&1 | head -20 >&2 || true`,
    "  fi",
    "}",
    // `enable --now` is not a restart. On repair/upgrade the previous release's unit can already
    // be active (or inside its restart loop), in which case `enable --now` returns successfully
    // without ever execing the release just installed at `current`. The r7 P-018 repair proved the
    // consequence live: r25 reached configure-service, health checked the still-running r24
    // process, and the failure trap rolled the symlink back. Enable persistence separately, then
    // unconditionally restart so first install and every release switch share one execution gate.
    'systemctl enable "$SERVICE_NAME.service" || { service_diagnostics; die "workspace service failed to enable"; }',
    // WI-10004242: GCE re-runs this whole bootstrap as the startup-script on EVERY boot. The unit
    // is enabled, so systemd has already started it by the time this line runs, and customers can
    // already have opened desktops and sessions on it. Restarting it ~3 minutes after boot killed
    // all of them (the desktop units are BindsTo= this service). So the restart is skipped only
    // when this boot re-runs a bootstrap that already COMPLETED on an earlier boot: the same
    // rendered script, `current` unchanged by this run, and the unit active. A release switch,
    // a changed rendering, or a second run within one boot still restarts (P-018 r7 above).
    `BOOTSTRAP_FINGERPRINT=${WORKSPACE_HOST_BOOTSTRAP_FINGERPRINT_PLACEHOLDER}`,
    'BOOTSTRAP_COMPLETE_MARKER="$BOOTSTRAP_STATE_DIR/complete"',
    'BOOT_ID="$(cat /proc/sys/kernel/random/boot_id)"',
    'service_restart_needed() {',
    '  local marker_fingerprint="" marker_boot_id=""',
    '  [[ -s "$BOOTSTRAP_COMPLETE_MARKER" ]] || return 0',
    '  read -r marker_fingerprint marker_boot_id < "$BOOTSTRAP_COMPLETE_MARKER" || return 0',
    '  [[ "$marker_fingerprint" == "$BOOTSTRAP_FINGERPRINT" ]] || return 0',
    '  [[ -n "$marker_boot_id" && "$marker_boot_id" != "$BOOT_ID" ]] || return 0',
    '  [[ -n "$PREVIOUS_TARGET" && "$PREVIOUS_TARGET" == "$(readlink -f "$RUNTIME_ROOT/current")" ]] || return 0',
    '  [[ "$(systemctl is-active "$SERVICE_NAME.service" 2>/dev/null)" == "active" ]] || return 0',
    '  return 1',
    '}',
    // WI-10006110: service_diagnostics runs AFTER the start has failed, when systemd has
    // already killed the server and scheduled its auto-restart — so it can say THAT the
    // start timed out but never WHAT the server was waiting on. The sampler records the
    // service's processes (state + wait channel), disk-read counters, listeners and
    // pending outbound connects every 10s WHILE systemctl restart blocks, so a failed
    // start carries its own in-flight evidence off the instance before teardown.
    'START_SAMPLE_LOG=""',
    'START_SAMPLER_PID=""',
    'start_sampler() {',
    '  START_SAMPLE_LOG="$(mktemp /run/papercusp-start-samples.XXXXXX 2>/dev/null || mktemp)"',
    '  ( t0=$SECONDS; while true; do',
    '      { echo "=== start sample t+$((SECONDS - t0))s";',
    '        echo "cpustat $(head -1 /proc/stat)";',
    '        grep -E " (nvme[0-9]+n[0-9]+|xvd[a-z]+|sd[a-z]+) " /proc/diskstats | sed "s/^ */diskstats /";',
    '        ps -e -o pid=,stat=,wchan:22=,etimes=,time=,rss=,args= | grep -E "node|postgres|initdb|papercusp" | grep -v grep | cut -c1-180 | head -n 12;',
    '        ss -ltn | tail -n +2 | sed "s/^/listen /" | head -n 8;',
    '        ss -tn state syn-sent | tail -n +2 | sed "s/^/syn-sent /" | head -n 5;',
    '      } >> "$START_SAMPLE_LOG" 2>&1 || true',
    '      sleep 10',
    // Detached from the bootstrap's stdio: a killed sampler's orphaned `sleep` would
    // otherwise hold the SSM command's output pipe open for up to 10s.
    '    done ) >/dev/null 2>&1 &',
    '  START_SAMPLER_PID=$!',
    '}',
    'stop_sampler() {',
    '  if [[ -n "$START_SAMPLER_PID" ]]; then kill "$START_SAMPLER_PID" 2>/dev/null || true; fi',
    '  START_SAMPLER_PID=""',
    '}',
    'start_diagnostics() {',
    '  if [[ -n "$START_SAMPLE_LOG" && -s "$START_SAMPLE_LOG" ]]; then',
    '    echo "[workspace-host-bootstrap] --- start samples: first, then last (every 10s during systemctl restart) ---" >&2',
    '    head -n 25 "$START_SAMPLE_LOG" >&2 || true',
    '    echo "..." >&2',
    '    tail -n 60 "$START_SAMPLE_LOG" >&2 || true',
    '  fi',
    '  echo "[workspace-host-bootstrap] --- recent logs under $STATE_ROOT ---" >&2',
    '  find "$STATE_ROOT" -xdev -type f \\( -name "*.log" -o -name "logfile" -o -name "postmaster.log" \\) -mmin -20 2>/dev/null | head -n 6 | while read -r f; do echo "## $f" >&2; tail -n 15 "$f" 2>&1 | cut -c1-240 >&2; done || true',
    '  selinux_denials >&2 || true',
    '}',
    'if service_restart_needed; then',
    '  start_sampler',
    '  SERVICE_START_T0=$SECONDS',
    '  if systemctl restart "$SERVICE_NAME.service"; then',
    '    stop_sampler',
    '    log "service:started in $((SECONDS - SERVICE_START_T0))s (TimeoutStartSec=$SERVICE_START_TIMEOUT_SEC)"',
    '  else',
    '    stop_sampler',
    '    service_diagnostics',
    '    start_diagnostics',
    '    die "workspace service failed to start"',
    '  fi',
    'else',
    '  log "service:unchanged — this boot re-runs the bootstrap that completed on an earlier boot; $SERVICE_NAME.service keeps running"',
    'fi',
    "",
    `phase '${WORKSPACE_HOST_BOOTSTRAP_PHASES[6]}'`,
    'systemctl is-active --quiet "$SERVICE_NAME.service" || { service_diagnostics; die "workspace service is not active after start"; }',
    '"$RUNTIME_ROOT/current/$HEALTH_ENTRYPOINT" --host 127.0.0.1 --port "$SERVICE_PORT"',
    'PUI_OPERATOR="http://127.0.0.1:$SERVICE_PORT" PUI_COMPANION_WASM="$RUNTIME_ROOT/current/$PUI_COMPANION_PATH" PUI_INSTALL_MANIFEST="$RUNTIME_ROOT/current/$PUI_INSTALL_MANIFEST_PATH" "$RUNTIME_ROOT/current/$PUI_ENTRYPOINT" doctor',
    '[[ "$(systemctl show "$SERVICE_NAME.service" --property User --value)" == "$SERVICE_USER" ]] || die "workspace service is not running under the dedicated service user"',
    '[[ "$(systemctl show "$SERVICE_NAME.service" --property Group --value)" == "$SERVICE_GROUP" ]] || die "workspace service is not running under the dedicated service group"',
    '[[ "$(stat -c %U "$RUNTIME_ROOT")" == "root" ]] || die "runtime root must be owned by root"',
    ...(hostModel === 'ubuntu-release-bundle'
      ? [
          '[[ -z "$(find "$RUNTIME_ROOT/releases" -xdev \\( -type f -o -type d \\) -perm -0004 -print -quit)" ]] || die "runtime release tree must not be world-readable"',
        ]
      : [
          // WI-10006110 / chain10: the bootc image (workspace-host.Containerfile, D-314) keeps
          // EXECUTABLE files a+rx on purpose, because embedded-postgres checks all 0555 bits, and
          // carries confidentiality on the 0750 root:papercusp-runtime-read parents instead. The
          // ubuntu predicate above can never pass on that tree: measured on image A r62b, all 163
          // world-readable entries were executables, with 0 world-readable directories and 0
          // world-readable non-executable files. So assert the bootc contract: the three parents
          // admit no other-class access, and nothing else under them is world-readable.
          '[[ "$(stat -c %a "$RUNTIME_ROOT" "$RUNTIME_ROOT/releases" "$(readlink -f "$RUNTIME_ROOT/current")" | sort -u)" == "750" ]] || die "runtime release tree must not be world-readable"',
          '[[ -z "$(find "$RUNTIME_ROOT/releases" -xdev \\( -type d -o \\( -type f ! -perm /111 \\) \\) -perm -0004 -print -quit)" ]] || die "runtime release tree must not be world-readable"',
        ]),
    // The two halves of D-248, asserted together because either one alone is satisfiable by the
    // broken shape. D-043 (owner ruling) requires the SSH account to be locked out of the runtime
    // tree; D-246 measured that the account running the agents must read it. Both are true, and
    // the resolution is that they are not the same account.
    //
    // HALF ONE — the SSH account still cannot read the runtime. This is the assertion D-246
    // deleted and D-248 restores verbatim in intent: it is the mechanical enforcement of D-043's
    // "keep runtime files root-owned/non-readable to the workspace user". Deleting it is how a
    // widened grant ships unnoticed, so it is the first line here rather than the last.
    'runuser -u "$WORKSPACE_USER" -- test ! -r "$RUNTIME_ROOT/current/$OPERATOR_ENTRYPOINT" || die "workspace SSH user can read the Papercusp runtime"',
    'for agent_entrypoint in "$CLAUDE_ENTRYPOINT" "$CODEX_ENTRYPOINT" "$OMP_ENTRYPOINT"; do',
    '  runuser -u "$WORKSPACE_USER" -- test ! -x "$RUNTIME_ROOT/current/$agent_entrypoint" || die "workspace SSH user can execute agent entrypoint: $agent_entrypoint"',
    "done",
    // HALF TWO — the agent identity CAN execute every agent CLI it holds credentials for. This is
    // the property whose absence cost six steps of a live canary and read as three independent
    // credential faults; it passed as `not readable` on every prior host precisely because the
    // agents were unrunnable, which is why it is asserted positively here.
    'for agent_entrypoint in "$CLAUDE_ENTRYPOINT" "$CODEX_ENTRYPOINT" "$OMP_ENTRYPOINT"; do',
    '  runuser -u "$AGENT_USER" -- test -x "$RUNTIME_ROOT/current/$agent_entrypoint" || die "agent identity cannot execute agent entrypoint: $agent_entrypoint"',
    "done",
    'runuser -u "$WORKSPACE_USER" -- test ! -r "$STATE_ROOT" || die "workspace SSH user can read the runtime state root"',
    'runuser -u "$WORKSPACE_USER" -- test ! -w "$RUNTIME_ROOT/current" || die "workspace SSH user can write the Papercusp runtime"',
    'runuser -u "$WORKSPACE_USER" -- test -w "$WORKSPACE_ROOT" || die "workspace SSH user cannot write the scoped workspace root"',
    // The credential home is the reason the third identity is worth its cost. On a BYOC host the
    // SSH account is the CUSTOMER's access path; before D-248 it owned the delivered Claude/Codex
    // material at 0600 in its own home. Assert the negative directly rather than inferring it
    // from the 0700 mode, because a later group change would defeat the mode silently.
    'runuser -u "$WORKSPACE_USER" -- test ! -r "$AGENT_HOME" || die "workspace SSH user can read the agent credential home"',
    // D-421/P-325: customer-supplied agent credentials are delivered into the customer's OWN home,
    // because that account runs every customer-driven agent. The mirror of the assertion above:
    // the customer can use its home, and neither the operator service account (whose state a
    // compromised agent must not reach, D-417) nor the platform agent identity can traverse it.
    'runuser -u "$WORKSPACE_USER" -- test -w "/home/$WORKSPACE_USER" || die "workspace SSH user cannot write its own home, where its agent credentials are delivered"',
    'runuser -u "$SERVICE_USER" -- test ! -x "/home/$WORKSPACE_USER" || die "operator service account can traverse the customer home that holds its agent credentials"',
    'runuser -u "$AGENT_USER" -- test ! -x "/home/$WORKSPACE_USER" || die "platform agent identity can traverse the customer home that holds its agent credentials"',
    // The agent identity is confined in every direction the SSH account is: it reads the signed
    // runtime and writes the workspace, and nothing else. Runtime WRITE is the property the old
    // read assertion was actually standing in for, and it is asserted for both accounts.
    'runuser -u "$AGENT_USER" -- test ! -r "$STATE_ROOT" || die "agent identity can read the runtime state root"',
    'runuser -u "$AGENT_USER" -- test ! -w "$RUNTIME_ROOT/current" || die "agent identity can write the Papercusp runtime"',
    'runuser -u "$AGENT_USER" -- test -w "$WORKSPACE_ROOT" || die "agent identity cannot write the scoped workspace root"',
    'runuser -u "$SERVICE_USER" -- test -w "$WORKSPACE_ROOT" || die "runtime service cannot write the scoped workspace root"',
    'if id -nG "$WORKSPACE_USER" | tr " " "\\n" | grep -Fx "$SERVICE_GROUP" >/dev/null; then die "workspace SSH user belongs to the runtime service group"; fi',
    'if id -nG "$WORKSPACE_USER" | tr " " "\\n" | grep -Fx "$AGENT_GROUP" >/dev/null; then die "workspace SSH user belongs to the agent group"; fi',
    'if id -nG "$WORKSPACE_USER" | tr " " "\\n" | grep -Fx sudo >/dev/null; then die "workspace SSH user belongs to sudo"; fi',
    'if id -nG "$AGENT_USER" | tr " " "\\n" | grep -Fx "$SERVICE_GROUP" >/dev/null; then die "agent identity belongs to the runtime service group"; fi',
    'if id -nG "$AGENT_USER" | tr " " "\\n" | grep -Fx "$WORKSPACE_GROUP" >/dev/null; then die "agent identity belongs to the workspace SSH group"; fi',
    'if id -nG "$AGENT_USER" | tr " " "\\n" | grep -Fx sudo >/dev/null; then die "agent identity belongs to sudo"; fi',
    // Non-login, and asserted rather than assumed: `useradd --shell` is a creation-time argument,
    // so on an UPGRADE over a host whose account predates this contract the shell is whatever it
    // already was. The `usermod` above re-applies it; this proves the re-application landed.
    '[[ "$(getent passwd "$AGENT_USER" | cut -d: -f7)" == /usr/sbin/nologin ]] || die "agent identity has a login shell"',
    '[[ "$(stat -c %U:%G:%a "$REMOTE_INITIALIZER_CONDUIT")" == root:root:755 ]] || die "initializer conduit ownership or mode is unsafe"',
    '[[ "$(stat -c %U:%G:%a "$CREDENTIAL_DELIVERY_CONDUIT")" == root:root:755 ]] || die "credential delivery conduit ownership or mode is unsafe"',
    '[[ "$(stat -c %U:%G:%a "$PRIVILEGED_CONDUIT_SUDOERS")" == root:root:440 ]] || die "conduit sudoers ownership or mode is unsafe"',
    'visudo -cf "$PRIVILEGED_CONDUIT_SUDOERS" >/dev/null || die "conduit sudoers policy is invalid"',
    // Ownership, mode and sudoers syntax were ALL green on a host whose conduits could not run a
    // single request: every privileged invocation died 127 resolving its interpreter. Those three
    // checks describe the wrapper's FILE, and the thing that broke was its EXECUTION, so no
    // strengthening of them could have caught it. Assert instead that each command vector the
    // sudoers allowlist pins is actually executable — the interpreter first, since that is the
    // element `secure_path` decides and the one that was missing.
    'CONDUIT_NODE="$RUNTIME_ROOT/current/$NODE_ENTRYPOINT"',
    '[[ -x "$CONDUIT_NODE" ]] || die "conduit interpreter is missing or not executable: $CONDUIT_NODE"',
    '[[ -x "$RUNTIME_ROOT/current/$REMOTE_INITIALIZER_ENTRYPOINT" ]] || die "conduit initializer target is missing or not executable"',
    '[[ -x "$RUNTIME_ROOT/current/$CREDENTIAL_DELIVERY_ENTRYPOINT" ]] || die "conduit delivery target is missing or not executable"',
    'grep -Fq "$CONDUIT_NODE" "$REMOTE_INITIALIZER_CONDUIT" || die "initializer conduit does not pin the bundled interpreter"',
    'grep -Fq "$CONDUIT_NODE" "$CREDENTIAL_DELIVERY_CONDUIT" || die "credential delivery conduit does not pin the bundled interpreter"',
    'SSHD_POLICY="$(sshd -T -C user="$WORKSPACE_USER",host=localhost,addr=127.0.0.1)"',
    'grep -Fx "allowtcpforwarding local" <<<"$SSHD_POLICY" >/dev/null || die "SSH TCP forwarding must be local-only"',
    'grep -Fx "x11forwarding no" <<<"$SSHD_POLICY" >/dev/null || die "SSH X11 forwarding must be off; a vendor sshd drop-in is overriding the workspace policy"',
    'grep -Fx "permitopen 127.0.0.1:$SERVICE_PORT" <<<"$SSHD_POLICY" >/dev/null || die "SSH forwarding must be restricted to the loopback operator"',
    // EI-22185970114422986 — the reachability property, observed WHERE `healthy` IS CLAIMED.
    //
    // `harden-os` already refuses to render a brick (`test -s … || die`), and that guard stays.
    // But it fires five phases earlier, so it cannot speak for the state of the host at the
    // moment the attestation is written, and it contributes nothing TO that attestation: the
    // document asserting the host is fine was silent on the one property whose absence made the
    // original host unrecoverable. These lines observe it here, and `workspace-ssh-authorized-keys`
    // is what carries the result.
    //
    // What this deliberately does NOT claim: that anyone connected. The host holds no private
    // key, so it cannot prove reachability end to end — only that the file it wrote is present,
    // non-empty and safely owned, and that sshd is configured to accept a key from it. End-to-end
    // reachability is proven by the CONTROLLER's own connection, never by the host's self-report.
    // Naming the check after what it observes instead of after what we wish it meant is the whole
    // lesson of this item: an attestation that cannot fail on the property that matters converts
    // an outage into a false positive.
    '[[ -s "/home/$WORKSPACE_USER/.ssh/authorized_keys" ]] || die "workspace authorized_keys is unreadable or empty at attest time; the host is unreachable"',
    '[[ "$(stat -c "%U %a" "/home/$WORKSPACE_USER/.ssh/authorized_keys")" == "$WORKSPACE_USER 600" ]] || die "workspace authorized_keys ownership or mode is unsafe"',
    '[[ "$(stat -c "%U:%G:%a" "$HOSTED_PTY_SSH_KEY")" == "$SERVICE_USER:$SERVICE_GROUP:600" ]] || die "hosted PTY private key ownership or mode is unsafe at attest time"',
    '[[ "$(stat -c "%U:%G:%a" "$HOSTED_PTY_KNOWN_HOSTS")" == "$SERVICE_USER:$SERVICE_GROUP:600" ]] || die "hosted PTY host pin ownership or mode is unsafe at attest time"',
    'runuser -u "$WORKSPACE_USER" -- test ! -r "$HOSTED_PTY_SSH_KEY" || die "customer can read hosted PTY private key"',
    'runuser -u "$WORKSPACE_USER" -- test ! -r "$STATE_ROOT/embedded-pg" || die "customer PTY identity can read embedded database state"',
    // A refused loopback must say WHY (WI-10006258): the account, the label/owner/mode of every
    // path sshd's StrictModes and SELinux check, sshd's effective auth settings, and sshd's own
    // log lines ("Authentication refused: ..."). die() then adds the AVC denials.
    'pty_loopback_evidence() {',
    '  echo "[workspace-host-bootstrap] --- hosted PTY loopback evidence ---"',
    '  getent passwd "$WORKSPACE_USER" || true',
    '  passwd -S "$WORKSPACE_USER" 2>&1 || true',
    '  stat -L -c "%n %U:%G %a %C" / /home "/home/$WORKSPACE_USER" "/home/$WORKSPACE_USER/.ssh" "/home/$WORKSPACE_USER/.ssh/authorized_keys" 2>&1 || true',
    '  sshd -T -C user="$WORKSPACE_USER",host=localhost,addr=127.0.0.1 2>&1 | grep -E "^(usepam|strictmodes|pubkeyauthentication|authorizedkeysfile|authenticationmethods|allowusers|pubkeyacceptedalgorithms) " || true',
    '  journalctl -b --no-pager -o cat -u sshd -u ssh -n 20 2>/dev/null | cut -c1-300 || true',
    '}',
    // Permissions checked via runuser alone would miss a bad key, host pin or sshd policy.
    // Exercise the actual customer PTY identity switch before attesting the host healthy.
    `timeout -k 5 30 runuser -u "$SERVICE_USER" -- env HOME="$STATE_ROOT" PATH=/usr/bin:/bin /usr/bin/ssh -F /dev/null -tt -i "$HOSTED_PTY_SSH_KEY" -o "UserKnownHostsFile=$HOSTED_PTY_KNOWN_HOSTS" -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o ForwardAgent=no -o ClearAllForwardings=yes -o ConnectTimeout=10 -l "$WORKSPACE_USER" 127.0.0.1 ${shellQuote(hostedPtySmoke)} || { pty_loopback_evidence >&2; die "hosted customer PTY loopback authentication or isolation failed"; }`,
    'grep -Fx "pubkeyauthentication yes" <<<"$SSHD_POLICY" >/dev/null || die "sshd would refuse public-key authentication for the workspace user"',
    'grep -Eq "^authorizedkeysfile .*\\.ssh/authorized_keys" <<<"$SSHD_POLICY" || die "sshd does not read the authorized_keys this bootstrap wrote"',
    'OBSERVED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
    `CHECKS_JSON=${shellQuote(checksJson)}`,
    'ATTESTATION_PATH="$STATE_ROOT/bootstrap-attestation.json"',
    'jq -n --arg contractVersion "$CONTRACT_VERSION" --arg hostId "$HOST_ID" --arg action "$BOOTSTRAP_ACTION" ' + modelJqArgs + '--arg observedAt "$OBSERVED_AT" --arg releaseVersion "$RELEASE_VERSION" --arg migrationId "$MIGRATION_ID" --arg serviceName "$SERVICE_NAME" --arg serviceUser "$SERVICE_USER" --arg serviceGroup "$SERVICE_GROUP" --arg workspaceUser "$WORKSPACE_USER" --arg workspaceGroup "$WORKSPACE_GROUP" --arg agentUser "$AGENT_USER" --arg agentGroup "$AGENT_GROUP" --arg runtimeRoot "$RUNTIME_ROOT" --arg stateRoot "$STATE_ROOT" --arg workspaceRoot "$WORKSPACE_ROOT" --argjson nodeMajor "$NODE_MAJOR" --argjson minimumNodeMajor "$MINIMUM_NODE_MAJOR" --argjson servicePort "$SERVICE_PORT" ' + agentRuntimeJqArgs + '--argjson checks "$CHECKS_JSON" \\',
    '  \'{contractVersion:$contractVersion,hostId:$hostId,action:$action,' + modelJqFields + 'observedAt:$observedAt,status:"healthy",' + modelReleaseJqField + ',migration:{id:$migrationId,applied:true},runtime:{nodeMajor:$nodeMajor,minimumNodeMajor:$minimumNodeMajor,psu:true,pui:true,agentLaunchers:{claude:true,codex:true,omp:true},agentRuntimesVerifiedByBootstrap:false,agentRuntimesInstalledByBootstrap:' + agentRuntimesInstalled + agentRuntimeJqFields + '},service:{name:$serviceName,user:$serviceUser,group:$serviceGroup,bindHost:"127.0.0.1",port:$servicePort,active:true},isolation:{workspaceUser:$workspaceUser,workspaceGroup:$workspaceGroup,agentUser:$agentUser,agentGroup:$agentGroup,runtimeRoot:$runtimeRoot,stateRoot:$stateRoot,workspaceRoot:$workspaceRoot,runtimeReadableByWorkspaceUser:false,runtimeWritableByWorkspaceUser:false,runtimeReadableByAgentUser:true,runtimeWritableByAgentUser:false,agentHomeReadableBySshUser:false,workspaceWritableByService:true,workspaceWritableBySshUser:true,workspaceWritableByAgentUser:true,sudo:false,serviceGroupMember:false,operatorIngress:"ssh-local-forward",updateMode:"' + WORKSPACE_HOST_UPDATE_MODE_BY_MODEL[hostModel] + '"},checks:$checks}\' > "$ATTESTATION_PATH"',
    'chown "$SERVICE_USER:$SERVICE_GROUP" "$ATTESTATION_PATH"',
    'chmod 0640 "$ATTESTATION_PATH"',
    `printf '${WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_PREFIX}%s\\n' "$(base64 --wrap=0 < \"$ATTESTATION_PATH\")"`,
    "SWITCHED=0",
    // WI-10004242: only a run that got this far may let a LATER boot skip the service restart.
    'install -d -o root -g root -m 0700 "$BOOTSTRAP_STATE_DIR"',
    'printf "%s %s\\n" "$BOOTSTRAP_FINGERPRINT" "$BOOT_ID" > "$BOOTSTRAP_COMPLETE_MARKER.next"',
    'mv -Tf "$BOOTSTRAP_COMPLETE_MARKER.next" "$BOOTSTRAP_COMPLETE_MARKER"',
    'log "bootstrap complete"',
  ];

  // The fingerprint is the hash of the rendered script itself (with the placeholder in place),
  // so any change to the release, the service unit, or the host configuration changes it.
  const script = `${lines.join('\n')}\n`;
  return script.replace(
    WORKSPACE_HOST_BOOTSTRAP_FINGERPRINT_PLACEHOLDER,
    createHash('sha256').update(script).digest('hex'),
  );
}

function addMismatch(
  errors: string[],
  condition: unknown,
  message: string,
): void {
  if (!condition) errors.push(message);
}

/** Parse the final base64 attestation line from remote bootstrap stdout. */
export function parseWorkspaceHostBootstrapAttestation(
  stdout: string,
): WorkspaceHostBootstrapAttestation {
  const lines = stdout.split(/\r?\n/);
  let line: string | undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].startsWith(WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_PREFIX)) {
      line = lines[index];
      break;
    }
  }
  if (!line)
    throw new Error(
      'Workspace-host bootstrap output did not contain an attestation',
    );
  const encoded = line.slice(
    WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_PREFIX.length,
  );
  try {
    return JSON.parse(
      Buffer.from(encoded, 'base64').toString('utf8'),
    ) as WorkspaceHostBootstrapAttestation;
  } catch (error) {
    throw new Error(
      'Workspace-host bootstrap attestation is not valid base64 JSON',
      { cause: error },
    );
  }
}

/**
 * Validate the remote result against the exact requested release, trust root,
 * migration, runtime floor, and loopback service contract.
 */
/**
 * The repository of a bootc release image ref: the ref without its tag. A tag separator is a
 * colon AFTER the final slash; a registry port is a colon BEFORE it, so `split(':')[0]` would
 * turn `127.0.0.1:5096/papercusp/workspace-host:tag` into `127.0.0.1`. SAFE_IMAGE_REF admits
 * no digest in `bootc.image`, so the last-colon comparison is a complete parser for that shape.
 */
export function workspaceHostBootcImageRepository(image: string): string {
  const finalSlash = image.lastIndexOf('/');
  const finalColon = image.lastIndexOf(':');
  return finalColon > finalSlash ? image.slice(0, finalColon) : image;
}

/**
 * The image ref a correct bootc host BOOTS: the release repository pinned to its digest. The
 * bake renders every cloud from `repo@sha256:…` (bake-cloud-images.sh refuses a tag) and the
 * bootstrap switches by digest, so `bootc status` reports exactly this ref — never the tag,
 * which rides along as provenance only. Every check of an attested `release.source` compares
 * against this, not `bootc.image` (WI-10006339: the tag comparison failed every correct host).
 */
export function workspaceHostBootcPinnedImageRef(bootc: {
  image: string;
  imageDigest: string;
}): string {
  return `${workspaceHostBootcImageRepository(bootc.image)}@${bootc.imageDigest}`;
}

export function validateWorkspaceHostBootstrapAttestation(
  attestation: unknown,
  expected: WorkspaceHostBootstrapInput,
): WorkspaceHostBootstrapAttestationValidation {
  const validated = validateInput(expected);
  const errors: string[] = [];
  try {
    assertWorkspaceHostSecretIsolation(attestation, 'bootstrap.attestation');
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (
    !isRecord(attestation) ||
    !isRecord(attestation.release) ||
    !isRecord(attestation.migration) ||
    !isRecord(attestation.runtime) ||
    !isRecord(attestation.service) ||
    !isRecord(attestation.isolation) ||
    !Array.isArray(attestation.checks)
  ) {
    return {
      ok: false,
      errors: [...errors, 'bootstrap attestation has an invalid shape'],
    };
  }
  const candidate = attestation as unknown as WorkspaceHostBootstrapAttestation;

  addMismatch(
    errors,
    candidate.contractVersion === expected.contractVersion,
    'contract version mismatch',
  );
  addMismatch(errors, candidate.hostId === expected.hostId, 'host id mismatch');
  addMismatch(
    errors,
    candidate.action === expected.action,
    'bootstrap action mismatch',
  );
  // The discriminant is checked BEFORE anything reads a model-specific field, and against the
  // render's own model rather than merely "one of the known values". A host that attests a model
  // this bootstrap was not rendered for is not a host with an odd field — it is a host whose
  // entire check set, update mode and release chain were judged against the wrong contract.
  addMismatch(
    errors,
    candidate.hostModel === validated.hostModel,
    `attested host model '${String(candidate.hostModel)}' does not match the rendered model '${validated.hostModel}'`,
  );
  if (candidate.hostModel === 'ubuntu-release-bundle') {
    addMismatch(
      errors,
      candidate.ubuntuVersion === WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
      'Ubuntu version mismatch',
    );
    addMismatch(
      errors,
      isRecord(candidate.release) &&
        typeof candidate.release.bundleSha256 === 'string' &&
        typeof candidate.release.signingKeySha256 === 'string',
      'bundle release attestation is missing its minisign trust chain',
    );
  } else if (candidate.hostModel === 'bootc-image') {
    addMismatch(
      errors,
      candidate.bootcBaseImage === validated.bootc?.baseImage,
      `attested bootc base image '${String(candidate.bootcBaseImage)}' does not match the expected '${String(validated.bootc?.baseImage)}'`,
    );
    // The digest, not the tag. A tag-only match would accept whatever the registry served.
    addMismatch(
      errors,
      isRecord(candidate.release) &&
        candidate.release.imageDigest === validated.bootc?.imageDigest,
      'attested image digest does not match the pinned release image',
    );
    // Refuse the minisign chain HERE rather than only requiring the image fields, because the
    // failure this guards is an attestation carrying BOTH: a bootc host that also reports a
    // bundle digest is describing a verification it did not perform, and a validator that only
    // checks for what it expects would pass it.
    // Read through an untyped view on purpose: the whole point is to detect fields the bootc
    // member does NOT declare, and a narrowed read cannot see what the type says is absent.
    // The attestation arrives as untrusted JSON, so "the type says it cannot be there" is a
    // statement about our code, never about the document.
    const bootcRelease = candidate.release as unknown as Record<string, unknown>;
    addMismatch(
      errors,
      bootcRelease.bundleSha256 === undefined &&
        bootcRelease.signingKeySha256 === undefined,
      'bootc attestation reports a minisign bundle trust chain it cannot have performed',
    );
  }
  addMismatch(
    errors,
    Number.isFinite(Date.parse(candidate.observedAt)),
    'observedAt must be an ISO timestamp',
  );
  addMismatch(
    errors,
    candidate.status === 'healthy',
    'bootstrap status is not healthy',
  );
  addMismatch(
    errors,
    candidate.release.version === expected.release.version,
    'release version mismatch',
  );
  // `source` means different things per model — the bundle URL that was fetched, or the image
  // ref that was booted — so it is compared per model rather than against `release.bundleUrl`
  // for both. Comparing a booted image ref to a tarball URL would fail every bootc host with a
  // message about a release source, which names the symptom and hides the cause.
  if (candidate.hostModel === 'bootc-image') {
    addMismatch(
      errors,
      validated.bootc !== undefined &&
        candidate.release.source === workspaceHostBootcPinnedImageRef(validated.bootc),
      'attested booted image ref does not match the pinned release image',
    );
    addMismatch(
      errors,
      candidate.release.signaturePolicyPath ===
        validated.bootc?.signaturePolicyPath,
      'attested signature policy path does not match the rendered one',
    );
  } else {
    addMismatch(
      errors,
      candidate.release.source === expected.release.bundleUrl,
      'release source mismatch',
    );
    addMismatch(
      errors,
      candidate.release.bundleSha256 ===
        expected.release.bundleSha256.toLowerCase(),
      'release digest mismatch',
    );
    addMismatch(
      errors,
      candidate.release.signingKeySha256 ===
        expected.release.signingKeySha256.toLowerCase(),
      'signing key mismatch',
    );
  }
  addMismatch(
    errors,
    candidate.release.signatureVerified === true,
    'release signature was not verified',
  );
  addMismatch(
    errors,
    candidate.migration.id === expected.migrationId,
    'migration id mismatch',
  );
  addMismatch(
    errors,
    candidate.migration.applied === true,
    'migration was not applied',
  );
  addMismatch(
    errors,
    Number.isSafeInteger(candidate.runtime.nodeMajor) &&
      candidate.runtime.nodeMajor >= expected.minimumNodeMajor,
    'Node runtime is below the requested floor',
  );
  addMismatch(
    errors,
    candidate.runtime.minimumNodeMajor === expected.minimumNodeMajor,
    'Node runtime floor mismatch',
  );
  addMismatch(
    errors,
    candidate.runtime.psu === true &&
      candidate.runtime.pui === true &&
      candidate.runtime.agentLaunchers?.claude === true &&
      candidate.runtime.agentLaunchers?.codex === true &&
      candidate.runtime.agentLaunchers?.omp === true,
    'agent launcher prerequisite check failed',
  );
  // Refuse the OPTIMISTIC lie specifically. A host claiming bootstrap verified its agent
  // runtimes is either running pre-D-252 code or has been hand-edited, and in both cases the
  // claim is unbacked — bootstrap has no probe that could establish it. Asserting the literal
  // `false` rather than ignoring the field is what makes a stale attestation legible instead of
  // merely tolerated.
  addMismatch(
    errors,
    candidate.runtime.agentRuntimesVerifiedByBootstrap === false,
    'attestation claims bootstrap verified the agent runtimes; bootstrap cannot establish that (D-252)',
  );
  addMismatch(
    errors,
    candidate.service.name === expected.service.name,
    'service name mismatch',
  );
  addMismatch(
    errors,
    candidate.service.user === validated.serviceUser,
    'service user mismatch',
  );
  addMismatch(
    errors,
    candidate.service.group === validated.serviceGroup,
    'service group mismatch',
  );
  addMismatch(
    errors,
    candidate.service.bindHost === '127.0.0.1',
    'operator must bind to loopback',
  );
  addMismatch(
    errors,
    candidate.service.port === expected.service.port,
    'service port mismatch',
  );
  addMismatch(
    errors,
    candidate.service.active === true,
    'workspace service is not active',
  );
  addMismatch(
    errors,
    candidate.isolation.workspaceUser === validated.workspaceUser,
    'workspace SSH user mismatch',
  );
  addMismatch(
    errors,
    candidate.isolation.workspaceGroup === validated.workspaceGroup,
    'workspace SSH group mismatch',
  );
  addMismatch(
    errors,
    candidate.isolation.runtimeRoot === WORKSPACE_HOST_RUNTIME_ROOT &&
      candidate.isolation.stateRoot === WORKSPACE_HOST_STATE_ROOT &&
      candidate.isolation.workspaceRoot === WORKSPACE_HOST_DATA_ROOT,
    'workspace isolation path mismatch',
  );
  addMismatch(
    errors,
    candidate.isolation.agentUser === validated.agentUser,
    'agent identity mismatch',
  );
  addMismatch(
    errors,
    candidate.isolation.agentGroup === validated.agentGroup,
    'agent group mismatch',
  );
  // Asserted here and not only on the host, because this validator is what a caller who never
  // saw the host runs. Each of the three is independently satisfiable by the broken shape: a
  // host with only the first has no runnable agents, one with only the second is D-246's
  // violation of D-043, and one with only the third can hand the customer's login the platform's
  // agent credentials. Naming them separately is what makes the failure legible.
  addMismatch(
    errors,
    candidate.isolation.runtimeReadableByWorkspaceUser === false,
    'workspace SSH user can read the Papercusp runtime (D-043)',
  );
  addMismatch(
    errors,
    candidate.isolation.runtimeReadableByAgentUser === true,
    'agent identity cannot read the runtime it must execute agents from',
  );
  addMismatch(
    errors,
    candidate.isolation.agentHomeReadableBySshUser === false,
    'workspace SSH user can read the delivered agent credential home',
  );
  addMismatch(
    errors,
    candidate.isolation.runtimeWritableByWorkspaceUser === false &&
      candidate.isolation.runtimeWritableByAgentUser === false,
    'an unprivileged identity can write the runtime',
  );
  addMismatch(
    errors,
    candidate.isolation.workspaceWritableByService === true &&
      candidate.isolation.workspaceWritableBySshUser === true &&
      candidate.isolation.workspaceWritableByAgentUser === true,
    'scoped workspace ACL verification failed',
  );
  addMismatch(
    errors,
    candidate.isolation.sudo === false &&
      candidate.isolation.serviceGroupMember === false,
    'workspace SSH user has privileged runtime membership',
  );
  addMismatch(
    errors,
    candidate.isolation.operatorIngress === 'ssh-local-forward',
    'operator ingress is not restricted to authenticated SSH forwarding',
  );
  // A PAIRING test, not membership in the union. Membership would accept a bootc host reporting
  // `signed-atomic-release-swap` — a claim to have swapped a minisign-verified tarball it never
  // downloaded — which is the precise shape of the attested-but-unperformed property D-262
  // exists to refuse.
  addMismatch(
    errors,
    candidate.isolation.updateMode ===
      WORKSPACE_HOST_UPDATE_MODE_BY_MODEL[validated.hostModel],
    `runtime update mode '${String(candidate.isolation.updateMode)}' is not the update path of host model '${validated.hostModel}'`,
  );

  const checks = candidate.checks.filter(
    (check) => isRecord(check) && typeof check.name === 'string',
  );
  const checkMap = new Map(checks.map((check) => [check.name, check.ok]));
  const requiredChecks = workspaceHostBootstrapChecks(validated.hostModel);
  for (const check of requiredChecks) {
    addMismatch(
      errors,
      checkMap.get(check) === true,
      `required bootstrap check '${check}' did not pass`,
    );
  }
  // Set EQUALITY, and the "no extras" half is the new one. The loop above only ever asked
  // whether each EXPECTED name was present and ok; a well-formed name outside the expected set
  // sailed through, because with a single host model there was no such thing. There is now: the
  // extras a bootc host could carry are `bundle-digest` and `bundle-signature`, i.e. precisely
  // the claims it is not entitled to make, and precisely the ones a reader of the attestation
  // would take as evidence that the release was minisign-verified.
  const required = new Set<string>(requiredChecks);
  const unexpected = checks
    .map((check) => String(check.name))
    .filter((name) => !required.has(name));
  addMismatch(
    errors,
    unexpected.length === 0,
    `bootstrap attestation carries checks that host model '${validated.hostModel}' cannot establish: ${unexpected.join(', ')}`,
  );
  addMismatch(
    errors,
    checks.length === candidate.checks.length,
    'bootstrap attestation contains invalid checks',
  );
  addMismatch(
    errors,
    checkMap.size === checks.length,
    'bootstrap attestation contains duplicate checks',
  );
  return { ok: errors.length === 0, errors };
}
