/**
 * P-002 / D-004(3) / D-018 — the set of code paths that can make a prompt LIVE is a
 * CLOSED, CLASSIFIED set, and it must stay one.
 *
 * The owner ruling is worded about the consequence: "a challenger may not be installed
 * into harness_prompt_overrides unless it holds the real-anchor pool". D-018 widened
 * that from the table to the INSTALL — every path that makes a challenger's prompt live
 * is gated, with one explicit audited override.
 *
 * WHY THIS FILE EXISTS. The gate itself (`gym/promotion-gate.ts`) is well tested: it has
 * a permanent permissive control, and both of today's challenger paths assert their
 * refusal. What NOTHING tested is the CENSUS — that today's two paths are still the only
 * two. `promotion-gate.ts` states "Today there are two" in prose, and that is exactly the
 * code-describing claim the derived-truth ladder says will drift: a third writer added
 * next month breaks the ruling silently, with every existing test still green, because no
 * existing test is a statement about the POPULATION. This is the recurrence guard for the
 * class, not another test of the instance.
 *
 * WHAT IT CAN AND CANNOT SEE — stated plainly, because a census that overclaims is worse
 * than none:
 *
 *   COVERED: every `INSERT INTO harness_shared.harness_prompt_overrides` in tracked
 *   source. Each must be classified below, so a NEW one fails until its author says which
 *   kind it is — and a challenger-installing one is thereby forced past the gate.
 *
 *   NOT COVERED by the census: an install that never touches the table. `acceptProposalViaCommit`
 *   is exactly that — it commits the prompt to the harness's git tree and re-projects it,
 *   which is why D-018 had to be worded about the install rather than the table. A textual
 *   census cannot enumerate that class in general, so it is guarded separately and
 *   narrowly below (`judgeCommitPathGating`) rather than pretended into scope.
 *
 * Only INSERTs are install sites. A DELETE removes an override and can never make an
 * ungated challenger live, so the delete paths are deliberately out of scope — including
 * them would train readers to wave through the one verb that matters.
 */
import { stripComments } from './gate-candidate-ref';

/** What a given install site IS, so a reader can tell a hole from a legitimate write. */
export type InstallDisposition =
  /** Installs a gym CHALLENGER where real agents read it — D-004(3) applies; must be gated. */
  | 'gated-install'
  /** Writes to a disposable per-run gym harness, torn down after the run. No real agent reads it. */
  | 'throwaway-harness'
  /** A human/agent authoring a prompt by hand. There is no candidate and no verdict to check. */
  | 'manual-authoring';

export interface InstallSite {
  /** Nearest enclosing top-level export — the policy boundary, not an inner closure. */
  symbol: string;
  /** 1-based line of the INSERT. */
  line: number;
}

export interface ClassifiedSite {
  disposition: InstallDisposition;
  why: string;
}

/**
 * Every place a prompt can be INSERTed into the override table, and what each one is.
 *
 * Keyed `<repo-relative file>::<enclosing top-level export>`, because two writes in one
 * file can have opposite dispositions — `control-plane.ts` holds both the gated challenger
 * install and the hand-authoring editor, and a file-level key would blur exactly the
 * distinction the ruling turns on.
 */
export const CLASSIFIED_INSTALL_SITES: Record<string, ClassifiedSite> = {
  'packages/operator-core/lib/gym/control-plane.ts::decideProposal': {
    disposition: 'gated-install',
    why:
      'The gym challenger install. Gated on realAnchorHeld(row.candidateVersion) before the ' +
      'INSERT, with an audited `override: { reason }` escape stamped into the change ledger. ' +
      'Reached by BOTH the auto-decide loop and the human gym:accept route for a legacy harness.',
  },
  'packages/operator-core/lib/gym/control-plane.ts::setPrompt': {
    disposition: 'manual-authoring',
    why:
      'The gym prompt EDITOR (judge rubric / role baseline), reached from the gym:set-prompt ' +
      'route. There is no candidate and no verdict here — a human is writing the prompt, which ' +
      'D-004 has never restricted. Guarded instead by isGymEditablePromptKey.',
  },
  'packages/operator-core/lib/gym/runner-ports.ts::createGymRunnerPorts': {
    disposition: 'throwaway-harness',
    why:
      'applyPromptOverride, writing to the per-run THROWAWAY harness registered by ' +
      'registerThrowawayHarness and deleted in the same port set. No real agent spawn reads it, ' +
      'so a challenger here has not been installed anywhere D-004 is about.',
  },
  'packages/operator-core/lib/harness-prompt-overrides.ts::setPromptOverride': {
    disposition: 'manual-authoring',
    why:
      'The generic override setter behind the prompt:role-override tool and the harness/prompts ' +
      'route — hand-authored prompt text, no gym candidate involved.',
  },
};

const TABLE = /harness_shared\.harness_prompt_overrides/i;
const VERB = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|SELECT)\b/gi;
const TOP_LEVEL_EXPORT = /^export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z_$][\w$]*)/;

/**
 * Which statement does the table mention on `idx` belong to? Walks BACKWARD a few lines so
 * a query broken across lines is still classified by its verb rather than silently skipped —
 * the failure direction that would make this census read clean while missing a real install.
 */
function verbFor(lines: string[], idx: number): 'INSERT' | 'UPDATE' | 'DELETE' | 'SELECT' | null {
  for (let i = idx; i >= 0 && i >= idx - 4; i--) {
    const found = [...lines[i].matchAll(VERB)];
    if (!found.length) continue;
    const last = found[found.length - 1][1].toUpperCase();
    if (last.startsWith('INSERT')) return 'INSERT';
    if (last.startsWith('DELETE')) return 'DELETE';
    if (last.startsWith('UPDATE')) return 'UPDATE';
    return 'SELECT';
  }
  return null;
}

/** Every INSERT into the override table in one source file, with its enclosing export. */
export function findPromptOverrideInstallSites(source: string): InstallSite[] {
  const lines = stripComments(source);

  // Resolve each line's enclosing top-level export in one forward pass.
  const symbolAt: string[] = [];
  let symbol = '<module>';
  for (let i = 0; i < lines.length; i++) {
    const m = TOP_LEVEL_EXPORT.exec(lines[i]);
    if (m) symbol = m[1];
    symbolAt[i] = symbol;
  }

  const sites: InstallSite[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!TABLE.test(lines[i])) continue;
    if (verbFor(lines, i) !== 'INSERT') continue;
    sites.push({ symbol: symbolAt[i], line: i + 1 });
  }
  return sites;
}

export interface CensusVerdict {
  ok: boolean;
  /** Found in code, absent from the registry — an unclassified way to make a prompt live. */
  unclassified: string[];
  /** In the registry, no longer in code — the registry is describing something that is gone. */
  stale: string[];
  violations: string[];
}

/**
 * Compare the install sites actually present in the tree against the classified set.
 *
 * Fails in BOTH directions on purpose. An unclassified site is the dangerous one, but a
 * stale entry is what turns this file into the same drifting prose it exists to replace.
 */
export function judgeInstallCensus(
  foundKeys: string[],
  registry: Record<string, ClassifiedSite> = CLASSIFIED_INSTALL_SITES,
): CensusVerdict {
  const found = [...new Set(foundKeys)].sort();
  const known = Object.keys(registry).sort();
  const unclassified = found.filter((k) => !known.includes(k));
  const stale = known.filter((k) => !found.includes(k));
  const violations: string[] = [];

  for (const k of unclassified) {
    violations.push(
      `UNCLASSIFIED install path: ${k} writes harness_shared.harness_prompt_overrides but is not ` +
        `in CLASSIFIED_INSTALL_SITES. Classify it in prompt-override-install-paths.ts. If it installs a gym ` +
        `CHALLENGER, D-004(3)/D-018 require it to be gated on realAnchorHeld() first — see gym/promotion-gate.ts.`,
    );
  }
  for (const k of stale) {
    violations.push(
      `STALE registry entry: ${k} is classified in CLASSIFIED_INSTALL_SITES but no longer inserts into ` +
        `the override table. Remove it, so this census keeps describing the tree as it is.`,
    );
  }
  return { ok: violations.length === 0, unclassified, stale, violations };
}

/** The non-table install path D-018 had to be worded to cover. */
export const COMMIT_INSTALL_FN = 'acceptProposalViaCommit';
const REAL_ANCHOR_GATE_FN = 'realAnchorHeld';

export interface CommitPathVerdict {
  ok: boolean;
  callsCommitInstall: boolean;
  gated: boolean;
  violations: string[];
}

/**
 * A caller of `acceptProposalViaCommit` installs a challenger without touching the table, so
 * the census above is blind to it by construction. Assert the narrow structural fact that IS
 * checkable: any file reaching that install must also reach the real-anchor gate.
 *
 * Deliberately weak — it proves the gate is PRESENT in the file, not that it dominates the
 * call. That is worth having anyway: the regression this class actually produces is a new
 * accept branch wired straight to the installer with no gate anywhere in sight, and the
 * route's own unit tests already assert the refusal behaviour for the branches that exist.
 */
export function judgeCommitPathGating(source: string): CommitPathVerdict {
  // A DECLARATION is not a call. `export async function acceptProposalViaCommit(` matches a
  // naive `name\s*\(` probe, which made the installer's own module report itself as an
  // ungated caller — a false positive, and the kind that trains readers to ignore the guard.
  const text = stripComments(source)
    .join('\n')
    .replace(new RegExp(`(?:function|const|let|var)\\s+${COMMIT_INSTALL_FN}\\b`, 'g'), '');
  const callsCommitInstall = new RegExp(`\\b${COMMIT_INSTALL_FN}\\s*\\(`).test(text);
  const gated = new RegExp(`\\b${REAL_ANCHOR_GATE_FN}\\s*\\(`).test(text);
  const violations: string[] = [];
  if (callsCommitInstall && !gated) {
    violations.push(
      `${COMMIT_INSTALL_FN}() is called here with no ${REAL_ANCHOR_GATE_FN}() anywhere in the file. ` +
        `That installs a challenger's prompt by committing it, which D-018 rules is an install like any ` +
        `other — gate it on the real-anchor pool before accepting.`,
    );
  }
  return { ok: violations.length === 0, callsCommitInstall, gated, violations };
}
