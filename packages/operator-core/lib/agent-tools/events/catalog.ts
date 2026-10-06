/**
 * events:catalog — "what can I wait on?" in one call
 * (event-await-discoverability-and-coverage-2026-07-03 P-002, D-001/D-005).
 *
 * The whole plan's headline is a DISCOVERABILITY gap: the await primitive works,
 * but agents poll (`dev:pipeline_position`, `dev:build_status`) because they never
 * find the event key that already fires. This tool renders the awaitable-key
 * registry (`events/await/catalog.ts` — the single source of truth) so the answer
 * to "is there an event for X?" is one read, not a code grep. It is the read-side
 * companion to `events:graph` (which shows server REACTIONS, not agent AWAITS).
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import {
  mergeInstalledEventCatalog,
  renderCatalog,
  familyKeyPrefix,
  familyKeyLikePattern,
  SUBJECT_SCOPE_GLOSS,
  type CatalogRow,
  type EventFamilyCollision,
  type InstalledUnitEvents,
  type SubjectScope,
} from '../../events/await/catalog';
import { readInstalledUnitEvents } from '../../events/await/installed-events';
import {
  countActiveAwaitsByKeyShapes,
  countActiveAwaitsByPrefixes,
  listActiveAnnouncements,
  listFiredAnnouncements,
} from '../../events/await/store';
import { announcementVisibleTo } from '../../events/await/announce-key';
import { resolveAgentIdentity } from '../coordination/identity';
import { getPresence } from '../coordination/presence';
import { resolveAnnouncementOwnership, type AnnouncementOwnership } from './status';

const MAX_CATALOG_LIMIT = 200;
const MAX_ANNOUNCEMENT_DISCOVERY = 100;
const CATALOG_SCOPE_NOTE =
  'Scope comes from request context; installed families use the call\'s harness, and announced gates use the reader\'s fleet/plan/harness visibility. Do not pass `scope`, `pot`, or `harness` as JSON filters; narrow with `q`/`pattern`/`query`/`family`.';

function escapeRegExp(value: string): string {
  let escaped = '';
  for (const char of value) {
    if ('\\^$.*+?()[]{}|'.includes(char)) escaped += '\\';
    escaped += char;
  }
  return escaped;
}

function keyTemplateMatchesQuery(keyTemplate: string, query: string): boolean {
  const pattern = keyTemplate
    .split(/(<[^<>]+>)/g)
    .map((part) => (/^<[^<>]+>$/.test(part) ? '[^:]+' : escapeRegExp(part)))
    .join('');
  return new RegExp('^' + pattern + '$', 'i').test(query);
}

/**
 * WI-10005981: free-text `q` used to match only as ONE contiguous substring, so a
 * multi-word query ("resource released") missed the very family it names
 * (`resource-released`), and the empty answer was read as proof the event does
 * not exist — two false "no release event" filings came from exactly that. A
 * query now matches when it appears verbatim in some field (unchanged), OR when
 * every whitespace-separated word appears in some field (words may land in
 * different fields). `query` arrives already trimmed + lower-cased.
 */
export function fieldsMatchQuery(values: readonly unknown[], query: string): boolean {
  const haystacks = values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.toLowerCase());
  if (haystacks.some((haystack) => haystack.includes(query))) return true;
  const words = query.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  return words.every((word) => haystacks.some((haystack) => haystack.includes(word)));
}

function catalogRowMatches(row: CatalogRow, query: string): boolean {
  const matchesField = fieldsMatchQuery(
    [row.family, row.key, row.await_example, row.describe, row.emitter, row.provenance, row.replaces_poll, row.sugar],
    query,
  );
  return matchesField || keyTemplateMatchesQuery(row.key, query);
}

export default defineTool({
  name: 'events:catalog',
  description:
    `List the awaitable event-key families — the answer to "what can I wait on instead of polling?". Each row: the key template (+ a ready events:await example), what it means, who emits it, whether it fires TODAY, the poll it replaces, its sugar verb (e.g. deploy:await), and \`live_awaiters\` — how many agents are registered on that key RIGHT NOW (EI-9000). Supports case-insensitive free-text \`q\` (compatibility aliases \`pattern\`/\`query\`) over family/key/description/emitter and a bounded \`limit\` for family rows. Check here before you poll dev:pipeline_position / dev:build_status / a peer\'s status. ${CATALOG_SCOPE_NOTE}`,
  capability: 'events:read',
  guidance: {
    when: 'Before polling for a deploy, gate, peer work-item, or service recovery; to check whether an event exists or who is listening.',
    notWhen: `You already know the exact key → events:await. For server reactions use events:graph; for your awaits/wakes use events:status. ${CATALOG_SCOPE_NOTE}`,
    chaining: 'events:catalog → events:await { event: <key> } (or sugar) → end your turn.',
    seeAlso: [
      'events:await (arm a wait on a key you found here)',
      'events:emit (its `waiters`/`woken` counts are the emit-TIME twin of this READ-time live_awaiters)',
      'events:graph (server reaction wiring — a different question)',
      'deploy:await / checkpoint:await / work-item:await (named sugar for the common waits)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    q: z
      .string()
      .max(200)
      .optional()
      .describe('Case-insensitive substring over family, key, await example, description, emitter, provenance, and sugar.'),
    pattern: z
      .string()
      .max(200)
      .optional()
      .describe('Compatibility alias for `q`; prefer the canonical `q` key. If both are supplied, `q` wins.'),
    query: z
      .string()
      .max(200)
      .optional()
      .describe('Compatibility alias for `q`; prefer the canonical `q` key. If multiple aliases are supplied, `q` wins.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_CATALOG_LIMIT)
      .optional()
      .describe(`Max family rows returned (default all; maximum ${MAX_CATALOG_LIMIT}).`),
    family: z
      .string()
      .max(64)
      .optional()
      .describe('Filter to one family id (e.g. "deploy", "work-item"). Omit for the whole catalog.'),
    awaitable_now: z
      .boolean()
      .optional()
      .describe('true = only families whose emitter fires TODAY (hide not-yet-wired Phase-2 keys).'),
    subjectScope: z
      .union([
        z.enum(['id', 'global', 'scope', 'unknown']),
        z.array(z.enum(['id', 'global', 'scope', 'unknown'])).min(1).max(4),
      ])
      .optional()
      .describe(
        'Filter by whether you can park on the key WITHOUT already knowing the subject (EI-19299170840541307). `id` = usable only if you already hold the specific id; `scope` = usable if you know a durable scope you own (fleet/plan/workspace/account/owner); `global` = usable by anyone, narrow with payload_filter; `unknown` = not classifiable from the template (installed packs only). A fleet leader asking "what can I actually wait on?" wants ["global","scope"] — the id-scoped families are unusable to anyone who does not already know which subject will move next. Accepts one value or an array.',
      ),
    liveAwaiters: z
      .boolean()
      .optional()
      .describe('default true — attach `live_awaiters` (current registered-await count) per family. Pass false to skip the extra DB read on a hot path that only needs the static catalog.'),
    announced: z
      .boolean()
      .optional()
      .describe("default true — also list ANNOUNCED gate events (EI-9270: dynamic, leader-declared keys — events:emit { announce:true }) visible to your fleet/plan/harness (+ global), each with fired/latched state and live_awaiters. Pass false to skip."),
    installed: z
      .boolean()
      .optional()
      .describe('default true — also fold in event families declared by INSTALLED packs/plugins (`provides.events`), each tagged `provenance: "installed:<unit>"`. Pass false for the builtin registry only.'),
  }),
  async handler(args, ctx) {
    // ── The INSTALLED tier (P-006 / D-003: events are a dependency axis). Installed
    // units declare the key families they provide; fold them over the builtin registry
    // so "what can I wait on?" answers for the WHOLE host, not just this binary's
    // hard-coded families. Fail-soft: a bad manifest or a cold host degrades to the
    // builtin catalog — never a throw, or an agent gets pushed back to polling.
    let installedUnits: InstalledUnitEvents[] = [];
    if (args.installed !== false) {
      try {
        const harnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
        installedUnits = await readInstalledUnitEvents({
          harnessSlug: typeof harnessRaw === 'string' && harnessRaw !== '*' ? harnessRaw : undefined,
        });
      } catch {
        /* best-effort — builtin-only catalog beats a dead discovery tool */
      }
    }
    // The merged entry list is also what the live-awaiter join reads below, so an
    // INSTALLED family gets its awaiter count too (deriving prefixes from the builtin
    // EVENT_CATALOG alone would silently leave every installed family without one).
    const merged = mergeInstalledEventCatalog(installedUnits);
    const collisions: EventFamilyCollision[] = merged.collisions;
    // EI-21374977511049906: events:watch calls its free-text selector `pattern`,
    // and callers naturally carried that spelling here. Keep `q` canonical while
    // accepting the explicit alias; an explicitly supplied `q` wins.
    // EI-22384286586185001: older callers used the generic `query` spelling.
    // Keep `q` canonical while accepting both compatibility aliases; canonical
    // input wins when more than one spelling is supplied.
    const query = (args.q ?? args.pattern ?? args.query)?.trim().toLowerCase();

    let rows = renderCatalog(installedUnits);

    // EI-19299170840541307: the census is taken over the UNFILTERED catalog, BEFORE any
    // narrowing below, and is always returned. A `subjectScope` filter is the one filter
    // here whose whole purpose is to hide families the caller cannot use — so reporting
    // only the surviving count would reproduce this item's own bug: a confident number
    // over a silently-narrowed population. `subject_scope_census` says how many families
    // exist in EACH bucket, so a filtered `count` can never be read as a total.
    const subjectScopeCensus = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.subject_scope] = (acc[r.subject_scope] ?? 0) + 1;
      return acc;
    }, {});

    if (args.family) rows = rows.filter((r) => r.family === args.family);
    if (args.awaitable_now) rows = rows.filter((r) => r.awaitable_now);
    const wantedScopes = args.subjectScope
      ? new Set<string>(Array.isArray(args.subjectScope) ? args.subjectScope : [args.subjectScope])
      : undefined;
    if (wantedScopes) rows = rows.filter((r) => wantedScopes.has(r.subject_scope));
    if (query) rows = rows.filter((r) => catalogRowMatches(r, query));
    if (args.limit !== undefined) rows = rows.slice(0, args.limit);

    // EI-9000: live awaiter counts — "is anyone actually listening" per family,
    // the read-time twin of events:emit's waiters/woken. Best-effort: a DB hiccup
    // here must never break catalog discoverability, so a failed count read just
    // omits live_awaiters rather than failing the whole call.
    if (args.liveAwaiters !== false && rows.length > 0) {
      const wanted = new Set(rows.map((r) => r.family));
      const entries = merged.entries.filter((e) => wanted.has(e.family));
      // WI-1611805: matched by the family's derived SHAPE (prefix + arity), not by
      // `prefix || '%'` — for a placeholder-first template the bare prefix is only
      // the namespace, so the old join counted unrelated families' awaits as this
      // family's (`plan-event` read 5 over a true 4). Shape comes from the catalog
      // so the count and the orphan guard can never disagree about the population.
      const counted = new Set(entries.map((e) => e.family));
      try {
        const counts = await countActiveAwaitsByKeyShapes(
          entries.map((e) => ({ family: e.family, exact: familyKeyPrefix(e), like: familyKeyLikePattern(e) })),
        );
        rows = rows.map((r) => (counted.has(r.family) ? { ...r, live_awaiters: counts.get(r.family) ?? 0 } : r));
      } catch {
        /* best-effort — omit live_awaiters rather than fail catalog discovery */
      }
    }

    // ── Announced gate events (EI-9270): dynamic, leader-declared keys — the catalog's
    // "announced" section, scoped to the reader's fleet/plan/harness (+ global). The
    // static registry above answers "what does the SYSTEM emit"; this answers "what did
    // a LEADER declare for my lane". BEST-EFFORT: any failure omits the section.
    let announced:
      | Array<{
          event: string;
          logical_gate: string | null;
          note: string | null;
          scope: string;
          announced_by: string;
          fired: boolean;
          fired_at: string | null;
          expires_ts: string | null;
          historical?: boolean;
          live_awaiters?: number;
          live_successor_ids?: string[];
          stale_owner?: boolean;
        }>
      | undefined;
    // EI-21907772459508454: an announced gate that exists but is NOT VISIBLE to this
    // reader used to come back in the SAME SHAPE as one that was never declared —
    // `count: 0`, or the `announced` key omitted entirely. That is the repo's
    // absence-vs-not-measured rule violated on a coordination surface the playbook
    // explicitly sends agents to ("verify the key against the catalog rather than
    // hand-copying it from a chat message"). A fleet member followed that rule, read
    // the silence as "my leader never declared the gate", and escalated wrongly.
    //
    // Visibility here is derived from PRESENCE (fleetSlug / currentPlanSlug), which
    // agents very often have not set: measured 2026-08-30, of 124 agents with a
    // heartbeat inside 30min, 76 carried a fleet_slug but only 30 carried a
    // current_plan_slug — so 60 fleet members saw NONE of the 25 active plan-scoped
    // gates. events:await resolves the same key BY KEY and answers correctly, so the
    // two surfaces disagree and the lying one is the documented one.
    //
    // The fix is to make the omission SAYABLE, not to loosen the scope rule
    // (announcementVisibleTo is correct): report what was withheld and why.
    let announcedVisibility:
      | {
          total_active: number;
          total_fired_history: number;
          total_discoverable: number;
          returned: number;
          hidden_by_scope: number;
          hidden_by_query: number;
          hidden_by_cap: number;
          reader_scope: { fleet: string | null; plan: string | null; harness: string | null };
          reader_resolved: boolean;
          note?: string;
        }
      | undefined;
    let announcedSectionFailed = false;
    if (args.announced !== false) {
      try {
        const activeAnnouncements = await listActiveAnnouncements({
          unfiredOnly: false,
          limit: MAX_ANNOUNCEMENT_DISCOVERY,
        });
        let firedAnnouncements: Awaited<ReturnType<typeof listFiredAnnouncements>> = [];
        let firedHistoryUnavailable = false;
        try {
          firedAnnouncements = await listFiredAnnouncements({ limit: MAX_ANNOUNCEMENT_DISCOVERY });
        } catch {
          // The historical latch is additive; an unavailable read must not hide
          // active declarations that the primary catalog query can still render.
          firedHistoryUnavailable = true;
        }
        const firedLatches = new Map(firedAnnouncements.map((entry) => [entry.announcement.eventKey, entry.fireLatch]));
        const historicalKeys = new Set<string>();
        const byEventKey = new Map<string, (typeof activeAnnouncements)[number]>();
        for (const announcement of activeAnnouncements) byEventKey.set(announcement.eventKey, announcement);
        for (const { announcement } of firedAnnouncements) {
          if (byEventKey.has(announcement.eventKey)) continue;
          byEventKey.set(announcement.eventKey, announcement);
          historicalKeys.add(announcement.eventKey);
        }
        const anns = [...byEventKey.values()];
        if (anns.length > 0) {
          let reader: { fleetSlug?: string | null; planSlug?: string | null; harnessSlug?: string | null } = {};
          let readerResolved = false;
          let workspaceId: string | null = null;
          try {
            const identity = resolveAgentIdentity(ctx);
            workspaceId = identity.workspaceId ?? null;
            const p = (await getPresence(identity.ownerId)) as
              | { fleetSlug?: string | null; currentPlanSlug?: string | null }
              | null;
            const ctxHarnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
            reader = {
              fleetSlug: p?.fleetSlug ?? null,
              planSlug: p?.currentPlanSlug ?? null,
              harnessSlug: typeof ctxHarnessRaw === 'string' && ctxHarnessRaw !== '*' ? ctxHarnessRaw : null,
            };
            readerResolved = true;
          } catch { /* unresolvable reader → global-only visibility, REPORTED below */ }
          const scopeVisible = anns.filter((a) => announcementVisibleTo(a, reader));
          const queryVisible = scopeVisible.filter((a) => {
            if (!query) return true;
            return fieldsMatchQuery(
              [a.eventKey, a.logicalGateKey, a.note, a.scopeKind, a.scopeRef, a.subscriberId],
              query,
            );
          });
          const visible = queryVisible.slice(0, 25);
          const hiddenByScope = anns.length - scopeVisible.length;
          const hiddenByCap = queryVisible.length - visible.length;
          const notes: string[] = [];
          if (hiddenByScope > 0) {
            notes.push(
              `${hiddenByScope} announced gate(s) exist but are OUT OF SCOPE for you — this is NOT proof they were never declared. Visibility comes from your PRESENCE (fleet=${reader.fleetSlug ?? 'null'}, plan=${reader.planSlug ?? 'null'}); a gate declared for a fleet/plan you are not recorded on is withheld here even though events:await on its exact key will still resolve it. If a leader told you a key, await it directly rather than concluding from this list that it does not exist.`,
            );
          }
          if (!readerResolved) {
            notes.push(
              'READER SCOPE UNRESOLVED — presence lookup failed, so this list was narrowed to GLOBAL gates only. Treat any fleet/plan-scoped absence as UNMEASURED, not absent.',
            );
          }
          if (hiddenByCap > 0) {
            notes.push(
              `${hiddenByCap} further visible gate(s) were cut by the fixed 25-row announced cap (the \`limit\` argument bounds FAMILY rows only, not this list). Narrow with \`q\` to see them.`,
            );
          }
          if (firedHistoryUnavailable) {
            notes.push(
              'Fired announced-gate history could not be read on this call; active declarations are shown, but historical fired keys are UNMEASURED, not absent.',
            );
          }
          announcedVisibility = {
            total_active: activeAnnouncements.length,
            total_fired_history: historicalKeys.size,
            total_discoverable: anns.length,
            returned: visible.length,
            hidden_by_scope: hiddenByScope,
            hidden_by_query: scopeVisible.length - queryVisible.length,
            hidden_by_cap: hiddenByCap,
            reader_scope: {
              fleet: reader.fleetSlug ?? null,
              plan: reader.planSlug ?? null,
              harness: reader.harnessSlug ?? null,
            },
            reader_resolved: readerResolved,
            ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
          };
          let counts: Map<string, number> | null = null;
          try {
            counts = await countActiveAwaitsByPrefixes(visible.map((a) => a.eventKey));
          } catch { /* omit live_awaiters */ }
          // EI-21840718595021627: a role/fleet-leadership-bound gate whose declarer
          // ended, with no live successor holding that binding, will NEVER fire —
          // events:status/events:await already compute this (staleOwner +
          // liveSuccessorIds), but only reactively, per-key, after an agent has
          // already armed an await and parked on it. Surface the SAME computation
          // here too, so "what can I wait on" — the tool whose whole job is
          // discoverability before parking — tells a caller UP FRONT that a
          // declared-but-undead gate is stranded, instead of one more of 52+
          // historical waiters discovering it only via a timeout wake.
          let ownership: Map<number, AnnouncementOwnership> | null = null;
          try {
            ownership = await resolveAnnouncementOwnership(visible, workspaceId);
          } catch { /* best-effort — omit stale_owner/live_successor_ids rather than fail catalog */ }
          announced = visible.map((a) => {
            const owned = ownership?.get(a.id);
            const fireLatch = firedLatches.get(a.eventKey);
            const historical = historicalKeys.has(a.eventKey);
            const firedAt = historical ? fireLatch?.lastFiredAt ?? null : a.firedReason === 'event' ? a.firedAt : null;
            return {
              event: a.eventKey,
              logical_gate: a.logicalGateKey ?? null,
              note: a.note,
              scope: a.scopeKind ? `${a.scopeKind}${a.scopeRef ? ':' + a.scopeRef : ''}` : 'global',
              announced_by: a.subscriberId,
              fired: !!firedAt,
              fired_at: firedAt,
              expires_ts: a.expiresTs,
              ...(historical ? { historical: true } : {}),
              ...(counts ? { live_awaiters: counts.get(a.eventKey) ?? 0 } : {}),
              ...(owned?.liveSuccessorIds.length ? { live_successor_ids: owned.liveSuccessorIds } : {}),
              ...(owned?.staleOwner ? { stale_owner: true } : {}),
            };
          });
        } else {
          announcedVisibility = {
            total_active: 0,
            total_fired_history: 0,
            total_discoverable: 0,
            returned: 0,
            hidden_by_scope: 0,
            hidden_by_query: 0,
            hidden_by_cap: 0,
            reader_scope: { fleet: null, plan: null, harness: null },
            reader_resolved: true,
            note: firedHistoryUnavailable
              ? 'No active announced gates are visible. Fired announced-gate history could not be read on this call, so historical fired keys are UNMEASURED, not absent.'
              : 'No announced gates are active in this workspace at all.',
          };
        }
      } catch {
        // Best-effort — never break catalog discovery. But do NOT let the failure
        // masquerade as "no gates are declared": say the section could not be read.
        announcedSectionFailed = true;
      }
    }

    const rowsOut: CatalogRow[] = rows;
    const installedCount = merged.entries.filter((e) => e.provenance !== 'builtin').length;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            count: rowsOut.length,
            total: merged.entries.length,
            // EI-19299170840541307: ALWAYS present, and always over the UNFILTERED
            // catalog — the denominator for `count`, broken down by whether a family
            // is reachable without already knowing its subject.
            subject_scope_census: subjectScopeCensus,
            ...(installedCount > 0 ? { installed_families: installedCount } : {}),
            ...(announced && announced.length > 0 ? { announced } : {}),
            // EI-21907772459508454: ALWAYS present when the announced section ran, even
            // when `announced` itself is empty/omitted — an empty list and a withheld
            // list must not read the same. This is the field that tells a caller whether
            // a missing gate is genuinely undeclared or merely out of their scope.
            ...(announcedVisibility ? { announced_visibility: announcedVisibility } : {}),
            ...(announcedSectionFailed
              ? {
                  announced_unavailable:
                    'The announced-gate section could not be read on this call. This is NOT evidence that no gate was declared — retry, or events:await the exact key your leader gave you (await resolves by key and does not depend on presence scope).',
                }
              : {}),
            // A REFUSED family declaration is reported, never swallowed — otherwise a
            // pack author debugs a family that "just doesn't appear" with no signal.
            ...(collisions.length > 0 ? { collisions } : {}),
            // WI-10005981: a free-text miss is a SEARCH result, not an absence verdict.
            ...(query && rowsOut.length === 0
              ? {
                  query_miss:
                    'No family matched every word of q. This is NOT proof the event does not exist: retry with fewer or different words (e.g. the noun alone), or omit q to list every family.',
                }
              : {}),
            note:
              `A gate MISSING from \`announced\` is not proof it was never declared — read \`announced_visibility\`: gates scoped to a fleet/plan you are not recorded on are withheld here, while events:await on the exact key still resolves them. Awaiting beats polling: pick a family, events:await its key (or its sugar verb), then END YOUR TURN — you are re-invoked when it fires. awaitable_now:false = the emitter is being wired (Phase 2); the key shape is stable. live_awaiters:0 means nobody is currently registered on that key — a events:emit against it would reach no one. An announced gate carrying \`stale_owner:true\` is STRANDED: its declarer's session ended and no live role/fleet-leadership successor holds the binding, so it will never fire — do NOT events:await it; \`live_successor_ids\` (when present) names who COULD declare a fresh gate instead. \`provenance\` says whether a family is a platform guarantee (builtin) or an installed unit's promise (installed:<unit>) — the two carry different trust and lifetime. \`subject_scope\` says whether you can park on a key WITHOUT already knowing the subject: \`id\` families are unusable unless you already hold that exact id, so matching a family BY NAME and concluding "this already exists for my case" is the specific mistake this field exists to stop — filter with \`subjectScope:["global","scope"]\` to see only what you can actually reach, and read \`subject_scope_census\` for how many were withheld. ${CATALOG_SCOPE_NOTE}`,
            families: rowsOut,
          }),
        },
      ],
    };
  },
});
