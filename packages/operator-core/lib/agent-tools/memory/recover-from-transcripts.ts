/**
 * memory:recover-from-transcripts — retroactive recovery of memory writes
 * lost to an embedder/store outage (memory-write-journal-auto-recovery P-008).
 *
 * The write-ahead journal (write-journal.ts) makes NEW losses impossible, but
 * anything lost BEFORE the journal existed — or through any hole the journal
 * itself misses — survives in exactly one place: the calling agent's session
 * transcript, as a memory:remember/update tool_use whose tool_result reported
 * a failure. This tool productizes the 2026-07-10 forensic pass (scratch
 * mine-failed-remembers.py: 74 transcripts → 14 error results → 10 genuinely
 * lost → 2 recovered): it scans session transcripts for failed memory-write
 * pairs, filters out writes the same session later retried successfully,
 * and — on confirm — parks the survivors in the journal with
 * source='transcript-miner', so the standard drain replays them behind its
 * near-dup guard and provenance tagging. DRY-RUN BY DEFAULT: without
 * `confirm:true` it only reports candidates.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { journalPendingWrite } from '../../memory/write-journal';
import { isMemoryPaused, MEMORY_PAUSED_REFUSAL } from '../../memory/memory-pause';
import { detectPossibleSecrets } from '../../memory/secret-detect';

/** Failure signatures a lost write's tool_result carries (the live classes
 *  observed in the 2026-07-10 forensic pass + the remember.ts envelope set). */
const FAIL_PAT =
  /memory_timeout|embedder unavailable|openai_embed_|insufficient_quota|memory_unavailable|mem0_unavailable|memory backend unavailable/i;
const TOOL_PAT = /memory[_:](remember|update)$/;
/** Skip transcript files larger than this — a runaway log, not a session. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export interface RecoveryCandidate {
  session: string;
  ts: string;
  tool: string;
  reason: string;
  content: string;
  scope: string;
  kind?: string;
  updateOf?: string;
  retriedOkSameSession: boolean;
  /** The failed result already carried the write-ahead journal's stamp
   *  (`journaled:true`) — the drain will re-store it, so it is PARKED, not lost;
   *  the handler excludes these from recovery candidates (re-mining would just
   *  double-journal the same fact). */
  alreadyJournaled: boolean;
}

function transcriptsRoot(): string {
  return (
    process.env.PAPERCUSP_SESSION_TRANSCRIPTS_DIR ??
    path.join(os.homedir(), '.papercusp', 'session-claude')
  );
}

async function* walkJsonl(dir: string, newerThanMs: number, depth = 0): AsyncGenerator<string> {
  if (depth > 6) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkJsonl(p, newerThanMs, depth + 1);
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      try {
        const st = await fs.stat(p);
        if (st.mtimeMs >= newerThanMs && st.size <= MAX_FILE_BYTES) yield p;
      } catch {
        /* raced deletion — skip */
      }
    }
  }
}

/** Escape-tolerant failure check: transcripts store tool results both as raw
 *  JSON and as escaped-JSON-in-a-string (`\"ok\":false`) — the exact miss
 *  that made the first forensic grep return 0 (2026-07-10). */
function looksFailed(text: string, isError: boolean | undefined): boolean {
  if (isError) return true;
  const squashed = text.replace(/[\\\s]/g, '');
  return squashed.includes('"ok":false') || FAIL_PAT.test(text);
}

/** A modern failed write already carries the write-ahead journal's stamp
 *  (`journaled:true`, set by remember.ts whenever journalPendingWrite returned
 *  an id): the drain WILL re-store it, so the fact is parked — NOT lost — and
 *  re-mining it just double-journals the same content. Only failures WITHOUT
 *  the stamp are genuinely at-risk: journalId was null (journaling itself
 *  degraded) or the transcript predates the journal — precisely "the hole the
 *  journal itself misses" this tool exists to backfill. Escape-tolerant,
 *  mirroring looksFailed's squashed form (`\"journaled\":true`). */
function wasJournaled(text: string): boolean {
  return text.replace(/[\\\s]/g, '').includes('"journaled":true');
}

function scopeOfInput(input: Record<string, unknown>): string {
  if (typeof input.hive_slug === 'string' && input.hive_slug) return `hive:${input.hive_slug}`;
  if (typeof input.harness_slug === 'string' && input.harness_slug) return `harness:${input.harness_slug}`;
  return ''; // per-user default — resolved at journal time below
}

/** Mine ONE transcript file for failed memory-write pairs. Exported for the
 *  unit test; the tool handler drives it over the whole transcripts tree. */
export async function mineTranscript(file: string): Promise<RecoveryCandidate[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const session = path.basename(file, '.jsonl');
  const openCalls = new Map<string, { name: string; input: Record<string, unknown>; ts: string }>();
  const failed: RecoveryCandidate[] = [];
  const succeeded: string[] = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const msg = (rec.message ?? {}) as { content?: unknown };
    if (!Array.isArray(msg.content)) continue;
    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : '';
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use' && typeof block.name === 'string' && TOOL_PAT.test(block.name)) {
        openCalls.set(String(block.id), {
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
          ts,
        });
      } else if (block.type === 'tool_result' && openCalls.has(String(block.tool_use_id))) {
        const call = openCalls.get(String(block.tool_use_id))!;
        openCalls.delete(String(block.tool_use_id));
        const rc = block.content;
        const text = Array.isArray(rc)
          ? rc.map((c) => (c && typeof c === 'object' ? String((c as { text?: unknown }).text ?? '') : '')).join(' ')
          : typeof rc === 'string'
            ? rc
            : '';
        const content =
          typeof call.input.content === 'string' ? call.input.content
          : typeof call.input.text === 'string' ? call.input.text : '';
        if (!content) continue;
        if (looksFailed(text, block.is_error === true)) {
          const m = FAIL_PAT.exec(text);
          failed.push({
            session,
            ts: call.ts,
            tool: call.name,
            reason: (m?.[0] ?? 'ok:false').slice(0, 80),
            content,
            scope: scopeOfInput(call.input),
            ...(typeof call.input.kind === 'string' ? { kind: call.input.kind } : {}),
            ...(call.name.endsWith('update') && typeof call.input.id === 'string'
              ? { updateOf: call.input.id }
              : {}),
            retriedOkSameSession: false,
            alreadyJournaled: wasJournaled(text),
          });
        } else {
          succeeded.push(content);
        }
      }
    }
  }
  for (const f of failed) {
    f.retriedOkSameSession = succeeded.some((s) => s.slice(0, 120) === f.content.slice(0, 120));
  }
  return failed;
}

export default defineTool({
  name: 'memory:recover-from-transcripts',
  capability: 'memory:write',
  description:
    'Retroactively recover memory writes lost to an embedder/store outage by mining session transcripts for FAILED memory:remember/update calls. DRY-RUN by default (lists candidates); confirm:true parks them in the write-ahead journal so the standard drain re-stores them (near-dup-guarded, provenance-tagged) within ~5 minutes.',
  guidance: {
    when:
      'After a memory outage window that predates the write-ahead journal, or when an agent reports a fact it saved was never stored. Run once WITHOUT confirm to review candidates, then re-run with confirm:true.',
    notWhen:
      'Not for live writes — memory:remember journals its own failures now (the envelope says journaled:true). Not a search tool.',
    chaining:
      'dry-run → review candidates → { confirm:true } → journal drain lands them within ~5 min (memory:search then finds them; recovered entries carry metadata.recovered_from).',
    seeAlso: ['memory:remember (live writes self-journal on failure)', 'memory:list (verify recovery)'],
  },
  crossWorkspace: true,
  args: z.object({
    window_hours: z.number().min(1).max(24 * 30).default(48)
      .describe('How far back to scan transcripts (by file mtime). Default 48h.'),
    confirm: z.boolean().default(false)
      .describe('false (default): dry-run, list candidates only. true: journal the candidates for automatic re-store.'),
    limit: z.number().min(1).max(200).default(50)
      .describe('Max candidates returned/journaled (oldest first).'),
  }),
  async handler(args) {
    const cutoff = Date.now() - args.window_hours * 3_600_000;
    const all: RecoveryCandidate[] = [];
    for await (const file of walkJsonl(transcriptsRoot(), cutoff)) {
      all.push(...(await mineTranscript(file)));
    }

    // Drop writes the same session already retried successfully, OR that the
    // write-ahead journal already parked (journaled:true — the drain re-stores
    // them, so re-mining would double-journal the same fact), then dedup across
    // sessions by content prefix (keep the earliest), oldest first.
    const alreadyJournaled = all.filter((c) => c.alreadyJournaled).length;
    const seen = new Set<string>();
    const candidates = all
      .filter((c) => !c.retriedOkSameSession && !c.alreadyJournaled)
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .filter((c) => {
        const key = c.content.slice(0, 120);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, args.limit);

    if (!args.confirm) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            mode: 'dry-run',
            scanned_failures: all.length,
            already_journaled: alreadyJournaled,
            candidates: candidates.map((c) => ({
              session: c.session, ts: c.ts, tool: c.tool, reason: c.reason,
              scope: c.scope || '(per-user default)',
              content_preview: c.content.slice(0, 300),
              ...(c.updateOf ? { update_of: c.updateOf } : {}),
            })),
            hint: 'Re-run with confirm:true to journal these for automatic re-store (drain lands them within ~5 minutes, near-dup-guarded).',
          }),
        }],
      };
    }

    const { getSessionUserOrDefault } = await import('../../auth');
    const user = await getSessionUserOrDefault();
    // EI-10355: honour the user's memory PAUSE here too. This path bulk-mines
    // facts out of transcripts — exactly the "remembered about me without
    // asking" class the pause exists to stop. Checked before the journal loop
    // so a paused run parks nothing for the drain to replay.
    if (await isMemoryPaused(user.id)) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ...MEMORY_PAUSED_REFUSAL, recovered: 0, candidates: candidates.length }) }],
      };
    }
    let journaled = 0;
    const failedToJournal: string[] = [];
    for (const c of candidates) {
      // EI-10371 stage 1: transcripts are exactly where leaked credentials
      // live (env dumps, pasted connection strings) — flag at journal time so
      // the drained row lands already stamped.
      const secrets = detectPossibleSecrets(c.content);
      const id = await journalPendingWrite({
        scope: c.updateOf ? `__update__:${c.updateOf}` : c.scope || user.id,
        ...(c.kind ? { kind: c.kind } : {}),
        content: c.content,
        metadata: {
          ...(c.updateOf ? { __journal_update_of: c.updateOf } : {}),
          ...(secrets.matched
            ? { possible_secret: true, possible_secret_classes: secrets.classes }
            : {}),
          recovered_from: 'transcript-miner',
          recovered_session: c.session,
          recovered_original_ts: c.ts,
          recovered_failure_reason: c.reason,
        },
        verbatim: true,
        source: 'transcript-miner',
      });
      if (id) journaled += 1;
      else failedToJournal.push(c.session);
    }
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: failedToJournal.length === 0,
          mode: 'journaled',
          journaled,
          already_journaled: alreadyJournaled,
          ...(failedToJournal.length > 0 ? { failed_to_journal: failedToJournal.length } : {}),
          hint: 'The embed-backfill drain re-stores these within ~5 minutes; recovered entries carry metadata.recovered_from = transcript-miner. Verify via memory:search.',
        }),
      }],
    };
  },
});
