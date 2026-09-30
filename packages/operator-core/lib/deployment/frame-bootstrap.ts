/**
 * Frame bootstrap generator (`cloud-deployment-layer-2026-06-06` P-010/P-011).
 *
 * Pure function: turns a deployment config + the blueprint's environment spec
 * (P-007) into the bash script the driver runs ON a provisioned frame to stand up
 * the papercusp runtime — generalizing the `deploy/HARNESS-ON-HETZNER.md`
 * sidecar-runner from a baked Docker image to an on-demand VM/metal bootstrap.
 *
 * Per the ratified D-006/D-007, a frame is SELF-SUFFICIENT: it runs its OWN
 * orchestrator loop (D-006) against its OWN embedded-pg that federates via the
 * peer-log (D-007). So the script installs the runtime + agent CLIs,
 * mounts the per-frame Claude credentials (P-011), runs the env spec's
 * setup/install/build, starts embedded-pg + applies migrations, and launches the
 * frame's orchestrator loop scoped to the one harness it hosts.
 *
 * It returns the script PLUS a `steps` list (the section ids) so the driver +
 * tests can reason about / assert the bootstrap without parsing bash. The exact
 * runtime-delivery (clone+build vs a prebuilt bundle) is a parameter — infra's
 * choice — so this generator stays correct-by-construction and unit-testable
 * without a live frame.
 */
import type { BlueprintEnvironment } from '@papercusp/orchestrator/blueprint';
import { buildGlSelectScript, GL_APT_PACKAGES, GL_STRATEGY_ENV_PATH } from '../desktop/gl-strategy';
import {
  buildDesktopCaptureScript,
  DESKTOP_CAPTURE_DIR,
  DESKTOP_CAPTURE_SCRIPT_PATH,
} from './desktop-capture';

export interface FrameBootstrapOpts {
  /** The harness this frame hosts. */
  harnessSlug: string;
  /** Git URL of the harness repo to clone (omit for a repo-less harness). */
  repoUrl?: string;
  /** Branch/ref to check out (default `main`). */
  repoRef?: string;
  /** The blueprint environment spec (P-007) — setup/install/build/run/services/ports/env. */
  environment?: BlueprintEnvironment;
  /** Node major to install (default 22). */
  nodeVersion?: number;
  /** Agent backend the frame's loop spawns (default `omp`). */
  agentBackend?: 'omp' | 'claude' | 'codex';
  /** D-007: run the frame's own embedded-pg, federating via the peer-log (default true). */
  embeddedPg?: boolean;
  /** D-006: run the frame's own orchestrator loop (default true). */
  orchestratorOnFrame?: boolean;
  /** P-011: path on the frame where the Claude credentials were staged before this runs. */
  claudeCredentialsRemotePath?: string;
  /** P-011 token channel: path on the frame where a long-lived OAuth token
   *  (`claude setup-token` output) was staged — installed to `~/.papercusp/claude-token`
   *  and exported as `CLAUDE_CODE_OAUTH_TOKEN` for everything the script starts. */
  claudeTokenRemotePath?: string;
  /** P-019: the logical account id this frame's credential belongs to. Exported as
   *  `PAPERCUSP_ACCOUNT_ID` so the frame's rate governor keys its buckets per-account
   *  (and its pauses carry the account, driving the Queen's scale-out). */
  accountId?: string;
  /** Install root on the frame (default `/opt/papercusp`). */
  installRoot?: string;
  /** Commands that install the papercusp RUNTIME on the frame (clone+build, or fetch a
   *  prebuilt bundle). Parameterized — infra's choice. A sane default is provided. */
  runtimeSetup?: string[];
  /** Path on the frame where an operator-packed runtime tarball was staged (P-010
   *  private-repo delivery). When set (and no explicit runtimeSetup), the runtime
   *  section untars it instead of the default anonymous `git clone` — which can
   *  never work against the private runtime repo. */
  runtimeTarballRemotePath?: string;
  /** Extra NON-SECRET env exported for the run (merged over environment.env). */
  env?: Record<string, string>;
  /** The harness's per-install instance config as JSON — exported as
   *  HARNESS_CONFIG_JSON so the frame's runtime reads it via the env-transport
   *  (P-008; the frame has no local config.json). */
  instanceConfigJson?: string;
  /** Control node (the Queen — P-016/D-008 `dedicated` placement): run the operator
   *  loop UNSCOPED (supervises across frames via coordination) rather than scoped to
   *  one harness. */
  controlNode?: boolean;
  /** Opt-in desktop capability (`hive-frame-desktops-live-view` P-001/D-001): stand
   *  up one Xvfb display per agent slot (`:99 + n`, openbox WM each) so the frame's
   *  agents can drive GUIs, plus the capture loop the live view pulls (P-005).
   *  `true` = defaults (4 displays @ 1920x1080x24). The orchestrator-loop section
   *  advertises the pool via `PAPERCUSP_DESKTOP_DISPLAYS` +
   *  `PAPERCUSP_DESKTOP_DISPLAY_BASE` so the spawn path leases per-agent
   *  `DISPLAY`s (P-002). */
  desktop?: boolean | { displays?: number; geometry?: string };
}

/** The bootstrap section ids, in run order — the observable contract. */
export const FRAME_BOOTSTRAP_STEPS = [
  'preflight',
  'node',
  'agent-clis',
  'desktop',
  'runtime',
  'repo',
  'credentials',
  'embedded-pg',
  'env-setup',
  'env-install',
  'env-build',
  'services',
  'orchestrator-loop',
] as const;
export type FrameBootstrapStep = (typeof FRAME_BOOTSTRAP_STEPS)[number];

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Desktop defaults (D-001): displays start at `:99` (the local agent-e2e
 *  convention — one display per agent, no focus stealing), 4 per frame unless
 *  tuned, llvmpipe-rendered 1080p. */
export const DESKTOP_DISPLAY_BASE = 99;
export const DESKTOP_DEFAULT_DISPLAYS = 4;
export const DESKTOP_DEFAULT_GEOMETRY = '1920x1080x24';

export interface NormalizedDesktop {
  displays: number;
  geometry: string;
}

/** Normalize the `desktop` knob (`true` → defaults; object → clamped/filled). */
export function normalizeDesktop(
  d: boolean | { displays?: number; geometry?: string } | undefined,
): NormalizedDesktop | undefined {
  if (!d) return undefined;
  const o = d === true ? {} : d;
  const displays = Math.max(1, Math.min(64, Math.floor(o.displays ?? DESKTOP_DEFAULT_DISPLAYS)));
  return { displays, geometry: o.geometry ?? DESKTOP_DEFAULT_GEOMETRY };
}

function section(id: FrameBootstrapStep, title: string, lines: string[]): string {
  return [`# ── ${id}: ${title} ──`, `log ${shq(id)}`, ...lines, ''].join('\n');
}

export interface FrameBootstrapResult {
  script: string;
  /** The sections actually emitted (some are skipped by opts). */
  steps: FrameBootstrapStep[];
}

export function buildFrameBootstrap(opts: FrameBootstrapOpts): FrameBootstrapResult {
  const node = opts.nodeVersion ?? 22;
  const root = (opts.installRoot ?? '/opt/papercusp').replace(/\/$/, '');
  const repoDir = `${root}/${opts.harnessSlug}`;
  const backend = opts.agentBackend ?? 'omp';
  const embeddedPg = opts.embeddedPg !== false;
  const orchestratorOnFrame = opts.orchestratorOnFrame !== false;
  const credPath = opts.claudeCredentialsRemotePath;
  const tokenPath = opts.claudeTokenRemotePath;
  const accountId = opts.accountId;
  const envSpec = opts.environment;
  const mergedEnv = { ...(envSpec?.env ?? {}), ...(opts.env ?? {}) };

  const emitted: FrameBootstrapStep[] = [];
  const blocks: string[] = [];
  const add = (id: FrameBootstrapStep, title: string, lines: string[]) => {
    emitted.push(id);
    blocks.push(section(id, title, lines));
  };

  add('preflight', 'OS packages', [
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -y',
    // bubblewrap + socat: the fleet OS sandbox (claude --settings sandbox.enabled,
    // DEFAULT-ON) hard-requires BOTH — bwrap for subprocess isolation, socat for
    // the egress proxy — or every agent spawn aborts instantly ("sandbox required
    // but unavailable"). Found live 2026-06-07 on the first frame work item.
    'apt-get install -y --no-install-recommends git curl ca-certificates build-essential python3 jq ripgrep openssh-client bubblewrap socat',
    // The frame's loop COMMITS chunks (worker-chunk-loop defaultCommitChunk) —
    // a fresh machine has no git identity and `git commit` refuses without one
    // (found live 2026-06-09, run #2 curator: "Git config: still missing").
    `git config --global user.email ${shq('frame@papercusp.local')}`,
    `git config --global user.name ${shq('Papercusp Frame')}`,
    'git config --global init.defaultBranch main',
  ]);

  add('node', `Node.js ${node}`, [
    `if ! node -v 2>/dev/null | grep -q "^v${node}"; then`,
    `  curl -fsSL https://deb.nodesource.com/setup_${node}.x | bash -`,
    '  apt-get install -y nodejs',
    'fi',
    'npm i -g tsx',
  ]);

  // Agent CLIs, per backend: OMP uses the existing gateway/account-pool spawn seam
  // (per-session models.yml + PAPERCUSP_ACCOUNT_ID), while Claude and Codex use
  // their normal CLIs. Staged Claude credentials remain available for direct
  // fallback; no separate OAuth router is required on the frame.
  add('agent-clis', `agent CLIs (backend=${backend})`, [
    ...(backend === 'omp' ? ['npm i -g @oh-my-pi/pi-coding-agent'] : []),
    '# claude CLI (primary or fallback backend; direct fallback uses staged credentials)',
    'curl -fsSL https://claude.ai/install.sh | bash || npm i -g @anthropic-ai/claude-code',
    backend === 'omp'
      ? '# OMP gateway/account routing is supplied per spawn by the runtime'
      : '# backend is not omp — OMP CLI not installed',
  ]);

  const desktop = normalizeDesktop(opts.desktop);
  if (desktop) {
    // P-001/D-001: one Xvfb display per agent slot (`:99 + n`), an openbox WM
    // each, plus the capture loop (P-005) the operator's live view pulls over
    // SSH. x11vnc is installed here but NOT started — Phase 3 starts it
    // on-demand per viewer session (localhost-only; never a listening 5900).
    const displayNumbers = Array.from({ length: desktop.displays }, (_, n) => DESKTOP_DISPLAY_BASE + n);
    add('desktop', `Xvfb desktops (${desktop.displays} displays — D-001 one per agent slot)`, [
      // socat bridges x11vnc's localhost port to the SSH stdio (the VNC leg —
      // `-inetd` can't run over an SSH pipe; see frame-vnc.ts vncRemoteCommand).
      // GL_APT_PACKAGES is what makes the displays paint at all: a bare Xvfb with no mesa
      // DRI driver gives GTK/WebKitGTK no usable context, so those apps render nothing and
      // every capture below comes back blank regardless of the DOM
      // (agent-insights/headless-desktop-testing-needs-gl). Frames are GPU-less, so the
      // software rasterizer in libgl1-mesa-dri IS the working path here, not a fallback.
      `apt-get install -y --no-install-recommends xvfb openbox x11vnc xdotool ffmpeg x11-utils socat ${GL_APT_PACKAGES.join(' ')}`,
      `mkdir -p /var/log/papercusp-desktop ${shq(DESKTOP_CAPTURE_DIR)}`,
      ...displayNumbers.flatMap((d) => [
        `( Xvfb :${d} -screen 0 ${shq(desktop.geometry)} -nolisten tcp >/var/log/papercusp-desktop/xvfb-${d}.log 2>&1 & )`,
        `( sleep 1; DISPLAY=:${d} openbox >/var/log/papercusp-desktop/openbox-${d}.log 2>&1 & )`,
      ]),
      // Measure GL on the FIRST display once the servers are up and record it for the
      // agent loop to source. One probe, not one per display: the pool is homogeneous
      // (same host, same geometry, same Xvfb invocation), so probing each would pay N
      // glxinfo runs to re-derive one answer.
      'sleep 2',
      buildGlSelectScript(`:${DESKTOP_DISPLAY_BASE}`),
      // The capture loop (P-005): latest-frame JPEG per ACTIVE display, written
      // atomically for the operator's viewer-driven SSH pull (D-003).
      `cat > ${shq(DESKTOP_CAPTURE_SCRIPT_PATH)} <<'PAPERCUSP_CAPTURE_EOF'`,
      buildDesktopCaptureScript({ displays: displayNumbers, geometry: desktop.geometry }).trimEnd(),
      'PAPERCUSP_CAPTURE_EOF',
      `chmod +x ${shq(DESKTOP_CAPTURE_SCRIPT_PATH)}`,
      `( ${DESKTOP_CAPTURE_SCRIPT_PATH} >/var/log/papercusp-desktop/capture.log 2>&1 & )`,
    ]);
  }

  add('runtime', 'papercusp runtime', [
    `mkdir -p ${shq(root)}`,
    ...(opts.runtimeSetup ??
      (opts.runtimeTarballRemotePath
        ? [
            '# Runtime delivered as an operator-packed tarball (the runtime repo is',
            '# private — an anonymous clone can never work; no git credential shipped).',
            `mkdir -p ${shq(`${root}/runtime`)}`,
            `tar xzf ${shq(opts.runtimeTarballRemotePath)} -C ${shq(`${root}/runtime`)}`,
            `rm -f ${shq(opts.runtimeTarballRemotePath)} # free ~200MB once extracted`,
            // --legacy-peer-deps on the fallback: a fast-moving monorepo's lockfile can
            // carry transient peer skew (hit live 2026-06-06: vitest 4.1.8 vs
            // coverage-v8@4.1.7 peer-pinned to 4.1.7) — a frame install must survive it.
            `cd ${shq(`${root}/runtime`)} && (npm ci --no-audit --no-fund || npm install --no-audit --no-fund --legacy-peer-deps)`,
          ]
        : [
            '# Default runtime delivery: clone + install the operator runtime. Prod may',
            '# swap this for a prebuilt bundle fetch (set opts.runtimeSetup) or stage a',
            '# tarball (runtimeTarballRemotePath) — required while the repo is private.',
            `git clone --depth 1 https://github.com/Papercusp/papercup.git ${shq(`${root}/runtime`)} || true`,
            `cd ${shq(`${root}/runtime`)} && npm ci --no-audit --no-fund || npm install --no-audit --no-fund`,
          ])),
  ]);

  if (opts.repoUrl) {
    add('repo', 'clone harness repo', [
      `if [ ! -d ${shq(repoDir)}/.git ]; then`,
      `  git clone ${shq(opts.repoUrl)} ${shq(repoDir)}`,
      'fi',
      `cd ${shq(repoDir)} && git fetch --all && git checkout ${shq(opts.repoRef ?? 'main')} && git pull --ff-only || true`,
    ]);
  }

  if (credPath || tokenPath || accountId) {
    // P-011: stage the per-frame Claude subscription so this frame has its OWN
    // rate limits — via a credentials bundle (interactive-login channel), a
    // long-lived OAuth token (`claude setup-token`; the automated channel), or both.
    const lines: string[] = [];
    if (accountId) {
      // P-019: export the logical account id (script-level) so the orchestrator loop
      // + every agent it spawns key their rate-governor buckets per-account.
      lines.push(`export PAPERCUSP_ACCOUNT_ID=${shq(accountId)}`);
    }
    if (credPath) {
      // The operator scp's the credentials to `credPath` BEFORE this runs; here we
      // install them where both OMP's direct fallback + Claude read.
      lines.push(
        'mkdir -p "$HOME/.claude" && chmod 700 "$HOME/.claude"',
        `if [ -f ${shq(credPath)} ]; then`,
        `  install -m 0600 ${shq(credPath)} "$HOME/.claude/.credentials.json"`,
        `  rm -f ${shq(credPath)} # staged copy removed once installed`,
        'else',
        `  echo "WARN: Claude credentials not staged at ${credPath} — agent runs will fail to auth" >&2`,
        'fi',
      );
    }
    if (tokenPath) {
      // Exported here (script-level) so every later section — services + the
      // orchestrator loop and the agents it spawns — inherits it.
      lines.push(
        `if [ -f ${shq(tokenPath)} ]; then`,
        `  mkdir -p "$HOME/.papercusp" && install -m 0600 ${shq(tokenPath)} "$HOME/.papercusp/claude-token"`,
        `  rm -f ${shq(tokenPath)} # staged copy removed once installed`,
        '  export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$HOME/.papercusp/claude-token")"',
        'else',
        `  echo "WARN: Claude OAuth token not staged at ${tokenPath} — agent runs will fail to auth" >&2`,
        'fi',
      );
    }
    add('credentials', 'mount Claude subscription (P-011)', lines);
  }

  if (embeddedPg) {
    // D-007: the frame runs its OWN Postgres (per-frame isolation; federates via the
    // peer-log at the operator layer). We use SYSTEM PG 16 + pgvector (pgdg), NOT the
    // npm embedded-postgres distribution: `000-baseline.sql` hard-requires the `vector`
    // type, and the npm distro ships neither the extension .so nor the headers to build
    // it, so its baseline migration dies with `type "public.vector" does not exist`
    // (found live 2026-06-06; reproduced on a fresh frame 2026-06-09 — the prior live
    // fix was never committed to this bootstrap). `apply-migrations.mjs` creates the
    // extensions (pgcrypto/pg_trgm/vector), applies all migrations, and pre-mints the
    // spawn-signing-key (without which the FIRST director spawn-mcp write can't sign →
    // claude -p --strict-mcp-config aborts on a missing .mcp.json). The operator resolves
    // this PG via DATABASE_URL exactly like the native-PG dev box.
    add('embedded-pg', 'system Postgres 16 + pgvector + migrations (D-007)', [
      'export DEBIAN_FRONTEND=noninteractive',
      // pgdg provides PG16 + the matching pgvector package on jammy (not in base repos).
      'apt-get install -y -q postgresql-common',
      'YES=yes /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y || true',
      'apt-get install -y -q postgresql-16 postgresql-16-pgvector',
      'systemctl start postgresql || pg_ctlcluster 16 main start || true',
      // Per-frame SUPERUSER credential (audit P-031): provisioned frames no
      // longer bake the repo-public 'harness_admin_pwd' literal — that stays
      // only as the documented DEV fallback in libs/db connection.ts. Override
      // with PAPERCUSP_FRAME_PG_PASSWORD (exported into the bootstrap env by
      // the caller) or take a fresh random per-frame secret.
      'HARNESS_ADMIN_PWD="${PAPERCUSP_FRAME_PG_PASSWORD:-$(openssl rand -hex 24)}"',
      // CREATE without a password, then ALTER to THIS run's password: a
      // re-bootstrap of an existing frame re-keys the role so the exported
      // DSN below always matches (the old `CREATE ... || true` left a stale
      // password on re-runs).
      'sudo -u postgres psql -qc "CREATE ROLE harness_admin LOGIN SUPERUSER" || true',
      'sudo -u postgres psql -qc "ALTER ROLE harness_admin WITH LOGIN SUPERUSER PASSWORD \'$HARNESS_ADMIN_PWD\'"',
      // Bound idle-in-transaction sessions: a leaked/dropped tx (e.g. an MCP transport-drop
      // mid plans:* write) must not hold its locks forever — the documented plans:* lock-leak
      // fleet-wedge class (infra round-3 F2). The host box runs this operationally; provisioned
      // frames inherit it here. Safe for boot-apply (only kills sessions IDLE in a tx, never a
      // running migration). statement_timeout deliberately NOT set — migrations run as this role.
      'sudo -u postgres psql -qc "ALTER ROLE harness_admin SET idle_in_transaction_session_timeout = \'60s\'"',
      // harness_app (the RLS-subject role getOrgPgApp dispatches on) gets the
      // same per-frame treatment; its DSN is exported as HARNESS_DATABASE_URL
      // below — without that export connection.ts would fall back to the
      // baked dev literal and every workspace-scoped tool call would fail.
      'HARNESS_APP_PWD="${PAPERCUSP_FRAME_PG_APP_PASSWORD:-$(openssl rand -hex 24)}"',
      'sudo -u postgres psql -qc "CREATE ROLE harness_app LOGIN" || true',
      'sudo -u postgres psql -qc "ALTER ROLE harness_app WITH LOGIN PASSWORD \'$HARNESS_APP_PWD\'"',
      // Same idle-in-transaction bound on the RLS-subject app role (infra round-3 F2).
      'sudo -u postgres psql -qc "ALTER ROLE harness_app SET idle_in_transaction_session_timeout = \'60s\'"',
      // harness_zero belongs to the RETIRED Zero/web path — nothing on a
      // frame ever logs in as it, but ~40 migrations GRANT to the role so it
      // must exist. Random throwaway password, no DSN exported anywhere.
      'HARNESS_ZERO_PWD="${PAPERCUSP_FRAME_PG_ZERO_PASSWORD:-$(openssl rand -hex 24)}"',
      'sudo -u postgres psql -qc "CREATE ROLE harness_zero LOGIN" || true',
      'sudo -u postgres psql -qc "ALTER ROLE harness_zero WITH LOGIN PASSWORD \'$HARNESS_ZERO_PWD\'"',
      'sudo -u postgres createdb -O harness_admin papercusp || true',
      // Database-level safety net (EI-21879861039988274): harness_admin/harness_app
      // get their own 60s idle-in-tx bound above, but a plain `postgres` connection
      // (e.g. pg_dump in the backup hook) or any OTHER role that ever logs into this
      // database has none. idle_in_transaction_session_timeout only fires when a
      // backend is genuinely IDLE (no statement running) inside an open transaction —
      // it never touches a session actively executing a query, including one blocked
      // waiting on a lock — so this cannot abort a running pg_dump/COPY/VACUUM. A
      // role-level SET (above) still takes precedence over this database default, so
      // harness_admin/harness_app are unaffected; this only closes the gap for roles
      // with no override of their own. Observed live: a leaked idle-in-tx backend
      // pinned VACUUM's dead-tuple reclaim horizon on gateway_payload_blobs for 59
      // minutes, which cascaded into work_items:checkpoint timing out fleet-wide.
      'sudo -u postgres psql -qc "ALTER DATABASE papercusp SET idle_in_transaction_session_timeout = \'60s\'"',
      // Export for every later step (single bootstrap shell): the operator + the
      // invoke-once pg-bootstrap read this DSN. No ~/.papercusp/embedded-pg.json is
      // written, so the operator's discovery cleanly falls through to DATABASE_URL.
      'export DATABASE_URL="postgresql://harness_admin:$HARNESS_ADMIN_PWD@localhost:5432/papercusp"',
      'export PAPERCUSP_DATABASE_URL="$DATABASE_URL"',
      'export HARNESS_DATABASE_URL="postgresql://harness_app:$HARNESS_APP_PWD@localhost:5432/papercusp"',
      // Persist the DSNs (0600) for manual relaunches after the bootstrap
      // shell exits — the connection.ts dev-fallback literals will NOT match
      // a provisioned frame anymore.
      'install -m 0600 /dev/null "$HOME/.papercusp/frame-pg.env" 2>/dev/null || { mkdir -p "$HOME/.papercusp" && install -m 0600 /dev/null "$HOME/.papercusp/frame-pg.env"; }',
      'printf "DATABASE_URL=%s\\nHARNESS_DATABASE_URL=%s\\n" "$DATABASE_URL" "$HARNESS_DATABASE_URL" > "$HOME/.papercusp/frame-pg.env"',
      `cd ${shq(`${root}/runtime`)}`,
      'export PAPERCUSP_PG_SQL_DIR=libs/papercusp/libs/db/sql',
      // Extensions + all migrations + spawn-signing-key premint (fails the script on error).
      'node libs/papercusp/packages/embedded-postgres-server/bin/apply-migrations.mjs',
      // Fail LOUD if provisioning didn't land — no silent half-migrated frame. Check the
      // spawn-signing-key row: apply-migrations.mjs inserts it LAST (after extensions +
      // all migrations), so its presence proves operator_secrets exists AND the full run
      // completed. (Do NOT check harness_shared.harness_features — features unified into
      // work_items / live in per-harness schemas; that table isn't in harness_shared.)
      `if [ "$(psql "$DATABASE_URL" -tAc "select count(*) from harness_shared.operator_secrets where name='spawn-signing-key'")" != "1" ]; then`,
      '  echo "FATAL: provisioning incomplete (spawn-signing-key row missing)" >&2',
      '  exit 1',
      'fi',
    ]);
  }

  const cdRun = opts.repoUrl ? `cd ${shq(repoDir)}` : `cd ${shq(root)}`;
  if (envSpec?.setup?.length) add('env-setup', 'env spec: setup', [cdRun, ...envSpec.setup]);
  if (envSpec?.install?.length) add('env-install', 'env spec: install', [cdRun, ...envSpec.install]);
  if (envSpec?.build?.length) add('env-build', 'env spec: build', [cdRun, ...envSpec.build]);

  if (envSpec?.services?.length) {
    add('services', 'background services', [
      cdRun,
      ...envSpec.services.map(
        (s) => `( ${s.command} ) >/var/log/svc-${s.name}.log 2>&1 & # ${s.name}${s.port ? ` :${s.port}` : ''}`,
      ),
    ]);
  }

  if (orchestratorOnFrame) {
    // D-006: the frame self-dispatches the agents it hosts. Scope the loop to this
    // one harness; the Queen supervises across frames via coordination, not by
    // running each frame's loop.
    add('orchestrator-loop', 'frame orchestrator loop (D-006)', [
      `cd ${shq(`${root}/runtime`)}`,
      // claude's install.sh lands in ~/.local/bin, which a non-login bootstrap
      // shell doesn't have on PATH — the loop's agent spawns need it.
      'export PATH="$HOME/.local/bin:$PATH"',
      // Role prompts resolve via PAPERCUSP_HARNESS_DIR (the dev-box default is a
      // ~/autonomous-harness symlink that frames don't have) — without it the
      // boot guard sees zero roles and refuses to start (found live 2026-06-06).
      `export PAPERCUSP_HARNESS_DIR=${shq(`${root}/runtime/libs/papercusp/packages/harness`)}`,
      // DBOS itself is gated default-OFF (instrumentation-node checks DBOS_ENABLE);
      // without it the frame's "own loop" silently never launches (found live
      // 2026-06-06 in the work-on-frame verification).
      'export PAPERCUSP_DBOS_ENABLE=1',
      'export PAPERCUSP_DBOS_ORCHESTRATOR=1',
      // Control node (Queen) supervises ACROSS frames → unscoped (`*`); an execution
      // frame self-dispatches only the one harness it hosts (D-006).
      `export PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES=${shq(opts.controlNode ? '*' : opts.harnessSlug)}`,
      `export AGENT_BACKEND=${shq(backend === 'omp' ? 'omp' : backend === 'claude' ? 'claude-code' : 'codex')}`,
      // P-002 (hive-frame-desktops): advertise the display pool so the loop's
      // spawn path leases a per-agent DISPLAY (display-allocator.ts).
      ...(desktop
        ? [
            `export PAPERCUSP_DESKTOP_DISPLAY_BASE=${DESKTOP_DISPLAY_BASE}`,
            `export PAPERCUSP_DESKTOP_DISPLAYS=${desktop.displays}`,
            // Carry the MEASURED GL strategy into the loop's env, so an agent launching a
            // GTK/WebKitGTK app on its leased display inherits the same wrapper + env the
            // bootstrap proved works. Sourced (not re-derived) because the probe already
            // ran above and re-probing per spawn would pay a glxinfo run on every launch.
            // `[ -f ]`-guarded: a frame whose desktop section was skipped has no file, and
            // sourcing a missing path under `set -u` would abort the whole loop start.
            `[ -f ${shq(GL_STRATEGY_ENV_PATH)} ] && . ${shq(GL_STRATEGY_ENV_PATH)}`,
          ]
        : []),
      // P-008: the frame reads its per-install instance config from env (no config.json file).
      ...(opts.instanceConfigJson ? [`export HARNESS_CONFIG_JSON=${shq(opts.instanceConfigJson)}`] : []),
      ...Object.entries(mergedEnv).map(([k, v]) => `export ${k}=${shq(v)}`),
      // `dev:operator` is only the SPA BUILDER (the desktop shell starts the host
      // separately) — a headless frame must launch the hono host itself, which
      // serves /api + the loop. Found live 2026-06-06: ":3070 never listened."
      // `setsid … </dev/null` FULLY detaches the long-running host from the bootstrap's
      // ssh channel — without redirecting stdin off the channel + a new session, the
      // install ssh command never returns (the live host keeps the channel open), so
      // the deploy hangs to timeout instead of completing (found live 2026-06-09, run #3).
      `setsid bash -c ${shq(`cd ${root}/runtime/apps/operator && exec npx tsx bin/hono-host.ts`)} </dev/null >/var/log/papercusp-operator.log 2>&1 &`,
      // shq() the whole literal so a slug with shell metacharacters can't break
      // out of the echo (consistent with every other interpolation here).
      `echo ${shq('frame orchestrator loop started for harness ' + opts.harnessSlug)}`,
    ]);
  }

  const header = [
    '#!/usr/bin/env bash',
    '# Generated by frame-bootstrap.ts — cloud-deployment-layer P-010/P-011.',
    `# Frame for harness: ${opts.harnessSlug}`,
    'set -euo pipefail',
    'log() { echo "[frame-bootstrap] $1"; }',
    '',
  ].join('\n');

  return { script: header + blocks.join('\n'), steps: emitted };
}
