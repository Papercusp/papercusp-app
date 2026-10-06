# Workload corpus — recorded sessions (P-002)

Plan `agent-capacity-and-cost-gcp-2026-09-30`, item P-002. Recorded 2026-09-30 on the
tower through `scripts/agent-capacity/record-session.ts` (recording proxy in front of the
inference gateway). The P-003 load driver (`load-driver.ts`, `replay-server.ts`) replays
these sessions against a fake model server.

- **Repos** (pinned, from `tasks.json`):
  - excalidraw, TypeScript web app: `https://github.com/excalidraw/excalidraw.git` @ `35e854ec`
  - mealie, Python service: `https://github.com/mealie-recipes/mealie.git` @ `7e03d041`
- **Tasks:** 20 in `tasks.json` (10 per repo: 4 light, 4 typical, 2 heavy), each run once
  per CLI. Time caps: light 300 s, typical 900 s, heavy 1800 s.
- **CLIs:** Claude Code 2.1.284 and codex-cli 0.159.2.
- **Recordings:** 42 = 40 tasks + 2 retries. **39 of 40 tasks are clean.** One task is
  kept truncated at its cap (below).
- **Where the data is:** `~/.cache/agent-capacity/corpus/` on the tower (40 MB, one
  directory per session: `meta.json`, `exchanges.jsonl`, `cli.jsonl`, `diff.patch`),
  mirrored to `gs://pc-agent-capacity-0930-artifacts/corpus/`.

Regenerate the table with `python3 scripts/agent-capacity/corpus/summarize.py`.

| cli | repo | profile | clean/tasks | exchanges (median, max) | tool calls (total by kind) | wall s (median, max) | non-200 exchanges | request MB (median) |
|---|---|---|---|---|---|---|---|---|
| claude | excalidraw | heavy | 2/2 | 11, 16 | Bash 17, WebFetch 1 | 253, 366 | 2 | 0.79 |
| claude | excalidraw | light | 4/4 | 8, 10 | Bash 13, Agent 4, bash 4, Read 3, WebSearch 2, Edit 1 | 130, 286 | 4 | 0.38 |
| claude | excalidraw | typical | 4/4 | 8, 9 | Bash 18, Write 1, WebSearch 1, Read 1 | 97, 130 | 4 | 0.43 |
| claude | mealie | heavy | 1/2 | 11, 11 | Bash 9 | 1400, 1400 | 2 | 1.17 |
| claude | mealie | light | 4/4 | 6, 8 | Read 9, Bash 6, Agent 2, Edit 2 | 39, 63 | 4 | 0.38 |
| claude | mealie | typical | 4/4 | 8, 13 | Bash 26, Edit 1 | 243, 598 | 4 | 0.66 |
| codex | excalidraw | heavy | 2/2 | 12, 12 | command_execution 26 | 221, 263 | 0 | 1.13 |
| codex | excalidraw | light | 4/4 | 5, 6 | command_execution 14, file_change 1 | 84, 153 | 2 | 0.31 |
| codex | excalidraw | typical | 4/4 | 8, 9 | command_execution 29, file_change 4 | 132, 363 | 4 | 0.55 |
| codex | mealie | heavy | 2/2 | 65, 69 | command_execution 105, file_change 2 | 935, 1065 | 4 | 13.10 |
| codex | mealie | light | 4/4 | 6, 9 | command_execution 18, file_change 2 | 79, 104 | 3 | 0.42 |
| codex | mealie | typical | 4/4 | 24, 26 | command_execution 54, file_change 4 | 255, 311 | 9 | 2.38 |

## Notes for the replay and the capacity numbers

- **One task outruns its cap, deterministically.** `claude mea-heavy-1` ("run the whole
  test suite, then the linters, fix and re-run") timed out at 1800 s on both attempts, with
  5 exchanges each time. It is not a hang: it runs the full mealie suite repeatedly, and
  the fifth run was killed (exit 137) by the cap. The corpus keeps the later recording,
  truncated at the cap. Replay reproduces those 5 exchanges; treat it as a lower bound on
  a heavy session's length.
- **Retries:** `codex exc-light-4` timed out at 326 s the first time and passed on retry
  (66 s). The table counts the retry.
- **Non-200 exchanges are real and kept.** 21 Codex exchanges are gateway 502s that the
  CLI retried, and 21 Claude exchanges are the CLI's startup `HEAD /api/hello` getting a
  404 from the proxy. Both replay faithfully, so replayed load includes the retry traffic.
- **Claude used sub-agents** (`Agent`, 6 calls in light tasks). Those turns are in the
  recording as ordinary model exchanges from the same CLI process.
- **Heaviest request volume:** Codex on mealie heavy (median 13 MB of request bodies per
  session, 65 exchanges). This shape is the worst case for the gateway and network side.
