/**
 * workspace-host-desktop-pack.ts — the OPT-IN agent-sandbox desktop pack (P-012).
 *
 * ── What this is, and what it deliberately is not ──────────────────────────────────
 * D-018 (owner ruling) scoped the BYOC cloud desktop to AGENT SANDBOX DESKTOPS ONLY,
 * and ruled that it is never a base-image requirement: the shipped workspace-host
 * image stays headless by construction. D-022 then settled the mechanism — this is a
 * POST-PROVISION LAYERED INSTALL applied to an already-bootstrapped host, not an
 * image variant. The reasoning is on D-022; the short version is that an image is
 * chosen once, for the whole host, at provision time, so "opt-in" delivered as a
 * different image is opt-in per fleet rather than per workspace.
 *
 * It does NOT stand up a Papercusp app session on the VM (byoc P-048 ships the thin
 * GUI/browser for that) and it does NOT provide visible cloud fleet terminals (cloud
 * fleets run headless; their observability is transcripts, coord and plans).
 *
 * ── The two things most likely to be got wrong, stated up front ────────────────────
 * 1. THE LISTENER. KasmVNC ships `network.interface: 0.0.0.0` and `Xkasmvnc -help`
 *    documents `interface ... (default=all)`. An install that merely succeeded would
 *    therefore publish every agent's sandbox desktop on the VM's external interface.
 *    D-020 requires loopback-only, reachable solely through P-013's ticket-gated
 *    proxy, so this pack OVERRIDES that default in the system config AND the runtime
 *    argv, and `loopback-only-listener` is a named check rather than a comment.
 * 2. THE IDENTITY. The pack introduces a THIRD unix identity. It would have been
 *    less code to run sandbox desktops as the existing workspace user — and that is
 *    exactly the credential bleed the item forbids: that account owns the customer's
 *    workspace and its git credentials, so an agent-operated app escaping its bwrap
 *    would inherit them. The desktop user owns nothing but desktops.
 */
import { assertWorkspaceHostSecretIsolation } from './workspace-host-test-harness';
import { WORKSPACE_HOST_DESKTOP_SESSION_ENTRYPOINT } from './workspace-host-build-manifest';
import {
  APT_BOUNDED_HELPER_LINES,
  WORKSPACE_HOST_CURL_STALL_GUARD,
  DEFAULT_WORKSPACE_HOST_AGENT_USER,
  DEFAULT_WORKSPACE_HOST_SERVICE_USER,
  DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
  WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
  WORKSPACE_HOST_RUNTIME_ROOT,
  WORKSPACE_HOST_STATE_ROOT,
} from './workspace-host-bootstrap';

export const WORKSPACE_HOST_DESKTOP_PACK_CONTRACT_VERSION =
  'papercusp-workspace-host-desktop-pack-v1';
export const WORKSPACE_HOST_DESKTOP_PACK_ATTESTATION_PREFIX =
  'PAPERCUSP_WORKSPACE_HOST_DESKTOP_PACK_ATTESTATION=';

/**
 * The pack's own unix identity — NOT the service user and NOT the workspace user.
 *
 * The whole point is what it is *not* a member of. `papercusp` (service) holds the
 * operator's runtime and its credentials; `papercusp-workspace` holds the customer's
 * checkout, their git credentials, and their agent credentials, in a 0700 home. A
 * sandbox desktop needs neither, so it gets neither, and `workspace-credential-isolation`
 * asserts the negative rather than trusting that nobody adds a convenient group later.
 */
export const DEFAULT_WORKSPACE_HOST_DESKTOP_USER = 'papercusp-desktop';
export const DEFAULT_WORKSPACE_HOST_DESKTOP_GROUP = 'papercusp-desktop';
/**
 * Home + per-session credential root for the desktop pool. Mode 0700, desktop-user owned.
 *
 * ⚠ A TOP-LEVEL PATH, DELIBERATELY *NOT* NESTED UNDER `WORKSPACE_HOST_STATE_ROOT`.
 *
 * It was `${WORKSPACE_HOST_STATE_ROOT}/desktop` until this was measured on a real
 * workspace VM: `/var/lib/papercusp` is `drwxr-x--- papercusp:papercusp`, and the
 * desktop user is deliberately NOT in group `papercusp` (that non-membership is what
 * `workspace-credential-isolation` asserts). With no `x` on the parent, the desktop
 * user could not TRAVERSE into the root created for it —
 * `namei` reported `desktop - Permission denied` — so `kasmvncpasswd` could not write
 * the per-session view/control credential file that `buildXServerCommand` requires,
 * and the ticketed viewer could not be provisioned at all.
 *
 * The two requirements are irreconcilable while nested: granting traversal means
 * putting the desktop user in the service group, which is exactly the credential bleed
 * the pack exists to prevent. So the root moves OUT rather than the isolation being
 * weakened. Anything that needs both must cross a deliberate seam, not a directory mode.
 */
export const WORKSPACE_HOST_DESKTOP_ROOT = '/var/lib/papercusp-desktop';

/**
 * The pinned KasmVNC artifact.
 *
 * Measured 2026-08-30 against the GitHub release API and a local `dpkg-deb` of the
 * downloaded file. It is NOT in the Ubuntu archive — `apt install kasmvncserver`
 * cannot work — so the pack fetches and verifies by digest, the same posture the
 * bootstrap contract already takes to the Server bundle.
 */
export interface WorkspaceHostDesktopPackArtifact {
  version: string;
  /** Public HTTPS .deb URL. Query credentials are forbidden, as in the bootstrap release. */
  debUrl: string;
  debSha256: string;
  debBytes: number;
}

export const PINNED_KASMVNC_ARTIFACT: Readonly<WorkspaceHostDesktopPackArtifact> = {
  version: '1.5.0',
  debUrl:
    'https://github.com/kasmtech/KasmVNC/releases/download/v1.5.0/kasmvncserver_noble_1.5.0_amd64.deb',
  debSha256: 'f599fe02e2175b9817b6165f74a5d2bebdc73118dde9181ba3410963bed7ae1e',
  debBytes: 2_653_112,
};

/**
 * APT packages the pack layers on. Split by WHY, because the temptation when one of
 * these is missing is to install a metapackage, and a metapackage is how a headless
 * host acquires a login manager.
 */
export const WORKSPACE_HOST_DESKTOP_PACK_APT = {
  /** KasmVNC's own declared Depends that are not in the base image. */
  kasmvncRuntime: [
    'libgl1',
    'libgbm1',
    'libxfont2',
    'libxtst6',
    'libunwind8',
    'xauth',
    'x11-xkb-utils',
    'xkb-data',
    'ssl-cert',
    'libswitch-perl',
    'libyaml-tiny-perl',
    'libhash-merge-simple-perl',
    'liblist-moreutils-perl',
    'libtry-tiny-perl',
    'libdatetime-perl',
    'libdatetime-timezone-perl',
  ],
  /** The window manager. openbox draws chrome through plain X11 and needs no GL. */
  windowManager: ['openbox'],
  /**
   * gl-strategy's measured ladder. `libgl1-mesa-dri` is what makes the mesa-software
   * rung real on a GPU-less VM; without it the honest measurement is `tier: 'none'`
   * and every capture from the desktop is untrustworthy by construction.
   */
  gl: ['libgl1-mesa-dri', 'libegl1', 'mesa-utils'],
  /** D-010's a11y bus: a dbus-daemon plus AT-SPI. Ordering is enforced in a11y-bus.ts. */
  accessibility: ['dbus-daemon', 'at-spi2-core'],
  /** The driver layer D-021 keeps X-bound: xdotool input, `import` capture. */
  driver: ['xdotool', 'imagemagick', 'x11-utils'],
  /** D-015/D-016 per-app confinement. */
  sandbox: ['bubblewrap', 'nftables'],
  /**
   * The floor of a USABLE desktop (WI-10002863). Without these a started desktop is a
   * black X root with openbox alone: Watch cannot tell it from a dead stream, and
   * openbox's right-click menu points at `x-terminal-emulator`, which nothing provides.
   * `xterm` registers that alternative; `x11-xserver-utils` ships `xsetroot`, which the
   * session worker uses to paint the root a non-black colour.
   */
  desktopFloor: ['xterm', 'x11-xserver-utils'],
  /**
   * The customer-facing desktop (WI-10002863, owner: XFCE). Named components, never the
   * `xfce4`/`xubuntu-desktop` metapackages: those pull a display manager. xfwm4 is the WM
   * of this session; openbox stays above for the bare agent desktops. `dbus-bin` ships
   * `dbus-run-session`, which gives the session the full bus xfconf needs; the a11y bus's
   * minimal bus cannot activate it. The icon theme is named because --no-install-recommends
   * otherwise leaves the panel with blank launchers.
   */
  desktopEnvironment: [
    'xfce4-session',
    'xfwm4',
    'xfce4-panel',
    'xfdesktop4',
    'xfce4-settings',
    'xfce4-terminal',
    'thunar',
    'dbus-bin',
    'adwaita-icon-theme',
  ],
  /** Verifies the pinned Mozilla signing key before its repo is trusted (see install-browser). */
  browserKeyring: ['gpg'],
} as const;

/**
 * The browser comes from Mozilla's own APT repo. Ubuntu 24.04's `firefox` and `chromium`
 * debs are transitional stubs that install the snap, and snapd cannot run inside the
 * desktop's systemd unit. The key is pinned by fingerprint, so a substituted key fails the
 * pack instead of becoming a trusted root.
 */
export const WORKSPACE_HOST_DESKTOP_BROWSER_REPO = {
  keyUrl: 'https://packages.mozilla.org/apt/repo-signing-key.gpg',
  keyFingerprint: '35BAA0B33E9EB396F59CA838C0BA5CE6DC6315A3',
  source: 'https://packages.mozilla.org/apt mozilla main',
  origin: 'packages.mozilla.org',
  package: 'firefox',
} as const;

export const WORKSPACE_HOST_DESKTOP_PACK_PHASES = [
  'validate-host',
  'install-x-stack',
  'install-kasmvnc',
  'harden-listener',
  'create-desktop-identity',
  'install-desktop-runtime',
  'attest-pack',
] as const;
export type WorkspaceHostDesktopPackPhase =
  (typeof WORKSPACE_HOST_DESKTOP_PACK_PHASES)[number];

export const WORKSPACE_HOST_DESKTOP_PACK_CHECKS = [
  'ubuntu-24.04',
  'host-bootstrapped',
  'kasmvnc-digest',
  'kasmvnc-binary',
  'loopback-only-listener',
  'desktop-identity',
  // The mirror of `workspace-credential-isolation`. That one proves the desktop user
  // CANNOT reach what isn't its own; this proves it CAN reach what is. Attesting only
  // the negative let the pack report `status: healthy` on a host whose desktop root was
  // unusable, which is the precise failure this pack's install-time checks exist to
  // turn into "one legible failure" rather than "desktops silently do not work".
  'desktop-root-writable',
  'workspace-credential-isolation',
  'x-stack',
  'a11y-stack',
  'gl-stack',
  'desktop-environment',
  'browser',
  'desktop-runtime',
  'desktop-socket',
  'desktop-egress-isolation',
] as const;
export type WorkspaceHostDesktopPackCheckName =
  (typeof WORKSPACE_HOST_DESKTOP_PACK_CHECKS)[number];

export interface WorkspaceHostDesktopPackIsolation {
  desktopUser?: string;
  desktopGroup?: string;
  /** The bootstrap's workspace account, which the desktop user must NOT be able to read. */
  workspaceUser?: string;
  /** The bootstrap's service account, which the desktop user must NOT share a group with. */
  serviceUser?: string;
  /**
   * The bootstrap's AGENT account (D-248), whose 0700 home holds the delivered Claude/Codex/OMP
   * material. The desktop user must not be able to read it. Named separately from `workspaceUser`
   * because those two homes were the SAME directory before D-248 split them — so a check written
   * against the workspace home alone silently stopped covering the credentials on the day of the
   * split, without changing behaviour or failing anything.
   */
  agentUser?: string;
}

export interface WorkspaceHostDesktopPackInput {
  contractVersion: typeof WORKSPACE_HOST_DESKTOP_PACK_CONTRACT_VERSION;
  /** Uninstall is reserved by the contract but not implemented; the builder rejects it. */
  action: 'install' | 'uninstall';
  hostId: string;
  artifact?: WorkspaceHostDesktopPackArtifact;
  isolation?: WorkspaceHostDesktopPackIsolation;
  /** Persistable labels only; secret-shaped values are rejected, as in the bootstrap. */
  publicMetadata?: Readonly<Record<string, unknown>>;
}

export interface WorkspaceHostDesktopPackAttestation {
  contractVersion: typeof WORKSPACE_HOST_DESKTOP_PACK_CONTRACT_VERSION;
  hostId: string;
  action: WorkspaceHostDesktopPackInput['action'];
  ubuntuVersion: typeof WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION;
  observedAt: string;
  status: 'healthy';
  kasmvnc: { version: string; sha256: string };
  checks: Array<{ name: WorkspaceHostDesktopPackCheckName; ok: true }>;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** UID-scoped OUTPUT rules; do not touch the host's existing ingress firewall. */
export function buildWorkspaceDesktopEgressRules(uid: number | '$DESKTOP_UID'): string {
  if (uid !== '$DESKTOP_UID' && (!Number.isSafeInteger(uid) || uid <= 0)) throw new Error('desktop egress requires a non-root uid');
  return `add table inet papercusp_desktop
add chain inet papercusp_desktop output { type filter hook output priority -10; policy accept; }
flush chain inet papercusp_desktop output
add rule inet papercusp_desktop output meta skuid ${uid} ct direction reply accept
add rule inet papercusp_desktop output meta skuid ${uid} ip daddr 127.0.0.53 meta l4proto { tcp, udp } th dport 53 accept
add rule inet papercusp_desktop output meta skuid ${uid} ip daddr 169.254.169.254 meta l4proto { tcp, udp } th dport 53 accept
add rule inet papercusp_desktop output meta skuid ${uid} fib daddr type local reject
add rule inet papercusp_desktop output meta skuid ${uid} ip daddr 169.254.0.0/16 reject
add rule inet papercusp_desktop output meta skuid ${uid} ip6 daddr { fe80::/10, fc00::/7 } reject
`;
}

function assertPublicHttps(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Desktop pack ${label} must be an absolute URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Desktop pack ${label} must be https`);
  }
  // Same rule the bootstrap release applies: a credential in a URL ends up in process
  // listings, shell history and any log that echoes the fetch.
  if (parsed.username || parsed.password || parsed.search) {
    throw new Error(`Desktop pack ${label} must not carry credentials or a query string`);
  }
}

/**
 * Render the pack's root shell script.
 *
 * Every phase ends by printing its name, so a partial run says exactly how far it got
 * rather than leaving the caller to infer it from which check failed. `set -euo
 * pipefail` is load-bearing here for the same reason it is in the bootstrap: several
 * steps are `cmd | cmd` pipelines whose first half is the one that can fail.
 */
export function buildWorkspaceHostDesktopPackScript(
  input: WorkspaceHostDesktopPackInput,
): { script: string; phases: readonly WorkspaceHostDesktopPackPhase[] } {
  if (input.contractVersion !== WORKSPACE_HOST_DESKTOP_PACK_CONTRACT_VERSION) {
    throw new Error(
      `Desktop pack contract mismatch: expected ${WORKSPACE_HOST_DESKTOP_PACK_CONTRACT_VERSION}`,
    );
  }
  // The privileged script only installs. Never render an install script labelled
  // "uninstall": that would make a destructive caller run apt installs and then
  // falsely attest success. Reject before constructing any shell commands.
  if (input.action !== 'install') {
    throw new Error(`Desktop pack action ${String(input.action)} is not implemented; only install is supported`);
  }
  if (!input.hostId.trim()) throw new Error('Desktop pack requires a hostId');
  if (input.publicMetadata) {
    assertWorkspaceHostSecretIsolation(input.publicMetadata, 'desktopPack.publicMetadata');
  }

  const artifact = input.artifact ?? PINNED_KASMVNC_ARTIFACT;
  assertPublicHttps(artifact.debUrl, 'artifact.debUrl');
  if (!/^[0-9a-f]{64}$/.test(artifact.debSha256)) {
    throw new Error('Desktop pack artifact.debSha256 must be a lowercase 64-char sha256');
  }

  const desktopUser = input.isolation?.desktopUser ?? DEFAULT_WORKSPACE_HOST_DESKTOP_USER;
  const desktopGroup = input.isolation?.desktopGroup ?? DEFAULT_WORKSPACE_HOST_DESKTOP_GROUP;
  const workspaceUser = input.isolation?.workspaceUser ?? DEFAULT_WORKSPACE_HOST_WORKSPACE_USER;
  const serviceUser = input.isolation?.serviceUser ?? DEFAULT_WORKSPACE_HOST_SERVICE_USER;
  // D-248 moved the agent credentials OUT of the workspace account's home and into their own
  // identity. This pack's whole isolation claim was written when those were the same directory,
  // so without naming the agent account here the reachability check below would keep proving the
  // desktop user cannot read a home the credentials no longer live in — a guard still passing
  // over an empty barn, which is worse than no guard because it reads as coverage.
  const agentUser = input.isolation?.agentUser ?? DEFAULT_WORKSPACE_HOST_AGENT_USER;

  if (
    desktopUser === workspaceUser ||
    desktopUser === serviceUser ||
    desktopUser === agentUser
  ) {
    throw new Error(
      `Desktop pack refuses desktopUser=${desktopUser}: sandbox desktops must not run as the ` +
        'workspace, service, or agent account. Between them those accounts hold the customer ' +
        'checkout, its git credentials, and the delivered agent credentials, so reusing one ' +
        'would make a sandbox escape a credential compromise — which is the exact bleed this ' +
        'pack exists to prevent.',
    );
  }

  for (const user of [desktopUser, desktopGroup, workspaceUser, serviceUser, agentUser]) {
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new Error('Desktop pack requires valid Unix account names');
  }
  if (desktopUser !== DEFAULT_WORKSPACE_HOST_DESKTOP_USER || desktopGroup !== DEFAULT_WORKSPACE_HOST_DESKTOP_GROUP) {
    throw new Error('Desktop runtime requires the fixed papercusp-desktop identity');
  }

  const apt = [
    ...WORKSPACE_HOST_DESKTOP_PACK_APT.kasmvncRuntime,
    ...WORKSPACE_HOST_DESKTOP_PACK_APT.windowManager,
    ...WORKSPACE_HOST_DESKTOP_PACK_APT.gl,
    ...WORKSPACE_HOST_DESKTOP_PACK_APT.accessibility,
    ...WORKSPACE_HOST_DESKTOP_PACK_APT.driver,
    ...WORKSPACE_HOST_DESKTOP_PACK_APT.sandbox,
    ...WORKSPACE_HOST_DESKTOP_PACK_APT.desktopFloor,
    ...WORKSPACE_HOST_DESKTOP_PACK_APT.desktopEnvironment,
    ...WORKSPACE_HOST_DESKTOP_PACK_APT.browserKeyring,
  ];
  const browser = WORKSPACE_HOST_DESKTOP_BROWSER_REPO;

  const script = `#!/usr/bin/env bash
# Papercusp workspace-host DESKTOP PACK (${WORKSPACE_HOST_DESKTOP_PACK_CONTRACT_VERSION})
# Opt-in, layered, post-provision. Never part of the base image (D-018 / D-022).
set -euo pipefail

HOST_ID=${shellQuote(input.hostId)}
DESKTOP_USER=${shellQuote(desktopUser)}
DESKTOP_GROUP=${shellQuote(desktopGroup)}
WORKSPACE_USER=${shellQuote(workspaceUser)}
SERVICE_USER=${shellQuote(serviceUser)}
AGENT_USER=${shellQuote(agentUser)}
DESKTOP_ROOT=${shellQuote(WORKSPACE_HOST_DESKTOP_ROOT)}
KASM_URL=${shellQuote(artifact.debUrl)}
KASM_SHA=${shellQuote(artifact.debSha256)}
KASM_VERSION=${shellQuote(artifact.version)}
KASM_YAML=/etc/kasmvnc/kasmvnc.yaml

phase() { echo "PAPERCUSP_DESKTOP_PACK_PHASE=$1"; }
fail()  { echo "PAPERCUSP_DESKTOP_PACK_FAIL=$1" >&2; exit 1; }
# Bounded retry for archive access: one missed fetch must not fail the pack (WI-10002837).
# Exhaustion returns non-zero, so set -e still stops the script exactly as a single try did.
# Every networked apt call is wall-clock bounded: one apt-get update ran ~30 min on a first
# boot without apt's own timeouts ending it (WI-10002863). Fetches are bounded, dpkg is not.
${APT_BOUNDED_HELPER_LINES.join('\n')}
retry() { local max="$1" attempt=1; shift; until "$@"; do (( attempt >= max )) && return 1; echo "attempt $attempt/$max failed, retrying in $(( attempt * 5 ))s: $*" >&2; sleep $(( attempt * 5 )); attempt=$(( attempt + 1 )); done; }

# ── validate-host ───────────────────────────────────────────────────────────────────
. /etc/os-release
[ "\${ID:-}" = ubuntu ] || fail ubuntu-24.04
[ "\${VERSION_ID:-}" = ${shellQuote(WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION)} ] || fail ubuntu-24.04
# The pack LAYERS onto a bootstrapped host; it does not bootstrap one. Refusing here
# turns "desktops silently do not work" into one legible failure at install time.
[ -d ${shellQuote(WORKSPACE_HOST_RUNTIME_ROOT)} ] || fail host-bootstrapped
phase validate-host

# ── install-x-stack ─────────────────────────────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
# --error-on=any: an unreachable archive is otherwise only a warning with exit 0.
retry 10 apt_update -qq --error-on=any
# --no-install-recommends is what keeps this a PACK and not a desktop environment:
# several of these recommend a display manager, and a workspace host must never
# acquire a login screen as a side effect of opting into agent desktops.
retry 5 apt_install -y --no-install-recommends ${apt.join(' ')}

# The browser: Mozilla's real deb (see WORKSPACE_HOST_DESKTOP_BROWSER_REPO). The fingerprint
# is checked BEFORE the key is installed, for the same reason as the KasmVNC digest below.
# The pin outranks Ubuntu's snap stub, whose epoch makes its version compare higher.
install -d -m 0755 /etc/apt/keyrings
MOZ_KEY=/etc/apt/keyrings/packages.mozilla.org.asc
curl -fsSL --retry 3 ${WORKSPACE_HOST_CURL_STALL_GUARD} --proto '=https' --tlsv1.2 -o "$MOZ_KEY.tmp" ${shellQuote(browser.keyUrl)}
[ "$(gpg --show-keys --with-colons "$MOZ_KEY.tmp" | awk -F: '$1=="fpr"{print $10; exit}')" = ${shellQuote(browser.keyFingerprint)} ] \\
  || { rm -f "$MOZ_KEY.tmp"; fail browser; }
mv "$MOZ_KEY.tmp" "$MOZ_KEY"
chmod 0644 "$MOZ_KEY"
echo "deb [signed-by=$MOZ_KEY] ${browser.source}" > /etc/apt/sources.list.d/mozilla.list
printf 'Package: *\\nPin: origin ${browser.origin}\\nPin-Priority: 1000\\n' > /etc/apt/preferences.d/mozilla
retry 10 apt_update -qq --error-on=any
retry 5 apt_install -y --no-install-recommends ${browser.package}
phase install-x-stack

# ── install-kasmvnc ─────────────────────────────────────────────────────────────────
# Not in the Ubuntu archive, so fetch + verify by digest. The digest is checked BEFORE
# dpkg is allowed near the file: verifying afterwards would mean a substituted package
# had already run its maintainer scripts as root.
KASM_DEB="$(mktemp -t kasmvnc-XXXXXX.deb)"
trap 'rm -f "$KASM_DEB"' EXIT
curl -fsSL --retry 3 ${WORKSPACE_HOST_CURL_STALL_GUARD} --proto '=https' --tlsv1.2 -o "$KASM_DEB" "$KASM_URL"
echo "$KASM_SHA  $KASM_DEB" | sha256sum -c - >/dev/null 2>&1 || fail kasmvnc-digest
retry 5 apt_install -y --no-install-recommends "$KASM_DEB"
command -v Xkasmvnc >/dev/null 2>&1 || fail kasmvnc-binary
command -v kasmvncpasswd >/dev/null 2>&1 || fail kasmvnc-binary
phase install-kasmvnc

# ── harden-listener ─────────────────────────────────────────────────────────────────
# D-020. The package ships network.interface: 0.0.0.0; this is the override, and the
# check below re-reads the file rather than trusting that the write happened.
mkdir -p /etc/kasmvnc
cat > "$KASM_YAML" <<'KASMYAML'
# Papercusp desktop pack — MANAGED FILE, regenerated by the pack on every install.
# The listener is loopback-only by policy (D-020): sandbox desktops are reachable
# exclusively through the workspace-host operator's ticket-gated proxy, never
# directly. Widening the interface value here silently exposes every agent desktop on
# the VM's external interface, so the pack asserts this value as a named check.
network:
  interface: 127.0.0.1
  protocol: http
  ssl:
    require_ssl: false
desktop:
  allow_resize: true
  pixel_depth: 24
KASMYAML
chmod 0644 "$KASM_YAML"
grep -qE '^[[:space:]]+interface:[[:space:]]*127\\.0\\.0\\.1[[:space:]]*$' "$KASM_YAML" \\
  || fail loopback-only-listener
grep -qE '^[[:space:]]+interface:[[:space:]]*0\\.0\\.0\\.0' "$KASM_YAML" \\
  && fail loopback-only-listener
phase harden-listener

# ── create-desktop-identity ─────────────────────────────────────────────────────────
# A third identity, owning nothing but desktops. --no-create-home because the home is
# created explicitly below at 0700; letting adduser create it applies the skel and the
# default mode, which on this image is world-readable.
getent group "$DESKTOP_GROUP" >/dev/null || groupadd --system "$DESKTOP_GROUP"
getent passwd "$DESKTOP_USER" >/dev/null || useradd --system \\
  --gid "$DESKTOP_GROUP" --home-dir "$DESKTOP_ROOT" --no-create-home \\
  --shell /usr/sbin/nologin "$DESKTOP_USER"
install -d -o "$DESKTOP_USER" -g "$DESKTOP_GROUP" -m 0700 "$DESKTOP_ROOT"

# Ownership is NOT evidence of usability: \`install -d\` runs as root and succeeds even
# when every ancestor denies the owner traversal, which is exactly how a desktop root
# nested under the service user's 0750 state root passed every other check while being
# unwritable by the only account that ever needs it. Ask the desktop user directly.
runuser -u "$DESKTOP_USER" -- test -w "$DESKTOP_ROOT" || fail desktop-root-writable

# THE ISOLATION ASSERTIONS. Each is the negative form on purpose: "is not a member",
# "cannot read". A positive check ("the desktop user exists") passes just as happily
# on a host where someone added it to the workspace group for convenience.
[ "$(id -gn "$DESKTOP_USER")" = "$DESKTOP_GROUP" ] || fail desktop-identity
[ "$(getent passwd "$DESKTOP_USER" | cut -d: -f7)" = /usr/sbin/nologin ] || fail desktop-identity
id -nG "$DESKTOP_USER" | tr ' ' '\\n' | grep -qx "$WORKSPACE_USER" && fail workspace-credential-isolation
id -nG "$DESKTOP_USER" | tr ' ' '\\n' | grep -qx "$SERVICE_USER" && fail workspace-credential-isolation
id -nG "$DESKTOP_USER" | tr ' ' '\\n' | grep -qx "$AGENT_USER" && fail workspace-credential-isolation
# The decisive test is not group membership but reachability: prove the desktop user
# cannot actually read either protected home, whatever the groups happen to say.
#
# BOTH homes, since D-248. The workspace home holds the customer checkout and its git
# credentials; the AGENT home holds the delivered Claude/Codex/OMP material. They were one
# directory when this check was written, so checking only the workspace home would now pass
# while leaving the credentials this pack names in its own error message unguarded.
for protected_user in "$WORKSPACE_USER" "$AGENT_USER"; do
  protected_home="$(getent passwd "$protected_user" | cut -d: -f6 || true)"
  [ -n "\${protected_home:-}" ] || continue
  [ -d "$protected_home" ] || continue
  if runuser -u "$DESKTOP_USER" -- test -r "$protected_home" 2>/dev/null; then
    fail workspace-credential-isolation
  fi
done
phase create-desktop-identity

# ── install-desktop-runtime ────────────────────────────────────────────────────────
# Copy ONLY the self-contained worker and interpreter. Never grant desktop access to
# the service/agent homes, their groups, or the rest of the immutable runtime tree.
DESKTOP_LIB=/usr/local/lib/papercusp-desktop
install -d -o root -g root -m 0755 "$DESKTOP_LIB"
install -o root -g root -m 0755 ${shellQuote(`${WORKSPACE_HOST_RUNTIME_ROOT}/current/bin/node`)} "$DESKTOP_LIB/node"
install -o root -g root -m 0755 ${shellQuote(`${WORKSPACE_HOST_RUNTIME_ROOT}/current/${WORKSPACE_HOST_DESKTOP_SESSION_ENTRYPOINT}`)} "$DESKTOP_LIB/session.cjs"
runuser -u "$DESKTOP_USER" -- env -i HOME="$DESKTOP_ROOT" PATH=/usr/bin:/bin \\
  "$DESKTOP_LIB/node" "$DESKTOP_LIB/session.cjs" --check || fail desktop-runtime

# Loopback HTTP is privileged operator authority. UID/home isolation alone is
# insufficient when desktop apps can call it. Keep DNS and viewer REPLIES, while
# refusing desktop-origin connections to local services and metadata endpoints.
DESKTOP_UID="$(id -u "$DESKTOP_USER")"
install -d -o root -g root -m 0755 /etc/papercusp
cat > /etc/papercusp/desktop-egress.nft <<NFT
${buildWorkspaceDesktopEgressRules('$DESKTOP_UID')}NFT
chmod 0644 /etc/papercusp/desktop-egress.nft
nft -f /etc/papercusp/desktop-egress.nft || fail desktop-egress-isolation
nft list chain inet papercusp_desktop output >/dev/null || fail desktop-egress-isolation

# The socket carries NO ordering or requirement on papercusp-workspace.service (D-439).
# A default-dependency socket is Before=sockets.target, and every ordinary service is
# After=basic.target, which is After=sockets.target — so After= that service closes a
# cycle. systemd breaks it at boot by deleting the socket's start job: the socket was
# live after install (started by hand below) and silently gone after the first reboot.
# The coupling to the workspace service lives on the per-connection @.service instead.
cat > /etc/systemd/system/papercusp-desktop.socket <<UNIT
[Unit]
Description=Papercusp isolated desktop session admission
[Socket]
ListenStream=/run/papercusp-desktop/session.sock
SocketUser=root
SocketGroup=$SERVICE_USER
SocketMode=0660
DirectoryMode=0755
Accept=yes
MaxConnections=64
RemoveOnStop=yes
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/papercusp-desktop@.service <<UNIT
[Unit]
Description=Papercusp isolated desktop session
After=papercusp-workspace.service
BindsTo=papercusp-workspace.service
JoinsNamespaceOf=papercusp-workspace.service
[Service]
Type=exec
User=$DESKTOP_USER
Group=$DESKTOP_GROUP
WorkingDirectory=$DESKTOP_ROOT
Environment=HOME=$DESKTOP_ROOT
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=LANG=C.UTF-8
# XFCE Terminal uses SHELL, then the passwd shell. Keep the account nologin for
# authentication while giving terminal windows an interactive shell.
Environment=SHELL=/bin/bash
# Reapply the fixed root-owned rules before ANY worker, including after a reboot.
ExecStartPre=+/usr/sbin/nft -f /etc/papercusp/desktop-egress.nft
ExecStart=$DESKTOP_LIB/node $DESKTOP_LIB/session.cjs --stdio
StandardInput=socket
StandardOutput=inherit
StandardError=journal
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=$DESKTOP_ROOT
InaccessiblePaths=${WORKSPACE_HOST_STATE_ROOT} /srv/papercusp/workspaces
RestrictSUIDSGID=true
LockPersonality=true
UMask=0077
KillMode=control-group
TimeoutStopSec=5s
UNIT
chmod 0644 /etc/systemd/system/papercusp-desktop.socket /etc/systemd/system/papercusp-desktop@.service
systemd-analyze verify /etc/systemd/system/papercusp-desktop.socket /etc/systemd/system/papercusp-desktop@.service
systemctl daemon-reload
systemctl enable --now papercusp-desktop.socket
systemctl is-active --quiet papercusp-desktop.socket || fail desktop-socket
[ -S /run/papercusp-desktop/session.sock ] || fail desktop-socket
[ "$(stat -c %a /run/papercusp-desktop/session.sock)" = 660 ] || fail desktop-socket
phase install-desktop-runtime

# ── attest-pack ─────────────────────────────────────────────────────────────────────
command -v openbox   >/dev/null 2>&1 || fail x-stack
command -v xdotool   >/dev/null 2>&1 || fail x-stack
command -v import    >/dev/null 2>&1 || fail x-stack
command -v bwrap     >/dev/null 2>&1 || fail x-stack
command -v xsetroot  >/dev/null 2>&1 || fail x-stack
# The name openbox's stock menu executes, not merely the package that should provide it.
command -v x-terminal-emulator >/dev/null 2>&1 || fail x-stack
command -v dbus-daemon >/dev/null 2>&1 || fail a11y-stack
[ -f /usr/lib/at-spi2-core/at-spi-bus-launcher ] || [ -f /usr/libexec/at-spi-bus-launcher ] || fail a11y-stack
command -v glxinfo >/dev/null 2>&1 || fail gl-stack
# The binaries the hosted worker's XFCE session execs, not the package names.
for bin in xfce4-session xfwm4 xfce4-panel xfdesktop xfsettingsd xfce4-terminal thunar dbus-run-session; do
  command -v "$bin" >/dev/null 2>&1 || fail desktop-environment
done
# Mozilla's build, not the stub: the stub's /usr/bin/firefox only execs snap.
command -v firefox >/dev/null 2>&1 || fail browser
case "$(dpkg-query -W -f='\${Version}' firefox)" in *snap*) fail browser ;; esac

printf '${WORKSPACE_HOST_DESKTOP_PACK_ATTESTATION_PREFIX}%s\\n' "$(cat <<JSON | tr -d '\\n'
{"contractVersion":"${WORKSPACE_HOST_DESKTOP_PACK_CONTRACT_VERSION}",
"hostId":"$HOST_ID","action":"${input.action}",
"ubuntuVersion":"${WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION}",
"observedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","status":"healthy",
"kasmvnc":{"version":"$KASM_VERSION","sha256":"$KASM_SHA"},
"checks":[${WORKSPACE_HOST_DESKTOP_PACK_CHECKS.map((c) => `{"name":"${c}","ok":true}`).join(',')}]}
JSON
)"
phase attest-pack
`;

  return { script, phases: WORKSPACE_HOST_DESKTOP_PACK_PHASES };
}

/**
 * Parse the attestation line the script prints.
 *
 * Refuses anything that is not a COMPLETE, healthy attestation naming every declared
 * check: a partial run that printed a truncated line must read as a failure, not as a
 * pack that installed slightly less. The check list is compared as a SET against
 * `WORKSPACE_HOST_DESKTOP_PACK_CHECKS`, so adding a check to the contract without
 * teaching the script to emit it fails here rather than silently weakening the bar.
 */
export function parseWorkspaceHostDesktopPackAttestation(
  output: string,
): WorkspaceHostDesktopPackAttestation {
  const line = output
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith(WORKSPACE_HOST_DESKTOP_PACK_ATTESTATION_PREFIX));
  if (!line) {
    throw new Error('Desktop pack produced no attestation line');
  }
  let parsed: WorkspaceHostDesktopPackAttestation;
  try {
    parsed = JSON.parse(
      line.slice(WORKSPACE_HOST_DESKTOP_PACK_ATTESTATION_PREFIX.length),
    ) as WorkspaceHostDesktopPackAttestation;
  } catch {
    throw new Error('Desktop pack attestation is not valid JSON');
  }
  if (parsed.contractVersion !== WORKSPACE_HOST_DESKTOP_PACK_CONTRACT_VERSION) {
    throw new Error('Desktop pack attestation reports a different contract version');
  }
  if (parsed.status !== 'healthy') {
    throw new Error(`Desktop pack attestation status is ${String(parsed.status)}`);
  }
  assertWorkspaceHostSecretIsolation(parsed, 'desktopPack.attestation');

  const observed = new Set((parsed.checks ?? []).filter((c) => c?.ok === true).map((c) => c.name));
  const missing = WORKSPACE_HOST_DESKTOP_PACK_CHECKS.filter((c) => !observed.has(c));
  if (missing.length > 0) {
    throw new Error(`Desktop pack attestation is missing checks: ${missing.join(', ')}`);
  }
  return parsed;
}
