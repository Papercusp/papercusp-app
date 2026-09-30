/**
 * pot-git/foreign-merge-admission.ts — the CANONICAL-MERGE admission gate for
 * FOREIGN-marked refs (p2p-work-distribution-2026-07-02 P-110; finding X2).
 *
 * THE HOLE THIS CLOSES (the foreign-work twin of github-ingress-admission):
 * git author is FREE TEXT and a foreign session (P-104/P-105) has shell+git.
 * Without this gate a hand-crafted `--author=<owner>` commit publishes via the
 * results channel (P-108), merges into canonical staging, and the
 * github-bridge egresses it to GitHub permanently attributed to a human who
 * never wrote it. This gate runs between the foreign results ref and ANY merge
 * into canonical staging: the merge lane only consumes a foreign head this
 * module ADMITS.
 *
 * THE PREDICATE (structural dual of github-ingress-admission, with the posture
 * INVERTED where the threat model differs):
 *   - walk the FOREIGN-INTRODUCED range (`head ^staging [^exclude...]` — the
 *     commits reachable ONLY via the foreign-marked ref, per X2);
 *   - every commit's author AND committer identity must resolve to a GitHub
 *     NUMERIC user id (X9: logins are mutable+reusable) WITHIN the offer's
 *     attested ORIGIN chain (`originGithubUserIds`, resolved by the caller
 *     from the offer's attestation map — P-102/P-104 wiring);
 *   - an UNKNOWN author (unmappable email) REFUSES — this is the exact spoof
 *     surface (`--author="Owner <owner@gmail.com>"`), so unlike the ingress
 *     gate (unknown = reported, not blocked) unknown here is INADMISSIBLE;
 *   - an identity OUTSIDE the chain REFUSES, loudly, naming the commit + role.
 *
 * FAIL-CLOSED everywhere — this is a TRUST decision: a git failure, an
 * over-long range, an EMPTY origin chain, or a non-foreign ref input refuses
 * with basis 'error'. There is NO baseline exemption (contrast ingress): a
 * foreign head is ALWAYS a contribution — with a null staging base the FULL
 * history of the head is judged.
 *
 * CONTRACT FOR THE P-109 COMMIT LANE: because BOTH author and committer are
 * judged, the per-foreign-workspace commit lane must stamp BOTH identities
 * from the attestation map (C7 origin author; committer likewise resolvable
 * within the chain). A merge of canonical staging INTO the foreign branch is
 * fine — those commits are ancestors of staging and fall out of the range.
 *
 * M21: the offer id threads through — pass `offerId` and every result echoes
 * it so receipts / audit rows / p2p:trace correlate both sides.
 *
 * Pure over storage.ts's RunGit + injected resolution seams, so it tests
 * against a temp repo with no PG. Refusal RECEIPTS (P-004) are the caller's
 * job; `formatForeignRefusal` renders the canonical loud one-liner for them.
 */

import { type RunGit, defaultRunGit } from './storage';
import { githubUserIdFromEmail } from './github-ingress-admission';

/** Range cap — a single foreign merge bigger than this fails CLOSED (a legit
 *  giant foreign deliverable is rare; the origin splits it or the host owner
 *  raises the cap). Same default as the ingress gate. */
export const DEFAULT_MAX_FOREIGN_RANGE_COMMITS = 5_000;

/**
 * The foreign-marked ref family (C8/X3). Matches BOTH P-108 candidate shapes
 * so the marker is stable across the pending (a)/(b) decision:
 *   (a) nested in an executor device namespace:
 *       refs/namespaces/<hex>/refs/foreign/<fleet>/...
 *   (b) top-level per-fleet visibility family:
 *       refs/foreign/<fleet>/...
 */
const FOREIGN_SEGMENT_RE = /^refs\/foreign\/([^/]+)(?:\/|$)/;
const NAMESPACE_PREFIX_RE = /^refs\/namespaces\/[0-9a-f]+\//i;

/** Is this ref in the foreign-marked family (either P-108 shape)? */
export function isForeignMarkedRef(ref: string): boolean {
  return FOREIGN_SEGMENT_RE.test(ref.replace(NAMESPACE_PREFIX_RE, ''));
}

/** Extract the fleet slug a foreign-marked ref belongs to (null if not foreign). */
export function foreignFleetFromRef(ref: string): string | null {
  const m = FOREIGN_SEGMENT_RE.exec(ref.replace(NAMESPACE_PREFIX_RE, ''));
  return m ? m[1] : null;
}

/** One inadmissible identity found in the foreign range. */
export interface ForeignRefusalReason {
  sha: string;
  /** Which identity slot failed — both are judged (see module header). */
  role: 'author' | 'committer';
  email: string;
  /** Resolved GitHub id when mappable but out-of-chain; null when unmappable. */
  githubUserId: number | null;
  reason: 'out-of-chain' | 'unmappable';
}

export interface ForeignAdmissionInput {
  /** The repo holding both the canonical staging line and the foreign ref. */
  repoPath: string;
  /** The foreign-marked ref being merged (validated: must be foreign-marked). */
  foreignRef: string;
  /** The foreign head sha to judge (the tip of foreignRef as read by caller). */
  head: string;
  /** Canonical staging sha the merge would land on. null = empty canonical →
   *  the FULL history of head is judged (no baseline exemption; see header). */
  stagingHead: string | null;
  /** The offer's attested ORIGIN chain as GitHub NUMERIC user ids (X9). The
   *  caller resolves this from the offer + attestation map. Empty = error. */
  originGithubUserIds: number[];
  /** M21 offer-id threading — echoed verbatim on the result. */
  offerId?: string;
  /** Extra negative tips ("reachable ONLY via foreign-marked refs", X2).
   *  ONLY already-admitted canonical tips (e.g. release refs) belong here —
   *  never unvetted member refs, which must not grant admission by exclusion. */
  excludeReachableFrom?: string[];
  runGit?: RunGit;
  /** Widen email→id resolution beyond the noreply pattern (e.g. an attestation
   *  -map email lookup). Consulted only when the pattern yields nothing; a
   *  resolver failure leaves the email unmappable → REFUSED (fail closed). */
  resolveGithubUserId?: (email: string) => Promise<number | null>;
  maxRangeCommits?: number;
}

export interface ForeignAdmissionResult {
  /** May the merge lane integrate this foreign head into canonical staging? */
  admit: boolean;
  /** 'clean' = walked and every identity in-chain; 'refused' = inadmissible
   *  identities found; 'error' = fail-closed on a mechanical/contract fault. */
  basis: 'clean' | 'refused' | 'error';
  /** Echo of the input (M21 threading + receipt assembly). */
  offerId: string | null;
  foreignRef: string;
  /** Every inadmissible identity, commit-exact (empty unless basis 'refused'). */
  refusals: ForeignRefusalReason[];
  /** GitHub ids that appeared in the range and were judged against the chain. */
  checkedIdentityIds: number[];
  /** Commits walked (the foreign-introduced range size). */
  rangeSize: number;
  errors: string[];
}

/**
 * Judge one foreign-marked head against the offer's attested origin chain.
 * Never throws; every fault fails CLOSED (admit:false).
 */
export async function admitForeignMergeHead(
  input: ForeignAdmissionInput,
): Promise<ForeignAdmissionResult> {
  const runGit = input.runGit ?? defaultRunGit;
  const maxRange = input.maxRangeCommits ?? DEFAULT_MAX_FOREIGN_RANGE_COMMITS;

  const res: ForeignAdmissionResult = {
    admit: false,
    basis: 'error',
    offerId: input.offerId ?? null,
    foreignRef: input.foreignRef,
    refusals: [],
    checkedIdentityIds: [],
    rangeSize: 0,
    errors: [],
  };

  // Contract validation — all fail closed, loudly.
  if (!isForeignMarkedRef(input.foreignRef)) {
    res.errors.push(
      `ref '${input.foreignRef}' is not in the foreign-marked family (refs/foreign/<fleet>/...) — this gate judges foreign merges only; a non-foreign ref here is a caller bug`,
    );
    return res;
  }
  if (input.originGithubUserIds.length === 0) {
    res.errors.push(
      'empty origin chain: no attested GitHub user ids supplied — nothing is admissible; resolve the offer\'s origin chain (P-102/P-104) before judging',
    );
    return res;
  }
  const chain = new Set(input.originGithubUserIds);

  // Walk the foreign-introduced range: sha \0 author-email \0 committer-email.
  // `head ^staging [^exclude...]` = commits reachable ONLY via the foreign ref
  // relative to what canonical already contains (X2).
  const negatives: string[] = [];
  if (input.stagingHead) negatives.push(`^${input.stagingHead}`);
  for (const ex of input.excludeReachableFrom ?? []) negatives.push(`^${ex}`);
  const log = await runGit(
    ['log', '--format=%H%x00%ae%x00%ce', input.head, ...negatives],
    input.repoPath,
  );
  if (log.code !== 0) {
    res.errors.push(`rev walk failed: ${log.stderr.trim() || `exited ${log.code}`}`);
    return res; // fail closed
  }
  const rows = log.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  res.rangeSize = rows.length;
  if (rows.length > maxRange) {
    res.errors.push(
      `foreign range at ${input.head.slice(0, 8)} has ${rows.length} commits (> ${maxRange}) — refusing to judge; split the deliverable or raise the cap`,
    );
    return res; // fail closed
  }

  // Judge BOTH identities on every commit (see module header for why).
  const checked = new Set<number>();
  for (const row of rows) {
    const [sha, authorEmail, committerEmail] = row.split('\0');
    if (!sha) continue;
    const slots: { role: 'author' | 'committer'; email: string }[] = [
      { role: 'author', email: authorEmail ?? '' },
      { role: 'committer', email: committerEmail ?? '' },
    ];
    for (const slot of slots) {
      let id = githubUserIdFromEmail(slot.email);
      if (id === null && input.resolveGithubUserId) {
        try {
          id = await input.resolveGithubUserId(slot.email);
        } catch {
          id = null; // resolver failure → unmappable → refused below (fail closed)
        }
      }
      if (id === null) {
        res.refusals.push({ sha, role: slot.role, email: slot.email, githubUserId: null, reason: 'unmappable' });
        continue;
      }
      checked.add(id);
      if (!chain.has(id)) {
        res.refusals.push({ sha, role: slot.role, email: slot.email, githubUserId: id, reason: 'out-of-chain' });
      }
    }
  }
  res.checkedIdentityIds = [...checked].sort((a, b) => a - b);

  if (res.refusals.length > 0) {
    res.basis = 'refused';
    res.admit = false;
  } else {
    res.basis = 'clean';
    res.admit = true;
  }
  return res;
}

/**
 * Render the canonical LOUD refusal line (P-004 posture: name the exact
 * failure; M21: lead with the offer id). Callers put this on the receipt to
 * the requester, the local audit row, and the counter-metric label.
 */
export function formatForeignRefusal(result: ForeignAdmissionResult): string {
  const offer = result.offerId ? `offer ${result.offerId}` : 'offer <unknown>';
  if (result.admit) return `${offer}: foreign head at ${result.foreignRef} ADMITTED (${result.basis}, ${result.rangeSize} commits judged)`;
  if (result.basis === 'error') {
    return `${offer}: foreign merge REFUSED (fail-closed error) at ${result.foreignRef} — ${result.errors.join('; ')}`;
  }
  const detail = result.refusals
    .slice(0, 5)
    .map((r) => `${r.sha.slice(0, 8)} ${r.role} '${r.email}' ${r.reason === 'unmappable' ? 'unmappable to a GitHub id' : `resolves to github user ${r.githubUserId} outside the attested origin chain`}`)
    .join('; ');
  const more = result.refusals.length > 5 ? ` (+${result.refusals.length - 5} more)` : '';
  return `${offer}: foreign merge REFUSED at ${result.foreignRef} — inadmissible identities: ${detail}${more}`;
}
