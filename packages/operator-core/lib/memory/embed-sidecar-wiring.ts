/**
 * Sidecar-aware embedder builders (P-004, plan
 * shared-embedding-sidecar-and-enrichment-2026-07-10).
 *
 * The ONE wiring seam between the operator's embedder cascade and the shared
 * embedding sidecar. Every production site that used to call
 * `buildGemmaEmbedder` / `buildLocalEmbedder` directly (configure.ts's
 * `buildEmbedderForMode` + `resolveEmbedder`, agent-tools/search's
 * `buildQueryEmbedder`, embed-backfill's `resolveBackfillEmbedder`) now
 * injects `buildSidecarAwareEmbedder` instead, so the sidecar-vs-in-process
 * decision lives HERE, once:
 *
 *   1. PAPERCUSP_EMBED_SIDECAR_URL set  → use that sidecar (it may be owned
 *      by another process, e.g. the bg-host spawned it for the whole box).
 *   2. PAPERCUSP_EMBED_SIDECAR=1        → lazily ensure the host-local
 *      sidecar (spawn once, or adopt a sibling's — embed-sidecar-spawn.ts)
 *      and use its loopback URL.
 *   3. neither                          → null URL: buildSidecarFirstEmbedder
 *      degenerates to the plain in-process embedder — byte-for-byte today's
 *      behavior, zero per-call overhead.
 *
 * Space safety is inherited, not re-argued: the sidecar wraps the SAME
 * builders, so vectors are bit-identical either way (D-002, live-verified in
 * P-002/P-003). Since WI-4021 a configured sidecar is REQUIRED (D-003
 * retired): sidecar failures throw after brief in-budget retries instead of
 * silently failing over to an in-process model; the in-process builders are
 * the sole engine ONLY where no sidecar is configured (case 3).
 */
import {
  buildGemmaEmbedder,
  buildHarrierEmbedder,
  buildLocalEmbedder,
  buildSidecarFirstEmbedder,
  resolveEmbedSidecarUrl,
  type EmbedFn,
  type GemmaEmbedKind,
} from '@papercusp/memory';
import { buildSidecarFirstReranker, type RerankScoreFn } from '@papercusp/rerank';
import {
  describeUnfitSidecar,
  embedSidecarEnabled,
  ensureEmbedSidecar,
  isEmbedSidecarReady,
  probeSidecarHealth,
} from './embed-sidecar-spawn';
import {
  EMBED_SIDECAR_CAP_EMBED,
  EMBED_SIDECAR_CAP_RERANK,
  EMBED_SIDECAR_LEGACY_CAPABILITIES,
  type RerankSidecarModel,
} from './embed-sidecar-server';
import { verifySidecarFitness } from '../process-supervision/sidecar-spawn-shared';
import { ensureEmbedDeviceSettingLoaded } from './embed-device-setting';
import { pinModuleState } from '@papercusp/module-singleton';

/**
 * A process-wide replacement for the LOCAL embed engine (EI-24688584300743328).
 *
 * Returns the EmbedFn to use for `(model, kind)`, or null to fall through to
 * the normal sidecar/in-process cascade. It is consulted FIRST in
 * `buildSidecarAwareEmbedder`, before any sidecar resolution, so an override
 * means no sidecar spawn, no /healthz probe and no model construction.
 *
 * Why it exists: this function is the single choke point for every
 * in-process local model build in the operator (memory/configure.ts twice,
 * search/embed-backfill, agent-tools/search/embedder, personal-vault). A test
 * fixture that swaps only ONE of those cascades (the memory host) leaves the
 * other three free to construct the real ONNX model — measured: the P-013
 * benchmark parent loaded onnxruntime CUDA (~5 GB of GPU) through the
 * declare-intent → embed-backfill leg while the fixture was installed. Setting
 * the override here covers all four by construction.
 *
 * Only test fixtures set it. Production never does, so production behavior is
 * byte-for-byte unchanged (the check is one null read).
 */
export type LocalEmbedEngineOverride = (
  model: 'gemma' | 'local' | 'harrier',
  kind: GemmaEmbedKind,
) => EmbedFn | null;

// Pinned through @papercusp/module-singleton: a fixture and production code can
// reach this module through different specifiers (relative path vs the package
// graph), and a split module record would silently leave the override unset
// on the production side.
const engineOverride = pinModuleState<{ embed: LocalEmbedEngineOverride | null }>(
  '@papercusp/operator-core.localEmbedEngineOverride',
  () => ({ embed: null }),
);

/** Install (or clear, with null) the process-wide local embed engine override. */
export function setLocalEmbedEngineOverride(override: LocalEmbedEngineOverride | null): void {
  engineOverride.embed = override;
}

/** Whether a local embed engine override is installed in this process. */
export function hasLocalEmbedEngineOverride(): boolean {
  return engineOverride.embed !== null;
}

/** Injectable seams (tests swap the env read + the spawn side effect). */
export interface SidecarWiringDeps {
  resolveUrl: () => string | null;
  ensure: (requiredCapabilities: readonly string[]) => Promise<string | null>;
  /** /healthz probe for the EXPLICIT-URL path (that sidecar is owned by another
   *  process, so this one never saw it start and cannot know its build). */
  probeHealth: (url: string) => Promise<unknown | null>;
}

const defaultDeps: SidecarWiringDeps = {
  resolveUrl: resolveEmbedSidecarUrl,
  ensure: ensureEmbedSidecar,
  probeHealth: probeSidecarHealth,
};

/** Version-skew is a standing condition, not a per-call event — log each
 *  distinct (url, missing) once so a stale sidecar says its piece loudly and
 *  then stops shouting. */
const reportedSkew = new Set<string>();

/**
 * The sidecar URL THIS process should use for `requiredCapabilities`, or null
 * for pure in-process. Explicit URL wins over the spawn-locally opt-in (an
 * operator fleet points workers at one URL; the owner host sets the opt-in).
 *
 * ⚠ Both paths are capability-verified, and the EXPLICIT one especially: it
 * points at a sidecar owned by another process (typically
 * papercup-embed-sidecar.service), so this process never saw it start and has
 * no idea which build it is running. Before EI-19314150478401738 that path did
 * NO check at all — not even liveness — which is how a 16-day-old bundle kept
 * being handed out for a /rerank route it had never contained.
 *
 * Verification is per-CAPABILITY, not per-sidecar: a pre-advertisement build
 * still serves /embed perfectly well, so embedding keeps using it while only
 * the capability it genuinely lacks falls back. Refusing the whole sidecar
 * would turn one silent bug into a fleet-wide embedding regression.
 */
export async function resolveProcessSidecarUrl(
  deps: SidecarWiringDeps = defaultDeps,
  requiredCapabilities: readonly string[] = [],
): Promise<string | null> {
  const explicit = deps.resolveUrl();
  if (!explicit) return deps.ensure(requiredCapabilities);

  const health = await deps.probeHealth(explicit);
  // A sidecar that is merely DOWN is not a skew problem, and must NOT resolve
  // to null here: WI-4021 (D-003 retired) makes a configured sidecar REQUIRED,
  // so the URL is handed back and the client's retry-then-throw contract owns
  // the outage. Returning null for an outage would silently reinstate the
  // in-process failover that retirement removed — a much worse bug than the
  // one being fixed. ONLY a capability mismatch refuses below.
  if (health === null) return explicit;

  const fitness = verifySidecarFitness(health, requiredCapabilities, EMBED_SIDECAR_LEGACY_CAPABILITIES);
  if (fitness.fit) return explicit;

  const key = `${explicit}|${fitness.reason}|${fitness.missing.join(',')}`;
  if (!reportedSkew.has(key)) {
    reportedSkew.add(key);
    console.error(describeUnfitSidecar(explicit, fitness));
  }
  return null;
}

/** Test seam — clear the once-per-condition skew log memo. */
export function _resetSidecarSkewReportForTests(): void {
  reportedSkew.clear();
}

/**
 * Would resolving this process's LOCAL embed acquisition (the
 * no-explicit-URL leg of `resolveProcessSidecarUrl`) be cheap right now, or
 * does it require waiting out a cold sidecar spawn? WI-3923: a bounded
 * interactive caller (e.g. `buildQueryEmbedderResolved`'s
 * `skipAcquisitionWhenCold`) uses this to avoid paying its FULL acquisition
 * budget on every query while OpenAI embed is in cooldown and the local
 * pipeline hasn't warmed yet — skip attempting local for THIS query (degrade
 * straight to BM25) while a background acquisition still warms the pipeline
 * for the next one.
 *
 * Mirrors `resolveProcessSidecarUrl`'s own branching so it can never drift
 * from what that function actually does:
 *  - an EXPLICIT sidecar URL (owned by another process) only ever costs a
 *    capped ~1.5s `/healthz` probe (`probeSidecarHealth`) — already well
 *    under a typical interactive budget, so always "cheap".
 *  - NO sidecar configured on this host at all: `buildSidecarFirstEmbedder`
 *    degenerates to the in-process fallback with ZERO acquisition overhead
 *    (its model load is deferred past acquisition, to the first actual
 *    `embed(text)` call) — always "cheap".
 *  - a host-local sidecar THIS process is responsible for spawning
 *    (`PAPERCUSP_EMBED_SIDECAR=1`) is cheap only once it has completed its
 *    ready handshake — the one case that can genuinely cost several seconds.
 */
export function isLocalEmbedAcquisitionCheap(
  deps: { resolveUrl: () => string | null; sidecarEnabled: () => boolean; sidecarReady: () => boolean } = {
    resolveUrl: resolveEmbedSidecarUrl,
    sidecarEnabled: embedSidecarEnabled,
    sidecarReady: isEmbedSidecarReady,
  },
): boolean {
  if (deps.resolveUrl()) return true;
  if (!deps.sidecarEnabled()) return true;
  return deps.sidecarReady();
}

/**
 * Transition reporter injected into BOTH sidecar-backed builders below
 * (EI-20006179456846006).
 *
 * A sidecar availability transition is INFRASTRUCTURE state: it says something
 * about the box, never about the code that happens to be running when it flips.
 * @papercusp/memory and @papercusp/rerank both DEFAULT `onTransition` to
 * `console.warn`, which under a test runner `vitest-fail-on-console` converts
 * into a failure of whichever test is mid-flight — measured red-ing a RANKING
 * diagnostic in owner-query-relevance.integration.test.ts when the :3384 sidecar
 * RECOVERED mid-run. Two properties make that maximally expensive to triage: the
 * victim is unrelated to the subject (so it reads as a ranking regression), and
 * it cannot reproduce on re-run (so it then gets written off as flake).
 *
 * Fixed HERE rather than in the shared libs on purpose. The generic default is
 * the right one for a consumer with no opinion, and both libs expose
 * `onTransition` precisely so a HOST can decide how its own environment reports
 * infrastructure state — so exercising that seam beats changing a default that
 * also feeds production logging for every other consumer.
 *
 * This is a CHANNEL change, never suppression: the identical line still reaches
 * the run output (fail-on-console polices warn/error and ignores log), so a
 * sidecar flap that degrades an eval stays diagnosable — the whole reason the
 * message exists. Production severity is deliberately untouched.
 */
function reportSidecarTransition(subject: string) {
  return (state: 'down' | 'up' | 'rejected', detail: string): void => {
    const line = `${subject} sidecar ${state}: ${detail}`;
    if (process.env.VITEST || process.env.NODE_ENV === 'test') {
      console.log(line);
      return;
    }
    console.warn(line);
  };
}

/**
 * Build a local embedder ('gemma' | 'local'/BGE | 'harrier') for `kind`,
 * served by the shared sidecar when one is configured/spawnable and
 * in-process otherwise. Drop-in replacement for the direct
 * `buildGemmaEmbedder({kind})` / `buildLocalEmbedder()` /
 * `buildHarrierEmbedder({kind})` calls at the cascade seams — same EmbedFn
 * shape, same vectors, same dims.
 */
/**
 * P-531: the per-attempt ensure hook for a sidecar THIS process spawns (or
 * adopts on the shared local port). Such a sidecar may exit after an idle
 * period, and the client calls this before each attempt to re-launch it.
 * Returns undefined when no local sidecar is in play: an explicit URL points
 * at a sidecar another process supervises (e.g. a systemd unit), and a null
 * URL with the local sidecar disabled means pure in-process.
 *
 * WI-10005932: a null URL with the local sidecar ENABLED is a sidecar that did
 * not come up in time (P-532d: a contended cold boot timed out its first
 * start). That still gets the hook, so the client stays sidecar-only and picks
 * up the URL on a later attempt. Returning undefined there built the in-process
 * model in the main Server and kept it next to the sidecar for good.
 */
export function localSidecarEnsure(
  deps: SidecarWiringDeps,
  url: string | null,
  capability: string,
  sidecarEnabled: () => boolean = embedSidecarEnabled,
): (() => Promise<unknown>) | undefined {
  if (deps.resolveUrl()) return undefined;
  if (url === null && !sidecarEnabled()) return undefined;
  return () => deps.ensure([capability]);
}

export async function buildSidecarAwareEmbedder(
  model: 'gemma' | 'local' | 'harrier',
  kind: GemmaEmbedKind,
  deps: SidecarWiringDeps = defaultDeps,
): Promise<EmbedFn> {
  // A test-fixture override wins over every engine, before any sidecar I/O.
  const overridden = engineOverride.embed?.(model, kind) ?? null;
  if (overridden) return overridden;
  const url = await resolveProcessSidecarUrl(deps, [EMBED_SIDECAR_CAP_EMBED]);
  return buildSidecarFirstEmbedder({
    model,
    kind,
    url,
    ensure: localSidecarEnsure(deps, url, EMBED_SIDECAR_CAP_EMBED),
    // Same text the lib's own default emits — only the channel differs, and
    // only under a test runner. See reportSidecarTransition.
    onTransition: reportSidecarTransition(`[sidecar-embedder] ${model}:${kind}`),
    // BGE is symmetric — buildLocalEmbedder has no kind knob; gemma and
    // harrier are asymmetric dual-encoders, so kind picks their task prompt
    // (both sides of this fallback match what the sidecar does server-side,
    // by construction).
    //
    // The in-process engine reads the Settings device choice (Auto/GPU/CPU)
    // once per process before its first model build — the sidecar does the
    // same at its own boot (plan memory-reduction-2026-09-24 D-008).
    fallback: async () => {
      await ensureEmbedDeviceSettingLoaded();
      return model === 'gemma'
        ? buildGemmaEmbedder({ kind })
        : model === 'harrier'
          ? buildHarrierEmbedder({ kind })
          : buildLocalEmbedder();
    },
  });
}

/**
 * Build a cross-encoder reranker served by the shared sidecar when one is
 * configured/spawnable, and in-process otherwise — the reranker analog of
 * buildSidecarAwareEmbedder, resolving the sidecar URL through the SAME seam
 * (one sidecar process serves both /embed and /rerank, so a host that already
 * runs one gets reranking through it for free).
 *
 * The contract is deliberately identical: with a sidecar the sidecar is
 * REQUIRED (brief retries, then throw — no silent in-process failover that
 * would duplicate a ~150M-param model per process and hide sidecar sickness);
 * the in-process engine is the sole engine only when none is configured.
 *
 * That throw is not a hazard to search: @papercusp/rerank's single fail-safe
 * seam converts it into "keep retrieval order" at the ranking layer, so an
 * outage degrades instead of erroring — it just stops being invisible.
 */
export async function buildSidecarAwareReranker(
  model: RerankSidecarModel = 'rerank',
  deps: SidecarWiringDeps = defaultDeps,
): Promise<RerankScoreFn> {
  const url = await resolveProcessSidecarUrl(deps, [EMBED_SIDECAR_CAP_RERANK]);
  // The reranker carries the IDENTICAL defaulted-to-console.warn transition
  // reporter, so it is the same latent red on a different sidecar capability —
  // fixed here at the same time rather than waiting for it to be filed too.
  return buildSidecarFirstReranker({
    model,
    url,
    ensure: localSidecarEnsure(deps, url, EMBED_SIDECAR_CAP_RERANK),
    onTransition: reportSidecarTransition(`[sidecar-reranker] ${model}`),
  });
}

/**
 * Whether THIS process has an embed-sidecar story at all (an explicit URL, or the
 * spawn-locally opt-in), decided WITHOUT ensuring it. `resolveProcessSidecarUrl`
 * answers by ENSURING the sidecar, which spawns the child when it is down. A
 * background caller must not do that just to learn it has nothing to embed (D-050).
 */
export function processSidecarConfigured(deps: Pick<SidecarWiringDeps, 'resolveUrl'> = defaultDeps): boolean {
  return Boolean(deps.resolveUrl()) || embedSidecarEnabled();
}

/**
 * `buildSidecarAwareEmbedder`, with the sidecar resolution (and so any spawn)
 * deferred to the first real embed call (D-050, P-532c).
 *
 * This is for BACKGROUND callers that rebuild on a cadence. The 5-min embed
 * backfill sweep re-resolves its embedder every tick. Built eagerly, each
 * resolution ensured the sidecar, so a fully drained Server respawned its ~2 GB
 * embed child on every sweep and the idle exit never held (cap-p532c: the
 * sidecar was up about 5 min of every 10 with zero real embeds). Interactive
 * callers keep the eager builder, because their warm-up exists to pay the spawn
 * before a user is waiting.
 *
 * A failed first build is not cached; the next call retries it.
 */
export function buildDeferredSidecarAwareEmbedder(
  model: 'gemma' | 'local' | 'harrier',
  kind: GemmaEmbedKind,
  deps: SidecarWiringDeps = defaultDeps,
): EmbedFn {
  let built: Promise<EmbedFn> | null = null;
  return async (text: string, signal?: AbortSignal): Promise<number[]> => {
    signal?.throwIfAborted();
    if (!built) {
      built = buildSidecarAwareEmbedder(model, kind, deps).catch((e: unknown) => {
        built = null;
        throw e;
      });
    }
    const embed = await built;
    return embed(text, signal);
  };
}
