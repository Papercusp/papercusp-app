/**
 * compaction-usage.ts — best-effort per-session context-size estimator.
 * agent-managed-compaction-2026-07-01 (P-007 / P-009).
 *
 * Resolves a session's transcript from its coord ownerId (via adv_sessions) and
 * estimates current context tokens. Claude uses transcript bytes/4; Codex uses
 * the exact latest `token_count.info.last_token_usage.total_tokens` from its
 * rollout JSONL. Runs OFF the per-turn hot
 * path: the compaction-compliance watchdog calls it on a cadence and caches the
 * result on coord_presence.context_tokens; the inbox usage signal reads that cached
 * value. Degrades to null (never throws) when a transcript can't be resolved.
 *
 * OMP self-compacts natively and remains intentionally unmeasured here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findSessionTranscript, papercuspSessionClaudeBase, newestTranscriptUnderOwner } from './claude-sessions';
import { findCodexRolloutPath, findCodexRolloutPathByUuid } from './session-transcript-resolvers';
import { codexHomeForSessionKey } from '@papercusp/orchestrator/session-launch-dirs';
import { MODEL_WINDOW_1M, MODEL_WINDOW_DEFAULT } from './agent-config-constants';
import {
  analyzeClaudeResumeTranscript,
  CLAUDE_TOOL_REFERENCE_RECOVERY_TURNS,
} from './claude-resume-tool-references.mjs';

// P-016 fallback resolver — RELOCATED to claude-sessions.ts (2026-07-04, WI-2680) so
// the agents-roster live-thinking pane + stream share the SAME resume-rotation
// robustness. Re-exported here so existing importers (+ compaction-usage.test.ts) are
// unaffected; the estimate fallback below (estimateContextTokensForOwner) still calls it.
export { newestTranscriptUnderOwner };

export interface SessionRef {
  /** Backend: 'claude' | 'omp' | 'codex' | null (unknown → treated as claude). */
  agent: string | null;
  /** The backend session id (Claude UUID / OMP thread / codex rollout). */
  sessionId: string | null;
  /** `adv_sessions.started_at` as epoch ms when the row exposes it. Used only
   *  to reject a respawn event that predates a later DB row/rebind. */
  startedAtMs?: number | null;
  /** adv_sessions numeric key; Codex homes are keyed by this value rather than
   *  by the rollout UUID stored in sessionId. */
  sessionKey?: number | null;
  /**
   * Transcript isolation owner to use for the exact-id lookup. Undefined means
   * the coord owner is authoritative (the normal adv_sessions path); null means
   * the ref was recovered without a DB owner anchor and the exact native id must
   * be resolved across isolation roots once (then the positive path cache makes
   * later reads cheap). WI-41504: a Claude self-relaunch changed coord ownerId
   * without moving its native transcript out of the predecessor's isolation dir.
   */
  transcriptOwner?: string | null;
}

export interface CodexContextSnapshot {
  /** Current request context plus its just-produced output. */
  tokens: number;
  /** Codex's effective model window (272k × 95% = 258400 on gpt-5.6). */
  modelContextWindow: number | null;
}

/** One bounded tail read is enough: Codex writes a token_count event after each
 * model response, so the newest valid event is the authoritative current gauge.
 * A native compaction/reset is reflected by the next event's lower
 * last_token_usage; cumulative total_token_usage is deliberately ignored. */
const CODEX_TOKEN_TAIL_BYTES = 1024 * 1024;

export function codexContextSnapshotFromRollout(pathStr: string): CodexContextSnapshot | null {
  try {
    const size = fs.statSync(pathStr).size;
    const start = Math.max(0, size - CODEX_TOKEN_TAIL_BYTES);
    const fd = fs.openSync(pathStr, 'r');
    let text: string;
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // the bounded tail can begin mid-line
      }
      const evt = parsed as {
        type?: string;
        payload?: {
          type?: string;
          info?: {
            last_token_usage?: {
              input_tokens?: number;
              output_tokens?: number;
              total_tokens?: number;
            } | null;
            model_context_window?: number;
          } | null;
        };
      };
      if (evt.type !== 'event_msg' || evt.payload?.type !== 'token_count') continue;
      const usage = evt.payload.info?.last_token_usage;
      if (!usage) continue; // rate-limit-only update
      const total = Number(usage.total_tokens);
      const fallback = Number(usage.input_tokens ?? 0) + Number(usage.output_tokens ?? 0);
      const tokens = Number.isFinite(total) && total >= 0 ? total : fallback;
      if (!Number.isFinite(tokens) || tokens < 0) continue;
      const rawWindow = Number(evt.payload.info?.model_context_window);
      return {
        tokens: Math.floor(tokens),
        modelContextWindow: Number.isFinite(rawWindow) && rawWindow > 0 ? Math.floor(rawWindow) : null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export interface EstimateContextDeps {
  /** WI-2140943 seam: resolve the owner's session ref (default {@link resolveSessionRefReconciled}). */
  resolveRef?: (ownerId: string) => Promise<SessionRef | null>;
  /** WI-2140943 seam: the gateway's SERVED route for the owner (default {@link gatewayServedRouteForOwner}). */
  servedRoute?: (ownerId: string) => Promise<GatewayServedRoute | null>;
  findCodexRollout?: typeof findCodexRolloutPath;
  /** WI-42507 seam: resolve a rollout by its native session id under a given home. */
  findCodexRolloutByUuid?: typeof findCodexRolloutPathByUuid;
  /** WI-42507 seam: the owner's OTHER codex adv-session row ids, newest first. */
  codexSiblingSessionKeys?: (ownerId: string, exceptKey: number | string) => Promise<number[]>;
  /** WI-42507 seam: mtime of a resolved path (null ⇒ vanished / unreadable). */
  statMtimeMs?: (p: string) => number | null;
}

/**
 * A codex rollout is written as `rollout-<ts>-<nativeSessionId>.jsonl`, so the
 * trailing uuid IS the session the file belongs to. Extracting it is what lets a
 * resolved path be checked against the ref it was resolved FOR. Null when the name
 * does not parse (a test fixture, a renamed file); callers must treat null as
 * "cannot check", never as a mismatch.
 *
 * NOTE (EI-21595542328480968): this is deliberately a pure helper and is NOT wired
 * into {@link codexSnapshotForRef}. Gating the estimate on `rolloutSessionId !==
 * ref.sessionId` (even when additionally requiring the file to be >10min stale) was
 * MEASURED to null 16 of 134 live codex sessions, only ONE of which was the actual
 * pathology — the other 15 were healthy and comfortably UNDER their limit, so the
 * gate would have disarmed their compaction backstop to fix one session. Do not
 * re-add that gate here: an IDLE session legitimately has an old rollout and a ref
 * whose native id has churned past it, so mtime age alone cannot separate "idle"
 * from "reading a dead predecessor". The discriminator needs the session's own
 * liveness (`coord_presence.last_active_at`), which this module does not have and
 * the watchdog does.
 */
export function codexRolloutSessionId(rolloutPath: string): string | null {
  const base = rolloutPath.slice(rolloutPath.lastIndexOf('/') + 1);
  const m = /^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-([0-9a-f]{8}(?:-[0-9a-f]+)+)\.jsonl$/.exec(base);
  return m ? m[1] : null;
}

/** How many of the owner's OTHER codex adv rows the WI-42507 repair may search.
 *  Measured 2026-08-27: an affected owner had 2 rows. 6 is generous headroom and
 *  still bounds the miss path to a handful of home walks — a blanket scan is not
 *  an option (1302 codex homes existed on this box at the time). */
const CODEX_SIBLING_HOME_LIMIT = 6;

/** The owner's OTHER codex adv-session row ids, newest first. */
async function codexSiblingSessionKeysForOwner(ownerId: string, exceptKey: number | string): Promise<number[]> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const rows = await getOrgPg().sql<{ id: number }[]>`
      SELECT id
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ${ownerId}
         AND agent = 'codex'
         AND id <> ${Number(exceptKey)}
       ORDER BY started_at DESC
       LIMIT ${CODEX_SIBLING_HOME_LIMIT}
    `;
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

function statMtimeMsSync(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * WI-42507 — resolve the rollout to read for a codex ref, repairing the case where
 * the ref's adv ROW and the home its native session actually writes into have come
 * apart.
 *
 * Codex homes are keyed by the adv_sessions ROW id, which is only sound while the row
 * whose `session_id` names the live native session is also the row whose home that
 * session writes into. Measured 2026-08-27 on su-e602814a: row 19845 (the newest, so
 * the one {@link resolveSessionRef} picks) carried session_id `01a04287-…`, whose
 * rollout lives in row 19993's home; 19845's own home held nothing but frozen
 * 03:14–03:39 rollouts. Every home-keyed read for that owner therefore returned a dead
 * predecessor's file, the estimate could never fall, and the respawn-streak guard
 * suppressed both compaction rungs.
 *
 * THE INVARIANT, and why this is a repair rather than the gate that was measured and
 * rejected (see {@link codexRolloutSessionId}): this may only ever move the reading to
 * a rollout that is BOTH
 *   (a) provably the session's — its filename carries `ref.sessionId` — AND
 *   (b) strictly FRESHER than what the keyed home offered.
 * It never returns null, never suppresses an estimate, and never substitutes an older
 * file. (b) is the load-bearing half: without it, a ref naming a DEAD predecessor
 * whose rollout happens to sit in a sibling home would drag the reading BACK onto that
 * frozen file — reintroducing WI-38090's pathology by the other door. With it, the
 * keyed home's newest always wins a tie, so the normal carry-respawn case (where the
 * DB ref lags the live rollout inside one stable home) is untouched.
 *
 * The sibling search runs ONLY on the miss path — when the keyed home's newest rollout
 * does not belong to `ref.sessionId` — so the healthy majority pays one already-cached
 * filename parse and no extra I/O at all.
 */
export async function resolveCodexRolloutPathForRef(
  ref: SessionRef,
  ownerId: string | null | undefined,
  deps: EstimateContextDeps = {},
): Promise<string | null> {
  if (ref.sessionKey == null) return null;
  const keyed = await (deps.findCodexRollout ?? findCodexRolloutPath)(ref.sessionKey);
  // No ref session id ⇒ nothing to check against ⇒ the keyed answer stands (this is
  // the documented normal state for a codex row, not an anomaly).
  if (!ref.sessionId || !ownerId) return keyed;
  // The keyed home already holds the session the ref names: the common healthy path.
  if (keyed && codexRolloutSessionId(keyed) === ref.sessionId) return keyed;

  const statMtime = deps.statMtimeMs ?? statMtimeMsSync;
  const keyedMtime = keyed ? statMtime(keyed) : null;
  const byUuid = deps.findCodexRolloutByUuid ?? findCodexRolloutPathByUuid;
  const siblingKeys = await (deps.codexSiblingSessionKeys ?? codexSiblingSessionKeysForOwner)(
    ownerId,
    ref.sessionKey,
  );
  for (const key of siblingKeys) {
    let candidate: string | null = null;
    try {
      candidate = await byUuid(ref.sessionId, { homeOverride: codexHomeForSessionKey(key) });
    } catch {
      continue;
    }
    if (!candidate) continue;
    const candidateMtime = statMtime(candidate);
    if (candidateMtime == null) continue;
    if (keyedMtime == null) {
      // Nothing to compare against: the keyed home has no rollout at all. Adopting a
      // FROZEN sibling here would be worse than the null it replaces — null degrades to
      // the watchdog's dark-telemetry grace, whereas a frozen number is the very input
      // that drives the respawn-streak suppression. So apply the same freshness floor
      // P-016 already uses for exactly this "is it live or is it a dead predecessor"
      // call ({@link fallbackTranscriptFresh}).
      if (Date.now() - candidateMtime <= FALLBACK_TRANSCRIPT_FRESH_MS) return candidate;
      continue;
    }
    // (b): strictly fresher only. A tie or an older file keeps the keyed answer.
    if (candidateMtime > keyedMtime) return candidate;
  }
  return keyed;
}

/** Where a codex owner's context reading actually CAME FROM — the rollout file that
 *  was read, when it was last written, and whether it belongs to the session the ref
 *  names. Pure observation: it applies no gate and never suppresses an estimate, so
 *  reading it can never disarm anyone. The judgement is the CALLER's, and only the
 *  compaction watchdog has the extra input (`coord_presence.last_active_at`) that
 *  makes one safe — see {@link codexRolloutSessionId}. */
export interface CodexReadingProvenance {
  /** The rollout jsonl the estimate was read from. */
  rolloutPath: string;
  /** Its mtime, or null when it vanished between resolution and stat. */
  rolloutMtimeMs: number | null;
  /** Native session id parsed from the FILENAME; null ⇒ unparseable ⇒ "cannot check". */
  rolloutSessionId: string | null;
  /** Native session id the ref resolved to. */
  refSessionId: string | null;
}

/**
 * Report the provenance of the codex reading for `ownerId` (null for non-codex, an
 * unresolvable ref, or no rollout). Deliberately separate from
 * {@link estimateContextTokensForOwner}: the estimate stays a number, and any
 * trust decision is made by a caller that can see the session's own liveness.
 */
export async function codexReadingProvenanceForOwner(
  ownerId: string,
  deps: EstimateContextDeps = {},
): Promise<CodexReadingProvenance | null> {
  try {
    const ref = await resolveSessionRefReconciled(ownerId);
    if (!ref || ref.agent !== 'codex' || ref.sessionKey == null) return null;
    const rolloutPath = await resolveCodexRolloutPathForRef(ref, ownerId, deps);
    if (!rolloutPath) return null;
    let rolloutMtimeMs: number | null = null;
    try {
      rolloutMtimeMs = fs.statSync(rolloutPath).mtimeMs;
    } catch {
      rolloutMtimeMs = null;
    }
    return {
      rolloutPath,
      rolloutMtimeMs,
      rolloutSessionId: codexRolloutSessionId(rolloutPath),
      refSessionId: ref.sessionId ?? null,
    };
  } catch {
    return null;
  }
}

async function codexSnapshotForRef(
  ref: SessionRef,
  ownerId?: string | null,
  deps: EstimateContextDeps = {},
): Promise<CodexContextSnapshot | null> {
  if (ref.agent !== 'codex' || ref.sessionKey == null) return null;
  try {
    const rollout = await resolveCodexRolloutPathForRef(ref, ownerId, deps);
    return rollout ? codexContextSnapshotFromRollout(rollout) : null;
  } catch {
    return null;
  }
}

/** The raw JSONL key Claude writes on a compaction-summary entry. Text that
 *  merely MENTIONS the key inside a string is escaped (\"isCompactSummary\"),
 *  so matching the raw byte form is unambiguous (EI-6410). Exported (WI-4958)
 *  so the session-audit digest's native-compaction transcript scan counts the
 *  SAME marker this file's own boundary-scan logic anchors on, instead of a
 *  second hand-copied literal that could drift out of sync. */
export const COMPACT_BOUNDARY_MARKER = '"isCompactSummary":true';
/** Bound the backward boundary scan. Not-found within the cap ⇒ ≥cap bytes
 *  since any compaction ⇒ the estimate is over every real limit anyway. */
const BOUNDARY_SCAN_CAP = 8 * 1024 * 1024;
/** Files below this skip the scan entirely: at bytes/4 a stat-only file caps at
 *  ~64k tokens, below every force threshold (the smallest is ~190k on a 200k
 *  window), so the fast path can never false-force. Was 1MB — a sub-1MB
 *  screenshot-carrying transcript could stat-read ~250k and trip a 200k-window
 *  force (WI-3176). */
const BOUNDARY_SCAN_MIN = 256 * 1024;

/** WI-3176 image discount: a screenshot in the transcript JSONL is 100–1000× its
 *  real context cost — a 1920×1080 PNG is ~1.3MB of base64 (→ ~325k "tokens" at
 *  bytes/4) but bills the model ≤~1600 tokens (vision pricing caps at the
 *  downscale bound), AND Claude Code writes the payload TWICE per read (the
 *  content block's `"data":"…"` + the toolUseResult's `"base64":"…"`, the latter
 *  never entering context at all). A screenshot-heavy E2E session read ~1948k on
 *  a real ~300k context and got force-compacted on it. Count each key-anchored
 *  long base64 run as one image at the cap instead. Anchoring on the two JSON
 *  keys (not bare runs) keeps ordinary long alphanumeric content — hex dumps,
 *  minified code — counted at full weight. */
const IMAGE_PAYLOAD_RE = /"(?:data|base64)":"[A-Za-z0-9+/=]{8192,}"/g;
/** Claude's per-image billing cap (≥1568px images are downscaled to ~1600 tok). */
const IMAGE_TOKEN_COST = 1600;

/** EI-12848 (the TEXT analogue of WI-3176's image double-write): Claude Code writes
 *  each tool_result's payload into the transcript line TWICE — once in the in-context
 *  `message.content` tool_result block, and again in the top-level `toolUseResult`
 *  bookkeeping field. Only `message.content` is sent to the model; `toolUseResult`
 *  is CC's local replay/re-render copy and NEVER enters context (same "latter never
 *  entering context at all" note as the image `"base64"` copy). It is ~20% of a
 *  tool-heavy transcript, so counting it at bytes/4 roughly DOUBLE-counts every tool
 *  result: a fresh fleet member reads 111% of its soft limit right after a ToolSearch
 *  schema preload — before any real work — and compact-loops forever on the immovable
 *  duplicate. The field is always emitted AFTER `message` on the line (verified across
 *  live transcripts), followed only by more non-context metadata (uuid/session_id/
 *  cwd/…), so every byte from the top-level `,"toolUseResult":` key to end-of-line is
 *  out-of-context. The comma anchor (a top-level key is always comma-preceded — the
 *  first key is parentUuid) fails SAFE: a nested/escaped `\"toolUseResult\"` mention
 *  inside message.content the session merely READ never matches (the WI-4608
 *  false-positive class), and an unmatched top-level key just leaves the (safe)
 *  over-count rather than risking an under-count that would cause a real context death. */
const TOOL_USE_RESULT_KEY = ',"toolUseResult":';

/** EI-23747373965813124 (the WHOLE-LINE analogue of WI-3176 / EI-12848): Claude Code
 *  writes a `"type":"prompt_snapshot"` JSONL line per turn holding the ENTIRE assembled
 *  prompt. Every token in it is already counted by the ordinary message lines it
 *  snapshots, so at bytes/4 it double-counts the whole context once per turn — and
 *  because it scales with SYSTEM-PROMPT size rather than with work done, the inflation
 *  is a FIXED per-turn constant. Measured on a live su transcript: 3 snapshots =
 *  1,890,243 of 2,350,316 bytes (80.4% of the file), driving gauge deltas of +213,592
 *  and +214,759 tokens across two consecutive turns whose real payloads were ~5KB and
 *  ~180KB respectively — near-identical jumps, i.e. not content-proportional at all. A
 *  session at a real ~115k read 578,187 (231% of a 250k limit) and was force-compacted
 *  twice on the fabricated number. Unlike toolUseResult this is not a trailing key but
 *  a whole out-of-context LINE, so the entire line is discounted. Matching the raw byte
 *  form is unambiguous for the same reason as COMPACT_BOUNDARY_MARKER (EI-6410): a line
 *  that merely MENTIONS the key inside string content carries it escaped
 *  (\"type\":\"prompt_snapshot\") and cannot match. */
const PROMPT_SNAPSHOT_MARKER = '"type":"prompt_snapshot"';

/**
 * Byte ranges `[start, end)` of the COMPLETE prompt_snapshot lines in `visible`.
 * Complete-only (both delimiters settled inside the slice) mirrors
 * `toolUseResultExcessIn`: a line clipped by the boundary-scan cap keeps full weight
 * so the estimate errs toward over-counting, never under.
 */
function promptSnapshotRangesIn(visible: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const hit = visible.indexOf(PROMPT_SNAPSHOT_MARKER, from);
    if (hit === -1) break;
    const start = visible.lastIndexOf('\n', hit) + 1; // 0 when the slice starts mid-file
    const nl = visible.indexOf('\n', hit);
    if (nl === -1) break; // trailing partial line — leave it at full weight
    from = nl + 1;
    // Several markers on one line must discount that line exactly once.
    const prev = ranges[ranges.length - 1];
    if (prev && prev[0] === start) continue;
    ranges.push([start, nl]);
  }
  return ranges;
}

/**
 * Sum the out-of-context `toolUseResult` byte excess over a settled latin1 slice
 * (complete lines only — each matched key's end-of-line newline must lie within
 * `visible`). Image-payload bytes inside a toolUseResult region are SUBTRACTED here
 * so they stay accounted for solely by the image path (IMAGE_PAYLOAD_RE) — no
 * double-discount, and the existing image handling is left byte-identical.
 */
function toolUseResultExcessIn(visible: string, skip?: (i: number) => boolean): number {
  let excess = 0;
  let from = 0;
  for (;;) {
    const key = visible.indexOf(TOOL_USE_RESULT_KEY, from);
    if (key === -1) break;
    // EI-23747373965813124: a hit inside a prompt_snapshot line is already discounted
    // with that whole line; discounting it again would UNDER-count.
    if (skip?.(key)) {
      const skipNl = visible.indexOf('\n', key);
      if (skipNl === -1) break;
      from = skipNl + 1;
      continue;
    }
    const start = key + 1; // discount from the key's opening quote (drop the separator comma)
    const nl = visible.indexOf('\n', start);
    const end = nl === -1 ? visible.length : nl;
    let region = end - start;
    // Exclude image runs inside the region — the image path already discounts them.
    const seg = visible.slice(start, end);
    for (const m of seg.matchAll(IMAGE_PAYLOAD_RE)) region -= m[0].length;
    excess += Math.max(0, region);
    from = end;
  }
  return excess;
}

/**
 * tokens ≈ (bytes SINCE THE LAST COMPACTION − base64-image excess −
 * toolUseResult double-write) / 4.
 * EI-6410: the transcript JSONL accumulates across compactions, so whole-file/4
 * is monotonic and reads a compacted session at 150–250%+ of its limit forever —
 * false over-limit warnings and compact-loops. WI-3176: base64 image payloads
 * are counted at their real ~1600-token cost, not byte-weight. EI-12848: the
 * top-level `toolUseResult` field duplicates the in-context tool_result block but
 * never enters context — discount it (see toolUseResultExcessIn). Small files stay
 * stat-only; larger ones scan a bounded tail for the last compaction-summary
 * entry and count from there.
 */
export function tokensFromFileSize(pathStr: string): number | null {
  try {
    const size = fs.statSync(pathStr).size;
    if (size < BOUNDARY_SCAN_MIN) return Math.floor(size / 4);
    const start = Math.max(0, size - BOUNDARY_SCAN_CAP);
    const fd = fs.openSync(pathStr, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const idx = buf.lastIndexOf(COMPACT_BOUNDARY_MARKER);
      // EI-10434: idx===-1 means "no marker in the SCANNED window [start, size)",
      // not "no marker in the whole file" — for a file bigger than
      // BOUNDARY_SCAN_CAP, a marker further back than the cap is invisible to
      // this scan and was NEVER refuted. Bounding at buf.length (== size − start,
      // itself capped at BOUNDARY_SCAN_CAP) preserves the intended "≥cap bytes
      // since any compaction ⇒ over every real limit anyway" conservative-but-
      // BOUNDED reading. Using the raw `size` instead (the pre-fix behavior) is
      // UNBOUNDED and grows with every byte appended to the transcript for the
      // rest of the session's life, even while genuine periodic compactions keep
      // real usage near zero — the exact "cumulative total misread as current
      // usage" signature (20.9M/21.17M/24.3M-token garbage readings, monotonically
      // growing across a whole day). For a file ≤ BOUNDARY_SCAN_CAP (start===0,
      // the whole file was scanned), buf.length === size, so this is byte-
      // identical to the old behavior in that case — only the >cap case changes.
      const sinceBytes = idx === -1 ? buf.length : buf.length - idx;
      // Discount image payloads visible in the since-compaction region. latin1
      // keeps string length == byte length (base64 is ASCII; surrounding
      // multibyte content must not skew the byte math). When the marker fell
      // outside the scan cap, only the buffered tail is discountable — the
      // unseen head keeps full weight (estimate stays conservative).
      const visible = buf.toString('latin1', idx === -1 ? 0 : idx);
      // EI-23747373965813124: discount whole prompt_snapshot lines, and exclude them
      // from the image/toolUseResult scans so no byte is discounted twice — a double
      // discount UNDER-counts, the one direction that risks a real context death.
      const snapRanges = promptSnapshotRangesIn(visible);
      let snapshotExcess = 0;
      for (const [s, e] of snapRanges) snapshotExcess += e - s;
      const inSnapshot = (i: number) => snapRanges.some(([s, e]) => i >= s && i < e);
      let imageExcess = 0;
      for (const m of visible.matchAll(IMAGE_PAYLOAD_RE)) {
        if (inSnapshot(m.index ?? 0)) continue;
        imageExcess += m[0].length - IMAGE_TOKEN_COST * 4;
      }
      // EI-12848: also drop the out-of-context toolUseResult double-write.
      const tureExcess = toolUseResultExcessIn(visible, snapRanges.length ? inSnapshot : undefined);
      return Math.max(
        0,
        Math.floor((sinceBytes - imageExcess - tureExcess - snapshotExcess) / 4),
      );
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Estimate a session's current context tokens from a resolved SessionRef.
 * Claude (+ unknown) → transcript bytes/4; Codex → exact rollout token_count;
 * OMP → null by design.
 */
export async function estimateContextTokens(
  ref: SessionRef,
  owner?: string | null,
  deps: EstimateContextDeps = {},
): Promise<number | null> {
  if (ref.agent === 'omp') return null;
  if (ref.agent === 'codex') return (await codexSnapshotForRef(ref, owner, deps))?.tokens ?? null;
  if (!ref.sessionId) return null;
  try {
    // Pass the coord `owner` hint: an interactive/spawned session's transcript lives under
    // ~/.papercusp/session-claude/<owner>/projects, so the hint takes findSessionTranscript's
    // FAST PATH (one owner-root readdir) instead of the full 12k-owner-dir sweep. Without it,
    // the compaction watchdog polling many owners on a cadence re-swept every isolation root
    // per call — the fs-churn that bloated the background host to tens of GB.
    const transcriptOwner = ref.transcriptOwner === undefined ? owner ?? null : ref.transcriptOwner;
    const p = await findSessionTranscript(ref.sessionId, { owner: transcriptOwner });
    return p ? tokensFromFileSize(p) : null;
  } catch {
    return null;
  }
}

/** Resolve a session's backend reference from its coord ownerId via adv_sessions.
 * Codex rows intentionally may not carry `session_id`: their rollout lookup is
 * keyed by the adv-session numeric id, so excluding null native ids makes the
 * entire Codex telemetry path dark. */
export async function resolveSessionRef(ownerId: string): Promise<SessionRef | null> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const rows = await getOrgPg().sql<{
      id: number;
      agent: string | null;
      session_id: string | null;
      started_at?: unknown;
    }[]>`
      SELECT id, agent, session_id, started_at
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ${ownerId}
         AND (session_id IS NOT NULL OR agent = 'codex')
       ORDER BY started_at DESC
       LIMIT 1
    `;
    if (!rows.length) return null;
    const rawStartedAt = rows[0].started_at;
    const startedAtMs =
      rawStartedAt instanceof Date
        ? rawStartedAt.getTime()
        : typeof rawStartedAt === 'number'
          ? rawStartedAt
          : typeof rawStartedAt === 'string'
            ? Date.parse(rawStartedAt)
            : NaN;
    return {
      agent: rows[0].agent,
      sessionId: rows[0].session_id,
      sessionKey: rows[0].id,
      ...(Number.isFinite(startedAtMs) ? { startedAtMs } : {}),
    };
  } catch {
    return null;
  }
}

/** How recently the P-016 fallback transcript must have been WRITTEN to be
 *  trusted as the live session's. The two cases the fallback must separate:
 *  a stale/rotated session_id with the live session appending to a
 *  differently-named file (P-016's target — that file's mtime is seconds old),
 *  versus a just-respawned successor with NO transcript yet, where the newest
 *  file under the owner root is the DEAD PREDECESSOR'S — frozen at kill time.
 *  Reading the latter re-reports the predecessor's over-limit size against the
 *  near-empty successor and re-kills it at every grace expiry (the 2026-07-18
 *  idle-successor leg of the WI-5075 kill loop). 10 min ≫ the watchdog cadence
 *  and any single write gap of a session actively filling its context; a file
 *  older than that cannot be the "live session about to overflow" P-016 exists
 *  to catch. */
const FALLBACK_TRANSCRIPT_FRESH_MS = 10 * 60_000;

/** Exported for tests: the P-016 fallback freshness gate. */
export function fallbackTranscriptFresh(p: string, nowMs = Date.now()): boolean {
  try {
    return nowMs - fs.statSync(p).mtimeMs <= FALLBACK_TRANSCRIPT_FRESH_MS;
  } catch {
    return false;
  }
}

/**
 * Best-effort context-token estimate for a session by its coord ownerId.
 *
 * Primary: resolve the recorded session_id → its `<sessionId>.jsonl`. Fallback
 * (P-016): if that misses for a Claude session (stale/rotated session_id), use the
 * newest RECENTLY-WRITTEN jsonl under the owner root so a live session is never left
 * with a null estimate — the null that silently hid the per-turn compaction reminder
 * and let the 2026-07-04 cohort drift to 836k. The freshness gate
 * ({@link fallbackTranscriptFresh}) keeps the fallback from pinning a fresh
 * carry-respawn successor to its dead predecessor's frozen transcript (an idle
 * successor has no jsonl until its first turn); a genuinely-missing estimate
 * degrades to null, which the watchdog's dark-telemetry grace handles without a
 * cut. OMP keeps the null-by-design gate. Codex resolves its per-session rollout
 * through the adv-session key. Cohorts whose
 * transcript lives outside the owner root entirely are covered by the mechanical
 * `autoCompactWindow` cap (P-014), not this estimate.
 */
export async function estimateContextTokensForOwner(
  ownerId: string,
  deps: EstimateContextDeps = {},
): Promise<number | null> {
  const ref = await (deps.resolveRef ?? resolveSessionRefReconciled)(ownerId);
  if (!ref) return null;
  const primary = await estimateContextTokens(ref, ownerId, deps);
  // WI-2140943 lane 2: the gateway read the EXACT context size off the last `message_start`
  // (input + cache_read + cache_creation). bytes/4 under-reads real usage by ~28% on code-heavy
  // transcripts (da701a71: 720KB ⇒ ~180k estimated vs 248,703 real), which is the margin between
  // "under the limit" and "Prompt is too long". Within ONE native session context only grows, so the
  // exact reading is a floor and the larger of the two is the safe estimate. Bound to the native
  // session id: a carry-respawn successor (same owner, new id) never inherits its predecessor's 248k.
  const served = await servedRouteBoundToRef(ownerId, ref, deps);
  rememberObservedPromptFloor(ownerId, served);
  const exact = served?.usage?.inputTotal;
  if (exact != null && exact > 0) return Math.max(exact, primary ?? 0);
  if (primary != null) return primary;
  if (ref.agent === 'omp' || ref.agent === 'codex') return null;
  const alt = newestTranscriptUnderOwner(ownerId);
  if (!alt || !fallbackTranscriptFresh(alt)) return null;
  return tokensFromFileSize(alt);
}

/** Exact effective window of the session's CURRENT model: for Codex the rollout's
 * reported window; for Claude the window of the model the gateway actually SERVED
 * last (`model` + whether the 1M beta was forwarded), bound to the same native
 * session. Null for OMP, before the first turn, or when the gateway has no route
 * for this native session — the caller then falls back to the launch-spec window.
 *
 * Why the served model and not the launch spec (WI-2140943 lane 2, 2026-09-02):
 * a CLI launched on `claude-fable-5-1[1m]` silently re-requested a bare
 * `claude-opus-5` after one 429 — a 1M→200k window drop no spec anywhere in
 * papercusp recorded — and then the gateway's WI-1073 rung downgraded that to
 * sonnet. The watchdog kept reading the 248,703-token session as "under a 400k
 * limit" while every request died. The served route is the only place the real
 * window is known. */
export async function estimateContextWindowForOwner(
  ownerId: string,
  deps: EstimateContextDeps = {},
): Promise<number | null> {
  const ref = await (deps.resolveRef ?? resolveSessionRefReconciled)(ownerId);
  if (!ref) return null;
  if (ref.agent === 'codex') return (await codexSnapshotForRef(ref, ownerId, deps))?.modelContextWindow ?? null;
  if (ref.agent === 'omp') return null;
  const served = await servedRouteBoundToRef(ownerId, ref, deps);
  return servedWindowForRoute(served);
}

/** The inference gateway's SERVED route for one owner — GET `/admin/route?owner=` (gateway.ts). */
export interface GatewayServedRoute {
  account: string | null;
  /** The model as FORWARDED upstream (after `[1m]` normalization and any last-resort downgrade). */
  model: string | null;
  /** Whether the forwarded request carried the 1M-context beta. Null ⇒ pre-upgrade gateway. */
  context1m: boolean | null;
  /** The caller's native session id (from the CLI's `metadata.user_id`); null for non-CLI callers. */
  nativeSessionId: string | null;
  /** Exact input usage from the last `message_start` plus the session's lowest observed total. */
  usage: {
    inputTotal: number;
    /** Smallest exact input total observed for this native session; null on a pre-upgrade gateway. */
    observedInputFloor?: number | null;
    /** Number of exact samples contributing to observedInputFloor; null on a pre-upgrade gateway. */
    observations?: number | null;
    at: number;
  } | null;
  at: number | null;
}

/** Prompt-floor evidence cached by the existing compaction estimator for the gauge writer. */
export interface ObservedPromptFloor {
  tokens: number;
  observations: number;
  at: number;
}

const OBSERVED_PROMPT_FLOOR_STALE_MS = 6 * 60_000;
const observedPromptFloors = new Map<string, ObservedPromptFloor>();

/**
 * Cache the route-bound measurement only after native-session validation. The value
 * is an observed TOTAL-prompt floor, not an exact decomposition of the fixed prefix.
 */
function rememberObservedPromptFloor(ownerId: string, route: GatewayServedRoute | null): void {
  const usage = route?.usage;
  if (
    usage?.observedInputFloor == null ||
    usage.observations == null ||
    !Number.isFinite(usage.observedInputFloor) ||
    usage.observedInputFloor < 0 ||
    !Number.isInteger(usage.observations) ||
    usage.observations < 1
  ) return;
  observedPromptFloors.set(ownerId, {
    tokens: Math.floor(usage.observedInputFloor),
    observations: usage.observations,
    at: usage.at,
  });
}

/** Sync read for the watchdog immediately after its ordinary context estimate. */
export function observedPromptFloorForOwner(
  ownerId: string,
  now: number = Date.now(),
): ObservedPromptFloor | null {
  const value = observedPromptFloors.get(ownerId);
  if (!value) return null;
  if (now - value.at > OBSERVED_PROMPT_FLOOR_STALE_MS) {
    observedPromptFloors.delete(ownerId);
    return null;
  }
  return { ...value };
}

function gatewayPortForRouteRead(): number {
  const p = Number(process.env.PAPERCUSP_GATEWAY_PORT);
  return Number.isFinite(p) && p > 0 ? p : 8788;
}

/** Read the gateway's served route for `ownerId`. Null on any failure (gateway down, no
 *  route, malformed) — every caller treats null as "unknown", never as "no usage". */
export async function gatewayServedRouteForOwner(
  ownerId: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<GatewayServedRoute | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(
      `http://127.0.0.1:${gatewayPortForRouteRead()}/admin/route?owner=${encodeURIComponent(ownerId)}`,
      { signal: AbortSignal.timeout(opts.timeoutMs ?? 1500) },
    );
    if (!res.ok) return null;
    const j = (await res.json()) as Partial<GatewayServedRoute> & { ok?: boolean };
    if (!j || j.ok !== true || typeof j.model !== 'string') return null;
    const usage =
      j.usage && typeof j.usage.inputTotal === 'number' && Number.isFinite(j.usage.inputTotal)
        ? {
            inputTotal: j.usage.inputTotal,
            observedInputFloor:
              typeof j.usage.observedInputFloor === 'number' &&
              Number.isFinite(j.usage.observedInputFloor) &&
              j.usage.observedInputFloor >= 0 &&
              j.usage.observedInputFloor <= j.usage.inputTotal
                ? j.usage.observedInputFloor
                : null,
            observations:
              typeof j.usage.observations === 'number' &&
              Number.isInteger(j.usage.observations) &&
              j.usage.observations > 0
                ? j.usage.observations
                : null,
            at: typeof j.usage.at === 'number' ? j.usage.at : 0,
          }
        : null;
    return {
      account: typeof j.account === 'string' ? j.account : null,
      model: j.model,
      context1m: typeof j.context1m === 'boolean' ? j.context1m : null,
      nativeSessionId: typeof j.nativeSessionId === 'string' ? j.nativeSessionId : null,
      usage,
      at: typeof j.at === 'number' ? j.at : null,
    };
  } catch {
    return null;
  }
}

/**
 * Narrow reader for consumers that need serving-account provenance but not the
 * context/usage fields. Keeping the route request in one helper preserves the
 * gateway's nullable/timeout semantics and gives native-session adapters an
 * injectable test seam.
 */
export async function gatewayServedAccountForOwner(
  ownerId: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  return (await gatewayServedRouteForOwner(ownerId, opts))?.account ?? null;
}

/** The served route ONLY when it is bound to the ref's own native session — the binding is
 *  what keeps a successor from inheriting a predecessor's window/usage (same owner id). A
 *  route without a native id (pre-upgrade gateway, non-CLI caller) is not trusted for either. */
async function servedRouteBoundToRef(
  ownerId: string,
  ref: SessionRef,
  deps: EstimateContextDeps,
): Promise<GatewayServedRoute | null> {
  if (ref.agent !== 'claude' || !ref.sessionId) return null;
  const served = await (deps.servedRoute ?? gatewayServedRouteForOwner)(ownerId);
  if (!served?.nativeSessionId) return null;
  return served.nativeSessionId.toLowerCase() === ref.sessionId.toLowerCase() ? served : null;
}

/** The hard window of a served route: 1M when the beta was forwarded, else the 200k default.
 *  Null when the route is unknown or its gateway predates the `context1m` field (never guess). */
export function servedWindowForRoute(route: GatewayServedRoute | null | undefined): number | null {
  if (!route?.model || route.context1m == null) return null;
  return route.context1m ? MODEL_WINDOW_1M : MODEL_WINDOW_DEFAULT;
}

/**
 * {@link resolveSessionRef}, but with the DB's native-session ref RECONCILED
 * against the host's own respawn log before it is trusted (WI-5075 rung 3).
 *
 * `adv_sessions.session_id` is re-anchored by a report the psu host POSTs after
 * each carry-respawn. A host running pre-2026-07-18-16:46 launcher code never
 * sends it, so the row keeps naming the DEAD predecessor. Estimating through
 * that ref reads the predecessor's frozen, over-limit transcript as the
 * near-empty successor's usage — and the watchdog cuts the live successor at
 * every grace expiry, forever. Rungs 1–2 (the launcher report; the P-016
 * fallback freshness gate) cannot reach this case: rung 1 needs a NEW host
 * process, and rung 2 only guards the fallback, which a resolvable-but-stale
 * primary never reaches.
 *
 * So: when the host log names a DIFFERENT (newer) native id than the DB, the DB
 * ref is provably a predecessor — prefer the host's. A successor that has not
 * yet written its first turn then estimates null, which the watchdog's
 * dark-telemetry grace absorbs WITHOUT a cut — the correct reading for a
 * near-empty session, and the loop cannot start.
 *
 * Host-log-silent owners (no psu host, never respawned, unreadable dir) keep the
 * DB ref unchanged, so non-psu and never-respawned cohorts are untouched.
 */
/** Injectable seams for {@link resolveSessionRefReconciled} — real defaults in
 *  prod, overridden in tests so the rung ordering is verifiable without a DB/FS. */
export interface ResolveReconciledDeps {
  resolveRef?: (ownerId: string) => Promise<SessionRef | null>;
  latestRespawn?: (ownerId: string, opts?: { allowWithoutHost?: boolean }) => string | null;
  /** Timestamped form of the host respawn read. When supplied it supersedes
   *  `latestRespawn`; the legacy id-only seam remains for existing callers/tests. */
  latestRespawnInfo?: (
    ownerId: string,
    opts?: { allowWithoutHost?: boolean },
  ) => { nativeId: string; atMs: number } | null;
  newestTranscript?: (ownerId: string) => string | null;
  isFresh?: (p: string) => boolean;
}

export async function resolveSessionRefReconciled(
  ownerId: string,
  deps: ResolveReconciledDeps = {},
): Promise<SessionRef | null> {
  const resolveRef = deps.resolveRef ?? resolveSessionRef;
  const newestTranscript = deps.newestTranscript ?? newestTranscriptUnderOwner;
  const isFresh = deps.isFresh ?? fallbackTranscriptFresh;

  const ref = await resolveRef(ownerId);
  // The rotation is a claude-only concept (--session-id); never touch omp/codex.
  if (ref?.agent === 'omp' || ref?.agent === 'codex') return ref;

  // Rung 3: a respawn LOGGED since the current host started names the successor
  // authoritatively — the host log knows about a just-happened carry-respawn even
  // before the successor has written its first transcript byte, so an idle
  // successor is never mis-pinned to its dead predecessor. When it names a NEWER
  // id, trust it (and skip rung 4, which could otherwise re-pin to the frozen
  // predecessor whose transcript is still the newest on disk for a few seconds).
  try {
    const hostRespawn = deps.latestRespawnInfo
      ? deps.latestRespawnInfo(ownerId, { allowWithoutHost: !ref })
      : deps.latestRespawn
        ? (() => {
            const nativeId = deps.latestRespawn!(ownerId, { allowWithoutHost: !ref });
            return nativeId ? { nativeId, atMs: null } : null;
          })()
        : await (async () => {
            const { latestRespawnNativeSession } = await import('./events/await/psu-pty-discovery');
            return latestRespawnNativeSession(ownerId, undefined, { allowWithoutHost: !ref });
          })();
    const respawnNewerThanRef =
      hostRespawn?.atMs == null ||
      ref?.startedAtMs == null ||
      hostRespawn.atMs > ref.startedAtMs;
    if (hostRespawn?.nativeId && hostRespawn.nativeId !== ref?.sessionId && respawnNewerThanRef) {
      return ref
        ? { ...ref, sessionId: hostRespawn.nativeId }
        : { agent: 'claude', sessionId: hostRespawn.nativeId, sessionKey: null, transcriptOwner: null };
    }
  } catch {
    /* fall through to rung 4 */
  }

  // Rung 4 (WI-5644 / the WI-5075 rung-3 gap): the respawn log ALSO goes stale
  // when a session acquires a NEW native transcript via a path that emits NO
  // `respawned` event — a service-restart relaunch (the papercup-dev-api bounce
  // that reaps+relaunches the headless child, EI-9748), a fork, or a fresh launch
  // reusing the adv row. latestRespawnNativeId then returns null / an equal id and
  // the DB ref keeps naming a dead predecessor, whose resolvable-but-frozen
  // transcript estimateContextTokens reads as the live session's usage → the P-018
  // kill loop, STILL LIVE for these unlogged transitions (2026-07-20 su-8e9c1164:
  // adv_sessions + respawn log both froze at an early id while three later
  // transcripts were written unlogged). The isolation dir's newest ACTIVELY-
  // WRITTEN transcript is the ground truth for the current native session
  // regardless of transition path — the same source the P-016 estimate fallback
  // trusts. Prefer it when it is FRESH (a stale/frozen newest is a dead
  // predecessor an idle successor must NOT be pinned to; rung 3 above already
  // covers the just-respawned case) and names a different id than the DB ref.
  try {
    const newest = newestTranscript(ownerId);
    if (newest && isFresh(newest)) {
      const id = path.basename(newest, '.jsonl');
      if (id && id !== ref?.sessionId) {
        return ref
          ? { ...ref, sessionId: id }
          : { agent: 'claude', sessionId: id, sessionKey: null, transcriptOwner: ownerId };
      }
    }
  } catch {
    /* fall through */
  }

  return ref;
}

/* ── WI-4154: anchored incremental reads — right the first time ─────────────
 *
 * The watchdog-cached estimate (coord_presence.context_tokens + the in-process
 * mirror) went stale ACROSS A COMPACTION BOUNDARY: nothing invalidated it when a
 * compaction landed, so for up to one ~2-min sweep every post-compaction render
 * served the PRE-compaction number — false LOUD/CRITICAL alarms at exactly the
 * compact-decision moment (two sessions burned pointless compactions on 126%/87%
 * readings whose real usage was 14–15%). Owner directive: don't re-verify a
 * possibly-wrong cache — make every rendered value RIGHT THE FIRST TIME.
 *
 * So render paths no longer read a point-in-time token cache. Each owner gets a
 * tiny ANCHOR — {countStart (last compaction-marker offset), imageExcess,
 * tureExcess (out-of-context toolUseResult double-write), settled (last
 * complete-line offset), sizeSeen} — and every read stats the transcript and
 * scans ONLY the bytes appended since the last read, updating the anchor as
 * markers/images/toolUseResult fields stream past. The returned value equals the full
 * tail-scan estimate at the current file size, at per-read cost proportional to
 * the append delta (typically KBs) instead of an 8MB tail scan. A compaction is
 * reflected the moment its summary line hits the transcript — no event, no TTL,
 * no verification pass.
 *
 * Only COMPLETE lines settle into the anchor (JSONL lines are the atomic unit;
 * a marker or base64 image run never spans lines), so a partially-flushed line
 * is counted raw once and re-scanned when its newline lands — never split
 * across scans where a marker/image match could be missed. Anchors are
 * per-process (each :3070 cluster worker / bg-host keeps its own) — purely a
 * cost optimization, never a correctness dependency. */

const NEWLINE = 0x0a;

/** A sync caller (the P-013 result annotator, a sync dispatch hot path) reads at
 *  most this much delta per call; a bigger backlog defers to a background
 *  (re)seed and the caller renders nothing rather than block the event loop. */
const SYNC_DELTA_CAP = 1024 * 1024;

interface TranscriptAnchor {
  path: string;
  /** Absolute offset where token counting starts (last seen marker start, or 0). */
  countStart: number;
  /** Image-payload byte excess accumulated over settled bytes in [countStart, settled). */
  imageExcess: number;
  /** EI-12848: out-of-context `toolUseResult` byte excess over settled bytes in
   *  [countStart, settled) — the text double-write, image bytes already excluded. */
  tureExcess: number;
  /** EI-23760035638533818: whole `prompt_snapshot` LINE bytes over settled bytes in
   *  [countStart, settled). The full-scan path has discounted these since
   *  EI-23747373965813124; without the same term here the anchored gauge steps by one
   *  whole system prompt (~200k tokens on an su session) per snapshot line written. */
  snapshotExcess: number;
  /** Absolute offset just past the last complete line scanned (settled ≤ sizeSeen). */
  settled: number;
  /** File size at the last read; (settled, sizeSeen] is the raw-counted partial tail. */
  sizeSeen: number;
  at: number;
  /** EI-13120: last time `path` was CONFIRMED to still be the owner's live transcript
   *  (a fresh resolveSessionRef+findSessionTranscript agreed with it). Reset on every
   *  reseed; refreshed by the periodic re-verify in `currentContextTokensForOwner`. */
  verifiedAt: number;
}

const anchors = new Map<string, TranscriptAnchor>();
/** Background (re)seed dedup for the sync path. */
const seedInFlight = new Set<string>();

function anchorTokens(a: TranscriptAnchor): number {
  return Math.max(
    0,
    Math.floor(
      (a.sizeSeen - a.countStart - a.imageExcess - a.tureExcess - a.snapshotExcess) / 4,
    ),
  );
}

/** Claude native session ids are v4 UUIDs. Deliberately a LOCAL copy of
 *  adv-sessions.ts's `NATIVE_SESSION_ID_RE` rather than an import: that module
 *  statically pulls `@papercusp/db-org`, and this one is the gauge's SYNC hot
 *  path (it reaches db-org only through `await import`). The two are pinned
 *  identical by compaction-usage.session-identity.test.ts, so the validation
 *  still cannot drift between call sites. */
const ANCHOR_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The native session id an anchor's transcript belongs to, DERIVED from the path
 * itself rather than carried alongside it (derived-truth ladder rung 1 — a second
 * copy of a truth the path already owns would drift). A claude transcript is
 * `<session-id>.jsonl`; a codex rollout embeds the id (see codexRolloutSessionId).
 * The same basename→sessionId convention claude-sessions.ts already uses.
 *
 * Null means "this path does not prove a session identity" — an unrecognized
 * shape, or a test seam's arbitrary temp filename. Callers MUST treat null as
 * CANNOT-PROVE and never as "matches"; that asymmetry is what keeps the gauge
 * degrading to no-number instead of to a wrong number.
 */
export function anchorSessionIdFromPath(pathStr: string): string | null {
  const base = pathStr.slice(pathStr.lastIndexOf('/') + 1);
  if (!base.endsWith('.jsonl')) return null;
  const codex = codexRolloutSessionId(pathStr);
  if (codex) return codex;
  const id = base.slice(0, -'.jsonl'.length);
  return ANCHOR_SESSION_ID_RE.test(id) ? id : null;
}

/** Sum the image discount (WI-3176) over a settled latin1 slice. `skip` excludes
 *  offsets lying inside an already-discounted whole prompt_snapshot line
 *  (EI-23760035638533818) — discounting the same byte twice UNDER-counts, the one
 *  direction that risks a real context death. */
function imageExcessIn(visible: string, skip?: (i: number) => boolean): number {
  let excess = 0;
  for (const m of visible.matchAll(IMAGE_PAYLOAD_RE)) {
    if (skip?.(m.index ?? 0)) continue;
    excess += m[0].length - IMAGE_TOKEN_COST * 4;
  }
  return excess;
}

/**
 * EI-23760035638533818: the ANCHORED analogue of the full-scan path's discount trio.
 *
 * `tokensFromFileSize` has discounted whole `prompt_snapshot` lines since
 * EI-23747373965813124, but the anchored incremental path — which is what actually
 * renders the live PostToolUse gauge (inbox.ts → currentContextTokensForOwner) — never
 * learned about them. Measured on a live su transcript 2026-09-20: 2 snapshots +
 * 1 instructions attachment = 1,283,758 of 1,854,774 bytes (69.2%), so the anchored
 * gauge read ~463,693 where the honest figure was ~142,754 — a 3.2x over-report that
 * arrives as discrete ~200k steps (one per snapshot line), uncorrelated with result
 * size, and force-compacts sessions that have done no work.
 *
 * Computing all three excesses together is what keeps the "no byte discounted twice"
 * invariant local to ONE place instead of re-derived at each of the three anchor call
 * sites (seed + both advance branches).
 */
function excessesIn(visible: string): {
  snapshotExcess: number;
  imageExcess: number;
  tureExcess: number;
} {
  const snapRanges = promptSnapshotRangesIn(visible);
  let snapshotExcess = 0;
  for (const [s, e] of snapRanges) snapshotExcess += e - s;
  const inSnapshot = snapRanges.length
    ? (i: number) => snapRanges.some(([s, e]) => i >= s && i < e)
    : undefined;
  return {
    snapshotExcess,
    imageExcess: imageExcessIn(visible, inSnapshot),
    tureExcess: toolUseResultExcessIn(visible, inSnapshot),
  };
}

/** Full (tail-capped) scan → a fresh anchor. Same math as tokensFromFileSize,
 *  but retains WHERE counting starts so later reads can advance incrementally.
 *  Null on any fs error (caller degrades like the estimator does). */
function seedAnchorFromFile(pathStr: string): TranscriptAnchor | null {
  try {
    const size = fs.statSync(pathStr).size;
    const start = Math.max(0, size - BOUNDARY_SCAN_CAP);
    const fd = fs.openSync(pathStr, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lastNl = buf.lastIndexOf(NEWLINE);
      const settledLen = lastNl === -1 ? 0 : lastNl + 1;
      const view = buf.subarray(0, settledLen);
      const idx = view.lastIndexOf(COMPACT_BOUNDARY_MARKER);
      // EI-10434: marker not in the scanned window ⇒ count from `start` (the
      // BOUNDED edge of the scan window), NOT 0 (the whole file) — matching the
      // tokensFromFileSize fix above. Counting from 0 makes anchorTokens ≈
      // sizeSeen/4, unbounded and growing forever as the transcript grows, even
      // though a real (unseen, further-back) compaction may already bound real
      // usage near zero. Counting from `start` keeps the same "≥cap bytes ⇒ over
      // every real limit" conservative signal without the unbounded growth.
      const countStart = idx === -1 ? start : start + idx;
      const countedView = view.toString('latin1', idx === -1 ? 0 : idx);
      const { snapshotExcess, imageExcess, tureExcess } = excessesIn(countedView);
      const now = Date.now();
      return {
        path: pathStr,
        countStart,
        imageExcess,
        tureExcess,
        snapshotExcess,
        settled: start + settledLen,
        sizeSeen: size,
        at: now,
        verifiedAt: now,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Advance an anchor over the bytes appended since its last read.
 *  'ok' — anchor is current (tokens readable); 'reseed' — file shrank/rotated or
 *  the backlog exceeds the scan cap (full reseed needed); 'defer' — sync caller
 *  hit its delta cap (a background advance/seed should run). Throws on fs errors
 *  (missing file) — callers treat that as 'reseed'. */
function advanceAnchor(a: TranscriptAnchor, opts: { syncCap?: number } = {}): 'ok' | 'reseed' | 'defer' {
  const size = fs.statSync(a.path).size;
  if (size < a.sizeSeen) return 'reseed';
  if (size === a.sizeSeen) return 'ok';
  const deltaLen = size - a.settled; // re-read the unsettled partial tail + new bytes
  if (deltaLen > BOUNDARY_SCAN_CAP) return 'reseed';
  if (opts.syncCap != null && deltaLen > opts.syncCap) return 'defer';
  const fd = fs.openSync(a.path, 'r');
  try {
    const buf = Buffer.alloc(deltaLen);
    fs.readSync(fd, buf, 0, deltaLen, a.settled);
    const lastNl = buf.lastIndexOf(NEWLINE);
    if (lastNl !== -1) {
      const settledLen = lastNl + 1;
      const view = buf.subarray(0, settledLen);
      const idx = view.lastIndexOf(COMPACT_BOUNDARY_MARKER);
      if (idx !== -1) {
        // A compaction landed in this delta: counting restarts at the marker.
        a.countStart = a.settled + idx;
        const e = excessesIn(view.toString('latin1', idx));
        a.imageExcess = e.imageExcess;
        a.tureExcess = e.tureExcess;
        a.snapshotExcess = e.snapshotExcess;
      } else {
        const e = excessesIn(view.toString('latin1'));
        a.imageExcess += e.imageExcess;
        a.tureExcess += e.tureExcess;
        a.snapshotExcess += e.snapshotExcess;
      }
      a.settled += settledLen;
    }
    a.sizeSeen = size;
    a.at = Date.now();
    return 'ok';
  } finally {
    fs.closeSync(fd);
  }
}

/** EI-13120: bound on how long a per-process anchor can go without re-confirming
 *  `path` is still the owner's LIVE transcript. On a clustered operator (each
 *  :3070 worker keeps its own anchor Map — see the file-header note), a
 *  carry-respawn's `sessionRespawned` report lands on exactly ONE worker and
 *  clears only THAT process's anchor; sibling workers never learn the old
 *  transcript died, so `advanceAnchor`'s "size unchanged ⇒ ok" fast path keeps
 *  replaying the frozen pre-respawn reading FOREVER on any request that happens
 *  to route to them (a fresh post-compaction wake re-reporting the byte-identical
 *  pre-compaction %). Re-resolving the live path is a DB read (resolveSessionRef)
 *  + a dir lookup — too costly for every call (the whole point of the anchor is
 *  to avoid that), so it's done at most once per this interval per process. */
const PATH_REVERIFY_MS = 30_000;

/** Resolve the CURRENT live transcript path for an owner (primary session_id
 *  lookup + the P-016 stale-session-id fallback), or null when untracked
 *  (OMP/Codex/unresolvable). Shared by the initial seed and the periodic
 *  re-verify so both paths make the SAME "what is live right now" call. */
async function resolveLiveTranscriptPath(ownerId: string): Promise<string | null> {
  // EI-13477: use the RECONCILED ref (WI-5075 rung 3), not the raw DB row. A
  // same-pid claude self-relaunch (TUI re-exec / update relaunch) writes a
  // brand-new native session id that `adv_sessions.session_id` is never
  // updated to (see session-recover-hook.mjs's respawned-event report), and the
  // OLD id still names a real (frozen, non-empty) transcript file — so the raw
  // ref resolves successfully to the DEAD transcript instead of falling through
  // to the P-016 newest-file fallback below. The anchor then "advances" against
  // a file that has stopped growing and never re-diverges on its own: the
  // periodic re-verify (EI-13120) re-resolves through the SAME raw (unreconciled)
  // path and confirms the same wrong file every time. Reconciling against the
  // host's own respawn log is exactly the fix already used by
  // estimateContextTokensForOwner for the carry-respawn case; this wires the
  // anchored "live" hot path (what the PostToolUse gauge + loop:checkpoint's
  // continuation gate actually read) into the same reconciliation.
  const ref = await resolveSessionRefReconciled(ownerId);
  if (!ref || ref.agent === 'omp' || ref.agent === 'codex') return null;
  let p: string | null = null;
  if (ref.sessionId) {
    try {
      p = await findSessionTranscript(ref.sessionId, {
        owner: ref.transcriptOwner === undefined ? ownerId : ref.transcriptOwner,
      });
    } catch {
      p = null;
    }
  }
  // P-016 fallback: stale/rotated session_id → newest jsonl under the owner root.
  if (!p) p = newestTranscriptUnderOwner(ownerId);
  return p;
}

/**
 * The live per-render read: EXACT current context tokens for an owner, derived
 * from the transcript's state at THIS call (anchored-incremental, so the cost is
 * the append delta, not a tail scan). Resolution/degradation contract matches
 * estimateContextTokensForOwner: OMP/Codex and unresolvable transcripts → null.
 * `reseed: true` forces a fresh full scan (periodic ground-truthing / boundary
 * refresh) instead of trusting the anchor.
 *
 * EI-13120: even on a byte-advance 'ok', an anchor older than
 * {@link PATH_REVERIFY_MS} since its last path confirmation re-resolves the
 * owner's live transcript path before trusting it — this is what bounds a
 * cross-process-stale anchor (see that constant's doc) to a short window
 * instead of "until this worker happens to be told otherwise", which on today's
 * cluster is never.
 */
export async function currentContextTokensForOwner(
  ownerId: string,
  opts: { reseed?: boolean } = {},
): Promise<number | null> {
  const a = anchors.get(ownerId);
  if (a && !opts.reseed) {
    try {
      if (advanceAnchor(a) === 'ok') {
        if (Date.now() - a.verifiedAt <= PATH_REVERIFY_MS) return anchorTokens(a);
        const livePath = await resolveLiveTranscriptPath(ownerId);
        if (livePath === a.path) {
          a.verifiedAt = Date.now();
          return anchorTokens(a);
        }
        if (livePath == null) {
          // Resolution failed/untracked THIS call — transient DB/fs hiccup or a
          // genuinely untracked owner. Fail open on the existing anchor (don't
          // flap to null / wipe good state on a blip); retry the re-verify next call.
          return anchorTokens(a);
        }
        // livePath resolved to a DIFFERENT file: this anchor is tracking a dead
        // transcript (a carry-respawn's successor, invisible to this process).
        // Fall through and reseed directly against the confirmed-live path.
        const seeded = seedAnchorFromFile(livePath);
        if (seeded) {
          anchors.set(ownerId, seeded);
          return anchorTokens(seeded);
        }
        // seed failed (fs blip) — degrade to the stale anchor rather than null.
        return anchorTokens(a);
      }
    } catch {
      /* rotated/unreadable — fall through to reseed */
    }
  }
  const p = await resolveLiveTranscriptPath(ownerId);
  if (!p) return null;
  const seeded = seedAnchorFromFile(p);
  if (!seeded) return null;
  anchors.set(ownerId, seeded);
  return anchorTokens(seeded);
}

/**
 * Sync variant for the P-013 result annotator. Returns the exact current tokens
 * when the anchor can advance within {@link SYNC_DELTA_CAP}; otherwise kicks ONE
 * background (re)seed and returns null — the caller renders NOTHING this call
 * rather than a possibly-stale number, and the next call reads the corrected
 * anchor. (An owner never read in this process before seeds in the background
 * the same way.)
 *
 * EI-13120 / WI-10001513: a sync call cannot await the path re-verify that
 * `currentContextTokensForOwner` does, so past {@link PATH_REVERIFY_MS} since the last
 * confirmation the anchor is UNPROVEN — this process has no evidence it still names the
 * owner's live transcript. It therefore kicks the background reseed and returns null:
 * the caller renders nothing, and the next call reads the corrected anchor.
 *
 * It previously returned the "bounded-stale" reading here instead. That was the defect
 * behind this file's cross-process staleness: a dead predecessor's transcript stops
 * growing, so the anchor stays byte-identical and cheerfully readable while describing a
 * process that no longer exists — and the number it yields is the pre-respawn one, which
 * is exactly the near-limit reading that makes a fresh successor consider re-compacting
 * with zero work done. Declining costs one missing gauge line; serving it costs a whole
 * session. It also settles a contradiction between this function's old contract and
 * context-gauge-annotator.ts's ("never a possibly-stale number") — agent-visible
 * behaviour followed the worse of the two.
 *
 * In practice the decline is rare, because {@link noteLiveNativeSession} re-proves the
 * anchor for free on every tool call this worker serves.
 */
export function currentContextTokensSyncForOwner(ownerId: string): number | null {
  const a = anchors.get(ownerId);
  if (a) {
    try {
      if (advanceAnchor(a, { syncCap: SYNC_DELTA_CAP }) === 'ok') {
        if (Date.now() - a.verifiedAt > PATH_REVERIFY_MS) {
          if (!seedInFlight.has(ownerId)) {
            seedInFlight.add(ownerId);
            void currentContextTokensForOwner(ownerId)
              .catch(() => null)
              .finally(() => seedInFlight.delete(ownerId));
          }
          return null; // unproven — degrade to "no gauge", never to "wrong gauge"
        }
        return anchorTokens(a);
      }
    } catch {
      /* rotated/unreadable — background reseed below */
    }
  }
  if (!seedInFlight.has(ownerId)) {
    seedInFlight.add(ownerId);
    void currentContextTokensForOwner(ownerId, { reseed: true })
      .catch(() => null)
      .finally(() => seedInFlight.delete(ownerId));
  }
  return null;
}

/**
 * EI-12966: respawn/carry-cut invalidation. A carry-respawn (P-018 soft/force
 * cut, or a deliberate `session:request-compaction`) keeps the coord ownerId
 * but KILLS the child process and starts a fresh one under a NEW native
 * `--session-id` — the successor's transcript is a DIFFERENT FILE, not an
 * appended `isCompactSummary` marker in the old one. The old file simply stops
 * growing (the dead predecessor never writes to it again), so the anchor's
 * fast path (`advanceAnchor`: size unchanged ⇒ 'ok') keeps serving the exact
 * pre-cut reading forever — it never re-checks whether `a.path` is even still
 * the LIVE transcript for this owner. That is the class WI-4154 was built to
 * eliminate for an in-place `isCompactSummary` boundary, but a carry-respawn's
 * boundary is a FILE change, which advanceAnchor cannot see by construction
 * (it only stats the anchor's own cached path). Call this at the same
 * `sessionRespawned` report site that already clears the watchdog-mirror cache
 * (`context-usage-cache.ts`'s clearContextUsage) so BOTH per-owner caches drop
 * together — the very next read reseeds from the successor's real transcript
 * instead of replaying the dead predecessor's frozen number.
 */
export function clearContextAnchor(ownerId: string): void {
  anchors.delete(ownerId);
  seedInFlight.delete(ownerId);
  observedPromptFloors.delete(ownerId);
}

/**
 * WI-10001513: identity-keyed respawn invalidation — the authority that makes the
 * gauge correct on a CLUSTERED operator without any broadcast.
 *
 * {@link clearContextAnchor} fires from ONE HTTP POST, so on a 16-worker cluster it
 * reaches exactly one process; the other 15 keep a dead predecessor's anchor, and
 * because a dead transcript STOPS GROWING, `advanceAnchor` reads "size unchanged ⇒
 * ok" and replays its frozen pre-respawn token count. The gauge is therefore not
 * merely lagging — it is a per-call lottery across workers, which is why agents
 * observe non-monotonic readings between consecutive calls.
 *
 * The fix needs no delivery and no timer: the caller's NATIVE session id already
 * rides on every tool call (the PostToolUse hook reads it off its own stdin event
 * and `activity:report` persists it). Authority that travels WITH the request
 * cannot be lost the way a broadcast can, and it reaches whichever worker is
 * actually serving — so each worker self-heals on the FIRST call it serves, never
 * sooner and never later. That is also why the eager cluster-broadcast alternative
 * was rejected: with identity keying it would reseed 16 workers (each a tail scan
 * up to BOUNDARY_SCAN_CAP) to pre-empt the handful of lazy reseeds that already
 * land at exactly the right moment.
 *
 * Three outcomes, and the asymmetry between them is the whole safety property:
 *  - id MATCHES the anchor's path-derived id → a free re-proof (no DB, no fs): the
 *    anchor is confirmed live, so refresh `verifiedAt`. On a busy worker this keeps
 *    the anchor continuously proven, so the sync read below rarely has to decline.
 *  - id DIFFERS → the anchor tracks a dead predecessor. Drop it; the next read
 *    reseeds from the successor's real transcript.
 *  - identity UNPROVABLE (no id supplied, or a path whose shape yields none) →
 *    change NOTHING. Dropping here would thrash (drop → reseed → drop) for any
 *    non-UUID path such as a test seam's temp file. The anchor simply stops being
 *    re-proven, so it ages out of the staleness gate and the sync read declines —
 *    which degrades to "no gauge", never to "wrong gauge".
 *
 * Cheap and total by design: a Map get plus a string compare, safe to call on
 * every report.
 */
export function noteLiveNativeSession(ownerId: string, sessionId: string | null | undefined): void {
  const sid = sessionId?.trim();
  if (!sid) return; // no identity evidence this call — never a reason to change state
  const a = anchors.get(ownerId);
  if (!a) return;
  const anchorSid = anchorSessionIdFromPath(a.path);
  if (anchorSid == null) return; // cannot prove EITHER way — let the staleness gate govern
  if (anchorSid === sid) {
    a.verifiedAt = Date.now(); // proven live, for free
    return;
  }
  clearContextAnchor(ownerId); // proven DEAD — this is the carry-respawn case
}

/** Test seams: reset anchor state / seed an anchor for a known file directly
 *  (unit tests have no adv_sessions row to resolve an owner through). */
export function resetContextAnchorsForTests(): void {
  anchors.clear();
  seedInFlight.clear();
  observedPromptFloors.clear();
}
export function seedContextAnchorForTests(ownerId: string, pathStr: string): boolean {
  const seeded = seedAnchorFromFile(pathStr);
  if (!seeded) return false;
  anchors.set(ownerId, seeded);
  return true;
}

/** The context-death signature Claude writes into the transcript when the
 *  request exceeds the model window — the silent fleet-member killer
 *  (context-trimming-tiers P-019: 6 members died on it, 2026-07-01). */
export const CONTEXT_DEATH_MARKER = 'Prompt is too long';

/**
 * Structural matcher for a REAL claude-code window-overflow death (WI-4608 fix).
 *
 * A real overflow lands as an ASSISTANT ERROR ENTRY whose text IS the marker —
 * `{"type":"text","text":"Prompt is too long"}` alongside `"error":"invalid_request"`
 * (verified against live doc-steward deaths). So in the raw transcript JSONL the
 * phrase is the START of an UNESCAPED JSON string value: `"Prompt is too long`
 * preceded by a real (un-backslashed) `"`.
 *
 * The prior detector naive-`.includes()`d the bare phrase over the whole 8KB tail,
 * which FALSE-FIRED whenever a session merely READ the phrase as DATA — and any
 * data a session reads is nested JSON, so its quotes are ESCAPED (`\"Prompt is too
 * long\"`):
 *   - a coord:escalations tool_result summary (`... died on \"Prompt is too long\" ...`)
 *     — the overwatch/mug survey escalations every wake, so they ingested the phrase,
 *     got flagged "dead", and filed a NEW escalation carrying the phrase → a
 *     self-amplifying false-death loop (WI-4608: mug/kettle/su were ~3k-token turns
 *     on a 1M window, "dying" every wake);
 *   - a code comment a cup/worker Read (e.g. this file's own comments);
 *   - the OverwatchBrief, which lists these deaths verbatim.
 * A session can also write a meta-commentary text block that STARTS with the
 * marker and continues (`"text":"Prompt is too long — ..."`), or even emit a
 * standalone text block containing the marker while explaining the incident.
 * Neither is the API error. The genuine record has a structural discriminator
 * that prose does not: it is an assistant JSONL record with top-level
 * `error:"invalid_request"` and a content text block whose value is exactly the
 * marker. Parse complete JSONL lines below instead of matching a phrase over
 * the raw tail, so nested tool results and assistant prose cannot satisfy the
 * detector.
 */
function isContextDeathRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as {
    type?: unknown;
    error?: unknown;
    message?: { content?: unknown };
  };
  if (record.type !== 'assistant' || record.error !== 'invalid_request') return false;
  if (!record.message || !Array.isArray(record.message.content)) return false;
  return record.message.content.some(
    (block) =>
      !!block &&
      typeof block === 'object' &&
      (block as { type?: unknown; text?: unknown }).type === 'text' &&
      (block as { type?: unknown; text?: unknown }).text === CONTEXT_DEATH_MARKER,
  );
}

/**
 * Pure (WI-4608): does this transcript-TAIL text carry claude-code's ACTUAL
 * window-overflow API error, as opposed to the phrase appearing as data the
 * session merely read or quoted in meta-commentary? Exported for a direct unit
 * test (detectContextDeathForOwner is fs/PG-bound). See isContextDeathRecord
 * for the real-vs-data discriminator.
 */
export function tailCarriesContextDeath(tail: string): boolean {
  for (const line of tail.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      if (isContextDeathRecord(JSON.parse(line))) return true;
    } catch {
      // The tail can begin in the middle of a JSONL record; incomplete lines
      // are not sufficient evidence of a real context death.
    }
  }
  return false;
}

/** How much transcript tail to scan for the death marker. The error lands as
 *  the final entry, but a hook/summary line can trail it — 8KB is plenty. */
const DEATH_TAIL_BYTES = 8_192;

/**
 * P-019 context-death detector: does this owner's transcript TAIL carry the real
 * "Prompt is too long" window-overflow error (NOT the phrase as data it read —
 * see tailCarriesContextDeath / WI-4608)? Best-effort (null transcript / read
 * error → false). fs reads only the tail, never the whole file.
 */
export async function detectContextDeathForOwner(ownerId: string): Promise<boolean> {
  const tail = await readLiveClaudeTranscriptTail(ownerId, DEATH_TAIL_BYTES);
  return tail != null && tailCarriesContextDeath(tail);
}

/**
 * The TAIL of an owner's LIVE claude transcript, or null (omp/codex, no transcript,
 * read error). EI-13477: reconciled, same reasoning as resolveLiveTranscriptPath —
 * a raw ref keeps reading a dead pre-relaunch transcript's tail, which can never
 * show a death record the LIVE successor might actually have written (and, for the
 * tool-reference detector, would keep "seeing" a death the successor already cured).
 * The first line of a tail may be a partial record; both detectors parse whole JSONL
 * lines and skip it.
 */
async function readLiveClaudeTranscriptTail(ownerId: string, bytes: number): Promise<string | null> {
  try {
    const ref = await resolveSessionRefReconciled(ownerId);
    if (!ref?.sessionId || ref.agent === 'omp' || ref.agent === 'codex') return null;
    const { findSessionTranscript } = await import('./claude-sessions');
    const p = await findSessionTranscript(ref.sessionId, {
      owner: ref.transcriptOwner === undefined ? ownerId : ref.transcriptOwner,
    });
    if (!p) return null;
    const size = fs.statSync(p).size;
    const start = Math.max(0, size - bytes);
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** A live session stranded by the provider's unavailable-tool-reference rejection. */
export interface ToolReferenceDeath {
  /** Consecutive trailing assistant turns that were the synthetic rejection. */
  turns: number;
  /** The tool the latest rejection named (e.g. `mcp__papercusp-su__capability_bash`). */
  toolName: string | null;
  /** Bounded verbatim rejection text. */
  evidence: string | null;
}

/** Tail window for the tool-reference death detector. Unlike the context-death
 *  marker (always the final record), this death is a STREAK spanning several turns,
 *  and each turn's user record can be a multi-KB wake or paste between the short
 *  synthetic rejections. A streak that does not fit is simply not seen this pass —
 *  fail-safe: it can under-detect, never invent a death. */
const TOOL_REFERENCE_DEATH_TAIL_BYTES = 256 * 1024;

/**
 * Pure (WI-10003466): does this transcript TAIL end in a streak of the provider's
 * `Tool reference '<x>' not found in available tools` rejection long enough that
 * the session cannot recover on its own? Only claude's SYNTHETIC rejection records
 * count (analyzeClaudeResumeTranscript keys on `isApiErrorMessage`/`<synthetic>`),
 * so prose that quotes the error — including an agent diagnosing this very bug —
 * never reads as a death. Exported for a direct unit test.
 */
export function tailCarriesToolReferenceDeath(
  tail: string,
  minTurns: number = CLAUDE_TOOL_REFERENCE_RECOVERY_TURNS,
): ToolReferenceDeath | null {
  const analysis = analyzeClaudeResumeTranscript(tail, { maxReferences: 0 });
  if (analysis.trailingMissingToolReferenceTurns < minTurns) return null;
  return {
    turns: analysis.trailingMissingToolReferenceTurns,
    toolName: analysis.lastMissingToolReferenceName,
    evidence: analysis.lastMissingToolReferenceEvidence,
  };
}

/**
 * WI-10003466 death detector, sibling of detectContextDeathForOwner: a LIVE claude
 * session whose transcript ends in consecutive unavailable-tool-reference rejections
 * is dead-but-still-beating exactly like a "Prompt is too long" death. The trigger
 * that killed su-7dc2cf9d (2026-09-27): a ~20s MCP transport refusal made the client
 * mark papercusp-su disconnected and drop its tools; the transcript held a saved
 * `tool_reference` to one of them, so every later request was rejected before the
 * agent could act — while hook-origin calls kept its presence beat fresh. A fresh
 * successor (new transcript, new MCP connection) cures it. Best-effort → null.
 */
export async function detectToolReferenceDeathForOwner(ownerId: string): Promise<ToolReferenceDeath | null> {
  const tail = await readLiveClaudeTranscriptTail(ownerId, TOOL_REFERENCE_DEATH_TAIL_BYTES);
  return tail == null ? null : tailCarriesToolReferenceDeath(tail);
}

/**
 * The EXPLICIT compaction limit a session was launched with — `psu
 * --compaction-limit=<tokens>`, read back off the same recorded launch argv
 * `resolveModelSpecForOwner` uses (per-member-declarative-launch-specs P-005).
 *
 * This is the per-member lever a fleet leader sets declaratively via
 * `MemberSpec.compactionLimit`. It rides the recorded argv rather than a column
 * of its own for two reasons: a psu session has NO `spawned_agents` row (that
 * table tracks hive/blueprint spawns — bootstrap-su never writes it), and
 * `adv_sessions.launch_argv` is already the per-session source of truth this
 * seeding path consults. So the value survives death/respawn exactly as the
 * model spec does, with no new schema.
 *
 * The caller CLAMPS: this returns the raw request, which is a ceiling-free number
 * until `clampCompactionLimit` bounds it by role + model window. null = the launch
 * named no limit (the overwhelmingly common case — fall through to the default).
 */
export async function resolveLaunchCompactionLimitForOwner(ownerId: string): Promise<number | null> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const rows = await getOrgPg().sql<{ launch_argv: unknown }[]>`
      SELECT launch_argv
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ${ownerId} AND launch_argv IS NOT NULL
       ORDER BY started_at DESC
       LIMIT 1
    `;
    return parseLaunchCompactionLimitArgv(rows[0]?.launch_argv);
  } catch {
    return null;
  }
}

/**
 * The pure argv scan behind {@link resolveLaunchCompactionLimitForOwner} — split
 * out so the parsing contract is unit-testable without a database.
 *
 * Accepts both wire forms (mirroring the `--model` scan below): psu emits
 * `--compaction-limit=N`, but a hand-composed argv may use the space form. A
 * malformed value is DROPPED rather than coerced — psu rejects bad input at parse
 * time, so anything unparseable here came from a hand-edited argv, and falling
 * through to the model-derived default is the safe read. Returns null when the
 * launch named no limit.
 */
export function parseLaunchCompactionLimitArgv(argv: unknown): number | null {
  if (!Array.isArray(argv)) return null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string') continue;
    let raw: string | null = null;
    if (a.startsWith('--compaction-limit=')) raw = a.slice('--compaction-limit='.length).trim();
    else if (a === '--compaction-limit' && typeof argv[i + 1] === 'string') raw = (argv[i + 1] as string).trim();
    if (!raw) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return null;
}

/**
 * Best-effort MODEL SPEC (`<id>[:effort]`, possibly carrying the `[1m]` window
 * marker) for a session owner — the window signal `defaultCompactionLimitForSpec`
 * keys on (context-trimming-tiers P-002/P-006).
 *
 * Source 1: a `--model` in the recorded launch argv (adv_sessions) — the only
 * PER-SESSION truth. Source 2 (fallback when no `--model` was recorded): the
 * session config dir's `settings.json` `model` field. Order matters: that
 * `settings.json` is a SYMLINK back to the shared `~/.claude/settings.json`
 * (interactive-claude-config mirror), so it reports the BOX-DEFAULT model —
 * checking it first handed every `psu --model=sonnet` fleet member the
 * opus[1m] 500k limit on a 200k window, a guaranteed context death
 * (context-trimming-tiers P-031 gap 1, 2026-07-02). argv-first fails safe:
 * a conservative spec on a big window is deliberate leanness; a big spec on a
 * 200k window is fatal. null when neither resolves — callers treat null as the
 * conservative 200k window.
 */
export async function resolveModelSpecForOwner(ownerId: string): Promise<string | null> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const rows = await getOrgPg().sql<{ launch_argv: unknown }[]>`
      SELECT launch_argv
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ${ownerId} AND launch_argv IS NOT NULL
       ORDER BY started_at DESC
       LIMIT 1
    `;
    // The argv parse itself lives in agent-config-constants (client-safe) so the
    // chat MODEL control can reuse it against the argv the roster already carries,
    // instead of growing a second copy of this loop (WI-6510).
    const { modelSpecFromArgv } = await import('./agent-config-constants');
    const fromArgv = modelSpecFromArgv(rows[0]?.launch_argv);
    if (fromArgv) return fromArgv;
  } catch {
    /* best-effort — fall through to settings.json */
  }
  // Guard the path join: owner ids are our own (su-/s-/pus- UUIDs), but never
  // let a hostile id escape the session-claude root.
  if (ownerId && !ownerId.includes('/') && !ownerId.includes('..')) {
    try {
      const { papercuspSessionClaudeBase } = await import('./claude-sessions');
      const path = await import('node:path');
      const p = path.join(papercuspSessionClaudeBase(), ownerId, 'settings.json');
      const j = JSON.parse(fs.readFileSync(p, 'utf8')) as { model?: unknown };
      if (typeof j.model === 'string' && j.model.trim()) return j.model.trim();
    } catch {
      /* unresolvable */
    }
  }
  return null;
}
