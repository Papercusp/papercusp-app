#!/usr/bin/env -S npx tsx
/**
 * resume-spawn-live.ts — the LIVE-SMOKE rung for the wake-executor's REAL
 * claude/omp/codex resume spawn (closes the coordination-test-suite EI-153
 * accepted-gap: "Full real three-backend resume spawn").
 *
 * The CI test (`wake-resume-isolation.test.ts`) asserts the wake-executor BUILDS
 * the right resume command and hands it to `spawnDetached` (bin/args/env captured
 * via an injected `spawnDetached`) — but it never runs a real CLI, because a real
 * resume needs credentials. This smoke is the other half: it builds the SAME
 * command via the SAME `resumeCommandFor`, runs it against the REAL `claude` /
 * `omp` / `codex` binary in a per-session isolated transcript store,
 * and asserts the resume actually FOUND and CONTINUED the exact session — and
 * does so DETERMINISTICALLY (the session's transcript / rollout file GROWS),
 * independent of the model's semantic output.
 *
 * Faithfulness: both the resume command (`resumeCommandFor`) and the claude
 * config-dir (`writeInteractiveClaudeConfig`, EI-155) are imported from the real
 * operator-core code — there is no copy of the flags to drift out of sync.
 *
 * Gated (needs live provider creds → never CI): surfaced as a `{kind:'node'}`
 * runner in the /adv Tests tab's coordination-suite domain. Each agent leg SKIPS
 * when its CLI is absent / unauthed; the smoke FAILS (exit non-zero) only when an
 * available, authed CLI's resume does NOT continue the session.
 *
 * Usage:
 *   npx tsx apps/operator/scripts/resume-spawn-live.ts            # claude + omp + codex
 *   npx tsx apps/operator/scripts/resume-spawn-live.ts --agent=claude
 *   PAPERCUSP_SMOKE_MODEL=claude-haiku-4-5-20251001 npx tsx … --agent=claude
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resumeCommandFor, wakeTurnText } from '../../../packages/operator-core/lib/events/await/wake-executor';
import type { DeliveryWork } from '../../../packages/operator-core/lib/events/await/types';
import { writeInteractiveClaudeConfig } from '../../../packages/operator-core/lib/interactive-claude-config';
import { tagTurnForInjection } from '../../../packages/operator-core/lib/turn-provenance/turn-provenance';

// A cheap model keeps the smoke's ~4 real turns near-free. Override via env.
const CLAUDE_MODEL = process.env.PAPERCUSP_SMOKE_MODEL || 'claude-haiku-4-5-20251001';
const TURN_TIMEOUT_MS = Number(process.env.PAPERCUSP_SMOKE_TURN_TIMEOUT_MS) || 180_000;

type Leg = {
  agent: "claude" | "omp" | "codex";
  status: "pass" | "skip" | "fail";
  detail: string;
};

function log(s: string) {
  process.stdout.write(s + '\n');
}

/** Run a CLI to completion; capture exit code + output (never throws). */
function run(bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) {
  try {
    const stdout = execFileSync(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      encoding: 'utf8',
      timeout: TURN_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e: any) {
    return { code: e?.status ?? 1, stdout: String(e?.stdout ?? ''), stderr: String(e?.stderr ?? e?.message ?? '') };
  }
}

/** Count newline-delimited records in a JSONL file (0 if absent). */
function jsonlLines(file: string): number {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

/** Enroll the exact prompt bytes before handing them to a real CLI. */
function tagSmokeTurn(sid: string, text: string, dir: string): string | null {
  const tagged = tagTurnForInjection({ sid, origin: 'resume-smoke', text, dir });
  return tagged.ledgerWritten ? tagged.taggedText : null;
}

/** Find `<root>/**​/<needle>` (first match) — claude hashes cwd into the projects
 *  subdir, and codex nests rollouts by date, so we locate the file by name. */
function findFile(root: string, predicate: (name: string, full: string) => boolean): string | null {
  let stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (predicate(e.name, full)) return full;
    }
  }
  return null;
}

function isClaudeAuthed(): boolean {
  return existsSync(join(homedir(), '.claude', '.credentials.json'));
}
function isCodexAuthed(): boolean {
  return existsSync(join(homedir(), '.codex', 'auth.json'));
}
function onPath(bin: string): boolean {
  try {
    execFileSync('bash', ['-lc', `command -v ${bin}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

// ── claude leg ────────────────────────────────────────────────────────────
function claudeLeg(): Leg {
  if (!onPath('claude')) return { agent: 'claude', status: 'skip', detail: 'claude not on PATH' };
  if (!isClaudeAuthed()) return { agent: 'claude', status: 'skip', detail: 'no ~/.claude/.credentials.json' };

  const sid = `smoke-${randomUUID()}`;
  const sessionId = randomUUID(); // forced native session id (claude --session-id)
  const { configDir } = writeInteractiveClaudeConfig({ sid }); // the real EI-155 dir
  const cwd = mkdtempSync(join(tmpdir(), 'resume-smoke-claude-'));
  const provenanceDir = mkdtempSync(join(tmpdir(), 'resume-smoke-provenance-'));
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configDir,
    PAPERCUSP_TURN_PROVENANCE_DIR: provenanceDir,
  };

  try {
    // 1. Fresh launch: force --session-id so resume can target it EXACTLY (the
    //    same flag the launcher's suLaunchArgs forces, plus headless -p).
    log('  claude: launching a fresh session (forced --session-id)…');
    const launchText = tagSmokeTurn(sid, 'Reply with the single word READY.', provenanceDir);
    if (!launchText) {
      return { agent: 'claude', status: 'fail', detail: 'turn-provenance ledger write failed before fresh launch' };
    }
    const launch = run(
      'claude',
      ['--session-id', sessionId, '-p', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions',
        '--model', CLAUDE_MODEL, launchText],
      { cwd, env },
    );
    if (launch.code !== 0) {
      return { agent: 'claude', status: 'fail', detail: `fresh launch exited ${launch.code}: ${launch.stderr.slice(0, 240)}` };
    }
    const transcript = findFile(join(configDir, 'projects'), (n) => n === `${sessionId}.jsonl`);
    if (!transcript) {
      return { agent: 'claude', status: 'fail', detail: `no transcript ${sessionId}.jsonl under the isolated config dir's projects/ after launch` };
    }
    const before = jsonlLines(transcript);

    // 2. Resume via the REAL wake-executor command builder (zero drift) — and
    //    with the REAL wake turn text (coord-e2e P-009: the resume path of
    //    wake-on-message). The prompt is exactly what executeWake's resume rung
    //    would inject for an always-armed inbox-wake fired by a directed
    //    coord:send {wake:true}, so this leg proves the message-bearing wake
    //    renders in the woken session's transcript, not just that resume works.
    const wakePayload = wakeTurnText({
      id: 9001,
      eventKey: `coord:inbox-wake:${sid}`,
      note: 'always-armed inbox-wake (resume-spawn-live P-009 rung)',
      summary: 'coord:send wake-rung ping — read your inbox',
      payload: null,
    } as DeliveryWork) + ' Reply with the single word AGAIN.';
    const wakeText = tagSmokeTurn(sid, wakePayload, provenanceDir);
    if (!wakeText) {
      return { agent: 'claude', status: 'fail', detail: 'turn-provenance ledger write failed before resume' };
    }
    const cmd = resumeCommandFor({ agent: 'claude', sessionId, ompThreadId: null }, wakeText);
    if (!cmd) return { agent: 'claude', status: 'fail', detail: 'resumeCommandFor returned null for a claude session with a sessionId' };
    log(`  claude: resuming via \`${cmd.bin} ${cmd.args.filter((a) => a !== wakeText).join(' ')} <wake-turn-text>\``);
    const resumeStartedAt = Date.now();
    const resume = run(cmd.bin, cmd.args, { cwd, env });
    const resumeMs = Date.now() - resumeStartedAt;
    if (resume.code !== 0) {
      return { agent: 'claude', status: 'fail', detail: `resume exited ${resume.code}: ${resume.stderr.slice(0, 240)}` };
    }

    // 3. Deterministic proof: the resume appended turns to the SAME transcript —
    //    so `--resume <uuid>` found + continued the exact session (not a new one)
    //    — AND the appended content carries the wake turn (the coord message
    //    reference the woken session acts on).
    const after = jsonlLines(transcript);
    if (after <= before) {
      return { agent: 'claude', status: 'fail', detail: `resume did not grow the session transcript (${before} → ${after} lines) — it did not continue the session` };
    }
    const transcriptText = readFileSync(transcript, 'utf8');
    if (!transcriptText.includes('coord:send wake-rung ping')) {
      return { agent: 'claude', status: 'fail', detail: 'resumed transcript grew but does NOT contain the injected wake turn text — the wake prompt did not reach the session' };
    }
    return {
      agent: "claude",
      status: "pass",
      detail: `resumed exact session ${sessionId.slice(0, 8)}… in ${resumeMs}ms; transcript ${before} → ${after} lines; wake turn text present in the resumed turn`,
    };
  } finally {
    rmSync(configDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(provenanceDir, { recursive: true, force: true });
  }
}

// ── OMP leg ───────────────────────────────────────────────────────────────
function ompLeg(): Leg {
  if (!onPath('omp')) return { agent: 'omp', status: 'skip', detail: 'omp not on PATH' };

  const sid = `smoke-${randomUUID()}`;
  // PI_CODING_AGENT_DIR is the production OMP session-store override. Keeping
  // it isolated proves both fresh and resume resolve the exact same thread
  // without reading or mutating the owner's normal ~/.omp/agent/sessions tree.
  const ompAgentDir = mkdtempSync(join(tmpdir(), 'resume-smoke-omp-agent-'));
  const cwd = mkdtempSync(join(tmpdir(), 'resume-smoke-omp-'));
  const provenanceDir = mkdtempSync(join(tmpdir(), 'resume-smoke-provenance-'));
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: ompAgentDir,
    PAPERCUSP_TURN_PROVENANCE_DIR: provenanceDir,
  };

  try {
    log('  omp: launching a fresh print-mode session…');
    const launchText = tagSmokeTurn(sid, 'Reply with the single word READY.', provenanceDir);
    if (!launchText) {
      return { agent: 'omp', status: 'fail', detail: 'turn-provenance ledger write failed before fresh launch' };
    }
    const launch = run(
      'omp',
      ['--approval-mode', 'yolo', '-p', launchText],
      { cwd, env },
    );
    if (launch.code !== 0) {
      const detail = `${launch.stderr}\n${launch.stdout}`.slice(0, 360);
      if (/unauth|not authenticated|api key|credential|login required/i.test(detail)) {
        return { agent: 'omp', status: 'skip', detail: `OMP is installed but not authenticated: ${detail}` };
      }
      return { agent: 'omp', status: 'fail', detail: `fresh launch exited ${launch.code}: ${detail}` };
    }

    const transcript = findFile(join(ompAgentDir, 'sessions'), (n) => n.endsWith('.jsonl'));
    if (!transcript) {
      return { agent: 'omp', status: 'fail', detail: `no session JSONL under ${join(ompAgentDir, 'sessions')} after launch` };
    }
    const match = transcript.match(/_([0-9a-z-]{8,})\.jsonl$/i);
    if (!match) {
      return { agent: 'omp', status: 'fail', detail: `could not parse an OMP thread id from session file: ${transcript}` };
    }
    const threadId = match[1];
    const before = jsonlLines(transcript);

    const resumeText = tagSmokeTurn(sid, 'Reply with the single word AGAIN.', provenanceDir);
    if (!resumeText) {
      return { agent: 'omp', status: 'fail', detail: 'turn-provenance ledger write failed before resume' };
    }
    const cmd = resumeCommandFor({ agent: 'omp', sessionId: null, ompThreadId: threadId }, resumeText);
    if (!cmd) return { agent: 'omp', status: 'fail', detail: 'resumeCommandFor returned null for an OMP thread id' };
    log(`  omp: resuming via \`${cmd.bin} -r ${threadId.slice(0, 8)}… --approval-mode yolo -p <text>\``);
    const resumeStartedAt = Date.now();
    const resume = run(cmd.bin, cmd.args, { cwd, env });
    const resumeMs = Date.now() - resumeStartedAt;
    if (resume.code !== 0) {
      return { agent: 'omp', status: 'fail', detail: `resume exited ${resume.code}: ${resume.stderr.slice(0, 240)}` };
    }

    const after = jsonlLines(transcript);
    if (after <= before) {
      return { agent: 'omp', status: 'fail', detail: `resume did not grow the session transcript (${before} → ${after} lines)` };
    }
    return { agent: 'omp', status: 'pass', detail: `resumed exact thread ${threadId.slice(0, 8)}… in ${resumeMs}ms; transcript ${before} → ${after} lines` };
  } finally {
    rmSync(ompAgentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(provenanceDir, { recursive: true, force: true });
  }
}

// ── codex leg ─────────────────────────────────────────────────────────────
function codexLeg(): Leg {
  if (!onPath('codex')) return { agent: 'codex', status: 'skip', detail: 'codex not on PATH' };
  if (!isCodexAuthed()) return { agent: 'codex', status: 'skip', detail: 'no ~/.codex/auth.json' };

  const sid = `smoke-${randomUUID()}`;
  // A minimal per-session CODEX_HOME: just the ChatGPT OAuth symlink (the resume
  // rung doesn't need MCP; writeSuCodexHome's full home is exercised elsewhere).
  const codexHome = mkdtempSync(join(tmpdir(), 'resume-smoke-codex-home-'));
  try {
    const realAuth = join(homedir(), '.codex', 'auth.json');
    if (existsSync(realAuth)) symlinkSync(realAuth, join(codexHome, 'auth.json'));
  } catch { /* best-effort */ }
  const cwd = mkdtempSync(join(tmpdir(), 'resume-smoke-codex-'));
  const provenanceDir = mkdtempSync(join(tmpdir(), 'resume-smoke-provenance-'));
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    PAPERCUSP_TURN_PROVENANCE_DIR: provenanceDir,
  };

  const sessionsRoot = join(codexHome, 'sessions');
  const rolloutLines = () => {
    let total = 0;
    findFile(sessionsRoot, (n, full) => {
      if (n.startsWith('rollout-') && n.endsWith('.jsonl')) total += jsonlLines(full);
      return false; // visit all (never "found")
    });
    return total;
  };

  try {
    // 1. Fresh headless session.
    log('  codex: launching a fresh exec session…');
    const launchText = tagSmokeTurn(sid, 'Reply with the single word READY.', provenanceDir);
    if (!launchText) {
      return { agent: 'codex', status: 'fail', detail: 'turn-provenance ledger write failed before fresh launch' };
    }
    const launch = run(
      'codex',
      ['exec', '--dangerously-bypass-approvals-and-sandbox', launchText],
      { cwd, env },
    );
    if (launch.code !== 0) {
      return { agent: 'codex', status: 'fail', detail: `fresh exec exited ${launch.code}: ${launch.stderr.slice(0, 240)}` };
    }
    // Recover the conversation uuid from the rollout filename (rollout-<ts>-<uuid>.jsonl).
    const rollout = findFile(sessionsRoot, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'));
    if (!rollout) {
      return { agent: 'codex', status: 'fail', detail: `no rollout-*.jsonl under ${sessionsRoot} after exec` };
    }
    const m = rollout.match(/rollout-.*-([0-9a-f-]{36})\.jsonl$/i);
    if (!m) return { agent: 'codex', status: 'fail', detail: `could not parse a session uuid from rollout name: ${rollout}` };
    const sessionId = m[1];
    const before = rolloutLines();

    // 2. Resume via the REAL wake-executor builder (`codex exec … resume <uuid>`).
    const resumeText = tagSmokeTurn(sid, 'Reply with the single word AGAIN.', provenanceDir);
    if (!resumeText) {
      return { agent: 'codex', status: 'fail', detail: 'turn-provenance ledger write failed before resume' };
    }
    const cmd = resumeCommandFor({ agent: 'codex', sessionId, ompThreadId: null }, resumeText);
    if (!cmd) return { agent: 'codex', status: 'fail', detail: 'resumeCommandFor returned null for a codex session with a sessionId' };
    log(`  codex: resuming via \`${cmd.bin} ${cmd.args.filter((a) => !a.startsWith('Reply')).join(' ')} <text>\``);
    const resumeStartedAt = Date.now();
    const resume = run(cmd.bin, cmd.args, { cwd, env });
    const resumeMs = Date.now() - resumeStartedAt;
    if (resume.code !== 0) {
      return { agent: 'codex', status: 'fail', detail: `resume exited ${resume.code}: ${resume.stderr.slice(0, 240)}` };
    }

    // 3. Deterministic proof: the home's rollout content grew — the resume ran a
    //    real turn against the session in this CODEX_HOME.
    const after = rolloutLines();
    if (after <= before) {
      return { agent: 'codex', status: 'fail', detail: `resume did not grow the session rollout (${before} → ${after} lines)` };
    }
    return {
      agent: "codex",
      status: "pass",
      detail: `resumed session ${sessionId.slice(0, 8)}… in ${resumeMs}ms; rollout ${before} → ${after} lines`,
    };
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(provenanceDir, { recursive: true, force: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const only = argv.find((a) => a.startsWith('--agent='))?.slice('--agent='.length) || null;

  log(
    "resume-spawn-live — real claude/omp/codex resume rung (EI-153 live-smoke)\n",
  );
  const legs: Leg[] = [];
  if (!only || only === 'claude') legs.push(claudeLeg());
  if (!only || only === "omp") legs.push(ompLeg());
  if (!only || only === 'codex') legs.push(codexLeg());

  log('');
  for (const l of legs) {
    const icon = l.status === 'pass' ? '✅' : l.status === 'skip' ? '⚪' : '❌';
    log(`${icon} ${l.agent}: ${l.status.toUpperCase()} — ${l.detail}`);
  }

  const failed = legs.filter((l) => l.status === 'fail');
  const ran = legs.filter((l) => l.status !== 'skip');
  log('');
  if (failed.length) {
    log(`FAIL — ${failed.length}/${legs.length} leg(s) failed.`);
    process.exit(1);
  }
  if (ran.length === 0) {
    log(
      "SKIP — no authed CLI available (claude/omp/codex). Nothing to verify on this box.",
    );
    process.exit(0);
  }
  log(`OK — ${ran.length} leg(s) verified a real resume continued the exact session.`);
  process.exit(0);
}

main().catch((e) => {
  log(`resume-spawn-live: ${e?.message ?? e}`);
  process.exit(2);
});
