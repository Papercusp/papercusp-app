/**
 * wi-6512-replay.ts — the reconstructed WI-6512 investigation, as ONE fixture
 * shared by the two things that replay it.
 *
 * WHY THIS MODULE EXISTS (it is anti-drift, not tidiness):
 *
 * `mid-turn-context.p018-acceptance.test.ts` says, in its own header, that a
 * fixture green in that file is NOT the acceptance case and that "the acceptance
 * number comes from replaying REPLAY against the live endpoint, and from nowhere
 * else." That sentence only holds if the live replay and the test replay are the
 * SAME seven batches. Kept as two copies they would diverge silently — and the
 * divergence would land exactly on the number the plan cites as its acceptance
 * result, where nobody could see it. So REPLAY lives here, and both importers
 * read it.
 *
 * PROVENANCE — the raw transcript jsonl is GONE (checked 2026-08-02: absent from
 * ~/.claude/projects and ~/.papercusp), and `session_turns` stores assistant
 * prose only, no tool rows. The sequence is RECONSTRUCTED, not captured, from the
 * two records that survived:
 *
 *   • session 0f7b47b5-df90-4821-b482-b0363b9834c0, turns 63-69
 *     (2026-07-27T23:13:08Z → 23:15:05Z) — each turn's prose names what that step
 *     did ("Let me find what that dropdown actually calls", "timing the two hops
 *     the modal makes", "421k turns, 2.2 GB", …);
 *   • WI-6512's body, which enumerates the concrete measurements and names
 *     `sessions/read.ts:104`, `sessions:list`, `harness_shared.session_turns`,
 *     `AgentsRunningPill` / `SwarmTab` / `SessionChatModal`.
 *
 * Every symbol and path below appears in one of those two records, and all of
 * them exist in the tree today. Thirteen calls across seven batches; the plan's
 * "~20" counts the whole detour including the filing turns, which carry no
 * investigation signal and are not replayed.
 *
 * ⚠ DO NOT "fix" a batch to make a measurement move. The point of the replay is
 * that the batches are fixed and the RETRIEVAL is the variable.
 */
import type { BatchCall } from '../../endpoint-route/routes/agent-mcp/mid-turn-context';

/** The work-item the investigation produced — what a later agent should be handed. */
export const KNOWN_ITEM = 'WI-6512';

/**
 * ═══ THE SCORING CRITERION, AND WHY THERE ARE TWO ═══════════════════════════
 *
 * The acceptance claim is behavioural: the push "saves the other twelve calls".
 * A record saves them if it tells the investigating agent to stop. That is NOT
 * the same as "the block contains the string WI-6512", and the difference is not
 * academic — measured 2026-08-03 against the live endpoint, a batch handed back
 * the COMPLETE recorded diagnosis (`5fecf95a`, "THE PATH IS NOT POSTGRES", with
 * the timings and the ruled-out list) and scored a MISS, because that record's
 * text never names the work-item. Scoring on the id alone measures record
 * IDENTITY and calls it relevance.
 *
 * So both criteria are reported, always:
 *
 *   STRICT  — the literal `WI-6512`. Narrow and often wrong about what the agent
 *             actually received, but it is what the 2026-08-03 baseline of
 *             "1 of 7" was measured under, so it is the ONLY criterion that
 *             compares like-for-like against that number. Keep it for that.
 *
 *   ANSWER  — any record in ANSWER_RECORDS below. This is the criterion that
 *             matches the acceptance claim. It is NOT comparable to the 1-of-7
 *             baseline (the baseline was never scored this way), so it must
 *             never be quoted as an improvement ON that number.
 *
 * ⚠ ANSWER is a WIDER criterion, so it scores higher by construction. That makes
 * it exactly the sort of change that can launder a null result into a pass. It
 * is defensible here only because the set below is ENUMERATED BY ID with a
 * stated reason each — not a keyword match that can drift to fit a result. Every
 * record was verified present in the live store on 2026-08-03, and all four
 * predate the 1-of-7 baseline, so this re-scores the same population rather than
 * measuring a new one. If you add to this set, add the reason too.
 */
export interface AnswerRecord {
  /** Substring that identifies the record in a rendered block. */
  marker: string;
  /** Why receiving THIS record would stop the investigation. */
  why: string;
}

export const ANSWER_RECORDS: AnswerRecord[] = [
  {
    marker: KNOWN_ITEM,
    why: 'the work-item itself — DB ruled out with measurements, "look at the UI transport path"',
  },
  {
    marker: '5fecf95a-edf9-4430-8585-490574690df1',
    why: 'mem0 reference, the full 2026-07-27 diagnosis: "THE PATH IS NOT POSTGRES", SSE + on-disk JSONL, with the ruled-out list',
  },
  {
    marker: '58b75895-c7eb-4373-8780-de91889fd22d',
    why: 'mem0 project: names the libsoup 6-connection cap AND the existing fix, and says outright it "has been re-derived from scratch at least three times because agents investigate before they search"',
  },
  {
    marker: '980ce692-1376-474c-a437-ef11393b53cf',
    why: 'mem0 project: "THE ROOT CAUSE WAS ALREADY FOUND AND ALREADY FIXED IN CODE ~2026-05-20→06-01. Do NOT re-derive it."',
  },
];

/** Does this rendered block hand back something that would stop the investigation? */
export const carriesAnswer = (block: string): AnswerRecord | undefined =>
  ANSWER_RECORDS.find((r) => block.includes(r.marker));

/** A batch as the PostToolBatch hook delivers it, plus why that turn happened. */
export interface ReplayBatch {
  turn: number;
  why: string;
  calls: BatchCall[];
}

const NO_MATCH = 'No matches found';

/** Seven batches, in execution order — session 0f7b47b5 turns 63-69. */
export const REPLAY: ReplayBatch[] = [
  {
    turn: 63,
    why: 'Now bug #1 — the slow session-history load. Let me find what that dropdown actually calls.',
    calls: [
      {
        tool: 'Grep',
        toolInput: { pattern: 'agents running', path: 'apps/operator-vite/src' },
        toolResponse: 'apps/operator-vite/src/components/adv/AgentsRunningPill.tsx',
      },
      {
        tool: 'Read',
        toolInput: { file_path: 'apps/operator-vite/src/components/adv/AgentsRunningPill.tsx' },
        toolResponse: 'export function AgentsRunningPill() { … }',
      },
      {
        tool: 'Grep',
        toolInput: { pattern: 'session history', path: 'apps/operator-vite/src' },
        toolResponse: NO_MATCH,
      },
    ],
  },
  {
    turn: 64,
    why: 'Let me measure rather than guess — timing the two hops the modal makes.',
    calls: [
      {
        tool: 'Bash',
        toolInput: {
          command: "curl -s -o /dev/null -w '%{time_total}' http://127.0.0.1:3170/api/agent-mcp/sessions-list",
          description: 'time the sessions:list hop',
        },
        toolResponse: '0.031',
      },
      {
        tool: 'Bash',
        toolInput: {
          command:
            'psql -c "EXPLAIN ANALYZE SELECT turn_idx, speaker FROM harness_shared.session_turns WHERE session_id = $1"',
          description: 'time the session history query itself',
        },
        toolResponse: 'Execution Time: 75.041 ms',
      },
    ],
  },
  {
    turn: 65,
    why: '`sessions:list` is fast (20–40ms). So the cost is the second hop — the transcript read. Let me find it.',
    calls: [
      {
        tool: 'Grep',
        toolInput: { pattern: 'session_turns', path: 'packages/operator-core/lib/agent-tools/sessions' },
        toolResponse: 'read.ts:104: FROM harness_shared.session_turns',
      },
      {
        tool: 'Read',
        toolInput: { file_path: 'packages/operator-core/lib/agent-tools/sessions/read.ts' },
        toolResponse:
          'const rows = await sql`SELECT source_kind, turn_idx, speaker, owner, ts, left(text,1500) …`',
      },
    ],
  },
  {
    turn: 66,
    why: '421k turns, 2.2 GB — with a 1536-dim embedding column and a tsvector per row.',
    calls: [
      {
        tool: 'Bash',
        toolInput: {
          command: 'psql -c "SELECT pg_size_pretty(pg_total_relation_size(\'harness_shared.session_turns\'))"',
          description: 'how big is session_turns',
        },
        toolResponse: '2243 MB',
      },
    ],
  },
  {
    turn: 67,
    why: 'a busy session carries 10 MB of embeddings + 7.5 MB of tsvector against 5 MB of actual text.',
    calls: [
      {
        tool: 'Bash',
        toolInput: {
          command:
            'psql -c "SELECT sum(pg_column_size(text_embedding)), sum(pg_column_size(text_tsv)) FROM harness_shared.session_turns WHERE session_id = $1"',
          description: 'how much of a busy session is search-index payload',
        },
        toolResponse: '10485760 | 7864320',
      },
    ],
  },
  {
    turn: 68,
    why: "`sessions:read` is already narrow — not the culprit. But that ORDER BY CASE can't use an index.",
    calls: [
      {
        tool: 'Grep',
        toolInput: {
          pattern: 'text_embedding|text_tsv',
          path: 'packages/operator-core/lib/agent-tools/sessions/read.ts',
        },
        toolResponse: NO_MATCH,
      },
      {
        tool: 'Read',
        toolInput: { file_path: 'packages/operator-core/lib/agent-tools/sessions/read.ts' },
        toolResponse: 'ORDER BY CASE WHEN $2 THEN turn_idx END DESC, turn_idx ASC',
      },
    ],
  },
  {
    turn: 69,
    why: 'The DB is not the bottleneck: 75 ms for the worst session on the box (7,622 turns).',
    calls: [
      {
        tool: 'Bash',
        toolInput: {
          command:
            'psql -c "EXPLAIN (ANALYZE, BUFFERS) SELECT source_kind, turn_idx, speaker, owner, ts, left(text,1500) FROM harness_shared.session_turns WHERE session_id = $1 ORDER BY CASE WHEN $2 THEN turn_idx END DESC, turn_idx ASC LIMIT 400"',
          description: 'measure the exact sessions:read query shape on the worst session',
        },
        toolResponse: 'Execution Time: 75.412 ms',
      },
    ],
  },
];
