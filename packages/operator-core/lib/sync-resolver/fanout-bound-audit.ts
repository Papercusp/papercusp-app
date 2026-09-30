/**
 * fanout-bound-audit.ts — the STRUCTURAL guard for variable-arity read fan-outs.
 *
 * WHY THIS EXISTS (WI-39849)
 *
 * WI-39823/WI-39825 bounded the sync-resolver read fan-outs by working from an
 * audited site list. That list was built by matching the shape
 *
 *     Promise.all([legA(), legB(), legC()])          // FIXED arity
 *
 * and it therefore never saw the other shape:
 *
 *     Promise.all(xs.map(async (x) => store(x)))     // VARIABLE arity
 *
 * Four such sites survived an audit that read as exhaustive — and they are the
 * WORSE half, because their leg count is not a constant a reviewer can eyeball:
 * it scales with the workspace (one leg per hive, per pot, per referenced pack).
 * A workspace that grows turns a passing read into a timing-out one with no code
 * change at all.
 *
 * The lesson is not "we missed three sites", it is that the SHAPE PREDICATE was
 * the defect. A list of sites cannot encode that lesson; a predicate can. So the
 * predicate lives here, executable, and the guard re-derives the population from
 * source on every run instead of trusting a list someone once wrote down.
 *
 * WHAT IT CHECKS
 *
 * Every variable-arity `Promise.all(... .map(...))` in the audited files must sit
 * inside a function that establishes a bounding seam — a `createReadDeadline`, an
 * injected `withinBudget`, or delegation to a reader that carries one
 * (`readBoundedList`). Anything else is reported, with the resolver key when the
 * site sits under one, so the finding names the panel that would hang.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK
 *
 * It does not prove the legs are ACTUALLY bounded — a resolver could create a
 * deadline and then forget to wrap one leg. Proving that needs the call graph,
 * not the syntax. This guard closes the cheap, high-recurrence gap (a NEW fan-out
 * added to an unbounded function) and says so rather than implying more.
 *
 * WHY IT AUDITS THIS DIRECTORY ONLY — the triage criterion (WI-39865)
 *
 * An unbounded variable-arity fan-out is NOT automatically a defect. What made
 * the sync-resolver sites defects is the READ PATH they sit on: a resolver leg is
 * awaited inside the sync layer's ~10s RESOLVER_READ_TIMEOUT, and ONE hanging leg
 * fails the WHOLE panel (a 500), not just its own row. The class is therefore
 *
 *     awaited on a bounded shared read path AND a hang FAILS the surface
 *
 * not "an unbounded `Promise.all`". Measured 2026-08-18 over the neighbouring
 * population: 50 variable-arity fan-outs with no enclosing seam exist across
 * `derived-reads/` + `agent-tools/` — a SHAPE count, not a defect count. The 3 in
 * `derived-reads/producers.ts` (the only ones plausibly in the class, since they
 * feed the same panels) were read and are OUT of it, structurally:
 *
 *   - a producer's `compute` is never awaited by a sync read while
 *     `FLAGS.PRECOMPUTE_DERIVED_READS` is on (FLAG_DEFAULTS resolves `true`, and
 *     it is not in KNOWN_DARK_FLAGS). The read is a plain snapshot SELECT, and a
 *     miss fires a `void` warm that derived-reads/registry.ts documents as
 *     "Never awaited by a read" — that is invariant D-003 of that substrate.
 *   - so a hanging leg DEGRADES (an empty/stale panel carrying its `_meta`),
 *     which is the trade the substrate exists to make. It cannot 500 the panel.
 *   - the expensive leg is already bounded one layer down regardless:
 *     JOURNALCTL_TIMEOUT_MS on the per-hive `execFile` (EI-19937931088042507).
 *
 * Their residual risk is real but DIFFERENT, and belongs to the registry rather
 * than to any one fan-out: `refreshDerivedReads` runs producers sequentially with
 * no per-producer timeout, so one wedged producer stales every derived panel
 * until the DBOS fire deadline (ROUTINE_FIRE_TIMEOUT_MS, 2h) reaps it. If that is
 * ever worth tightening, the fix is ONE timeout around the single
 * `producer.compute` call in registry.ts — bounding 3 fan-outs inside 3 producers
 * would leave the other ~20 producers unbounded and the class unfixed.
 *
 * So: before pointing this guard at another directory, apply the criterion above
 * to it. Widening it to a population whose hangs merely degrade turns a precise
 * signal into noise, and mass-bounding those 50 sites would be churn defended by
 * a shape count nobody has tied to a failure.
 */

import ts from 'typescript';

/**
 * Tokens whose presence in an enclosing function means a deadline governs the
 * reads inside it. `withinBudget` covers both the local `const withinBudget =
 * createReadDeadline(...)` idiom and the injected-`WithinBudget` seam the
 * extracted `*-read.ts` readers take as an option.
 */
export const BOUNDING_SEAMS = ['createReadDeadline', 'withinBudget', 'readBoundedList'] as const;

/** One variable-arity `Promise.all(xs.map(...))` found in source. */
export interface FanOutSite {
  /** File the site was found in, as handed to the analyzer. */
  file: string;
  /** 1-indexed line of the `Promise.all` call. */
  line: number;
  /**
   * The sync-resolver registry key the site sits under (`'hive.controlState'`),
   * or null when the site is not inside a registry `resolve:` — e.g. a helper in
   * an extracted `*-read.ts`.
   */
  resolverKey: string | null;
  /** The mapped expression, e.g. `hives.map(async (hv) => {` — for the report. */
  snippet: string;
  /** Which seam token bounded the enclosing function, or null if none did. */
  boundedBy: string | null;
  /** Name of the outermost enclosing function, when it has one. */
  functionName: string | null;
  /**
   * The stable handle an exemption names: the registry key when the site sits
   * under one, else `file#functionName`, else the file. Function-level so an
   * exemption cannot silently cover a NEW fan-out added elsewhere in the file.
   */
  identity: string;
}

/** A site the guard accepts unbounded, and the reason it is safe. */
export interface FanOutExemption {
  /**
   * The site's `identity` — a registry key, or `file.ts#functionName`. Function-
   * scoped on purpose: a file-wide exemption would silently swallow the NEXT
   * fan-out someone adds to that file, which is the failure this guard exists for.
   */
  where: string;
  /** Why this fan-out needs no deadline of its own. Required — an unexplained hole is a hole. */
  reason: string;
}

/**
 * The two honest reasons a variable-arity fan-out needs no deadline HERE:
 * its legs do no IO, or an OUTER deadline already governs the whole call.
 *
 * The second kind is this analyzer's blind spot, not an excuse: it reads one
 * function at a time and cannot follow a call graph, so a helper bounded by its
 * CALLER looks identical to one bounded by nobody. Each entry below therefore
 * cites the exact bounding call site, so the claim is checkable by reading two
 * named lines rather than by trusting the entry.
 *
 * SHRINK-ONLY in spirit: an entry asserts a property that is either true or has
 * stopped being true. If a leg gains a store read, or a caller stops wrapping
 * it, the entry must be REMOVED — never widened to keep the guard quiet.
 */
export const FANOUT_EXEMPTIONS: readonly FanOutExemption[] = [
  {
    where: 'learning-retain-read.ts#readInsightDocsPage',
    reason:
      'Bounded by its CALLER: index.ts wires it as deps.listRunbooksPage, which readRetainFeed invokes only inside withinBudget(legFns[k](), `${k} leg`) — so a hang in either fs fan-out rejects the whole runbook leg on the shared deadline and degrades it, exactly like a throw.',
  },
];

function enclosingFunction(node: ts.Node, sf: ts.SourceFile): { text: string; name: string | null } {
  let cur: ts.Node | undefined = node.parent;
  let last: ts.Node = node;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur)
    ) {
      last = cur;
      // Keep walking: a nested arrow (the map callback itself) is not where the
      // deadline lives. The OUTERMOST function in the chain is the read.
    }
    cur = cur.parent;
  }

  let name: string | null = null;
  if ((ts.isFunctionDeclaration(last) || ts.isFunctionExpression(last)) && last.name) {
    name = last.name.getText(sf);
  } else if (last.parent && ts.isVariableDeclaration(last.parent)) {
    name = last.parent.name.getText(sf);
  } else if (last.parent && ts.isPropertyAssignment(last.parent)) {
    name = last.parent.name.getText(sf).replace(/['"]/g, '');
  }
  return { text: last.getText(sf), name };
}

/**
 * The registry key a site sits under: walk out to the `resolve:` property, then
 * take the name of the property assignment that owns its object literal.
 */
function enclosingResolverKey(node: ts.Node, sf: ts.SourceFile): string | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isPropertyAssignment(cur) && cur.name.getText(sf).replace(/['"]/g, '') === 'resolve') {
      const objectLiteral = cur.parent;
      const owner = objectLiteral?.parent;
      if (owner && ts.isPropertyAssignment(owner)) {
        return owner.name.getText(sf).replace(/['"]/g, '');
      }
      return null;
    }
    cur = cur.parent;
  }
  return null;
}

/** Every variable-arity `Promise.all(xs.map(...))` in one source text. */
export function findVariableArityFanOuts(sourceText: string, file = 'source.ts'): FanOutSite[] {
  const sf = ts.createSourceFile(file, sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const sites: FanOutSite[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'all' &&
      node.expression.expression.getText(sf) === 'Promise'
    ) {
      const argText = node.arguments.map((a) => a.getText(sf)).join(',');
      if (/\.\s*map\s*\(/.test(argText)) {
        const fn = enclosingFunction(node, sf);
        const boundedBy = BOUNDING_SEAMS.find((seam) => fn.text.includes(seam)) ?? null;
        const resolverKey = enclosingResolverKey(node, sf);
        sites.push({
          file,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          resolverKey,
          snippet: argText.split('\n')[0]!.trim().slice(0, 100),
          boundedBy,
          functionName: fn.name,
          identity: resolverKey ?? (fn.name ? `${file}#${fn.name}` : file),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

/**
 * The sites a reviewer must act on: variable-arity, unbounded, and not exempt.
 * An exemption matches a site's `identity` — nothing coarser.
 */
export function unboundedFanOuts(
  sites: readonly FanOutSite[],
  exemptions: readonly FanOutExemption[] = FANOUT_EXEMPTIONS,
): FanOutSite[] {
  const exempt = new Set(exemptions.map((e) => e.where));
  return sites.filter((s) => s.boundedBy === null && !exempt.has(s.identity));
}

/** A human-readable line per finding, for a failing assertion's message. */
export function describeFanOut(site: FanOutSite): string {
  return `${site.file}:${site.line} ${site.resolverKey ? `[${site.resolverKey}] ` : ''}${site.snippet}`;
}
