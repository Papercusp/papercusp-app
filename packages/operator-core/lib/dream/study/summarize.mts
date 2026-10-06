import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getOrgPg } from "@papercusp/db-org";
import { capabilityHash } from "../../dream/capability-contracts.ts";
import {
  dreamCapabilityRun,
  dreamRunAssessments,
} from "../../dream/dream-run-provenance.ts";
import {
  STUDY_BLOCKS,
  readStudyTotals,
  validateStudyBlocks,
} from "./accounting.mts";

const here = dirname(fileURLToPath(import.meta.url));
const workspaceId = "papercusp-workspace";
process.env.PAPERCUSP_WORKSPACE_ID = workspaceId;
const blocks = await Promise.all(
  Object.values(STUDY_BLOCKS).map(async (b) =>
    JSON.parse(await readFile(resolve(here, b.file), "utf8")),
  ),
);
validateStudyBlocks(blocks);
const pins = blocks.map((b) => b.pin);
const independentReview = JSON.parse(
  await readFile(resolve(here, "calibration-review-2026-09-14.json"), "utf8"),
);
const unblindedReview = JSON.parse(
  await readFile(
    resolve(here, "calibration-unblinded-review-2026-09-14.json"),
    "utf8",
  ),
);
const blind = JSON.parse(
  await readFile(resolve(here, "calibration-blind-v2.json"), "utf8"),
);
const flatBlindBytes = await readFile(
  resolve(here, "calibration-flat-blind-v2.json"),
  "utf8",
);
const flatBlind = JSON.parse(flatBlindBytes);
const flatFacetedProtocol = JSON.parse(
  await readFile(
    resolve(here, "calibration-flat-faceted-ablation-protocol.json"),
    "utf8",
  ),
);
const flatFacetedResult = JSON.parse(
  await readFile(
    resolve(here, "calibration-flat-faceted-ablation-result-2026-09-14.json"),
    "utf8",
  ),
);
if (independentReview.blindHash !== capabilityHash(JSON.stringify(blind)))
  throw new Error("Independent review is not bound to the frozen blind packet");
const reviewCaseIds = independentReview.posts.flatMap((p: { body: string }) =>
  [...p.body.matchAll(/^\d\. `([a-f0-9]{20})`/gm)].map((m) => m[1]),
);
if (
  independentReview.posts.length !== 7 ||
  JSON.stringify(reviewCaseIds) !==
    JSON.stringify(blind.cases.map((c: { caseId: string }) => c.caseId)) ||
  !independentReview.posts[6].body.includes("END FROZEN REVIEW.") ||
  independentReview.qualifiedFamilies !== null
)
  throw new Error(
    "Independent calibration freeze is incomplete or conflates review with qualification",
  );
const unblindedRepresentativeIds = [
  "1176a396ed37847cf61c",
  "36908b44cc10514ba38e",
  "5908803065283e72f93d",
];
if (
  unblindedReview.version !== "dream-unblinded-novelty-review-v1" ||
  unblindedReview.sourceWorkItem !== "WI-40148" ||
  JSON.stringify(unblindedReview.postIds) !==
    JSON.stringify([204403, 204404, 204405, 204406]) ||
  JSON.stringify(
    unblindedReview.representatives.map((r: { caseId: string }) => r.caseId),
  ) !== JSON.stringify(unblindedRepresentativeIds) ||
  unblindedReview.representatives.some(
    (r: { novelBoundedLocalExperiment: boolean }) =>
      r.novelBoundedLocalExperiment,
  ) ||
  unblindedReview.closure.reviewedRepresentatives !== 3 ||
  unblindedReview.closure.qualifiedNovelExperiments !== 0 ||
  unblindedReview.closure.downstreamEligibleCandidates !== 0 ||
  unblindedReview.closure.downstreamTrialsExecuted !== 0 ||
  unblindedReview.closure.downstreamDisposition !==
    "not-applicable-no-qualified-candidates"
)
  throw new Error(
    "Unblinded novelty review is incomplete or admits an unsupported downstream branch",
  );
const flatCaseIds = flatFacetedResult.caseComparisons.map(
  (entry: { caseId: string }) => entry.caseId,
);
const flatAgreements = flatFacetedResult.caseComparisons.filter(
  (entry: { agreement: boolean }) => entry.agreement,
).length;
const flatMismatches =
  flatFacetedResult.caseComparisons.length - flatAgreements;
const frozenFacetedByCase = new Map(
  flatFacetedProtocol.frozenFacetedOutcomes.map(
    (entry: { caseId: string; disposition: string }) => [
      entry.caseId,
      entry.disposition,
    ],
  ),
);
if (
  flatFacetedResult.version !== "dream-study-flat-faceted-ablation-result-v1" ||
  flatFacetedResult.protocolHash !==
    capabilityHash(JSON.stringify(flatFacetedProtocol)) ||
  flatFacetedResult.sourceWorkItem !== "WI-10001412" ||
  flatFacetedResult.sourcePostId !== 204651 ||
  flatFacetedResult.sourcePostBodySha256 !==
    "3d59be4b70d683c22df4a9936cf6af9abfa182fcede315638a389d3204940b80" ||
  flatFacetedResult.completionAuthority !== "committed" ||
  flatFacetedResult.flatPacket.sourceBlindHash !==
    capabilityHash(JSON.stringify(blind)) ||
  flatFacetedResult.flatPacket.compactHash !==
    capabilityHash(JSON.stringify(flatBlind)) ||
  flatFacetedResult.flatPacket.fileSha256 !==
    createHash("sha256").update(flatBlindBytes).digest("hex") ||
  JSON.stringify(flatCaseIds) !==
    JSON.stringify(
      blind.cases.map((entry: { caseId: string }) => entry.caseId),
    ) ||
  flatFacetedResult.caseComparisons.some(
    (entry: { caseId: string; facetedDisposition: string }) =>
      frozenFacetedByCase.get(entry.caseId) !== entry.facetedDisposition,
  ) ||
  flatAgreements !== 2 ||
  flatMismatches !== 4 ||
  flatFacetedResult.primaryEndpoint.population !== 6 ||
  flatFacetedResult.primaryEndpoint.agreements !== flatAgreements ||
  flatFacetedResult.primaryEndpoint.mismatches !== flatMismatches ||
  flatFacetedResult.secondaryEndpoints.requiredDomainCoverage.complete !== 6 ||
  flatFacetedResult.secondaryEndpoints.citationCompleteness.complete !== 6
)
  throw new Error(
    "Flat/faceted ablation result is incomplete or not bound to the frozen inputs",
  );
const { sql } = getOrgPg();
try {
  const rows = await sql<any[]>`
    SELECT run_id, started_at, completed_at, status, outcome, review, cost_usd, error
      FROM harness_shared.dream_runs
     WHERE workspace_id = ${workspaceId} AND pot_slug = 'papercusp'
       AND outcome->'capabilityRun'->'evaluation'->>'protocolPin' = ANY(${pins}::text[])
     ORDER BY started_at, run_id`;
  if (rows.some((r) => !r.completed_at))
    throw new Error(
      "A study Dream is still running; summarize only after completion",
    );
  const totals = await readStudyTotals(sql, workspaceId);
  const ticks = await sql<any[]>`
    SELECT status, tick_at, ideas_generated, ideas_routed, detail->'study' AS study
      FROM harness_shared.scout_ticks
     WHERE workspace_id = ${workspaceId}
       AND detail->'study'->>'protocolPin' = ANY(${pins}::text[])
       AND detail->'study'->>'arm' = 'blender' ORDER BY tick_at, id`;
  const byCycle = new Map<string, any[]>();
  for (const t of ticks)
    byCycle.set(t.study.cycleId, [...(byCycle.get(t.study.cycleId) ?? []), t]);
  const blender = [...byCycle].map(([cycleId, entries]) => {
    const final = entries.filter((e) => e.status !== "gated");
    if (final.length !== 1)
      throw new Error(
        "Blender cycle lacks one authoritative final receipt: " + cycleId,
      );
    const row = final[0];
    return {
      cycleId,
      pin: row.study.protocolPin,
      configHash: row.study.configHash,
      status: row.status,
      settled: row.study.settled,
      ideasGenerated: row.ideas_generated,
      routed: row.ideas_routed,
      costUsd: row.study.costUsd,
      calls: row.study.calls,
      tickAt: row.tick_at,
    };
  });
  const dreams = rows.map((row) => {
    const run = dreamCapabilityRun(row)!;
    const selection =
      run.sampling?.status === "selected" ? run.sampling.selection : null;
    const calls = run.calls.map((c) => ({
      phase: c.phase,
      status: c.status,
      model: c.model,
      settledUsd: c.usage?.costUsd ?? null,
      reservedUsd: c.reservedUsd,
      zeroPricedUsage:
        c.status === "settled" &&
        !c.model.startsWith("local:") &&
        c.usage?.costUsd === 0 &&
        c.usage.inputTokens + c.usage.outputTokens > 0,
    }));
    const amount = calls.reduce(
      (n, c) =>
        n +
        (c.zeroPricedUsage || c.settledUsd === null
          ? c.reservedUsd
          : c.settledUsd),
      0,
    );
    const zeroPriceReserve = calls
      .filter((c) => c.zeroPricedUsage)
      .reduce((n, c) => n + c.reservedUsd, 0);
    if (Math.abs(amount - (Number(row.cost_usd) + zeroPriceReserve)) > 1e-8)
      throw new Error("Call/row accounting mismatch: " + row.run_id);
    const candidate = row.outcome?.insight?.capability ?? null;
    return {
      runId: row.run_id,
      pin: run.evaluation!.protocolPin,
      arm: run.evaluation!.arm,
      matchedPairIndex: run.evaluation!.matchedPairIndex ?? null,
      startedAt: row.started_at,
      status: row.status,
      verdict: row.review?.verdict ?? null,
      reason:
        row.review?.reason ?? row.outcome?.verdict ?? row.error ?? "unknown",
      note: row.review?.note ?? null,
      candidateHash: row.review?.candidateHash ?? null,
      behavior: candidate?.behavior ?? null,
      beneficiary: candidate?.beneficiary ?? null,
      units: selection
        ? [
            selection.a.packet.unit.id,
            selection.b.packet.unit.id,
            ...(selection.c ? [selection.c.entry.packet.unit.id] : []),
          ]
        : [],
      sourceSnapshot: run.sampling?.log.snapshotFingerprint ?? null,
      aOnly: row.review?.controls?.aOnly?.unchanged ?? null,
      bOnly: row.review?.controls?.bOnly?.unchanged ?? null,
      assessments: dreamRunAssessments(row),
      calls,
      accountedUsd: amount,
      settledProviderUsd: calls
        .filter((c) => !c.model.startsWith("local:"))
        .reduce((n, c) => n + (c.settledUsd ?? 0), 0),
    };
  });
  const grouped = totals.map((total) => {
    const selected = dreams.filter(
      (r) => r.pin === total.pin && r.arm === total.arm,
    );
    const scientific: Record<string, number> = {};
    for (const row of selected) {
      const key = (row.verdict ?? "no-review") + "/" + row.reason;
      scientific[key] = (scientific[key] ?? 0) + 1;
    }
    return {
      ...total,
      scientific,
      sourceUnitIds: [...new Set(selected.flatMap((r) => r.units))].sort(),
      qualifiedFamilyAssessment:
        "0/3 reviewed representative families qualify as novel bounded local experiments; review is calibration-wide, not arm-specific",
      sourceSnapshots: [
        ...new Set(selected.map((r) => r.sourceSnapshot).filter(Boolean)),
      ],
    };
  });
  const paired = new Map<string, typeof dreams>();
  for (const d of dreams.filter((d) => d.matchedPairIndex !== null)) {
    const key = d.pin + ":" + d.matchedPairIndex;
    paired.set(key, [...(paired.get(key) ?? []), d]);
  }
  const matchedPairs = [...paired].map(([key, entries]) => {
    const pair = entries.find((x) => x.arm === "structured-pair");
    const triple = entries.find((x) => x.arm === "structured-triple");
    const primaryMatch =
      !!pair &&
      !!triple &&
      JSON.stringify(pair.units.slice(0, 2)) ===
        JSON.stringify(triple.units.slice(0, 2));
    if (pair && triple && !primaryMatch)
      throw new Error("Mismatched A/B ablation: " + key);
    return {
      key,
      complete: !!pair && !!triple,
      primaryMatch,
      pair: pair?.runId,
      triple: triple?.runId,
      units: triple?.units ?? pair?.units,
      pairVerdict: pair?.verdict,
      tripleVerdict: triple?.verdict,
      pairReason: pair?.reason,
      tripleReason: triple?.reason,
      pairAccountedUsd: pair?.accountedUsd,
      tripleAccountedUsd: triple?.accountedUsd,
    };
  });
  const accountedUsd = totals.reduce((n, r) => n + r.cost, 0);
  const attempts = totals.reduce((n, r) => n + r.attempts, 0);
  if (attempts !== dreams.length + blender.length)
    throw new Error("Study attempt census mismatch");
  const output = {
    measuredAt: new Date().toISOString(),
    disposition: "interim/inconclusive",
    attempts,
    accountedUsd,
    accountingBasis:
      "Production ledgers plus conservative reservations for unknown calls and historical zero-priced provider usage; not invoice cost.",
    grouped,
    dreams,
    blender,
    matchedPairs,
    independentCalibration: {
      source: "calibration-review-2026-09-14.json",
      reviewer: independentReview.reviewer,
      reviewerKind: independentReview.reviewerKind,
      reviewerMinutesApproximate: independentReview.reviewerMinutesApproximate,
      blindHash: independentReview.blindHash,
      frozenPostIds: independentReview.posts.map((p: { id: number }) => p.id),
      clarificationPostIds: independentReview.clarifications.map(
        (p: { id: number }) => p.id,
      ),
      caseJudgments: independentReview.reviewerHistogram,
      familyInterpretation: independentReview.familyInterpretation,
      qualifiedFamilies: independentReview.qualifiedFamilies,
      admissibility: independentReview.admissibility,
    },
    unblindedNoveltyReview: {
      source: "calibration-unblinded-review-2026-09-14.json",
      sourceWorkItem: unblindedReview.sourceWorkItem,
      reviewer: unblindedReview.reviewer,
      postIds: unblindedReview.postIds,
      representatives: unblindedReview.representatives,
      closure: unblindedReview.closure,
      limitations: unblindedReview.limitations,
    },
    flatFacetedAblation: {
      source: "calibration-flat-faceted-ablation-result-2026-09-14.json",
      protocol: "calibration-flat-faceted-ablation-protocol.json",
      sourceWorkItem: flatFacetedResult.sourceWorkItem,
      sourcePostId: flatFacetedResult.sourcePostId,
      sourcePostBodySha256: flatFacetedResult.sourcePostBodySha256,
      reviewer: flatFacetedResult.reviewer,
      reviewerKind: flatFacetedResult.reviewerKind,
      reviewerMinutesApproximate: flatFacetedResult.reviewerMinutesApproximate,
      exposure: flatFacetedResult.exposure,
      caseComparisons: flatFacetedResult.caseComparisons,
      primaryEndpoint: flatFacetedResult.primaryEndpoint,
      secondaryEndpoints: flatFacetedResult.secondaryEndpoints,
      interpretation: flatFacetedResult.interpretation,
    },
    scientific: {
      dreamAttempts: dreams.length,
      acceptedDreamRows: dreams.filter((d) => d.verdict === "accept").length,
      unverifiedDreamReviews: dreams.filter((d) => d.verdict === "unverified")
        .length,
      noDreamReview: dreams.filter((d) => d.verdict === null).length,
      blenderIdeas: blender.reduce((n, b) => n + b.ideasGenerated, 0),
      blenderRouted: blender.reduce((n, b) => n + b.routed, 0),
      qualifiedNovelFamilies: unblindedReview.closure.qualifiedNovelExperiments,
      downstreamEligibleCandidates:
        unblindedReview.closure.downstreamEligibleCandidates,
      downstreamTrialsExecuted:
        unblindedReview.closure.downstreamTrialsExecuted,
    },
    historicalDiagnosticWarnings: [
      "Historical timeout notes claiming never-admitted/local-governor starvation were retracted in EI-22769219749818913: the Codex adapter did not emit onAdmitted. These raw persisted strings do not establish the cause or prove no generation occurred.",
      "For the original Haiku cycle 36930ec0-0135-4c3d-8261-b9b8f8028545, the recovered driver log records four HTTP 429 rate_limit_error retries before the deadline. This contradicts its persisted never-admitted explanation. The responding hop, pool account, later retry progress and billed usage remain unestablished; retain the USD 0.039173 unknown-call reservation. Evidence is preserved in EI-22756328656642291 comment 203056; source /tmp/dream-study-pair-after-readiness-20260909.log, SHA-256 ea874cd3a74f97ec879eb9d490a8d1e257684a52f54dc487ccf716e080fe5e3c. This historical evidence does not prove current Haiku recovery.",
    ],
    infrastructureCorrections: [
      "EI-22762141222831537 is closed: the Scout production path now threads the explicit workspaceId through productionScoutRunner, buildScoutCycleDeps, and the default goal-dispatch path. Twelve focused adapter/runner tests passed. This prevents future runs from relying on ambient sentinel scope; it does not reclassify historical study outcomes.",
      "EI-22769219749818913 is closed: the deadline diagnostics now separate admission and generation budgets, with 49 focused tests passing at the recorded base and the relevant source unchanged at closure. The historical d536051b delay remains un-attributable, and no paid identity was retried.",
    ],
    outstanding: [
      "Independent human validation; the two AI source-stage reviews disagree on four of six exact dispositions",
      "Independent final acceptance and owner keep/simplify/expand/stop or explicitly inconclusive disposition",
    ],
    limitations: [
      "Four source units and one source snapshot; no domain-general inference",
      "Model blocks and pre/post infrastructure or prompt-contract windows must remain distinct",
      "Ordinary Blender uses its production corpus and one ideator, not the Dream source population",
      "Unequal spend so far; no matched-spend superiority claim",
      "All phase cost figures exclude unmeasured engineer/reviewer time and local compute dollar valuation",
      "No substantive rejection should be inferred from an unverified verdict or a missing judgment",
      "The flat/faceted comparison used different reviewers and cannot isolate representation effects from reviewer effects",
    ],
  };
  const lines = [
    "# Dream study evidence — interim",
    "",
    `Measured ${output.measuredAt}. **Inconclusive; final acceptance remains open.**`,
    "",
    `${attempts} governed study attempts; $${accountedUsd.toFixed(6)} accounted, including conservative reservations. This is not invoice cost.`,
    "",
    "| Model block | Arm | Attempts | Accounted USD |",
    "|---|---|---:|---:|",
    ...grouped.map(
      (g) =>
        `| ${g.pin === STUDY_BLOCKS.luna.pin ? "Luna/Sol" : "Haiku/Sol"} | ${g.arm} | ${g.attempts} | ${g.cost.toFixed(6)} |`,
    ),
    "",
    "## Observed outcomes",
    "",
    `Dream: ${output.scientific.dreamAttempts} attempts, ${output.scientific.acceptedDreamRows} accepted review rows, ${output.scientific.unverifiedDreamReviews} unverified reviews, and ${output.scientific.noDreamReview} attempts without a completed review. Unverified results are not substantive proposal rejections.`,
    "",
    `Blender: ${blender.length} governed cycles, ${output.scientific.blenderIdeas} generated ideas, ${output.scientific.blenderRouted} routed ideas. Routing was explicitly deferred in the newer block; its scored-idea artifacts report no survivors.`,
    "",
    `${matchedPairs.filter((x) => x.complete).length} matched A/B pairs were verified against the stored unit IDs. Both members of every completed matched comparison remain unverified; these data do not establish an incremental benefit from C.`,
    "",
    "## Interpretation",
    "",
    ...output.limitations.map((s) => "- " + s),
    "",
    ...output.historicalDiagnosticWarnings.map((s) => "- " + s),
    "",
    "## Infrastructure corrections",
    "",
    ...output.infrastructureCorrections.map((s) => "- " + s),
    "",
    "## Independent calibration review",
    "",
    `The six-case AI/domain review is frozen in [the verbatim review artifact](${output.independentCalibration.source}) with its exposure disclosure and source-quotation clarification. Original case labels: ${independentReview.reviewerHistogram.reject} rejected, ${independentReview.reviewerHistogram.unverified} unverified, ${independentReview.reviewerHistogram.accept} accepted. These are calibration judgments, not executed outcomes.`,
    "",
    "The duplicate source-packing cases count as one unverified representative family. Across five families, two are intrinsically rejected and three remain unverified. Qualified families remain unknown pending separate novelty/integration assessment; zero accepted cases does not mean zero viable families.",
    "",
    "This is exploratory AI review with disclosed incidental aggregate exposure, not pristine blindness, human validation or held-out confirmation. It used approximately 17 reviewer-minutes. No original study outcome, source pin, cost or unknown reservation is rewritten by this report.",
    "",
    "## Flat versus faceted representation ablation",
    "",
    `The separately pre-registered flat-only AI review is frozen at WI-10001412 post 204651 and preserved in [the comparison result](${output.flatFacetedAblation.source}). Exact per-case disposition agreement was **${flatAgreements}/6 (${((flatAgreements / 6) * 100).toFixed(1)}%)**; four cases changed disposition. Faceted histogram: 0 accept, 4 reject, 2 unverified. Flat histogram: 2 accept, 3 reject, 1 unverified.`,
    "",
    `Mismatches: ${flatFacetedResult.primaryEndpoint.mismatchCaseIds
      .map((caseId: string) => {
        const entry = flatFacetedResult.caseComparisons.find(
          (candidate: { caseId: string }) => candidate.caseId === caseId,
        );
        return caseId + " (" + entry.direction + ")";
      })
      .join(
        "; ",
      )}. Both reviewers recognized 1176a396ed37847cf61c and 82152aef5690ace62e79 as one duplicate family. All six flat judgments covered the required decision domains and included decisive source citations.`,
    "",
    "This is a large descriptive representation/reviewer sensitivity signal, not a causal effect estimate: different AI reviewers judged the two forms, and the faceted reviewer disclosed incidental aggregate exposure after forming judgments. Six calibration cases are not powered evidence, flat `accept` is bounded-experiment qualification rather than global novelty or benefit, and this ablation is not human validation.",
    "",
    "## Unblinded novelty and downstream eligibility",
    "",
    `The separate unblinded AI/domain review is preserved in [its structured record](${output.unblindedNoveltyReview.source}) and WI-40148 posts ${unblindedReview.postIds.join(", ")}. It evaluated the three representatives selected before key access: ${unblindedRepresentativeIds.join(", ")}.`,
    "",
    `Novel bounded local Dream experiments qualified: **${output.scientific.qualifiedNovelFamilies}/3**. The first two representatives are exact-family duplicates; the third is a refinement/consolidation of already-articulated prior compositions. All three are engineering-feasible in principle only after their missing product seams and contracts are established.`,
    "",
    `Downstream-eligible candidates: **${output.scientific.downstreamEligibleCandidates}**; downstream trials executed: **${output.scientific.downstreamTrialsExecuted}**. The downstream branch is **not applicable under the frozen evidence**, not silently deferred: no candidate passed the prerequisite novelty qualification. A later independent human review may challenge that conclusion, but tests or technical plausibility cannot promote a candidate by themselves.`,
    "",
    "The discordant flat source-stage judgments do not rewrite this later unblinded novelty result or revive downstream execution: they establish sensitivity and strengthen the need for independent human review. This remains AI review, not human validation or held-out confirmation. “Not novel” does not mean technically impossible or useless; it means these proposals cannot count as new Dream discoveries on the current unblinded evidence.",
    "",
    "## Remaining acceptance work",
    "",
    ...output.outstanding.map((s) => "- " + s),
    "",
    "## Reproduction and evidence",
    "",
    "`PAPERCUSP_WORKSPACE_ID=papercusp-workspace node --import tsx packages/operator-core/lib/dream/study/summarize.mts`",
    "",
    "The companion [JSON evidence](evidence-summary.json) records each attempt, settled calls and conservative reservations, source-unit coverage, exact paired-run matching, Blender receipts, and outstanding work. The source ledgers are `harness_shared.dream_runs` and `harness_shared.scout_ticks`; `accounting.mts` owns cumulative budget accounting. Historic trial rows are not rewritten.",
    "",
  ];
  await writeFile(
    resolve(here, "evidence-summary.json"),
    JSON.stringify(output, null, 2) + "\n",
  );
  await writeFile(resolve(here, "evidence-summary.md"), lines.join("\n"));
  console.log(
    JSON.stringify({
      attempts,
      accountedUsd,
      groups: grouped.map(({ pin, arm, attempts, cost, scientific }) => ({
        pin,
        arm,
        attempts,
        cost,
        scientific,
      })),
      matchedPairs: matchedPairs.length,
      completePairs: matchedPairs.filter((x) => x.complete).length,
    }),
  );
} finally {
  await sql.end();
}
process.exit(0);
