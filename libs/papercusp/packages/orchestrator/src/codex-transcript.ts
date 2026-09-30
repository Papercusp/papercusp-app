/**
 * Codex transcript tee (2026-07-01) — make codex wakes VISIBLE in the hive-tabs
 * mirror panes.
 *
 * The owner's TUI queen/overwatch panes tail a CLAUDE-shaped session transcript
 * located by the roster row's session id (apps/tui/src/transcript.rs). Claude
 * spawns get that for free (`--session-id` + the CLI's own project transcript);
 * codex spawns run `codex exec --ephemeral` and record NOTHING — so after the
 * gpt-5.4 switch both panes sat on "no transcript found — waiting for the next
 * wake…" forever while the agents ran.
 *
 * This tee synthesizes the transcript OURSELVES from the codex `--json` stream
 * the invoke wrapper already captures: one `user` line (the kickoff prompt) +
 * one `assistant` line per `item.completed agent_message` event, in the exact
 * line shape the TUI's `parse_transcript_line` consumes. Written once at end of
 * run to `~/.papercusp/codex-transcripts/<session-uuid>.jsonl` (the uuid the
 * invoke route minted onto the adv_sessions row — PAPERCUSP_NATIVE_SESSION_ID).
 * The TUI locates this as its root 3. Each wake is a fresh uuid, so files are
 * write-once; a retention sweep bounds the directory.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Retain at most this many transcripts (oldest pruned — wakes are frequent). */
const MAX_TRANSCRIPTS = 200;

export function codexTranscriptsDir(home: string = homedir()): string {
  return join(home, '.papercusp', 'codex-transcripts');
}

/** Synthesize claude-session-shaped transcript LINES from a codex --json stream.
 *  Pure; exported for tests. Returns [] when the stream carries no turn (the
 *  caller then writes nothing — the pane keeps the previous wake). */
export function codexTranscriptLines(prompt: string, rawJsonl: string): string[] {
  const lines: string[] = [];
  const p = prompt.trim();
  if (p) {
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: p } }));
  }
  let sawAssistant = false;
  for (const raw of rawJsonl.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const ev = obj as { type?: string; item?: { type?: string; text?: unknown } };
    if (ev?.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
      const text = ev.item.text.trim();
      if (!text) continue;
      sawAssistant = true;
      lines.push(
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
        }),
      );
    }
  }
  return sawAssistant ? lines : [];
}

/**
 * Write the wake's transcript (best-effort — a tee failure must never fail the
 * run). Returns the file path, or null when skipped (no session id / no turn).
 */
export function writeCodexTranscript(opts: {
  sessionId: string | undefined | null;
  prompt: string;
  rawJsonl: string;
  home?: string;
}): string | null {
  const sessionId = opts.sessionId?.trim();
  if (!sessionId) return null;
  try {
    const lines = codexTranscriptLines(opts.prompt, opts.rawJsonl);
    if (lines.length === 0) return null;
    const dir = codexTranscriptsDir(opts.home);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, `${sessionId}.jsonl`);
    writeFileSync(file, `${lines.join('\n')}\n`);
    // Retention: prune oldest beyond the cap (names are uuids, so sort by mtime
    // via readdir order isn't reliable — a simple count-cap with lexical sort is
    // fine here because we only need "bounded", not "exact LRU").
    try {
      const entries = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
      if (entries.length > MAX_TRANSCRIPTS) {
        entries.sort();
        for (const f of entries.slice(0, entries.length - MAX_TRANSCRIPTS)) {
          rmSync(join(dir, f), { force: true });
        }
      }
    } catch {
      /* prune is best-effort */
    }
    return file;
  } catch {
    return null;
  }
}
