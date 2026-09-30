/**
 * EI-21433690724936606 — what does THIS doc-part edit push OUT of the projected file?
 *
 * The projector already reports the parts the budget cut, and that report is not enough
 * to keep an author honest, for three reasons that compound:
 *
 *   1. It is ABSOLUTE, not a delta. On a corpus that sits ~30 chars from its budget,
 *      most of the cut list was already cut before this edit, so a newly-evicted rule
 *      is one unremarkable line among a dozen unchanged ones.
 *   2. It is TRUNCATED (`MAX_SPILL_ENTRIES`), so the newly-evicted rule can be in the
 *      elided tail and appear nowhere at all.
 *   3. It is printed by a DIFFERENT command — `project-doc-parts.mjs` — which the author
 *      runs later, if at all. `set-doc-part --write` reports "✓ written" and a green diff
 *      of the author's own text, which reads as unqualified success.
 *
 * Net effect: adding ~510 chars to one rule silently evicted four unrelated rules from
 * every agent's context, and the change was very nearly attributed to a peer editing
 * parts concurrently. A delta is short by construction, is attributable to the author
 * standing in front of it, and is therefore never truncated here.
 *
 * `projectClient` is INJECTED rather than imported. The composition, cut order and budget
 * arithmetic belong to `scripts/project-doc-parts.mjs` and must have exactly one
 * definition — re-implementing any of it here would produce a report that predicts
 * something other than what actually authors the file, which is a worse failure than no
 * report at all. Injection also makes the delta logic testable without a database.
 */

/** The row shape the projector composes from — what `readProjectedParts` returns. */
export interface ProjectionRow {
  part_key: string;
  kind: string;
  body: string;
  ordinal: number;
  client_scope: string[];
  target_section: string | null;
  project_rank: number;
  /**
   * P-022 addressing tokens. Optional: a row read before migration 1104 has none, and
   * `projectClient` treats absent and empty alike (unaddressed → the default file).
   */
  stack_scope?: string[];
}

/** The subset of `projectClient`'s result this module reads. */
export interface ProjectionResult {
  text: string;
  dropped: ProjectionRow[];
  /**
   * The parts that actually REACH this client's file. Read so `deprojected` can be
   * decided from the projector's own verdict rather than from a second copy of its
   * `partTargetsClient` scope rule — a part scoped `{codex}` never reached CLAUDE.md,
   * so emptying its scope de-projects it from AGENTS.md and from nothing else.
   */
  kept: ProjectionRow[];
}

export type ProjectClientFn = (
  parts: ProjectionRow[],
  opts: {
    client: string;
    docId: string;
    file: string;
    reader: string;
    budget: number;
  },
) => ProjectionResult;

export interface ClientSpec {
  client: string;
  file: string;
  reader: string;
}

export interface ClientImpact {
  file: string;
  /** Parts THIS edit pushes out of the file. */
  evicted: string[];
  /** Parts THIS edit makes room for (a shrinking edit). */
  restored: string[];
  /**
   * The EDITED part itself stops reaching this file, because its `client_scope` was
   * emptied rather than because the budget cut it.
   *
   * `evicted` structurally CANNOT report this, and that is the whole reason this field
   * exists. `evicted` is derived from the projector's `dropped` list — the parts it
   * considered and cut — but a scope-emptying edit removes the part from the candidate
   * set entirely (`applyEditInMemory(..., null)`), so it is never considered and never
   * dropped. Worse, its bytes are freed, so previously-cut parts fit again and the
   * report reads `✓ restores N part(s)` with a RISING headroom: the one shape an author
   * is least likely to read as "I just deleted a rule from every agent's context".
   *
   * This is the mechanism that left ~4.6KB of `harness_doc_parts` rules live-looking
   * (`tombstone=false`) but unreachable, with nothing in the pipeline reporting it
   * (EI-22179257919368370).
   */
  deprojected: boolean;
  headroomBefore: number;
  headroomAfter: number;
  /** Set when the projector refused outright; the headroom numbers are then meaningless. */
  failed?: string;
}

/**
 * The projected part list as it will be AFTER this edit commits.
 *
 * `readProjectedParts` selects only parts with a non-empty `client_scope`, so an edit
 * that empties the scope REMOVES the part from the projection and one that fills it ADDS
 * it. Both directions change what fits, so neither can be modelled as a body swap —
 * hence `next: null` for "no longer projected" rather than a row with an empty scope.
 */
export function applyEditInMemory(
  rows: ProjectionRow[],
  partKey: string,
  next: ProjectionRow | null,
): ProjectionRow[] {
  const without = rows.filter((r) => r.part_key !== partKey);
  if (!next) return without;
  return [...without, next].sort(
    (a, b) => a.ordinal - b.ordinal || a.part_key.localeCompare(b.part_key),
  );
}

/**
 * Project the corpus twice — before and after the edit — and diff the CUT SETS.
 *
 * A projector throw is captured per client rather than propagated: it means the budget
 * cannot be honoured even with every part dropped, which is worth reporting plainly but
 * must not take the author's edit down with it.
 */
export function evictionDelta(opts: {
  before: ProjectionRow[];
  after: ProjectionRow[];
  clients: ClientSpec[];
  docId: string;
  budget: number;
  projectClient: ProjectClientFn;
  /** The part being edited — the subject of `deprojected`. */
  partKey: string;
}): ClientImpact[] {
  const { before, after, clients, docId, budget, projectClient, partKey } =
    opts;

  return clients.map(({ client, file, reader }): ClientImpact => {
    try {
      const args = { client, docId, file, reader, budget };
      const b = projectClient(before, args);
      const a = projectClient(after, args);
      const droppedBefore = new Set(b.dropped.map((p) => p.part_key));
      const droppedAfter = new Set(a.dropped.map((p) => p.part_key));
      // Decided from the projector's OWN `kept`/`dropped` verdict on both passes, so it
      // asks the only question that matters per client: did this part reach this file,
      // and does it still? Reached-before AND now neither kept nor cut means it is not
      // in the projection at all — the scope-emptying case, which `evicted` cannot see.
      // A part still present but cut by the budget IS in `dropped`, so it stays an
      // ordinary eviction and is not double-reported here.
      const deprojected =
        b.kept.some((p) => p.part_key === partKey) &&
        !a.kept.some((p) => p.part_key === partKey) &&
        !droppedAfter.has(partKey);
      return {
        file,
        evicted: a.dropped
          .map((p) => p.part_key)
          .filter((k) => !droppedBefore.has(k)),
        restored: b.dropped
          .map((p) => p.part_key)
          .filter((k) => !droppedAfter.has(k)),
        deprojected,
        headroomBefore: budget - b.text.length,
        headroomAfter: budget - a.text.length,
      };
    } catch (err) {
      return {
        file,
        evicted: [],
        restored: [],
        deprojected: false,
        headroomBefore: Number.NaN,
        headroomAfter: Number.NaN,
        failed: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

const n = (v: number): string =>
  Number.isFinite(v) ? v.toLocaleString("en-US") : "?";

/**
 * Render the impact block for a CLI.
 *
 * ⚠ The evicted and restored lists are NEVER truncated. The projector truncates its
 * absolute cut list for a good reason — it is long and mostly pre-existing — but a delta
 * is bounded by what one edit displaced, and eliding its tail would recreate precisely
 * the blind spot this report exists to remove. `packages/operator-core/lib/doc-projection/
 * eviction-delta.test.ts` pins that property against a 40-part eviction.
 */
/** The subset of a `docPartIdentityProblems` finding this module reads. */
export interface IdentityProblem {
  part_key: string;
  code: string;
  detail: string;
}

/** `docPartIdentityProblems`, injected — see `identityProblemDelta`. */
export type DetectIdentityProblemsFn = (
  rows: ProjectionRow[],
) => IdentityProblem[];

/**
 * EI-21968678099053129 — which identity problems would THIS edit introduce?
 *
 * `project-doc-parts` refuses to write ANY client file while a canonical row disagrees
 * with its own generated key, and that refusal is GLOBAL: one bad row blocks CLAUDE.md,
 * AGENTS.md and the corpus for every other part in the batch. Checked only there, the
 * split is silent in the direction that matters — canonical Postgres accepts the write
 * and every file that projects it stays stale, which no test detects because the
 * projection is self-consistent and merely old.
 *
 * Reported ABSOLUTELY it would also be unattributable: the author is shown somebody
 * else's broken row and cannot tell whether they caused it. So this is a DELTA, for the
 * same reason `evictionDelta` is one. `introduced` is the author's to fix and is worth
 * refusing over; `preexisting` is already blocking their projection and must still be
 * surfaced — but never as their doing.
 *
 * `detect` is INJECTED, exactly like `projectClient` above: the identity rule has one
 * definition, in the projector that enforces it, and a second copy here would predict
 * something other than what actually refuses.
 */
export function identityProblemDelta(opts: {
  before: ProjectionRow[];
  after: ProjectionRow[];
  detect: DetectIdentityProblemsFn;
}): { introduced: IdentityProblem[]; preexisting: IdentityProblem[] } {
  const identify = (p: IdentityProblem) => JSON.stringify([p.part_key, p.code]);
  const prior = new Set(opts.detect(opts.before).map(identify));
  const introduced: IdentityProblem[] = [];
  const preexisting: IdentityProblem[] = [];
  for (const problem of opts.detect(opts.after)) {
    (prior.has(identify(problem)) ? preexisting : introduced).push(problem);
  }
  return { introduced, preexisting };
}

export function renderImpact(
  impacts: ClientImpact[],
  partKey: string,
): string {
  const out: string[] = [
    "",
    "  projection impact (what this edit does to the file):",
  ];
  for (const i of impacts) {
    if (i.failed) {
      out.push(`    ${i.file.padEnd(12)} ⚠ projector refused: ${i.failed}`);
      continue;
    }
    const delta = i.headroomAfter - i.headroomBefore;
    const arrow =
      `headroom ${n(i.headroomBefore)} -> ${n(i.headroomAfter)} chars ` +
      `(${delta >= 0 ? "+" : ""}${n(delta)})`;

    // FIRST, and never folded into the branches below. A de-projecting edit frees its
    // own bytes, so it commonly ALSO has a non-empty `restored` list — and reporting
    // that first would head the block with `✓ restores N part(s)` and a rising headroom
    // while the rule the author was editing left the file.
    if (i.deprojected) {
      out.push(
        `    ${i.file.padEnd(12)} ⚠ DE-PROJECTED — '${partKey}' NO LONGER REACHES THIS FILE — ${arrow}`,
        "                   Its client_scope is now empty, so it leaves the projection",
        "                   altogether rather than being cut by the budget. The row stays",
        "                   live and searchable in the corpus (tombstone=false), which is",
        "                   why nothing downstream reads as broken — but no agent launch",
        "                   context will carry this rule again.",
      );
      if (i.restored.length > 0) {
        out.push(
          `                   ${i.restored.length} part(s) fit again ONLY because this rule left:`,
        );
        for (const k of i.restored) out.push(`                   + ${k}`);
      }
      continue;
    }

    if (i.evicted.length > 0) {
      out.push(
        `    ${i.file.padEnd(12)} ⚠ EVICTS ${i.evicted.length} part(s) — ${arrow}`,
      );
      for (const k of i.evicted) {
        out.push(
          `                   - ${k}${
            k === partKey ? "   <- the part you are editing" : ""
          }`,
        );
      }
      if (i.evicted.includes(partKey)) {
        out.push(
          "                   (your own part does not fit: it goes to the file's spill",
          "                    pointer, not the file. Shorten it or raise its rank.)",
        );
      }
    } else if (i.restored.length > 0) {
      out.push(
        `    ${i.file.padEnd(12)} ✓ restores ${i.restored.length} part(s) — ${arrow}`,
      );
      for (const k of i.restored) out.push(`                   + ${k}`);
    } else {
      out.push(`    ${i.file.padEnd(12)} no change to the cut set — ${arrow}`);
    }
  }
  return out.join("\n");
}
