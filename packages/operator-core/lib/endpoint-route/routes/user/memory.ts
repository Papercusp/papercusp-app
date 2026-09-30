/**
 * /api/user/memory — list + delete + edit persistent memories for the
 * session user. Rides the neutral `MemoryBackend` seam
 * (generalize-memory-backend-swappable D-003) — rows are the neutral
 * entry shape `{ id, text, kind, scope, harness_slug?, metadata }`,
 * regardless of which store backs them.
 *
 * The audit enrichment (state + broken anchors) reads the mem0
 * canonical tables directly — it is mem0-specific by design and
 * degrades silently for other backends (no matching ids → no audit
 * fields).
 *
 * Ported from app/api/user/memory/route.ts. `auth: 'public'` —
 * session-cookie auth with the seeded-`default`-user fallback
 * (getSessionUserOrDefault), the same single-user-install semantics the
 * `memory:*` MCP tools and /auth/me use. The desktop webview typically
 * carries no session cookie, so a strict 401 here blanks the settings
 * memory page while the store is full (regression of 2026-06-11).
 */
import { getSessionUserOrDefault } from '../../../auth';
import {
  getMemoryBackend,
  MemoryUnavailableError,
  registeredMemoryBackends,
} from '../../../memory/backend';
import {
  currentMemoryBackendChoice,
  writeMemoryBackendChoice,
} from '../../../memory/backend-selection';
import { MemoryTimeoutError, withMemoryToolTimeout, embedFailureReason } from '../../../memory/op-deadline';
import { journalPendingWrite, markJournalCommitted } from '../../../memory/write-journal';
import { listUserMemories } from '../../../memory/list-user-memories';
import { isMemoryPaused, setMemoryPaused } from '../../../memory/memory-pause';
import { recallCanaryForEnvelope } from '../../../memory/recall-canary-envelope';
import { detectPossibleSecrets, possibleSecretWarning } from '../../../memory/secret-detect';
import { recordFeedback } from '../../../memory/feedback';
import { invalidateUserMemoryViews } from '../../../memory/invalidate-user-memory-views';
import { activeWorkspaceId } from '../../../workspace-registry';
import { loadHarnessRegistry } from '../../../harness-registry';
import { defineTool } from '@papercusp/agent-mcp';

/**
 * Mark every cached view of the memory corpus stale — the row list AND the
 * total the settings page shows beside it (args omitted = all users / all
 * instances, see SSEAdapter). Best-effort: a notify failure must never fail
 * the write that triggered it.
 *
 * Routed through `invalidateUserMemoryViews` rather than naming keys here, so
 * a future sync query over the corpus cannot be left refreshing behind the
 * rows (WI-39540).
 *
 * STATICALLY imported on purpose. A `void import(...)` here would defer the
 * notify CALL itself into a microtask, so a write's invalidation would no
 * longer be observable at the point the write returns — both a behaviour
 * change (a same-tick reader sees a stale view) and what silently broke the
 * `POST /user/memory` invalidate assertion in user.test.ts.
 */
const invalidateMemoryList = (): void => {
  void invalidateUserMemoryViews();
};

const list = defineTool({
  method: 'GET',
  path: '/user/memory',
  auth: 'public',
  async handler(req) {
    const user = await getSessionUserOrDefault(req.headers);
    const backend = getMemoryBackend();
    const avail = await backend.available();
    if (!avail.ok) {
      return Response.json({
        results: [],
        reason: avail.reason,
        backend: backend.name,
        currentBackend: currentMemoryBackendChoice(),
        availableBackends: registeredMemoryBackends(),
      });
    }
    const enriched = await listUserMemories(user.id);

    return Response.json({
      results: enriched,
      backend: backend.name,
      currentBackend: currentMemoryBackendChoice(),
      availableBackends: registeredMemoryBackends(),
    });
  },
});

/**
 * GET /api/user/memory/backend — backend availability + selection meta
 * for the settings page. The row data itself rides the `userMemory.list`
 * sync query (P-007); this endpoint carries only the envelope the old
 * list response bundled (backend name / choices / unavailable-reason).
 */
const backendInfo = defineTool({
  method: 'GET',
  path: '/user/memory/backend',
  auth: 'public',
  async handler(req) {
    const user = await getSessionUserOrDefault(req.headers);
    const backend = getMemoryBackend();
    const avail = await backend.available();
    // Harness slugs for the add-memory scope select (P-010) — best-effort.
    let harnesses: string[] = [];
    try {
      const reg = await loadHarnessRegistry(activeWorkspaceId());
      harnesses = reg.projects.map((p) => p.slug);
    } catch { /* select just offers Personal */ }
    return Response.json({
      backend: backend.name,
      currentBackend: currentMemoryBackendChoice(),
      availableBackends: registeredMemoryBackends(),
      reason: avail.ok ? null : avail.reason,
      userId: user.id,
      harnesses,
      // EI-10355: the user's memory-pause state rides the envelope the page
      // already fetches — no extra round-trip for the toggle to render truthfully.
      paused: await isMemoryPaused(user.id),
      // EI-10368: latest live recall-canary verdict, same ride. Fail-open —
      // null (no runs / canary storage absent / PG down) must render as
      // "hasn't run yet", never break the envelope.
      recallCanary: await recallCanaryForEnvelope().catch(() => null),
    });
  },
});

/**
 * GET/POST /api/user/memory/pause — the user's "stop remembering things about
 * me" switch (EI-10355). Before this, the only way to stop memory writes was
 * PAPERCUSP_MEMORY_BACKEND=noop: an operator-wide env var + restart, i.e. an
 * infra kill-switch, not a user control.
 *
 * A pause stops the AGENT write paths (memory:remember,
 * memory:recover-from-transcripts) — the ways things get remembered ABOUT you
 * without you asking. It deliberately does NOT gate list/edit/delete/export:
 * pausing must never lock a user out of their own data.
 */
const getPause = defineTool({
  method: 'GET',
  path: '/user/memory/pause',
  auth: 'public',
  async handler(req) {
    const user = await getSessionUserOrDefault(req.headers);
    return Response.json({ paused: await isMemoryPaused(user.id) });
  },
});

const setPause = defineTool({
  method: 'POST',
  path: '/user/memory/pause',
  // EI-10435: this is a MUTATING route and was left at 'public' by oversight
  // when EI-10355 added it — every sibling mutator in this file (`create`,
  // `setBackend`, `del`) is 'loopback' per the Wave-1 rule (mutating routes
  // are loopback-or-better). Nothing about pause/resume needs remote
  // reachability; flip to match.
  auth: 'loopback',
  async handler(req) {
    const user = await getSessionUserOrDefault(req.headers);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'invalid_json' }, { status: 400 });
    }
    const paused = (body as { paused?: unknown } | null)?.paused;
    if (typeof paused !== 'boolean') {
      return Response.json({ error: 'paused must be a boolean' }, { status: 400 });
    }
    // NOTE: intentionally NOT gated on backend.available(). A user must be able
    // to pause memory even while the store is down — the pause is a statement of
    // consent, not a store operation, and refusing it during an outage would
    // deny the one control that matters most when things are broken.
    const applied = await setMemoryPaused(user.id, paused);
    invalidateMemoryList();
    return Response.json({ ok: true, paused: applied });
  },
});

/**
 * POST /api/user/memory — create a memory from the settings page (P-010).
 * Writes through the neutral backend seam like the `memory:remember` MCP
 * verb, but trusts the page's free-form kind (the taxonomy is backend-
 * defined — D-001); records `create` feedback symmetrically with
 * edit/delete so the extractor learns from hand-curated entries too.
 *
 * WRITE-AHEAD JOURNALED (WI-4208 — memory-write-journal-auto-recovery P-002
 * parity). This route used to probe `available()`, 503 on a down store, and
 * call `remember` unguarded: an embedder outage (or the saturated-sidecar
 * shape) meant the text a HUMAN just typed was lost outright — worse than
 * the agent case that motivated the journal, because a person watching a
 * failure toast has no transcript to recover from. Now the fact is parked in
 * the journal BEFORE any embedder-dependent step (a plain PG INSERT), the
 * store write is deadline-bounded, and every failure branch returns
 * `{ journaled, will_retry, journal_id }` so the UI can say "saved, pending
 * embedding" instead of "failed". The 5-min drain replays it.
 */
const create = defineTool({
  method: 'POST',
  path: '/user/memory',
  auth: 'loopback',
  async handler(req) {
    const user = await getSessionUserOrDefault(req.headers);
    const backend = getMemoryBackend();
    // Validate BEFORE journaling — a malformed request is a 400, not a fact
    // to park and replay.
    const body = (await req.json().catch(() => null)) as
      | { text?: string; kind?: string; harness_slug?: string }
      | null;
    const text = body?.text?.trim();
    if (!text) return Response.json({ error: 'text_required' }, { status: 400 });
    const kind = body?.kind?.trim() || undefined;
    if (kind && kind.length > 40) {
      return Response.json({ error: 'kind_too_long' }, { status: 400 });
    }
    const harnessSlug = body?.harness_slug?.trim() || undefined;

    const scopeKey = harnessSlug ? `harness:${harnessSlug}` : user.id;
    const metadata: Record<string, unknown> = {
      scope: harnessSlug ? 'harness' : 'user',
      created_by: user.id,
      display_name: user.display_name,
      source: 'settings-page',
    };
    if (harnessSlug) metadata.harness_slug = harnessSlug;
    // EI-10371 stage 1: flag credential-shaped content (detection only — the
    // text is stored unchanged). Stamped before journaling so a replay carries it.
    const secrets = detectPossibleSecrets(text);
    if (secrets.matched) {
      metadata.possible_secret = true;
      metadata.possible_secret_classes = secrets.classes;
    }

    // Park the fact durably first. `journalId === null` ⇒ journaling itself is
    // degraded (pre-migration DB, PG hiccup) — the write proceeds on the old
    // lossy path rather than failing, exactly as memory:remember does.
    const journalId = await journalPendingWrite({
      scope: scopeKey,
      kind,
      content: text,
      metadata,
      verbatim: true,
    });
    const journaledFields = journalId
      ? {
          journaled: true,
          will_retry: true,
          journal_id: journalId,
          hint: 'Saved — this memory is stored durably and will finish indexing automatically once the embedder recovers. Do not re-submit it.',
        }
      : {};

    const avail = await backend.available().catch(() => ({ ok: false as const, reason: 'probe_failed' }));
    if (!avail.ok) return Response.json({ error: avail.reason, ...journaledFields }, { status: 503 });

    // verbatim: the user typed exactly what they want stored — bypass the
    // mem0 leg's LLM fact-extraction (which can extract NOTHING from short
    // prose and silently store zero entries; observed live 2026-06-09).
    let ids: string[];
    try {
      ({ ids } = await withMemoryToolTimeout(
        backend.remember(text, { scope: scopeKey, kind, metadata, verbatim: true }),
        'POST /user/memory remember',
      ));
    } catch (err) {
      // A wedged/saturated embedder is exactly what the journal exists for:
      // report the parked fact instead of a 500 that loses the user's text.
      const reason =
        err instanceof MemoryTimeoutError
          ? 'memory_timeout'
          : err instanceof MemoryUnavailableError
            ? err.reason
            : embedFailureReason(err);
      if (!reason) throw err;
      return Response.json({ error: reason, ...journaledFields }, { status: 503 });
    }

    if (journalId) void markJournalCommitted(journalId, ids[0] ?? null);
    for (const id of ids) {
      await recordFeedback({
        memId: id, userId: user.id, action: 'create', kind: kind ?? null, newText: text,
      });
    }
    invalidateMemoryList();
    return Response.json({
      ok: true,
      ids,
      // EI-10371: the UI shows this as a toast/warning next to the saved row.
      ...(secrets.matched
        ? { possible_secret: true, warning: possibleSecretWarning(secrets.classes) }
        : {}),
    });
  },
});

/**
 * POST /api/user/memory/backend — switch the active MemoryBackend
 * (mem0-revive-or-retire / Brief 30). Operator-wide, persisted, live: the
 * next memory call serves the new store with no restart. The owner uses
 * this to flip to `claude-file` (the real ~/.claude store) to see real
 * data + inform the revive-vs-retire decision. Validated against the
 * registry so an unknown name can't make getMemoryBackend() throw.
 */
const setBackend = defineTool({
  method: 'POST',
  path: '/user/memory/backend',
  auth: 'loopback',
  async handler(req) {
    const user = await getSessionUserOrDefault(req.headers);
    const body = (await req.json().catch(() => null)) as { backend?: string } | null;
    const choice = body?.backend?.trim();
    if (!choice) return Response.json({ error: 'backend_required' }, { status: 400 });
    const available = registeredMemoryBackends();
    if (!available.includes(choice)) {
      return Response.json(
        { error: 'unknown_backend', backend: choice, availableBackends: available },
        { status: 400 },
      );
    }
    await writeMemoryBackendChoice(choice);
    invalidateMemoryList();
    // Probe the newly-selected store so the UI can warn if it's unavailable
    // (e.g. selecting claude-file on a box with no ~/.claude store).
    let availability: { ok: boolean; reason?: string } = { ok: true };
    try {
      const a = await getMemoryBackend().available();
      availability = a.ok ? { ok: true } : { ok: false, reason: a.reason };
    } catch (e) {
      availability = { ok: false, reason: String((e as Error)?.message ?? e) };
    }
    return Response.json({ ok: true, backend: choice, availability });
  },
});

const del = defineTool({
  method: 'DELETE',
  path: '/user/memory',
  auth: 'loopback',
  async handler(req) {
    const user = await getSessionUserOrDefault(req.headers);
    const backend = getMemoryBackend();
    const avail = await backend.available();
    if (!avail.ok) return Response.json({ error: avail.reason }, { status: 503 });
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    const all = url.searchParams.get('all');
    if (all === '1') {
      const mine = await backend.list({ scope: user.id });
      let n = 0;
      for (const entry of mine) {
        try {
          await backend.forget(entry.id);
          await recordFeedback({
            memId: entry.id, userId: user.id, action: 'forget_all',
            kind: entry.kind ?? null,
            priorText: entry.text || null,
          });
          n += 1;
        } catch { /* best-effort */ }
      }
      backend.invalidate?.();
      invalidateMemoryList();
      return Response.json({ ok: true, deleted: n });
    }
    if (!id) return Response.json({ error: 'id_or_all_required' }, { status: 400 });
    let priorText: string | null = null;
    let priorKind: string | null = null;
    try {
      const got = await backend.get(id);
      priorText = got?.text ?? null;
      priorKind = got?.kind ?? null;
    } catch { /* best-effort */ }
    await backend.forget(id);
    await recordFeedback({
      memId: id, userId: user.id, action: 'delete', kind: priorKind, priorText,
    });
    invalidateMemoryList();
    return Response.json({ ok: true });
  },
});

/**
 * PATCH /api/user/memory — edit a memory's text from the settings page.
 * WRITE-AHEAD JOURNALED for the same reason as POST above (WI-4208): a text
 * edit RE-EMBEDS, so an embedder outage lost the user's correction. The
 * journal row carries `__journal_update_of` — the drain replays it as an
 * UPDATE of that id (never as a new memory), the same contract memory:update
 * uses.
 */
const patch = defineTool({
  method: 'PATCH',
  path: '/user/memory',
  auth: 'loopback',
  async handler(req) {
    const user = await getSessionUserOrDefault(req.headers);
    const backend = getMemoryBackend();
    const body = (await req.json().catch(() => null)) as { id?: string; text?: string; memory?: string } | null;
    // `text` is the neutral field; `memory` accepted from older clients.
    const nextText = (body?.text ?? body?.memory)?.trim();
    if (!body?.id || !nextText) {
      return Response.json({ error: 'id_and_text_required' }, { status: 400 });
    }
    let priorText: string | null = null;
    let priorKind: string | null = null;
    try {
      const got = await backend.get(body.id);
      priorText = got?.text ?? null;
      priorKind = got?.kind ?? null;
    } catch { /* best-effort */ }

    // EI-10371 stage 1: re-check the edited text and re-stamp the flag both
    // ways — editing a secret out must clear the chip (vec-safe metadata merge).
    const secrets = detectPossibleSecrets(nextText);

    const journalId = await journalPendingWrite({
      scope: `__update__:${body.id}`,
      content: nextText,
      metadata: { __journal_update_of: body.id, source: 'settings-page' },
      verbatim: true,
    });
    const journaledFields = journalId
      ? {
          journaled: true,
          will_retry: true,
          journal_id: journalId,
          hint: 'Saved — this edit is stored durably and will finish indexing automatically once the embedder recovers. Do not re-submit it.',
        }
      : {};

    const avail = await backend.available().catch(() => ({ ok: false as const, reason: 'probe_failed' }));
    if (!avail.ok) return Response.json({ error: avail.reason, ...journaledFields }, { status: 503 });

    try {
      await withMemoryToolTimeout(
        backend.update(body.id, {
          text: nextText,
          metadata: { possible_secret: secrets.matched, possible_secret_classes: secrets.classes },
        }),
        'PATCH /user/memory update',
      );
    } catch (err) {
      const reason =
        err instanceof MemoryTimeoutError
          ? 'memory_timeout'
          : err instanceof MemoryUnavailableError
            ? err.reason
            : embedFailureReason(err);
      // A not-found id is a clean 404, NOT a parked write — the drain must
      // never resurrect an edit to a memory that doesn't exist.
      const message = err instanceof Error ? err.message : String(err);
      if (!reason || /not\s*found/i.test(message)) {
        if (journalId) void markJournalCommitted(journalId, null);
        if (/not\s*found/i.test(message)) {
          return Response.json({ error: 'not_found', id: body.id }, { status: 404 });
        }
        throw err;
      }
      return Response.json({ error: reason, ...journaledFields }, { status: 503 });
    }

    if (journalId) void markJournalCommitted(journalId, body.id);
    await recordFeedback({
      memId: body.id, userId: user.id, action: 'edit',
      kind: priorKind, priorText, newText: nextText,
    });
    invalidateMemoryList();
    return Response.json({
      ok: true,
      ...(secrets.matched
        ? { possible_secret: true, warning: possibleSecretWarning(secrets.classes) }
        : {}),
    });
  },
});

/**
 * GET /api/user/memory/export — download the session user's OWN memories as a
 * structured JSON file (EI-10350: data portability / GDPR Art. 20). We already
 * honor access (list), rectification (patch), and erasure (delete / ?all=1);
 * this closes the portability gap for public release.
 *
 * Returns exactly the same user-scoped set the `list` route serves
 * (`listUserMemories(user.id)`, workspace-shared excluded — same scope as
 * forget_all), so it exposes nothing `list` doesn't already; `auth:'public'`
 * matches list for the same desktop-webview / single-user-fallback reason. The
 * only difference is a `Content-Disposition: attachment` header so a browser
 * downloads it rather than rendering it.
 */
const exportAll = defineTool({
  method: 'GET',
  path: '/user/memory/export',
  auth: 'public',
  async handler(req) {
    const user = await getSessionUserOrDefault(req.headers);
    const backend = getMemoryBackend();
    const avail = await backend.available();
    if (!avail.ok) return Response.json({ error: avail.reason }, { status: 503 });
    const memories = await listUserMemories(user.id);
    const payload = {
      schema: 'papercusp.memory.export/v1',
      exportedAt: new Date().toISOString(),
      userId: user.id,
      count: memories.length,
      note: 'Your personal memories. Workspace-shared entries are not included.',
      memories,
    };
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="papercusp-memories-${stamp}.json"`,
      },
    });
  },
});

export default [list, create, del, patch, setBackend, backendInfo, exportAll, getPause, setPause];
