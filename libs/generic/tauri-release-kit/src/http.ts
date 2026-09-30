/**
 * A real `HttpGetPort` (incremental-publish.ts) backed by the platform global
 * `fetch` — Node 18+ ships one built in, so this stays a zero-runtime-dep
 * kit. Never throws: a network error, a non-2xx, or any other failure reads
 * as "no live manifest yet" (null), matching the ordinary first-publish case
 * — the caller decides what that means, this just reports it.
 */
import type { HttpGetPort } from './incremental-publish.js';

export const fetchHttpGetPort: HttpGetPort = {
  async getText(url: string): Promise<string | null> {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  },
};
