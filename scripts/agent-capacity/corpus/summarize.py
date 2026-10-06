#!/usr/bin/env python3
"""Summarize the recorded agent-capacity corpus into the table in SUMMARY.md.

    python3 scripts/agent-capacity/corpus/summarize.py [corpus-dir]

corpus-dir defaults to ~/.cache/agent-capacity/corpus (one directory per recorded
session, written by scripts/agent-capacity/record-session.ts). A task recorded more
than once (a retry) counts once: the latest clean recording if there is one, else
the latest recording. Plan agent-capacity-and-cost-gcp-2026-09-30, P-002.
"""
import collections
import glob
import json
import os
import statistics
import sys

root = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else '~/.cache/agent-capacity/corpus')
recorded = []
for meta_path in sorted(glob.glob(os.path.join(root, '*', 'meta.json'))):
    m = json.load(open(meta_path))
    d = os.path.dirname(meta_path)
    errs = req_bytes = 0
    for line in open(os.path.join(d, 'exchanges.jsonl')):
        e = json.loads(line)
        errs += e.get('status') != 200
        req_bytes += e['req']['bytes']
    recorded.append(dict(
        id=m['sessionId'], cli=m['cli'], ver=m.get('cliVersion'), repo=m['repo']['name'],
        prof=m['task']['profile'], task=m['task']['id'],
        ok=m['exitCode'] == 0 and not m['timedOut'], to=m['timedOut'], wall=m['wallMs'] / 1000,
        ex=m['exchanges'], tools=m.get('toolCalls') or {}, errs=errs, reqb=req_bytes,
    ))

by_task = collections.defaultdict(list)
for r in recorded:
    by_task[(r['cli'], r['task'])].append(r)
rows = []
for runs in by_task.values():
    runs.sort(key=lambda r: r['id'])  # ids end in a UTC timestamp, so this is chronological
    clean = [r for r in runs if r['ok']]
    rows.append(clean[-1] if clean else runs[-1])
superseded = sorted(r['id'] for r in recorded if r not in rows)

print(f"recordings={len(recorded)} tasks={len(rows)} clean={sum(r['ok'] for r in rows)} "
      f"timedOut={sum(r['to'] for r in rows)} superseded={len(superseded)}")
print('cli versions:', ', '.join(f'{c} {v}' for c, v in sorted({(r['cli'], r['ver']) for r in rows})))
print()
print('| cli | repo | profile | clean/tasks | exchanges (median, max) | tool calls (total by kind) '
      '| wall s (median, max) | non-200 exchanges | request MB (median) |')
print('|---|---|---|---|---|---|---|---|---|')
groups = collections.defaultdict(list)
for r in rows:
    groups[(r['cli'], r['repo'], r['prof'])].append(r)
for key in sorted(groups):
    rs = groups[key]
    ok = [r for r in rs if r['ok']] or rs
    tools = collections.Counter()
    for r in ok:
        tools.update(r['tools'])
    print(f"| {key[0]} | {key[1]} | {key[2]} | {sum(r['ok'] for r in rs)}/{len(rs)} "
          f"| {statistics.median(r['ex'] for r in ok):.0f}, {max(r['ex'] for r in ok)} "
          f"| {', '.join(f'{a} {b}' for a, b in tools.most_common())} "
          f"| {statistics.median(r['wall'] for r in ok):.0f}, {max(r['wall'] for r in ok):.0f} "
          f"| {sum(r['errs'] for r in rs)} | {statistics.median(r['reqb'] for r in ok) / 1e6:.2f} |")
print()
print('timed out (kept, truncated at the cap):', [(r['id'], round(r['wall'])) for r in rows if r['to']])
print('superseded by a later recording:', superseded)
