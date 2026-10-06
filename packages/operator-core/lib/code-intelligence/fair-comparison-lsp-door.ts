/**
 * The `LspDoor` the P-017 `lsp-query` arm runs through in a real comparison:
 * the production LSP adapter (the engine behind the `lsp:query` tool), called
 * in-process. Kept apart from fair-comparison-first-party.ts so the arm and its
 * tests never load the adapter's Postgres-backed capability store.
 */
import { readFileSync, readdirSync } from 'node:fs';
import type { LspDoor } from './fair-comparison-first-party';
import { lspClientInventory, lspQuery, lspWorkspaceSymbols, shutdownAllLspClients } from './lsp-adapter';

/** Pids of `pid` and every descendant, from /proc (Linux). */
function processTree(pid: number): number[] {
  const children = new Map<number, number[]>();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      children.set(ppid, [...(children.get(ppid) ?? []), Number(entry)]);
    } catch {
      /* the process exited while we walked */
    }
  }
  const out: number[] = [];
  const stack = [pid];
  while (stack.length > 0) {
    const p = stack.pop()!;
    out.push(p);
    stack.push(...(children.get(p) ?? []));
  }
  return out;
}

/** Sum of VmHWM (peak resident set, kB) over a process tree; null when nothing was readable. */
export function treePeakRssKb(pid: number): number | null {
  let total = 0;
  let read = false;
  for (const p of processTree(pid)) {
    try {
      const m = /^VmHWM:\s+(\d+)\s+kB/m.exec(readFileSync(`/proc/${p}/status`, 'utf8'));
      if (m) {
        total += Number(m[1]);
        read = true;
      }
    } catch {
      /* exited */
    }
  }
  return read ? total : null;
}

export function createLspAdapterDoor(): LspDoor {
  return {
    workspaceSymbols: ({ name, rootPath, anchor, limit }) => lspWorkspaceSymbols({ name, rootPath, anchor, limit, language: 'typescript' }),
    references: (q) => lspQuery('references', q),
    async serverPeakRssKb() {
      const pids = lspClientInventory().map((c) => c.pid).filter((p): p is number => p !== null);
      if (pids.length === 0) return null;
      const peaks = pids.map(treePeakRssKb).filter((k): k is number => k !== null);
      return peaks.length > 0 ? peaks.reduce((a, b) => a + b, 0) : null;
    },
    async close() {
      await shutdownAllLspClients();
    },
  };
}
