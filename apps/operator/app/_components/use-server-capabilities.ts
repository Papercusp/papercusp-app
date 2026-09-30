'use client';

/**
 * Fetches the palette-eligible server tool catalog (`GET /api/agent-mcp/capabilities`)
 * and turns it into executable palette `Command`s (P-004 client half).
 *
 * Execution goes through `POST /api/agent-mcp/run-tool` — loopback-only,
 * fully gated + audited server-side. Destructive/high-risk tools come back
 * `eligibility: 'confirm'`; their `perform` asks the server (which 409s
 * without `confirmed`), then surfaces a sonner confirm-action before re-running
 * with `confirmed:true`. Args are always `{}` — the §3 filter only admits
 * no-required-arg tools in Phase 1 (arg prompting is Phase 2 / P-012).
 *
 * Fetches once, the first time the palette opens. On any failure (e.g. a
 * non-desktop browser where the principal doesn't resolve, or the route not
 * yet live) it degrades silently to the Action-Registry commands only.
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { Command } from './CommandPalette';

type Eligibility = 'fire-and-toast' | 'confirm';

interface ServerCapabilityDTO {
  id: string;
  title: string;
  description: string;
  eligibility: Eligibility;
}

// All server tools live in one palette section. The group is carried in each
// row's title (e.g. "Goals: List", see humanizeCapabilityId) so a flat, sorted
// list stays self-describing — per-group sub-sections produced one heading per
// single-item group, which reads worse than a single "Agent tools" group.
const SERVER_TOOLS_SECTION = 'Agent tools';

async function runServerCapability(name: string, confirmed: boolean): Promise<void> {
  try {
    const res = await fetch('/api/agent-mcp/run-tool', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, args: {}, confirmed }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      message?: string;
    };
    // Server says this needs confirmation — surface a confirm action rather
    // than firing. (Defense in depth: the server, not the client, decides.)
    if (res.status === 409 && data.error === 'confirmation_required') {
      toast(`Run “${name}”? This action is destructive or high-risk.`, {
        action: { label: 'Run anyway', onClick: () => void runServerCapability(name, true) },
      });
      return;
    }
    if (!res.ok || data.ok === false) {
      toast.error(`${name}: ${data.message ?? data.error ?? res.statusText}`);
      return;
    }
    toast.success(`Ran ${name}`);
  } catch (e) {
    toast.error(`${name}: ${e instanceof Error ? e.message : 'request failed'}`);
  }
}

export function useServerCapabilityCommands(open: boolean): Command[] {
  const [commands, setCommands] = useState<Command[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/agent-mcp/capabilities');
        if (!res.ok) {
          if (!cancelled) setLoaded(true);
          return;
        }
        const data = (await res.json()) as { capabilities?: ServerCapabilityDTO[] };
        if (cancelled) return;
        const mapped: Command[] = (data.capabilities ?? []).map((c) => ({
          id: c.id,
          title: c.title,
          subtitle: c.description,
          section: SERVER_TOOLS_SECTION,
          keywords: `${c.id} ${c.description}`,
          icon: c.eligibility === 'confirm' ? '⚠' : '⚙',
          perform: () => void runServerCapability(c.id, false),
        }));
        setCommands(mapped);
        setLoaded(true);
      } catch {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, loaded]);

  return commands;
}
