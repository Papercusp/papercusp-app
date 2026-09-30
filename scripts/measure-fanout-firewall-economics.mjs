#!/usr/bin/env node
/**
 * WI-6883 (plan agent-context-firewall-and-output-spill-2026-08-02, P-005)
 * — Is a fleet/cup fan-out a context FIREWALL here, economically?
 *
 * THE QUESTION. A client-native subagent discards its transcript and returns a
 * summary for ~zero marginal infrastructure. A fleet MEMBER is a full su session:
 * its own persona+playbook system prompt, its own orient, its own tool catalogue,
 * its own account draw — and the whole window is re-sent on EVERY turn. Those are
 * not the same economics, and the difference IS the question.
 *
 * A firewall is only worth it if what it ABSORBS exceeds what it COSTS to stand up.
 * So this script prices both sides in real billed tokens and reduces the answer to
 * ONE number: the BREAK-EVEN — how many exploration turns a member must absorb
 * before it has paid for its own existence.
 *
 * WHY BILLED TOKENS, NOT BYTES. Transcripts carry the provider's own `usage` for
 * every assistant turn, so we do not have to proxy context with character counts:
 *   window_tokens = input + cache_creation + cache_read   (what the model SEES)
 *   billed_tokens = input + cache_creation + 0.1*cache_read (what it COSTS; a
 *                   cache read is ~10% of a fresh input token)
 * Reporting only one of these is how this measurement goes wrong in either
 * direction: window alone overstates the cost of a warm session (most of its
 * window is cached), and billed alone hides that a firewall's real product is
 * WINDOW headroom, not money.
 *
 * NOT A SECOND CORPUS: same ROOTS/walk/cutoff as
 * scripts/measure-context-token-baseline.mjs and
 * scripts/analyze-loop-checkpoint-notes.mjs, so totals reconcile with D-017.
 *
 * A NEGATIVE RESULT IS A SUCCESS. If a member costs more than the exploration it
 * absorbs, that closes the fan-out line (P-007) and is the more valuable outcome.
 *
 * Usage: node scripts/measure-fanout-firewall-economics.mjs [days] [outJsonPath]
 */
import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const DAYS = Number(process.argv[2] || 6);
const OUT = process.argv[3] || '/tmp/fanout-firewall-economics.json';
const CUTOFF = Date.now() - DAYS * 86400_000;
const ROOTS = [join(homedir(), '.claude', 'projects'), join(homedir(), '.papercusp', 'session-claude')];

/** A cache read bills at ~10% of a fresh input token. */
const CACHE_READ_WEIGHT = 0.1;

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function summarize(arr) {
  if (!arr.length) return { n: 0 };
  const s = [...arr].sort((a, b) => a - b);
  const total = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    total: Math.round(total),
    mean: Math.round(total / s.length),
    p10: Math.round(pct(s, 10)),
    p50: Math.round(pct(s, 50)),
    p90: Math.round(pct(s, 90)),
    max: Math.round(s[s.length - 1]),
  };
}

/** Bytes of tool_result content in a user message — what an exploration DEPOSITS. */
function toolResultChars(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) {
    if (block?.type !== 'tool_result') continue;
    const c = block.content;
    if (typeof c === 'string') n += c.length;
    else if (Array.isArray(c)) {
      for (const part of c) {
        if (typeof part?.text === 'string') n += part.text.length;
        else if (part != null) n += JSON.stringify(part).length;
      }
    } else if (c != null) n += JSON.stringify(c).length;
  }
  return n;
}

const sessions = new Map();

function sessionOf(key, isSidechain) {
  let s = sessions.get(key);
  if (!s) {
    s = {
      key,
      isSidechain: Boolean(isSidechain),
      firstSeenTs: null,
      startedInWindow: false,
      assistantTurns: 0,
      firstWindow: null,
      firstBilled: null,
      lastWindow: 0,
      maxWindow: 0,
      billedTotal: 0,
      toolResultChars: 0,
      toolResultBlocks: 0,
      turnsWithToolResult: 0,
    };
    sessions.set(key, s);
  }
  // A sidechain marker can appear on any line; once true it stays true.
  if (isSidechain) s.isSidechain = true;
  return s;
}

let filesScanned = 0;
let linesParsed = 0;
let linesUnparseable = 0;
let assistantNoUsage = 0;

for (const root of ROOTS) {
  for await (const file of walk(root)) {
    filesScanned += 1;
    let rl;
    try {
      rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    } catch {
      continue;
    }
    for await (const line of rl) {
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        linesUnparseable += 1;
        continue;
      }
      linesParsed += 1;

      const ts = Date.parse(ev?.timestamp ?? '');

      // Group by the transcript FILE, not sessionId: a carry-respawn chain writes
      // several files and each pays its own entry cost, which is exactly the cost
      // this measurement is about.
      const s = sessionOf(file, ev?.isSidechain);

      // SELECTION-BIAS GUARD. Record the session's TRUE first line before the
      // cutoff filter can hide it. A session that began BEFORE the window has its
      // early turns skipped, so the first turn we observe is mid-session — and a
      // mid-session window is far larger than a real entry cost. That inflates
      // entry cost, inflates break-even, and so FLATTERS a negative verdict. The
      // bias runs in the direction of the conclusion, which is exactly when it
      // must be measured rather than argued about.
      if (s.firstSeenTs == null && Number.isFinite(ts)) {
        s.firstSeenTs = ts;
        s.startedInWindow = ts >= CUTOFF;
      }

      if (Number.isFinite(ts) && ts < CUTOFF) continue;

      if (ev?.type === 'assistant') {
        const u = ev?.message?.usage;
        if (!u) {
          assistantNoUsage += 1;
          continue;
        }
        const inTok = num(u.input_tokens);
        const cc = num(u.cache_creation_input_tokens);
        const cr = num(u.cache_read_input_tokens);
        const window = inTok + cc + cr;
        const billed = inTok + cc + CACHE_READ_WEIGHT * cr;
        if (window <= 0) continue;
        s.assistantTurns += 1;
        if (s.firstWindow == null) {
          s.firstWindow = window;
          s.firstBilled = billed;
        }
        s.lastWindow = window;
        if (window > s.maxWindow) s.maxWindow = window;
        s.billedTotal += billed;
      } else if (ev?.type === 'user') {
        const c = toolResultChars(ev?.message);
        if (c > 0) {
          s.toolResultChars += c;
          s.turnsWithToolResult += 1;
        }
        const blocks = ev?.message?.content;
        if (Array.isArray(blocks)) {
          for (const b of blocks) if (b?.type === 'tool_result') s.toolResultBlocks += 1;
        }
      }
    }
  }
}

// Only sessions that actually took a turn tell us anything about entry cost.
const all = [...sessions.values()].filter((s) => s.assistantTurns > 0 && s.firstWindow != null);
const main = all.filter((s) => !s.isSidechain);
const side = all.filter((s) => s.isSidechain);

/**
 * ENTRY COST = the first assistant turn's window. Before this session did ANY
 * useful work it had already been charged for its system prompt, tool catalogue
 * and launch context. That is the firewall's price of admission.
 */
const entryWindow = summarize(main.map((s) => s.firstWindow));
const entryBilled = summarize(main.map((s) => s.firstBilled));

/**
 * The UNBIASED subset: sessions whose very first transcript line is inside the
 * window, so the first turn we observed really is the session's first turn. If
 * these two populations disagree, the biased number is the one to throw away.
 */
const clean = main.filter((s) => s.startedInWindow);
const entryWindowClean = summarize(clean.map((s) => s.firstWindow));
const entryBilledClean = summarize(clean.map((s) => s.firstBilled));

/**
 * RE-SEND AMPLIFICATION — the correction that argues FOR the firewall.
 * A byte deposited in a window at turn t is re-sent on every turn after it, so
 * its true cost is not D but D amplified by the remaining session length. The
 * same is true of the member's own entry cost, which is why this must be applied
 * to BOTH sides or it becomes an argument rather than a measurement.
 *
 * `billedTotal / firstBilled` is that amplification, measured rather than
 * modelled: how many times over a session bills its own entry cost across life.
 */
const amplification = summarize(
  main.filter((s) => s.firstBilled > 0).map((s) => s.billedTotal / s.firstBilled),
);

/**
 * THE SYMMETRIC COMPARISON — and the reason the naive break-even above is not the
 * answer either way.
 *
 * It is tempting to "correct" break-even by dividing it by the amplification
 * factor, on the grounds that a deposit in the parent is re-sent for the rest of
 * the session. That is WRONG, and wrong in the direction that rescues the
 * firewall: the member re-sends its OWN persona, playbook and tool catalogue on
 * every one of its turns too. Amplifying one side only turns a measurement into
 * an argument. Applied to both sides the factors largely cancel.
 *
 * So compare the two things that are actually per-turn, both measured, no model:
 *   - a member's ALL-IN cost of one turn      (billedTotal / turns)
 *   - the recurring overhead inside that      (~CACHE_READ_WEIGHT * entry cost:
 *     what it costs merely to RE-STATE the member's own prompt each turn)
 *   - versus what one absorbed exploration turn would have cost in the parent,
 *     credited generously WITH its own re-send amplification.
 *
 * If a member's per-turn overhead exceeds the amplified cost of just letting the
 * exploration land in the parent, fan-out cannot pay on token economics at any N.
 */
const perTurnBilled = summarize(main.map((s) => s.billedTotal / s.assistantTurns));
const perTurnWindow = summarize(main.map((s) => s.maxWindow));

/** What exploration actually deposits, per turn that carried a tool result. */
const perTurnResultChars = [];
for (const s of main) {
  if (s.turnsWithToolResult > 0) perTurnResultChars.push(s.toolResultChars / s.turnsWithToolResult);
}
const depositPerTurn = summarize(perTurnResultChars);

/**
 * BREAK-EVEN. Compare like with like: convert deposited CHARS to tokens (~4
 * chars/token, the standard approximation) and ask how many exploration turns a
 * member must absorb before it has paid off its own entry cost.
 *
 * Deliberately generous to the firewall: entry cost is counted ONCE (a warm
 * member re-pays only cache reads), and the deposit is credited in FULL as if
 * every absorbed byte would otherwise have stuck in the parent forever.
 */
const CHARS_PER_TOKEN = 4;
const depositTokensP50 = depositPerTurn.p50 / CHARS_PER_TOKEN;
const depositTokensMean = depositPerTurn.mean / CHARS_PER_TOKEN;
const breakEven = {
  charsPerTokenAssumed: CHARS_PER_TOKEN,
  entryWindowP50: entryWindow.p50,
  entryBilledP50: entryBilled.p50,
  depositTokensPerTurnP50: Math.round(depositTokensP50),
  depositTokensPerTurnMean: Math.round(depositTokensMean),
  turnsToPayBackWindow_p50: depositTokensP50 > 0 ? +(entryWindow.p50 / depositTokensP50).toFixed(1) : null,
  turnsToPayBackBilled_p50: depositTokensP50 > 0 ? +(entryBilled.p50 / depositTokensP50).toFixed(1) : null,
};

const observedTurns = summarize(main.map((s) => s.assistantTurns));

/**
 * Credit the parent-side deposit with re-send amplification over the REMAINING
 * session (half the median length, since a deposit lands mid-session on average),
 * and charge the member the same recurring re-statement of its own prompt.
 */
const residualTurns = Math.max(1, Math.round(observedTurns.p50 / 2));
const depositAmplified = depositTokensP50 * (1 + CACHE_READ_WEIGHT * residualTurns);
const memberTurnOverhead = CACHE_READ_WEIGHT * entryBilledClean.p50;
const symmetric = {
  note: 'per-turn, both sides amplified — the comparison that decides the question',
  memberAllInBilledPerTurn_p50: perTurnBilled.p50,
  memberRecurringPromptOverheadPerTurn: Math.round(memberTurnOverhead),
  residualTurnsAssumed: residualTurns,
  parentDepositAmplifiedPerExplorationTurn: Math.round(depositAmplified),
  firewallPaysOnTokens: memberTurnOverhead < depositAmplified,
  overheadRatio: depositAmplified > 0 ? +(memberTurnOverhead / depositAmplified).toFixed(2) : null,
};

const report = {
  measuredAt: new Date().toISOString(),
  windowDays: DAYS,
  corpus: {
    roots: ROOTS,
    filesScanned,
    linesParsed,
    linesUnparseable,
    assistantTurnsWithoutUsage: assistantNoUsage,
    sessionsWithTurns: all.length,
    mainSessions: main.length,
    sidechainSessions: side.length,
  },
  entryCostTokens: { window: entryWindow, billed: entryBilled },
  entryCostTokensUnbiased: {
    note: 'sessions whose FIRST transcript line is inside the window — a true entry cost',
    sessions: clean.length,
    window: entryWindowClean,
    billed: entryBilledClean,
  },
  resendAmplification: {
    note: 'billedTotal / firstBilled — how many entry-costs a session bills over its life',
    ratio: amplification,
  },
  symmetricComparison: symmetric,
  perTurnCost: { billed: perTurnBilled, peakWindow: perTurnWindow },
  explorationDepositChars: { perTurn: depositPerTurn },
  observedSessionLengthTurns: observedTurns,
  breakEven,
  sidechain: side.length
    ? {
        note: 'client-native subagent transcripts (isSidechain) — the cheap-firewall comparator',
        entryWindow: summarize(side.map((s) => s.firstWindow)),
        turns: summarize(side.map((s) => s.assistantTurns)),
      }
    : { note: 'no sidechain (subagent) transcripts in window — Task/Agent are deny-listed here' },
};

await writeFile(OUT, JSON.stringify(report, null, 2));

const f = (n) => (n == null ? 'n/a' : n.toLocaleString());
console.log(`corpus: ${filesScanned} files, ${f(linesParsed)} lines, ${main.length} main sessions, ${side.length} sidechain`);
console.log(`ENTRY COST (first turn, tokens)  window p50=${f(entryWindow.p50)} mean=${f(entryWindow.mean)} p90=${f(entryWindow.p90)}`);
console.log(`                                 billed p50=${f(entryBilled.p50)} mean=${f(entryBilled.mean)} p90=${f(entryBilled.p90)}`);
console.log(`DEPOSIT per exploration turn     chars  p50=${f(depositPerTurn.p50)} mean=${f(depositPerTurn.mean)} p90=${f(depositPerTurn.p90)}`);
console.log(`                                 tokens p50=${f(breakEven.depositTokensPerTurnP50)}`);
console.log(`BREAK-EVEN (turns a member must absorb to pay for itself)`);
console.log(`   vs WINDOW cost: ${breakEven.turnsToPayBackWindow_p50} turns`);
console.log(`   vs BILLED cost: ${breakEven.turnsToPayBackBilled_p50} turns`);
console.log(`OBSERVED session length: p50=${f(observedTurns.p50)} mean=${f(observedTurns.mean)} p90=${f(observedTurns.p90)} turns`);
console.log(`--- bias + model checks ---`);
console.log(`UNBIASED entry cost (${clean.length}/${main.length} sessions truly started in window)`);
console.log(`                                 window p50=${f(entryWindowClean.p50)} mean=${f(entryWindowClean.mean)}`);
console.log(`                                 billed p50=${f(entryBilledClean.p50)} mean=${f(entryBilledClean.mean)}`);
const beCleanWindow = depositTokensP50 > 0 ? +(entryWindowClean.p50 / depositTokensP50).toFixed(1) : null;
const beCleanBilled = depositTokensP50 > 0 ? +(entryBilledClean.p50 / depositTokensP50).toFixed(1) : null;
console.log(`UNBIASED break-even: window=${beCleanWindow} turns  billed=${beCleanBilled} turns`);
console.log(`RE-SEND AMPLIFICATION (entry-costs billed per session life)`);
console.log(`                                 p50=${amplification.p50}x mean=${amplification.mean}x p90=${amplification.p90}x`);
console.log(`--- the symmetric comparison (both sides amplified) ---`);
console.log(`member all-in billed per turn      p50=${f(perTurnBilled.p50)}  mean=${f(perTurnBilled.mean)}`);
console.log(`member RECURRING prompt overhead   ${f(symmetric.memberRecurringPromptOverheadPerTurn)} billed tok/turn (just to re-state its own prompt)`);
console.log(`parent cost of ONE absorbed turn   ${f(symmetric.parentDepositAmplifiedPerExplorationTurn)} billed tok (deposit + ${symmetric.residualTurnsAssumed} re-sends)`);
console.log(`=> firewall pays on tokens? ${symmetric.firewallPaysOnTokens ? 'YES' : 'NO'}  (overhead is ${symmetric.overheadRatio}x the thing it absorbs)`);
console.log(`wrote ${OUT}`);
