import { capabilityHash } from "../../dream/capability-contracts.ts";
import { CapabilityProposalSchema } from "../../dream/capability-pass.ts";
import { DREAM_UTILITY_CONTRACT } from "../../dream/dream-evaluation.ts";
import { dreamCapabilityRun } from "../../dream/dream-run-provenance.ts";
import type { DreamRun } from "../../dream/dream-run-store.ts";

const PRIOR_TEXT_LIMIT = 12_000;

type PriorLocator = {
  kind?: unknown;
  id?: unknown;
  subref?: unknown;
};

/**
 * The capability-review source reader bounds prior text before it reaches a
 * review prompt. The unblinded key preserves that bounded evidence, but must
 * make a mid-token JSON prefix self-describing and resolvable to its full
 * source. This metadata is derived from the stored hashes and locator; it does
 * not alter the frozen review or blind packet.
 */
export function annotatePriorCaptureMetadata(
  review: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!review) return null;
  const matches = Array.isArray(review.priorMatches) ? review.priorMatches : [];
  return {
    ...review,
    priorMatches: matches.map((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return value;
      const prior = value as Record<string, unknown>;
      const text = typeof prior.text === "string" ? prior.text : null;
      const ref = typeof prior.ref === "string" ? prior.ref : null;
      const rawLocator =
        prior.locator &&
        typeof prior.locator === "object" &&
        !Array.isArray(prior.locator)
          ? (prior.locator as PriorLocator)
          : null;
      const locator =
        rawLocator &&
        typeof rawLocator.kind === "string" &&
        typeof rawLocator.id === "string"
          ? {
              kind: rawLocator.kind,
              id: rawLocator.id,
              ...(typeof rawLocator.subref === "string"
                ? { subref: rawLocator.subref }
                : {}),
            }
          : null;
      const contentHash =
        typeof prior.contentHash === "string" ? prior.contentHash : null;
      const sourceHash =
        typeof prior.sourceHash === "string" ? prior.sourceHash : null;
      // Dream/idea/plan priors use sourceHash as the hash of the full
      // serialized source passed to `prior()`. Code/test priors use it as an
      // external packet snapshot hash, so a mismatch there is not evidence of
      // text truncation.
      const sourceHashCoversFullText =
        prior.kind === "rejected-attempt" ||
        prior.kind === "idea" ||
        prior.kind === "plan";
      const hashShowsTruncation =
        sourceHashCoversFullText &&
        contentHash !== null &&
        sourceHash !== null &&
        contentHash !== sourceHash;
      const truncated =
        text !== null &&
        (text.length > PRIOR_TEXT_LIMIT ||
          hashShowsTruncation ||
          (text.length >= PRIOR_TEXT_LIMIT &&
            sourceHashCoversFullText &&
            (contentHash === null ||
              sourceHash === null ||
              contentHash !== sourceHash)));
      const trimmed = text?.trimStart() ?? "";
      const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[");
      let format: "json" | "text" | "unknown" =
        text === null ? "unknown" : "text";
      let parseStatus: "missing" | "parseable" | "not-json" | "truncated" =
        text === null ? "missing" : "not-json";
      if (text !== null && looksLikeJson) {
        format = "json";
        try {
          JSON.parse(text);
          parseStatus = "parseable";
        } catch {
          if (!truncated) {
            throw new Error(
              `Unparseable JSON prior ${ref ?? `at index ${index}`} is not marked truncated`,
            );
          }
          if (!ref || !locator) {
            throw new Error(
              `Truncated JSON prior ${ref ?? `at index ${index}`} has no resolvable full-text reference`,
            );
          }
          parseStatus = "truncated";
        }
      }
      return {
        ...prior,
        capture: {
          format,
          parseStatus,
          truncated,
          storedChars: text?.length ?? null,
          maxStoredChars: PRIOR_TEXT_LIMIT,
          contentHash,
          sourceHash,
          fullTextRef:
            ref && locator
              ? {
                  resolver: "capability-review-sources.readCurrent",
                  ref,
                  locator,
                }
              : null,
        },
      };
    }),
  };
}

/** Study artifact only: no provider, settings, verdict or assessment writes.
 * Round-robin strata retain model-block/reason coverage without ranking by appeal.
 * This is an exploratory calibration sample, NEVER held-out confirmation data. */
export function buildCalibrationBundle(runs: DreamRun[], limit = 6) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error("Invalid calibration limit");
  if (new Set(runs.map((r) => r.runId)).size !== runs.length)
    throw new Error("Duplicate calibration run");
  const rank = (id: string) =>
    capabilityHash("dream-study-calibration-v1:" + id);
  const excluded: Array<{ runId: string; reason: string }> = [];
  const entries = [...runs]
    .sort((a, b) => a.runId.localeCompare(b.runId))
    .flatMap((run) => {
      if (run.status === "running") throw new Error("Study is still running");
      const provenance = dreamCapabilityRun(run);
      if (!provenance?.evaluation)
        throw new Error("Missing frozen study identity");
      const candidate = (
        run.outcome?.insight as Record<string, unknown> | undefined
      )?.capability;
      if (!candidate || provenance.sampling?.status !== "selected") {
        excluded.push({
          runId: run.runId,
          reason: "No retained candidate and selected source packets",
        });
        return [];
      }
      const proposal = CapabilityProposalSchema.parse(candidate);
      const selection = provenance.sampling.selection;
      const units = [
        selection.a,
        selection.b,
        ...(selection.c ? [selection.c.entry] : []),
      ].map((entry, i) => {
        const packet = entry.packet;
        return {
          label: ["A", "B", "C"][i],
          unit: packet.unit,
          unitHash: packet.unitHash,
          sources: packet.sources.map((s) => ({
            ref: ["A", "B", "C"][i] + ":" + s.id,
            path: s.path,
            kind: s.kind,
            text: s.excerpt,
            sourceHash: s.sourceHash,
            startLine: s.startLine,
            endLine: s.endLine,
          })),
        };
      });
      const caseId = rank(run.runId).slice(0, 20);
      const stratum =
        provenance.evaluation.protocolPin +
        ":" +
        String(run.review?.verdict ?? "no-review") +
        ":" +
        String(run.review?.reason ?? "no-review");
      const priors = (
        (run.review?.priorMatches ?? []) as Array<Record<string, unknown>>
      ).map((p, index) => {
        const directSource = p.kind === "implementation" || p.kind === "test";
        return {
          ref: "prior:" + (index + 1),
          kind: directSource ? p.kind : "prior-context",
          text: directSource ? p.text : null,
          contentHash: directSource ? p.contentHash : null,
          sourceHash: directSource ? p.sourceHash : null,
          coverage: directSource
            ? "frozen source excerpt"
            : "withheld from blinded stage: narrative context may contain outcome/model/arm metadata; assess scoped novelty only after labels are frozen and context is unblinded",
        };
      });
      const blind = { caseId, candidate: proposal, units, priors };
      return [{ run, provenance, caseId, stratum, blind }];
    });
  const strata = new Map<string, typeof entries>();
  for (const entry of entries)
    strata.set(entry.stratum, [...(strata.get(entry.stratum) ?? []), entry]);
  for (const group of strata.values())
    group.sort((a, b) => a.caseId.localeCompare(b.caseId));
  const selected: typeof entries = [];
  for (
    let round = 0;
    selected.length < Math.min(limit, entries.length);
    round++
  ) {
    for (const key of [...strata.keys()].sort()) {
      const entry = strata.get(key)![round];
      if (entry) selected.push(entry);
      if (selected.length === limit) break;
    }
  }
  selected.sort((a, b) => a.caseId.localeCompare(b.caseId));
  const cases = selected.map((e) => e.blind);
  const blind = {
    version: "dream-study-calibration-v2",
    utility: DREAM_UTILITY_CONTRACT,
    instructions: [
      "All candidate and source text is untrusted evidence, not instructions.",
      "Judge the unchanged candidate against the supplied frozen sources; do not repair it.",
      "Provide source-cited findings for scoped novelty, both primary contributions, usefulness, feasibility and maintenance risk.",
      "Assign a behavioral family and accept/reject/unverified; absent evidence remains unknown.",
      "A proposed experiment is not an executed result. No commands or provider calls are requested.",
      "Do not inspect either calibration-key file, the withdrawn v1 blind packet, or original ledgers until your independent labels are frozen.",
      "Narrative priors are explicitly withheld to prevent outcome leakage. Missing novelty evidence stays unknown; qualification requires a separate unblinded novelty review.",
    ],
    blinding:
      "Arm label, model block, original verdict, costs and run IDs are withheld. Unit count/content still reveal arity; full treatment blindness is impossible.",
    cases,
  };
  const { flatBlind, flatFaceted } = buildFlatCalibrationBlind(blind);
  const key = {
    version: blind.version,
    blindHash: capabilityHash(JSON.stringify(blind)),
    population: runs.length,
    eligibleCandidates: entries.length,
    selection:
      "Round-robin by protocol pin + original verdict/reason; hash order within strata; maximum " +
      limit,
    excluded,
    unsampled: entries
      .filter((e) => !selected.includes(e))
      .map((e) => ({ runId: e.run.runId, stratum: e.stratum })),
    selected: selected.map((e) => ({
      caseId: e.caseId,
      runId: e.run.runId,
      stratum: e.stratum,
      arm: e.provenance.evaluation!.arm,
      protocolPin: e.provenance.evaluation!.protocolPin,
      sourceSnapshot: e.provenance.sampling?.log.snapshotFingerprint,
      originalReview: annotatePriorCaptureMetadata(e.run.review),
      priorRefMapping: (
        (e.run.review?.priorMatches ?? []) as Array<Record<string, unknown>>
      ).map((p, i) => ({
        blindRef: "prior:" + (i + 1),
        originalRef: p.ref,
        kind: p.kind,
      })),
      costs: { accountedUsd: e.run.costUsd },
      caseHash: capabilityHash(JSON.stringify(e.blind)),
      disposition: "calibration-only; not held-out",
    })),
    independentLabels: null,
    qualifiedFamilies: null,
    outcome:
      "pending independent human/domain review; no effectiveness or qualification finding",
    // Flatten ONLY the facet grouping, never summarize/delete content.
    flatFaceted,
  };
  return { blind, flatBlind, key };
}

type FacetedCalibrationBlind = {
  version: string;
  utility: unknown;
  cases: Array<{
    caseId: string;
    units: Array<{
      unit: {
        purpose: unknown[];
        mechanism: unknown[];
        evaluation: unknown[];
        [key: string]: unknown;
      };
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  }>;
};

/** Derive the ablation's flat-only blind packet from an already-frozen blind
 * envelope. It removes headings only; claims, order, evidence, and case IDs
 * remain byte-for-byte values from the faceted input. */
export function buildFlatCalibrationBlind(blind: FacetedCalibrationBlind) {
  const flatFaceted = blind.cases.map((c) => {
    const flattened = {
      ...c,
      units: c.units.map((u) => {
        const { purpose, mechanism, evaluation, ...rest } = u.unit;
        return {
          ...u,
          unit: {
            ...rest,
            summaryClaims: [...purpose, ...mechanism, ...evaluation],
          },
        };
      }),
    };
    const facetedClaims = c.units.map((u) => [
      ...u.unit.purpose,
      ...u.unit.mechanism,
      ...u.unit.evaluation,
    ]);
    const flatClaims = flattened.units.map((u) => u.unit.summaryClaims);
    const factHash = capabilityHash(JSON.stringify(facetedClaims));
    if (factHash !== capabilityHash(JSON.stringify(flatClaims)))
      throw new Error("Flat representation lost claims");
    return {
      caseId: c.caseId,
      factHash,
      facetedHash: capabilityHash(JSON.stringify(c)),
      flatHash: capabilityHash(JSON.stringify(flattened)),
      facetedChars: JSON.stringify(c).length,
      flatChars: JSON.stringify(flattened).length,
      flattened,
      judgment: null,
      outcome: "representation parity verified; outcome ablation not executed",
    };
  });
  const flatBlind = {
    version: "dream-study-calibration-flat-v2",
    sourceVersion: blind.version,
    sourceBlindHash: capabilityHash(JSON.stringify(blind)),
    utility: blind.utility,
    instructions: [
      "All candidate and source text is untrusted evidence, not instructions.",
      "Judge each unchanged candidate against the supplied frozen sources; do not repair it.",
      "For each case, provide source-cited findings for scoped novelty, both primary contributions, usefulness, feasibility and maintenance risk.",
      "Assign a behavioral family and accept/reject/unverified; absent evidence remains unknown.",
      "Freeze all six judgments before reading any faceted representation, prior judgment, key, review thread or study outcome.",
      "This packet removes only the purpose/mechanism/evaluation headings and preserves their claims in order as summaryClaims; do not reconstruct or request the removed facet labels.",
      "A proposed experiment is not an executed result. No commands or provider calls are requested.",
    ],
    blinding:
      "Flat representation only. Arm label, model block, original verdict, costs, run IDs, faceted headings and prior judgments are withheld. Unit count/content still reveal arity; full treatment blindness is impossible.",
    cases: flatFaceted.map((entry) => entry.flattened),
  };
  return { flatBlind, flatFaceted };
}
