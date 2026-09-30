#!/usr/bin/env node
/**
 * Canonical capless resource-governor policy guard (P-012).
 *
 * This replaces capacity-limit linting. A numeric maximum is not proof that work
 * is safe; the proof is a governed admission/queue/state lifecycle. The inventory
 * is deliberately subsystem-complete and records the migration item that turns
 * each pending lane on. Once a lane is active, every resource start in its paths
 * must carry writer evidence in source.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { isCliEntry } from "@papercusp/operator-core/lib/util/cli-entry";
import { describeUnscanned, listTrackedFiles } from "./lib/tracked-files.mjs";
import { stripCommentsAndStrings } from "./lib/strip-comments-and-strings.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

export const RESOURCE_GOVERNOR_INVENTORY = Object.freeze([
  inventory({
    id: "agent-process-memory",
    migration: "P-013",
    enforcement: "active",
    paths: [
      "packages/operator-core/lib/agent-",
      "packages/operator-core/lib/fleet/",
      "packages/operator-core/lib/pty-",
      "apps/operator/scripts/psu-",
      // P-001 (spawn-door-governor-migration-2026-08-31, D-006): the lane's
      // prefixes covered every DOOR but not the two files holding the actual
      // child-start primitives, so a raw spawn() could be added there and the
      // scan would stay green. Measured before widening: console-spawn.ts
      // yielded resource-start-outside-admission with NO registry row, and
      // orchestrator-runner.ts already carried a row that was inert because
      // nothing scanned the path it names. Exact-file entries (the style the
      // P-015 lane uses) rather than a `lib/dbos/` prefix: only these two
      // files start a child, and a directory prefix would silently adopt
      // unrelated future files into an active lane.
      "packages/operator-core/lib/console-spawn.ts",
      "packages/operator-core/lib/dbos/orchestrator-runner.ts",
    ],
    resourceDimensions: ["cpu", "memory", "process", "pty"],
    fanOut:
      "one admission per agent process, one per pty child; nested tool starts inherit the parent AdmissionContext, so the Nth fleet member is attributed to the launch that created it rather than counted as an independent root",
    durableSource:
      "capability:launch-agent's idempotencyKey agent-spawn:<caller>:<spawnStartedAt>:<i>, and the fleet/plan work-item that commissioned the launch",
    telemetry:
      "admissionClass 'agent' and 'process' admission/queue depth, plus psu host liveness through coord presence sessionState",
    contextAndRelease:
      "spawnGovernedAgentProcess holds the execution across the child's whole lifetime and releases actual cost on exit; a throwing spawn calls execution.cancel so a failed start never leaks a reservation",
    currentCaps:
      "none on the governed door: the per-launch spawn ceiling was deleted when capability:launch-agent and fleet:launch-on-plan moved onto spawnGovernedAgentProcess, and psu-launcher/psu-pty-host hold no ceiling of their own. The lane's OTHER door, fleet/operator-spawn.ts spawnAgentInHarness, still enforces effectiveSpawnCeiling at its atomic admission cap: a USER-set maxSimultaneousAgents is an honoured deliberate throttle, while a SEED-sourced value resolves to the governor's live adaptive window instead of the boot-time host guess (WI-586538 / P-009), so it is never a frozen maximum — and over-ceiling spawns QUEUE on the D-004 wake key rather than being rejected. Routing that second door onto spawnGovernedAgentProcess is tracked residue (WI-590490), not a finished migration",
    writerEvidence:
      "beginGovernedExecution at spawn-execution.ts and pty-bridge.ts with AdmissionContext propagated into the spawned process; residual probe/release/ledger sites carry explicit BYPASS_REGISTRY rows",
    sites: [
      {
        path: "packages/operator-core/lib/agent-tools/capability/launch-agent.ts",
        start: "psu agent process — governed, admissionClass 'agent'",
      },
      {
        path: "packages/operator-core/lib/resource-governor/spawn-execution.ts",
        start: "spawnGovernedAgentProcess — the lane's admission seam",
      },
      {
        path: "packages/operator-core/lib/pty-bridge.ts",
        start: "pty child — governed, admissionClass 'process'",
      },
      {
        path: "packages/operator-core/lib/fleet/sidecar-exec-process.ts",
        start: "fleet sidecar exec — governed",
      },
      {
        path: "apps/operator/scripts/psu-launcher.mjs",
        start:
          "agent wrapper via spawnInherit — admitted upstream by launch-agent; probes bypass-registered",
      },
      {
        path: "apps/operator/scripts/psu-pty-host.mjs",
        start:
          "pty.spawn of the launched agent's own child — admitted upstream; bypass-registered",
      },
    ],
  }),
  inventory({
    id: "mcp-http-operator-transport",
    migration: "P-014",
    enforcement: "active",
    paths: [
      "packages/operator-core/lib/endpoint-",
      "packages/operator-core/lib/agent-tools/",
      "apps/operator/bin/",
    ],
    resourceDimensions: ["cpu", "memory", "socket", "process"],
    fanOut:
      "one admission per tool invocation that starts a subprocess; a tool called by an agent inherits that agent's context, so a fleet-wide tool storm attributes to its callers instead of appearing as unrelated roots",
    durableSource:
      "the tool_invocations ledger row for the call, plus the caller's own work-item; never an in-process request queue",
    telemetry:
      "per-tool admission counts and MCP proxy shed responses (HTTP 429 + Retry-After) surfaced as governor admission pressure",
    currentCaps:
      "none on the machine paths: the MCP proxy sheds with a retryable 429 under pressure instead of holding a fixed concurrency ceiling. ONE deliberate exception lives inside this prefix — INTERACTIVE launches (endpoint-route/routes/agent-mcp/console-launch.ts, adv/launch-su.ts) waive brain admission because the human IS the judgment (D-003), but still pass checkInteractiveSafetyFloor, the P-012 / D-013 deterministic concurrency floor: over-ceiling returns 429 with an actionable message, and the floor read fails OPEN so it can guard a human launch without ever gating one",
    contextAndRelease:
      "runGovernedOperation wraps each subprocess-starting tool and releases on settle; the host bootstrap admits its own long-lived listeners once at start",
    writerEvidence:
      "beginGovernedExecution across 21 agent-tools/endpoint writers (build/typecheck, db/migrate, computer, backup/diff, host-bootstrap); cheap git/probe metadata reads carry explicit BYPASS_REGISTRY rows",
    sites: [
      {
        path: "apps/operator/bin/host-bootstrap.ts",
        start: "operator host listeners — governed at boot",
      },
      {
        path: "packages/operator-core/lib/agent-tools/build/typecheck.ts",
        start: "tsc subprocess — governed",
      },
      {
        path: "packages/operator-core/lib/agent-tools/db/migrate.ts",
        start: "migration runner subprocess — governed",
      },
      {
        path: "packages/operator-core/lib/agent-tools/computer/computer.ts",
        start: "desktop automation subprocess — governed",
      },
    ],
  }),
  inventory({
    id: "inference-embedding-provider-batching",
    migration: "P-015",
    enforcement: "active",
    paths: [
      "packages/operator-core/lib/inference-",
      "packages/operator-core/lib/memory/embed-sidecar-server.ts",
      "packages/operator-core/lib/memory/embed-admission.ts",
      "packages/operator-core/lib/memory/bench/",
      "packages/operator-core/lib/llm-",
    ],
    resourceDimensions: ["cpu", "memory", "gpu", "network"],
    fanOut:
      "one admission per embedding batch and per provider request; a recall that fans into N provider calls must carry one parent context, not N roots",
    durableSource:
      "the memory/embedding job row that requested the batch; embed-admission already reads it rather than holding an in-memory backlog",
    telemetry:
      "embedding queue depth and provider latency/ratelimit state, with unknown preserved when a provider does not report",
    contextAndRelease:
      "embed-admission and the sidecar hold one durable admission per unit; provider responses remain live feedback and the gateway watchdog is observe-only, so no local cap is duplicated",
    currentCaps:
      "none: inference-gateway/watchdog.mjs reads the live admission.maxConcurrent gauge only to detect a frozen queue; it does not configure or enforce capacity",
    writerEvidence:
      "governed writers: memory/embed-admission.ts, memory/bench/index-cap.ts, and memory/embed-sidecar-server.ts (embedding/inference per-unit runGovernedOperation); watchdog reads live provider state without admission",
    sites: [
      {
        path: "packages/operator-core/lib/memory/embed-admission.ts",
        start: "embedding batch — governed",
      },
      {
        path: "packages/operator-core/lib/inference-gateway/watchdog.mjs",
        start:
          "provider watchdog — observe-only live admission state; no capacity setting",
      },
    ],
  }),
  inventory({
    id: "database-sidecar-checkpoint-dbos",
    migration: "P-015",
    enforcement: "active",
    paths: [
      "packages/operator-core/lib/db/",
      "packages/operator-core/lib/dbos/queue-concurrency.ts",
      "packages/operator-core/lib/dbos/routines-workflow.ts",
      "packages/operator-core/lib/derived-",
      "packages/operator-core/lib/memory/embed-sidecar-",
    ],
    resourceDimensions: ["cpu", "memory", "database", "process"],
    fanOut:
      "one admission per DBOS workflow start and per sidecar process; a routine that fans into per-harness work must propagate one context so a 21-install sweep is not 21 unrelated roots",
    durableSource:
      "the DBOS workflow row and the routines table entry that scheduled it — both already durable, which is why this lane needs admission rather than a new queue",
    telemetry:
      "one prior-cohort org-admin pool probe per tick plus indexed ENQUEUED/PENDING routineFire counts by queue, durable pool-shed events, and per-routine fire/skip counts; pool exhaustion reads as feedback pressure, not as a terminal error",
    contextAndRelease:
      "sidecar process units carry durable Governor receipts and inherited AdmissionContext; DBOS queues have no local concurrency cap, preserve deferred work as unclaimed durable routine rows, and reopen starts from the next capless previous-cohort feedback epoch after subtracting real in-flight work",
    currentCaps:
      "no numeric ceiling in-lane; the effective limit is the Postgres connection pool, a physical upstream constraint to observe rather than duplicate",
    writerEvidence:
      "packages/operator-core/lib/memory/embed-sidecar-server.ts is governed per sidecar unit; dbos/queue-concurrency.ts removes the former fixed cap while dbos/routines-workflow.ts feeds physical pool health and indexed DBOS occupancy into CaplessAdaptiveController before claim/start and leaves withheld routine rows durably due",
    sites: [
      {
        path: "packages/operator-core/lib/dbos/bootstrap.ts",
        start:
          "DBOS workflow host — durable workflow state; queue capacity is delegated to governor/DB feedback",
      },
      {
        path: "packages/operator-core/lib/dbos/routines-workflow.ts",
        start:
          "routineFire workflow fan-out — one prior-cohort health epoch reads indexed DBOS in-flight rows before claim/start, then the loop spends only its credit",
      },
      {
        path: "packages/operator-core/lib/memory/embed-sidecar-server.ts",
        start:
          "sidecar inference units — durable embedding/inference admission per text",
      },
    ],
  }),
  inventory({
    id: "p2p-sync-index-cache-compaction",
    migration: "P-016",
    enforcement: "active",
    paths: [
      "packages/operator-core/lib/p2p/",
      "packages/operator-core/lib/sync/",
      "packages/operator-core/lib/search/",
    ],
    resourceDimensions: ["cpu", "memory", "network", "disk"],
    fanOut:
      "one admission per fetch/index/compaction pass; a multi-pot sync fans out per pot and must attribute to the sync that started it",
    durableSource:
      "the pot-git fetch cursor and the index generation record; compaction is restartable from them, so nothing needs an in-memory backlog",
    telemetry:
      "index lag, fetch bytes in flight, and compaction backlog age — with stale preserved rather than coerced to zero",
    contextAndRelease:
      "fetch transport owns its durable admission; index and compaction starts are either parent-admitted or explicitly dispositioned below, with release/control paths kept runnable under pressure",
    currentCaps:
      "no numeric ceiling in-lane; disk throughput is the physical upstream constraint and is observed, not duplicated",
    writerEvidence:
      "sync/pot-git/fetch-transport.ts is the governed writer; every other detected start has a path-and-finding disposition in BYPASS_REGISTRY and the active scan validates that registry strictly",
    sites: [
      {
        path: "packages/operator-core/lib/sync/pot-git/fetch-transport.ts",
        start: "git fetch transport — governed",
      },
    ],
  }),
  inventory({
    id: "ci-release-test-workers",
    migration: "P-016",
    enforcement: "active",
    paths: [
      "packages/operator-core/lib/release/",
      "apps/operator/lib/release/",
      "scripts/",
    ],
    resourceDimensions: ["cpu", "memory", "process", "disk"],
    fanOut:
      "one admission per test worker and per release step; the affected-tests runner fans out per workspace and propagates a single parent context so a 71-workspace run is one attributed tree",
    durableSource:
      "the test_runs ledger row per file and the release checkpoint record; a killed worker is re-derivable from them",
    telemetry:
      "per-worker CPU claim and suite wall-time, plus green-checkpoint gate health (consecutive reds, observed candidate)",
    contextAndRelease:
      "governed-test-process.mjs admits each worker and releases on exit; release/control children are parent-owned or explicitly dispositioned in BYPASS_REGISTRY, so no untracked worker remains",
    currentCaps:
      "no numeric worker ceiling; scripts/lib/governed-test-process.mjs replaced the former fixed worker count with admission",
    writerEvidence:
      "runGovernedTestProcess in scripts/lib/governed-test-process.mjs covers test fan-out; release/check helpers carry reviewed per-site parent/bypass evidence in BYPASS_REGISTRY",
    sites: [
      {
        path: "scripts/lib/governed-test-process.mjs",
        start: "test worker — governed admission seam",
      },
      {
        path: "scripts/affected-tests.mjs",
        start: "affected-suite fan-out — governed via the seam above",
      },
      {
        path: "apps/operator/lib/release/deploy-cli.ts",
        start:
          "release deploy — parent-owned admission; residual start is reviewed in the P-016 disposition registry",
      },
    ],
  }),
  inventory({
    id: "background-routines-watchdogs",
    migration: "P-016",
    enforcement: "active",
    paths: [
      "packages/operator-core/lib/system-health/",
      "packages/operator-core/lib/harness/routines/",
      "packages/operator-core/lib/events/",
    ],
    resourceDimensions: ["cpu", "memory", "database", "network"],
    fanOut:
      "one admission per routine fire; the ephemeral executor fans out per host and per install, so a fleet-wide tick must attribute to the tick rather than to each install separately",
    durableSource:
      "the routines table row (nextFireAt/lastFiredAt) — a skipped fire is recoverable from it, so a dropped tick must never be re-queued in memory",
    telemetry:
      "routine fire/skip/overrun counts and watchdog liveness, observed from OUTSIDE the routine process so a saturated main thread cannot self-report healthy",
    contextAndRelease:
      "routine fire owns a durable schedule record; each child start is parent-owned or a release/control operation explicitly dispositioned in BYPASS_REGISTRY, with no hidden resident queue",
    currentCaps:
      "no numeric ceiling; managedSetInterval makes timers visible in schedule:inventory but visibility is not control, which is why admission is still required",
    writerEvidence:
      "routine and system-health starts are covered by parent-scheduler or control-path dispositions in BYPASS_REGISTRY; the active scan now proves no unreviewed finding remains",
    sites: [
      {
        path: "packages/operator-core/lib/harness/routines/supervision-reconcile-action.ts",
        start:
          "supervision reconcile fire — systemd control/probe; residual start is reviewed in the P-016 disposition registry",
      },
      {
        path: "packages/operator-core/lib/system-health/index.ts",
        start:
          "health sweep — bounded system-health operation; residual start is reviewed in the P-016 disposition registry",
      },
    ],
  }),
  inventory({
    id: "governor-core",
    migration: "P-012",
    enforcement: "active",
    paths: ["packages/operator-core/lib/resource-governor/"],
    resourceDimensions: ["cpu", "memory", "process", "database", "network"],
    fanOut:
      "the governor itself starts no resource work; it MEASURES fan-out by minting the typed admissionClass and the child AdmissionContext lineage every other lane propagates",
    durableSource:
      "work_items-backed durable queue receipts — the record that lets capacity pressure queue instead of reject (D-001)",
    telemetry:
      "the governor health/admission/queue/resources/recovery snapshot, which preserves unknown and stale rather than coercing either to zero",
    contextAndRelease:
      "AdmissionContext is propagated to an exact Governor.release(actualDemand); the release path is deliberately never gated on admission so recovery stays runnable under saturation",
    currentCaps:
      "none by construction (D-002): desired admission windows and lease credit are transient feedback state with no upper bound",
    writerEvidence:
      "Governor.admit plus a valid local lease, AdmissionContext, Governor.release, and the governor state writer — all five present in execution.ts and spawn-execution.ts",
    sites: [
      {
        path: "packages/operator-core/lib/resource-governor/execution.ts",
        start: "beginGovernedExecution — the admission primitive",
      },
      {
        path: "packages/operator-core/lib/resource-governor/spawn-execution.ts",
        start: "spawnGovernedAgentProcess — the process-spawn wrapper",
      },
      {
        path: "packages/operator-core/lib/resource-governor/live-health-supervisor.ts",
        start: "live health sampling that feeds the admission window",
      },
    ],
  }),
]);

/**
 * D-004's exemption registry: "Control, release, and non-resident work bypass
 * explicitly. The registry owns exemptions and lint enforces them; callers cannot
 * self-exempt."
 *
 * Two design constraints, both load-bearing:
 *
 *   1. THE REGISTRY OWNS IT, NOT THE CALL SITE. There is deliberately no inline
 *      pragma (`// governor-exempt`). An exemption a caller can write next to its
 *      own spawn is self-exemption, which D-004 forbids in as many words. Adding a
 *      row here is a reviewable diff in a file whose whole purpose is being read.
 *
 *   2. KEYED BY (path, findingCode), NOT BY PATH. A file-level exemption is too
 *      coarse: `capability/bash-jobs.ts` genuinely bypasses admission for a control
 *      kill, but that says nothing about whether it also parks an unbounded resident
 *      queue. Exempting the file would silently retire a check nobody judged — the
 *      decorative-allowlist failure documented at length in
 *      check-no-unenrolled-detached-spawn.mjs ("an allowlist is evidence of what a
 *      guard was ASKED to ignore, never evidence of what it can SEE").
 *
 * `disposition` reuses the inventory vocabulary. Use `bypass` for work that cannot
 * materially increase residency, `upstream` when a physical constraint is observed
 * rather than duplicated, `semantic` for a policy limit that is not a capacity cap.
 * `false-positive` does NOT belong here — a detector that misfires is a detector bug
 * to fix, and registering it would preserve the bug behind a row that reads as
 * judgement.
 *
 * Shrinking this list is the point. Every row states what the process actually does.
 */
/**
 * P-016's active lanes include broad support paths (release helpers, routine
 * actions, drills, and CI scripts). A green scan is not evidence that those
 * paths were reviewed: it is only evidence when every finding has a central,
 * path-and-finding disposition. Keep this manifest explicit and keyed by the
 * exact detector code so a new start or queue cannot inherit a file-wide
 * exemption. Reasons are intentionally path-specific; a shared boilerplate
 * reason would make the review decorative.
 */
export const RESOURCE_GOVERNOR_SCANNER_PATH =
  "scripts/check-resource-governor-enforcement.mjs";
export const P016_REVIEWED_DISPOSITIONS = Object.freeze([
  {
    path: "scripts/share-source.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/share-source.mjs: this is an operator-invoked CLI that lists, adds, or removes collaborators on the private source-preview GitHub repo, not a runtime lane. Its only start is the `gh(args, env)` helper — one synchronous `spawnSync('gh', args, { encoding })` per GitHub API call, awaited to completion before the next and resolving to one captured stdout/stderr pair with nothing retained between calls. It never detaches a child, never runs inside the operator, bg-host, or a routine, and holds no queue; every call is a single short HTTPS request on behalf of a human at a terminal, so it adds no residency the governor could meter (WI-10003724).",
  },
  {
    path: "scripts/source-preview.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/source-preview.mjs: this is an operator-invoked export CLI (`npm run preview:*`) that materializes one pinned commit with git archive, gates it with audit-release-bundle, gitleaks and trufflehog, and publishes it as a single commit. It is not a runtime lane. Every start goes through the synchronous `run(cmd, args)` helper, or a direct `spawnSync('git', ...)` probe: awaited to completion before the next, bounded by an explicit maxBuffer, fail-closed (a non-zero exit throws PreviewError), and never detached. It never runs inside the operator, bg-host, or a routine, and it holds no resident queue; the work is one human-initiated export at a terminal (WI-10003724).",
  },
  {
    path: "scripts/check-tracked-src-entry-dist.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-tracked-src-entry-dist.mjs: this is a BUILD-TIME tracked-tree guard (WI-10002064 — a src-as-entry package tracking its own unreachable dist/, whose stale _bulk.js re-teaches a removed contract), not a runtime lane. Its only start is a single `execFileSync('git', args, { cwd, encoding, maxBuffer })` helper used to enumerate tracked paths; each call is synchronous, bounded by an explicit maxBuffer, awaited to completion before the next, and resolves to one captured stdout string with nothing retained between calls — so it adds no residency and no independent resident queue. Routing it through Governor.admit would be a category error: the governor admits contended RUNTIME capacity, whereas this process is a lint invoked by the release gate and by developers, and gating it would make the guard unrunnable in exactly the pressured conditions where a wrong tracked dist/ is most likely to ship. Same shape as the git-plumbing bypasses already reviewed for green-checkpoint-gen-check-self-heal.ts.",
  },
  {
    path: "scripts/verify-identities-r4.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/verify-identities-r4.mjs: this is P-015 R-4's acceptance VERIFICATION driver (an isolated, pointer-driven identity review journey against a disposable coord_presence/adv_sessions fixture), not a runtime lane. Its only start is the `checkedCommand` helper — one synchronous `execFileSync(command, args, { encoding, timeout: 45_000 })` per call, awaited to completion before the next and resolving to a single captured stdout string with nothing retained between calls, so it adds no residency and no independent resident queue. Every call site is explicitly bounded: a `git rev-parse HEAD` tree-head read, plus two `bash` settle/liveness probes under 45s and 15s timeouts. The driver cannot run outside `verify-tauri-headless.sh` at all — it throws on the missing VERIFY_TAURI_* env contract — so it only ever executes inside that script's own isolated Xvfb/devUrl/sidecar tree. Routing it through Governor.admit would be a category error for the same reason as the scripts/check-tracked-src-entry-dist.mjs bypass: the governor admits contended RUNTIME capacity, whereas this is an evidence-producing verification driver invoked by a developer or the acceptance gate, and gating it would make the verification unrunnable in exactly the pressured conditions where its evidence matters most.",
  },
  {
    path: "scripts/verify-identities-r3.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/verify-identities-r3.mjs: this is P-015 R-3's live self-drill VERIFICATION driver, the sibling of the reviewed verify-identities-r4.mjs row, run by hand in an observing session. Its starts are three synchronous execFileSync calls, each awaited to completion before the next and retaining only one captured stdout string: `node scripts/mcp-call.mjs` (one tool call, timeout 180s, 8 MiB maxBuffer), the production user-prompt-submit hook (timeout 30s, 8 MiB maxBuffer), and one `git rev-parse HEAD`. It holds no resident queue and adds no residency after it exits. Routing it through Governor.admit would gate an evidence-producing acceptance drill behind the runtime capacity it is meant to observe.",
  },
  {
    path: "scripts/fixmic.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/fixmic.mjs: an owner-invoked host audio RECOVERY command (EI-24190247768567149), not a runtime lane. Its starts are synchronous spawnSync calls through one `command()` helper to host audio tooling — `pactl` source reads, a bounded source-level measurement (timeout = durationMs, default 4s), and one `systemctl --user restart` of the pipewire/wireplumber units. Each is awaited to completion, nothing is retained between calls, and the process exits when recovery ends, so it adds no residency and no queue. Gating a repair of the owner's microphone behind contended agent capacity would make it unavailable exactly when the host is busy.",
  },
  {
    path: "scripts/run-carry-cohort.mts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/run-carry-cohort.mts: the P-005 carry-cohort runner's only detected start is the `git` helper — a synchronous `execFileSync('git', args, { cwd: REPO })` used for a handful of read-only repository reads (rev-parse and blob/path lookups that stamp instrument provenance on the cohort ledger). Each call is awaited to completion and returns one trimmed string; nothing is retained between calls and no child outlives its call. `node:child_process` is imported in this file for that helper alone; starts made by the modules it imports (carry-cohort-driver, psu-launcher) are judged at their own paths, not covered by this row. A read-only git probe adds no residency, so admission would only add a failure mode to the provenance stamp.",
  },
  {
    path: "scripts/tsc-service/server.mjs",
    code: "unbounded-resident-queue",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for scripts/tsc-service/server.mjs: the flagged `queue` is the shared typecheck service's list of pending requests, and its bound is observed upstream rather than duplicated. Each entry is created once per accepted client socket (later data on that socket is ignored), is marked cancelled when the socket closes, and is flushed in whole batches by drain(); a request body is capped at 1 MiB and MAX_REQUEST_FILES paths. So the queue length can never exceed the number of live client connections, and those clients are the gate's `lint:tsc --files` runs, which are themselves admitted by pc-heavy. The service is socket-activated and exits after PAPERCUSP_TSC_SERVICE_IDLE_SEC idle, releasing its memory. A second local cap would duplicate the client admission it already sits behind.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/stale-routine-executor-watchdog.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/harness/routines/stale-routine-executor-watchdog.ts: `runRestartCommand` execFiles the ptool CLI (`dev:restart --json -`) to auto-remediate a STALE routines-enabled bg-host executor. The start is bounded and awaited under an explicit timeout with a 4MB maxBuffer, writes its argument payload to stdin and closes it immediately, and resolves to a single {stdout, error} receipt; nothing is retained between calls, so it adds no residency and no independent resident queue. It must remain runnable while productive capacity is pressured because it is the recovery lever for an executor that has ALREADY stopped making progress — gating it on admission would queue the restart behind the very wedged capacity the restart exists to free. The restart it invokes is itself the governed dev:restart chokepoint, which owns drain/coalescing and its own authorize+reason audit trail.",
  },
  {
    path: "apps/operator/lib/release/green-checkpoint-gen-check-self-heal.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for apps/operator/lib/release/green-checkpoint-gen-check-self-heal.ts: R-5's gen-check self-heal re-runs the paired generator inside the frozen verification tree and rebuilds a scratch git index (read-tree, hash-object, update-index) to admit the regenerated artifacts onto repairHead. Every start is git plumbing that is bounded, awaited, and confined to one self-heal attempt against a temporary GIT_INDEX_FILE in a mkdtemp scratch dir; it creates no independent resident queue, and it must remain runnable while productive capacity is pressured because it sits on the release gate's own critical path — a held red cannot clear if the heal cannot run.",
  },
  {
    path: "packages/operator-core/lib/release/admission-fix-precheck.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/release/admission-fix-precheck.ts: `defaultExec` is the injectable command-runner seam behind the checkpoint-tree precheck (callers may substitute their own via CheckpointTreeRunnerOptions.exec). Each start is a single awaited child under an enforced timeout, with combined stdout/stderr capped at 256KB, resolving to an explicit {code, signal, timedOut, durationMs} receipt; nothing is retained between calls, so it adds no residency, and it must stay runnable under pressure so an admission precheck can still reach a verdict.",
  },
  {
    path: "scripts/bench-release-task-reuse.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/bench-release-task-reuse.ts: this is a hand-invoked benchmark harness that shells out to read-only git plumbing to pin the source sha, gitlinks and source fingerprints for one controlled release-preparation measurement. The starts are bounded, awaited and non-mutating, they run only when a human runs the bench script rather than on any scheduled or serving path, and they create no resident queue.",
  },
  {
    path: "apps/operator/lib/release/cut-seed-cli.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for apps/operator/lib/release/cut-seed-cli.ts: this release/checkpoint operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "apps/operator/lib/release/workspace-host-release-cut-cli.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for apps/operator/lib/release/workspace-host-release-cut-cli.ts: every start here is the `runStep` helper — one `spawn` per release stage (pinned source checkout, vm-release sidecar build, deterministic pack, minisign sign plus independent verify, tar extract, SBOM/vulnerability audit, identity audit). Each is sequential, awaited to `close` before the next begins, writes into a per-stage log fd rather than an in-memory buffer, and retains nothing between calls, so the file adds no residency and starts no independent resident queue. The whole cut runs under ONE durable `class: 'deploy'` task that `openOperation` registers BEFORE any stage spawns (D-394 / WI-10002539 — 'the row first: a row with no cut is discoverable and harmless; a cut with no row cannot journal'), and that task owns admission, resumption and release for the operation as a whole, including the --task-id/--operation-id resume path. A per-stage receipt would double-count the same release work against a task already accounted for. Same shape as the substrate-sidecar-spawn.ts upstream disposition.",
  },
  {
    path: "apps/operator/lib/release/deploy-deps.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for apps/operator/lib/release/deploy-deps.ts: this release/checkpoint operation is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "apps/operator/lib/release/desktop-perf-gate.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for apps/operator/lib/release/desktop-perf-gate.ts: its starts are awaited git metadata reads (15s timeout each) that the post-suite desktop-perf gate issues once per green-checkpoint verdict: `readNewestCommitAtMs` (one `git log -n 64 --format=%ct <ref>`, to age the measured build against main, WI-10003815) and `classifyBuildSha` (at most two `git rev-parse --verify` and two `git merge-base --is-ancestor`, to relate the build's recorded sha to the candidate and main, plan desktop-perf-measure-candidate-build-2026-09-29 P-002). They return scalars, retain nothing, start no resident queue, and sit behind an injectable IO seam that tests fake. The gate that calls them is fail-soft, so a failed read degrades the verdict to unknown rather than blocking; release/control metadata must stay runnable while productive capacity is pressured.",
  },
  {
    path: "apps/operator/lib/release/precut-containment-cli.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for apps/operator/lib/release/precut-containment-cli.ts: an operator-invoked release CLI (`npm --prefix apps/operator run release:precut-containment`, WI-10002524 / WI-10004153) that answers one go/no-go question before a desktop cut: is every listed fix's blob in green main. Its only starts are synchronous local git metadata reads against the shared checkout: one `git rev-parse` per ref (main, staging), one `git show <ref>:<path>` per declared path and ref to compare blob contents and grep a marker, and one `git status --porcelain -- <path>` per path to spot uncommitted edits. The set is a few dozen paths, so the run is seconds of bounded local git with no network, no build and no resident process. It returns a table and an exit code, retains nothing, and writes nothing. A cut decision must stay answerable while productive capacity is pressured, so it is release/control metadata rather than a governed workload.",
  },
  {
    path: "packages/operator-core/lib/sync/pot-git/physical-drill-phase-h.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/sync/pot-git/physical-drill-phase-h.ts: the P-521 F3 (serving identity, drill leg H, WI-10003963) evidence verifier. Its one start is the `git(repoPath, args)` helper, a synchronous `spawnSync('git', ['--git-dir', repoPath, ...])`. `assertCanonicalRepoPath` confines repoPath to the drill's own Phase-A test pot bare repo. Per drill step it reads (show-ref, cat-file) and writes exactly one run-scoped test commit under `refs/namespaces/<device>/refs/heads/p521-phase-h-<step>-<runId>` (hash-object, mktree, commit-tree, update-ref). It refuses a ref that already exists, so it never moves an existing ref. It runs only inside the attended hive-git physical drill. There is no network, no build and no resident process, and each call returns one scalar or oid that the verifier folds into a pass/fail record. The rig itself is serialized by the hive-git-physical-rig resource lock, so the verifier adds only a handful of bounded local reads to an already exclusive, attended run.",
  },
  {
    path: "packages/operator-core/lib/sync/pot-git/physical-drill-phase-i.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/sync/pot-git/physical-drill-phase-i.ts: the P-521 F6-remainder protected-effect fencing check (drill leg I, WI-10003964). Its starts are the `sh(cwd, args)` and `tryRev(gitDir, ref)` helpers, both synchronous `spawnSync('git', ...)` in an absolute scratch directory the phase itself created and asserts exists (`assertDir`). They build and inspect throwaway local repos to prove that release promotion, origin push and fork/PR paths are refused, and they commit with a fixed test identity (COMMIT_ENV). They never touch the shared checkout, never reach a real remote and start no resident process. The phase runs only inside the attended physical drill, serialized by the hive-git-physical-rig resource lock, and its cost is a bounded handful of local git calls per drill run.",
  },
  {
    path: "packages/operator-core/lib/sync/pot-git/physical-drill-preflight.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/sync/pot-git/physical-drill-preflight.ts: the hive-git physical drill's read-only pre-run check (D-086, WI-10004088, WI-10004062), which verifies that the pinned drill source commit carries every drill file before the rig run starts. Its default gatherers are awaited `execFile` reads with explicit bounds: `git -C <repo> ...` metadata reads (status, show, ls-tree) with a 20s timeout and capped maxBuffer, and one `ssh -o BatchMode=yes -o ConnectTimeout=10 <vm>` probe of the VM owner's payload identity. They return scalars, retain nothing and start no resident queue. The gatherers sit behind injectable seams that the tests replace, and the preflight runs once per attended drill run, which the hive-git-physical-rig resource lock already serializes. A refused preflight blocks only that drill, never a productive lane.",
  },
  {
    path: "apps/operator/lib/release/git-ops.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for apps/operator/lib/release/git-ops.ts: this release/checkpoint operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "apps/operator/lib/release/gitignored-asset-coverage.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for apps/operator/lib/release/gitignored-asset-coverage.ts: this release/checkpoint operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "apps/operator/lib/release/green-checkpoint.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for apps/operator/lib/release/green-checkpoint.ts: this release/checkpoint operation is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "apps/operator/lib/release/record-release-cli.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for apps/operator/lib/release/record-release-cli.ts: this release/checkpoint operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "apps/operator/lib/release/release-config.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for apps/operator/lib/release/release-config.ts: this release/checkpoint operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "apps/operator/lib/release/release-content-scrub.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for apps/operator/lib/release/release-content-scrub.ts: this release/checkpoint operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "apps/operator/lib/release/retrofit-hive-to-gate.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for apps/operator/lib/release/retrofit-hive-to-gate.ts: this release/checkpoint operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "apps/operator/lib/release/runtime-workspace-build-coverage.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for apps/operator/lib/release/runtime-workspace-build-coverage.ts: this release/checkpoint operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "apps/operator/lib/release/seed-identity-guard.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for apps/operator/lib/release/seed-identity-guard.ts: this release/checkpoint operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/autoloop-release-readiness-action.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/harness/routines/autoloop-release-readiness-action.ts: this scheduled routine child is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/cargo-test-action.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/harness/routines/cargo-test-action.ts: this scheduled routine child is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/gc-verify-instances.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/harness/routines/gc-verify-instances.ts: this scheduled routine child is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/gitnexus-reindex-action.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/harness/routines/gitnexus-reindex-action.ts: this scheduled routine child is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/oddsmith-cron-shared.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/harness/routines/oddsmith-cron-shared.ts: runBounded is the shared bounded-spawn helper for the oddsmith routine actions (oddsmith-paper-cycle-action.ts, oddsmith-error-triage-autofix-action.ts), so every start it makes is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; the child is awaited, hard-bounded by timeoutMs with SIGTERM then SIGKILL across the whole process group, and leaves no independent resident queue, so adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/p2p-perf-actions.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/harness/routines/p2p-perf-actions.ts: this scheduled routine child is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/project-history-refresh-action.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/harness/routines/project-history-refresh-action.ts: this scheduled routine child is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/release-actions.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/harness/routines/release-actions.ts: this scheduled routine child is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/supervision-reconcile-action.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/harness/routines/supervision-reconcile-action.ts: this scheduled routine child is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/task-reconcile-action.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/harness/routines/task-reconcile-action.ts: this scheduled routine child is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/template-gym-runner.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/harness/routines/template-gym-runner.ts: this scheduled routine child is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/p2p/delegated-spawn-honor.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/p2p/delegated-spawn-honor.ts: this bounded support-path operation is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/p2p/sandbox/drill.ts",
    code: "resource-start-outside-admission",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for packages/operator-core/lib/p2p/sandbox/drill.ts: its finite sandbox drill subprocess is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "packages/operator-core/lib/p2p/sandbox/network-egress.ts",
    code: "resource-start-outside-admission",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for packages/operator-core/lib/p2p/sandbox/network-egress.ts: its finite sandbox drill subprocess is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "packages/operator-core/lib/p2p/sandbox/os-user-isolation.ts",
    code: "resource-start-outside-admission",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for packages/operator-core/lib/p2p/sandbox/os-user-isolation.ts: its finite sandbox drill subprocess is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "packages/operator-core/lib/release/checkpoint-qualification-transaction.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/release/checkpoint-qualification-transaction.ts: its only detected start is a `systemctl --user is-active <unit>` status probe that is bounded, awaited, and read for release/checkpoint control metadata; it spawns no worker, creates no resident queue, and must stay runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/release/checkpoint-required-ancestor.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/release/checkpoint-required-ancestor.ts: this release/checkpoint operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/release/dependency-generation-prebuild.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/release/dependency-generation-prebuild.ts: this release/checkpoint operation is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/release/green-stall-watchdog.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/release/green-stall-watchdog.ts: this watchdog probe/control operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/release/in-flight-retriage.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/release/in-flight-retriage.ts: this release/checkpoint operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/release/worktree-coverage-watchdog.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/release/worktree-coverage-watchdog.ts: this watchdog probe/control operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/search/import-graph.ts",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for packages/operator-core/lib/search/import-graph.ts: its graph traversal worklist is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "packages/operator-core/lib/sync/hyperbee/boot.ts",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for packages/operator-core/lib/sync/hyperbee/boot.ts: its pending-membership retry set is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "packages/operator-core/lib/sync/hyperbee/perf/child-driver.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/sync/hyperbee/perf/child-driver.ts: this finite performance harness subprocess is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/sync/hyperbee/perf/netem-inner.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/sync/hyperbee/perf/netem-inner.ts: this finite performance harness subprocess is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/sync/hyperbee/perf/peer-child.ts",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for packages/operator-core/lib/sync/hyperbee/perf/peer-child.ts: its bounded IPC line buffer is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "packages/operator-core/lib/sync/hyperbee/perf/provenance.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/sync/hyperbee/perf/provenance.ts: this finite performance harness subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/sync/hyperbee/perf/scenarios/netem.ts",
    code: "resource-start-outside-admission",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for packages/operator-core/lib/sync/hyperbee/perf/scenarios/netem.ts: its finite performance harness subprocess is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "packages/operator-core/lib/sync/hyperbee/seed-provider-corestore.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/sync/hyperbee/seed-provider-corestore.ts: this bounded git seed operation is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/sync/hyperbee/seed-provider-git.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/sync/hyperbee/seed-provider-git.ts: this bounded git seed operation is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/sync/hyperbee/substrate-ipc-client.ts",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for packages/operator-core/lib/sync/hyperbee/substrate-ipc-client.ts: its in-flight RPC correlation map is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "packages/operator-core/lib/sync/hyperbee/substrate-sidecar-spawn.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/sync/hyperbee/substrate-sidecar-spawn.ts: this bounded support-path operation is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/sync/pot-git/chunked-blob-scan.ts",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for packages/operator-core/lib/sync/pot-git/chunked-blob-scan.ts: this module EXISTS to impose the very bound the rule hunts for (WI-6254/WI-6258 — `partitionBlobsForScan` splits the admissible range into `chunkBytes` groups so that peak resident content is ONE chunk rather than the whole range, written after ref-announce's OOM took the whole sidecar down). The flagged structures are per-chunk working sets: `groups`/`current` live only across the partition pass, and `files`/`binaryOids` hold one `cat-file --batch` frame that the caller consumes and drops with the chunk — none survives the chunk or starts independent resident work. The one structure that DOES persist is bounded and instrumented rather than unbounded: the verdict memo is capped at `BLOB_SCAN_VERDICT_CACHE_MAX` (100_000) inside `pinModuleState`, `recallVerdict` re-inserts on hit for LRU recency, `rememberVerdict` evicts the oldest key while `size > max`, and the drops are counted and published through `getBlobScanCacheStats().evictions` — a capped memo publishing honest state, not a resident queue.",
  },
  {
    path: "packages/operator-core/lib/sync/pot-git/gate/shards.ts",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for packages/operator-core/lib/sync/pot-git/gate/shards.ts: its dependency traversal stack is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "packages/operator-core/lib/sync/pot-git/physical-drill-host-receipt.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/sync/pot-git/physical-drill-host-receipt.ts: this physical-drill evidence probe is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/sync/pot-git/physical-drill-phase-a.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/sync/pot-git/physical-drill-phase-a.ts: this physical-drill evidence probe is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/sync/pot-git/physical-drill-phase-b.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/sync/pot-git/physical-drill-phase-b.ts: this physical-drill evidence probe is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/sync/pot-git/storage.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/sync/pot-git/storage.ts: this bounded support-path operation is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/system-health/compute.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/system-health/compute.ts: this system-health probe/run is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/system-health/desktop-perf-scheduled-run.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/system-health/desktop-perf-scheduled-run.ts: this system-health probe/run is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/system-health/gui-e2e-surface-scheduled-run.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/system-health/gui-e2e-surface-scheduled-run.ts: this system-health probe/run is launched under the surrounding durable scheduler/operation, which owns admission, cancellation, and release; adding a second local receipt would double-count the same work.",
  },
  {
    path: "packages/operator-core/lib/system-health/single-primary-check.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/system-health/single-primary-check.ts: this system-health probe/run is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/affected-tests.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/affected-tests.mjs: its affected-test selection list is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "scripts/burst-probe.ts",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/burst-probe.ts: its finite benchmark fan-out list is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "scripts/cdp-inspector.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/cdp-inspector.mjs: its CDP request correlation map is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "scripts/check-assert-integrity.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/check-assert-integrity.mjs: its assertion graph worklist is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "scripts/check-bundle-budget.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-bundle-budget.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-conflict-markers.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-conflict-markers.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-declared-deps-extracted.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-declared-deps-extracted.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-di-seam-arity-strands.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-di-seam-arity-strands.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-docs-mirror.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-docs-mirror.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-drizzle-drift.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-drizzle-drift.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-env-feature-gates.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-env-feature-gates.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-fixed-but-open.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-fixed-but-open.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-fleet-auth.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-fleet-auth.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-format.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-format.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-full-replacement-mocks.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-full-replacement-mocks.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-guidance-returns-schema.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-guidance-returns-schema.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-host-bundle-builds.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-host-bundle-builds.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-js-syntax.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-js-syntax.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-licenses.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-licenses.mjs (WI-10003906): the license gate's children — `cargo metadata --locked` for the Rust leg, `tar -xf` + `syft` for the report-only installer leg — are synchronous execFileSync calls, each with an explicit timeout, awaited before the next step. It runs as a CI/release guard invoked from the command line, creates no detached worker or resident queue, and must stay runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-lint-guard-reachability.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-lint-guard-reachability.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-mac-bash-portability.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/check-mac-bash-portability.mjs: its portable-file traversal worklist is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "scripts/check-mdx.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-mdx.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-migration-fixture-drift.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-migration-fixture-drift.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-migration-forward-compat.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-migration-forward-compat.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-no-box-identity.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-no-box-identity.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-no-cdn-egress.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-no-cdn-egress.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-no-control-bytes.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-no-control-bytes.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-no-identity-literals.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-no-identity-literals.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-no-nul-in-source.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-no-nul-in-source.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-no-owner-name-tags.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-no-owner-name-tags.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-no-proc-path-fixture.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-no-proc-path-fixture.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-no-raw-harness-sentinel.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-no-raw-harness-sentinel.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-optional-seam-strands.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-optional-seam-strands.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-pipefail-sigpipe.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-pipefail-sigpipe.mjs: its single `git ls-files -z '*.sh'` enumeration of tracked shell scripts is bounded and awaited, creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-required-field-strands.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-required-field-strands.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-retired-resurrection.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-retired-resurrection.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-scope-defaults.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-scope-defaults.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-submodule-coverage-ignore.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-submodule-coverage-ignore.mjs (found by the gate on the frozen candidate, WI-212675): its only start is ONE synchronous, awaited `execFileSync('git', ['check-ignore', '-q', <probe path>])` per invocation — a CI/guard helper probing whether the coverage sentinel is gitignored. It is bounded by the single probe, holds no resident queue, and must remain runnable while productive capacity is pressured because it is part of the release gate's own lint leg.",
  },
  {
    path: "scripts/check-sidecar-fallback-reported.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-sidecar-fallback-reported.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-sql-guidance-justified.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-sql-guidance-justified.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-systemd-dropins-installed.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-systemd-dropins-installed.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-tracked-node-modules.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-tracked-node-modules.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-ungated-mug-kettle.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-ungated-mug-kettle.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-unreachable-tier-mock.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-unreachable-tier-mock.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-vacuous-negative-assertions.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-vacuous-negative-assertions.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-vimock-export-strands.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-vimock-export-strands.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-vite-externalized-warnings.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-vite-externalized-warnings.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-workspace-default-sql.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-workspace-default-sql.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/check-workspace-deps-complete.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-workspace-deps-complete.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/content-lint-runner.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/content-lint-runner.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/gen-agent-env.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/gen-agent-env.ts: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/gen-declarations.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/gen-declarations.ts: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/gen-doc-projections.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/gen-doc-projections.ts: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/gen-lib-api-docs.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/gen-lib-api-docs.ts: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/gen-tool-routing.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/gen-tool-routing.ts: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/guard-shared-tree-install.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/guard-shared-tree-install.mjs: its only detected start is a `git` plumbing read wrapped in execFileSync with an explicit 5s timeout, awaited and exiting immediately; this install guard must remain runnable precisely when capacity is pressured, and governing a metadata read would cost more than the admission record it would write.",
  },
  {
    path: "scripts/lexicon-residual-count.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lexicon-residual-count.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/lib/cargo-result.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/cargo-result.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/lib/declaration-export-parity.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/declaration-export-parity.ts: its only start is `ignoredUntrackedPaths`, one synchronous `git ls-files --others --ignored --exclude-standard --directory -z` metadata read per guard invocation (30s timeout, 64 MiB buffer, stdin ignored). It is awaited to completion, retains nothing between calls, starts no resident queue, and fails OPEN to an empty set so a git failure makes the parity guard walk more declarations, never fewer (EI-24553552437295746). A CI/guard metadata read must stay runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/lib/doc-projection.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/doc-projection.ts: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/lib/identity-leak-patterns.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/identity-leak-patterns.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/lib/passing-task-verdict-cache.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/lib/passing-task-verdict-cache.mjs: its TTL verdict cache is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "scripts/lib/related-tests.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/lib/related-tests.mjs: its `pending` module-graph traversal worklist is finite build-time correlation state, not a resident resource queue — every entry is popped and consumed, deduplicated against the `visited` set, and confined by `insideRoot` to tracked files under the repo root, so the queue is bounded by the finite import graph and starts no independent resident work.",
  },
  {
    path: "scripts/lib/tsc-baseline-gate.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/tsc-baseline-gate.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/lib/typecheck-fanout.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/typecheck-fanout.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/lint-affected-gate.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lint-affected-gate.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/lint-as-committed.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lint-as-committed.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/lint-tsc-workspaces.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lint-tsc-workspaces.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/measure-carry-note-population.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/measure-carry-note-population.mjs: its carry-note analysis list is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "scripts/npm-install-safe.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/npm-install-safe.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/okf-backfill-insights.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/okf-backfill-insights.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/patch-coverage.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/patch-coverage.ts: its only start is a single synchronous execFileSync `git diff --unified=0` that computes the added-line set for the patch-coverage report. execFileSync blocks its own caller, so the child is awaited by construction and cannot outlive the call; the file declares no interval, worker, detached spawn or unref, so it parks no resident queue and cannot materially increase residency while productive capacity is pressured.",
  },
  {
    path: "scripts/pg-autotune.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/pg-autotune.ts: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/proc-guard.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/proc-guard.mjs: its process inspection worklist is finite diagnostic/correlation state, not a resident resource queue; entries are consumed, evicted, or bounded by the caller's in-flight workload and start no independent resident work.",
  },
  {
    path: "scripts/publish-official-blueprints.mts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/publish-official-blueprints.mts: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/publish-workspace-host-artifacts.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/publish-workspace-host-artifacts.mjs: its single `gh auth token` credential read is bounded and awaited (synchronous execFileSync that prints and exits), creates no independent resident queue, and must remain runnable while productive capacity is pressured — the same class as scripts/check-fleet-auth.mjs.",
  },
  {
    path: "scripts/repair-stale-generated-artifacts.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/repair-stale-generated-artifacts.ts: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/report-cargo-tests.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/report-cargo-tests.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/scan-catastrophic-deletion-commits.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/scan-catastrophic-deletion-commits.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/stats-proof.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/stats-proof.ts: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/templates-mirror-sync.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/templates-mirror-sync.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/time-travel-probe.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/time-travel-probe.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/with-test-pg.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/with-test-pg.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  {
    path: "scripts/workspace-test.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/workspace-test.mjs: this CI/guard helper subprocess is bounded and awaited (or release/control metadata), creates no independent resident queue, and must remain runnable while productive capacity is pressured.",
  },
  // ── EI-21921643279095147: dead-target / dead-citation / drift sweep routines,
  // the frozen-candidate converge helper, three new CI lint scripts, and one
  // ephemeral manual diagnostic — all new P-016-lane files as of 2026-08-30.
  {
    path: "packages/operator-core/lib/harness/routines/dead-citation-sweep-action.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/harness/routines/dead-citation-sweep-action.ts: execFileAsync(git ls-files) lists tracked *.md/*.ts/etc paths as a cheap pre-filter before the in-module dead-citation scan; awaited, exits immediately, creates no independent resident queue.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/dead-target-probe.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/harness/routines/dead-target-probe.ts: execFileAsync(git rev-parse --verify --quiet HEAD^{commit}) and (git status --porcelain --untracked-files=no) are two bounded, explicitly-timed-out reads (probeTimeoutMs) run per install per sweep to classify an install's git object store as readable/corrupt/absent/unknown; both are awaited, read-only, and create no independent resident queue.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/frozen-candidate-drift-sweep-action.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/harness/routines/frozen-candidate-drift-sweep-action.ts: spawnSync(git log <candidate>..<branch> --name-only) is one bounded synchronous metadata read (explicit maxBuffer) used to compute a residual drift finding; it creates no independent resident queue.",
  },
  {
    // frozen-candidate-stays-frozen-through-all-fixes-2026-09-03 P-003 / D-010: this is the
    // read-only half of the former converge-repair-head.ts (renamed when the fast-forward plan
    // was deleted); the disposition below carries over with the code it describes.
    path: "packages/operator-core/lib/release/judged-sha-containment.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/release/judged-sha-containment.ts (formerly converge-repair-head.ts): the GitProbe implemented here is read-only — spawnSync(git rev-parse --verify --quiet), spawnSync(git merge-base --is-ancestor), and a rev-parse blob lookup. This module only answers whether the judged sha CONTAINS a path's blob; it performs no fast-forward, merge, or push itself, and creates no independent resident queue.",
  },
  {
    path: "packages/operator-core/lib/release/repair-head-admission.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/release/repair-head-admission.ts (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03 P-001, the ONE door a fix enters the frozen lineage through): every start is a short synchronous spawnSync('git', …) plumbing call awaited to completion — rev-parse, ls-tree, read-tree/update-index/write-tree against a throwaway temp index, diff-tree (the allowlist proof), and commit-tree — followed by one update-ref. It runs once per explicit `release:repair-queue { op:'admit' }` call under the caller's own admission, holds nothing resident, and creates no independent queue; a resident Governor lease here would gate the gate's own repair path behind the resource it is trying to un-wedge.",
  },
  {
    // WI-10004151 part 2: the admission-time dependency prediction the repair-queue admit door
    // consults before it lands a lockfile change on the frozen lineage.
    path: "packages/operator-core/lib/release/dependency-admission-prediction.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/release/dependency-admission-prediction.ts (WI-10004151): its only start is one execFile('bash', [dependency-generation.sh, '--predict-ref', <ref>]) per explicit `release:repair-queue { op:'admit' }` call, made inside that admit and awaited to completion. The --predict-ref mode is read-only against the generation store and the live trees: it fingerprints the ref's dependency inputs, checks for an existing selector or a live-tree match, and otherwise stages ONLY the ref's lockfiles into a scratch root (removed before it returns) for the dependency-lock-equivalence.mjs comparison. It never installs, never copies node_modules, never publishes, and takes no generation lock. The call is bounded by DEPENDENCY_PREDICTION_TIMEOUT_MS (30s, measured 12.6s at load ~90) plus a 4 MiB maxBuffer, after which the prediction degrades to verdict 'unknown' rather than waiting. It holds nothing resident and creates no independent queue. It is the same shape as the repair-head-admission.ts bypass it sits beside: a resident Governor lease here would gate the frozen lineage's own repair door behind the capacity the gate is trying to recover.",
  },
  {
    path: "scripts/check-integration-teardown-nullsafe.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-integration-teardown-nullsafe.mjs: execFileSync(git ls-files) discovers tracked *.integration.test.ts paths for this CI lint script (an explicit argv override takes precedence over the discovery call entirely); awaited, exits immediately, creates no independent resident queue.",
  },
  {
    path: "scripts/check-narrowing-gated-assertions.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-narrowing-gated-assertions.mjs: execFileSync(git ls-files --recurse-submodules) enumerates tracked files for this CI lint script's AST scan; awaited, exits immediately, creates no independent resident queue.",
  },
  {
    path: "scripts/check-registry-census-drift.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-registry-census-drift.mjs: execFileSync(git grep -l --fixed-strings) is a bounded tracked-file search over *.test.ts/*.test.tsx for this CI lint script; a non-zero exit (no match) is caught as an empty result. Awaited, exits immediately, creates no independent resident queue.",
  },
  {
    path: "scripts/check-deps-wiring-parity.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-deps-wiring-parity.mjs: this CI guard launches bounded, awaited helper probes to inspect dependency wiring and creates no resident production work.",
  },
  {
    path: "scripts/check-no-agent-intent-comments.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-no-agent-intent-comments.mjs: the child git listing is a bounded, awaited source-file enumeration for this CI comment guard, not a resident resource start.",
  },
  {
    path: "scripts/lib/disk-reservations.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/disk-reservations.mjs: its child-process calls are bounded filesystem and process metadata probes used by the reservation ledger, with no independent resident queue.",
  },
  {
    path: "scripts/lib/retry-tree-provenance.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/retry-tree-provenance.mjs: git metadata reads are bounded and awaited to classify retry-tree changes; they start no resident work.",
  },
  {
    path: "scripts/settle-probe.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/settle-probe.mjs: this probe runs bounded child commands to settle diagnostics and exits; it does not create an independent resident queue.",
  },
  {
    path: "apps/operator/lib/release/deploy-parity.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for apps/operator/lib/release/deploy-parity.ts: its only detected start is readRefUnification's promisified execFile('git', ['rev-parse', '--verify', '--quiet', ref]), called twice (local main, origin/main) to observe ref unification after a deploy; both calls are bounded, awaited, and read-only, spawn no worker, and create no independent resident queue — this honesty check must remain runnable while productive capacity is pressured.",
  },
  {
    path: "packages/operator-core/lib/harness/routines/nightly-release-cut-action.ts",
    code: "resource-start-outside-admission",
    disposition: "upstream",
    reason:
      "P-016 reviewed upstream disposition for packages/operator-core/lib/harness/routines/nightly-release-cut-action.ts: the file mixes two kinds of start, and this disposition covers both rather than exempting the heavier one by citing only the lighter. (1) The 30–40 minute detached desktop-release child is started through managedSpawn under runNightlyCut, which is itself gated by the durable harness_shared.routines schedule for system:nightly-release-cut AND a file-based single-flight lock (acquireNightlyLock/releaseNightlyLock) that already refuses a second concurrent cut and carries the child's own runtimeMaxSec/memoryMaxBytes ceilings in the task-manager's durable spawn ledger — a second local Governor receipt for that same admitted, ledgered, single-flight-locked child would double-count capacity already tracked upstream, not exempt it. (2) The remaining execFileSync calls (readDesktopVersionAtSource's git ls-tree/show, and the sourceSha git rev-parse) are separate, cheap, bounded, awaited metadata reads with no independent resident queue of their own.",
  },
  {
    path: "packages/operator-core/lib/release/gate-fire-drill-deps.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/release/gate-fire-drill-deps.ts: its detected starts are execFileSync('systemctl', ['--user', 'is-active'|'stop', unit]) — a bounded status probe and a bounded control/kill of the drill's own deliberately-launched checkpoint unit — both synchronous, awaited, and read/acted on for release-control metadata; neither spawns a worker or creates an independent resident queue, and the kill leg must remain runnable precisely when capacity is pressured (it is how the drill releases its own admitted test run).",
  },
  {
    path: "packages/operator-core/lib/release/sync-batch-delta-check-deps.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/release/sync-batch-delta-check-deps.ts: every detected start is the file's own run() wrapper around spawnSync with an explicit per-leg timeout (SYNC_DELTA_TIMEOUTS_MS, 30s–25min) and killSignal:'SIGTERM'; each call is synchronous, bounded, and resolves to the deps contract's undetermined value on any failure rather than a fake result, so no call can wedge the routine tick or leave an independent resident queue behind.",
  },
  {
    path: "packages/operator-core/lib/p2p/two-peer-commerce/commerce-peer-launcher.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for packages/operator-core/lib/p2p/two-peer-commerce/commerce-peer-launcher.ts: its local/SSH children are the measured subjects of one finite two-peer diagnostic run, not a resident service or queue; runTwoPeerCommerce awaits bounded ready/mesh/convergence windows and owns every handle, and its finally cleanup sends stop/end then SIGKILLs local stragglers and tears down remote children before the one-shot run returns.",
  },
  {
    path: "scripts/install-onnxruntime-node.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/install-onnxruntime-node.mjs: the single spawnSync child is the version-pinned onnxruntime package's installer, invoked as an npm postinstall under the serialized install:safe lifecycle; it is synchronous and awaited, returns only after the provider files are verified, and creates no detached worker or independent resident queue.",
  },
  {
    path: "scripts/lib/executed-source-map.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/executed-source-map.mjs: defaultExec performs one synchronous git diff --name-only metadata read for a cached commit pair with a 64 MiB output bound; it is awaited, starts no worker or resident queue, and an unavailable/unknown revision degrades honestly to null so selection keeps rather than drops tests.",
  },
  {
    path: "scripts/ensure-playwright-browsers.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/ensure-playwright-browsers.mjs: its only detected start is a single spawnSync('npx playwright install <browsers>') installer call, synchronous and awaited to completion before the function returns; it runs at most once per missing-browser check, creates no independent resident queue, and must remain runnable so e2e setup is not itself gated behind admission.",
  },
  {
    path: "scripts/check-behavioural-strands.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-behavioural-strands.mjs: its detected starts are execFileSync('git', ...) diff/blame plumbing reads and one spawnSync('npm', ['run','test:file',...]) that re-runs the specific stranded test files it names — each synchronous, awaited, and bounded by the finite strand set it just computed; this is a one-shot PostToolUse/CI lint invocation that creates no independent resident queue and must remain runnable so the guard is not itself gated behind admission.",
  },
  {
    path: "scripts/check-identity-keyed-classification.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-identity-keyed-classification.mjs: its only detected start is a single spawnSync('npx', ['vitest','run', CENSUS_TEST_REL]) that runs one fixed census test file, synchronous and awaited to completion; it is a one-shot CI lint check, creates no independent resident queue, and must remain runnable so the guard is not itself gated behind admission.",
  },
  {
    path: "scripts/check-lockfile-census.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-lockfile-census.mjs: its detected start is execFileSync(<sbom scanner>, ['scan', ...], { maxBuffer }) invoked once per lockfile subject over a finite subject list, synchronous and awaited; it is a one-shot CI census check, creates no independent resident queue, and must remain runnable so the guard is not itself gated behind admission.",
  },
  {
    path: "scripts/check-reachable-advisories.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/check-reachable-advisories.mjs: its detected start is execFileSync('npm', args, { maxBuffer }) run once to enumerate advisories, synchronous and awaited; it is a one-shot CI reachability check, creates no independent resident queue, and must remain runnable so the guard is not itself gated behind admission.",
  },
  {
    path: "scripts/p2p-witness-manifest.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/p2p-witness-manifest.mjs: every detected start is execFileSync('git', ['-C', repoRoot, ...]) cheap plumbing metadata reads that print and exit, synchronous and awaited; the manifest builder spawns no worker, creates no independent resident queue, and must remain runnable so manifest generation is not itself gated behind admission.",
  },
  {
    path: "scripts/lib/release-task-journal.mts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/lib/release-task-journal.mts: its two execFileSync calls are bounded, awaited git show/ls-tree metadata reads against one pinned source SHA; they start no resident worker or queue and must complete before the journal identity can be accepted.",
  },
  {
    path: "scripts/lib/stale-swap-leftovers.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/lib/stale-swap-leftovers.mjs: its `pending` array is a depth-first directory-walk worklist consumed to completion within a single synchronous scan of a finite tree, not a resident resource queue; it holds no work across calls and starts no independent resident work.",
  },
  {
    path: "scripts/lib/tracked-files.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/lib/tracked-files.mjs: its `pending` directory-walk worklist in the filesystem fallback is consumed within one synchronous enumeration and is hard-bounded by FALLBACK_MAX_ENTRIES (it throws rather than continue past the bound), so it is finite traversal state, not a resident resource queue, and starts no independent resident work.",
  },
  {
    path: "scripts/check-vacuous-negative-assertions.mjs",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for scripts/check-vacuous-negative-assertions.mjs: the Aho–Corasick `queue` is a finite trie-construction worklist consumed completely during one synchronous corpus scan; it is bounded by the static probe set for that invocation, retains no work across calls, and starts no independent resident work.",
  },
  {
    path: "scripts/vendor-gitnexus-patch.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/vendor-gitnexus-patch.mjs: this offline installation repair invokes synchronous execFileSync('patch') only for missing entries in the finite, version-pinned local patch manifest; --check starts no child. The child patches a known local package file and is awaited before its marker is verified, with no detached worker, network request, resident queue, or independently scheduled productive work.",
  },
  {
    path: "scripts/project-doc-parts.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for scripts/project-doc-parts.mjs: verifyDocClaims() makes exactly one synchronous spawnSync('npx', ['vitest','run',...,'lib/doc-claims/']) to run the doc-claims guards against the corpus this projection just wrote — the only moment that corpus exists on disk before git-sync sweeps it into the gate's candidate. It is not a cheap metadata read (~40s), but it cannot materially increase residency: spawnSync is awaited by construction, exactly one child exists and it must exit before the projection continues, and the child is handed PAPERCUSP_SKIP_DOC_CLAIMS_VERIFY=1 so it provably cannot recurse into a second verify. It runs only when a human or a release script projects doc parts (a handful of times a day), never on a scheduled or serving path, and starts no detached worker, network request, or resident queue. Two deliberate escape hatches (--no-verify, PAPERCUSP_SKIP_DOC_CLAIMS_VERIFY=1) let a mid-repair or non-interactive caller skip the start entirely.",
  },
  {
    path: "apps/operator/lib/release/green-checkpoint.ts",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for green-checkpoint.ts: createCheckpointTerminalEventBuffer's pending Map holds only terminal wake events from one qualification result, keyed by event/sha/runId; flush copies and clears it after the durable result is recorded or withholds it on failure. It is per-run notification correlation state, not resident work or an independently draining queue.",
  },
  {
    path: "packages/operator-core/lib/sync/hyperbee/snapshot-fold-offload.ts",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for snapshot-fold-offload.ts: SnapshotFoldWorker.open obtains the process-wide acquireSnapshotFoldSlot lease before new Worker, permits one fold worker at a time, sets a per-worker V8 heap limit, and releases the exact slot on failed start, close, or exit. The worker is parent-owned by one in-flight pot compaction; it creates no independent scheduled work.",
  },
  {
    path: "packages/operator-core/lib/sync/hyperbee/snapshot-fold-offload.ts",
    code: "unbounded-resident-queue",
    disposition: "semantic",
    reason:
      "P-016 reviewed semantic disposition for snapshot-fold-offload.ts: pending maps request IDs to reply promises inside the single leased worker; each reply or send failure deletes its entry, and close/worker failure rejects and clears all entries. It is active-call correlation, not a resident work backlog.",
  },
  {
    path: "scripts/check-installed-patch-postimages.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for check-installed-patch-postimages.mjs: runGit performs synchronous, awaited local Git metadata and hash reads over the finite tracked patch list during postinstall, each with a 30-second timeout and 32 MiB output bound. It starts no detached worker or resident queue and must run before the installed patch set is trusted.",
  },
  {
    path: "scripts/verify-identities-r7.mjs",
    code: "resource-start-outside-admission",
    disposition: "bypass",
    reason:
      "P-016 reviewed bypass disposition for verify-identities-r7.mjs: this operator-invoked acceptance journey awaits each Tauri command before the next UI step, bounds UI/poll commands to 45 seconds, liveness to 15 seconds, and its Git identity read to 5 seconds. It neither detaches children nor retains a resident queue after the journey ends.",
  },
]);
export const P016_DISPOSITION_REGISTRY = new Map(
  P016_REVIEWED_DISPOSITIONS.map(({ path, code, disposition, reason }) => [
    `${path}::${code}`,
    { disposition, reason },
  ]),
);

export const BYPASS_REGISTRY = new Map([
  ...P016_DISPOSITION_REGISTRY,
  [
    "packages/operator-core/lib/agent-identities/sink-evaluator.ts::hidden-or-static-capacity",
    {
      disposition: "semantic",
      reason:
        "P-013 reviewed semantic disposition for sink-evaluator.ts (portable-identity-packages P-010, D-009/D-017; WI-10003925): the only concurrency bound is SinkHostLimits.perSessionConcurrency, a per-session Semaphore that caps how many of ONE session's identity context providers are in flight at its sink invocations. A slot is released only when the provider's promise settles, so a provider that ignores its abort signal stays counted against its own session instead of becoming an orphan (D-009's hard admission cap). It is a sink-evaluation policy, like the per-invocation token and wall-clock budgets beside it, not a host capacity figure: the former static per-host Semaphore was removed, so host in-flight is at most perSessionConcurrency times the live sessions, and launched sessions already hold a durable Governor 'agent' admission lease (spawnGovernedAgentProcess). Providers run in-process inside the turn hook and may call only approved read-only bindings (D-009); any process such a binding starts is admitted at its own seam. sinkHostStatus() publishes live per-session and summed host in-flight counts.",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/testing/mutation-probe-fence.ts::unbounded-resident-queue",
    {
      disposition: "semantic",
      reason:
        "P-014 reviewed semantic disposition: this import-closure queue is a per-request graph traversal, not resident work. Each file enters once, the metafile input population is refused above CLOSURE_FILE_CAP (20,000), and the build has a 20-second deadline. It starts no independent task and is discarded when the one preflight returns.",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/work_items/complete.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "EI-23172979870567206: defaultCompletionTrackedness performs one synchronous read-only git ls-files --error-unmatch probe for one candidate path. It ignores output, has a 5s timeout and SIGKILL bound, retains no worker or queue, and must remain available for completion/recovery under pressure. The source predicate pins this exact call and refuses any additional resource start; unknown Git outcomes retain the durability warning.",
      matchesSource: matchesReviewedCompletionTrackedness,
    },
  ],
  [
    "apps/operator/bin/bundle-host-freshness.mjs::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "Every detected start is execFileSync('git', ...) for bounded repository identity and dirty-state metadata with an explicit 30s timeout; each call is synchronous and awaited, creates no worker or resident queue, and must remain available to reject a stale host bundle before launch.",
    },
  ],
  // ── cheap metadata reads: a git plumbing call that prints and exits ──────────
  // These are D-004's "cheap metadata operations that cannot materially increase
  // residency": single short-lived plumbing processes, awaited, no worker, no queue.
  // Governing them would add an admission round-trip per call to operations whose
  // whole cost is less than the admission record they would write.
  [
    "packages/operator-core/lib/agent-tools/plans/evidence-measurement-pin.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "defaultGitRunner awaits one local git plumbing read for a pinned measurement, with a 5-second timeout and 1 MiB output bound; it starts no resident worker or queue",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/plans/audit.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "git rev-parse HEAD — cheap metadata read, awaited, exits immediately",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/plans/git-history.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "git rev-parse --show-toplevel — cheap metadata read, awaited, exits immediately",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/plans/viewer-identity.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "git config user.email — cheap metadata read, awaited, exits immediately",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/work_items/fabricated-paths.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "git log -1 --format=%H --all over one path — cheap metadata read proving a cited path ever existed, awaited, exits immediately",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/work_items/untouched-paths.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "git status --porcelain and git log -1 --format=%ct over one path, each capped at a 5s timeout — cheap metadata reads, awaited, exit immediately",
    },
  ],
  [
    // NOT a git plumbing read, and deliberately not dispositioned as one: this
    // starts a node child running scripts/affected-tests.mjs. It is bypassed on
    // BOUNDEDNESS rather than cheapness — the start is awaited inside a single
    // Promise, carries an explicit timeout (AFFECTED_PLAN_TIMEOUT_MS), an 8MB
    // maxBuffer, and an optional AbortSignal, and the child prints its plan and
    // exits. It spawns no worker and leaves no resident queue, so it cannot
    // materially increase residency; the plan path deliberately RUNS NO TESTS.
    "packages/operator-core/lib/agent-tools/testing/affected-plan.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "node scripts/affected-tests.mjs --print-affected — bounded awaited child with an explicit timeout, maxBuffer and abort signal; prints the affected-test plan and exits, starting no worker and no resident queue",
    },
  ],
  [
    "apps/operator/bin/ascii-escape-bundle.mjs::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "node --check over one staged bundle — awaited syntax validation before atomic replacement, not resident runtime work",
    },
  ],
  // ── liveness/capability probes: ask the OS a question, start nothing ─────────
  [
    "apps/operator/bin/serve.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "ps -o command= -p <pid> — reads one process table row to identify a peer; starts no work",
    },
  ],
  [
    "packages/operator-core/lib/endpoint-route/routes/desktop/setup-pty-commands.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason: "which gh — binary-presence probe, exits immediately",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/computer/desktop-provisioner-core.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "xdpyinfo -display — X display liveness probe (spawnSync, stdio ignored, reads only the exit status); the provisioning start it guards is governed separately. Path repointed 2026-09-20: desktop-provisioner.ts was split on 2026-09-19 (6ec387d053) and is now a 1.7KB shim that only injects managedSpawn; the probe itself moved to desktop-provisioner-core.ts, so the old row went finding-absent while the new path carried an unreviewed finding",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/capability/exec-sandbox.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "bwrap /bin/true — one cached sandbox capability probe with a five-second timeout; starts no resident work",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/coordination/machine-capability-tags.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "docker info — one cached machine-capability probe with a 1.5-second timeout; starts no resident work",
    },
  ],
  // ── release / control path: D-004 names these explicitly ─────────────────────
  // Admission must never gate the path that RELEASES resources, or a saturated host
  // cannot recover: the kill that would free capacity would itself queue behind the
  // capacity it is trying to free. This is a deadlock, not an optimisation.
  [
    "packages/operator-core/lib/agent-tools/capability/bash-jobs.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "systemctl --user kill — cancellation/release of an already-admitted job; gating release on admission deadlocks recovery under saturation",
    },
  ],
  // ── P-015 sidecar/provider control and upstream-admitted starts ─────────────
  // P-001 (spawn-door-governor-migration-2026-08-31, D-006). console-spawn is
  // not a door — it is the low-level child-start PRIMITIVE that governed doors
  // wrap. resource-governor/spawn-execution.ts imports its result types (:3)
  // and spawnGovernedAgentProcess admits FIRST and then calls this as its
  // spawnProcess(context), so the lease is held by the caller across the
  // child's whole lifetime and re-admitting here would double-count one agent
  // start. Same shape as the psu-launcher.mjs row above. This row disposes of
  // the PRIMITIVE only: whether each importer (launch-agent, launch-on-plan,
  // goals/start, capability/terminal, fleet-headcount-action, goal-auto-start,
  // terminal-spawn) is itself admitted stays enforced against those files in
  // their own scanned prefixes — this is not a blanket exemption for callers.
  [
    "packages/operator-core/lib/console-spawn.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "spawnConsole/spawnHeadless are the child-start primitive that spawnGovernedAgentProcess wraps, not an independent door: admission and the lease are held by the calling seam across the child's lifetime (spawn-execution.ts imports this module's result types and calls it as spawnProcess(context)), so admitting here would double-count a single agent start; each importer remains separately enforced in its own scanned prefix",
    },
  ],
  [
    "packages/operator-core/lib/dbos/orchestrator-runner.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "spawnInvokeOnce is the DBOS pipeline agent-process chokepoint: its durable workflow supplies the receipt and its governorForBackend acquire supplies provider pacing; this direct child start is not a second resident queue, and re-admitting it would double-count the same agent turn",
    },
  ],
  [
    "packages/operator-core/lib/inference-gateway/credential-store.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "security/keychain credential lookup via awaited spawnSync; bounded metadata read that exits immediately and creates no resident provider work",
    },
  ],
  [
    "packages/operator-core/lib/inference-gateway/gateway-sidecar-spawn.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "systemd/loopback gateway sidecar supervision and crash-respawn control; the child gateway owns provider admission, while this control path must remain runnable during gateway pressure",
    },
  ],
  [
    "packages/operator-core/lib/inference-gateway/watchdog.mjs::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "watchdog systemctl restart is release/recovery control for an external gateway process; gating it on the failed gateway would deadlock recovery",
    },
  ],
  [
    "packages/operator-core/lib/inference-gateway/watchdog.mjs::hidden-or-static-capacity",
    {
      disposition: "semantic",
      reason:
        "admission.maxConcurrent is a live provider-gateway health gauge used only to detect a frozen queue; it is not configured or enforced by this watchdog, so no capacity ceiling is duplicated",
    },
  ],
  [
    "packages/operator-core/lib/memory/embed-sidecar-spawn.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "supervised sidecar child lifecycle (startup/respawn/release control); each sidecar request unit is admitted by embed-sidecar-server.ts and re-admitting the supervisor would double-count the process",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/dev/restart.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "delayed systemd restart — control/recovery path that releases the current operator and must remain runnable under saturation",
    },
  ],
  [
    "packages/operator-core/lib/endpoint-route/routes/harness/features.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "git worktree remove + branch delete — feature teardown releases filesystem/process coordination state and must remain runnable under saturation",
    },
  ],
  // ── bounded benchmark/diagnostic work ───────────────────────────────────────
  // These paths either inspect metadata or drain a finite, caller-owned fixture.
  // They do not create resident service work and therefore do not need a second
  // durable admission receipt; keep the exemption explicit and reviewable.
  [
    "packages/operator-core/lib/dbos/bootstrap.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "git rev-parse used only to locate the canonical checkout before arming a watchdog; no resident work starts",
    },
  ],
  [
    "packages/operator-core/lib/memory/audit-anchors.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "git ls-files builds a bounded read-only index of repository anchors; it starts no resident work",
    },
  ],
  [
    "packages/operator-core/lib/memory/bench/wi-6512-known-item-replay-cli.ts::unbounded-resident-queue",
    {
      disposition: "semantic",
      reason:
        "finite in-memory benchmark pair list is test workload enumeration, not a resident production queue; evidence required",
    },
  ],
  [
    "packages/operator-core/lib/memory/op-deadline.ts::unbounded-resident-queue",
    {
      disposition: "semantic",
      reason:
        "pending promise set tracks already-started memory operations until settlement; it is a lifecycle ledger, not queued work; evidence required",
    },
  ],
  [
    "packages/operator-core/lib/inference-gateway/stall-waker.ts::unbounded-resident-queue",
    {
      disposition: "semantic",
      reason:
        "pending map is a TTL-bounded stall observation set; it never queues resource starts; evidence required",
    },
  ],
  // ── P-013 agent-process-memory lane (D-026 remediation) ──────────────────────
  // The lane's governed seams are pty-bridge.ts:192 (beginGovernedExecution,
  // admissionClass 'process' -> spawn :247), resource-governor/spawn-execution.ts:46
  // (admissionClass 'agent'), and fleet/sidecar-exec-process.ts:96. The rows below are
  // the residue those seams deliberately do NOT cover: probes, release/control calls,
  // and correlation ledgers. Each states what its own process actually does.
  [
    "apps/operator/scripts/psu-launcher.mjs::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        'launcher CLI, 9 detected starts, every one a bounded probe or an interactive install: curl operator-health (:225,:250,:4390,:8214), systemctl unit query (:241), gh auth token (:5136), ps -o tty= (:6722), which-bin probe (:11660), runInstallerInherit (:11739, awaited, stdio inherit, one backend install). ⚠ EVIDENCE OF WHAT THIS ROW DOES NOT COVER: the file ALSO starts the real resident agent wrapper at spawnInherit (:8342) via spawnImpl(wrapperBin, args, {detached:true}) (:8367), where `spawnImpl = spawn` is defaulted at :8347 — the START regex cannot match an aliased call, so that start is registered here by hand rather than detected. It is admitted upstream when operator-launched (capability/launch-agent.ts:1250 -> spawnGovernedAgentProcess -> beginGovernedExecution admissionClass "agent"); a human typing psu in a terminal is the operator entry path itself, not fleet-initiated fan-out. Detector gap tracked separately; evidence required',
    },
  ],
  [
    "apps/operator/scripts/psu-pty-host.mjs::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        'pty.spawn (:3743) starts the launched agent\'s OWN child under the host that already represents it; admission happened upstream at capability/launch-agent.ts:1250 -> spawnGovernedAgentProcess -> beginGovernedExecution admissionClass "agent" (spawn-execution.ts:46). Re-admitting the same logical agent inside its own host would double-count it. The other two START hits are a detector coincidence, not starts: turnCoalescer.admit (:4820) and staleFireGuard.admit (:5041) are local fold/dedupe methods matched by the `.admit(` alternative; evidence required',
    },
  ],
  [
    "packages/operator-core/lib/agent-auth-detect.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "seven credential-presence probes, all spawnSync (awaited by construction) with explicit timeouts and no resident work: security find-generic-password (:42,:87), security dump-keychain (:100), a keychain read (:130), gh auth status (:312), git config --get-all credential.helper (:318). Same cheap-metadata class as agent-tools/plans/viewer-identity.ts; evidence required",
    },
  ],
  [
    "packages/operator-core/lib/agent-bin-detect.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        'spawnSync("which", [bin]) (:111) — single binary-presence probe, awaited, exits immediately. Identical to the already-registered setup-pty-commands.ts "which gh" row; evidence required',
    },
  ],
  [
    "packages/operator-core/lib/agent-state-divergence.ts::unbounded-resident-queue",
    {
      disposition: "semantic",
      reason:
        "pending.push(c) (:704) appends to a LOCAL DivergenceCall[] that cuts an already-materialized call timeline into consecutive-failure episodes; it is reset to [] at every success and discarded when the loop ends. It is an analysis buffer over finite input, bounded by the timeline being read, and starts nothing; evidence required",
    },
  ],
  [
    "packages/operator-core/lib/fleet/spawner-ipc-client.ts::unbounded-resident-queue",
    {
      disposition: "semantic",
      reason:
        "this.pending.set(id, {resolve, reject}) (:186) is an in-flight RPC CORRELATION map, not queued work: every entry is self-evicting via a 30s default timeout that deletes it (:176-178) and both settle paths delete it. Bounded by concurrently in-flight RPCs; the requests it correlates were already started. Same lifecycle-ledger shape as memory/op-deadline.ts; evidence required",
    },
  ],
  [
    "packages/operator-core/lib/fleet/spawner-sidecar-spawn.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "killOwnedScope (:62) execFileSync systemctl --user kill of the sidecar's OWN managed scope — a RELEASE/control call that frees residency. Synchronous on purpose: its call sites are a process-exit hook and a timer callback, neither of which has an async turn left. Gating release on admission deadlocks recovery under saturation, exactly as the registered bash-jobs.ts row states; evidence required",
    },
  ],
  // ── binding-aware detector dispositions (EI-21714833795753624) ─────────────
  // These aliases are now detected by hasCalledResourceStartAlias. Each is a
  // bounded probe, metadata read, setup write, or user-requested git operation;
  // none creates a resident worker or an in-memory queue of work.
  [
    "packages/operator-core/lib/agent-tools/capability/bash_output.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "scopeExecFile is promisify(execFile) used for bounded systemd/cgroup liveness metadata; it probes an already-recorded task and starts no resident work.",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/deploys/vintage.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "pexec is promisify(execFile) used for bounded git ref/vintage reads; the command is awaited and creates no resident queue.",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/dev/systemd-service-probe.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "run is promisify(execFile) for bounded systemd/ps start-time diagnostics; it reads service metadata and starts no resident work.",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/git_sync/run.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "execFileP is promisify(execFile) for a bounded git rev-parse preflight around the durable git-sync routine; no independent resident worker starts.",
    },
  ],
  [
    "packages/operator-core/lib/agent-tools/setup/set_git_identity.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "exec is promisify(execFile) for two awaited user-requested git-config writes; setup metadata is finite and does not create resident work.",
    },
  ],
  [
    "packages/operator-core/lib/endpoint-route/routes/desktop/git-identity.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "exec is promisify(execFile) for bounded git-config reads/writes in the user-facing setup endpoint; each command is awaited and finite.",
    },
  ],
  [
    "packages/operator-core/lib/endpoint-route/routes/desktop/preflight.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "exec is promisify(execFile) for bounded binary --version and bundled-path probes in preflight; it starts no resident work.",
    },
  ],
  [
    "packages/operator-core/lib/endpoint-route/routes/desktop/setup-status.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "exec is promisify(execFile) for bounded git identity metadata probes in setup-status; failures degrade to status and no queue is retained.",
    },
  ],
  [
    "packages/operator-core/lib/endpoint-route/routes/harness/feature-views.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "execFileP is promisify(execFile) for bounded, user-requested git diff/stat reads with maxBuffer limits; output is returned, not queued as resident work.",
    },
  ],
  [
    "packages/operator-core/lib/endpoint-route/routes/harness/notes-diff.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "execFileP is promisify(execFile) for bounded git diff/status reads with maxBuffer limits in a user-facing endpoint; no resident worker remains.",
    },
  ],
  [
    "packages/operator-core/lib/endpoint-route/routes/harness/project-history-source.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "defaultGit() wraps execFile for ONE bounded `git log` per History page: PROJECT_HISTORY_GIT_TIMEOUT_MS (20s) and a 32MB maxBuffer, awaited, its output returned and parsed in-process with no resident worker left behind. This file exists to REDUCE residency rather than add it — it replaced a CLI provider that shelled out once per plan and per work-item and then walked the entire commit graph with --name-only (~290s against a 90s child budget, hundreds of children, WI-10001548 defect A) with a single grep-bounded child per page.",
    },
  ],
  [
    "packages/operator-core/lib/endpoint-route/routes/harness/prs.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "execFileP is promisify(execFile) for a bounded git-origin metadata read used to render PR context; the command is awaited and finite.",
    },
  ],
  [
    "packages/operator-core/lib/endpoint-route/routes/harness/sync.ts::resource-start-outside-admission",
    {
      disposition: "bypass",
      reason:
        "execFileAsync is promisify(execFile) for bounded, user-requested git fetch/rebase/status operations in a durable user worktree; git owns recovery state and no in-memory resident queue is created.",
    },
  ],
  // ── reviewed retry around a receipt-producing write (EI-21850494041821321) ───
  [
    "packages/operator-core/lib/resource-governor/queue.ts::retry-around-receipt",
    {
      disposition: "semantic",
      reason:
        "The one retry in this file wraps store.enqueue — the write that CREATES the receipt — via acquireWithContentionRetry, and is keyed by idempotencyKey: a pg lock/statement timeout aborts its transaction so nothing is committed, and if an earlier attempt HAD committed, the retry returns that same row and the requestFingerprint check still raises a genuine idempotency conflict. Non-contention faults propagate on the first attempt. Admission is PRE-execution, so dropping the record would mean running ungoverned; the retry is the correct lever. The detector recognizes the retry callback and receipt-producing enqueue operation rather than unrelated option-type fields.",
    },
  ],
]);

function registryKey(path, code) {
  return `${path}::${code}`;
}

/**
 * Build one inventory row. Every descriptive field is REQUIRED and none has a
 * default — deliberately.
 *
 * The previous signature defaulted fanOut/durableSource/telemetry/contextAndRelease/
 * currentCaps/writerEvidence to five shared constants, so every lane inherited
 * identical prose and `validateInventory`'s presence check passed while the
 * inventory described nothing (auditSeq 9, D-026). Removing the defaults is what
 * makes that regression structurally impossible rather than merely detected: a new
 * lane cannot be decorative by omission, because omission no longer compiles into
 * boilerplate — it produces `undefined` and trips `inventory-missing`.
 */
function inventory(row) {
  return Object.freeze({
    disposition: "govern",
    ...row,
    enforcement: row.enforcement ?? `pending-${row.migration}`,
    sites: Object.freeze((row.sites ?? []).map((s) => Object.freeze(s))),
  });
}

const START_VERBS = ["spawn", "spawnSync", "fork", "execFile", "execFileSync"];
const START_NON_VERB = /new\s+(?:Worker|Piscina)\s*\(|\.admit\s*\(/;
// A start verb is also the natural NAME for a caller-supplied callback: a pacing,
// retry, or instrumentation wrapper takes `spawn: () => Promise<T>` and calls
// `spawn()` while starting nothing itself. The real child process is started by the
// caller it wraps, at a site this same scan already covers, so counting the wrapper
// as a start reports the one start twice and pins the finding on the file that does
// not make it. That is a detector misfire, and BYPASS_REGISTRY deliberately refuses
// to absorb misfires ("a detector that misfires is a detector bug to fix, and
// registering it would preserve the bug behind a row that reads as judgement"), so
// it is narrowed HERE rather than dispositioned.
//
// The exemption is deliberately hard to obtain, because it must not become a way to
// launder a real start: the identifier has to be declared as a function-typed
// binding in this same file (`spawn: (`), AND the file must never import or require
// that name. A file that pulls in the real primitive keeps its finding even when it
// also happens to carry a callback parameter of the same name.
function isLocalCallbackBinding(code, name) {
  if (!new RegExp(`\\b${name}\\s*:\\s*\\(`).test(code)) return false;
  return !new RegExp(`\\b(?:import|require)\\b[^;\\n]*\\b${name}\\b`).test(
    code,
  );
}
function hasResourceStart(code) {
  if (START_NON_VERB.test(code)) return true;
  for (const verb of START_VERBS) {
    if (!new RegExp(`\\b${verb}\\s*\\(`).test(code)) continue;
    if (isLocalCallbackBinding(code, verb)) continue;
    return true;
  }
  return false;
}
// Direct-call matching misses dependency-injected aliases such as
// `const spawnImpl = spawn` / `spawnImpl(...)` and
// `const exec = promisify(execFile)` / `exec(...)`. Match only identifiers
// syntactically bound to one of the real child-process starts, then require a
// call to that same identifier. Widening by name (`spawn[A-Z]...`) is unsafe:
// it turns ordinary domain words such as `spawnRowKind` into false starts.
const ALIAS_BIND =
  /\b([A-Za-z_$][\w$]*)\s*[=:]\s*(?:promisify\s*\(\s*)?(?:spawn|spawnSync|fork|execFile|execFileSync)\s*[,\)\s;}]/g;
function hasCalledResourceStartAlias(code) {
  const aliases = new Set();
  for (const match of code.matchAll(ALIAS_BIND)) {
    const name = match[1];
    if (/^(?:spawn|spawnSync|fork|execFile|execFileSync)$/.test(name)) continue;
    aliases.add(name);
  }
  for (const name of aliases) {
    const escaped = name.replace(/\$/g, "\\$");
    if (new RegExp(`\\b${escaped}\\s*\\(`).test(code)) return true;
  }
  return false;
}
const GOVERNED =
  /\bGovernor\.admit\b|\bgovernor\.admit\s*\(|\bbeginGovernedExecution\s*\(|\bwithGovernedExecution\s*\(|\brunGovernedOperation\s*\(|\brunGovernedTestProcess\s*\(|\bAdmissionContext\b|\bvalid(?:ated)?\s+local\s+lease\b/i;
const RELEASE = /\.release\s*\(|\bAdmissionRelease\b/;
const STATIC_CAP =
  /\b(?:maxConcurrent|maxWorkers|maxQueue|maxSimultaneous|capacityCeiling)\b\s*(?:[:=]|\?\?)\s*\d+/i;
const HIDDEN_SEMAPHORE = /\b(?:Semaphore|semaphore|p-limit|Bottleneck)\b/;
const DURABLE = /\b(?:work_items|durable|receipt|postgres|DBOS)\b/i;
// Match collections whose identifier says they are a queue/backlog.  The old
// `(?:queue|pending|backlog)\w*` prefix also matched diagnostic Sets such as
// `pendingGradingAuditTargetIds.add(...)`: that is an ID accumulator, not a
// resident work queue, and made the active P-014 lane fail on its own gate
// bookkeeping.  Keep the exact `pending` spelling for the small conventional
// case, while requiring a Queue/Backlog suffix for compound names so pending
// IDs, tokens, and targets do not look like resident work.
const RESIDENT_QUEUE =
  /\b(?:queue|backlog|pending|[A-Za-z_$][\w$]*(?:Queue|Backlog))\.(?:push|set|add)\s*\(/;
const RECEIPT_WRITE =
  /\b(?:[A-Za-z_$][\w$]*\.)*(?:enqueue|enqueueReceipt|createReceipt|persistReceipt|insertReceipt|saveReceipt|writeReceipt|storeReceipt)\s*\(/i;
const DISHONEST_METRIC =
  /\b(?:oldestAgeMs|arrivalRatePerSec|drainRatePerSec|confidence)\b[^\n]{0,80}\?\?\s*0\b/;

/**
 * Return the closing parenthesis for a call whose opening parenthesis is at
 * `openIndex`. The source has already gone through stripCommentsAndStrings, so
 * parentheses in comments, strings, and regex literals cannot perturb this
 * small structural walk.
 */
function matchingCallEnd(code, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < code.length; index += 1) {
    if (code[index] === "(") {
      depth += 1;
    } else if (code[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Detect a retry construct only when it invokes a callback that performs a
 * receipt-producing operation. Identifier proximity is not enough: unrelated
 * fields such as `admissionRetryBackoffsMs` and `receiptId` can sit next to
 * each other in a type declaration without any retry or write taking place.
 */
function hasRetryAroundReceipt(code) {
  for (const match of code.matchAll(
    /\b(?:retry|again|[A-Za-z_$][\w$]*(?:retry|again)[A-Za-z_$\d]*)\s*\(/gi,
  )) {
    const openIndex = match.index + match[0].lastIndexOf("(");
    const closeIndex = matchingCallEnd(code, openIndex);
    if (closeIndex < 0) continue;
    const args = code.slice(openIndex + 1, closeIndex);
    if (!/(?:=>|\bfunction\s*\()/i.test(args)) continue;
    if (RECEIPT_WRITE.test(args)) return true;
  }
  return false;
}

export function inspectGovernorSource(source) {
  const code = stripCommentsAndStrings(source, "fixture.ts");
  const findings = [];
  if (
    (hasResourceStart(code) || hasCalledResourceStartAlias(code)) &&
    !GOVERNED.test(code)
  )
    findings.push("resource-start-outside-admission");
  if (
    (STATIC_CAP.test(code) || HIDDEN_SEMAPHORE.test(code)) &&
    !/transient feedback state|physical upstream constraint/i.test(code)
  ) {
    findings.push("hidden-or-static-capacity");
  }
  if (RESIDENT_QUEUE.test(code) && !DURABLE.test(code))
    findings.push("unbounded-resident-queue");
  if (hasRetryAroundReceipt(code)) findings.push("retry-around-receipt");
  if (
    /\bgovernor\.admit\s*\(/.test(code) &&
    (!/\bAdmissionContext\b/.test(code) || !RELEASE.test(code))
  ) {
    findings.push("missing-admission-context-or-release");
  }
  if (DISHONEST_METRIC.test(code))
    findings.push("undefined-partial-or-stale-metric-coerced-to-zero");
  return findings;
}

/**
 * A metadata disposition must not cover a later resident start in the same file.
 * Compare parsed call syntax (not comments/formatting), then rescan with ONLY that
 * reviewed call removed. A changed command, weakened bound, or another detected
 * start therefore restores the original finding instead of inheriting the bypass.
 */
function matchesReviewedCompletionTrackedness(source) {
  const parse = (text) =>
    ts.createSourceFile("complete.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const file = parse(source);
  if (file.parseDiagnostics.length) return false;
  const calls = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "execFileSync"
    ) calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (calls.length !== 1) return false;
  const call = calls[0];
  let enclosing = call.parent;
  while (enclosing && !ts.isFunctionDeclaration(enclosing)) enclosing = enclosing.parent;
  if (enclosing?.name?.text !== "defaultCompletionTrackedness") return false;
  const expected = parse(`execFileSync('git', ['-C', repoRoot, 'ls-files', '--error-unmatch', '--', repoRelativePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 5_000,
    killSignal: 'SIGKILL',
  });`);
  const printer = ts.createPrinter({ removeComments: true });
  const print = (node, root) => printer.printNode(ts.EmitHint.Expression, node, root);
  if (print(call, file) !== print(expected.statements[0].expression, expected)) return false;
  const remaining = source.slice(0, call.getStart(file)) + "undefined" + source.slice(call.end);
  return !inspectGovernorSource(remaining).includes("resource-start-outside-admission");
}

/**
 * P-001 acceptance is that each admission SITE names its own resource dimensions,
 * fan-out, durable source, telemetry, context/release path and the cap to delete.
 *
 * A PRESENCE check cannot enforce that, and the audit (auditSeq 9) proved it: the
 * seven lanes shared five identical boilerplate constants, satisfied `required`
 * completely, and carried no per-site information whatsoever. A field that every
 * row can satisfy with the SAME string is not describing anything — it is a check
 * that cannot fail. So presence is necessary and no longer sufficient:
 *
 *   1. NO SHARED BOILERPLATE. If two rows give byte-identical prose for a
 *      descriptive field, neither row is describing itself. Duplicate ⇒ finding.
 *   2. SITES ARE NAMED, NOT IMPLIED. Every governed lane enumerates the concrete
 *      admission sites it owns; a lane that names none is a path prefix, not an
 *      inventory.
 *   3. NAMED SITES MUST EXIST. `pathExists` (injected by scanTree, omitted by pure
 *      callers) resolves each site against the tree, so the inventory cannot drift
 *      into citing files that were renamed or deleted — the decorative-inventory
 *      failure one level up from the decorative-allowlist one.
 */
const DESCRIPTIVE_FIELDS = [
  "fanOut",
  "durableSource",
  "telemetry",
  "contextAndRelease",
  "currentCaps",
  "writerEvidence",
];

export function validateInventory(
  rows = RESOURCE_GOVERNOR_INVENTORY,
  { pathExists = null } = {},
) {
  const findings = [];
  const ids = new Set();
  const required = [
    "id",
    "disposition",
    "enforcement",
    "paths",
    "resourceDimensions",
    "fanOut",
    "durableSource",
    "telemetry",
    "contextAndRelease",
    "currentCaps",
    "writerEvidence",
    "sites",
  ];
  // (1) shared boilerplate across rows — the exact defect auditSeq 9 found.
  for (const field of DESCRIPTIVE_FIELDS) {
    const seen = new Map();
    for (const row of rows) {
      const value = row[field];
      if (typeof value !== "string" || value === "") continue;
      const norm = value.trim().replace(/\s+/g, " ");
      if (!seen.has(norm)) seen.set(norm, []);
      seen.get(norm).push(row.id);
    }
    for (const [, sharers] of seen) {
      if (sharers.length > 1)
        findings.push(
          `inventory-boilerplate:${field}:${sharers.sort().join("+")}`,
        );
    }
  }
  for (const row of rows) {
    if (ids.has(row.id)) findings.push(`duplicate-inventory:${row.id}`);
    ids.add(row.id);
    for (const field of required) {
      const value = row[field];
      if (
        value == null ||
        value === "" ||
        (Array.isArray(value) && value.length === 0)
      )
        findings.push(`inventory-missing:${row.id}:${field}`);
    }
    // (2)+(3) named sites, and they must resolve against the tree.
    for (const site of row.sites ?? []) {
      if (!site?.path || !site?.start)
        findings.push(`inventory-site-incomplete:${row.id}`);
      else if (pathExists && !pathExists(site.path))
        findings.push(`inventory-site-missing:${row.id}:${site.path}`);
    }
    if (
      !["govern", "bypass", "semantic", "upstream", "false-positive"].includes(
        row.disposition,
      )
    )
      findings.push(`inventory-disposition:${row.id}`);
    if (
      ["bypass", "semantic", "upstream"].includes(row.disposition) &&
      !/evidence|required|constraint|registry/i.test(row.writerEvidence ?? "")
    ) {
      findings.push(`inventory-writer-evidence:${row.id}`);
    }
  }
  return findings;
}

export function scanInventory(
  files,
  { migrations = [], validateRegistry = false } = {},
) {
  const selected = RESOURCE_GOVERNOR_INVENTORY.filter(
    (row) =>
      row.enforcement === "active" ||
      migrations.some(
        (migration) => row.enforcement === `pending-${migration}`,
      ),
  );
  const findings = [];
  const scannedPaths = new Set();
  const observedRegistryKeys = new Set();
  for (const [path, source] of files) {
    // The guard's own regex literals/documentation intentionally contain
    // detector vocabulary (for example the retry receipt pattern). Scanning
    // this implementation as product code would make its self-description a
    // finding and would force a self-exemption row. Exclude only this exact
    // canonical scanner path; all caller paths remain strictly dispositioned.
    if (path === RESOURCE_GOVERNOR_SCANNER_PATH) continue;
    if (
      !selected.some((row) =>
        row.paths.some((prefix) => path.startsWith(prefix)),
      )
    )
      continue;
    scannedPaths.add(path);
    for (const code of inspectGovernorSource(source)) {
      const key = registryKey(path, code);
      observedRegistryKeys.add(key);
      const disposition = BYPASS_REGISTRY.get(key);
      if (!disposition || (disposition.matchesSource && !disposition.matchesSource(source)))
        findings.push(`${path}:${code}`);
    }
  }
  if (validateRegistry) {
    for (const key of BYPASS_REGISTRY.keys()) {
      const separator = key.lastIndexOf("::");
      const path = key.slice(0, separator);
      const selectedPath = selected.some((row) =>
        row.paths.some((prefix) => path.startsWith(prefix)),
      );
      if (!selectedPath) continue;
      if (!scannedPaths.has(path)) {
        if (validateRegistry === "strict")
          findings.push(`stale-bypass-registry:${key}:path-not-scanned`);
        continue;
      }
      if (!observedRegistryKeys.has(key))
        findings.push(`stale-bypass-registry:${key}:finding-absent`);
    }
  }
  return findings;
}

export function scanActiveInventory(files, options = {}) {
  return scanInventory(files, options);
}

function scanTree() {
  const { files, unscanned } = listTrackedFiles(ROOT);
  const sourceFiles = [];
  for (const path of files) {
    if (
      !/\.(?:ts|tsx|mts|mjs)$/.test(path) ||
      /\.(?:test|spec)\./.test(path) ||
      path.includes("/_retired/")
    )
      continue;
    try {
      sourceFiles.push([path, readFileSync(`${ROOT}${path}`, "utf8")]);
    } catch {
      /* concurrent deletion */
    }
  }
  const tracked = new Set(files);
  const enforced = RESOURCE_GOVERNOR_INVENTORY.filter(
    (row) => row.enforcement === "active",
  );
  const pending = RESOURCE_GOVERNOR_INVENTORY.filter(
    (row) => row.enforcement !== "active",
  );
  const scannedCount = sourceFiles.filter(([path]) =>
    enforced.some((row) => row.paths.some((prefix) => path.startsWith(prefix))),
  ).length;
  return {
    findings: [
      ...validateInventory(RESOURCE_GOVERNOR_INVENTORY, {
        pathExists: (path) => tracked.has(path),
      }),
      ...scanActiveInventory(sourceFiles, { validateRegistry: "strict" }),
    ],
    unscanned,
    coverage: {
      enforced,
      pending,
      scannedCount,
      sourceCount: sourceFiles.length,
    },
  };
}

function main() {
  const { findings, unscanned, coverage } = scanTree();
  // A lane sitting at `pending-P-NNN` is NOT scanned, so "8 lanes inventoried"
  // read as "8 lanes checked" while only two were — the exact misreading that let
  // the agent-process lane stay blind through a whole audit (D-026). Report what
  // was ENFORCED and name what was not, so the gate's own output can never again
  // present coverage it does not have.
  const coverageLine =
    `${coverage.enforced.length}/${RESOURCE_GOVERNOR_INVENTORY.length} lanes ENFORCED ` +
    `(${coverage.scannedCount}/${coverage.sourceCount} source files scanned)` +
    (coverage.pending.length
      ? `; ${coverage.pending.length} NOT ENFORCED and therefore UNSCANNED: ` +
        coverage.pending.map((r) => `${r.id}(${r.enforcement})`).join(", ")
      : "");
  // WI-6776: the submodule half of coverage was hand-rolled as a bare COUNT
  // ("3 unscanned submodule(s)"), which says a gap exists but not why it exists or
  // what it costs. In a release-shaped checkout (papercusp-checkpoint /
  // papercusp-release) submodule source is git archive-extracted, so there is no .git
  // to descend into and this scan reaches ZERO submodule files — about 22% of the tree
  // — while still printing a confident ✓. describeUnscanned() diagnoses the cause by
  // TREE SHAPE (present-but-not-a-repo vs absent vs uninitialized) instead of guessing
  // "not initialized" for all three, so the success line can no longer overstate itself.
  const unscannedNote = describeUnscanned(unscanned);
  if (findings.length === 0) {
    console.log(
      `[resource-governor-enforcement] OK — ${coverageLine}; active writer evidence clean.${unscannedNote}`,
    );
    return;
  }
  console.error(
    `[resource-governor-enforcement] coverage: ${coverageLine}${unscannedNote}`,
  );
  console.error(
    "[resource-governor-enforcement] FAIL — capless admission/queue/state policy violations:",
  );
  for (const finding of findings) console.error(`  ${finding}`);
  console.error(
    "\nDo not add a new cap. Route the start through Governor.admit or a registered valid lease, preserve its durable receipt and AdmissionContext, release exact actual cost, and publish honest unknown/stale state. Semantic/policy/upstream constraints require explicit writer evidence.",
  );
  process.exitCode = 1;
}

if (isCliEntry(import.meta.url)) main();
