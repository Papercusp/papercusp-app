/**
 * The scoped AppArmor grant that lets an UNPRIVILEGED bubblewrap create a user namespace, and the
 * probe that proves a host can (WI-10004636, split from WI-10004618).
 *
 * Why it exists. Ubuntu 23.10+ (24.04 included) boots with
 * `kernel.apparmor_restrict_unprivileged_userns=1`: an unconfined process may still call
 * `unshare(CLONE_NEWUSER)`, but it gets a namespace with no capabilities, so bwrap's loopback setup
 * fails (`loopback: Failed RTM_NEWADDR: Operation not permitted`, measured on a fresh GCE 24.04.5
 * VM 2026-10-01). Codex's `workspace-write` sandbox runs every tool command through bwrap, so on
 * such a host EVERY command fails while the run itself reports success — the model sees the
 * failures as tool output and nothing else surfaces them (plan agent-capacity-and-cost-gcp-
 * 2026-09-30, D-012).
 *
 * The fix grants `userns` to exactly `/usr/bin/bwrap`; the global restriction stays on for every
 * other binary. Ubuntu's own `bwrap-userns-restrict` profile is NOT a substitute: it strips
 * capabilities from bwrap's children, which breaks the same loopback setup (openai/codex#12572).
 *
 * THREE copies of the profile body exist, because three installers that share no build graph
 * install it: this module (hosted workspace hosts), `papercusp-desktop/src-tauri/deb/postinstall.sh`
 * (the Server .deb, a separate submodule) and `scripts/agent-capacity/vm/bootstrap-agent-vm.sh`
 * (capacity-test VMs). They are PINNED to one another by
 * `packages/operator-core/lib/doc-claims/bwrap-userns-grant-parity.test.ts`, so editing one copy
 * without the others fails the build instead of drifting.
 */

export const BWRAP_BIN = '/usr/bin/bwrap';
export const APPARMOR_PROFILE_DIR = '/etc/apparmor.d';
export const APPARMOR_RESTRICT_UNPRIVILEGED_USERNS_SYSCTL =
  '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';

/** The profile body, one line per element, for a given bwrap path. */
export function bwrapUsernsAppArmorProfileLines(bwrapBin: string = BWRAP_BIN): readonly string[] {
  return [
    'abi <abi/4.0>,',
    'include <tunables/global>',
    '',
    `profile bwrap ${bwrapBin} flags=(unconfined) {`,
    '  userns,',
    '',
    '  include if exists <local/bwrap>',
    '}',
  ];
}

/**
 * The probe: create exactly the namespaces Codex's sandbox creates (user, pid, net) and run
 * `true`. It fails on a host where unprivileged bwrap cannot get a usable user namespace, which
 * is the one property the grant exists to establish. `--chdir /` keeps it independent of the
 * caller's working directory (a bootstrap running as root may sit in a directory the probed
 * account cannot enter).
 */
export const BWRAP_USERNS_PROBE_ARGS = [
  '--ro-bind', '/', '/',
  '--dev', '/dev',
  '--proc', '/proc',
  '--unshare-user',
  '--unshare-pid',
  '--unshare-net',
  '--chdir', '/',
  'true',
] as const;

/** Name of the bash function `bwrapUsernsGrantShellLines` defines. */
export const BWRAP_USERNS_GRANT_FUNCTION = 'install_bwrap_userns_profile';

/**
 * Bash lines that define `install_bwrap_userns_profile <aa_dir> <restrict_sysctl> <bwrap_bin>`.
 * The caller decides whether and when to invoke it. Same rules as the .deb postinst it mirrors:
 *
 * - Only a kernel that HAS the restriction needs (or can parse) the grant; without the sysctl,
 *   an executable bwrap, the profile directory and `apparmor_parser`, it changes nothing.
 * - Someone else's `<aa_dir>/bwrap` (no `marker` line) and any other profile that already attaches
 *   to the bwrap binary are left alone.
 * - A profile the parser rejects is removed again, so a broken grant never lingers.
 *
 * It ALWAYS returns 0 — whether the host can actually sandbox is decided by the probe, never by
 * whether this function thinks it succeeded. It uses `printf`, not a heredoc, so the lines stay
 * valid however a renderer indents or joins them.
 */
export function bwrapUsernsGrantShellLines(marker: string): readonly string[] {
  if (/['\n]/.test(marker)) throw new Error('bwrap grant marker must not contain a single quote or newline');
  const profileArgs = bwrapUsernsAppArmorProfileLines('$bwrap_bin')
    .map((line) => (line.includes('$bwrap_bin') ? `"${line}"` : `'${line}'`))
    .join(' ');
  return [
    `${BWRAP_USERNS_GRANT_FUNCTION}() {`,
    '  local aa_dir="$1" restrict_sysctl="$2" bwrap_bin="$3" profile other',
    `  local marker='${marker}'`,
    '  profile="$aa_dir/bwrap"',
    '  [[ -e "$restrict_sysctl" ]] || return 0',
    '  [[ -x "$bwrap_bin" ]] || return 0',
    '  [[ -d "$aa_dir" ]] || return 0',
    '  command -v apparmor_parser >/dev/null 2>&1 || return 0',
    '  if [[ -e "$profile" ]] && ! grep -qF "$marker" "$profile" 2>/dev/null; then return 0; fi',
    '  for other in "$aa_dir"/*; do',
    '    [[ -f "$other" && "$other" != "$profile" ]] || continue',
    '    if grep -qE "^[[:space:]]*(profile[[:space:]]+[^[:space:]]+[[:space:]]+)?$bwrap_bin[[:space:]]+(flags=|\\{)" "$other" 2>/dev/null; then return 0; fi',
    '  done',
    `  printf '%s\\n' "$marker" ${profileArgs} > "$profile" || { rm -f "$profile"; return 0; }`,
    '  if ! apparmor_parser -r "$profile" >/dev/null 2>&1; then',
    '    rm -f "$profile"',
    '    printf "%s\\n" "WARN: AppArmor rejected the bwrap userns profile $profile" >&2',
    '  fi',
    '  return 0',
    '}',
  ];
}
