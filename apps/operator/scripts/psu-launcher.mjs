#!/usr/bin/env node
/**
 * psu-launcher.mjs — the `psu` command.
 *
 * Picks an SU agent + harness + plan, records a tracked `adv_sessions`
 * row via the bootstrap-su endpoint, then exec's the chosen `*-su`
 * wrapper (claude-su / omp-su / codex-su) in the harness cwd with the
 * tracking env. The `*-su` wrappers (installed by
 * install-standalone-mcp.sh) already inject the engineer playbook +
 * skip-permissions + MCP — `psu` adds the picker + plan tracking on top.
 *
 * Per `psu-wrappers-and-plan-tracked-launch-2026-05-30` Phase B (pivot:
 * single `psu` entry point exec'ing the existing `*-su` wrappers).
 *
 * Lives in the repo so it resolves `@inquirer/prompts` from the
 * operator's node_modules; the on-PATH `psu` shim is a one-liner that
 * exec's this file by absolute path.
 *
 * Interactive:   psu
 * Scripting:     psu --no-picker --agent=<claude|omp|codex> --harness=<slug> [--plan=<slug>|--no-plan]
 */
import { spawn, spawnSync, execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  cpSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  renameSync,
  realpathSync,
  statSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
  copyFileSync,
  openSync,
  readSync,
  writeSync,
  closeSync,
} from "node:fs";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { homedir, hostname } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join, dirname, delimiter, basename, relative } from "node:path";
import { isCliEntry } from "@papercusp/operator-core/lib/util/cli-entry";

/** Keep the packaged adapter relocatable while preserving source-checkout development. */
export function resolveNativeMcpAssets(moduleUrl = import.meta.url, available = existsSync) {
  const packaged = {
    bundle: new URL("./native-client.cjs", moduleUrl),
    extension: new URL("./native-extension.mjs", moduleUrl),
  };
  // Select the layout as one generation: never mix a partially assembled
  // packaged pair with the source-tree fallback.
  if (available(packaged.bundle) && available(packaged.extension)) return packaged;
  return {
    bundle: new URL("../../../packages/omp-plugin/dist/native-client.cjs", moduleUrl),
    extension: new URL("../../../packages/omp-plugin/dist/native-extension.mjs", moduleUrl),
  };
}
const { bundle: nativeMcpBundle, extension: nativeMcpExtension } = resolveNativeMcpAssets();
const nativeMcpRequire = createRequire(import.meta.url);

/** Explicit owned-OMP path only; stock Claude/Codex never receive this adapter. */
export function nativeOmpExtensionArgs(backend, env = process.env, platform = process.platform, available = existsSync) {
  const mode = env.PAPERCUSP_MCP_TRANSPORT || "http";
  if (backend !== "omp" || mode === "http" || !["linux", "darwin"].includes(platform) ||
      env.WSL_INTEROP || env.WSL_DISTRO_NAME || env.PAPERCUSP_IPC_TCP === "1") return [];
  if (!["uds", "auto"].includes(mode)) throw new Error("Invalid MCP transport; expected http, uds or auto");
  if (!available(nativeMcpExtension) || !available(nativeMcpBundle))
    throw new Error("Native MCP bundle missing; run npm run build:native -w @papercusp/omp");
  return ["-e", fileURLToPath(nativeMcpExtension)];
}
import {
  fireSessionCompactedEvent,
  hostThroughPty,
  fleetOscFromEnv,
  findLiveHostFor,
  hostIdleMs,
  readHostHandoff,
  readHostHandoffForParentPid,
  reexecExitCodeFrom,
  missingReexecLoopDiagnosis,
  warnMissingReexecLoop,
} from "./psu-pty-host.mjs";

/**
 * WI-10001537: `reexecExitCodeFrom`, plus a one-line operator warning when its
 * null is the DEFECT case (an unmanaged shim earlier on PATH advertising no
 * re-exec loop) on an interactive launch. Silent for every legitimate null —
 * headless member, nested psu, explicit kill switch.
 */
function reexecExitCodeAnnounced(env) {
  const code = reexecExitCodeFrom(env);
  if (code == null) warnMissingReexecLoop({ diagnosis: missingReexecLoopDiagnosis(env) });
  return code;
}
import { runPsuConnectionFrontController } from "./psu-connection-front-controller.mjs";
// DERIVED tool-delivery map (deterministic-tool-definition-delivery-2026-09-21).
// A plain generated .mjs of frozen literals, deliberately: this launcher is
// dependency-free by design and must import it with no build step. Regenerate
// with `npm run gen:tool-delivery`; `npm run gen:tool-delivery:check` is wired
// into the affected-run gate, so a stale artifact reds rather than drifts.
import { TOOL_DELIVERY_BY_AGENT_KIND } from "./tool-delivery.generated.mjs";
import {
  analyzeClaudeResumeTranscript,
  appendClaudeToolReferencesToSeed,
} from "../../../packages/operator-core/lib/claude-resume-tool-references.mjs";
import {
  RECOVERY_CAPABILITY_DIAGNOSTIC,
  hasRecoveryCliFlag,
  issueRecoveryGrant,
  readRecoveryAncestorCmdlines,
  reconcileRecoveryAudit,
  recoveryAuthorizationEligibility,
  runRecoveryGrant,
  stripRecoveryMarkers,
  validateRecoveryCliArgv,
} from "./psu-recovery.mjs";
// Shared with the proxy itself (WI-6738) — psu must not give up while the proxy is still
// retrying on its behalf. Plain .mjs so this bare-node script and the tsx-run proxy can
// import the SAME definition.
import { PSU_REQUEST_TIMEOUT_MS } from "../lib/mcp-proxy/budgets.mjs";
import {
  RUNTIME_OVERHEAD_TOKENS,
  buildContextBudget,
  codexContextConfigArgs,
  codexContextConfigToml,
  codexModelConfigToml,
  listCodexInstalledModels,
  normalizeCodexCliModel,
  isCodexModelDenied,
  CODEX_DENIED_MODEL_IDS,
  resolveCodexModel,
  resolveCodexModelSelection,
} from "../../../packages/operator-core/lib/model-context-budget.mjs";
// WI-126377: the ONE builder for this picker's rows + the effort intersection
// rule. Plain .mjs for the same reason as every import below it — see that
// file's header for why a registry's advertised effort list can never be
// offered verbatim.
import {
  buildResumeModelRows,
  composeRegistryModelSpec,
  effortRowsFor,
} from "../../../packages/operator-core/lib/su-model-menu.mjs";
// EI-996: the ONE su-tier role list, shared with the server-side allow-list in
// su-role-addendum.ts. Plain .mjs so this bare-node script and the tsx/bundled
// operator import the SAME definition — a second copy here would drift silently.
import { SU_TIER_ROLES } from "../../../packages/operator-core/lib/su-tier-roles.mjs";
// P-021/D-013: the ONE local-model predicate, shared with the server-side
// OMP_NATIVE_LSP_BUILTIN tier gate in bootstrap-{su,role}.ts. This file used to
// carry two byte-identical copies of its regex pair (cloudModelBackendHint,
// validateModelSpec); both now call it, so the gate cannot drift from them.
import { isLocalModelSpec } from "../../../packages/operator-core/lib/local-model-spec.mjs";
import { EXTERNAL_SCHEDULES } from "../../../packages/operator-core/lib/schedule-descriptors.mjs";
import {
  SU_CONTEXT_SIZE,
  normalizeSuContextSize,
} from "../../../packages/operator-core/lib/su-context-size.mjs";
// P-023 (D-015): the TIER half of the omp native-lsp gate, shared with the
// server-side `mayKeepOmpNativeLsp` so the resume path cannot drift from it.
import { ompModelTierAllowsNativeLsp } from "../../../packages/operator-core/lib/omp-native-lsp-tier.mjs";
// WI-37920: ONE definition of where a backend CLI can live + how to reach it,
// shared with the operator's spawn-env injection (console-launcher). See that
// file's header for why detection and execution are two separate layers.
import {
  wellKnownBackendBin as sharedWellKnownBackendBin,
  readShebangInterpreter,
  resolveOnPath,
  resolveInWellKnownDirs,
} from "../../../packages/operator-core/lib/backend-bin-resolve.mjs";
// WI-37841: the ONE derivation of a launch's boot-log path, shared with
// launch-su.ts (which points the keep-window-open receipt at the same file) and
// with the reader that surfaces its tail on the failed-launch banner. Plain .mjs
// for the same reason as the imports above.
import {
  ensurePsuLaunchLogPath,
  prunePsuLaunchLogs,
  PSU_LAUNCH_LOG_MAX_BYTES,
} from "../../../packages/operator-core/lib/psu-launch-log.mjs";
import {
  CODEX_GATEWAY_PROVIDER_ID,
  codexGatewayConfigToml,
} from "@papercusp/orchestrator/codex-gateway-config";
import {
  prepareOmpGatewayModelsConfig,
  ompGatewayModelsConfig,
  ompGatewayModelFromSpec,
} from "@papercusp/orchestrator/omp-gateway-config";

export const AGENTS = ["claude", "omp", "codex"];

/** The caller/origin marker used when PUI invokes the real PSU picker. */
export const PUI_TUI_ORIGIN = "pui";

/**
 * Build the public interactive backend choices. PUI is a launcher destination,
 * not an agent backend, so it is deliberately kept out of AGENTS (the backend
 * validation set) and added only to this picker. A PUI-originated invocation
 * filters the destination back out to prevent recursive `pui workbench`
 * launches.
 */
export function agentPickerChoices({ tui = null } = {}) {
  const choices = AGENTS.map((agent) => ({ name: agent, value: agent }));
  if (tui !== PUI_TUI_ORIGIN) choices.push({ name: "pui", value: "pui" });
  return choices;
}

/** Exact command used when the PSU picker selects the PUI destination. */
export function puiWorkbenchCommand() {
  return { bin: "pui", args: ["workbench"] };
}

/** Run the PUI workbench command in the current terminal, preserving status. */
export function launchPuiWorkbench({
  spawnImpl = spawnSync,
  cwd = process.cwd(),
  env = sanitizeInheritedEnv(process.env),
} = {}) {
  const { bin, args } = puiWorkbenchCommand();
  const result = spawnImpl(bin, args, { cwd, env, stdio: "inherit" });
  if (result?.error)
    throw new Error(
      `psu: failed to launch PUI workbench: ${result.error.message}`,
    );
  return result?.status ?? (result?.signal ? 1 : 0);
}

/**
 * The side-effect-free CLI reference shown by `psu --help`.
 *
 * Keep this next to parseArgs so adding a launcher flag has an obvious,
 * discoverable place to document it. The `--` escape hatch remains available
 * for backend-native flags that psu intentionally does not own.
 */
export const PSU_HELP_TEXT = `Usage: psu [options]

Launch an interactive Papercusp superuser session, or use --no-picker for a
scripted launch.

Session selection:
  -h, --help                         Show this help and exit
  -V, --version                      Show the psu build version and exit
  --resume[=<id>] [id]               Resume a tracked or native session
  --fork, --fork-session             Fork the selected session (with --resume)
  --brain                            Show the retired brain-session message

Launch context:
  --agent=<claude|omp|codex>         Backend to launch
  --tui=<pui>                       Caller origin (PUI hides recursive PUI choice)
  --role=<role>                      Launch a role-scoped session
  --stack=<slot:id|composition:id>   Select an identity component or named composition
  --identity-revision=<sha256>       Require the selected stack source revision
  --workspace=<slug>                 Workspace context
  --harness=<slug>                   Harness context
  --feature=<id>                     Feature context
  --plan=<slug>                      Plan context
  --no-plan                          Launch without a plan
  --model=<model[:effort]>           Model and optional effort
  --model-source=<source>            Codex provenance: explicit|inherited|configured-default
  --profile=<engineer|power>         SU prompt profile
  --context-size=trimmed|steward     Initial tool seed (steward = core + steward verb families, WI-2140338; legacy full normalizes to trimmed)
  --compaction-limit=<tokens>        Requested compaction limit
  --launch-context=<path>            Additional launch brief
  --kickoff=<text>                   Seed the first user turn
  --no-kickoff                       Do not seed a scripted first turn
  --label=<text>                     Label the tracked session

Fleet and execution:
  --fleet=<slug>                     Join an existing fleet
  --seat=<ref>                       Consume a delegated fleet seat
  --headless                         Launch without a desktop window
  --auto, --no-auto                  Set AUTO mode explicitly
  --mode=drain|grade|test            Start in a named mode (launches autonomously)
  --mode-subject=<text>              DRAIN subject
  --mode-instructions=<text>         DRAIN instructions
  --mode-owner-directed              Mark the DRAIN mode owner-directed
  --goal-bootstrap-subject=<id>      Require exact GOAL subject and implied modes before turn one
  --carry=<warm|cold>                Fleet carry mode
  --account=<id|auto|default>        Account routing

Launcher controls:
  --no-picker                        Skip interactive prompts
  --add-dir=<dir>                    Add a backend working directory (repeatable)
  --allow-subagents, --no-subagents Allow or deny Claude subagent tools
  --yes, -y                          Skip untracked-resume confirmation
  --force                            Override launch preflight guards
  --set-claude-token[=<token>]       Store the default Claude OAuth token
  --clear-claude-token               Clear the stored Claude OAuth token
  --recovery-authorize               Locally authorize one exact diagnostic argv
  --recovery-reason=<text>           Required authorization reason
  --recovery-ttl=<seconds>           Grant lifetime (default 300, max 900)
  --recovery-max-runtime=<seconds>   Command deadline (default 60, max 300)
  --recovery-grant=<uuid>            Consume a signed one-use recovery grant
  --                                 Forward remaining arguments to the backend

Remote hosts (run psu on another machine; every other option is forwarded to it):
  --connect[=<name>[/<workspace>]]   Run on a saved remote host (picker when omitted)
  --connect-list                     List saved remote hosts and cloud workspaces
  --connect-login[=<portal>]         Sign in to Papercusp cloud (default https://app.papercusp.com)
  --connect-logout[=<name>]          Sign out of Papercusp cloud on this computer
  --connect-session=<key>            Reattach a specific cloud workspace shell
  --connect-add-gcp-iap=<name>       Save your own GCP VM, reached over IAP SSH, with
                                     --connect-project, --connect-zone,
                                     --connect-instance and --connect-user
  --connect-remove=<name>            Forget a saved remote host

Values may use either --name=value or (where supported) --name value form.
`;

/**
 * Does `--role=<role>` launch on the SU tier (full engineer playbook + superuser
 * MCP + that role's addendum) rather than via the role-scoped bootstrap? EI-996.
 *
 * `su` itself is the plain SU flow and is NOT a su-tier ROLE — it carries no
 * addendum — but both fall through to the same launch path, which is why this
 * answers the ROUTING question ("skip roleFlow") and `suRoleFor` separately
 * answers the ADDENDUM question ("which role's lines, if any").
 */
export function launchesOnSuTier(role) {
  return role === "su" || SU_TIER_ROLES.includes(role);
}

/** The su_role to send for a launch, or null for a plain su session. EI-996. */
export function suRoleFor(role) {
  return role !== "su" && SU_TIER_ROLES.includes(role) ? role : null;
}
/** Sentinel value for the "NO PLAN" picker row. Uses non-slug chars
 *  (`<`/`>`) so it can never collide with a real plan slug. */
export const NO_PLAN = "<no-plan>";

/**
 * Is the resilient MCP proxy (mcp-host-availability-resilience-2026-06-22 P-005,
 * systemd user unit `papercup-mcp-proxy`, default :9071 → :3070) alive on this
 * box? The ROUTE decision is the systemd unit being `active` — the unit is the
 * sole legitimate port owner per the P-006 cutover, so a stale role MCP host
 * squatting the port (role hosts have historically used e.g. :9071) still can't
 * false-positive: it has no active unit. The /api/health check THROUGH the proxy
 * is ADVISORY ONLY (warn, never reroute). It used to be a hard second factor,
 * but a transient health blip at launch (busy box, or :3070 mid-deploy-restart —
 * the very window the proxy exists to bridge) then minted a LIFETIME direct
 * :3070 pin into the child session's env, which is the exact availability
 * failure the proxy was built to prevent (observed live on two sessions,
 * mcp-outage-triage-2026-07-02). A genuinely wedged proxy fails loudly on first
 * use and gets fixed; a silent direct pin severs the session's tools on every
 * subsequent deploy.
 * Sync (resolveOperatorUrl runs at module top level); each check is loopback +
 * bounded, so the added launch latency is ~10–50ms. Exported for tests.
 */
export function defaultMcpProxyProbe(port) {
  try {
    const proxyHealth = spawnSync(
      "curl",
      [
        "-s",
        "-o",
        "/dev/null",
        "-m",
        "2",
        "-w",
        "%{http_code}",
        `http://127.0.0.1:${port}/__mcp_proxy_health`,
      ],
      { encoding: "utf8", timeout: 3_000 },
    );
    if ((proxyHealth.stdout ?? "").trim() === "200") return true;

    const unit = spawnSync(
      "systemctl",
      ["--user", "is-active", "papercup-mcp-proxy"],
      {
        encoding: "utf8",
        timeout: 2_000,
      },
    );
    if ((unit.stdout ?? "").trim() !== "active") return false;
    const health = spawnSync(
      "curl",
      [
        "-s",
        "-o",
        "/dev/null",
        "-m",
        "6",
        "-w",
        "%{http_code}",
        `http://127.0.0.1:${port}/api/health`,
      ],
      { encoding: "utf8", timeout: 8_000 },
    );
    if ((health.stdout ?? "").trim() !== "200") {
      console.warn(
        `psu: MCP proxy unit is active on :${port} but /api/health through it did not return 200 — ` +
          `routing via the proxy anyway (it bridges operator restarts; a direct pin would be permanent). ` +
          `If tools fail, check papercup-mcp-proxy.service and :3070.`,
      );
    }
    return true;
  } catch {
    return false; // no systemctl / any error ⇒ treat as no proxy (safe fallback)
  }
}

/**
 * Resolve the operator's base URL. Precedence:
 *   1. PAPERCUSP_OPERATOR_URL env — explicit override (highest). If it targets
 *      the fixed :3070 while the resilient proxy is active, a loud warning is
 *      emitted (WI-1457: proxy active-but-unrouted) — the override still wins.
 *   2. The RESILIENT MCP PROXY (`http://127.0.0.1:9071`, WI-1457 hardening) —
 *      when it is verifiably alive. This is the dev-box steady state, and now
 *      also the packaged steady state: sessions ride the always-up proxy so a
 *      dynamic operator port restart is invisible (retry-on-refused, never
 *      double-applies a write). Opt out with PAPERCUSP_MCP_PROXY=0; port
 *      override via PAPERCUSP_MCP_PROXY_PORT. The proxy is a generic
 *      passthrough, so the whole operator HTTP surface (not just /api/mcp)
 *      works through it.
 *   3. ~/.papercusp/operator.json `httpUrl` (or `port`) — the DESKTOP operator's
 *      ACTUAL address. A shipped Tauri desktop app runs its operator on a
 *      dynamically-assigned localhost port (rewritten on every boot), NOT a
 *   4. http://localhost:3070 — the dev-box direct default (no proxy installed).
 * The desktop never has operator.json missing, and the dev box never WRITES
 * operator.json in steady state, so each environment lands on the right branch
 * with no cross-contamination. Exported for tests; `probe`/`warn` injectable.
 */
/**
 * WI-6821 DEFECT A — `PAPERCUSP_OPERATOR_URL` is contractually a BARE BASE: every
 * caller appends the path itself (`${base}/api/mcp?…`, `${base}/api/admin/…`).
 * A value that ALREADY ends in `/api/mcp` therefore builds `…/api/mcp/api/…`,
 * which 404s — and psu died on that with a bare `not_found` and exit 1 about
 * 0.4s in. That is not a cosmetic failure: `launch-su.ts` runs psu as
 * `exec <psu …>` inside `gnome-terminal --wait`, so psu exiting IS the window
 * closing. The terminal flashed open and shut, the recorded pid died, the
 * session never registered, and its adv_sessions row sat at `session_id NULL`
 * advertising "Starting up — waiting for this session to come online…" for the
 * whole 15-minute window (the owner-reported symptom, 2026-08-02).
 *
 * Reproduced with a one-variable control: `http://127.0.0.1:3070` launched
 * cleanly (exit 0), `http://127.0.0.1:3070/api/mcp` died in 0.4s. Nothing else
 * differed.
 *
 * The launcher that leaked it is fixed at its own source, but this is the choke
 * point EVERY psu launch passes through and psu can be started by any parent (a
 * human shell with a stale export, another tool), so normalize here too rather
 * than leaving the trap armed for the next caller. Every OTHER branch of
 * resolveOperatorTarget already returns a bare base — this env branch was the
 * only one that could return a path-suffixed url.
 *
 * A base can never legitimately END in the path about to be appended to it, so
 * stripping is unambiguous, not a guess. Anything unparseable is returned
 * untouched — the connection path reports that far better than a silent rewrite.
 * Exported for tests; `warn` injectable.
 */
export function normalizeOperatorBaseUrl(
  raw,
  { warn = (m) => console.warn(m) } = {},
) {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  let u;
  try {
    u = new URL(trimmed);
  } catch {
    return trimmed;
  }
  if (!/\/api\/mcp\/?$/i.test(u.pathname)) return trimmed.replace(/\/+$/, "");
  u.pathname = u.pathname.replace(/\/api\/mcp\/?$/i, "");
  // The suffixed form is the agent MCP url, which carries the session's signed
  // query (`?sid=…`). Those params address /api/mcp specifically and are
  // meaningless — and misleading — on a base, so drop them with the path.
  u.search = "";
  u.hash = "";
  const fixed = u.toString().replace(/\/+$/, "");
  warn(
    `psu: PAPERCUSP_OPERATOR_URL is "${trimmed}", but it must be a BARE BASE — the /api/mcp path is appended per call, ` +
      `so this pin would request …/api/mcp/api/… and EVERY operator call would 404 (psu would exit "not_found" in well ` +
      `under a second, closing its terminal window immediately). Using "${fixed}" instead — fix whatever exports the ` +
      `suffixed value (WI-6821).`,
  );
  return fixed;
}

// Shared with ptool and the PTY host: only launcher-managed URLs may rediscover.
export const OPERATOR_URL_PROVENANCE_ENV = "PAPERCUSP_OPERATOR_URL_PROVENANCE";
export const LAUNCHER_OPERATOR_URL_PROVENANCE = "psu-launcher";

export function resolveOperatorTarget({
  env = process.env,
  home = homedir(),
  probe = defaultMcpProxyProbe,
  warn = (m) => console.warn(m),
} = {}) {
  const proxyOptedOut = env.PAPERCUSP_MCP_PROXY === "0";
  const proxyPort =
    Number(env.PAPERCUSP_MCP_PROXY_PORT) > 0
      ? Number(env.PAPERCUSP_MCP_PROXY_PORT)
      : 9071;
  if (env.PAPERCUSP_OPERATOR_URL) {
    const pinned = normalizeOperatorBaseUrl(env.PAPERCUSP_OPERATOR_URL, {
      warn,
    });
    // WI-1457: an explicit :3070 pin while the proxy is alive is exactly the
    // active-but-unrouted regression — honor the override, but say so loudly.
    if (!proxyOptedOut && /:3070\b/.test(pinned) && probe(proxyPort)) {
      warn(
        `psu: PAPERCUSP_OPERATOR_URL pins ${pinned} but the resilient MCP proxy is ACTIVE on :${proxyPort} — ` +
          `this session bypasses deploy-restart resilience (WI-1457). Unset the override (or point it at :${proxyPort}) to ride the proxy.`,
      );
    }
    return {
      url: pinned,
      source: env[OPERATOR_URL_PROVENANCE_ENV] === LAUNCHER_OPERATOR_URL_PROVENANCE
        ? "managed-env" : "env",
      startedAt: null,
    };
  }
  // WI-3247: prefer the stable proxy over desktop operator.json when present.
  // operator.json carries a per-boot dynamic port; exporting it into a long-lived
  // child makes that session lose MCP after the operator restarts. The proxy
  // re-resolves operator.json per attempt, so the child env stays stable.
  if (!proxyOptedOut && probe(proxyPort))
    return {
      url: `http://127.0.0.1:${proxyPort}`,
      source: "proxy",
      startedAt: null,
    };
  try {
    const d = JSON.parse(
      readFileSync(join(home, ".papercusp", "operator.json"), "utf8"),
    );
    // startedAt (epoch ms, written by serve on come-up) dates the record: a
    // desktop whose operator died leaves a STALE record behind, and psu's
    // connection-failure handling uses that age to fail fast with real guidance
    // instead of a quiet 30s retry (WI-3271).
    const startedAt = Number(d?.startedAt) > 0 ? Number(d.startedAt) : null;
    if (d && typeof d.httpUrl === "string" && d.httpUrl)
      return { url: d.httpUrl, source: "discovery", startedAt };
    if (d && d.port)
      return {
        url: `http://127.0.0.1:${d.port}`,
        source: "discovery",
        startedAt,
      };
  } catch {
    /* no/!readable operator.json (the dev box) → proxy / dev-port fallback below */
  }
  return {
    url: "http://localhost:3070",
    source: "dev-default",
    startedAt: null,
  };
}

/** Back-compat string form of resolveOperatorTarget (exported for tests/callers). */
export function resolveOperatorUrl(opts = {}) {
  return resolveOperatorTarget(opts).url;
}

// `let` (not const): fetchWithResilience fails over to a live alternative when
// the resolved target is dead (stale-shell heal below) — every later api()
// call / child-session URL derivation picks up the adopted target because the
// defaults at those call sites read these bindings per call.
let OPERATOR_TARGET = resolveOperatorTarget();
let OPERATOR_URL = OPERATOR_TARGET.url;

/**
 * Apply the current launcher target to a child environment and preserve URL
 * provenance. An explicit PAPERCUSP_OPERATOR_URL source is a caller pin and
 * must remain fixed; discovery/proxy/default targets are launcher-managed.
 * Exported for the environment-boundary regression tests.
 */
export function applyLauncherOperatorUrlEnv(env, target = OPERATOR_TARGET) {
  // These describe the spawning operator host, not the agent session. ptool
  // prefers either hint over PAPERCUSP_OPERATOR_URL, so carrying a stale host
  // port through a loop respawn can route every named tool call to the wrong
  // control plane even after the launcher selected a live operator URL.
  delete env.PAPERCUSP_OPERATOR_BASE;
  delete env.PAPERCUSP_HONO_PORT;
  env.PAPERCUSP_OPERATOR_URL = target.url;
  if (target.source === "env")
    delete env[OPERATOR_URL_PROVENANCE_ENV];
  else
    env[OPERATOR_URL_PROVENANCE_ENV] = LAUNCHER_OPERATOR_URL_PROVENANCE;
  return env;
}

/**
 * The candidate ladder for HEALING a dead operator target mid-session — the
 * same ladder as resolveOperatorTarget MINUS the inherited managed URL.
 * Explicit caller pins never use this ladder. Candidates are NOT liveness-checked here;
 * fetchWithResilience health-checks each in order. Exported for tests.
 *
 * Why this exists (owner repro, mac VM 2026-07-07): every console/fleet
 * terminal exports PAPERCUSP_OPERATOR_URL for the operator instance that
 * spawned it, but a desktop operator's port is per-boot dynamic — a window
 * that outlives its operator pins a DEAD port, and psu burned the whole
 * connect budget on it and failed ("operator unreachable") while a healthy
 * operator sat one operator.json read away.
 */
export function resolveFallbackOperatorTargets({
  env = process.env,
  home = homedir(),
  excludeUrls = [],
} = {}) {
  const out = [];
  const push = (url, source, startedAt = null) => {
    if (url && !excludeUrls.includes(url) && !out.some((c) => c.url === url))
      out.push({ url, source, startedAt });
  };
  const proxyOptedOut = env.PAPERCUSP_MCP_PROXY === "0";
  const proxyPort =
    Number(env.PAPERCUSP_MCP_PROXY_PORT) > 0
      ? Number(env.PAPERCUSP_MCP_PROXY_PORT)
      : 9071;
  if (!proxyOptedOut) push(`http://127.0.0.1:${proxyPort}`, "proxy");
  try {
    const d = JSON.parse(
      readFileSync(join(home, ".papercusp", "operator.json"), "utf8"),
    );
    const startedAt = Number(d?.startedAt) > 0 ? Number(d.startedAt) : null;
    if (d && typeof d.httpUrl === "string" && d.httpUrl)
      push(d.httpUrl, "discovery", startedAt);
    else if (d && d.port)
      push(`http://127.0.0.1:${d.port}`, "discovery", startedAt);
  } catch {
    /* no/!readable operator.json (the dev box) */
  }
  push("http://localhost:3070", "dev-default");
  return out;
}

/**
 * Adopt a healed operator target session-wide: later api() calls and child
 * sessions derive their URL from these bindings, and the env export means any
 * child that inherits raw process.env gets the WORKING address instead of the
 * dead pin this process was started with. Exported for tests.
 */
export function adoptOperatorTarget(t) {
  OPERATOR_TARGET = t;
  OPERATOR_URL = t.url;
  applyLauncherOperatorUrlEnv(process.env, t);
}

/**
 * Per-request timeout (ms). `fetch` has no default timeout, so a wedged or
 * CPU-saturated operator used to make `psu` hang FOREVER on its first picker
 * call (`bootstrap-su/options`) with no output. A bounded timeout fails fast
 * with an actionable message instead. Override with PAPERCUSP_PSU_TIMEOUT_MS.
 */
// Per-request timeout. History: 15s→45s (2026-06-07, a busy operator can take 10-30s on a
// hop-heavy bootstrap route under fleet load), then 45s→DERIVED (WI-6738).
//
// 45s was wrong for a reason no amount of tuning fixes: psu dials the mcp-proxy, and the
// proxy retries a refused upstream for up to MCP_PROXY_RETRY_WINDOW_MS (90s). Giving up at
// 45s meant abandoning a request the front door was still actively retrying — so every
// :3070 gap between 45s and 90s became a hard, user-visible psu failure that the proxy
// existed to absorb. Owner hit exactly that on 2026-08-01 and reported the system down; it
// self-recovered ~90s later.
//
// The number now DERIVES from the proxy's window (+ headroom) so the two cannot drift apart
// again; budgets.test.ts asserts the invariant. A truly wedged host still fails with the
// same guidance — just after the proxy has actually exhausted its retries, not during them.
// Override still honored: PAPERCUSP_PSU_TIMEOUT_MS.
const REQUEST_TIMEOUT_MS = PSU_REQUEST_TIMEOUT_MS;
// A TIMEOUT means the host accepted but didn't answer within REQUEST_TIMEOUT_MS
// (wedged, not restarting) — a retry just burns another full timeout, so keep
// these few. Tunable via PAPERCUSP_PSU_RETRIES (kept for back-compat).
const TIMEOUT_RETRIES = Number(process.env.PAPERCUSP_PSU_RETRIES) || 1;
// A CONNECTION failure (refused/reset — undici's "fetch failed") almost always
// means the operator is mid-recycle: the memory-watchdog drains + exits and
// systemd restarts a fresh process (~10-15s unreachable per cycle), which on a
// busy box recurs. These fail in milliseconds, so rather than one fixed retry we
// keep retrying on a short backoff until this wall-clock budget elapses — riding
// THROUGH the restart window instead of failing the launch on the first dead
// tick. A genuine outage still fails once the budget is spent. 0 disables.
const _connectRetryRaw = Number(process.env.PAPERCUSP_PSU_CONNECT_RETRY_MS);
const CONNECT_RETRY_BUDGET_MS = Number.isFinite(_connectRetryRaw)
  ? _connectRetryRaw
  : 30_000;
// WI-3271: the 30s ride-through is for a MID-RESTART operator. On a desktop
// install whose operator DIED (app closed / supervision gave up), operator.json
// keeps the dead port with an old startedAt — burning the full budget there is
// the owner-reported "psu → nothing happened" UX. When the discovery record is
// older than this, a connection failure fails FAST (budget below) with an
// actionable "start the Papercusp app" message instead. A record younger than
// this still gets the full ride-through (a restarting operator rewrites
// operator.json on come-up, so a fresh record = plausibly mid-boot).
const STALE_DISCOVERY_MS = 10 * 60_000;
const STALE_FAST_FAIL_BUDGET_MS = 5_000;

// The MCP proxy marks admission shedding with HTTP 429 + Retry-After. Treat that
// response as a bounded, safe-to-replay front-door condition: the proxy sheds
// before forwarding, so no operator-side work has run yet. Keep this separate
// from connection retry (which rides an operator recycle) and timeout retry
// (which is intentionally tiny because the request may have reached the host).
export const MCP_PROXY_OVERLOAD_MAX_ATTEMPTS = 5;
export const MCP_PROXY_OVERLOAD_RETRY_BUDGET_MS = 20_000;
export const MCP_PROXY_OVERLOAD_DEFAULT_RETRY_MS = 1_000;
export const MCP_PROXY_OVERLOAD_MAX_RETRY_MS = 5_000;

// WI-41363: a fresh bootstrap is replay-safe only when it carries the stable
// idempotency key cached by bootstrap-su. The proxy's upstream-silent 502 means
// the request MAY still have completed, so this budget is deliberately separate
// from connection/429 retries and remains small enough not to amplify a busy
// request cluster. Four total attempts fit inside psu's 120s request budget even
// when each proxy attempt spends the full 8s response-header timeout.
export const BOOTSTRAP_REPLAY_MAX_ATTEMPTS = 4;
export const BOOTSTRAP_REPLAY_BUDGET_MS = 30_000;
export const BOOTSTRAP_REPLAY_DEFAULT_DELAY_MS = 1_000;

/** Parse a Retry-After delta-seconds value into a bounded delay for psu's
 * front-door overload retry. Invalid/missing values use the supplied fallback. */
export function proxyOverloadRetryDelayMs(
  value,
  fallbackMs = MCP_PROXY_OVERLOAD_DEFAULT_RETRY_MS,
  maxMs = MCP_PROXY_OVERLOAD_MAX_RETRY_MS,
) {
  const raw = Array.isArray(value) ? value[0] : value;
  const seconds =
    typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  if (!Number.isFinite(seconds) || seconds < 0) return fallbackMs;
  return Math.min(maxMs, seconds * 1_000);
}

/** Only the proxy's explicitly retryable admission response is absorbed. A
 * bare application 429 without Retry-After is returned to the caller unchanged. */
export function isRetryableMcpProxyOverload(response) {
  if (response?.status !== 429) return false;
  return (
    typeof response?.headers?.get === "function" &&
    response.headers.get("retry-after") != null
  );
}

/**
 * Classify the two typed bootstrap responses that are safe to replay with the
 * SAME idempotency key. `clone()` preserves the original response for api() to
 * surface unchanged when the bounded retry budget is exhausted.
 */
export async function bootstrapReplayDirective(response) {
  if (response?.status !== 409 && response?.status !== 502) return null;
  let body;
  try {
    body = await response.clone().json();
  } catch {
    return null;
  }
  if (response.status === 502 && body?.error === "mcp_proxy_upstream_error") {
    return {
      kind: "upstream-silent",
      delayMs: BOOTSTRAP_REPLAY_DEFAULT_DELAY_MS,
    };
  }
  if (response.status === 409 && body?.error === "bootstrap_in_progress") {
    return {
      kind: "in-progress",
      delayMs: proxyOverloadRetryDelayMs(
        body?.retryAfterSec,
        BOOTSTRAP_REPLAY_DEFAULT_DELAY_MS,
        MCP_PROXY_OVERLOAD_MAX_RETRY_MS,
      ),
    };
  }
  return null;
}

/** Coarse human age ("3m" / "2h" / "5d") for the stale-operator message. */
function fmtAgo(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "an unknown time";
  const m = Math.round(ms / 60_000);
  if (m < 1) return "under a minute";
  if (m < 120) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Floor for `--compaction-limit`, mirroring MIN_COMPACTION_LIMIT_TOKENS in
 *  packages/operator-core/lib/agent-config-constants.ts. Duplicated (this launcher
 *  is plain .mjs and imports no TS) and pinned by a parity assertion in
 *  apps/operator/lib/psu-launcher.test.ts — the same pattern validateModelSpec uses. */
export const MIN_COMPACTION_LIMIT_TOKENS = 20_000;

/** Parse the scripting-escape flags. Pure — exported for tests. */
export function parseArgs(argv) {
  const out = {
    picker: true,
    resume: false,
    resumeId: null,
    fork: false,
    agent: null,
    role: null,
    stack: [],
    selectedIdentityRevision: null,
    feature: null,
    workspace: null,
    harness: null,
    plan: null,
    noPlan: false,
    model: null,
    resumeSession: null,
    launchContext: null,
    launchedBy: null,
    ownerId: null,
    profile: null,
    contextSize: null,
    personaTier: null,
    compactionLimit: null,
    force: false,
    yes: false,
    brain: false,
    account: null,
    fleet: null,
    fleetRole: null,
    fleetName: null,
    fleetScheme: null,
    auto: null,
    mode: null,
    seat: null,
    carry: null,
    addDir: [],
    passthrough: [],
    setClaudeToken: false,
    setClaudeTokenValue: null,
    clearClaudeToken: false,
    recoveryAuthorize: false,
    recoveryGrant: null,
    recoveryReason: null,
    recoveryTtlMs: null,
    recoveryMaxRuntimeMs: null,
    allowSubagents: null,
    kickoffPromptText: null,
    label: null,
    headless: false,
    tui: null,
  };
  // Everything after a literal `--` is forwarded VERBATIM to the underlying agent
  // CLI (claude/omp/codex) — a generic escape hatch so a new backend flag needs no
  // psu change. Appended at the END of the launch/resume argv (launchFreshSu /
  // launchResume); ordering past that is the caller's responsibility.
  let rest = false;
  let pendingAddDir = false;
  let pendingAccount = false;
  let pendingFleet = false;
  // EI-181: the space-separated form of the six most-scripted value flags
  // (`psu --role operator` etc.) used to be SILENTLY DROPPED — `--role` matched
  // no `--role=` prefix (ignored) and the bare value `operator` matched no
  // positional case either (ignored), so role/agent/etc. resolved to null and
  // psu fell through to the interactive picker with zero error or warning (cost
  // a multi-round debugging session when a dock pane launched exactly this
  // form). Mirrors the pre-existing --add-dir/--account/--fleet space-form
  // pattern below: the flag token arms a `pending*` latch, the NEXT token
  // (verbatim, even if it happens to start with `--`) is taken as the value.
  let pendingRole = false;
  let pendingStack = false;
  let pendingAgent = false;
  let pendingWorkspace = false;
  let pendingFeature = false;
  let pendingHarness = false;
  let pendingPlan = false;
  let pendingModeSubject = false;
  let pendingModeInstructions = false;
  let pendingTui = false;
  let pendingRecoveryReason = false;
  for (const a of argv) {
    if (rest) {
      out.passthrough.push(a);
      continue;
    }
    // `--add-dir <dir>` (space form) — the previous token armed this; take the
    // value verbatim (even if it looks like a flag, it's the dir the user meant).
    if (pendingAddDir) {
      pendingAddDir = false;
      out.addDir.push(a);
      continue;
    }
    if (pendingRole) {
      pendingRole = false;
      out.role = a;
      continue;
    }
    if (pendingStack) {
      pendingStack = false;
      out.stack.push(a);
      continue;
    }
    if (pendingAgent) {
      pendingAgent = false;
      out.agent = a;
      continue;
    }
    if (pendingWorkspace) {
      pendingWorkspace = false;
      out.workspace = a;
      continue;
    }
    if (pendingFeature) {
      pendingFeature = false;
      out.feature = a;
      continue;
    }
    if (pendingHarness) {
      pendingHarness = false;
      out.harness = a;
      continue;
    }
    if (pendingPlan) {
      pendingPlan = false;
      out.plan = a;
      continue;
    }
    if (pendingModeSubject) {
      pendingModeSubject = false;
      out.modeSubject = a;
      continue;
    }
    if (pendingModeInstructions) {
      pendingModeInstructions = false;
      out.modeInstructions = a;
      continue;
    }
    if (pendingTui) {
      pendingTui = false;
      if (a !== PUI_TUI_ORIGIN) {
        throw new Error(
          `--tui=${a} is not recognized — the only supported caller origin is \`${PUI_TUI_ORIGIN}\`.`,
        );
      }
      out.tui = a;
      continue;
    }
    if (pendingRecoveryReason) {
      pendingRecoveryReason = false;
      out.recoveryReason = a;
      continue;
    }
    // `--account <id>` (space form) — the previous token armed this; take the
    // value verbatim (an account id never starts with `--`).
    if (pendingAccount) {
      pendingAccount = false;
      out.account = a;
      continue;
    }
    // `--fleet <slug>` (space form) — join an EXISTING named fleet by slug
    // (member role). A new fleet is only created interactively (the picker
    // prompts for a name → leader), so the flag form always means "member".
    if (pendingFleet) {
      pendingFleet = false;
      out.fleet = a;
      out.fleetRole = "member";
      continue;
    }
    if (a === "--") {
      rest = true;
      continue;
    }
    // One-time credential commands (handled at the top of main(), before any
    // launch). Store/clear the default-account Claude OAuth token that
    // default-account claude psu sessions inherit cross-platform (esp. macOS,
    // where keychain-per-config-dir defeats file inheritance). The inline
    // `=<token>` form is for scripting; bare prompts for a paste.
    if (a === "--help" || a === "-h") {
      // Help is a terminal parser result: ignore any following launch flags so
      // `psu --help` cannot validate, prompt, contact the operator, or spawn.
      out.help = true;
      break;
    }
    if (a === "--version" || a === "-V") {
      // Version is also terminal: no picker, profile lookup, credential read,
      // operator request or connection-controller prompt may precede it.
      out.version = true;
      break;
    }
    if (a === "--set-claude-token") {
      out.setClaudeToken = true;
      continue;
    } else if (a.startsWith("--set-claude-token=")) {
      out.setClaudeToken = true;
      out.setClaudeTokenValue = a.slice("--set-claude-token=".length) || null;
      continue;
    } else if (a === "--clear-claude-token") {
      out.clearClaudeToken = true;
      continue;
    }
    if (a === "--recovery-authorize") {
      out.recoveryAuthorize = true;
      continue;
    } else if (a.startsWith("--recovery-grant=")) {
      out.recoveryGrant = a.slice("--recovery-grant=".length) || null;
      continue;
    } else if (a === "--recovery-reason") {
      pendingRecoveryReason = true;
      continue;
    } else if (a.startsWith("--recovery-reason=")) {
      out.recoveryReason = a.slice("--recovery-reason=".length);
      continue;
    } else if (a.startsWith("--recovery-ttl=")) {
      const seconds = Number(a.slice("--recovery-ttl=".length));
      if (!Number.isInteger(seconds) || seconds <= 0)
        throw new Error("--recovery-ttl must be a positive whole number of seconds");
      out.recoveryTtlMs = seconds * 1_000;
      continue;
    } else if (a.startsWith("--recovery-max-runtime=")) {
      const seconds = Number(a.slice("--recovery-max-runtime=".length));
      if (!Number.isInteger(seconds) || seconds <= 0)
        throw new Error("--recovery-max-runtime must be a positive whole number of seconds");
      out.recoveryMaxRuntimeMs = seconds * 1_000;
      continue;
    }
    if (a === "--no-picker") out.picker = false;
    // headless-fleet-launch (P-001): run with NO desktop window + no TTY, but STILL
    // through the managed-pty host so the session keeps its control socket and stays
    // injectable (warm `loop:arm` wakes land as `psu-socket-inject`, not a Channel-3
    // park). Sets PAPERCUSP_PSU_HEADLESS=1 for usePtyHost + the child env. Implies
    // --no-picker: there is no terminal to prompt at.
    else if (a === "--headless") {
      out.headless = true;
      out.picker = false;
    }
    // Fleet-launch attestation token (WI-38513). Carry behavior still comes from
    // the member baseline's loop:arm directive; this flag makes the resolved
    // choice durable in adv_sessions.launch_argv so launch verification can prove
    // the child received warm vs cold instead of trusting the caller's receipt.
    else if (a.startsWith("--carry=")) {
      const carry = a.slice("--carry=".length);
      if (carry !== "warm" && carry !== "cold") {
        throw new Error(`--carry must be warm|cold (got ${carry || "empty"})`);
      }
      out.carry = carry;
    }
    // THE brain (native-terminal-desktop D-013): resume the canonical pinned
    // brain session exactly (no picker); when none is pinned (or it no longer
    // resolves) launch a fresh claude SU session and pin it server-side.
    else if (a === "--brain") out.brain = true;
    // `--resume` alone → pick from the recent-session list. `--resume=<id>`
    // (or a bare id after `--resume`) → resume THAT session directly, no
    // picker. The id is the /adv adv_sessions row id OR a backend-native handle:
    // claude session UUID, OMP thread id, or Codex rollout UUID under a tracked
    // CODEX_HOME.
    else if (a === "--resume") out.resume = true;
    else if (a.startsWith("--resume=")) {
      out.resume = true;
      out.resumeId = a.slice("--resume=".length) || null;
    }
    // Fork the resumed session instead of appending to it. Claude uses
    // `--fork-session`; Codex uses `codex fork`. Both mint a NEW native session
    // seeded with the original's history, leaving the original id + transcript
    // untouched. psu additionally hands the fork a FRESH coord identity (new
    // PAPERCUSP_SID, no adv-row link unless the tracked Claude fork path can mint
    // one — see resumeEnvFor) so it can run CONCURRENTLY with the still-live
    // original without colliding on locks/presence/inbox-wake. OMP still has no
    // native branch command.
    else if (a === "--fork" || a === "--fork-session") out.fork = true;
    else if (a === "--no-plan") out.noPlan = true;
    // Subagent-launch tool (Task/Agent) governance (owner mandate 2026-07-02):
    // DENIED BY DEFAULT for every psu launch (su + role + resume), matching the
    // headless/bee posture. `--allow-subagents` is the explicit opt-IN that KEEPS
    // the tool for THIS launch; `--no-subagents` is kept as an (now-redundant)
    // explicit opt-OUT alias. Tri-state: null = unset (picker prompts; falls back
    // to deny), true = allow, false = deny. Threaded into roleLaunchArgs /
    // suLaunchArgs / resumeArgsFor, and re-emitted by fleet:launch-on-plan
    // ({ allowSubagents } → `--allow-subagents`). claude-only (the deny flag is a
    // claude CLI flag; omp/codex have no equivalent and are unaffected).
    else if (a === "--allow-subagents") out.allowSubagents = true;
    else if (a === "--no-subagents") out.allowSubagents = false;
    // improve-fleet-launch-autokickoff (EI-5503): opt OUT of the auto-kickoff first
    // user turn that a scripted plan launch (`--no-picker --plan=…`) otherwise seeds.
    // Default ON for scripted plan launches; this flag restores the old open-at-an-
    // empty-prompt behavior. (Interactive picker launches never auto-kickoff.)
    else if (a === "--no-kickoff") out.kickoff = false;
    else if (a === "--agent") pendingAgent = true;
    else if (a.startsWith("--agent=")) out.agent = a.slice("--agent=".length);
    else if (a === "--role") pendingRole = true;
    else if (a.startsWith("--role=")) out.role = a.slice("--role=".length);
    else if (a === "--stack") pendingStack = true;
    else if (a.startsWith("--stack=")) out.stack.push(a.slice("--stack=".length));
    else if (a.startsWith("--identity-revision="))
      out.selectedIdentityRevision = a.slice("--identity-revision=".length);
    else if (a === "--feature") pendingFeature = true;
    else if (a.startsWith("--feature="))
      out.feature = a.slice("--feature=".length);
    else if (a === "--workspace") pendingWorkspace = true;
    else if (a.startsWith("--workspace="))
      out.workspace = a.slice("--workspace=".length);
    else if (a === "--harness") pendingHarness = true;
    else if (a.startsWith("--harness="))
      out.harness = a.slice("--harness=".length);
    else if (a === "--plan") pendingPlan = true;
    else if (a.startsWith("--plan=")) out.plan = a.slice("--plan=".length);
    // P-032 omp-convergence passthroughs: a model fuzzy-match, resume of a
    // specific recorded session, and a kickoff/launch-context file the server
    // pre-generated (fed to the *-su wrapper as its launch-context).
    else if (a.startsWith("--model=")) {
      // Guard a malformed model spec (WI-1979) — a hand-typed `[1m]` marker / misspelled alias
      // (`fabel5[1m]`) is rejected HERE with a corrective suggestion, so it never reaches the CLI
      // as an unrunnable model that fails the launch silently. throw → the top-level main().catch
      // prints `psu: <message>` + exits. Covers EVERY launch path (raw psu, capability:terminal,
      // fleet:launch-on-plan) since all --model input funnels through parseArgs.
      const rawModel = a.slice("--model=".length);
      const v = validateModelSpec(rawModel);
      if (!v.ok) throw new Error(v.message);
      // Normalization is backend-specific and therefore happens after the
      // complete argv has resolved `--agent` below. OMP is multi-provider and
      // must receive configured model ids verbatim; Claude's `[1m]` marker is
      // not part of OMP's model grammar.
      out.model = rawModel;
    } else if (a.startsWith("--model-source=")) {
      const source = a.slice("--model-source=".length);
      if (!["explicit", "inherited", "configured-default"].includes(source)) {
        throw new Error(
          `--model-source must be explicit|inherited|configured-default (got ${source || "empty"})`,
        );
      }
      out.modelSource = source;
    } else if (a.startsWith("--resume-session="))
      out.resumeSession = a.slice("--resume-session=".length);
    else if (a.startsWith("--launch-context="))
      out.launchContext = a.slice("--launch-context=".length);
    // Free-form KICKOFF first user turn — the general form of the EI-5503 plan
    // auto-kickoff, decoupled from plans. A caller (e.g. the desktop tutorial's
    // "ask an agent" launcher) that wants the session to START by working a
    // specific prompt passes `--kickoff='<text>'`; it becomes the trailing
    // positional first turn (kickoffPositionalArgs), taking precedence over the
    // server's plan-derived kickoff. Same --no-picker + --no-kickoff gating.
    else if (a.startsWith("--kickoff="))
      out.kickoffPromptText = a.slice("--kickoff=".length);
    // Opaque LABEL stamped on this session's adv_sessions row (bootstrap-su reads
    // body.label). Lets the launcher later CORRELATE the booted session back to
    // its coord owner id (adv_sessions.coord_owner_id) — e.g. the tutorial's
    // docs-agent reuse: find the live `docs-tutor`-labelled session for a workspace.
    else if (a.startsWith("--label=")) out.label = a.slice("--label=".length);
    // solo-launch-provenance: the ownerId of the agent that launched this session
    // (capability:terminal auto-injects it into psu commands). Forwarded to
    // bootstrap-su, which bakes it into the system prompt + env + a standing fact.
    else if (a.startsWith("--launched-by="))
      out.launchedBy = a.slice("--launched-by=".length);
    // WI-5002/EI-13277 programmatic-spawner contract: PRE-PIN this fresh session's
    // coord owner id (bootstrap-su validates + uses it instead of minting). Exists
    // because the spawner's exported PAPERCUSP_SID is overridden by the launch
    // envelope — state a spawner keys pre-spawn (doors overrides, transcript reads)
    // otherwise binds to an owner the session never runs as.
    else if (a.startsWith("--owner-id="))
      out.ownerId = a.slice("--owner-id=".length);
    else if (a.startsWith("--context-size=")) {
      const normalized = normalizeSuContextSize(
        a.slice("--context-size=".length),
      );
      if (!normalized.ok)
        throw new Error(`--context-size: ${normalized.error}`);
      out.contextSize = normalized.contextSize;
      if (normalized.normalizedLegacyFull) {
        console.error(
          "psu: --context-size=full is retired; launching with trimmed instead. The growable tools:find/tools:invoke surface retains full capability reachability.",
        );
      }
    }
    // context-trimming-tiers P-017: persona tier — full | fleet. Omitted ⇒ the
    // server auto-selects from the model window (≤200k known model → fleet).
    else if (a.startsWith("--persona-tier="))
      out.personaTier = a.slice("--persona-tier=".length);
    // per-member-declarative-launch-specs P-005: this session's explicit soft
    // compaction limit in TOKENS (MemberSpec.compactionLimit). Recorded onto
    // adv_sessions.launch_argv by psuLaunchArgvRecord; the compaction watchdog's
    // seeding pass reads it back and applies it AHEAD of the tier/model default,
    // clamped to the fleet-role ceiling. Before this, a per-member limit could only
    // be REQUESTED in a brief ("set your own limit to N") — an instruction a member
    // could ignore, mis-apply, or reach only after its first compaction.
    // Malformed input THROWS (like --model/--mode): a limit silently dropped back to
    // the default is exactly the failure this flag exists to remove.
    else if (a.startsWith("--compaction-limit=")) {
      const rawLimit = a.slice("--compaction-limit=".length);
      const n = Number(rawLimit);
      if (!Number.isInteger(n) || n < MIN_COMPACTION_LIMIT_TOKENS) {
        throw new Error(
          `--compaction-limit=${rawLimit} is not valid — pass a whole number of TOKENS >= ${MIN_COMPACTION_LIMIT_TOKENS} ` +
            `(e.g. --compaction-limit=200000). The seed clamps it DOWN to your fleet-role ceiling; it never raises it.`,
        );
      }
      out.compactionLimit = n;
    }
    // context-trimming-tiers P-018: override the preflight window-guard refusal.
    else if (a === "--force") out.force = true;
    // P-023: su playbook profile (engineer|power) — assembled per-launch now,
    // so it's a launch flag, not a per-install choice. Default (server-side) engineer.
    else if (a.startsWith("--profile="))
      out.profile = a.slice("--profile=".length);
    // First-class `--add-dir <dir>` / `--add-dir=<dir>` (repeatable): the most-asked
    // backend passthrough, lifted out of the generic `--` for discoverability +
    // backend-aware placement. Maps to claude's + codex's native `--add-dir` (omp
    // has none → warned + skipped at launch). Both space + `=` forms; values are
    // forwarded verbatim. See addDirArgs for the per-backend flag mapping.
    else if (a === "--add-dir") pendingAddDir = true;
    else if (a.startsWith("--add-dir=")) {
      const v = a.slice("--add-dir=".length);
      if (v) out.addDir.push(v);
    }
    // account-routing-3-options (P-001 + 2026-06-30): the ONE `--account` value picks ONE of three
    // explicit routing modes (`psu --account <id|auto|default>`, space or `=` form):
    //   • <pool-id> → pin this session to that account via the inference gateway (hard, no failover)
    //   • auto      → route through the gateway with NO pin; it picks an available account + fails over
    //   • default (or omitted) → skip the gateway, use the system / CLI-login credential (THE DEFAULT)
    // Threaded to bootstrap-su (resolveAccountPin) for a fresh launch / tracked fork; resolved
    // client-side (chooseResumeAccount) for an in-place resume. Explicit auto/pin choices fail
    // closed when unavailable; only default/omitted may use the system login.
    else if (a === "--account") pendingAccount = true;
    else if (a.startsWith("--account="))
      out.account = a.slice("--account=".length);
    // named-su-agent-fleets P-006: pin this session into a named fleet (`psu
    // --fleet ops-team` or `--fleet=ops-team`). Threaded to bootstrap-su, which
    // folds PAPERCUSP_FLEET_SLUG/PAPERCUSP_FLEET_ROLE into the spawn env (mirrors
    // --account). The flag joins an EXISTING fleet → member; creating a new fleet
    // (→ leader) is only offered through the interactive picker.
    else if (a === "--fleet") pendingFleet = true;
    else if (a.startsWith("--fleet=")) {
      out.fleet = a.slice("--fleet=".length);
      out.fleetRole = "member";
    }
    // agent-allocation P-005 (launch-from-seats): the delegated agent_slot template
    // this member consumes ('<model>:<effort>:<account>', emitted by
    // fleet:launch-on-plan as `--seat=<ref>`). Forwarded to bootstrap-su, which
    // records the consumption (mig 487) and REFUSES the boot when the fleet's
    // delegated seats are exhausted — the flag only makes sense with `--fleet`.
    else if (a.startsWith("--seat="))
      out.seat = a.slice("--seat=".length) || null;
    // fleet-auto-mode (WI-1356): start the session in AUTO mode (the persona's
    // act/don't-ask/loop-until-done standing state). A fleet member has no human at
    // its keyboard, so `--fleet` defaults AUTO ON (see effectiveAutoMode); `--auto`
    // forces it on for any launch, `--no-auto` forces it off even for a fleet member.
    else if (a === "--auto") out.auto = true;
    else if (a === "--no-auto") out.auto = false;
    // drain-mode-2026-07-03 P-003: named operating mode. Only 'drain' is recognized —
    // launch the session in DRAIN mode (drain the target work queue to terminal; implies
    // AUTO). A typo'd mode must fail the launch loudly, not silently launch a plain
    // session — same throw-to-main() pattern as the --model guard (WI-1979).
    else if (a.startsWith("--mode=")) {
      const rawMode = a.slice("--mode=".length);
      if (!["drain", "grade", "test"].includes(rawMode)) {
        throw new Error(
          `--mode=${rawMode} is not recognized — supported modes are drain, grade, test.`,
        );
      }
      out.mode = rawMode;
    }
    // drain-mode propagation: these bounded scope fields are emitted by the
    // shared launch composers. Keep both `=` and space forms so a hand-written
    // psu invocation has the same semantics as a fleet-generated command.
    else if (a === "--mode-subject") pendingModeSubject = true;
    else if (a.startsWith("--mode-subject="))
      out.modeSubject = a.slice("--mode-subject=".length);
    else if (a === "--mode-instructions") pendingModeInstructions = true;
    else if (a.startsWith("--mode-instructions="))
      out.modeInstructions = a.slice("--mode-instructions=".length);
    else if (a === "--mode-owner-directed") out.modeOwnerDirected = true;
    else if (a.startsWith("--goal-bootstrap-subject=")) {
      const subject = a.slice("--goal-bootstrap-subject=".length).trim();
      if (!subject || subject.length > 200) {
        throw new Error("--goal-bootstrap-subject requires a non-empty goal id of at most 200 characters");
      }
      out.goalBootstrapSubject = subject;
    }
    // PUI-origin marker: when PUI delegates new-session creation to this
    // launcher, hide the PUI destination so the picker cannot recurse.
    else if (a === "--tui") pendingTui = true;
    else if (a.startsWith("--tui=")) {
      const rawTui = a.slice("--tui=".length);
      if (rawTui !== PUI_TUI_ORIGIN) {
        throw new Error(
          `--tui=${rawTui} is not recognized — the only supported caller origin is \`${PUI_TUI_ORIGIN}\`.`,
        );
      }
      out.tui = rawTui;
    }
    // Skip the confirm when resuming an UNTRACKED (non-psu) session (for scripts).
    else if (a === "--yes" || a === "-y") out.yes = true;
    // Bare positional id after `--resume` (ergonomic `psu --resume 42` form).
    else if (!a.startsWith("--") && out.resume && !out.resumeId)
      out.resumeId = a;
    // EI-181 defense-in-depth: any OTHER `--`-prefixed token that reached here
    // matched none of the branches above — a typo'd/unknown flag, or a value
    // flag's space-form we haven't special-cased. Before this, such a token was
    // silently swallowed with zero signal (the same silent-drop this item's
    // repro hit for --role); now the caller gets a one-line stderr note instead
    // of a mysteriously-unscoped session. Never throws — a genuinely-unknown
    // flag shouldn't hard-fail the launch, just be visible.
    else if (a.startsWith("--")) {
      console.error(
        `psu: warning — unrecognized flag \`${a}\` was ignored (did you mean \`${a}=<value>\`? psu --help lists supported flags).`,
      );
    }
  }
  if (out.goalBootstrapSubject && (out.resume || out.mode || out.auto !== null || out.fleet || out.fleetName)) {
    throw new Error("--goal-bootstrap-subject requires a fresh, fleetless launch without separate AUTO or DRAIN flags");
  }
  // Model-family/backend coupling: a supplied native cloud model selects its
  // backend when --agent is omitted, and an explicit mismatch fails before any
  // wrapper/terminal opens. OMP stays exempt because it is multi-provider.
  const hintedBackend = cloudModelBackendHint(out.model);
  if (!out.agent && hintedBackend) out.agent = hintedBackend;
  const pairing = validateAgentModelPair(out.agent, out.model);
  if (!pairing.ok) throw new Error(pairing.message);
  // Resolve every managed Codex launch to an explicit safe model and reject
  // Spark before bootstrap/PTY creation.  OMP remains multi-provider, but the
  // retired Spark id is denied globally so an explicit provider prefix cannot
  // bypass the policy through that backend.
  if (out.agent === "codex") {
    // A visible desktop picker has a human in the loop: choosing Codex is the
    // deliberate configured-default decision when no model was supplied. A
    // scripted --no-picker launch is unattended even when it opens a visible
    // terminal, so absence must remain unresolved just like --headless.
    const selection = resolveCodexModelSelection(out.model, {
      source:
        out.modelSource ||
        (out.model
          ? "explicit"
          : out.headless || out.picker === false
            ? "explicit"
            : "configured-default"),
    });
    out.model = selection.model;
    out.modelSource = selection.source;
  } else if (isCodexModelDenied(out.model)) {
    out.model = resolveCodexModel(out.model);
  }
  out.model = normalizeModelSpecForAgent(out.agent, out.model);
  return out;
}

/**
 * Map a psu model spec (`<model>[:<effort>]`) onto ONE backend's native model
 * flags. Shared by the fresh-launch wrapper path (suWrapperExtraArgs) and the
 * resume path (resumeArgsFor — WI-3758 `psu --resume … --model`). Pure —
 * exported for tests.
 *
 *   - claude: the CLI takes effort as its OWN flag — a verbatim suffixed spec
 *     sets the model and silently DROPS the effort, so the session falls back
 *     to the box's saved default (how a sonnet-5:high fleet came up at xhigh,
 *     2026-07-01). Split a recognized effort tail into `--effort`; anything
 *     else (a bare id, or a non-effort `:` segment like bedrock's `…-v2:0`)
 *     passes through verbatim.
 *   - codex: `-m` wants a BARE model id; reasoning effort is a CONFIG override
 *     (`-c model_reasoning_effort="high"`, preserving every recognized level,
 *     including `max`, exactly as requested). A verbatim suffixed
 *     spec would set an unknown MODEL and silently drop the effort — the same
 *     effort-drop class the claude branch fixed (2026-07-01), found for codex
 *     launching the backlog-clearance fleet (2026-07-03).
 *   - omp: understands the `<model>[:<effort>]` spec natively. One provider/model
 *     exception is refused below: Vertex Gemini 3.1 Pro currently returns a
 *     deterministic empty STOP stream at `:high`. Psu must not silently lower an
 *     explicitly requested effort level, so that exact combination fails before spawn.
 */
const OMP_GEMINI_31_PRO_HIGH_RE =
  /^google-vertex\/gemini-3\.1-pro-preview:high$/i;

/**
 * Guard a provider-specific OMP failure without changing the user's OMP
 * installation or other model/effort selections. The controlled reproduction
 * for WI-37890 showed `google-vertex/gemini-3.1-pro-preview:high` emits only a
 * `STOP` with no content and retries until exhaustion, while the same request
 * at `:low` completes and can call tools. D-011 forbids treating an implicit
 * high-to-low downgrade as terminal: refuse the unsupported exact path and make
 * the caller choose a lower effort explicitly. Keep the guard exact and reversible;
 * an unrelated Vertex model, provider, or effort remains byte-identical.
 * Pure + exported for regression tests.
 */
export function normalizeOmpModelSpec(model) {
  if (typeof model === "string" && OMP_GEMINI_31_PRO_HIGH_RE.test(model)) {
    throw new Error(
      `OMP cannot launch ${model}: this exact high-effort path returns deterministic empty STOP responses. ` +
        "Refusing to silently lower the requested effort; choose :low explicitly or use a client/provider whose :high path is supported.",
    );
  }
  return model;
}

/** Compatibility notices are reserved for non-semantic adjustments; WI-37890 now fails loud. */
export function ompModelCompatibilityNotice(model) {
  normalizeOmpModelSpec(model);
  return null;
}

const CLAUDE_OPUS_5_XHIGH_RESUME_RE =
  /^(?:opus|claude-opus-5)(\[1m\])?:xhigh$/i;

/**
 * Reconcile the one legacy Claude effort name that Opus 5's subscription route
 * no longer accepts when a saved launch profile is replayed on resume.
 *
 * `capability:launch-agent` deliberately restores a fleet member's canonical
 * launch profile. A profile recorded while Opus exposed `xhigh` can therefore
 * reach `psu --resume` as `claude-opus-5:xhigh`; once the account is switched
 * to the inference gateway, Claude rejects the resumed agent's first request
 * before it can checkpoint or repair itself. Opus 5 now calls its strongest
 * supported level `max`, so this is a name reconciliation, not a silent effort
 * reduction. Keep it native-resume + gateway + exact-family scoped: a default
 * system route, another Claude family, OMP/Codex, and every supported effort
 * remain byte-identical.
 *
 * Pure + exported so the scope and the diagnostic are regression-testable.
 */
export function reconcileResumeModelForAccountRoute({
  agent,
  model,
  accountRoute,
} = {}) {
  const unchanged = { model, notice: null, reconciled: false };
  if (
    agent !== "claude" ||
    (accountRoute?.mode !== "auto" && accountRoute?.mode !== "pin") ||
    accountRoute?.provider !== "claude" ||
    typeof model !== "string" ||
    !CLAUDE_OPUS_5_XHIGH_RESUME_RE.test(model.trim())
  ) {
    return unchanged;
  }
  const compatibleModel = model.trim().replace(/:xhigh$/i, ":max");
  return {
    model: compatibleModel,
    reconciled: true,
    notice:
      `resume model '${model}' names Opus 5's retired xhigh effort; ` +
      `using its supported strongest level '${compatibleModel}' for this inference-gateway route.`,
  };
}

const OMP_OX_ALPHA_MODEL_RE =
  /^(?:openrouter\/)?stealth\/ox-alpha(?::(?:low|medium|high|xhigh|max))?$/i;

// Safe, known-working default for a session whose inherited modelRoles.default
// resolves to a retired model with no explicit --model to fall back to
// (writeOmpSessionConfigDir, EI-21919040934117285).
const OMP_GATEWAY_FALLBACK_MODEL = "papercusp-gateway/claude-sonnet-4-6";

/**
 * Disable OMP's provider-backed automatic title request for every managed psu
 * session.
 *
 * The title is non-essential metadata, but OMP starts it from the first owner
 * message before the main model request. A real tracked session (adv 21150,
 * 2026-08-29) entered the gateway through that title request while the provider
 * pool was throttled; the request remained in flight, the real owner turn never
 * reached the model, and no native session JSONL materialized even though the
 * managed-pty socket had acknowledged the keystrokes. `--no-title` is OMP's
 * supported process-local switch (`PI_NO_TITLE=1` internally), so this removes
 * the optional competing provider request without mutating the user's global
 * OMP config or changing direct, non-psu OMP launches.
 *
 * Keep the model parameter for call-site compatibility: every fresh role,
 * fresh SU, and resume path already funnels through this helper. Pure +
 * exported for argv regression tests.
 */
export function ompTitleMitigationArgs(_model) {
  return ["--no-title"];
}

const OMP_OPENROUTER_RESPONSES_ENV = "PI_OPENROUTER_RESPONSES";

/**
 * TEMPORARY compatibility guard for EI-21439300345381616.
 *
 * OMP 18.0.3's OpenRouter Responses route persists a failed ox-alpha request as
 * an empty assistant turn (429 / zero usage). `PI_OPENROUTER_RESPONSES=0` keeps
 * this exact model on the stable OpenRouter route until OMP fixes that behavior.
 * An explicit environment override wins; unrelated models and backends remain
 * byte-identical. Pure + exported for fresh role, fresh SU, and resume tests.
 */
export function ompResponsesCompatibilityEnv(agent, model, env = process.env) {
  if (
    agent !== "omp" ||
    typeof model !== "string" ||
    !OMP_OX_ALPHA_MODEL_RE.test(model.trim()) ||
    env?.[OMP_OPENROUTER_RESPONSES_ENV] != null
  ) {
    return {};
  }
  return { [OMP_OPENROUTER_RESPONSES_ENV]: "0" };
}

export function modelArgsFor(agent, model) {
  // Low-level argv construction is never itself authorization to choose a
  // model. Fresh visible launchers resolve configured-default explicitly;
  // unattended resume/fleet paths must supply an explicit or inherited model.
  if (agent === "codex") model = resolveCodexModel(model);
  if (!model) return [];
  const effectiveModel =
    agent === "codex"
      ? normalizeCodexCliModel(model)
      : agent === "omp"
        ? normalizeOmpModelSpec(model)
        : model;
  const m = /^(.+):(low|medium|high|xhigh|max)$/.exec(effectiveModel);
  if (agent === "codex") {
    // Extended-window models are launched with the exact top-level opt-in and
    // native auto-compact backstop (plan codex-1m-context-window-2026-08-17
    // D-008). Without this, codex runs its
    // 272k default -> 258,400 effective and its OWN summarizer fires before
    // papercusp's 400k su/leader carry cut is ever reached, so the soft limit
    // in D-001 never gets to run. `[]` for a model with no extended window, so
    // those launches stay byte-identical to before.
    const windowArgs = codexContextConfigArgs(m ? m[1] : effectiveModel);
    if (m) {
      return [
        "-m",
        m[1],
        "-c",
        `model_reasoning_effort="${m[2]}"`,
        ...windowArgs,
      ];
    }
    return ["-m", effectiveModel, ...windowArgs];
  }
  if (agent === "claude" && m) return ["--model", m[1], "--effort", m[2]];
  return ["--model", effectiveModel];
}

/**
 * Extra args to pass THROUGH a `*-su` wrapper to the underlying CLI (the
 * wrappers all end with `"$@"`). Maps a model fuzzy-match + a resume-by-id
 * onto each backend's native flags. Pure — exported for tests.
 *
 * This is what gives psu launches model/resume parity with the retired
 * `buildEngineerOmpLaunchCommand` (P-032): omp `--model`/`-r`, claude
 * `--model`/`--resume`, codex `-m`/`resume`.
 */
export function suWrapperExtraArgs(agent, { model, resumeSession } = {}) {
  const args = [];
  if (model) args.push(...modelArgsFor(agent, model));
  if (agent === "omp") args.push(...ompTitleMitigationArgs(model));
  if (resumeSession) {
    if (agent === "omp" || agent === "claude") args.push("-r", resumeSession);
    else if (agent === "codex") args.push("resume", resumeSession);
  }
  return args;
}

/**
 * Map psu's repeated `--add-dir <dir>` onto each backend's native flag. claude
 * AND codex both expose `--add-dir` (extra tool-accessible directories); omp has
 * no equivalent → [] (the launch path warns so the user isn't surprised). Pure —
 * exported for tests.
 *
 * Emits the single-`=` token form (`--add-dir=<dir>`), NOT the space form: claude's
 * `--add-dir` is VARIADIC, so a space-form value at the end of the argv would
 * greedily swallow whatever followed (e.g. a `--` passthrough token). The `=` form
 * binds exactly one value per occurrence — the same greed-guard reason
 * NATIVE_SCHEDULER_DENY_FLAG is one `=` token. clap (codex) accepts `=` too.
 */
export function addDirArgs(agent, dirs = []) {
  if (!dirs.length) return [];
  if (agent === "claude" || agent === "codex")
    return dirs.map((d) => `--add-dir=${d}`);
  return [];
}

export function forkUnsupportedMessage(agent) {
  return (
    `psu: --fork is not supported for ${agent} sessions; ${agent} has no native branch command. ` +
    `To branch safely, write a brief/transcript excerpt and launch a new ${agent} session with ` +
    `\`psu --agent=${agent} --launch-context=<brief.md>\` plus the same workspace/harness/plan flags as needed, ` +
    `or re-run without --fork to resume in place. psu will not silently append to the original when a fork was requested.`
  );
}

/**
 * Native-scheduler lockout (native-scheduler-lockout-2026-06-09 D-001/D-002):
 * AGENT sessions (role panes + the brain/Queen) lose claude-code's own
 * scheduling surfaces — Cron* tools, ScheduleWakeup, the schedule/loop
 * skills, and Bash-reachable OS schedulers — so a wake can only live in the
 * harness routines table (the one scheduler Pause/`hive:status`/the liveness
 * backstop can see). The human `psu su` session keeps them (D-003).
 *
 * MUST stay one `=` token: the flag is variadic and the space form greedily
 * eats every following argv element. This plain-node script can't import TS,
 * so the literal mirrors NATIVE_SCHEDULER_DENY + OS_SCHEDULER_BASH_DENY in
 * `@papercusp/orchestrator/native-scheduler-deny`; the lockstep test in
 * `lib/psu-launcher.test.ts` pins the two copies together. Exported for tests.
 */
export const NATIVE_SCHEDULER_DENY_FLAG =
  "--disallowedTools=CronCreate,CronDelete,CronList,ScheduleWakeup,Skill(schedule),Skill(loop),Bash(crontab:*),Bash(systemd-run:*),Bash(batch:*)";

/**
 * su-session scheduler-TOOL lockout (agent-launch-context-cost-2026-09-18 P-006).
 *
 * The su session deliberately does NOT get NATIVE_SCHEDULER_DENY_FLAG (D-003 —
 * the human keeps `/schedule` + `/loop`). But D-003's rationale is the OWNER's
 * surface, and it only covers the SKILLS a human types. The four Cron and
 * ScheduleWakeup TOOLS are MODEL-facing, and the su playbook already forbids the
 * model from using them ("do NOT self-pace with Claude Code's native `/loop` (or
 * `ScheduleWakeup`) … declare an engine loop with `loop:arm`") — so su paid for
 * 9,156 B of schemas per turn AND for the prose banning them.
 *
 * Measured 2026-09-18 from a captured `/v1/messages` body, 7-arm A/B with a
 * no-deny positive control: ScheduleWakeup 4,923 B, CronCreate 3,642 B,
 * CronDelete 360 B, CronList 231 B.
 *
 * ⚠ This is a STRICT SUBSET of NATIVE_SCHEDULER_DENY_FLAG and must stay one: the
 * `Skill(...)` and `Bash(...)` entries are deliberately absent so D-003's
 * owner-facing carve-out is preserved exactly. The lockstep test in
 * apps/operator/lib/psu-launcher.test.ts pins this literal to
 * `suSchedulerToolsDenyFlag()` in `@papercusp/orchestrator/native-scheduler-deny`
 * AND asserts the subset relationship, so neither copy can drift.
 *
 * MUST stay one `=` token — same greed-guard reason as NATIVE_SCHEDULER_DENY_FLAG.
 */
export const SU_SCHEDULER_TOOLS_DENY_FLAG =
  "--disallowedTools=CronCreate,CronDelete,CronList,ScheduleWakeup";

/**
 * Subagent-fanout deny (owner request 2026-07-01): AGENT role/bee sessions
 * lose the built-in subagent-launch tool — unconditional, no opt-out, mirrors
 * the native-scheduler lockout's posture for role sessions. `Task` is the
 * pre-rename name (verified vs claude 2.1.158); `Agent` is the name as of
 * 2.1.198 — re-verifying live found the `Task`-only form had become a silent
 * no-op (a spawned Agent-tool subagent still ran), so both are carried.
 * `Workflow` (added 2026-07-05) is the SEPARATE multi-agent orchestration tool —
 * a subagents-denied `psu --resume` session still fanned out via it because the
 * deny listed only Task/Agent; it is a distinct top-level tool, so it's denied
 * explicitly too. A
 * SEPARATE `--disallowedTools=` token from NATIVE_SCHEDULER_DENY_FLAG
 * (verified live: claude unions repeated `--disallowedTools` occurrences) so
 * this doesn't disturb that flag's own lockstep-pinned literal. MUST stay one
 * `=` token — same greed-guard reason as NATIVE_SCHEDULER_DENY_FLAG. The
 * literal mirrors `NO_SUBAGENT_TOOLS_DENY` in
 * `@papercusp/orchestrator/no-subagent-deny`; the lockstep test in
 * `lib/psu-launcher.test.ts` pins the two copies together. Exported for tests.
 *
 * DENIED BY DEFAULT for every psu launch (su + role + resume) as of the
 * 2026-07-02 owner mandate — `--allow-subagents` is the explicit opt-IN that
 * KEEPS the tool for a launch (also surfaced as a psu picker toggle + a
 * `fleet:launch-on-plan { allowSubagents }` arg). No longer follows the
 * native-scheduler-lockout D-003 human-keeps-it carve-out.
 *
 * ⚠ THIS DENY WORKS BECAUSE Task/Agent/Workflow ARE NATIVE TOOLS. Do NOT extend
 * this (or any `--disallowedTools=` flag in this file) with an `mcp__*` entry
 * expecting the tool to be withheld: an MCP tool executes SERVER-side, and the
 * permitted `tools:invoke { name, args }` dispatches to it BY NAME without the
 * server ever seeing the client's deny list — so one call re-reaches it. That is
 * documented behaviour, not an exploit. An `mcp__*` deny here buys discovery
 * friction, not confinement; a real boundary must be enforced server-side.
 * Related trap: a deny is observably IDENTICAL to a never-seeded tool, so never
 * confirm one without a same-server, same-tier control. Full write-up:
 * /internal/docs/agent-insights/disallowed-tools-cannot-withhold-an-mcp-tool
 */
export const NO_SUBAGENTS_DENY_FLAG = "--disallowedTools=Task,Agent,Workflow";

/**
 * Native client tool-search lockout (owner directive 2026-09-11): every psu
 * launch loses claude's built-in `ToolSearch`, forcing discovery through
 * papercusp's `tools:find` (result-door-capped) and `tools:invoke` (zero schema
 * tokens — it dispatches server-side).
 *
 * WHY: measured on a live su session (WI-10001033), ONE `ToolSearch` call
 * loading six schemas cost +67,045 tokens — 17% of that session's whole budget
 * in a single hop. It bypasses `applyResultDoor` (applied only in papercusp's
 * MCP transport, `_mcp-host.ts`), which caps results at ~1,500 tokens — a ~45x
 * overshoot through the one channel no guard watches.
 *
 * ⚠ IT DOES NOT STRAND THE SESSION — the fear is real but wrong, and it was
 * verified both ways on the SAME raw `claude -p` path, varying only this flag:
 * ToolSearch ALLOWED → 0 papercusp tools directly callable (the client defers
 * them all and points at ToolSearch); ToolSearch DENIED → 63 directly callable,
 * and `mcp__papercusp-su__tools_invoke` genuinely DISPATCHED (`CALL_OK` with a
 * real result payload, not a model's self-report). The deferral is CONDITIONAL
 * ON ToolSearch EXISTING. Re-run both arms against a new claude build before
 * trusting this — the policy is closed-source, exactly like the Task→Agent
 * rename that silently no-op'd the subagent deny.
 *
 * A SEPARATE `--disallowedTools=` token (claude unions repeated occurrences —
 * verified live) so it stays independently revertible and cannot disturb the
 * other flags' lockstep-pinned literals. MUST stay one `=` token — same
 * greed-guard reason as NATIVE_SCHEDULER_DENY_FLAG. The literal mirrors
 * `NATIVE_TOOL_SEARCH_DENY` in `@papercusp/orchestrator/native-tool-search-deny`;
 * the lockstep test in `lib/psu-launcher.test.ts` pins the two copies together.
 * Exported for tests.
 *
 * ⚠ Same native-only caveat as NO_SUBAGENTS_DENY_FLAG: this works because
 * `ToolSearch` is a NATIVE tool. Do NOT add an `mcp__*` entry here expecting
 * confinement — `tools:invoke` re-reaches any MCP tool by name server-side.
 */
export const NATIVE_TOOL_SEARCH_DENY_FLAG = "--disallowedTools=ToolSearch";

/**
 * Is claude's NATIVE schema deferral REACHABLE on a psu launch?
 *
 * DERIVED from {@link NATIVE_TOOL_SEARCH_DENY_FLAG} rather than hand-set, so the deny and the
 * `ENABLE_TOOL_SEARCH` env that exists to force deferral ON cannot drift into contradicting
 * each other. Flip the flag's contents and the env follows automatically. Mirror of
 * `nativeDeferralReachable` in `@papercusp/orchestrator/native-tool-search-deny` (plain node
 * here, so the literal is duplicated and pinned by the lockstep test in
 * `apps/operator/lib/psu-launcher.test.ts`).
 *
 * WHY THIS EXISTS (P-007, agent-launch-context-cost-2026-09-18): both halves shipped
 * independently — the deny on 2026-09-11, the env long before — and CONTRADICTED each other in
 * production for days with nothing detecting it, because each half read healthy on its own.
 * MEASURED 2026-09-18 on real captured /v1/messages bodies (repeated, stable): the pair emits a
 * `DeferredToolPlaceholder` tool carrying `defer_loading: true` into EVERY request, standing in
 * for an empty deferred set, with no `ToolSearch` that could ever resolve it. Dropping the env
 * under the deny removes exactly that tool and nothing else (66 → 65 tools, −204 B).
 *
 * ⚠ ASSUMPTION THIS DERIVATION RESTS ON: every psu claude launch path applies the deny —
 * `roleLaunchArgs`, `suLaunchArgs` AND `resumeArgsFor` all do. That is asserted directly by
 * `psu-launcher.test.ts` ("every claude launch path denies ToolSearch"), so if a future path
 * omits it that test fails and tells you to thread this predicate per-path instead of globally.
 */
export function nativeDeferralReachable(
  denyFlag = NATIVE_TOOL_SEARCH_DENY_FLAG,
) {
  const prefix = "--disallowedTools=";
  if (!denyFlag.startsWith(prefix)) return true;
  return !denyFlag
    .slice(prefix.length)
    .split(",")
    .map((s) => s.trim())
    .includes("ToolSearch");
}

/**
 * Dead-weight NATIVE-tool lockout (context-baseline repair 2026-09-15).
 *
 * With ToolSearch denied there is no schema deferral, so every advertised tool
 * ships its FULL schema in the prompt on every turn. MEASURED on a captured
 * /v1/messages body from a clean `psu` launch: 119 tools, 547,041 B — 62.7% of
 * an 871,924 B first turn. PAPERCUSP_TOOLS (contextTrimmingEnv) trims only the
 * papercusp-su MCP server, so claude's OWN natives are outside its reach
 * entirely — and `Artifact` alone is 50,101 B, the single largest item in the
 * whole prompt (25,248 B of that is its description).
 *
 * Every name here is a native surface this repo never uses or outright forbids:
 *   Artifact, DesignSync   claude.ai publishing / design-system sync; this repo
 *                          designs via design-phase:* and ships a Tauri app.
 *   SendFeedback           papercusp files through improvements:capture.
 *   RemoteTrigger          claude.ai cloud routines; papercusp has routines:*.
 *   EnterWorktree,         the repo guide bans them outright ("work on `staging`
 *   ExitWorktree           directly — no `git worktree`, no feature branches").
 * Measured saving ~75,000 B (~20k tokens) off EVERY turn of every psu session.
 *
 * VERIFIED that a deny strips the schema from the WIRE, not merely blocks the
 * call: denying `Artifact` moved a captured body 871,924 -> 822,141 B (-49,783)
 * with zero `"name":"Artifact"` occurrences remaining.
 *
 * ⚠ NATIVE-ONLY — same caveat as NATIVE_TOOL_SEARCH_DENY_FLAG, but here it is
 * MEASURED rather than inferred: in that same capture
 * `mcp__claude-in-chrome__navigate` was denied by the identical token and its
 * schema stayed in the body verbatim. An `mcp__*` entry buys NOTHING here; to
 * drop an MCP server's schemas you must stop LOADING the server.
 *
 * ⚠ Deliberately NOT in this list: the Cron tools and `ScheduleWakeup` (D-003 keeps claude's
 * schedulers for the human `psu su` session — `/schedule` there is the owner's
 * own surface, which is also why NATIVE_SCHEDULER_DENY_FLAG is absent from the
 * su branch below), `EndConversation` (a safety affordance, not dead weight),
 * and `Monitor` (genuinely used for log/event watching).
 *
 * MUST stay one `=` token — same greed-guard reason as the flags above; the
 * flag is variadic and the space form eats every following argv element.
 * Exported for tests.
 */
export const NATIVE_DEADWEIGHT_DENY_FLAG =
  "--disallowedTools=Artifact,DesignSync,SendFeedback,RemoteTrigger,EnterWorktree,ExitWorktree";

/**
 * Claude-in-Chrome lockout for AGENT sessions (owner directive 2026-09-15).
 *
 * WHAT IT BUYS: the claude-in-chrome MCP block is 22 tools / 28,499 B of the prompt —
 * measured by decomposing a real captured /v1/messages body from a clean psu launch
 * (113 tools: papercusp-su 397,655 B, natives 59,280 B, chrome 28,499 B). With
 * ToolSearch denied there is no schema deferral, so that rides in EVERY turn.
 *
 * ⚠ WHY NOT `--disallowedTools=mcp__claude-in-chrome__*` — the obvious move, and it
 * buys ZERO bytes. MEASURED, not inferred: in that same capture
 * `mcp__claude-in-chrome__navigate` was denied by exactly that token and its schema
 * stayed in the body verbatim. A deny blocks the CALL; only dropping the SERVER drops
 * the schema. (Denying a NATIVE tool does strip it — see NATIVE_DEADWEIGHT_DENY_FLAG.)
 *
 * ⚠ WHY NOT `--strict-mcp-config` — the first plan, and it does not address this.
 * claude-in-chrome is NOT a configured MCP server: `claude mcp list` shows only
 * papercusp-su, because the CLI attaches Chrome from the paired extension
 * (`claudeInChromeDefaultEnabled` / `cachedChromeExtensionInstalled` in ~/.claude.json).
 * Strict mode filters CONFIGURED servers, so it would not have removed chrome — and it
 * would have stopped loading the user-level papercusp-su, which psu depends on (no
 * --mcp-config is passed precisely because that server is user-level; see suLaunchArgs).
 * It was the riskier lever AND the ineffective one.
 *
 * ⚠ WHY NOT the user-level toggle — flipping `claudeInChromeDefaultEnabled` in
 * ~/.claude.json works, but that is the OWNER'S personal client config: it would also
 * kill Chrome automation in their own interactive sessions. This flag is per-launch, so
 * agents lose Chrome and the owner keeps it. That split is the whole point.
 *
 * A standalone flag (not a --disallowedTools token): it is claude's own first-class
 * "Disable Claude in Chrome integration" switch (verified in `claude --help`, 2.1.268).
 * Agents that genuinely need a browser use the `verdict` skill, or drive the Tauri
 * webview via tauri-agent-tools per the repo guide — neither goes through Chrome.
 * Exported for tests.
 */
export const NO_CHROME_FLAG = "--no-chrome";

/**
 * EI-3294 known-risk warning: an opted-in subagent (Task/Agent tool) session
 * running on the DEFAULT (no-gateway, direct local OAuth) account route died
 * with 401 "Please run /login" after 12-39 tool calls, while the PARENT
 * session kept working fine (repro: su-7c7f465d, 2026-06-24). Root cause
 * (unconfirmed against Anthropic's closed-source CLI — no repro access from
 * a papercusp-denied session — but consistent with the evidence): the
 * built-in Task/Agent tool's spawned subagents likely run long enough to
 * cross the local OAuth token's refresh/rotation window, and either don't
 * share the parent's refresh or race it (a rotating refresh can invalidate
 * the token a subagent is still holding) — a client-side behavior papercusp
 * does not control. Gateway-routed sessions (`--account auto` / a pinned
 * pool account) sidestep this ENTIRELY: the CLI holds a static
 * `ANTHROPIC_AUTH_TOKEN` placeholder that never expires (spawn-env.ts
 * `gatewaySpawnEnv` — the gateway does the real OAuth server-side), so a
 * long-running subagent can't hit a client-side refresh race. Subagents are
 * DENIED BY DEFAULT fleet-wide (owner mandate 2026-07-02) specifically
 * because of this class of unreliable behavior, so most sessions never hit
 * this — this warning only fires for the explicit opt-in
 * (`--allow-subagents`) combined with the default (non-gateway) account
 * route, i.e. exactly the untested combination. Non-fatal: prints once and
 * proceeds — account routing is the OWNER's call (su playbook: never
 * silently switch it), so this only surfaces the tradeoff, never changes it.
 * Full writeup: agent-insights doc `task-tool-subagent-401-on-default-account`.
 */
export function subagentGatewayRiskNotice(agent, allowSubagents, envelopeEnv) {
  if (agent !== "claude" || !allowSubagents) return null;
  if (envelopeEnv?.PAPERCUSP_ACCOUNT_ROUTING_MODE !== "default") return null;
  return (
    "psu: WARNING — subagents are enabled on the default (non-gateway) account route. " +
    'A long-running Task/Agent subagent can die with a 401 "Please run /login" while the ' +
    "parent session keeps working (EI-3294) — a known Claude-Code-CLI local-OAuth-refresh risk that " +
    "gateway routing (`--account auto` or a pinned pool account) sidesteps. Not auto-switching your " +
    "account route (that choice is yours) — just flagging it before you rely on subagent output."
  );
}

/**
 * Owner-desktop-notification lockout (owner directive 2026-07-14): agents were
 * hand-firing `notify-send` popups at the owner's desktop. Deny the easy Bash
 * paths (bare name + the absolute paths that would trivially bypass the
 * ~/.papercusp/bin PATH shim) on EVERY claude launch — su + role + resume,
 * unconditional, no opt-out (claude unions repeated --disallowedTools
 * occurrences, so this composes with the other deny flags). Layered with the
 * PATH shim (all backends, compound forms) + the root-CLAUDE.md standing rule
 * (route human-facing alerts via coord:escalate / notifyAttention). MUST stay
 * one `=` token — same greed-guard reason as NATIVE_SCHEDULER_DENY_FLAG. The
 * literal mirrors `OWNER_DESKTOP_NOTIFY_BASH_DENY` in
 * `@papercusp/orchestrator/owner-desktop-notify-deny`; the lockstep test in
 * `lib/psu-launcher.test.ts` pins the two copies together. Exported for tests.
 */
export const OWNER_DESKTOP_NOTIFY_DENY_FLAG =
  "--disallowedTools=Bash(notify-send:*),Bash(/usr/bin/notify-send:*),Bash(/bin/notify-send:*)";
export const BRAIN_TOMBSTONE_MESSAGE =
  "psu: --brain is deprecated and no longer launches a pinned brain session. Use the live operator/sentinel converse surface or a normal `psu` session.";

/**
 * Per-backend args for an interactive ROLE session — exec the raw CLI
 * (NOT the *-su wrapper, which bakes the engineer playbook + superuser
 * MCP) with the role prompt as system prompt + the signed role-scoped
 * `.mcp.json`. Pure — exported for tests.
 *
 * claude gets `--strict-mcp-config` so it's restricted to ONLY the
 * role-scoped server (true tool-scoping); omp path-discovers the cwd's
 * `.mcp.json`. codex has no --mcp-config / --append-system-prompt flags,
 * so bootstrap-role mints a per-session CODEX_HOME (AGENTS.md = role
 * prompt, config.toml = role-scoped MCP) and exports it via
 * `envelopeEnv.CODEX_HOME`; the launcher just execs `codex` with the
 * approvals/sandbox bypass Papercusp still uses for managed Codex launches
 * until the MCP-under-sandbox path has a fresh live smoke on the current CLI
 * (mirrors the codex-su wrapper).
 */
/**
 * The omp `lsp`-builtin argv fragment — `['--no-lsp']` to STRIP the builtin, or
 * `[]` to leave it in place. P-021 (D-013) replaced two hard-coded `'--no-lsp'`
 * literals (the role and su omp branches) with this one helper.
 *
 * WHAT `--no-lsp` ACTUALLY DOES — read this before changing the default. It
 * strips OMP's OWN `lsp` BUILTIN as weak-model tool-attractor suppression. A
 * weak ornith model reaches for lsp/read to try to INVOKE MCP tools (session
 * 9885 abused `lsp` as a tools:call wrapper before recovering). The other
 * attractor, `eval`, is a REAL omp shell builtin and the WORST offender —
 * ornith DOOM-LOOPED on it 56-80× (sessions 10234/10239) despite the coord-hook
 * block + an escalating steer; message-based fixes can't break the reflex, so
 * it is disabled at the omp-config layer instead (eval.py/eval.js=false,
 * ensureOmpAgentToolTierConfig in ensure-omp-su.ts / WI-2382) and never reaches
 * the surface. The kickoff tools:invoke escape hatch remains the positive
 * redirect.
 *
 * ⚠ THIS IS NOT ABOUT PAPERCUSP'S `lsp.*` FACADE. That is a separate surface
 * behind a separate flag (FLAGS.CODE_INTEL_LSP). Conflating the two would mean
 * enabling our facade silently re-arms the attractor above on every omp launch
 * — the hazard D-013 exists to record.
 *
 * `allowNativeLsp` is NOT read here. It is resolved server-side in
 * bootstrap-{su,role}.ts as `FLAGS.OMP_NATIVE_LSP_BUILTIN && !isLocalModelSpec(model)`
 * and threaded in via `envelopeEnv.PAPERCUSP_OMP_NATIVE_LSP` — the reason this
 * bare-node script needs no flag read (and so no launch-time network dependency)
 * of its own. Absent/false ⇒ strip,
 * byte-identical to the pre-P-021 hard-coded behaviour.
 *
 * Pure — exported for tests.
 *
 * @param {boolean} [allowNativeLsp]
 * @returns {string[]}
 */
export function ompLspArgs(allowNativeLsp) {
  return allowNativeLsp === true ? [] : ["--no-lsp"];
}

export function roleLaunchArgs(
  backend,
  {
    promptFile,
    mcpJsonPath,
    coordExtPath,
    injectHookPath,
    nativeSessionId,
    allowSubagents,
    model,
    allowNativeLsp,
  } = {},
) {
  if (backend === "claude") {
    // identities-v1 D-018 / D-021 / WI-2143907: the sealed role prompt always
    // REPLACES Claude's coding base. Appending would put unsealed client prose
    // above the kernel and violate the seal.
    const systemPromptArgs = [
      "--system-prompt-file",
      promptFile,
      "--exclude-dynamic-system-prompt-sections",
    ];
    return {
      bin: "claude",
      args: [
        "--dangerously-skip-permissions",
        ...systemPromptArgs,
        "--mcp-config",
        mcpJsonPath,
        "--strict-mcp-config",
        // Force the spec-minted session id (mirrors suLaunchArgs) so `psu --resume`
        // and wake-executor resume the EXACT conversation, not `--continue`'s
        // most-recent-in-cwd (a random peer on the shared tree). claude-only.
        ...(nativeSessionId ? ["--session-id", nativeSessionId] : []),
        "--permission-mode",
        "bypassPermissions",
        // Agent sessions must schedule ONLY via the harness routines table —
        // never claude's own cron/schedule/loop surfaces (D-001).
        NATIVE_SCHEDULER_DENY_FLAG,
        // Native client tool-search lockout (owner directive 2026-09-11).
        // UNCONDITIONAL — no opt-in flag, unlike subagents: papercusp's
        // tools:find/tools:invoke fully cover the capability, so there is no
        // reason to keep the uncapped native one. See its doc comment.
        NATIVE_TOOL_SEARCH_DENY_FLAG,
        // Owner-desktop notify-send lockout (owner directive 2026-07-14).
        OWNER_DESKTOP_NOTIFY_DENY_FLAG,
        // Dead-weight native tools (2026-09-15) — a role/bee has even less use
        // for claude.ai publishing surfaces than an su session. See its comment.
        NATIVE_DEADWEIGHT_DENY_FLAG,
        // Claude-in-Chrome lockout (owner directive 2026-09-15) — 22 tools /
        // 28,499 B off every turn. See NO_CHROME_FLAG for why a deny token and
        // --strict-mcp-config both fail to remove it.
        NO_CHROME_FLAG,
        // Subagent-launch (Task/Agent) is DENIED BY DEFAULT (owner mandate
        // 2026-07-02) — a role/bee never fans out via its own subagent tool
        // unless the launch explicitly opts in (`--allow-subagents`). See
        // NO_SUBAGENTS_DENY_FLAG's doc comment.
        ...(allowSubagents ? [] : [NO_SUBAGENTS_DENY_FLAG]),
        // P-019/D-007 (voice-public-release-readiness-2026-07-12): role sessions
        // previously NEVER emitted model argv — `psu --role=papercup --model=sonnet:medium`
        // silently dropped the spec (only PAPERCUSP_MODEL env was exported, which the
        // CLI ignores), so the "fast" voice pane came up on the box's saved default
        // (Opus) — the root cause behind the heavy-pane "Agent did not respond" class.
        // Same effort-splitting rules as the su flow (modelArgsFor). NOTE: the omp/codex
        // role branches below still lack model argv (claude-minimal for P-019).
        ...modelArgsFor("claude", model),
      ],
    };
  }
  if (backend === "omp") {
    // omp path-discovers <cwd>/.mcp.json; --append-system-prompt takes a file path.
    // -e loads the coordination extension (lock enforcement + coord + the activity
    // bridge port) when one is supplied — a role omp session is a worker that edits
    // files + whose activity belongs in the fleet view, so it gets the same hook the
    // su omp launch + role codex/claude do. (claude/codex role hooks are user-level /
    // baked; omp's is the `-e` module.)
    // D-021: the sealed prompt is the whole system prompt; no append branch.
    const args = [
      "--approval-mode",
      "yolo",
      // weak-model-tool-tier: strip omp's own `lsp` builtin unless the
      // server-resolved OMP_NATIVE_LSP_BUILTIN gate says this session may keep
      // it. See ompLspArgs — it carries the full attractor rationale and the
      // reason this is NOT the same switch as our `lsp.*` facade.
      ...ompLspArgs(allowNativeLsp),
      "--system-prompt",
      promptFile,
      ...modelArgsFor("omp", model),
      ...ompTitleMitigationArgs(model),
    ];
    if (coordExtPath) args.push("-e", coordExtPath);
    // omp-context-injection-parity-2026-08-09 P-003: turn-start + mid-turn
    // context injection, the omp half of what claude gets from its
    // UserPromptSubmit/PostToolBatch hooks. STRICTLY ADDITIVE — one more module
    // alongside the coord extension, no model and no routing touched, so
    // psu->omp keeps launching on OMP's own default config and the owner still
    // picks the model interactively [owner 2026-06-29].
    // `--hook` and `-e` are the SAME loader in omp (main.ts:1049 merges both
    // into additionalExtensionPaths); both flags are repeatable and accumulate,
    // so this appends to — never replaces — any hook the user already has.
    if (injectHookPath) args.push("--hook", injectHookPath);
    return { bin: "omp", args };
  }
  if (backend === "codex") {
    // CODEX_HOME (with AGENTS.md + role-scoped config.toml + lock-hook
    // settings.json) is supplied via envelopeEnv.
    // --dangerously-bypass-hook-trust runs the home's SU-locks hooks (P-030;
    // the only hooks there are ours). The approvals/sandbox bypass remains the
    // managed-launch default until the current Codex MCP-under-sandbox path has
    // a live Papercusp smoke; the orchestrator fleet path wraps Codex externally.
    return {
      bin: "codex",
      args: [
        "--dangerously-bypass-hook-trust",
        "--dangerously-bypass-approvals-and-sandbox",
        "--no-alt-screen",
        ...modelArgsFor("codex", model),
      ],
    };
  }
  throw new Error(
    `roleLaunchArgs: backend '${backend}' has no interactive role launch`,
  );
}

/**
 * Raw-CLI launch args for a SUPERUSER (`su`) session — the engineer/
 * collaborator path. Pure — exported for tests. The su counterpart to
 * `roleLaunchArgs`: same raw backends, but the prompt is the engineer
 * playbook (`buildLaunchSpec({kind:'su'})`).
 *
 * MCP is USER-LEVEL for claude + omp and survives a raw launch (the Phase 0
 * finding) — claude's `papercusp-su` lives in `~/.claude.json` (its url
 * env-expands `${PAPERCUSP_SID}`, so per-session identity flows once psu
 * exports the SID), omp's in `~/.omp/agent/mcp.json`. So psu supplies NO
 * `--mcp-config`: it would double the `papercusp-su` server. This also
 * realizes D-005 (su keeps its FULL toolkit — every user server loads, not
 * just papercusp) more directly than `--mcp-config` + non-strict would.
 *
 * Lock-hook enforcement is likewise USER-LEVEL for claude (Pre/PostToolUse
 * in `~/.claude/settings.json`); omp loads it as a module via `-e`
 * (P-021, `~/.papercusp/papercusp-coord.ts`). codex is the only one whose
 * MCP + hooks are NOT user-level — it has no --mcp-config/-e/-prompt flag,
 * so a per-session CODEX_HOME is minted server-side (P-030: AGENTS.md =
 * playbook, config.toml = superuser MCP w/ bearer, settings.json = lock
 * hooks) and supplied via `envelopeEnv.CODEX_HOME`; the launcher execs
 * `codex` with `--dangerously-bypass-hook-trust` (the home's only hooks are
 * ours) + the approvals/sandbox bypass Papercusp still uses for managed
 * Codex launches pending a current MCP-under-sandbox live smoke.
 */
export function suLaunchArgs(
  backend,
  {
    promptFile,
    coordExtPath,
    injectHookPath,
    nativeSessionId,
    allowSubagents,
    allowNativeLsp,
  } = {},
) {
  if (backend === "claude") {
    // identities-v1 D-018 / D-021 / WI-2143907: the sealed playbook always
    // REPLACES Claude's coding base; exclude the residual dynamic sections too.
    const systemPromptArgs = [
      "--system-prompt-file",
      promptFile,
      "--exclude-dynamic-system-prompt-sections",
    ];
    return {
      bin: "claude",
      args: [
        "--dangerously-skip-permissions",
        ...systemPromptArgs,
        // Force the session id bootstrap-su recorded so `psu --resume <uuid>`
        // can correlate this session to its adv row — and resume the EXACT
        // session, not `--continue`'s most-recent-in-cwd. claude-only (omp/codex
        // pass null; they don't take a forced session id).
        ...(nativeSessionId ? ["--session-id", nativeSessionId] : []),
        // No --mcp-config: claude's papercusp-su is user-level (~/.claude.json)
        // and survives a raw launch; adding it would duplicate the server.
        "--permission-mode",
        "bypassPermissions",
        // Subagent-launch (Task/Agent) DENIED BY DEFAULT (owner mandate 2026-07-02);
        // `--allow-subagents` opts THIS su launch back IN. See NO_SUBAGENTS_DENY_FLAG.
        ...(allowSubagents ? [] : [NO_SUBAGENTS_DENY_FLAG]),
        // Native client tool-search lockout (owner directive 2026-09-11) —
        // unconditional, su sessions included, and NO opt-in: papercusp's
        // tools:find/tools:invoke fully cover it. See its doc comment.
        NATIVE_TOOL_SEARCH_DENY_FLAG,
        // Owner-desktop notify-send lockout (owner directive 2026-07-14) —
        // unconditional, su sessions included (an su agent fired the popups).
        OWNER_DESKTOP_NOTIFY_DENY_FLAG,
        // Model-facing scheduler TOOLS (2026-09-18) — 9,156 B off every turn.
        // A strict SUBSET of NATIVE_SCHEDULER_DENY_FLAG: the owner-facing
        // Skill(schedule)/Skill(loop) stay, so D-003's carve-out is intact.
        SU_SCHEDULER_TOOLS_DENY_FLAG,
        // Dead-weight native tools (2026-09-15) — unconditional. With
        // ToolSearch denied their full schemas ride in EVERY prompt; measured
        // ~75,000 B of an su session's 547,041 B tool block. See its comment.
        NATIVE_DEADWEIGHT_DENY_FLAG,
        // Claude-in-Chrome lockout (owner directive 2026-09-15) — 22 tools /
        // 28,499 B off every turn. See NO_CHROME_FLAG for why a deny token and
        // --strict-mcp-config both fail to remove it.
        NO_CHROME_FLAG,
      ],
    };
  }
  if (backend === "omp") {
    // omp's papercusp-su is user-level (~/.omp/agent/mcp.json);
    // --append-system-prompt takes a file path; -e loads the coordination
    // extension (P-021) for lock enforcement when one is provided.
    // D-021: the sealed playbook is the whole system prompt; no append branch.
    const args = [
      "--approval-mode",
      "yolo",
      // weak-model-tool-tier: strip omp's own `lsp` builtin unless the
      // server-resolved OMP_NATIVE_LSP_BUILTIN gate says this session may keep
      // it. See ompLspArgs — it carries the full attractor rationale and the
      // reason this is NOT the same switch as our `lsp.*` facade.
      ...ompLspArgs(allowNativeLsp),
      "--system-prompt",
      promptFile,
      // adv 21150 — the SAME title-request mitigation the fresh-role
      // (roleLaunchArgs) and resume paths already apply. ompTitleMitigationArgs'
      // own contract claims "every fresh role, fresh SU, and resume path already
      // funnels through this helper"; the fresh-SU branch was the one path that
      // did NOT, so an interactive `psu` su session kept racing the
      // provider-backed title request that lost a real tracked session while the
      // pool was throttled. Held by the suLaunchArgs > omp argv regression tests.
      ...ompTitleMitigationArgs(),
    ];
    if (coordExtPath) args.push("-e", coordExtPath);
    args.push(...nativeOmpExtensionArgs("omp"));
    // omp-context-injection-parity-2026-08-09 P-003: turn-start + mid-turn
    // context injection, the omp half of what claude gets from its
    // UserPromptSubmit/PostToolBatch hooks. STRICTLY ADDITIVE — one more module
    // alongside the coord extension, no model and no routing touched, so
    // psu->omp keeps launching on OMP's own default config and the owner still
    // picks the model interactively [owner 2026-06-29].
    // `--hook` and `-e` are the SAME loader in omp (main.ts:1049 merges both
    // into additionalExtensionPaths); both flags are repeatable and accumulate,
    // so this appends to — never replaces — any hook the user already has.
    if (injectHookPath) args.push("--hook", injectHookPath);
    return { bin: "omp", args };
  }
  if (backend === "codex") {
    // codex has no --system-prompt flag: its system prompt IS the per-session
    // CODEX_HOME AGENTS.md (the playbook), so Codex already carries no client base
    // that needs a replace-vs-append decision.
    return {
      bin: "codex",
      args: [
        "--dangerously-bypass-hook-trust",
        "--dangerously-bypass-approvals-and-sandbox",
        "--no-alt-screen",
      ],
    };
  }
  throw new Error(
    `suLaunchArgs: backend '${backend}' has no interactive su launch`,
  );
}

/**
 * improve-fleet-launch-autokickoff (EI-5503): the TRAILING POSITIONAL kickoff arg(s)
 * to append to the backend CLI argv — the first user turn that makes a SCRIPTED plan
 * launch (a fleet/automation member) start working the plan immediately instead of
 * orienting once and parking idle. All three backends have a native first-turn
 * seam, but fresh OMP UI sessions need the managed-pty barrier because asynchronous
 * MCP discovery can still be assembling their prompt when OMP submits argv.
 *
 * Empty (today's behavior) unless ALL hold: the server supplied `res.kickoffPrompt`
 * (a plan is bound) · this is a `--no-picker` launch (`args.picker === false`) so an
 * interactive human picker launch still opens at an empty prompt · `--no-kickoff` was
 * not passed (`args.kickoff !== false`). Pure — exported for tests.
 */
/**
 * turn-provenance P-002 (turn-provenance-owner-vs-agent-2026-07-11): envelope +
 * ledger-tag a SCRIPTED kickoff first turn so the session's UserPromptSubmit
 * hook classifies it as verified agent-origin (`fleet-kickoff`), never owner
 * input. MIRROR of packages/operator-core/lib/turn-provenance/turn-provenance.ts
 * (the launcher is plain node and cannot import the TS module) — keep the
 * envelope format + JSONL row shape in lockstep. Fail-soft: any error returns
 * the untagged text (the turn then classifies owner/unverified — visible, and
 * never a broken launch). No-sid launches (interactive, untracked) stay untagged.
 */
export function tagKickoffProvenance(
  text,
  sid,
  env = process.env,
  nowMs = Date.now(),
) {
  try {
    if (!text || !sid) return text;
    const nonce = randomBytes(8).toString("hex");
    const sha256 = createHash("sha256")
      .update(String(text).replace(/\r\n?/g, "\n").trim(), "utf8")
      .digest("hex");
    const dir =
      env.PAPERCUSP_TURN_PROVENANCE_DIR ||
      join(homedir(), ".papercusp", "turn-provenance");
    mkdirSync(dir, { recursive: true });
    const safe = String(sid)
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 200);
    // Ledger row FIRST, then the tagged text (the hook classifies at prompt-submit).
    writeFileSync(
      join(dir, `${safe}.jsonl`),
      JSON.stringify({
        sid,
        nonce,
        origin: "fleet-kickoff",
        sha256,
        ts: nowMs,
      }) + "\n",
      { flag: "a" },
    );
    return `⟦turn-origin:fleet-kickoff nonce:${nonce}⟧\n${text}`;
  } catch {
    return text;
  }
}

export function kickoffPositionalArgs(res, args) {
  // A client-supplied free-form `--kickoff='<text>'` wins over the server's
  // plan-derived kickoff (res.kickoffPrompt) — it's the general "start by working
  // THIS prompt" seam (no plan required), used by the tutorial docs-agent launcher.
  const text = args?.kickoffPromptText || res?.kickoffPrompt;
  if (!text) return [];
  if (args?.picker !== false) return []; // interactive picker launch → empty prompt
  if (args?.kickoff === false) return []; // explicit --no-kickoff opt-out
  return [text];
}

/**
 * The free-form first-turn text for a launch, with the SPAWN-SAFE env fallback:
 * an explicit `--kickoff=<text>` flag wins, else `PAPERCUSP_KICKOFF_PROMPT` from
 * the environment (else null → no kickoff). The env var is how the desktop
 * tutorial's docs-agent launcher delivers the question: a `--kickoff=<text>`
 * VALUE inside a console greetingCmd gets DOUBLE-single-quoted by
 * buildConsoleOneliner and breaks the shell (the gnome-terminal exit-2 the
 * docs-agent hit), whereas an env value is exported via a correctly-escaped
 * `export K=…` in the oneliner prelude and arrives intact (multiline / embedded
 * quotes included). Pure — exported for tests.
 */
export function resolveKickoffText(args, env = process.env) {
  return args?.kickoffPromptText || env?.PAPERCUSP_KICKOFF_PROMPT || null;
}

/**
 * A scripted OMP launch has nobody available to complete OMP's first-run setup
 * wizard.  When an isolated per-session home has not recorded setupVersion yet,
 * that wizard takes focus before the composer prompt; the managed-pty kickoff is
 * then submitted into the "Choose composer shape" overlay and no agent turn is
 * created.  OMP's own supported bypass is OMP_SKIP_SETUP.  Default it only for
 * scripted launches, while preserving both interactive setup and an explicit
 * operator override already present in the environment.
 */
export function scriptedOmpSetupEnv(backend, args, env = process.env) {
  if (
    backend !== "omp" ||
    args?.picker !== false ||
    env?.OMP_SKIP_SETUP != null
  )
    return {};
  return { OMP_SKIP_SETUP: "1" };
}

/**
 * Route every scripted FRESH launch's first turn to the managed-pty safe
 * delivery seam. Keeping prompts out of every backend's argv prevents shared
 * host process diagnostics from exposing the prompt; the PTY host submits the
 * turn after the child settles (EI-20339142329504181).
 *
 * The returned kickoff is already provenance-tagged; callers pass it to
 * runWrapper({ kickoff }) for every backend. Pure apart from the existing provenance
 * ledger write performed by tagKickoffProvenance.
 */
export function routeFreshKickoff(backend, res, args, env = process.env) {
  const kickoffArgs = kickoffPositionalArgs(res, {
    ...args,
    kickoffPromptText: resolveKickoffText(args, env),
  });
  if (!kickoffArgs.length) {
    return { positionalArgs: [], managedKickoff: null, kickoffSeeded: false };
  }

  const sidForTag =
    res?.envelopeEnv?.PAPERCUSP_SID || env?.PAPERCUSP_SID || null;
  const tagged = kickoffArgs.map((text) =>
    tagKickoffProvenance(text, sidForTag, env),
  );
  return {
    positionalArgs: [],
    managedKickoff: tagged[0],
    kickoffSeeded: true,
  };
}

/**
 * Finish a fresh SU launch with the backend-specific first-turn delivery.
 * Every backend keeps argv free of the prompt and receives it through the
 * managed pty.
 *
 * Keep this assembly in one pure helper so the caller cannot truthfully log
 * "kickoff seeded" while accidentally dropping routeFreshKickoff's
 * managed kickoff before runWrapper (the live failure behind WI-39943).
 */
export function finalizeFreshSuArgs(
  backend,
  launchArgs,
  res,
  args,
  env = process.env,
) {
  const kickoff = routeFreshKickoff(backend, res, args, env);
  return {
    args: [...launchArgs, ...kickoff.positionalArgs],
    kickoff: kickoff.managedKickoff,
    kickoffSeeded: kickoff.kickoffSeeded,
  };
}

/**
 * Finish a fresh ROLE launch argv with the same scripted first-turn seam used by
 * fresh SU launches. Role launches used to stop after flags/passthrough, so a
 * headless acceptance judge could inherit PAPERCUSP_KICKOFF_PROMPT yet open at
 * an empty prompt forever. Keep the prompt out of argv for every backend and
 * return the managed-pty kickoff alongside the argv. Tag machine-origin turns
 * and expose whether a turn was actually seeded so the caller can report the
 * launch honestly. Pure
 * except for the existing provenance-ledger write performed by
 * tagKickoffProvenance.
 *
 * @param {any[]} launchArgs
 */
export function finalizeFreshRoleArgs(
  backend,
  launchArgs,
  res,
  args,
  env = process.env,
) {
  const baseArgs = [
    ...launchArgs,
    ...addDirArgs(backend, args?.addDir || []),
    ...(args?.passthrough || []),
  ];
  const kickoff = routeFreshKickoff(backend, res, args, env);
  return {
    args: [...baseArgs, ...kickoff.positionalArgs],
    kickoff: kickoff.managedKickoff,
    kickoffSeeded: kickoff.kickoffSeeded,
  };
}

/**
 * The kickoff text for a RESUME / FORK launch, under the SAME gating as the
 * fresh path (scripted `--no-picker` only, honors `--no-kickoff`) — but with no
 * server-supplied plan kickoff to fall back on, because a resume does no
 * bootstrap POST. Null ⇒ the resumed session opens idle, exactly as before.
 *
 * A resume cannot deliver its first turn the way a fresh launch does: the CLI's
 * positional-prompt seam belongs to a NEW session, and a session that just came
 * back from the dead is unreachable through the roster (coord:wake / coord:send
 * answer `unknown_recipient` — its presence rows were reaped at death). So the
 * text is handed to the managed-pty host, which injects it as a turn once the
 * child settles at its prompt (agent-launch-resume-primitives P-011/D-008 —
 * live-proven on the two desktop-release-0-0-8 legs, 2026-07-12). Pure —
 * exported for tests.
 */
export function resumeKickoffText(args, env = process.env) {
  const [text] = kickoffPositionalArgs(
    {},
    { ...args, kickoffPromptText: resolveKickoffText(args, env) },
  );
  return text ?? null;
}

/**
 * Per-agent resume command — RAW CLI (no `*-su` wrapper, P-042). Pure —
 * exported for tests. Returns the raw `bin` + resume args, re-supplying the
 * same launch flags the fresh-launch path uses (the wrappers used to bake
 * these). Semantics: claude/omp continue the most recent conversation in the
 * session's cwd (omp targets an exact thread when one was captured); codex
 * resumes its most recent session from its per-session CODEX_HOME (set by the
 * caller via env — derived from the session id, which still holds that
 * session's history).
 *
 * MCP + (claude) lock hooks are user-level → survive a raw resume. omp re-adds
 * the coordination extension via `-e <coordExtPath>` (per-invocation, not saved
 * in the thread). codex re-supplies its bypass flags; its hooks/MCP live in the
 * CODEX_HOME the caller points at.
 */
/**
 * Path to the omp CONTEXT-INJECTION hook, or undefined when it should not be
 * passed (omp-context-injection-parity-2026-08-09 P-003). Pure apart from the
 * existsSync probe; exported for tests.
 *
 * Mirrors the coord-extension resolution directly above its call sites: a
 * stable installed path, added ONLY when the file is actually there, so a box
 * that has not run the installer launches exactly as it does today instead of
 * failing on a missing --hook target.
 *
 * omp ONLY. claude gets this via its own UserPromptSubmit/PostToolBatch hooks
 * and codex via its own config; passing --hook to either is meaningless.
 */
export function resolveOmpInjectHookPath(agent, home = homedir()) {
  if (agent !== "omp") return undefined;
  const hook = join(home, ".papercusp", "hooks", "omp", "inject-hook.ts");
  return existsSync(hook) ? hook : undefined;
}

/**
 * @param {any} session
 * @param {{ coordExtPath?: string, injectHookPath?: string, fork?: boolean, forkSessionId?: string | null, addDir?: string[], allowSubagents?: boolean, model?: string | null, personaFile?: string | null, env?: NodeJS.ProcessEnv }} [opts]
 */
export function resumeArgsFor(
  session,
  {
    coordExtPath,
    injectHookPath,
    fork = false,
    forkSessionId = null,
    addDir = [],
    allowSubagents,
    model = null,
    personaFile = null,
    env = process.env,
  } = {},
) {
  // --fork is native for claude and codex; omp has no branch-the-session flag,
  // and silently appending to the original would be the very clobber the user asked
  // to avoid. Refuse loudly instead.
  if (fork && session.agent !== "claude" && session.agent !== "codex") {
    throw new Error(forkUnsupportedMessage(session.agent));
  }
  // `session.sessionId` is the agent's NATIVE session id (a UUID) when known —
  // set for store-found (untracked) sessions, so we resume that EXACT session.
  // Without it (tracked rows don't carry the native id) we fall back to the
  // agent's "most-recent-in-cwd" resume.
  if (session.agent === "claude") {
    const resume = session.sessionId
      ? ["--resume", session.sessionId]
      : ["--continue"];
    // --fork-session: branch the resumed conversation into a NEW session id, leaving
    // the original's id + transcript untouched (so the fork is safe to run alongside it).
    // `--session-id <forkSessionId>` FORCES that new id to one psu pre-minted (a
    // tracked fork — launchTrackedFork) so the fork is resumable from the picker, not
    // only by raw uuid. The plain `--session-id`/`--resume` conflict is LIFTED by
    // --fork-session (verified: claude accepts the trio), so only emit the forced id
    // alongside --fork-session.
    const forkFlag = fork
      ? [
          "--fork-session",
          ...(forkSessionId ? ["--session-id", forkSessionId] : []),
        ]
      : [];
    // Subagent-launch (Task/Agent) DENIED BY DEFAULT (owner mandate 2026-07-02).
    // CLI flags don't persist into a resume, so re-arm the deny every resume —
    // unless this resume explicitly opts in (`psu --resume … --allow-subagents`).
    // `--model`/`--effort` are top-level claude flags — a resume honors them like a
    // fresh launch (WI-3758: model select on resume).
    //
    // The base persona on RESUME too (EI-24628537598753105). A resumed
    // conversation looks intact without it, because claude restores the system
    // prompt from the transcript's prompt_snapshot. But the process argv carries
    // no --system-prompt-file, so the first conversation it starts FRESH — the
    // cold-auto in-place reset (/clear) — boots on claude's stock coding prompt:
    // no playbook, no carry, no identity. And mintRecycleArgs only swaps a flag
    // that is already present, so a recycle or carry-respawn of this process
    // inherits the same hole. Same flags as suLaunchArgs; the caller passes a
    // fresh render (refreshPersonaRender), or null to keep the old argv.
    const personaArgs = personaFile
      ? [
          "--system-prompt-file",
          personaFile,
          "--exclude-dynamic-system-prompt-sections",
        ]
      : [];
    return {
      bin: "claude",
      args: [
        ...resume,
        ...personaArgs,
        "--dangerously-skip-permissions",
        "--permission-mode",
        "bypassPermissions",
        ...(allowSubagents ? [] : [NO_SUBAGENTS_DENY_FLAG]),
        // Native tool-search deny on RESUME too — same persistence gap as the
        // subagent deny: a spawn-time deny does NOT survive into a resume, so a
        // resumed session would silently regain ToolSearch and its uncapped
        // schema loads (this is the psu twin of the wake-executor re-arm).
        NATIVE_TOOL_SEARCH_DENY_FLAG,
        OWNER_DESKTOP_NOTIFY_DENY_FLAG,
        // Model-facing scheduler TOOLS on RESUME too — same persistence gap as
        // the flags above: without this a resumed su session silently regains
        // 9,156 B of schemas per turn. Safe on a ROLE resume as well, being a
        // strict SUBSET of the full lockout that path already intends.
        SU_SCHEDULER_TOOLS_DENY_FLAG,
        // Dead-weight native deny on RESUME too — same persistence gap as the
        // two flags above: a spawn-time deny does NOT survive into a resume, so
        // a resumed session would silently regain ~75,000 B of schemas.
        NATIVE_DEADWEIGHT_DENY_FLAG,
        // Claude-in-Chrome lockout (owner directive 2026-09-15) — 22 tools /
        // 28,499 B off every turn. See NO_CHROME_FLAG for why a deny token and
        // --strict-mcp-config both fail to remove it.
        NO_CHROME_FLAG,
        ...forkFlag,
        ...addDirArgs("claude", addDir),
        ...modelArgsFor("claude", model),
      ],
    };
  }
  if (session.agent === "omp") {
    const args = session.ompThreadId ? ["-r", session.ompThreadId] : ["-c"];
    args.push("--approval-mode", "yolo");
    if (coordExtPath) args.push("-e", coordExtPath);
    // Signed role profiles still use their selected HTTP configuration. Never
    // load a user-level SU native profile into a role-scoped resumed agent.
    if (!session.role || launchesOnSuTier(session.role))
      args.push(...nativeOmpExtensionArgs("omp", env));
    // omp-context-injection-parity P-003. CLI flags do not persist into an omp
    // resume, so the injection hook must be re-passed every resume exactly like
    // the coord extension above — otherwise a resumed session silently loses
    // turn-start/mid-turn context while a fresh one has it.
    if (injectHookPath) args.push("--hook", injectHookPath);
    if (model) args.push(...modelArgsFor("omp", model));
    args.push(...ompTitleMitigationArgs(model));
    // P-023 (D-015): the native-`lsp` gate has to be re-applied on EVERY resume,
    // for the same reason as the two flags above — omp CLI flags do not persist
    // into a resume. Until now this branch simply never emitted `--no-lsp`, so a
    // resumed session kept the builtin unconditionally. That is FAIL-OPEN in the
    // one direction that matters: it handed the tool-attractor back to weak
    // LOCAL models (session 9885 abused `lsp` as a tools:call wrapper), which is
    // the exact population the tier gate exists to exclude. The bug predates
    // P-021 — P-021 replaced two hard-coded literals on the FRESH paths and this
    // third site had no literal to replace, which is why it was missed.
    //
    // WHICH HALF OF THE GATE THIS APPLIES, and why only that half. The full
    // decision is `mayKeepOmpNativeLsp` = TIER && FLAGS.OMP_NATIVE_LSP_BUILTIN,
    // resolved server-side and threaded via envelopeEnv.PAPERCUSP_OMP_NATIVE_LSP.
    // A plain resume has no envelopeEnv and makes no bootstrap POST, so the flag
    // half is genuinely unreachable here — and reading it would give this
    // bare-node launcher the launch-time network dependency the whole design
    // avoids. So resume applies the TIER term alone, from the shared module the
    // server gate uses, against the account-route-resolved resume model.
    //
    // The residual gap, stated rather than hidden: a session whose model is a
    // known CLOUD spec keeps the builtin on resume even if someone has since
    // flipped FLAGS.OMP_NATIVE_LSP_BUILTIN off. Bounded on purpose — the flag
    // ships default-ON precisely because the tier term, not the flag, is the
    // safety gate (see omp-native-lsp-gate.ts), so the unreachable half is the
    // permissive one and the half that fails closed is the one enforced here.
    const allowNativeLsp = ompModelTierAllowsNativeLsp(model);
    args.push(...ompLspArgs(allowNativeLsp));
    return { bin: "omp", args };
  }
  if (session.agent === "codex") {
    // Bypass flags + model + any --add-dir BEFORE the `resume` subcommand (all
    // top-level codex options — `-m`/`-c` AFTER the subcommand would be parsed as
    // resume's own args and fail; WI-3758). CODEX_HOME (the session's home) is set
    // by the caller. `resume <uuid>` / `fork <uuid>` (UUIDs take precedence) for an
    // exact session; `resume --last` / `fork --last` otherwise.
    const subcommand = fork ? "fork" : "resume";
    const target = session.sessionId
      ? [subcommand, session.sessionId]
      : [subcommand, "--last"];
    return {
      bin: "codex",
      args: [
        "--dangerously-bypass-hook-trust",
        "--dangerously-bypass-approvals-and-sandbox",
        "--no-alt-screen",
        ...modelArgsFor("codex", model),
        ...addDirArgs("codex", addDir),
        ...target,
      ],
    };
  }
  throw new Error(`resumeArgsFor: unknown agent: ${session.agent}`);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * The per-session isolated `CLAUDE_CONFIG_DIR` root + dir for a tracked claude
 * session, keyed by its coord owner id — the .mjs mirror of the TS helper
 * `@papercusp/orchestrator/session-launch-dirs` `sessionClaudeConfigDir` (EI-155).
 *
 * An interactive claude session launches with `CLAUDE_CONFIG_DIR` pointed here
 * (bootstrap-su/role → writeInteractiveClaudeConfig), so it writes its transcript
 * under `<dir>/projects/**` — NOT the shared `~/.claude`. Every resume reader
 * (launchResume, claudeStoreHasSession, findUntrackedSession) must therefore look
 * here, or `claude --resume <uuid>` finds nothing. Pure — `home` for tests; honors
 * the same `PAPERCUSP_SESSION_CLAUDE_DIR` override the materializer uses.
 */
function sessionClaudeRoot(home = homedir()) {
  return (
    process.env.PAPERCUSP_SESSION_CLAUDE_DIR ||
    join(home, ".papercusp", "session-claude")
  );
}
function sessionClaudeConfigDir(ownerId, home = homedir()) {
  return join(sessionClaudeRoot(home), ownerId);
}

/** First `"cwd":"…"` in a session jsonl (claude events + codex rollout meta both
 *  carry it), so we recover the launch dir WITHOUT knowing where it started. */
function cwdFromSessionFile(file) {
  try {
    const m = readFileSync(file, "utf8").match(
      /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/,
    );
    return m ? JSON.parse(`"${m[1]}"`) : null;
  } catch {
    return null;
  }
}

/** Recursively find the codex rollout file whose name ends with `-<id>.jsonl`. */
function findCodexRollout(root, id) {
  for (const e of safeReaddir(root)) {
    const p = join(root, e.name);
    if (e.isDirectory()) {
      const hit = findCodexRollout(p, id);
      if (hit) return hit;
    } else if (e.name.endsWith(`-${id}.jsonl`)) return p;
  }
  return null;
}

const CODEX_ROLLOUT_ID_RE =
  /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/**
 * Resolve the newest persisted Codex thread in one isolated home. Carry
 * respawn is the one place where `codex resume --last` is not enough: the
 * successor must branch the exact predecessor so Codex keeps the visible
 * conversation while still minting a fresh native writer. Fail-soft and
 * bounded like the transcript readers above; a missing/partial rollout takes
 * the fresh-thread fallback instead of guessing another session.
 */
export function latestCodexRollout(root) {
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 10) return;
    for (const entry of safeReaddir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
      const match = CODEX_ROLLOUT_ID_RE.exec(entry.name);
      if (!match) continue;
      try {
        const stat = statSync(path);
        if (!stat.isFile() || stat.size <= 0 || stat.size > 64 * 1024 * 1024) continue;
        files.push({ path, id: match[1], mtimeMs: stat.mtimeMs });
      } catch {
        /* a concurrently rotated rollout is not a safe predecessor */
      }
    }
  };
  walk(root, 0);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
  return files[0] ?? null;
}

/** The Codex-native marker carried in the successor's first visible turn. */
export function codexCarryLineageMarker(predecessorId) {
  if (predecessorId) {
    return (
      `⟦codex-carry-lineage predecessor:${predecessorId}⟧\n` +
      "This is a fresh managed continuation. The predecessor transcript is preserved on disk, " +
      `not loaded into this context. Recover earlier detail with sessions:read { session:'${predecessorId}' } ` +
      "or sessions:search; the saved carry document supplies the current task state."
    );
  }
  return (
    "⟦codex-carry-lineage predecessor:unresolved⟧\n" +
    "This is a fresh managed continuation, but the predecessor rollout was not resolved; " +
    "the prior turns remain in the predecessor session and are not deleted."
  );
}

/**
 * Does this codex sessions root hold ANY rollout at all — i.e. would `codex resume --last`
 * find something? The by-uuid sibling {@link findCodexRollout} cannot answer for a row with
 * no recorded `session_id`, and that is the majority case: measured 2026-08-12, 127 of the
 * 241 most recent codex rows had no session_id AND no rollout on disk (128 had no CODEX_HOME
 * directory at all). Those are launches that died before persisting a first turn, and the
 * picker offered every one of them because "no id to check" was read as "assume resumable".
 * Exported for tests.
 */
export function codexHomeHasAnyRollout(root) {
  for (const e of safeReaddir(root)) {
    const p = join(root, e.name);
    if (e.isDirectory()) {
      if (codexHomeHasAnyRollout(p)) return true;
    } else if (e.name.endsWith(".jsonl")) return true;
  }
  return false;
}

function findOmpTranscript(root, id) {
  for (const entry of safeReaddir(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const hit = findOmpTranscript(path, id);
      if (hit) return hit;
    } else if (entry.name.endsWith(`_${id}.jsonl`)) {
      return path;
    }
  }
  return null;
}

function trackedCodexSessionsRoot(session, home = homedir()) {
  // A restored session may have a configured or relocated native home. The
  // persisted launch identity outranks the default per-adv directory layout.
  if (session.codexHome) return join(session.codexHome, "sessions");
  if (session.id == null) return null;
  return join(
    home,
    ".papercusp",
    "su-codex-homes",
    `session-${session.id}`,
    "sessions",
  );
}

/**
 * WI-3884: scan ALL tracked per-session CODEX_HOMEs
 * (`~/.papercusp/su-codex-homes/session-<advId>/sessions`) for a rollout uuid.
 * resolveTrackedResumeSession only scans the homes of the RESUMABLE WINDOW
 * (/api/adv/sessions/resumable, default 30 rows) — a tracked codex session
 * older than that window is invisible to it, and findUntrackedSession's codex
 * branch only searched the SHARED ~/.codex/sessions store (owner-hit live:
 * psu #11582 / rollout 019f4d46…). The dir name recovers the adv session id,
 * and the hit's home is REQUIRED for the resume — the rollout is invisible to
 * codex under any other CODEX_HOME. Returns
 * `{ advSessionId, codexHome, rollout }` or null. Exported for tests.
 */
export function findTrackedCodexHomeRollout(id, { home = homedir() } = {}) {
  if (!id) return null;
  const root = join(home, ".papercusp", "su-codex-homes");
  for (const d of safeReaddir(root)) {
    if (!d.isDirectory() || !d.name.startsWith("session-")) continue;
    const rollout = findCodexRollout(join(root, d.name, "sessions"), id);
    if (!rollout) continue;
    const advSessionId = Number(d.name.slice("session-".length));
    return {
      advSessionId: Number.isFinite(advSessionId) ? advSessionId : null,
      codexHome: join(root, d.name),
      rollout,
    };
  }
  return null;
}

/**
 * Resolve a direct `psu --resume <id>` against tracked adv_sessions rows.
 *
 * Claude records its native UUID at bootstrap, so `sessionId` is enough. OMP
 * learns its native thread id after launch via the coord hook, so match
 * `ompThreadId` too. Codex cannot be forced to a pre-minted id, but its rollout
 * UUID is persisted under the tracked row's isolated CODEX_HOME; when the user
 * passes that UUID, discover the owning row and graft the id onto the transient
 * session object so `resumeArgsFor` can emit `codex resume <uuid>` while
 * `launchResume` still restores that row's CODEX_HOME.
 */
export function resolveTrackedResumeSession(
  sessions,
  id,
  { home = homedir() } = {},
) {
  if (!id) return null;
  const wanted = String(id);
  const direct = sessions.find(
    (s) =>
      String(s.id) === wanted ||
      (s.sessionId && s.sessionId === wanted) ||
      (s.ompThreadId && s.ompThreadId === wanted),
  );
  if (direct) return direct;

  if (!UUID_RE.test(wanted)) return null;
  for (const session of sessions) {
    if (session.agent !== "codex") continue;
    const root = trackedCodexSessionsRoot(session, home);
    if (root && findCodexRollout(root, wanted)) {
      return { ...session, sessionId: wanted };
    }
  }
  return null;
}

/**
 * Find a session the user did NOT launch via psu, by searching each agent's
 * OWN session store for the id — NOT a filesystem crawl: claude keeps every
 * session under `~/.claude/projects/<dir>/<id>.jsonl`, codex under
 * `~/.codex/sessions/**​/rollout-*-<uuid>.jsonl`. The store IS the index, and
 * the matched file records its own `cwd`, so the launch dir falls out of it.
 * Returns `{ agent, sessionId|ompThreadId, cwd, untracked:true }` or null.
 * A UUID → claude/codex (whichever store has it); a non-UUID → an omp thread
 * name (resumed in the current dir, since omp's store isn't path-indexed here).
 * Pure-ish (reads FS); exported for tests.
 */
export function findUntrackedSession(
  id,
  { home = homedir(), cwd = process.cwd() } = {},
) {
  if (!id) return null;
  if (UUID_RE.test(id)) {
    const claudeProjects = join(home, ".claude", "projects");
    for (const d of safeReaddir(claudeProjects)) {
      if (!d.isDirectory()) continue;
      const f = join(claudeProjects, d.name, `${id}.jsonl`);
      if (existsSync(f))
        return {
          agent: "claude",
          sessionId: id,
          cwd: cwdFromSessionFile(f) || cwd,
          untracked: true,
        };
    }
    // EI-155: interactive claude sessions write transcripts under per-session
    // isolated dirs (`<session-claude>/<owner>/projects`), not the shared store —
    // scan those too, so an isolated session whose adv row was pruned still
    // resolves by its native uuid (and carries its `configDir` so the resume
    // points CLAUDE_CONFIG_DIR back at it).
    //
    // EI-9756: a hit here is found ONLY because psu's own per-owner isolation
    // dir structure exists — a genuinely vanilla (non-psu) claude session can
    // never land under `session-claude/<owner>/`. So, exactly like the
    // WI-3884 tracked-CODEX_HOME case below, mark it `psuTracked` — the most
    // common reason this branch is reached at all is an ENDED session whose
    // adv row fell outside the (default 30-row) `/adv/sessions/resumable`
    // window, NOT an untracked/foreign session; the prior unconditional
    // "isn't linked to a tracked psu launch" warning was actively misleading
    // for that (very common) case and is exactly what the owner-reported
    // repro saw.
    const isoRoot = sessionClaudeRoot(home);
    for (const owner of safeReaddir(isoRoot)) {
      if (!owner.isDirectory()) continue;
      const configDir = join(isoRoot, owner.name);
      const projects = join(configDir, "projects");
      for (const d of safeReaddir(projects)) {
        if (!d.isDirectory()) continue;
        const f = join(projects, d.name, `${id}.jsonl`);
        if (existsSync(f)) {
          return {
            agent: "claude",
            sessionId: id,
            cwd: cwdFromSessionFile(f) || cwd,
            untracked: true,
            configDir,
            psuTracked: true,
          };
        }
      }
    }
    const codexRollout = findCodexRollout(join(home, ".codex", "sessions"), id);
    if (codexRollout)
      return {
        agent: "codex",
        sessionId: id,
        cwd: cwdFromSessionFile(codexRollout) || cwd,
        untracked: true,
      };
    // WI-3884: a psu-TRACKED codex session OLDER than the resumable window
    // (default 30 rows) falls through to here — its adv row wasn't in the API
    // slice, so resolveTrackedResumeSession never scanned its home, and the
    // shared ~/.codex store above doesn't hold tracked rollouts. Scan the
    // tracked-home store itself: `id` (from the dir name) re-attaches the adv
    // row (reactivation on resume), `codexHome` points the resume at the ONLY
    // CODEX_HOME that can see this rollout, and `psuTracked` skips the
    // "not launched by psu" confirm (it WAS — the home carries the baked
    // config.toml + AGENTS.md, so nothing is lost on resume).
    const trackedHome = findTrackedCodexHomeRollout(id, { home });
    if (trackedHome) {
      return {
        agent: "codex",
        sessionId: id,
        cwd: cwdFromSessionFile(trackedHome.rollout) || cwd,
        untracked: true,
        psuTracked: true,
        id: trackedHome.advSessionId,
        codexHome: trackedHome.codexHome,
      };
    }
    return null;
  }
  // Non-UUID → treat as an omp thread name; resume in the current dir.
  return { agent: "omp", ompThreadId: id, cwd, untracked: true };
}

/**
 * Durable native-session-id → coordination-ownerId index — the fix for the
 * untracked-resume identity split (owner bug 2026-07-02): `psu --resume <uuid>`
 * on a session with no visible adv row fell through to findUntrackedSession,
 * which knows no coordOwnerId, so resumeEnvFor MINTED a fresh SID. The resumed
 * body then registered its pty host, took file locks, and answered presence
 * under the NEW sid while the fleet/coordination plane still addressed the OLD
 * one — orphaning fleet leadership and locks, and breaking wake/recolor
 * injection (findLiveHost looks for `<oldSid>.json`, which no longer exists).
 *
 * One file per native session id under `~/.papercusp/psu-session-owners/` so
 * concurrent launches never contend on a shared file. FIRST WRITE WINS: the
 * binding records the identity the session was BORN with; a later launch under
 * a different SID (the pre-fix bug, or any future drift) must not rebind it.
 * The psu-pty registry can't serve this purpose — its json is removed when the
 * host ends; these entries persist, and that durability is the point.
 */
export function sessionOwnersRoot(home = homedir()) {
  return join(home, ".papercusp", "psu-session-owners");
}

/** Record `nativeSessionId → coordOwnerId` (first write wins; `wx` create keeps
 *  a concurrent double-launch to one winner). Never throws — an index miss only
 *  costs the old minted-SID behavior, so no launch is ever blocked on it. */
export function recordSessionOwner(
  nativeSessionId,
  coordOwnerId,
  { home = homedir(), advSessionId = /** @type {number|string|null} */ (null) } = {},
) {
  if (!nativeSessionId || !coordOwnerId) return false;
  const file = join(sessionOwnersRoot(home), String(nativeSessionId));
  try {
    if (existsSync(file)) return false;
    mkdirSync(sessionOwnersRoot(home), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        ownerId: coordOwnerId,
        advSessionId,
        recordedAt: new Date().toISOString(),
      }) + "\n",
      { flag: "wx" },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Tee this launcher's OWN stderr into the launch's boot log — WI-37841.
 *
 * WHAT THIS BUYS. When a HUD "+ New session" launch dies before psu registers,
 * the operator can say only "its terminal closed before the session came online"
 * — it has no access to the one artifact that names the cause, because psu's
 * diagnostics go to the spawned window's pty and nowhere else. That has now cost
 * two full forensic sessions for two different root causes. Every explanation
 * was already printed; none was readable afterwards.
 *
 * WHY A STREAM WRAPPER AND NOT INSTRUMENTED EXIT PATHS. This launcher has 60+
 * `console.error` / `process.exit` sites. Instrumenting them is unmaintainable
 * and, worse, fails silently in the direction that matters: the exit path nobody
 * remembered to annotate is precisely the novel failure a future forensic
 * session will be spent on. One wrapper at the stream captures all of them —
 * including an uncaught exception's stack, which no per-site annotation would.
 *
 * WHY STDERR ONLY, NEVER STDOUT. psu hands stdout to an INTERACTIVE agent client
 * (the claude/codex REPL owns the pty). Routing it through a tee — the obvious
 * shell-level `psu … | tee` shape — destroys the tty and breaks every launch it
 * was meant to diagnose. This wrapper also only ever ADDS a file write; the
 * original `write` still runs first, so the window shows exactly what it did
 * before.
 *
 * SCOPE IS SELF-LIMITING, BY CONSTRUCTION. Only a launch that was handed a
 * PRE-PINNED `--owner-id` (i.e. a programmatic one — launch-su) gets a log; a
 * human typing `psu` at a terminal has the window in front of them and needs no
 * side-channel. And once psu hands the tty to the agent child, the child writes
 * to fd 2 directly rather than through this JS wrapper, so capture naturally
 * stops at the boot boundary instead of trailing a session for hours.
 *
 * Never throws, and returns null when it captured nothing: a diagnostic
 * side-channel must never be able to fail a launch. Every failure degrades to
 * exactly the pre-WI-37841 behaviour.
 *
 * ⚠ `stream` is TYPED AS THE MINIMAL WRITABLE ON PURPOSE, not as
 * `typeof process.stderr`. Inferring it from the default value narrows the
 * generated declaration to `WriteStream & { fd: 2 }`, which no test double can
 * satisfy — that would make the one DI seam here reachable only by a cast, and
 * a seam you must lie to the compiler to use is not a seam. Everything this
 * function needs is `write`.
 *
 * @param {string|null|undefined} ownerId the PRE-PINNED coord owner id
 * @param {{
 *   home?: string,
 *   maxBytes?: number,
 *   stream?: { write: (chunk: any, encoding?: any, cb?: any) => boolean },
 *   argv?: string[],
 *   now?: () => Date,
 * }} [opts]
 * @returns {{ path: string, uninstall: () => void } | null}
 */
export function installBootLogCapture(
  ownerId,
  {
    home = homedir(),
    maxBytes = PSU_LAUNCH_LOG_MAX_BYTES,
    stream = process.stderr,
    argv = process.argv.slice(2),
    now = () => new Date(),
  } = {},
) {
  const file = ensurePsuLaunchLogPath(ownerId, { home });
  if (!file) return null;
  let fd;
  try {
    // 'w' — TRUNCATE. Owner ids are unique per launch, so this file belongs to
    // this launch alone; truncating means a reader can never be handed a
    // previous launch's diagnostic, which would be worse than no diagnostic.
    fd = openSync(file, "w");
  } catch {
    return null;
  }
  let written = 0;
  let live = true;
  const append = (text) => {
    if (!live || written >= maxBytes) return;
    try {
      const buf = Buffer.from(text, "utf8");
      const room = maxBytes - written;
      writeSync(fd, room >= buf.length ? buf : buf.subarray(0, room));
      written += buf.length;
    } catch {
      // A broken fd must not take the launch down with it, and retrying every
      // subsequent write would turn one fault into a storm.
      live = false;
    }
  };
  // The header is half the value: a failed launch's argv is what distinguishes
  // "psu refused these arguments" from "psu never got that far", and it is not
  // recoverable from the adv_sessions row once the launch dies.
  append(
    `# psu launch ${ownerId} at ${now().toISOString()}\n# argv: ${argv.join(" ")}\n`,
  );
  // Keep the UNBOUND original and re-dispatch with `.call(stream, …)`, rather
  // than storing a `.bind(stream)` copy: uninstall must put back the exact
  // function that was there, or a second install/uninstall cycle leaves a stack
  // of bound wrappers behind and the stream never returns to its own method.
  const original = stream.write;
  stream.write = (chunk, encoding, cb) => {
    try {
      append(
        typeof chunk === "string"
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString("utf8")
            : String(chunk),
      );
    } catch {
      // fall through — the real write below is what the user sees, and it must
      // happen whatever the tee did.
    }
    return original.call(stream, chunk, encoding, cb);
  };
  // Housekeeping, not correctness: one small file per launch would otherwise
  // accrete forever. Best-effort and bounded (see prunePsuLaunchLogs).
  try {
    prunePsuLaunchLogs({ home });
  } catch {
    /* never blocks a launch */
  }
  return {
    path: file,
    /** Restore the original stream + stop writing. Tests use it; production
     *  never needs to — the process exiting is the natural end of capture. */
    uninstall() {
      live = false;
      stream.write = original;
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    },
  };
}

/** The durable identity recorded when this native session was born. */
export function recoverSessionIdentity(
  nativeSessionId,
  { home = homedir() } = {},
) {
  if (!nativeSessionId) return null;
  try {
    const parsed = JSON.parse(
      readFileSync(
        join(sessionOwnersRoot(home), String(nativeSessionId)),
        "utf8",
      ),
    );
    const ownerId =
      typeof parsed?.ownerId === "string" && parsed.ownerId
        ? parsed.ownerId
        : null;
    if (!ownerId) return null;
    const adv = Number(parsed?.advSessionId);
    return {
      ownerId,
      advSessionId: Number.isSafeInteger(adv) && adv > 0 ? adv : null,
    };
  } catch {
    return null;
  }
}

/** The coordOwnerId this native session was born with, or null (no entry /
 *  unreadable / malformed — all degrade to the caller minting, never throw). */
export function recoverSessionOwner(
  nativeSessionId,
  { home = homedir() } = {},
) {
  return recoverSessionIdentity(nativeSessionId, { home })?.ownerId ?? null;
}

/**
 * Recover the canonical coordination owner for a session found outside the
 * recent adv_sessions window. A tracked session's adv-keyed binding wins: it
 * names the owner still attached to the durable row (and therefore its fleet,
 * loop, locks, and checkpoints). The native id remains the fallback for raw
 * sessions and older launches that predate the adv-keyed index.
 */
export function recoverResumeSessionOwner(session, { home = homedir() } = {}) {
  return recoverResumeSessionIdentity(session, { home })?.ownerId ?? null;
}

/** Recover both durable identity halves for an out-of-window resume. The
 * adv-keyed entry wins when the row id is known; otherwise the native-session
 * entry supplies the id recorded at launch. */
export function recoverResumeSessionIdentity(
  session,
  { home = homedir() } = {},
) {
  if (session?.id != null) {
    const advIdentity = recoverSessionIdentity(`adv-${session.id}`, { home });
    if (advIdentity) return advIdentity;
  }
  return recoverSessionIdentity(session?.sessionId || session?.ompThreadId, {
    home,
  });
}

/** Exact server read for a psu session found on disk after it fell outside the
 * bounded resumable window. The local owner index supplies the durable adv id;
 * the server row supplies the workspace/plan/launch identity a managed fork
 * requires. Raw/foreign sessions deliberately have no such read. */
export function exactTrackedResumePath(session) {
  const id = Number(session?.id);
  if (session?.psuTracked !== true || !Number.isSafeInteger(id) || id <= 0) return null;
  return `/api/adv/sessions/resumable?id=${encodeURIComponent(String(id))}`;
}

/** Merge the exact durable row with the on-disk hit that found it. The disk hit
 * wins for native id/config dir/cwd because those identify the transcript that
 * was actually requested; the durable row restores coordination scope. */
export function rehydrateOutOfWindowTrackedSession(session, exactRead) {
  const path = exactTrackedResumePath(session);
  if (!path) return null;
  const tracked = resolveTrackedResumeSession(exactRead?.sessions ?? [], String(session.id));
  if (!tracked) return null;
  return {
    ...tracked,
    ...(session.sessionId ? { sessionId: session.sessionId } : {}),
    ...(session.ompThreadId ? { ompThreadId: session.ompThreadId } : {}),
    ...(session.cwd ? { cwd: session.cwd } : {}),
    ...(session.configDir ? { configDir: session.configDir } : {}),
    ...(session.codexHome ? { codexHome: session.codexHome } : {}),
  };
}

/** WI-10003198: exact server read by NATIVE session id, for a psu-tracked
 * transcript whose row id the local index cannot supply. The server bridges the
 * uuid through session_turns.owner to the owner's current row — which is the
 * only row an earlier carry-respawn incarnation has, since a respawn rewrites
 * its owner's row in place. Raw/foreign sessions get no such read. */
export function exactTrackedResumeBySessionPath(session) {
  if (session?.psuTracked !== true) return null;
  const sid = session?.sessionId;
  if (!sid || !UUID_RE.test(String(sid))) return null;
  return `/api/adv/sessions/resumable?sessionId=${encodeURIComponent(String(sid))}`;
}

/** The coord owner whose isolated CLAUDE_CONFIG_DIR holds this transcript, or
 * null when the hit is not under `session-claude/<owner>/`. That directory is
 * keyed by the owner the transcript was written under, so it is ground truth a
 * recovered row must agree with. Pure — exported for tests. */
export function transcriptOwnerFromConfigDir(session, home = homedir()) {
  const dir = session?.configDir;
  if (!dir) return null;
  const root = sessionClaudeRoot(home);
  if (dirname(dir) !== root) return null;
  return basename(dir) || null;
}

/**
 * Recover the durable adv row for a psu-tracked transcript found on disk after
 * the bounded `/adv/sessions/resumable` window missed it (WI-10002877,
 * WI-10003198). Two exact reads, in order:
 *   1. the row id the local first-write-wins owner index recorded at launch;
 *   2. the server's session_turns owner bridge, by native session id — the only
 *      way to reach an earlier carry-respawn incarnation, whose own launch never
 *      wrote an index entry with a row id (measured 2026-09-26: 41 of 52 refused
 *      consult sources).
 * A recovered row is accepted only when its coord owner matches the owner whose
 * isolated config dir holds the transcript: the index is first-write-wins and has
 * been seen naming a foreign owner, so it is never trusted over that directory.
 * Returns `{ tracked, reasons }`; `tracked` is null when nothing was recovered and
 * `reasons` says why, for the caller's refusal message. Never throws.
 */
export async function recoverOutOfWindowTrackedSession(
  untracked,
  { apiImpl = api, home = homedir() } = {},
) {
  const reasons = [];
  const dirOwner = transcriptOwnerFromConfigDir(untracked, home);
  const accept = (tracked, via) => {
    if (dirOwner && tracked.coordOwnerId && tracked.coordOwnerId !== dirOwner) {
      reasons.push(
        `${via} row #${tracked.id} belongs to ${tracked.coordOwnerId}, but the transcript is under ${dirOwner}`,
      );
      return null;
    }
    return tracked;
  };
  const byId = exactTrackedResumePath(untracked);
  if (byId) {
    try {
      const recovered = rehydrateOutOfWindowTrackedSession(untracked, await apiImpl(byId));
      if (recovered) {
        const ok = accept(recovered, "owner-index");
        if (ok) return { tracked: ok, reasons };
      } else {
        reasons.push(`owner-index row #${untracked.id} is not a resumable tracked row`);
      }
    } catch (error) {
      reasons.push(`owner-index row #${untracked.id} read failed (${error?.message ?? error})`);
    }
  }
  const bySession = exactTrackedResumeBySessionPath(untracked);
  if (bySession) {
    try {
      const read = await apiImpl(bySession);
      const id = Number(read?.exact?.id);
      if (Number.isSafeInteger(id) && id > 0) {
        const recovered = rehydrateOutOfWindowTrackedSession({ ...untracked, id }, read);
        if (recovered) {
          const ok = accept(recovered, "session-bridge");
          if (ok) return { tracked: ok, reasons };
        } else {
          reasons.push(`session-bridge row #${id} is not a resumable tracked row`);
        }
      } else {
        reasons.push(
          `the operator resolved no tracked row for native session ${untracked.sessionId}` +
            (read && !("exact" in read) ? " (it may predate the sessionId lookup)" : ""),
        );
      }
    } catch (error) {
      reasons.push(`session-bridge read failed (${error?.message ?? error})`);
    }
  }
  if (!byId && !bySession) reasons.push("no row id and no native session uuid to look up");
  return { tracked: null, reasons };
}

/**
 * The native session id a launch argv identifies AS THIS SESSION, or null.
 * Precedence matters because a fork's argv names TWO sessions:
 *   1. `--session-id <uuid>` wins — it declares the launched session's OWN id
 *      (fresh launches force it; a tracked claude fork emits
 *      `--resume <orig> --fork-session --session-id <forkId>`, and binding the
 *      ORIGINAL's id to the fork's fresh SID would poison the index).
 *   2. `--fork-session` with no forced id → null: the fork's new native id is
 *      minted by claude at runtime and unknowable here. Codex forks
 *      (`codex fork <uuid>`) likewise match nothing.
 *   3. Else `--resume <uuid>` (claude) / `resume <uuid>` subcommand (codex) —
 *      a plain resume IS the named session. OMP threads are non-UUID names,
 *      deliberately skipped.
 * Pure — exported for tests.
 */
export function nativeSessionIdFromLaunchArgs(args = []) {
  const argStrs = args.map((a) => String(a ?? ""));
  for (let i = 0; i < argStrs.length; i++) {
    const a = argStrs[i];
    if (a === "--session-id" && UUID_RE.test(argStrs[i + 1] ?? ""))
      return argStrs[i + 1];
    if (a.startsWith("--session-id=")) {
      const v = a.slice("--session-id=".length);
      if (UUID_RE.test(v)) return v;
    }
  }
  if (argStrs.includes("--fork-session")) return null;
  for (let i = 0; i < argStrs.length; i++) {
    const a = argStrs[i];
    if (
      (a === "--resume" || a === "resume") &&
      UUID_RE.test(argStrs[i + 1] ?? "")
    )
      return argStrs[i + 1];
    if (a.startsWith("--resume=")) {
      const v = a.slice("--resume=".length);
      if (UUID_RE.test(v)) return v;
    }
  }
  return null;
}

/**
 * WI-1980: build the argv for a cold-loop RECYCLE respawn.
 *
 * The initial launch forces the launched session's OWN id via `--session-id
 * <uuid>` (not resume — it DECLARES the id, see nativeSessionIdFromLaunchArgs).
 * The recycle host reused that argv verbatim, so every respawn re-declared the
 * SAME id whose transcript already existed on disk from the first boot → claude
 * refused to create an already-existing session → boot-error → supervisor
 * respawn → boot-retry storm (4× in 31s at wake 8, su-8ab32510 repro).
 *
 * A RECYCLE is a HARD cold reset — its intent IS a clean conversation, so we
 * mint a FRESH `--session-id` and strip any warm-resume flags
 * (`--resume`/`--continue`/`--fork-session`). The coord identity (PAPERCUSP_SID
 * in `env`) is deliberately UNCHANGED (D-003) — only the native claude id
 * rotates. Returns { args, nativeId } where nativeId is the fresh id (so the
 * caller can re-anchor native→coord via recordSessionOwner), or null when the
 * argv carries no `--session-id` (e.g. omp launches) — then args is returned
 * untouched and the respawn is a no-op change.
 *
 * Pure — exported for tests. `mintId` is injectable for deterministic tests.
 */
/** The provenance envelope every SCRIPTED kickoff carries (tagKickoffProvenance
 *  above, and turn-provenance.ts's ENVELOPE_RE which this mirrors). Minted ONLY
 *  for a kickoff first turn, so a token bearing one is definitively a kickoff
 *  positional and never a flag's value. */
const KICKOFF_ENVELOPE_RE =
  /^\s*⟦turn-origin:[A-Za-z0-9:._@-]+ nonce:[a-f0-9]{8,64}⟧/;

/** True for a SELF-CONTAINED inline flag (`--key=value`). It cannot consume the
 *  FOLLOWING token as its value, which is what makes whatever follows it a
 *  provable positional rather than a maybe-value. */
function isInlineFlag(tok) {
  return tok.startsWith("--") && tok.includes("=");
}

/**
 * Drop the trailing KICKOFF POSITIONAL from a launch argv.
 *
 * WI-37939: `kickoffPositionalArgs` seeds a scripted launch's first turn as a
 * TRAILING POSITIONAL (psu-launcher ~L7726). `mintRecycleArgs`'s copy loop then
 * carried it through verbatim on every recycle / carry-respawn, so each fresh
 * child re-exec'd `claude` with the ORIGINAL kickoff still on its argv and
 * opened on that stale prompt as turn 1 — forever, however many respawns later.
 * Measured on su-12b70e95: a fleet-kickoff minted 2026-08-10T16:57:23Z was
 * re-delivered 26.6h later, asserting a GOAL-mode contract that session never
 * held, for a goal already achieved. Same bug shape as the P-002 staleness fix
 * below (argv copied through verbatim), one argv element over. A recycle is a
 * CLEAN BOOT whose first prompt is the carry text the host types in
 * (recycleChild -> injectTurnAtPrompt), so the launch prompt must not survive.
 *
 * CONSERVATIVE BY CONSTRUCTION — strips only on POSITIVE identification, because
 * wrongly eating a flag's VALUE would launch the successor with a broken flag
 * (strictly worse than the staleness this fixes). Two provably-safe signals:
 *   1. the token carries a kickoff provenance envelope; or
 *   2. it is not a flag AND the token before it is an inline `--key=value`,
 *      which cannot own a following value — so this one is a positional.
 * Anything else is left alone (an untagged kickoff behind a value-taking flag
 * keeps today's behaviour rather than risking a mangled argv). Pure; exported
 * for tests.
 */
export function stripKickoffPositional(args = []) {
  const out = args.map((a) => String(a ?? ""));
  while (out.length) {
    const last = out[out.length - 1];
    const prev = out.length >= 2 ? out[out.length - 2] : null;
    const taggedKickoff = KICKOFF_ENVELOPE_RE.test(last);
    const provablePositional =
      !last.startsWith("-") && prev !== null && isInlineFlag(prev);
    if (!taggedKickoff && !provablePositional) break;
    out.pop();
  }
  return out;
}

/**
 * @param {string[]} [args]
 * @param {{ mintId?: () => string, agent?: string | null, personaFile?: string | null, model?: string | null }} [opts]
 */
export function mintRecycleArgs(
  args = [],
  {
    mintId = () => randomUUID(),
    agent = null,
    personaFile = null,
    model = null,
  } = {},
) {
  const raw = args.map((a) => String(a ?? ""));
  // stale-prompt-render-in-live-sessions-2026-08-02 P-002: the freshly re-rendered
  // base persona, when the operator produced one. See the --system-prompt-file case
  // in the copy loop below for why this exists.
  const persona =
    typeof personaFile === "string" && personaFile.trim()
      ? personaFile.trim()
      : null;
  // WI-2141859: the model this session is CURRENTLY running, when the caller
  // detected one that differs from the inherited flag (detectRespawnModelSpec).
  // Same shape as `persona` above and for the same reason — see the --model
  // case in the copy loop below.
  const freshModel =
    typeof model === "string" && model.trim() ? model.trim() : null;
  const hasSessionId = raw.some(
    (a) => a === "--session-id" || a.startsWith("--session-id="),
  );
  // A RESUME-launched Claude session (`claude --resume <id>`) has no --session-id
  // to rotate — but a recycle/carry-respawn successor never wants the old
  // transcript anyway (the carry document replaces it), so for claude we
  // SYNTHESIZE a fresh --session-id instead of bailing. Before this, every
  // `psu --resume`d session was un-respawnable: the watchdog's forced
  // carry-respawn failed argv-build on EVERY sweep, spamming the terminal with
  // "carry-respawn requires a Claude --session-id launch" and leaving the
  // session unpoliced (owner-reported 2026-07-18). Non-claude argv is never
  // touched here (--session-id is a claude flag).
  const isClaude =
    String(agent ?? "")
      .trim()
      .toLowerCase() === "claude";
  if (!hasSessionId && !isClaude) {
    // Codex has no --session-id, but a fresh carry still inherits its launch
    // argv. Replace the single model flag when the predecessor or configured
    // default has changed; otherwise an old -m overrides the repaired home.
    if (String(agent ?? "").trim().toLowerCase() !== "codex" || !freshModel)
      return { args, nativeId: null };
    const selected = splitRespawnModelSpec(freshModel);
    if (!selected.id) return { args, nativeId: null };
    const out = [];
    let replacedModel = false;
    let replacedEffort = false;
    for (let i = 0; i < raw.length; i++) {
      const a = raw[i];
      if (a === "-m" || a === "--model") {
        out.push(a, selected.id);
        replacedModel = true;
        i++;
      } else if (a.startsWith("--model=")) {
        out.push(`--model=${selected.id}`);
        replacedModel = true;
      } else if (selected.effort && a === "-c" &&
                 /^model_reasoning_effort=/.test(raw[i + 1] ?? "")) {
        out.push("-c", `model_reasoning_effort="${selected.effort}"`);
        replacedEffort = true;
        i++;
      } else {
        out.push(a);
      }
    }
    if (replacedModel && selected.effort && !replacedEffort)
      out.push("-c", `model_reasoning_effort="${selected.effort}"`);
    return { args: out, nativeId: null };
  }
  // WI-37939: drop the launch kickoff BEFORE the copy loop, so no path below can
  // carry it into the successor argv. See stripKickoffPositional above.
  const src = stripKickoffPositional(raw);
  const freshId = mintId();
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const a = src[i];
    if (a === "--session-id") {
      out.push("--session-id", freshId);
      i++; // consume the stale id token
      continue;
    }
    if (a.startsWith("--session-id=")) {
      out.push(`--session-id=${freshId}`);
      continue;
    }
    // A recycle is a clean boot — drop every warm-resume flag (and its value).
    if (a === "--resume") {
      i++; // consume the resumed-session id token
      continue;
    }
    if (a.startsWith("--resume=")) continue;
    if (a === "--continue" || a === "--fork-session") continue;
    // stale-prompt-render-in-live-sessions-2026-08-02 P-002: THE staleness bug lived
    // in the bare `out.push(a)` below. It copies every remaining flag through
    // verbatim — including `--system-prompt-file <the PREDECESSOR's render>` — so a
    // session's base persona was pinned to the first launch of its chain forever,
    // however many times it respawned. Only the carry document was ever refreshed.
    // Measured 2026-08-02: 27 of 53 live claude sessions ran a render up to 14 days
    // old, so every prompt fix of that fortnight reached only half the fleet.
    //
    // REPLACE the value, never append a second flag (claude takes the last one, but
    // relying on that would be an accident waiting to be reordered), and only when
    // the caller actually obtained a fresh render — a null personaFile means the
    // refresh was unavailable or failed, and then keeping the inherited path is the
    // deliberate fail-soft: a stale prompt beats a lost session. An omp/codex argv
    // (no --system-prompt-file) is left alone; a CLAUDE argv without the flag gets
    // one after this loop (EI-24628537598753105).
    if (persona && a === "--system-prompt-file") {
      out.push("--system-prompt-file", persona);
      i++; // consume the stale render path
      continue;
    }
    if (persona && a.startsWith("--system-prompt-file=")) {
      out.push(`--system-prompt-file=${persona}`);
      continue;
    }
    // WI-2141859: THE MODEL half of exactly the staleness the persona case
    // above fixes, and the bare `out.push(a)` below is again where it lived.
    // `--model` copied through verbatim pins the successor to the model the
    // CHAIN was launched with — and because an explicit --model OVERRIDES the
    // CLI's in-session `/model` selection, an owner who changes model in the
    // chat has it reverted at the very next respawn. Owner-reported 2026-09-02
    // ("I switched all models to opus, which worked, but whenever they carry
    // themselves to a new session they restart as fable agents again"),
    // measured on three live chains — su-60757119 ran fable, fable, fable,
    // OPUS, FABLE, fable: the switch held for one session, then the respawn
    // undid it.
    //
    // REPLACE the value, never append a second flag (claude takes the last one,
    // but relying on that would be an accident waiting to be reordered), and
    // only when the caller actually detected the session's current model — a
    // null `model` means detection was unavailable and the deliberate fail-soft
    // is the inherited spec: a stale model beats a successor that boots on the
    // wrong one. An argv with NO --model is left alone; we never ADD the flag,
    // and that is not an oversight — such a session already honours `/model`
    // across respawns on its own, because the CLI persists the selection and
    // there is no flag to override it (measured: su-0c710c57 switched to opus
    // mid-session and both successors stayed opus). Adding a flag there would
    // newly pin a session that currently self-corrects.
    if (freshModel && a === "--model") {
      out.push("--model", freshModel);
      i++; // consume the stale spec
      continue;
    }
    if (freshModel && a.startsWith("--model=")) {
      out.push(`--model=${freshModel}`);
      continue;
    }
    out.push(a);
  }
  // EI-24628537598753105: the one place the persona IS added. A claude argv
  // with no --system-prompt-file is a process resumed before resumeArgsFor
  // carried the persona (or one whose resume render failed); its successor would
  // otherwise boot on claude's stock coding prompt with only the carry appended.
  // omp/codex never reach here with a persona that means anything to them.
  const hasPersonaFlag = raw.some(
    (a) =>
      a === "--system-prompt-file" || a.startsWith("--system-prompt-file="),
  );
  if (persona && isClaude && !hasPersonaFlag) {
    out.push("--system-prompt-file", persona);
    if (!raw.includes("--exclude-dynamic-system-prompt-sections"))
      out.push("--exclude-dynamic-system-prompt-sections");
  }
  if (!hasSessionId) out.push("--session-id", freshId);
  return { args: out, nativeId: freshId };
}

/**
 * P-018 deterministic carry respawn: rotate the native Claude session id using
 * {@link mintRecycleArgs}, persist the bounded carry document as one owner-scoped
 * 0600 launch-context file, and layer it onto the fresh child. The original argv
 * is the input on every respawn, so generated carry flags never accumulate.
 */
function stripManagedCarrySection(text) {
  const source = String(text ?? "");
  // The managed section is always the final heading emitted below. Match the
  // optional separator as well so a legacy/stale snapshot is reduced to the
  // original prompt before it becomes the new immutable base.
  const marker =
    /(?:^|\r?\n)(?:---\r?\n)?## Managed carry checkpoint(?:\r?\n|$)/m.exec(
      source,
    );
  return marker ? source.slice(0, marker.index) : source;
}

/**
 * @param {string[]} [args]
 * @param {{ systemPromptAddendum?: string, ownerId?: string | null, mintId?: () => string,
 *          home?: string, agent?: string | null, personaFile?: string | null,
 *          codexHome?: string | null, model?: string | null }} [opts]
 */
export function mintCarryRespawnArgs(
  args = [],
  {
    systemPromptAddendum,
    ownerId = null,
    mintId = () => randomUUID(),
    home = homedir(),
    agent = "claude",
    personaFile = null,
    codexHome = null,
    model = null,
  } = {},
) {
  const text = String(systemPromptAddendum ?? "").trim();
  if (!text)
    throw new Error(
      "carry-respawn requires a non-empty system-prompt addendum",
    );
  const normalizedAgent = String(agent ?? "")
    .trim()
    .toLowerCase();
  // Claude rotates its native id and consumes the carry through
  // --append-system-prompt-file. Codex has no equivalent CLI flag; its system
  // base instructions use CODEX_HOME/AGENTS.md; the changing checkpoint is
  // delivered once in the provenance-marked first turn below. OMP has no managed
  // carry-respawn consumer.
  // `personaFile` (P-002) rides through to mintRecycleArgs, which owns the
  // --system-prompt-file swap — the copy-through it fixes lives there, so both
  // respawn modes (carry AND plain recycle) get the fresh render from one code
  // path. This function stays PURE: the network call that produces personaFile is
  // the caller's, where its failure can be caught and fail-softed.
  // `personaFile` (P-002) and `model` (WI-2141859) both ride through to
  // mintRecycleArgs, which owns the --system-prompt-file and --model swaps —
  // the copy-through they fix lives there, so both respawn modes (carry AND
  // plain recycle) get the fresh values from one code path. This function stays
  // PURE: the fs/network reads that produce them are the caller's, where their
  // failure can be caught and fail-softed.
  const codexSessionsRoot =
    normalizedAgent === "codex" && codexHome
      ? join(String(codexHome), "sessions")
      : null;
  const codexPredecessor = codexSessionsRoot
    ? latestCodexRollout(codexSessionsRoot)
    : null;
  const codexLineage =
    normalizedAgent === "codex"
      ? codexCarryLineageMarker(codexPredecessor?.id ?? null)
      : null;
  // The marker is part of the managed first turn, not merely AGENTS.md. That
  // makes the transition visible in Codex's transcript even when the owner is
  // looking at the successor TUI rather than the launcher/session browser.
  const effectiveText = codexLineage ? `${text}\n\n${codexLineage}` : text;
  const rotated = mintRecycleArgs(args, { mintId, agent, personaFile, model });
  const dir = join(home, ".papercusp", "launch-context");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sanitizeCarrySegment = (value) =>
    String(value ?? "")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 200);
  const key = sanitizeCarrySegment(ownerId || rotated.nativeId || "unknown");
  // WI-10002026: this file is the DELIVERY SLOT the successor reads BY PATH at
  // boot (--append-system-prompt-file below). Keying it on ownerId ALONE made it
  // a single mutable slot that every respawn of that owner overwrites in place,
  // so one cut's document and another cut's successor can meet — the reported
  // symptom is a successor handed the PREVIOUS generation's document, silently
  // discarding an intervening session's turns while the embedded recovery marker
  // still asserted complete:true. `rotated.nativeId` is freshly minted per
  // respawn (mintRecycleArgs above), so binding it into the NAME makes a cut's
  // document unreachable by any other cut's successor: the class is removed
  // structurally instead of detected after the fact. Aged renders are reaped by
  // runLaunchContextGc (mtime + live-render evidence, name-agnostic), so the
  // per-cut names do not accumulate.
  // Codex does not expose a pre-minted successor id. Use a private cut token
  // for the delivery filename so successive Codex cuts cannot overwrite one
  // another while Codex is creating its fresh rollout.
  const cutId = sanitizeCarrySegment(
    rotated.nativeId || (normalizedAgent === "codex" ? mintId() : null),
  );
  const launchContextPath = join(
    dir,
    cutId ? `carry-${key}-${cutId}.md` : `carry-${key || "unknown"}.md`,
  );
  // ATOMIC (tmp + rename) — matching the Codex branch below and the host's own
  // meta write (psu-pty-host.mjs, WI-3455). A plain in-place writeFileSync
  // TRUNCATES first, so a successor booting mid-write reads a truncated carry
  // document, which presents as a short-but-valid one rather than as a failure.
  const carryTmp = `${launchContextPath}.${process.pid}.carry.tmp`;
  writeFileSync(carryTmp, `${effectiveText}\n`, { mode: 0o600 });
  chmodSync(carryTmp, 0o600);
  renameSync(carryTmp, launchContextPath);
  chmodSync(launchContextPath, 0o600);

  const lineagePath =
    normalizedAgent === "codex"
      ? join(dir, `${basename(launchContextPath, ".md")}.lineage.json`)
      : null;
  if (lineagePath) {
    const lineageTmp = `${lineagePath}.${process.pid}.lineage.tmp`;
    writeFileSync(
      lineageTmp,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          ownerId: ownerId || null,
          predecessorSessionId: codexPredecessor?.id ?? null,
          predecessorPath: codexPredecessor?.path ?? null,
          successorMode: "fresh",
          carryPath: launchContextPath,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    chmodSync(lineageTmp, 0o600);
    renameSync(lineageTmp, lineagePath);
    chmodSync(lineagePath, 0o600);
  }

  if (normalizedAgent === "codex") {
    const targetHome = String(codexHome ?? "").trim();
    if (!targetHome) throw new Error("Codex carry-respawn requires CODEX_HOME");
    // A long-lived PTY host can outlive the per-session home repair/archiver.
    // The operator repair route restores the canonical prompt before minting.
    // Never turn an unavailable repair into a fresh thread with no SU rules.
    mkdirSync(targetHome, { recursive: true, mode: 0o700 });
    const agentsPath = join(targetHome, "AGENTS.md");
    const basePath = join(targetHome, ".papercusp-carry-base-AGENTS.md");

    // Snapshot the launch-time prompt ONCE, then replace (never accumulate) the
    // managed carry section on each successor. A fleet member can respawn many
    // times; appending to the previous AGENTS.md would grow context without
    // bound and replay stale checkpoints. Older homes may already have a
    // contaminated AGENTS.md (or base snapshot) from that accumulation bug, so
    // strip the managed tail before preserving either source as the base.
    const baseExists = existsSync(basePath);
    const baseSourcePath = baseExists ? basePath : agentsPath;
    const sourceBaseText = existsSync(baseSourcePath)
      ? readFileSync(baseSourcePath, "utf8")
      : "";
    const baseText = stripManagedCarrySection(sourceBaseText);
    if (!baseText.trim()) {
      throw new Error("Codex carry-respawn requires a restored non-empty AGENTS.md base");
    }
    if (!baseExists || baseText !== sourceBaseText) {
      writeFileSync(basePath, baseText, { mode: 0o600 });
      chmodSync(basePath, 0o600);
    }
    const nextAgents = [
      baseText.trimEnd(),
      "",
      "---",
      "## Managed carry checkpoint",
      "",
      // The host also sends carryText as the first turn. Embedding the full
      // checkpoint here duplicated it in model context. Keep an addressable
      // fallback only; the per-cut file and native delivery proof remain intact.
      "The full checkpoint is delivered in the first managed turn, not repeated here.",
      `If that turn is missing or incomplete, read this exact checkpoint file: ${launchContextPath}`,
      "",
    ].join("\n");
    const tmp = `${agentsPath}.${process.pid}.carry.tmp`;
    writeFileSync(tmp, nextAgents, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, agentsPath);
    chmodSync(agentsPath, 0o600);

    // A carry-respawn is a FRESH Codex thread. Drop the original launch's
    // positional kickoff and any resume/fork subcommand; preserving either
    // replays stale work or collides with the predecessor's active-writer lock.
    const strippedKickoff = stripKickoffPositional(args);
    const subcommandAt = strippedKickoff.findIndex(
      (arg) => arg === "resume" || arg === "fork",
    );
    // A native fork preserves the entire context window: it is a branching
    // operation, not compaction. Keep the predecessor archived and addressable
    // via the lineage marker/sidecar, but never feed it back into managed carry.
    // Explicit user resume/fork remains owned by resumeArgsFor, unchanged.
    const freshArgs = subcommandAt >= 0
      ? strippedKickoff.slice(0, subcommandAt)
      : strippedKickoff;
    return {
      args: freshArgs,
      nativeId: null,
      launchContextPath,
      codexAgentsPath: agentsPath,
      lineagePath,
      predecessorSessionId: codexPredecessor?.id ?? null,
      carryText: effectiveText,
    };
  }

  if (normalizedAgent !== "claude" || !rotated.nativeId) {
    throw new Error(
      "carry-respawn is supported only for Claude and Codex launches",
    );
  }
  return {
    args: [...rotated.args, "--append-system-prompt-file", launchContextPath],
    nativeId: rotated.nativeId,
    launchContextPath,
  };
}

/**
 * Does claude's OWN store hold a transcript for this session id? A tracked
 * adv row alone doesn't prove resumability: a launch that died before its
 * first persisted turn leaves the adv row behind with NO
 * `~/.claude/projects/<dir>/<id>.jsonl`, and `claude --resume <id>` then
 * fails "No conversation found". Pure-ish (reads FS); exported for tests.
 */
export function claudeStoreHasSession(
  id,
  { home = homedir(), configDir = null } = {},
) {
  return Boolean(claudeSessionTranscriptFile(id, { home, configDir }));
}

/** The transcript jsonl PATH for a claude session id (isolated configDir first —
 *  EI-155 — then the shared ~/.claude store), or null. Pure-ish (reads FS). */
export function claudeSessionTranscriptFile(
  id,
  { home = homedir(), configDir = null } = {},
) {
  if (!id) return null;
  // EI-155: an interactive session's transcript lives in its isolated configDir,
  // not the shared ~/.claude — check that first (when known) before the shared store.
  const roots = [configDir, join(home, ".claude")].filter(Boolean);
  for (const root of roots) {
    const projects = join(root, "projects");
    for (const d of safeReaddir(projects)) {
      if (!d.isDirectory()) continue;
      const f = join(projects, d.name, `${id}.jsonl`);
      if (existsSync(f)) return f;
    }
  }
  return null;
}

/**
 * Can this tracked session actually be RESUMED — does the agent's own store
 * hold a persisted transcript for it? An adv row is recorded at LAUNCH time
 * (bootstrap-su, before the agent's first turn), but an agent only persists
 * its transcript on the first message — so a launch that died at startup, or
 * a session closed at the prompt, leaves a permanent "ghost" row with nothing
 * to resume (`claude --resume` fails "No conversation found"; measured ~50%
 * of recent rows on the standing dev box, 2026-06-12). The resume picker
 * filters by this so it only offers sessions that can really be resumed.
 *
 * Verification is per-agent and deliberately errs toward KEEPING a row when
 * the store can't be checked by id:
 *   - claude + known sessionId → the EI-155 isolated config dir (else the
 *     shared ~/.claude) must hold `projects/<dir>/<sid>.jsonl`.
 *   - claude, no sessionId (pre-native-id rows) → resume falls back to
 *     `--continue` (most-recent-in-cwd) — not verifiable by id, keep.
 *   - codex + adv row id → the per-session CODEX_HOME must hold the rollout named by
 *     sessionId, or (when no sessionId was recorded) ANY rollout, since that resume runs
 *     `codex resume --last` inside that same isolated home. Without a row id there is no
 *     home to check — keep.
 *   - omp → the thread store isn't path-indexed here — keep.
 * Pure-ish (reads FS); `home` injectable for tests; exported for tests.
 */
export function sessionHasTranscript(session, { home = homedir() } = {}) {
  if (session.agent === "claude") {
    if (!session.sessionId) return true;
    const configDir =
      session.configDir ||
      (session.coordOwnerId
        ? sessionClaudeConfigDir(session.coordOwnerId, home)
        : null);
    return claudeStoreHasSession(session.sessionId, { home, configDir });
  }
  if (session.agent === "codex") {
    // No adv row id ⇒ no tracked home to look in ⇒ genuinely unverifiable, keep.
    if (session.id == null && !session.codexHome) return true;
    const sessionsRoot = trackedCodexSessionsRoot(session, home);
    // No recorded session_id is NOT unverifiable: resume runs `codex resume --last` against
    // this row's own isolated CODEX_HOME (resumeArgsFor + the CODEX_HOME pin in launchResume),
    // so "is there anything to resume" is exactly "does that home hold a rollout" — which we
    // can just look at. Keeping the blanket `return true` here filled the picker with launches
    // that die on selection (measured: over half of recent codex rows).
    if (!session.sessionId) return codexHomeHasAnyRollout(sessionsRoot);
    return Boolean(findCodexRollout(sessionsRoot, session.sessionId));
  }
  if (session.agent === "omp") {
    if (!session.ompThreadId) return true;
    return Boolean(sessionTranscriptFile(session, { home }));
  }
  return true;
}

/**
 * Whether a session is resumable for the `psu --resume` PICKER — an on-disk
 * transcript OR a DB session-archive (`session.hasArchive`, stamped by the
 * /adv/sessions/resumable endpoint). The archive-at-death lifecycle deletes an
 * ended session's on-disk transcript ~15s after end and keeps it only in the DB,
 * so an on-disk-only check (sessionHasTranscript) misclassifies every off-disk-
 * but-archived session as a permanent ghost and hides it (owner-hit 2026-07-13:
 * `psu --resume` reported "hiding N session(s) with no persisted transcript" after
 * sessions moved off disk to the DB). An archived pick is rematerialized to disk
 * on selection before resume. Exported for unit testing.
 */
export function sessionIsResumable(session, opts = {}) {
  return sessionHasTranscript(session, opts) || Boolean(session.hasArchive);
}

/**
 * The persisted transcript file for a resolved session (tracked or untracked),
 * or null: claude → `<store>/projects/<dir>/<sid>.jsonl` (isolated configDir
 * first, EI-155); codex → the rollout jsonl under the tracked per-session
 * CODEX_HOME, else the shared ~/.codex store (an untracked resume); omp → null
 * (its thread store isn't path-indexed here). Pure-ish (reads FS); `home`
 * injectable for tests; exported for tests.
 */
export function sessionTranscriptFile(session, { home = homedir() } = {}) {
  if (session.agent === "claude" && session.sessionId) {
    const configDir =
      session.configDir ||
      (session.coordOwnerId
        ? sessionClaudeConfigDir(session.coordOwnerId, home)
        : null);
    return claudeSessionTranscriptFile(session.sessionId, { home, configDir });
  }
  if (session.agent === "codex" && session.sessionId) {
    const roots = [];
    if (session.id != null) {
      const r = trackedCodexSessionsRoot(session, home);
      if (r) roots.push(r);
    }
    roots.push(join(home, ".codex", "sessions"));
    for (const root of roots) {
      const hit = findCodexRollout(root, session.sessionId);
      if (hit) return hit;
    }
  }
  if (session.agent === "omp" && session.ompThreadId) {
    const roots = [];
    if (session.id != null) {
      roots.push(
        join(
          home,
          ".papercusp",
          "su-omp-homes",
          `session-${session.id}`,
          "agent",
          "sessions",
        ),
      );
    }
    roots.push(join(home, ".omp", "agent", "sessions"));
    for (const root of roots) {
      const hit = findOmpTranscript(root, session.ompThreadId);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Restore the Papercusp MCP definitions referenced by a Claude transcript
 * before `--resume` opens it. A native ToolSearch result is stored as a
 * client-mangled `tool_reference`; a new CLI process otherwise starts with
 * only the current trimmed seed, and Claude rejects the replay before it can
 * call tools:find. Unknown/removed tool names are harmlessly ignored by the
 * server's allowlist filter and remain eligible for the poison detector.
 */
export function addClaudeResumeToolReferencesToEnv(session, env, { home = homedir() } = {}) {
  if (session?.agent !== "claude" || typeof env?.PAPERCUSP_TOOLS !== "string" || !env.PAPERCUSP_TOOLS.trim()) {
    return { transcriptPath: null, restored: 0, toolReferences: [] };
  }
  const transcriptPath = sessionTranscriptFile(session, { home });
  if (!transcriptPath) return { transcriptPath: null, restored: 0, toolReferences: [] };
  let analysis;
  try {
    analysis = analyzeClaudeResumeTranscript(readFileSync(transcriptPath, "utf8"));
  } catch {
    return { transcriptPath, restored: 0, toolReferences: [] };
  }
  if (analysis.toolReferences.length === 0) {
    return { transcriptPath, restored: 0, toolReferences: [] };
  }
  const before = new Set(env.PAPERCUSP_TOOLS.split(",").map((name) => name.trim().toLowerCase()).filter(Boolean));
  env.PAPERCUSP_TOOLS = appendClaudeToolReferencesToSeed(env.PAPERCUSP_TOOLS, analysis.toolReferences);
  const restored = analysis.toolReferences.filter((name) => !before.has(name.toLowerCase())).length;
  return { transcriptPath, restored, toolReferences: analysis.toolReferences };
}

/** How much of a transcript's tail lastActiveModelFor reads — the model appears
 *  on every assistant event (claude) / turn_context (codex), so a quarter-MB of
 *  tail always covers the latest turn without reading a multi-MB file. */
const LAST_MODEL_TAIL_BYTES = 256 * 1024;

/**
 * The model that was LAST ACTIVE in a session, read from its own transcript
 * (WI-3758: `psu --resume` shows it and offers to keep it). Tail-reads the
 * final ~256KB and scans lines newest-first:
 *   - claude: `{"type":"assistant","message":{"model":"…"}}` — the model that
 *     actually answered; `<synthetic>` (error/system events) is skipped.
 *   - codex: `{"type":"turn_context","payload":{"model":"…","effort":"…"}}`
 *     — stamped every turn (verified codex CLI 0.144.0; session_meta carries
 *     only model_provider). Return the complete model:effort selection so a
 *     carry or exact resume cannot silently reset the owner's reasoning level.
 *   - omp / no transcript / unreadable → null (callers degrade to "unknown").
 * Pure-ish (reads FS); `home` injectable for tests; exported for tests.
 */
export function lastActiveModelFor(session, { home = homedir() } = {}) {
  const file = sessionTranscriptFile(session, { home });
  if (!file) return null;
  let tail;
  try {
    const size = statSync(file).size;
    const want = Math.min(size, LAST_MODEL_TAIL_BYTES);
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(want);
      readSync(fd, buf, 0, want, size - want);
      tail = buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = tail.split("\n");
  // A truncated read starts mid-line — drop the partial first line so a stray
  // `"model":"…"` fragment can never half-parse into a wrong answer.
  if (tail.length === LAST_MODEL_TAIL_BYTES) lines.shift();
  const marker =
    session.agent === "codex"
      ? '"turn_context"'
      : session.agent === "omp"
        ? '"model_change"'
        : '"assistant"';
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes(marker) || !line.includes('"model"')) continue; // cheap prefilter
    try {
      const o = JSON.parse(line);
      // WI-2141859: a SUBAGENT turn (`isSidechain`) can answer on a different
      // model from the session's own, and it is never the answer to "what is
      // this session running" — for the resume picker OR for the respawn model
      // carry below. Claude stamps the flag on every record it writes; codex
      // and omp have no sidechains, so the guard is inert for them.
      if (o?.isSidechain === true) continue;
      const m =
        session.agent === "codex"
          ? o?.type === "turn_context"
            ? o?.payload?.model
            : null
          : session.agent === "omp"
            ? o?.type === "model_change"
              ? (o?.model ?? o?.payload?.model)
              : null
            : o?.type === "assistant"
              ? o?.message?.model
              : null;
      if (typeof m === "string" && m && m !== "<synthetic>") {
        if (session.agent === "codex") {
          const effort = o?.payload?.effort;
          if (typeof effort === "string" && RESPAWN_MODEL_EFFORT_RE.test(effort))
            return `${m}:${effort.toLowerCase()}`;
        }
        return m;
      }
    } catch {
      /* malformed / partial line — keep scanning */
    }
  }
  return null;
}

/** The effort levels a `<model>:<effort>` spec may carry. Kept local so the
 *  respawn-model helpers below stay dependency-free (this file is a standalone
 *  .mjs the CLI runs directly). */
const RESPAWN_MODEL_EFFORT_RE = /^(low|medium|high|xhigh|max)$/i;

/**
 * Split a model spec into the parts that mean different things across a
 * respawn: the model IDENTITY (`claude-opus-5`), and the EFFORT suffix.
 *
 * Identity drops the `[1m]`-style window marker as well as the effort, because
 * a transcript records the model that ANSWERED (`claude-opus-5`) while the
 * launch flag carries the decorated spec (`claude-opus-5[1m]:max`). Comparing
 * the raw strings would report a change on every respawn of an unchanged
 * session. Pure; exported for tests.
 */
export function splitRespawnModelSpec(spec) {
  let base = String(spec ?? "").trim();
  let effort = "";
  const c = base.lastIndexOf(":");
  if (c > 0 && RESPAWN_MODEL_EFFORT_RE.test(base.slice(c + 1))) {
    effort = base.slice(c + 1);
    base = base.slice(0, c);
  }
  return {
    id: base
      .replace(/\[[^\]]*\]/g, "")
      .trim()
      .toLowerCase(),
    effort,
  };
}

/** The Claude model FAMILY a spec belongs to, or null for a non-Claude /
 *  unrecognized id. Kept in the same vocabulary as DEFAULT_1M_FAMILY_RE. */
export function respawnModelFamily(id) {
  const m = /(haiku|sonnet|opus|fable)/i.exec(String(id ?? ""));
  return m ? m[1].toLowerCase() : null;
}

/**
 * WI-2141859: the model spec a successor should be launched with, given the
 * spec its predecessor's argv carried and the model that predecessor was
 * ACTUALLY answering on. Returns null for "keep the inherited spec".
 *
 * Null on every uncertain input — no inherited flag (we never ADD one; see
 * mintRecycleArgs), nothing detected, an unrecognizable detected id, or an
 * unchanged model and effort. A change is composed with the transcript's
 * effort when present (Codex stamps it on every turn); older transcripts and
 * Claude retain the inherited effort. normalizeModelSpec then re-adds the
 * `[1m]` window marker exactly as the resume path does, so an opus/fable/
 * sonnet-5 successor keeps its 1M window. Pure; exported for tests.
 *
 * "UNCHANGED" IS COMPARED AT FAMILY GRANULARITY, and that is the whole
 * conservatism of this function. The flag holds what the LAUNCH asked for
 * (`sonnet[1m]`, `claude-fable-5`) while the transcript holds what the CLI
 * RESOLVED it to (`claude-sonnet-5`, `claude-fable-5-1`) — so an exact-id
 * compare calls those a change and rewrites the flag, quietly converting an
 * alias pin ("latest sonnet") into a version pin, and a release pin into a
 * point-release pin. Neither is anything the owner did. Caught by a read-only
 * probe over the live fleet before this shipped: 4 running sessions carrying
 * `sonnet[1m]` would have been rewritten to `claude-sonnet-5[1m]`. Only a
 * FAMILY change (fable → opus) is an owner `/model` switch, which is the only
 * thing this exists to preserve. Two ids with no recognizable family (a
 * provider-qualified or local id) fall back to an exact compare.
 */
export function reconcileRespawnModelSpec(inheritedSpec, detectedModel) {
  const inherited = splitRespawnModelSpec(inheritedSpec);
  const detected = splitRespawnModelSpec(detectedModel);
  if (!inherited.id || !detected.id) return null;
  // A transcript can hold junk (`<synthetic>` is already filtered upstream, but
  // a future marker would not be). Only a plausible model id may re-pin a live
  // session's model; anything else fails soft to the inherited spec.
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(detected.id)) return null;
  const inheritedFamily = respawnModelFamily(inherited.id);
  const detectedFamily = respawnModelFamily(detected.id);
  const unchanged =
    inheritedFamily && detectedFamily
      ? inheritedFamily === detectedFamily
      : detected.id === inherited.id;
  const effortChanged =
    detected.effort && detected.effort.toLowerCase() !== inherited.effort.toLowerCase();
  if (unchanged && !effortChanged) return null;
  return composeResumeModelSpec(
    detected.id,
    detected.effort || inherited.effort,
  );
}

/** The `--model` spec an argv carries, or null. Pure; the read half of the
 *  respawn model carry (mintRecycleArgs owns the write half). */
export function modelSpecFromRecycleArgv(args = []) {
  const raw = args.map((a) => String(a ?? ""));
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "--model" || raw[i] === "-m") {
      const model = (raw[i + 1] ?? "").trim();
      if (!model) return null;
      if (raw[i] !== "-m") return model;
      const effort = raw.find((value, index) =>
        raw[index - 1] === "-c" && /^model_reasoning_effort=/.test(value));
      const level = effort?.match(/^model_reasoning_effort=["']?(low|medium|high|xhigh|max)["']?$/)?.[1];
      return level ? `${model}:${level}` : model;
    }
    if (raw[i].startsWith("--model=")) return raw[i].slice(8).trim() || null;
  }
  return null;
}

/**
 * WI-2141859: detect the model a live session is CURRENTLY running, for the
 * respawn about to replace it — the owner-directed semantics (2026-09-02):
 * "at the time our system ends their session and restarts it … check what the
 * model is currently set at internally (it should pick up any user changes like
 * ones they might do by /model)".
 *
 * The session's OWN transcript is that check: `lastActiveModelFor` reads the
 * model that answered the most recent turn, which is the post-`/model` model
 * whenever the owner switched mid-session. Reads FS; every failure path returns
 * null so a respawn keeps the inherited spec rather than being blocked or
 * re-pinned on a guess.
 */
/**
 * @param {string[]} [args]
 * @param {{ ownerId?: string | null, agent?: string | null, home?: string,
 *          configDir?: string | null, codexHome?: string | null,
 *          advSessionId?: string | number | null, modelSource?: string | null,
 *          readLatestCodexRollout?: (root: string) => {id: string} | null,
 *          readLastActiveModel?: (session: { agent: string, sessionId: string, coordOwnerId?: string | null, configDir?: string },
 *                                 opts?: { home?: string }) => string | null }} [opts]
 * @returns {string | null}
 */
export function detectRespawnModelSpec(
  args = [],
  {
    ownerId = null,
    agent = null,
    home = homedir(),
    configDir = null,
    codexHome = null,
    advSessionId = null,
    modelSource = null,
    readLatestCodexRollout = latestCodexRollout,
    readLastActiveModel = lastActiveModelFor,
  } = {},
) {
  // An empty/absent agent means "the claude argv shape" — `--model` and
  // `--session-id` in this position are claude flags, and the host passes
  // env.PAPERCUSP_AGENT which is unset on some claude launches. An explicitly
  // non-claude agent is left alone: codex/omp compose model flags differently.
  const normalized = String(agent ?? "")
    .trim()
    .toLowerCase();
  const inherited = modelSpecFromRecycleArgv(args);
  if (!inherited) return null; // no flag to replace — never ADD one
  if (normalized === "codex") {
    const latest = codexHome
      ? readLatestCodexRollout(join(codexHome, "sessions"))
      : null;
    let active = null;
    if (latest?.id) {
      try {
        active = readLastActiveModel(
          { agent: "codex", id: advSessionId, sessionId: latest.id },
          { home },
        );
      } catch {
        // A missing or incomplete rollout must not block the carry.
      }
    }
    const switched = reconcileRespawnModelSpec(inherited, active);
    if (switched) {
      try {
        return resolveCodexModelSelection(switched, { source: "inherited" }).model;
      } catch {
        return null;
      }
    }
    if (modelSource === "configured-default") {
      try {
        const text = readFileSync(join(codexHome, "config.toml"), "utf8").split(/^\s*\[/m, 1)[0];
        const model = /^model\s*=\s*"([^"]+)"\s*$/m.exec(text)?.[1];
        const effort = /^model_reasoning_effort\s*=\s*"(low|medium|high|xhigh|max)"\s*$/m.exec(text)?.[1];
        const configured = model ? resolveCodexModelSelection(
          `${model}${effort ? `:${effort}` : ""}`, { source: "inherited" },
        ).model : null;
        return configured && configured !== inherited ? configured : null;
      } catch {
        return null;
      }
    }
    return null;
  }
  if (normalized && normalized !== "claude") return null;
  const sessionId = nativeSessionIdFromLaunchArgs(args);
  if (!sessionId) return null;
  try {
    const detected = readLastActiveModel(
      {
        agent: "claude",
        sessionId,
        coordOwnerId: ownerId,
        ...(configDir ? { configDir } : {}),
      },
      { home },
    );
    return reconcileRespawnModelSpec(inherited, detected);
  } catch {
    return null; // an unreadable transcript only costs the refresh
  }
}

/** Map a plan picker value to the bootstrap-su `plan_slug` (NO_PLAN → null). Pure. */
export function planValue(picked) {
  return picked === NO_PLAN || picked == null || picked === "" ? null : picked;
}

/**
 * An interactive SU omp session path-discovers `<cwd>/.mcp.json` (omp's
 * `mcp.discoveryMode`; claude auto-loads it too). A ROLE session (console-launch
 * `doSpawn` / a fleet role) writes a SIGNED role-scoped `.mcp.json` there and never
 * removes it — it spawns a DETACHED, unref'd terminal with no exit hook — so a later
 * SU launch in the same cwd inherits the stale role server (a per-role MCP host URL,
 * e.g. :9071) and hangs ~30s on "papercusp timed out". An SU session needs only the
 * USER-LEVEL papercusp-su (or, for omp, the per-session RELOCATED copy of it — see
 * writeOmpSessionConfigDir), never a co-located `.mcp.json`, so PARK ANY existing one
 * before launch — unconditionally, not just role-scoped ones.
 *
 * EI-10388 (2026-07-12): the prior version only parked a URL matching `role=` AND
 * NOT `superuser=1` — on the (false) assumption that any superuser-scoped project
 * file must already BE the current papercusp-su server, so it's harmless to leave.
 * That let a STALE superuser-scoped file with a DIFFERENT server name ("papercusp",
 * not "papercusp-su") and NO `tools=` seed slip through unparked. OMP then discovered
 * it ALONGSIDE the correctly-seeded per-session "papercusp-su" server and merged
 * BOTH tool catalogs — the seeded ~39-tool spine plus the stale server's full
 * ~700+-tool catalog (~778 total, hard 400 on a small-context local model:
 * `mcp_tools:papercusp` (unfiltered) + `mcp_tools:papercusp-su` (39, correct) both
 * present in OMP's own tool cache; confirmed server-side filtering itself works
 * correctly via a direct probe of the exact seeded URL). A co-located `.mcp.json`
 * is NEVER wanted for an SU launch regardless of its shape — park it, full stop.
 *
 * No restore: role launchers recreate `.mcp.json` fresh on their next launch (they
 * back up any existing one first), so parking is safe. Returns the parked path, or
 * null when nothing was parked. Side-effects fs only; exported for tests.
 */
export function parkRoleScopedMcpJson(cwd) {
  if (!cwd) return null;
  const p = join(cwd, ".mcp.json");
  if (!existsSync(p)) return null;
  const parked = join(cwd, ".mcp.json.su-parked");
  try {
    if (existsSync(parked)) rmSync(parked, { force: true }); // overwrite a stale prior park
    renameSync(p, parked);
    return parked;
  } catch {
    return null;
  }
}

/**
 * P-004 (omp-psu-interactive-parity-hardening-2026-06-29): an SU omp session loads
 * `~/.omp/agent/config.yml` `modelRoles.default`. When that's a LOCAL ollama model
 * (e.g. `ollama/ornith:fast` — 32k + text-only), the very first turn overflows the SU
 * toolset (~33k > 32k) BEFORE the user can `/model` to a bigger one — the exact cryptic
 * `exceeds the available context size (32768)` failure the owner hit. Return a one-line
 * advisory (else null) so the launcher warns UP FRONT. The owner's default is deliberately
 * left untouched (their "use my default" steer); this only surfaces the gotcha. Reads
 * config.yml; side-effects fs read only; exported for tests.
 */
// weak-model-tool-tier-2026-07-01: the UNIVERSAL core MCP spine handed to a weak/local
// OMP model up-front (bootstrap + coordination + work + discovery — ~19 tools) instead of
// the full ~580-tool superuser surface it cannot wield. The server honors `?tools=` as a
// LISTING allowlist only, so everything omitted stays REACHABLE via `tools:find` (intent
// search) → OMP's native `search_tool_bm25` activation. MIRROR of the orchestrator's
// CORE_MCP_TOOL_NAMES (libs/papercusp/packages/orchestrator/src/invoke.ts) — kept in
// lockstep by the drift guard in apps/operator/lib/psu-launcher.test.ts (psu-launcher.mjs
// is a plain node script with no TS imports, so the list is inlined, not imported).
export const OMP_CORE_MCP_TOOL_NAMES = [
  // (coord:ack cut in the 2026-07-05 demand-evidence rebalance, in lockstep with the
  // canonical list — 47 calls/7d; a coord:send reply covers it. coord:ask cut
  // 2026-07-19 by the same bar — 16 calls/14d seeded, zero fallback reaches.)
  "coord:orient",
  "coord:declare-intent",
  "coord:inbox",
  "coord:send",
  "coord:glance",
  // Added 2026-09-02 in lockstep with the canonical list (WI-2142095 / P-011): until
  // then coord:dispatch sat only in the retired mug tier, so the P-013 falsifier would
  // have read absence as rejection. Order matters — the drift guard compares this list
  // to CORE_MCP_TOOL_NAMES element-by-element.
  "coord:dispatch",
  // plans:new (P-002, cross-platform-hardening-and-agent-ergonomics-2026-07-05) authors a
  // whole plan in ONE call (P-001 `body` arg) so an agent never hunts for a create verb —
  // the Mac-app plan-authoring fumble (owner: "plans should be a core trimmed tool").
  // plans:set-now: the "## Now" narration duty (467 fallback + 807 direct calls/7d).
  "plans:new",
  "plans:get",
  "plans:set-status",
  "plans:items",
  "plans:set-now",
  // work_items:create: #1 gap of the 2026-07-05 rebalance (608 fallback + 1,354 direct
  // across 5 roles/7d) — the spine had claim/complete but not the verb that CREATES one.
  "work_items:list",
  "work_items:create",
  "work_items:claim",
  // EI-6770/EI-8588: self-pull (claim_next) + read (get) + finish (complete) +
  // release — the rest of the canonical worker loop; their absence caused "tool
  // not available" self-halts and stranded claim handoffs.
  // EI-10946: work_items:comment + work_items:update RE-ADDED to the canonical CORE
  // (the 2026-07-05 cut's premise — "set_state + comment cover it" — was false: comment
  // was never seeded either, so an agent could CREATE/close an item but had no seeded way
  // to correct or annotate one, and abused work_items:checkpoint as an erratum channel).
  // Mirror them here or the lockstep drift guard fails.
  "work_items:claim_next",
  "work_items:get",
  "work_items:complete",
  "work_items:release",
  "work_items:set_state",
  "work_items:comment",
  "work_items:update",
  // scheduler:get_next: the fleet-member feed loop (claim-spec pull, 732 fallback
  // reaches/7d) — a drain member hits this every iteration.
  "scheduler:get_next",
  // locks:*_granular are NOT in the weak-model spine: file-edit locks are acquired
  // AUTOMATICALLY by the omp `-e` coord extension on every Edit/Write, so a worker
  // never needs the manual lock tools. Advertising them up-front just invited misuse
  // — weak models treated them as an operation-mutex (locking the plan file to
  // "serialize fleet creation", churning acquire/release, losing track of lock_ids).
  // They stay REACHABLE via tools:find for the rare genuine multi-file cross-turn hold.
  // (2026-07-05: the canonical list dropped them too — this is no longer a divergence.)
  "docs:search",
  "memory:search",
  "memory:remember",
  // improvements:capture: the universal "file what you notice" reflex (227 fallback +
  // 1,128 direct calls across 3 roles/7d).
  "improvements:capture",
  // 2026-07-03 canonical-core catch-up (drift guard): batching (code:run + recipes),
  // standing facts, and the loop/work-item checkpoint verbs joined the canonical
  // CORE_MCP_TOOL_NAMES — mirror them here or the lockstep test fails.
  // (recipes:run cut 2026-07-05 — 78 calls/7d, one role; recipes:search returns the
  // run pointer and the run routes via tools:invoke.)
  "code:run",
  "recipes:search",
  // dev:pg_query added 2026-07-19: the loudest unmet need in the fallback-reach ledger
  // (1,132 tools:invoke reaches/14d, 2.4× the next entry) + the storage-policy-mandated
  // read path for PG-canonical state. Mirror of the canonical CORE addition.
  "dev:pg_query",
  // EI-10946/EI-10947: facts:retract is the ONLY exit from a standing fact (folded VERBATIM
  // into every future orient as binding context) — seeding assert+list without retract armed
  // the stale-fact trap with no disarm. Mirror the canonical CORE order (retract after list).
  "facts:assert",
  "facts:list",
  "facts:retract",
  // loop:arm joins loop:checkpoint (2026-07-05): checkpoint was in the spine while the
  // verb that CREATES the loop was not (253 fallback reaches/7d).
  // loop:status + loop:end join (2026-07-07, EI-8597 canonical-core catch-up): the
  // wind-down half of the loop lifecycle — discovery can miss them, so a seeded worker
  // must be able to inspect/stop its own loop without depending on tools:find.
  "work_items:checkpoint",
  "loop:arm",
  "loop:checkpoint",
  "loop:status",
  "loop:end",
  // checkpoint:await is the shared release-gate sleep primitive named by
  // checkpoint-run/trace. Seed it for trimmed Codex sessions because tools:find
  // cannot guarantee a same-turn direct-wrapper refresh.
  "checkpoint:await",
  // Event-wait lifecycle (fleet-member-dx-improvements-2026-07-10 P-008): keep the
  // seeded OMP spine aligned with the canonical event sleep/catalog/cancel verbs.
  // (events:emit cut 2026-07-19 in lockstep — 29 calls/14d seeded, no reach demand;
  // members await, leaders/the system emit; reachable via tools:find/invoke.)
  "events:await",
  "events:catalog",
  // EI-21345492095209440: events:cancel is the correction half of the seeded
  // events:await lifecycle; a trimmed client must be able to retract its own wait
  // without a tools:find/tools:invoke round-trip.
  "events:cancel",
  // EI-6770: without this, an agent nearing its compaction limit self-halts instead of
  // compacting cleanly ("no compaction tool available"), losing in-flight work.
  "session:request-compaction",
  // fleet:launch-on-plan mirrors the canonical CORE: every su routing gate offers the
  // fleet route, so every trimmed client needs the verb that executes it. This used to
  // be an OMP-only exception; that stranded Codex/Claude behind the same required gate.
  "fleet:launch-on-plan",
  // search:fulltext joins the canonical CORE (EI-18745029375690371, 2026-07-27): it was
  // seeded asymmetrically vs docs:search (docs:search in the spine, fulltext not) despite
  // root CLAUDE.md recommending both for prose recall — 22 tools:invoke fallback
  // reaches/11 distinct callers in 14d vs docs:search's 9. Mirror the canonical CORE order
  // (right before the discovery pair). search:semantic stays OUT here too — lower
  // demand-evidence (7 reaches/7 callers/14d), reachable via tools:find/invoke.
  "search:fulltext",
  // MIRROR of the canonical orchestrator CORE_MCP_TOOL_NAMES addition (same position, same
  // order — the lockstep drift guard in psu-launcher.test.ts compares the arrays EXACTLY).
  // Admitted by P-006 (D-006) and raising NO cap: the array measured 42 against a <=43
  // ratchet, so the slot already existed. 622 fallback-reaches/65 callers @4,250 B =
  // 149.9 reaches/KB, the highest demand in the ledger, and the verb root CLAUDE.md
  // MANDATES for recording a cross-lane ruling. Full rationale lives beside the canonical
  // list in libs/papercusp/packages/orchestrator/src/invoke.ts.
  "plans:add-decision",
  // MIRROR of the canonical CORE admission (EI-21503656260697108): the shared spine
  // now holds 45 entries, matching the canonical list and its <=45 ratchet.
  "work_items:claimable",
  // MIRROR of the canonical CORE admission (WI-37550, 2026-09-05), ratchet 47->48 — same
  // position, same order; the lockstep drift guard in psu-launcher.test.ts compares the
  // arrays EXACTLY. mode:set is no longer a Claude-only extra: OMP/codex reach it directly.
  // Re-measured 14d demand 656 fallback-reaches/443 callers @3,028 B = 216.6 reach/KB, the
  // highest admission-time reach/KB in the changelog, and the su playbook MANDATES the call
  // on every AUTO/DRAIN/IDEATE flip. Full rationale — including the measured finding that
  // the wire seed is already over D-001's 256 KB ceiling — lives beside the canonical list
  // in libs/papercusp/packages/orchestrator/src/invoke.ts.
  "mode:set",
  "tools:find",
  "tools:invoke",
];

/* ── DERIVED DELIVERY (deterministic-tool-definition-delivery-2026-09-21) ─────
 *
 * WHAT CHANGED, and why the hand lists below are no longer the source.
 * Every seed in this file used to be a hand-maintained array whose entries were
 * each individually justified — and that is exactly how the Claude seed reached
 * 432,714 B one defensible append at a time before anything measured the
 * aggregate. The lists are METADATA DESCRIBING CODE (which tools exist, how
 * much each costs), which the repo's own derived-truth ladder says to DERIVE
 * rather than curate.
 *
 * So the decision is now a function: `resolveToolDelivery()` ranks the live
 * catalog by measured VALUE DENSITY (distinct callers ÷ bytes-at-that-tier,
 * from a committed demand snapshot) against a byte budget, admits every floor
 * tool, and returns full / compact / deferred per tool. `npm run
 * gen:tool-delivery` freezes that result into the artifact imported above, and
 * `gen:tool-delivery:check` reds the gate if the artifact drifts from its
 * inputs.
 *
 * TWO CORRECTIONS THIS ENCODES, both of which a name count cannot express:
 *   - DEMAND IS DISTINCT CALLERS, NOT CALL COUNT. Call count is dominated by
 *     machinery (`activity:report` alone is ~233 calls per caller — a loop), so
 *     ranking by calls buys seats for the busiest robot rather than the most
 *     widely-needed verb.
 *   - THE DECISION IS NOT BINARY. A tool used to be either full-schema or
 *     invisible, which is why the 2026-09-15 cut had to drop seven high-demand
 *     heavies outright. COMPACT is the tier that lets demand and cost combine
 *     instead of compete.
 */

/** Advertised names for an agent kind, straight from the generated artifact.
 *  Throws rather than falling back: a silently-empty seed is indistinguishable
 *  from a deliberate trim, and would strand every session's whole catalog. */
function deliveryAdvertisedNames(agentKind) {
  const entry = TOOL_DELIVERY_BY_AGENT_KIND[agentKind];
  if (!entry || !Array.isArray(entry.advertised) || entry.advertised.length === 0) {
    throw new Error(
      `psu: tool-delivery.generated.mjs has no advertised set for agentKind='${agentKind}'. ` +
        "Run `npm run gen:tool-delivery` — an empty seed would advertise NO tools at all, " +
        "which reads exactly like a deliberate minimal seed.",
    );
  }
  return [...entry.advertised];
}

/** The subset of {@link deliveryAdvertisedNames} that ships at COMPACT tier.
 *  An empty result is legitimate (a budget that fits everything at FULL), so
 *  unlike the advertised set this does not throw. */
function deliveryCompactNames(agentKind) {
  const entry = TOOL_DELIVERY_BY_AGENT_KIND[agentKind];
  const tiers = entry?.tiers ?? {};
  return Object.keys(tiers)
    .filter((n) => tiers[n] === "compact")
    .sort();
}

/** Names excluded by PAPERCUSP_OMP_TOOLS_EXCLUDE (comma-separated). Escape hatch for a
 *  seeded tool the target operator currently serves BROKEN — e.g. a schema Ollama's parser
 *  400s on until a server fix deploys (P-030: work_items:update's unconstrained
 *  status/state on the release host). An excluded tool stays CALLABLE via tools:invoke;
 *  only its up-front advertisement is dropped. */
function ompExcludedToolNames(env) {
  return String(env.PAPERCUSP_OMP_TOOLS_EXCLUDE || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The OMP/codex advertised seed — DERIVED, from the same policy and the same generated
 *  artifact as {@link claudeSeedToolNames} (D-005, owner directive: "unify them").
 *
 *  This used to return the hand-maintained {@link OMP_CORE_MCP_TOOL_NAMES} literal, and
 *  the two seeds were separate lists maintained by separate arguments — which is why the
 *  drift guard had to assert the Claude extras stayed DISJOINT from this spine. They are
 *  no longer two lists: `resolveToolDelivery()` ranks the SAME catalog against the SAME
 *  budget for every agent kind, so `omp`, `codex` and `claude` come out byte-identical by
 *  construction rather than by a rule someone has to keep enforcing. Disjointness is now
 *  not merely unenforced but FALSE — and correctly so.
 *
 *  The literal survives as the historical PAPERCUSP_CLAUDE_FULL_SEED revert target, which
 *  is the only remaining reason it is still in this file. Exported for tests. */
export function ompCoreToolNames(env = process.env) {
  const excluded = ompExcludedToolNames(env);
  const advertised = deliveryAdvertisedNames("omp");
  if (!excluded.length) return advertised;
  return advertised.filter((n) => !excluded.includes(n));
}

/** The COMPACT-tier half of {@link ompCoreToolNames} — the `?tools_compact=` axis for an
 *  OMP session, the exact mirror of {@link claudeCompactToolNames}. An excluded tool must
 *  not be named as compact either: a name that is not advertised has no tier. */
export function ompCompactToolNames(env = process.env) {
  const advertised = new Set(ompCoreToolNames(env));
  return deliveryCompactNames("omp").filter((n) => advertised.has(n));
}

/** EI-9011 (fleet-retro-hardening-2026-07-10 P-002): the CLAUDE seed = the shared core
 *  spine + the manual lock verbs. locks:* stay OUT of the weak-model OMP spine (misuse
 *  evidence — see the spine comment above), but belong IN the claude seed: the CC
 *  PreToolUse lock-block hook fires ONLY in Claude sessions and its refusal names
 *  locks:acquire {wake_on_grant:true} as the sanctioned queue+sleep path, yet Claude's
 *  native ToolSearch indexes ONLY the advertised subset — an unseeded name reads as
 *  "doesn't exist" (the EI-9011 poll-degradation). Exported for tests.
 *
 *  WI-37534 (owner-reported 2026-08-09) extends the same principle from the lock hook to
 *  the rest of the CLAUDE-ONLY mandates. These live here rather than in the shared spine
 *  on purpose: a weak local OMP model has no use for a state plane or a background-job
 *  runner, and the drift guard asserts this list stays DISJOINT from OMP_CORE.
 *  Demand evidence (tool_invocations, tools:invoke fallback reaches / distinct callers,
 *  14d, papercusp-workspace) against the list's own admit precedent — search:fulltext was
 *  admitted at 22/11, coord:ask CUT at 16 and events:emit at 29:
 *    state:read              68 / 31   root CLAUDE.md mandates RE-READING any volatile
 *                                      value (gate verdict, deploy sha, queue depth)
 *                                      instead of transcribing it; unreachable, so the
 *                                      transcribe-a-stale-number bug it exists to kill
 *                                      stayed alive.
 *    capability:bash        111 / 29   the long-jobs rule routes every >1-2min job here
 *                                      (recoverable log + real child exit code).
 *    capability:bash_output 119 / 34   its INSEPARABLE pair — seeding the launcher
 *                                      without the reader strands every background job,
 *                                      which is why its reach count is the HIGHER of the
 *                                      two (agents got a bash_id they could not read).
 *  Previously filed independently and left unfixed: EI-19500729376783421 (capability:bash
 *  unreachable, so agents fall back to native backgrounding — whose completion
 *  notification root CLAUDE.md separately calls untrustworthy). */
/*  P-002 of psu-seed-prompt-mandate-alignment-2026-08-09. Same principle again, now
 *  applied against a MEASURED cost rather than demand alone (plan D-001): seed cost is
 *  the tools/list WIRE payload, and it is dominated by argSchema, not by the
 *  description/guidance that promptWeight() governs. Admission metric is therefore
 *  reach-per-KB, and every name below was measured before being admitted:
 *    dev:pipeline_position  474/88  1,919 B  252.9 reach/KB  "is my change live" is ONE
 *                                            call (root CLAUDE.md); the highest
 *                                            distinct-caller count of ANY unseeded tool.
 *    testing:run            428/57  2,455 B  178.5  bash-routing table; previously filed
 *                                            unfixed as EI-19321552629556165.
 *    dev:restart            142/39  1,328 B  109.5  two-port model — the ONLY sanctioned
 *                                            way to restart :3170 (a raw systemctl was
 *                                            firing every ~5-6min uncoordinated, WI-4221).
 *    sessions:search        129/47  2,305 B   57.3  the compaction strategy's self-recall
 *                                            path; a successor that cannot call it
 *                                            re-derives instead of retrieving.
 *    build:typecheck        174/49  3,141 B   56.7  bash-routing table; refuses the
 *                                            zero-file `tsc -p .` run that reads as clean.
 *    coord:presence         117/48  3,331 B   36.0  liveness/wake rules — sessionState is
 *                                            the verdict a wake decision depends on.
 *  Subtotal +14,479 B (~3.6K tokens), seed 190.9 -> 205.4 KB against a 256 KB ceiling.
 *  MEASURED AND DEFERRED (below the value line, listed so the next audit need not
 *  re-derive): db:migrate 43.7, plans:add-item 28.0, work_items:link 24.1,
 *  checkpoint:await 20.0, plans:list 12.9. release:checkpoint-run scored 57.5 and is a
 *  genuine near-miss, held back only to keep this tranche to the plan's stated scope. */
export const CLAUDE_SEED_EXTRA_TOOL_NAMES = [
  "locks:acquire",
  "locks:release",
  "locks:list",
  "state:read",
  "capability:bash",
  "capability:bash_output",
  "dev:pipeline_position",
  "testing:run",
  // sql-escape-tool-routing-2026-08-12: the generated routing table promotes
  // these read-side tools, so Claude's native ToolSearch must see them in its
  // seed. Keep them Claude-only: the shared OMP spine is capped at 43, while
  // these are high-value operator reads (db:migrations: 153 calls/64 agents;
  // testing:runs: 288 calls/40 agents; issues:list: 686 calls/83 agents).
  "db:migrations",
  "issues:list",
  "testing:runs",
  "routines:list",
  "dev:restart",
  "sessions:search",
  "build:typecheck",
  "coord:presence",
  // GAP CLOSED 2026-09-05 (WI-37550). This list used to carry the P-003 trio of cross-role
  // verbs rehomed here after overshooting the shared spine's ratchet. All three have since
  // been promoted into the shared spine proper and NONE is listed here any more — OMP/codex
  // reach all of them directly: plans:add-decision by P-006 (D-006), work_items:claimable by
  // EI-21503656260697108 (ratchet 44->45), and mode:set by WI-37550 (ratchet 47->48), which
  // is the deliberate wire-byte budget decision D-001 asked for rather than a quiet append.
  // Do not re-add any of the three here: "every Claude-only extra stays OUT of the
  // weak-model OMP spine" (psu-launcher.test.ts) fails on a name that is in both lists.
];
/** EI-23319364088969722 — CLAUDE'S OWN MINIMAL SEED. Read this before adding a name.
 *
 *  WHY THIS LIST EXISTS AT ALL. Until 2026-09-15 the Claude seed was DERIVED from the
 *  weak-model spine: `ompCoreToolNames()` (48) + `CLAUDE_SEED_EXTRA_TOOL_NAMES` (16) = 64.
 *  That is backwards, and measurably expensive. The spine is large BECAUSE a weak/local
 *  OMP model cannot reliably drive `tools:invoke` and so needs its verbs up-front; Claude
 *  is the model BEST able to drive it, and was receiving the LARGEST seed.
 *
 *  THE COST IT WAS PAYING. Claude's native schema DEFERRAL is conditional on ToolSearch
 *  EXISTING (verified both ways on a raw `claude -p` path varying only that flag — see
 *  NATIVE_TOOL_SEARCH_DENY_FLAG: ToolSearch ALLOWED -> 0 papercusp tools inline, DENIED ->
 *  63 inline). psu denies ToolSearch by owner directive (one call measured +67,045 tokens
 *  bypassing applyResultDoor), so deferral is structurally unavailable and EVERY advertised
 *  tool ships its FULL argSchema on EVERY turn. Measured 2026-09-15: the tool block was
 *  461,966 B of an 807,630 B first turn (57.2%) — i.e. essentially the whole 151K -> 317K
 *  baseline regression. ADVERTISE-LESS IS THEREFORE THE ONLY REMAINING LEVER.
 *
 *  MEASURED (live `tools/list`, ctx_tier=trimmed, this build): old 64-name seed = 432,714 B;
 *  this 31-name seed = 113,588 B. -319,126 B (-73.7%), ~-116K tokens off every turn.
 *  The cut is dominated by seven heavies the routing table never promotes:
 *  work_items:complete 44,060 · coord:send 39,254 · work_items:checkpoint 24,597 ·
 *  fleet:launch-on-plan 22,561 · loop:checkpoint 21,033 · improvements:capture 20,977 ·
 *  facts:assert 15,359 = 187,841 B for SEVEN names.
 *
 *  WHY DROPPING THEM IS SAFE — the thing that makes this different from the EI-9011 /
 *  WI-37534 cuts that hurt. Those failed because native ToolSearch indexes ONLY the
 *  advertised subset, so an unseeded name answered "no matching deferred tools found",
 *  which reads as "this tool does not exist". With ToolSearch DENIED that mechanism is not
 *  in play at all: papercusp's OWN `tools:find` searches the FULL ~900-tool catalog and
 *  ACTIVATES matches into the live list, and `tools:invoke` dispatches any catalog tool by
 *  name, gated identically to a direct call. Root CLAUDE.md states this explicitly for
 *  agents. So the seed is a LATENCY budget (one round-trip to reach a tail tool), not a
 *  capability boundary — and `tools:find` + `tools:invoke` cost 2,873 B combined, which is
 *  why they are the one non-negotiable entry below.
 *
 *  ADMISSION RULE — every name here traces to one of four evidence tiers, and a new one
 *  needs its tier plus its measured bytes. Blanket-seeding is what this list exists to stop.
 *    (1) REACHABILITY FLOOR — without these the whole cut strands the catalog.
 *    (2) ROUTING-TABLE MANDATE — promoted by the generated bash->tool table, so
 *        `seed-mandate-coverage` FAILS if it is neither seeded nor evidence-exempt.
 *    (3) SILENT-HALT LIFECYCLE — absence does not degrade, it HALTS or strands state
 *        (EI-6770: a session without session:request-compaction self-halts at its limit
 *        rather than compacting; an undeclared lane is invisible, so work gets double-placed).
 *    (4) PROSE MANDATE — required by documentation the agent must follow but NOT covered by
 *        the machine-readable guard (that guard's own SCOPE note lists these), so nothing
 *        would catch their removal. Seeded by hand under P-002/P-003 and kept here.
 *  Deliberately OUT, reachable via tools:find/tools:invoke: every heavy above, plus the
 *  plans:* / events:* / work_items:create|update|set_state|complete families. */
export const CLAUDE_MINIMAL_SEED_TOOL_NAMES = [
  // (1) REACHABILITY FLOOR — 2,873 B buys the other ~870 tools. Never remove.
  "tools:find", // 1,936 B
  "tools:invoke", // 937 B
  // (2) ROUTING-TABLE MANDATES (54,396 B) — the promoted set, minus the five entries that
  // carry a measured exemption in MANDATE_SEED_EXEMPT. Removing one turns the guard red.
  "build:typecheck",
  "coord:orient",
  "db:migrations",
  "dev:pg_query",
  "issues:list",
  "routines:list",
  "testing:run",
  "testing:runs",
  "work_items:get",
  "work_items:list",
  // (3) SILENT-HALT LIFECYCLE (18,072 B) — bootstrap, lane, wake, and the clean exit.
  "session:request-compaction", // EI-6770: without it a session self-halts at its limit.
  "loop:status", // the su rule: VERIFY a wake is armed before ending a turn.
  "coord:declare-intent",
  "coord:inbox",
  "work_items:claim",
  "scheduler:get_next", // a drain member hits this every iteration.
  // (4) PROSE MANDATES (31,532 B) — documented duties the machine-readable guard cannot see.
  "state:read", // root CLAUDE.md: RE-READ a volatile value, never transcribe it. 1,467 B.
  "sessions:search", // the compaction strategy's self-recall path.
  "mode:set", // the su persona mandates the call on every AUTO/DRAIN/IDEATE flip.
  "work_items:claimable", // the storage-policy table's "what is claimable" answer.
  "dev:restart", // two-port model: the ONLY sanctioned way to restart :3170.
  "dev:pipeline_position", // root CLAUDE.md: "is my change live" is ONE call.
  "capability:bash", // the long-jobs rule. INSEPARABLE from its reader below —
  "capability:bash_output", // seeding the launcher alone strands every background job.
  "locks:acquire", // the CC PreToolUse lock-block hook names this verb in its refusal
  "locks:release", // (EI-9011), and release is what keeps a grant from stranding.
  "memory:search", // user CLAUDE.md: durable facts go to memory:remember FIRST.
  "memory:remember",
  "docs:search", // "Before you design or test — read the docs first."
];

/* ⛔ `CLAUDE_MINIMAL_SEED_MAX_NAMES = 31` WAS HERE. RETIRED by D-009, and the reason is
 * worth keeping because the constant was not wrong so much as measuring the wrong thing.
 *
 * It ratcheted a NAME COUNT as a proxy for a BYTE COST, and the proxy fails in BOTH
 * directions at once. Measured 2026-09-21 on the same catalog: the 31-name list it governed
 * was 106,873 B — already OVER the 100,000 B wire budget the seed is actually held to — while
 * the derived map advertises 90 names in 99,898 B. So the ratchet simultaneously FORBADE
 * cheap names (a 500 B verb cost a whole seat) and PERMITTED expensive ones (a 12 KB verb
 * cost the same seat), which is precisely how a list can pass its own guard while breaching
 * the budget the guard exists to protect.
 *
 * WHAT REPLACES IT — the same discipline, moved onto the thing that costs: the budget is
 * TRIMMED_BUDGET_BYTES in scripts/gen-tool-delivery.ts, enforced by the generator at
 * resolution time and asserted on the emitted artifact by claude-seed-wire-budget.test.ts.
 * Raising THAT is still a deliberate budget decision, not a chore.
 *
 * The 64-name history this constant was written against is preserved verbatim in the
 * DERIVED DELIVERY block comment above, which is where the ranking that replaced it lives. */

/** Claude's advertised seed. DEFAULT = the DERIVED delivery map (see the block comment
 *  above `deliveryAdvertisedNames`).
 *  Set PAPERCUSP_CLAUDE_FULL_SEED=1 to restore the historical spine+extras seed byte-for-byte
 *  — the escape hatch for a session that genuinely needs the wide surface up front, and the
 *  instant revert if the derived seed ever proves wrong. Both paths honor
 *  PAPERCUSP_OMP_TOOLS_EXCLUDE (a tool the target operator currently serves BROKEN should not
 *  be advertised on either). Exported for tests. */
export function claudeSeedToolNames(env = process.env) {
  const full = String(env.PAPERCUSP_CLAUDE_FULL_SEED || "").trim();
  const wantsFull = full !== "" && full !== "0" && full.toLowerCase() !== "false";
  const excluded = ompExcludedToolNames(env);
  // ⚠ The revert path reads the HISTORICAL LITERAL, not ompCoreToolNames() — since D-005
  // that function DERIVES, so routing the hatch through it would "restore" the very map it
  // exists to revert. An escape hatch that resolves to the thing it escapes is worse than
  // no hatch: it looks like it worked.
  const base = wantsFull
    ? [...OMP_CORE_MCP_TOOL_NAMES, ...CLAUDE_SEED_EXTRA_TOOL_NAMES]
    : deliveryAdvertisedNames("claude");
  const seen = new Set();
  return base.filter(
    (n) => !excluded.includes(n) && !seen.has(n) && (seen.add(n), true),
  );
}

/** The COMPACT-tier half of the same decision, for `?tools_compact=`.
 *
 *  A name here is advertised (it is also in {@link claudeSeedToolNames}) but its
 *  definition ships without prose — the transport applies `compactInputSchema`,
 *  which preserves everything a model needs to form a VALID call. That is what
 *  makes admission three-way instead of all-or-nothing, and it is the whole
 *  reason the derived seed can carry ~90 names in the byte budget that a
 *  hand-curated 31-name list was already filling.
 *
 *  PAPERCUSP_CLAUDE_FULL_SEED=1 restores the historical spine+extras seed
 *  byte-for-byte, which by definition compacts NOTHING — so this returns the
 *  empty list on that path, and the escape hatch stays a true revert.
 *  PAPERCUSP_OMP_TOOLS_EXCLUDE is honored here too: a tool that is not
 *  advertised must not be named as compact either. Exported for tests. */
export function claudeCompactToolNames(env = process.env) {
  const full = String(env.PAPERCUSP_CLAUDE_FULL_SEED || "").trim();
  const wantsFull = full !== "" && full !== "0" && full.toLowerCase() !== "false";
  if (wantsFull) return [];
  const advertised = new Set(claudeSeedToolNames(env));
  return deliveryCompactNames("claude").filter((n) => advertised.has(n));
}

/** The context-trimming env trio (context-trimming-tiers D-004 / D-010 / P-031) — the keys
 *  that keep a launched session's prompt at the ~143k trimmed baseline instead of the ~756k
 *  whole-catalog boot. ONE derivation, spread by launchFreshSu AND re-applied by the host-code
 *  handoff successor ({@link healContextTrimmingEnv}).
 *  Why one place (WI-2140943 lane 2, 2026-09-02): the WI-38292 host-code handoff carried a
 *  hand-kept allowlist of child env keys that predated all three, so every headless fleet
 *  member that adopted updated host code re-booted with the whole ~581-tool papercusp-su
 *  catalog INLINE — measured 756k tokens on the successor's FIRST turn (vs 143k before the
 *  adoption), 12 native sessions in 2h per member as the compaction watchdog respawned it
 *  against its 200k cap, 4 members re-reading ~800k cached tokens per turn.
 *  - ENABLE_TOOL_SEARCH: claude silently disables ToolSearch deferral whenever
 *    ANTHROPIC_BASE_URL is set (it can't assume a proxy forwards tool_reference blocks — both
 *    of ours are pass-throughs), so every gateway-routed session must force it back on.
 *    ⚠ EMITTED ONLY WHEN DEFERRAL IS ACTUALLY REACHABLE ({@link nativeDeferralReachable}) —
 *    i.e. when ToolSearch is NOT denied. Since the 2026-09-11 lockout it is NOT reachable on
 *    any psu launch, so this key is currently absent by derivation, not by an edit someone has
 *    to remember to keep in sync. Do not re-add it unconditionally: with ToolSearch denied it
 *    does not enable deferral, it injects a `DeferredToolPlaceholder` (`defer_loading: true`)
 *    into every request for a deferred set that is empty (measured, P-007).
 *    ⚠ AND THE COMMENT BELOW IS NOW HISTORY, NOT CURRENT BEHAVIOUR: the ~143k-not-756k
 *    baseline it describes is held by PAPERCUSP_TOOLS alone. Native deferral is off fleet-wide.
 *  - PAPERCUSP_TOOLS: the core spine the user-level papercusp-su MCP url env-expands (D-010),
 *    so the superuser MCP advertises ONLY the spine (~9k) and the tail stays reachable via
 *    tools:find / tools:invoke.
 *  - PAPERCUSP_CONTEXT_TIER: the payload tier the same url env-expands (`ctx_tier=`, P-009);
 *    TRIMMED for EVERY launch, model window irrelevant [owner 2026-08-10]. Every agent. */
export function contextTrimmingEnv(agent, env = process.env) {
  return {
    PAPERCUSP_CONTEXT_TIER: "trimmed",
    ...(agent === "claude"
      ? {
          // DERIVED, not hand-set — see nativeDeferralReachable. Denying ToolSearch removes the
          // mechanism this key turns on, so emitting both is a contradiction the launcher must
          // not be able to express (P-007).
          ...(nativeDeferralReachable() ? { ENABLE_TOOL_SEARCH: "true" } : {}),
          PAPERCUSP_TOOLS: claudeSeedToolNames(env).join(","),
          // The delivery TIER for the names above (?tools_compact=). DERIVED
          // from the same generated artifact, so the two can never disagree:
          // a compact name is always a subset of the advertised set.
          PAPERCUSP_TOOLS_COMPACT: claudeCompactToolNames(env).join(","),
        }
      : {}),
  };
}

/** Fill the trio into `env` wherever it is ABSENT (an explicitly carried value always wins)
 *  and return the keys filled. A host-code handoff is written by the code the predecessor
 *  has IN MEMORY — by definition the OLD code — so the successor cannot rely on it having
 *  carried every key the fresh path sets; healing here is what makes a fix to the writer
 *  land on the FIRST adoption instead of the second. */
export function healContextTrimmingEnv(env, agent = env?.PAPERCUSP_AGENT) {
  const filled = [];
  for (const [k, v] of Object.entries(contextTrimmingEnv(agent))) {
    if (env[k] === undefined || env[k] === "") {
      env[k] = v;
      filled.push(k);
    }
  }
  // P-007 — the one case where healing must REMOVE rather than fill. Filling alone cannot make
  // the contradiction unrepresentable here: a host-code handoff is written by the predecessor's
  // IN-MEMORY code, i.e. the OLD code, which set ENABLE_TOOL_SEARCH unconditionally. That value
  // arrives already present, so every fill-only path leaves it untouched and the successor
  // re-inherits the exact state this item exists to eliminate. Strip it whenever deferral is
  // unreachable, so adopting new host code converges on the FIRST handoff rather than never.
  if (agent === "claude" && !nativeDeferralReachable()) {
    delete env.ENABLE_TOOL_SEARCH;
  }
  return filled;
}

// weak-model-tool-tier: a model that runs LOCALLY (ollama/local provider prefix) is small
// and weak for tool-use relative to a hosted frontier model. Mirror of the canonical
// packages/operator-core/lib/model-tier.ts modelCapabilityTier heuristic (kept simple here
// — no TS import). Unknown/empty ⇒ NOT weak (safe default: never accidentally trim a strong
// model). OMP runs weak AND strong models, so the tier comes from the MODEL, not the client.
const OMP_LOCAL_MODEL_PREFIXES = [
  "ollama/",
  "ollama-cc/",
  "local/",
  "llamacpp/",
  "llama.cpp/",
  "lmstudio/",
  "localai/",
];
export function isWeakOmpModel(modelId) {
  if (!modelId) return false;
  const id = String(modelId).trim().toLowerCase();
  if (!id) return false;
  return OMP_LOCAL_MODEL_PREFIXES.some((p) => id.startsWith(p));
}

/** The registry-file form of an OMP model id: the provider prefix (`ollama-cc/…`) and any
 *  trailing reasoning-effort suffix (`:xhigh`) are launch-spec decoration — models.yml/models.json
 *  entries carry the bare id (e.g. `maxwell1500/ornith-35b:IQ3_M`), and the gateway's
 *  model→backend router matches that bare form. Exported for tests. */
export function bareOmpModelId(modelId) {
  let id = String(modelId ?? "").trim();
  if (!id) return "";
  const lower = id.toLowerCase();
  for (const p of OMP_LOCAL_MODEL_PREFIXES) {
    if (lower.startsWith(p)) {
      id = id.slice(p.length);
      break;
    }
  }
  return id.replace(/:(?:minimal|low|medium|high|xhigh)$/i, "");
}

/** Read the LIVE per-slot context window for a local model from the gateway's backend probe
 *  (deterministic-context-carry P-005): GET /maintenance/backend-context?model=<bare-id> →
 *  { nCtx } from the backend's own /props. The path is LOCKSTEP with operator-core
 *  inference-gateway/gateway.ts MAINTENANCE_BACKEND_CONTEXT_PATH (plain .mjs — no TS import;
 *  same mirror rule as OMP_LOCAL_MODEL_PREFIXES above). Fail-soft null on ANY miss (gateway
 *  down, model not backend-served, wedged /props) — the caller keeps the configured registry
 *  values, which is exactly the pre-P-005 behavior. Exported for tests. */
export async function probeOmpBackendContextWindow(
  modelId,
  env = process.env,
  fetchImpl = fetch,
) {
  try {
    const bare = bareOmpModelId(modelId);
    if (!bare) return null;
    const gwp = Number(env.PAPERCUSP_GATEWAY_PORT);
    const port = Number.isFinite(gwp) && gwp > 0 ? gwp : 8788;
    const r = await fetchImpl(
      `http://127.0.0.1:${port}/maintenance/backend-context?model=${encodeURIComponent(bare)}`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (!r.ok) return null;
    const j = await r.json();
    const n = Number(j?.nCtx);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** A numeric field a models.yml carries for `bareId`, or null. Scans the id's entry only
 *  (from its `- id:` line to the next `- id:`/dedent) so sibling models are never misread.
 *  Exported for tests. */
export function readModelsYmlField(ymlText, bareId, field) {
  const entry = modelsYmlEntrySpan(ymlText, bareId);
  if (!entry) return null;
  const m = entry.text.match(new RegExp(`^[ \\t]*${field}:[ \\t]*(\\d+)`, "m"));
  return m ? Number(m[1]) : null;
}
export const readModelsYmlContextWindow = (ymlText, bareId) =>
  readModelsYmlField(ymlText, bareId, "contextWindow");

/** Rewrite a numeric `field` to `value` inside `bareId`'s models.yml entry (only that entry —
 *  hosted siblings in the same registry are untouched). Returns the input unchanged when the
 *  entry or the field line is absent. Exported for tests. */
export function rewriteModelsYmlField(ymlText, bareId, field, value) {
  const entry = modelsYmlEntrySpan(ymlText, bareId);
  if (!entry) return ymlText;
  const rewritten = entry.text.replace(
    new RegExp(`^([ \\t]*${field}:[ \\t]*)\\d+`, "m"),
    `$1${value}`,
  );
  return ymlText.slice(0, entry.start) + rewritten + ymlText.slice(entry.end);
}
export const rewriteModelsYmlContextWindow = (ymlText, bareId, newWindow) =>
  rewriteModelsYmlField(ymlText, bareId, "contextWindow", newWindow);

/** Per-hop context doors MIRROR (deterministic-context-carry P-006, plan D-007) — canonical
 *  TS lives in packages/operator-core/lib/context-doors.ts (plain .mjs cannot import it; same
 *  lockstep rule as OMP_LOCAL_MODEL_PREFIXES / MAINTENANCE_SUMMARIZE_PATH). Only the two
 *  pieces the launcher consumes are mirrored: maxTurn and the OUTPUT door (the max_tokens
 *  request param — enforcement leg (a); the results/injections doors are operator-core's).
 *  Exported for tests. */
export function computeMaxTurnTokens(effectiveWindow) {
  const w = Number(effectiveWindow);
  if (!Number.isFinite(w) || w <= 0) return 8000;
  return Math.min(15000, Math.max(8000, Math.floor(w / 26)));
}
export function computeOutputDoorTokens(effectiveWindow) {
  return Math.floor(computeMaxTurnTokens(effectiveWindow) * 0.5);
}
/** P-007 two-tier thresholds — MIRROR of operator-core context-doors.ts
 *  computeCompactionThresholds (same lockstep rule as computeMaxTurnTokens above).
 *  soft = w − (2×maxTurn + 4000 overhead) → nudge tier; hard = w − maxTurn → the mechanical
 *  tier (shake), holding one full doored hop of headroom by construction.
 *  Ornith 204,800 → soft 90 / hard 96; 400K → soft 91 / hard 96. */
export function computeCompactionThresholdPercents(effectiveWindow) {
  const maxTurn = computeMaxTurnTokens(effectiveWindow);
  const w = Number(effectiveWindow);
  const window = Number.isFinite(w) && w > 0 ? w : maxTurn * 4;
  const softTokens = Math.max(0, window - (2 * maxTurn + 4000));
  const hardTokens = Math.max(softTokens, window - maxTurn);
  return {
    softPct: Math.floor((softTokens / window) * 100),
    hardPct: Math.floor((hardTokens / window) * 100),
  };
}

/** The [start,end) span of `bareId`'s list entry in a models.yml: from its `- id:` line up to the
 *  next `- `-prefixed line at the same indent or any dedent past the entry's own indentation. */
function modelsYmlEntrySpan(ymlText, bareId) {
  const lines = String(ymlText ?? "").split("\n");
  const esc = bareId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const idRe = new RegExp(`^([ \\t]*)-[ \\t]+id:[ \\t]*"?${esc}"?[ \\t]*$`);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(idRe);
    if (!m) {
      offset += lines[i].length + 1;
      continue;
    }
    const indent = m[1].length;
    let end = offset + lines[i].length + 1;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      const lead = l.match(/^[ \t]*/)[0].length;
      // A new list item at the entry's indent, or any non-blank dedent, ends the entry.
      if (
        l.trim() &&
        (lead < indent || (lead === indent && l.trimStart().startsWith("-")))
      )
        break;
      end += l.length + 1;
    }
    return {
      start: offset,
      end: Math.min(end, ymlText.length),
      text: ymlText.slice(offset, Math.min(end, ymlText.length)),
    };
  }
  return null;
}

/** Set numeric `fields` on every models.json record whose `id` is `bareId` (a JSON
 *  parse/stringify — models.json is machine-written; no comment/format concerns). Only fields
 *  the record already carries as numbers are touched. Returns the input unchanged on any
 *  parse failure. Exported for tests. */
export function rewriteModelsJsonFields(jsonText, bareId, fields) {
  try {
    const root = JSON.parse(jsonText);
    let touched = false;
    const walk = (node) => {
      if (Array.isArray(node)) {
        for (const v of node) walk(v);
      } else if (node && typeof node === "object") {
        if (node.id === bareId) {
          for (const [k, v] of Object.entries(fields)) {
            if (typeof node[k] === "number" && typeof v === "number") {
              node[k] = v;
              touched = true;
            }
          }
        }
        for (const v of Object.values(node)) walk(v);
      }
    };
    walk(root);
    return touched ? JSON.stringify(root, null, 2) : jsonText;
  } catch {
    return jsonText;
  }
}
export const rewriteModelsJsonContextWindow = (jsonText, bareId, newWindow) =>
  rewriteModelsJsonFields(jsonText, bareId, { contextWindow: newWindow });

/** The OMP session's DEFAULT model id (config.yml `modelRoles.default`), or null. Used to
 *  compute the model tier when the launch didn't pass an explicit --model. Exported for tests. */
export function ompDefaultModel(home = homedir()) {
  try {
    const text = readFileSync(
      join(home, ".omp", "agent", "config.yml"),
      "utf8",
    );
    const m = text.match(/modelRoles:[\s\S]*?\n[ \t]+default:[ \t]*([^\s#]+)/);
    return m?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Resolve a structured session's model without substituting its provider or account.
 * A copied native default is still a real selection: validate it before the
 * legacy config writer can repair a retired model by choosing a gateway.
 * @param {string | null | undefined} model
 * @param {string | null | undefined} [accountRoute]
 * @param {string} [home]
 */
export function resolveOmpSessionModel(model, accountRoute = "default", home = homedir()) {
  const selected = String(model || ompDefaultModel(home) || "").trim();
  if (!selected) return null;
  if (OMP_OX_ALPHA_MODEL_RE.test(selected)) {
    throw new Error(`OMP model '${selected}' is retired; choose a supported model before starting this session.`);
  }
  const route = String(accountRoute || "default").trim().toLowerCase();
  if ((route === "default" || route === "system") && /^papercusp-gateway\//i.test(selected)) {
    throw new Error(
      `OMP default account cannot use gateway model '${selected}'; choose auto or a named gateway account, or choose a direct-provider model.`,
    );
  }
  return selected;
}

/** Append `?tools=<names>` (and, when supplied, `&tools_compact=<names>`) to every papercusp
 *  `/api/mcp` server URL in an OMP mcp.json that doesn't already carry one, so the superuser
 *  MCP advertises ONLY the derived seed and ships the compact half without prose.
 *
 *  D-005: OMP gets BOTH axes, exactly as Claude does. Claude carries them by env-expansion in
 *  the user-level url template (`&tools_compact=${PAPERCUSP_TOOLS_COMPACT:-}`); OMP's mcp.json
 *  cannot interpolate, so the launcher writes them in. Seeding `tools` without `tools_compact`
 *  would advertise all ~90 names at FULL schema — the budget the policy resolved against is
 *  43 full + 47 compact, so that is a ~2x wire overrun, not a conservative default.
 *
 *  Pure string→string (uses URL/searchParams so colons/commas are encoded exactly the
 *  way the server's parseToolsAllowlist decodes them); returns the input unchanged on any parse
 *  failure. Exported for tests. */
export function applyOmpToolsAllowlist(mcpJsonText, toolNames, compactNames = null) {
  try {
    const obj = JSON.parse(mcpJsonText);
    const servers = obj?.mcpServers;
    if (
      servers &&
      typeof servers === "object" &&
      Array.isArray(toolNames) &&
      toolNames.length
    ) {
      for (const key of Object.keys(servers)) {
        const srv = servers[key];
        if (
          srv &&
          typeof srv.url === "string" &&
          /\/api\/mcp(\?|$)/.test(srv.url) &&
          !/[?&]tools=/.test(srv.url)
        ) {
          const u = new URL(srv.url);
          u.searchParams.set("tools", toolNames.join(","));
          if (Array.isArray(compactNames) && compactNames.length)
            u.searchParams.set("tools_compact", compactNames.join(","));
          srv.url = u.toString();
        }
      }
    }
    return JSON.stringify(obj, null, 2);
  } catch {
    return mcpJsonText;
  }
}

/** Keep only the MCP servers that belong in a default trimmed OMP session.
 *
 * The per-session config copy must carry papercusp-su, and may carry the public
 * context7 server. Copying every server from the user's global mcp.json also
 * pulls heavyweight/browser and credentialed plugin servers into every worker,
 * even though the trimmed Papercusp tool spine cannot use them. ROLE launches
 * deliberately skip this filter by not supplying toolsAllowlist; there is no
 * context-size opt-out ('full' normalizes to 'trimmed' at parse).
 * Pure string→string; returns the input unchanged on any parse failure.
 */
function filterTrimmedOmpMcpServers(mcpJsonText) {
  try {
    const obj = JSON.parse(mcpJsonText);
    const servers = obj?.mcpServers;
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      obj.mcpServers = Object.fromEntries(
        Object.entries(servers).filter(
          ([name]) => name === "papercusp-su" || name === "context7",
        ),
      );
    }
    return JSON.stringify(obj, null, 2);
  } catch {
    return mcpJsonText;
  }
}

/** Rewrite the ORIGIN (scheme+host+port) of every papercusp `/api/mcp` server URL in an OMP
 *  mcp.json to the launcher's resolved operator URL, preserving path + query. The user-level
 *  `~/.omp/agent/mcp.json` pins whatever origin it was minted with (usually direct :3070) — a
 *  per-session copy that keeps that origin ignores PAPERCUSP_OPERATOR_URL and bypasses the
 *  resilient proxy (WI-1457), so the member talks to a DIFFERENT operator than the launcher
 *  that spawned it (root-caused 2026-07-02, P-030: a :3170-pinned relaunch still hit :3070).
 *  Pure string→string; returns the input unchanged on any parse failure. Exported for tests. */
export function applyOmpOperatorOrigin(mcpJsonText, operatorUrl) {
  try {
    const origin = new URL(operatorUrl).origin;
    const obj = JSON.parse(mcpJsonText);
    const servers = obj?.mcpServers;
    if (servers && typeof servers === "object") {
      for (const key of Object.keys(servers)) {
        const srv = servers[key];
        if (
          srv &&
          typeof srv.url === "string" &&
          /\/api\/mcp(\?|$)/.test(srv.url)
        ) {
          const u = new URL(srv.url);
          srv.url = origin + u.pathname + u.search;
        }
      }
    }
    return JSON.stringify(obj, null, 2);
  } catch {
    return mcpJsonText;
  }
}

/** Replace the bearer on every papercusp SUPERUSER `/api/mcp` server (`?superuser=1`) in an OMP
 *  mcp.json with `bearer`, the token the target operator actually validates.
 *
 *  WHY (WI-10003604): the user-level template bakes the bearer it was minted with and normally
 *  points at the :9071 proxy, which re-injects the CURRENT superuser token on every request.
 *  applyOmpOperatorOrigin re-points that origin — for the in-process PUI engine, straight at the
 *  operator — so the proxy's refresh no longer runs and the stale template bearer reaches an
 *  operator validating `$PAPERCUSP_HOME/superuser-token`. Result: `superuser_invalid_bearer` on
 *  every tools/list, OMP starts with only its native tools, and the SU turn fails
 *  `omp_connection_failed`. The credential must follow the origin. Any case variant of the
 *  Authorization header is replaced so the server never receives two. An empty bearer, a
 *  non-superuser server, or unparseable input is left unchanged. Pure; exported for tests. */
export function applyOmpOperatorBearer(mcpJsonText, bearer) {
  const token = typeof bearer === "string" ? bearer.trim() : "";
  if (!token) return mcpJsonText;
  try {
    const obj = JSON.parse(mcpJsonText);
    const servers = obj?.mcpServers;
    if (servers && typeof servers === "object") {
      for (const key of Object.keys(servers)) {
        const srv = servers[key];
        if (!srv || typeof srv.url !== "string" || !/\/api\/mcp(\?|$)/.test(srv.url)) continue;
        if (new URL(srv.url).searchParams.get("superuser") !== "1") continue;
        const headers = srv.headers && typeof srv.headers === "object" ? srv.headers : {};
        for (const h of Object.keys(headers)) {
          if (h.toLowerCase() === "authorization") delete headers[h];
        }
        headers.Authorization = `Bearer ${token}`;
        srv.headers = headers;
      }
    }
    return JSON.stringify(obj, null, 2);
  } catch {
    return mcpJsonText;
  }
}

/**
 * Probe an OMP session's operator MCP endpoint without requiring auth or a
 * valid MCP request. Any HTTP response proves that a listener is serving the
 * route; connection and timeout failures are the only unavailable states.
 * The async probe keeps native OMP materialization from blocking on a stale
 * PAPERCUSP_HONO_PORT while preserving the sync writer below for pure callers.
 */
export async function probeOmpOperatorMcp(
  operatorMcpUrl,
  timeoutMs = 1_500,
  fetchImpl = fetch,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchImpl(operatorMcpUrl, {
      method: "GET",
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function ompOperatorMcpEndpoint(operatorUrl) {
  try {
    const u = new URL(operatorUrl);
    u.search = "";
    u.hash = "";
    const path = u.pathname.replace(/\/+$/, "");
    u.pathname = /\/api\/mcp$/i.test(path) ? path : `${path}/api/mcp`;
    return u.toString();
  } catch {
    return null;
  }
}

function isLoopbackOperatorUrl(operatorUrl) {
  try {
    const host = new URL(operatorUrl).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

function runtimeOmpOperatorBase(operatorUrl, env) {
  const configuredPort = String(env.PAPERCUSP_HONO_PORT || "").trim();
  if (!/^\d+$/.test(configuredPort))
    return { base: operatorUrl, configuredPort: null };
  const proxyBase = String(env.PAPERCUSP_MCP_PROXY_BASE || "")
    .trim()
    .replace(/\/+$/, "");
  const proxyTargetPort = String(
    env.PAPERCUSP_MCP_PROXY_TARGET_PORT || "3070",
  ).trim();
  if (proxyBase && configuredPort === proxyTargetPort)
    return { base: proxyBase, configuredPort };
  // Match the orchestrator resolver: a known serving port outranks inherited
  // PAPERCUSP_OPERATOR_URL so a child stays on its spawning code/control plane.
  return { base: `http://127.0.0.1:${configuredPort}`, configuredPort };
}

/**
 * Resolve the operator origin for native OMP's per-session mcp.json and
 * resume-time config-repair requests. This is the launcher-side counterpart to
 * orchestrator spawn-mcp's async resolver:
 * probe the runtime-selected local route, then recover on canonical :3070
 * when a copied PAPERCUSP_HONO_PORT is stale. A live non-green port remains
 * authoritative, so staging :3170 never silently falls through to green.
 *
 * No runtime port hint means there is no stale local-port claim to validate;
 * preserve the already-resolved proxy/discovery target without adding a
 * network request to ordinary launches. Caller-supplied writer pins bypass
 * this helper in writeOmpSessionConfigDirAsync.
 */
export async function resolveOmpOperatorUrl(
  operatorUrl = undefined,
  {
    env = process.env,
    probe = probeOmpOperatorMcp,
    onRecovery = ({ configuredBase, recoveredBase, configuredPort }) =>
      console.warn(
        `[psu] native OMP MCP route ${configuredBase} was unavailable; recovered on ${recoveredBase}` +
          (configuredPort
            ? ` (PAPERCUSP_HONO_PORT=${configuredPort} is stale)`
            : ""),
      ),
    probeTimeoutMs = 1_500,
  } = {},
) {
  // A caller-supplied pin is authoritative; never silently route it elsewhere.
  if (operatorUrl) return operatorUrl;
  const { base: configuredBase, configuredPort } = runtimeOmpOperatorBase(
    OPERATOR_URL,
    env,
  );
  if (!configuredPort || !isLoopbackOperatorUrl(configuredBase))
    return configuredBase;
  const configuredEndpoint = ompOperatorMcpEndpoint(configuredBase);
  if (!configuredEndpoint) return configuredBase;
  if (await probe(configuredEndpoint, probeTimeoutMs)) return configuredBase;

  const candidates = [
    `http://127.0.0.1:${configuredPort}`,
    "http://127.0.0.1:3070",
  ]
    .filter((candidate, index, all) => all.indexOf(candidate) === index)
    .filter((candidate) => candidate !== configuredBase);
  for (const recoveredBase of candidates) {
    const recoveredEndpoint = ompOperatorMcpEndpoint(recoveredBase);
    if (!recoveredEndpoint || !(await probe(recoveredEndpoint, probeTimeoutMs)))
      continue;
    onRecovery({ configuredBase, recoveredBase, configuredPort });
    return recoveredBase;
  }
  // Preserve the configured route when no recovery candidate is reachable so
  // the normal OMP connection error remains the authoritative diagnosis.
  return configuredBase;
}

/** Stamp fixed query params (`agent`, `model`) onto every papercusp `/api/mcp` server URL in an
 *  OMP mcp.json, so the operator learns the CALLING agent's backend + model PER REQUEST. This is
 *  the "current calling agent" signal fleet:launch-on-plan reads to default a spawned fleet's
 *  backend/model to the caller's own (fleet-launch-agent-inheritance-2026-07-03) — an omp/ornith
 *  leader that omits `agent` then spawns omp members, not the historical claude default. Because
 *  psu REWRITES this per-session copy each launch (unlike the static user-level file), the value is
 *  the CURRENT process's backend/model, not a session-start constant (a resume re-stamps). Pure
 *  string→string; returns the input unchanged on any parse failure. Exported for tests. */
export function applyOmpMcpUrlParams(mcpJsonText, params) {
  try {
    const obj = JSON.parse(mcpJsonText);
    const servers = obj?.mcpServers;
    if (
      servers &&
      typeof servers === "object" &&
      params &&
      typeof params === "object"
    ) {
      for (const key of Object.keys(servers)) {
        const srv = servers[key];
        if (
          srv &&
          typeof srv.url === "string" &&
          /\/api\/mcp(\?|$)/.test(srv.url)
        ) {
          const u = new URL(srv.url);
          for (const [k, v] of Object.entries(params)) {
            if (v != null && String(v).length > 0)
              u.searchParams.set(k, String(v));
          }
          srv.url = u.toString();
        }
      }
    }
    return JSON.stringify(obj, null, 2);
  } catch {
    return mcpJsonText;
  }
}

/**
 * Point a relocated OMP agent dir at the global OAuth SQLite store.
 *
 * Modern OMP keeps provider logins (xai-oauth, anthropic, openai-codex, …) in
 * `agent.db` (`auth_credentials`). `PI_CONFIG_DIR` relocation would otherwise
 * leave the session with a fresh empty db — credentials appear only in
 * `~/.omp/agent/agent.db` (or the legacy `auth.json` for older providers).
 *
 * Symlink (not copy) matches fleet `writeSpawnOmpHome` / `OMP_SEEDED_AGENT_ESSENTIALS`:
 * concurrent sessions share one credential store; no multi-MB duplicate; token
 * refresh from a direct `omp` login is visible to the next psu launch.
 *
 * Replaces a stale real-file `agent.db` (empty db created by a pre-fix psu
 * session, or a prior copy) so re-seeding the same session id heals. Best-effort
 * — never throws; a missing global store degrades to OMP's own auth error.
 * Exported for tests.
 */
export function linkOmpAgentDb(srcAgent, dstAgent) {
  try {
    if (!srcAgent || !dstAgent) return;
    const srcDb = join(srcAgent, "agent.db");
    if (!existsSync(srcDb)) return;
    const dstDb = join(dstAgent, "agent.db");
    // Healthy: already a symlink resolving to the global store.
    try {
      if (
        lstatSync(dstDb).isSymbolicLink() &&
        realpathSync(dstDb) === realpathSync(srcDb)
      ) {
        return;
      }
    } catch {
      /* missing or dangling — fall through and (re)link */
    }
    // Drop a stale real file / wrong link and any local WAL/SHM left by an empty
    // session db (those would sit next to the symlink path and confuse SQLite).
    for (const side of ["agent.db", "agent.db-wal", "agent.db-shm"]) {
      try {
        rmSync(join(dstAgent, side), { force: true });
      } catch {
        /* best-effort */
      }
    }
    symlinkSync(srcDb, dstDb);
  } catch {
    /* a launch must NEVER fail on credential seed */
  }
}

/**
 * su-context-size-variants + weak-model-tool-tier: materialize a per-session OMP config dir
 * and return the value to export as PI_CONFIG_DIR.
 *
 * ⚠ RETURNS A HOME-RELATIVE PATH (e.g. `.papercusp/su-omp-homes/session-<id>`), NOT absolute.
 * OMP resolves PI_CONFIG_DIR as `path.join(os.homedir(), process.env.PI_CONFIG_DIR || '.omp')`,
 * so an ABSOLUTE value gets doubled onto home (`/home/u/home/u/…`) → a non-existent dir. (Root-
 * caused 2026-07-01 from the OMP bundle; the prior absolute-returning writeOmpFullConfigDir
 * silently broke full-mode — the relocated dir was never read.)
 *
 * Because PI_CONFIG_DIR fully RELOCATES OMP's config+data root (no overlay fallback; with no
 * XDG_*_HOME the data root collapses onto configRoot), the per-session dir must carry a FAITHFUL
 * copy of the model registry (config.yml + models.yml/json/db + auth) AND the mcp.json — else the
 * session loses model resolution AND the papercusp-su MCP server. We copy the small config+registry
 * files (not the multi-MB session/history dbs, which a fresh session recreates).
 *
 * OAuth credentials (xai-oauth, anthropic, openai-codex, …) live in `agent.db`
 * (`auth_credentials`), NOT the legacy `auth.json`. A byte-copy of that SQLite
 * store would race concurrent sessions and bloat every su-omp-home; instead we
 * **symlink** `agent.db` to the global `~/.omp/agent/agent.db` — same essential
 * as fleet `writeSpawnOmpHome` / `OMP_SEEDED_AGENT_ESSENTIALS`. Without the
 * link, psu→omp sessions boot with an empty credential store and Grok/xAI
 * (and any other post-login provider) silently vanish from `/model`.
 *
 *   opts.discoveryOff   → flip OMP tool-discovery OFF. NOT a whole-catalog switch (that mode is
 *                         retired): it accompanies the trimmed SEED, because with discovery ON
 *                         even tools:find/tools:invoke sit behind activation and a 0-match query
 *                         strands the entire surface.
 *   opts.toolsAllowlist → advertise ONLY these MCP tools (weak-model trim; listing-only, the rest
 *                         stay callable via tools:find).
 *
 * Returns the home-relative dir, or null on any failure (caller falls back to OMP's native default
 * — no regression). Exported for tests.
 */
// Match the canonical OMP transcript root. Keep PI_CONFIG_DIR home-relative
// even when an isolated operator/test supplies an absolute store root.
function ompSessionConfigRelativeDir(sessionId, home) {
  const root = process.env.PAPERCUSP_SU_OMP_HOMES_DIR || join(home, ".papercusp", "su-omp-homes");
  return relative(home, join(root, `session-${sessionId}`));
}

export function writeOmpSessionConfigDir(
  sessionId,
  opts = {},
  home = homedir(),
) {
  const {
    discoveryOff = false,
    toolsAllowlist = null,
    // The COMPACT-tier subset of toolsAllowlist (`&tools_compact=`, D-005). Null/empty ⇒
    // nothing is compacted, which is the correct behaviour for a ROLE launch (it supplies
    // no allowlist at all) but a ~2x wire overrun for a seeded one — so the seeded call
    // site passes it, and the omp-seed-wire-budget guard measures the pair.
    toolsCompact = null,
    operatorUrl = OPERATOR_URL,
    // The superuser bearer the operator at operatorUrl validates. When set, it replaces the
    // template's baked bearer on every superuser papercusp server (applyOmpOperatorBearer):
    // re-pointing the origin without the credential strands the session on a stale token
    // (WI-10003604). Null keeps the template bearer (legacy callers, open dev operators).
    operatorBearer = null,
    model = null,
    // Authoritative gateway registry bytes from bootstrap account routing.
    // When present they replace (not merge with) the user's global registry so
    // a selected auto/pin route cannot be shadowed by a direct provider entry.
    modelsYml = null,
    // Role launches receive already-signed MCP bytes from bootstrap-role. Keep
    // those bytes verbatim: rewriting the URL/query would invalidate its role
    // signature and reintroduce the shared-cwd identity leak.
    mcpJsonContents = null,
    clientId = null,
    nativeMcp = false,
    mcpEnv = null,
    backendWindow = null,
    // P-019 residual sampler (D-010): the launcher is the ONLY layer that knows
    // whether this session is interactive (headless members / piped launches are
    // not) — thread the truthful bit so the gateway's sampler honors the
    // interactive-only gate instead of guessing. Default false: under-claiming
    // interactivity only skips samples (conservative), never mis-samples.
    interactive = false,
  } = opts;
  try {
    if (!sessionId) return null;
    const srcAgent = join(home, ".omp", "agent");
    const srcCfg = join(srcAgent, "config.yml");
    if (!existsSync(srcCfg)) return null;
    const rel = ompSessionConfigRelativeDir(sessionId, home);
    const dstAgent = join(home, rel, "agent");
    mkdirSync(dstAgent, { recursive: true });
    // config.yml — copy verbatim, optionally flipping discoveryMode off. That flip accompanies
    // the trimmed SEED (see the discoveryOff note on this function); it is NOT the retired
    // whole-catalog mode. String surgery on the stable installer-managed keys (a YAML
    // parse/emit would risk reordering).
    let cfg = readFileSync(srcCfg, "utf8");
    if (discoveryOff) {
      cfg = cfg
        .replace(/^(\s*discoveryMode:\s*)(?:mcp-only|all|auto)\s*$/gm, "$1off")
        .replace(/^(\s*discoveryMode:\s*)true\s*$/gm, "$1false");
    }
    // Disable the `eval` builtin (py/js/rb/jl) in THIS psu agent session's config copy ONLY — never
    // the user's global ~/.omp, which keeps eval for their own DIRECT (non-psu) omp use. A weak local
    // model reflexively runs MCP calls as `eval` code and DOOM-LOOPS on it (WI-2382 iter4/5: 56–80×,
    // fatal); removing it from the surface is the fix that works (a coord-hook execution-block alone
    // doesn't stop the model REACHING for it). This replaces the former GLOBAL `omp config set
    // eval.*=false` in ensure-omp-su, which leaked the disable into the user's own non-psu omp (owner
    // scoping fix 2026-07-04 / WI-2382). Remove any inherited `eval:` block, then append a canonical
    // all-off one — deterministic whether the copied global had eval on, off, or absent.
    cfg = cfg.replace(/^eval:[ \t]*\n(?:[ \t]+\S.*\n?)*/gm, "");
    if (!cfg.endsWith("\n")) cfg += "\n";
    cfg += "eval:\n  py: false\n  js: false\n  rb: false\n  jl: false\n";
    // Deterministic compaction for LOCAL-model sessions (deterministic-context-carry P-001,
    // ornith overflow 2026-07-13): omp's default strategy `snapcompact` archives history as
    // IMAGES (useless to a text-only local model) and falls back to LLM summarization on the
    // session's own saturated single-slot backend — 429 self-starvation, then an un-gated
    // 213K-token send into a 204K window → HTTP 400 and a dead session. `shake` is mechanical
    // (no LLM call, no images) and thresholdPercent 70 fires it well before the wall. Settings
    // live in config.yml (NOT agent/config.json — verified against the omp bundle's settings
    // loader, which migrates legacy settings.json INTO config.yml). Same remove-then-append
    // surgery as `eval` above; hosted-model sessions keep the copied config untouched.
    const cfgDefaultModel =
      cfg
        .match(/modelRoles:[\s\S]*?\n[ \t]+default:[ \t]*([^\s#]+)/)?.[1]
        ?.trim() || null;
    let effModel = model || cfgDefaultModel;
    // EI-21919040934117285: modelRoles.default is copied VERBATIM from the user's
    // global ~/.omp/agent/config.yml above, so a session that omits --model silently
    // inherits whatever that default names — including a model RETIRED upstream
    // (verified: openrouter/stealth/ox-alpha now 404s "Thank you for participating
    // in the Stealth Ox Alpha testing period"). Check the COPIED CFG's default
    // directly (never effModel — that already prefers opts.model, so it would never
    // see a retired default an explicit --model happens to mask) and rewrite it to
    // the model THIS launch actually selected when one was passed, or — when none
    // was and the inherited default is the known-retired one — to the same
    // papercusp-gateway route used elsewhere as the safe fallback (see
    // ompDefaultModelAdvisory's /model suggestion below). Fails loud at
    // config-materialization time instead of a silent 404 ~3s into the session.
    if (OMP_OX_ALPHA_MODEL_RE.test(cfgDefaultModel || "")) {
      const replacement = model || OMP_GATEWAY_FALLBACK_MODEL;
      console.error(
        `psu: CONFIG ERROR — modelRoles.default (${cfgDefaultModel}) is a RETIRED upstream model that 404s; ` +
          `rewriting this session's copy to ${replacement}. Fix your global ~/.omp/agent/config.yml.`,
      );
      cfg = cfg.replace(
        /^([ \t]*modelRoles:[\s\S]*?\n[ \t]+default:[ \t]*)([^\s#]+)/m,
        `$1${replacement}`,
      );
      effModel = replacement;
    }
    const localModel = isWeakOmpModel(effModel);
    // WI-5047: OMP classifies generic provider HTTP 500 / "internal error" responses as
    // transient and retries them (10 attempts by default). A local llama-server CUDA
    // allocation failure is process-startup state, not a request-level transient: replaying
    // the same request immediately only creates a noisy retry storm and hides the original
    // actionable cudaMalloc error. Papercusp owns this relocated config, so LOCAL sessions
    // fail loud on the first provider error. Hosted OMP sessions retain the user's/native
    // retry policy. Remove both supported config spellings before appending the canonical
    // local-only block so an inherited global retry policy cannot override it.
    if (localModel) {
      cfg = cfg
        .replace(/^retry:[ \t]*\n(?:[ \t]+\S.*\n?)*/gm, "")
        .replace(/^retry\.[A-Za-z.]+:.*\n?/gm, "");
      if (!cfg.endsWith("\n")) cfg += "\n";
      cfg += "retry:\n  enabled: false\n";
    }
    // remoteEndpoint (deterministic-context-carry P-002): route the summarizer's LLM call to
    // the gateway's reserved maintenance lane instead of the session's own backend. The path
    // is LOCKSTEP with operator-core inference-gateway/gateway.ts MAINTENANCE_SUMMARIZE_PATH
    // (plain .mjs — no TS import; same mirror rule as OMP_LOCAL_MODEL_PREFIXES above). omp
    // THROWS on a remoteEndpoint failure (no local fallback), so it is seeded ONLY where the
    // gateway is already a hard dependency (a papercusp-gateway/-routed model) or where the
    // alternative is worse (a weak local model summarizing on its own saturated slot).
    const gwp = Number(process.env.PAPERCUSP_GATEWAY_PORT);
    const gwPort = Number.isFinite(gwp) && gwp > 0 ? gwp : 8788;
    // DETERMINISTIC CARRY cutover (deterministic-context-carry P-017, WI-4845;
    // P-022/WI-4998 removed the PAPERCUSP_OMP_CARRY_COMPACTION emergency opt-out —
    // native compaction is retired, so there is nothing to opt back INTO): append
    // ?carryOwner=<coord ownerId>
    // [&carryWindow=<probed backend tokens>] so the gateway answers the compaction from the
    // deterministic carry-doc builder instead of the LLM oneshot. Requires the per-session
    // coord ownerId (opts.clientId): without it there is no owner to build a carry doc
    // for, so the session runs the mechanical `shake` strategy instead (below).
    const carryOptIn = !!clientId;
    const carryBw = Number(backendWindow);
    // &carryInteractive=1 (P-019, D-010): threads the launcher's truthful
    // interactivity knowledge to the gateway's residual sampler — headless /
    // piped sessions omit it and their boundaries are skipped (graded by the
    // P-020 drills instead). An older gateway ignores the extra param.
    const carryParams = carryOptIn
      ? `?carryOwner=${encodeURIComponent(clientId)}${Number.isFinite(carryBw) && carryBw > 0 ? `&carryWindow=${carryBw}` : ""}${interactive ? "&carryInteractive=1" : ""}`
      : "";
    const remoteEndpointLine = `  remoteEndpoint: "http://127.0.0.1:${gwPort}/maintenance/summarize${carryParams}"\n`;
    // P-022 (WI-4998, owner terminal state 2026-07-14 "remove the compact call
    // entirely"): EVERY omp session — local, gateway-routed, AND direct-API
    // hosted — gets the papercusp compaction block; omp's native strategies
    // (snapcompact et al.) are retired fleet-wide. This supersedes the P-001
    // "never force shake on a hosted model" decision. Strip any inherited
    // block, then append the canonical one:
    //   • carry-opted (clientId present): `context-full` + remoteEndpoint with
    //     carryOwner params — the summarize call is answered DETERMINISTICALLY
    //     by the gateway's carry-doc builder (P-017), never an LLM oneshot.
    //   • no clientId: mechanical `shake` (no LLM call, no endpoint line) — no
    //     gateway hard-dependency is introduced where none existed (omp THROWS
    //     on a remoteEndpoint failure with no local fallback).
    cfg = cfg
      .replace(/^compaction:[ \t]*\n(?:[ \t]+\S.*\n?)*/gm, "")
      .replace(/^compaction\.[A-Za-z.]+:.*\n?/gm, "");
    if (!cfg.endsWith("\n")) cfg += "\n";
    // Threshold (P-007): when the LIVE backend window was probed (P-005), the cut fires at the
    // DERIVED hard tier — window − maxTurn, one full doored hop of headroom by construction
    // (Ornith → 96; the P-006 doors bound what a hop can add, and omp ≥16.3.3's pre-flight
    // guard fail-louds a doomed send as the wall backstop). Derived from the SAME
    // effectiveWindow = min(configured, backend) the registry copy below clamps to — omp
    // measures its % against that clamped contextWindow, so a percent from the raw probe
    // would under-reserve when the configured limit is deliberately smaller. No probe
    // (gateway down / hosted model) → the conservative pre-P-007 constant 70, since
    // nothing then bounds the hop.
    let shakePct = 70;
    const shakeBw = Number(backendWindow);
    if (Number.isFinite(shakeBw) && shakeBw > 0) {
      let shakeWindow = shakeBw;
      try {
        const srcYml = join(srcAgent, "models.yml");
        const configured = existsSync(srcYml)
          ? readModelsYmlContextWindow(
              readFileSync(srcYml, "utf8"),
              bareOmpModelId(effModel || ""),
            )
          : null;
        if (configured) shakeWindow = Math.min(configured, shakeBw);
      } catch {
        /* fail-soft: the raw probed window still yields a sane hard tier */
      }
      shakePct = computeCompactionThresholdPercents(shakeWindow).hardPct;
    }
    cfg += `compaction:\n  strategy: ${carryOptIn ? "context-full" : "shake"}\n  thresholdPercent: ${shakePct}\n${carryOptIn ? remoteEndpointLine : ""}`;
    writeFileSync(join(dstAgent, "config.yml"), cfg, { mode: 0o600 });
    // Faithful model registry + auth so model resolution + provider baseUrls survive the
    // relocation (the data root collapses onto the relocated configRoot; missing registry ⇒
    // "model not found"). Skip the big session/history dbs — a fresh session recreates them.
    //
    // effectiveWindow clamp (deterministic-context-carry P-005): when the caller probed the LIVE
    // backend window (opts.backendWindow, from the gateway /maintenance/backend-context read),
    // this session's registry copies are rewritten so EVERY source agrees on
    // effectiveWindow = min(configured models.yml limit, live backend n_ctx) — eliminating the
    // three-way contextWindow conflict (models.yml 200000 vs backend 204800 vs stale models.json
    // 57344) at the one seam every psu omp session passes through. A configured limit ABOVE the
    // live backend window is the 2026-07-13 overflow class (the session believes it has room the
    // backend cannot hold) — clamped here, loudly. Only THIS model's entries are touched; hosted
    // siblings keep their registry values.
    const bwNum = Number(backendWindow);
    const clampBare =
      Number.isFinite(bwNum) && bwNum > 0 && effModel
        ? bareOmpModelId(effModel)
        : "";
    let effectiveWindow = null;
    let effectiveMaxTokens = null;
    for (const f of [
      "models.yml",
      "models.json",
      "models.db",
      "auth.json",
      "claude-bridge.json",
      "config.json",
      "SYSTEM.md",
    ]) {
      const s = join(srcAgent, f);
      if (
        f === "models.yml" &&
        typeof modelsYml === "string" &&
        modelsYml.trim()
      ) {
        writeFileSync(join(dstAgent, f), prepareOmpGatewayModelsConfig(modelsYml, "yaml", clientId), { mode: 0o600 });
        continue;
      }
      if (!existsSync(s)) continue;
      if (clampBare && f === "models.yml") {
        let text = readFileSync(s, "utf8");
        const configured = readModelsYmlContextWindow(text, clampBare);
        effectiveWindow = configured ? Math.min(configured, bwNum) : bwNum;
        if (configured && configured > bwNum) {
          console.error(
            `psu: CONFIG ERROR — models.yml contextWindow ${configured} for ${clampBare} EXCEEDS the live backend window ${bwNum}; ` +
              `clamping this session's registry to ${effectiveWindow}. Fix the registry: a configured limit above what the backend serves is the 2026-07-13 overflow class.`,
          );
        }
        text = rewriteModelsYmlContextWindow(text, clampBare, effectiveWindow);
        // Output door (P-006 enforcement leg (a)): maxTokens = the max_tokens request param
        // omp sends per hop. min(existing, door) — the door only ever TIGHTENS a registry
        // value, never raises one a smaller model deliberately set low.
        const outputDoor = computeOutputDoorTokens(effectiveWindow);
        const configuredMax = readModelsYmlField(text, clampBare, "maxTokens");
        effectiveMaxTokens = configuredMax
          ? Math.min(configuredMax, outputDoor)
          : outputDoor;
        text = rewriteModelsYmlField(
          text,
          clampBare,
          "maxTokens",
          effectiveMaxTokens,
        );
        console.error(
          `psu: per-hop doors for ${clampBare}: maxTurn ${computeMaxTurnTokens(effectiveWindow)} → output door (max_tokens) ${effectiveMaxTokens} at effectiveWindow ${effectiveWindow}.`,
        );
        writeFileSync(join(dstAgent, f), prepareOmpGatewayModelsConfig(text, "yaml", clientId), { mode: 0o600 });
        continue;
      }
      if (clampBare && f === "models.json" && effectiveWindow) {
        const fields = { contextWindow: effectiveWindow };
        if (effectiveMaxTokens) fields.maxTokens = effectiveMaxTokens;
        const text = rewriteModelsJsonFields(
          readFileSync(s, "utf8"),
          clampBare,
          fields,
        );
        writeFileSync(join(dstAgent, f), prepareOmpGatewayModelsConfig(text, "json", clientId), { mode: 0o600 });
        continue;
      }
      if (f === "models.yml" || f === "models.json") {
        const text = prepareOmpGatewayModelsConfig(readFileSync(s, "utf8"), f === "models.json" ? "json" : "yaml", clientId);
        writeFileSync(join(dstAgent, f), text, { mode: 0o600 });
        continue;
      }
      cpSync(s, join(dstAgent, f));
    }
    // OAuth credential store — symlink, never copy (see writeOmpSessionConfigDir doc).
    linkOmpAgentDb(srcAgent, dstAgent);
    // mcp.json — carry the papercusp-su server (else the relocated session has NO MCP at all).
    // A default trimmed launch also prunes the SERVER map to papercusp-su + optional context7;
    // otherwise every future server added to the user's global config silently joins every weak
    // worker. ROLE launches omit toolsAllowlist and so keep the complete user-selected server
    // map. There is no longer a --context-size opt-out: 'full' is normalized to 'trimmed' at
    // parse (see parseArgs), so an SU launch asking for it still gets the allowlist.
    const srcMcp = join(srcAgent, "mcp.json");
    const explicitMcpJson =
      typeof mcpJsonContents === "string" && mcpJsonContents.trim()
        ? mcpJsonContents
        : null;
    if (explicitMcpJson || existsSync(srcMcp)) {
      // Role MCP contents are already signed for this session. Do not apply
      // the normal SU profile rewrites (origin, client, allowlist, native
      // adapter): any URL/query mutation would invalidate the role signature.
      const roleMcp = explicitMcpJson !== null;
      let mcpText = roleMcp ? explicitMcpJson : readFileSync(srcMcp, "utf8");
      if (!roleMcp) {
        if (toolsAllowlist && toolsAllowlist.length)
          mcpText = filterTrimmedOmpMcpServers(mcpText);
        mcpText = applyOmpOperatorOrigin(mcpText, operatorUrl);
        mcpText = applyOmpOperatorBearer(mcpText, operatorBearer);
        if (toolsAllowlist && toolsAllowlist.length)
          mcpText = applyOmpToolsAllowlist(
            mcpText,
            toolsAllowlist,
            toolsCompact,
          );
        // Stamp the caller's backend (always omp here) + resolved model so the operator can inherit
        // them for a fleet this session launches (fleet-launch-agent-inheritance-2026-07-03).
        // WI-1866: ALSO stamp the per-session coord ownerId as `client=` — the user-level template
        // bakes a single PER-MACHINE client id, and omp (unlike claude's ${PAPERCUSP_SID} url
        // env-expansion) can't interpolate the SID at connect, so every omp session on the box
        // collapsed into ONE in-band coord identity: shared claims (fleet:assignments showed one
        // agent doing every member's work), void claim-conflict protection between members, and
        // wakes to the transcript-visible identity black-holing (sessions 9980–9982, 2026-07-03).
        // Overriding client= per-session is exactly how claude/codex thread identity (_mcp-handler
        // resolution: x-papercusp-client header || mcp-session || ?client=).
        mcpText = applyOmpMcpUrlParams(mcpText, {
          agent: "omp",
          model: model || undefined,
          client: clientId || undefined,
        });
        if (nativeMcp && nativeOmpExtensionArgs("omp").length) {
          const native = nativeMcpRequire(fileURLToPath(nativeMcpBundle));
          mcpText = native.prepareNativeOmpConfig(mcpText, {
            mode: native.agentMcpMode(process.env.PAPERCUSP_MCP_TRANSPORT),
            home, env: { ...process.env, ...mcpEnv, PAPERCUSP_SID: clientId || mcpEnv?.PAPERCUSP_SID },
          });
        }
      }
      writeFileSync(join(dstAgent, "mcp.json"), mcpText, { mode: 0o600 });
    }
    return rel;
  } catch (e) {
    if (process.env.PAPERCUSP_MCP_TRANSPORT && process.env.PAPERCUSP_MCP_TRANSPORT !== "http") throw e;
    console.error(
      `psu: omp per-session config setup failed (${e?.message ?? e}); falling back to OMP default.`,
    );
    return null;
  }
}

/**
 * Async launch-time counterpart to writeOmpSessionConfigDir. The synchronous
 * writer remains pure from its callers' perspective, while fresh launches can
 * validate the runtime-selected loopback route before baking it into mcp.json.
 * Explicit operatorUrl pins bypass probing; all other route options are test
 * seams and are removed before delegating to the synchronous writer.
 */
export async function writeOmpSessionConfigDirAsync(
  sessionId,
  opts = {},
  home = homedir(),
) {
  const {
    operatorUrl,
    env = process.env,
    probe = probeOmpOperatorMcp,
    onRecovery,
    probeTimeoutMs,
    ...writerOpts
  } = opts || {};
  const explicitOperatorUrl =
    operatorUrl != null && String(operatorUrl).trim().length > 0;
  const resolvedOperatorUrl = explicitOperatorUrl
    ? operatorUrl
    : await resolveOmpOperatorUrl(undefined, {
        env: env ?? process.env,
        probe,
        onRecovery,
        probeTimeoutMs,
      });
  return writeOmpSessionConfigDir(
    sessionId,
    { ...writerOpts, operatorUrl: resolvedOperatorUrl },
    home,
  );
}

export function ompDefaultModelAdvisory(home = homedir()) {
  try {
    const text = readFileSync(
      join(home, ".omp", "agent", "config.yml"),
      "utf8",
    );
    const m = text.match(/modelRoles:[\s\S]*?\n[ \t]+default:[ \t]*([^\s#]+)/);
    const def = m?.[1]?.trim();
    if (def && /^ollama\//i.test(def)) {
      return (
        `psu: omp's default model is ${def} (a local model with a small context) — if your first turn ` +
        `errors with "exceeds the available context size", run /model to pick a larger one ` +
        `(e.g. ${OMP_GATEWAY_FALLBACK_MODEL}).`
      );
    }
  } catch {
    /* no / unreadable config.yml → no advisory */
  }
  return null;
}

/**
 * Env for a resumed session. Pure — exported for tests. Identity + scope
 * SURVIVE the resume (psu-workspace-scoping fix):
 *   - A tracked row's `coordOwnerId` is re-exported as PAPERCUSP_SID —
 *     wake-executor semantics. The old behavior (fresh random SID per
 *     resume) orphaned the original SID's locks/awaits/presence and
 *     detached the live session from its adv row mid-stream.
 *   - The row's `workspaceId` is re-exported as PAPERCUSP_WORKSPACE — the
 *     carrier claude's user-level MCP url (`${PAPERCUSP_WORKSPACE:-}`) and
 *     omp's x-papercusp-workspace header expand at connect. Without it a
 *     resumed session lost workspace scoping and every workspace-scoped
 *     tool failed "no workspace transaction".
 * Untracked sessions (no adv row) have neither → fresh SID, no workspace;
 * the operator's SID→adv-row fallback can't help those either.
 *
 * `fork: true` INVERTS the identity rule on purpose: a fork is a genuinely new
 * session, not a second body of the original, so it ALWAYS gets a fresh SID and
 * NO adv-row link — that is what lets a fork run concurrently with the still-live
 * original without colliding on its locks/presence/inbox-wake. Workspace scope
 * still carries over (the fork stays in the same workspace).
 *
 * `ownerId` PRE-PINS that fresh id instead of minting a random one
 * (consult-expert-routing-2026-09-22 P-003 — a consult names its responder
 * before the answering session boots). It applies to the FORK branch ONLY: on a
 * plain resume the recorded coord id is the whole point of the branch below, and
 * overriding it there would strand the original's locks/awaits/presence, which is
 * the exact regression the fresh-random-SID resume caused.
 */
export function resumeEnvFor(
  session,
  { mintSid = () => `su-${randomUUID()}`, fork = false, ownerId = null } = {},
) {
  if (fork) {
    return {
      PAPERCUSP_AGENT: session.agent,
      PAPERCUSP_SID: ownerId || mintSid(),
      ...(session.workspaceId
        ? { PAPERCUSP_WORKSPACE: session.workspaceId }
        : {}),
      ...(session.harnessSlug
        ? { PAPERCUSP_HARNESS_SLUG: session.harnessSlug }
        : {}),
    };
  }
  return {
    PAPERCUSP_AGENT: session.agent,
    PAPERCUSP_SID: session.coordOwnerId || mintSid(),
    ...(session.workspaceId
      ? { PAPERCUSP_WORKSPACE: session.workspaceId }
      : {}),
    ...(session.harnessSlug
      ? { PAPERCUSP_HARNESS_SLUG: session.harnessSlug }
      : {}),
    ...(session.id != null
      ? { PAPERCUSP_ADV_SESSION_ID: String(session.id) }
      : {}),
  };
}

/**
 * Decide how the account is chosen for a RESUME launch. Pure — exported for
 * tests. The gateway account pin is spawn-env only (never persisted on the
 * session), so a resume otherwise silently falls back to the default credential
 * (verified: launchResume never re-folds gatewaySpawnEnv). Option 1 (owner,
 * 2026-06-19): re-prompt on an interactive resume, neutral default.
 *   - explicit `--account` → honored in ANY mode (no prompt)
 *   - interactive (picker)  → prompt (pickAccount; itself a no-op + no prompt
 *                             when the gateway is off / the pool is empty)
 *   - --no-picker scripting → none → default credential, byte-identical to the
 *                             pre-account resume (no surprise prompt in scripts)
 */
export function resumeAccountPlan(args) {
  if (args.account)
    return { source: "flag", account: args.account, prompt: false };
  if (args.picker) return { source: "prompt", account: null, prompt: true };
  return { source: "none", account: null, prompt: false };
}

/**
 * The full env for a resume launch — identity + workspace scope (resumeEnvFor),
 * the psu agent-session marker, and the re-pinned account env. Pure — exported
 * for tests. With no `accountEnv`, the account routing stays byte-identical to
 * the pre-account resume; `accountEnv.env` layers the gateway pin on top.
 * @param {*} session
 * @param {{fork?: boolean, brain?: boolean, accountEnv?: {mode?: string, id?: string | null, env?: Record<string, string>} | null, ownerId?: string | null}} [options]
 */
export function buildResumeEnv(
  session,
  { fork = false, brain = false, accountEnv = null, ownerId = null } = {},
) {
  return {
    ...resumeEnvFor(session, { fork, ownerId }),
    // Anything launched/resumed through psu is an agent session for hook
    // purposes. Direct non-psu Claude terminals remain unmarked and keep the
    // owner-session exemption in pretooluse-bash-resource-gate.sh.
    PAPERCUSP_AGENT_SESSION: "1",
    // P-022: a resume spawns a NEW CLI process, so the native-compaction
    // retirement env must be re-stamped exactly as on a fresh launch — without
    // it a resumed Claude session silently regains native auto-compact + /compact.
    ...nativeCompactionEnv(session?.agent),
    // Same again for the alternate-screen switch: a resumed CLI that boots into the
    // fullscreen TUI loses its whole epoch from the console at the next cut.
    ...terminalRenderEnv(session?.agent),
    // Same rationale for the context-trimming trio (WI-2140943 lane 2): a resume
    // spawns a NEW CLI, and a gateway-routed claude without ENABLE_TOOL_SEARCH /
    // PAPERCUSP_TOOLS / PAPERCUSP_CONTEXT_TIER boots with the whole catalog inline.
    ...contextTrimmingEnv(session?.agent),
    ...(accountEnv?.env ?? {}),
    // Codex keeps the route in config.toml, so its account env is otherwise
    // empty. The managed host needs this choice when it rebuilds that config
    // during a carry; it cannot infer the choice after the rebuild erased it.
    ...(session?.agent === "codex" && accountEnv?.mode
      ? {
          [ACCOUNT_ROUTING_MODE_ENV]: accountEnv.mode,
          ...(accountEnv.mode === "pin" && accountEnv.id
            ? { PAPERCUSP_ACCOUNT_ID: accountEnv.id }
            : {}),
        }
      : {}),
  };
}

/** Restore the per-session OMP store a tracked launch created. Fresh OMP
 * launches pin BOTH variables because PI_CODING_AGENT_DIR overrides
 * PI_CONFIG_DIR; resumes must do the same or `omp -r <native-id>` searches the
 * global ~/.omp store and reports a perfectly valid tracked thread as missing.
 * The config dir remains home-relative because OMP joins it onto homedir().
 *
 * Also re-heals `agent.db` → global OAuth store (linkOmpAgentDb): pre-fix
 * sessions have an empty real-file agent.db, so a resume without this would
 * keep dropping xai-oauth / other logins even after a fresh-launch fix.
 * @returns {NodeJS.ProcessEnv}
 */
export function ompTrackedResumeEnv(session, { home = homedir() } = {}) {
  if (session?.agent !== "omp" || session?.id == null) return {};
  const rel = ompSessionConfigRelativeDir(session.id, home);
  const root = join(home, rel);
  if (!existsSync(root)) return {};
  const agentDir = join(root, "agent");
  linkOmpAgentDb(join(home, ".omp", "agent"), agentDir);
  // The launcher moved eligible servers out of the stock MCP map. A resume
  // from a new shell must therefore load the adapter from this saved profile,
  // not from an opt-in env var the shell may no longer export. Conversely a
  // legacy HTTP profile must not inherit a parent's unrelated UDS opt-in.
  const configPath = join(agentDir, "mcp.json");
  let transportEnv = {};
  if (existsSync(configPath)) {
    let config;
    try { config = JSON.parse(readFileSync(configPath, "utf8")); }
    catch { throw new Error("Saved OMP MCP configuration is unreadable; refusing an incomplete resume"); }
    const native = config?.papercuspNativeMcp;
    if (native && (native.version !== 1 || !["uds", "auto"].includes(native.mode) ||
        !native.servers || !Object.keys(native.servers).length))
      throw new Error("Saved OMP native MCP configuration is invalid; refusing an incomplete resume");
    if (native && session.role && !launchesOnSuTier(session.role))
      throw new Error("Saved SU native MCP configuration cannot be used by a role-scoped resume");
    transportEnv = { PAPERCUSP_MCP_TRANSPORT: native?.mode ?? "http" };
  }
  return {
    PI_CONFIG_DIR: rel,
    PI_CODING_AGENT_DIR: agentDir,
    ...transportEnv,
  };
}

export function ompDirectModelForRoute(model) {
  const value = String(model || "").trim();
  if (!/^papercusp-gateway\//i.test(value)) return model;
  const route = ompGatewayModelFromSpec(value);
  if (!route) {
    throw new Error(
      `OMP gateway selector '${value}' cannot be restored to a compatible direct provider; refusing model substitution`,
    );
  }
  return `${route.gatewayProvider}/${route.modelId}`;
}

/** Apply a selected OMP route to the exact per-session registry used by resume.
 * Auto/pin replace models.yml with the generated gateway provider; default
 * restores the global direct registry so switching modes is reversible. */
export function applyOmpResumeAccountRoute({
  session,
  env,
  accountRoute,
  model,
  home = homedir(),
}) {
  if (session?.agent !== "omp") return model;
  const mode = accountRoute?.mode ?? "default";
  const selectedModel = String(model || "").trim();
  const modelRoute = selectedModel
    ? ompGatewayModelFromSpec(selectedModel)
    : null;
  const agentDir = env?.PI_CODING_AGENT_DIR;
  if (!agentDir) {
    if (mode !== "default") {
      throw new Error(
        "selected OMP gateway route cannot be applied: this resume has no isolated session registry; refusing direct/default fallback",
      );
    }
    return ompDirectModelForRoute(model);
  }
  mkdirSync(agentDir, { recursive: true });
  const target = join(agentDir, "models.yml");
  if (mode === "default") {
    const source = join(home, ".omp", "agent", "models.yml");
    if (!existsSync(source)) {
      throw new Error(
        "default OMP route cannot be restored: ~/.omp/agent/models.yml is missing",
      );
    }
    copyFileSync(source, target);
    return ompDirectModelForRoute(model);
  }
  if (selectedModel && !modelRoute) {
    throw new Error(
      `OMP model '${selectedModel}' is not compatible with gateway account routing; refusing model substitution`,
    );
  }
  if (
    modelRoute &&
    accountRoute?.provider &&
    accountRoute.provider !== modelRoute.accountProvider
  ) {
    throw new Error(
      `selected OMP model '${selectedModel}' requires ${modelRoute.accountProvider} accounts, but the resume route resolved ${accountRoute.provider}; refusing model substitution`,
    );
  }
  const config = ompGatewayModelsConfig({
    accountId: mode === "pin" ? accountRoute.id : null,
    gatewayOn: mode === "auto",
    provider: modelRoute?.gatewayProvider ?? "anthropic",
    ownerId: session.coordOwnerId,
    models: modelRoute ? [modelRoute.modelId] : undefined,
  });
  if (!config) {
    throw new Error(
      `selected OMP ${mode} route could not be rendered; refusing direct/default fallback`,
    );
  }
  writeFileSync(target, config.content, { mode: 0o600 });
  return config.modelSelector;
}

/** The per-account routing header the inference gateway reads + the claude CLI forwards (via
 *  ANTHROPIC_CUSTOM_HEADERS). MUST equal the server's `ACCOUNT_HEADER` (gateway.ts) — pinned in
 *  lockstep by a test. Duplicated here (not imported) so the standalone launcher stays dependency-light. */
export const GATEWAY_ACCOUNT_HEADER = "x-papercusp-account";

/** The SESSION-IDENTITY header the inference gateway reads to resolve a LIVE, per-request dynamic
 *  pin (account-dynamic-pin-2026-06-29's `ownerPinMap`, set via `accounts:pin`/`accounts:unpin` and
 *  read BEFORE the static `x-papercusp-account` header — gateway.ts `wantAccount = dynPin?.accountId
 *  ?? wantAccountHeader`). MUST equal the server's `OWNER_HEADER` (gateway.ts) — pinned in lockstep by
 *  a test. The fresh-spawn path (spawn-env.ts `gatewaySpawnEnv`) already sends this; the RESUME path
 *  historically never did (WI-4402), which meant `accounts:pin` could set a durable, live re-pin for
 *  ANY owner id but it could never actually reach a `psu --resume`'d session's requests — the dynamic
 *  re-pin mechanism was already fully built (live, durable across gateway restarts) and simply
 *  unreachable from this one launch path. Duplicated here (not imported), same reasoning as
 *  GATEWAY_ACCOUNT_HEADER. */
export const GATEWAY_OWNER_HEADER = "x-papercusp-owner";

/** Non-secret bearer used only to make a gateway-routed Claude CLI pass its local
 * login gate. The gateway strips it and injects the selected account's real OAuth.
 * MUST equal operator-core inference-gateway/spawn-env.ts GATEWAY_CLIENT_AUTH_TOKEN. */
export const GATEWAY_CLIENT_AUTH_TOKEN = "papercusp-gateway";

/**
 * The inference-gateway pin env for an account, built CLIENT-SIDE. Pure — exported for tests. Mirrors
 * the server's gatewaySpawnEnv + resolveAccountPin exactly: point the agent at the localhost gateway
 * (which injects the account's OAuth) + carry the per-account routing header the claude CLI forwards.
 * The fresh-launch path gets this folded by the bootstrap-su POST; the RESUME path (no POST) builds it
 * here so it never depends on a server endpoint that may not be deployed where the launcher points.
 *
 * `ownerId` (WI-4402): when provided, ALSO carries the session-identity header (GATEWAY_OWNER_HEADER)
 * so a LIVE `accounts:pin { agent: ownerId, account }` (already durable, already live-effective
 * per-request — no new mechanism) can dynamically re-route this resumed session with no respawn.
 * Omit to keep today's exact behavior (no identity header) — used by existing callers/tests.
 */
export function gatewayPinEnv(
  account,
  provider = "claude",
  ownerId = undefined,
) {
  if (provider === "codex") {
    return { PAPERCUSP_ACCOUNT_ID: account };
  }
  const p = Number(process.env.PAPERCUSP_GATEWAY_PORT);
  const port = Number.isFinite(p) && p > 0 ? p : 8788;
  const headers = [`${GATEWAY_ACCOUNT_HEADER}: ${account}`];
  if (ownerId) headers.push(`${GATEWAY_OWNER_HEADER}: ${ownerId}`);
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: GATEWAY_CLIENT_AUTH_TOKEN,
    ANTHROPIC_CUSTOM_HEADERS: headers.join("\n"),
    PAPERCUSP_ACCOUNT_ID: account,
    [ACCOUNT_ROUTING_MODE_ENV]: "pin",
  };
}

/**
 * account-routing-3-options (owner, 2026-06-30): the ONE `account` value carries THREE explicit
 * routing modes (mirrors the server's resolveAccountPin keyword handling exactly — kept in lockstep
 * by a test):
 *   - 'default' — '', null, `default`, `none`, `system` → skip the gateway, use the system / CLI
 *                 login credential (THE DEFAULT).
 *   - 'auto'    — `auto`, `gateway` → route through the inference gateway with NO account pin; it
 *                 selects an available pool account and fails over.
 *   - 'pin'     — any other value → a specific pool account id, pinned via the gateway (hard, no
 *                 failover).
 * Pure — exported for tests. The keywords are reserved, so a pool account literally named
 * `auto`/`default`/`none`/`system`/`gateway` can't be pin-targeted (same tradeoff the server makes).
 *
 * ⚠ ONE DELIBERATE DIVERGENCE from the server (default-deploy-account-2026-08-08 P-004 split what
 * used to be one branch): server-side, '' / `default` mean "the owner's NOMINATED default account"
 * — a GATEWAY route (as `auto`) whenever a workspace has one configured — while only `none` /
 * `system` are guaranteed to skip the gateway. This client keeps all four in the 'default' bucket
 * because it is the RESUME path, which builds its env locally and cannot read the nominated
 * account. So never emit '' / null / `default` on a path whose intent is "the machine's own login":
 * emit `system`. (That is why the picker's default row carries `system`.)
 */
export function accountRoutingMode(value) {
  const v = (value == null ? "" : String(value)).trim().toLowerCase();
  if (v === "" || v === "default" || v === "none" || v === "system")
    return "default";
  if (v === "auto" || v === "gateway") return "auto";
  return "pin";
}

/**
 * Return whether raw Codex auth.json content contains a usable ChatGPT access
 * token. Pure and secret-free: this only parses the shape needed by the Codex
 * CLI, and never returns or logs token contents.
 *
 * A fresh isolated CODEX_HOME inherits the user's auth.json as a symlink. When
 * that source is absent (or malformed), Codex falls through to its interactive
 * sign-in screen; a headless launch then remains alive forever waiting on fd0.
 * Keep this predicate aligned with the gateway's readCodexAuth contract.
 */
export function codexAuthJsonReady(raw) {
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return false;
    const tokens = parsed.tokens;
    return Boolean(
      tokens &&
      typeof tokens === "object" &&
      !Array.isArray(tokens) &&
      typeof tokens.access_token === "string" &&
      tokens.access_token.trim(),
    );
  } catch {
    return false;
  }
}

/**
 * Preflight the credential a FRESH headless Codex launch will actually use.
 * Gateway auto/pin routes do not consume the machine's ~/.codex login and all
 * non-Codex/non-headless launches retain their existing behavior.
 *
 * The filesystem reader is injectable so the decision remains deterministic in
 * tests. The returned reason is diagnostic only and never includes credentials.
 *
 * @param {{
 *   agent?: string | null,
 *   headless?: boolean,
 *   account?: string | null,
 *   codexHome?: string | null,
 *   readFile?: (path: string, encoding: string) => string,
 * }} [opts]
 */
export function codexFreshDefaultAuthPreflight({
  agent,
  headless = false,
  account = null,
  codexHome = null,
  readFile = readFileSync,
} = {}) {
  if (
    agent !== "codex" ||
    headless !== true ||
    accountRoutingMode(account) !== "default"
  )
    return { checked: false, ready: true, reason: "not-required" };
  if (!codexHome)
    return { checked: true, ready: false, reason: "missing-codex-home" };
  let raw;
  try {
    raw = readFile(join(codexHome, "auth.json"), "utf8");
  } catch {
    return { checked: true, ready: false, reason: "missing-auth-json" };
  }
  if (!codexAuthJsonReady(raw))
    return { checked: true, ready: false, reason: "unusable-auth-json" };
  return { checked: true, ready: true, reason: "ready" };
}

/** Parse the refresh ordering key for a persistent ChatGPT login without ever
 * returning credential material to the caller. `mtimeMs` is the fallback for
 * older Codex versions that did not write `last_refresh`. */
function codexPersistentAuthCandidate(raw, mtimeMs = 0) {
  try {
    const parsed = JSON.parse(String(raw));
    if (
      parsed?.auth_mode !== "chatgpt" ||
      !codexAuthJsonReady(raw) ||
      typeof parsed?.tokens?.refresh_token !== "string" ||
      !parsed.tokens.refresh_token.trim()
    )
      return null;
    const refreshedAt = Date.parse(String(parsed.last_refresh || ""));
    return {
      freshness: Number.isFinite(refreshedAt)
        ? refreshedAt
        : Number(mtimeMs) || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Reconcile Codex's canonical system login from isolated PSU homes.
 *
 * A fresh PSU Codex launch runs under a per-session `CODEX_HOME`. When
 * `~/.codex/auth.json` is absent, the home writer has no canonical file to
 * symlink, so interactive `codex login` writes a real auth.json into that ONE
 * session. Without reconciliation every later launch starts empty and asks the
 * owner to authenticate again. Codex may also atomically replace an inherited
 * symlink during refresh, producing the same real-file fork.
 *
 * Reuse the established Claude credential rule: newest valid refresh wins.
 * Only real files with a complete ChatGPT access+refresh token participate;
 * symlinks, gateway/API-key auth, malformed files, and partial logins are
 * ignored. Promotion is an atomic 0600 rename, with a final freshness recheck
 * so concurrent launchers cannot overwrite a newer canonical login with an
 * older snapshot. The return value is deliberately secret-free.
 *
 * @param {{ home?: string }} [opts]
 * @returns {{ promoted: boolean, reason: string, sourceSession?: string }}
 */
export function reconcileCodexSystemAuth({ home = homedir() } = {}) {
  const globalDir = join(home, ".codex");
  const globalPath = join(globalDir, "auth.json");
  const candidateAt = (p) => {
    try {
      const st = statSync(p);
      const raw = readFileSync(p, "utf8");
      const candidate = codexPersistentAuthCandidate(raw, st.mtimeMs);
      return candidate ? { ...candidate, raw } : null;
    } catch {
      return null;
    }
  };

  const global = candidateAt(globalPath);
  let best = null;
  let dirs = [];
  try {
    dirs = readdirSync(join(home, ".papercusp", "su-codex-homes"), {
      withFileTypes: true,
    });
  } catch {
    return { promoted: false, reason: "no-isolated-homes" };
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const p = join(home, ".papercusp", "su-codex-homes", dir.name, "auth.json");
    try {
      if (lstatSync(p).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    const candidate = candidateAt(p);
    if (
      candidate &&
      candidate.freshness > (global?.freshness ?? 0) &&
      candidate.freshness > (best?.freshness ?? 0)
    )
      best = { ...candidate, sourceSession: dir.name };
  }
  if (!best) return { promoted: false, reason: "canonical-current" };

  let tempPath = null;
  try {
    mkdirSync(globalDir, { recursive: true, mode: 0o700 });
    tempPath = join(
      globalDir,
      `.auth.json.psu-reconcile-${process.pid}-${randomBytes(6).toString("hex")}`,
    );
    writeFileSync(tempPath, best.raw, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(tempPath, 0o600);
    // A concurrent launcher may have promoted a still-newer refresh while this
    // process prepared its temp file. Never move the canonical clock backward.
    const current = candidateAt(globalPath);
    if (current && current.freshness >= best.freshness)
      return { promoted: false, reason: "canonical-current" };
    renameSync(tempPath, globalPath);
    tempPath = null;
    chmodSync(globalPath, 0o600);
    return {
      promoted: true,
      reason: global
        ? "newer-isolated-login"
        : "recovered-missing-system-login",
      sourceSession: best.sourceSession,
    };
  } catch {
    return { promoted: false, reason: "write-failed" };
  } finally {
    if (tempPath) {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  }
}

/** Explicit launch-envelope marker for the direct system/CLI credential route.
 * It must be envelope state (not inherited ambient state), because runWrapper uses
 * it to clear every higher-precedence Claude credential before restoring the
 * machine's default login. */
export const ACCOUNT_ROUTING_MODE_ENV = "PAPERCUSP_ACCOUNT_ROUTING_MODE";

/** The transparent prompt-cache proxy (papercup-cache-proxy.service, P-006). Default-account
 *  sessions point ANTHROPIC_BASE_URL here so the cache-policy body rewrite (extended ttl + the
 *  org-shared tools-span breakpoint) covers them too — they are the LARGEST sharing cohort, and
 *  they deliberately skip the inference gateway, which is the only other rewrite point.
 *  This is NOT an account change: the proxy forwards this session's own credentials verbatim. */
export const CACHE_PROXY_URL = () =>
  process.env.PAPERCUSP_CACHE_PROXY_URL ||
  `http://127.0.0.1:${Number(process.env.PAPERCUSP_CACHE_PROXY_PORT) || 9073}`;

/** Spawn-time liveness gate for the cache proxy, memoized per launcher process.
 *  A DOWN proxy must never block or break a launch: we simply omit ANTHROPIC_BASE_URL and the
 *  session talks to Anthropic directly, exactly as it does today (degrade, never fail). The probe
 *  hits the proxy's LOCAL health route, so it costs nothing upstream. */
let _cacheProxyUp = null;
/** Test seam: force the probe result (and reset the memo) so unit tests stay deterministic
 *  regardless of whether this machine happens to be running the proxy. */
export function __setCacheProxyReachable(v) {
  _cacheProxyUp = v;
}
export function cacheProxyReachable() {
  if (_cacheProxyUp !== null) return _cacheProxyUp;
  if (process.env.PAPERCUSP_CACHE_PROXY_ROUTE === "1")
    return (_cacheProxyUp = true);
  if (process.env.PAPERCUSP_CACHE_PROXY_ROUTE === "0")
    return (_cacheProxyUp = false);
  // Under vitest the launcher's pure-function contracts are asserted directly; a live probe
  // would make them depend on this machine's running services. Opt in explicitly instead.
  if (process.env.VITEST) return (_cacheProxyUp = false);
  try {
    const out = execFileSync(
      "curl",
      [
        "-s",
        "--max-time",
        "2",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        `${CACHE_PROXY_URL()}/__cache_proxy_health`,
      ],
      { encoding: "utf8", timeout: 4000 },
    );
    _cacheProxyUp = String(out).trim() === "200";
  } catch {
    _cacheProxyUp = false;
  }
  return _cacheProxyUp;
}

/** Is this base URL our transparent cache proxy (as opposed to an inference-gateway route)?
 *  The distinction matters because the default-account enforcement below CLEARS a base URL —
 *  it exists to stop an inherited GATEWAY route from silently overriding the system login.
 *  The cache proxy is the opposite: it carries the system login through untouched, so it must
 *  survive that clearing. Compared structurally (host+port), not by string, so an equivalent
 *  spelling (localhost vs 127.0.0.1, trailing slash) still matches. */
export function isCacheProxyUrl(url) {
  if (!url) return false;
  try {
    const a = new URL(String(url));
    const b = new URL(CACHE_PROXY_URL());
    const localhost = (h) =>
      h === "localhost" || h === "127.0.0.1" || h === "::1" ? "127.0.0.1" : h;
    return (
      localhost(a.hostname) === localhost(b.hostname) &&
      (a.port || "80") === (b.port || "80")
    );
  } catch {
    return false;
  }
}

export function defaultAccountEnv() {
  const env = { [ACCOUNT_ROUTING_MODE_ENV]: "default" };
  if (cacheProxyReachable()) env.ANTHROPIC_BASE_URL = CACHE_PROXY_URL();
  return env;
}

/**
 * The inference-gateway AUTO-route env, built CLIENT-SIDE. Pure — exported for tests. Mirrors the
 * server's gatewaySpawnEnv(true, {}) for the no-account case: point the agent at the localhost
 * gateway with NO `x-papercusp-account` header, so the gateway auto-selects an available pool
 * account and fails over. Claude carries this route in environment variables.
 * Codex and OMP carry the equivalent unpinned route in per-session config files,
 * so their callers use the returned route mode rather than this helper's env payload.
 *
 * `ownerId` (WI-4402): same session-identity-header treatment as gatewayPinEnv above — carries
 * GATEWAY_OWNER_HEADER when provided (no-op if omitted, unchanged for existing callers/tests) so a
 * LIVE accounts:pin can dynamically move this auto-routed resumed session between pool accounts.
 *
 * WI-39692: the `@param` types below are LOAD-BEARING, not decoration. `psu-launcher.d.mts` is
 * GENERATED from this JSDoc (`npm run gen:declarations`), and without them tsc infers each
 * parameter's type from its DEFAULT VALUE alone — so `ownerId = undefined` was published as
 * `ownerId?: undefined`, making the ownerId feature this very comment documents impossible to
 * call from any TypeScript caller. Do not delete them to "simplify".
 *
 * @param {string} [provider]
 * @param {string} [ownerId]
 */
export function gatewayAutoEnv(provider = "claude", ownerId = undefined) {
  if (provider !== "claude") return {};
  const p = Number(process.env.PAPERCUSP_GATEWAY_PORT);
  const port = Number.isFinite(p) && p > 0 ? p : 8788;
  const env = {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: GATEWAY_CLIENT_AUTH_TOKEN,
    [ACCOUNT_ROUTING_MODE_ENV]: "auto",
  };
  if (ownerId)
    env.ANTHROPIC_CUSTOM_HEADERS = `${GATEWAY_OWNER_HEADER}: ${ownerId}`;
  return env;
}

/**
 * True only for an explicit AUTO route whose model is served by the Codex/OpenAI pool.
 * OMP is provider-polymorphic, so its selected model — not the OMP process name — decides.
 *
 * @param {string | null | undefined} agent
 * @param {string | null | undefined} model
 * @param {string | null | undefined | { mode?: string, provider?: string }} account
 */
function isCodexAutoRoute(agent, model, account) {
  const route = account && typeof account === "object" ? account : null;
  const mode = route?.mode ?? accountRoutingMode(account);
  if (mode !== "auto") return false;
  const provider =
    route?.provider ??
    (agent === "codex"
      ? "codex"
      : agent === "omp"
        ? ompGatewayModelFromSpec(String(model || ""))?.accountProvider
        : "claude");
  return provider === "codex";
}

/** Env escape hatch: launch anyway despite a provably-walled auto-route pool. */
export const ALLOW_WALLED_LAUNCH_ENV = "PAPERCUSP_ALLOW_WALLED_LAUNCH";

/**
 * Exit code for a launch REFUSED because its account pool is provably walled.
 * Distinct from 1 on purpose: a dispatcher can tell "this launch is futile until
 * capacity returns, do not re-dispatch" apart from "the launch crashed, retry".
 */
export const WALLED_POOL_REFUSAL_EXIT = 78;

/**
 * Verdict for a Codex auto-route launch, from a live gateway `/stats` snapshot.
 *
 * THREE outcomes, deliberately not two:
 *  - `proceed` — nothing affirmative says the pool is walled. Missing, legacy and
 *    deploy-skewed stats all land here: a down or older gateway must never block psu.
 *  - `warn` — the pool reads fully walled, but the snapshot CONTRADICTS ITSELF: its
 *    own earliest-recovery horizon has already passed, so capacity may well be back
 *    and the reading merely stale. Say so and launch anyway.
 *  - `refuse` — fully walled with no recovery yet due. Every model call this launch
 *    makes would 429 immediately, so the spawn can only burn capacity, a task slot
 *    and a log file.
 *
 * Why `refuse` exists at all: this function's ancestor COMPUTED the futility and
 * launched regardless ("the launch will continue"). Measured 2026-09-11 over 3h of
 * grading-audit judges — 342 launches into this exact state, 336 dying quota-terminal,
 * and ZERO emitting a card — while the same walled pool starved every other agent
 * (EI-22976924584016603). Fail-open is right for an UNCERTAIN snapshot; it is how one
 * walled pool becomes hundreds of futile spawns when the snapshot is certain.
 *
 * @param {{
 *   agent?: string | null,
 *   model?: string | null,
 *   account?: string | null | { mode?: string, provider?: string },
 *   stats?: { codexHealthyAccounts?: number, codexTotalAccounts?: number, codexEarliestRecoveryAt?: number | null } | null,
 *   now?: number
 * }} input
 * @returns {{ kind: 'proceed' | 'warn' | 'refuse', message: string | null, recoveryAt: number | null }}
 */
export function codexAutoPoolVerdict({
  agent,
  model,
  account,
  stats,
  now = Date.now(),
} = {}) {
  const proceed = { kind: "proceed", message: null, recoveryAt: null };
  if (!isCodexAutoRoute(agent, model, account)) return proceed;
  if (!stats || typeof stats !== "object") return proceed;
  const healthy = stats.codexHealthyAccounts;
  const total = stats.codexTotalAccounts;
  const hasRecovery = Object.prototype.hasOwnProperty.call(
    stats,
    "codexEarliestRecoveryAt",
  );
  const rawRecovery = stats.codexEarliestRecoveryAt;
  // Speak only from the complete stats contract introduced with this guard.
  // Number(null) and Number("") are both zero; coercing either would turn an
  // unknown/legacy snapshot into a false all-walled verdict — and now that the
  // certain case REFUSES, a false positive strands a launch instead of merely
  // printing a wrong line. The pre-P-006 gateway also exposed
  // codexHealthyAccounts without the denominator/horizon, so require all three
  // fields before speaking with certainty.
  if (
    healthy !== 0 ||
    !Number.isInteger(total) ||
    total <= 0 ||
    !hasRecovery ||
    (rawRecovery !== null &&
      (typeof rawRecovery !== "number" || !Number.isFinite(rawRecovery)))
  )
    return proceed;
  const count = `0 of ${total}`;
  const recovery =
    typeof rawRecovery === "number" && Number.isFinite(rawRecovery)
      ? rawRecovery
      : null;
  // A horizon already in the PAST is the one all-walled snapshot we decline to act
  // on: the gateway itself predicted capacity back by now, so `healthy: 0` may be a
  // stale read rather than a live wall. Warn and launch — never refuse on a
  // self-contradicting snapshot.
  if (recovery !== null && recovery <= now)
    return {
      kind: "warn",
      recoveryAt: recovery,
      message:
        `psu: WARNING — Codex auto-route pool reads fully walled (${count} ChatGPT accounts serviceable), ` +
        `but its own earliest recovery ${new Date(recovery).toISOString()} has already passed, so the snapshot may be stale. ` +
        "Launching anyway; the first model call will fail fast with 429 if capacity has not in fact returned.",
    };
  const horizon =
    recovery === null
      ? "; earliest recovery unknown"
      : `; earliest known recovery ${new Date(recovery).toISOString()}`;
  return {
    kind: "refuse",
    recoveryAt: recovery,
    message:
      `psu: REFUSING TO LAUNCH — Codex auto-route pool is fully walled: ${count} ChatGPT accounts serviceable${horizon}. ` +
      "Every model call would fail fast with 429, so this launch can only burn a spawn, a task slot and a log file. " +
      "Re-route instead: --agent claude (auto-routing is PROVIDER-SCOPED, so no --account value can cross providers), " +
      "or --account default to skip the gateway, or wait for the recovery above. " +
      `Override with ${ALLOW_WALLED_LAUNCH_ENV}=1 if you know this snapshot is wrong.`,
  };
}

/**
 * Launch preflight against the live gateway. Returns TRUE when the launch may proceed.
 *
 * FAIL-OPEN EVERYWHERE EXCEPT ONE CASE: a down, slow, unreachable or older gateway
 * never blocks psu (every failure path below returns true). Only a live,
 * self-describing, internally-consistent all-walled snapshot refuses — see
 * `codexAutoPoolVerdict` for why that one case stops being advisory.
 *
 * @param {{
 *   agent?: string | null,
 *   model?: string | null,
 *   account?: string | null | { mode?: string, provider?: string },
 *   fetchImpl?: typeof fetch,
 *   log?: (message: string) => void,
 *   port?: number,
 *   timeoutMs?: number,
 *   env?: Record<string, string | undefined>
 * }} input
 * @returns {Promise<boolean>} false ⇒ the caller MUST abort the launch.
 */
export async function preflightCodexAutoPool({
  agent,
  model,
  account,
  fetchImpl = fetch,
  log = console.error,
  port,
  timeoutMs = 1_200,
  env = process.env,
} = {}) {
  if (!isCodexAutoRoute(agent, model, account)) return true;
  const envPort = Number(env.PAPERCUSP_GATEWAY_PORT);
  const gatewayPort =
    Number.isFinite(port) && port > 0
      ? port
      : Number.isFinite(envPort) && envPort > 0
        ? envPort
        : 8788;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${gatewayPort}/stats`, {
      signal: controller.signal,
    });
    if (!response?.ok) return true;
    const stats = await response.json();
    const verdict = codexAutoPoolVerdict({ agent, model, account, stats });
    if (verdict.kind === "proceed") return true;
    const refused = verdict.kind === "refuse";
    const overridden = refused && env[ALLOW_WALLED_LAUNCH_ENV] === "1";
    log(
      overridden
        ? `${verdict.message}\npsu: ${ALLOW_WALLED_LAUNCH_ENV}=1 is set — launching anyway.`
        : String(verdict.message),
    );
    return !refused || overridden;
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Strip ONLY the managed ROOT block (`model_provider = "papercusp-codex-gateway"`),
 * leaving the `[model_providers.papercusp-codex-gateway]` TABLE in place. With no
 * root key codex falls back to its built-in `openai` provider — the same state a
 * fresh default-route home is in — while a rollout that names the gateway
 * provider still resolves it (WI-38706). Pure; exported for tests.
 *
 * @param {string} configText
 */
export function stripCodexGatewayRoot(configText) {
  return String(configText || "")
    .replace(
      /# BEGIN PAPERCUSP_CODEX_GATEWAY_ROOT\n[\s\S]*?# END PAPERCUSP_CODEX_GATEWAY_ROOT\n?/g,
      "",
    )
    .replace(/^\n+/, "");
}

export function stripCodexGatewayConfig(configText) {
  return stripCodexGatewayRoot(configText)
    .replace(
      /# BEGIN PAPERCUSP_CODEX_GATEWAY_PROVIDER\n[\s\S]*?# END PAPERCUSP_CODEX_GATEWAY_PROVIDER\n?/g,
      "",
    )
    .replace(/^\n+/, "");
}

/**
 * Rewrite a codex `config.toml`'s papercusp gateway block for THIS launch's route.
 *
 * WI-39692: the `@param` types are LOAD-BEARING — see the note on gatewayAutoEnv above.
 * `psu-launcher.d.mts` is GENERATED from this JSDoc, and inference-from-default published
 * `ownerId?: null | undefined` (from `ownerId = null`), so passing a real owner id was a
 * type error for every TS caller even though the runtime has always accepted one.
 *
 * @param {string} configText  the existing config.toml text ('' when absent)
 * @param {string | null} [account]  the account id to PIN to, or null for the unpinned/default route
 * @param {{ gatewayOn?: boolean, ownerId?: string | null, priority?: string | null, keepProviderTableWhenUnrouted?: boolean }} [opts]
 * @returns {string}
 */
export function codexGatewayConfigPatch(
  configText,
  account = null,
  {
    gatewayOn = false,
    ownerId = null,
    priority = null,
    keepProviderTableWhenUnrouted = false,
  } = {},
) {
  const stripped = stripCodexGatewayConfig(configText).trimEnd();
  const patch = codexGatewayConfigToml(account, {
    gatewayOn,
    ownerId,
    priority,
  });
  if (!patch.root.length && !patch.tables.length) {
    // WI-38706: "no gateway route for THIS launch" must not mean "delete the
    // provider table this thread's rollout names". codex stamps the provider
    // id into every rollout's `session_meta`, then resolves it against the
    // CURRENT config at `thread/resume` — so stripping the table out from
    // under a gateway-born thread fails the resume outright ("Model provider
    // `papercusp-codex-gateway` not found", -32600).
    //
    // EI-22086713788860638: the ROOT key is a different thing. It is what
    // SELECTS the provider for the resumed session — codex resumes with the
    // current config's `model_provider`, never the stamped one — so keeping the
    // whole file byte-identical (the pre-fix behaviour) is how a "default"
    // resume of a gateway-born thread silently stayed on :8788 (EI-22039). An
    // unrouted resume therefore keeps the TABLE and drops only the ROOT block;
    // with no root key codex falls back to its built-in `openai` provider,
    // exactly the state of a fresh default-route home.
    if (keepProviderTableWhenUnrouted) return stripCodexGatewayRoot(configText);
    return stripped ? `${stripped}\n` : "";
  }
  return `${patch.root.join("\n")}${stripped ? `${stripped}\n\n` : ""}${patch.tables.join("\n")}`;
}

/** The provider id a codex rollout is BOUND to (`session_meta.model_provider`
 *  on its first line), or null. Read at resume so the route patch below cannot
 *  remove a provider the thread needs. Pure-ish (one file read); exported for
 *  tests. */
export function codexRolloutModelProvider(rolloutPath) {
  try {
    const fh = readFileSync(rolloutPath, "utf8");
    const firstLine = fh.slice(
      0,
      fh.indexOf("\n") === -1 ? fh.length : fh.indexOf("\n"),
    );
    const payload = JSON.parse(firstLine)?.payload;
    const p = payload?.model_provider;
    return typeof p === "string" && p ? p : null;
  } catch {
    return null;
  }
}

/**
 * Codex does NOT bind a thread to the provider stamped in its rollout. At
 * resume/fork it uses the CURRENT config's `model_provider` and sends that in
 * the thread/resume request (codex exec/src/lib.rs: `model_provider:
 * Some(config.model_provider_id.clone())`); the stamped
 * `session_meta.model_provider` is never compared. Measured on Codex 0.152.0
 * (EI-22086713788860638): a thread born on direct `openai` resumed under a
 * `papercusp-codex-gateway` config reported `provider: papercusp-codex-gateway`
 * and sent its turn to the gateway URL — via both `codex exec resume` and the
 * TUI `codex resume` psu spawns; a gateway-born thread resumed with the provider
 * TABLE kept and the root key dropped reported `provider: openai`. The only real
 * constraint is WI-38706's: the provider id the rollout names must still
 * RESOLVE in the config — which `keepProviderTableWhenUnrouted` guarantees.
 *
 * Until EI-22086713788860638 this function REFUSED any cross-family switch,
 * asserting that Codex "does not permit changing model providers on
 * resume/fork" — an inference EI-22039056757537981 drew from WI-38706's
 * missing-table failure and enforced as fact. It stranded a system-login thread
 * on an account at its usage wall when the owner asked to move it to the pool.
 * What remains is the DISCLOSURE half of EI-22039: the route the owner picked is
 * applied, and when it differs from the family the thread was born on, say so
 * before spawning. A missing binding (legacy rollout) says nothing.
 *
 * @param {string | null} boundProvider
 * @param {{ mode?: string, id?: string | null } | null} accountRoute
 * @param {{ fork?: boolean, sessionId?: string | null }} [opts]
 * @returns {string | null}
 */
export function codexResumeRouteNotice(
  boundProvider,
  accountRoute,
  { fork = false, sessionId = null } = {},
) {
  if (!boundProvider || !accountRoute?.mode) return null;
  const boundToGateway = boundProvider === CODEX_GATEWAY_PROVIDER_ID;
  const requestedGateway =
    accountRoute.mode === "auto" || accountRoute.mode === "pin";
  const requestedDefault = accountRoute.mode === "default";
  if (!requestedDefault && !requestedGateway) return null;
  if (boundToGateway === requestedGateway) return null;

  const operation = fork ? "forking" : "resuming";
  const thread = sessionId ? ` ${sessionId}` : "";
  const tail =
    "Codex resumes with the current config's model_provider (verified 0.152.0), so the switch is applied.";
  if (boundToGateway) {
    return (
      `psu: ${operation} Codex thread${thread} on the default system account (inference gateway skipped) — ` +
      `it was born on '${CODEX_GATEWAY_PROVIDER_ID}'; the provider table stays so the rollout still resolves. ${tail}`
    );
  }
  const route =
    accountRoute.mode === "pin" && accountRoute.id
      ? `pinned to account '${accountRoute.id}'`
      : "auto-routed across the pool";
  return (
    `psu: ${operation} Codex thread${thread} through the inference gateway (${route}) — ` +
    `it was born on direct provider '${boundProvider}'. ${tail}`
  );
}

const CODEX_CONTEXT_WINDOW_BEGIN = "# BEGIN PAPERCUSP_CODEX_CONTEXT_WINDOW";
const CODEX_CONTEXT_WINDOW_END = "# END PAPERCUSP_CODEX_CONTEXT_WINDOW";

/**
 * Upsert the extended-window keys into a codex `config.toml` (plan
 * codex-1m-context-window-2026-08-17 P-004). Pure — exported for tests.
 *
 * WHY THE FILE AND NOT JUST `-c`: `modelArgsFor` emits the overrides only when
 * a launch NAMES a model, and a bare `psu --resume` names none — so a resumed
 * session would silently drop back to codex's 272k default and start
 * native-compacting at ~258k, under the very soft limit this plan exists to
 * make reachable. The file is what a model-less resume inherits.
 *
 * ⚠ THE BLOCK IS PREPENDED, and that placement is load-bearing, not cosmetic:
 * these are ROOT keys, and in TOML a root key written after any `[table]`
 * header binds to that table instead. Emitting at the top is the only position
 * that is correct regardless of what the rest of the file already contains.
 * For the same reason this must run AFTER codexGatewayConfigPatch, which
 * re-orders the file around its own markers.
 *
 * @param {string} configText  existing config.toml text ('' when absent)
 * @param {string | null} model  the model whose window to declare
 * @returns {string}
 */
export function codexContextWindowConfigPatch(configText, model) {
  const withoutManagedBlock = String(configText || "").replace(
    new RegExp(
      `${CODEX_CONTEXT_WINDOW_BEGIN}\\n[\\s\\S]*?${CODEX_CONTEXT_WINDOW_END}\\n?`,
      "g",
    ),
    "",
  );
  // The first rollout of the 1M-window support wrote these as unmarked root
  // keys. Once the managed block was introduced, prepending it without
  // removing those legacy lines made the TOML invalid (duplicate root keys)
  // before `codex resume` could start. Only migrate the root prefix: a key
  // with the same name below a table header belongs to that table and is not
  // ours to rewrite.
  const firstTable = withoutManagedBlock.search(/^\s*\[[^\n]+\]\s*(?:#.*)?$/m);
  const root =
    firstTable === -1
      ? withoutManagedBlock
      : withoutManagedBlock.slice(0, firstTable);
  const tables = firstTable === -1 ? "" : withoutManagedBlock.slice(firstTable);
  const stripped = `${root.replace(
    /^\s*(?:model_context_window|model_auto_compact_token_limit)\s*=.*(?:\n|$)/gm,
    "",
  )}${tables}`;
  // '' for a model with no extended window — the strip above still runs, so a
  // home that MOVED to such a model loses a stale block rather than keeping a
  // window its new model does not have.
  const body = model ? codexContextConfigToml(model) : "";
  if (!body) return stripped;
  return `${CODEX_CONTEXT_WINDOW_BEGIN}\n${body}${CODEX_CONTEXT_WINDOW_END}\n${stripped}`;
}

/**
 * Write the extended-window block into a session's codex home. The model comes
 * from this launch when it names one, else from the home's OWN `model = ` line
 * (per-session homes carry it) — so a bare resume still refreshes correctly.
 * Returns the model it resolved, or null when it could not act.
 */
function applyCodexContextWindow(codexHome, model = null) {
  try {
    const configPath = join(codexHome, "config.toml");
    if (!existsSync(configPath)) return null;
    const current = readFileSync(configPath, "utf8");
    const effective =
      model || current.match(/^model\s*=\s*["']([^"']+)["']/m)?.[1] || null;
    const next = codexContextWindowConfigPatch(current, effective);
    if (next !== current) writeFileSync(configPath, next, { mode: 0o600 });
    return effective;
  } catch {
    // Never fail a launch over a window optimization — the `-c` args on a
    // model-carrying launch already cover the common path.
    return null;
  }
}

/** @param {string} codexHome
 * @param {{mode?: string, id?: string | null, ownerId?: string | null, priority?: string | null, keepProviderTableWhenUnrouted?: boolean}} [options] */
export function applyCodexGatewayRoute(
  codexHome,
  {
    mode = "default",
    id = null,
    ownerId = null,
    priority = null,
    keepProviderTableWhenUnrouted = false,
  } = {},
) {
  const configPath = join(codexHome, "config.toml");
  const current = existsSync(configPath)
    ? readFileSync(configPath, "utf8")
    : "";
  writeFileSync(
    configPath,
    codexGatewayConfigPatch(current, mode === "pin" ? id : null, {
      gatewayOn: mode === "auto",
      ownerId,
      priority,
      keepProviderTableWhenUnrouted,
    }),
    { mode: 0o600 },
  );
}

/**
 * Resolve which fields the flags PRE-SELECT vs which still need an
 * interactive prompt. Pure — exported for tests. Throws on a bad --agent.
 *
 * Any flag you pass preselects that field (the picker skips it); anything
 * you omit is marked `need*` so the interactive picker fills it in. This
 * is what lets you preselect some fields and still get prompted for the
 * rest — e.g. `psu --agent=claude --workspace=ws2` presets agent +
 * workspace and prompts for harness + plan.
 */
export function presetsFromArgs(args) {
  const agent = args.agent || null;
  if (agent && !AGENTS.includes(agent)) {
    throw new Error(
      `--agent must be one of ${AGENTS.join("|")} (got ${agent})`,
    );
  }
  const harness =
    args.harness != null && args.harness !== "" ? args.harness : null;
  const planProvided = args.noPlan || (args.plan != null && args.plan !== "");
  return {
    agent,
    workspace: args.workspace || null,
    harness,
    plan: args.noPlan ? null : args.plan || null,
    needAgent: !agent,
    needWorkspace: !args.workspace,
    needHarness: !harness,
    needPlan: !planProvided,
  };
}

/**
 * Strict (no-prompt) resolution for `--no-picker`. Pure; throws if the
 * required --agent is missing (can't prompt in scripting mode). Omitted
 * workspace/harness/plan fall back to the server defaults (active
 * workspace, workspace root, no plan).
 */
export function selectionsFromArgs(args) {
  const p = presetsFromArgs(args);
  if (p.needAgent) {
    throw new Error(
      `--agent must be one of ${AGENTS.join("|")} (got ${String(args.agent)})`,
    );
  }
  return {
    agent: p.agent,
    workspace: p.workspace,
    harness: p.harness,
    plan: p.plan,
  };
}

export function readToken({ home = homedir() } = {}) {
  try {
    return readFileSync(
      join(home, ".papercusp", "superuser-token"),
      "utf8",
    ).trim();
  } catch {
    /* no superuser-token file → fall back to the desktop operator's token below */
  }
  // The desktop operator records its bearer in operator.json (== superuser-token
  // when both exist). Falling back here keeps psu authenticated even if only the
  // operator.json discovery file is present in a fresh desktop install.
  try {
    const d = JSON.parse(
      readFileSync(join(home, ".papercusp", "operator.json"), "utf8"),
    );
    if (d && typeof d.token === "string" && d.token) return d.token.trim();
  } catch {
    /* none → unauthenticated (dev-box open operator) */
  }
  return "";
}

/**
 * Path to the persisted default-account Claude OAuth token (from `claude
 * setup-token`). 0600. Overridable via env for tests / non-default homes.
 *
 * WHY a stored env-token is the inheritance path (not a file/keychain copy):
 * a psu claude session runs under a per-owner isolated `CLAUDE_CONFIG_DIR`. On
 * Linux/Windows that config dir's `.credentials.json` is healed from the global
 * `~/.claude` login by the reconcile/symlink machinery — but on **macOS** the
 * OAuth token lives in the Keychain keyed by a per-`CLAUDE_CONFIG_DIR` suffix
 * (`Claude Code-credentials-<hash>`), and claude *deletes* any seeded
 * `.credentials.json` after migrating it. So the session's config dir gets a
 * fresh suffix that never matches the default `~/.claude` login → "launches
 * logged out", and no file-based reconcile can fix it (Anthropic docs:
 * file fallback + the CLAUDE_CONFIG_DIR→file relocation are Linux/Windows only).
 * `CLAUDE_CODE_OAUTH_TOKEN` (auth precedence #5, above subscription OAuth #6) is
 * the ONE mechanism that bypasses keychain + file + config-dir-suffix entirely
 * and behaves identically on every OS — exactly the "log in once, inherit in
 * every psu session" the default account wants. (psu-login-inherit / macOS.)
 */
export function claudeOAuthTokenPath({ home = homedir() } = {}) {
  return (
    process.env.PAPERCUSP_CLAUDE_OAUTH_TOKEN_FILE ||
    join(home, ".papercusp", "claude-oauth-token")
  );
}

/** Read the stored token (trimmed) or null when none/unreadable. */
export function readStoredClaudeOAuthToken({ home = homedir() } = {}) {
  try {
    const p = claudeOAuthTokenPath({ home });
    if (!existsSync(p)) return null;
    const t = readFileSync(p, "utf8").trim();
    return t || null;
  } catch {
    return null;
  }
}

/**
 * Inject `CLAUDE_CODE_OAUTH_TOKEN` into a DEFAULT-account claude launch so it
 * inherits the single stored CLI login (see `claudeOAuthTokenPath`). Mutates +
 * returns `env`. Skipped — leaving the env byte-identical — when:
 *   - not a claude session (codex/omp authenticate by their own file creds);
 *   - an inference-gateway account is pinned (`ANTHROPIC_BASE_URL` set → the
 *     gateway authenticates; an env bearer would fight its account routing);
 *   - the user already exported a token/key (respect their explicit, and
 *     higher- or equal-precedence, choice);
 *   - no token is stored (→ unchanged: keychain/file OAuth login as before).
 * Pure but for the `env` mutation; `home` injectable for tests.
 */
export function applyDefaultClaudeOAuthToken(
  wrapperBin,
  env,
  { home = homedir(), platform = process.platform } = {},
) {
  if (!/(^|\/)claude(-su)?$/.test(String(wrapperBin || ""))) return env;
  if (env.ANTHROPIC_BASE_URL) return env;
  if (
    env.CLAUDE_CODE_OAUTH_TOKEN ||
    env.ANTHROPIC_API_KEY ||
    env.ANTHROPIC_AUTH_TOKEN
  )
    return env;
  // Linux/Windows store the real system `/login` in this file. Prefer it over
  // the optional setup-token cache: the file is refreshed by Claude itself,
  // while the cache can be older. macOS is intentionally excluded because its
  // real login is Keychain-backed and the per-session CLAUDE_CONFIG_DIR uses a
  // different Keychain suffix (the reason this fallback exists at all).
  if (
    platform !== "darwin" &&
    existsSync(join(home, ".claude", ".credentials.json"))
  )
    return env;
  const tok = readStoredClaudeOAuthToken({ home });
  if (tok) env.CLAUDE_CODE_OAUTH_TOKEN = tok;
  return env;
}

/** Claude settings/env selectors that can redirect a launch away from the
 * machine's first-party `/login`. Keep this list aligned with
 * enforceDefaultClaudeAccount and the command-line settings override below.
 *
 * CLAUDE_CODE_OAUTH_TOKEN is deliberately NOT written as an empty
 * `settings.env` value: Claude treats that as an explicit logged-out OAuth
 * choice and will not fall back to `.credentials.json` / Keychain. The ambient
 * value is still deleted by enforceDefaultClaudeAccount; copied user settings
 * are removed by persistDefaultClaudeAuthSettings. */
export const CLAUDE_DEFAULT_AUTH_ENV_KEYS = Object.freeze([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_UNIX_SOCKET",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLAUDE_CODE_API_BASE_URL",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
  "CLAUDE_CODE_HOST_CREDS_FILE",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
  "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_GATEWAY",
]);

/** Highest-precedence, secret-free Claude settings overlay for an explicit
 * default-account launch. `--settings` outranks project/local/user settings, so
 * a stale apiKeyHelper, API key, gateway URL, or cloud-provider selector cannot
 * silently win over the system login selected in the UI. */
export function defaultClaudeAuthSettings(routeEnv = {}) {
  const mode = routeEnv?.[ACCOUNT_ROUTING_MODE_ENV] ?? "default";
  const routedEnv = Object.fromEntries(
    CLAUDE_DEFAULT_AUTH_ENV_KEYS.map((key) => [key, ""]),
  );
  if (mode === "auto" || mode === "pin") {
    for (const key of [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_CUSTOM_HEADERS",
    ]) {
      if (routeEnv?.[key]) routedEnv[key] = routeEnv[key];
    }
  } else if (isCacheProxyUrl(routeEnv?.ANTHROPIC_BASE_URL)) {
    // P-006: the cache proxy is a same-credential passthrough, not a route override — keep it
    // so this settings overlay (which outranks project/user settings) doesn't blank it back out.
    routedEnv.ANTHROPIC_BASE_URL = routeEnv.ANTHROPIC_BASE_URL;
  }
  return {
    apiKeyHelper: "",
    env: routedEnv,
  };
}

/** Add the default-account settings override at the central wrapper seam
 * shared by fresh, resume, and fork launches. Pure; exported for regression
 * coverage. */
export function applyDefaultClaudeAuthSettingsArgs(wrapperBin, args, env) {
  const list = Array.isArray(args) ? args : [];
  if (!/(^|\/)claude(-su)?$/.test(String(wrapperBin || ""))) return list;
  if (!["default", "auto", "pin"].includes(env?.[ACCOUNT_ROUTING_MODE_ENV]))
    return list;
  // Global options must precede subcommands (`claude auth status --settings`
  // is rejected), so prepend rather than append. This is also valid for the
  // normal interactive/resume argv where every remaining token is an option or
  // the optional kickoff prompt.
  return [
    "--settings",
    JSON.stringify(defaultClaudeAuthSettings(env)),
    ...list,
  ];
}

/**
 * Make an EXPLICIT `default` Claude launch mean exactly what the picker says:
 * use the system / CLI login, regardless of the parent shell's prior account.
 *
 * Claude credential env vars outrank its config-dir login. Merely removing the
 * inference-gateway URL is therefore insufficient: a resumed auto/pinned session
 * (or a shell with a direct API/OAuth token) can otherwise keep using that inherited
 * credential after the user selects `default`. Clear every Claude direct/gateway
 * credential here; applyDefaultClaudeOAuthToken then restores the stored system
 * OAuth token, while launchResume's rehealResumeCredentials points the isolated
 * config dir back at the global system credential on file-based platforms.
 *
 * The marker is applied only by Papercusp's account-routing decision. A direct
 * non-psu Claude invocation, and role launches without that decision, retain their
 * explicitly exported credentials.
 */
export function enforceDefaultClaudeAccount(wrapperBin, env) {
  if (!/(^|\/)claude(-su)?$/.test(String(wrapperBin || ""))) return env;
  if (env[ACCOUNT_ROUTING_MODE_ENV] !== "default") return env;
  // P-006: preserve a cache-proxy base URL across the credential purge below. The purge targets
  // inherited GATEWAY/API credentials that would outrank the system login; the cache proxy
  // forwards that same system login verbatim, so clearing it would only cost us the cache
  // policy. Re-applied after the loop so the key list stays the single source of truth.
  const keepCacheProxy = isCacheProxyUrl(env.ANTHROPIC_BASE_URL)
    ? env.ANTHROPIC_BASE_URL
    : null;
  for (const key of [
    ...CLAUDE_DEFAULT_AUTH_ENV_KEYS,
    "PAPERCUSP_ANTHROPIC_URL",
    "PAPERCUSP_ACCOUNT_ID",
    "PAPERCUSP_CODEX_GATEWAY",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ]) {
    delete env[key];
  }
  if (keepCacheProxy) env.ANTHROPIC_BASE_URL = keepCacheProxy;
  return env;
}

/**
 * The OAuth-bundle expiry (epoch ms) recorded in a claude `.credentials.json`,
 * or -1 when absent/unreadable. Mirrors reconcileClaudeCredentials's
 * newest-expiresAt-wins key. Pure; exported for tests.
 */
export function claudeCredExpiresAt(path) {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    const o = j.claudeAiOauth ?? j;
    return Number(o.expiresAt ?? o.expires_at) || 0;
  } catch {
    return -1;
  }
}

/**
 * Re-heal a resumed session's isolated `.credentials.json` (psu-resume-relogin,
 * owner-reported 2026-07-12).
 *
 * A FRESH launch runs bootstrap-su → `writeInteractiveClaudeConfig`, which
 * reconciles credentials to the newest bundle (`reconcileClaudeCredentials`) and
 * then symlinks `<configDir>/.credentials.json` → the global
 * `~/.claude/.credentials.json`. A RAW `psu --resume` (`launchResume`) never did
 * that leg — it only re-points `CLAUDE_CONFIG_DIR` at the existing isolated dir.
 * But claude REPLACES `.credentials.json` on every OAuth refresh (temp+rename),
 * so an in-session refresh swaps the symlink for a divergent real-file fork;
 * with Anthropic's single-use rotating refresh tokens that fork goes stale, and
 * the background reconciler (`claude-credential-sync`) may not have converged it
 * by resume time — so a default-account resume "launches logged out" and
 * prompts a re-login even though the system account IS logged in. (A fresh
 * launch re-heals every time, which is why only `--resume` regressed.)
 *
 * Re-establish the fresh-mirror invariant right before spawn: keep the global on
 * the newest bundle (promote the strictly-newest real-file fork — newest-
 * expiresAt wins, matching reconcileClaudeCredentials) and re-point the session
 * credential at it via symlink. Best-effort — a launch must NEVER fail on
 * credential reconciliation, and a healthy symlink is left byte-identical.
 * Linux/Windows file path; a gateway-pinned resume skips this (it authenticates
 * via `ANTHROPIC_BASE_URL`) and macOS inherits via the OAuth-token path
 * (`applyDefaultClaudeOAuthToken`). `home` injectable for tests.
 *
 * DURABILITY (WI-4727 follow-up, 2026-07-14): the promotion sweeps EVERY
 * real-file fork under the session-claude root (`promoteNewestForkToGlobal`),
 * not just this session's own — a pairwise this-session-vs-global check missed
 * a fresher token sitting in a *different* concurrently-running session's
 * fork, which the background reconciler's debounce/interval hadn't yet
 * converged. This resume path now performs the same full-fleet
 * newest-wins convergence a fresh launch gets from `reconcileClaudeCredentials`,
 * just re-implemented locally (this script has no dependency on the
 * operator-core TS package it lives in).
 */
export function rehealResumeCredentials(configDir, { home = homedir() } = {}) {
  try {
    if (!configDir) return;
    const globalPath = join(home, ".claude", ".credentials.json");
    if (!existsSync(globalPath)) return; // API-key-only / fresh box: nothing to mirror
    const sessPath = join(configDir, ".credentials.json");
    // Healthy: already a symlink resolving to the (reconciler-kept-newest)
    // global — claude will follow it to a live token. Leave byte-identical.
    try {
      if (
        lstatSync(sessPath).isSymbolicLink() &&
        realpathSync(sessPath) === realpathSync(globalPath)
      )
        return;
    } catch {
      /* missing, or a dangling symlink — fall through and (re)heal */
    }
    // Sweep every OTHER real-file fork under the session-claude root for a
    // bundle strictly newer than the global — a CONCURRENT session's
    // in-session refresh the background reconciler (claude-credential-sync,
    // debounced/interval-polled) hasn't converged yet. (WI-4727 durability
    // follow-up: the original resume-time reheal only ever promoted THIS
    // session's own fork, so a fresher token sitting in a *different* live
    // session's fork was invisible to a resume landing on a merely-stale — not
    // necessarily the oldest — fork; the symlink invariant "degrades in-session"
    // faster than a narrow pairwise check can chase.)
    promoteNewestForkToGlobal(home, globalPath);
    // A real-file fork of THIS session strictly NEWER than the (possibly
    // just-updated) global: promote it too. Kept in addition to the sweep
    // above because `configDir` is not guaranteed to live under the default
    // session-claude root (a relocated/custom config dir the sweep can't
    // discover) — this direct check is location-independent.
    let sessIsSymlink = false;
    try {
      sessIsSymlink = lstatSync(sessPath).isSymbolicLink();
    } catch {
      /* missing */
    }
    if (
      !sessIsSymlink &&
      existsSync(sessPath) &&
      claudeCredExpiresAt(sessPath) > claudeCredExpiresAt(globalPath)
    ) {
      try {
        copyFileSync(sessPath, globalPath);
      } catch {
        /* keep the global as-is on failure */
      }
    }
    // Re-point the session credential at the global CLI login, exactly as
    // writeInteractiveClaudeConfig's fresh mirror does.
    rmSync(sessPath, { force: true });
    symlinkSync(globalPath, sessPath);
  } catch {
    /* a launch must NEVER fail on credential reconciliation */
  }
}

/**
 * Re-establish a resumed Codex session's default-account auth mirror.
 *
 * Fresh isolated CODEX_HOMEs inherit `~/.codex/auth.json` as a symlink, but an
 * older home can predate the owner's system login (or Codex can replace the
 * symlink during an OAuth refresh). An exact `--account=default` resume reuses
 * that old home, so without this repair Codex opens its login screen even though
 * the system account is already authenticated. This is the Codex counterpart of
 * {@link rehealResumeCredentials}: explicit `default` means the system login,
 * therefore the session home must resolve to the system auth file before spawn.
 *
 * Best-effort and idempotent. Gateway-routed resumes do not call this helper;
 * a missing global login is a no-op so API-key-only/fresh boxes are untouched.
 */
export function rehealResumeCodexAuth(codexHome, { home = homedir() } = {}) {
  try {
    if (!codexHome) return;
    const globalPath = join(home, ".codex", "auth.json");
    if (!existsSync(globalPath)) return;
    const sessPath = join(codexHome, "auth.json");
    try {
      if (
        lstatSync(sessPath).isSymbolicLink() &&
        realpathSync(sessPath) === realpathSync(globalPath)
      )
        return;
    } catch {
      /* missing or dangling — fall through and (re)heal */
    }
    rmSync(sessPath, { force: true });
    symlinkSync(globalPath, sessPath);
  } catch {
    /* a launch must NEVER fail on credential reconciliation */
  }
}

/**
 * Scan every real-file (non-symlink) `.credentials.json` fork under the
 * session-claude root (`sessionClaudeRoot`) for a bundle strictly newer than
 * `globalPath`'s CURRENT bundle, and promote the single newest one found into
 * the global file. Mirrors `reconcileClaudeCredentials`'s (claude-credential-
 * sync.ts) newest-expiresAt-wins key — duplicated here rather than imported,
 * because `psu-launcher.mjs` runs as a plain node script outside the
 * operator-core TS package/build (see the file-top note on this module's
 * dependency surface). Best-effort: a missing session root, or a read/copy
 * failure on any one fork, degrades to skipping that fork — never throws.
 */
function promoteNewestForkToGlobal(home, globalPath) {
  const root = sessionClaudeRoot(home);
  let dirs = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return; // no session-claude root yet
  }
  let bestPath = null;
  let bestExp = claudeCredExpiresAt(globalPath);
  for (const dir of dirs) {
    const p = join(root, dir, ".credentials.json");
    let isSymlink = false;
    try {
      isSymlink = lstatSync(p).isSymbolicLink();
    } catch {
      continue; // missing — nothing to consider
    }
    if (isSymlink) continue; // resolves to the global; nothing to promote
    const exp = claudeCredExpiresAt(p);
    if (exp > bestExp) {
      bestExp = exp;
      bestPath = p;
    }
  }
  if (bestPath) {
    try {
      copyFileSync(bestPath, globalPath);
    } catch {
      /* keep the global as-is on failure */
    }
  }
}

/**
 * Make the GitHub Copilot MCP plugin AUTHENTICATE instead of failing. That plugin (a Claude
 * plugin OMP also discovers via claude-plugin discovery) sends
 * `Authorization: Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}`; when the env var is unset the header is
 * a bare `Bearer ` and the server rejects it ("Authorization header is badly formatted", HTTP 400)
 * on EVERY claude/omp launch. The `gh` CLI already holds a working token (verified: it
 * authenticates the Copilot MCP → HTTP 200), so export it into the agent env when unset. Fail-soft:
 * no gh / not logged in → env untouched (the plugin then fails exactly as before, never worse).
 * Mutates + returns env. `runGh` injectable for tests.
 */
export function applyGithubTokenEnv(
  env,
  {
    runGh = () =>
      spawnSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 5000 }),
  } = {},
) {
  if (env.GITHUB_PERSONAL_ACCESS_TOKEN) return env;
  try {
    const out = runGh();
    const tok = (
      out && out.status === 0 ? String(out.stdout || "") : ""
    ).trim();
    if (tok) env.GITHUB_PERSONAL_ACCESS_TOKEN = tok;
  } catch {
    /* gh missing / not logged in → leave env unchanged (fail-soft) */
  }
  return env;
}

/** Persist the default-account Claude OAuth token (0600); creates ~/.papercusp. */
export function storeClaudeOAuthToken(token, { home = homedir() } = {}) {
  const t = String(token || "").trim();
  if (!t) throw new Error("refusing to store an empty Claude OAuth token");
  const p = claudeOAuthTokenPath({ home });
  mkdirSync(join(home, ".papercusp"), { recursive: true });
  writeFileSync(p, t + "\n", { mode: 0o600 });
  // writeFileSync's mode is ignored when the file pre-existed — force 0600.
  try {
    chmodSync(p, 0o600);
  } catch {
    /* best-effort on platforms w/o chmod */
  }
  return p;
}

/**
 * Resilient fetch: retries CONNECTION failures (refused/reset — "fetch failed",
 * i.e. the operator is mid-recycle) on a short backoff until `connectBudgetMs`
 * elapses, so a launch rides THROUGH a memory-watchdog drain+restart window
 * instead of failing on the first dead tick. TIMEOUTs (reachable but slow —
 * wedged, not restarting) are retried only a small fixed number of times, since
 * each retry costs another full timeout. A caller-supplied `init.signal` owns
 * the request lifetime and disables retry. Returns the Response (caller reads
 * the body); throws a descriptive Error when every attempt fails.
 *
 * On repeated connection failure it additionally attempts ONE health-gated
 * FAILOVER for launcher-managed targets to a different live operator (resolveFallbackOperatorTargets:
 * proxy → fresh operator.json → dev default) and adopts it session-wide
 * (adoptOperatorTarget) — the stale-shell heal for terminals whose
 * PAPERCUSP_OPERATOR_URL outlived the per-boot desktop operator port.
 *
 * Deps are injected for tests (psu-launcher.test.ts) — `fetchImpl`/`sleep`/`now`
 * make the retry timing deterministic without real timers or sockets.
 */
export async function fetchWithResilience(
  url,
  init = {},
  {
    fetchImpl = fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
    onNotice = (msg) => process.stderr.write(msg),
    timeoutMs = REQUEST_TIMEOUT_MS,
    connectBudgetMs = CONNECT_RETRY_BUDGET_MS,
    timeoutRetries = TIMEOUT_RETRIES,
    retryBootstrapFailures = false,
    bootstrapReplayMaxAttempts = BOOTSTRAP_REPLAY_MAX_ATTEMPTS,
    bootstrapReplayBudgetMs = BOOTSTRAP_REPLAY_BUDGET_MS,
    label = url,
    target = OPERATOR_TARGET,
    // Stale-shell heal (mac VM owner repro 2026-07-07): when the target keeps
    // refusing, look ONCE for a DIFFERENT live operator (proxy → fresh
    // operator.json → dev default), health-check it, and switch — instead of
    // burning the whole budget on a dead per-boot port a long-lived terminal
    // window pinned via PAPERCUSP_OPERATOR_URL.
    resolveFallback = resolveFallbackOperatorTargets,
    onFailover = adoptOperatorTarget,
    healthProbeTimeoutMs = 2_000,
  } = {},
) {
  // A caller-supplied AbortSignal owns the request lifetime — never retry it.
  const callerSignal = init.signal ?? null;
  const retryable = !callerSignal;
  // WI-3271: a desktop (operator.json-discovered) target whose record is old is
  // almost certainly a DEAD operator (app closed / supervision gave up), not a
  // mid-restart one — shrink the connection-retry budget so psu answers in
  // seconds with the "start the Papercusp app" guidance instead of sitting
  // quietly through the full ride-through window.
  const targetAgeMs =
    target?.source === "discovery" && target.startedAt
      ? now() - target.startedAt
      : null;
  const targetStale = targetAgeMs != null && targetAgeMs > STALE_DISCOVERY_MS;
  const effectiveConnectBudgetMs = targetStale
    ? Math.min(connectBudgetMs, STALE_FAST_FAIL_BUDGET_MS)
    : connectBudgetMs;
  // Wall-clock deadline for retrying CONNECTION failures (host mid-recycle).
  const connectDeadline = now() + effectiveConnectBudgetMs;
  let timeoutRetriesLeft = timeoutRetries;
  let announcedConnRetry = false;
  let failoverAttempted = false;
  let overloadAttempts = 1;
  let announcedOverloadRetry = false;
  const overloadDeadline = now() + MCP_PROXY_OVERLOAD_RETRY_BUDGET_MS;
  let bootstrapReplayAttempts = 1;
  let announcedBootstrapReplay = false;
  const bootstrapReplayDeadline = now() + bootstrapReplayBudgetMs;
  let lastErr;
  for (;;) {
    try {
      const response = await fetchImpl(url, {
        ...init,
        // Without a timeout a wedged operator hangs psu indefinitely. Fail fast.
        signal: callerSignal ?? AbortSignal.timeout(timeoutMs),
      });
      if (retryable && isRetryableMcpProxyOverload(response)) {
        const remaining = overloadDeadline - now();
        const retryAfter = response.headers.get("retry-after");
        const delayMs = proxyOverloadRetryDelayMs(retryAfter);
        if (
          overloadAttempts < MCP_PROXY_OVERLOAD_MAX_ATTEMPTS &&
          remaining >= delayMs
        ) {
          if (!announcedOverloadRetry) {
            onNotice(
              `psu: the MCP proxy is overloaded; retrying in ${Math.ceil(delayMs / 1_000)}s ` +
                `(attempt ${overloadAttempts + 1}/${MCP_PROXY_OVERLOAD_MAX_ATTEMPTS})…\n`,
            );
            announcedOverloadRetry = true;
          }
          overloadAttempts += 1;
          // Release the shed response before waiting so undici can reuse the
          // connection while the proxy drains an in-flight slot.
          try {
            await response.body?.cancel?.();
          } catch {
            /* best-effort; the response was already a rejected admission */
          }
          await sleep(delayMs);
          continue;
        }
      }
      if (retryable && retryBootstrapFailures) {
        const directive = await bootstrapReplayDirective(response);
        if (directive) {
          const remaining = bootstrapReplayDeadline - now();
          if (
            bootstrapReplayAttempts < bootstrapReplayMaxAttempts &&
            remaining >= directive.delayMs
          ) {
            if (!announcedBootstrapReplay) {
              onNotice(
                `psu: bootstrap ${directive.kind === "upstream-silent" ? "lost its upstream response" : "is still completing"}; ` +
                  `retrying safely with the same idempotency key ` +
                  `(attempt ${bootstrapReplayAttempts + 1}/${bootstrapReplayMaxAttempts})…\n`,
              );
              announcedBootstrapReplay = true;
            }
            bootstrapReplayAttempts += 1;
            try {
              await response.body?.cancel?.();
            } catch {
              /* best-effort; the typed response is no longer needed */
            }
            await sleep(directive.delayMs);
            continue;
          }
        }
      }
      return response;
    } catch (e) {
      lastErr = e;
      if (!retryable) break;
      const isTimeout = e?.name === "TimeoutError" || e?.name === "AbortError";
      if (isTimeout) {
        // Reachable but slow (wedged, not restarting) — a retry costs another
        // full timeout, so only a small fixed number of them.
        if (timeoutRetriesLeft <= 0) break;
        timeoutRetriesLeft -= 1;
        onNotice(`psu: ${label} timed out after ${timeoutMs}ms — retrying…\n`);
        await sleep(1_500);
        continue;
      }
      // Connection refused/reset ("fetch failed") — the operator is almost
      // certainly mid-recycle or a deploy swap, unreachable for ~10-15s. Retry
      // on a short backoff until the budget elapses so the launch rides through,
      // instead of failing on the first dead window (the single 1.5s retry this
      // replaced couldn't span a recycle).
      const remaining = connectDeadline - now();
      if (remaining <= 0) break;
      if (!announcedConnRetry) {
        onNotice(
          targetStale
            ? `psu: the Papercusp app's server at ${target.url} isn't answering (${label}) and its boot record is ` +
                `${fmtAgo(targetAgeMs)} old — checking for ${Math.ceil(effectiveConnectBudgetMs / 1000)}s…\n`
            : `psu: operator at ${target?.url ?? OPERATOR_URL} unreachable (${label}) — it may be restarting; ` +
                `retrying for up to ${Math.ceil(effectiveConnectBudgetMs / 1000)}s…\n`,
        );
        announcedConnRetry = true;
      }
      // Stale-shell heal: ONE failover attempt per call. Only when this
      // request actually targets the failing session target (a caller-custom
      // operatorUrl is never rebased), and only to a candidate that answers
      // /api/health right now — a mid-restart operator's candidates all fail
      // the health probe, so the normal ride-through behavior is unchanged.
      // Explicit env pins remain on the chosen build even through an outage.
      // Only known managed sources can heal; unknown provenance fails closed.
      if (!failoverAttempted && ["managed-env", "discovery", "proxy"].includes(target?.source)) {
        failoverAttempted = true;
        const base = target?.url ?? null;
        if (base && url.startsWith(base)) {
          let switched = false;
          for (const cand of resolveFallback({ excludeUrls: [base] })) {
            try {
              const h = await fetchImpl(`${cand.url}/api/health`, {
                signal: AbortSignal.timeout(healthProbeTimeoutMs),
              });
              if (!h?.ok) continue;
            } catch {
              continue;
            }
            onNotice(
              `psu: ${base} is not answering but a live operator is at ${cand.url} (${cand.source}) — switching. ` +
                (target?.source === "managed-env"
                  ? `This shell's launcher-managed PAPERCUSP_OPERATOR_URL is stale (desktop operator ports change per boot); ` +
                    `sessions launched from here now inherit the working one.\n`
                  : `Its recorded address was stale; continuing on the live one.\n`),
            );
            url = cand.url + url.slice(base.length);
            target = cand;
            onFailover(cand);
            switched = true;
            break;
          }
          if (switched) continue; // retry immediately on the healed target
        }
      }
      await sleep(Math.min(2_000, remaining));
    }
  }
  const e = lastErr;
  const shownUrl = target?.url ?? OPERATOR_URL;
  // WI-3271: guidance must match the install. A desktop (discovery) target has
  // no systemd — telling a Windows/desktop user to systemctl is a dead end; the
  // fix there is starting (or restarting) the Papercusp app itself.
  const isDesktop = target?.source === "discovery";
  if (e?.name === "TimeoutError" || e?.name === "AbortError") {
    throw new Error(
      `the operator at ${shownUrl} did not respond within ${timeoutMs}ms (${label}). ` +
        (isDesktop
          ? `It may be wedged — restart the Papercusp desktop app, `
          : `It may be wedged — restart it (systemctl --user restart papercup-dev-api.service), `) +
        `or raise the cap with PAPERCUSP_PSU_TIMEOUT_MS.`,
    );
  }
  if (target?.source === "env") {
    throw new Error(
      `the operator URL this shell pins via PAPERCUSP_OPERATOR_URL (${shownUrl}) refused connections for ` +
        `${Math.ceil(effectiveConnectBudgetMs / 1000)}s. The explicit target was preserved; no other operator was tried. ` +
        `Restore that operator, or \`unset PAPERCUSP_OPERATOR_URL\` to opt into discovery (~/.papercusp/operator.json).`,
    );
  }
  if (isDesktop) {
    throw new Error(
      `the Papercusp app's server isn't running (${shownUrl} refused for ${Math.ceil(effectiveConnectBudgetMs / 1000)}s` +
        (targetAgeMs != null
          ? `; it last reported up ${fmtAgo(targetAgeMs)} ago`
          : "") +
        `). Start (or restart) the Papercusp desktop app, wait for it to finish loading, then re-run psu. ` +
        `Override with PAPERCUSP_OPERATOR_URL.`,
    );
  }
  throw new Error(
    `could not reach the operator at ${shownUrl} after ${Math.ceil(effectiveConnectBudgetMs / 1000)}s (${e?.message || e}). ` +
      `Is the desktop/operator running? Override with PAPERCUSP_OPERATOR_URL.`,
  );
}

/** Turn a structured operator/proxy failure into an actionable launcher error.
 * Keep the stable error code, but retain the server's detail and retry hint so
 * a final exhausted overload is distinguishable from a programming failure. */
export function formatApiFailureMessage(json, status, path) {
  const err = json?.error;
  const msg =
    typeof err === "string"
      ? err
      : err?.message ||
        (err ? JSON.stringify(err) : `HTTP ${status} from ${path}`);
  const detail = typeof json?.detail === "string" ? json.detail.trim() : "";
  const rawRetryAfter = json?.retryAfterSec;
  const retryAfterSec =
    typeof rawRetryAfter === "number" || typeof rawRetryAfter === "string"
      ? Number(rawRetryAfter)
      : NaN;
  const retryHint =
    Number.isFinite(retryAfterSec) && retryAfterSec >= 0
      ? `retry in ${retryAfterSec}s`
      : "";
  return [msg, detail && detail !== msg ? detail : "", retryHint]
    .filter(Boolean)
    .join(" — ");
}

async function api(path, opts = {}) {
  const { retryBootstrapFailures = false, ...fetchOpts } = opts;
  const token = readToken();
  const res = await fetchWithResilience(
    OPERATOR_URL + path,
    {
      ...fetchOpts,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(fetchOpts.headers || {}),
      },
    },
    { label: path, retryBootstrapFailures },
  );
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { status: "error", error: text.slice(0, 200) };
  }
  if (!res.ok || json.status === "error") {
    const failure = new Error(formatApiFailureMessage(json, res.status, path));
    failure.status = res.status;
    failure.path = path;
    throw failure;
  }
  return json;
}

async function pickAgent({ tui = null } = {}) {
  const { select } = await import("@inquirer/prompts");
  return select({
    message: "Agent",
    choices: agentPickerChoices({ tui }),
  });
}

// su-context-size-variants: the per-variant ~Nk figures shown in the picker —
// parity with the operator UI's SU_CONTEXT_OPTIONS (AdvSessionsClient.tsx). STATIC
// measured estimates. Re-measured 2026-07-02 AFTER the Phase-3 cuts (fleet persona
// tier, P-020 plugin prune, P-015 zero-AGENTS.md): trimmed turn-1 boot is 60.1k on a
// sonnet fleet member / ~66k fable fleet / ~76k full-persona power launch — the old
// '~83k' (P-018, pre-Phase-3, full persona) over-stated by ~15-20k. '~70k' is the
// honest mid; the preflight guard below does the exact per-launch math anyway.
export const SU_CONTEXT_TOKEN_ESTIMATES = { trimmed: "~70k" };

// su-context-size-variants: the terminal-picker choices — the twin of the UI's
// SU_CONTEXT_OPTIONS, which is likewise a single 'trimmed' row. 'trimmed' is the ONLY
// live mode and therefore the only choice: 'full' is a RETIRED alias that
// normalizeSuContextSize maps down to 'trimmed' at the flag boundary (see parseArgs),
// and there is no Native/no-flag row — the picker forces a value. Do not re-add a
// second entry here to "restore" the whole-catalog launch: the catalog stays fully
// reachable from the trimmed seed via tools:find/tools:invoke, which is what made the
// up-front load unnecessary rather than merely unfashionable.
export const SU_CONTEXT_CHOICES = [
  {
    name: `Trimmed · ${SU_CONTEXT_TOKEN_ESTIMATES.trimmed}  (core spine, native soft-trim) (default)`,
    value: "trimmed",
  },
];

// su-context-size-variants: the picker's default SELECTION (highlighted row when the
// prompt opens; Enter with no arrow keys picks this). Trimmed keeps initial context
// small without giving up on-demand discovery — and it is now also the only row, so
// this is the value every interactive launch gets.
export const SU_CONTEXT_DEFAULT = "trimmed";

// ── Launch preflight guards (context-trimming-tiers P-016 / P-018) ──────────

/** Numeric per-variant baseline estimates (tokens) for the NON-persona context
 *  (tool catalog + static prefix). The persona playbook is measured from the
 *  actual prompt file at launch, so only the remainder is estimated here.
 *  Re-derived 2026-07-02 from live turn-1 boots minus the measured persona file:
 *  60.1k sonnet-fleet − 15.6k persona ≈ 44.5k; 76.2k power − ~28k ≈ 48k; 66.1k
 *  fable-fleet − 16k ≈ 50k → 50k (top of the measured band, guard stays
 *  conservative). Assumes ToolSearch deferral is ON (the launch tail sets
 *  ENABLE_TOOL_SEARCH=true on the claude paths — see the writes below; neither
 *  branches on contextSize, so there is no full/non-full distinction here.
 *  Without the deferral a gateway-routed member boots ~46k heavier, P-031 gap 3). */
export const SU_BASELINE_NON_PERSONA_TOKENS = RUNTIME_OVERHEAD_TOKENS;

/**
 * P-016 persona-append assertion: with the $HOME AGENTS.md mirrors gone
 * (P-015), the --append-system-prompt file IS the session's whole behavioral
 * spine — a missing/empty/tiny prompt file means a bare agent with no
 * playbook. Fail LOUD before spawning instead of launching a spineless
 * session. Returns the file's byte size for the window guard.
 */
export function assertLaunchPersona(promptFile) {
  const MIN_PERSONA_BYTES = 2_000;
  if (!promptFile) {
    throw new Error(
      "psu: launch spec carried NO persona prompt file — refusing to launch a session with no behavioral spine (context-trimming-tiers P-016).",
    );
  }
  let size = 0;
  try {
    size = statSync(promptFile).size;
  } catch {
    throw new Error(
      `psu: persona prompt file missing/unreadable at ${promptFile} — refusing to launch (context-trimming-tiers P-016).`,
    );
  }
  if (size < MIN_PERSONA_BYTES) {
    throw new Error(
      `psu: persona prompt file at ${promptFile} is only ${size} bytes (< ${MIN_PERSONA_BYTES}) — the playbook did not render/append; refusing to launch (context-trimming-tiers P-016).`,
    );
  }
  return size;
}

/**
 * opus + fable + sonnet-5 default to the FULL 1M window (owner directive
 * 2026-07-02): inject the `[1m]` marker into their model spec so EVERY
 * downstream `[1m]` consumer — the preflight window guard, the
 * context-size/tier derivation, and the `--model` passthrough that makes
 * Claude Code / the gateway enable the 1M-context window — treats them as 1M.
 * Idempotent; a no-op for a spec already carrying `[1m]` or outside the
 * default-1M families. `[1m]` is inserted before a recognized `:effort`
 * suffix, else appended. Papercusp then caps their compaction at 400k and
 * named-fleet MEMBERS at the current 250k role cap (retained by
 * measured-agent-productivity-2026-09-06 D-009; agent-config-constants
 * COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP / defaultCompactionLimitForSpec)
 * to bound token spend. The same two caps now bind extended-window CODEX
 * sessions (plan codex-1m-context-window-2026-08-17 D-001), which previously
 * seeded 158k because the window resolver only recognized this `[1m]` marker.
 * sonnet-5 REQUIRES the marker too — REVERSAL of the earlier P-031 note
 * (2026-07-02), live-verified via `/context` the same day: bare `--model
 * sonnet` runs a 200k AUTO-COMPACT window in CC 2.1.198 ("76k/200k ·
 * Auto-compact window: 200k tokens" — auto-fires ~167k, which killed a whole
 * wave of sonnet fleet members at preTokens 167-170k on 2026-07-02), while
 * `--model 'sonnet[1m]'` runs "76k/967k · Auto-compact window: 967k tokens".
 * The CC binary's 967k default for sonnet-5 sits behind a staged-rollout gate
 * (statsig `tengu_amber_moleskin`, OFF here), so despite sonnet-5 being
 * natively 1M-capable the `[1m]` marker is the only reliable way to get the
 * big window. The bare `sonnet` alias (whole spec) also counts: CC resolves it
 * to the latest sonnet = sonnet-5 (live-verified 2026-07-02). Kept in lockstep
 * with agent-config-constants `isDefault1mModelSpec` via DEFAULT_1M_FAMILY_RE.
 */
export const DEFAULT_1M_FAMILY_RE =
  /fable|opus|sonnet-?5|^sonnet(\[1m\])?(:[a-z0-9]+)?$/i;

export function normalizeModelSpec(spec) {
  if (!spec || /\[1m\]/i.test(spec) || !DEFAULT_1M_FAMILY_RE.test(spec))
    return spec;
  const c = spec.lastIndexOf(":");
  const suffix = c > 0 ? spec.slice(c + 1) : "";
  if (c > 0 && /^(low|medium|high|xhigh|max)$/i.test(suffix))
    return `${spec.slice(0, c)}[1m]${spec.slice(c)}`;
  return `${spec}[1m]`;
}

/** Apply Claude Code's private window marker only at a Claude boundary.
 * OMP model ids are provider-configured/open vocabulary, and Codex has its
 * own context controls, so both must remain byte-identical. */
export function normalizeModelSpecForAgent(agent, spec) {
  if (agent === "claude") return normalizeModelSpec(spec);
  if (agent === "codex" && spec) return normalizeCodexCliModel(spec);
  return spec;
}

// (The COMPACTION_LIMIT_1M_* mirrors lived here for the P-014 window backstop
// until P-022 retired native auto-compact outright — agent-config-constants
// remains the canonical home of the soft limits themselves.)

/**
 * P-022 (deterministic-context-carry-2026-07-14, WI-4998; owner terminal state
 * 2026-07-14 "remove the compact call entirely") — native compaction is RETIRED
 * for every Claude launch. Returns the env fragment setting Claude Code's
 * `DISABLE_AUTO_COMPACT` (verified against the CC 2.1.x binary: the auto-compact
 * predicate short-circuits false on a truthy value before the `autoCompactEnabled`
 * setting is even read), so the native summarizer can never fire — papercusp
 * carry (builder + respawn/handoff + shake) is the only compaction path.
 *
 * The boundary ladder that replaced the old P-014 window backstop
 * (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`, whose CC 2.1.x fire-point math is
 * preserved in git history should it ever need resurrecting): per-turn context
 * nudges from 85% → self carry-respawn (session:request-compaction) → the
 * compliance watchdog's soft-threshold carry-respawn → its 1.3× force-respawn →
 * the hard-wall death detector (improvements watchdog "Prompt is too long").
 * `{}` for non-claude: OMP compaction is papercusp-owned via its relocated
 * config (strategy `context-full`/`shake` + the gateway carry lane), and Codex
 * launches are audited separately (they have their own context controls).
 */
export function nativeCompactionEnv(agent) {
  // DISABLE_AUTO_COMPACT kills the automatic fire; DISABLE_COMPACT removes the
  // /compact command itself (both binary-verified CC 2.1.x envs) — the owner
  // terminal state is "no /compact", not merely "no auto-compact", and the
  // harness no longer types it either (session:request-compaction and the
  // watchdog both drive mode:'carry-respawn' now).
  return agent === "claude"
    ? { DISABLE_AUTO_COMPACT: "1", DISABLE_COMPACT: "1" }
    : {};
}

/**
 * Console-history preservation across a carry-respawn [owner terminal 2026-09-06
 * 00:10Z: "WHY IN THE CONSOLE IT SHOWING OLDER HISTORY"]. Claude Code 2.1.259 ships a
 * fullscreen TUI that paints on the terminal's ALTERNATE screen (`ESC[?1049h`),
 * switched on remotely through the `tui_fullscreen_upsell_trial` gate or locally by
 * the `tui:"fullscreen"` setting — so it can flip between two epochs of the SAME
 * session with no local code or config change. Everything drawn there is discarded
 * the moment the CLI exits, and every carry-respawn exits the CLI: two whole epochs
 * of su-8ef2d (22:53Z→00:08Z) vanished from the owner's console, leaving only their
 * "Resume this session with" exit lines, while the epoch before them (primary
 * screen) survived intact. The pty host's respawnTerminalHandoffBytes (WI-41386)
 * protects PRIMARY scrollback only; nothing host-side can save alternate-screen
 * frames, so the fix is to keep the child off that screen.
 *
 * `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` is a binary-verified CC 2.1.259 env key
 * (listed beside CLAUDE_CODE_DISABLE_MOUSE / _DISABLE_VIRTUAL_SCROLL in the
 * terminal-feature env table). An explicit value in the launch env WINS — an owner
 * who wants fullscreen sets it to `0` in their shell and this stamps nothing. `{}`
 * for non-claude: omp has always run on the alternate screen by design (the pty
 * host documents it), codex paints inline. Spread by every Claude spawn path
 * (launchFreshSu, buildResumeEnv, trackedForkEnvelopeEnv, role sessions) and
 * re-derived by the host-handoff successor ({@link healTerminalRenderEnv}) for the
 * same reason as the context-trimming trio: the handoff is written by the OLD code.
 */
export function terminalRenderEnv(agent, env = process.env) {
  if (agent !== "claude") return {};
  const explicit = env?.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN;
  if (explicit !== undefined && explicit !== "") return {};
  return { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1" };
}

/** Fill {@link terminalRenderEnv} into `env` wherever it is ABSENT (an explicitly
 *  carried value always wins) and return the keys filled — the host-handoff heal,
 *  same contract as {@link healContextTrimmingEnv}. */
export function healTerminalRenderEnv(env, agent = env?.PAPERCUSP_AGENT) {
  const filled = [];
  for (const [k, v] of Object.entries(terminalRenderEnv(agent, env))) {
    if (env[k] === undefined || env[k] === "") {
      env[k] = v;
      filled.push(k);
    }
  }
  return filled;
}

/** The canonical BARE cloud model aliases psu recognizes. Short + lowercase. The CLI/gateway own
 *  the full OPEN set of ids, so this list is used ONLY to spot an obviously-misspelled short alias
 *  (validateModelSpec) — never to gate full/provider ids. Includes Anthropic (opus/sonnet/haiku/fable)
 *  and OpenAI GPT-5.6 (sol/terra/luna) families. */
export const KNOWN_CLOUD_ALIASES = [
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "sol",
  "terra",
  "luna",
];

/** Native backend hint for unambiguous cloud model families. Unknown model ids
 * stay open-set and return null; explicit OMP remains valid for either family.
 *
 * ⚠ The `@returns` is load-bearing, not decoration (EI-19384804106131566). Left to
 * inference, this union's MEMBER ORDER is not stable across tsc invocations that
 * differ only in `outDir`: `gen:declarations` (outDir `.`) emitted
 * `"codex" | "claude"` while `gen:declarations:check` (outDir a temp dir) emitted
 * `"claude" | "codex"` from byte-identical sources, so the check reported this
 * declaration permanently stale and no amount of regenerating converged. Pinning the
 * order here makes the emit invariant. Do not remove it, and prefer an explicit
 * `@returns` on any other exported function whose inferred return is a union.
 *
 * @returns {'codex' | 'claude' | null}
 */
export function cloudModelBackendHint(model) {
  if (!model) return null;
  const withoutEffort = String(model)
    .trim()
    .replace(/:(low|medium|high|xhigh|max)$/i, "");
  const base = withoutEffort.replace(/\[[^\]]+\]$/, "");
  if (isLocalModelSpec(base)) return null;
  if (
    /^(luna|terra|sol)$/i.test(base) ||
    /^gpt(?:[-_.]|\d)/i.test(base) ||
    /^o\d(?:[-_.]|$)/i.test(base) ||
    /(?:^|[-_.\/])codex(?:[-_.\/]|$)/i.test(base)
  )
    return "codex";
  if (
    /^(opus|sonnet|haiku|fable)$/i.test(base) ||
    /^claude(?:[-_.\/]|$)/i.test(base) ||
    /^anthropic[.\/]claude(?:[-_.\/]|$)/i.test(base)
  )
    return "claude";
  return null;
}

/** Reject a native cloud model paired with the other native CLI. */
export function validateAgentModelPair(agent, model) {
  const hintedBackend = cloudModelBackendHint(model);
  if (!agent || agent === "omp" || !hintedBackend || agent === hintedBackend)
    return { ok: true };
  return {
    ok: false,
    message:
      `model \`${model}\` belongs to the \`${hintedBackend}\` backend, but this launch requested ` +
      `\`--agent=${agent}\`. Pass \`--agent=${hintedBackend}\`, or omit \`--agent\` and let psu infer it.`,
  };
}

/** Damerau optimal-string-alignment distance: Levenshtein PLUS adjacent transpositions as a single
 *  edit — so a swap typo (`fabel`↔`fable`) is distance 1, without widening the substitution radius
 *  (`o3`/`gpt4`/`grok` stay far from every alias). Tiny; only ever run over the ~4 known aliases. */
function damerauDistance(a, b) {
  const al = a.length;
  const bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  const d = Array.from({ length: al + 1 }, () => new Array(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) d[i][0] = i;
  for (let j = 0; j <= bl; j++) d[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // adjacent transposition
      }
    }
  }
  return d[al][bl];
}

/** Nearest known cloud alias to a (letters-only) token, with its Damerau distance. */
function nearestCloudAlias(letters) {
  const t = String(letters || "").toLowerCase();
  let alias = null;
  let dist = Infinity;
  for (const a of KNOWN_CLOUD_ALIASES) {
    const d = damerauDistance(t, a);
    if (d < dist) {
      dist = d;
      alias = a;
    }
  }
  return { alias, dist };
}

/**
 * Validate a hand-typed `--model` spec, catching the malformed-alias classes that otherwise
 * reach the CLI as an unrunnable model and fail the launch with NO useful hint (WI-1979):
 *   (1) a psu-INTERNAL `[1m]` 1M-window marker typed as INPUT on a bare non-family alias
 *       (`fabel5[1m]`) — psu APPENDS `[1m]` (see normalizeModelSpec); it is never something you type;
 *   (2) a bare short cloud alias that is a CLOSE misspelling of a known one (`fabel`→fable, `sonet`,
 *       `sonnet5`, `opus4`);
 *   (3) a known alias glued or dash/dot-separated to a version — `sonnet-5`, `opus-4.8`, `haiku-4` —
 *       the marketing name typed instead of the bare alias (or a full `claude-…` id). The most common agent typo.
 * Deliberately LENIENT — cloud model ids are an OPEN set (the CLI/gateway own the canonical list).
 * It only inspects values that unambiguously look like a bare short alias (pure letters, or
 * letters+digits). A dashed/dotted/slashed/versioned id (`claude-fable-5`, `anthropic.claude-3-5-…`,
 * a future `claude-newfam-6`, and legit `[1m]` round-trips like `claude-fable-5[1m]`) is a plausible
 * full id and PASSES UNCHECKED; so does a plausible non-alias short id (`o3`, `gpt4`) that is NOT a
 * close typo of a known alias, and any local/ollama id (validated separately by fuzzyEnum). Returns
 * { ok:true } | { ok:false, message }. Pure + exported. NO leading 'psu:' in the message — the
 * top-level launch catch prepends it.
 */
export function validateModelSpec(spec) {
  if (!spec) return { ok: true };
  const s = String(spec).trim();
  if (!s) return { ok: true };
  if (isLocalModelSpec(s)) return { ok: true }; // local — not ours to check
  // Peel a recognized :effort tail so we inspect the model BASE (an unrecognized ':x' — bedrock's
  // '…-v2:0' — stays on the base, which then contains ':' → not alias-shaped → passes below).
  const c = s.lastIndexOf(":");
  const effort =
    c > 0 && /^(low|medium|high|xhigh|max)$/i.test(s.slice(c + 1))
      ? s.slice(c + 1)
      : null;
  const base = effort ? s.slice(0, c) : s;
  // Peel a trailing [..] window marker: 'fable[1m]' → core 'fable', hadMarker true.
  const mk = base.match(/^(.*?)(\[[^\]]*\])$/);
  const core = mk ? mk[1] : base;
  const hadMarker = !!mk;
  const isPure = /^[a-z]+$/i.test(core); // opus, fabel
  const isLettersDigits = /^[a-z]+[0-9]+$/i.test(core); // fabel5, sonnet5, o3
  if (isPure && KNOWN_CLOUD_ALIASES.includes(core.toLowerCase()))
    return { ok: true }; // opus / fable / fable[1m]
  // (3) a known alias glued or dash/dot-separated to a version — `sonnet-5`, `opus-4.8`, `haiku-4`,
  //     `sonnet5` — the marketing name typed instead of the BARE alias (or a full id). The single most
  //     common malformed spec agents produce: psu resolves the bare alias to the latest generation and
  //     appends [1m], so `sonnet-5` reaches the CLI as an unrunnable id. A genuine full id starts with a
  //     VENDOR prefix (`claude-…`, `anthropic.…`), never a bare alias, so it is unaffected — checked HERE,
  //     BEFORE the dash/version passthrough below that would otherwise wave `sonnet-5` through as a full id.
  const aliasVer = core
    .toLowerCase()
    .match(/^(opus|sonnet|haiku|fable|sol|terra|luna)(?=[-.]?[0-9])/);
  if (aliasVer) {
    const fam = aliasVer[1];
    const prefix = /^(sol|terra|luna)$/i.test(fam) ? "gpt-5.6-" : "claude-";
    return {
      ok: false,
      message:
        `\`${s}\` is not a recognized model spec. Did you mean \`${effort ? `${fam}:${effort}` : fam}\`? ` +
        `Type the BARE alias (${KNOWN_CLOUD_ALIASES.join("/")}) — psu resolves it to the latest generation, appending the [1m] 1M-context window — ` +
        `not a versioned shorthand; pin a specific generation only as a full id (e.g. ${prefix}${fam}-5).`,
    };
  }
  // A full/provider id (dashes/dots/slashes/version) is NOT alias-shaped → open set, pass — including
  // a legit '[1m]' round-trip on a full id (e.g. 'claude-fable-5[1m]').
  if (!isPure && !isLettersDigits) return { ok: true };
  // Bare short token that is NOT a known alias (fabel / fabel5 / o3 / grok). Reject only when it is
  // either wearing a [1m] marker (never valid on a non-family bare token) OR a CLOSE typo (Damerau
  // distance ≤ 1) of a known alias — so genuinely-unknown ids like `o3` / `gpt4` pass untouched.
  const near = nearestCloudAlias(core.replace(/[0-9]+$/, ""));
  const closeTypo = near.alias != null && near.dist <= 1;
  if (!hadMarker && !closeTypo) return { ok: true };
  const suggestion = closeTypo
    ? ` Did you mean \`${effort ? `${near.alias}:${effort}` : `${near.alias}:xhigh`}\`?`
    : "";
  const markerTip = hadMarker
    ? " The `[1m]` 1M-context marker is appended AUTOMATICALLY by psu — do not type it."
    : "";
  return {
    ok: false,
    message:
      `\`${s}\` is not a recognized model spec.${suggestion}${markerTip} ` +
      `Cloud models: \`<alias>[:<effort>]\` — aliases ${KNOWN_CLOUD_ALIASES.join("/")}, ` +
      `effort low|medium|high|xhigh|max (e.g. \`fable:xhigh\`) — or a full id (e.g. claude-fable-5, anthropic.claude-…).`,
  };
}

/**
 * P-018 preflight window guard: estimate the session's BASELINE context
 * (persona file + catalog/prefix estimate) against the model window.
 *   - ≥60% of the window → refuse (unless force) — the session would have
 *     almost no working headroom and dies mid-task ("Prompt is too long").
 *   - ≥35% → warn loudly, proceed.
 * Pure + exported for tests; the caller decides how to surface it.
 */
export function preflightWindowGuard({
  personaBytes,
  contextSize,
  model,
  agent = "claude",
  budget = null,
}) {
  const shared =
    budget?.version === 1
      ? budget
      : buildContextBudget({
          agent,
          model,
          contextSize,
          estimatedPromptTokens: Math.round((personaBytes ?? 0) / 3.7),
        });
  return {
    level: shared.level,
    pct: shared.pct,
    estTokens: shared.baselineTokens,
    window: shared.window,
    budget: shared,
  };
}

/**
 * Validate the launch's context size and return the EFFECTIVE one: 'trimmed' for
 * both '' and the retired 'full' alias, and a throw for anything unrecognized. That
 * is the whole behaviour — it does not inspect the agent, and it has no Codex-specific
 * branch.
 *
 * HISTORY (why the whole-catalog mode is gone, not a live guard): WI-39948 — Codex's
 * code-mode bridge serializes the advertised tool surface into its per-call IPC
 * request, so advertising the whole catalog produced a ~128 MiB frame above the
 * bridge's hard 64 MiB limit; the session booted and then rejected EVERY tool call
 * before execution, and `--force` could not make that transport valid. Retiring the
 * mode removed that state at the source: 'full' now normalizes to 'trimmed' here, so
 * no caller can reach the oversized frame. The growable trimmed seed preserves full
 * reachability via tools:find/tools:invoke.
 *
 * This function was named assertCodexToolTransport and took an `agent` it never read.
 * Do not reintroduce that: a Codex-only backstop cannot fire, because 'full' is the
 * only recognized non-trimmed value and it normalizes rather than throwing.
 */
export function assertLaunchContextSize({ contextSize }) {
  const normalized = normalizeSuContextSize(contextSize);
  if (!normalized.ok) throw new Error(`psu: ${normalized.error}`);
  return normalized.contextSize;
}

/** Run both preflight guards before a launch; exits/throws per policy. */
export function runLaunchPreflight({
  promptFile,
  contextSize,
  model,
  agent = "claude",
  budget = null,
  force,
}) {
  const effectiveContextSize = assertLaunchContextSize({ contextSize });
  const personaBytes = assertLaunchPersona(promptFile);
  const guard = preflightWindowGuard({
    personaBytes,
    contextSize: effectiveContextSize,
    model,
    agent,
    budget,
  });
  if (guard.level === "refuse" && !force) {
    throw new Error(
      `psu: estimated baseline context ~${Math.round(guard.estTokens / 1000)}k tokens is ${Math.round(guard.pct * 100)}% of the ${Math.round(guard.window / 1000)}k model window — the session would die mid-task ("Prompt is too long"). Use --context-size=trimmed / a wider-window model, or --force to launch anyway (context-trimming-tiers P-018).`,
    );
  }
  if (guard.level !== "ok") {
    console.error(
      `psu: WARNING — estimated baseline context ~${Math.round(guard.estTokens / 1000)}k tokens (${Math.round(guard.pct * 100)}% of the ${Math.round(guard.window / 1000)}k window)${guard.level === "refuse" ? " [--force override active]" : ""} — headroom is thin; prefer --context-size=trimmed or a wider-window model (P-018).`,
    );
  }
  return guard;
}

/** su-context-size-variants: choose the initial-context size for the SU session —
 *  the terminal-picker twin of the operator UI's context select. 'trimmed' (core spine
 *  + the client's native soft-trim) is the default AND the only choice: the whole-catalog
 *  'full' mode is retired (normalized to 'trimmed' at the flag boundary) and there is no
 *  Native/no-flag row, so this prompt has exactly one selectable value. Threads into
 *  args.contextSize, honored per-agent in the launch tail (claude ENABLE_TOOL_SEARCH,
 *  omp PI_CONFIG_DIR, codex/server via the bootstrap body's context_size). */
async function pickContextSize() {
  const { select } = await import("@inquirer/prompts");
  return select({
    message: "Context size",
    default: SU_CONTEXT_DEFAULT,
    choices: SU_CONTEXT_CHOICES,
  });
}

// Subagent-launch (Task/Agent) picker toggle (owner mandate 2026-07-02). Denied by
// DEFAULT for every psu launch; this is the interactive opt-IN twin of the
// `--allow-subagents` flag. Disabled is the highlighted default (Enter = deny), so
// a launch keeps subagents ONLY when the human deliberately arrows to Enabled.
export const SU_SUBAGENTS_CHOICES = [
  { name: "Disabled — cannot launch subagents (default)", value: false },
  {
    name: "Enabled — allow the built-in subagent-launch (Task/Agent) tool",
    value: true,
  },
];

/** Choose whether this session may launch subagents. Denied by default; returns a
 *  boolean threaded into args.allowSubagents (→ roleLaunchArgs/suLaunchArgs). A
 *  `--allow-subagents` / `--no-subagents` flag preselects + skips this (mirrors
 *  --context-size). claude-only — omp/codex have no deny flag and are unaffected. */
async function pickSubagents() {
  const { select } = await import("@inquirer/prompts");
  return select({
    message: "Subagents",
    default: false,
    choices: SU_SUBAGENTS_CHOICES,
  });
}

/** Pick a workspace. Harnesses are workspace-scoped, so this comes
 *  before the harness picker. Auto-resolves (no prompt) when there's
 *  0 or 1 workspace. Returns the workspace id (or null → active). */
async function pickWorkspace() {
  const { workspaces, activeWorkspace } = await api(
    "/api/agent-mcp/console/bootstrap-su/options",
  );
  if (!Array.isArray(workspaces) || workspaces.length <= 1) {
    return (
      activeWorkspace ?? (workspaces && workspaces[0] ? workspaces[0].id : null)
    );
  }
  const { select } = await import("@inquirer/prompts");
  return select({
    message: "Workspace",
    default: activeWorkspace ?? undefined,
    choices: workspaces.map((w) => ({
      name: w.id === activeWorkspace ? `${w.name}  (active)` : w.name,
      value: w.id,
    })),
  });
}

function filterRows(rows, term) {
  const t = (term || "").toLowerCase();
  return t ? rows.filter((r) => r.name.toLowerCase().includes(t)) : rows;
}

async function pickHarness(workspace) {
  const { search } = await import("@inquirer/prompts");
  const q = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
  const { harnesses, workspace: ws } = await api(
    `/api/agent-mcp/console/bootstrap-su/options${q}`,
  );
  const rows = [
    { name: `· workspace root — no harness  [${ws}]`, value: null },
    ...harnesses.map((h) => ({
      name: h.status ? `${h.slug}  (${h.status})` : h.slug,
      value: h.slug,
    })),
  ];
  return search({
    message: "Harness",
    source: async (term) => filterRows(rows, term),
  });
}

async function pickPlan(workspace, harness) {
  const { search } = await import("@inquirer/prompts");
  let plans = [];
  if (harness) {
    try {
      const params = new URLSearchParams({ harness });
      if (workspace) params.set("workspace", workspace);
      const r = await api(
        `/api/agent-mcp/console/bootstrap-su/options?${params.toString()}`,
      );
      plans = r.plans || [];
    } catch {
      plans = [];
    }
  }
  const rows = [
    { name: "NO PLAN — ad-hoc SU session", value: NO_PLAN },
    ...plans.map((p) => ({ name: p.slug, value: p.slug })),
  ];
  return search({
    message: "Plan",
    source: async (term) => filterRows(rows, term),
  });
}

/**
 * psu-account-chooser P-005: pick a pool account to pin this session to (gateway
 * routing), or the system/CLI login. Returns the account id, or the literal `system`
 * for "skip the gateway" — INCLUDING when the picker is hidden: gateway off, an empty
 * pool, or any fetch error. It returns `system` rather than null BY DESIGN: an
 * unspecified account means "the owner's nominated default account" server-side
 * (P-004), which is a gateway route — see accountPickerChoices. The picker can only
 * return the system login when no nondefault routes are available; explicit
 * `--account auto|<pin>` flags are validated separately and fail closed. The
 * "default" row is FIRST so hitting enter keeps the machine's own credential;
 * accounts blocked by the active session-override are shown disabled.
 */
/** The account-pin choices the gateway offers for a workspace (gatewayOn + pool + session-override).
 *  Live `/options` endpoint — deployed everywhere, unlike a bespoke pin endpoint (deploy-skew safe).
 *  null on any error (fail-soft → no pin). */
async function fetchAccountChoices(workspace, agent = "claude") {
  try {
    const params = new URLSearchParams();
    if (workspace) params.set("workspace", workspace);
    if (agent) params.set("agent", agent);
    const q = params.toString() ? `?${params.toString()}` : "";
    return (
      (await api(`/api/agent-mcp/console/bootstrap-su/options${q}`)).accounts ??
      null
    );
  } catch {
    return null;
  }
}

/** WI-126377: the host-local OMP model registry (`omp models --json`), read off
 *  the SAME `/options` response this file already fetches for workspaces,
 *  harnesses, plans, accounts and fleets — and the same `ompCatalog` field the
 *  GUI's New Session launcher renders, so the terminal and the window cannot
 *  offer different models.
 *
 *  Fail-soft to `[]` on every failure mode, including the endpoint's OWN
 *  `status:'unavailable'` (it reports a catalog read failure in-band rather than
 *  erroring, precisely so one broken `omp` binary cannot take down the rest of
 *  the picker). The caller then shows its alias rows and the free-text escape —
 *  degraded, never absent. */
async function fetchOmpModelCatalog(workspace) {
  try {
    const q = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
    const r = await api(`/api/agent-mcp/console/bootstrap-su/options${q}`);
    const catalog = r?.ompCatalog;
    if (!catalog || catalog.status !== "available") return [];
    return Array.isArray(catalog.models) ? catalog.models : [];
  } catch {
    return [];
  }
}

/** Build the account picker rows from already-fetched choices. Pure so the
 * provider-specific routing contract is regression-testable without driving
 * Inquirer. */
export function accountPickerChoices(accounts) {
  const pool = Array.isArray(accounts?.pool) ? accounts.pool : [];
  // psu-account-chooser: ALWAYS show the picker (at least the default option) so
  // the choice is consistent across machines — a fresh install with no gateway
  // pool still gets the "default = system/CLI login" row, instead of silently
  // skipping the screen the dev box shows. (Was: hidden when pool empty.)
  const exclude = new Set(accounts?.excludeAccounts ?? []);
  const forced = new Set(accounts?.forcedAccounts ?? []);
  // account-routing-3-options: offer auto only when the provider has a usable
  // pool. Claude carries the unpinned route in env; Codex carries it in the
  // per-session CODEX_HOME provider block (WI-3645). OMP requests are resolved
  // against their model's underlying Claude/Codex provider before reaching here.
  const provider = accounts?.provider ?? "claude";
  const showAuto =
    pool.length > 0 && (provider === "claude" || provider === "codex");
  return [
    // ⚠ The value MUST be the LITERAL `system` escape hatch — NEVER null/'' (default-deploy-account
    // -2026-08-08 P-004 D-002). The server's resolveAccountPin reads an UNSPECIFIED account as
    // "whatever the owner nominated": once a workspace has a default account configured, a null
    // here routed this row THROUGH the inference gateway (as `auto`, default-account-first) while
    // its label promised the exact opposite — a silent misroute onto a pool credential, observed
    // 2026-08-19 (su-254aa2e1: picked `default`, launched with ANTHROPIC_BASE_URL=:8788 and sat
    // minutes behind the pool's weekly-cap pacing while a plain `claude` answered in 1s).
    // `none`/`system` is the ONE spelling P-004 keeps pinned to the machine's own login, always —
    // and it is what this row has always SAID it does. The nominated-default route is still
    // reachable: it is exactly the `auto` row below (resolveAccountPin routes a configured default
    // as auto, default-first + failover).
    {
      name: "· default — use the system / CLI login (skip the inference gateway)",
      value: "system",
    },
    ...(showAuto
      ? [
          {
            name: "· auto — route via the inference gateway (nominated default account first, then failover)",
            value: "auto",
          },
        ]
      : []),
    ...pool.map((id) => {
      const state = accounts?.accountStates?.[id];
      const blocked = exclude.has(id) || (forced.size > 0 && !forced.has(id)) || state === "unavailable";
      const tag = exclude.has(id)
        ? "  (excluded)"
        : forced.size > 0 && !forced.has(id)
          ? "  (not in allow-list)"
          : state === "unavailable"
            ? "  (used up — usage limit reached)"
            : state === "unknown"
              ? "  (usage unverified)"
              : "";
      return {
        name: `${id}${tag}  (pin via the gateway)`,
        value: id,
        disabled: blocked
          ? state === "unavailable" && !exclude.has(id) && !(forced.size > 0 && !forced.has(id))
            ? "(usage limit reached)"
            : "(blocked by session-override)"
          : false,
      };
    }),
  ];
}

/** Render the account picker from already-fetched choices. Returns the chosen id, or the literal
 *  `system` for "the machine's own login — skip the gateway" (also the preselected row, and what an
 *  empty pool / gateway-off offers). It is deliberately NOT null: see accountPickerChoices. */
async function promptAccount(accounts) {
  const { select } = await import("@inquirer/prompts");
  const choices = accountPickerChoices(accounts);
  return select({ message: "Account routing", default: "system", choices });
}

async function pickAccount(workspace, agent = "claude") {
  // Per-account inference-gateway pinning is implemented for claude + codex only;
  // omp (and any future backend) has no per-account routing yet — the server
  // ignores a pool pin for it ("account routing is unsupported for <agent>", see
  // the resume path). So for those agents we KEEP the picker for a consistent
  // launch flow but offer ONLY the default = system/CLI-login row (no pool), so
  // the user can't pick a pin that would be silently dropped.
  if (agent !== "claude" && agent !== "codex") {
    return promptAccount({ pool: [] });
  }
  const accounts = await fetchAccountChoices(workspace, agent);
  // Always surface the picker (at least the default = system/CLI-login row),
  // even when the gateway is off / the pool is empty / the operator is
  // unreachable. (Was: returned null without prompting when accounts was null,
  // so a fresh install never saw the account screen the dev box shows.)
  return promptAccount(accounts ?? {});
}

/**
 * Derive a stable fleet slug from a user-entered name. MIRRORS
 * `fleetSlugFromName` in packages/operator-core/lib/agent-fleets-store.ts (kept in
 * sync) — the launcher is plain Node ESM and can't import the TS store. The server
 * RE-DERIVES authoritatively from the entered name (sent as `fleet_name`), so this
 * client copy is only the picker's display value. Pure — exported for tests.
 */
export function fleetSlugFromName(name) {
  const slug = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "fleet";
}

/** Parse a `#rrggbb` hex into `[r,g,b]`, or null when malformed. Pure — exported
 *  for tests. */
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(
    String(hex ?? "").trim(),
  );
  return m
    ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
    : null;
}

/** A 2-cell ANSI truecolor swatch in the scheme's background (trailing space), or
 *  '' when there is no/invalid color — so a picker row degrades cleanly to plain
 *  text for a fleet with no bound color. `color` is the `{ bg, fg, cursor }` the
 *  /options endpoint resolves per fleet (fleet-color-schemes). Pure — for tests. */
export function colorSwatch(color) {
  const rgb = color && hexToRgb(color.bg);
  if (!rgb) return "";
  const [r, g, b] = rgb;
  return `\x1b[48;2;${r};${g};${b}m  \x1b[0m `;
}

/** The durable named fleets the workspace offers (agent_fleets rows — they persist
 *  even with zero live members, D-003), plus `nextScheme` (the color a NEW fleet
 *  would be allocated, for the create-row preview). Same live `/options` endpoint
 *  the account picker reads. Fail-soft → `{ fleets: [], nextScheme: null }` so the
 *  picker still shows its two default rows. */
async function fetchFleetChoices(workspace) {
  try {
    const params = new URLSearchParams();
    if (workspace) params.set("workspace", workspace);
    const q = params.toString() ? `?${params.toString()}` : "";
    const resp = await api(`/api/agent-mcp/console/bootstrap-su/options${q}`);
    return {
      fleets: Array.isArray(resp.fleets) ? resp.fleets : [],
      nextScheme: resp.nextScheme ?? null,
      schemes: Array.isArray(resp.schemes) ? resp.schemes : [],
    };
  } catch {
    return { fleets: [], nextScheme: null, schemes: [] };
  }
}

/**
 * named-su-agent-fleets P-006: pick a named fleet to run this session in, create a
 * new one, or stay unfleeted (default). Mirrors pickAccount — the FIRST row keeps
 * today's behavior (no fleet, no name). Picking an existing persisted fleet JOINS it
 * as a member; entering a NEW name makes this agent the LEADER of a freshly-created
 * fleet (D-002). Returns `{ slug, role, name }`: slug+role null for "no fleet";
 * `name` is set only for a freshly-entered new fleet (its title — threaded to the
 * server, which creates the agent_fleets row + re-derives the slug authoritatively).
 */
async function pickFleet(workspace) {
  const { fleets, nextScheme, schemes } = await fetchFleetChoices(workspace);
  const existing = Array.isArray(fleets) ? fleets : [];
  const NEW = "__new__";
  const { select, input } = await import("@inquirer/prompts");
  // fleet-color-schemes: prefix each existing fleet with a swatch in its bound
  // color, and the create-row with the color a new fleet would get (nextScheme).
  const choices = [
    { name: "· no fleet — default (no name)", value: null },
    { name: `${colorSwatch(nextScheme)}+ create a new fleet…`, value: NEW },
    ...existing.map((f) => ({
      name: `${colorSwatch(f.color)}${f.title || f.slug}`,
      value: f.slug,
    })),
  ];
  const chosen = await select({ message: "Fleet", default: null, choices });
  if (chosen === null)
    return { slug: null, role: null, name: null, scheme: null };
  if (chosen === NEW) {
    const name = (await input({ message: "New fleet name" })).trim();
    if (!name) return { slug: null, role: null, name: null, scheme: null }; // empty name → no fleet
    // fleet-color-schemes: pick the fleet's colour — the full catalog, each row a
    // swatch in its own colour, defaulting to the next-unused scheme. The chosen
    // NAME is threaded to the server (fleet_scheme), which forces it at create.
    const scheme = await pickFleetScheme(schemes, nextScheme);
    return { slug: fleetSlugFromName(name), role: "leader", name, scheme };
  }
  return { slug: chosen, role: "member", name: null, scheme: null };
}

/** Offer the curated catalog as a colour picker for a NEW fleet — each row a swatch
 *  (bg block) + the scheme name in its cursor accent, defaulting to the next-unused
 *  scheme. Returns the chosen scheme NAME; falls back to nextScheme's name (else
 *  null → server auto-allocates) when the catalog isn't available. */
async function pickFleetScheme(schemes, nextScheme) {
  const catalog = Array.isArray(schemes) ? schemes : [];
  if (!catalog.length) return nextScheme?.name ?? null;
  const { select } = await import("@inquirer/prompts");
  const choices = catalog.map((s) => ({
    name: `${colorSwatch(s)}${schemeNameInAccent(s)}`,
    value: s.name,
  }));
  return select({
    message: "Fleet color",
    default: nextScheme?.name ?? catalog[0].name,
    choices,
    loop: false,
  });
}

/** A scheme's name rendered in its own cursor accent (ANSI truecolor fg), or plain
 *  when the colour is unparseable. Pure — for the fleet colour-picker rows; for tests. */
export function schemeNameInAccent(scheme) {
  const rgb = scheme && hexToRgb(scheme.cursor);
  if (!rgb) return scheme?.name ?? "";
  const [r, g, b] = rgb;
  return `\x1b[38;2;${r};${g};${b}m${scheme.name}\x1b[0m`;
}

/** True if `id` is a pinnable account given the gateway choices (pool membership + session-override
 *  allow/exclude). Pure — mirrors the server's resolveAccountPin gating. Exported for tests. */
export function accountPinnable(accounts, id) {
  if (!id || !accounts?.gatewayOn) return false;
  const pool = Array.isArray(accounts.pool) ? accounts.pool : [];
  if (!pool.includes(id)) return false;
  const exclude = accounts.excludeAccounts ?? [];
  const forced = accounts.forcedAccounts ?? [];
  if (exclude.includes(id)) return false;
  if (forced.length > 0 && !forced.includes(id)) return false;
  return true;
}

export function accountProviderFromChoices(accounts, agent = "claude") {
  if (accounts?.provider === "claude" || accounts?.provider === "codex")
    return accounts.provider;
  if (accounts && Object.prototype.hasOwnProperty.call(accounts, "provider"))
    return null;
  return agent === "codex" ? "codex" : "claude";
}

/**
 * Choose (prompt) / honor (`--account`) the account for a RESUME, then build the inference-gateway
 * pin env CLIENT-SIDE (gatewayPinEnv) — the resume mints no session, so it can't ride the
 * bootstrap-su POST that folds the pin for a fresh launch, and the launcher must not depend on a
 * server endpoint that may not be deployed where it points (the 404 deploy-skew bug). Gating reuses
 * the live `/options` choices. Returns `{ id, forward, env, notice }`: `forward`/`id` for the FORK
 * path (folded server-side via the bootstrap POST), `env`/`notice` for the in-place resume
 * (launchResume). A default route forwards the explicit `system` marker because omitting the
 * account at bootstrap means "owner-nominated default", which may be gateway-routed.
 * Scripting (`--no-picker`) with no account uses the default system login. A
 * user-selected `auto` or named pin is fail-closed: if the gateway/provider/pin
 * cannot be honored, this function throws instead of silently returning the
 * default-account marker.
 */
export async function chooseResumeAccount(session, args) {
  const plan = resumeAccountPlan(args);
  if (plan.source === "none") {
    return {
      mode: "default",
      id: null,
      forward: "system",
      env: defaultAccountEnv(),
      notice: null,
    }; // --no-picker + no --account = system credential
  }

  // account-routing-3-options: the `default` keyword (or '' / none / system) is resolved by NAME —
  // it deliberately skips the gateway, so it needs no pool fetch. (The picker path resolves its
  // keyword AFTER fetching the choices, below.)
  if (!plan.prompt && accountRoutingMode(plan.account) === "default") {
    return {
      mode: "default",
      id: null,
      forward: "system",
      env: defaultAccountEnv(),
      notice: "using the default system account (inference gateway skipped).",
    };
  }

  const selectedModel = String(args?.model || "").trim();
  const ompModelRoute =
    session.agent === "omp" && selectedModel
      ? ompGatewayModelFromSpec(selectedModel)
      : null;
  if (session.agent === "omp" && selectedModel && !ompModelRoute) {
    if (plan.prompt) {
      return {
        mode: "default",
        id: null,
        forward: "system",
        env: defaultAccountEnv(),
        notice: null,
      };
    }
    throw new Error(
      `--account ${plan.account} could not be honored: OMP model '${selectedModel}' is not compatible with gateway account routing. ` +
        "Refusing model substitution and default-system fallback.",
    );
  }
  const accountAgent =
    session.agent === "omp"
      ? (ompModelRoute?.accountProvider ?? "claude")
      : session.agent;
  const expectedProvider =
    ompModelRoute?.accountProvider ??
    (session.agent === "codex" ? "codex" : "claude");
  const accounts = await fetchAccountChoices(session.workspaceId, accountAgent);
  if (
    !accounts?.gatewayOn ||
    !(Array.isArray(accounts.pool) && accounts.pool.length)
  ) {
    // No explicit nondefault choice exists on the prompt path because the picker
    // hides unavailable gateway rows; omission therefore remains the product's
    // default system route. A flag-selected auto/pin is a contract and must fail.
    if (plan.prompt)
      return {
        mode: "default",
        id: null,
        forward: "system",
        env: defaultAccountEnv(),
        notice: null,
      };
    throw new Error(
      `--account ${plan.account} could not be honored: inference gateway off / no pool. ` +
        "Refusing to fall back to the default system login.",
    );
  }

  const requested = plan.prompt ? await promptAccount(accounts) : plan.account;
  const mode = accountRoutingMode(requested);
  if (mode === "default") {
    return {
      mode: "default",
      id: null,
      forward: "system",
      env: defaultAccountEnv(),
      notice: requested
        ? "using the default system account (inference gateway skipped)."
        : null,
    };
  }

  const provider = accountProviderFromChoices(accounts, accountAgent);

  if (mode === "auto") {
    if (provider !== expectedProvider) {
      throw new Error(
        `--account auto could not be honored: ${session.agent}${selectedModel ? ` model '${selectedModel}'` : ""} requires a ${expectedProvider} account pool. ` +
          "Refusing to fall back to the default system login.",
      );
    }
    // `forward: 'auto'` is the value a TRACKED fork sends to the server (resolveAccountPin) so the
    // fork re-derives the same auto-route — `id` is null here, so the fork's `id` fallback alone
    // would silently drop the choice.
    return {
      mode: "auto",
      id: null,
      auto: true,
      forward: "auto",
      provider,
      env:
        session.agent === "claude"
          ? gatewayAutoEnv(provider, session.coordOwnerId)
          : {},
      notice:
        "routing through the inference gateway (auto — it selects an available pool account and fails over).",
    };
  }

  // mode === 'pin'
  const id = requested;
  if (!accountPinnable(accounts, id)) {
    throw new Error(
      `--account ${id} could not be honored: not an allowed pool account. ` +
        "Refusing to fall back to the default system login.",
    );
  }
  if (!provider) {
    throw new Error(
      `--account ${id} could not be honored: account routing is unsupported for ${session.agent}. ` +
        "Refusing to fall back to the default system login.",
    );
  }
  if (provider !== expectedProvider) {
    throw new Error(
      `--account ${id} could not be honored: '${id}' is a ${provider} account, but ` +
        `${session.agent}${selectedModel ? ` model '${selectedModel}'` : ""} requires ${expectedProvider} accounts. ` +
        "Refusing to fall back to the default system login.",
    );
  }
  return {
    mode: "pin",
    id,
    provider,
    env:
      session.agent === "claude"
        ? gatewayPinEnv(id, provider, session.coordOwnerId)
        : { PAPERCUSP_ACCOUNT_ID: id },
    notice: `pinned to ${provider === "codex" ? "Codex " : ""}account ${id} (routed through the inference gateway).`,
  };
}

/** Sentinel for the "no feature" picker row (optional-feature roles). */
const NO_FEATURE = "<no-feature>";

/** SU is the interactive execution tier. Identity is selected once the
 * workspace/harness is known; scripted --role keeps its existing route. */
export async function pickRole() {
  return { role: "su", roles: [] };
}

/** Catalog rows are already source-validated by the operator. Preserve
 * unusable entries as disabled choices with the actual failure reason. */
export function identityPickerChoices(page) {
  const choices = [{ name: "SU  — default identity", value: "su" }];
  for (const identity of page.identities || []) {
    if (identity.slots?.length === 0 && identity.launchCompatibility?.eligible) {
      choices.push({
        name: `${identity.id}  ·  named composition  ·  ${identity.tier}  ·  ${identity.version || "unversioned"}  ·  ${identity.sourceRevision?.slice(0, 12) || "unversioned source"}`,
        value: `composition:${identity.id}`,
        ...(/^[a-f0-9]{64}$/.test(identity.sourceRevision || "")
          ? {} : { disabled: "source revision unavailable" }),
      });
    }
    for (const slot of identity.slots || []) {
      const ref = `${slot.slot}:${identity.id}`;
      choices.push({
        name: `${identity.id}  ·  ${slot.slot}  ·  ${identity.tier}  ·  ${identity.version || "unversioned"}  ·  ${identity.sourceRevision?.slice(0, 12) || "unversioned source"}`,
        value: ref,
        ...(identity.launchCompatibility?.eligible === false
          ? { disabled: identity.launchCompatibility.reason || "not launchable" }
          : slot.cardinality && /^[a-f0-9]{64}$/.test(identity.sourceRevision || "")
            ? {} : { disabled: "unsupported slot or source revision unavailable" }),
      });
    }
  }
  for (const entry of page.unreadable || []) {
    choices.push({ name: `${entry.id}  ·  invalid: ${entry.error}`, value: `invalid:${entry.id}`,
      disabled: entry.error });
  }
  if (page.nextAfter) choices.push({ name: "Load more identities…", value: "__next__" });
  return choices;
}

export async function pickIdentity(workspace, harness) {
  const { select } = await import("@inquirer/prompts");
  let after = null;
  for (;;) {
    const query = new URLSearchParams({ identities: "1", limit: "30" });
    if (workspace) query.set("workspace", workspace);
    if (harness) query.set("harness", harness);
    if (after) query.set("after", after);
    const page = await api(`/api/agent-mcp/console/bootstrap-su/options?${query}`);
    const choice = await select({ message: "Identity", default: "su", choices: identityPickerChoices(page) });
    if (choice === "su") return { stack: [], selectedIdentityRevision: null };
    if (choice === "__next__") {
      if (!page.nextAfter || page.nextAfter === after) throw new Error("identity catalog cursor did not advance");
      after = page.nextAfter;
      continue;
    }
    const identity = (page.identities || []).find((entry) =>
      entry.slots?.some((slot) => `${slot.slot}:${entry.id}` === choice) ||
      (entry.slots?.length === 0 && `composition:${entry.id}` === choice));
    if (!identity || identity.launchCompatibility?.eligible === false ||
        !/^[a-f0-9]{64}$/.test(identity.sourceRevision || "")) {
      throw new Error("selected identity has no validated source revision");
    }
    return { stack: [choice], selectedIdentityRevision: identity.sourceRevision };
  }
}

/** Role sessions support claude, omp, and codex interactively. codex
 *  runs in a per-session CODEX_HOME (bootstrap-role mints it). */
async function pickRoleBackend() {
  const { select } = await import("@inquirer/prompts");
  return select({
    message: "Backend",
    choices: [
      { name: "claude", value: "claude" },
      { name: "omp", value: "omp" },
      { name: "codex", value: "codex" },
    ],
  });
}

/** Harness picker that REQUIRES a real harness (role sessions are
 *  harness-scoped — no workspace-root option). */
async function pickHarnessRequired(workspace) {
  const { search } = await import("@inquirer/prompts");
  const q = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
  const { harnesses } = await api(
    `/api/agent-mcp/console/bootstrap-su/options${q}`,
  );
  const rows = (harnesses || []).map((h) => ({
    name: h.status ? `${h.slug}  (${h.status})` : h.slug,
    value: h.slug,
  }));
  if (rows.length === 0) {
    console.error(
      "psu: no harnesses registered in this workspace — a role session needs one.",
    );
    process.exit(1);
  }
  return search({
    message: "Harness",
    source: async (term) => filterRows(rows, term),
  });
}

/** Feature picker. `need` = 'required' (must pick) | 'optional' (offer
 *  a "no feature" row). Returns the feature id or null. */
async function pickFeature(workspace, harness, need) {
  const { search } = await import("@inquirer/prompts");
  let features = [];
  try {
    const params = new URLSearchParams({ harness, features: "1" });
    if (workspace) params.set("workspace", workspace);
    const r = await api(
      `/api/agent-mcp/console/bootstrap-su/options?${params.toString()}`,
    );
    features = r.features || [];
  } catch {
    features = [];
  }
  const featureRows = features.map((f) => ({
    name: f.title
      ? `${f.id}  —  ${f.title}${f.status ? `  (${f.status})` : ""}`
      : f.id,
    value: f.id,
  }));
  const rows =
    need === "optional"
      ? [
          { name: "NO FEATURE — run the role unscoped", value: NO_FEATURE },
          ...featureRows,
        ]
      : featureRows;
  if (rows.length === 0) {
    console.error(
      `psu: role needs a feature but harness '${harness}' has none.`,
    );
    process.exit(1);
  }
  const picked = await search({
    message: "Feature",
    source: async (term) => filterRows(rows, term),
  });
  return picked === NO_FEATURE ? null : picked;
}

/**
 * Should this interactive launch run through the managed-pty host
 * (turn-lifecycle-control Phase 3, P-012)? Pure — exported for tests.
 *
 * Rollout gate. `PAPERCUSP_PSU_NO_PTY=1` is an always-wins kill switch.
 * Otherwise the default is `PTY_DEFAULT_ON`; until the P-015 feel-check is
 * confirmed it's opt-IN via `PAPERCUSP_PSU_PTY=1` so the default launch path
 * stays byte-identical for the live fleet (psu-launcher is exec'd directly — an
 * edit hits every agent's next launch). Needs a real TTY on both ends (we bridge
 * raw mode); a non-TTY launch (the brain dock pane, --no-picker scripts) keeps
 * the plain inherit spawn, which is correct — there's no terminal to bridge.
 *
 * HEADLESS (headless-fleet-launch-and-carry-knob-2026-07-10 P-001, D-004): a
 * headless FLEET MEMBER has no terminal either, but unlike the dock pane it MUST
 * still be injectable — its whole lifecycle is warm `loop:arm` wakes delivered by
 * the wake-executor. Without a managed pty there is no control socket and no
 * `~/.papercusp/psu-pty/<ownerId>.json` discovery file, so wake-executor Channel 1b
 * can't find it, Channel 3 fires instead ("session pid alive but not an injectable
 * managed pty") and the member PARKS FOREVER after one turn. So `--headless` /
 * `PAPERCUSP_PSU_HEADLESS=1` bypasses EXACTLY ONE thing: the isTTY check. It does
 * NOT override the kill switch and does NOT override an explicit `PAPERCUSP_PSU_PTY=0`.
 *
 * This is sound because `hostThroughPty` is TTY-optional by construction: the pty
 * itself comes from node-pty (the child still sees a real pty), `bridgeTty` defaults
 * to `stdin.isTTY` → false here, and the pty is sized from `sanePtyDim(stdout.columns,
 * 80, …)` which falls back to 80x24 for a non-TTY stdout. Only the bridge to a HUMAN's
 * terminal needs a TTY, and a headless member has no human. Keep the pty, drop the
 * terminal emulator.
 */
// P-012/P-015: managed-pty IS the interactive launch path (D-006). Flipped on
// 2026-06-08 after the mechanical feel-check passed end-to-end (a real bash
// driven through the host: cooked-line editing + backspace, $COLUMNS from the
// pty size, Ctrl-C interrupts the foreground job without killing the shell,
// bracketed-paste/readline intact, clean exit). Per-launch escape hatches stay:
// `PAPERCUSP_PSU_PTY=0` opts one launch out, `PAPERCUSP_PSU_NO_PTY=1` is the
// always-wins kill switch. A non-TTY launch (brain dock pane, --no-picker
// scripts) still takes the plain inherit spawn — there's no terminal to bridge.
export const PTY_DEFAULT_ON = true;
export function usePtyHost({
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
} = {}) {
  if (env.PAPERCUSP_PSU_NO_PTY === "1") return false;
  const enabled =
    env.PAPERCUSP_PSU_PTY === "1"
      ? true
      : env.PAPERCUSP_PSU_PTY === "0"
        ? false
        : PTY_DEFAULT_ON;
  if (!enabled) return false;
  // A headless launch has no TTY BY DESIGN, but still needs the injectable pty.
  if (env.PAPERCUSP_PSU_HEADLESS === "1") return true;
  return !!(stdin.isTTY && stdout.isTTY);
}

/**
 * The terminal THIS psu launch owns, as a device path — or null when there isn't one
 * (headless bee, brain dock pane, `--no-picker` script, piped stdio).
 *
 * WI-3665. Every agent CLI renders its fleet identity (👑 leader / 👤 member + fleet name
 * + colour square) into the OS title with an OSC-0 escape, written from a hook. Those hooks
 * used to open `/dev/tty` — the CONTROLLING terminal — and Claude Code never gives them one:
 * it spawns the statusLine command setsid'd, so the open raised ENXIO on every tick and the
 * title silently never appeared. Exporting the answer as PAPERCUSP_TTY fixes it for good,
 * because ENV crosses the setsid boundary that a controlling terminal does not.
 *
 * Resolved HERE, at launch, on purpose: psu is the process that attaches the agent to the
 * terminal, so it is the only one that knows — authoritatively — which terminal the session
 * owns. The tempting alternative (have the hook walk /proc ancestry to the nearest tty)
 * works but is unsafe: ancestry crosses ownership boundaries, so a headless bee whose
 * ancestor chain reaches a dev terminal would retitle a window it doesn't own. Measured on
 * the dev box while diagnosing this: a bash under one agent walks up to another agent's
 * `claude` and resolves to that agent's /dev/pts/65.
 *
 * Correct under the managed-pty host too. We export psu's OUTER tty (the real terminal),
 * not the inner pty slave: a write there lands on the terminal directly, and the inner pty
 * doesn't exist yet at env-assembly time anyway.
 *
 * @param {object} [o]
 * @param {NodeJS.ReadStream} [o.stdin]
 * @param {NodeJS.WriteStream} [o.stdout]
 * @param {string} [o.platform]  process.platform (injected for tests)
 * @param {(p: string) => string} [o.readLink]  readlinkSync (injected for tests)
 * @param {(pid: number) => string} [o.psTty]   `ps -o tty=` reader (injected for tests)
 * @param {(p: string) => boolean} [o.exists]   existsSync (injected for tests)
 * @returns {string | null} an absolute device path, or null when no terminal is owned
 */
export function resolveOwnedTtyPath({
  stdin = process.stdin,
  stdout = process.stdout,
  platform = process.platform,
  readLink = readlinkSync,
  psTty = defaultPsTty,
  exists = existsSync,
} = {}) {
  // No tty on either end ⇒ this launch owns no terminal. Say so; never guess.
  if (!stdout.isTTY && !stdin.isTTY) return null;

  // Linux: /proc/self/fd/<n> is a symlink to the device. Prefer stdout, then stdin —
  // a launch may have one redirected. (fd 2 is deliberately NOT consulted: stderr is
  // routinely redirected to a log while the session still owns a terminal.)
  if (platform === "linux") {
    for (const fd of [1, 0]) {
      try {
        const p = readLink(`/proc/self/fd/${fd}`);
        if (p.startsWith("/dev/pts/") || p.startsWith("/dev/tty")) return p;
      } catch {
        /* fd redirected / proc unavailable — try the next */
      }
    }
  }

  // macOS/BSD have no /proc and node exposes no ttyname(3). `ps -o tty=` reports the
  // controlling terminal by NAME, and the spelling varies by platform and device:
  //   linux  'pts/24'          → /dev/pts/24
  //   darwin 's003'            → /dev/ttys003   (the short form drops the 'tty')
  //   darwin 'ttys003'         → /dev/ttys003
  //   either 'console'         → /dev/console   (NOT /dev/ttyconsole)
  // Rather than guess the prefix from the spelling, probe: the device that exists is the
  // device we own. Only ever return a path that is really there.
  try {
    const name = psTty(process.pid).trim();
    if (name && name !== "?" && name !== "??" && name !== "-") {
      const candidates = name.startsWith("/dev/")
        ? [name]
        : [`/dev/${name}`, `/dev/tty${name}`];
      for (const path of candidates) {
        if (exists(path)) return path;
      }
    }
  } catch {
    /* no ps / unexpected output — fall through */
  }
  return null;
}

/** `ps -o tty= -p <pid>` — split out so resolveOwnedTtyPath stays unit-testable. */
function defaultPsTty(pid) {
  return execFileSync("ps", ["-o", "tty=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 1000,
  });
}

/** Default claim-registry directory — one small marker file per terminal device.
 *  Override (tests only) via PAPERCUSP_TTY_CLAIMS_DIR. */
export const TTY_CLAIMS_DIR = join(homedir(), ".papercusp", "tty-claims");

/** Turn a device path into a safe, collision-free filename for the claims dir. */
function ttyClaimFilename(ttyPath) {
  return ttyPath.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+/, "");
}

/**
 * Claim `ttyPath` as owned by `sid`, overwriting whatever session claimed it before.
 *
 * EI-10377 (2026-07-12/13, caught on camera during a demo shoot). A Linux pty's minor
 * number is NOT a stable identity: devpts allocates each `/dev/pts/N`'s inode
 * deterministically from N itself (measured on this box: ino == minor + 3), so once a
 * pty is closed, its number is handed to the very next terminal that opens one — the
 * new terminal is indistinguishable from the old at the path level. PAPERCUSP_TTY
 * (WI-3665) is resolved ONCE at launch and then lives in a session's env for its
 * entire lifetime; a session that keeps firing hooks after the WINDOW that spawned it
 * is gone (an orphaned hook process, or a fleet loop still warm past its xterm being
 * killed) will happily `open(its stale PAPERCUSP_TTY, 'w')` and SUCCEED, because that
 * path now belongs to a completely different, unrelated session. `open()` has no way
 * to detect that from the path alone — which is exactly how su-9859e's title landed on
 * su-c70f4's (luna's) terminal on stage :110.
 *
 * The fix: every launch that owns a terminal stamps a claim file for that path with its
 * own session id, overwriting any prior claim — including a STALE one left by whichever
 * session used to own that path. A writer then checks the CURRENT claim before it opens
 * PAPERCUSP_TTY (see pc_tty.py's `tty_owned_by_us` / coord-hook.ts's `ttyOwnedByUs` — the
 * two must stay in lockstep with this, same as every other WI-3665 title mechanic); if
 * the claim now names someone else, the write is skipped exactly like a closed terminal.
 * A recycled path is ALWAYS re-stamped before it's usable again (the new xterm's own psu
 * launch runs this same code first), so the stale writer's next attempt sees the
 * mismatch and backs off instead of clobbering it.
 *
 * Fire-and-forget / best-effort, like every other title mechanic here: a claim-file
 * write must never fail a launch.
 */
export function claimTtyOwnership(ttyPath, sid, { dir } = {}) {
  if (!ttyPath || !sid) return;
  const claimsDir = dir || TTY_CLAIMS_DIR;
  try {
    mkdirSync(claimsDir, { recursive: true });
    writeFileSync(join(claimsDir, ttyClaimFilename(ttyPath)), sid, "utf8");
  } catch {
    /* cosmetic guard — never fail a launch over a claim-file write */
  }
}

/** The settings.json a claude launch will actually read: the per-session isolated
 *  CLAUDE_CONFIG_DIR when psu pinned one (EI-155), else the shared user-level dir. */
function effectiveClaudeSettingsPath(env, home = homedir()) {
  const dir = (env.CLAUDE_CONFIG_DIR ?? "").trim();
  return join(dir || join(home, ".claude"), "settings.json");
}

/**
 * mcp-transport-resilience P-002 (2026-07-13): derive the re-exec-durable
 * permissions this launch's composed claude argv expresses. A Claude Code
 * self-relaunch (auto-update relaunch / TUI fullscreen switch) re-execs with
 * REBUILT argv — every launch flag is dropped (the recovery-banner class):
 * `--permission-mode` fell back to the default, and the `--disallowedTools`
 * deny sets (native-scheduler lockout, no-subagents) degraded to
 * honor-the-playbook. settings.json in the per-session CLAUDE_CONFIG_DIR is
 * RE-READ by the re-exec'd process, so mirroring the flags there makes them
 * survive mechanically. Handles both `--flag=value` and `--flag value` forms;
 * `--dangerously-skip-permissions` maps to defaultMode 'bypassPermissions'
 * (claude unions repeated --disallowedTools occurrences; so do we). Null when
 * the argv expresses no permissions at all. Pure — exported for tests.
 */
export function reExecSafePermissionsFromArgs(args) {
  const deny = [];
  let defaultMode = null;
  const list = Array.isArray(args) ? args : [];
  for (let i = 0; i < list.length; i++) {
    const a = String(list[i] ?? "");
    if (a === "--dangerously-skip-permissions")
      defaultMode = "bypassPermissions";
    else if (a === "--permission-mode" && list[i + 1] != null)
      defaultMode = String(list[++i]);
    else if (a.startsWith("--permission-mode="))
      defaultMode = a.slice("--permission-mode=".length);
    else if (a.startsWith("--disallowedTools="))
      deny.push(...a.slice("--disallowedTools=".length).split(","));
    else if (a === "--disallowedTools" && list[i + 1] != null)
      deny.push(...String(list[++i]).split(","));
  }
  const cleaned = [...new Set(deny.map((t) => t.trim()).filter(Boolean))];
  if (!defaultMode && cleaned.length === 0) return null;
  return { defaultMode, deny: cleaned };
}

/**
 * Merge the argv-derived permissions (reExecSafePermissionsFromArgs) into the
 * per-session settings.json — P-002's IO leg. ONLY writes when this launch has
 * an isolated CLAUDE_CONFIG_DIR: deny rules must never bleed into the shared
 * ~/.claude/settings.json (they'd outlive the session and constrain the owner's
 * own launches). Read-modify-write preserving every other key; ATOMIC
 * (tmp + rename) for the same partial-read reason as psu-pty-host's writeMeta.
 * deny UNIONS with any existing deny (removing an entry is a human edit, never
 * ours to undo); defaultMode is overwritten (this launch's mode is current).
 * Fail-open: a write failure warns and the launch continues on argv flags
 * alone — exactly the pre-P-002 behavior. Exported for tests.
 */
export function persistReExecSafePermissions({
  env,
  args,
  log = (m) => process.stderr.write(m),
}) {
  try {
    const dir = (env?.CLAUDE_CONFIG_DIR ?? "").trim();
    if (!dir) return false;
    const derived = reExecSafePermissionsFromArgs(args);
    if (!derived) return false;
    const path = join(dir, "settings.json");
    let current = {};
    try {
      current = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      current = {}; // absent/corrupt — start clean; the merge below re-creates it
    }
    if (!current || typeof current !== "object" || Array.isArray(current))
      current = {};
    const permissions =
      current.permissions &&
      typeof current.permissions === "object" &&
      !Array.isArray(current.permissions)
        ? { ...current.permissions }
        : {};
    if (derived.defaultMode) permissions.defaultMode = derived.defaultMode;
    if (derived.deny.length > 0) {
      const existing = Array.isArray(permissions.deny) ? permissions.deny : [];
      permissions.deny = [...new Set([...existing, ...derived.deny])];
    }
    const next = { ...current, permissions };
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, path);
    return true;
  } catch (e) {
    try {
      log(
        `psu: could not persist re-exec-safe permissions (${e?.message ?? e}) — launch continues on argv flags alone.\n`,
      );
    } catch {
      /* diagnostic only */
    }
    return false;
  }
}

/**
 * Remove copied user-level auth routing from an isolated default-account
 * session's settings.json. This is the re-exec-durable half of
 * applyDefaultClaudeAuthSettingsArgs: Claude self-relaunches can drop argv, but
 * they re-read this file. We DELETE credential env keys instead of persisting
 * empty values because an empty CLAUDE_CODE_OAUTH_TOKEN suppresses the normal
 * file/Keychain login fallback.
 *
 * The command-line override still handles higher-precedence project/local
 * settings on the initial launch. Managed settings remain an administrator
 * policy and intentionally outrank every user launch choice.
 */
export function persistDefaultClaudeAuthSettings({
  wrapperBin,
  env,
  log = (m) => process.stderr.write(m),
}) {
  try {
    if (!/(^|\/)claude(-su)?$/.test(String(wrapperBin || ""))) return false;
    const mode = env?.[ACCOUNT_ROUTING_MODE_ENV];
    if (!["default", "auto", "pin"].includes(mode)) return false;
    const dir = (env?.CLAUDE_CONFIG_DIR ?? "").trim();
    if (!dir) return false;
    const path = join(dir, "settings.json");
    let current = {};
    try {
      current = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      current = {};
    }
    if (!current || typeof current !== "object" || Array.isArray(current))
      current = {};
    const settingsEnv =
      current.env &&
      typeof current.env === "object" &&
      !Array.isArray(current.env)
        ? { ...current.env }
        : {};
    for (const key of [
      ...CLAUDE_DEFAULT_AUTH_ENV_KEYS,
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_OAUTH_TOKEN",
      "PAPERCUSP_ANTHROPIC_URL",
      "PAPERCUSP_ACCOUNT_ID",
      "PAPERCUSP_CODEX_GATEWAY",
    ]) {
      delete settingsEnv[key];
    }
    if (mode === "auto" || mode === "pin") {
      for (const key of [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_CUSTOM_HEADERS",
      ]) {
        if (env[key]) settingsEnv[key] = env[key];
      }
    } else if (isCacheProxyUrl(env.ANTHROPIC_BASE_URL)) {
      settingsEnv.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL; // P-006, same rationale as above
    }
    const next = { ...current, apiKeyHelper: "", env: settingsEnv };
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, path);
    return true;
  } catch (e) {
    try {
      log(
        `psu: could not persist explicit-route Claude auth settings (${e?.message ?? e}) — launch continues on env/argv enforcement.\n`,
      );
    } catch {
      /* diagnostic only */
    }
    return false;
  }
}

/**
 * Should THIS launch silence Claude Code's own terminal-title writer?
 *
 * WI-3665. Claude Code writes its current topic to the OS title (`✳ Claude Code`, then
 * `⠐ <topic>`) — verified by capturing its pty output: 1 OSC-0 write by default, 0 with
 * CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1. Papercusp's statusline hook writes the FLEET
 * identity to that same title (👑 leader / 👤 member + fleet + colour square + objective).
 * Two writers on one title means last-writer-wins and the title flickers between them.
 *
 * The fleet identity is the one the owner asked to see, and it already carries the topic as
 * its 🔭 objective segment — so when our statusline is in charge, Claude's writer is pure
 * contention and we turn it off.
 *
 * GUARDED, because silencing the only writer would leave NO title at all:
 *   - claude backends only (codex/omp never wrote a title of their own);
 *   - only when this launch owns a terminal (headless ⇒ nobody writes; leave defaults);
 *   - only when the statusLine claude will actually load IS our hook. A user with a
 *     personal statusLine keeps Claude's title — the installer likewise refuses to clobber
 *     a foreign statusLine, and these two refusals must agree.
 * Fail-open: an unreadable/absent settings.json ⇒ don't silence.
 *
 * Pure but for the settings read; `readFile` is injected for tests.
 */
export function shouldSilenceClaudeTitle({
  agent,
  ownsTty,
  env = process.env,
  home = homedir(),
  readFile = (p) => readFileSync(p, "utf8"),
} = {}) {
  if (agent !== "claude" || !ownsTty) return false;
  try {
    const cfg = JSON.parse(readFile(effectiveClaudeSettingsPath(env, home)));
    return String(cfg?.statusLine?.command ?? "").includes(
      "statusline-fleet.sh",
    );
  } catch {
    return false; // absent/unreadable settings ⇒ never silence the only writer
  }
}

/**
 * Supervisor presence beat (agent-liveness-heartbeat-hardening-2026-06-12
 * P-004): while psu is the live PARENT of the agent child — which it is in
 * BOTH launch paths (spawnInherit waits + forwards exit; the pty host owns
 * the pty for the session's lifetime) — keep the session's coord_presence
 * row warm via the bootstrap-su heartbeat endpoint. Process-alive semantics,
 * the interactive analog of the fleet nursery beat (operator-spawn.ts
 * ensureSpawnHeartbeatLoop): an agent in an hour-long turn making NO tool
 * calls stays live; the beat dies with this process (child exit →
 * process.exit kills the timer; the timer is unref'd so it never holds psu
 * open on its own).
 *
 * Quiet + fail-soft by design: a down/wedged operator means missed beats,
 * never terminal spam or an error loop. touchHeartbeat server-side is a
 * no-op when no presence row exists (D-003) — declare-intent at session
 * start mints the row, this only keeps it warm.
 *
 * pid/host (WI-3898 P1, coord:presence liveness parity): this beat genuinely
 * runs AS this session's own parent process — "the beat dies with this
 * process" above is exactly the invariant a liveness probe needs — so it is
 * the one call site that can honestly report its own `process.pid`/
 * `hostname()`. The server stores them on the presence row (never defaults
 * them itself — see presence.ts's file-header note) so a same-machine reader
 * can later verify liveness via a local `kill(pid, 0)` probe instead of
 * trusting heartbeat_at recency alone.
 *
 * Exported with injectables for tests (scripts/__tests__).
 */
export const SUPERVISOR_BEAT_MS =
  EXTERNAL_SCHEDULES.psuSupervisorHeartbeat.defaultIntervalMs;

/**
 * EI-19412221266350408 — consecutive `sessionTerminal` beats required before psu exits.
 *
 * >1 on purpose. A single reply is one sample of a distributed verdict; two consecutive
 * ones cost at most one extra beat (~60s) against a zombie that otherwise lingers for
 * HOURS (the observed one held its slot ~10h, idle 20h), and it means no single anomalous
 * response can terminate a live agent.
 */
export const TERMINAL_BEATS_TO_EXIT = 2;

/**
 * Minimum psu uptime before a terminal verdict may act. Startup is exactly when a session
 * is least established — it has declared no intent and armed no wake yet — so it is the
 * window where a spurious terminal verdict would be most damaging AND most likely. A
 * genuine zombie is hours old, so waiting costs nothing it can measure.
 */
export const MIN_UPTIME_BEFORE_SELF_EXIT_MS = 5 * 60_000;

/**
 * EI-19412221266350408 — exit when this session is authoritatively FINISHED.
 *
 * The zombie this closes: psu outlived its agent session by ~9h, holding a fleet slot, a
 * pid and a cgroup with nothing running inside it — and THIS beat is what made it look
 * healthy, by warming the presence row long after the session died (the corpse read
 * heartbeatFresh:true + sessionState:'recorded'). So the beat is the right place to ask
 * "am I beating for a corpse?": it already runs every 60s, already talks to the operator,
 * and already dies with this process.
 *
 * The server answers ONLY on positive ended-session evidence (see terminalSessionVerdict in
 * bootstrap-su.ts). The liveness oracle's `sessionState:'recorded'` means a LIVE recorded
 * session that is not wake-dispatchable (`ended_at IS NULL`), so it must never terminate
 * this launcher. This side adds two more conservative gates — consecutive confirmations
 * and a minimum uptime — and RESETS the streak on any non-terminal or failed beat. Every
 * degraded path keeps psu alive: the failure mode is a zombie that lingers, never a live
 * agent that is killed.
 * @param {string|null} ownerId
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.intervalMs]
 * @param {string} [options.operatorUrl]
 * @param {string|null} [options.token]
 * @param {(callback:()=>void, ms:number)=>{unref?:()=>void}} [options.setIntervalImpl]
 * @param {string|null} [options.tty]
 * @param {number} [options.pid]
 * @param {number} [options.beatsToExit]
 * @param {number} [options.minUptimeMs]
 * @param {()=>number} [options.uptimeMsFn]
 * @param {()=>void} [options.onTerminalSession]
 */
export function startSupervisorBeat(
  ownerId,
  {
    fetchImpl = fetch,
    intervalMs = SUPERVISOR_BEAT_MS,
    operatorUrl = OPERATOR_URL,
    token = null,
    setIntervalImpl = setInterval,
    // EI-19948333346987654: the terminal device path THIS launch owns (from
    // resolveOwnedTtyPath() at spawn time — see the call site), reported on
    // every beat exactly like pid/host below. null for a headless launch.
    tty = null,
    // Attached engines run inside an operator host: report the CHILD, never
    // the host process, as the supervised session's liveness identity.
    pid = process.pid,
    // Injectables for tests; defaults are the real process behaviour.
    beatsToExit = TERMINAL_BEATS_TO_EXIT,
    minUptimeMs = MIN_UPTIME_BEFORE_SELF_EXIT_MS,
    uptimeMsFn = () => process.uptime() * 1000,
    onTerminalSession = () => {
      console.error(
        `psu: this session is recorded as ENDED but psu is still running — exiting so the slot, pid and ` +
          `cgroup are reclaimed (EI-19412221266350408).`,
      );
      process.exit(0);
    },
  } = {},
) {
  if (!ownerId) return null;
  let terminalStreak = 0;
  const beat = async () => {
    try {
      const tok = token ?? readToken();
      const res = await fetchImpl(
        operatorUrl + "/api/agent-mcp/console/bootstrap-su/heartbeat",
        {
          method: "POST",
          signal: AbortSignal.timeout(5_000),
          headers: {
            "content-type": "application/json",
            ...(tok ? { authorization: `Bearer ${tok}` } : {}),
          },
          body: JSON.stringify({
            ownerId,
            pid,
            host: hostname(),
            ...(tty ? { tty } : {}),
          }),
        },
      );
      // Any unreadable/absent body is NOT a terminal verdict — it resets the streak, like
      // any other beat that failed to produce an explicit answer.
      let terminal = false;
      try {
        terminal = Boolean((await res?.json?.())?.sessionTerminal);
      } catch {
        terminal = false;
      }
      if (!terminal) {
        terminalStreak = 0;
        return;
      }
      terminalStreak += 1;
      if (terminalStreak >= beatsToExit && uptimeMsFn() >= minUptimeMs)
        onTerminalSession();
    } catch {
      /* missed beat — the next tick retries; never surface. A beat that did not complete
       * proves nothing about the session, so it must not count toward the streak. */
      terminalStreak = 0;
    }
  };
  const timer = setIntervalImpl(() => {
    void beat();
  }, intervalMs);
  if (typeof timer?.unref === "function") timer.unref();
  void beat(); // immediate first beat so a fresh session is warm at once
  return timer;
}

/**
 * Acknowledged "my child exited" report: stamps the tracked adv row's
 * ended_at/exit_code (bootstrap-su/session-ended), so the resume picker and
 * roster stop showing dead sessions as `· active` and the session-dir GC's
 * open-row protection actually expires. psu is the live parent in BOTH launch
 * paths (the same property the supervisor beat rides), so child-exit is the
 * one reliable place to stamp it. A stable attempt key makes overload and
 * unknown-response replay safe. Before the request, psu writes a local pending
 * witness; acknowledgement removes it, while an unavailable operator leaves it
 * for the next resume to reconcile after its writer-liveness checks. Exported
 * with injectables for tests. Never rejects.
 *
 * @param {number|string|null} advSessionId  the adv_sessions PK to stamp
 * @param {number|null|undefined} exitCode   the child's exit code (null when unknown)
 * @param {{ fetchImpl?: typeof fetch, operatorUrl?: string, token?: string|null,
 *           timeoutMs?: number, connectBudgetMs?: number, timeoutRetries?: number,
 *           killedBySignal?: string|null, launchFailed?: boolean,
 *           endAttemptKey?: string, sleep?: (ms:number)=>Promise<void>,
 *           now?: ()=>number, home?: string }} [opts]
 *   `killedBySignal` is the signal NAME that killed the child, or null for a voluntary
 *   exit. The server derives `ended_by` from it (WI-38054); omitting it makes every kill
 *   record as a clean self-reported exit. `launchFailed` is used when the launcher
 *   claimed a tracked resume row but never got a child process running; the server
 *   records that as cleanup so the row is immediately retryable rather than waiting
 *   for stale-claim recovery.
 */
export function pendingSessionEndWitnessPath(advSessionId, home = homedir()) {
  return join(
    home,
    ".papercusp",
    "psu-lifecycle",
    `session-${Number(advSessionId)}-ended.json`,
  );
}

export function readPendingSessionEndWitness(advSessionId, home = homedir()) {
  try {
    const parsed = JSON.parse(
      readFileSync(pendingSessionEndWitnessPath(advSessionId, home), "utf8"),
    );
    return parsed?.advSessionId === Number(advSessionId) &&
      typeof parsed?.endAttemptKey === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function writePendingSessionEndWitness(witness, home = homedir()) {
  const path = pendingSessionEndWitnessPath(witness.advSessionId, home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(witness)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  return path;
}

/**
 * @typedef {object} SessionEndReportOptions
 * @property {(input:any, init?:any)=>Promise<any>} [fetchImpl]
 * @property {string} [operatorUrl]
 * @property {string|null} [token]
 * @property {number} [timeoutMs]
 * @property {number} [connectBudgetMs]
 * @property {number} [timeoutRetries]
 * @property {string|null} [killedBySignal]
 * @property {boolean} [launchFailed]
 * @property {string} [endAttemptKey]
 * @property {(ms:number)=>Promise<void>} [sleep]
 * @property {()=>number} [now]
 * @property {string} [home]
 */

/**
 * @param {number|string|null} advSessionId
 * @param {number|null|undefined} exitCode
 * @param {SessionEndReportOptions} [opts]
 */

export async function reportSessionEnded(advSessionId, exitCode, opts = {}) {
  const {
    fetchImpl = fetch,
    operatorUrl = OPERATOR_URL,
    token = null,
    timeoutMs = 2_000,
    connectBudgetMs = 5_000,
    timeoutRetries = 1,
    killedBySignal = null,
    launchFailed = false,
    endAttemptKey = randomUUID(),
    // WI-10002854: a REPLAYED pending witness passes its ORIGINAL observation time. Stamping
    // the replay time instead would let a stale end observation of a killed predecessor
    // re-end the row a successor (a headless wake resume) reactivated in between.
    observedAt = null,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    home = homedir(),
  } = opts;
  if (!advSessionId) return { reported: false, reason: "no-session" };
  const observedMs =
    typeof observedAt === "string" ? Date.parse(observedAt) : Number.NaN;
  const witness = {
    advSessionId: Number(advSessionId),
    exitCode: exitCode ?? null,
    killedBySignal: killedBySignal ?? null,
    launchFailed: launchFailed === true,
    endAttemptKey,
    observedAt: Number.isFinite(observedMs)
      ? new Date(observedMs).toISOString()
      : new Date(now()).toISOString(),
  };
  try {
    writePendingSessionEndWitness(witness, home);
  } catch {
    // A read-only/broken home loses only crash recovery; the acknowledged
    // server transition remains authoritative.
  }
  try {
    const tok = token ?? readToken();
    const response = await fetchWithResilience(
      operatorUrl + "/api/agent-mcp/console/bootstrap-su/session-ended",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(tok ? { authorization: `Bearer ${tok}` } : {}),
        },
        // WI-38054: `killedBySignal` is what lets the server tell a VOLUNTARY exit from a
        // kill. Without it every end reports as `ended_by='self'`, and because a signal
        // death carries exitCode 0, the row then positively asserts a clean exit — which
        // is how a sidecar restart reaped two of the owner's agents unnoticed.
        body: JSON.stringify({
          advSessionId: Number(advSessionId),
          exitCode: exitCode ?? null,
          killedBySignal: killedBySignal ?? null,
          ...(launchFailed ? { launchFailed: true } : {}),
          endAttemptKey,
          // WI-10002854: lets the server refuse to end a successor incarnation that
          // started after this observation (markAdvSessionEnded observedAt).
          observedAt: witness.observedAt,
        }),
      },
      {
        fetchImpl,
        sleep,
        now,
        timeoutMs,
        connectBudgetMs,
        timeoutRetries,
        retryBootstrapFailures: true,
        label: `session end report for #${advSessionId}`,
      },
    );
    if (!response?.ok) {
      return {
        reported: false,
        reason: "http",
        status: response?.status ?? null,
        endAttemptKey,
      };
    }
    if (typeof response.json === "function") {
      const body = await response.json().catch(() => null);
      if (body && body.ok !== true) {
        return {
          reported: false,
          reason: "http",
          status: response?.status ?? null,
          endAttemptKey,
        };
      }
    }
    rmSync(pendingSessionEndWitnessPath(advSessionId, home), { force: true });
    return { reported: true, endAttemptKey };
  } catch (error) {
    return {
      reported: false,
      reason: "transport",
      detail: error instanceof Error ? error.message : String(error),
      endAttemptKey,
    };
  }
}

/**
 * Atomically ACQUIRE the right to resume a tracked session without claiming the
 * child is live. `psu --resume` reuses the original coord identity + adv row, so
 * it must reserve that row before backend-specific setup, then finalize only from
 * a concrete direct-child/managed-pty spawn. The keyed endpoint preserves the
 * prior terminal tuple until that second transition; an abandoned launcher lease
 * therefore expires without creating a ghost live session. Bounded and
 * fail-closed — a resume must never spawn after a lost/unknown acquisition.
 * Exported with injectables for tests.
 *
 * RETURNS A DISCRIMINATED OUTCOME, not a bare boolean (EI-21414979137146784).
 * Four independent conditions refuse the claim — no row, an HTTP/body failure, a
 * genuinely lost race, and a thrown transport error — and collapsing them into
 * `false` made the ONE call site assert contention for all four. A headless
 * consult revival then reported "its resume claim was not acquired" (i.e. someone
 * else won) when the truth was an unreachable operator, sending whoever debugged
 * it hunting a racing process that never existed. `claimed` remains the ONLY gate
 * on spawning — the fail-closed property is unchanged; `reason` exists so the
 * refusal can say WHICH of the four happened.
 *
 * @typedef {{ claimed: true, status: 'acquired', resumeClaimKey: string,
 *             replayed?: boolean, leaseExpiresAt?: string,
 *             legacyReactivation?: true }
 *   | { claimed: false, reason: 'no-session' | 'http' | 'contended' | 'transport',
 *       detail?: string, status?: 'reserved' | 'live' | 'missing',
 *       retryAfterMs?: number, leaseExpiresAt?: string, resumeClaimKey?: string }
 * } ResumeClaimOutcome
 * @typedef {object} ResumeClaimOptions
 * @property {(input:any, init?:any)=>Promise<any>} [fetchImpl]
 * @property {string} [operatorUrl]
 * @property {string|null} [token]
 * @property {number} [timeoutMs]
 * @property {number} [connectBudgetMs]
 * @property {number} [timeoutRetries]
 * @property {(ms:number)=>Promise<void>} [sleep]
 * @property {()=>number} [now]
 * @property {(message:string)=>any} [onNotice]
 * @property {string} [resumeClaimKey]
 * @property {unknown} [localLivenessEvidence]
 *
 * @param {number|string|null} advSessionId the adv_sessions PK to claim
 * @param {ResumeClaimOptions} [opts]
 * @returns {Promise<ResumeClaimOutcome>}
 */
export async function reportSessionResumed(advSessionId, opts = {}) {
  const {
    fetchImpl = fetch,
    operatorUrl = OPERATOR_URL,
    token = null,
    // Exact-session resume claims traverse the same MCP proxy as every other
    // psu bootstrap request. Keep their default budget on the shared derivation
    // instead of giving up while the proxy is still retrying an upstream.
    timeoutMs = REQUEST_TIMEOUT_MS,
    connectBudgetMs = CONNECT_RETRY_BUDGET_MS,
    timeoutRetries = 1,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    onNotice = (message) => process.stderr.write(message),
    resumeClaimKey = randomUUID(),
    localLivenessEvidence = null,
  } = opts;
  if (!advSessionId) return { claimed: false, reason: "no-session" };
  const claimKey = String(resumeClaimKey || "").trim();
  if (!claimKey) {
    return {
      claimed: false,
      reason: "http",
      detail: "resume acquisition requires a stable non-empty attempt key",
    };
  }
  try {
    const tok = token ?? readToken();
    const canonicalLocalLivenessEvidence = normalizeResumeLocalLivenessEvidence(
      localLivenessEvidence,
    );
    const post = (evidence) =>
      fetchWithResilience(
        operatorUrl + "/api/agent-mcp/console/bootstrap-su/session-resumed",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(tok ? { authorization: `Bearer ${tok}` } : {}),
          },
          body: JSON.stringify({
            advSessionId: Number(advSessionId),
            resumeClaimKey: claimKey,
            ...(evidence ? { localLivenessEvidence: evidence } : {}),
          }),
        },
        {
          fetchImpl,
          sleep,
          now,
          onNotice,
          timeoutMs,
          connectBudgetMs,
          timeoutRetries,
          retryBootstrapFailures: true,
          label: `resume claim for session #${advSessionId}`,
        },
      );
    let response = await post(canonicalLocalLivenessEvidence);
    // MIXED-VERSION ROLLOUT. This launcher runs straight from the staging
    // checkout (`psu` execs it by path) while the operator serves the green
    // release pin, so a witness KIND can be hours or days newer than the
    // endpoint that validates it — and an unknown kind is a hard 400. Without
    // this fallback, teaching the launcher a new kind would turn a refusal the
    // owner could at least act on into "operator returned HTTP 400", i.e. make
    // the very bug being fixed strictly worse until a deploy lands. Measured
    // 2026-09-02: :3070, :3170 and :3270 all rejected `no-live-claude-process`
    // while the launcher serving it was already live.
    //
    // Retrying WITHOUT the witness is exactly the pre-witness behavior, so the
    // degraded path is the old one, not a new one. The claim key is unchanged:
    // replaying it is the endpoint's documented idempotency contract, so this
    // cannot create a second claimant.
    if (
      response?.ok === false &&
      response?.status === 400 &&
      canonicalLocalLivenessEvidence
    ) {
      onNotice(
        `psu: this operator does not recognize the '${canonicalLocalLivenessEvidence.kind}' local-liveness ` +
          `witness (HTTP 400); retrying the resume claim without it. Deploy the current operator to restore ` +
          `evidence-based reconciliation of a stale-live row.\n`,
      );
      response = await post(null);
    }
    if (!response?.ok || typeof response.json !== "function") {
      const status =
        typeof response?.status === "number" ? response.status : null;
      return {
        claimed: false,
        reason: "http",
        detail:
          status == null
            ? "operator returned an unusable response"
            : `operator returned HTTP ${status}`,
      };
    }
    let body;
    try {
      body = await response.json();
    } catch (err) {
      // A malformed body is the OPERATOR answering badly, not the network
      // failing — classify it with the other HTTP-shaped failures so the
      // refusal does not blame the transport.
      return {
        claimed: false,
        reason: "http",
        detail: `operator response body was unreadable (${err instanceof Error ? err.message : String(err)})`,
      };
    }
    // New callers require the two-phase typed reservation. Accepting only the
    // legacy reactivated:true field here would recreate the old bug: acquisition
    // would assert liveness before any child had spawned.
    if (body?.acquired === true && body?.status === "acquired") {
      return {
        claimed: true,
        status: "acquired",
        resumeClaimKey: claimKey,
        ...(typeof body.replayed === "boolean"
          ? { replayed: body.replayed }
          : {}),
        ...(typeof body.leaseExpiresAt === "string"
          ? { leaseExpiresAt: body.leaseExpiresAt }
          : {}),
      };
    }
    if (
      body?.acquired === false &&
      ["reserved", "live", "missing"].includes(body?.status)
    ) {
      return {
        claimed: false,
        reason: "contended",
        status: body.status,
        resumeClaimKey: claimKey,
        ...(Number.isFinite(body.retryAfterMs)
          ? { retryAfterMs: body.retryAfterMs }
          : {}),
        ...(typeof body.leaseExpiresAt === "string"
          ? { leaseExpiresAt: body.leaseExpiresAt }
          : {}),
      };
    }
    // Mixed-version rollout compatibility. The launcher runs from the staging
    // checkout while the operator serves the green release pin, so the client
    // can become newer than the endpoint for hours (or longer behind a wedged
    // gate). Pre-reservation operators atomically reactivated only an ENDED row
    // and returned { ok, reactivated }. That is still a single-winner claim for
    // clean-ended sessions; contain its weaker lifecycle semantics explicitly:
    // launchResume skips the v2 finalize endpoint and re-ends the row on every
    // pre-spawn failure. A false legacy verdict remains fail-closed because it
    // cannot distinguish an already-live row from a missing one.
    if (
      body?.ok === true &&
      body?.acquired === undefined &&
      body?.status === undefined &&
      typeof body?.reactivated === "boolean"
    ) {
      if (body.reactivated) {
        onNotice(
          `psu: operator predates typed resume reservations; using its legacy atomic reactivation contract for session #${advSessionId}. ` +
            "Pre-spawn failures will be re-ended; deploy the current operator to restore lease-backed handoff.\n",
        );
        return {
          claimed: true,
          status: "acquired",
          resumeClaimKey: claimKey,
          legacyReactivation: true,
        };
      }
      return {
        claimed: false,
        reason: "contended",
        status: "live",
        resumeClaimKey: claimKey,
      };
    }
    return {
      claimed: false,
      reason: "http",
      detail:
        "operator response did not contain a typed resume reservation verdict",
      resumeClaimKey: claimKey,
    };
  } catch (err) {
    /* fail closed — never spawn without the atomic claim. The error was
       previously swallowed entirely; capture it so the refusal can name the
       transport fault instead of asserting a race that never happened. */
    return {
      claimed: false,
      reason: "transport",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * @typedef {object} ResumeAcquireRecoveryOptions
 * @property {string} [resumeClaimKey]
 * @property {(advSessionId:number|string|null, opts:{resumeClaimKey:string})=>Promise<ResumeClaimOutcome>} [reportImpl]
 * @property {(ms:number)=>Promise<void>} [sleep]
 * @property {()=>number} [now]
 * @property {(message:string)=>any} [onNotice]
 * @property {number} [waitBudgetMs]
 * @property {unknown} [localLivenessEvidence]
 */

/**
 * Ride through another launcher's short reservation with the SAME local attempt
 * key. If that launcher finalizes, the retry returns `live`; if it died, expiry
 * admits this key. HTTP/transport/missing/live verdicts return immediately —
 * only a truthful held lease authorizes waiting.
 *
 * @param {number|string|null} advSessionId
 * @param {ResumeAcquireRecoveryOptions} [opts]
 * @returns {Promise<ResumeClaimOutcome>}
 */
export async function acquireSessionResumeWithRecovery(
  advSessionId,
  opts = {},
) {
  const {
    resumeClaimKey = randomUUID(),
    reportImpl = reportSessionResumed,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    onNotice = (message) => console.error(message),
    waitBudgetMs = 75_000,
    localLivenessEvidence = null,
  } = opts;
  const claimKey = String(resumeClaimKey || "").trim();
  const startedAt = now();
  const canonicalLocalLivenessEvidence = normalizeResumeLocalLivenessEvidence(
    localLivenessEvidence,
  );

  while (true) {
    const outcome = await reportImpl(advSessionId, {
      resumeClaimKey: claimKey,
      ...(canonicalLocalLivenessEvidence
        ? { localLivenessEvidence: canonicalLocalLivenessEvidence }
        : {}),
    });
    if (outcome.claimed || outcome.status !== "reserved") return outcome;

    const observedAt = now();
    const fromRetryAfter = Number(outcome.retryAfterMs);
    const fromExpiry = outcome.leaseExpiresAt
      ? Date.parse(outcome.leaseExpiresAt) - observedAt
      : Number.NaN;
    const leaseWaitMs =
      Number.isFinite(fromRetryAfter) && fromRetryAfter > 0
        ? fromRetryAfter
        : fromExpiry;
    const remainingBudgetMs = Math.max(
      0,
      waitBudgetMs - (observedAt - startedAt),
    );
    if (!Number.isFinite(leaseWaitMs) || leaseWaitMs < 0) {
      return {
        ...outcome,
        detail: "the held reservation omitted a usable retry delay and expiry",
      };
    }
    // A small boundary grace prevents an exact-expiry retry from arriving a few
    // milliseconds before the datastore's clock crosses the lease boundary.
    const waitMs = Math.max(1, Math.ceil(leaseWaitMs) + 50);
    if (waitMs > remainingBudgetMs) {
      return {
        ...outcome,
        detail:
          `the reservation remains held until ${outcome.leaseExpiresAt ?? "its reported expiry"}; ` +
          `that exceeds the ${waitBudgetMs}ms automatic wait budget`,
      };
    }
    onNotice(
      `psu: session #${advSessionId} has a resume reservation held until ` +
        `${outcome.leaseExpiresAt ?? "the reported lease expiry"}; waiting ${waitMs}ms ` +
        `and retrying with the same attempt key.`,
    );
    await sleep(waitMs);
  }
}

/**
 * Report a keyed post-acquire transition. The body is constructed once and
 * replayed unchanged by fetchWithResilience, so a response lost after commit
 * never creates a new claimant or substitutes a new key.
 *
 * @typedef {object} ResumeTransitionOptions
 * @property {(input:any, init?:any)=>Promise<any>} [fetchImpl]
 * @property {string} [operatorUrl]
 * @property {string|null} [token]
 * @property {number} [timeoutMs]
 * @property {number} [connectBudgetMs]
 * @property {number} [timeoutRetries]
 * @property {(ms:number)=>Promise<void>} [sleep]
 * @property {()=>number} [now]
 * @property {(message:string)=>any} [onNotice]
 * @property {string[]} [launchArgv] current resolved psu invocation, sent on finalize only
 */
async function reportSessionResumeTransition(
  transition,
  advSessionId,
  resumeClaimKey,
  opts = {},
) {
  const {
    fetchImpl = fetch,
    operatorUrl = OPERATOR_URL,
    token = null,
    timeoutMs = 10_000,
    connectBudgetMs = 10_000,
    timeoutRetries = 1,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    onNotice = (message) => process.stderr.write(message),
    launchArgv = null,
  } = /** @type {ResumeTransitionOptions} */ (opts);
  const verdictField = transition === "finalized" ? "finalized" : "released";
  if (!advSessionId) return { [verdictField]: false, reason: "no-session" };
  const claimKey = String(resumeClaimKey || "").trim();
  if (!claimKey) return { [verdictField]: false, reason: "no-key" };
  try {
    const tok = token ?? readToken();
    const response = await fetchWithResilience(
      operatorUrl +
        `/api/agent-mcp/console/bootstrap-su/session-resume-${transition}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(tok ? { authorization: `Bearer ${tok}` } : {}),
        },
        body: JSON.stringify({
          advSessionId: Number(advSessionId),
          resumeClaimKey: claimKey,
          ...(transition === "finalized" && Array.isArray(launchArgv)
            ? { launchArgv }
            : {}),
        }),
      },
      {
        fetchImpl,
        sleep,
        now,
        onNotice,
        timeoutMs,
        connectBudgetMs,
        timeoutRetries,
        retryBootstrapFailures: true,
        label: `resume ${transition} for session #${advSessionId}`,
      },
    );
    if (!response?.ok || typeof response.json !== "function") {
      return {
        [verdictField]: false,
        reason: "http",
        status: typeof response?.status === "number" ? response.status : null,
        resumeClaimKey: claimKey,
      };
    }
    const body = await response.json().catch(() => null);
    if (
      body?.ok !== true ||
      typeof body?.[verdictField] !== "boolean" ||
      body?.resumeClaimKey !== claimKey
    ) {
      return {
        [verdictField]: false,
        reason: "http",
        resumeClaimKey: claimKey,
      };
    }
    return {
      [verdictField]: body[verdictField],
      resumeClaimKey: claimKey,
      ...(body[verdictField] ? {} : { reason: "not-held" }),
    };
  } catch (error) {
    return {
      [verdictField]: false,
      reason: "transport",
      detail: error instanceof Error ? error.message : String(error),
      resumeClaimKey: claimKey,
    };
  }
}

/**
 * @typedef {{ finalized:boolean, reason?:string, status?:number|null,
 *             detail?:string, resumeClaimKey?:string }} ResumeFinalizeOutcome
 * @param {number|string|null} advSessionId
 * @param {string} resumeClaimKey
 * @param {ResumeTransitionOptions} [opts]
 * @returns {Promise<ResumeFinalizeOutcome>}
 */
export function reportSessionResumeFinalized(
  advSessionId,
  resumeClaimKey,
  opts = {},
) {
  return /** @type {Promise<ResumeFinalizeOutcome>} */ (
    reportSessionResumeTransition(
      "finalized",
      advSessionId,
      resumeClaimKey,
      opts,
    )
  );
}

/**
 * @typedef {{ released:boolean, reason?:string, status?:number|null,
 *             detail?:string, resumeClaimKey?:string }} ResumeReleaseOutcome
 * @param {number|string|null} advSessionId
 * @param {string} resumeClaimKey
 * @param {ResumeTransitionOptions} [opts]
 * @returns {Promise<ResumeReleaseOutcome>}
 */
export function reportSessionResumeReleased(
  advSessionId,
  resumeClaimKey,
  opts = {},
) {
  return /** @type {Promise<ResumeReleaseOutcome>} */ (
    reportSessionResumeTransition(
      "released",
      advSessionId,
      resumeClaimKey,
      opts,
    )
  );
}

/**
 * Reconstruct the current psu invocation for a tracked exact resume.
 *
 * The prior launch record supplies durable identity/placement flags (fleet,
 * carry, mode, etc.); model/account and per-invocation backend flags are
 * replaced with the values actually resolved for this resume. The resulting
 * argv is only sent after runWrapper reports a concrete child spawn, so a
 * failed setup never erases the last known-good launch record.
 */
export function resumeLaunchArgvRecord(
  session,
  {
    model = null,
    modelSource = null,
    account,
    addDir = [],
    allowSubagents = null,
    passthrough = [],
    launchMode = null,
    brain = false,
  } = {},
) {
  const recorded = Array.isArray(session?.launchArgv) ? session.launchArgv : [];
  let priorArgs = {};
  try {
    priorArgs = parseArgs(
      recorded[0] === "psu" ? recorded.slice(1) : recorded,
    );
  } catch {
    // A legacy/malformed record must not prevent the resume itself. The
    // session row below still gives us enough identity to build a safe record.
  }
  const effectiveArgs = {
    ...priorArgs,
    sessionPortSourceAdvSessionId: session?.id ?? null,
    agent: session?.agent || priorArgs.agent,
    workspace: session?.workspaceId ?? priorArgs.workspace ?? null,
    harness: session?.harnessSlug ?? priorArgs.harness ?? null,
    plan: session?.planSlug ?? priorArgs.plan ?? null,
    model,
    modelSource,
    addDir,
    allowSubagents,
    passthrough,
  };
  if (account !== undefined) {
    effectiveArgs.account =
      account?.mode === "auto" || account?.forward === "auto" || account?.auto === true
        ? "auto"
        : account?.mode === "pin" && account?.id
          ? account.id
          : account?.id || "default";
  }
  if (launchMode) {
    effectiveArgs.mode = launchMode.mode;
    effectiveArgs.modeSubject = launchMode.subject ?? null;
    effectiveArgs.modeInstructions = launchMode.instructions ?? null;
    effectiveArgs.modeOwnerDirected = launchMode.ownerDirected === true;
  }
  return psuLaunchArgvRecord(
    {
      agent: effectiveArgs.agent,
      workspace: effectiveArgs.workspace,
      harness: effectiveArgs.harness,
      plan: effectiveArgs.plan,
    },
    effectiveArgs,
    { brain },
  );
}

/**
 * Render a refused {@link ResumeClaimOutcome} as the clause the operator reads
 * (EI-21414979137146784). Each reason gets its OWN sentence: the old single
 * message asserted contention ("its resume claim was not acquired") for all
 * four refusal paths, so an unreachable operator or a 500 was reported as a
 * lost race. Every branch still refuses — this names the cause, it does not
 * soften the guard.
 *
 * @param {{ claimed: false, reason: 'no-session'|'http'|'contended'|'transport',
 *           detail?: string, status?: 'reserved'|'live'|'missing',
 *           retryAfterMs?: number, leaseExpiresAt?: string,
 *           resumeClaimKey?: string }} outcome
 * @param {{ agent?: 'claude'|'omp'|'codex'|null,
 *           processHolder?: { held?: boolean, pid?: number|null, reason?: string }|null }} [context]
 * @returns {string}
 */
export function describeResumeClaimRefusal(
  outcome,
  { agent = null, processHolder = null } = {},
) {
  const detail = outcome?.detail ? ` (${outcome.detail})` : "";
  if (outcome?.status === "reserved") {
    const expiry = outcome.leaseExpiresAt
      ? ` until ${outcome.leaseExpiresAt}`
      : "";
    return (
      `another resume attempt holds a reservation${expiry}; ` +
      `no agent-process liveness was inferred${detail}`
    );
  }
  if (outcome?.status === "live") {
    // WI-2141892 (claude) / WI-2142101 (omp): for an argv-probing backend the
    // local absence probe now runs BEFORE this check and, on a clean scan,
    // reconciles the row outright — so reaching a `live` refusal means one of
    // exactly two things, and saying WHICH is the difference between a route and
    // a dead end.
    //
    // Report only what the probe ACTUALLY returned. The omp branch used to assert
    // "No live managed-PTY host was found" unconditionally, which was a claim
    // about a check that had not run — and once claude and codex both reported
    // real observations, omp was the only backend whose message could be false.
    // A message asserting an unmade check is worse than no message at all.
    const argvProbeContext = () => {
      if (processHolder?.held) {
        return (
          ` A live process (pid ${processHolder.pid}) still carries this session id in its argv — that agent ` +
          `is RUNNING, most likely headless rather than in a window you can see. Talk to it (coord:send with ` +
          `wake:'required'), stop it first (processes:kill by taskId — never pkill -f), or branch alongside it with --fork.`
        );
      }
      if (!processHolder) {
        // The probe never ran for this resume — typically no coordOwnerId on the
        // row, so the PTY-host registry (keyed by ownerId) could not be consulted
        // and the witness was correctly withheld. Say that, rather than implying
        // a host lookup happened and came back empty.
        return (
          ` The local liveness probe did not run for this resume, so nothing here observed whether an agent ` +
          `process exists. Wait out the recent-active window, or use --fork (which mints a NEW identity and ` +
          `abandons this coord ownerId).`
        );
      }
      const why = processHolder.reason ? ` (${processHolder.reason})` : "";
      return (
        ` No live managed-PTY host was found, and the local process probe could not return a clean absence` +
        `${why}, so the guard stayed closed. Re-run psu --resume once the probe can complete, wait out the ` +
        `recent-active window, or use --fork (which mints a NEW identity and abandons this coord ownerId).`
      );
    };
    const backendContext =
      agent === "codex"
        ? " Codex's native writer-lock guard ran before this database check; if it reported no holder, verify the adv-session row or use --fork."
        : agent === "claude" || agent === "omp"
          ? argvProbeContext()
          : "";
    return (
      `the tracked session row is already marked live; that database state alone ` +
      `does not prove an agent process exists.${backendContext}${detail}`
    );
  }
  if (outcome?.status === "missing") {
    return `the operator found no tracked adv-session row for this id${detail}`;
  }
  switch (outcome?.reason) {
    case "contended":
      return `the resume acquisition was refused without a typed reservation state; no agent-process liveness was inferred${detail}`;
    case "http":
      return `the operator did not return an evaluated resume-acquisition verdict${detail}`;
    case "transport":
      return `the resume-acquisition request could not be evaluated because the operator transport failed${detail}`;
    case "no-session":
      return "it has no tracked adv-session row to acquire";
    default:
      return `the ended-session resume claim failed for an unrecognized reason${detail}`;
  }
}

/**
 * Best-effort "my managed host RESPAWNED the child under a fresh native id"
 * report (WI-5075) — the third lifecycle sibling next to ended/resumed. A P-018
 * carry-respawn / cold-loop RECYCLE keeps the coord identity + adv row but
 * rotates the NATIVE `--session-id`; without this report the adv_sessions row
 * keeps naming the dead predecessor, and every owner→transcript consumer (the
 * compaction watchdog's context estimate above all) stays pinned to the
 * predecessor's over-limit transcript — the successor-kill loop of 2026-07-15/16.
 * Keyed by advSessionId when the env carries one, by coordOwnerId otherwise —
 * an interactive `psu` / `psu --resume` launch has NO adv id, and gating the
 * report on one silently exempted that whole cohort from the re-anchor (the
 * 2026-07-18 su-57b6247d successor-kill loop). Fire-and-forget, bounded, never
 * rejects — a respawn must never wait on it. Exported with injectables for tests.
 */
export async function reportSessionRespawned(
  advSessionId,
  sessionId,
  {
    coordOwnerId = null,
    fetchImpl = fetch,
    operatorUrl = OPERATOR_URL,
    token = null,
    timeoutMs = 2_000,
  } = {},
) {
  if (!sessionId || (!advSessionId && !coordOwnerId)) return false;
  try {
    const tok = token ?? readToken();
    const response = await fetchImpl(
      operatorUrl + "/api/agent-mcp/console/bootstrap-su/session-respawned",
      {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "content-type": "application/json",
          ...(tok ? { authorization: `Bearer ${tok}` } : {}),
        },
        body: JSON.stringify({
          ...(advSessionId ? { advSessionId: Number(advSessionId) } : {}),
          ...(coordOwnerId ? { coordOwnerId: String(coordOwnerId) } : {}),
          sessionId: String(sessionId),
        }),
      },
    );
    return response?.ok === true;
  } catch {
    /* best-effort — never surface; callers must not announce an unconfirmed cut */
    return false;
  }
}

/**
 * Complete a stale-host carry adoption's lifecycle report before announcing
 * `session:compacted`. The detached event wakes members that may immediately
 * claim work, so it is only safe after the operator has re-anchored the
 * successor and cleared the predecessor's context estimate. Exported for a
 * deterministic ordering regression test; both operations remain fail-soft.
 */
export async function announceAdoptedCarryRespawn(
  ownerId,
  advSessionId,
  nativeId,
  {
    reportImpl = reportSessionRespawned,
    emitImpl = fireSessionCompactedEvent,
  } = {},
) {
  if (!ownerId || !nativeId) return false;
  let reported = false;
  try {
    reported = await reportImpl(advSessionId, nativeId, { coordOwnerId: ownerId });
  } catch {
    return false;
  }
  if (!reported) return false;
  try {
    emitImpl(ownerId, "carry-respawn", { nativeId });
  } catch {
    /* a wake announcement must never surface into the successor */
  }
  return true;
}

/**
 * Ask the operator to RE-RENDER this session's base persona from current prompt
 * sources, and return the fresh file's path (or null).
 *
 * stale-prompt-render-in-live-sessions-2026-08-02 P-002. A respawn rebuilds argv
 * from the ORIGINAL argv, so `--system-prompt-file` used to be copied through
 * verbatim and a long-lived session ran its FIRST launch's render forever — 27 of
 * 53 live sessions were up to 14 days stale when measured. A respawn is already a
 * full relaunch, so re-rendering is nearly free; the host swaps the returned path
 * into the successor's argv via mintRecycleArgs.
 *
 * NULL ON EVERYTHING — unreachable operator, timeout, non-200, a session with no
 * stored launch spec, a refused render. The caller then keeps the inherited path
 * and respawns anyway. That fail-soft is deliberate and not negotiable: a respawn
 * that died because the operator was briefly unreachable would lose the session,
 * which is strictly worse than running a stale prompt. Bounded well under the
 * respawn's own kill timeout so a wedged operator delays a respawn rather than
 * stalling it. Exported with injectables for tests.
 */
export async function refreshPersonaRender(
  coordOwnerId,
  {
    fetchImpl = fetch,
    operatorUrl = OPERATOR_URL,
    token = null,
    timeoutMs = 8_000,
  } = {},
) {
  if (!coordOwnerId) return { promptFile: null, reason: "no-owner" };
  try {
    const tok = token ?? readToken();
    const r = await fetchImpl(
      operatorUrl + "/api/agent-mcp/console/bootstrap-su/persona-refresh",
      {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "content-type": "application/json",
          ...(tok ? { authorization: `Bearer ${tok}` } : {}),
        },
        body: JSON.stringify({ coordOwnerId: String(coordOwnerId) }),
      },
    );
    if (!r?.ok)
      return { promptFile: null, reason: `http-${r?.status ?? "error"}` };
    const j = await r.json();
    if (j?.ok !== true || typeof j?.promptFile !== "string" || !j.promptFile) {
      return { promptFile: null, reason: String(j?.reason ?? "not-rendered") };
    }
    return {
      promptFile: j.promptFile,
      reason: null,
      bytes: Number(j.bytes) || null,
    };
  } catch (e) {
    return { promptFile: null, reason: `error: ${e?.message ?? String(e)}` };
  }
}

/** Critical (not best-effort) session-port disposition. The server accepts a
 * delivery only when `proof.nativeRef` names the target backend's own persisted
 * transcript containing the exact rendered hash. If the POST response is lost,
 * reconcile through the status route before deciding whether acknowledgement
 * failed; killing a successfully-delivered target on a network ambiguity would
 * be as wrong as accepting PTY output as persistence. */
export async function reportSessionPortDelivery(
  sessionPort,
  proof,
  {
    fetchImpl = fetch,
    operatorUrl = OPERATOR_URL,
    token = null,
    timeoutMs = 10_000,
  } = {},
) {
  if (!sessionPort?.portId || !sessionPort?.targetAdvSessionId) {
    throw new Error("session-port disposition is missing port/target identity");
  }
  const tok = token ?? readToken();
  const status = proof?.persisted === true ? "delivered" : "failed";
  const headers = {
    "content-type": "application/json",
    ...(tok ? { authorization: `Bearer ${tok}` } : {}),
  };
  let responseBody = null;
  try {
    const response = await fetchImpl(
      operatorUrl + "/api/adv/sessions/port/delivery",
      {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers,
        body: JSON.stringify({
          protocolVersion: sessionPort.protocolVersion,
          transformVersion: sessionPort.transformVersion,
          workspace: sessionPort.workspace,
          portId: sessionPort.portId,
          targetAdvSessionId: Number(sessionPort.targetAdvSessionId),
          status,
          ...(status === "delivered"
            ? {
                proof: {
                  persisted: true,
                  renderedHash: proof.renderedHash,
                  nativeRef: proof.nativeRef,
                },
              }
            : {
                error: proof?.error ?? "native persistence verification failed",
              }),
        }),
      },
    );
    responseBody = await response.json().catch(() => null);
    if (response.ok && responseBody?.ok && responseBody.status === status)
      return responseBody;
  } catch {
    /* reconcile below — the server may have committed before the response was lost */
  }
  try {
    const query = new URLSearchParams({ id: sessionPort.portId });
    if (sessionPort.workspace) query.set("workspace", sessionPort.workspace);
    const response = await fetchImpl(
      `${operatorUrl}/api/adv/sessions/port/status?${query}`,
      {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
        headers,
      },
    );
    const body = await response.json().catch(() => null);
    if (
      response.ok &&
      body?.ok &&
      body.port?.status === status &&
      Number(body.port?.targetAdvSessionId) ===
        Number(sessionPort.targetAdvSessionId)
    )
      return body;
  } catch {
    /* the disposition remains unacknowledged */
  }
  throw new Error(
    `operator did not acknowledge session port ${sessionPort.portId} as ${status}` +
      (responseBody?.error ? `: ${responseBody.error}` : ""),
  );
}

/** Finalize any failure after /prepare, whether bootstrap never minted a target
 * row (`prepared`) or local launch setup failed after bootstrap (`pending`). The
 * status read is authoritative: it chooses the token-authenticated no-target
 * disposition or the existing target-bound delivery disposition without
 * guessing how far the failed launch progressed. */
export async function reportSessionPortLaunchFailure(
  prepared,
  failure,
  {
    fetchImpl = fetch,
    operatorUrl = OPERATOR_URL,
    token = null,
    timeoutMs = 10_000,
  } = {},
) {
  if (!prepared?.portId || !prepared?.token) {
    throw new Error("prepared session-port failure is missing port/token identity");
  }
  const tok = token ?? readToken();
  const headers = {
    "content-type": "application/json",
    ...(tok ? { authorization: `Bearer ${tok}` } : {}),
  };
  const query = new URLSearchParams({ id: prepared.portId });
  if (prepared.workspace) query.set("workspace", prepared.workspace);
  const readStatus = async () => {
    const response = await fetchImpl(
      `${operatorUrl}/api/adv/sessions/port/status?${query}`,
      {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
        headers,
      },
    );
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok || !body.port) {
      throw new Error(
        `could not read session-port ${prepared.portId} after launch failure` +
          (body?.error ? `: ${body.error}` : ""),
      );
    }
    return body;
  };
  const failureMessage =
    `target bootstrap/spawn failed after preparation: ${failure?.message ?? String(failure)}`.slice(
      0,
      1000,
    );
  let current = await readStatus();
  if (current.port.status === "failed") return current;
  if (
    current.port.status === "pending" &&
    Number.isSafeInteger(Number(current.port.targetAdvSessionId)) &&
    Number(current.port.targetAdvSessionId) > 0
  ) {
    return reportSessionPortDelivery(
      {
        protocolVersion: prepared.protocolVersion,
        transformVersion: prepared.transformVersion,
        workspace: prepared.workspace,
        portId: prepared.portId,
        targetAdvSessionId: Number(current.port.targetAdvSessionId),
      },
      {
        persisted: false,
        renderedHash: current.port.renderedHash,
        error: failureMessage,
      },
      { fetchImpl, operatorUrl, token: tok, timeoutMs },
    );
  }
  if (
    current.port.status === "prepared" &&
    current.port.targetAdvSessionId == null
  ) {
    let responseBody = null;
    try {
      const response = await fetchImpl(
        operatorUrl + "/api/adv/sessions/port/delivery",
        {
          method: "POST",
          signal: AbortSignal.timeout(timeoutMs),
          headers,
          body: JSON.stringify({
            protocolVersion: prepared.protocolVersion,
            transformVersion: prepared.transformVersion,
            workspace: prepared.workspace,
            portId: prepared.portId,
            status: "failed",
            preparationToken: prepared.token,
            error: failureMessage,
          }),
        },
      );
      responseBody = await response.json().catch(() => null);
      if (response.ok && responseBody?.ok && responseBody.status === "failed") {
        return responseBody;
      }
    } catch {
      /* reconcile below — the server may have committed before the response was lost */
    }
    current = await readStatus();
    if (
      current.port.status === "failed" &&
      current.port.targetAdvSessionId == null
    ) {
      return current;
    }
    throw new Error(
      `operator did not acknowledge prepared session port ${prepared.portId} as failed` +
        (responseBody?.error ? `: ${responseBody.error}` : ""),
    );
  }
  throw new Error(
    `session port ${prepared.portId} cannot be failed from ${current.port.status}`,
  );
}

/** EI-8868/EI-8877: strip inherited `npm run`-lifecycle env pollution before it
 *  reaches an agent child. This box's long-lived gnome-terminal-server (every
 *  terminal window is forked from ONE persistent daemon, inheriting whatever
 *  env it had at ITS OWN startup) was activated with `npm_config_local_prefix`
 *  / `INIT_CWD` / `npm_package_json` pinned to `papercup-release` and its
 *  node_modules/.bin dirs PREPENDED to PATH — so every su/agent session on
 *  this box inherits it identically. Effect: `npx <tool>` / bare `vitest`
 *  resolve the STALE release-tree copy instead of the staging tree's, making
 *  every test in a run fail identically ("Vitest failed to find the runner")
 *  and poisoning `harness_shared.test_runs`, which then feeds FALSE "red-test"
 *  watchdog EIs fleet-wide (confirmed via EI-8828/EI-8840 — both proved green
 *  when re-run through a clean env). Root cause lives upstream of this
 *  process (the terminal daemon's own frozen env) and isn't fixable here, but
 *  THIS is the one choke point every psu-launched agent session passes
 *  through — sanitizing here fixes it fleet-wide regardless of what garbage
 *  the launching shell carried in. Non-destructive: only strips the npm
 *  lifecycle vars above and PATH segments naming the release checkout, which
 *  an interactive agent session never legitimately needs.
 *
 * WI-5052: account routing is also launch-envelope state, never ambient shell
 * state. A gateway-routed Claude session can itself run `psu`; without removing
 * its inherited ANTHROPIC_BASE_URL / routing headers, a child explicitly launched
 * as `--account=default` silently remains on the gateway because the default
 * envelope is intentionally empty. Strip every inference-gateway route marker
 * here, BEFORE runWrapper overlays the explicit launch envelope. Auto/pin launches
 * re-add the complete route through gatewayAutoEnv/gatewayPinEnv or bootstrap-su.
 * Direct credentials are route selectors too: the explicit envelope re-adds
 * only the credential source selected for this child. */
export function sanitizeInheritedEnv(env) {
  const out = stripRecoveryMarkers(env);
  for (const key of Object.keys(out)) {
    if (
      key === "INIT_CWD" ||
      key.startsWith("npm_config_local_prefix") ||
      key.startsWith("npm_package_") ||
      key.startsWith("npm_lifecycle_")
    ) {
      delete out[key];
    }
  }
  if (typeof out.PATH === "string" && out.PATH.includes("papercup-release")) {
    out.PATH = out.PATH.split(delimiter)
      .filter((seg) => !seg.includes("/papercup-release/"))
      .join(delimiter);
  }
  for (const key of [
    ...CLAUDE_DEFAULT_AUTH_ENV_KEYS,
    "PAPERCUSP_ANTHROPIC_URL",
    "PAPERCUSP_ACCOUNT_ID",
    "PAPERCUSP_CODEX_GATEWAY",
    ACCOUNT_ROUTING_MODE_ENV,
    "CLAUDE_CODE_OAUTH_TOKEN",
    // WI-37487: these are operator-service-only performance toggles from
    // WI-7160. A psu process may itself be launched from an operator shell,
    // but its child is an independent agent session; inheriting these flags
    // makes unrelated agent tests and tools route through the operator's
    // sidecar path. The explicit launch envelope can still opt a child in if
    // a future launch contract requires it.
    "PAPERCUSP_DEV_DEPLOY_SPAWN_SIDECAR",
    "PAPERCUSP_SYSTEM_HEALTH_SPAWN_SIDECAR",
  ]) {
    delete out[key];
  }
  // WI-5002: a psu launch is an INDEPENDENT session, but an agent-spawned launch
  // (a claude session's Bash running psu-launcher) inherits the SPAWNER's claude
  // session-identity markers. Claude Code treats a process carrying these as a
  // CHILD session and silently skips transcript persistence — the session runs
  // fine, completes work, and leaves NO projects/<slug>/<id>.jsonl (bisected
  // live 2026-07-17: stripping these flips persistence back on; flags/config-dir
  // shape/version all ruled out). Strip the whole ancestry family so the child's
  // claude context is always re-derived, never inherited; the envelope re-adds
  // CLAUDE_CONFIG_DIR when psu pins one.
  for (const key of [
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CONFIG_DIR",
  ]) {
    delete out[key];
  }
  return out;
}

// Codex's TUI file logger is opt-in through config.toml's `log_dir`; RUST_LOG
// controls which of the useful core/TUI diagnostics are written once that
// directory is configured. Keep this at the shared launcher boundary so fresh,
// resume, PTY, plain, and host-handoff launches all carry the same diagnostic
// environment. Managed Codex launches intentionally replace an inherited value:
// a parent session's broad or quiet RUST_LOG must not make reconnect evidence
// depend on which shell happened to spawn the member.
export const CODEX_DIAGNOSTIC_RUST_LOG = "codex_core=info,codex_tui=info";

export function applyCodexDiagnosticEnv(env, agent) {
  if (agent === "codex") env.RUST_LOG = CODEX_DIAGNOSTIC_RUST_LOG;
  return env;
}

/**
 * coord-delivery-residual-gaps-2026-07-11 P-002 — launch-time CC hook
 * enrollment guard, GENERALIZED (WI-4394) to any settings.json-wired CC hook,
 * not just coord-inbox.
 *
 * A Claude psu session receives several capabilities purely through hooks
 * merged into the global `~/.claude/settings.json` (coord-inbox mid-turn
 * mail; the turn-start memory delta — see memory-delivery-unification-
 * 2026-07-12 P-003a). That wiring is re-merged at every OPERATOR boot
 * (host-bootstrap → installPapercuspFiles), but it can drift BETWEEN boots —
 * a hand-edited settings.json, a fresh machine, a wiped home, OR (the
 * concrete failure this generalization fixes, WI-4394) simply a dev box whose
 * operator hasn't restarted since a NEW hook was added to the repo: on plain
 * `npm run dev` (no PAPERCUSP_DESKTOP=1) the self-install only runs at
 * operator boot, so a hook shipped after the last restart is silently absent
 * from every session's settings.json until the operator restarts or someone
 * hand-runs install-standalone-mcp.sh. The failure is SILENT either way: the
 * session launches fine and simply never gets that hook's behavior. Claude
 * reads hooks at session birth, so the moment that matters is right here,
 * before the spawn.
 *
 * PURE verdict: given the settings.json text + a hook-script existence probe,
 * report whether the named hook is wired under the named event and
 * executable-on-disk. Unknown/unparseable states report the specific miss —
 * the caller decides loudness. Exported for unit tests.
 */
export function ccHookEnrollment(
  settingsText,
  { event, hookName, scriptExists } = {},
) {
  const misses = [];
  let cfg = null;
  try {
    cfg = JSON.parse(settingsText ?? "");
  } catch {
    return {
      enrolled: false,
      misses: ["settings.json missing or unparseable"],
    };
  }
  const entries = Array.isArray(cfg?.hooks?.[event]) ? cfg.hooks[event] : [];
  const cmds = entries
    .flatMap((e) => (Array.isArray(e?.hooks) ? e.hooks : []))
    .map((h) => (typeof h?.command === "string" ? h.command : ""));
  const hookCmd = cmds.find((c) => c.includes(hookName));
  if (!hookCmd) {
    misses.push(`no ${event} entry runs ${hookName}`);
  } else if (typeof scriptExists === "function") {
    // The command may carry env prefixes/args — extract the script path token.
    const tok =
      hookCmd.split(/\s+/).find((t) => t.includes(hookName)) ?? hookCmd;
    if (!scriptExists(tok)) misses.push(`hook script missing on disk: ${tok}`);
  }
  return { enrolled: misses.length === 0, misses };
}

/** Back-compat thin wrapper — same signature/behavior pre-generalization; the
 *  pinned unit tests (cc-coord-hook-enrollment.test.ts) import this name.
 *  EI-11405 (coordination-hook-rpc-fanout-collapse-2026-07-16): the standalone
 *  posttooluse-coord-inbox.sh hook this used to probe for is RETIRED — its
 *  coord:inbox mid-turn delivery is now folded into posttooluse-activity-
 *  report.sh's own round trip (delta-aware `hook_bundle`), so THAT is the
 *  script whose enrollment now gates "is this session deaf to mid-turn coord
 *  mail". */
export function ccCoordHookEnrollment(settingsText, { scriptExists } = {}) {
  return ccHookEnrollment(settingsText, {
    event: "PostToolUse",
    hookName: "posttooluse-activity-report.sh",
    scriptExists,
  });
}

/** Same verdict shape for the turn-start memory delta hook (WI-4394). */
export function ccTurnStartMemoryHookEnrollment(
  settingsText,
  { scriptExists } = {},
) {
  return ccHookEnrollment(settingsText, {
    event: "UserPromptSubmit",
    hookName: "userpromptsubmit-memory.sh",
    scriptExists,
  });
}

/**
 * The I/O half: verify enrollment for a claude launch; on a miss, self-repair
 * ONCE through the operator's existing idempotent install route
 * (POST /api/desktop/install/papercusp-files — the same merge every operator
 * boot runs), re-verify, and print a LOUD banner if still unenrolled. Never
 * blocks or fails the launch (worst case ~4s on the already-broken path;
 * healthy path is one readFileSync). The session still works degraded-but-
 * launched either way — this is best-effort self-heal + loud disclosure, not
 * a launch gate.
 */
function ensureCcHookEnrollment(env, { event, hookName, label, degradedNote }) {
  if ((env.PAPERCUSP_AGENT || "") !== "claude") return; // codex bakes per-session hooks.json; omp uses its own coord-hook
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const read = () => {
    try {
      return readFileSync(settingsPath, "utf8");
    } catch {
      return "";
    }
  };
  const probe = (p) => existsSync(p);
  let verdict = ccHookEnrollment(read(), {
    event,
    hookName,
    scriptExists: probe,
  });
  if (verdict.enrolled) return;
  // Self-repair: the operator re-runs the same idempotent hook merge its boot
  // path uses. Loopback-only route; short timeout; failure falls through to the
  // banner. curl keeps this synchronous (the spawn follows immediately).
  try {
    spawnSync(
      "curl",
      [
        "-fsS",
        "-m",
        "4",
        "-X",
        "POST",
        `${OPERATOR_URL}/api/desktop/install/papercusp-files`,
      ],
      {
        encoding: "utf8",
        timeout: 6000,
      },
    );
  } catch {
    /* unreachable operator → banner below */
  }
  verdict = ccHookEnrollment(read(), { event, hookName, scriptExists: probe });
  if (verdict.enrolled) {
    console.error(
      `psu: ${hookName} was missing from ~/.claude/settings.json — repaired via the operator install route.`,
    );
    return;
  }
  console.error(
    [
      "",
      `⚠⚠ ${label} NOT ENROLLED — ${degradedNote} ⚠⚠`,
      `   ${verdict.misses.join("; ")}`,
      "   Self-repair via the operator failed or it is unreachable. Fix: restart the operator (it re-installs",
      `   hooks at boot), or: curl -X POST ${OPERATOR_URL}/api/desktop/install/papercusp-files`,
      "   Launching anyway.",
      "",
    ].join("\n"),
  );
}

/** WI-1079034: this hook has TWO consumers, and the second one is silent when
 *  it breaks. Besides folding mid-turn coord mail, its `'*'`-matcher
 *  `activity:report` POST is what writes a `tool_invocations` row for a NATIVE
 *  tool call — which is the only reason `FleetPresenceRow.lastToolCallAt`
 *  (an MCP-only max()) stays fresh across a native-tool turn. Name both in the
 *  degraded note, or an operator reads a coord-mail warning while the fleet's
 *  liveness signal quietly degrades. Stated precisely: an agent still calling
 *  MCP tools goes on looking fresh from its own real calls; what is lost is a
 *  stretch that uses NO MCP tools directly. */
function ensureCcCoordHookEnrollment(env) {
  ensureCcHookEnrollment(env, {
    event: "PostToolUse",
    hookName: "posttooluse-activity-report.sh",
    label: "COORD-INBOX + NATIVE-ACTIVITY HOOK",
    degradedNote:
      "THIS SESSION WILL BE DEAF TO MID-TURN COORD MAIL — peer messages will only land at session start / orient / an explicit wake, and the fleet sees it flagged coordHook:missing in coord:presence. IT WILL ALSO STOP RECORDING NATIVE TOOL CALLS: a stretch using no MCP tools directly leaves no tool_invocations row, so presence/fleet lastToolCallAt reads stale and a leader can misjudge this agent as stalled",
  });
}

/** WI-4394: the turn-start memory delta (memory-delivery-unification-2026-07-12
 *  P-003a) is the same drift class as coord-inbox — verify + self-repair it too. */
function ensureCcTurnStartMemoryHookEnrollment(env) {
  ensureCcHookEnrollment(env, {
    event: "UserPromptSubmit",
    hookName: "userpromptsubmit-memory.sh",
    label: "TURN-START MEMORY HOOK",
    degradedNote:
      "THIS SESSION WILL NEVER GET THE TURN-START MEMORY DELTA — a bare session with no initialize-time query gets no recall fallback at all",
  });
}

/** context-injection-audit-2026-07-28 P-015: the MID-TURN half of the same delta
 *  is the same drift class again — and the reason this verifier exists at all is
 *  EI-18891337746278593, where posttooluse-objective-title.sh sat deployed on disk
 *  but registered under no hook event, while the plan describing it claimed it
 *  "injects today". A hook that is copied but unenrolled is indistinguishable from
 *  a working one unless something checks. This checks. */
function ensureCcMidTurnContextHookEnrollment(env) {
  ensureCcHookEnrollment(env, {
    event: "PostToolBatch",
    hookName: "posttoolbatch-midturn-context.sh",
    label: "MID-TURN CONTEXT HOOK",
    degradedNote:
      "THIS SESSION GETS RECALL ONLY AT TURN-START — a long tool-call turn will re-derive facts already in memory, with no injection after the opening prompt",
  });
}

/** portable-identity-packages-2026-09-26 P-011 (D-023 §2): the three identity
 *  hook sinks turn-start and mid-turn do not reach. Same drift class again, and
 *  the guard half is the one that matters most: an unenrolled PreToolUse guard
 *  lets through every call a worn identity's deny rule exists to refuse, and
 *  looks exactly like an identity that simply has no guards. */
const CC_IDENTITY_HOOKS = [
  {
    event: "PreToolUse",
    hookName: "pretooluse-identity-guard.sh",
    degradedNote:
      "A WORN IDENTITY'S DENY RULES WILL NOT BE ENFORCED — every tool call they would refuse runs",
  },
  {
    event: "Stop",
    hookName: "stop-identity-context.sh",
    degradedNote:
      "A WORN IDENTITY'S STOP RULES WILL NEVER FIRE — the turn ends without the context they add",
  },
  {
    event: "SessionStart",
    hookName: "sessionstart-identity-context.sh",
    degradedNote:
      "A WORN IDENTITY'S COMPACTION RULES WILL NEVER FIRE — a fresh context starts without what they re-seed",
  },
];

function ensureCcIdentityHookEnrollment(env) {
  for (const { event, hookName, degradedNote } of CC_IDENTITY_HOOKS) {
    ensureCcHookEnrollment(env, {
      event,
      hookName,
      label: `IDENTITY ${event.toUpperCase()} HOOK`,
      degradedNote,
    });
  }
}

/** Terminate a plain-launch process group, retaining a direct-child fallback.
 * `spawnInherit` uses `detached:true`, making the wrapper the leader of its own
 * process group on POSIX. The wrapper can leave a native backend descendant
 * behind after it exits, so cleanup must signal the group, not only the wrapper.
 * Negative process-group pids are POSIX-only; the direct child call keeps this
 * useful on Windows and when the group has already disappeared.
 */
export function killSpawnProcessTree(
  child,
  signal = "SIGKILL",
  kill = process.kill,
) {
  const pid = Number(child?.pid);
  let killed = false;
  if (process.platform !== "win32" && Number.isInteger(pid) && pid > 1) {
    try {
      kill(-pid, signal);
      killed = true;
    } catch {
      /* the group may already be gone; try the direct child below */
    }
  }
  try {
    child?.kill?.(signal);
    killed = true;
  } catch {
    /* already gone */
  }
  return killed;
}

/**
 * @typedef {object} SpawnInheritOptions
 * @property {string} wrapperBin
 * @property {string[]} [args]
 * @property {string} cwd
 * @property {Record<string, any>} env
 * @property {(...args:any[])=>any} [spawnImpl]
 * @property {any} [processApi]
 * @property {any} [signalSource]
 * @property {(...args:any[])=>any} [processKill]
 * @property {(...args:any[])=>any} [processExit]
 * @property {(...args:any[])=>any} [reportSessionEndedImpl]
 * @property {()=>any} [onSpawn]
 * @property {(()=>any)|null} [onSpawnFailure]
 */

/** The original plain launch: inherit the user's stdio straight into the child.
 *  The fallback when the managed-pty host is disabled, has no TTY, or fails to
 *  start.
 *  @param {SpawnInheritOptions} options
 */
export function spawnInherit(options) {
  const {
    wrapperBin,
    args = [],
    cwd,
    env,
    spawnImpl = spawn,
    processApi = process,
    signalSource = processApi,
    processKill = processApi.kill?.bind(processApi) ?? process.kill,
    processExit = processApi.exit?.bind(processApi) ?? process.exit,
    reportSessionEndedImpl = reportSessionEnded,
    onSpawn = () => {},
    onSpawnFailure = null,
  } = options;
  // Fleet color for the no-pty fallback (the managed-pty host writes its own at
  // startup — see hostThroughPty). Recolor THIS window before the child takes the
  // terminal over; no fleet ⇒ no write (the profile default stands).
  const osc = fleetOscFromEnv(env);
  if (osc) {
    try {
      process.stdout.write(osc);
    } catch {
      /* best-effort — a recolor must never break the launch */
    }
  }
  const child = spawnImpl(wrapperBin, args, {
    cwd,
    env,
    stdio: "inherit",
    detached: true,
  });
  const terminalSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
  let finished = false;
  let spawnObserved = false;
  let forwardedSignal = null;
  const signalHandlers = new Map();
  const removeSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) {
      try {
        signalSource.off?.(signal, handler);
      } catch {
        /* best-effort listener hygiene */
      }
    }
    signalHandlers.clear();
  };
  const forwardSignal = (signal) => {
    if (finished || forwardedSignal) return;
    forwardedSignal = signal;
    killSpawnProcessTree(child, signal, processKill);
  };
  if (typeof signalSource.on === "function") {
    for (const signal of terminalSignals) {
      const handler = () => forwardSignal(signal);
      signalHandlers.set(signal, handler);
      signalSource.on(signal, handler);
    }
  }
  child.once("spawn", () => {
    spawnObserved = true;
    try {
      const acknowledgement = onSpawn();
      void Promise.resolve(acknowledgement).catch((error) => {
        console.error(
          `psu: child spawned, but its resume finalization report failed: ${error?.message ?? error}`,
        );
      });
    } catch (error) {
      console.error(
        `psu: child spawned, but its resume finalization callback failed: ${error?.message ?? error}`,
      );
    }
  });
  child.on("error", (e) => {
    if (finished) return;
    finished = true;
    removeSignalHandlers();
    killSpawnProcessTree(child, "SIGKILL", processKill);
    console.error(`psu: failed to launch ${wrapperBin}: ${e.message}`);
    // WI-3884 follow-up: node's spawn reports ENOENT for a MISSING CWD with the
    // exact same error as a missing binary — a resume whose recorded working
    // directory was deleted looked like "codex not installed". Disambiguate.
    if (cwd && !existsSync(cwd)) {
      console.error(
        `psu: the session's recorded working directory no longer exists: ${cwd} — ` +
          `spawn fails with ENOENT even when ${wrapperBin} is installed. ` +
          `Recreate it (mkdir -p '${cwd}') and re-run, or resume a different session.`,
      );
    } else {
      console.error(
        `psu: is ${wrapperBin} on PATH? run apps/operator/scripts/install-standalone-mcp.sh`,
      );
    }
    // A tracked resume reserves its row before setup/spawn. If the wrapper itself
    // cannot be started, the injected pre-spawn callback releases that lease; a
    // fresh/non-resume launch retains the historical cleanup end report.
    void Promise.resolve()
      .then(() =>
        !spawnObserved && onSpawnFailure
          ? onSpawnFailure()
          : reportSessionEndedImpl(env.PAPERCUSP_ADV_SESSION_ID || null, null, {
              launchFailed: true,
            }),
      )
      .catch(() => undefined)
      .finally(() => processExit(127));
  });
  child.on("exit", (code, signal) => {
    if (finished) return;
    finished = true;
    const terminalSignal = signal ?? forwardedSignal;
    // The wrapper may have exited while its native backend descendant is still
    // alive. Reap the detached group before handing terminal control back.
    killSpawnProcessTree(child, "SIGKILL", processKill);
    removeSignalHandlers();
    // WI-38054: this path always KNEW the signal — it used it to re-kill itself — but
    // forwarded only `code`, so a killed session still recorded as a voluntary 'self'
    // exit. Report it.
    void Promise.resolve()
      .then(() =>
        reportSessionEndedImpl(env.PAPERCUSP_ADV_SESSION_ID || null, code, {
          killedBySignal: terminalSignal,
        }),
      )
      .catch(() => undefined)
      .finally(() => {
        // Remove handlers before re-signalling this supervisor, or the signal
        // re-enters forwardSignal and can recurse indefinitely.
        if (terminalSignal) processKill(processApi.pid, terminalSignal);
        else processExit(code ?? 0);
      });
  });
}

/**
 * EI-10938 — never hand an agent a cwd that is not a checkout.
 *
 * The console launcher used to open workspace-only (su) sessions in the
 * workspace's `.papercusp` STATE dir, which is not a git repo and holds no
 * source. Claude Code resets the shell cwd to the launch dir after every command,
 * so the agent paid a defensive `cd` on 77% of its bash calls, bare `git` failed,
 * and relative paths silently resolved into the state dir.
 *
 * That is fixed at the source (console-launcher's resolveWorkspaceHomeCwd). This
 * is the belt-and-braces guard for every OTHER way a bad cwd can arrive — a stale
 * caller, a recorded session cwd from before the fix, a hand-rolled invocation.
 * It ONLY ever redirects a cwd that is demonstrably a papercusp state dir into the
 * real checkout; a deliberate cwd (a harness dir, a user's own directory) is left
 * strictly alone.
 */
function repoCwdOrRedirect(cwd) {
  if (!cwd) return cwd;
  const isStateDir = basename(cwd) === ".papercusp";
  if (!isStateDir) return cwd; // a deliberate cwd — never second-guess it
  const markers = (d) =>
    existsSync(join(d, "apps", "operator", "package.json")) &&
    existsSync(join(d, "libs", "papercusp", "package.json"));
  if (markers(cwd)) return cwd; // somehow already a checkout — leave it
  const envRoot =
    process.env.PAPERCUSP_REPO_ROOT || process.env.PAPERCUSP_INTEGRATION_ROOT;
  if (envRoot && markers(envRoot)) {
    console.error(
      `psu: cwd was a state dir (${cwd}); using the checkout at ${envRoot}`,
    );
    return envRoot;
  }
  return cwd; // no better answer — do not invent one
}

/**
 * @typedef {object} RunWrapperOptions
 * @property {string} wrapperBin
 * @property {string[]} [args]
 * @property {string} cwd
 * @property {Record<string, any>} envelopeEnv
 * @property {string|null} [kickoff]
 * @property {string|null} [kickoffFile]
 * @property {any} [sessionPort]
 * @property {boolean} [preserveCwd]
 * @property {any} [hostHandoff] already-consumed host handoff orders
 * @property {(...args:any[])=>any} [reportSessionEndedImpl]
 * @property {()=>any} [onSpawn]
 * @property {(()=>any)|null} [onSpawnFailure]
 */

/** @param {RunWrapperOptions} options */
export function runWrapper(options) {
  let {
    wrapperBin,
    args = [],
    cwd,
    envelopeEnv,
    kickoff = null,
    kickoffFile = null,
    sessionPort = null,
    preserveCwd = false,
    hostHandoff: initialHostHandoff = null,
    reportSessionEndedImpl = reportSessionEnded,
    onSpawn = () => {},
    onSpawnFailure = null,
  } = options;
  // EI-10938's `.papercusp` state-dir → checkout redirect is correct for a FRESH
  // launch, but a RESUME/FORK MUST keep the recorded cwd: `claude --resume` /
  // `--fork` locate the transcript under the cwd-derived projects dir
  // (<CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<id>.jsonl), and the archive
  // rematerializes it under the ORIGINAL cwd's encoding — so redirecting the cwd
  // makes claude search the checkout's projects dir instead → "No conversation
  // found", which silently made EVERY `.papercusp`-cwd session unresumable
  // (owner-reported 2026-07-13). Resume/fork pass preserveCwd:true; fresh
  // launches keep the guard.
  if (!preserveCwd) cwd = repoCwdOrRedirect(cwd);
  const env = { ...sanitizeInheritedEnv(process.env), ...envelopeEnv };
  const reportPreSpawnFailure = () =>
    onSpawnFailure
      ? onSpawnFailure()
      : reportSessionEndedImpl(env.PAPERCUSP_ADV_SESSION_ID || null, null, {
          launchFailed: true,
        });
  // WI-5052 acceptance hardening: `default` is an active credential choice,
  // not merely the absence of a gateway overlay. Clear every prior Claude auth
  // source before restoring the system login below.
  enforceDefaultClaudeAccount(wrapperBin, env);
  // Export the RESOLVED operator url to every agent child so claude's user-level
  // papercusp-su MCP url (`${PAPERCUSP_OPERATOR_URL:-…}/api/mcp?…`, written by
  // desktop-install/claude-integration) resolves to the LIVE operator on each
  // launch. The desktop operator binds a dynamic localhost port per boot, so a
  // baked url would go stale; env-interpolation + this export self-heal it.
  // OPERATOR_URL already honors an explicit PAPERCUSP_OPERATOR_URL override;
  // the provenance marker lets a fresh ptool wake distinguish this managed
  // export from a caller's deliberate env pin.
  applyLauncherOperatorUrlEnv(env);
  // WI-3665: hand every descendant the terminal this launch OWNS, so the fleet-identity
  // title (👑/👤 + fleet + colour square) can be written even from a hook that has been
  // setsid'd away from its controlling terminal — which is exactly how Claude Code spawns
  // its statusLine command, and why that title silently never appeared.
  //
  // ALWAYS RE-DERIVED, NEVER INHERITED. sanitizeInheritedEnv keeps PAPERCUSP_*, so an
  // agent session that owns a terminal and then spawns a HEADLESS psu child (a bee) would
  // otherwise leak its own PAPERCUSP_TTY down — and the bee's every tool call would retitle
  // the human's window. Terminal ownership is a property of THIS launch and nothing else:
  // recompute it, and delete it outright when this launch owns no terminal.
  const ownedTty = resolveOwnedTtyPath();
  if (ownedTty) env.PAPERCUSP_TTY = ownedTty;
  else delete env.PAPERCUSP_TTY;
  // EI-10377: re-stamp this terminal's claim on EVERY launch that owns one, so a stale
  // writer left over from whoever owned this (possibly-recycled) pty path before us is
  // told, on its very next write attempt, that the claim has moved on. See
  // claimTtyOwnership for the full rationale.
  if (ownedTty && env.PAPERCUSP_SID) {
    claimTtyOwnership(ownedTty, env.PAPERCUSP_SID, {
      dir: env.PAPERCUSP_TTY_CLAIMS_DIR || undefined,
    });
  }
  // ONE writer per title. Claude Code writes its own topic title and would otherwise fight
  // the statusline's fleet identity (last writer wins ⇒ flicker). Silence Claude's writer,
  // but ONLY when our statusline is the one it will actually load — see shouldSilenceClaudeTitle.
  if (
    shouldSilenceClaudeTitle({
      agent: env.PAPERCUSP_AGENT,
      ownsTty: !!ownedTty,
      env,
    })
  ) {
    env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE = "1";
  }
  // Default-account claude inherits the single stored CLI login via
  // CLAUDE_CODE_OAUTH_TOKEN — the only cross-platform path (macOS keeps the
  // OAuth token in the Keychain keyed per CLAUDE_CONFIG_DIR, so the per-session
  // config dir never finds the default ~/.claude login and no file reconcile can
  // heal it). No-op unless a token was stored (`psu --set-claude-token`) and the
  // session is default-account claude. See applyDefaultClaudeOAuthToken.
  applyDefaultClaudeOAuthToken(wrapperBin, env);
  // Settings can independently select a cloud provider, API key/helper, or
  // gateway even after the inherited process env is clean. Add a
  // highest-precedence override for this launch, and scrub the isolated copied
  // user settings so a Claude self-reexec (which drops argv) stays on the same
  // explicit default-account route.
  args = applyDefaultClaudeAuthSettingsArgs(wrapperBin, args, env);
  persistDefaultClaudeAuthSettings({ wrapperBin, env });
  // The GitHub Copilot MCP plugin (a Claude plugin OMP also discovers) needs
  // GITHUB_PERSONAL_ACCESS_TOKEN; unset → "Authorization header is badly formatted" (HTTP 400) on
  // every claude/omp launch. Export the gh CLI token when unset (verified it authenticates the MCP).
  applyGithubTokenEnv(env);
  // mcp-transport-resilience P-001 (2026-07-13): a mid-session Claude Code
  // AUTO-UPDATE relaunch re-execs the process, which (a) severs the papercusp-su
  // HTTP-MCP transport — tools vanish and the armed loop's events:await
  // registration dies with it (the su-39f07 5h-dark incident) — and (b) rebuilds
  // argv WITHOUT the launch flags (the recovery-banner class). Kill the trigger:
  // no mid-session self-update; version freshness is a spawn-time concern. The
  // env var is claude's; other backends ignore it. Opt back in per-box with
  // PAPERCUSP_CC_AUTOUPDATE=1.
  if (process.env.PAPERCUSP_CC_AUTOUPDATE !== "1")
    env.DISABLE_AUTOUPDATER = "1";
  // mcp-transport-resilience P-002 (2026-07-13): mirror this launch's argv
  // permission flags into the per-session settings.json so the SAME re-exec that
  // drops argv re-applies them MECHANICALLY from disk (see the helper's doc).
  persistReExecSafePermissions({ env, args });
  // P-002 (coord-delivery-residual-gaps): verify the claude coord-inbox hook is
  // enrolled BEFORE the spawn (Claude reads hooks at session birth) — self-repairs
  // via the operator's idempotent install route, loud-warns when it can't.
  ensureCcCoordHookEnrollment(env);
  // WI-4394: same drift class, same self-repair path, for the turn-start memory
  // delta hook — this is the concrete fix for the near-silent-live turn-start port.
  ensureCcTurnStartMemoryHookEnrollment(env);
  // P-015: and the mid-turn boundary the turn-start hook structurally cannot reach.
  ensureCcMidTurnContextHookEnrollment(env);
  // P-011: and the identity hook sinks (pre-tool guard, stop, compaction).
  ensureCcIdentityHookEnrollment(env);
  // turn-lifecycle-control Phase 3: when enabled + interactive, host the agent
  // through a managed pty + owner-only control socket so the operator can inject
  // a wake (or, Phase 4, an interrupt) into the LIVE session rather than parking
  // it. The discovery key is the coord ownerId (PAPERCUSP_SID); without one the
  // operator can't find the socket, so we keep the plain launch.
  const ownerId = env.PAPERCUSP_SID || null;
  // identity-split fix (2026-07-02): durably bind this launch's native session
  // id → coord ownerId so a FUTURE untracked resume recovers the same identity
  // instead of minting a fresh SID (see recordSessionOwner). First write wins,
  // so re-recording on every launch/resume is a no-op for a known session.
  if (ownerId) {
    const advSessionId = env.PAPERCUSP_ADV_SESSION_ID || null;
    recordSessionOwner(nativeSessionIdFromLaunchArgs(args), ownerId, {
      advSessionId,
    });
    // WI-1863: omp launches have NO native session UUID (nativeSessionIdFromLaunchArgs
    // returns null for them by design), so they never got an owner-index entry — a
    // desktop `session-<N>` was locally unresolvable to its coord ownerId, and a tester
    // resolving "the leader" from this index picked a nearby CLAUDE entry and misdelivered
    // directives (the 2026-07-03 ornith fleet-of-claude incident). ALSO key every launch
    // by its adv session id (`adv-<N>`) so session-number → ownerId always resolves.
    // Same first-write-wins semantics; the authoritative registry stays adv_sessions.
    if (advSessionId)
      recordSessionOwner(`adv-${advSessionId}`, ownerId, { advSessionId });
  }
  // liveness-hardening P-004: supervisor beat covers BOTH launch paths below.
  // EI-19948333346987654: thread the already-resolved owned-tty path (line
  // ~5395 above) into the beat so coord_presence.tty answers "which terminal
  // does this session own" without a /proc ancestry walk.
  const supervisorBeat = startSupervisorBeat(ownerId, { tty: ownedTty });
  // WI-38292: are we the SUCCESSOR of a host that exited to adopt fresh code? The
  // predecessor left this session's already-minted child argv on disk (its carry
  // included) because it could not put anything in our environment — the psu
  // shim's re-exec loop spawned us, not it. Consuming is single-shot and
  // self-validating; a null here is the ordinary cold-launch case.
  const hostHandoff =
    initialHostHandoff || (ownerId ? readHostHandoff(ownerId) : null);
  if (hostHandoff) {
    // Use the predecessor's argv VERBATIM. It was minted from an argv that had
    // already been through this launcher's whole normalization pass, so
    // re-deriving it here would re-apply flags that are already present and, far
    // worse, drop the rotated --session-id and the --append-system-prompt-file
    // that IS the carry.
    args = hostHandoff.args;
    for (const [k, v] of Object.entries(hostHandoff.childEnv ?? {})) env[k] = v;
    // WI-2140943 lane 2 (2026-09-02): the handoff was written by the code the predecessor
    // has IN MEMORY — the old code, by definition — so never trust it to have carried every
    // key the fresh path sets. Re-derive the context-trimming trio where absent (an
    // explicitly carried value wins). Before this heal, the first adoption after a
    // psu-pty-host.mjs edit re-booted every headless member at ~756k tokens (the whole
    // tool catalog inline) and the compaction watchdog respawned it every ~10 min forever.
    const healed = healContextTrimmingEnv(env, env.PAPERCUSP_AGENT);
    if (healed.length > 0)
      process.stderr.write(
        `psu: host handoff carried no ${healed.join(", ")} — re-derived from contextTrimmingEnv (WI-2140943)\n`,
      );
    // Same heal for the alternate-screen switch (see terminalRenderEnv): a handoff
    // written by a pre-fix host carries no CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN, and
    // without it the successor's whole epoch vanishes from the console at its cut.
    const healedRender = healTerminalRenderEnv(env, env.PAPERCUSP_AGENT);
    if (healedRender.length > 0)
      process.stderr.write(
        `psu: host handoff carried no ${healedRender.join(", ")} — re-derived from terminalRenderEnv\n`,
      );
    // The successor's first turn is the carry, delivered through the argv above.
    // A kickoff from THIS process's own command line would be the ORIGINAL
    // launch's first prompt replayed into a session that is many turns past it.
    kickoff = null;
    kickoffFile = null;
    sessionPort = null;
    if (hostHandoff.nativeId) {
      // The in-process respawn re-anchors identity through `onRespawn` AFTER
      // spawning the child; the adopting predecessor exits before it ever gets
      // there, so the successor owes both halves of that hook. Skipping the
      // second one is the P-018 successor-kill loop: adv_sessions keeps naming
      // the predecessor's native id, and the compaction watchdog then reaps a
      // session that is very much alive.
      recordSessionOwner(hostHandoff.nativeId, ownerId, {
        advSessionId: env.PAPERCUSP_ADV_SESSION_ID || null,
      });
      if (hostHandoff.mode === "carry-respawn") {
        void announceAdoptedCarryRespawn(
          ownerId,
          env.PAPERCUSP_ADV_SESSION_ID || null,
          hostHandoff.nativeId,
        );
      } else {
        void reportSessionRespawned(
          env.PAPERCUSP_ADV_SESSION_ID || null,
          hostHandoff.nativeId,
          {
            coordOwnerId: ownerId,
          },
        );
      }
    }
    process.stderr.write(
      `psu: adopted updated host code for ${ownerId} (predecessor pid ${hostHandoff.fromPid ?? "?"}, ` +
        `mode ${hostHandoff.mode ?? "unknown"})\n`,
    );
  }
  // EI-203876: stamp Codex's diagnostic filter after host-handoff env overlay,
  // so a successor cannot inherit a predecessor's missing/stale RUST_LOG.
  applyCodexDiagnosticEnv(env, env.PAPERCUSP_AGENT);
  if (ownerId && usePtyHost({ env })) {
    try {
      hostThroughPty({
        command: wrapperBin,
        args,
        cwd,
        env,
        ownerId,
        // headless-fleet-launch P-001/D-004: never bridge a human TTY for a headless
        // member. It resolves false anyway when stdio is detached (stdin.isTTY undefined),
        // but pinning it makes `psu --headless` run FROM a real terminal (the debugging
        // case) deterministic — no setRawMode on the operator's own stdin, no SIGWINCH
        // coupling. The pty (and therefore the control socket + discovery file) still spawns.
        bridgeTty: env.PAPERCUSP_PSU_HEADLESS === "1" ? false : undefined,
        advSessionId: env.PAPERCUSP_ADV_SESSION_ID || null,
        onSpawn,
        // WI-1980: a cold-loop RECYCLE must respawn with a FRESH --session-id
        // (reusing the on-disk id storms the supervisor). Inject the arg-rewrite
        // + native→coord re-anchor here so the host stays launcher-agnostic.
        // WI-2141859: both respawn modes re-detect the model the session is
        // CURRENTLY running — an in-session `/model` switch included — instead
        // of copying the launch-time flag forward. Detection happens per
        // respawn (the native session id rotates each time, so the transcript
        // to read is the one named by the argv being replaced) and is
        // fail-soft: a null keeps the inherited spec. An explicit `model` from
        // the host still wins, so this can never fight a deliberate caller.
        mintRecycleArgs: (a, o = {}) =>
          mintRecycleArgs(a, {
            ...o,
            model:
              o.model ??
              detectRespawnModelSpec(a, {
                ownerId,
                agent: env.PAPERCUSP_AGENT,
                configDir: env.CLAUDE_CONFIG_DIR || null,
                codexHome: env.CODEX_HOME || null,
                advSessionId: env.PAPERCUSP_ADV_SESSION_ID || advSessionId || null,
                modelSource: env.PAPERCUSP_MODEL_SOURCE || null,
              }),
          }),
        mintCarryRespawnArgs: (a, o = {}) =>
          mintCarryRespawnArgs(a, {
            ...o,
            model:
              o.model ??
              detectRespawnModelSpec(a, {
                ownerId,
                agent: o.agent ?? env.PAPERCUSP_AGENT,
                configDir: env.CLAUDE_CONFIG_DIR || null,
                codexHome: env.CODEX_HOME || null,
                advSessionId: env.PAPERCUSP_ADV_SESSION_ID || advSessionId || null,
                modelSource: env.PAPERCUSP_MODEL_SOURCE || null,
              }),
          }),
        ensureCodexHome: () =>
          ensureCodexHomeViaOperator(
            ownerId,
            env.CODEX_HOME || null,
            env.PAPERCUSP_ADV_SESSION_ID || advSessionId || null,
            {
              model: detectRespawnModelSpec(args, {
                ownerId,
                agent: env.PAPERCUSP_AGENT,
                configDir: env.CLAUDE_CONFIG_DIR || null,
                codexHome: env.CODEX_HOME || null,
                advSessionId: env.PAPERCUSP_ADV_SESSION_ID || advSessionId || null,
                modelSource: env.PAPERCUSP_MODEL_SOURCE || null,
              }),
              routeMode: env[ACCOUNT_ROUTING_MODE_ENV] || null,
              accountId: env.PAPERCUSP_ACCOUNT_ID || null,
              priority: env.PAPERCUSP_AGENT_ROLE || "su",
            },
          ),
        // stale-prompt-render-in-live-sessions-2026-08-02 P-002: a respawn must
        // re-render the base persona instead of inheriting the predecessor's file,
        // or every prompt fix stops at the session's FIRST launch. Injected like the
        // mints so the host stays launcher-agnostic; returns null on any failure and
        // the host then keeps the inherited render.
        refreshPersonaFile: () => refreshPersonaRender(ownerId),
        // agent-launch-resume-primitives P-011/D-008: the first turn for a scripted
        // RESUME/FORK. A resumed CLI has no positional-prompt seam (the fresh path's
        // kickoff rides the argv), and a session that just came back from the dead is
        // unreachable by roster-gated coord:wake/coord:send — its presence rows were
        // reaped when it died. The host owns the pty, so it seeds the turn itself once
        // the child settles at its prompt.
        kickoff,
        // Session-port seeds use a separate server-owned file channel. The PTY
        // host does not acknowledge it until the exact checksum is visible in
        // the target backend's native transcript.
        kickoffFile,
        sessionPort,
        onKickoffPersisted: (proof) =>
          reportSessionPortDelivery(sessionPort, proof),
        onRespawn: (freshId) => {
          recordSessionOwner(freshId, ownerId, {
            advSessionId: env.PAPERCUSP_ADV_SESSION_ID || null,
          });
          // WI-5075: ALSO re-anchor the authoritative adv_sessions owner→native
          // mapping. recordSessionOwner only writes the file-based native→owner
          // index; resolveSessionRef / the compaction watchdog's estimate read
          // adv_sessions.session_id, which otherwise keeps naming the dead
          // predecessor — the P-018 successor-kill loop. coordOwnerId rides along
          // so an interactive/resumed launch (no adv id in env) re-anchors too.
          return reportSessionRespawned(
            env.PAPERCUSP_ADV_SESSION_ID || null,
            freshId,
            {
              coordOwnerId: ownerId,
            },
          );
        },
        // WI-38292: leave so the psu shim's loop can re-run us on CURRENT host
        // code. Only wired when the shim actually advertised that loop — a
        // launcher nobody will re-run must never take this path, and this is the
        // handshake's enforcement point (the host separately re-checks the env).
        //
        // NOT reportSessionEnded: this session is continuing, in a new process. It
        // is also why the beat is stopped by hand — a heartbeat that outlives this
        // process by even one tick reports a pid that is gone, and the successor
        // is already beating for the same ownerId.
        // WI-10001537: the null branch below is correct but was entirely SILENT,
        // so a stale PATH shim turned every hand-off into a hard death with no
        // signal at all. warnMissingReexecLoop speaks up ONLY for the actionable
        // cause on an interactive launch (never for a headless member, a nested
        // psu, or the kill switch) — see missingReexecLoopDiagnosis.
        onReexec: reexecExitCodeAnnounced(env)
          ? ({ code }) => {
              try {
                if (supervisorBeat) clearInterval(supervisorBeat);
              } catch {
                /* the exit below reclaims it regardless */
              }
              process.exit(code);
            }
          : null,
        // WI-38054: the managed-PTY path had no `signal` parameter at all, which is
        // where the owner's reaped agents lost the only evidence they were killed.
        onExit: (code, killedBySignal = null) => {
          void reportSessionEndedImpl(
            env.PAPERCUSP_ADV_SESSION_ID || null,
            code,
            {
              killedBySignal,
            },
          ).finally(() => process.exit(code ?? 0));
        },
      }).catch((e) => {
        // The pty was already spawned (the promise only rejects on an unforeseen
        // bridge error); don't double-spawn — surface + exit non-zero.
        process.stderr.write(
          `psu: managed-pty host error: ${e?.message ?? e}\n`,
        );
        // A tracked resume claims its row before this host starts. If the host
        // rejects before handing a child a usable session, release that claim
        // immediately; otherwise the picker sees a false live row until stale
        // recovery. This is deliberately launchFailed, not a child-exit report.
        const cleanup = Promise.resolve(
          reportSessionEndedImpl(env.PAPERCUSP_ADV_SESSION_ID || null, null, {
            launchFailed: true,
          }),
        ).catch(() => undefined);
        const finish =
          kickoffFile && sessionPort
            ? Promise.all([
                cleanup,
                reportSessionPortDelivery(sessionPort, {
                  persisted: false,
                  renderedHash: sessionPort.renderedHash,
                  error: `managed-pty host failed: ${e?.message ?? e}`,
                }).catch(() => undefined),
              ])
            : cleanup;
        void finish.finally(() => process.exit(1));
      });
      return;
    } catch (e) {
      // Synchronous failure = the pty never started (node-pty load / spawn). Safe
      // to fall back to the plain inherit launch.
      process.stderr.write(
        `psu: managed-pty host unavailable (${e?.message ?? e}); using a plain launch. ` +
          `Set PAPERCUSP_PSU_NO_PTY=1 to silence.\n`,
      );
    }
  }
  // A kickoff can ONLY be delivered through the managed pty (it is injected as a
  // turn once the child settles at its prompt). If we got here with one pending,
  // the pty path was unavailable — say so LOUDLY rather than launching a session
  // that silently sits idle forever waiting for a first turn that never comes.
  if (kickoffFile) {
    process.stderr.write(
      `psu: session-port launch refused: a managed pty is required to deliver and verify the seed.\n`,
    );
    process.exitCode = 1;
    void Promise.resolve(reportPreSpawnFailure()).catch(() => undefined);
    if (sessionPort) {
      void reportSessionPortDelivery(sessionPort, {
        persisted: false,
        renderedHash: sessionPort.renderedHash,
        error: "managed pty unavailable before session-port seed delivery",
      }).catch(() => undefined);
    }
    return;
  }
  if (kickoff) {
    process.stderr.write(
      `psu: ⚠ a kickoff was requested but this launch has NO managed pty (no coord id, ` +
        `PAPERCUSP_PSU_NO_PTY/PAPERCUSP_PSU_PTY=0, or no TTY) — the session will open IDLE and ` +
        `its first turn was NOT delivered. Re-launch with the pty host enabled, or deliver the ` +
        `turn yourself (coord:wake once it registers presence).\n`,
    );
  }
  spawnInherit({
    wrapperBin,
    args,
    cwd,
    env,
    reportSessionEndedImpl,
    onSpawn,
    onSpawnFailure: reportPreSpawnFailure,
  });
}

/**
 * A live discovery record can describe a process that has stopped doing useful
 * work. Process existence is still the safety gate (a second host must not
 * silently trample a running identity), but stale pty activity is valuable
 * diagnosis — especially for headless launches, where there is no real window
 * an owner can use. Two normal 15-minute wake gaps are allowed by default so a
 * loop-armed worker waiting for its next wake is not immediately called a husk.
 * Override for local recovery drills with
 * `PAPERCUSP_PSU_LIVE_HOST_IDLE_THRESHOLD_MS`.
 */
const liveHostIdleThresholdRaw = Number(
  process.env.PAPERCUSP_PSU_LIVE_HOST_IDLE_THRESHOLD_MS,
);
export const LIVE_HOST_IDLE_THRESHOLD_MS =
  Number.isFinite(liveHostIdleThresholdRaw) && liveHostIdleThresholdRaw > 0
    ? liveHostIdleThresholdRaw
    : 30 * 60_000;

/**
 * Classify the activity evidence in a discovery record. This is deliberately a
 * diagnostic helper, not an auto-release decision: a quiet interactive prompt
 * and a loop-armed headless worker can both be quiet while still owning a live
 * identity. The resume guard remains conservative and still requires
 * `PSU_FORCE_RESUME=1` to take over.
 * Pure — exported for tests.
 */
export function classifyLiveHostActivity(
  meta,
  { now = Date.now(), idleThresholdMs = LIVE_HOST_IDLE_THRESHOLD_MS } = {},
) {
  const activitySamples = [
    meta?.lastActivityAt,
    meta?.lastOutputAt,
    meta?.lastInputAt,
  ]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  const lastActivityAt =
    activitySamples.length > 0 ? Math.max(...activitySamples) : null;
  const idleMs = hostIdleMs(meta, now);
  const threshold = Number(idleThresholdMs);
  if (idleMs === null || !Number.isFinite(threshold) || threshold <= 0) {
    return { state: "unknown", lastActivityAt, idleMs };
  }
  if (idleMs < threshold) return { state: "active", lastActivityAt, idleMs };
  // Only a host that explicitly advertises no bridged human TTY can be called
  // abandoned. An interactive host may simply be waiting at its prompt; the
  // caller still gets an activity warning, but not a false abandonment verdict.
  return {
    state: meta?.bridgeTty === false ? "abandoned" : "idle",
    lastActivityAt,
    idleMs,
  };
}

/**
 * WI-41663 — the SECOND liveness oracle, and the only one that sees a HEADLESS
 * codex session.
 *
 * WHY THIS EXISTS. `classifyLiveHostActivity` above reads the psu PTY-HOST
 * registry (`findLiveHostFor` → `~/.papercusp/psu-pty/<sid>.json`), which is
 * written only by a psu pty host. A headless session — the common shape here,
 * driven by the operator's wake executor as a cold-loop `codex exec … resume` —
 * registers no such file, so the WI-3455 double-host guard sees nothing, lets
 * the resume through, and the owner gets codex's own opaque refusal instead:
 *
 *   Error: thread/resume: thread/resume failed: thread <id> already has an
 *          active writer (code -32600)
 *
 * …which names no route, so the reasonable read is "my session is broken". It is
 * not. It is working. That is precisely why it cannot be resumed.
 *
 * Codex enforces ONE WRITER PER THREAD with an flock on
 * `<CODEX_HOME>/thread-writer-locks/<uuid>.lock`. That lock is the authority
 * codex itself consults, so reading it is not a second opinion — it is the same
 * verdict, obtained early enough for psu to explain it and name a real route.
 * `/proc/locks` yields the holder PID with no subprocess and without an flock
 * attempt of our own (which would itself contend).
 *
 * FAIL-OPEN, EVERY PATH. An unreadable `/proc/locks`, a non-Linux host, a missing
 * lock file all report "not held" — the exact pre-WI-41663 behavior. This guard
 * may only ever turn an error that WAS going to happen into a better message; it
 * must never block a resume that would have worked.
 */

/** Decode a Linux `dev_t` into major/minor, the glibc way. `/proc/locks` prints
 *  them as `%02x:%02x`, so callers compare numerically rather than by string —
 *  zero-padding is not something to depend on. Pure — exported for tests. */
export function devMajorMinor(dev) {
  const d = BigInt(dev);
  return {
    major: Number(((d >> 8n) & 0xfffn) | ((d >> 32n) & ~0xfffn)),
    minor: Number((d & 0xffn) | ((d >> 12n) & ~0xffn)),
  };
}

/**
 * The PID holding a WRITE flock on the given device+inode per `/proc/locks` text,
 * else null. Pure — exported for tests.
 *
 * A row whose second token is `->` is a BLOCKED WAITER, not a holder. Counting
 * one would report a live writer for a thread whose real writer had already
 * exited — i.e. refuse a resume that is now perfectly legal.
 * Rows read: `<n>: FLOCK ADVISORY WRITE <pid> <maj>:<min>:<ino> <start> <end>`.
 */
export function findFlockWriteHolderPid(
  procLocksText,
  { major, minor, inode },
) {
  for (const raw of String(procLocksText || "").split("\n")) {
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 6) continue;
    if (parts[1] === "->") continue; // blocked waiter — never the holder
    if (parts[1] !== "FLOCK" || parts[3] !== "WRITE") continue;
    const m = /^([0-9a-f]+):([0-9a-f]+):(\d+)$/i.exec(parts[5]);
    if (!m) continue;
    // Inode numbers are unique only per filesystem — matching one without its
    // device would let a lock on an unrelated mount refuse a resumable session.
    if (parseInt(m[1], 16) !== major) continue;
    if (parseInt(m[2], 16) !== minor) continue;
    if (Number(m[3]) !== Number(inode)) continue;
    const pid = Number(parts[4]);
    if (Number.isFinite(pid) && pid > 0) return pid;
  }
  return null;
}

/** `<CODEX_HOME>/thread-writer-locks/<uuid>.lock`. Pure — exported for tests. */
export function codexThreadWriterLockPath(codexHome, sessionId) {
  if (!codexHome || !sessionId) return null;
  return join(codexHome, "thread-writer-locks", `${sessionId}.lock`);
}

const readProcLocksText = () => readFileSync("/proc/locks", "utf8");

/**
 * Is a codex thread currently open by a live writer?
 * `{ held, pid, lockPath, sessionId, reason }` — fail-open on every error path.
 *
 * `sessionId` null ⇒ scan the whole home. psu resumes a tracked row with no
 * recorded native id as `resume --last`, which lands on the home's most recent
 * thread — usually the live one — so "any held writer in this home" is the honest
 * question there. It is also the right question for the picker, where a row's
 * recorded `sessionId` can have DRIFTED from the thread actually running: a codex
 * carry-respawn mints a new uuid, and adv row #18052 still recorded 01a036a4-…
 * while 01a038ff-… was the live thread.
 * Pure apart from the injected readers — exported for tests.
 */
export function codexThreadWriterHolder(
  codexHome,
  sessionId,
  {
    readProcLocks = readProcLocksText,
    statFile = statSync,
    listDir = safeReaddir,
  } = {},
) {
  const miss = (reason, lockPath = null) => ({
    held: false,
    pid: null,
    lockPath,
    sessionId: null,
    reason,
  });
  if (!codexHome) return miss("no-home");
  let procLocks;
  try {
    procLocks = readProcLocks();
  } catch {
    return miss("no-proc-locks");
  }
  const candidates = [];
  if (sessionId) {
    candidates.push({
      sessionId,
      lockPath: codexThreadWriterLockPath(codexHome, sessionId),
    });
  } else {
    const lockDir = join(codexHome, "thread-writer-locks");
    for (const ent of listDir(lockDir)) {
      if (!ent.isFile?.() || !ent.name.endsWith(".lock")) continue;
      const id = ent.name.slice(0, -".lock".length);
      // `.coordination.lock` is always present and is not a thread; matching it
      // would report every home live.
      if (!UUID_RE.test(id)) continue;
      candidates.push({ sessionId: id, lockPath: join(lockDir, ent.name) });
    }
  }
  // `free` (a lock file exists, nobody holds it) and `no-lock-file` (the thread
  // was never opened, or its lock was cleaned up) are both fail-open, so they do
  // not change what psu DOES — but they are the diagnostic a later reader trusts,
  // so they must not be conflated. Only a candidate we could actually stat proves
  // a lock file exists.
  let sawLockFile = false;
  for (const c of candidates) {
    let st;
    try {
      st = statFile(c.lockPath);
    } catch {
      continue; // never opened, or already cleaned up
    }
    sawLockFile = true;
    const { major, minor } = devMajorMinor(st.dev);
    const pid = findFlockWriteHolderPid(procLocks, {
      major,
      minor,
      inode: st.ino,
    });
    if (pid)
      return {
        held: true,
        pid,
        lockPath: c.lockPath,
        sessionId: c.sessionId,
        reason: "held",
      };
  }
  return miss(
    sawLockFile ? "free" : "no-lock-file",
    candidates[0]?.lockPath ?? null,
  );
}

/**
 * WI-2141892 — the same second oracle, for CLAUDE.
 *
 * WHY THIS EXISTS. `acquireAdvSessionResume` refuses a non-terminal adv row whose
 * `started_at` is inside the 300s recent-active window, and until now only a
 * `codex` row could be reconciled by local evidence. So a claude session that
 * exited WITHOUT an end witness (window closed, host killed, box rebooted — the
 * row keeps ended_at/exit_code/shutdown_accepted_at NULL) was unresumable for
 * five minutes with NO override: `PSU_FORCE_RESUME=1` gates only psu's own
 * double-host guard and never reaches the server acquire, leaving `--fork` —
 * which mints a FRESH identity and abandons the coord ownerId every lock, await
 * and presence row is keyed on. The refusal even reported that no managed-PTY
 * host was found, then discarded that fact. This turns it into evidence.
 *
 * WHAT IT ASKS. Codex has one authority to consult (its writer flock). Claude has
 * none, so the witness is the conjunction of two independent local oracles, and
 * this is the second: does any live process on this box carry the native session
 * uuid in its argv? A psu-hosted claude runs `claude … --resume <uuid>` /
 * `--session-id <uuid>`, and a headless loop-driven one — the shape the PTY
 * registry cannot see, exactly the WI-41663 gap — carries it too.
 *
 * FAIL-CLOSED, EVERY PATH, which is the OPPOSITE of the codex writer-lock probe
 * above. That one may only improve a message for an error already about to
 * happen, so an unreadable /proc means "not held". This one RELAXES a guard, so
 * an unreadable /proc, a non-Linux host, a missing session id, or any argv hit it
 * cannot attribute must report unknown and leave the guard closed.
 *
 * SELF-MATCH IS THE TRAP. This launcher's OWN argv contains `--resume <uuid>`, so
 * a naive scan always finds "a live process holding the session" — itself — and
 * the witness could never be produced. Excluding just `process.pid` is not
 * enough: psu runs under a shell/wrapper whose argv carries the same uuid. The
 * caller's whole ANCESTOR CHAIN is excluded, the same fix `scripts/proc-guard.mjs`
 * applies to the `pgrep -f` self-match class.
 */

/** `/proc/<pid>/stat`'s ppid, or null. The `comm` field can itself contain spaces
 *  and parentheses, so fields are read after the LAST ')' — splitting on
 *  whitespace from the start misreads any process named e.g. `(foo bar)`.
 *  Pure apart from the injected reader — exported for tests. */
export function procParentPid(pid, { readStat = readProcStatText } = {}) {
  let text;
  try {
    text = readStat(pid);
  } catch {
    return null;
  }
  const close = String(text ?? "").lastIndexOf(")");
  if (close < 0) return null;
  // After `<pid> (<comm>)` the next fields are `<state> <ppid> …`.
  const rest = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number(rest[1]);
  return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
}

/** The caller's pid plus every ancestor pid, walking `/proc/<pid>/stat`. Bounded
 *  and cycle-safe: a corrupted chain must not spin. Pure apart from the injected
 *  reader — exported for tests. */
export function procAncestorPids(
  startPid,
  { readStat = readProcStatText, maxDepth = 64 } = {},
) {
  const seen = new Set();
  let pid = Number(startPid);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) break;
    seen.add(pid);
    const parent = procParentPid(pid, { readStat });
    if (parent == null) break;
    pid = parent;
  }
  return seen;
}

const readProcStatText = (pid) => readFileSync(`/proc/${pid}/stat`, "utf8");
const readProcCmdlineText = (pid) =>
  readFileSync(`/proc/${pid}/cmdline`, "utf8");

/**
 * Is any live process (outside the caller's own ancestor chain) carrying this
 * native session id in its argv?
 *
 * BACKEND-NEUTRAL by construction, and used by two of them: the caller supplies
 * whichever id its resume actually puts on the command line — claude's
 * `--resume <session_id>` or omp's `-r <omp_thread_id>` (resumeArgsFor). It asks
 * only "is this string in a live argv", so nothing here knows or cares which
 * backend it is serving.
 * `{ held, pid, cmdline, reason }` — fail-CLOSED: `held` is false ONLY on a
 * complete, successful scan that found nothing.
 *
 * `reason` distinguishes the two false results that must not be conflated:
 * `"clean-scan"` is the positive absence witness; everything else
 * (`no-session-id`, `no-proc`, `scan-empty`) is unknown and must not relax the
 * guard. Pure apart from the injected readers — exported for tests.
 */
export function sessionProcessHolder(
  sessionId,
  {
    listProcPids = defaultListProcPids,
    readCmdline = readProcCmdlineText,
    readStat = readProcStatText,
    selfPid = process.pid,
  } = {},
) {
  const miss = (reason) => ({ held: false, pid: null, cmdline: null, reason });
  const id = String(sessionId ?? "").trim();
  if (!id) return miss("no-session-id");
  let pids;
  try {
    pids = listProcPids();
  } catch {
    return miss("no-proc");
  }
  if (!Array.isArray(pids) || pids.length === 0) return miss("scan-empty");
  const excluded = procAncestorPids(selfPid, { readStat });
  for (const pid of pids) {
    if (excluded.has(pid)) continue;
    let cmdline;
    try {
      cmdline = readCmdline(pid);
    } catch {
      // A pid that exited mid-scan cannot be holding the session. Any other
      // read error is equally unattributable to THIS session, and treating it
      // as a holder would make the witness unobtainable on a busy box.
      continue;
    }
    if (!cmdline || !cmdline.includes(id)) continue;
    return {
      held: true,
      pid,
      cmdline: cmdline.replace(/\0/g, " ").trim().slice(0, 400),
      reason: "argv-match",
    };
  }
  return miss("clean-scan");
}

/** Numeric pid entries under `/proc`. Exported for tests via the injectable. */
function defaultListProcPids() {
  const out = [];
  for (const entry of safeReaddir("/proc")) {
    const name = typeof entry === "string" ? entry : entry?.name;
    if (!name || !/^\d+$/.test(name)) continue;
    out.push(Number(name));
  }
  if (out.length === 0) throw new Error("/proc listed no pids");
  return out;
}

/**
 * The local liveness witnesses accepted by the resume endpoint. Keep this closed
 * and exact: a probe result that is missing, malformed, or from an unknown
 * failure mode must not relax the server's recent-active guard. Each kind is
 * bound to ONE agent backend on the server, so a claude witness can never
 * reconcile a codex row (or the reverse).
 */
export const NO_LIVE_CODEX_WRITER_EVIDENCE = Object.freeze({
  version: 1,
  kind: "no-live-codex-writer",
});

export const NO_LIVE_CLAUDE_PROCESS_EVIDENCE = Object.freeze({
  version: 1,
  kind: "no-live-claude-process",
});

export const NO_LIVE_OMP_PROCESS_EVIDENCE = Object.freeze({
  version: 1,
  kind: "no-live-omp-process",
});

const RESUME_LOCAL_LIVENESS_EVIDENCE_KINDS = Object.freeze({
  "no-live-codex-writer": NO_LIVE_CODEX_WRITER_EVIDENCE,
  "no-live-claude-process": NO_LIVE_CLAUDE_PROCESS_EVIDENCE,
  "no-live-omp-process": NO_LIVE_OMP_PROCESS_EVIDENCE,
});

/** Which witness an argv-probing backend mints, and which adv-row column carries
 *  the id its resume actually puts on the command line (resumeArgsFor). */
const ARGV_PROBE_BACKENDS = Object.freeze({
  claude: {
    evidence: NO_LIVE_CLAUDE_PROCESS_EVIDENCE,
    idOf: (session) => session?.sessionId || null,
  },
  omp: {
    evidence: NO_LIVE_OMP_PROCESS_EVIDENCE,
    idOf: (session) => session?.ompThreadId || null,
  },
});

/** Normalize a wire value to one canonical local-liveness witness. */
export function normalizeResumeLocalLivenessEvidence(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value))
    return null;
  const keys = Object.keys(value);
  const canonical = RESUME_LOCAL_LIVENESS_EVIDENCE_KINDS[value.kind];
  if (
    keys.length !== 2 ||
    !keys.includes("version") ||
    !keys.includes("kind") ||
    value.version !== 1 ||
    !canonical
  )
    return null;
  return { ...canonical };
}

/**
 * Build the positive witness for an exact Codex resume only when both local
 * liveness oracles positively say there is no competing writer. Every other
 * result remains unknown and therefore returns null (fail closed).
 * @param {{agent?: string, fork?: boolean, forceResume?: string, liveHost?: unknown, writerHolder?: {held?: boolean, reason?: string} | null}} [input]
 */
export function normalizeCodexResumeLocalLivenessEvidence({
  agent,
  fork = false,
  forceResume = process.env.PSU_FORCE_RESUME,
  liveHost,
  writerHolder,
} = {}) {
  if (
    agent !== "codex" ||
    fork ||
    forceResume === "1" ||
    liveHost !== null ||
    writerHolder == null ||
    typeof writerHolder !== "object" ||
    Array.isArray(writerHolder) ||
    writerHolder.held !== false ||
    (writerHolder.reason !== "free" && writerHolder.reason !== "no-lock-file")
  )
    return null;
  return normalizeResumeLocalLivenessEvidence(NO_LIVE_CODEX_WRITER_EVIDENCE);
}

/**
 * Build the positive witness for an exact CLAUDE or OMP resume only when BOTH
 * local liveness oracles positively say no process owns this session: the psu
 * PTY-host registry found none, and a complete `/proc` scan found no live argv
 * carrying the id that backend's resume puts on the command line. Every other
 * result — including a probe that could not complete — stays unknown and returns
 * null (fail closed).
 *
 * `liveHost` must be exactly `null` — "the registry was consulted and answered
 * no". `undefined` means the PTY-host block never ran (no coordOwnerId, or a
 * force/fork path), and that is ONE ORACLE MISSING, not two oracles passing. The
 * distinction is load-bearing: the registry is keyed by ownerId, so a row without
 * one cannot be asked at all, and inferring absence from an unasked question is
 * exactly the unearned liveness claim this whole mechanism exists to prevent.
 *
 * `PSU_FORCE_RESUME=1` deliberately does NOT produce a witness. That variable
 * means "take over a host I can SEE is alive"; a witness means "I looked and
 * there is nothing alive". Letting a force manufacture an absence claim would
 * make the server's audit trail lie about what was actually observed.
 * @param {{agent?: string, fork?: boolean, forceResume?: string, liveHost?: unknown, processHolder?: {held?: boolean, reason?: string} | null}} [input]
 */
export function normalizeArgvProbeResumeLocalLivenessEvidence({
  agent,
  fork = false,
  forceResume = process.env.PSU_FORCE_RESUME,
  liveHost,
  processHolder,
} = {}) {
  const backend = ARGV_PROBE_BACKENDS[agent];
  if (
    !backend ||
    fork ||
    forceResume === "1" ||
    liveHost !== null ||
    processHolder == null ||
    typeof processHolder !== "object" ||
    Array.isArray(processHolder) ||
    processHolder.held !== false ||
    processHolder.reason !== "clean-scan"
  )
    return null;
  return normalizeResumeLocalLivenessEvidence(backend.evidence);
}

/** The id this session's resume will put on the command line, or null when the
 *  backend does not probe argv (codex has its own flock oracle) or the row
 *  records no id — psu then resumes with `--continue` / `-c`, which names
 *  nothing to scan for. Pure — exported for tests. */
export function argvProbeSessionId(session) {
  return ARGV_PROBE_BACKENDS[session?.agent]?.idOf(session) ?? null;
}

/**
 * The CODEX_HOME a resume of `session` will run in — an explicit `codexHome`
 * (WI-3884: the home a rollout was actually FOUND in by disk scan) wins over the
 * row-id derivation. Extracted so the writer-lock guard, the picker and the spawn
 * all ask about the SAME home; a second copy of this derivation is how a guard
 * ends up reporting confidently on a directory nothing runs in. Pure — exported
 * for tests.
 */
export function codexResumeHome(session, home = homedir()) {
  if (session?.agent !== "codex") return null;
  if (session.codexHome && existsSync(session.codexHome))
    return session.codexHome;
  if (session.id != null)
    return join(home, ".papercusp", "su-codex-homes", `session-${session.id}`);
  return null;
}

/**
 * The refusal text for a resume codex is going to reject anyway. Pure — exported
 * for tests.
 *
 * Deliberately NOT overridable by `PSU_FORCE_RESUME=1`: that variable overrides
 * psu's OWN double-host guard, and anyone reaching for it here would simply
 * receive codex's `-32600` one step later. Saying so is the difference between a
 * message that ends the confusion and one that relocates it.
 */
export function codexActiveWriterMessage(session, holder) {
  const idPart =
    holder.sessionId || session.sessionId || "its most recent thread";
  const forkHint = session.sessionId
    ? `psu --resume=${session.sessionId} --fork`
    : "psu --resume=<session-id> --fork";
  return (
    `psu: codex thread ${idPart} is ALREADY OPEN by a live writer (pid ${holder.pid}) — that session is ` +
    `running RIGHT NOW, most likely a headless loop-driven agent rather than a window you can see.\n` +
    `psu: codex allows one writer per thread, so resuming here would fail with "thread/resume failed: … ` +
    `already has an active writer (code -32600)". PSU_FORCE_RESUME=1 does NOT bypass it — the lock is ` +
    `codex's, not psu's.\n` +
    `psu: what does work —\n` +
    `psu:   • run ALONGSIDE it on a branched copy of the conversation:  ${forkHint}\n` +
    `psu:   • talk to the live agent instead:  coord:send { to:['${session.coordOwnerId || "<owner-id>"}'], wake:'required' }\n` +
    `psu:   • or stop the holder first (processes:kill by taskId — never pkill -f), then resume in place.\n` +
    `psu: lock: ${holder.lockPath}`
  );
}

function fmtAge(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const ms = Date.now() - t;
  const m = 60_000,
    h = 3_600_000,
    d = 86_400_000;
  if (ms < 2 * m) return "just now";
  if (ms < h) return `${Math.floor(ms / m)}m ago`;
  if (ms < d) return `${Math.floor(ms / h)}h ago`;
  return `${Math.floor(ms / d)}d ago`;
}

/** Resume a resolved session: cd to its recorded cwd + exec the RAW agent's
 *  resume command there (P-042 — no `*-su` wrapper), re-establishing the same
 *  per-session config the wrapper used to bake. `brain` marks the resumed
 *  session as the pinned brain (Queen) — an AGENT, so it re-applies the
 *  native-scheduler lockout the human resume path deliberately skips
 *  (flags don't persist into resumes; every brain dock-open re-arms it). */
// EI-12938: async because the resume must be able to re-ensure a non-launch-ready
// config dir server-side before spawning (ensureInteractiveConfigViaOperator).
// Every call site is already inside an async function and now awaits it.
async function launchResume(
  session,
  {
    brain = false,
    fork = false,
    passthrough = [],
    addDir = [],
    accountEnv = null,
    allowSubagents,
    model = null,
    modelSource = null,
    kickoff = null,
    launchMode = null,
    ownerId = null,
  } = {},
) {
  // --fork is native for claude/codex — refuse early with a clear message rather than letting
  // resumeArgsFor throw a terse error (or, worse, appending to the original, which
  // is the clobber --fork exists to avoid).
  if (fork && session.agent !== "claude" && session.agent !== "codex") {
    console.error(forkUnsupportedMessage(session.agent));
    process.exit(2);
  }
  // WI-3455: refuse to double-host a LIVE session. A non-fork resume reuses the
  // original coord identity (PAPERCUSP_SID) + adv row, so resuming a session
  // that is STILL RUNNING in another window boots a SECOND psu host on the same
  // discovery key: the new boot tramples the live host's control socket, and
  // its exit deletes the key + falsely stamps the shared adv row ended —
  // stranding the original (wake / turn:interrupt / auto-/compact all report
  // no_live_pty_host on a live session; the 2026-07-08 su-a8f52 incident). A
  // FORK is the supported run-alongside path (fresh identity); PSU_FORCE_RESUME=1
  // overrides for recovery of a wedged-but-technically-alive host.
  let liveHostForResume;
  let localLivenessEvidence = null;
  let argvProbeHolder = null;
  if (!fork && session.coordOwnerId && process.env.PSU_FORCE_RESUME !== "1") {
    const live = findLiveHostFor(session.coordOwnerId);
    liveHostForResume = live;
    if (live) {
      const activity = classifyLiveHostActivity(live);
      const lastActivityIso = activity.lastActivityAt
        ? new Date(activity.lastActivityAt).toISOString()
        : null;
      const idleAge = lastActivityIso
        ? fmtAge(lastActivityIso)
        : "an unknown time";
      if (activity.state === "abandoned") {
        console.error(
          `psu: this session (${session.coordOwnerId}) appears ABANDONED: its headless host is still alive ` +
            `(host pid ${live.pid}) but has recorded no pty activity for ${idleAge}.\n` +
            `psu: last recorded activity: ${lastActivityIso}; there may be no usable window to resume. ` +
            `Verify its wake source, reap it if possible, or set PSU_FORCE_RESUME=1 to take over.\n` +
            `psu: if the host is intentionally loop-armed, leave it in place; otherwise do not wait on that husk.`,
        );
      } else if (activity.state === "idle") {
        console.error(
          `psu: this session (${session.coordOwnerId}) is STILL LIVE but IDLE in another window ` +
            `(host pid ${live.pid}; no pty activity recorded for ${idleAge}, last activity ${lastActivityIso}).\n` +
            `psu: resuming it here would boot a second host on the same identity and strand the live one. ` +
            `Use that window if it is attended; if it is abandoned, reap it or set PSU_FORCE_RESUME=1 to take over.`,
        );
      } else {
        console.error(
          `psu: this session (${session.coordOwnerId}) is STILL LIVE in another window (host pid ${live.pid}).\n` +
            `psu: resuming it here would boot a second host on the same identity and strand the live one.\n` +
            `psu: use that window, run alongside it with --fork, or set PSU_FORCE_RESUME=1 to take over anyway.`,
        );
      }
      process.exit(2);
    }
  }
  // WI-41663: the guard above only sees sessions with a psu PTY HOST. A headless
  // codex session (cold-loop `codex exec … resume`, the common shape here)
  // registers none, so it sailed through and the owner got codex's raw
  // "already has an active writer (code -32600)" with no route out of it.
  // Ask codex's OWN single-writer flock instead — same verdict, early enough to
  // explain. Fail-open throughout (codexThreadWriterHolder), and NOT overridable
  // by PSU_FORCE_RESUME: that overrides psu's guard, not codex's lock.
  // A FORK is exempt — verified: `codex fork <uuid>` succeeds while the original's
  // writer lock is held, which is exactly why it is the route we recommend.
  if (!fork && session.agent === "codex") {
    const holder = codexThreadWriterHolder(
      codexResumeHome(session),
      session.sessionId || null,
    );
    if (holder.held) {
      console.error(codexActiveWriterMessage(session, holder));
      process.exit(2);
    }
    // Only the two known-positive local oracle results can relax the server's
    // recent-active guard. Unknown/error results remain fail-closed.
    localLivenessEvidence = normalizeCodexResumeLocalLivenessEvidence({
      agent: session.agent,
      fork,
      forceResume: process.env.PSU_FORCE_RESUME,
      liveHost: liveHostForResume,
      writerHolder: holder,
    });
  }
  // WI-2141892 (claude) / WI-2142101 (omp): the same reconciliation for the two
  // backends whose resume names the session on the COMMAND LINE. The PTY-host
  // guard above already returned null for this session (a found host exits before
  // here), so the remaining question is whether a HEADLESS agent — invisible to
  // that registry — still holds the id. Only a complete scan that finds nothing
  // produces the witness; every failure mode leaves the server's recent-active
  // guard closed exactly as it is today. codex is absent by design: it has a
  // better oracle (its own writer flock), handled above.
  if (!fork && ARGV_PROBE_BACKENDS[session.agent]) {
    argvProbeHolder = sessionProcessHolder(argvProbeSessionId(session));
    localLivenessEvidence = normalizeArgvProbeResumeLocalLivenessEvidence({
      agent: session.agent,
      fork,
      forceResume: process.env.PSU_FORCE_RESUME,
      liveHost: liveHostForResume,
      processHolder: argvProbeHolder,
    });
  }
  let resumeClaimed = false;
  let resumeClaimKey = null;
  let resumeClaimLegacyReactivation = false;
  let resumeLaunchArgv = null;
  const cleanupResumeClaim = async () => {
    if (!resumeClaimed || session.id == null || !resumeClaimKey) return;
    // Flip the local guard before the best-effort network call so a future
    // cleanup path cannot report the same claim twice.
    resumeClaimed = false;
    if (resumeClaimLegacyReactivation) {
      // A pre-reservation operator already marked the row live during acquire
      // and has no release endpoint. Re-end that exact row through the endpoint
      // every such operator already exposes. reportSessionEnded accepts both
      // its legacy {ok:true} acknowledgement and the current typed response.
      const outcome = await reportSessionEnded(session.id, null, {
        launchFailed: true,
      });
      if (!outcome.reported) {
        console.error(
          `psu: legacy resume cleanup for session #${session.id} was not acknowledged ` +
            `(${outcome.reason ?? "unknown"}); the pending end witness will retry on the next resume.`,
        );
      }
      return;
    }
    await reportSessionResumeReleased(session.id, resumeClaimKey);
  };
  const finalizeResumeClaim = async () => {
    if (!resumeClaimed || session.id == null || !resumeClaimKey) return;
    if (resumeClaimLegacyReactivation) {
      // The legacy acquire already performed its one-step live transition.
      // There is no finalize endpoint to call on that operator generation.
      resumeClaimed = false;
      return;
    }
    const outcome = await reportSessionResumeFinalized(session.id, resumeClaimKey, {
      ...(resumeLaunchArgv ? { launchArgv: resumeLaunchArgv } : {}),
    });
    if (outcome.finalized) {
      resumeClaimed = false;
      return;
    }
    // The child is already demonstrably alive. Keep running and let genuine
    // activity repair liveness, but say why the explicit acknowledgement is
    // still pending; never acquire a replacement key for this child.
    console.error(
      `psu: session #${session.id} spawned, but resume finalization was not acknowledged ` +
        `(${outcome.reason ?? "unknown"}); continuing under claim ${resumeClaimKey}.`,
    );
  };
  // The manual resume and an already-queued loop wake can race after the old
  // process exits. Reconcile a durable end witness, then ACQUIRE the ended adv
  // row before any config repair or spawn. The short keyed lease is the
  // single-winner handoff; started_at remains untouched until spawn finalization.
  // A lost/unknown acquisition must never launch a second exact-session writer.
  if (!fork && session.id != null) {
    const pendingEnd = readPendingSessionEndWitness(session.id);
    if (pendingEnd) {
      const reconciled = await reportSessionEnded(
        session.id,
        pendingEnd.exitCode,
        {
          killedBySignal: pendingEnd.killedBySignal,
          launchFailed: pendingEnd.launchFailed === true,
          endAttemptKey: pendingEnd.endAttemptKey,
          observedAt: pendingEnd.observedAt ?? null,
        },
      );
      if (!reconciled.reported) {
        console.error(
          `psu: refusing to resume session #${session.id} — its pending end witness ` +
            `could not be reconciled (${reconciled.reason ?? "unknown"}); no agent process was spawned.`,
        );
        process.exit(2);
      }
    }
    const claim = await acquireSessionResumeWithRecovery(session.id, {
      ...(localLivenessEvidence ? { localLivenessEvidence } : {}),
    });
    if (!claim.claimed) {
      console.error(
        `psu: refusing to resume session #${session.id} — ${describeResumeClaimRefusal(claim, { agent: session.agent, processHolder: argvProbeHolder })}; no agent process was spawned.`,
      );
      // Headless revival runs this launcher beneath a detached, non-interactive
      // shell whose lifetime is the launcher's lifetime. Setting exitCode and
      // returning is not enough when launcher-owned handles remain open: the
      // shell can stay alive while holding a dead session. Terminate now; no
      // child was spawned and this branch owns no resume claim to clean up.
      process.exit(2);
    }
    resumeClaimed = true;
    resumeClaimKey = claim.resumeClaimKey;
    resumeClaimLegacyReactivation = claim.legacyReactivation === true;
  }
  try {
    if (addDir.length && session.agent === "omp") {
      console.error(
        "psu: omp has no --add-dir; ignoring it. Pass a backend flag verbatim with `-- <flag>` if omp supports one.",
      );
    }
    // omp re-loads the coordination extension per invocation; claude/codex don't
    // use -e. Stable path, only added when actually installed.
    const coordExt = join(homedir(), ".papercusp", "papercusp-coord.ts");
    const coordExtPath =
      session.agent === "omp" && existsSync(coordExt) ? coordExt : undefined;
    const injectHookPath = resolveOmpInjectHookPath(session.agent);

    // Identity + workspace scope survive the resume (see resumeEnvFor) — except a
    // FORK, which deliberately takes a fresh coord identity + no adv-row link so it
    // can run alongside the still-live original it branched from. `accountEnv` re-pins
    // the inference-gateway account (spawn-env only, otherwise lost on resume); the
    // agent-session marker arms the hook-level scheduler guard (bash gate / omp
    // coord-hook) for the brain only — never the owner's own sessions (D-003).
    const env = buildResumeEnv(session, { fork, brain, accountEnv, ownerId });
    const restoredClaudeToolRefs = addClaudeResumeToolReferencesToEnv(session, env);
    if (restoredClaudeToolRefs.restored > 0) {
      console.error(
        `psu: restored ${restoredClaudeToolRefs.restored} deferred Papercusp tool reference(s) for this Claude resume.`,
      );
    }
    if (session.agent === "codex" && modelSource) {
      env.PAPERCUSP_MODEL_SOURCE = modelSource;
    }
    // In-place resumes have no bootstrap POST. Apply the same bounded mode payload
    // through the existing admin mode:set seam; forks target the freshly minted SID
    // from buildResumeEnv rather than mutating the original session.
    if (launchMode)
      await syncResumeLaunchMode(env.PAPERCUSP_SID || null, launchMode);
    // OMP's native id is scoped to its data root. A fresh tracked launch writes
    // under session-<adv id>; without restoring that root here, the exact id we
    // read from adv_sessions is looked up in ~/.omp and falsely appears missing.
    Object.assign(env, ompTrackedResumeEnv(session));
    // EI-155: a claude session launched with per-session transcript isolation wrote
    // its transcript under an isolated CLAUDE_CONFIG_DIR (keyed by coord owner id),
    // NOT the shared ~/.claude — point the resume back at it or `claude --resume
    // <uuid>` finds "No conversation found". `session.configDir` (an untracked
    // isolated session resolved by findUntrackedSession) wins; else derive from the
    // tracked row's coordOwnerId. Only when it exists — sessions launched before
    // EI-155 used the shared store and want no override.
    if (session.agent === "claude") {
      // context-trimming parity for RESUMES (P-006 follow-on): claude silently disables tool
      // search whenever ANTHROPIC_BASE_URL is set (it can't assume a proxy forwards
      // tool_reference blocks — both of ours do, they are pass-throughs), so a routed session
      // boots with EVERY schema inline (~106k vs ~60k measured, context-trimming-tiers P-031).
      // The FRESH path forces it back on; the resume path never did, so every resumed
      // gateway-routed session has been silently paying that. Force it here too — otherwise
      // routing default-account sessions through the cache proxy would spread the same defect.
      // ⚠ GATED ON DEFERRAL BEING REACHABLE (P-007): resumeArgsFor ALSO emits
      // NATIVE_TOOL_SEARCH_DENY_FLAG, so on a resume this key would turn on nothing and merely
      // inject a `DeferredToolPlaceholder` for an empty deferred set. Same single derivation as
      // the fresh path (contextTrimmingEnv) — a second, independent write here is exactly how
      // the two halves drifted apart in the first place.
      if (
        session.agent === "claude" &&
        env.ANTHROPIC_BASE_URL &&
        env.ENABLE_TOOL_SEARCH === undefined &&
        nativeDeferralReachable()
      ) {
        env.ENABLE_TOOL_SEARCH = "true";
      }
      const dir =
        session.configDir ||
        (session.coordOwnerId
          ? sessionClaudeConfigDir(session.coordOwnerId)
          : null);
      if (dir && existsSync(dir)) {
        env.CLAUDE_CONFIG_DIR = dir;
        // EI-12938: creds are not account state. The reheal below fixes
        // `.credentials.json`; `.claude.json` (oauthAccount / onboarding / trust /
        // the user-level MCP servers) only ever comes from the interactive mirror,
        // and a dir restored from the archive (transcript only) or built for a
        // headless bee (creds symlink only) has none — so an interactive resume
        // lands in the first-run wizard. Re-ensure it server-side (ONE mirror
        // implementation) BEFORE the reheal + the settings merge below, so those
        // read the materialized dir rather than re-creating a stub over it.
        // No-op + no round-trip when the dir is already healthy.
        await ensureInteractiveConfigViaOperator(session.coordOwnerId, dir);
        // psu-resume-relogin fix: a fresh launch re-heals this dir's
        // .credentials.json (writeInteractiveClaudeConfig's reconcile-before-
        // mirror); a raw resume did not, so an in-session OAuth refresh that
        // forked the symlink into a now-stale real file made a default-account
        // resume "launch logged out". Re-point it at the global CLI login before
        // spawn. Skipped for a gateway-pinned account (auths via ANTHROPIC_BASE_URL).
        // P-006: the CACHE PROXY also sets ANTHROPIC_BASE_URL but carries the SYSTEM login
        // through verbatim — it is precisely the "default account" case this reheal exists for,
        // so it must NOT be treated as a gateway route here (skipping it would resurrect the
        // "default-account resume launches logged out" bug for every default session).
        if (!env.ANTHROPIC_BASE_URL || isCacheProxyUrl(env.ANTHROPIC_BASE_URL))
          rehealResumeCredentials(dir);
      }
    }
    // codex resumes from its per-session CODEX_HOME — derived from the session id
    // (that home still holds the session's history; only re-launching the SAME
    // session rebuilds it). The home's config.toml carries the baked superuser
    // bearer, so no PAPERCUSP_SU_TOKEN is needed. An explicit `codexHome`
    // (WI-3884: a tracked home recovered by disk scan, not row id) wins — it is
    // the home the rollout was actually FOUND in.
    // WI-41663: one derivation (codexResumeHome), shared with the writer-lock
    // guard above and the picker's live label — so a guard can never report on a
    // different directory than the one the spawn actually uses.
    const resumeCodexHome = codexResumeHome(session);
    if (resumeCodexHome) env.CODEX_HOME = resumeCodexHome;
    let resumeModel = model;
    if (session.agent === "omp") {
      const selectedResumeModel =
        resumeModel || lastActiveModelFor(session) || ompDefaultModel();
      resumeModel = applyOmpResumeAccountRoute({
        session,
        env,
        accountRoute: accountEnv,
        model: selectedResumeModel,
      });
      const requestedResumeModel = resumeModel;
      resumeModel = normalizeOmpModelSpec(requestedResumeModel);
      const resumeModelNotice =
        ompModelCompatibilityNotice(requestedResumeModel);
      if (resumeModelNotice) console.error(resumeModelNotice);
      Object.assign(
        env,
        ompResponsesCompatibilityEnv(session.agent, resumeModel, env),
      );
    }
    if (session.agent === "codex" && env.CODEX_HOME) {
      // WI-38706 — REBUILD BEFORE PATCHING. The claude branch above re-ensures its
      // config dir server-side on every resume; codex never did, so a home whose
      // config.toml had been deleted (or reduced to codex's trust-only stub) went
      // straight into the patch below, which happily wrote a gateway-less config
      // into the hole and left `codex resume` to fail on the missing provider.
      // The provider THIS thread's rollout names decides both halves below: the
      // rebuild must re-emit that provider's table, and the patch must not then
      // remove it. A resume with no explicit --account resolves to mode 'default'
      // (chooseResumeAccount does not inherit the session's original pin), so an
      // unguarded patch strips the very `[model_providers.…]` table the rollout
      // names. The ROOT `model_provider` key, by contrast, follows the route the
      // owner picked THIS launch — codex resumes with the current config's
      // provider, in either direction (EI-22086713788860638) — so a cross-family
      // switch is applied and disclosed, never refused.
      const rollout = findCodexRollout(
        join(env.CODEX_HOME, "sessions"),
        session.sessionId ?? "",
      );
      const boundProvider = rollout ? codexRolloutModelProvider(rollout) : null;
      const routeNotice = codexResumeRouteNotice(boundProvider, accountEnv, {
        fork,
        sessionId: session.sessionId ?? null,
      });
      if (routeNotice) console.error(routeNotice);
      if (accountEnv?.mode === "default") {
        const authSync = reconcileCodexSystemAuth();
        if (authSync.promoted)
          console.error(
            "psu: recovered the newest isolated Codex login as the persistent default system login.",
          );
      }
      await ensureCodexHomeViaOperator(
        session.coordOwnerId ?? null,
        env.CODEX_HOME,
        session.id ?? null,
        {
          requireGatewayProvider: boundProvider === CODEX_GATEWAY_PROVIDER_ID,
          model: resumeModel || lastActiveModelFor(session) || null,
        },
      );
      // An exact resume reuses an older per-session CODEX_HOME. If that home
      // predates the system login (or Codex replaced its symlink during OAuth
      // refresh), explicit --account=default would otherwise open a login prompt
      // despite ~/.codex/auth.json being healthy. Restore the same shared-auth
      // invariant a fresh CODEX_HOME gets before applying the account route.
      if (accountEnv?.mode === "default") rehealResumeCodexAuth(env.CODEX_HOME);
      applyCodexGatewayRoute(env.CODEX_HOME, {
        mode: accountEnv?.mode ?? "default",
        id: accountEnv?.id ?? null,
        ownerId: session.coordOwnerId ?? null,
        priority: session.role || "su",
        keepProviderTableWhenUnrouted:
          boundProvider === CODEX_GATEWAY_PROVIDER_ID,
      });
      // AFTER the gateway patch, which re-orders the file around its own markers —
      // see codexContextWindowConfigPatch for why these root keys must land first.
      // A resume that names no model resolves it from the home itself, which is
      // what stops a resumed session falling back to codex's 272k default (P-004).
      applyCodexContextWindow(env.CODEX_HOME, resumeModel);
    }

    // EI-24628537598753105: give the resumed claude process its base persona in
    // argv (see resumeArgsFor), so a cold-auto reset or a recycle of it does not
    // boot on the stock prompt. Fail-soft exactly like the respawn path: a null
    // render resumes with the old argv. An untracked fork is skipped — it would be
    // handed the ORIGINAL owner's render.
    let personaFile = null;
    if (session.agent === "claude" && session.coordOwnerId && !fork) {
      const persona = await refreshPersonaRender(session.coordOwnerId);
      personaFile = persona.promptFile;
      if (!personaFile && persona.reason !== "no-launch-spec")
        console.error(
          `psu: persona re-render unavailable (${persona.reason}) — resuming without --system-prompt-file; a later /clear or respawn of this process starts on the stock prompt`,
        );
    }
    const { bin, args } = resumeArgsFor(session, {
      coordExtPath,
      injectHookPath,
      env,
      fork,
      addDir,
      allowSubagents,
      model: resumeModel,
      personaFile,
    });
    if (brain && session.agent === "claude")
      args.push(NATIVE_SCHEDULER_DENY_FLAG);
    // notify-send lockout rides resumeArgsFor for claude already; nothing extra here.
    // Generic `--` passthrough, forwarded verbatim after psu's own resume flags.
    if (passthrough.length) args.push(...passthrough);

    // Build the current launch record only after every resume selection has
    // resolved. It is sent from finalizeResumeClaim, which runs only after
    // runWrapper confirms the child/host spawned.
    resumeLaunchArgv = resumeLaunchArgvRecord(session, {
      model: resumeModel,
      modelSource,
      account: accountEnv,
      addDir,
      allowSubagents,
      passthrough,
      launchMode,
      brain,
    });

    // Surface the successfully resolved account route. Unavailable explicit
    // auto/pin choices already threw, so this can never describe a silent fallback.
    if (accountEnv?.notice)
      console.error(`psu: account — ${accountEnv.notice}`);
    // IDENTITY-LEAK FIX (su-resume-inherits-role-mcp-json, 2026-06-30): a resumed SU claude/omp session
    // PATH-DISCOVERS <cwd>/.mcp.json and the resume path adds NO --strict-mcp-config — so a role-scoped
    // .mcp.json a co-located role spawn left in the session's cwd is inherited, giving the SU resume
    // that role's principal (e.g. system:sentinel, read-only) instead of user-level papercusp-su. This
    // is exactly the mis-launch that stranded session e424229c as system:sentinel. Park it for an SU
    // (non-role) resume; a ROLE resume (coordOwnerId 'role-…') keeps its own config. parkRoleScopedMcpJson
    // only moves ROLE-scoped files (leaves the SU's own papercusp-su alone) and role launches recreate
    // .mcp.json fresh — so parking is safe + needs no restore. Mirrors the fresh-SU park above.
    if (
      (session.agent === "claude" || session.agent === "omp") &&
      !String(session.coordOwnerId || "").startsWith("role-")
    ) {
      const parked = parkRoleScopedMcpJson(session.cwd);
      if (parked)
        console.error(
          `psu: parked a stale role-scoped ${session.cwd}/.mcp.json (an SU resume must use user-level papercusp-su, not a co-located role server)`,
        );
    }
    console.error(
      `psu: ${fork ? "forking" : "resuming"} ${session.agent} in ${session.cwd}  (${bin} ${args.join(" ")})`,
    );
    // P-011/D-008: seed the first turn of a SCRIPTED resume/fork — the managed-pty
    // host injects it once the child settles at its prompt. Provenance-tagged like
    // the fresh path's kickoff so the resumed session's prompt hook classifies it as
    // machine-origin (fleet-kickoff), never as the owner typing.
    if (kickoff) {
      console.error(
        "psu: kickoff — seeding the resumed session's first turn (suppress with --no-kickoff)",
      );
    }
    runWrapper({
      wrapperBin: bin,
      args,
      cwd: session.cwd,
      // A resume MUST run in the recorded cwd so `claude --resume` finds the
      // transcript under its cwd-encoded projects dir (EI-10938's state-dir
      // redirect would send it to the checkout → "No conversation found").
      preserveCwd: true,
      envelopeEnv: env,
      kickoff: kickoff
        ? tagKickoffProvenance(kickoff, env.PAPERCUSP_SID || null)
        : null,
      onSpawn: finalizeResumeClaim,
      onSpawnFailure: cleanupResumeClaim,
    });
  } catch (error) {
    // Everything above runWrapper is post-claim setup. A config repair, model
    // route, argv build, or synchronous spawn failure must not leave the
    // successfully claimed row looking live until stale recovery.
    await cleanupResumeClaim();
    throw error;
  }
}

/**
 * The bootstrap-su POST body that mints the NEW tracked row + native id for a
 * fork. Pure — exported for tests. A fork carries over the original's workspace +
 * plan and lands in the ORIGINAL's cwd (harness_slug:null so the server doesn't
 * relocate cwd — the seeded transcript is keyed by the original's cwd, and claude
 * resolves --resume by CLAUDE_CONFIG_DIR + the encoded cwd it runs in, so the fork
 * MUST run in that same cwd). agent is claude here because tracked forks need a
 * forced native id, and Codex exposes native fork but not caller-chosen fork ids.
 */
export function forkBootstrapBody(
  session,
  account = null,
  launchMode = null,
  ownerId = null,
) {
  return {
    agent: "claude",
    workspace: session.workspaceId || null,
    harness_slug: null,
    plan_slug: session.planSlug || null,
    cwd: session.cwd,
    // PRE-PINNED fork identity (consult-expert-routing-2026-09-22 P-003). A fork
    // normally has bootstrap-su mint its fresh coord id, which leaves that id
    // unknowable to the caller until the child registers presence. A consult
    // must name its responder BEFORE the answering session boots, so it pins the
    // id here and bootstrap-su adopts it exactly as on a fresh --owner-id launch.
    ...(ownerId ? { owner_id: ownerId } : {}),
    // A tracked fork mints a fresh session, so the gateway account pin is folded
    // server-side (resolveAccountPin) into the new launch envelope — the same path
    // a fresh psu launch takes. Omitted → no `account` key (byte-identical).
    ...(account ? { account } : {}),
    ...(launchMode ? { mode: launchMode.mode } : {}),
    ...(launchMode?.subject ? { mode_subject: launchMode.subject } : {}),
    ...(launchMode?.instructions
      ? { mode_instructions: launchMode.instructions }
      : {}),
    ...(launchMode?.ownerDirected ? { mode_owner_directed: true } : {}),
  };
}

/**
 * fleet-auto-mode (WI-1356): should this launch start in AUTO mode (the persona's
 * act/don't-ask/loop-until-done standing state)? An explicit `--auto`/`--no-auto`
 * wins; otherwise a `--fleet` launch defaults AUTO ON (a fleet MEMBER has no human at
 * its keyboard). A new-fleet create via the interactive picker (fleetName → leader)
 * does NOT default on — a leader already auto-enters AUTO via the persona rule, and
 * it has a human present. Pure — exported for tests.
 */
export function effectiveAutoMode(args) {
  // drain-mode P-003: DRAIN IMPLIES AUTO — a drain launch is autonomous by definition,
  // and this is NOT overridable by --no-auto (a non-auto drain is a contradiction).
  if (["drain", "grade", "test"].includes(args.mode)) return true;
  return args.auto ?? Boolean(args.fleet);
}

const LAUNCH_MODE_SUBJECT_MAX_CHARS = 200;
const LAUNCH_MODE_INSTRUCTIONS_MAX_CHARS = 500;

function boundedLaunchModeText(value, maxChars) {
  if (typeof value !== "string") return null;
  const text = value.trim().slice(0, maxChars);
  return text || null;
}

/**
 * Normalize the launch-mode fields parsed by psu before they cross either the
 * bootstrap JSON boundary or the resume-mode admin write. This mirrors the
 * shared TypeScript LaunchMode bounds, while keeping this plain .mjs launcher
 * independent of the operator-core module graph.
 */
export function launchModeFromArgs(args = {}) {
  if (!["drain", "grade", "test"].includes(args.mode)) return null;
  return {
    mode: args.mode,
    subject: boundedLaunchModeText(
      args.modeSubject,
      LAUNCH_MODE_SUBJECT_MAX_CHARS,
    ),
    instructions: boundedLaunchModeText(
      args.modeInstructions,
      LAUNCH_MODE_INSTRUCTIONS_MAX_CHARS,
    ),
    ownerDirected: args.modeOwnerDirected === true,
  };
}

/** Apply an explicit launch-mode overlay to an existing or newly forked resume identity. */
async function syncResumeLaunchMode(ownerId, launchMode) {
  if (!ownerId || !launchMode) return;
  try {
    const result = await api("/api/admin/mode/set", {
      method: "POST",
      body: JSON.stringify({
        mode: launchMode.mode,
        enabled: true,
        agent: ownerId,
        ownerDirected: launchMode.ownerDirected,
        subject: launchMode.subject ?? undefined,
        // An explicit empty value clears a stale child fact; a nonempty value
        // is asserted by mode:set under mode-instructions:drain.
        instructions: launchMode.instructions ?? "",
        reason: "psu resume: propagated launch mode",
      }),
    });
    if (result?.ok === false || result?.stickyConflict) {
      throw new Error(
        result.error ?? "mode:set refused the propagated launch mode",
      );
    }
  } catch (error) {
    // A resume can still be useful when the control-plane write is unavailable,
    // but never make the loss of a DRAIN overlay silent.
    console.error(
      `psu: launch-mode sync failed for ${ownerId} (resume will continue without the durable overlay): ` +
        `${error?.message ?? error}`,
    );
  }
}

/**
 * WI-1408 (fleet-join-startup-assertion): hard client-side guard mirroring the
 * server's own invariant — when this launch explicitly requested a fleet (an
 * existing `--fleet=<slug>` join, or a fresh `--fleet-name` create), the
 * bootstrap response's `fleetSlug` must come back non-null. bootstrap-su and
 * bootstrap-role already refuse (409, surfaced by `api()` as a thrown Error) a
 * fleet join that failed server-side, so this never fires in the happy path —
 * it's the last line of defense against a FUTURE regression that silently
 * returns `status: 'ok'` with `fleetSlug: null`: exactly the "colour-only,
 * membership forgotten" bug this whole feature exists to prevent.
 *
 * Skew tolerance: this launcher always runs from the STAGING tree while the
 * operator it bootstraps against runs the GREEN release pin — which can lag by
 * hours (or, wedged, weeks). A pre-WI-1408 server registers the membership
 * correctly (env PAPERCUSP_FLEET_SLUG + the pending-fleet row) but simply does
 * not echo `fleetSlug` in the response. So the hard-fail keys on the field
 * being PRESENT-BUT-NULL (a new server that genuinely failed the join); a
 * response with the field ABSENT means an old server — warn loudly and
 * continue rather than killing a correctly-fleeted member (the 2026-07-01
 * 10-member wipeout). Pure — exported for tests.
 */
export function assertFleetJoined(requestedFleet, res) {
  if (!requestedFleet) return;
  if (res && !("fleetSlug" in res)) {
    console.error(
      `psu: ⚠ --fleet was requested (${requestedFleet}) but the operator's bootstrap response predates the fleetSlug field (an older release build) — cannot verify the join client-side. The join was still applied server-side; confirm with fleet:status once up.`,
    );
    return;
  }
  if (!res?.fleetSlug) {
    throw new Error(
      `psu: --fleet was requested (${requestedFleet}) but the launch did not register a fleetSlug — refusing to start an unfleeted member. This should never happen (bootstrap-su/-role hard-fail server-side); if you see this, it's a regression.`,
    );
  }
}

/**
 * launch-path-argv-reconstruction (WI-1343): the literal `psu …` invocation this
 * fresh-SU launch reduces to — recorded on adv_sessions.launch_argv (via the
 * bootstrap-su body) so a killed batch (e.g. a 14-agent fleet) can be reconstructed
 * after the fact. Reconstructed from the RESOLVED selections + flags (so it is
 * complete even for an interactive picker launch that passed no flags). Pure —
 * exported for tests.
 */
export function psuLaunchArgvRecord(selections, args, { brain = false } = {}) {
  const argv = args.sessionPortSourceAdvSessionId
    ? [
        "psu",
        "--no-picker",
        `--resume=${args.sessionPortSourceAdvSessionId}`,
        `--agent=${selections.agent}`,
      ]
    : ["psu", "--no-picker", `--agent=${selections.agent}`];
  // Headless is a durable launch discriminator: the live-session reaper may
  // only relax the owner-directed SU safeguard when this exact token was
  // recorded. Do not infer it from the environment or rewrite it as an
  // assignment/value form; legacy and interactive rows must stay protected.
  if (args.headless) argv.push("--headless");
  if (args.carry) argv.push(`--carry=${args.carry}`);
  if (selections.workspace) argv.push(`--workspace=${selections.workspace}`);
  if (selections.harness) argv.push(`--harness=${selections.harness}`);
  argv.push(selections.plan ? `--plan=${selections.plan}` : "--no-plan");
  if (args.profile) argv.push(`--profile=${args.profile}`);
  for (const ref of args.stack || []) argv.push(`--stack=${ref}`);
  if (args.selectedIdentityRevision)
    argv.push(`--identity-revision=${args.selectedIdentityRevision}`);
  if (args.contextSize) argv.push(`--context-size=${args.contextSize}`);
  // P-005: MUST be re-emitted here — this record is what lands on
  // adv_sessions.launch_argv, and the compaction watchdog reads the limit back OFF
  // that argv. A parse without this re-emit would drop the flag silently.
  if (args.compactionLimit)
    argv.push(`--compaction-limit=${args.compactionLimit}`);
  if (args.model) argv.push(`--model=${args.model}`);
  if (args.modelSource) argv.push(`--model-source=${args.modelSource}`);
  if (args.account) argv.push(`--account=${args.account}`);
  // A joined fleet (--fleet=<slug>) or a new fleet's derived slug (picker → fleetName).
  const fleetSlug =
    args.fleet || (args.fleetName ? fleetSlugFromName(args.fleetName) : null);
  if (fleetSlug) argv.push(`--fleet=${fleetSlug}`);
  if (args.seat) argv.push(`--seat=${args.seat}`);
  const launchMode = launchModeFromArgs(args);
  if (launchMode) {
    argv.push(`--mode=${launchMode.mode}`);
    if (launchMode.subject) argv.push(`--mode-subject=${launchMode.subject}`);
    if (launchMode.instructions)
      argv.push(`--mode-instructions=${launchMode.instructions}`);
    if (launchMode.ownerDirected) argv.push("--mode-owner-directed");
  }
  if (effectiveAutoMode(args)) argv.push("--auto");
  if (args.goalBootstrapSubject)
    argv.push(`--goal-bootstrap-subject=${args.goalBootstrapSubject}`);
  if (args.launchContext) argv.push(`--launch-context=${args.launchContext}`);
  if (args.launchedBy) argv.push(`--launched-by=${args.launchedBy}`);
  if (args.ownerId) argv.push(`--owner-id=${args.ownerId}`);
  for (const d of args.addDir || []) argv.push(`--add-dir=${d}`);
  // Subagent-launch deny is DEFAULT-ON; only the non-default opt-IN needs recording.
  if (args.allowSubagents) argv.push("--allow-subagents");
  if (brain) argv.push("--brain");
  if (args.passthrough?.length) argv.push("--", ...args.passthrough);
  return argv;
}

export function freshSuBootstrapBody(
  selections,
  args,
  { brain = false, bootstrapIdempotencyKey = null } = {},
) {
  bootstrapIdempotencyKey ||= args.bootstrapIdempotencyKey || null;
  const launchMode = launchModeFromArgs(args);
  const codexSelection =
    selections.agent === "codex"
      ? resolveCodexModelSelection(args.model, {
          source:
            args.modelSource ||
            (args.model ? "explicit" : args.headless ? "explicit" : "configured-default"),
        })
      : null;
  const effectiveModel = codexSelection?.model ?? args.model;
  const effectiveArgs =
    effectiveModel === args.model && (!codexSelection || codexSelection.source === args.modelSource)
      ? args
      : { ...args, model: effectiveModel, modelSource: codexSelection?.source ?? args.modelSource };
  return {
    agent: selections.agent,
    workspace: selections.workspace,
    harness_slug: selections.harness,
    plan_slug: selections.plan,
    // WI-41363: stable across every fetchWithResilience replay of THIS launch.
    // bootstrap-su caches the completed response under the existing agent-launch
    // ledger, so an upstream-silent 502 can be retried without minting a second
    // session/process. Omitted outside the fresh scripted launch path.
    ...(bootstrapIdempotencyKey
      ? { bootstrap_idempotency_key: bootstrapIdempotencyKey }
      : {}),
    // WI-1343: the literal psu invocation → adv_sessions.launch_argv (traceability).
    launch_argv: psuLaunchArgvRecord(selections, effectiveArgs, { brain }),
    // headless-fleet-launch-and-carry-knob: the launch argv is an audit record;
    // bootstrap also needs the resolved carry value to seed the member's loop.
    ...(args.headless ? { headless: true } : {}),
    ...(args.carry ? { carry: args.carry } : {}),
    // WI-1356: start fleet/auto launches in AUTO mode — bootstrap-su bakes the durable
    // AUTO directive into the system prompt + prepends it to the seeded kickoff.
    ...(effectiveAutoMode(args) ? { auto: true } : {}),
    ...(args.goalBootstrapSubject
      ? { goal_bootstrap_subject: args.goalBootstrapSubject }
      : {}),
    // Forward the bounded named mode. bootstrap-su validates it, enters AUTO,
    // and registers the child mode before its first turn.
    ...(launchMode ? { mode: launchMode.mode } : {}),
    ...(launchMode?.subject ? { mode_subject: launchMode.subject } : {}),
    ...(launchMode?.instructions
      ? { mode_instructions: launchMode.instructions }
      : {}),
    ...(launchMode?.ownerDirected ? { mode_owner_directed: true } : {}),
    ...(args.profile ? { profile: args.profile } : {}),
    // EI-996: the su-tier ROLE NAME (e.g. 'planner'). The server resolves that
    // role's addendum from prompts/su-role-<role>.addendum.md and appends it to
    // the engineer playbook; the launch keeps the superuser MCP tier. A NAME,
    // never prose — this endpoint mints a superuser-tier prompt, so it exposes no
    // free-text append surface. Omitted for a plain su launch ⇒ byte-identical.
    ...(args.suRole ? { su_role: args.suRole } : {}),
    ...(args.stack?.length ? { stack: [...args.stack] } : {}),
    ...(args.selectedIdentityRevision
      ? { selected_identity_revision: args.selectedIdentityRevision } : {}),
    ...(args.contextSize ? { context_size: args.contextSize } : {}),
    // context-trimming-tiers P-017: explicit persona tier; omitted ⇒ server auto-select.
    ...(args.personaTier ? { persona_tier: args.personaTier } : {}),
    // weak-model-tool-tier: forward the launch model so the server's tool-tier gate
    // (buildLaunchSpec) can hard-trim a WEAK/local model's catalog for the codex path
    // (omp trims client-side above; claude self-trims). Frontier ⇒ no trim (safe default).
    ...(effectiveModel ? { model: effectiveModel } : {}),
    ...(codexSelection ? { model_source: codexSelection.source } : {}),
    ...(brain ? { brain: true } : {}),
    ...(args.account ? { account: args.account } : {}),
    // named-su-agent-fleets P-006: `fleet` = the slug to JOIN (member); `fleet_name`
    // = a freshly-entered name the server creates a fleet row from (this agent leads
    // it). The server folds PAPERCUSP_FLEET_SLUG/PAPERCUSP_FLEET_ROLE into the env.
    ...(args.fleet ? { fleet: args.fleet } : {}),
    ...(args.fleetRole ? { fleet_role: args.fleetRole } : {}),
    ...(args.fleetName ? { fleet_name: args.fleetName } : {}),
    ...(args.fleetScheme ? { fleet_scheme: args.fleetScheme } : {}),
    // agent-allocation P-005 (launch-from-seats): the delegated agent_slot template
    // this member consumes — bootstrap-su records it (consumeSeatAtBoot, mig 487)
    // and refuses the boot with seats_exhausted when the fleet's cap is reached.
    ...(args.seat ? { seat: args.seat } : {}),
    ...(args.launchContext ? { launch_context: args.launchContext } : {}),
    // Opaque session label → adv_sessions.label (bootstrap-su reads body.label),
    // so the launcher can later correlate the booted session to its coord owner id
    // (the tutorial docs-agent reuse path). No behavioural effect beyond the stamp.
    ...(args.label ? { label: args.label } : {}),
    // solo-launch-provenance: who launched this session — bootstrap-su bakes it
    // into the system prompt + PAPERCUSP_LAUNCHED_BY + an owner-scoped standing fact.
    ...(args.launchedBy ? { launched_by: args.launchedBy } : {}),
    // WI-5002/EI-13277: pre-pinned coord owner id — bootstrap-su validates it and
    // uses it as the session's sid instead of minting (programmatic-spawner contract).
    ...(args.ownerId ? { owner_id: args.ownerId } : {}),
    // A port's fresh target starts in the source's exact recorded cwd. This is
    // data provenance, not a harness-derived relocation, and is included in the
    // inspected source hash/contract.
    cwd: args.sessionPortSourceCwd || process.cwd(),
    ...(args.sessionPortToken
      ? {
          session_port_protocol: args.sessionPortProtocol,
          session_port_transform_version: args.sessionPortTransformVersion,
          session_port_token: args.sessionPortToken,
        }
      : {}),
  };
}

export function roleBootstrapBody({
  role,
  agent,
  ownerId,
  workspace,
  harness,
  feature,
  plan,
  account,
  model,
  modelSource,
  headless = false,
  fleet,
  fleetRole,
  fleetName,
  fleetScheme,
  stack,
} = {}) {
  const codexSelection =
    agent === "codex"
      ? resolveCodexModelSelection(model, {
          source: modelSource || (model ? "explicit" : headless ? "explicit" : "configured-default"),
        })
      : null;
  const effectiveModel = codexSelection?.model ?? model;
  return {
    role,
    agent,
    workspace,
    harness_slug: harness,
    feature,
    plan,
    ...(ownerId ? { owner_id: ownerId } : {}),
    ...(account ? { account } : {}),
    ...(effectiveModel ? { model: effectiveModel } : {}),
    ...(codexSelection ? { model_source: codexSelection.source } : {}),
    ...(headless ? { headless: true } : {}),
    ...(fleet ? { fleet } : {}),
    ...(fleetRole ? { fleet_role: fleetRole } : {}),
    ...(fleetName ? { fleet_name: fleetName } : {}),
    ...(fleetScheme ? { fleet_scheme: fleetScheme } : {}),
    ...(stack?.length ? { stack: [...stack] } : {}),
  };
}

/**
 * src/dst for seeding a fork's fresh isolated config dir with the original's
 * transcripts. Pure — exported for tests. We copy the whole `projects/` subtree
 * (the original's per-session dir holds essentially just <origId>.jsonl) so that
 * whichever encoded-cwd dir claude looks under, the original transcript is present
 * to --resume from.
 */
export function forkSeedPaths(origConfigDir, forkConfigDir) {
  return {
    src: join(origConfigDir, "projects"),
    dst: join(forkConfigDir, "projects"),
  };
}

/**
 * `psu --resume <tracked-claude> --fork` → a NEW *tracked* session. Unlike the
 * plain (untracked) fork (launchResume + fork, which lets claude mint a random id
 * with no adv row), this:
 *   1. mints a fresh adv_sessions row + native id via bootstrap-su (same envelope
 *      a fresh psu session gets: per-session CLAUDE_CONFIG_DIR, coord owner id, MCP),
 *   2. SEEDS that fresh config dir with the original's transcript (forkSeedPaths),
 *   3. launches `claude --resume <origId> --fork-session --session-id <forkId>` so
 *      claude forks the history into the psu-known id (verified: the trio is valid).
 * The fork therefore shows up in `psu --resume`'s picker like any other psu session.
 * Its coord identity (PAPERCUSP_SID) is fresh (a NEW row), so it runs concurrently
 * with the still-live original without colliding on locks/presence/inbox-wake.
 *
 * No engineer-playbook re-injection (unlike launchFreshSu): the forked history
 * already carries the original's system prompt — appending it again would double it.
 *
 * Falls back to the plain untracked fork (launchResume) when the session isn't a
 * forkable tracked claude session, including Codex native forks, or when bootstrap-su is unreachable/incomplete —
 * so `--fork` never hard-fails on the tracked path.
 */
/**
 * The env a TRACKED fork actually execs with — bootstrap-su's envelope PLUS the
 * psu agent-session marker. Pure — exported for tests. bootstrap-su (server-side)
 * never sets PAPERCUSP_AGENT_SESSION itself (it's a pure client-side launcher
 * concern, mirroring buildResumeEnv / the fresh-launch envelopeEnv), so folding
 * it in here is what arms the hook-level guards (native-scheduler lockout,
 * destructive shared-tree git guard — pretooluse-bash-resource-gate.sh gates
 * both on this exact var) for a forked su session. Missing it let `git stash`
 * run unblocked on the shared staging tree from a forked session (2026-07-05,
 * WI-3071).
 */
export function trackedForkEnvelopeEnv(bootstrapEnvelopeEnv, agent = "claude") {
  // P-022: a fork spawns a NEW CLI process, so the native-compaction retirement
  // must be re-stamped here exactly as on fresh launches and resumes — the
  // server's bootstrap envelope never carries it. (The tracked-fork path is
  // claude-only today; the agent param keeps the stamp honest if that widens.)
  return {
    ...bootstrapEnvelopeEnv,
    PAPERCUSP_AGENT_SESSION: "1",
    ...nativeCompactionEnv(agent),
    // A fork is a NEW CLI too: keep it off the alternate screen (terminalRenderEnv).
    ...terminalRenderEnv(agent),
    // WI-2140943 lane 2: the context-trimming trio is a launcher-side concern too
    // (the server envelope never carries it) — a fork without it boots the whole
    // catalog inline, exactly like the host-handoff successor did.
    ...contextTrimmingEnv(agent),
  };
}

/** Preserve the complete account-route decision when a tracked fork falls back
 * to the native fork path. Codex applies routing from `mode`/`id`, not env alone;
 * narrowing this object to `{ env, notice }` silently converted its auto/pin
 * forks to the default route. */
export function forkFallbackAccountRoute(account = null) {
  return {
    ...(account ?? {}),
    env: account?.env ?? {},
    notice: account?.notice ?? null,
  };
}

/**
 * A caller that pre-pins a fresh coord identity is launching a managed agent,
 * not an ordinary native fork. Such a fork cannot use Papercusp tools without
 * the bootstrap launch record, so never silently degrade it to the raw,
 * untracked resume path.
 */
export function forkBootstrapFallbackMessage(ownerId, reason) {
  const pinnedOwnerId = typeof ownerId === "string" ? ownerId.trim() : "";
  if (pinnedOwnerId) {
    throw new Error(
      `psu: ${reason}; refusing untracked fork ${pinnedOwnerId} because a pre-pinned managed identity requires a launch record.`,
    );
  }
  return `psu: ${reason} — falling back to an UNTRACKED fork (resumable only by uuid).`;
}

export async function launchTrackedFork(
  session,
  args = {},
  acct = { id: null, env: {}, notice: null },
  model = null,
  deps = {},
) {
  const postBootstrap = deps.api ?? api;
  const resumeFallback = deps.launchResume ?? launchResume;
  // The account re-pin: a TRACKED fork folds it server-side (forkBootstrapBody →
  // resolveAccountPin), like a fresh launch; an UNTRACKED fallback re-pins client-
  // side via accountEnv (it never hits bootstrap-su).
  const forkOpts = {
    fork: true,
    passthrough: args.passthrough,
    addDir: args.addDir,
    accountEnv: forkFallbackAccountRoute(acct),
    allowSubagents: args.allowSubagents,
    model,
    launchMode: launchModeFromArgs(args),
    // P-011/D-008: a scripted fork gets its first turn seeded too. It matters MORE
    // here than for an in-place resume: a fork mints a FRESH coord identity, so no
    // external caller can even address it until it boots and registers presence.
    kickoff: resumeKickoffText(args),
    // …unless the caller PRE-PINNED that identity (--owner-id), which is how a
    // consult can name its responder before the answering session exists. A
    // pre-pinned identity requires the tracked bootstrap path; an untracked fork
    // would have a live id but no launch record or Papercusp tools.
    ownerId: args.ownerId || null,
  };
  const fallbackToUntrackedFork = async (reason) => {
    console.error(forkBootstrapFallbackMessage(args.ownerId, reason));
    await resumeFallback(session, forkOpts);
  };
  const forkable =
    session.agent === "claude" &&
    session.sessionId &&
    session.coordOwnerId &&
    session.id != null;
  if (!forkable) {
    // Untracked claude (no adv row) → the plain untracked fork; non-claude →
    // launchResume refuses with a clear message. Preserve that manual fallback,
    // but fail closed when a managed caller pre-pinned an identity.
    await fallbackToUntrackedFork(`tracked fork is unavailable for ${session.agent ?? "unknown"} source`);
    return;
  }
  let res;
  try {
    res = await postBootstrap("/api/agent-mcp/console/bootstrap-su", {
      method: "POST",
      body: JSON.stringify(
        forkBootstrapBody(
          session,
          acct?.forward ?? acct?.id ?? null,
          launchModeFromArgs(args),
          args.ownerId || null,
        ),
      ),
    });
  } catch (e) {
    await fallbackToUntrackedFork(`fork bootstrap failed (${e?.message ?? e})`);
    return;
  }
  const forkId = res?.nativeSessionId || null;
  const forkConfigDir = res?.envelopeEnv?.CLAUDE_CONFIG_DIR || null;
  if (!forkId || !forkConfigDir) {
    await fallbackToUntrackedFork("fork bootstrap returned no native id / config dir");
    return;
  }
  // Seed the fork's empty per-session config dir with the original's transcript so
  // `claude --resume <origId>` resolves there; the forked turns then write
  // <forkId>.jsonl in the fork's OWN dir (keyed by its fresh coord owner id).
  const origConfigDir =
    session.configDir || sessionClaudeConfigDir(session.coordOwnerId);
  const { src, dst } = forkSeedPaths(origConfigDir, forkConfigDir);
  try {
    if (existsSync(src)) {
      mkdirSync(dst, { recursive: true });
      cpSync(src, dst, { recursive: true });
    } else
      console.error(
        `psu: original transcript dir not found (${src}) — claude --resume may fail to find it.`,
      );
  } catch (e) {
    console.error(
      `psu: could not seed the fork transcript (${e?.message ?? e}) — continuing; claude --resume may not find the original.`,
    );
  }
  // Resume the ORIGINAL's id, fork into the FORCED fork id. No playbook turn is
  // re-injected, but the fork's OWN render rides in argv (EI-24628537598753105):
  // without it the first fresh conversation of this process boots stock.
  const { bin, args: forkArgs } = resumeArgsFor(session, {
    fork: true,
    forkSessionId: forkId,
    addDir: args.addDir,
    allowSubagents: args.allowSubagents,
    model,
    personaFile: res.promptFile || null,
  });
  if (args.passthrough?.length) forkArgs.push(...args.passthrough);
  console.error(
    `psu: forking claude ${session.sessionId} → tracked session #${res.sessionId ?? "?"} (${forkId}) in ${session.cwd}  (${bin} ${forkArgs.join(" ")})`,
  );
  console.error(
    "psu: the fork is a NEW tracked session — it appears in `psu --resume`; the original is untouched.",
  );
  // Surface the account route the POST resolved. Explicit nondefault failures are
  // HTTP errors now, so a tracked fork never silently falls back to system login.
  if (res.accountNotice) console.error(`psu: account — ${res.accountNotice}`);
  // Run in the ORIGINAL's cwd (the seeded transcript is keyed by it); the fresh
  // bootstrap envelope (config dir / coord id / MCP) makes it a proper SU session
  // — trackedForkEnvelopeEnv folds in the agent-session marker bootstrap-su omits.
  const forkKickoff = resumeKickoffText(args);
  if (forkKickoff)
    console.error(
      "psu: kickoff — seeding the fork's first turn (suppress with --no-kickoff)",
    );
  runWrapper({
    wrapperBin: bin,
    args: forkArgs,
    cwd: session.cwd,
    // Same as resume: the seeded transcript is keyed by the original cwd, so
    // never redirect it away from a `.papercusp` state dir (EI-10938).
    preserveCwd: true,
    envelopeEnv: {
      ...trackedForkEnvelopeEnv(res.envelopeEnv),
      // A successful tracked fork resolves account routing server-side. No
      // gateway URL in the returned envelope means the result is the direct
      // system route; stamp the same fail-closed marker as an in-place resume.
      ...(res.agent === "claude" && !res.envelopeEnv?.ANTHROPIC_BASE_URL
        ? defaultAccountEnv()
        : {}),
    },
    // Tagged with the FORK's fresh SID (not the original's) — the provenance ledger
    // is keyed by the identity that will actually submit the turn.
    kickoff: forkKickoff
      ? tagKickoffProvenance(
          forkKickoff,
          res?.envelopeEnv?.PAPERCUSP_SID || null,
        )
      : null,
  });
}

/** A session that couldn't be matched to a tracked adv_sessions row — either a
 *  genuinely vanilla session, or a psu session that predates native-id tracking
 *  (its id was never recorded, so it can't be linked). Either way the engineer
 *  playbook won't be re-injected (and for codex, the papercusp-su tools — it ran
 *  under ~/.codex). Warn + require explicit confirmation before resuming it as
 *  if it were SU. `--yes` bypasses (scripts); non-interactive without `--yes`
 *  refuses. */
async function confirmUntrackedResume(session, args) {
  const sid = session.sessionId || session.ompThreadId || "?";
  const missing =
    session.agent === "codex"
      ? "the engineer playbook + papercusp-su tools"
      : "the engineer playbook";
  console.error(
    `psu: ⚠ session ${sid} isn't linked to a tracked psu launch — resuming it as a raw ` +
      `${session.agent} session (${missing} won't be re-injected; ${session.cwd}). ` +
      `Sessions psu started before native-id tracking won't match here either. Resuming continues it as-is.`,
  );
  if (args.yes) {
    console.error("psu: --yes given; proceeding.");
    return;
  }
  if (!args.picker) {
    console.error(
      "psu: refusing to resume an untracked session non-interactively — re-run without --no-picker, or pass --yes.",
    );
    process.exit(2);
  }
  const { confirm } = await import("@inquirer/prompts");
  const proceed = await confirm({
    message: "Do you want to proceed anyway?",
    default: false,
  });
  if (!proceed) {
    console.error("psu: aborted.");
    process.exit(0);
  }
}

/** Sentinel for the "type a different model" resume-prompt row. */
const CHOOSE_MODEL = "<choose-model>";
// The base-model menu's rows carry a discriminated `kind` now (WI-126377), so the
// old `<custom-model>` string sentinel is gone — a row whose value is an OBJECT
// cannot be confused with a model id the way a bare string could.

/**
 * WI-4889 (owner directive 2026-07-14): the resume "choose a different model"
 * path is a MENU, not a free-text `<model>[:<effort>]` prompt. Two selects —
 * base model, then reasoning effort — with a "type a custom spec…" escape that
 * keeps the old open-set free-text path. The menu mirrors the launcher's OWN
 * recognized aliases so it never drifts from what validateModelSpec accepts:
 * KNOWN_CLOUD_ALIASES (opus/sonnet/haiku/fable → Anthropic) + the
 * cloudModelBackendHint codex families (luna/terra/sol → OpenAI/codex).
 *
 * WI-4891 (owner directive 2026-07-14): each row carries its `backend` because a
 * `psu --resume` is HARD-BOUND to session.agent — resumeArgsFor(session,{model})
 * branches on the session's native CLI, and a claude transcript is not resumable
 * by codex (nor vice-versa). Offering a codex model on a claude resume just made
 * `claude -m sol` (a broken launch). resumeModelMenuFor(agent) below filters the
 * rows to the models the session's backend can ACTUALLY launch.
 */
export const RESUME_MODEL_MENU = [
  {
    name: "opus — Anthropic Claude Opus (1M, strongest)",
    value: "opus",
    backend: "claude",
  },
  {
    name: "sonnet — Anthropic Claude Sonnet (1M, balanced)",
    value: "sonnet",
    backend: "claude",
  },
  {
    name: "fable — Anthropic Claude Fable (1M)",
    value: "fable",
    backend: "claude",
  },
  {
    name: "haiku — Anthropic Claude Haiku (fast, cheap)",
    value: "haiku",
    backend: "claude",
  },
  {
    name: "sol — OpenAI GPT-5.6 “Sol” (codex)",
    value: "sol",
    backend: "codex",
  },
  { name: "luna — OpenAI “Luna” (codex)", value: "luna", backend: "codex" },
  { name: "terra — OpenAI “Terra” (codex)", value: "terra", backend: "codex" },
];

/** WI-4891: the base-model rows a resume of `agent` may offer — ONLY models that
 *  backend can launch (a resume can't switch backend). claude → the claude
 *  family; codex → the codex family; omp is model-agnostic with an open,
 *  config-driven vocabulary (not the claude/codex CLI aliases) → [] so the caller
 *  falls through to the free-text spec instead of offering a guessed alias. The
 *  `backend` tag on each row is the single source of truth, so a new row can
 *  never leak across backends. Rows are stripped to the inquirer {name,value}
 *  shape. */
export function resumeModelMenuFor(agent) {
  const rows =
    agent === "claude"
      ? RESUME_MODEL_MENU.filter((m) => m.backend === "claude")
      : agent === "codex"
        ? RESUME_MODEL_MENU.filter((m) => m.backend === "codex")
        : [];
  return rows.map((m) => ({ name: m.name, value: m.value }));
}

/** Reasoning-effort choices for the resume model menu. Values ⊆ the efforts
 *  validateModelSpec / the `:<effort>` suffix accept; '' = no suffix (model default). */
export const RESUME_EFFORT_MENU = [
  { name: "default (model default — no effort suffix)", value: "" },
  { name: "low", value: "low" },
  { name: "medium", value: "medium" },
  { name: "high", value: "high" },
  { name: "xhigh", value: "xhigh" },
  { name: "max (strongest reasoning)", value: "max" },
];

/** PURE (exported for tests): compose a base model + optional effort into a
 *  normalized psu model spec. Empty/blank model → null (agent default); a blank
 *  effort drops the `:<effort>` suffix. normalizeModelSpec adds `[1m]` for the
 *  default-1M families (opus/sonnet/fable) before the effort suffix. */
export function composeResumeModelSpec(model, effort) {
  const m = String(model ?? "").trim();
  if (!m) return null;
  const e = String(effort ?? "").trim();
  return normalizeModelSpec(e ? `${m}:${e}` : m);
}

/** Content-free lineage shown in the resume picker for ported target sessions. */
export function resumeSessionLineageLabel(session) {
  if (
    session?.portSourceAdvSessionId == null ||
    !Number.isSafeInteger(Number(session.portSourceAdvSessionId))
  )
    return null;
  const status =
    typeof session?.portStatus === "string" && session.portStatus
      ? session.portStatus
      : "delivered";
  return `ported from #${Number(session.portSourceAdvSessionId)}${status === "delivered" ? "" : ` (${status})`}`;
}

export const SESSION_PORT_PROTOCOL_VERSION = 2;
export const SESSION_PORT_TRANSFORM_VERSION = 4;

export function sessionPortUpgradeError(error) {
  const status = Number(error?.status ?? 0);
  const message = String(error?.message ?? error ?? "");
  if (
    status === 404 ||
    status === 426 ||
    /protocol|transform|migration 611|session_ports|upgrade/i.test(message)
  ) {
    return new Error(
      `psu: cross-backend session port is unavailable because the launcher/operator protocol is out of sync (${message}). ` +
        `Upgrade the staging psu launcher and serving operator together, apply migration 611, then retry.`,
    );
  }
  return error instanceof Error ? error : new Error(message);
}

async function sessionPortApi(path, opts) {
  try {
    return await api(path, opts);
  } catch (error) {
    throw sessionPortUpgradeError(error);
  }
}

function providerForResumeTarget(agent) {
  if (agent === "claude") return "anthropic";
  if (agent === "codex") return "openai";
  return "omp-configured-provider";
}

/** Resolve the backend before account selection. Same-backend selections keep
 * the byte-identical native resume/fork path; a tracked plain Claude source may
 * instead create a fresh Codex/OMP session through protocol v1. */
export function resolveResumeTarget(session, args = {}, selected = {}) {
  const sourceAgent = session?.agent;
  if (!AGENTS.includes(sourceAgent))
    throw new Error(`unsupported source backend ${String(sourceAgent)}`);
  const selectedOwnsModel = Object.prototype.hasOwnProperty.call(
    selected,
    "modelSpec",
  );
  const requestedModelSpec = selectedOwnsModel
    ? selected.modelSpec
    : args.model ?? null;
  const hinted = requestedModelSpec
    ? cloudModelBackendHint(requestedModelSpec)
    : null;
  const targetAgent =
    selected.targetAgent ?? args.agent ?? hinted ?? sourceAgent;
  if (!AGENTS.includes(targetAgent))
    throw new Error(`--agent must be one of ${AGENTS.join("|")}`);
  let modelSpec = normalizeModelSpecForAgent(targetAgent, requestedModelSpec);
  let modelSource = null;
  if (targetAgent === "codex") {
    const requestedSource = selected.modelSource ?? args.modelSource ?? null;
    let selection = null;
    if (modelSpec || requestedSource) {
      selection = resolveCodexModelSelection(modelSpec, {
        source: requestedSource ?? "explicit",
      });
    } else if (!selectedOwnsModel && targetAgent === sourceAgent) {
      selection = recordedCodexModelSelectionForResume(session);
    }
    if (!selection) {
      const unattended = args.headless === true || args.picker === false;
      selection = resolveCodexModelSelection(undefined, {
        source: unattended ? "explicit" : "configured-default",
      });
    }
    modelSpec = selection.model;
    modelSource = selection.source;
  }
  const pair = validateAgentModelPair(targetAgent, modelSpec);
  if (!pair.ok) throw new Error(pair.message);
  const operation = targetAgent === sourceAgent ? "native" : "port";
  if (operation === "port") {
    if (args.fork)
      throw new Error(
        "--fork is a native same-backend operation and cannot be combined with a session port",
      );
    if (
      sourceAgent !== "claude" ||
      (targetAgent !== "codex" && targetAgent !== "omp")
    ) {
      throw new Error(
        `session-port protocol v1 supports tracked plain Claude → Codex/OMP only (got ${sourceAgent} → ${targetAgent})`,
      );
    }
  }
  return {
    operation,
    sourceAgent,
    targetAgent,
    provider: providerForResumeTarget(targetAgent),
    modelSpec,
    ...(modelSource ? { modelSource } : {}),
  };
}

/**
 * Resolve a native Codex resume from the exact model recorded on its last
 * successful psu launch. The inherited source is stamped freshly: the prior
 * launch may itself have been explicit or configured-default, but this process
 * is authorized by the durable record rather than silently consulting native
 * Codex cache/default state.
 */
export function recordedCodexModelSelectionForResume(session) {
  if (session?.agent !== "codex" || !Array.isArray(session.launchArgv))
    return null;
  const modelArg = session.launchArgv.find(
    (arg) => typeof arg === "string" && arg.startsWith("--model="),
  );
  if (!modelArg) return null;
  return resolveCodexModelSelection(modelArg.slice("--model=".length), {
    source: "inherited",
  });
}

/**
 * Select a transcript-derived model for an unattended native Codex resume when
 * the tracked row has no launch argv (for example, because it fell outside the
 * resumable-session window). The transcript is authoritative for the model that
 * actually answered the session; resolveResumeTarget still applies the normal
 * Codex policy and deny-list to the selected value.
 */
export function resumeTargetSelectionFromLastActive(session, args = {}, last) {
  if (
    session?.agent !== "codex" ||
    typeof last !== "string" ||
    !last.trim() ||
    args.model ||
    args.modelSource ||
    (args.agent && args.agent !== "codex")
  ) {
    return {};
  }
  return {
    targetAgent: "codex",
    modelSpec: last.trim(),
    modelSource: "inherited",
  };
}

export function sessionPortTargetAccount(account) {
  if (account?.forward === "auto" || account?.auto === true) return "auto";
  if (account?.id) return account.id;
  return "default";
}

export function sessionPortRequestBody(source, target, account, args = {}) {
  if (!Number.isSafeInteger(Number(source?.id)) || Number(source.id) <= 0) {
    throw new Error(
      "cross-backend resume requires a tracked source adv session id",
    );
  }
  if (!source?.coordOwnerId) {
    throw new Error(
      "cross-backend resume requires the tracked source coordination identity",
    );
  }
  let consultEvidenceSpan = args.consultEvidenceSpan ?? null;
  if (consultEvidenceSpan == null && process.env.PAPERCUSP_CONSULT_EVIDENCE_SPAN) {
    try {
      consultEvidenceSpan = JSON.parse(process.env.PAPERCUSP_CONSULT_EVIDENCE_SPAN);
    } catch {
      throw new Error("PAPERCUSP_CONSULT_EVIDENCE_SPAN is not valid JSON");
    } finally {
      delete process.env.PAPERCUSP_CONSULT_EVIDENCE_SPAN;
    }
  }
  return {
    protocolVersion: SESSION_PORT_PROTOCOL_VERSION,
    transformVersion: SESSION_PORT_TRANSFORM_VERSION,
    workspace: source.workspaceId,
    sourceAdvSessionId: Number(source.id),
    targetBackend: target.targetAgent,
    targetModel: target.modelSpec,
    targetAccount: sessionPortTargetAccount(account),
    contextSize: args.contextSize ?? null,
    launchContext: args.launchContext ?? null,
    currentInstruction: resumeKickoffText(args),
    ...(consultEvidenceSpan == null ? {} : { consultEvidenceSpan }),
  };
}

export function formatSessionPortInspection(result) {
  const i = result?.inspection;
  if (!i) return ["psu: session-port inspection unavailable"];
  const s = i.stats ?? {};
  return [
    `psu: cross-backend port preview — Claude session #${i.source?.advSessionId} → ${i.target?.backend}/${i.target?.model ?? "default"}`,
    `psu: source snapshot — ${i.source?.snapshotKind}, ${i.source?.completeBytes ?? "?"} bytes, sha256 ${String(i.source?.sha256 ?? "").slice(0, 12)}…`,
    `psu: fidelity — ${i.requiresSummary ? "summary + recent tail (target budget requires summarization)" : "full active-path history"}; complete payload upper bound ${i.fullPayloadEstimatedTokens ?? i.fullHistoryEstimatedTokens ?? "?"} tokens / ${i.target?.availableInputTokens ?? "?"} available (${i.tokenEstimator ?? "unspecified estimator"})`,
    `psu: sanitization — ${s.redactions ?? 0} secret redaction(s), ${s.omittedThinkingBlocks ?? 0} thinking block(s) omitted, ${s.omittedSignatureBlocks ?? 0} signature block(s) omitted, ${s.omittedAttachments ?? 0} binary attachment omission(s), ${s.textAttachments ?? 0} text attachment(s) preserved, ${s.truncatedAttachments ?? 0} attachment truncation(s), ${s.unsupportedBlocks ?? 0} unsupported block(s), ${s.sidechainRecords ?? 0} sidechain record(s) excluded`,
    `psu: egress — target ${i.disclosure?.targetEgress ?? "unknown"}${i.disclosure?.summarizerEgress ? `; summarizer ${i.disclosure.summarizerEgress}` : "; no summarizer egress"}`,
    "psu: continuity — creates a NEW native target session while preserving the source coordination identity; fleet/loop/claims/modes/awaits/locks continue on the target.",
    ...(Array.isArray(i.warnings)
      ? i.warnings.map((w) => `psu: source warning — ${w}`)
      : []),
  ];
}

/**
 * WI-3758 (owner directive 2026-07-10): a resume SHOWS the session's
 * last-active model and lets you pick the one to resume with. Returns the psu
 * model spec to thread into resumeArgsFor, or null for the agent default (no
 * flag — the pre-WI-3758 behavior).
 *
 *   - `--model=<spec>` (already validated + normalized by parseArgs) wins —
 *     no prompt, like every other resume flag.
 *   - interactive (the default) → announce the last-active model + a select:
 *     keep it (an EXPLICIT flag — CLI flags don't persist into resumes, so
 *     "keep" must re-pass it) / agent default / type a different spec
 *     (validateModelSpec-checked, same guard as parseArgs' --model).
 *   - `--no-picker` scripting → no prompt, announce only (mirrors
 *     chooseResumeAccount's no-prompt gating) — agent default, exactly the old
 *     behavior.
 */
async function chooseResumeTarget(session, args) {
  let last = null;
  try {
    last = lastActiveModelFor(session);
  } catch {
    /* a transcript we can't read only costs the announce */
  }
  if (last) console.error(`psu: last active model in this session: ${last}`);
  const transcriptSelection = resumeTargetSelectionFromLastActive(
    session,
    args,
    last,
  );
  // Explicit CLI selections are a complete scripted target. Cloud aliases can
  // infer Claude vs Codex; OMP remains explicit (`--agent=omp`) because its
  // model vocabulary is intentionally open/config-driven.
  if (args.model || args.agent || !args.picker)
    return resolveResumeTarget(session, args, transcriptSelection);
  const { select, input, search } = await import("@inquirer/prompts");
  const picked = await select({
    message: "Continue this session with which backend/model?",
    choices: [
      ...(last
        ? [
            {
              name: `Native ${session.agent}: keep last active — ${last}`,
              value: { targetAgent: session.agent, modelSpec: last },
            },
          ]
        : []),
      {
        name: `Native ${session.agent}: backend default (no model flag)`,
        value: { targetAgent: session.agent, modelSpec: null },
      },
      { name: "Choose a different model…", value: CHOOSE_MODEL },
    ],
  });
  if (picked !== CHOOSE_MODEL)
    return resolveResumeTarget(session, args, picked);

  const allowedBackends = session.agent === "claude" ? AGENTS : [session.agent];
  const askCustomSpec = async (targetAgent) => {
    const typed = await input({
      message: `${targetAgent} model spec (<model>[:<effort>]; empty = backend default):`,
      validate: (v) => {
        const s = String(v ?? "").trim();
        if (!s) return true;
        const r = validateModelSpec(s);
        if (!r.ok) return r.message;
        return (
          validateAgentModelPair(targetAgent, s).ok ||
          validateAgentModelPair(targetAgent, s).message
        );
      },
    });
    const spec = String(typed ?? "").trim();
    return resolveResumeTarget(session, args, {
      targetAgent,
      modelSpec: spec || null,
    });
  };

  // WI-126377 (owner directive 2026-08-27) — this used to be four hardcoded
  // aliases and a free-text `<model>[:<effort>]` prompt, which is how a human
  // with gpt-5.5 installed ended up typing its id from memory. Every row now
  // comes from a registry something else already reads:
  //   claude → the bare aliases (the CLI resolves them; there is no local list)
  //   codex  → ~/.codex/models_cache.json, the Codex CLI's own installed models
  //   omp    → ompCatalog off /options, the field the GUI launcher renders
  // Both registry reads are fail-soft: a missing one costs its GROUP, never the
  // picker, and a per-backend free-text escape still closes the menu for an id
  // no registry lists (claude ships no local registry at all, so its four
  // aliases plus that escape genuinely are the whole list).
  const codexModels = allowedBackends.includes("codex")
    ? listCodexInstalledModels()
    : [];
  const ompModels = allowedBackends.includes("omp")
    ? await fetchOmpModelCatalog(args.workspace ?? null)
    : [];
  const modelRows = buildResumeModelRows({
    backends: allowedBackends,
    sourceAgent: session.agent,
    aliases: RESUME_MODEL_MENU,
    codexModels,
    ompModels,
    // `sol` and `gpt-5.6-sol` are the same launch — the alias is just what psu's
    // own flags and docs call it — so the registry row for an id an alias already
    // resolves to would be a duplicate that looks like a choice.
    codexSkipIds: RESUME_MODEL_MENU.filter(
      (row) => row.backend === "codex",
    ).map((row) => normalizeCodexCliModel(row.value)),
    codexDeniedIds: CODEX_DENIED_MODEL_IDS,
  });
  // A `select` cannot be typed into, so it is unusable at catalog scale (the OMP
  // registry measured 499 rows on this box). Above the threshold the picker
  // becomes the same autocomplete `search` the harness/plan pickers use, whose
  // filter matches row NAMES — which is why the row builders fold provider, id
  // and context window into the name rather than a separate detail field.
  const baseModel =
    modelRows.length > 25
      ? await search({
          message: "Target backend and model (type to filter)",
          source: async (term) => filterRows(modelRows, term),
        })
      : await select({
          message: "Target backend and model",
          choices: modelRows,
        });

  // Each escape row names its own backend, so the follow-up "Target backend"
  // select this path used to need is gone.
  if (baseModel.kind === "custom") return askCustomSpec(baseModel.targetAgent);
  // "just take in claude or omp or codex" — a backend is a complete answer, so
  // there is no model prompt and no effort prompt after this row.
  if (baseModel.kind === "backend-default")
    return resolveResumeTarget(session, args, {
      targetAgent: baseModel.targetAgent,
      modelSpec: null,
    });

  const effortRows = effortRowsFor({
    published: baseModel.efforts,
    encodable: RESUME_EFFORT_MENU.map((row) => row.value).filter(
      (value) => value !== "",
    ),
  });
  const effort =
    effortRows.length > 1
      ? await select({
          message: "Reasoning effort",
          default: "",
          choices: effortRows,
        })
      : "";
  return resolveResumeTarget(session, args, {
    targetAgent: baseModel.targetAgent,
    // An ALIAS keeps the pre-existing composer (which appends the `[1m]` window
    // marker for the default-1M families). A REGISTRY id must not: psu's
    // DEFAULT_1M_FAMILY_RE is unanchored, so a selector like
    // `google-vertex/claude-fable-5@default` matches `fable` and would be handed
    // to omp wearing a Claude-Code-private marker it has no syntax for.
    modelSpec: baseModel.alias
      ? composeResumeModelSpec(baseModel.model, effort)
      : composeRegistryModelSpec({ model: baseModel.model, effort }),
  });
}

/** WI-3859 F4: the archive-at-death lifecycle DELETES an ended session's
 *  transcript ~15s after end (it lives on in harness_shared.session_archives).
 *  The wake-executor rematerializes on ITS resume path, but a direct
 *  `psu --resume` reads the disk — so on a transcript miss, ask the operator
 *  to restore the files from the archive, then retry the disk lookup. Returns
 *  the API result or null; never throws (a miss just falls through to the
 *  existing not-found error, incl. against an older operator without the
 *  endpoint). EI-9756 regression guard: injectable `fetchImpl`/`operatorUrl`/
 *  `token` (mirrors reportSessionResumed) so this — previously untested — is
 *  unit-testable without a live operator; a real caller always hits the real
 *  operator via the defaults.
 * @param {string | null | undefined} sessionId
 * @param {'claude' | 'codex' | 'omp' | null} [sourceKind]
 */
export async function tryRematerializeFromArchive(
  sessionId,
  sourceKind = null,
  {
    fetchImpl = fetch,
    operatorUrl = OPERATOR_URL,
    token = null,
    timeoutMs = 10_000,
    statusTimeoutMs = 1_000,
    statusAttempts = 10,
    statusDelayMs = 250,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  if (!sessionId) return null;
  try {
    const tok = token ?? readToken();
    const res = await fetchImpl(
      operatorUrl + "/api/adv/sessions/rematerialize",
      {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "content-type": "application/json",
          ...(tok ? { authorization: `Bearer ${tok}` } : {}),
        },
        body: JSON.stringify({
          sessionId,
          ...(sourceKind ? { sourceKind } : {}),
        }),
      },
    );
    const r = await res.json().catch(() => null);
    if (!r?.ok) return null;
    console.error(
      `psu: transcript restored from the session archive (${r.sourceKind}, ${r.written} file(s) → ${r.root}).`,
    );
    return r;
  } catch (error) {
    // AbortSignal.timeout only cancels the client request. The synchronous
    // operator handler can still be decompressing/writing a large archive.
    if (!isArchiveRequestTimeout(error)) return null;
    const status = await pollArchiveRematerializeStatus(sessionId, sourceKind, {
      fetchImpl,
      operatorUrl,
      token,
      timeoutMs: statusTimeoutMs,
      attempts: statusAttempts,
      delayMs: statusDelayMs,
      sleep,
    });
    if (status?.ready) {
      const restored = {
        ...status,
        ok: true,
        sourceKind: status.sourceKind || sourceKind,
        written: status.written ?? 0,
        restoredAfterTimeout: true,
      };
      console.error(
        `psu: transcript restored from the session archive (${restored.sourceKind}, ${restored.written} file(s) → ${restored.root ?? "session store"}).`,
      );
      return restored;
    }
    return {
      ok: false,
      pending: true,
      timedOut: true,
      reason: "in_flight",
      sessionId,
      sourceKind: sourceKind || status?.sourceKind || null,
      archiveStatus: status,
    };
  }
}

function isArchiveRequestTimeout(error) {
  const name = String(error?.name || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  return (
    name === "timeouterror" ||
    name === "aborterror" ||
    message.includes("timeout") ||
    message.includes("aborted")
  );
}

async function pollArchiveRematerializeStatus(
  sessionId,
  sourceKind,
  { fetchImpl, operatorUrl, token, timeoutMs, attempts, delayMs, sleep },
) {
  const query = new URLSearchParams({ sessionId });
  if (sourceKind) query.set("sourceKind", sourceKind);
  const url = `${operatorUrl}/api/adv/sessions/rematerialize/status?${query.toString()}`;
  let last = null;
  const count = Math.max(1, Math.min(10, Number(attempts) || 1));
  for (let attempt = 0; attempt < count; attempt++) {
    try {
      const tok = token ?? readToken();
      const res = await fetchImpl(url, {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
      });
      const body = await res.json().catch(() => null);
      if (body) {
        last = body;
        if (body.ready || body.state !== "pending") return body;
      }
    } catch {
      // An unavailable/older status endpoint is still an UNKNOWN timeout
      // outcome; the caller must keep the safe pending result.
    }
    if (attempt + 1 < count) await sleep(Math.max(0, Number(delayMs) || 0));
  }
  return last;
}

/**
 * Re-verify — and if necessary RESTORE — a resume's transcript in the last
 * moment before exec. This closes the owner-hit race of 2026-08-12: `psu
 * --resume <id>` printed "resuming from its per-session CLAUDE_CONFIG_DIR" and
 * then died on `No conversation found with session ID: …`.
 *
 * Both resume paths resolve the session — and check that its transcript is on
 * disk — BEFORE prompting for backend/model and then account. Those prompts are
 * HUMAN-paced, while archive-at-death deletes an ended session's transcript on a
 * fixed 15s timer (SETTLE_DELAY_MS, session-archive-hook.ts). So resuming a
 * JUST-ENDED session — precisely what claude's own exit message tells you to do
 * ("Resume this session with: claude --resume <id>") — lands inside that window:
 * the existence check passes, the timer fires while the user is answering the
 * prompts, and psu execs an id that can no longer resolve. Measured on adv 15148:
 * archived + deleted 13:03:42.406, launched 13:03:55.438, 13s apart.
 *
 * The bytes are never lost — archive-at-death PUTS them in the DB session archive
 * before deleting — so the fix is to look again AFTER the prompts and
 * rematerialize when the file has gone. Returns true when there is something to
 * resume, false when there genuinely is not (the caller must then refuse to
 * launch rather than hand the agent an id that cannot resolve).
 *
 * Only claude/codex have an id-addressable on-disk transcript; omp resumes by
 * thread name and is passed through unchanged. Injectable `home`/`rematerialize`
 * for tests; never throws.
 */
export async function ensureResumeTranscriptPresent(
  source,
  { home = homedir(), rematerialize = tryRematerializeFromArchive } = {},
) {
  if (!source || (source.agent !== "claude" && source.agent !== "codex"))
    return true;
  if (sessionHasTranscript(source, { home })) return true;
  const restored = await rematerialize(
    source.sessionId || source.ompThreadId,
    source.agent,
  );
  if (restored?.pending) return restored;
  return Boolean(restored) && sessionHasTranscript(source, { home });
}

/**
 * Is a claude session's isolated `CLAUDE_CONFIG_DIR` LAUNCH-READY, or merely
 * transcript-bearing? The .mjs mirror of operator-core's
 * `isInteractiveClaudeConfigReady` — duplicated for the same reason
 * `rehealResumeCredentials` duplicates the credential reconciler: this script
 * runs as plain node outside the operator-core TS package (see the file-top note
 * on this module's dependency surface). Keep the two in sync; the REPAIR itself
 * is not duplicated — that stays server-side behind /adv/sessions/
 * ensure-claude-config, so the symlink mirror has exactly one implementation.
 *
 * `.claude.json` is the tell: a symlink ⇒ the mirror linked the user's real
 * config in; a real file with `mcpServers` ⇒ a P-020 pruned fleet copy; a real
 * file WITHOUT ⇒ the stub claude minted for itself in a first-run boot (an
 * account, but no MCP + no hooks); absent ⇒ a bee/rematerialized dir. Pure —
 * exported for tests; never throws.
 */
export function isClaudeConfigDirLaunchReady(configDir) {
  try {
    if (!configDir) return false;
    const path = join(configDir, ".claude.json");
    const entry = lstatSync(path); // throws when absent
    // Read THROUGH the link: a DANGLING symlink still lstats as a symlink but
    // gives claude nothing — the same wizard by a different door.
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    if (!cfg || typeof cfg !== "object") return false;
    return entry.isSymbolicLink() || cfg.mcpServers != null;
  } catch {
    return false;
  }
}

/**
 * EI-12938 (owner-hit 2026-07-16, "psu --resume STILL prompted me to login"):
 * ask the operator to re-materialize this session's interactive config dir when
 * it is not launch-ready.
 *
 * A fresh launch's dir is built server-side by the bootstrap-su POST; a resume
 * does no POST, so a dir that came from the ARCHIVE (transcript only) or from
 * `writeSpawnClaudeConfig` (a plan-run/bee's creds-symlink-only dir) has no
 * `.claude.json` — and that, not the credential symlink `rehealResumeCredentials`
 * fixes, is what claude reads to decide it is signed in. Result: an interactive
 * resume boots the first-run wizard (/login), mints a stub config, and the
 * SECOND attempt "works" while silently running with no MCP servers and no lock
 * hooks on a shared tree.
 *
 * Local ready-check FIRST so the normal (healthy-dir) resume pays no round-trip
 * — only a genuinely degraded dir calls out. Fail-soft: an unreachable/older
 * operator (404) leaves the launch exactly as it is today. Returns the API
 * result or null; never throws. Injectable `fetchImpl`/`operatorUrl`/`token`
 * mirror tryRematerializeFromArchive so this is unit-testable without a live
 * operator.
 */
export async function ensureInteractiveConfigViaOperator(
  owner,
  configDir,
  {
    fetchImpl = fetch,
    operatorUrl = OPERATOR_URL,
    token = null,
    timeoutMs = 10_000,
  } = {},
) {
  if (!owner) return null; // untracked/pre-EI-155 session — no owner keys its dir
  // The server keys the dir by OWNER, so it can only ensure the conventional
  // per-owner path. A session resumed from a relocated/foreign configDir would
  // otherwise have a DIFFERENT dir materialized behind its back while the one it
  // actually launches with stays broken. Same guard the rematerialize route uses.
  if (configDir !== sessionClaudeConfigDir(owner)) return null;
  if (isClaudeConfigDirLaunchReady(configDir)) return null; // healthy — byte-identical, no call
  try {
    const tok = token ?? readToken();
    const res = await fetchImpl(
      operatorUrl + "/api/adv/sessions/ensure-claude-config",
      {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "content-type": "application/json",
          ...(tok ? { authorization: `Bearer ${tok}` } : {}),
        },
        body: JSON.stringify({ owner }),
      },
    );
    const r = await res.json().catch(() => null);
    if (!r?.ok) return null;
    if (r.repaired) {
      console.error(
        "psu: repaired this session's claude config dir (it carried a transcript but no account/MCP state — a resume would have hit the first-run login screen).",
      );
    }
    return r;
  } catch {
    return null;
  }
}

/**
 * Is this per-session CODEX_HOME launch-ready — the codex twin of
 * `isClaudeConfigDirLaunchReady`?
 *
 * `config.toml` IS the codex home: the superuser MCP server + its baked bearer,
 * the approvals/sandbox bypass, `[features] remote_compaction_v2 = false`, and
 * the `[model_providers.papercusp-codex-gateway]` table every gateway-born
 * thread resolves at resume. `[mcp_servers.papercusp-su]` is the marker because
 * it is the part codex itself will never write back: after the file goes
 * missing, codex re-creates an 87-byte trust-only stub on the next launch, which
 * LOOKS like a config and carries none of the above — the resume then either
 * dies on the missing provider or, worse, comes up quietly with no coordination
 * MCP at all. Presence of the MCP block distinguishes ours from that stub.
 *
 * @param {string | null | undefined} codexHome
 * @param {string | null} [expectedOwner]
 */
export function isCodexHomeLaunchReady(codexHome, expectedOwner = null) {
  try {
    if (!codexHome) return false;
    // AGENTS.md is this session's behavioral spine. A home with valid MCP/hooks
    // but no prompt is not launch-ready and must be rematerialized before a
    // resume or deterministic carry successor starts.
    const agentsText = readFileSync(join(codexHome, "AGENTS.md"), "utf8");
    if (!stripManagedCarrySection(agentsText).trim()) return false;
    const carryBasePath = join(codexHome, ".papercusp-carry-base-AGENTS.md");
    if (
      existsSync(carryBasePath) &&
      !stripManagedCarrySection(readFileSync(carryBasePath, "utf8")).trim()
    ) return false;
    const text = readFileSync(join(codexHome, "config.toml"), "utf8"); // throws when absent
    if (!text.includes("[mcp_servers.papercusp-su]")) return false;
    // Codex 0.157 captures GNOME Terminal right-clicks in alternate-screen
    // mode. A healthy pre-0.157 home needs an in-place config repair on resume
    // so the terminal's Paste menu remains usable (WI-10003121).
    if (!text.includes('[tui]\nterminal_title = []\nalternate_screen = "never"\n')) return false;
    if (!expectedOwner) return true;
    if (!text.includes(`client=${encodeURIComponent(expectedOwner)}`))
      return false;

    const diagnostics = JSON.parse(
      readFileSync(join(codexHome, "papercusp-diagnostics.json"), "utf8"),
    );
    if (diagnostics?.lockOwnerSid !== expectedOwner) return false;
    if (diagnostics?.lockEnforcement === "hooks-missing") return true;
    const hooksText = readFileSync(join(codexHome, "hooks.json"), "utf8");
    const hookOwners = Array.from(
      hooksText.matchAll(/PAPERCUSP_(?:LOCK_)?SID='([^']+)'/g),
      (match) => match[1],
    );
    const hooks = JSON.parse(hooksText);
    // WI-41305: an otherwise healthy, same-owner home can still predate the
    // Codex SessionStart/SessionEnd registration. Treat that as a repair input:
    // without SessionEnd, the owner's logical "end session" never reaches the
    // existing continuation classifier + audited fleet:kill teardown, leaving
    // this exact managed host alive to block the next resume.
    const lifecycleReady = ["SessionStart", "SessionEnd"].every((event) =>
      hooks?.hooks?.[event]?.some((group) =>
        group?.hooks?.some(
          (hook) =>
            String(hook?.command || "").includes("lifecycle-report.sh") &&
            String(hook.command).includes(`PAPERCUSP_SID='${expectedOwner}'`),
        ),
      ),
    );
    return (
      hookOwners.length > 0 &&
      hookOwners.every((owner) => owner === expectedOwner) &&
      lifecycleReady
    );
  } catch {
    return false;
  }
}

/**
 * WI-38706 — the codex twin of `ensureInteractiveConfigViaOperator`, and for the
 * same structural reason: a FRESH psu launch has its CODEX_HOME materialized
 * server-side by bootstrap-su (`writeSuCodexHome`), while a RESUME does no
 * bootstrap POST. The launcher cannot rebuild the home itself — psu-launcher.mjs
 * is plain node outside operator-core, so it can neither sign the MCP url nor
 * import the writer.
 *
 * Until now the resume leg simply ASSUMED the home was intact. It often wasn't:
 * the session archiver was unlinking the home's `config.toml` (it archived
 * directory-shared state under one thread's session id — fixed in
 * session-archive.ts), and the launcher's own gateway patch would then write a
 * gateway-less config into the hole. Owner-hit 2026-08-14: 11 homes, 89
 * rollouts, all failing `thread/resume` on the missing provider.
 *
 * The server-side writer is idempotent and also reconciles project HTTP MCP
 * servers. A structurally ready home can still predate a newly inherited
 * connector, so every resume must reach that writer.
 * @param {string | null} owner
 * @param {string | null} codexHome
 * @param {string | number | null} advSessionId
 * @param {{requireGatewayProvider?: boolean, model?: string | null, routeMode?: string | null, accountId?: string | null, priority?: string | null, fetchImpl?: (...args: any[]) => Promise<any>, operatorUrl?: string, env?: NodeJS.ProcessEnv, probe?: typeof probeOmpOperatorMcp, onRecovery?: Function, token?: string | null, timeoutMs?: number}} options
 */
export async function ensureCodexHomeViaOperator(
  owner,
  codexHome,
  advSessionId,
  {
    requireGatewayProvider = false,
    model = null,
    routeMode = null,
    accountId = null,
    priority = null,
    fetchImpl = fetch,
    // A resume can inherit a stale PAPERCUSP_HONO_PORT from the judge/runtime.
    // Resolve the runtime route only when repair is actually needed; explicit
    // callers may still pin a URL for tests or a deliberate control-plane hop.
    operatorUrl = /** @type {string | undefined} */ (undefined),
    env = process.env,
    probe = probeOmpOperatorMcp,
    onRecovery,
    token = null,
    timeoutMs = 10_000,
  } = {},
) {
  if (!owner || !codexHome || advSessionId == null) return null;
  // The server keys the home by ADV SESSION ID, so it can only ensure the
  // conventional path. A resume pointed at a relocated/foreign home would
  // otherwise have a DIFFERENT home rebuilt behind its back while the one it
  // actually launches with stays broken (the same guard the claude twin uses).
  if (
    codexHome !==
    join(homedir(), ".papercusp", "su-codex-homes", `session-${advSessionId}`)
  )
    return null;
  try {
    const resolvedOperatorUrl =
      operatorUrl ??
      (await resolveOmpOperatorUrl(undefined, {
        env: env ?? process.env,
        probe,
        onRecovery,
      }));
    const tok = token ?? readToken();
    const res = await fetchImpl(
      resolvedOperatorUrl + "/api/adv/sessions/ensure-codex-home",
      {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "content-type": "application/json",
          ...(tok ? { authorization: `Bearer ${tok}` } : {}),
        },
        body: JSON.stringify({
          owner,
          advSessionId,
          requireGatewayProvider,
          ...(model ? { model } : {}),
        }),
      },
    );
    const r = await res.json().catch(() => null);
    if (!r?.ok) return null;
    // The canonical writer refreshes config.toml and may remove the launch's
    // gateway selector. Reapply the explicit route after every carry refresh.
    // Default/unspecified launches keep their existing provider semantics.
    if (routeMode === "auto" || routeMode === "pin") {
      if (routeMode === "pin" && !accountId)
        throw new Error("Codex carry cannot restore a pin without an account id");
      applyCodexGatewayRoute(codexHome, {
        mode: routeMode,
        id: accountId,
        ownerId: owner,
        priority,
      });
    }
    if (r.repaired) {
      console.error(
        "psu: repaired this session's codex home config/hooks/instructions in place (existing rollouts were preserved).",
      );
    }
    return r;
  } catch {
    return null;
  }
}

/** Pure launch-argument half of a session port. Keeping the same owner id is the
 * authority-continuity invariant: the new native backend is another body of the
 * resumed session, not a fork, so its loop/claims/modes/awaits/locks stay keyed
 * to the identity they already use. Bootstrap independently checks the prepared
 * port's server-recorded source owner before it accepts these args. */
export function sessionPortTargetArgs(source, target, account, args, prepared) {
  const portId =
    prepared.portId || String(prepared.token || "").split(".", 1)[0];
  if (!portId)
    throw new Error("prepared session port is missing its attempt id");
  return {
    ...args,
    picker: false,
    resume: false,
    resumeId: null,
    fork: false,
    agent: target.targetAgent,
    model: target.modelSpec,
    modelSource: target.modelSource,
    account: sessionPortTargetAccount(account),
    fleet: null,
    fleetRole: null,
    fleetName: null,
    fleetScheme: null,
    seat: null,
    auto: false,
    mode: null,
    profile: "engineer",
    launchContext: args.launchContext ?? null,
    // The session-port seed IS the target's first turn: sessionPortRequestBody
    // already folded any scripted instruction (`--kickoff=` or the spawn-safe
    // PAPERCUSP_KICKOFF_PROMPT env) into it as `currentInstruction`. Letting the
    // fresh launch re-derive a plain kickoff from the same env hands the PTY
    // host BOTH channels, which it refuses before spawning — every scripted
    // consult convert died at boot that way (WI-10003858).
    kickoff: false,
    kickoffPromptText: null,
    launchedBy: null,
    ownerId: source.coordOwnerId,
    resumeSession: null,
    sessionPortProtocol: SESSION_PORT_PROTOCOL_VERSION,
    sessionPortTransformVersion: SESSION_PORT_TRANSFORM_VERSION,
    sessionPortToken: prepared.token,
    bootstrapIdempotencyKey: `session-port:${portId}`,
    sessionPortSourceAdvSessionId: Number(source.id),
    sessionPortSourceCwd: source.cwd,
  };
}

export async function launchSessionPort(
  source,
  target,
  account,
  args,
  {
    sessionPortApiImpl = sessionPortApi,
    launchFreshSuImpl = launchFreshSu,
    reportLaunchFailureImpl = reportSessionPortLaunchFailure,
  } = {},
) {
  if (source.role != null)
    throw new Error(
      "session-port protocol v1 requires a plain tracked SU source",
    );
  const request = sessionPortRequestBody(source, target, account, args);
  const inspected = await sessionPortApiImpl("/api/adv/sessions/port/inspect", {
    method: "POST",
    body: JSON.stringify(request),
  });
  for (const line of formatSessionPortInspection(inspected))
    console.error(line);
  if (args.picker && !args.yes) {
    const { confirm } = await import("@inquirer/prompts");
    const proceed = await confirm({
      message: `Prepare this sanitized history and launch a new ${target.targetAgent} session?`,
      default: false,
    });
    if (!proceed) {
      console.error(
        "psu: session port cancelled before egress; no artifact or target session was created.",
      );
      return;
    }
  }
  const prepared = await sessionPortApiImpl("/api/adv/sessions/port/prepare", {
    method: "POST",
    body: JSON.stringify({
      ...request,
      expectedSourceHash: inspected.inspection.source.sha256,
    }),
  });
  console.error(
    `psu: prepared session port ${prepared.portId} (${prepared.fidelity}; expires ${prepared.expiresAt}) — launching fresh target.`,
  );
  const targetArgs = sessionPortTargetArgs(
    source,
    target,
    account,
    args,
    prepared,
  );
  try {
    await launchFreshSuImpl(
      {
        agent: target.targetAgent,
        workspace: source.workspaceId,
        harness: null,
        plan: source.planSlug ?? null,
      },
      targetArgs,
    );
  } catch (error) {
    let disposition;
    try {
      disposition = await reportLaunchFailureImpl(
        {
          ...prepared,
          protocolVersion: SESSION_PORT_PROTOCOL_VERSION,
          transformVersion: SESSION_PORT_TRANSFORM_VERSION,
          workspace: source.workspaceId,
        },
        error,
      );
    } catch (finalizationError) {
      throw new Error(
        `psu: session-port target bootstrap/spawn failed after preparation ${prepared.portId}: ` +
          `${error?.message ?? error}. Automatic failure finalization was not acknowledged: ` +
          `${finalizationError?.message ?? finalizationError}. The prepared artifact expires at ${prepared.expiresAt}.`,
        { cause: error },
      );
    }
    throw new Error(
      `psu: session-port target bootstrap/spawn failed after preparation ${prepared.portId} and was finalized ` +
        `${disposition?.status ?? disposition?.port?.status ?? "failed"}: ${error?.message ?? error}`,
      { cause: error },
    );
  }
}

async function launchResolvedResume(source, args, { tracked }) {
  // Backend/model first, account second. Account choices are provider-scoped;
  // prompting before the target is known is how cross-backend resumes get
  // silently pinned to the source provider.
  const target = await chooseResumeTarget(source, args);
  if (target.operation === "port" && !tracked) {
    throw new Error(
      "cross-backend resume requires a psu-tracked source session; raw native sessions can only resume/fork in place",
    );
  }
  if (
    target.operation === "port" &&
    !(await ensureBackendInstalled(target.targetAgent))
  ) {
    process.exitCode = 1;
    return;
  }
  const account = await chooseResumeAccount(
    { ...source, agent: target.targetAgent },
    { ...args, model: target.modelSpec },
  );
  if (target.operation === "port") {
    await launchSessionPort(source, target, account, args);
    return;
  }
  if (
    !(await preflightCodexAutoPool({
      agent: target.targetAgent,
      model: target.modelSpec,
      account,
    }))
  ) {
    process.exitCode = WALLED_POOL_REFUSAL_EXIT;
    return;
  }
  const resumeModel = reconcileResumeModelForAccountRoute({
    agent: target.targetAgent,
    model: target.modelSpec,
    accountRoute: account,
  });
  if (resumeModel.notice)
    console.error(`psu: model compatibility — ${resumeModel.notice}`);
  // LAST-MOMENT transcript re-verify. Everything below resumes IN PLACE against
  // the session's own on-disk transcript, and that transcript was last checked
  // BEFORE the two human-paced prompts above — long enough for the 15s
  // archive-at-death timer to have deleted it out from under us. Look again, and
  // restore from the archive if it has gone. (A cross-backend PORT returned
  // above: it rebuilds context server-side and owns no on-disk transcript.)
  const transcriptReady = await ensureResumeTranscriptPresent(source);
  if (transcriptReady?.pending) {
    console.error(
      `psu: archive restore for ${source.sessionId ?? source.ompThreadId ?? ""} is still in progress; ` +
        "the operator timed out while writing its transcript. Retry in a few seconds.",
    );
    process.exitCode = 1;
    return;
  }
  if (!transcriptReady) {
    console.error(
      `psu: session ${source.sessionId ?? source.ompThreadId ?? ""} has no transcript on disk and no copy in ` +
        `the session archive to restore — there is nothing to resume. If it ended moments ago its transcript may ` +
        `still be archiving; retry in a few seconds, or pick another session with \`psu --resume\`.`,
    );
    process.exitCode = 1;
    return;
  }
  if (args.fork && tracked) {
    await launchTrackedFork(source, args, account, resumeModel.model);
    return;
  }
  await launchResume(source, {
    fork: args.fork,
    passthrough: args.passthrough,
    addDir: args.addDir,
    accountEnv: account,
    allowSubagents: args.allowSubagents,
    model: resumeModel.model,
    modelSource: target.modelSource,
    kickoff: resumeKickoffText(args),
    launchMode: launchModeFromArgs(args),
    // Honored on the FORK branch only (resumeEnvFor): a same-backend resume
    // re-attaches its recorded coord id and must not be re-pinned.
    ownerId: args.ownerId || null,
  });
}

// `psu --resume` (picker) or `psu --resume=<id>` / `psu --resume <id>`
// (direct): resume a tracked session by adv id, recorded native session id,
// linked OMP thread id, or Codex rollout UUID under a tracked CODEX_HOME. If
// none match, fall back to an unmatched session by the agent's native store id.
// Either way, cd to the recorded cwd and run the agent there.
async function resumeFlow(args = {}) {
  const data = await api("/api/adv/sessions/resumable");
  const sessions = (data.sessions || []).filter((s) => s.agent && s.cwd);

  // Direct resume by id — skip the picker.
  if (args.resumeId) {
    // 1. A psu-tracked session (adv_sessions row)? Match the integer adv id,
    //    the agent's recorded NATIVE session id (claude), linked native thread
    //    id (OMP), or discovered rollout UUID in the tracked CODEX_HOME
    //    (Codex). Resuming by any handle finds the tracked row with NO false
    //    "not started by psu" warning.
    const tracked = resolveTrackedResumeSession(sessions, args.resumeId);
    if (tracked) {
      // A tracked row alone doesn't prove resumability — a launch that died
      // (or was closed) before its first persisted message has NO transcript,
      // and the raw `--resume` would fail "No conversation found". But an
      // ENDED session's transcript may simply be archived (archive-at-death
      // deletes it from disk ~15s after end) — restore it and retry before
      // declaring it unresumable.
      if (!sessionHasTranscript(tracked)) {
        const restored = await tryRematerializeFromArchive(
          tracked.sessionId || tracked.ompThreadId,
          tracked.agent,
        );
        if (restored?.pending) {
          console.error(
            `psu: session #${tracked.id} archive restore is still in progress; the operator timed out while ` +
              `writing its transcript. Retry psu --resume=${args.resumeId} in a few seconds.`,
          );
          process.exit(1);
        }
        if (!restored || !sessionHasTranscript(tracked)) {
          console.error(
            `psu: session #${tracked.id} (${tracked.agent}${tracked.sessionId ? ` ${tracked.sessionId}` : ""}) ` +
              `has no persisted transcript — it died or was closed before its first message (and the session ` +
              `archive holds no copy), so there is no conversation to resume. Pick a different session with \`psu --resume\`.`,
          );
          process.exit(1);
        }
      }
      await launchResolvedResume(tracked, args, { tracked: true });
      return;
    }

    // 2. Not tracked → search the agents' OWN session stores for the id. On a
    //    miss, the transcript may be ARCHIVED (deleted from disk at session
    //    end) — restore it from the session archive and search again.
    let untracked = findUntrackedSession(args.resumeId);
    if (!untracked) {
      const restored = await tryRematerializeFromArchive(args.resumeId);
      if (restored?.pending) {
        console.error(
          `psu: session archive restore for ${args.resumeId} is still in progress; the operator timed out while ` +
            "writing its transcript. Retry in a few seconds.",
        );
        process.exit(1);
      }
      if (restored) untracked = findUntrackedSession(args.resumeId);
    }
    if (!untracked) {
      const ids = sessions
        .map((s) => s.id)
        .filter((x) => x != null)
        .join(", ");
      console.error(
        `psu: no session "${args.resumeId}" — not a tracked psu session (ids: ${ids || "none"}), ` +
          `no claude/codex session file with that id under ~/.claude/projects, per-session config dirs, ` +
          `tracked CODEX_HOME dirs, or ~/.codex/sessions, and no session-archive copy to restore ` +
          `(omp threads resume by thread name).`,
      );
      process.exit(1);
    }

    // 3. Untracked ≠ identity-less: the psu-session-owners index may still hold
    //    the coord ownerId this session was BORN with (recorded at every psu
    //    launch). Recover it so resumeEnvFor re-attaches the session's real
    //    identity — fleet leadership, file locks, presence, pty-host discovery —
    //    instead of minting a fresh SID and orphaning all four (the 2026-07-02
    //    identity-split bug). A fork still mints (resumeEnvFor's fork branch).
    const bornIdentity = recoverResumeSessionIdentity(untracked);
    if (bornIdentity) {
      untracked.coordOwnerId = bornIdentity.ownerId;
      // A transcript can remain on disk after its adv row falls outside the
      // recent API window. Restore the row id recorded at launch so every
      // subsequent respawn report uses the exact Codex-home key instead of the
      // owner-only started_at fallback.
      if (untracked.id == null && bornIdentity.advSessionId != null)
        untracked.id = bornIdentity.advSessionId;
    }

    // WI-10002877: an old psu session can be absent from the bounded resumable
    // response while its local first-write-wins index still names the exact adv
    // row. Rehydrate that row before choosing the launch route. Without this,
    // a consult's pre-pinned --owner-id took the raw fork path, reused the OLD
    // source CLAUDE_CONFIG_DIR, and wedged at that stale dir's onboarding/trust
    // dialogs. Measured 2026-09-24: two ranks from source 9aed… failed this way;
    // a different source succeeded. The managed path below mints a fresh config
    // dir + forced native id and keeps the fork durable/resumable.
    //
    // WI-10003198: the index alone was not enough. Every earlier incarnation of
    // a carry-respawn chain has no index entry with a row id (and no row of its
    // own), so the same call also asks the server to bridge the native id to its
    // owner's row — the lookup the consult dispatcher already made.
    let recoveryReasons = [];
    if (untracked.psuTracked) {
      const recovery = await recoverOutOfWindowTrackedSession(untracked);
      if (recovery.tracked) {
        await launchResolvedResume(recovery.tracked, args, { tracked: true });
        return;
      }
      recoveryReasons = recovery.reasons;
      if (recoveryReasons.length)
        console.error(
          `psu: exact tracked-session recovery for ${untracked.sessionId ?? untracked.ompThreadId ?? "?"} failed: ` +
            `${recoveryReasons.join("; ")}.`,
        );
    }

    // A pre-pinned identity is a managed launch contract. Never silently turn
    // it into a raw native fork when the durable row could not be recovered:
    // that creates no adv row, reuses stale source config, and gives the caller
    // a responder id that is not backed by a launch record. Fail this rank fast;
    // the consult dispatcher can continue its ranked fallback walk truthfully.
    if (args.fork && args.ownerId && untracked.psuTracked) {
      console.error(
        `psu: refusing unmanaged fork ${args.ownerId}: tracked source session ${untracked.sessionId ?? untracked.ompThreadId ?? "?"} ` +
          `could not recover adv row #${untracked.id ?? "?"}` +
          (recoveryReasons.length ? ` (${recoveryReasons.join("; ")})` : "") +
          ".",
      );
      process.exit(2);
    }

    // 4. Untracked = NOT launched by psu → its engineer playbook (and, for codex,
    //    the papercusp-su tools) are NOT loaded. Require an explicit confirm.
    //    EXCEPT a psuTracked hit — su-codex-homes (WI-3884) or the claude
    //    per-owner isolation dir (EI-9756): that session WAS psu-launched —
    //    only older than the resumable window — and its per-session store
    //    (CODEX_HOME / CLAUDE_CONFIG_DIR) carries the baked config, so nothing
    //    is lost on resume; no confirm, and no "not a tracked psu launch" scare.
    if (untracked.psuTracked) {
      const store =
        untracked.agent === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
      console.error(
        `psu: session ${untracked.sessionId} is a psu-launched ${untracked.agent} session${untracked.id != null ? ` (tracked #${untracked.id})` : ""} — ` +
          `older than the recent-session window; resuming from its per-session ${store}.`,
      );
    } else {
      await confirmUntrackedResume(untracked, args);
    }
    // A genuinely untracked session has no adv row to seed a tracked fork from —
    // fork it in place (claude mints a random id; resumable only by uuid).
    // A psuTracked hit with a pre-pinned managed identity was recovered or refused
    // above; it must never reach this raw fallback.
    // Account re-pin applies here too (a raw resume can be routed through the
    // gateway), but raw sessions remain same-backend: V1 ports require tracked
    // workspace/source identity and server-side authority checks.
    await launchResolvedResume(untracked, args, { tracked: false });
    return;
  }

  // Only offer sessions that are actually resumable — an on-disk transcript OR a
  // DB session-archive (server-stamped `hasArchive`). An ended session's on-disk
  // transcript is deleted ~15s after death, so a resumable session may live ONLY
  // in the archive; the on-disk-only test used to hide every such session as a
  // ghost (owner-hit 2026-07-13: "hiding N session(s) with no persisted transcript"
  // after sessions moved off disk to the DB). A row with NEITHER is a true ghost
  // (recorded at launch, never persisted a first message → "No conversation found"
  // on every attempt). Say how many were hidden so "where did my session go?" has
  // an answer. An archived pick is rematerialized to disk on selection below.
  const resumable = sessions.filter((s) => sessionIsResumable(s));
  const ghostCount = sessions.length - resumable.length;
  if (ghostCount > 0) {
    console.error(
      `psu: hiding ${ghostCount} session(s) with no persisted transcript (died or closed before the first message) — they cannot be resumed.`,
    );
  }
  if (resumable.length === 0) {
    console.error(
      "psu: no resumable sessions — launch one with `psu`, or resume a raw session by id with `psu --resume=<session-id>`.",
    );
    process.exit(1);
  }
  const { search } = await import("@inquirer/prompts");
  // WI-41663: read /proc/locks ONCE for the whole list rather than per row — the
  // picker labels every codex session whose thread is currently open by a live
  // writer, so "this one will refuse to resume" is visible BEFORE the pick rather
  // than as an error after it. Fail-open: unreadable ⇒ no labels, list unchanged.
  let procLocksSnapshot = null;
  try {
    procLocksSnapshot = readFileSync("/proc/locks", "utf8");
  } catch {
    /* not Linux, or unreadable — rows simply carry no live-writer label */
  }
  const rows = resumable.map((s) => {
    // Surface each session's last-active model in its row (WI-3758) — a cheap
    // tail read per row; unknown (omp / unreadable) rows just omit the segment.
    let lastModel = null;
    try {
      lastModel = lastActiveModelFor(s);
    } catch {
      /* row stays model-less */
    }
    const lineage = resumeSessionLineageLabel(s);
    // WI-41663: pass sessionId:null so the whole home is scanned — a row's
    // recorded id drifts from the running thread after a carry-respawn, and the
    // question the picker is asking is "is this session live", not "is that exact
    // uuid live".
    let liveWriter = null;
    if (s.agent === "codex" && procLocksSnapshot !== null) {
      try {
        const holder = codexThreadWriterHolder(codexResumeHome(s), null, {
          readProcLocks: () => procLocksSnapshot,
        });
        if (holder.held) liveWriter = holder.pid;
      } catch {
        /* label is a convenience, never a reason to fail the picker */
      }
    }
    // The age shown is LAST-ACTIVE, not started (WI-38226). `startedAt` is bumped to now() by
    // every reactivation, so it reads as "3m ago" for a session that resumed and then sat idle,
    // while a session that has been working for hours reads as the oldest thing in the list —
    // exactly inverted from what someone scanning for "the one I was just in" needs. The server
    // orders by the same key it hands back here, so the ages now descend down the list.
    return {
      name:
        `${s.id != null ? `#${s.id}  ·  ` : ""}${s.agent}${lastModel ? ` (${lastModel})` : ""}  ·  ${s.planSlug ? `plan ${s.planSlug}` : "no plan"}  ·  ${s.cwd}  ·  ${fmtAge(s.lastActiveAt || s.startedAt)}` +
        `${lineage ? `  · ${lineage}` : ""}${s.endedAt ? "" : "  · active"}` +
        `${liveWriter ? `  · ⚠ LIVE WRITER (pid ${liveWriter}) — resume needs --fork` : ""}`,
      value: s,
    };
  });
  const picked = await search({
    message: "Resume which session?",
    source: async (term) => filterRows(rows, term),
  });
  // An archived (off-disk) pick has NO on-disk transcript — claude/codex --resume
  // would fail "No conversation found". Restore it from the DB archive first, the
  // same way the explicit `--resume=<id>` path does. Only when the on-disk copy is
  // actually absent (a live/on-disk session skips this); best-effort — launchResume
  // still surfaces a real miss.
  if (!sessionHasTranscript(picked)) {
    await tryRematerializeFromArchive(picked.sessionId, picked.agent);
  }
  await launchResolvedResume(picked, args, { tracked: true });
}

// `psu --brain` was retired 2026-06-21. Keep a hard CLI tombstone so old
// scripts fail clearly instead of accidentally launching a normal SU session.
async function brainFlow(args = {}) {
  console.error(BRAIN_TOMBSTONE_MESSAGE);
  process.exitCode = 2;
}

/** Require the signed role-scoped MCP config produced by bootstrap-role.
 * OMP's per-session config copies these exact bytes; passing an omitted field
 * directly to readFileSync turns a server/client contract mismatch into the
 * opaque Node error "The path argument must be of type string". */
export function requireOmpRoleMcpJsonPath(res) {
  const configPath = res?.mcpJsonPath;
  if (typeof configPath !== "string" || configPath.length === 0) {
    const agent = typeof res?.agent === "string" ? res.agent : "unknown";
    const role = typeof res?.role === "string" ? res.role : "unknown";
    throw new Error(
      `psu: bootstrap-role omitted the signed MCP config path for ${agent} role '${role}'; ` +
        "refusing to launch without the role-scoped MCP config",
    );
  }
  return configPath;
}

// `psu --role=<role>` (or picking a non-su role): an interactive,
// role-scoped session — role persona + tools + feature context, human at
// the keyboard. Goes through bootstrap-role + execs the raw backend with
// the role prompt + signed role-scoped .mcp.json (NOT a *-su wrapper).
export function requestedRoleModelFromBootstrap(res, requestedModel) {
  return res.agent === "omp"
    ? res.envelopeEnv?.PAPERCUSP_OMP_MODEL_SELECTOR || res.model || requestedModel
    : res.model || requestedModel;
}

async function roleFlow(args, role, rolesMeta) {
  const consumes = (rolesMeta || []).find((r) => r.id === role)?.consumes ?? {
    feature: "none",
    plan: "none",
  };
  let agent, workspace, harness, feature, plan, account;
  if (args.picker) {
    agent = args.agent || (await pickRoleBackend());
    workspace = args.workspace || (await pickWorkspace());
    // named-su-agent-fleets P-006: fleet selection IMMEDIATELY before the account
    // pin (same as the SU flow). A new name → leader; an existing fleet → member.
    if (!args.fleet) {
      const f = await pickFleet(workspace);
      args.fleet = f.slug;
      args.fleetRole = f.role;
      args.fleetName = f.name;
      args.fleetScheme = f.scheme;
    }
    account = args.account || (await pickAccount(workspace, agent));
    harness = args.harness || (await pickHarnessRequired(workspace));
    if (args.feature) feature = args.feature;
    else if (consumes.feature === "none") feature = null;
    else feature = await pickFeature(workspace, harness, consumes.feature);
    // Plan context for plan-consuming roles (scoper/reviewer). --plan/--no-plan
    // preselect; otherwise offer the plan picker (it has a "NO PLAN" row).
    if (args.noPlan) plan = null;
    else if (args.plan) plan = args.plan;
    else if (consumes.plan === "none") plan = null;
    else plan = planValue(await pickPlan(workspace, harness));
  } else {
    if (agentInvalidForRole(args.agent)) {
      throw new Error(
        "--agent must be claude, omp, or codex for a role session",
      );
    }
    agent = args.agent;
    workspace = args.workspace || null;
    account = args.account || null;
    // No --harness = a WORKSPACE-LEVEL role session (owner-confirmed,
    // hive-agent-tabs P-003: operator/planner launch harness-less — the SU
    // model). bootstrap-role still 400s a feature-consuming role without one.
    harness = args.harness || null;
    feature = args.feature || null;
    plan = args.noPlan ? null : args.plan || null;
  }

  // Backend-not-installed → offer to install it before we spawn (owner req
  // 2026-07-06), same as the SU flow. Aborts if the user declines / it doesn't land.
  if (!(await ensureBackendInstalled(agent))) process.exit(1);
  if (!(await preflightCodexAutoPool({ agent, model: args.model, account })))
    process.exit(WALLED_POOL_REFUSAL_EXIT);

  const res = await api("/api/agent-mcp/console/bootstrap-role", {
    method: "POST",
    body: JSON.stringify(
      roleBootstrapBody({
        role,
        agent,
        ownerId: args.ownerId,
        workspace,
        harness,
        feature,
        plan,
        account,
        model: args.model,
        modelSource: args.modelSource,
        headless: args.headless,
        fleet: args.fleet,
        fleetRole: args.fleetRole,
        fleetName: args.fleetName,
        fleetScheme: args.fleetScheme,
        stack: args.stack,
      }),
    ),
  });
  // WI-1408 (fleet-join-startup-assertion): a requested fleet must have actually
  // registered — see assertFleetJoined's doc comment.
  assertFleetJoined(args.fleet || args.fleetName, res);

  // omp role sessions load the coordination extension (lock enforcement + coord +
  // the activity-bridge port) via -e, the same stable module the su omp launch +
  // resume use. claude/codex role hooks are user-level / baked into the codex home.
  const roleCoordExt = join(homedir(), ".papercusp", "papercusp-coord.ts");
  const roleCoordExtPath =
    res.agent === "omp" && existsSync(roleCoordExt) ? roleCoordExt : undefined;
  const requestedRoleModel = requestedRoleModelFromBootstrap(res, args.model);
  const roleModel =
    res.agent === "omp"
      ? normalizeOmpModelSpec(requestedRoleModel)
      : requestedRoleModel;
  const roleModelNotice =
    res.agent === "omp"
      ? ompModelCompatibilityNotice(requestedRoleModel)
      : null;
  if (roleModelNotice) console.error(roleModelNotice);
  // Launch preflight (context-trimming-tiers P-016/P-018): persona-append
  // assertion + window guard — fail loud BEFORE spawning a doomed session.
  try {
    runLaunchPreflight({
      promptFile: res.promptFile,
      contextSize: args.contextSize,
      model: requestedRoleModel,
      agent: res.agent,
      budget: res.contextBudget,
      force: args.force,
    });
  } catch (e) {
    console.error(e?.message ?? String(e));
    process.exit(1);
  }
  const { bin, args: launchArgs } = roleLaunchArgs(res.agent, {
    promptFile: res.promptFile,
    mcpJsonPath: res.mcpJsonPath,
    coordExtPath: roleCoordExtPath,
    injectHookPath: resolveOmpInjectHookPath(res.agent),
    // Force the native session id the spec minted (claude only) so the session's
    // conversation id is known up-front and wake-executor can `--resume <uuid>`
    // EXACTLY it — never `--continue`'s most-recent-in-cwd peer on the shared
    // tree (unify-launch-mechanics P-003 invariant d).
    nativeSessionId: res.envelopeEnv?.PAPERCUSP_NATIVE_SESSION_ID || null,
    // Subagent-launch deny is DEFAULT-ON; `--allow-subagents` (or the picker) opts in.
    allowSubagents: args.allowSubagents,
    // P-021/D-013: may this omp session KEEP its native `lsp` builtin? bootstrap-role
    // resolves FLAGS.OMP_NATIVE_LSP_BUILTIN *and* the local-model tier gate
    // server-side and threads the answer here. Absent ⇒ strip, byte-identical to
    // the pre-P-021 behavior. See ompLspArgs.
    allowNativeLsp: res.envelopeEnv?.PAPERCUSP_OMP_NATIVE_LSP === "1",
    // P-019/D-007: thread --model into the role launch argv (claude branch splits
    // effort via modelArgsFor). Without this the spec was env-only (PAPERCUSP_MODEL,
    // title hooks) and the session ran the saved default model.
    model: roleModel,
  });
  if (args.addDir?.length && res.agent === "omp") {
    console.error(
      "psu: omp has no --add-dir; ignoring it. Pass a backend flag verbatim with `-- <flag>` if omp supports one.",
    );
  }
  // First-class --add-dir (claude/codex) + generic `--` passthrough, followed by
  // the scripted first turn as the final positional argument. Fresh SU launches
  // already use this kickoff seam; roles must too because acceptance graders are
  // fresh headless role sessions and have no human to submit an empty prompt.
  const {
    args: roleArgs,
    kickoff: roleKickoff,
    kickoffSeeded: roleKickoffSeeded,
  } = finalizeFreshRoleArgs(res.agent, launchArgs, res, args);
  let roleOmpConfigDir = null;
  if (res.agent === "omp") {
    roleOmpConfigDir = await writeOmpSessionConfigDirAsync(res.sessionId, {
      discoveryOff: true,
      model: roleModel,
      modelsYml: res.envelopeEnv.PAPERCUSP_OMP_MODELS_YML,
      mcpJsonContents: readFileSync(requireOmpRoleMcpJsonPath(res), "utf8"),
      clientId: res.envelopeEnv?.PAPERCUSP_SID || null,
      env: { ...process.env, ...res.envelopeEnv },
      interactive: !!process.stdout.isTTY,
    });
    if (!roleOmpConfigDir) {
      throw new Error(
        "psu: could not materialize the selected OMP account route; refusing direct/default fallback",
      );
    }
  }
  console.error(
    `psu: ${res.role} on ${res.agent}  ·  ${res.feature ? `feature ${res.feature}` : res.planSlug ? `plan ${res.planSlug}` : "no feature"}` +
      `  ·  ${res.harnessSlug ? `harness ${res.harnessSlug}` : "workspace-level (no harness)"}  ·  session ${res.sessionId ?? "?"}`,
  );
  if (res.accountNotice) console.error(`psu: ${res.accountNotice}`);
  {
    const subagentRisk = subagentGatewayRiskNotice(
      res.agent,
      args.allowSubagents,
      res.envelopeEnv,
    );
    if (subagentRisk) console.error(subagentRisk);
  }
  console.error(
    `psu: cwd ${res.cwd}  —  role-scoped MCP (${res.role}); resume from here`,
  );
  if (roleKickoffSeeded) {
    console.error(
      `psu: kickoff — seeding the role session's first turn (suppress with --no-kickoff)`,
    );
  }
  // Role sessions are AGENT sessions across all backends: the marker arms the
  // hook-level scheduler guard (bash gate / omp coord-hook / codex hooks.json)
  // (native-scheduler-lockout P-010).
  runWrapper({
    wrapperBin: bin,
    args: roleArgs,
    cwd: res.cwd,
    kickoff: roleKickoff,
    // PAPERCUSP_MODEL: the launch model spec, exported so the codex/omp title hook can
    // render the model in the terminal title (WI-1963 title-parity — those CLIs have no
    // live model object like Claude's statusline stdin). Omitted when no --model (default).
    envelopeEnv: {
      ...res.envelopeEnv,
      ...ompResponsesCompatibilityEnv(res.agent, roleModel, {
        ...process.env,
        ...res.envelopeEnv,
      }),
      ...(roleOmpConfigDir
        ? {
            PI_CONFIG_DIR: roleOmpConfigDir,
            PI_CODING_AGENT_DIR: join(homedir(), roleOmpConfigDir, "agent"),
          }
        : {}),
      PAPERCUSP_AGENT_SESSION: "1",
      ...(roleModel ? { PAPERCUSP_MODEL: roleModel } : {}),
      // WI-2140943 lane 2 (2026-09-02): role sessions owe the SAME trio as launchFreshSu.
      // This was the last uncovered spawn path — buildResumeEnv, trackedForkEnvelopeEnv and
      // launchFreshSu all stamp it, and runWrapper's healContextTrimmingEnv only fires on the
      // hostHandoff branch, so a role session got none of it. A role session is how a system
      // routine launches an agent (`--launched-by=system:…`), and without ENABLE_TOOL_SEARCH
      // claude inlines every advertised schema on a gateway-routed launch: measured 753,066
      // boot tokens on the consult-expiry-sweep session (su-a961ddec) vs 94–150k fleet-wide.
      ...contextTrimmingEnv(res.agent),
      // P-022: native auto-compact is retired — every Claude launch runs with
      // DISABLE_AUTO_COMPACT; the carry-respawn ladder owns the boundary.
      ...nativeCompactionEnv(res.agent),
      // Keep the CLI off the terminal's alternate screen so its epoch survives the
      // cut in the console (terminalRenderEnv).
      ...terminalRenderEnv(res.agent),
    },
  });
}

/** True when an --agent value can't back a role session (claude/omp/codex can). */
export function agentInvalidForRole(agent) {
  return agent !== "claude" && agent !== "omp" && agent !== "codex";
}

/**
 * One-time setup: persist the default-account Claude OAuth token so every
 * default-account claude psu session inherits the single CLI login on EVERY OS
 * (the macOS keychain-per-config-dir trap can't be healed by file inheritance —
 * see claudeOAuthTokenPath). `inline` is the scripting form; otherwise we guide
 * the user through `claude setup-token` and read a pasted token.
 */
async function setClaudeTokenFlow(inline) {
  let token = (inline || "").trim() || null;
  if (!token) {
    console.error(
      "psu: store the default-account Claude login for psu sessions (works on macOS too).",
    );
    console.error("psu:   1) in a normal terminal run:   claude setup-token");
    console.error(
      "psu:   2) copy the printed token (starts with sk-ant-oat01-…)",
    );
    console.error("psu:   3) paste it below.");
    const { input } = await import("@inquirer/prompts");
    token =
      (
        (await input({ message: "Paste the `claude setup-token` output:" })) ||
        ""
      ).trim() || null;
  }
  if (!token) {
    console.error("psu: no token provided — nothing saved.");
    process.exit(2);
  }
  if (!/^sk-ant-/.test(token)) {
    console.error(
      `psu: warning — that doesn't look like a setup-token (expected sk-ant-oat01-…); saving anyway.`,
    );
  }
  const p = storeClaudeOAuthToken(token);
  console.error(
    `psu: saved → ${p} (0600). Default-account claude psu sessions now inherit this login.`,
  );
}

/** Remove the stored default-account Claude OAuth token (revert to keychain/file login). */
function clearClaudeTokenFlow() {
  const p = claudeOAuthTokenPath();
  if (existsSync(p)) {
    rmSync(p, { force: true });
    console.error(
      `psu: removed ${p}. Default-account claude reverts to the keychain/file login.`,
    );
  } else {
    console.error("psu: no stored Claude OAuth token to clear.");
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Backend-not-installed → offer to install it (owner req 2026-07-06). If the
// chosen agent CLI (claude / codex / omp) isn't present, psu prompts and runs the
// SAME installer the setup CLI uses (/api/desktop/setup-pty-commands →
// installFramework[agent]), then re-detects — so `psu --agent=omp` on a machine
// without omp installs it in place instead of ENOENT-ing on the bare-name spawn.
// ───────────────────────────────────────────────────────────────────────────

export const AGENT_LABELS = {
  claude: "Claude Code",
  codex: "Codex (OpenAI)",
  omp: "oh-my-pi (omp)",
};

/** which/where <bin> → absolute path or null — the exact gate for psu's bare-name
 *  spawn (runWrapper execs `claude`/`codex`/`omp` off PATH). Pure-ish; exported. */
export function whichBin(bin, { platform = process.platform } = {}) {
  try {
    const cmd = platform === "win32" ? "where" : "which";
    const r = spawnSync(cmd, [bin], { encoding: "utf8", timeout: 4_000 });
    const out = String(r.stdout ?? "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    return r.status === 0 && out ? out : null;
  } catch {
    return null;
  }
}

/**
 * Well-known install locations per backend — for a bin the setup flow just
 * installed that PATH hasn't picked up yet, or (the WI-37920 case) a bin PATH
 * will NEVER pick up because this process is a login-but-non-interactive shell
 * spawned by a desktop terminal. Abs path or null. Exported for tests.
 *
 * The LIST itself lives in `packages/operator-core/lib/backend-bin-resolve.mjs`,
 * shared with the operator-side PATH injection (console-launcher). Two copies
 * would drift in the worst direction: detection succeeds here while the operator
 * injects a different (or no) dir, so the window still cannot execute the bin —
 * and it only reproduces inside a desktop terminal. Same one-definition reasoning
 * as `su-tier-roles.mjs`.
 */
export function wellKnownBackendBin(agent, opts = {}) {
  // ⚠ FORWARD THE OPTIONS OBJECT — do NOT re-destructure and rebuild it.
  //
  // This wrapper used to read `{ home = homedir(), env = process.env }` and pass
  // `{ home, env }`, which SILENTLY DROPPED every other option. `platform` was
  // the casualty: a caller asking for win32 got process.platform instead, so the
  // %USERPROFILE% branch could never run and the Windows case returned null. It
  // reds a test that looks like it is about Windows paths while the actual defect
  // is one line of destructuring here (caught 2026-08-11 by su-1f60f82c).
  //
  // The general shape, worth recognising anywhere: a pass-through wrapper that
  // re-destructures its options is an arg-dropping footgun — the option is
  // accepted by the signature, ignored in the body, and NOTHING errors. Defaults
  // belong downstream (backendSearchDirs already applies home/env/platform), so
  // forwarding whole is both simpler and the only correct form.
  return sharedWellKnownBackendBin(agent, opts);
}

/** Detect a backend bin: PATH first, then well-known. `{ path, onPath } | null`. */
export function detectBackendBin(agent) {
  const onPath = whichBin(agent);
  if (onPath) return { path: onPath, onPath: true };
  const wk = wellKnownBackendBin(agent);
  return wk ? { path: wk, onPath: false } : null;
}

/** Prepend a bin's dir to THIS process's PATH so the bare-name launch (runWrapper
 *  inherits process.env) resolves a just-installed backend not yet on PATH.
 *
 *  WI-37920: ALSO prepend the dir of the bin's shebang INTERPRETER. `omp` ships as
 *  `#!/usr/bin/env bun`, so making `omp` resolvable is worthless if `bun` is not —
 *  the exec succeeds at the kernel layer and dies in `env`. Detection-only fixes
 *  pass their tests and still leave a dead window; this is the execution half. */
function ensureDirOnPath(binPath) {
  const dirs = [dirname(binPath)];
  try {
    const interpreter = readShebangInterpreter(binPath);
    if (interpreter) {
      const resolved =
        resolveOnPath(interpreter) ?? resolveInWellKnownDirs(interpreter);
      if (resolved) dirs.push(dirname(resolved));
    }
  } catch {
    /* a shebang we cannot read is not a reason to skip the bin's own dir */
  }
  for (const dir of dirs) {
    const parts = String(process.env.PATH ?? "").split(delimiter);
    if (!parts.includes(dir))
      process.env.PATH = dir + delimiter + (process.env.PATH ?? "");
  }
}

/** Spawn an installer SpawnSpec inheriting this terminal (installs are interactive). */
function runInstallerInherit(spec) {
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd || process.cwd(),
      env: { ...sanitizeInheritedEnv(process.env), ...(spec.env ?? {}) },
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

/**
 * Ensure the chosen backend CLI is installed before we launch it. Returns true when
 * it's usable (already present, or installed here + made resolvable), false when the
 * user declined or it didn't land — the caller then aborts the launch. Non-interactive
 * (scripted / non-TTY) launches never prompt; they fail with guidance instead.
 */
async function ensureBackendInstalled(
  agent,
  { interactive = Boolean(process.stdout.isTTY) } = {},
) {
  const present = detectBackendBin(agent);
  if (present) {
    if (!present.onPath) ensureDirOnPath(present.path);
    return true;
  }
  const label = AGENT_LABELS[agent] ?? agent;
  console.error(`psu: the ${label} backend (\`${agent}\`) is not installed.`);
  if (!interactive) {
    console.error(
      "psu: install it with `papercusp setup` (or run psu interactively to be prompted), then re-run.",
    );
    return false;
  }
  const { confirm } = await import("@inquirer/prompts");
  const wants = await confirm({
    message: `The ${label} AI backend isn't installed. Install it now?`,
    default: true,
  });
  if (!wants) {
    console.error(
      `psu: skipped. Install ${label} yourself or run \`papercusp setup\`, then re-run psu.`,
    );
    return false;
  }
  let cmds;
  try {
    cmds = await api("/api/desktop/setup-pty-commands");
  } catch (e) {
    console.error(
      `psu: couldn't fetch the installer (${e?.message ?? e}). Finish setup with \`papercusp setup\`.`,
    );
    return false;
  }
  const spec = cmds?.installFramework?.[agent];
  if (!spec?.command) {
    console.error(
      `psu: no installer available for ${label} on this platform. Install it manually` +
        (agent === "omp" ? " (see https://github.com/can1357/oh-my-pi)" : "") +
        ", then re-run psu.",
    );
    return false;
  }
  console.error(`psu: installing ${label} — streaming the installer here…`);
  const code = await runInstallerInherit(spec);
  if (code !== 0)
    console.error(`psu: the installer exited ${code}; re-checking anyway.`);
  const after = detectBackendBin(agent);
  if (!after) {
    console.error(
      `psu: ${label} still isn't detected. Open a new terminal (so PATH refreshes) and re-run psu, or finish setup with \`papercusp setup\`.`,
    );
    return false;
  }
  if (!after.onPath) {
    ensureDirOnPath(after.path);
    console.error(
      `psu: using ${after.path} (added its dir to PATH for this launch; restart your shell to make it permanent).`,
    );
  }
  console.error(`psu: ${label} is ready. ✓`);
  return true;
}

/**
 * Continue a host-code handoff without running bootstrap-su a second time.
 * The shim re-executes this launcher with its original argv, but the original
 * bootstrap result (adv row, Codex home, and route identity) was only held in
 * the predecessor process. Consuming the handoff before the normal launch
 * flow keeps the successor on that exact row/home instead of minting a sibling.
 */
async function launchHostHandoff(handoff) {
  const childEnv =
    handoff?.childEnv &&
    typeof handoff.childEnv === "object" &&
    !Array.isArray(handoff.childEnv)
      ? stripRecoveryMarkers(handoff.childEnv)
      : {};
  if (handoff?.ownerId) childEnv.PAPERCUSP_SID = String(handoff.ownerId);
  if (handoff?.agent) childEnv.PAPERCUSP_AGENT = String(handoff.agent);
  if (handoff?.advSessionId != null)
    childEnv.PAPERCUSP_ADV_SESSION_ID = String(handoff.advSessionId);
  if (handoff?.codexHome) childEnv.CODEX_HOME = String(handoff.codexHome);
  if (
    !childEnv.PAPERCUSP_SID ||
    typeof handoff?.command !== "string" ||
    !handoff.command
  ) {
    console.error(
      "psu: host handoff is missing its session identity or backend command; refusing a bare successor",
    );
    process.exitCode = 1;
    return;
  }
  runWrapper({
    wrapperBin: handoff.command,
    args: Array.isArray(handoff.args) ? handoff.args : [],
    cwd:
      typeof handoff.cwd === "string" && handoff.cwd
        ? handoff.cwd
        : process.cwd(),
    preserveCwd: true,
    envelopeEnv: childEnv,
    hostHandoff: handoff,
  });
}

function psuClientVersion() {
  if (process.env.PAPERCUSP_BUILD_ID) return String(process.env.PAPERCUSP_BUILD_ID);
  // Release bundles carry a minimal adjacent manifest; the source launcher is
  // under scripts/ and reads the operator package one directory above it.
  for (const relative of ["./package.json", "../package.json"]) {
    try {
      const manifest = JSON.parse(
        readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8"),
      );
      if (typeof manifest.version === "string" && manifest.version) return manifest.version;
    } catch {
      // Try the other supported layout before reporting an unknown protocol.
    }
  }
  return "unknown";
}

async function recoveryFlow(args, { rawArgv = [] } = {}) {
  if (!args.recoveryAuthorize && !args.recoveryGrant) return false;
  validateRecoveryCliArgv(rawArgv);
  if (args.recoveryAuthorize && args.recoveryGrant)
    throw new Error("--recovery-authorize and --recovery-grant are mutually exclusive");
  if (
    args.resume ||
    args.fork ||
    args.brain ||
    args.agent ||
    args.role ||
    args.workspace ||
    args.harness ||
    args.plan ||
    args.fleet ||
    args.auto != null ||
    args.mode
  ) {
    throw new Error("native recovery flags cannot be combined with an agent launch, resume, fleet, plan, or mode");
  }
  const terminalId = resolveOwnedTtyPath();
  if (!terminalId)
    throw new Error("native recovery requires a real local terminal");
  const eligibility = recoveryAuthorizationEligibility({
    env: process.env,
    ancestorCmdlines: readRecoveryAncestorCmdlines(),
  });
  if (!eligibility.ok) {
    throw new Error(
      `native recovery refused (${eligibility.reason}); use a direct local owner terminal, never an agent session`,
    );
  }

  if (args.recoveryAuthorize) {
    if (!args.recoveryReason?.trim())
      throw new Error("--recovery-authorize requires --recovery-reason=<why>");
    if (!Array.isArray(args.passthrough) || args.passthrough.length === 0)
      throw new Error("--recovery-authorize requires an exact argv after `--`");
    const ttlMs = args.recoveryTtlMs ?? 5 * 60_000;
    const maxRuntimeMs = args.recoveryMaxRuntimeMs ?? 60_000;
    const preview = [
      "PAPERCUSP NATIVE RECOVERY AUTHORIZATION",
      "This bypasses the operator/MCP control plane for one exact diagnostic command.",
      `Command argv: ${JSON.stringify(args.passthrough)}`,
      `Cwd: ${process.cwd()}`,
      `Reason: ${args.recoveryReason.trim()}`,
      `Grant ttl: ${ttlMs}ms · command deadline: ${maxRuntimeMs}ms · uses: 1`,
      "The signed grant is bound to this terminal and audited outside the repository.",
    ].join("\n");
    console.error(preview);
    const { confirm } = await import("@inquirer/prompts");
    const approved = await confirm({
      message: "Authorize this exact one-use native recovery command?",
      default: false,
    });
    if (!approved) {
      console.error("psu: recovery authorization cancelled; no grant was created.");
      return true;
    }
    const grant = issueRecoveryGrant(
      {
        capability: RECOVERY_CAPABILITY_DIAGNOSTIC,
        argv: args.passthrough,
        cwd: process.cwd(),
        reason: args.recoveryReason,
        ttlMs,
        maxRuntimeMs,
      },
      {
        token: readToken(),
        terminalId,
        clientVersion: psuClientVersion(),
      },
    );
    console.error(
      `psu: recovery grant ${grant.grantId} authorized for one use; expires ${new Date(grant.expiresAtMs).toISOString()}.`,
    );
    console.error(`psu: execute it from this terminal with: psu --recovery-grant=${grant.grantId}`);
    return true;
  }

  if (args.passthrough?.length)
    throw new Error("--recovery-grant executes only the signed argv; additional `--` arguments are refused");
  const result = await runRecoveryGrant(args.recoveryGrant, {
    token: readToken(),
    terminalId,
    clientVersion: psuClientVersion(),
  });
  if (!result.ok) {
    console.error(`psu: recovery grant refused: ${result.reason}`);
    process.exitCode = 1;
  } else if (result.timedOut) {
    console.error(`psu: recovery command exceeded its ${result.grant.maxRuntimeMs}ms deadline.`);
    process.exitCode = 124;
  } else if (result.error) {
    console.error(`psu: recovery command failed to start: ${result.error}`);
    process.exitCode = 1;
  } else if (result.signal) {
    console.error(`psu: recovery command ended by ${result.signal}.`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.exitCode ?? 1;
  }
  return true;
}

async function reconcileRecoveryAuditSoft() {
  try {
    const result = await reconcileRecoveryAudit({
      send: (events) =>
        api("/api/agent-mcp/recovery-audit/reconcile", {
          method: "POST",
          body: JSON.stringify({ events }),
        }),
    });
    if (result.reconciled > 0) {
      console.error(
        `psu: reconciled ${result.reconciled} local recovery audit event(s) into the operator audit log.`,
      );
    }
  } catch (error) {
    console.error(
      `psu: recovery audit is still pending local reconciliation (${error?.message ?? error}); launch continues.`,
    );
  }
}

async function main() {
  // Recovery is the no-control-plane path. Detect its dedicated flags before
  // even the connection front controller: a remote-profile lookup or transport
  // bootstrap must not become an accidental prerequisite during an outage.
  const rawArgv = process.argv.slice(2);
  if (rawArgv.includes("--version") || rawArgv.includes("-V")) {
    const versionArgs = parseArgs(rawArgv);
    if (versionArgs.version) {
      process.stdout.write(`psu ${psuClientVersion()}\n`);
      return;
    }
  }
  if (hasRecoveryCliFlag(rawArgv)) {
    const recoveryArgs = parseArgs(rawArgv);
    if (await recoveryFlow(recoveryArgs, { rawArgv })) return;
  }
  const connection = await runPsuConnectionFrontController(
    rawArgv,
  );
  if (connection.handled) {
    process.exitCode = connection.exitCode ?? 0;
    return;
  }
  const args = parseArgs(connection.argv);
  // `--help` is intentionally handled before every other flow: it must not
  // prompt, read credentials, contact the operator, or create a session.
  if (args.help) {
    process.stdout.write(`${PSU_HELP_TEXT}\n`);
    return;
  }
  if (args.version) {
    process.stdout.write(`psu ${psuClientVersion()}\n`);
    return;
  }
  if (await recoveryFlow(args, { rawArgv: connection.argv })) return;
  // A host-code adoption handoff is consumed BEFORE any normal fresh/resume
  // flow. Re-running bootstrap-su here would select or mint another adv row
  // while the handoff's already-minted child belongs to the predecessor row.
  if (args.headless) process.env.PAPERCUSP_PSU_HEADLESS = "1";
  const hostHandoff =
    reexecExitCodeFrom(process.env) != null
      ? readHostHandoffForParentPid(process.ppid)
      : null;
  if (hostHandoff) {
    await launchHostHandoff(hostHandoff);
    return;
  }
  // WI-37841 — FIRST, before any flow can fail. A launch carrying a PRE-PINNED
  // owner id was started programmatically (launch-su's "+ New session"), so
  // nobody is watching its window and every diagnostic it prints from here on is
  // otherwise lost the moment it exits. Tee them to this launch's boot log so
  // the failure banner can name a cause instead of "the terminal closed".
  // Never throws and returns null on any trouble — a diagnostic side-channel
  // must not be able to fail the launch it is diagnosing.
  if (args.ownerId) installBootLogCapture(args.ownerId);
  // headless-fleet-launch P-001: publish the headless posture into the env BEFORE any
  // launch flow. runWrapper builds its child env from sanitizeInheritedEnv(process.env)
  // (which preserves PAPERCUSP_*), so this single assignment is what (a) makes
  // usePtyHost({ env }) keep the managed pty despite no TTY, and (b) hands the posture
  // down to the agent child. `--headless` is the CLI face of PAPERCUSP_PSU_HEADLESS=1;
  // setting the env var directly (a headless spawner) works identically.
  // One-time credential maintenance commands run before any launch flow.
  if (args.setClaudeToken) {
    await setClaudeTokenFlow(args.setClaudeTokenValue);
    return;
  }
  if (args.clearClaudeToken) {
    clearClaudeTokenFlow();
    return;
  }
  await reconcileRecoveryAuditSoft();
  // --fork only has meaning when resuming an existing session — warn (don't fail)
  // so a stray `psu --fork` on a fresh launch doesn't silently look honored.
  if (args.fork && !args.resume) {
    console.error(
      "psu: --fork only applies with --resume (it branches an existing session); ignoring it for this fresh launch.",
    );
  }
  if (args.brain) {
    await brainFlow(args);
    return;
  }
  if (args.resume) {
    await resumeFlow(args);
    return;
  }

  // Resolve the role first: flag wins; else pick (picker mode); else 'su'.
  let role = args.role || null;
  let rolesMeta = null;
  if (!role && args.picker) {
    const picked = await pickRole();
    role = picked.role;
    rolesMeta = picked.roles;
  }
  if (!role) role = "su";
  // Subagent-launch toggle (owner mandate 2026-07-02): DENIED BY DEFAULT; the picker
  // offers an explicit opt-IN for this interactive launch (su OR role). A
  // --allow-subagents / --no-subagents flag preselects + skips it. Runs before the
  // su/role branch so BOTH paths carry args.allowSubagents into their launch args.
  if (args.picker && args.allowSubagents == null)
    args.allowSubagents = await pickSubagents();
  // EI-996 (owner ask 2026-06-17: planners should "be full su agents and get the
  // full su prompt, but just a few lines added about their planner role"): a
  // SU-TIER role skips roleFlow entirely and falls through to the plain SU flow
  // below, carrying its role NAME as `su_role`. The server appends that role's
  // addendum to the engineer playbook and the session keeps the SUPERUSER MCP
  // tier — the "full su agent" half of the ask, which the role bootstrap cannot
  // give (renderSuPlaybook needs the su path's `agent`).
  //
  // ⚠ This GRANTS THE SUPERUSER TIER to the roles listed here — a deliberate,
  // owner-authorized privilege escalation, not an incidental side effect. Adding
  // a role to SU_TIER_ROLES is a security decision; make it consciously.
  if (!launchesOnSuTier(role)) {
    await roleFlow(args, role, rolesMeta);
    return;
  }
  // Reached with role === 'su' (su_role null) or a su-tier role name.
  args.suRole = suRoleFor(role);

  // ── plain SU / engineer flow (unchanged) ──
  let selections;
  if (args.picker) {
    // Honor any flags as preselections; prompt only for what was omitted.
    const p = presetsFromArgs(args);
    const agent = p.needAgent ? await pickAgent({ tui: args.tui }) : p.agent;
    if (agent === "pui") {
      process.exitCode = launchPuiWorkbench();
      return;
    }
    // su-context-size-variants: 'trimmed' is the only live context size, so there is
    // nothing left to prompt for — assign it directly rather than opening a
    // single-choice picker. A --context-size= flag has already set args.contextSize by
    // here (parseArgs normalizes the retired 'full' down to 'trimmed'), so this only
    // fills the unflagged case.
    if (!args.contextSize) args.contextSize = SU_CONTEXT_SIZE;
    const workspace = p.needWorkspace ? await pickWorkspace() : p.workspace;
    const harness = p.needHarness ? await pickHarness(workspace) : p.harness;
    if (!args.stack?.length && role === "su") {
      const identity = await pickIdentity(workspace, harness);
      args.stack = identity.stack;
      args.selectedIdentityRevision = identity.selectedIdentityRevision;
    }
    const plan = p.needPlan
      ? planValue(await pickPlan(workspace, harness))
      : p.plan;
    // named-su-agent-fleets P-006: choose a named fleet (or none) IMMEDIATELY
    // before the account pin, mirroring it. A new name → this agent leads the
    // fresh fleet; an existing fleet → member. `--fleet=<slug>` preselects + skips.
    if (!args.fleet) {
      const f = await pickFleet(workspace);
      args.fleet = f.slug;
      args.fleetRole = f.role;
      args.fleetName = f.name;
      args.fleetScheme = f.scheme;
    }
    // psu-account-chooser P-005: offer a pool-account pin when one is meaningful
    // (gateway on + a non-empty pool). Otherwise the picker still shows its one
    // row and returns the literal `system` (the machine's own login), which is
    // what the bootstrap POST then carries — an OMITTED account is not the same
    // request (it means "the nominated default account"; see accountPickerChoices).
    if (!args.account) args.account = await pickAccount(workspace, agent);
    selections = { agent, workspace, harness, plan };
  } else {
    selections = selectionsFromArgs(args);
  }

  // Backend-not-installed → offer to install it before we spawn (owner req
  // 2026-07-06). Aborts the launch if the user declines / it doesn't land.
  if (!(await ensureBackendInstalled(selections.agent))) process.exit(1);

  await launchFreshSu(selections, args);
}

/**
 * The pre-TUI "your setup isn't finished" nudge (owner batch #5). PURE: given the
 * concierge setup STAGE name, return the reminder lines to print, or null when there
 * is nothing to nudge — setup is complete (stage 'done') or the stage is unknown
 * (null, e.g. the operator was unreachable — never nag on a failed probe). Both
 * `papercusp setup` and `papercusp tutorial` reach the same place (the unified
 * onboarding shell), so the nudge names both.
 */
export function setupReminderLines(stage) {
  if (!stage || stage === "done") return null;
  return [
    "",
    "ⓘ  Heads up — your Papercusp setup isn’t finished yet, so some functionality stays locked.",
    "   Finish it any time:  `papercusp setup`  or  `papercusp tutorial`  (both open the same place).",
    "",
  ];
}

/**
 * Best-effort read of the concierge setup stage from the LIVE operator. Returns the
 * stage NAME (e.g. 'pick' | 'install' | 'login' | 'embeddings' | 'handoff' | 'done'),
 * or null on ANY error/timeout so a slow or unreachable operator never delays or breaks
 * the TUI launch. The operator is already known-reachable at the one call site
 * (bootstrap-su just succeeded), so this normally returns in tens of ms; the timeout is
 * only a safety net. Note the endpoint returns `stage` as an OBJECT ({ stage: 'done' }),
 * so the stage NAME is `body.stage.stage`.
 */
async function fetchSetupStageSoft({
  fetchImpl = fetch,
  operatorUrl = OPERATOR_URL,
  timeoutMs = 1500,
} = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(operatorUrl + "/api/desktop/onboarding-status", {
      signal: ac.signal,
    });
    if (!r?.ok) return null;
    const j = await r.json();
    const name = j?.stage?.stage;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST bootstrap-su + exec the raw backend — the fresh-SU launch tail shared
 * by the plain `psu` flow. The retired `psu --brain` path is rejected before
 * it reaches this launcher.
 */
/** Preserve ordinary fresh-launch exit semantics, but turn a session-port
 * preflight refusal into an exception so launchSessionPort can finalize the
 * already-prepared row before the process exits. */
export function sessionPortLaunchAbortError(args, failure, stage) {
  if (!args?.sessionPortToken) return null;
  const cause =
    failure instanceof Error ? failure : new Error(String(failure ?? "unknown failure"));
  return new Error(
    `session-port target ${stage} failed after preparation: ${cause.message}`,
    { cause },
  );
}

async function launchFreshSu(selections, args, { brain = false } = {}) {
  if (
    !(await preflightCodexAutoPool({
      agent: selections.agent,
      model: args.model,
      account: args.account,
    }))
  ) {
    const portFailure = sessionPortLaunchAbortError(
      args,
      "target account preflight refused the selected route",
      "account preflight",
    );
    if (portFailure) throw portFailure;
    process.exit(WALLED_POOL_REFUSAL_EXIT);
  }
  const bootstrapIdempotencyKey = args.bootstrapIdempotencyKey || randomUUID();
  if (
    selections.agent === "codex" &&
    accountRoutingMode(args.account) === "default"
  ) {
    const authSync = reconcileCodexSystemAuth();
    if (authSync.promoted)
      console.error(
        "psu: recovered the newest isolated Codex login as the persistent default system login.",
      );
  }
  const res = await api("/api/agent-mcp/console/bootstrap-su", {
    method: "POST",
    body: JSON.stringify(
      freshSuBootstrapBody(selections, args, {
        brain,
        bootstrapIdempotencyKey,
      }),
    ),
    // Only the key-bearing bootstrap request is replay-safe. api() strips this
    // internal option before calling fetch.
    retryBootstrapFailures: true,
  });
  // WI-1408 (fleet-join-startup-assertion): a requested fleet must have actually
  // registered — see assertFleetJoined's doc comment.
  assertFleetJoined(args.fleet || args.fleetName, res);

  // A fresh headless Codex process cannot complete an interactive sign-in. The
  // server-created home inherits the machine's default auth.json when it is
  // available, so check the exact home that the child will use before doing any
  // further launch setup or starting the managed PTY. Gateway-routed Codex
  // launches do not use this local credential and are intentionally skipped.
  const codexAuthPreflight = codexFreshDefaultAuthPreflight({
    agent: res.agent,
    headless: args.headless,
    account: args.account,
    codexHome: res.codexHome,
  });
  if (codexAuthPreflight.checked && !codexAuthPreflight.ready) {
    const message =
      "psu: refusing headless Codex launch on the default system account — " +
        `${codexAuthPreflight.reason}. ` +
        "Authenticate with `codex` first, or choose `--account=auto` / a Codex pool account; " +
        "a headless launch cannot complete an interactive sign-in.";
    console.error(message);
    const portFailure = sessionPortLaunchAbortError(
      args,
      message,
      "credential preflight",
    );
    if (portFailure) throw portFailure;
    process.exit(1);
  }

  // res.cwd is server-decided: the harness repo for a harness launch, or
  // our cwd (above) for a no-harness one. Agents scope resumable sessions
  // by cwd, so resume works from res.cwd.
  console.error(
    `psu: ${res.agent} (su${brain ? " · BRAIN pinned" : ""})  ·  ${res.planSlug ? `plan ${res.planSlug}` : "no plan"}  ·  session ${res.sessionId ?? "?"}`,
  );
  console.error(
    `psu: cwd ${res.cwd}  —  resume this session by running the agent's resume command from here`,
  );
  // psu-account-chooser: surface whether the `--account` pin took effect (or the
  // fail-soft reason it was skipped) so the user is never silently unpinned.
  if (res.accountNotice) console.error(`psu: account — ${res.accountNotice}`);
  {
    const subagentRisk = subagentGatewayRiskNotice(
      res.agent,
      args.allowSubagents,
      res.envelopeEnv,
    );
    if (subagentRisk) console.error(subagentRisk);
  }
  // named-su-agent-fleets P-006: surface the chosen fleet (leading a new one /
  // joining an existing one), or the fail-soft reason it was skipped.
  if (res.fleetNotice) console.error(`psu: fleet — ${res.fleetNotice}`);

  // P-020: exec the RAW backend (not a *-su wrapper) with the engineer
  // playbook (res.promptFile) + flags. MCP + lock hooks are user-level for
  // claude/omp (they survive a raw launch); codex runs in res.codexHome.
  // Launch preflight (context-trimming-tiers P-016/P-018): persona-append
  // assertion + window guard — fail loud BEFORE spawning a doomed session.
  try {
    runLaunchPreflight({
      promptFile: res.promptFile,
      contextSize: args.contextSize,
      model: args.model,
      agent: res.agent,
      budget: res.contextBudget,
      force: args.force,
    });
  } catch (e) {
    console.error(e?.message ?? String(e));
    const portFailure = sessionPortLaunchAbortError(
      args,
      e,
      "launch preflight",
    );
    if (portFailure) throw portFailure;
    process.exit(1);
  }
  const { bin, args: baseArgs } = suLaunchArgs(res.agent, {
    promptFile: res.promptFile,
    coordExtPath: res.coordExtPath,
    injectHookPath: resolveOmpInjectHookPath(res.agent),
    // Force the recorded native session id on a FRESH launch — but not when
    // this invocation is itself resuming one: claude rejects --session-id with
    // --resume/--continue *unless* --fork-session is also present (that exception
    // is what launchTrackedFork relies on; see resumeArgsFor).
    nativeSessionId: args.resumeSession ? null : res.nativeSessionId,
    // Subagent-launch deny is DEFAULT-ON (claude-only); `--allow-subagents` (or the
    // picker) opts THIS su launch back in. See suLaunchArgs / NO_SUBAGENTS_DENY_FLAG.
    allowSubagents: args.allowSubagents,
    // P-021/D-013: may this omp session KEEP its native `lsp` builtin? bootstrap-su
    // resolves FLAGS.OMP_NATIVE_LSP_BUILTIN *and* the local-model tier gate
    // server-side and threads the answer here. Absent ⇒ strip, byte-identical to
    // the pre-P-021 behavior. See ompLspArgs.
    allowNativeLsp: res.envelopeEnv?.PAPERCUSP_OMP_NATIVE_LSP === "1",
  });
  const requestedLaunchModel = requestedRoleModelFromBootstrap(res, args.model);
  const launchModel =
    res.agent === "omp"
      ? normalizeOmpModelSpec(requestedLaunchModel)
      : requestedLaunchModel;
  const launchModelNotice =
    res.agent === "omp"
      ? ompModelCompatibilityNotice(requestedLaunchModel)
      : null;
  if (launchModelNotice) console.error(launchModelNotice);
  // model/resume passthrough (raw-CLI flags: claude/omp --model/-r, codex -m/resume).
  const extra = suWrapperExtraArgs(res.agent, {
    model: launchModel,
    resumeSession: args.resumeSession,
  });
  if (args.addDir?.length && res.agent === "omp") {
    console.error(
      "psu: omp has no --add-dir; ignoring it. Pass a backend flag verbatim with `-- <flag>` if omp supports one.",
    );
  }
  if (args.allowSubagents != null && res.agent !== "claude") {
    console.error(
      `psu: subagent allow/deny is claude-only; ${res.agent} sessions are unaffected (no deny flag wired up — they keep their native subagent tool).`,
    );
  }
  // First-class --add-dir (claude/codex) then the generic `--` passthrough — both
  // forwarded verbatim to the backend CLI after psu's own flags.
  const launchArgs = [
    ...baseArgs,
    ...extra,
    ...addDirArgs(res.agent, args.addDir || []),
    ...(args.passthrough || []),
  ];
  // The brain (Queen) is an AGENT riding the su launch machinery — it gets the
  // native-scheduler lockout the human su session deliberately keeps (D-003).
  if (brain && res.agent === "claude")
    launchArgs.push(NATIVE_SCHEDULER_DENY_FLAG);
  // notify-send lockout rides suLaunchArgs for claude already; nothing extra here.
  // A kickoff launch-context (server-generated) layers in as a SECOND system
  // prompt for claude/omp. Codex has no equivalent CLI flag, so bootstrap-su
  // folds the same file into CODEX_HOME/AGENTS.md before returning.
  if (args.launchContext && res.agent !== "codex") {
    launchArgs.push(
      res.agent === "claude"
        ? "--append-system-prompt-file"
        : "--append-system-prompt",
      args.launchContext,
    );
  }

  // improve-fleet-launch-autokickoff (EI-5503): seed the FIRST USER TURN for a
  // SCRIPTED plan launch so a fleet/automation member immediately starts working
  // the plan instead of orienting once (reading the plan + brief as system prompt)
  // and then parking idle on its inbox-wake — the gap a leader previously closed by
  // hand with a coord:send wake. A prompt in any backend's argv is visible to shared
  // host process diagnostics, so routeFreshKickoff sends every backend through the
  // managed-pty startup barrier and keeps every launch argv prompt-free.
  // Gated to --no-picker launches (an interactive human picker launch still opens at
  // an empty prompt) + an explicit --no-kickoff opt-out. Text is server-supplied
  // (res.kickoffPrompt = the canonical deriveLaunchPromptText, present iff a plan is
  // bound) so it never drifts from headless plans:launch's kickoff.
  // Free-form kickoff precedence: explicit `--kickoff=<text>` flag, else the
  // PAPERCUSP_KICKOFF_PROMPT env var. The env var is the SPAWN-SAFE channel — a
  // free-form question passed as a `--kickoff=` VALUE inside a console greetingCmd
  // gets double-single-quoted by buildConsoleOneliner and breaks the shell (the
  // gnome-terminal exit-2 the tutorial docs-agent hit); an env value is exported
  // via a correctly-escaped `export K=…` in the oneliner prelude and arrives
  // intact (multiline / quotes included). So the desktop docs-agent launcher sets
  // the env var, not the flag.
  const kickoff = finalizeFreshSuArgs(res.agent, launchArgs, res, args);
  if (kickoff.kickoffSeeded) {
    console.error(
      `psu: kickoff — seeding first turn${res.planSlug ? ` to advance plan ${res.planSlug}` : ""} (suppress with --no-kickoff)`,
    );
  }

  // P-002 (omp-psu-interactive-parity-hardening-2026-06-29): an SU omp session
  // path-discovers <cwd>/.mcp.json. A prior ROLE session leaves a signed role-scoped
  // one there and never cleans it up (detached, unref'd terminal, no exit hook), so a
  // later SU omp launch hangs ~30s on a dead per-role MCP host ("papercusp timed
  // out"). Park it — the SU session needs only the user-level papercusp-su, and role
  // launchers recreate .mcp.json fresh, so parking is safe + needs no restore.
  // BOTH claude AND omp path-discover <cwd>/.mcp.json (claude auto-loads a project .mcp.json;
  // omp's mcp.discoveryMode) and NEITHER SU launch uses --strict-mcp-config (claude's papercusp-su
  // is user-level ~/.claude.json; omp discovers) — so park for both. (Was omp-only on the false
  // premise "claude uses --strict-mcp-config" — that holds for ROLE claude launches, not SU: an SU
  // claude in a cwd where a role spawn left a stale role-scoped .mcp.json inherits that role's
  // principal, e.g. system:sentinel. su-resume-inherits-role-mcp-json, 2026-06-30.) codex uses
  // CODEX_HOME, exempt.
  // su-context-size-variants + weak-model-tool-tier: OMP's per-session PI_CONFIG_DIR carries
  // a faithful copy of the config+model-registry with a rewritten mcp.json (home-relative —
  // see writeOmpSessionConfigDir). ONE trigger now that 'full' is retired: every session
  // advertises ONLY the ~19-tool core spine (the rest via tools:find), so no model — weak or
  // strong — is handed ~580 tools up front. Discovery is flipped OFF alongside it, which is
  // NOT the old whole-catalog behaviour: it is required BECAUSE the surface is a seed (see the
  // launch-tail comment — with discovery ON, the seed's own front doors sit behind activation).
  // Fail-safe: null ⇒ OMP keeps its native default (no regression).
  let ompPiConfigDir = null;
  if (res.agent === "omp" || res.agent === "claude") {
    const parked = parkRoleScopedMcpJson(res.cwd);
    if (parked)
      console.error(
        `psu: parked a stale role-scoped ${res.cwd}/.mcp.json (an SU session uses user-level papercusp-su, not a co-located role server; role launches recreate it)`,
      );
  }
  if (res.agent === "omp") {
    const advisory = ompDefaultModelAdvisory();
    if (advisory) console.error(advisory);
    const effectiveModel = launchModel || ompDefaultModel();
    // effectiveWindow probe (deterministic-context-carry P-005): for a LOCAL model, read the
    // live per-slot n_ctx from the gateway's backend probe so the per-session registry is
    // clamped to min(configured, live) — never trusting a hand-set number the backend has
    // drifted away from. Fail-soft: a null probe keeps the configured registry (pre-P-005
    // behavior), it never blocks the launch.
    let backendWindow = null;
    if (isWeakOmpModel(effectiveModel)) {
      backendWindow = await probeOmpBackendContextWindow(effectiveModel);
      if (backendWindow)
        console.error(
          `psu: live backend context window for ${effectiveModel}: ${backendWindow} tokens/slot — per-session registry set to min(configured, live).`,
        );
      else
        console.error(
          `psu: live backend context-window probe unavailable for ${effectiveModel} (gateway/backend miss) — keeping configured registry values.`,
        );
    }
    {
      // DEFAULT for EVERY model/tier (dynamic-tool-surface D-010):
      // SEED the core spine. It's a growable FLOOR, not a cap — tools:find surfaces the tail
      // on demand (→ notifications/tools/list_changed → OMP re-fetches tools/list, VERIFIED
      // live), tools:invoke (also in the spine) calls anything by name, and the compact
      // capability map (MCP initialize instructions) preserves discoverability. ~165k→~10k
      // tokens with the whole catalog still reachable. There is no opt-out: the seed is the
      // only mode, and --context-size=full is normalized to 'trimmed' at parse.
      //
      // discoveryOff is REQUIRED here, not optional (live-verified 2026-07-01 on ornith):
      // with OMP discovery ON, even the seed's front doors (tools:find / tools:invoke) sit
      // behind search_tool_bm25 activation — a 0-match query strands the ENTIRE surface
      // (nothing activated ⇒ nothing callable). A ~20-tool seed needs no discovery gate;
      // exposing it directly also makes post-list_changed refreshes auto-expose surfaced
      // tools (sdk activateAll path) instead of gating them behind a second bm25 pass.
      const spine = ompCoreToolNames();
      const spineCompact = ompCompactToolNames();
      // Compare against the DERIVED set, not the historical literal (D-005): the literal is
      // now only the PAPERCUSP_CLAUDE_FULL_SEED revert target, so differencing against it
      // would report a "drop" of ~42 tools on every launch where nothing was excluded.
      const undropped = deliveryAdvertisedNames("omp").length;
      if (spine.length !== undropped) {
        console.error(
          `psu: PAPERCUSP_OMP_TOOLS_EXCLUDE — dropped ${undropped - spine.length} tool(s) from the advertised spine; still callable via tools:invoke.`,
        );
      }
      ompPiConfigDir = await writeOmpSessionConfigDirAsync(res.sessionId, {
        discoveryOff: true,
        toolsAllowlist: spine,
        toolsCompact: spineCompact,
        model: effectiveModel,
        modelsYml: res.envelopeEnv?.PAPERCUSP_OMP_MODELS_YML || null,
        clientId: res.envelopeEnv?.PAPERCUSP_SID || null,
        // The live superuser token, not the template's minted copy (WI-10003604).
        operatorBearer: readToken() || null,
        env: { ...process.env, ...res.envelopeEnv },
        nativeMcp: true,
        mcpEnv: res.envelopeEnv || null,
        backendWindow,
        interactive: !args.headless && !!process.stdout.isTTY,
      });
      if (ompPiConfigDir)
        console.error(
          `psu: omp (${effectiveModel}) — MCP surface seeded to ${spine.length} core tools (long tail reachable on demand via tools:find/tools:invoke).`,
        );
      else
        console.error(
          `psu: omp (${effectiveModel}) — could not materialize a seeded config; using OMP default (full catalog).`,
        );
    }
    if (res.envelopeEnv?.PAPERCUSP_OMP_MODELS_YML && !ompPiConfigDir) {
      throw new Error(
        "psu: could not materialize the selected OMP account route; refusing direct/default fallback",
      );
    }
  }

  // Owner batch #5: right before the TUI takes over the terminal, remind a human
  // whose setup isn't finished that some functionality stays locked — and that
  // `papercusp setup` / `papercusp tutorial` both reach the place to finish it.
  // Gated to an INTERACTIVE, non-agent, non-scripted launch: fleet/Queen (brain),
  // omp (always an agent session), a scripted plan kickoff, a layered launch-context,
  // and any piped/non-TTY stdio all skip it. Best-effort + time-boxed — a slow or
  // unreachable operator (or any probe error) prints nothing and never delays the launch.
  if (
    Boolean(process.stdout.isTTY) &&
    !brain &&
    res.agent !== "omp" &&
    !kickoff.kickoffSeeded &&
    !args.launchContext
  ) {
    const lines = setupReminderLines(await fetchSetupStageSoft());
    if (lines) for (const line of lines) console.error(line);
  }

  // codex's superuser bearer is baked into its per-session config.toml
  // server-side (D-006); nothing for psu to export here.
  runWrapper({
    wrapperBin: bin,
    args: kickoff.args,
    cwd: res.cwd,
    kickoff: kickoff.kickoff,
    kickoffFile: res.sessionPortKickoffFile || null,
    sessionPort: res.sessionPort
      ? {
          ...res.sessionPort,
          workspace: selections.workspace,
          targetAdvSessionId: res.sessionId,
        }
      : null,
    // Anything launched through psu is an agent session for hook purposes:
    // native-scheduler lockout, OMP coord-hook guards, and the destructive
    // shared-tree git guard must all be armed. Direct non-psu Claude terminals
    // stay unmarked, preserving the owner-session exemption.
    envelopeEnv: {
      ...res.envelopeEnv,
      // The SU account picker defines no gateway route as "default — system/CLI
      // login". Make that an explicit envelope decision so ambient API/OAuth
      // credentials cannot silently override what the user selected.
      ...(res.agent === "claude" && !res.envelopeEnv?.ANTHROPIC_BASE_URL
        ? defaultAccountEnv()
        : {}),
      ...ompResponsesCompatibilityEnv(
        res.agent,
        launchModel || (res.agent === "omp" ? ompDefaultModel() : null),
        { ...process.env, ...res.envelopeEnv },
      ),
      PAPERCUSP_AGENT_SESSION: "1",
      // PAPERCUSP_MODEL: the launch model spec, exported so the codex/omp title hook can
      // render the model in the terminal title (WI-1963 title-parity — those CLIs have no
      // live model object like Claude's statusline stdin). Omitted when no --model (default).
      ...(launchModel ? { PAPERCUSP_MODEL: launchModel } : {}),
      // fleet-auto-mode (WI-1356): mark the running session as AUTO so the persona +
      // hooks read it at runtime (the durable prompt directive + turn-1 kickoff come
      // from bootstrap-su via the `auto` body field). Default on for `--fleet`.
      ...(effectiveAutoMode(args) ? { PAPERCUSP_AUTO_MODE: "1" } : {}),
      ...(args.mode === "drain" ? { PAPERCUSP_DRAIN_MODE: "1" } : {}),
      // Trimmed-only launch policy: keep ToolSearch deferral ON. Claude silently disables it when
      // ANTHROPIC_BASE_URL is overridden (it can't assume a proxy forwards tool_reference
      // blocks — ours does, it's a pass-through), so every gateway-routed (`--account`)
      // member was booting with ALL advertised schemas inline: 106–108k vs 60k measured
      // across the 2026-07-02 04:50 sonnet fleet (context-trimming-tiers P-031 gap 3).
      // Redundant-but-harmless on direct-API launches where deferral is already the default.
      // ENABLE_TOOL_SEARCH + PAPERCUSP_TOOLS (D-010 spine) + PAPERCUSP_CONTEXT_TIER (P-009
      // tier) come from ONE helper so the host-code handoff successor re-derives the same
      // trio (WI-2140943 lane 2) — see contextTrimmingEnv for the rationale of each key.
      ...contextTrimmingEnv(res.agent),
      // P-014 (agent-managed-compaction): the MECHANICAL compaction backstop. For a
      // P-022: native auto-compact is retired — every Claude launch runs with
      // DISABLE_AUTO_COMPACT; the carry-respawn ladder owns the boundary
      // (self-cut → watchdog soft cut → 1.3× force cut → death detector).
      ...nativeCompactionEnv(res.agent),
      // Console-history preservation: keep the CLI off the terminal's alternate
      // screen, or every carry-respawn discards the whole epoch it just rendered
      // (terminalRenderEnv — owner terminal 2026-09-06).
      ...terminalRenderEnv(res.agent),
      // P-030 (2026-07-02): OMP's default 30s MCP connect timeout is starved by a ~35s
      // startup event-loop block (observed twice, blockedMs≈35.6k both times) — every MCP
      // server then "times out"/"unable to connect" and the session runs TOOL-LESS with no
      // retry (OMP never reconnects a failed server). Give the connect phase real headroom;
      // an explicit env override still wins.
      ...(res.agent === "omp" && !process.env.OMP_MCP_TIMEOUT_MS
        ? { OMP_MCP_TIMEOUT_MS: "120000" }
        : {}),
      // Scripted OMP launches use a fresh isolated home and therefore have no
      // setupVersion on first boot. Without this supported OMP bypass, its
      // composer-layout wizard consumes the managed kickoff before any model
      // request or Papercusp tool call can begin.
      ...scriptedOmpSetupEnv(res.agent, args),
      // dynamic-tool-surface D-010 ("default all to trimmed"): claude is seeded BY DEFAULT
      // too — native ToolSearch defers only tool SCHEMAS, leaving all ~581 tool
      // names+descriptions (~165k, MEASURED) inline (that DOA'd sonnet-window sessions with
      // "Prompt is too long"), so the up-front load is the waste. claude's user-level
      // papercusp-su MCP url env-expands ${PAPERCUSP_TOOLS} (see buildClaudeMcpEntry), so
      // exporting the CORE SPINE makes the superuser MCP advertise ONLY the spine (~9k). The
      // tail stays reachable via tools:find/tools:invoke (in the spine) + the capability map.
      // (PAPERCUSP_TOOLS itself is spread by contextTrimmingEnv above.)
      // context-trimming-tiers D-004/P-009: the session PAYLOAD tier. The claude MCP url
      // env-expands ${PAPERCUSP_CONTEXT_TIER} (buildClaudeMcpEntry `ctx_tier=`) so the
      // server shapes tool payloads (defineTool `shape` projections) per tier.
      // TRIMMED IS THE DEFAULT FOR EVERY LAUNCH, model window irrelevant
      // [owner 2026-08-10: "make the default trimmed even for the 1m context models"].
      // P-009 originally derived this from the WINDOW (≤200k → trimmed, a [1m] spec →
      // full) on the theory that payload shaping only matters where the window is
      // small. It doesn't: a big window makes an unshaped payload AFFORDABLE, not
      // useful — the same wasted tokens are still read, just without hitting a wall.
      // This now matches the tool-surface spine (D-010), which was already trimmed for
      // everyone. Historical full inputs are normalized before this point.
      // (PAPERCUSP_CONTEXT_TIER itself is spread by contextTrimmingEnv above.)
      // su-context-size-variants + weak-model-tool-tier: OMP runs against a per-session config
      // dir (home-relative) with the MCP surface trimmed to the core spine and discovery off
      // (materialized above; null for non-omp / frontier-model / failure).
      // PI_CODING_AGENT_DIR must be PINNED alongside it (context-trimming-tiers P-031, 2026-07-02):
      // OMP treats that var as an agent-dir OVERRIDE that BEATS PI_CONFIG_DIR, and adv-console /
      // pty spawns export it (<stateDir>/pi-sessions — spawn-config.resolveContextEnv), so a psu
      // launched from such a shell silently ignored the per-session mcp.json + config.yml: the
      // 04:53 ornith session got the FULL 592-tool catalog (inherited pi-sessions agent dir, no
      // tools= filter, no discovery flip) instead of the 20-tool spine. Pinning to the session's
      // own agent dir makes the relocation deterministic regardless of inherited env.
      ...(ompPiConfigDir
        ? {
            PI_CONFIG_DIR: ompPiConfigDir,
            PI_CODING_AGENT_DIR: join(homedir(), ompPiConfigDir, "agent"),
          }
        : {}),
    },
  });
}

// The shared helper owns both symlink robustness and bundled-sidecar safety.
if (isCliEntry(import.meta.url)) {
  main().catch((e) => {
    // @inquirer throws ExitPromptError on Ctrl+C — treat as a clean cancel.
    if (
      e &&
      (e.name === "ExitPromptError" || /force closed/i.test(e.message || ""))
    ) {
      console.error("psu: cancelled");
      process.exit(130);
    }
    const msg = e?.message || (typeof e === "string" ? e : JSON.stringify(e));
    console.error("psu: " + msg);
    process.exit(1);
  });
}
