/**
 * Real, non-interactive readiness probes for the three agents a workspace host must be able to
 * execute (P-046 / WI-41711 / D-230).
 *
 * THE GAP THIS CLOSES. `WorkspaceHostInitializationCanaryEvidence.agents` carries
 * `{ claude: { ready: true, verificationKind: … }, … }`, and
 * `validateWorkspaceHostInitializationCanary` checks that readiness. Nothing originally derived
 * the old authenticated booleans from anything. The type makes `false` unrepresentable, so the validator's agent
 * check could only ever fail if a caller went out of its way to construct invalid evidence —
 * i.e. a green canary verdict proved nothing at all about whether Claude, Codex or OMP had
 * actually authenticated. This module makes readiness the OUTPUT of a probe that has to succeed,
 * and records whether the proof was an authenticated account or real local inference, so the
 * verdict becomes falsifiable without claiming that a no-auth local model is "authenticated".
 *
 * WHAT A PROBE MAY EMIT. Only the four discriminators the receipt contract allows: which
 * account/subject answered, which endpoint was reached, the exit status, and when. Raw stdout
 * NEVER escapes this module — the extraction regex runs in-process and only its captured group
 * is considered, and even that is emitted as a digest unless the probe declares its own output
 * already redacted. That ordering matters: a probe that emitted stdout and redacted afterwards
 * would leak on every path that logged the intermediate value.
 *
 * WHY THESE COMMANDS. Each default is a documented non-interactive status verb of the agent's
 * OWN CLI, read from its `--help` rather than assumed:
 *   claude → `auth status`      ("Show authentication status")
 *   codex  → `login status`     ("Show login status")
 *   omp    → first `usage --json --redact` for a hosted account; if no account answers, invoke
 *            OMP itself non-interactively against loopback Ollama and require a model-produced
 *            marker. A version check, model listing, or broker registration is not inference.
 * A probe reaches the agent's real authenticated surface; it is not a version check. `--version`
 * would pass on a host where nobody had ever signed in, which is the precise failure the canary
 * exists to catch.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";

import { assertWorkspaceHostSecretIsolation } from "./workspace-host-test-harness";

// v3 (D-265): codex gained a `live-inference` probe. The bump is deliberate and load-bearing —
// the controller compares this against the report the HOST produced out of its release bundle, so
// bumping it is what turns "this host is still running the old codex probe" into a loud contract
// mismatch instead of a silent 5/6 that reads as a credential fault. That misreading cost a
// canary and most of a session before it was traced to the bundle rather than the credentials.
//
// v4 (WI-10001694): readiness and identity no longer compete for one boolean. codex's
// `authenticated-account` probe is `satisfiesReadiness: false` — it still records WHO the
// credential claims to be, but only an inference probe can mark an agent ready. The bump is
// required for the same reason v3's was: a host still running the v3 bundle has the SHORT-CIRCUIT
// arrangement, where a forged `auth.json` that matches SUBJECT_PATTERN marks codex ready and
// `live-inference` never runs. That host is not equivalent to this one, and the strict-equality
// comparison in the controller is what refuses it instead of trusting its report.
export const WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION =
  "papercusp-workspace-host-agent-verification-v4";

export const WORKSPACE_HOST_CANARY_AGENTS = ["claude", "codex", "omp"] as const;
export type WorkspaceHostCanaryAgent =
  (typeof WORKSPACE_HOST_CANARY_AGENTS)[number];

/** Validate coverage before any credential read or runtime invocation. Omission means all agents. */
export function resolveWorkspaceHostRequestedAgents(value: unknown): readonly WorkspaceHostCanaryAgent[] {
  if (value === undefined) return WORKSPACE_HOST_CANARY_AGENTS;
  if (!Array.isArray(value) || value.length === 0 ||
      Array.from(value).some((agent) => !WORKSPACE_HOST_CANARY_AGENTS.includes(agent)) ||
      new Set(value).size !== value.length) {
    throw new Error("requestedAgents must be a nonempty array of distinct claude, codex, or omp agents");
  }
  // Canonical order makes immutable scope/replay comparisons independent of caller ordering.
  return WORKSPACE_HOST_CANARY_AGENTS.filter((agent) => value.includes(agent));
}

/**
 * `authenticated-account` proves WHO the credential belongs to by making the CLI name a subject.
 * The two inference kinds prove the credential WORKS by making the agent do work and return a
 * marker, and exist because naming a subject is not always possible or not always meaningful:
 *
 * - `local-inference` reaches a model on the host itself (OMP against ollama). There is no remote
 *   account to name, so the work IS the evidence.
 * - `live-inference` reaches the agent's REMOTE endpoint. It exists because a status subcommand
 *   can report a session it never validated: MEASURED 2026-09-03, `codex login status` printed
 *   `Logged in using ChatGPT` and exited 0 against an auth.json whose id_token was 30 days
 *   expired and whose access and refresh tokens were both garbage. A probe reading that line
 *   would return ready:true for a host that cannot authenticate at all, which is the unbacked
 *   boolean this module exists to prevent (D-265).
 */
export type WorkspaceHostAgentVerificationKind =
  | "authenticated-account"
  | "local-inference"
  | "live-inference";

/**
 * How a probe's extracted subject may be published.
 *
 * `redacted` is reserved for output the TOOL ITSELF redacted (OMP's `--redact`); it is not a
 * promise the caller can make on a tool's behalf. Everything else digests, because we cannot
 * know whether an arbitrary agent CLI prints a full email, an org name, or a key prefix.
 */
export type WorkspaceHostAgentSubjectDisclosure = "redacted" | "digest";

export interface WorkspaceHostAgentVerificationProbeSpec {
  readonly agent: WorkspaceHostCanaryAgent;
  readonly verificationKind: WorkspaceHostAgentVerificationKind;
  /** Absolute path (or PATH-resolvable name) of the agent CLI on the host. */
  readonly command: string;
  readonly args: readonly string[];
  /** The authenticated surface this probe reaches; recorded as evidence, never derived. */
  readonly endpoint: string;
  /**
   * Extracts the account/subject discriminator from stdout. The FIRST capture group is the
   * subject. A probe whose pattern does not match is a FAILED probe, not an authenticated one
   * with an unknown subject — "exit 0 but unparseable" is the shape a broken or reworded CLI
   * takes, and treating it as success is how an unbacked boolean comes back.
   */
  readonly proofPattern: RegExp;
  readonly subjectDisclosure: WorkspaceHostAgentSubjectDisclosure;
  readonly timeoutMs?: number;
  /**
   * Whether a matching result from this probe may mark the agent READY. Defaults to true.
   *
   * `false` makes the probe contribute SUBJECT EVIDENCE ONLY: it still runs, and its parsed
   * subject is published as `selfReportedSubjectDigest`, but it can neither set `ready` nor
   * end the probe loop. Use it for any probe whose proof the credential holder could author.
   *
   * This exists because ORDERING cannot express the distinction safely (WI-10001694). The loop
   * breaks on the first ready spec, so a forgeable probe placed FIRST short-circuits the real
   * one; and placed SECOND it runs exactly when the real one did NOT pass, so a forged
   * credential plus a transient endpoint failure still reads ready. Both arrangements make
   * forgery load-bearing. A probe that cannot satisfy readiness at all is safe in ANY position,
   * which is what takes the defect out of the ordering and makes it structural.
   */
  readonly satisfiesReadiness?: boolean;
}

/**
 * True when a matching result from this spec may mark the agent ready. Absent means true, so a
 * spec that predates the flag keeps its meaning; a probe is opted OUT of readiness explicitly.
 */
export function workspaceHostAgentSpecSatisfiesReadiness(
  spec: WorkspaceHostAgentVerificationProbeSpec,
): boolean {
  return spec.satisfiesReadiness !== false;
}

/**
 * Matches "<label><separator><subject>" in a status line, where the subject is an email or a
 * bare account identifier.
 *
 * The separator class is `[^A-Za-z0-9]`, NOT `\D`. `\D` means "not a digit", so it matches
 * letters — a greedy run of it consumes the subject and backtracks to capture only the tail
 * ("ai" of "canary@papercup.ai"), producing a stable-looking digest of the wrong string. A class
 * that cannot consume the capture's own first character makes that failure impossible rather
 * than merely unlikely.
 */
const SUBJECT_PATTERN =
  /(?:account|email|organi[sz]ation|org|logged in as|signed in as)\b[^A-Za-z0-9]{0,24}([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|[A-Za-z0-9][A-Za-z0-9._-]{2,63})/i;

/**
 * The defaults, grounded in each CLI's own documented help output.
 *
 * `proofPattern` is deliberately permissive about surrounding prose and strict about the shape
 * of the thing it captures, because the prose is what churns between CLI releases.
 */
export const WORKSPACE_HOST_OMP_LOCAL_MODEL = "qwen2.5-coder:0.5b";
export const WORKSPACE_HOST_OMP_LOCAL_INFERENCE_MARKER =
  "P046_OMP_LOCAL_INFERENCE_OK";
export const WORKSPACE_HOST_CODEX_LIVE_INFERENCE_MARKER = "P046_CODEX_LIVE_OK";
export const WORKSPACE_HOST_CLAUDE_LIVE_INFERENCE_MARKER =
  "P047_CLAUDE_LIVE_OK";

export const DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES: Readonly<
  Record<
    WorkspaceHostCanaryAgent,
    readonly WorkspaceHostAgentVerificationProbeSpec[]
  >
> = {
  claude: [
    // WI-10001689. `authenticated-account` via `claude auth status` was REMOVED here rather than
    // kept as a first spec with live-inference behind it, and both halves of that are deliberate.
    //
    // It could never PASS. The agent-home bundle ships only `.claude/.credentials.json`, but the
    // subject that command names is read from `~/.claude.json` `oauthAccount.*`, which the bundle
    // does not ship — measured, a config dir holding only the credentials file reports
    // `"email": null` and matches no subject, so claude failed verify-initialization for EVERY
    // account, whatever credential was delivered.
    //
    // And it must NOT be repaired by shipping that identity file, because the check proves nothing
    // even when it is satisfied: `claude auth status` never contacts the endpoint it declares.
    // Measured, an entirely invented access token beside a hand-written oauthAccount block
    // reported `attacker@example.invalid` / `Fabricated Org` and MATCHED SUBJECT_PATTERN. The
    // subject comes from an ordinary writable JSON file, so anything that can write the agent home
    // can name any subject it likes. Shipping the identity file would only have turned the gate
    // green while leaving it forgeable, and would have put a real account's identity on the host
    // in order to do it. Ordering it FIRST would be worse still: a future oauthAccount file would
    // short-circuit the real probe and silently restore the vacuity.
    //
    // This is the conclusion the codex spec below already reached about `codex login status`
    // ("proves nothing about whether the delivered credential authenticates"); claude simply never
    // got the live-inference treatment that replaced it there.
    {
      agent: "claude",
      verificationKind: "live-inference",
      command: "claude",
      // No `--model` here, for the reason the codex spec documents: a model-specific value goes
      // stale under the probe and fails it for a NON-credential reason. `--strict-mcp-config`
      // keeps a host's MCP config out of a readiness probe, and `--no-session-persistence` keeps
      // the probe from writing session state into the agent home it is verifying. This EXACT argv
      // was measured against both a real and a fabricated credential before it shipped.
      args: [
        "-p",
        "--strict-mcp-config",
        "--no-session-persistence",
        `Reply with exactly ${WORKSPACE_HOST_CLAUDE_LIVE_INFERENCE_MARKER} and nothing else.`,
      ],
      endpoint: "https://api.anthropic.com",
      // MULTILINE-ANCHORED, mirroring codex. Measured, `claude -p` does NOT echo the prompt (1
      // marker occurrence on a passing run, where codex exec produced 3), so the anchoring is not
      // load-bearing TODAY. It is kept because the codex comment records exactly what an
      // unanchored pattern costs if a CLI ever starts echoing: every credential failure reads as
      // ready. Cheap insurance against a CLI release nobody here controls.
      proofPattern: new RegExp(
        `^\\s*(${WORKSPACE_HOST_CLAUDE_LIVE_INFERENCE_MARKER})\\s*$`,
        "m",
      ),
      subjectDisclosure: "digest",
      timeoutMs: 180_000,
    },
  ],
  codex: [
    {
      agent: "codex",
      verificationKind: "authenticated-account",
      command: "codex",
      args: ["login", "status"],
      endpoint: "https://api.openai.com",
      proofPattern: SUBJECT_PATTERN,
      subjectDisclosure: "digest",
      // WI-10001694, superseding D-265's ordering rationale. MEASURED 2026-09-17: against a fully
      // fabricated `$CODEX_HOME/auth.json` — invented email and account_id, placeholder access
      // token, an `alg:RS256` signature nothing signed — this command prints `Logged in using
      // ChatGPT` and exits 0. The REAL credential prints the SAME line at the same exit code, so
      // the outputs are byte-identical and this probe cannot tell a forged credential from a live
      // one. (Two cruder arms WERE rejected `invalid ID token format`, so codex parses the token
      // structurally and simply never verifies it.)
      //
      // It survives, rather than being removed as claude's was in WI-10001689, because it is the
      // only signal naming WHICH account a host authenticated as — and it is safe to keep ONLY
      // because it can no longer decide readiness. What stops the vacuity is this flag, not the
      // fact that `Logged in using ChatGPT` happens to miss SUBJECT_PATTERN today: that miss is a
      // coincidence of one CLI's current output string, and any auth mode or future release that
      // prints an account line would have restored the short-circuit silently.
      satisfiesReadiness: false,
    },
    // D-265, as amended by WI-10001694: this is now codex's ONLY readiness-bearing probe, not a
    // fallback behind the account probe. It has to exist because, under ChatGPT OAuth,
    // `codex login status` prints exactly `Logged in using ChatGPT` — no account, no email, and
    // no `--json` to ask for one — so SUBJECT_PATTERN cannot match and codex could never pass.
    //
    // Widening SUBJECT_PATTERN to accept that line was REJECTED: it would digest a PROVIDER name
    // as though it were an account subject, and — measured — that line is printed for a 30-day
    // expired token with garbage access and refresh tokens too, so it proves nothing about
    // whether the delivered credential authenticates.
    {
      agent: "codex",
      verificationKind: "live-inference",
      command: "codex",
      // No `-c` override in this argv. A model-specific value goes stale under the probe and
      // fails it for a NON-credential reason: `-c model_reasoning_effort="minimal"` was measured
      // returning HTTP 400 `Unsupported value: 'minimal' is not supported with the 'gpt-5.6-sol'
      // model`, which is a false RED. `--sandbox read-only` is not such a value — a readiness
      // probe must not need write access, and it measured cheaper (15,883 vs 16,267 tokens).
      args: [
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        `Reply with exactly ${WORKSPACE_HOST_CODEX_LIVE_INFERENCE_MARKER} and nothing else.`,
      ],
      endpoint: "https://api.openai.com",
      // MULTILINE-ANCHORED, and the anchoring is load-bearing rather than tidy: codex echoes the
      // prompt, so the marker appears in the output of a FAILING run too (measured: once, in the
      // `Reply with exactly …` line). An unanchored pattern would match that echo and report
      // every credential failure as ready. Measured both ways against real captures — positive
      // exit 0 with 3 occurrences MATCHES; negative exit 1 with 1 occurrence does NOT.
      proofPattern: new RegExp(
        `^\\s*(${WORKSPACE_HOST_CODEX_LIVE_INFERENCE_MARKER})\\s*$`,
        "m",
      ),
      subjectDisclosure: "digest",
      timeoutMs: 180_000,
    },
  ],
  omp: [
    {
      agent: "omp",
      verificationKind: "authenticated-account",
      command: "omp",
      args: ["usage", "--json", "--redact"],
      endpoint: "papercusp-omp-broker",
      // `--redact` already reduces account ids to a shortest-unique prefix, so the captured value
      // is publishable as-is; this reads the first account id out of the JSON report.
      proofPattern:
        /"(?:account|accountId|account_id)"\s*:\s*"([^"\\]{1,120})"/,
      subjectDisclosure: "redacted",
    },
    {
      agent: "omp",
      verificationKind: "local-inference",
      command: "omp",
      args: [
        "--model",
        `ollama/${WORKSPACE_HOST_OMP_LOCAL_MODEL}`,
        "--print",
        "--no-tools",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-rules",
        "--mode",
        "text",
        `Reply with exactly ${WORKSPACE_HOST_OMP_LOCAL_INFERENCE_MARKER} and nothing else.`,
      ],
      endpoint: "http://127.0.0.1:11434",
      proofPattern: new RegExp(
        `^\\s*(${WORKSPACE_HOST_OMP_LOCAL_INFERENCE_MARKER})\\s*$`,
      ),
      subjectDisclosure: "digest",
      timeoutMs: 180_000,
    },
  ],
};

/**
 * The verification kinds a READY verdict for `agent` may legitimately carry, DERIVED from the
 * probe table above rather than restated by each consumer.
 *
 * WI-10002402. Four call sites had each hand-copied this rule as a literal
 * (`authenticated-account`, or `local-inference` when the agent is omp), and the copies had
 * drifted from the table they describe — in opposite directions, so no two agreed:
 *
 * - Three of them (the canary evidence validator, the remote initializer's evidence assembler,
 *   and the initialization verifier) demanded `authenticated-account` for claude. Claude's spec
 *   set CANNOT emit that kind at all: its `authenticated-account` probe was deliberately removed
 *   (WI-10001689) because it could never pass AND was forgeable — `claude auth status` reads its
 *   subject from an ordinary writable JSON file and never contacts the endpoint it names, so an
 *   invented token beside a hand-written `oauthAccount` block matched SUBJECT_PATTERN. Those
 *   three sites therefore rejected a live GCP canary for presenting the STRONGER evidence that
 *   deliberately replaced it, and no credential could ever have satisfied them.
 * - The fourth (agent credential admission) already allowed `live-inference` for non-omp agents,
 *   which is why the disagreement surfaced a layer later instead of at admission.
 *
 * Deriving it removes the class: a probe added, retired, or re-keyed moves every consumer with
 * it, and a spec that cannot mark readiness cannot be presented as readiness evidence. Readiness
 * is the filter (v4 / WI-10001694): codex's `authenticated-account` probe is
 * `satisfiesReadiness: false` — it records WHO the credential claims to be, and only an
 * inference probe may mark the agent ready — so it is correctly absent from this set.
 */
export function workspaceHostAgentAllowedVerificationKinds(
  agent: WorkspaceHostCanaryAgent,
  probes: Readonly<
    Record<
      WorkspaceHostCanaryAgent,
      readonly WorkspaceHostAgentVerificationProbeSpec[]
    >
  > = DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES,
): ReadonlySet<WorkspaceHostAgentVerificationKind> {
  return new Set(
    (probes[agent] ?? [])
      .filter(workspaceHostAgentSpecSatisfiesReadiness)
      .map((spec) => spec.verificationKind),
  );
}

/**
 * True when `kind` is a readiness-capable verification kind for `agent`.
 *
 * Consumers should prefer this over an inline literal comparison; see
 * {@link workspaceHostAgentAllowedVerificationKinds} for why.
 */
export function workspaceHostAgentVerificationKindIsAllowed(
  agent: WorkspaceHostCanaryAgent,
  kind: unknown,
  probes?: Readonly<
    Record<
      WorkspaceHostCanaryAgent,
      readonly WorkspaceHostAgentVerificationProbeSpec[]
    >
  >,
): boolean {
  return workspaceHostAgentAllowedVerificationKinds(agent, probes).has(
    kind as WorkspaceHostAgentVerificationKind,
  );
}

export const DEFAULT_WORKSPACE_HOST_AGENT_PROBE_TIMEOUT_MS = 60_000;

/**
 * Longest legal default probe sequence when every stronger probe falls through.
 *
 * Agent probes run sequentially by design, including the 180s Codex and OMP inference
 * fallbacks. Transport adapters use this derived budget to keep their own outer deadline
 * from expiring before the inner contract has had time to finish.
 */
export const DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_TIMEOUT_BUDGET_MS =
  WORKSPACE_HOST_CANARY_AGENTS.reduce(
    (total, agent) =>
      total +
      DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES[agent].reduce(
        (agentTotal, spec) =>
          agentTotal +
          (spec.timeoutMs ?? DEFAULT_WORKSPACE_HOST_AGENT_PROBE_TIMEOUT_MS),
        0,
      ),
    0,
  );
/**
 * Bounded stderr tail kept while classifying. Large enough that a recognized phrase split across
 * two chunk boundaries still matches, small enough that nothing accumulates.
 */
const STDERR_CLASSIFY_WINDOW_BYTES = 4096;

const MAX_PROBE_OUTPUT_BYTES = 512 * 1024;

export interface WorkspaceHostAgentProbeInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  /** When supplied, this is the COMPLETE child environment, not an overlay on the parent. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Explicit working directory for controller-side isolated probes.
   *
   * HOME alone does not change a process's cwd. Without this field a probe over a temporary
   * credential home can still discover repo-local config from the controller's inherited cwd,
   * which means it is no longer proving only the material the caller supplied.
   */
  readonly cwd?: string;
  /** Execute the probe as this real non-root account, not merely with identity-shaped env vars. */
  readonly runAsUser?: string;
}

export interface WorkspaceHostAgentProbeOutcome {
  readonly exitCode: number;
  /** Consumed in-process only. It is never copied into evidence. */
  readonly stdout: string;
  /**
   * A CLASSIFIED cause, when the probe's own output named one — a fixed reason code, never text.
   *
   * The runner matches output against `PROBE_FAILURE_CLASSIFIERS` and keeps only the resulting
   * enum value; the text that produced it is dropped in the same tick. That is what lets a
   * diagnosis survive without weakening the rule that CLI output never reaches evidence.
   */
  readonly failureHint?: WorkspaceHostAgentProbeFailureReason;
}

export interface WorkspaceHostAgentProbeRunner {
  run(
    invocation: WorkspaceHostAgentProbeInvocation,
  ): Promise<WorkspaceHostAgentProbeOutcome>;
}

export interface WorkspaceHostAgentProbeProcess {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

const WORKSPACE_HOST_PROBE_RUNUSER = "/usr/sbin/runuser";
const WORKSPACE_HOST_PROBE_ENV = "/usr/bin/env";
const WORKSPACE_HOST_PROBE_LAUNCH_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";
const WORKSPACE_HOST_PROBE_ACCOUNT = /^[a-z_][a-z0-9_-]{0,30}$/;
const WORKSPACE_HOST_PROBE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Build the exact process boundary for a probe.
 *
 * `HOME`/`USER` alone do not change a Unix identity. Production probes enter through a root-owned
 * initializer, so the runner must drop to the workspace account before the CLI reads its 0600
 * files. `env -i` then gives that account the caller's complete allowlisted environment and makes
 * ambient controller/service credentials unavailable even if PAM or runuser would preserve them.
 */
export function buildWorkspaceHostAgentProbeProcess(
  invocation: WorkspaceHostAgentProbeInvocation,
): WorkspaceHostAgentProbeProcess {
  if (
    invocation.cwd !== undefined &&
    (!isAbsolute(invocation.cwd) ||
      normalize(invocation.cwd) !== invocation.cwd ||
      containsControlCharacter(invocation.cwd))
  ) {
    throw new Error(
      "agent authentication probe cwd must be an absolute canonical path free of control characters",
    );
  }
  if (!invocation.runAsUser) {
    return {
      command: invocation.command,
      args: invocation.args,
      ...(invocation.env ? { env: invocation.env } : {}),
      ...(invocation.cwd ? { cwd: invocation.cwd } : {}),
    };
  }
  if (
    !WORKSPACE_HOST_PROBE_ACCOUNT.test(invocation.runAsUser) ||
    invocation.runAsUser === "root"
  ) {
    throw new Error(
      "agent authentication probe runAsUser must be a non-root Linux account",
    );
  }
  if (!invocation.env) {
    throw new Error(
      "agent authentication probe runAsUser requires a complete environment",
    );
  }
  const agentHome = invocation.env.HOME;
  if (!agentHome?.startsWith("/") || containsControlCharacter(agentHome)) {
    throw new Error(
      "agent authentication probe runAsUser requires an absolute HOME",
    );
  }
  const environment = Object.entries(invocation.env).map(([key, value]) => {
    if (!WORKSPACE_HOST_PROBE_ENV_NAME.test(key) || /\0/.test(value)) {
      throw new Error(
        "agent authentication probe environment is not safe for env -i",
      );
    }
    return `${key}=${value}`;
  });
  return {
    command: WORKSPACE_HOST_PROBE_RUNUSER,
    // SSH enters its own 0700 home. Switching identity does not change cwd;
    // agents must start inside the home their credential binding actually owns.
    cwd: invocation.cwd ?? agentHome,
    args: [
      "--user",
      invocation.runAsUser,
      "--",
      WORKSPACE_HOST_PROBE_ENV,
      "-i",
      "--",
      ...environment,
      invocation.command,
      ...invocation.args,
    ],
    // This environment belongs only to the trusted runuser launcher. The target receives the
    // exact allowlist above after env -i; nothing from the initializer process is inherited.
    env: { PATH: WORKSPACE_HOST_PROBE_LAUNCH_PATH },
  };
}

/** Public, secret-isolated evidence for one agent. */
export interface WorkspaceHostAgentVerificationEvidence {
  readonly contractVersion: typeof WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION;
  readonly agent: WorkspaceHostCanaryAgent;
  readonly ready: boolean;
  readonly verificationKind: WorkspaceHostAgentVerificationKind;
  readonly endpoint: string;
  readonly exitStatus: number;
  readonly observedAt: string;
  /** Present only for a `redacted` probe; the tool produced the redaction, not us. */
  readonly subject?: string;
  /** Always present on a successful probe: a stable digest of the parsed proof value. */
  readonly proofDigest?: string;
  /**
   * The subject a `satisfiesReadiness: false` probe reported, digested — SELF-REPORTED AND
   * UNVERIFIED, and named that way so no reader can mistake it for a proven identity.
   *
   * It is deliberately a SEPARATE field from `subject`/`proofDigest` rather than a flag beside
   * them. Those two are populated by the probe that decided `ready`; this one is populated by a
   * probe that is not allowed to decide anything. Measured 2026-09-17 (WI-10001694): a fully
   * fabricated codex `auth.json` makes `codex login status` print output BYTE-IDENTICAL to the
   * real credential's, so any value derived from it is an unverifiable claim. Its presence says
   * the CLI named a subject; it never says the credential authenticates. Read `ready` for that.
   */
  readonly selfReportedSubjectDigest?: string;
  readonly subjectDisclosure: WorkspaceHostAgentSubjectDisclosure;
  /** Populated only on failure, and only with a fixed reason code — never CLI output. */
  readonly failure?: WorkspaceHostAgentProbeFailureReason;
}

export type WorkspaceHostAgentProbeFailureReason =
  | "non-zero-exit"
  | "no-verification-proof"
  | "probe-error"
  | "credential-revoked"
  | "credential-malformed"
  | "credential-unauthorized"
  | "provider-usage-limit";

/**
 * Fixed patterns that turn a probe's own failure output into a REASON CODE.
 *
 * Why this exists: a metered third-party account that has run out of quota fails a probe in a way
 * that is indistinguishable, from evidence alone, from a broken credential. MEASURED 2026-09-04
 * (WI-2144034): `codex exec` printed `You've hit your usage limit` and **exited 0**, so the probe
 * recorded `no-verification-proof` — a code that says "the marker was absent" and points every
 * reader at the credentials. Diagnosing that cost two GCP canaries and most of two sessions; the
 * one line that explained it went to stderr, which this module drains and discards on purpose.
 *
 * The isolation rule is unchanged and deliberately so: matching happens in-process, the matched
 * text is dropped in the same tick, and only the enum value below can leave. A classifier may
 * therefore never capture a group or interpolate what it matched — that would be a route for CLI
 * text to reach evidence, which is exactly what `failure` forbids.
 *
 * Keep these patterns narrow and provider-agnostic in wording. A pattern that matched broadly
 * would relabel ordinary credential failures as quota exhaustion, which is the more dangerous
 * error: it would send a reader to the billing page while the real fault is an expired token.
 */
const PROBE_FAILURE_CLASSIFIERS: readonly {
  readonly pattern: RegExp;
  readonly reason: WorkspaceHostAgentProbeFailureReason;
}[] = [
  // Measured r7 failure: retain the cause while discarding all credential text.
  { pattern: /\brefresh token was revoked\b/i, reason: "credential-revoked" },
  // Measured 2026-09-11 (P-305 G6 root cause): a delivered auth.json the CLI cannot deserialize
  // prints serde's `missing field \`<name>\`` and exits 1 — a MALFORMED generation, not a
  // revoked or exhausted one. Name it, so the reader is sent to the projection, not the account.
  { pattern: /\bmissing field\b/i, reason: "credential-malformed" },
  // The provider refused the identity outright (codex exec sends no bearer when auth.json did
  // not parse; an expired/foreign access token lands here too). Distinct from quota, which
  // requires an ACCEPTED identity to be reported at all.
  { pattern: /\b401 unauthorized\b/i, reason: "credential-unauthorized" },
  // Claude's weekly exhaustion names the window instead of saying "usage" (P-318).
  { pattern: /\bhit your (?:usage|weekly) limit\b/i, reason: "provider-usage-limit" },
  { pattern: /\busage limit reached\b/i, reason: "provider-usage-limit" },
  { pattern: /\bquota exceeded\b/i, reason: "provider-usage-limit" },
  { pattern: /\binsufficient_quota\b/i, reason: "provider-usage-limit" },
  { pattern: /\brate limit exceeded\b/i, reason: "provider-usage-limit" },
];

/**
 * Reduce probe output to a fixed reason code, or undefined when nothing is recognized.
 *
 * Returns only a value from the closed union above; the input string is never retained.
 */
export function classifyWorkspaceHostAgentProbeFailure(
  output: string,
): WorkspaceHostAgentProbeFailureReason | undefined {
  for (const classifier of PROBE_FAILURE_CLASSIFIERS) {
    if (classifier.pattern.test(output)) return classifier.reason;
  }
  return undefined;
}

export function workspaceHostAgentSubjectDigest(subject: string): string {
  return createHash("sha256").update(subject).digest("hex").slice(0, 16);
}

/**
 * Node runner: closes stdin so an interactive prompt cannot block, bounds the output, and kills
 * the tree on timeout.
 *
 * Closing stdin is the load-bearing part. A CLI that decides to prompt for a login finds EOF and
 * exits non-zero instead of hanging until the timeout, so "nobody is signed in" is reported as a
 * clean failure rather than as a probe that mysteriously took a minute.
 */
export class NodeWorkspaceHostAgentProbeRunner implements WorkspaceHostAgentProbeRunner {
  constructor(private readonly spawnImpl: typeof nodeSpawn = nodeSpawn) {}

  run(
    invocation: WorkspaceHostAgentProbeInvocation,
  ): Promise<WorkspaceHostAgentProbeOutcome> {
    return new Promise((resolve, reject) => {
      let processInput: WorkspaceHostAgentProbeProcess;
      try {
        processInput = buildWorkspaceHostAgentProbeProcess(invocation);
      } catch (error) {
        reject(error);
        return;
      }
      // runuser is a launcher: killing only its PID leaves the agent holding our
      // output pipes open. This awaited probe owns one POSIX process group so its
      // deadline and output bound cover the launcher and its descendants together.
      const ownsProcessGroup = process.platform !== "win32";
      const child = this.spawnImpl(
        processInput.command,
        [...processInput.args],
        {
          stdio: ["ignore", "pipe", "pipe"],
          detached: ownsProcessGroup,
          ...(processInput.cwd ? { cwd: processInput.cwd } : {}),
          ...(processInput.env ? { env: { ...processInput.env } } : {}),
        },
      );
      let stdout = "";
      let bytes = 0;
      let settled = false;
      let stderrWindow = "";
      let failureHint: WorkspaceHostAgentProbeFailureReason | undefined;

      const killProbe = (): void => {
        if (ownsProcessGroup && child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
            return;
          } catch {
            // The group may already have exited; retain the child-handle fallback.
          }
        }
        child.kill("SIGKILL");
      };

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => {
          killProbe();
          reject(
            new Error(
              `agent authentication probe timed out after ${invocation.timeoutMs}ms`,
            ),
          );
        });
      }, invocation.timeoutMs);

      child.stdout?.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        bytes += Buffer.byteLength(text);
        if (bytes > MAX_PROBE_OUTPUT_BYTES) {
          finish(() => {
            killProbe();
            reject(
              new Error("agent authentication probe produced too much output"),
            );
          });
          return;
        }
        stdout += text;
      });
      // stderr is drained so the child never blocks on a full pipe, and still never reaches
      // evidence as TEXT. It is classified as it arrives (a fixed reason code, dropped text) so a
      // provider-side cause such as an exhausted quota survives as `failureHint` instead of being
      // destroyed here and mis-read later as a credential fault — WI-2144034, where the one line
      // that explained a two-canary failure went out on this exact stream.
      child.stderr?.on("data", (chunk: Buffer | string) => {
        if (failureHint) return;
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        // Carry a bounded tail across chunk boundaries so a pattern split across two reads is
        // still matched, without accumulating the whole stream.
        stderrWindow = (stderrWindow + text).slice(-STDERR_CLASSIFY_WINDOW_BYTES);
        failureHint = classifyWorkspaceHostAgentProbeFailure(stderrWindow);
        if (failureHint) stderrWindow = "";
      });
      child.on("error", (error) => finish(() => reject(error)));
      child.on("close", (code) =>
        finish(() =>
          resolve({
            exitCode: typeof code === "number" ? code : 1,
            stdout,
            // stdout is classified too: a CLI that reports quota on stdout is just as opaque.
            ...((failureHint ??= classifyWorkspaceHostAgentProbeFailure(stdout))
              ? { failureHint }
              : {}),
          }),
        ),
      );
    });
  }
}

export interface ProbeWorkspaceHostAgentInput {
  readonly spec: WorkspaceHostAgentVerificationProbeSpec;
  readonly runner: WorkspaceHostAgentProbeRunner;
  readonly now: () => Date;
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly runAsUser?: string;
}

/** Run one probe and reduce it to publishable evidence. */
export async function probeWorkspaceHostAgentVerification(
  input: ProbeWorkspaceHostAgentInput,
): Promise<WorkspaceHostAgentVerificationEvidence> {
  const { spec, runner, now } = input;
  const base = {
    contractVersion: WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
    agent: spec.agent,
    verificationKind: spec.verificationKind,
    endpoint: spec.endpoint,
    subjectDisclosure: spec.subjectDisclosure,
  } as const;

  let outcome: WorkspaceHostAgentProbeOutcome;
  try {
    outcome = await runner.run({
      command: spec.command,
      args: spec.args,
      timeoutMs:
        spec.timeoutMs ?? DEFAULT_WORKSPACE_HOST_AGENT_PROBE_TIMEOUT_MS,
      ...(input.env ? { env: input.env } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.runAsUser ? { runAsUser: input.runAsUser } : {}),
    });
  } catch {
    // The thrown error may carry a command line or CLI text, so it is reduced to a code here and
    // never surfaced. A caller that needs to debug reads the host's own logs.
    return {
      ...base,
      ready: false,
      exitStatus: -1,
      observedAt: now().toISOString(),
      failure: "probe-error",
    };
  }

  const observedAt = now().toISOString();
  if (outcome.exitCode !== 0) {
    return {
      ...base,
      ready: false,
      exitStatus: outcome.exitCode,
      observedAt,
      // A classified provider cause outranks the generic shape code: "non-zero-exit" describes
      // HOW the probe failed, "provider-usage-limit" describes WHY, and only the second one tells
      // a reader not to go looking at the credential.
      failure: outcome.failureHint ?? "non-zero-exit",
    };
  }

  const match = spec.proofPattern.exec(outcome.stdout);
  const proof = match?.[1]?.trim();
  if (!proof) {
    return {
      ...base,
      ready: false,
      exitStatus: outcome.exitCode,
      observedAt,
      // The measured WI-2144034 case lands HERE, not above: `codex exec` exited 0 while printing a
      // usage-limit error, so the marker was simply absent. Without the hint this reads as
      // "no proof" and sends every reader to the credentials.
      failure: outcome.failureHint ?? "no-verification-proof",
    };
  }

  const evidence: WorkspaceHostAgentVerificationEvidence = {
    ...base,
    ready: true,
    exitStatus: outcome.exitCode,
    observedAt,
    proofDigest: workspaceHostAgentSubjectDigest(proof),
    ...(spec.verificationKind === "authenticated-account" &&
    spec.subjectDisclosure === "redacted"
      ? { subject: proof }
      : {}),
  };
  assertWorkspaceHostSecretIsolation(
    evidence,
    `workspaceHost.agentAuthentication.${spec.agent}`,
  );
  return evidence;
}

export interface WorkspaceHostAgentVerificationReport {
  readonly contractVersion: typeof WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION;
  readonly observedAt: string;
  readonly allReady: boolean;
  /** Explicit coverage; omitted on legacy/default all-agent reports. Excluded agents have no evidence. */
  readonly requestedAgents?: readonly WorkspaceHostCanaryAgent[];
  readonly agents: Readonly<
    Partial<Record<WorkspaceHostCanaryAgent, WorkspaceHostAgentVerificationEvidence>>
  >;
}

/**
 * True when any code unit is a C0 control or DEL.
 *
 * A codepoint scan rather than a character-class regex on purpose: the class has to be written
 * with the control characters themselves, and a raw control byte in source makes ripgrep treat the
 * file as binary and skip it — so the one guard nobody can grep for is the guard about ungreppable
 * bytes. This says the same thing in characters that survive a diff.
 */
function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Point one probe spec at the vendor runtime path recorded for its agent (D-259 Defect 2).
 *
 * The default specs name each CLI by BARE NAME, which the probe resolves against its search path.
 * On a real workspace host that path leads with the release bundle's own `bin/`, and the files
 * there are launcher WRAPPERS named after the agent CLIs — they do not implement `auth status`, so
 * a probe that found one measured the wrapper and reported a credential fault that no credential
 * could fix. That is D-247, and it read as a probe bug across three sessions precisely because the
 * probe looked correct: it ran the name it meant to run. Provisioning resolves each vendor binary
 * after installing it and records the ABSOLUTE path; substituting that path here is what makes the
 * probe exec the vendor CLI instead of whatever the search path happens to find first.
 *
 * A MISSING path is deliberately not an error. A host provisioned before those installs existed
 * genuinely has no vendor runtime, and the honest outcome there is a probe that runs and FAILS —
 * "this host cannot authenticate an agent" is the finding the canary exists to surface. Throwing
 * instead would re-file that finding as an infrastructure error and hide it.
 */
export function applyWorkspaceHostAgentRuntimePath(
  spec: WorkspaceHostAgentVerificationProbeSpec,
  runtimePath: string | undefined,
): WorkspaceHostAgentVerificationProbeSpec {
  if (runtimePath === undefined) return spec;
  // Control characters are rejected rather than escaped: the path is interpolated into the
  // `env -i --` argv the probe launches with, so a value carrying a NUL or a newline is a
  // truncated or split ARGUMENT, not a path that merely fails to exist.
  if (
    !runtimePath.startsWith("/") ||
    runtimePath.length < 2 ||
    containsControlCharacter(runtimePath)
  ) {
    throw new Error(
      `agent '${spec.agent}' runtime path must be an absolute path free of control characters`,
    );
  }
  return { ...spec, command: runtimePath };
}

export interface ProbeWorkspaceHostAgentsInput {
  readonly runner: WorkspaceHostAgentProbeRunner;
  readonly requestedAgents?: readonly WorkspaceHostCanaryAgent[];
  readonly probes?: Partial<
    Record<
      WorkspaceHostCanaryAgent,
      readonly WorkspaceHostAgentVerificationProbeSpec[]
    >
  >;
  readonly now?: () => Date;
  /** Exact environment shared by all three sequential probes. */
  readonly env?: Readonly<Record<string, string>>;
  /** Explicit cwd shared by all three probes; controller-side callers use the isolated home. */
  readonly cwd?: string;
  /** Real Unix account shared by all three sequential probes. */
  readonly runAsUser?: string;
  /**
   * Absolute path of each agent's VENDOR runtime, as resolved on the host after install.
   *
   * When present for an agent it REPLACES that agent's probe `command` — every spec for that
   * agent, so OMP's hosted-account and local-inference probes both exec the same binary. Absent
   * entries fall back to the spec's own command; see `applyWorkspaceHostAgentRuntimePath` for why
   * that fallback is a fallback and not a failure.
   */
  readonly runtimePaths?: Partial<Record<WorkspaceHostCanaryAgent, string>>;
}

/**
 * Probe the requested agents, defaulting to all three.
 *
 * Sequential, not parallel: three CLIs racing for the same credential store or keychain is a
 * source of spurious failures, and a probe suite that is flaky is worse than no probe suite —
 * it teaches whoever reads the canary to re-run until it passes.
 */
export async function probeWorkspaceHostAgents(
  input: ProbeWorkspaceHostAgentsInput,
): Promise<WorkspaceHostAgentVerificationReport> {
  const requestedAgents = resolveWorkspaceHostRequestedAgents(input.requestedAgents);
  const now = input.now ?? (() => new Date());
  const agents: Partial<
    Record<WorkspaceHostCanaryAgent, WorkspaceHostAgentVerificationEvidence>
  > = {};
  for (const agent of requestedAgents) {
    const specs =
      input.probes?.[agent] ??
      DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES[agent];
    if (specs.length === 0) {
      throw new Error(`agent '${agent}' has no verification probes`);
    }
    // Ordered BEFORE the readiness guard below, for the same reason the runtime path is applied
    // after it: a mis-declared spec must be refused AS mis-declared. Checking readiness first
    // would report a borrowed `satisfiesReadiness: false` spec as "this agent has no readiness
    // probe", which is a true statement about the wrong problem and hides the actual mistake.
    for (const spec of specs) {
      if (spec.agent !== agent) {
        throw new Error(
          `agent probe for '${agent}' declares agent '${spec.agent}'`,
        );
      }
    }
    // STRUCTURAL GUARD (WI-10001694). A probe set whose every spec is `satisfiesReadiness: false`
    // could never mark the agent ready, and the shape that produces it — opting the last readiness
    // probe out while meaning to keep the account one for evidence — fails SILENTLY in the
    // direction that reads as a credential fault. Refusing the SET is what makes the defect
    // impossible to express, rather than merely absent from the current arrangement.
    if (!specs.some(workspaceHostAgentSpecSatisfiesReadiness)) {
      throw new Error(
        `agent '${agent}' has no readiness-bearing verification probe`,
      );
    }
    let readiness: WorkspaceHostAgentVerificationEvidence | undefined;
    let selfReportedSubjectDigest: string | undefined;
    for (const spec of specs) {
      const evidence = await probeWorkspaceHostAgentVerification({
        // Applied AFTER the agent-mismatch check above, so a mis-declared spec is refused as a
        // mis-declared spec rather than silently rewritten to point at another agent's binary.
        spec: applyWorkspaceHostAgentRuntimePath(
          spec,
          input.runtimePaths?.[agent],
        ),
        runner: input.runner,
        now,
        ...(input.env ? { env: input.env } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.runAsUser ? { runAsUser: input.runAsUser } : {}),
      });
      if (!workspaceHostAgentSpecSatisfiesReadiness(spec)) {
        // Contributes identity, never readiness: it cannot assign `readiness` and cannot `break`,
        // so it is inert in EVERY position. A probe that did not match leaves no digest, which is
        // the ChatGPT-OAuth case today — absent, rather than an empty-string claim of identity.
        if (evidence.proofDigest) {
          selfReportedSubjectDigest = evidence.proofDigest;
        }
        continue;
      }
      readiness = evidence;
      if (evidence.ready) break;
    }
    if (!readiness) {
      // Unreachable via the structural guard above; kept because the alternative to throwing here
      // is a non-null assertion, and this module's whole purpose is refusing unbacked booleans.
      throw new Error(
        `agent '${agent}' produced no readiness-bearing evidence`,
      );
    }
    const merged: WorkspaceHostAgentVerificationEvidence =
      selfReportedSubjectDigest
        ? { ...readiness, selfReportedSubjectDigest }
        : readiness;
    // The merge builds a new object that leaves this function, so it faces the same gate the
    // probe's own evidence did rather than inheriting a pass from before the field was added.
    assertWorkspaceHostSecretIsolation(
      merged,
      `workspaceHost.agentAuthentication.${agent}`,
    );
    agents[agent] = merged;
  }
  const report: WorkspaceHostAgentVerificationReport = {
    contractVersion: WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
    observedAt: now().toISOString(),
    allReady: WORKSPACE_HOST_CANARY_AGENTS.every(
      (agent) => agents[agent]?.ready === true,
    ),
    ...(input.requestedAgents !== undefined ? { requestedAgents } : {}),
    agents,
  };
  assertWorkspaceHostSecretIsolation(
    report,
    "workspaceHost.agentAuthentication.report",
  );
  return report;
}
