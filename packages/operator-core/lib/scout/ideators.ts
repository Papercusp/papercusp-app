/**
 * Scout divergent generation (P-004, D-004) — the ideator fan-out.
 *
 * Runs N ideators over the corpus digest, each through a *distinct*
 * {@link CreativeLens} (the analogical lens additionally seeded with a distinct
 * distant domain), so the batch explores different regions of idea-space and
 * cannot collapse to the median ("forced diversity"). The roster construction is
 * a pure, testable function ({@link buildIdeatorRoster}); execution injects a
 * {@link ScoutLlmCall} (the gym:judge pattern) so the whole step unit-tests with
 * a fake call and no network.
 *
 * Output: a flat `Idea[]` (each tagged with its lens + grounded refs) handed to
 * the P-005 critics. One failed ideator never kills the batch (defensive, like
 * the change-feed's `safe()`).
 */
import type { CorpusDigest, CreativeLens, Idea, ScoutLlmCall } from './types';
import { CREATIVE_LENSES } from './types';
import {
  assignDistantDomain,
  buildIdeatorPrompt,
  buildRubricFocus,
  digestRefSet,
  DISTANT_DOMAINS,
  type DistantDomain,
} from './lenses';
import { DEFAULT_SCOUT_IDEATOR_MODEL } from './models';
import { admissionDenialFrom } from './capacity-errors';
import type { AdmissionDenial } from '@papercusp/papercusp-shared/agent';

/** The default ideator model — a strong model matters for the creative leap. */
export const SCOUT_IDEATOR_MODEL = DEFAULT_SCOUT_IDEATOR_MODEL;
/**
 * Bound one wedged ideator GENERATION so the whole Scout cycle can still make progress.
 *
 * WI-4475: this is a GENERATION cap, NOT a wall-clock cap on the whole call — its timer starts
 * when the shared governor ADMITS the request, not when the call is enqueued. Sizing evidence
 * (measured 2026-07-13 against the live gateway, at the ideator's exact params): opus-4-8 emits
 * ~62 tok/s, so a FULL 4096-token response takes ~66s; 180s leaves ~2.7x headroom. A call that
 * blows this budget is genuinely wedged mid-stream. Queue-wait is charged to the cycle deadline
 * instead (see `RunIdeatorsOptions.cycleDeadlineMs`) — conflating the two is what made a routine
 * rate-limit pause look like transport death.
 */
export const DEFAULT_SCOUT_IDEATOR_TIMEOUT_MS = 180_000;

/**
 * Output-token headroom for ONE ideator call — the room left for the response
 * ON TOP OF any requested thinking budget (`maxTokens = thinking + this`, or
 * just this when no thinking is requested).
 *
 * ⚠ Sized for SERVER-SIDE thinking, which bills against this same budget even
 * when no thinkingBudgetTokens is requested (client-side thinking is not even
 * plumbed — agent-chat-stream ignores it). At the previous 4096, thinking
 * consumed ~2.5-4k tokens and the JSON payload was TRUNCATED MID-ARRAY (or never
 * started) → parseIdeasPayload → [] → a silent ok:true/raw:0 outage (2026-07-16,
 * EI-13119 textHead capture + repro: outTok exactly 4096, textLen 0-2173, tail
 * cut mid-JSON). 16384 fits worst-case thinking + 4 full ideas with wide margin;
 * only generated tokens are billed, so the raise costs nothing on a normal call.
 *
 * Exported so the test asserts against THIS constant instead of re-typing the
 * literal: the 4096→16384 raise redded the release gate because ideators.test.ts
 * pinned the old number independently (WI-5097 gate sweep).
 */
export const IDEATOR_OUTPUT_HEADROOM_TOKENS = 16_384;

/**
 * Grace added to the admission backstop timer. The governor is supposed to bail on its own at
 * `governorMaxWaitMs` with an honest capacity error; this backstop only exists for a transport
 * that neither admits nor returns. The grace lets the governor's own error win that race.
 */
const ADMISSION_BACKSTOP_GRACE_MS = 5_000;

/**
 * WI-5784 — how far INSIDE the owning cycle's deadline this call's backstop must
 * fire. A backstop armed at (or past) the cycle deadline is dead code: the cycle's
 * timer wins and the tick records an opaque "cycle timed out during phase ideate"
 * instead of an honest, capacity-classifiable per-ideator error. Kept BELOW
 * cycle.ts's RETRY_LADDER_DEADLINE_MARGIN_MS (10s) so the retry ladder's more
 * precise 429/529 error still lands first when it applies.
 */
const CYCLE_DEADLINE_MARGIN_MS = 5_000;

/** One planned ideator: a lens, its within-lens index (drives domain rotation), and a global index. */
export interface IdeatorSlot {
  lens: CreativeLens;
  /** 0-based index within this lens (rotates the distant domain for analogical). */
  withinLens: number;
  /** 0-based index across the whole roster (stable id source). */
  globalIndex: number;
  /** The primed distant domain (analogical lens only). */
  seedDomain?: DistantDomain;
}

export interface BuildRosterInput {
  /** Lenses to run (default: all four; empty/duplicates normalized). */
  lenses?: readonly CreativeLens[];
  /** Base ideators per lens — floored at 1 so no lens is ever silenced (D-004). Default 1. */
  perLens?: number;
  /**
   * Per-lens win-weights (P-013 / D-009 hook): EXTRA ideators (beyond the base)
   * are distributed across lenses proportional to these weights. Never removes a
   * lens; diversity floor is preserved — weights only ADD to winning lenses.
   */
  lensWeights?: Partial<Record<CreativeLens, number>>;
  /** Total extra ideators to distribute by `lensWeights` (default 0 → weights inert). */
  extraIdeatorBudget?: number;
  /** Distant-domain pool/order for analogical ideators (default {@link DISTANT_DOMAINS}). */
  distantDomains?: readonly DistantDomain[];
}

/** Distinct, order-preserving lens list (defaults to all four). */
function normalizeLenses(lenses?: readonly CreativeLens[]): CreativeLens[] {
  const src = lenses && lenses.length > 0 ? lenses : CREATIVE_LENSES;
  const seen = new Set<CreativeLens>();
  const out: CreativeLens[] = [];
  for (const l of src) {
    if (!seen.has(l)) {
      seen.add(l);
      out.push(l);
    }
  }
  return out;
}

/**
 * Distribute `total` extra ideators across `lenses` proportional to `weights`,
 * by the largest-remainder method (stable, exact: the parts sum to `total`).
 * Lenses with no/zero weight get no extras. Returns a per-lens extra count.
 */
export function allocateExtraIdeators(
  lenses: readonly CreativeLens[],
  weights: Partial<Record<CreativeLens, number>>,
  total: number,
): Record<CreativeLens, number> {
  const out = Object.fromEntries(lenses.map((l) => [l, 0])) as Record<CreativeLens, number>;
  if (total <= 0) return out;
  const w = lenses.map((l) => Math.max(0, weights[l] ?? 0));
  const sum = w.reduce((a, b) => a + b, 0);
  if (sum <= 0) return out; // no signal → no extras
  const ideal = w.map((x) => (x / sum) * total);
  const floors = ideal.map((x) => Math.floor(x));
  let assigned = floors.reduce((a, b) => a + b, 0);
  lenses.forEach((l, i) => {
    out[l] = floors[i];
  });
  // Distribute the leftover to the largest fractional remainders.
  const remainders = lenses
    .map((l, i) => ({ l, rem: ideal[i] - floors[i] }))
    .sort((a, b) => b.rem - a.rem);
  let k = 0;
  while (assigned < total && k < remainders.length) {
    out[remainders[k].l] += 1;
    assigned += 1;
    k += 1;
  }
  return out;
}

/**
 * Build the ideator roster (pure). Guarantees the forced-diversity floor: every
 * requested lens gets ≥ `perLens` (≥1) ideators; `lensWeights`+`extraIdeatorBudget`
 * only ADD extra ideators to winning lenses. Analogical ideators rotate through
 * the distant-domain pool so even multiple analogical ideators diverge.
 */
export function buildIdeatorRoster(input: BuildRosterInput = {}): IdeatorSlot[] {
  const lenses = normalizeLenses(input.lenses);
  const perLens = Math.max(1, input.perLens ?? 1);
  const domains = input.distantDomains && input.distantDomains.length > 0 ? input.distantDomains : DISTANT_DOMAINS;

  const extras =
    input.lensWeights && (input.extraIdeatorBudget ?? 0) > 0
      ? allocateExtraIdeators(lenses, input.lensWeights, input.extraIdeatorBudget ?? 0)
      : (Object.fromEntries(lenses.map((l) => [l, 0])) as Record<CreativeLens, number>);

  const slots: IdeatorSlot[] = [];
  let globalIndex = 0;
  for (const lens of lenses) {
    const count = perLens + (extras[lens] ?? 0);
    for (let withinLens = 0; withinLens < count; withinLens++) {
      const seedDomain = lens === 'analogical' ? assignDistantDomain(withinLens, domains) : undefined;
      slots.push({ lens, withinLens, globalIndex, seedDomain });
      globalIndex++;
    }
  }
  return slots;
}

export interface RunIdeatorsOptions extends BuildRosterInput {
  llmCall: ScoutLlmCall;
  /** Max ideas each ideator may return (default 3). */
  maxIdeasPerIdeator?: number;
  /** Model id (default {@link SCOUT_IDEATOR_MODEL}). */
  model?: string;
  /** Extended-thinking budget per ideator (default none — cheaper). */
  thinkingBudgetTokens?: number;
  /** Abort all ideator calls when the parent Scout cycle is cancelled. */
  signal?: AbortSignal;
  /**
   * Per-ideator GENERATION cap (default {@link DEFAULT_SCOUT_IDEATOR_TIMEOUT_MS}; <=0 disables).
   *
   * WI-4475: this bounds the model actually STREAMING — its timer starts when the governor
   * ADMITS the call, not when the call is enqueued. It deliberately does NOT bound the
   * admission wait (see {@link cycleDeadlineMs}); charging queue-wait against this cap is what
   * turned a survivable rate-limit pause into a hard "transport timeout" with $0 spent.
   */
  ideatorTimeoutMs?: number;
  /**
   * WI-4475 — absolute epoch-ms deadline of the OWNING Scout cycle. The ADMISSION wait
   * (queueing behind the shared rate-limit governor) is bounded by the time actually left on
   * it, so an inner call can never outlive — or eat — the cycle that owns it.
   *
   * Absent ⇒ no admission bound is imposed (the host's own default applies), which is the
   * pre-WI-4475 behavior and keeps every existing caller/test byte-identical.
   */
  cycleDeadlineMs?: number;
  /**
   * Grace added to the admission backstop before we give up on a transport that never signals
   * admission (default {@link ADMISSION_BACKSTOP_GRACE_MS}). Exists so the governor's own honest
   * capacity error wins that race in production; tests inject a small value to stay fast.
   */
  admissionBackstopGraceMs?: number;
  /**
   * Optional gym-QD stepping-stone priming (P-012 archive→Scout): appended to
   * every ideator's grounded substrate so generation builds on the gym's
   * discovered elites. Empty/absent ⇒ cold start (no priming).
   */
  priming?: string;
  /** Dedicated crowded/empty niche guidance block (P-007). */
  nicheMapPriming?: string;
  /**
   * Per-blueprint ideator MISSION framing (P-010). Forwarded to every ideator's
   * prompt; absent ⇒ the default coding-platform framing (byte-identical).
   */
  mission?: string;
}

/** Per-ideator outcome (forced-diversity audit + provenance + failure isolation). */
export interface IdeatorRunInfo {
  lens: CreativeLens;
  seedDomain?: string;
  globalIndex: number;
  /** Ideas kept after the grounding/shape filter. */
  produced: number;
  /** Ideas the model returned before filtering. */
  raw: number;
  ok: boolean;
  error?: string;
  admissionDenial?: AdmissionDenial;
  /** EI-13119: present only when a SUCCESSFUL call parsed to zero raw ideas — the head of
   *  the actual response text, so the tick ledger shows WHAT came back (truncation /
   *  refusal / format drift) instead of an undiagnosable `raw: 0`. */
  textHead?: string;
  textLen?: number;
  outputTokens?: number;
}

export interface RunIdeatorsResult {
  ideas: Idea[];
  perLensCounts: Record<CreativeLens, number>;
  ideators: IdeatorRunInfo[];
  costUsd: number;
}

/**
 * Raised (by the prod cycle adapter, cycle-deps.ts) when EVERY ideator failed its
 * LLM call — a TOTAL transport death (gateway wedge / token 401 / provider stall) —
 * AND the batch produced ZERO ideas. This is deliberately distinct from a healthy
 * cycle that genuinely found nothing (ideators ran fine, returned 0 ideas): a total
 * transport failure must NOT masquerade as a benign 'no-ideas' tick. Surfacing it as
 * a thrown error lets the scheduler's catch record an `error` tick (visible in
 * scout_ticks) AND call recordFire('error') so the autoloop fire-gate backs off,
 * instead of hammering a dead gateway every cadence and logging it as quiet idle.
 * Partial failures (some ideators OK) never throw — one dead ideator never kills the
 * batch (the existing defensive contract in runIdeators).
 */
export class ScoutIdeatorsTransportError extends Error {
  readonly failedCount: number;
  readonly sample?: string;
  readonly admissionDenial?: AdmissionDenial;
  constructor(failedCount: number, sample?: string, admissionDenial?: AdmissionDenial) {
    super(
      `scout: all ${failedCount} ideator LLM call(s) failed — transport death (0 ideas, $0 spent)` +
        (sample ? `: ${sample}` : ''),
    );
    this.name = 'ScoutIdeatorsTransportError';
    this.failedCount = failedCount;
    if (sample !== undefined) this.sample = sample;
    if (admissionDenial !== undefined) this.admissionDenial = admissionDenial;
  }
}

interface RawIdea {
  title: string;
  body: string;
  mechanism: string;
  addressesPatternRefs: string[];
  seededByRefs?: string[];
  seedDomain?: string;
}

/** Parse a model payload (object or text) into the `{ideas:[...]}` array, defensively. */
export function parseIdeasPayload(json: unknown, text: string): unknown[] {
  const fromJson = extractIdeasArray(json);
  if (fromJson) return fromJson;
  const parsed = tryParseJsonText(text);
  return extractIdeasArray(parsed) ?? [];
}

function extractIdeasArray(x: unknown): unknown[] | null {
  if (Array.isArray(x)) return x;
  if (x && typeof x === 'object' && Array.isArray((x as Record<string, unknown>).ideas)) {
    return (x as { ideas: unknown[] }).ideas;
  }
  return null;
}

function tryParseJsonText(text: string): unknown {
  if (!text) return null;
  const stripped = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    /* fall through to bracket extraction */
  }
  const match = stripped.match(/[[{][\s\S]*[\]}]/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      /* give up */
    }
  }
  return null;
}

/** Coerce one raw idea object; null if it lacks the required fields. */
function coerceRawIdea(x: unknown): RawIdea | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const body = typeof o.body === 'string' ? o.body.trim() : '';
  const mechanism = typeof o.mechanism === 'string' ? o.mechanism.trim() : '';
  if (!title || !body || !mechanism) return null;
  const refs = Array.isArray(o.addressesPatternRefs)
    ? o.addressesPatternRefs.filter((r): r is string => typeof r === 'string')
    : [];
  const seededByRefs = Array.isArray(o.seededByRefs)
    ? [...new Set(o.seededByRefs.filter((r): r is string => typeof r === 'string' && r.trim().length > 0))]
    : [];
  const seedDomain = typeof o.seedDomain === 'string' ? o.seedDomain : undefined;
  return { title, body, mechanism, addressesPatternRefs: refs, ...(seededByRefs.length ? { seededByRefs } : {}), seedDomain };
}

/**
 * Run the ideator fan-out over `digest`. Ideators execute in parallel; each is
 * isolated (a thrown/garbled ideator yields no ideas, recorded `ok:false`,
 * without sinking the batch). Each kept idea is grounded — its
 * `addressesPatternRefs` is intersected with the digest's real refs.
 */
export async function runIdeators(digest: CorpusDigest, opts: RunIdeatorsOptions): Promise<RunIdeatorsResult> {
  const roster = buildIdeatorRoster(opts);
  const model = opts.model ?? SCOUT_IDEATOR_MODEL;
  // NOV-3 (gym-unwedge-scout-novelty-2026-07-02): throughput is a novelty
  // prerequisite — 11 routed ideas ALL-TIME is no evolutionary pressure. Default
  // raised 3→4 (critics/grading remain the filter; the USD budget ceiling still
  // governs spend) and env-tunable so the owner can push higher without a deploy.
  const envMax = Number(process.env.PAPERCUSP_SCOUT_MAX_IDEAS_PER_IDEATOR);
  const maxIdeas =
    opts.maxIdeasPerIdeator ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : 4);
  const validRefs = digestRefSet(digest);
  const thinking = opts.thinkingBudgetTokens;
  // DETERMINISTIC rubric seeding (blender-self-learning-2026-07-12 P-004): when
  // the digest carries measured rubric criteria, the FIRST roster slot is
  // required to ground an idea in one of the worst-measured refs. One slot, not
  // all — the rest of the roster keeps its unforced diversity, but rubric
  // measurements now generate ideas every cycle by construction, not by hoping
  // the lane wins salience in the flat render (0/116 ever, per the WI-4250 audit).
  const rubricFocus = buildRubricFocus(digest);

  const runs = await Promise.all(
    roster.map(async (slot, slotIdx): Promise<{ info: IdeatorRunInfo; ideas: Idea[]; cost: number }> => {
      const { system, user } = buildIdeatorPrompt({
        lens: slot.lens,
        digest,
        seedDomain: slot.seedDomain,
        maxIdeas,
        ...(opts.mission ? { mission: opts.mission } : {}),
        ...(opts.priming ? { priming: opts.priming } : {}),
        ...(opts.nicheMapPriming ? { nicheMapPriming: opts.nicheMapPriming } : {}),
        ...(slotIdx === 0 && rubricFocus ? { rubricFocus } : {}),
      });
      try {
        const res = await callIdeatorLlm(
          opts,
          {
            model,
            system,
            messages: [{ role: 'user', content: user }],
            responseFormat: 'json',
            // ⚠ maxTokens must leave room for SERVER-SIDE thinking — see
            // IDEATOR_OUTPUT_HEADROOM_TOKENS for the sizing evidence (EI-13119).
            ...(thinking
              ? {
                  thinkingBudgetTokens: thinking,
                  maxTokens: thinking + IDEATOR_OUTPUT_HEADROOM_TOKENS,
                }
              : { maxTokens: IDEATOR_OUTPUT_HEADROOM_TOKENS }),
          },
          slot,
        );
        const rawArr = parseIdeasPayload(res.json, res.text);
        const ideas: Idea[] = [];
        for (let j = 0; j < rawArr.length; j++) {
          const raw = coerceRawIdea(rawArr[j]);
          if (!raw) continue;
          const grounded = raw.addressesPatternRefs.filter((r) => validRefs.has(r));
          ideas.push({
            id: `scout-idea-${slot.lens}-${slot.globalIndex}-${ideas.length}`,
            lens: slot.lens,
            title: raw.title,
            body: raw.body,
            mechanism: raw.mechanism,
            // Analogical: trust the assigned seed domain over the model's echo.
            seedDomain: slot.seedDomain?.key ?? raw.seedDomain,
            addressesPatternRefs: grounded,
            ...(raw.seededByRefs && raw.seededByRefs.length > 0
              ? { seededByRefs: [...raw.seededByRefs] }
              : {}),
          });
        }
        return {
          info: {
            lens: slot.lens,
            seedDomain: slot.seedDomain?.key,
            globalIndex: slot.globalIndex,
            produced: ideas.length,
            raw: rawArr.length,
            ok: true,
            // EI-13119 escalation: a successful call that parses to ZERO raw ideas is the
            // silent-outage shape — keep enough of the actual response to diagnose from the
            // tick ledger (truncation vs refusal vs format drift) without a live re-probe.
            ...(rawArr.length === 0
              ? { textHead: (res.text ?? '').slice(0, 200), textLen: (res.text ?? '').length, outputTokens: res.outputTokens }
              : {}),
          },
          ideas,
          cost: res.costUsd ?? 0,
        };
      } catch (err) {
        const admissionDenial = admissionDenialFrom(err);
        return {
          info: {
            lens: slot.lens,
            seedDomain: slot.seedDomain?.key,
            globalIndex: slot.globalIndex,
            produced: 0,
            raw: 0,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            ...(admissionDenial ? { admissionDenial } : {}),
          },
          ideas: [],
          cost: 0,
        };
      }
    }),
  );

  const ideas = runs.flatMap((r) => r.ideas);
  const perLensCounts = Object.fromEntries(CREATIVE_LENSES.map((l) => [l, 0])) as Record<CreativeLens, number>;
  for (const idea of ideas) perLensCounts[idea.lens] += 1;

  return {
    ideas,
    perLensCounts,
    ideators: runs.map((r) => r.info),
    costUsd: runs.reduce((a, r) => a + r.cost, 0),
  };
}

type ScoutLlmCallInput = Parameters<ScoutLlmCall>[0];

/**
 * WI-4475 — two budgets, not one.
 *
 * The old shape started a single 180s wall-clock timer at CALL time and raced it against
 * `llmCall`. But `llmCall` blocks (by design) in the shared rate-limit governor waiting for a
 * permit BEFORE it issues the request — so that one timer was charging QUEUE-WAIT and
 * GENERATION to the same budget. Measured 2026-07-13: opus-4-8 emits ~62 tok/s, so a FULL
 * 4096-token ideation response takes ~66s — the 180s cap has ~2.7x headroom and the call
 * CANNOT time out by generating. Every observed "Scout ideator <lens> timed out after
 * 180000ms" ($0 spent, 0 ideas) was therefore a correctly-paced capacity wait being
 * guillotined and misreported as transport death. Live governor pauses run 15s / 120s / 453s.
 *
 * So we split them:
 *   - ADMISSION  — bounded by the time actually LEFT on the owning cycle's deadline. The
 *     governor gets that as `governorMaxWaitMs` and bails with an HONEST capacity error
 *     instead of being killed by our timer. A backstop timer covers a transport that never
 *     admits and never returns.
 *   - GENERATION — the existing per-ideator cap, whose timer starts on `onResponseStart`
 *     (response headers / first stream event, after the inference gateway admits the request)
 *     and RESETS on each retry attempt.
 *
 * Net effect: a pause shorter than the cycle's remaining budget now yields IDEAS (a bit
 * later) instead of a hard cycle failure; a pause longer than it fails fast and honestly.
 */
async function callIdeatorLlm(
  opts: RunIdeatorsOptions,
  input: ScoutLlmCallInput,
  slot: IdeatorSlot,
): Promise<Awaited<ReturnType<ScoutLlmCall>>> {
  const generationTimeoutMs =
    opts.ideatorTimeoutMs === undefined
      ? DEFAULT_SCOUT_IDEATOR_TIMEOUT_MS
      : opts.ideatorTimeoutMs;
  const hasGenerationCap = Number.isFinite(generationTimeoutMs) && generationTimeoutMs > 0;

  // The admission budget: whatever the owning cycle has left, minus a reserve so generation
  // still has room to run. No deadline ⇒ leave it to the host default (pre-WI-4475 behavior).
  const admissionBudgetMs = (() => {
    if (opts.cycleDeadlineMs === undefined || !Number.isFinite(opts.cycleDeadlineMs)) return undefined;
    const remaining = opts.cycleDeadlineMs - Date.now();
    const reserve = hasGenerationCap ? generationTimeoutMs : 0;
    return Math.max(0, remaining - reserve);
  })();

  // The TOTAL wall-clock ceiling armed at call time. This must ALWAYS exist when a cap was
  // asked for: not every transport signals admission (the codex-gateway path and the subprocess
  // backends never do), and a timer that only starts on `onAdmitted` would leave those calls
  // completely UNBOUNDED — strictly worse than the bug we're fixing. So we always arm, and
  // merely RE-ARM on admission:
  //   - no deadline  ⇒ ceiling = the generation cap. Byte-identical to the pre-WI-4475 contract
  //                    (same bound, same message), so legacy callers are untouched.
  //   - a deadline   ⇒ ceiling = admission budget + generation cap. On RESPONSE START we
  //                    re-arm to the generation cap alone; local/gateway queue-wait is never
  //                    charged to generation.
  const grace = opts.admissionBackstopGraceMs ?? ADMISSION_BACKSTOP_GRACE_MS;
  const totalCeilingMs = (() => {
    if (admissionBudgetMs === undefined) return hasGenerationCap ? generationTimeoutMs : undefined;
    const uncapped = admissionBudgetMs + (hasGenerationCap ? generationTimeoutMs : 0) + grace;
    // WI-5784 — CLAMP the ceiling strictly INSIDE the owning cycle's deadline.
    //
    // Without this the arithmetic cancels: admissionBudget is `remaining - genCap`,
    // so admissionBudget + genCap + grace === `remaining + grace` — the backstop was
    // always armed AFTER the cycle deadline and could never win the race. The cycle's
    // own timer fired first, every time, recording the useless "Scout cycle timed out
    // after 600000ms during phase ideate" instead of the honest, capacity-classifiable
    // per-ideator error the messages below were written to produce. That is 42 of the
    // 55 scout error ticks in the 7d window that broke the <5% release bar.
    //
    // The ladder is deliberate, outermost-last: retry-ladder bail (cycle deadline −10s,
    // cycle.ts RETRY_LADDER_DEADLINE_MARGIN_MS) → this backstop (−5s) → cycle timer (0).
    // The more precise error therefore still wins when it applies; this only guarantees
    // SOMETHING honest fires before the guillotine.
    const remaining = (opts.cycleDeadlineMs as number) - Date.now();
    const insideCycle = Math.max(0, remaining - CYCLE_DEADLINE_MARGIN_MS);
    return Math.min(uncapped, insideCycle);
  })();

  if (totalCeilingMs === undefined && !opts.signal) {
    return opts.llmCall(input);
  }

  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let parentAbort: (() => void) | null = null;
  let locallyAdmitted = false;
  let responseStarted = false;
  // Assigned synchronously by the Promise executor below, before `llmCall` is ever invoked.
  let onAdmitted: () => void = () => {};
  let onResponseStart: () => void = () => {};

  const rejectOnAbort = new Promise<never>((_, reject) => {
    const abort = (err: Error) => {
      if (!ctrl.signal.aborted) ctrl.abort(err);
      reject(err);
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        abort(new Error(`Scout ideator ${slot.lens} aborted`));
        return;
      }
      parentAbort = () => abort(new Error(`Scout ideator ${slot.lens} aborted`));
      opts.signal.addEventListener('abort', parentAbort, { once: true });
    }

    // The failure MESSAGE is chosen when the timer FIRES. Local admission is deliberately
    // NOT the generation boundary: the HTTP request can still spend minutes in the inference
    // gateway's own queue/account governor (EI-11417). Conversely, buffered transports
    // may expose neither hook until completion; missing hooks cannot prove a capacity wall.
    const arm = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (responseStarted) {
          abort(
            new Error(
              `Scout ideator ${slot.lens} timed out after ${Math.trunc(generationTimeoutMs)}ms of GENERATION ` +
                `(upstream response started — this is not an admission wait)`,
            ),
          );
        } else if (admissionBudgetMs !== undefined) {
          abort(
            new Error(
              `Scout ideator ${slot.lens} did not receive an upstream response before the cycle deadline ` +
                `(${locallyAdmitted ? 'local admission observed' : 'local admission unobserved — transport may not expose admission'}; ` +
                `response start unobserved; queueing versus generation unknown)`,
            ),
          );
        } else {
          // Legacy shape: no deadline was supplied, so we cannot tell queue-wait from generation.
          // Keep the original message verbatim — callers/tests depend on it.
          abort(new Error(`Scout ideator ${slot.lens} timed out after ${Math.trunc(generationTimeoutMs)}ms`));
        }
      }, ms);
      if (typeof timer.unref === 'function') timer.unref();
    };

    if (totalCeilingMs !== undefined) arm(totalCeilingMs);

    // LOCAL ADMISSION — observability only. The HTTP request may still be waiting inside the
    // inference gateway, so re-arming the generation timer here recreates the exact queue-vs-
    // generation conflation WI-4475 intended to remove (EI-11417).
    onAdmitted = () => {
      locallyAdmitted = true;
    };
    // RESPONSE START — the gateway has routed/admitted the request and upstream response
    // headers arrived. Generation owns the timer from this point onward. Fires per successful
    // retry attempt, resetting the cap for that attempt.
    onResponseStart = () => {
      responseStarted = true;
      if (hasGenerationCap) arm(generationTimeoutMs);
      else if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
  });

  try {
    return await Promise.race([
      opts.llmCall({
        ...input,
        signal: ctrl.signal,
        ...(admissionBudgetMs !== undefined ? { governorMaxWaitMs: admissionBudgetMs } : {}),
        onAdmitted: () => onAdmitted(),
        onResponseStart: () => onResponseStart(),
      }),
      rejectOnAbort,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (parentAbort && opts.signal) opts.signal.removeEventListener('abort', parentAbort);
  }
}
