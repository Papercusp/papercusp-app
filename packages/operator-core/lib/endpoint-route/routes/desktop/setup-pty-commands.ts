/**
 * GET /api/desktop/setup-pty-commands — platform-correct spawn opts for
 * the Setup Wizard's inline pty terminals (install + sign-in flows).
 *
 * Ported from app/api/desktop/setup-pty-commands/route.ts. `auth: {}`.
 */
import { platform, homedir, arch as osArch } from 'node:os';
import { join as joinPath } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';
import { detectBinaries } from '../../../agent-bin-detect';
import { allowedFrameworks, type OnboardingFramework } from '../../../onboarding/stage-resolver';

const CODEX_PACKAGE = '@openai/codex';

// oh-my-pi (binary `omp`) has NO live npm package (`oh-my-pi` was unpublished
// 2026-05-21; `@oh-my-pi/cli` never existed — a dead ref there 404s). It ships
// as a prebuilt binary on github.com/can1357/oh-my-pi releases (the SAME asset
// the desktop sidecar bundles), so we install it by downloading that binary
// directly into a PATH+detected location — no Homebrew/npm needed, uniform on
// every OS. ⚠ KEEP OMP_VERSION in sync with the sidecar bundle pin in
// papercusp-desktop/bin/build-desktop-sidecar.sh (OMP_VERSION).
const OMP_VERSION = 'v14.5.14';
const OMP_RELEASE_BASE = `https://github.com/can1357/oh-my-pi/releases/download/${OMP_VERSION}`;

/**
 * The oh-my-pi release asset filename for an OS+arch, or null when upstream ships
 * no build for it. Upstream publishes omp-{darwin,linux}-{x64,arm64} and a single
 * omp-windows-x64.exe. `os` is `process.platform`, `arch` is `os.arch()`. Pure.
 */
export function ompReleaseAsset(os: string, arch: string): string | null {
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  if (os === 'darwin') return `omp-darwin-${a}`;
  if (os === 'linux') return `omp-linux-${a}`;
  if (os === 'win32') return 'omp-windows-x64.exe'; // upstream ships x64 only on Windows
  return null;
}

/** Full download URL for the current host's omp asset (null when unsupported). Pure. */
export function ompDownloadUrl(os: string, arch: string): string | null {
  const asset = ompReleaseAsset(os, arch);
  return asset ? `${OMP_RELEASE_BASE}/${asset}` : null;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/**
 * Build the install spawn spec for a given OS. Pure — `os` is the value
 * of `process.platform` and `home` is the user's home dir.
 */
export function buildInstallSpec(os: string, home: string): SpawnSpec {
  if (os === 'win32') {
    const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Write-Host '==> installing Claude Code'
Invoke-WebRequest -UseBasicParsing -Uri https://claude.ai/install.ps1 | Select-Object -ExpandProperty Content | Invoke-Expression
Write-Host '==> bootstrapping runtime'
$runtime = Join-Path $env:USERPROFILE '.papercusp\\runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
@'
{ "name":"papercusp-runtime","version":"0.0.0","private":true,
  "dependencies":{"${CODEX_PACKAGE}":"latest"} }
'@ | Set-Content -Path (Join-Path $runtime 'package.json') -Encoding UTF8
Write-Host '==> installing codex'
npm install --prefix $runtime --no-audit --no-fund
Write-Host '==> done'
`;
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      cwd: home,
      env: {},
    };
  }
  const script = `set -e
echo '==> installing Claude Code'
curl -fsSL https://claude.ai/install.sh | bash
echo '==> bootstrapping runtime'
mkdir -p ~/.papercusp/runtime
cat > ~/.papercusp/runtime/package.json <<JSON
{
  "name": "papercusp-runtime",
  "version": "0.0.0",
  "private": true,
  "dependencies": {
    "${CODEX_PACKAGE}": "latest"
  }
}
JSON
echo '==> installing codex'
npm install --prefix ~/.papercusp/runtime --no-audit --no-fund
echo '==> done'
`;
  return { command: 'bash', args: ['-c', script], cwd: home, env: {} };
}

/**
 * PER-FRAMEWORK install spec (agent-first-onboarding-2026-07-03 P-001) — the
 * onboarding concierge installs ONLY the framework the user picked, unlike the
 * wizard's all-in-one `buildInstallSpec` (kept above for the GUI wizard).
 *
 * Composability: the codex install goes into the SAME `~/.papercusp/runtime`
 * prefix the wizard uses (and detection probes), via incremental
 * `npm install --prefix` — installing one framework never removes another.
 */
export function buildFrameworkInstallSpec(
  framework: OnboardingFramework,
  os: string,
  home: string,
  arch: string = osArch(),
): SpawnSpec {
  const ompUrl = ompDownloadUrl(os, arch);
  if (os === 'win32') {
    const scripts: Record<OnboardingFramework, string> = {
      claude: `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Write-Host '==> installing Claude Code'
Invoke-WebRequest -UseBasicParsing -Uri https://claude.ai/install.ps1 | Select-Object -ExpandProperty Content | Invoke-Expression
Write-Host '==> done'
`,
      codex: `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$runtime = Join-Path $env:USERPROFILE '.papercusp\\runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
if (-not (Test-Path (Join-Path $runtime 'package.json'))) {
  Push-Location $runtime; npm init -y | Out-Null; Pop-Location
}
Write-Host '==> installing codex'
npm install --prefix $runtime --no-audit --no-fund ${CODEX_PACKAGE}@latest
Write-Host '==> done'
`,
      // omp: download the prebuilt binary into %USERPROFILE%\.papercusp\bin and
      // add that dir to the PERSISTENT user PATH (non-destructively) so a future
      // shell resolves a bare `omp`. detectOmp also probes this path directly so
      // the wizard sees it as installed without a shell restart.
      omp: ompUrl
        ? `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Write-Host '==> installing oh-my-pi (omp)'
$dir = Join-Path $env:USERPROFILE '.papercusp\\bin'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$dst = Join-Path $dir 'omp.exe'
Invoke-WebRequest -UseBasicParsing -Uri '${ompUrl}' -OutFile $dst
$userPath = [Environment]::GetEnvironmentVariable('Path','User')
if (-not (($userPath -split ';') -contains $dir)) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $dir), 'User')
  Write-Host '==> added omp to your user PATH (restart your terminal to pick it up)'
}
Write-Host "==> installed omp -> $dst"
Write-Host '==> done'
`
        : `Write-Host 'No oh-my-pi build is published for this platform; see https://github.com/can1357/oh-my-pi'`,
    };
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', scripts[framework]],
      cwd: home,
      env: {},
    };
  }

  const runtimeBootstrap = `mkdir -p ~/.papercusp/runtime
[ -f ~/.papercusp/runtime/package.json ] || (cd ~/.papercusp/runtime && npm init -y >/dev/null)`;
  const scripts: Record<OnboardingFramework, string> = {
    claude: `set -e
echo '==> installing Claude Code'
curl -fsSL https://claude.ai/install.sh | bash
echo '==> done'
`,
    codex: `set -e
echo '==> bootstrapping runtime'
${runtimeBootstrap}
echo '==> installing codex'
npm install --prefix ~/.papercusp/runtime --no-audit --no-fund ${CODEX_PACKAGE}@latest
echo '==> done'
`,
    // omp: download the prebuilt binary into ~/.local/bin (where the official
    // claude installer also lands, and which detectOmp probes) + chmod +x. If it
    // isn't on PATH, print an actionable hint rather than silently failing later.
    omp: ompUrl
      ? `set -e
echo '==> installing oh-my-pi (omp)'
mkdir -p ~/.local/bin
curl -fsSL '${ompUrl}' -o ~/.local/bin/omp
chmod +x ~/.local/bin/omp
echo '==> installed omp -> ~/.local/bin/omp'
if ! command -v omp >/dev/null 2>&1; then
  echo 'NOTE: ~/.local/bin is not on your PATH — add this to your shell profile so \`omp\` is found: export PATH="$HOME/.local/bin:$PATH"'
fi
echo '==> done'
`
      : `echo 'No oh-my-pi build is published for this platform; see https://github.com/can1357/oh-my-pi'`,
  };
  return { command: 'bash', args: ['-c', scripts[framework]], cwd: home, env: {} };
}

/**
 * Build the login spawn spec for a provider.
 *
 * The Tauri PTY child does NOT inherit the parent process env (see
 * `src-tauri/src/pty.rs:114-124` — `CommandBuilder::new(command)`
 * starts with an empty env), so a bare `claude` / `omp` resolves
 * against the default `/usr/bin:/bin` PATH the kernel hands the
 * child — which is wrong for tools installed under
 * `~/.local/bin` or `~/node_modules/.bin`. Resolve to an absolute
 * path first; if `which` can't find it (unusual install layout),
 * fall back to `bash -lc` which sources the user's login shell
 * profile and picks up their full PATH.
 *
 * `absolutePath` is the same value `/api/agent-config` returns under
 * `binaries.{claude|omp}` — callers can pass it in if they already
 * have it, otherwise we detect.
 */
export function buildLoginSpec(
  provider: 'claude' | 'codex' | 'omp',
  home: string,
  absolutePath?: string | null,
): SpawnSpec {
  const resolved = absolutePath ?? detectBinaries()[provider];
  const args = provider === 'codex' ? ['login'] : ['/login'];
  if (resolved) {
    return { command: resolved, args, cwd: home, env: {} };
  }
  if (provider === 'codex') {
    return {
      command: 'bash',
      args: ['-lc', 'codex login'],
      cwd: home,
      env: {},
    };
  }
  return {
    command: 'bash',
    args: ['-lc', `${provider} /login`],
    cwd: home,
    env: {},
  };
}

/**
 * Locate the onboarding concierge script from the operator's cwd. Same
 * fallback-chain trick as the bundled-gh resolution below: dev runs with
 * cwd=apps/operator; the packaged sidecar keeps scripts/ next to its cwd.
 * Returns null when absent (Onboarding Console then shows its GUI-wizard
 * fallback).
 *
 * ⚠ The PACKAGED sidecar RENAMES the script: build-desktop-sidecar.sh
 * esbuilds `scripts/onboard-launcher.mjs` → `scripts/onboard.mjs` (named for
 * the `papercusp onboard` CLI, like psu/ptool). So we MUST accept BOTH names —
 * `onboard.mjs` (packaged) and `onboard-launcher.mjs` (dev source). Checking
 * only the source name made EVERY packaged build return onboardConcierge:null,
 * so the chat-first onboarding dead-ended on the GUI-wizard fallback — found
 * live on the Windows build 2026-07-04 (the resolver looked for
 * onboard-launcher.mjs; the sidecar only had onboard.mjs).
 */
export function resolveConciergeScript(
  cwd: string = process.cwd(),
  exists: (p: string) => boolean = (p) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { existsSync } = require('node:fs') as typeof import('node:fs');
    return existsSync(p);
  },
): string | null {
  const candidates = [
    // Packaged sidecar (build-renamed): onboard.mjs sits next to serve.mjs.
    `${cwd}/scripts/onboard.mjs`,
    `${cwd}/../scripts/onboard.mjs`,
    // Dev / source layout: the un-renamed source stem.
    `${cwd}/scripts/onboard-launcher.mjs`,
    `${cwd}/../scripts/onboard-launcher.mjs`,
    `${cwd}/apps/operator/scripts/onboard-launcher.mjs`,
  ];
  return candidates.find((p) => exists(p)) ?? null;
}

/**
 * Spawn spec for the Onboarding Console — the FIRST thing first-run onboarding
 * launches. Owner 2026-07-07: onboarding must open the unified Tutorial & Setup
 * CLI **on the SETUP tab** as the first surface — NOT the linear chat concierge
 * that only reached the unified shell at its very end (the handoff). So we launch
 * `onboard-launcher.mjs --tab=setup`, which routes straight to the unified
 * Tutorial|Setup shell (tutorial-runner) opened on the Setup tab. That setup tab
 * IS the concierge folded into a re-entrant checklist — it drives the SAME
 * server-side stage machine + pty specs, so the framework pick → sign-in → mem0
 * flow still happens there, with the tutorial one Tab away. (The original linear
 * chat concierge stays reachable via `papercusp onboard`.)
 *
 * Pure given its inputs — exported for tests. `origin` is the operator base URL
 * the WEBVIEW reached us on (derived from the request), threaded via
 * PAPERCUSP_OPERATOR_URL so the shell polls the same server. `nodeBin` defaults
 * to this process's node — the Tauri pty child inherits NO PATH, so a bare
 * `node` would not resolve.
 */
export function buildOnboardingSetupSpec(
  scriptPath: string,
  origin: string,
  home: string,
  nodeBin: string = process.execPath,
): SpawnSpec {
  return {
    command: nodeBin,
    args: [scriptPath, '--tab=setup'],
    cwd: home,
    env: { PAPERCUSP_OPERATOR_URL: origin },
  };
}

/**
 * GitHub CLI uses `gh auth login` (different arg shape from claude/omp).
 *
 * `cwd`/`exists` are injectable (mirroring `resolveConciergeScript` above) so the
 * path-priority order — the actual regression surface of WI-3626 — is unit-testable
 * without mocking the `node:fs` ESM module (not spy-able: "Cannot redefine property"
 * under Vitest 4's ESM namespace). Both default to the real `process.cwd()` /
 * `existsSync` for every production call site.
 */
export function buildGithubLoginSpec(
  home: string,
  deps: {
    cwd?: string;
    exists?: (p: string) => boolean;
  } = {},
): SpawnSpec {
  const cwd = deps.cwd ?? process.cwd();
  const exists =
    deps.exists ??
    ((p: string) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { existsSync } = require('node:fs') as typeof import('node:fs');
      return existsSync(p);
    });
  const resolved = (() => {
    try {
      // The Tauri pty child gets NO inherited PATH (empty env), so a bare `gh`
      // resolves against /usr/bin:/bin only. Prefer the STABLE shim at
      // ~/.papercusp/bin/gh (installPapercuspFiles' ensureGhLinked keeps it
      // symlinked to the current bundle's gh, refreshed every boot) over the raw
      // app-bundle-relative paths below — `gh auth setup-git` bakes WHICHEVER
      // path resolves here verbatim into `credential.https://github.com.helper`
      // in ~/.gitconfig, and an app-bundle path (`/Applications/Papercusp.app/…`)
      // dangles the instant the app is renamed/replaced (confirmed live on the
      // Mac VM, WI-3626 — the bundle is now `Papercusp Server.app` /
      // `Papercusp GUI.app`, no `Papercusp.app`). The stable shim path never
      // moves, so anything that bakes IT into gitconfig survives every future
      // rename too. Falls through to the bundle-relative paths for a dev box /
      // an install that predates ensureGhLinked (this run's install pass hasn't
      // relinked yet).
      for (const p of [joinPath(home, '.papercusp', 'bin', 'gh'), `${cwd}/bin/gh`, `${cwd}/../bin/gh`]) {
        if (exists(p)) return p;
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
      const r = spawnSync('which', ['gh'], { encoding: 'utf8' });
      return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    } catch {
      return null;
    }
  })();
  // Force HTTPS + web/device flow, THEN wire git to gh — both in one shell.
  //  - `--git-protocol https --web`: the dogfood clone uses an HTTPS remote, so SSH
  //    is never needed; this skips gh's SSH-key-UPLOAD path (which fails "key is
  //    already in use" when a matching key is already on the account, exit 1) and
  //    runs the browser/device-code flow.
  //  - `&& gh auth setup-git`: gh's `--web` login STORES the token but does NOT wire
  //    git's credential helper to gh, so a later `git clone` of the private dogfood
  //    repo can't use the token — it fails auth_required and the setup bar stays
  //    stuck on "Sign in to GitHub to begin the download". setup-git writes
  //    `credential.https://github.com.helper = !<gh> auth git-credential`, so git
  //    then authenticates via gh's stored token. (Found live 2026-06-24: login
  //    succeeded, github status flipped true, but the clone still couldn't auth.)
  // Always via `bash -lc` so the two steps chain; the absolute gh path is used
  // because the Tauri pty child inherits no PATH.
  const gh = resolved ?? 'gh';
  const script =
    `"${gh}" auth login --hostname github.com --git-protocol https --web && ` +
    `"${gh}" auth setup-git --hostname github.com`;
  return { command: 'bash', args: ['-lc', script], cwd: home, env: {} };
}

export default defineTool({
  method: 'GET',
  path: '/desktop/setup-pty-commands',
  auth: {},
  handler(req: Request) {
    const os = platform();
    const home = homedir();
    // Per-framework specs for the onboarding concierge (P-001) — claude, codex,
    // AND omp, installable on every OS (omp via a direct GitHub-release download).
    const installFramework = Object.fromEntries(
      allowedFrameworks(os).map((f) => [f, buildFrameworkInstallSpec(f, os, home)]),
    ) as Partial<Record<OnboardingFramework, SpawnSpec>>;
    // Onboarding Console (P-003): the unified Tutorial & Setup shell opened on the
    // SETUP tab (owner 2026-07-07) — null when the script can't be located, in which
    // case the console component falls back to the GUI wizard.
    const conciergeScript = resolveConciergeScript();
    const onboardConcierge = conciergeScript
      ? buildOnboardingSetupSpec(conciergeScript, new URL(req.url).origin, home)
      : null;
    return Response.json({
      installRuntime: buildInstallSpec(os, home),
      installFramework,
      onboardConcierge,
      loginClaude: buildLoginSpec('claude', home),
      loginCodex: buildLoginSpec('codex', home),
      loginOmp: buildLoginSpec('omp', home),
      loginGithub: buildGithubLoginSpec(home),
    });
  },
});
