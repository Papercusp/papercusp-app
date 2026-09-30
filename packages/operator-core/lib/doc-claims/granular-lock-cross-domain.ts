/**
 * `locks:acquire_granular` tells agents what its lock EXCLUDES. That sentence is a
 * safety contract — a release lane reads it to decide whether it holds an exclusive
 * snapshot of the working tree — and until EI-20471899135452182 it was FALSE.
 *
 * ── The measured reality ──
 *
 * There are two lock domains, and they are mutually invisible in BOTH directions:
 *
 *   granular  `tryAcquireGranular` (granular-lock-store.ts) conflict-checks
 *             `agent_granular_locks` via `readNodeHolders`. It reads no other table.
 *   classic   `tryAcquire` (su-lock-store.ts) — the path EVERY automatic PreToolUse
 *             edit-hook claim takes — conflict-checks `agent_file_locks`. Likewise.
 *
 * So the Gray-1976 ancestor-intention property is real, but holds WITHIN the granular
 * domain only: a root X excludes a peer's granular lock on a descendant, and excludes
 * nothing at all about the per-file edit hooks that actually mutate the tree.
 *
 * ── Why this is pinned rather than just corrected ──
 *
 * Measured 2026-08-14 (WI-39007): a release lane took `path:'' mode:'X'` on a clean
 * tree, trusting the description's "conflicts with any descendant file lock". Peer
 * edits landed 60-70s AFTER the grant; `locks:queue` showed no classic holders, because
 * the two domains never consult each other. The lane lost its snapshot and fell back to
 * manual clean/status/remote coordination. The behavioural bug is an open lock-authority
 * decision — but the FALSE PROMISE is what the lane actually relied on, and a prose fix
 * with no guard rots back the first time someone "improves" the description.
 *
 * This judge therefore fails in BOTH directions:
 *   - domains still split + description promises exclusion  → the WI-39007 trap is back.
 *   - domains still split + description drops the boundary  → the warning silently rotted.
 *   - domains BRIDGED + description still disclaims         → the doc now understates the
 *     lock, so the fix must update this text with it (the gate-candidate-ref property).
 *
 * ── Bound ──
 *
 * The bridge is detected by the classic table NAME appearing in granular conflict-check
 * code. A bridge routed through a helper that never names the table would read as "still
 * split" — it fails CLOSED (toward keeping the warning), which is the safe direction, and
 * the positive control below makes a silently-empty read impossible to mistake for a pass.
 */

/** A source line implicated in the cross-domain measurement. */
export interface CrossDomainFinding {
  /** 1-based line in the source. */
  line: number;
  text: string;
}

export interface GranularCrossDomainVerdict {
  /** Granular-store CODE lines naming the classic file-lock table (evidence of a bridge). */
  bridgeSites: CrossDomainFinding[];
  /** Positive control: granular-store CODE lines naming its OWN table. */
  ownDomainSites: CrossDomainFinding[];
  /** True when the granular conflict check demonstrably consults the classic domain. */
  bridged: boolean;
  /** True when the description asserts it conflicts with FILE locks. */
  promisesCrossDomain: boolean;
  /** True when the description states the classic-file-lock boundary out loud. */
  disclaimsCrossDomain: boolean;
  /** Human-readable violations; empty when doc and code agree. */
  violations: string[];
  ok: boolean;
}

/**
 * Strip block and line comments so prose ABOUT the other domain — this repo's own
 * scope-bound comments name both tables — cannot be mistaken for the code reading it.
 */
export function stripComments(source: string): string[] {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return withoutBlocks.split('\n').map((line) => line.replace(/\/\/.*$/, ''));
}

/** The classic per-file lock table — the one the granular path must read to be bridged. */
const CLASSIC_TABLE = /agent_file_locks/;
/** The granular table — the positive control proving we judged the right file. */
const GRANULAR_TABLE = /agent_granular_locks/;

/**
 * "conflicts with ... file lock" — the exact false shape. Bounded to one clause so the
 * TRUE "conflicts with any descendant GRANULAR lock" cannot match it.
 */
const CROSS_DOMAIN_PROMISE = /conflicts?\s+with\s+[^.]*\bfile\s+locks?\b/i;
/** An explicit statement that classic file locks are NOT excluded. */
const CROSS_DOMAIN_DISCLAIMER = /\bnot\b[^.]{0,80}\bexclude[sd]?\b[^.]{0,80}\bfile\s+locks?\b/i;

/**
 * Judge the granular-store source + the tool description against each other.
 *
 * THROWS when the store source is too small, or when the positive control finds ZERO
 * mentions of the granular table. Either means we judged the wrong text — and a read
 * that silently returned nothing would otherwise produce `bridged:false` with no
 * findings, which is indistinguishable from a real measurement. That false-absence
 * shape is the one this repo keeps paying for, so it is refused rather than reported.
 */
export function judgeGranularCrossDomain(
  input: { storeSource: string; description: string },
  minLines = 60,
): GranularCrossDomainVerdict {
  const { storeSource, description } = input;

  const rawLineCount = storeSource.split('\n').length;
  if (rawLineCount < minLines) {
    throw new Error(
      `judgeGranularCrossDomain: store source has ${rawLineCount} lines (< ${minLines}). ` +
        'Refusing to judge — an empty/short read must not be reported as a clean pass.',
    );
  }
  if (description.trim().length === 0) {
    throw new Error(
      'judgeGranularCrossDomain: empty description. Refusing to judge — an unread ' +
        'description would report "no false promise" for every possible text.',
    );
  }

  const codeLines = stripComments(storeSource);
  const at = (i: number, text: string): CrossDomainFinding => ({ line: i + 1, text: text.trim() });

  const bridgeSites: CrossDomainFinding[] = [];
  const ownDomainSites: CrossDomainFinding[] = [];
  codeLines.forEach((line, i) => {
    if (CLASSIC_TABLE.test(line)) bridgeSites.push(at(i, line));
    if (GRANULAR_TABLE.test(line)) ownDomainSites.push(at(i, line));
  });

  if (ownDomainSites.length === 0) {
    throw new Error(
      'judgeGranularCrossDomain: positive control found 0 mentions of `agent_granular_locks` ' +
        'in the store source. Refusing to judge — this is not the granular store, so a ' +
        '"no bridge" reading would be an artefact of reading the wrong file.',
    );
  }

  const bridged = bridgeSites.length > 0;
  const promisesCrossDomain = CROSS_DOMAIN_PROMISE.test(description);
  const disclaimsCrossDomain = CROSS_DOMAIN_DISCLAIMER.test(description);

  const violations: string[] = [];
  if (!bridged && promisesCrossDomain) {
    violations.push(
      'The description promises the granular lock conflicts with FILE locks, but the granular ' +
        'conflict check never reads `agent_file_locks`. This is the WI-39007 trap ' +
        '(EI-20471899135452182): a root X is not an exclusive snapshot of the tree.',
    );
  }
  if (!bridged && !disclaimsCrossDomain) {
    violations.push(
      'The domains are still split, but the description no longer states that classic file ' +
        'locks are NOT excluded. Restore the boundary — without it agents re-derive the ' +
        'WI-39007 assumption from the Gray-1976 wording.',
    );
  }
  if (bridged && disclaimsCrossDomain) {
    violations.push(
      `The granular conflict check now reads the classic domain (line ${bridgeSites[0]!.line}: ` +
        `${bridgeSites[0]!.text}), but the description still disclaims cross-domain exclusion. ` +
        'The bridge landed — update this text with it.',
    );
  }

  return {
    bridgeSites,
    ownDomainSites,
    bridged,
    promisesCrossDomain,
    disclaimsCrossDomain,
    violations,
    ok: violations.length === 0,
  };
}
