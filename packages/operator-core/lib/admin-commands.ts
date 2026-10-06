/**
 * Server-side allowlist for /admin ops dashboard.
 *
 * Client only sends a `cmd` id. Server resolves to the actual shell
 * command. Adding a new entry here is the only way to expose a
 * command — there's no path that lets the client pass raw shell.
 *
 * NOTHING HERE MAY NAME A PARTICULAR MACHINE (WI-4419). These commands used to
 * hardcode one box's home (`/home/<user>/...`), its VM ssh keys and the VM
 * account name. That was wrong twice over: wrong on every checkout that isn't
 * that box, and — since this file ships inside the release bundle's source drop
 * — it leaked the owner's identity to everyone we hand a build to. So the repo
 * paths are DERIVED and the VM targets are MACHINE-LOCAL CONFIG, read at run
 * time from `~/.papercusp/build-vms.env` (git-ignored, like `r2.env` and
 * `release-host.env` beside it).
 */
import { homedir } from 'node:os';
import path from 'node:path';

import { desktopRoot, integrationRoot } from './release-cut-launch';

export interface AdminCommand {
  id: string;
  label: string;
  section: 'building' | 'running' | 'simulators' | 'packaged-build';
  description?: string;
  command: string;
  cwd?: string;
}

const PAPERCUSP_REPO = integrationRoot();
const PAPERCUSP_DESKTOP = desktopRoot();

/** Where a VM build drops the installer it just built. */
const ARTIFACT_DIR = process.env.PAPERCUSP_ARTIFACT_DIR ?? homedir();

/**
 * Prelude for every command that talks to a build VM: load the machine's own VM
 * config and construct $SSH_MAC / $SSH_WIN from it. Missing config FAILS LOUD
 * with the fix, rather than silently ssh-ing at whatever the defaults happened
 * to be — a wrong-host build is worse than no build.
 */
const LOAD_VM_ENV = `VM_ENV="$HOME/.papercusp/build-vms.env"
if [ ! -f "$VM_ENV" ]; then
  echo "ERROR: no $VM_ENV — the build VMs are machine-local config, not repo constants." >&2
  echo "Create it (chmod 600) with, e.g.:" >&2
  echo "  VM_MAC_SSH_KEY=\\$HOME/.ssh/papercup-vm-mac" >&2
  echo "  VM_MAC_USER=<the mac VM account>" >&2
  echo "  VM_WIN_SSH_KEY=\\$HOME/.ssh/papercup-vm-win" >&2
  echo "  VM_WIN_USER=<the windows VM account>" >&2
  exit 1
fi
. "$VM_ENV"
: "\${VM_MAC_SSH_KEY:?set VM_MAC_SSH_KEY in $VM_ENV}"; : "\${VM_MAC_USER:?set VM_MAC_USER in $VM_ENV}"
: "\${VM_WIN_SSH_KEY:?set VM_WIN_SSH_KEY in $VM_ENV}"; : "\${VM_WIN_USER:?set VM_WIN_USER in $VM_ENV}"
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
MAC_PORT="\${VM_MAC_PORT:-2222}"; MAC_HOST="\${VM_MAC_HOST:-127.0.0.1}"
WIN_PORT="\${VM_WIN_PORT:-2223}"; WIN_HOST="\${VM_WIN_HOST:-127.0.0.1}"
SSH_MAC="ssh -i $VM_MAC_SSH_KEY -p $MAC_PORT $SSH_OPTS $VM_MAC_USER@$MAC_HOST"
SSH_WIN="ssh -i $VM_WIN_SSH_KEY -p $WIN_PORT $SSH_OPTS $VM_WIN_USER@$WIN_HOST"`;

export const ADMIN_COMMANDS: AdminCommand[] = [
  // ── Building ─────────────────────────────────────────────
  {
    id: 'build-linux-prod',
    label: 'Linux Prod Build',
    section: 'building',
    description: 'Builds the Linux .deb / .rpm desktop bundles on this host. Audits the bundle for PostHog leaks at the end.',
    command: `set -e
echo "=== npm run build (tauri build)"
npm run build 2>&1 | tail -200
echo "=== audit-bundle.sh"
DEB="${PAPERCUSP_DESKTOP}/src-tauri/target/release/bundle/deb/Papercusp_0.0.1_amd64.deb"
RPM="${PAPERCUSP_DESKTOP}/src-tauri/target/release/bundle/rpm/Papercusp-0.0.1-1.x86_64.rpm"
[ -f "$DEB" ] && ${PAPERCUSP_DESKTOP}/bin/audit-bundle.sh "$DEB"
[ -f "$RPM" ] && ${PAPERCUSP_DESKTOP}/bin/audit-bundle.sh "$RPM"
echo "=== build + audit complete"`,
    cwd: PAPERCUSP_DESKTOP,
  },
  {
    id: 'build-mac-prod',
    label: 'Mac Prod Build',
    section: 'building',
    description: 'Rsyncs the canonical tree into the Mac VM (~/papercup-build-mac) and builds the UNIVERSAL .dmg via bin/mac-vm-build.sh (term shim + sidecar + tauri). ~30–45 min. Copies the .dmg back to the artifact dir and runs the privacy auditor.',
    command: `set -e
${LOAD_VM_ENV}
echo "=== rsync tree → VM:papercup-build-mac/papercup"
rsync -az --delete --exclude .git --exclude node_modules --exclude target --exclude .turbo --exclude .next -e "ssh -i $VM_MAC_SSH_KEY -p $MAC_PORT $SSH_OPTS" ${PAPERCUSP_REPO}/ "$VM_MAC_USER@$MAC_HOST:papercup-build-mac/papercup/"
SIGNING_KEY="$HOME/.papercusp/signing/papercusp.key"
if [ -f "$SIGNING_KEY" ]; then
  scp -i "$VM_MAC_SSH_KEY" -P "$MAC_PORT" $SSH_OPTS "$SIGNING_KEY" "$VM_MAC_USER@$MAC_HOST:.papercusp-updater.key"
fi
echo "=== mac build via $SSH_MAC"
$SSH_MAC 'bash -lc "set -e
   cd ~/papercup-build-mac/papercup/papercusp-desktop
   NODE_OPTIONS=--max-old-space-size=8192 npm install --legacy-peer-deps 2>&1 | tail -5
   export TAURI_SIGNING_PRIVATE_KEY_PATH=\\$HOME/.papercusp-updater.key TAURI_SIGNING_PRIVATE_KEY_PASSWORD=
   bash bin/mac-vm-build.sh 2>&1 | tail -200"' 2>&1
echo "=== scp dmg back"
scp -i "$VM_MAC_SSH_KEY" -P "$MAC_PORT" $SSH_OPTS "$VM_MAC_USER@$MAC_HOST:papercup-build-mac/papercup/papercusp-desktop/src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg" "${ARTIFACT_DIR}/"
echo "=== audit"
${PAPERCUSP_DESKTOP}/bin/audit-bundle.sh ${ARTIFACT_DIR}/Papercusp_*_universal.dmg
echo "=== mac build + audit complete"`,
  },
  {
    id: 'build-windows-prod',
    label: 'Windows Prod Build',
    section: 'building',
    description: 'Builds the Windows .msi / .exe inside the Windows VM (%USERPROFILE%\\papercupai\\papercusp-desktop). ~30–45 min. Copies the artifacts back to the artifact dir and runs the privacy auditor.',
    command: `set -e
${LOAD_VM_ENV}
echo "=== win build via $SSH_WIN"
$SSH_WIN "powershell -NoProfile -ExecutionPolicy Bypass -File win-build.ps1" 2>&1 | tail -200
echo "=== scp msi+exe back"
scp -i "$VM_WIN_SSH_KEY" -P "$WIN_PORT" $SSH_OPTS "$VM_WIN_USER@$WIN_HOST:papercupai/papercusp-desktop/src-tauri/target/release/bundle/msi/Papercusp_0.0.1_x64_en-US.msi" "${ARTIFACT_DIR}/"
scp -i "$VM_WIN_SSH_KEY" -P "$WIN_PORT" $SSH_OPTS "$VM_WIN_USER@$WIN_HOST:papercupai/papercusp-desktop/src-tauri/target/release/bundle/nsis/Papercusp_0.0.1_x64-setup.exe" "${ARTIFACT_DIR}/"
echo "=== audit"
${PAPERCUSP_DESKTOP}/bin/audit-bundle.sh ${ARTIFACT_DIR}/Papercusp_0.0.1_x64_en-US.msi ${ARTIFACT_DIR}/Papercusp_0.0.1_x64-setup.exe
echo "=== win build + audit complete"`,
  },
  {
    id: 'rebuild-3070',
    label: 'Rebuild 3070 host',
    section: 'building',
    description: 'Runs bin/prod: builds the operator (Starlight docs + Vite SPA) and restarts the Hono host on :3070. Survives this stream — server keeps running after you Stop.',
    command: 'bin/prod 2>&1',
    cwd: PAPERCUSP_REPO,
  },

  // ── Running ──────────────────────────────────────────────
  {
    id: 'install-linux-deb',
    label: 'Install + launch Linux .deb',
    section: 'running',
    description: 'Installs the latest local .deb (requires NOPASSWD sudo for dpkg) and launches the installed binary.',
    command: `set -e; DEB="${PAPERCUSP_DESKTOP}/src-tauri/target/release/bundle/deb/Papercusp_0.0.1_amd64.deb"; echo "==> installing $DEB"; sudo -n dpkg -i "$DEB" 2>&1; echo "==> launching Papercusp"; setsid /usr/bin/papercusp >/dev/null 2>&1 < /dev/null & echo "launched pid $!"`,
  },
  {
    id: 'install-mac-dmg',
    label: 'Install + launch Mac .dmg',
    section: 'running',
    description: 'Mounts the DMG, copies Papercusp.app to /Applications, strips quarantine, and launches it in the Mac VM.',
    command: `set -e
${LOAD_VM_ENV}
$SSH_MAC 'bash -lc "set -e; DMG=~/Papercusp_0.0.1_x86_64.dmg; echo \\"==> mounting $DMG\\"; hdiutil attach \\"$DMG\\" -nobrowse; echo \\"==> copying to /Applications\\"; rm -rf /Applications/Papercusp.app; cp -R /Volumes/Papercusp/Papercusp.app /Applications/; hdiutil detach /Volumes/Papercusp; xattr -dr com.apple.quarantine /Applications/Papercusp.app; echo \\"==> launching\\"; open /Applications/Papercusp.app; echo done"' 2>&1`,
  },
  {
    id: 'install-windows-msi',
    label: 'Install + launch Windows .msi',
    section: 'running',
    description: 'Runs msiexec /i silent + launches Papercusp.exe in the Windows VM.',
    command: `set -e
${LOAD_VM_ENV}
$SSH_WIN "powershell -NoProfile -Command \\"& { \\$msi = \\"\\$env:USERPROFILE\\\\papercusp-desktop\\\\src-tauri\\\\target\\\\release\\\\bundle\\\\msi\\\\Papercusp_0.0.1_x64_en-US.msi\\" ; Write-Host '==> installing' \\$msi ; Start-Process -Wait msiexec -ArgumentList '/i', \\$msi, '/quiet' ; Write-Host '==> launching' ; Start-Process 'C:\\\\Program Files\\\\Papercusp\\\\Papercusp.exe' ; Write-Host 'done' }\\"" 2>&1`,
  },
  {
    id: 'launch-linux-dev',
    label: 'Launch Linux Desktop DEV',
    section: 'running',
    description: 'Starts `npm run dev` in papercusp-desktop (Tauri dev mode against :3055). Server keeps running after you Stop the stream.',
    command: `setsid bash -c 'cd ${PAPERCUSP_DESKTOP} && npm run dev' </dev/null >/tmp/papercusp-desktop-dev.log 2>&1 & disown; echo "==> launched pid $!"; echo "==> tailing /tmp/papercusp-desktop-dev.log"; sleep 1; tail -n+1 -F /tmp/papercusp-desktop-dev.log`,
  },
  {
    id: 'restart-3055',
    label: 'Restart dev stack (3055 + 3070)',
    section: 'running',
    description: 'Restarts the operator dev stack — papercup-dev (Vite frontend on :3055) and papercusp-dev-api (Hono on :3070). The /admin page goes offline for a few seconds while the Hono host re-imports; the Vite side comes back via HMR almost immediately.',
    command: 'bin/dev 2>&1',
    cwd: PAPERCUSP_REPO,
  },
  {
    id: 'audit-prod-bundles',
    label: 'Audit prod bundles for PostHog leaks',
    section: 'running',
    description: 'Runs bin/audit-bundle.sh against any prod artifacts present in the artifact dir + the local Linux .deb/.rpm. Fails loud if any artifact contains posthog.json, posthog-personal.json, or PAPERCUSP_POSTHOG_* env vars.',
    command: `set -e
ARTIFACTS=()
DEB="${PAPERCUSP_DESKTOP}/src-tauri/target/release/bundle/deb/Papercusp_0.0.1_amd64.deb"
RPM="${PAPERCUSP_DESKTOP}/src-tauri/target/release/bundle/rpm/Papercusp-0.0.1-1.x86_64.rpm"
DMG=${ARTIFACT_DIR}/Papercusp_0.0.1_x86_64.dmg
MSI=${ARTIFACT_DIR}/Papercusp_0.0.1_x64_en-US.msi
EXE=${ARTIFACT_DIR}/Papercusp_0.0.1_x64-setup.exe
for a in "$DEB" "$RPM" "$DMG" "$MSI" "$EXE"; do
  [ -f "$a" ] && ARTIFACTS+=("$a") && echo "found: $a ($(du -h "$a" | cut -f1))" || echo "missing: $a"
done
echo "---"
if [ \${#ARTIFACTS[@]} -eq 0 ]; then echo "no artifacts to scan"; exit 1; fi
${PAPERCUSP_DESKTOP}/bin/audit-bundle.sh "\${ARTIFACTS[@]}"`,
  },
  {
    id: 'env-probe',
    label: 'Env probe',
    section: 'running',
    description: 'Prints a handful of env vars from your interactive shell config (NVM, BUN, COMPOSIO, HINDSIGHT_API_URL, CLOUDFLARE_API_TOKEN). Useful for diagnosing "command can\'t find X" issues.',
    command: 'echo "PATH=$PATH"; echo "NVM=$(type -t nvm 2>/dev/null)"; echo "NODE=$(which node)"; echo "BUN_INSTALL=$BUN_INSTALL"; echo "COMPOSIO_INSTALL_DIR=$COMPOSIO_INSTALL_DIR"; echo "HINDSIGHT_API_URL=$HINDSIGHT_API_URL"; echo "ELEVENLABS_API_KEY=$(test -n "$ELEVENLABS_API_KEY" && echo set || echo unset)"; echo "CLOUDFLARE_API_TOKEN=$(test -n "$CLOUDFLARE_API_TOKEN" && echo set || echo unset)"; echo "ANTHROPIC_API_KEY=$(test -n "$ANTHROPIC_API_KEY" && echo set || echo unset)"; echo "OPENAI_API_KEY=$(test -n "$OPENAI_API_KEY" && echo set || echo unset)"',
  },

  // ── Simulators ───────────────────────────────────────────
  // ── Packaged build (wdio + tauri-driver against the shipped binary) ──
  {
    id: 'wdio-install',
    label: 'Install wdio deps (one-time)',
    section: 'packaged-build',
    description: 'Runs `npm install` in tools/perf-test/wdio. Kept out of the pnpm workspace on purpose — wdio postinstall doesn\'t play nicely with hoisting.',
    command: 'npm install 2>&1',
    cwd: `${PAPERCUSP_REPO}/tools/perf-test/wdio`,
  },
  {
    id: 'wdio-test',
    label: 'Run wdio test against packaged binary',
    section: 'packaged-build',
    description: 'Spawns tauri-driver on :4445 and drives the latest packaged Tauri binary via WebDriver. Runs `specs/*.spec.ts`. Prereqs: `Linux Prod Build` produced an artifact, `webkit2gtk-driver` is installed (sudo apt), and `Install wdio deps` was run once.',
    command: 'npm test 2>&1',
    cwd: `${PAPERCUSP_REPO}/tools/perf-test/wdio`,
  },
  {
    id: 'wdio-webkit-driver-check',
    label: 'Check webkit2gtk-driver',
    section: 'packaged-build',
    description: 'Reports whether `WebKitWebDriver` is on PATH (required for tauri-driver on Linux). If missing: `sudo apt install webkit2gtk-driver`.',
    command: `if command -v WebKitWebDriver >/dev/null 2>&1; then echo "WebKitWebDriver: $(WebKitWebDriver --version 2>&1 | head -1) at $(command -v WebKitWebDriver)"; else echo "WebKitWebDriver: MISSING — install with: sudo apt install webkit2gtk-driver"; exit 1; fi`,
  },

  {
    id: 'launch-android-emulator',
    label: 'Launch Android emulator',
    section: 'simulators',
    description: 'Boots the papercusp-test AVD on this Linux host. Runs detached — survives Stop. After boot, `adb devices` shows emulator-5554.',
    command: `setsid bash -c '$HOME/Android/Sdk/emulator/emulator -avd papercusp-test -no-snapshot-load -no-audio' </dev/null >/tmp/android-emulator.log 2>&1 & disown; echo "==> launched pid $!"; echo "==> avd=papercusp-test"; echo "==> tailing /tmp/android-emulator.log"; sleep 1; tail -n+1 -F /tmp/android-emulator.log`,
  },
  {
    id: 'start-mac-vm',
    label: 'Start macOS VM',
    section: 'simulators',
    description: 'Boots the macOS VM (QEMU + SPICE on :5930). ~60–120s to be SSH-ready. Skip if it\'s already up.',
    // EI-18666147162251862: this used to be a bare `pgrep -f "qemu.*mac_hdd_ng"`. This
    // command runs as `bash -lic '<the whole command string>'` (see admin/run.ts), so
    // the invoking shell's OWN cmdline contains that pattern literally (it's the pgrep
    // argument itself) — and `pgrep -f` matches every process system-wide, not just
    // descendants, so it ALWAYS self-matched its own wrapper and reported "already
    // running" even on a cold box, silently skipping the `systemctl --user start`
    // below every single time. Confirmed reproducible: `bash -c 'pgrep -f
    // "definitely-not-a-real-process-zzqq" >/dev/null && echo MATCHED'` prints MATCHED.
    // scripts/proc-guard.mjs excludes the caller's own ancestor chain before matching,
    // so it only reports a REAL external qemu process.
    command: `if node "${PAPERCUSP_REPO}/scripts/proc-guard.mjs" check "qemu.*mac_hdd_ng"; then exit 0; fi; systemctl --user start papercup-vm-mac.service && echo "==> started papercup-vm-mac.service (boot-sonoma-durable.sh)"; echo "==> SPICE: remote-viewer spice://127.0.0.1:5930"; echo "==> tailing qemu log (Stop when SSH is ready)"; sleep 2; tail -n+1 -F $HOME/macos-vm/OSX-KVM/logs/qemu-current.log`,
  },
  {
    id: 'launch-ios-simulator',
    label: 'Launch iOS simulator (iPhone 16)',
    section: 'simulators',
    description: 'SSH Mac VM → xcrun simctl boot "iPhone 16" + open Simulator.app. Requires the macOS VM running; view via `remote-viewer spice://127.0.0.1:5930`.',
    command: `set -e
${LOAD_VM_ENV}
$SSH_MAC 'bash -lc "set -e; DEVICE=\\"iPhone 16\\"; echo \\"==> booting $DEVICE\\"; xcrun simctl boot \\"$DEVICE\\" 2>&1 | grep -v \\"Booted\\" || true; echo \\"==> opening Simulator.app\\"; open -a Simulator; sleep 2; echo \\"==> booted devices:\\"; xcrun simctl list devices booted; echo \\"==> done — view via SPICE on :5930\\""' 2>&1`,
  },
  {
    id: 'ios-simulator-list',
    label: 'List iOS simulator devices',
    section: 'simulators',
    description: 'Shows all available iOS simulator devices on the Mac VM. Use device names from here in custom xcrun simctl boot runs.',
    command: `set -e
${LOAD_VM_ENV}
$SSH_MAC "xcrun simctl list devices available iOS" 2>&1`,
  },
];


export function getCommand(id: string): AdminCommand | null {
  return ADMIN_COMMANDS.find((c) => c.id === id) ?? null;
}

export function listCommands(): AdminCommand[] {
  return ADMIN_COMMANDS;
}
