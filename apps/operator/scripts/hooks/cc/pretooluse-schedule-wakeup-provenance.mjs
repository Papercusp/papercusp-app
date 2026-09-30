#!/usr/bin/env node
/**
 * PreToolUse (matcher "ScheduleWakeup") — best-effort turn-provenance
 * ENROLLMENT for the Claude-CLI-native ScheduleWakeup tool
 * (EI-18680056073436345, following turn-provenance-owner-vs-agent-2026-07-11).
 *
 * THE BUG THIS CLOSES
 *   ScheduleWakeup wakes are delivered by the Claude Code CLI ITSELF, from
 *   inside the same process, at some later turn — there is no papercusp
 *   injector on that delivery path to prefix a `⟦turn-origin⟧` envelope or
 *   write a ledger row BEFORE typing (the normal D-002 enrollment contract
 *   in packages/operator-core/lib/turn-provenance/turn-provenance.ts). So the
 *   UserPromptSubmit hook (userpromptsubmit-provenance.sh) sees "no envelope,
 *   no ledger match" for the delivered wake and stamps it the AFFIRMATIVE
 *   `OWNER (interactive)` default — a manufactured owner directive, the
 *   dangerous direction of the WI-3532 class: worse than un-stamped text,
 *   because the stamp itself now vouches for it.
 *
 * THE FIX
 *   We cannot intercept the DELIVERY (it's CLI-internal), but the CALL that
 *   *schedules* it — the agent invoking the ScheduleWakeup tool — DOES pass
 *   through papercusp's normal PreToolUse hook chain, same as any other tool
 *   call. So enroll THERE: hash the exact `prompt` text being scheduled and
 *   write a ledger row for it NOW, with a per-row `ttlMs` sized to the
 *   requested delay (clamped to the tool's documented [60,3600]s range) plus
 *   slack for delivery jitter — instead of the global 10-minute default,
 *   which would expire long before a 30-60 minute wake ever fires. When the
 *   CLI later delivers the prompt verbatim, classify()'s no-envelope
 *   hash-match branch finds this row and stamps `VERIFIED AGENT-ORIGIN
 *   (origin: cli-schedule-wakeup)` instead of OWNER — see turn-provenance.ts
 *   D-002 and its `LedgerRow.ttlMs` field (kept in lockstep with this file's
 *   hash/normalize logic and with userpromptsubmit-provenance.sh's reader).
 *
 * SCOPE + FAIL-OPEN
 *   - Only tool_name === 'ScheduleWakeup', with a `stop:true` call (ending an
 *     existing loop, no prompt/delay to enroll) and any call missing a
 *     non-empty string `prompt` treated as a no-op.
 *   - NEVER blocks: this hook does not emit a permissionDecision at all — it
 *     is purely an observational ledger write, always exit 0. Any internal
 *     error (bad JSON, unwritable ledger dir, …) is swallowed; a missed
 *     enrollment just means the eventual delivery falls back to today's
 *     behavior (OWNER/machine-surface per the existing classifier), never a
 *     blocked tool call.
 *   - Scope guard: PAPERCUSP_SID must be set (mirrors every other CC hook's
 *     psu-session gate) — a plain `claude` elsewhere has no sid, no-op.
 *
 * Registered via mergeClaudeHookSettings (papercusp-files.ts)
 * `merge_schedule_wakeup_provenance_hook` + the install-standalone-mcp.sh
 * sibling of the same name — KEEP THE TWO IN SYNC (same convention as every
 * other hook in this directory; see e.g. guard-operator-desktop.mjs's header).
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ─── lockstep mirrors of turn-provenance.ts (keep in sync) ─────────────────

function normalizeForHash(payload) {
  return (payload ?? '').replace(/\r\n?/g, '\n').trim();
}

function payloadSha256(payload) {
  return createHash('sha256').update(normalizeForHash(payload), 'utf8').digest('hex');
}

function sanitizeSid(sid) {
  return String(sid || 'unknown')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 200);
}

function turnProvenanceDir(env = process.env) {
  return env.PAPERCUSP_TURN_PROVENANCE_DIR || join(homedir(), '.papercusp', 'turn-provenance');
}

const LEDGER_COMPACT_BYTES = 32 * 1024;

/** ScheduleWakeup's own documented clamp (the tool schema: "Clamped to
 *  [60, 3600] by the runtime"). We can't observe the runtime's ACTUAL clamp
 *  from here, so we replicate it — a wrong guess only ever widens the ttl
 *  slack, never narrows correctness (a live-but-unmatched row still falls
 *  back to today's classification, not a false verify). */
const MIN_DELAY_SEC = 60;
const MAX_DELAY_SEC = 3600;
/** Slack added on top of the clamped delay: delivery jitter (the runtime's
 *  own docs mention up to ~15min lateness for a recurring cron elsewhere in
 *  this codebase; ScheduleWakeup is one-shot but we budget generously) plus
 *  hook-to-delivery processing lag. */
const TTL_SLACK_MS = 5 * 60_000;

export function ledgerRowForScheduleWakeup(args) {
  const { sid, prompt, delaySeconds, nowMs = Date.now() } = args;
  const clampedSec = Math.min(MAX_DELAY_SEC, Math.max(MIN_DELAY_SEC, Number(delaySeconds) || MIN_DELAY_SEC));
  return {
    sid,
    nonce: randomBytes(8).toString('hex'),
    origin: 'cli-schedule-wakeup',
    sha256: payloadSha256(prompt),
    ts: nowMs,
    ttlMs: clampedSec * 1000 + TTL_SLACK_MS,
  };
}

/** Fail-soft append (mirrors turn-provenance.ts's appendLedgerRow): a write
 *  failure must never block the tool call — it just means this wake will
 *  classify per today's (pre-fix) fallback when it fires. */
export function appendScheduleWakeupLedgerRow(row, dir = turnProvenanceDir()) {
  try {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${sanitizeSid(row.sid)}.jsonl`);
    // Opportunistic compaction past the size threshold — same trigger as the
    // TS-side appendLedgerRow, so a chatty session's file never grows
    // unbounded. Compaction here only drops rows whose OWN ttl (per-row, or
    // none) has lapsed by wall-clock now — never a live row, ours included.
    if (existsSync(p) && statSync(p).size > LEDGER_COMPACT_BYTES) {
      const nowMs = Date.now();
      const live = readFileSync(p, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((r) => r && typeof r.nonce === 'string' && typeof r.sha256 === 'string' && Number.isFinite(r.ts))
        .filter((r) => nowMs - r.ts <= (r.ttlMs ?? 10 * 60_000));
      writeFileSync(p, live.map((r) => JSON.stringify(r)).join('\n') + (live.length ? '\n' : ''));
    }
    appendFileSync(p, JSON.stringify(row) + '\n');
    return true;
  } catch {
    return false;
  }
}

// ─── hook entrypoint ────────────────────────────────────────────────────────

function main() {
  const allow = () => process.exit(0);

  const sid = process.env.PAPERCUSP_SID || '';
  if (!sid) return allow();

  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return allow(); // malformed hook input — never block on it
  }

  if (String(payload.tool_name || '') !== 'ScheduleWakeup') return allow();
  const input = payload.tool_input || {};
  if (input.stop === true) return allow(); // a stop call schedules nothing

  const prompt = input.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) return allow();

  try {
    const row = ledgerRowForScheduleWakeup({ sid, prompt, delaySeconds: input.delaySeconds });
    appendScheduleWakeupLedgerRow(row);
  } catch {
    /* fail-soft: a ledger-write failure never blocks the schedule itself */
  }
  return allow();
}

// Only run as a hook when invoked directly (lets the vitest suite import the
// helpers above without triggering stdin reads / process.exit).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
