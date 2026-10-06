/**
 * Just-in-time authentication of the exact sealed agent generation a workspace host will receive.
 *
 * Delivery proves that bytes named by `(reference, generation)` reached the guest; it does not
 * prove those bytes still authenticate. The controller's ambient HOME cannot answer that question:
 * it may hold a newer, healthy account while the immutable stored generation is revoked. This
 * verifier resolves the exact stored bundle, installs it only into a private temporary home, and
 * delegates authentication to the existing closed workspace-host agent probe contract.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

import {
  DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES,
  NodeWorkspaceHostAgentProbeRunner,
  WORKSPACE_HOST_AGENT_HOME_OMP_LOCAL_MODELS_YML,
  WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
  WORKSPACE_HOST_CANARY_AGENTS,
  WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS,
  assertWorkspaceHostAgentHomeBundleAdmissionEligible,
  assertWorkspaceHostSecretIsolation,
  parseWorkspaceHostAgentHomeBundle,
  parseWorkspaceHostCredentialReference,
  probeWorkspaceHostAgentVerification,
  resolveWorkspaceHostRequestedAgents,
  workspaceHostAgentHomeDirectories,
  workspaceHostAgentHomeOmpModelsPath,
  workspaceHostAgentHomePaths,
  workspaceHostAgentSpecSatisfiesReadiness,
  workspaceHostCredentialReferenceDigest,
  type ProbeWorkspaceHostAgentsInput,
  type WorkspaceHostAgentHomeBundle,
  type WorkspaceHostAgentProbeRunner,
  type WorkspaceHostAgentVerificationEvidence,
  type WorkspaceHostAgentVerificationKind,
  type WorkspaceHostAgentVerificationProbeSpec,
  type WorkspaceHostCanaryAgent,
  type WorkspaceHostCredentialDelivery,
  type WorkspaceHostCredentialFamily,
  type WorkspaceHostCredentialRefs,
} from '@papercusp/deployment-driver';

import type { WorkspaceHostCredentialMaterialSource } from './credential-material-source';

export const WORKSPACE_HOST_AGENT_CREDENTIAL_ADMISSION_CONTRACT_VERSION =
  'papercusp-workspace-host-agent-credential-admission-v1';

const WORKSPACE_HOST_PUBLIC_REFERENCE_DIGEST = /^[0-9a-f]{32}$/;

type AgentCredentialRef = NonNullable<WorkspaceHostCredentialRefs['agentCredentialRef']>;

export interface WorkspaceHostAgentCredentialAdmissionInput {
  readonly credentialRef: AgentCredentialRef;
  readonly delivery: WorkspaceHostCredentialDelivery;
  readonly materialSource: WorkspaceHostCredentialMaterialSource;
  readonly requestedAgents?: readonly WorkspaceHostCanaryAgent[];
}

export interface WorkspaceHostAgentCredentialAdmissionEvidence {
  readonly contractVersion: typeof WORKSPACE_HOST_AGENT_CREDENTIAL_ADMISSION_CONTRACT_VERSION;
  readonly sourceKind: 'operator-integration-credentials';
  readonly binding: {
    readonly channel: 'agent';
    readonly family: WorkspaceHostCredentialFamily;
    readonly generation: number;
    /** Digest of PUBLIC reference metadata only — never of credential material (D-215). */
    readonly referenceDigest: string;
  };
  readonly observedAt: string;
  readonly verification: {
    readonly contractVersion: typeof WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION;
    readonly observedAt: string;
    /**
     * READINESS: every credentialed agent probe returned ready. This is what the canary/readiness
     * layer asks — "can these agents actually do work" — and it is deliberately NOT the admission
     * predicate. Do not widen it.
     */
    readonly allReady: boolean;
    /** Explicit coverage; excluded agents are neither authenticated nor reported ready. */
    readonly requestedAgents?: readonly WorkspaceHostCanaryAgent[];
    readonly agents: Readonly<Partial<Record<WorkspaceHostCanaryAgent, WorkspaceHostAgentVerificationEvidence>>>;
    /** Agents whose bundle member is intentionally null and therefore has no credential to authenticate. */
    readonly credentialFreeAgents: readonly WorkspaceHostCanaryAgent[];
    /**
     * Agents that authenticated but whose provider reports the account out of quota. A
     * `provider-usage-limit` refusal is only reportable for an ACCEPTED identity — the classifier
     * that produces it separates it from `credential-revoked` / `credential-malformed` /
     * `credential-unauthorized` precisely because those describe a credential and this one does
     * not. It is therefore positive evidence the bytes authenticated and resolved to a real
     * account, which is exactly what admission is asking.
     */
    readonly unfundedAgents: readonly WorkspaceHostCanaryAgent[];
    /**
     * ADMISSION: every agent is credential-free, ready, or authenticated-but-unfunded. Admission
     * answers authenticity only; conflating it with funding made a transient provider state
     * hard-fail a durable install.
     */
    readonly admissible: boolean;
  };
}

export class WorkspaceHostAgentCredentialAdmissionError extends Error {
  constructor(readonly evidence: WorkspaceHostAgentCredentialAdmissionEvidence) {
    const failed = Object.entries(evidence.verification.agents)
      .filter(([, result]) => !result.ready)
      .map(([agent, result]) => `${agent}:${result.failure ?? 'not-ready'}`);
    super(
      `Workspace-host agent credential generation ${evidence.binding.generation} failed ` +
        `authentication admission (${failed.join(', ') || 'verification-incomplete'})`,
    );
    this.name = 'WorkspaceHostAgentCredentialAdmissionError';
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isWorkspaceHostCanaryAgent(value: unknown): value is WorkspaceHostCanaryAgent {
  return typeof value === 'string' && WORKSPACE_HOST_CANARY_AGENTS.some((agent) => agent === value);
}

function isAgentCredentialFamily(value: unknown): value is WorkspaceHostCredentialFamily {
  return Object.values(WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS).some(
    (spec) => spec.family === value && spec.channel === 'agent',
  );
}

/**
 * The ONE probe failure reason that is compatible with an authentic credential.
 *
 * The probe classifier reports quota only for an identity the provider ACCEPTED — an unauthenticated
 * call cannot be attributed to an account, so it cannot be told it has run out of one. Every other
 * reason (`credential-revoked`, `credential-malformed`, `credential-unauthorized`, and the shape
 * codes) either describes the credential or fails to establish anything about it, and none of them
 * may be admitted.
 */
const WORKSPACE_HOST_UNFUNDED_PROBE_FAILURE = 'provider-usage-limit';

type AdmissionProbeTable = ProbeWorkspaceHostAgentsInput['probes'];

/**
 * The probes admission RUNS for one agent, and therefore the only verification kinds a receipt may
 * carry (WI-10005806). Derived from the probe table, never restated, for the reason WI-10002402
 * derived `workspaceHostAgentAllowedVerificationKinds`: a hand-copied kind rule here had drifted to
 * accept claude `authenticated-account` (removed from claude's probes by WI-10001689 because
 * `claude auth status` is forgeable) and to let a `satisfiesReadiness: false` spec decide.
 *
 * Two filters, each with its own reason:
 * - readiness-bearing only. A `satisfiesReadiness: false` spec (codex's `codex login status`,
 *   WI-10001694) contributes identity elsewhere and can never decide readiness; admission used to
 *   run it first and `break` on a pass, so a forgeable status line could admit the credential.
 * - OMP: `authenticated-account` only. A present OMP credential must authenticate its stored
 *   bytes; local inference proves the controller's Ollama runtime and says nothing about them.
 *   A credential-free OMP slot never reaches a probe at all (`credentialFreeAgents`).
 */
export function workspaceHostAgentAdmissionProbeSpecs(
  agent: WorkspaceHostCanaryAgent,
  probes?: AdmissionProbeTable,
): readonly WorkspaceHostAgentVerificationProbeSpec[] {
  const configured = probes?.[agent] ?? DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES[agent];
  return configured.filter(
    (spec) =>
      workspaceHostAgentSpecSatisfiesReadiness(spec) &&
      (agent !== 'omp' || spec.verificationKind === 'authenticated-account'),
  );
}

function admissionVerificationKinds(
  agent: WorkspaceHostCanaryAgent,
  probes?: AdmissionProbeTable,
): ReadonlySet<WorkspaceHostAgentVerificationKind> {
  return new Set(workspaceHostAgentAdmissionProbeSpecs(agent, probes).map((spec) => spec.verificationKind));
}

/**
 * A refusal that PROVES authentication: same evidence contract as a ready probe, but a non-zero
 * exit carrying the quota reason and no proof digest. Validated as strictly as the ready case so a
 * forged receipt cannot buy admission by simply claiming to be unfunded.
 */
function isUnfundedAgentVerificationEvidence(
  expectedAgent: WorkspaceHostCanaryAgent,
  value: unknown,
  reportObservedAt: number,
  allowedKinds: ReadonlySet<WorkspaceHostAgentVerificationKind>,
): value is WorkspaceHostAgentVerificationEvidence {
  if (!isRecord(value)) return false;
  const observedAt = isTimestamp(value.observedAt) ? Date.parse(value.observedAt) : Number.NaN;
  const verificationKindIsValid = allowedKinds.has(value.verificationKind as WorkspaceHostAgentVerificationKind);
  return (
    value.contractVersion === WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION &&
    value.agent === expectedAgent &&
    value.ready === false &&
    value.failure === WORKSPACE_HOST_UNFUNDED_PROBE_FAILURE &&
    verificationKindIsValid &&
    typeof value.endpoint === 'string' &&
    value.endpoint.length > 0 &&
    Number.isFinite(observedAt) &&
    observedAt <= reportObservedAt &&
    // A quota refusal never parsed a proof, so it must not carry one, and it must not disclose a
    // subject: both would mean this evidence came from somewhere other than a failed probe.
    value.proofDigest === undefined &&
    value.subject === undefined &&
    (value.subjectDisclosure === 'redacted' || value.subjectDisclosure === 'digest')
  );
}

function isReadyAgentVerificationEvidence(
  expectedAgent: WorkspaceHostCanaryAgent,
  value: unknown,
  reportObservedAt: number,
  allowedKinds: ReadonlySet<WorkspaceHostAgentVerificationKind>,
): value is WorkspaceHostAgentVerificationEvidence {
  if (!isRecord(value)) return false;
  const observedAt = isTimestamp(value.observedAt) ? Date.parse(value.observedAt) : Number.NaN;
  const verificationKindIsValid = allowedKinds.has(value.verificationKind as WorkspaceHostAgentVerificationKind);
  const subjectDisclosureIsValid = value.subjectDisclosure === 'redacted' || value.subjectDisclosure === 'digest';
  const subjectIsValid =
    value.subjectDisclosure === 'redacted'
      ? value.verificationKind === 'authenticated-account' &&
        typeof value.subject === 'string' &&
        value.subject.length > 0
      : value.subject === undefined;
  return (
    value.contractVersion === WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION &&
    value.agent === expectedAgent &&
    value.ready === true &&
    verificationKindIsValid &&
    typeof value.endpoint === 'string' &&
    value.endpoint.length > 0 &&
    value.exitStatus === 0 &&
    Number.isFinite(observedAt) &&
    observedAt <= reportObservedAt &&
    subjectDisclosureIsValid &&
    subjectIsValid &&
    typeof value.proofDigest === 'string' &&
    value.proofDigest.length > 0 &&
    value.failure === undefined
  );
}

/**
 * Validate a receipt before a caller persists or reuses it as an admission decision.
 *
 * `probes` names the probe table the receipt is checked against; omitted, it is the shipped
 * default, which is what every persisted receipt must match. Only `verify…` passes its own.
 */
export function assertWorkspaceHostAgentCredentialAdmissionEvidence(
  evidence: unknown,
  expected?: Pick<WorkspaceHostAgentCredentialAdmissionInput, 'credentialRef' | 'delivery' | 'requestedAgents'>,
  probes?: AdmissionProbeTable,
): asserts evidence is WorkspaceHostAgentCredentialAdmissionEvidence {
  if (!isRecord(evidence) || !isRecord(evidence.binding) || !isRecord(evidence.verification)) {
    throw new Error('workspace-host agent credential admission evidence is incomplete or not ready');
  }
  const { binding, verification } = evidence;
  if (
    evidence.contractVersion !== WORKSPACE_HOST_AGENT_CREDENTIAL_ADMISSION_CONTRACT_VERSION ||
    evidence.sourceKind !== 'operator-integration-credentials' ||
    binding.channel !== 'agent' ||
    !isAgentCredentialFamily(binding.family) ||
    !Number.isSafeInteger(binding.generation) ||
    (binding.generation as number) < 1 ||
    typeof binding.referenceDigest !== 'string' ||
    !WORKSPACE_HOST_PUBLIC_REFERENCE_DIGEST.test(binding.referenceDigest) ||
    !isTimestamp(evidence.observedAt) ||
    verification.contractVersion !== WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION ||
    verification.observedAt !== evidence.observedAt ||
    typeof verification.allReady !== 'boolean' ||
    verification.admissible !== true ||
    !isRecord(verification.agents) ||
    !Array.isArray(verification.credentialFreeAgents) ||
    !Array.isArray(verification.unfundedAgents)
  ) {
    throw new Error('workspace-host agent credential admission evidence is incomplete or not ready');
  }

  const credentialFreeAgents = verification.credentialFreeAgents;
  const requestedAgents = resolveWorkspaceHostRequestedAgents(verification.requestedAgents);
  if (expected && JSON.stringify(resolveWorkspaceHostRequestedAgents(expected.requestedAgents)) !== JSON.stringify(requestedAgents)) {
    throw new Error('workspace-host agent credential admission requestedAgents does not match the requested binding');
  }
  const credentialFreeSet = new Set(credentialFreeAgents);
  const unfundedAgents = verification.unfundedAgents as readonly unknown[];
  const unfundedSet = new Set(unfundedAgents);
  if (
    credentialFreeSet.size !== credentialFreeAgents.length ||
    credentialFreeAgents.some((agent) => !isWorkspaceHostCanaryAgent(agent) || agent !== 'omp') ||
    Object.keys(verification.agents).some((agent) => !requestedAgents.includes(agent as WorkspaceHostCanaryAgent)) ||
    credentialFreeAgents.some((agent) => !requestedAgents.includes(agent as WorkspaceHostCanaryAgent)) ||
    unfundedAgents.some((agent) => !requestedAgents.includes(agent as WorkspaceHostCanaryAgent)) ||
    (requestedAgents.length < WORKSPACE_HOST_CANARY_AGENTS.length && verification.allReady !== false) ||
    unfundedSet.size !== unfundedAgents.length ||
    unfundedAgents.some((agent) => !isWorkspaceHostCanaryAgent(agent)) ||
    // An agent cannot be both "has no credential to authenticate" and "authenticated but unfunded".
    unfundedAgents.some((agent) => credentialFreeSet.has(agent as WorkspaceHostCanaryAgent)) ||
    // `allReady` is a readiness claim, so an unfunded agent must falsify it. A receipt asserting
    // both is internally incoherent and must not be trusted by the layers that read allReady.
    (unfundedAgents.length > 0 && verification.allReady !== false)
  ) {
    throw new Error('workspace-host agent credential admission evidence has invalid agent coverage');
  }

  const reportObservedAt = Date.parse(verification.observedAt as string);
  for (const agent of requestedAgents) {
    const agentEvidence = verification.agents[agent];
    if (credentialFreeSet.has(agent)) {
      if (agentEvidence !== undefined) {
        throw new Error(
          `workspace-host agent credential admission evidence overlaps credential-free '${agent}' coverage`,
        );
      }
      continue;
    }
    // Admission accepts exactly two shapes: a ready probe, or a quota refusal that proves the
    // credential authenticated. Every identity refusal still lands in the `else` and throws.
    const allowedKinds = admissionVerificationKinds(agent, probes);
    const admissibleEvidence = unfundedSet.has(agent)
      ? isUnfundedAgentVerificationEvidence(agent, agentEvidence, reportObservedAt, allowedKinds)
      : isReadyAgentVerificationEvidence(agent, agentEvidence, reportObservedAt, allowedKinds);
    if (!admissibleEvidence) {
      throw new Error(`workspace-host agent credential admission evidence has invalid '${agent}' verification`);
    }
  }
  if (
    expected &&
    (binding.generation !== expected.delivery.generation ||
      binding.referenceDigest !== workspaceHostCredentialReferenceDigest(expected.credentialRef.ref))
  ) {
    throw new Error('workspace-host agent credential admission evidence does not match the requested binding');
  }
  assertWorkspaceHostSecretIsolation(evidence, 'workspaceHost.agentCredentialAdmission');
}

const FORWARDED_PROBE_ENVIRONMENT = [
  'PATH',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

export interface WorkspaceHostAgentCredentialAdmissionDependencies {
  readonly runner?: WorkspaceHostAgentProbeRunner;
  readonly probes?: ProbeWorkspaceHostAgentsInput['probes'];
  readonly now?: () => Date;
  /** Test seam. Values outside the fixed connectivity allowlist are deliberately discarded. */
  readonly environment?: Readonly<Record<string, string>>;
  readonly temporaryParent?: string;
}

function probeEnvironment(
  home: string,
  supplied: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const name of FORWARDED_PROBE_ENVIRONMENT) {
    const value = supplied[name];
    if (typeof value === 'string' && value.length > 0) environment[name] = value;
  }
  if (!environment.PATH) {
    throw new Error('workspace-host agent credential admission requires a controller PATH');
  }
  const username = userInfo().username;
  return { ...environment, HOME: home, USER: username, LOGNAME: username };
}

async function installTemporaryAgentHome(home: string, bundle: WorkspaceHostAgentHomeBundle): Promise<void> {
  for (const directory of workspaceHostAgentHomeDirectories(home)) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  const paths = workspaceHostAgentHomePaths(home);
  for (const agent of Object.keys(paths) as Array<keyof typeof paths>) {
    const bytes = bundle.files[agent];
    if (bytes === null) continue;
    await writeFile(paths[agent], bytes, { flag: 'wx', mode: 0o600 });
  }
  if (bundle.files.omp === null) {
    const modelsPath = workspaceHostAgentHomeOmpModelsPath(home);
    await mkdir(dirname(modelsPath), { recursive: true, mode: 0o700 });
    await writeFile(modelsPath, WORKSPACE_HOST_AGENT_HOME_OMP_LOCAL_MODELS_YML, {
      flag: 'wx',
      mode: 0o600,
    });
  }
}

/** Authenticate one exact stored agent generation and emit only closed, public evidence. */
export async function verifyWorkspaceHostAgentCredentialAdmission(
  input: WorkspaceHostAgentCredentialAdmissionInput,
  dependencies: WorkspaceHostAgentCredentialAdmissionDependencies = {},
): Promise<WorkspaceHostAgentCredentialAdmissionEvidence> {
  const requestedAgents = resolveWorkspaceHostRequestedAgents(input.requestedAgents);
  const parsed = parseWorkspaceHostCredentialReference(input.credentialRef.ref, 'agent');
  if (!Number.isSafeInteger(input.delivery.generation) || input.delivery.generation < 1) {
    throw new Error('workspace-host agent credential generation must be a positive safe integer');
  }

  const material = await input.materialSource.resolve({
    channel: 'agent',
    credentialRef: input.credentialRef.ref,
    family: parsed.family,
    generation: input.delivery.generation,
  });
  const materialBytes = material.reveal();
  let temporary: string | undefined;
  let bundle: WorkspaceHostAgentHomeBundle | undefined;
  try {
    bundle = parseWorkspaceHostAgentHomeBundle(materialBytes);
    assertWorkspaceHostAgentHomeBundleAdmissionEligible(bundle);
    temporary = await mkdtemp(join(dependencies.temporaryParent ?? tmpdir(), 'papercusp-agent-admission-'));
    await chmod(temporary, 0o700);
    await installTemporaryAgentHome(temporary, bundle);
    const now = dependencies.now ?? (() => new Date());
    const runner = dependencies.runner ?? new NodeWorkspaceHostAgentProbeRunner();
    const environment = probeEnvironment(temporary, dependencies.environment);
    const agents: Partial<Record<WorkspaceHostCanaryAgent, WorkspaceHostAgentVerificationEvidence>> = {};
    const credentialFreeAgents: WorkspaceHostCanaryAgent[] = [];
    for (const agent of requestedAgents) {
      if (agent === 'omp' && bundle.files.omp === null) {
        credentialFreeAgents.push(agent);
        continue;
      }
      // Readiness-bearing specs only, and authenticated-account only for a present OMP credential:
      // see workspaceHostAgentAdmissionProbeSpecs for why each filter exists.
      const specs = workspaceHostAgentAdmissionProbeSpecs(agent, dependencies.probes);
      if (specs.length === 0) {
        throw new Error(`agent credential admission has no credential-authentication probe for '${agent}'`);
      }
      for (const spec of specs) {
        const result = await probeWorkspaceHostAgentVerification({
          spec,
          runner,
          now,
          env: environment,
          cwd: temporary,
        });
        agents[agent] = result;
        if (result.ready) break;
      }
    }
    const observedAt = now().toISOString();
    const unfundedAgents = requestedAgents.filter(
      (agent) =>
        !credentialFreeAgents.includes(agent) &&
        agents[agent]?.ready !== true &&
        agents[agent]?.failure === WORKSPACE_HOST_UNFUNDED_PROBE_FAILURE,
    );
    const verification = {
      contractVersion: WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
      observedAt,
      ...(input.requestedAgents !== undefined ? { requestedAgents } : {}),
      allReady: WORKSPACE_HOST_CANARY_AGENTS.every(
        (agent) => credentialFreeAgents.includes(agent) || agents[agent]?.ready === true,
      ),
      agents,
      credentialFreeAgents,
      unfundedAgents,
      admissible: requestedAgents.every(
        (agent) =>
          credentialFreeAgents.includes(agent) || agents[agent]?.ready === true || unfundedAgents.includes(agent),
      ),
    } as const;
    const evidence: WorkspaceHostAgentCredentialAdmissionEvidence = {
      contractVersion: WORKSPACE_HOST_AGENT_CREDENTIAL_ADMISSION_CONTRACT_VERSION,
      sourceKind: 'operator-integration-credentials',
      binding: {
        channel: 'agent',
        family: parsed.family,
        generation: input.delivery.generation,
        referenceDigest: workspaceHostCredentialReferenceDigest(input.credentialRef.ref),
      },
      observedAt,
      verification,
    };
    // Admission asks authenticity, not funding: an authenticated-but-out-of-quota account is
    // admitted and recorded in `unfundedAgents`. "Can this agent do work" is `allReady`, which an
    // unfunded agent still falsifies.
    //
    // `allReady` is a COHERENCE field, not a flag another layer polls: no source file outside this
    // one reads `.allReady` (the only other hits are dist bundles of this file). The readiness
    // requirement is real but is enforced by RE-DERIVING readiness per agent — canary-runner.ts's
    // validateAgentEvidence (:195) independently demands `ready === true` plus a non-empty
    // proofDigest, both of which an unfunded agent fails — which is why canary-runner.ts:280 can
    // hardcode `allReady: true` as a justified post-validation constant. Do not restate this as
    // "the canary layer requires allReady"; that reading sends the next editor looking for a
    // consumer that does not exist.
    if (!verification.admissible) throw new WorkspaceHostAgentCredentialAdmissionError(evidence);
    assertWorkspaceHostAgentCredentialAdmissionEvidence(evidence, input, dependencies.probes);
    return evidence;
  } finally {
    // This tree contains the only plaintext copy outside the encrypted store. Cleanup failure is
    // therefore allowed to fail the request rather than being swallowed behind a successful probe.
    for (const bytes of bundle ? Object.values(bundle.files) : []) bytes?.fill(0);
    materialBytes.fill(0);
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
