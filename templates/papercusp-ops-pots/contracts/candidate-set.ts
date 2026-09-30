/**
 * candidate-set — STARTER seam-contract template (papercusp-ops-pots).
 *
 * Building agent: this becomes YOUR app's contracts package (e.g.
 * `@myapp/contracts`) — the typed definition of the ONLY things that cross
 * the app⇄hive seam. Specialize it while walking the `contract-shape`
 * decision point; the INVARIANTS marked MUST are the proven two-plane-ops
 * discipline and are what the seam-round-trip and schema-clean-output
 * checks enforce.
 *
 * MUST (Tier B — typed-contracts):
 *  - Both payloads are wire-validated zod schemas, `.strict()` — unknown keys
 *    are contract drift, fail loud.
 *  - ONE parse gate (`parse{{ContractName}}`) between agent output and any
 *    app table. Nothing else writes ingested rows.
 *  - The join key (`{{itemId}}`) round-trips UNCHANGED input → output — the
 *    sidecar ingests by it, never by guessing.
 *  - An empty result REQUIRES notes (`.refine` below) — an agent never
 *    returns silence.
 *  - Rejects are emitted UP as events ({{workUnit}}.rejected), never silently
 *    dropped — the ops hive's ingest-sentinel reacts to them.
 *  - Money (if any) is INTEGER CENTS + an ISO-4217 currency code. Never
 *    floats.
 *  - This module is types + schemas + assembly helpers ONLY — no business
 *    logic. Additive changes only once anything depends on it.
 */

import { z } from "zod";

// ─────────────────────────── The seam kind ───────────────────────────

/** The work-item kind carrying these payloads (the blueprint declares it too). */
export const SEAM_KIND = "{{SEAM_WORK_ITEM_KIND}}";
/** Work-item id prefix for the kind (e.g. PR for purchase-research). */
export const SEAM_ID_PREFIX = "{{ID_PREFIX}}";

// ────────────────────── payload.in — going UP ────────────────────────

/**
 * Input constraints the worker must honor. All optional — absent = no
 * constraint. Keep constraints DECLARATIVE so the judge rubric and the
 * constraint-honored gym signal can score against them.
 */
export const InputConstraintsSchema = z
  .object({
    // {{e.g. maxUnitPriceCents: z.number().int().positive().optional(),}}
    // {{e.g. excludeVendors: z.array(z.string().min(1)).optional(),}}
    // {{e.g. attributes: z.array(z.string().min(1)).optional(),}}
  })
  .strict();
export type InputConstraints = z.infer<typeof InputConstraintsSchema>;

/**
 * The seam INPUT payload: one unit of domain work. The sidecar enqueues one
 * per {{ENQUEUE_TRIGGER}}; the worker reads it and writes the result set back
 * as the OUTPUT payload. `{{itemId}}` is the DB join key — it MUST round-trip
 * unchanged into the result.
 */
export const WorkInputSchema = z
  .object({
    /** DB join key back into the app ({{e.g. items.id}}). */
    itemId: z.number().int().positive(),
    // {{Domain input fields — e.g. item: z.string().min(1), qty: z.number().positive(),}}
    /** Constraints the worker must honor. */
    constraints: InputConstraintsSchema.optional(),
  })
  .strict();
export type WorkInput = z.infer<typeof WorkInputSchema>;

// ───────────────────── payload.out — coming DOWN ──────────────────────

/**
 * One proposal. Maps 1:1 onto a `{{APP_TABLE}}` row. A proposal is a
 * RECOMMENDATION, never an action — the judgment plane is propose-only; the
 * deterministic app (strictly after any human gate) acts.
 */
export const ProposalSchema = z
  .object({
    // {{Domain proposal fields — e.g. vendor: z.string().min(1), url: z.string().url(),}}
    // {{Money? INTEGER CENTS: priceCents: z.number().int().nonnegative().optional(),}}
    // {{                      currency: z.string().length(3).default("USD"),}}
    /** How well this proposal matches the request, in [0, 1]. */
    matchConfidence: z.number().min(0).max(1),
    /** Why this proposal — required, never empty. */
    rationale: z.string().min(1),
    /** Evidence the proposal rests on. At least one — never sourceless. */
    sources: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type Proposal = z.infer<typeof ProposalSchema>;

/**
 * The seam OUTPUT payload: the worker's full result for one input. INVARIANTS
 * (pinned by .refine): the join key echoes the input; an EMPTY proposals
 * array requires `notes` explaining the miss — never silence.
 */
export const CandidateSetSchema = z
  .object({
    /** DB join key, echoed UNCHANGED from {@link WorkInput}. */
    itemId: z.number().int().positive(),
    /** Ranked proposals, best first. May be empty ONLY with `notes`. */
    proposals: z.array(ProposalSchema),
    /** What was tried / why nothing qualified. Required when empty-handed. */
    notes: z.string().min(1).optional(),
    /** ISO-8601 timestamp the set was produced. */
    ts: z.string().min(1),
    /** The producing agent run (work-item id / session ref) for provenance. */
    agentRunRef: z.string().optional(),
  })
  .strict()
  .refine((s) => s.proposals.length > 0 || s.notes !== undefined, {
    message: "an empty result must carry notes explaining the miss",
    path: ["notes"],
  });
export type CandidateSet = z.infer<typeof CandidateSetSchema>;
export type CandidateSetInput = z.input<typeof CandidateSetSchema>;

// ──────────────────── boundary parse/assemble helpers ─────────────────

/** Wire-validate an untrusted `payload.in` (sidecar → worker pickup). Fail loud at the seam. */
export function parseWorkInput(json: unknown): WorkInput {
  return WorkInputSchema.parse(json);
}

/**
 * Wire-validate an untrusted `payload.out` (worker completion → sidecar
 * ingest). THE ONLY GATE between agent output and the `{{APP_TABLE}}` table.
 * On a ZodError the sidecar emits `{{workUnit}}.rejected` UP — never a silent
 * drop.
 */
export function parseCandidateSet(json: unknown): CandidateSet {
  return CandidateSetSchema.parse(json);
}

/**
 * Structural assembly: stamps `ts` (when omitted) and validates, so every
 * producer emits an identical, schema-valid set. The caller supplies the
 * JUDGMENT; this helper adds no domain logic.
 */
export function assembleCandidateSet(
  input: Omit<CandidateSetInput, "ts"> & { ts?: string },
): CandidateSet {
  return CandidateSetSchema.parse({ ts: new Date().toISOString(), ...input });
}
