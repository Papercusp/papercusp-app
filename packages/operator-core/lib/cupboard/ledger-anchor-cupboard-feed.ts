/**
 * The Cupboard Worker's D1 chain links as an anchor-log feed
 * (agent-economy-flywheel-2026-08-30 D-027, WI-10004676).
 *
 * The Worker's commerce and treasury streams are hash-chained in D1
 * (ledger_chain_links, P-040), not in Postgres, so pgAnchorLinkFeed cannot see
 * them. This feed pages GET /commerce/ledger-chain/links with the same HMAC the
 * reconciliation run uses (D-025 §4), signing path AND query so a signature is
 * bound to its page.
 *
 * Workspace binding (D-027 §3): the links belong only to the treasury
 * workspace, and the Worker must report that same workspace. Any other
 * workspace gets no links; a mismatch throws, so the union reports it instead
 * of filing links under the wrong log.
 */
import type { AnchorLeaf, AnchorLinkFeed } from './ledger-anchor';
import { LEDGER_CHAIN_LINKS_PATH, RECONCILIATION_SIGNATURE_HEADER, signReconciliationRequest } from './reconciliation-hmac';

const HEX64 = /^[0-9a-f]{64}$/;

/** Hard stop on a misbehaving cursor; 1000 pages of 1000 links is far beyond test volumes. */
export const CUPBOARD_LINK_FEED_MAX_PAGES = 1000;

export interface CupboardAnchorLinkFeedConfig {
  readonly baseUrl: string;
  readonly secret: string;
  /** The operator workspace whose log holds the Worker's links. */
  readonly treasuryWorkspace: string;
  readonly pageSize?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

function parseLink(raw: unknown): AnchorLeaf | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.streamId !== 'string' || !r.streamId) return null;
  if (typeof r.seq !== 'number' || !Number.isSafeInteger(r.seq) || r.seq < 0) return null;
  if (typeof r.entryHash !== 'string' || !HEX64.test(r.entryHash)) return null;
  return { streamId: r.streamId, seq: r.seq, entryHash: r.entryHash };
}

export function cupboardAnchorLinkFeed(cfg: CupboardAnchorLinkFeedConfig): AnchorLinkFeed {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const now = cfg.now ?? Date.now;
  const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  return {
    async links(workspaceId) {
      if (workspaceId !== cfg.treasuryWorkspace) return [];
      const out: AnchorLeaf[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < CUPBOARD_LINK_FEED_MAX_PAGES; page += 1) {
        const params = new URLSearchParams();
        if (cursor) params.set('after', cursor);
        if (cfg.pageSize) params.set('limit', String(cfg.pageSize));
        const qs = params.toString();
        const query = qs ? `?${qs}` : '';
        const signedPath = `${LEDGER_CHAIN_LINKS_PATH}${query}`;
        const signature = await signReconciliationRequest({ secret: cfg.secret, method: 'GET', pathname: signedPath, body: '', nowMs: now() });
        const response = await fetchImpl(`${baseUrl}${signedPath}`, { headers: { [RECONCILIATION_SIGNATURE_HEADER]: signature } });
        const text = await response.text();
        if (!response.ok) throw new Error(`cupboard ledger-chain links: status ${response.status}: ${text.slice(0, 200)}`);
        let body: { workspaceId?: unknown; links?: unknown; nextCursor?: unknown };
        try {
          body = JSON.parse(text) as typeof body;
        } catch {
          throw new Error('cupboard ledger-chain links: non-JSON response');
        }
        if (body.workspaceId !== cfg.treasuryWorkspace) {
          throw new Error(
            `cupboard ledger-chain links: Worker governs workspace ${JSON.stringify(body.workspaceId ?? null)}, operator treasury workspace is ${JSON.stringify(cfg.treasuryWorkspace)}`,
          );
        }
        if (!Array.isArray(body.links)) throw new Error('cupboard ledger-chain links: response has no links array');
        for (const raw of body.links) {
          const link = parseLink(raw);
          if (!link) throw new Error('cupboard ledger-chain links: malformed link in response');
          out.push(link);
        }
        if (body.nextCursor === null || body.nextCursor === undefined) return out;
        if (typeof body.nextCursor !== 'string' || body.nextCursor === cursor) {
          throw new Error('cupboard ledger-chain links: cursor did not advance');
        }
        cursor = body.nextCursor;
      }
      throw new Error(`cupboard ledger-chain links: more than ${CUPBOARD_LINK_FEED_MAX_PAGES} pages`);
    },
  };
}
