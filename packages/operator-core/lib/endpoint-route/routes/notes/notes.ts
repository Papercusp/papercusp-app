/**
 * /api/notes — the minimal notes app's CRUD surface (owner-ask-batch-
 * 2026-07-06 P-004, WI-3265). Rows ride the `notes.list` sync query
 * (packages/operator-core/lib/sync-resolver/index.ts) — this route only
 * carries the writes, invalidating that query so the list page updates live
 * with no manual refresh (the repo's `@papercusp/sync` convention).
 *
 * `auth: 'loopback'` on the write verbs (create/update/delete) mirrors
 * /user/memory — desktop-local writes, no session-cookie requirement.
 */
import { createNote, updateNote, deleteNote } from '../../../notes';
import { notifySyncInvalidate } from '../../../sync-sse';
import { defineTool } from '@papercusp/agent-mcp';

const invalidateNotesList = (): void => {
  void notifySyncInvalidate('notes.list').catch(() => { /* best-effort */ });
};

const create = defineTool({
  method: 'POST',
  path: '/notes',
  auth: 'loopback',
  async handler(req) {
    const body = (await req.json().catch(() => null)) as { title?: string; body?: string } | null;
    const note = await createNote({ title: body?.title, body: body?.body });
    invalidateNotesList();
    return Response.json({ ok: true, note });
  },
});

const patch = defineTool({
  method: 'PATCH',
  path: '/notes',
  auth: 'loopback',
  async handler(req) {
    const body = (await req.json().catch(() => null)) as
      | { id?: string; title?: string; body?: string }
      | null;
    if (!body?.id) return Response.json({ error: 'id_required' }, { status: 400 });
    const note = await updateNote(body.id, { title: body.title, body: body.body });
    if (!note) return Response.json({ error: 'not_found' }, { status: 404 });
    invalidateNotesList();
    return Response.json({ ok: true, note });
  },
});

const del = defineTool({
  method: 'DELETE',
  path: '/notes',
  auth: 'loopback',
  async handler(req) {
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    if (!id) return Response.json({ error: 'id_required' }, { status: 400 });
    const ok = await deleteNote(id);
    if (!ok) return Response.json({ error: 'not_found' }, { status: 404 });
    invalidateNotesList();
    return Response.json({ ok: true });
  },
});

export default [create, patch, del];
