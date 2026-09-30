/**
 * emitter-pin — pins EVENT_CATALOG's hand-authored `emitter` and `exists` fields
 * to the code they describe (EI-21087476375596978).
 *
 * ── Why this exists ──
 *
 * `emitter` is a prose string and `exists` a boolean, both hand-typed beside every
 * family. They are a second copy of a truth the CODE owns, which is the exact shape
 * CLAUDE.md § "code-describing metadata" says will drift — and it has: measured
 * 2026-08-31, `escalation-resolved` named `tools/resolve.ts` + `spawn/approve.ts`,
 * neither of which mentions the key. Both are CALLERS of `resolveEscalation`; the
 * emit lives in `coordination/escalations.ts`. Nothing caught it because
 * `catalog.test.ts` guards internal consistency only (unique families, template↔param
 * agreement, prefix uniqueness) and never looks outside the catalog at all.
 *
 * The consequence is not cosmetic. `renderCatalog` copies `exists` straight into
 * `awaitable_now`, so an agent reading `events:catalog` is told it may await a key
 * today; and when an await does not rendezvous, `emitter` is the first place anyone
 * looks to find out who was supposed to fire it. A wrong emitter path sends the
 * debugging to a file that has nothing to do with the failure.
 *
 * ── Direction, and why it is a SEPARATE module from ./emitter-coverage ──
 *
 * `./emitter-coverage` walks the tree and asks "is every EMITTED key REGISTERED?".
 * This asks the opposite: "does every REGISTERED key's DECLARED emitter really emit
 * it?". Neither implies the other — the live drift here was invisible to the sibling
 * because `escalation:resolved` *is* registered and *is* emitted; only the prose
 * saying WHERE was wrong. They share `stripComments` so the two directions cannot
 * disagree about what counts as code versus prose.
 *
 * ── The four tiers, and why the weakest one is the load-bearing one ──
 *
 * A key reaches `emitAwaitedEvent` in ways static analysis cannot always resolve. The
 * decisive case is a key BUILDER that interpolates the family segment itself:
 *
 *     export function fleetTransitionKey(slug: string, kind: FleetTransitionKind) {
 *       return `fleet:${kind}:${slug}`;      // "fleet:member-dead" appears NOWHERE
 *     }
 *
 * There is no text in that file matching the family's key head, so a guard demanding
 * a static emit would fail on 12 families that are correctly attributed and working.
 * Demanding LESS is what makes the guard true: tier 2 asks only that the declared
 * file MENTIONS the key head at all (code or prose). That is weak enough to be green
 * on every dynamic emitter and still strong enough to catch the whole drift class —
 * a rename, a move, a retarget, a copy-pasted emitter string — because a file that
 * never mentions the key is not where it is emitted. Tiers 3 and 4 then keep the
 * exemptions from becoming a parking lot.
 *
 *   1. PATHS RESOLVE      — every path named in an `emitter` string is a real file.
 *   2. ATTRIBUTION        — an `exists:true` family's key head appears in ≥1 of its
 *                           declared files. This is the tier that catches drift.
 *   3. DYNAMIC, DECLARED  — head present only in PROSE ⇒ the family must be listed in
 *                           {@link DYNAMIC_KEY_FAMILIES} with a reason. Listing is
 *                           shrink-only: once a family's key becomes statically
 *                           present in code, its exemption is reported as STALE.
 *   4. PATHLESS, DECLARED — an `emitter` naming no path at all must be listed in
 *                           {@link PATHLESS_EMITTER_FAMILIES} with a reason, so the
 *                           "label (path/to/file.ts)" convention cannot quietly erode.
 *
 * Plus the `exists` half: an `exists:false` family whose declared file already emits
 * the key in code is a STALE false — the Phase-2 addition landed and nobody flipped
 * the boolean. (Live population of `exists:false` is currently zero, so that rule is
 * carried by fixtures alone; it is implemented because an empty population is the
 * reason a field rots, not a reason to skip guarding it.)
 *
 * ⚠ STATED BOUND: tier 2 is a substring test over one file, not a call-graph proof.
 * It cannot tell a real emit from a doc comment — that is deliberate, and tier 3 is
 * what records which families rely on that leniency. It fails OPEN in the direction
 * that matters: a file that does not mention the key cannot pass.
 *
 * Pure + injectable (`readFile`, `fileExists`) so the test drives it over fixtures
 * AND over the real tree without a second implementation.
 */

import { familyKeyPrefix, type EventCatalogEntry } from './catalog';
import { stripComments } from './emitter-coverage';

/**
 * Repo-relative source paths inside an `emitter` string.
 *
 * Anchored on the workspace roots rather than on the parenthesis convention: the
 * live strings write paths four different ways — `(path.ts)`, `(path.ts, helperName)`,
 * `path.ts — NOTE`, and a bare `a.mjs → b.ts` chain — and a parens-only reader
 * silently sees NO path in three of them, which reads as "nothing to check".
 */
const EMITTER_PATH_RE = /(?:packages|apps|libs|scripts)\/[A-Za-z0-9._/-]+\.(?:ts|tsx|mts|mjs|js)/g;

/** Every repo-relative source path an `emitter` string names, in order, deduped. */
export function declaredEmitterPaths(emitter: string): string[] {
  return [...new Set(String(emitter).match(EMITTER_PATH_RE) ?? [])];
}

/**
 * Families whose key is assembled at RUNTIME, so no declared file can contain the
 * head as static text. Each names the mechanism — an unexplained entry is how a real
 * gap gets parked forever (same discipline as `emitter-coverage`'s `allow` map).
 *
 * ⛔ SHRINK-ONLY. Do not add a family here to silence tier 2. The correct fix for a
 * new entry is almost always to build the key through `buildKey(family, params)` so
 * the template is sourced from the catalog and cannot drift — which also makes the
 * exemption unnecessary. This list is therefore also the worked backlog for that
 * change: it is exactly the set of emitters that would benefit.
 */
export const DYNAMIC_KEY_FAMILIES: Readonly<Record<string, string>> = {
  'fleet-member-dead': 'fleetTransitionKey() interpolates the KIND segment: `fleet:${kind}:${slug}`',
  'fleet-member-left': 'fleetTransitionKey() interpolates the KIND segment',
  'fleet-context-critical': 'fleetTransitionKey() interpolates the KIND segment',
  'fleet-claim-released': 'fleetTransitionKey() interpolates the KIND segment',
  'fleet-item-completed': 'fleetTransitionKey() interpolates the KIND segment',
  'fleet-member-stalled': 'fleetTransitionKey() interpolates the KIND segment',
  'fleet-admission-blocked': 'fleetTransitionKey() interpolates the KIND segment',
  'fleet-repeated-recovery': 'fleetTransitionKey() interpolates the KIND segment',
  'service-up': 'one emitter builds both up/down from a `to` discriminant',
  'service-down': 'one emitter builds both up/down from a `to` discriminant',
  'git-sync': 'key assembled from a phase variable inside the git-sync event helper',
  'git-sync-egress': 'declared file is the CALLER; the emit is in its git-sync-events helper',
  'session-compacted': 'emitted through a helper re-exported from session-compacted-events',
  'consult-reply': 'declared files are the consult verbs; the emit is in get-feedback-core',
};

/**
 * Families whose `emitter` names no source path — a subsystem label instead. Kept
 * short deliberately: a label is only adequate where the subsystem is a single
 * obvious module. New families should name a path.
 */
export const PATHLESS_EMITTER_FAMILIES: Readonly<Record<string, string>> = {
  lock: 'lock-grant-bridge spans the locks:* verb surface, not one file',
  'work-item-done': 'work-items-events — the whole module is the emitter',
  'work-item-unblocked': 'work-items-events — the whole module is the emitter',
  'work-item-blocked': 'work-items-events — the whole module is the emitter',
  'work-item-claimed': 'work-items-events — the whole module is the emitter',
  'claim-released': 'fired from BOTH work_items:release and the stale-claim reaper',
  'rate-limit-paused': 'gym rate-pause-events — the whole module is the emitter',
};

/** One tier-2/3/4 finding, already phrased as the repair. */
export interface EmitterPinFinding {
  family: string;
  /** The key head the family's declared files were searched for. */
  head: string;
  detail: string;
}

export interface EmitterPinVerdict {
  ok: boolean;
  /** Tier 1: an `emitter` names a path that does not exist. */
  missingPaths: EmitterPinFinding[];
  /** Tier 2: an `exists:true` family whose declared files never mention its key. */
  unattributed: EmitterPinFinding[];
  /** Tier 3: head is prose-only and the family is not in DYNAMIC_KEY_FAMILIES. */
  undeclaredDynamic: EmitterPinFinding[];
  /** Tier 3, stale side: listed as dynamic but the head IS now static code. */
  staleDynamic: EmitterPinFinding[];
  /** Tier 4: no declared path and not in PATHLESS_EMITTER_FAMILIES. */
  undeclaredPathless: EmitterPinFinding[];
  /** Tier 4, stale side: listed as pathless but the `emitter` now names a path. */
  stalePathless: EmitterPinFinding[];
  /** `exists:false` whose declared file already emits the key in code. */
  staleExistsFalse: EmitterPinFinding[];
  /** Every finding, flattened, for a one-line assertion message. */
  violations: string[];
}

export interface EmitterPinOptions {
  catalog: readonly EventCatalogEntry[];
  /** Repo-relative read; MUST throw/reject for a path that does not exist. */
  readFile: (path: string) => string;
  /** Repo-relative existence probe. */
  fileExists: (path: string) => boolean;
  dynamic?: Readonly<Record<string, string>>;
  pathless?: Readonly<Record<string, string>>;
}

/**
 * The key head a declared emitter file is searched for: the family's key template up
 * to its first interpolated param, with any trailing separator removed.
 *
 * `familyKeyPrefix` is reused rather than re-deriving from `keyTemplate`, so the head
 * this guard searches for is the SAME string the live-awaiter join and the orphan
 * guard use. A second derivation here would be one more copy that can drift — the
 * very defect this module exists to catch.
 */
export function emitterKeyHead(entry: EventCatalogEntry): string {
  return familyKeyPrefix(entry).replace(/:$/, '');
}

/** Judge one catalog against the tree. Pure: all I/O arrives through `opts`. */
export function judgeEmitterPins(opts: EmitterPinOptions): EmitterPinVerdict {
  const dynamic = opts.dynamic ?? DYNAMIC_KEY_FAMILIES;
  const pathless = opts.pathless ?? PATHLESS_EMITTER_FAMILIES;

  const v: EmitterPinVerdict = {
    ok: true,
    missingPaths: [],
    unattributed: [],
    undeclaredDynamic: [],
    staleDynamic: [],
    undeclaredPathless: [],
    stalePathless: [],
    staleExistsFalse: [],
    violations: [],
  };

  for (const entry of opts.catalog) {
    const head = emitterKeyHead(entry);
    const declared = declaredEmitterPaths(entry.emitter);
    const family = entry.family;

    // ── tier 1: every named path resolves ────────────────────────────────────
    const present: string[] = [];
    for (const path of declared) {
      if (opts.fileExists(path)) present.push(path);
      else
        v.missingPaths.push({
          family,
          head,
          detail: `emitter names "${path}", which does not exist — update the emitter string to the file that emits "${head}" now`,
        });
    }

    // ── tier 4: an emitter with no path at all must be declared as such ───────
    if (declared.length === 0) {
      if (pathless[family] === undefined)
        v.undeclaredPathless.push({
          family,
          head,
          detail: `emitter "${entry.emitter}" names no source path — give it a "label (path/to/file.ts)" form, or add ${family} to PATHLESS_EMITTER_FAMILIES with a reason`,
        });
      continue;
    }
    if (pathless[family] !== undefined)
      v.stalePathless.push({
        family,
        head,
        detail: `listed in PATHLESS_EMITTER_FAMILIES but its emitter now names ${declared.join(', ')} — delete the entry`,
      });

    // Read what actually resolved; a missing file is already tier-1 reported.
    let inCode = false;
    let inProse = false;
    for (const path of present) {
      let source: string;
      try {
        source = opts.readFile(path);
      } catch {
        continue;
      }
      if (stripComments(source).includes(head)) inCode = true;
      else if (source.includes(head)) inProse = true;
    }

    // ── the `exists` half ────────────────────────────────────────────────────
    if (!entry.exists) {
      if (inCode)
        v.staleExistsFalse.push({
          family,
          head,
          detail: `exists:false, but "${head}" is already emitted in ${present.join(', ')} — the Phase-2 addition landed; flip exists to true`,
        });
      continue;
    }

    // ── tier 2: attribution ──────────────────────────────────────────────────
    if (!inCode && !inProse) {
      v.unattributed.push({
        family,
        head,
        detail: `exists:true, but "${head}" appears NOWHERE in its declared emitter file(s) ${present.join(', ')} — find the real emit site (it is often a helper the declared file merely CALLS) and name it`,
      });
      continue;
    }

    // ── tier 3: prose-only must be a declared, non-stale exemption ───────────
    if (inCode) {
      if (dynamic[family] !== undefined)
        v.staleDynamic.push({
          family,
          head,
          detail: `listed in DYNAMIC_KEY_FAMILIES, but "${head}" is now static code in ${present.join(', ')} — delete the entry (the exemption is spent)`,
        });
    } else if (dynamic[family] === undefined) {
      v.undeclaredDynamic.push({
        family,
        head,
        detail: `"${head}" appears only in PROSE in ${present.join(', ')} — if the key is built at runtime, add ${family} to DYNAMIC_KEY_FAMILIES with the mechanism; prefer building it via buildKey() so no exemption is needed`,
      });
    }
  }

  v.violations = [
    ...v.missingPaths.map((f) => `[emitter path missing] ${f.family}: ${f.detail}`),
    ...v.unattributed.map((f) => `[emitter not attributed] ${f.family}: ${f.detail}`),
    ...v.undeclaredDynamic.map((f) => `[undeclared dynamic key] ${f.family}: ${f.detail}`),
    ...v.staleDynamic.map((f) => `[stale dynamic exemption] ${f.family}: ${f.detail}`),
    ...v.undeclaredPathless.map((f) => `[pathless emitter] ${f.family}: ${f.detail}`),
    ...v.stalePathless.map((f) => `[stale pathless exemption] ${f.family}: ${f.detail}`),
    ...v.staleExistsFalse.map((f) => `[stale exists:false] ${f.family}: ${f.detail}`),
  ];
  v.ok = v.violations.length === 0;
  return v;
}

/** Render a verdict as the assertion message — every finding names its own fix. */
export function formatEmitterPinVerdict(verdict: EmitterPinVerdict): string {
  if (verdict.ok) return '';
  return [
    `${verdict.violations.length} EVENT_CATALOG emitter/exists claim(s) no longer match the code:`,
    ...verdict.violations.map((line) => `  • ${line}`),
  ].join('\n');
}
