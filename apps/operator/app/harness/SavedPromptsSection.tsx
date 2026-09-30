'use client';

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useQueryState, parseAsString } from 'nuqs';
import { toast } from 'sonner';
import {
  fetchSavedPrompts,
  saveSavedPrompt,
  deleteSavedPrompt,
  type SavedPrompt,
} from '@papercusp/operator-core/lib/saved-prompts-client';

/**
 * Saved-prompts settings module — the same component on the harness-settings
 * page (harness scope) and the personalization page (workspace scope). Prompts
 * are stored in PG and projected to the on-disk command files Claude Code, OMP,
 * and Codex read, so each becomes a `/name` slash command. Plan
 * saved-prompts-cross-client.
 */
export type SavedPromptsScope = { kind: 'workspace' } | { kind: 'harness'; slug: string };

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '6px 9px',
  fontSize: 13,
  background: 'var(--bg-2)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--fg)',
};

const labelStyle: CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--fg)',
  margin: '0 0 4px',
};

export function scopeHarness(scope: SavedPromptsScope): string | undefined {
  return scope.kind === 'harness' ? scope.slug : undefined;
}

/** A saved-prompt name is valid as a slash command iff it is lowercase
 *  alphanumeric + dashes, starting with an alphanumeric. */
export function isValidPromptName(name: string): boolean {
  return NAME_RE.test(name);
}

/** Whether the editor's Save action is allowed: a valid name + a non-blank body,
 *  and not mid-save. The pure gate behind the disabled Save button. */
export function canSavePrompt(opts: { saving: boolean; name: string; body: string }): boolean {
  return !opts.saving && isValidPromptName(opts.name) && opts.body.trim().length > 0;
}

export default function SavedPromptsSection({ scope }: { scope: SavedPromptsScope }) {
  const harness = scopeHarness(scope);
  const scopeKey = harness ?? '__workspace__';

  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Editor open-state in the URL (repo nuqs rule): null = closed, 'new' =
  // create, else the name being edited. Scoped per mount so the two pages
  // never share editor state.
  const editKey = harness ? `spEdit_${harness}` : 'spEdit';
  const [editing, setEditing] = useQueryState(editKey, parseAsString);

  // Mid-edit draft fields stay useState (lost-on-reload is acceptable here).
  const [draftName, setDraftName] = useState('');
  const [draftDesc, setDraftDesc] = useState('');
  const [draftArgHint, setDraftArgHint] = useState('');
  const [draftBody, setDraftBody] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setPrompts(await fetchSavedPrompts(harness));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [harness]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Seed the draft whenever the editor target changes.
  const isEditingExisting = editing != null && editing !== 'new';
  useEffect(() => {
    if (editing == null) return;
    if (editing === 'new') {
      setDraftName('');
      setDraftDesc('');
      setDraftArgHint('');
      setDraftBody('');
      return;
    }
    const p = prompts.find((x) => x.name === editing);
    setDraftName(p?.name ?? editing);
    setDraftDesc(p?.description ?? '');
    setDraftArgHint(p?.argHint ?? '');
    setDraftBody(p?.body ?? '');
  }, [editing, prompts]);

  const nameValid = isValidPromptName(draftName);
  const canSave = canSavePrompt({ saving, name: draftName, body: draftBody });

  const onSave = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await saveSavedPrompt({
        harness,
        name: draftName,
        body: draftBody,
        description: draftDesc.trim() || null,
        argHint: draftArgHint.trim() || null,
      });
      toast.success(`Saved /${draftName}`);
      void setEditing(null);
      await reload();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [canSave, harness, draftName, draftBody, draftDesc, draftArgHint, setEditing, reload]);

  const onDelete = useCallback(
    async (name: string) => {
      try {
        await deleteSavedPrompt(name, harness);
        toast.success(`Deleted /${name}`);
        if (editing === name) void setEditing(null);
        await reload();
      } catch (err) {
        toast.error((err as Error).message);
      } finally {
        setConfirmDelete(null);
      }
    },
    [harness, editing, setEditing, reload],
  );

  const scopeNote = useMemo(
    () =>
      harness
        ? `Stored with this harness and written to its repo at .claude/commands/ — version-controlled and available to everyone working in it.`
        : `Stored for this workspace and written to your workspace home — available across every harness.`,
    [harness],
  );

  return (
    <section style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      <h2 style={{ fontSize: 14, margin: '0 0 6px' }}>Saved prompts</h2>
      <p style={{ fontSize: 12, color: 'var(--fg-mute)', margin: '0 0 12px', maxWidth: 620 }}>
        Reusable prompts you invoke as <code>/name</code> in Claude Code, Codex, and OMP. {scopeNote} Use{' '}
        <code>$ARGUMENTS</code> or <code>$1</code>…<code>$9</code> for arguments.
      </p>

      {loading ? (
        <div style={{ fontSize: 12, color: 'var(--fg-mute)', padding: '8px 0' }}>Loading…</div>
      ) : prompts.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--fg-mute)', padding: '8px 0' }}>No saved prompts yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {prompts.map((p) => (
            <div
              key={p.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '8px 10px',
                background: 'var(--bg-2)',
                border: '1px solid var(--border)',
                borderRadius: 8,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <code style={{ fontSize: 13, color: 'var(--fg)' }}>/{p.name}</code>
                {p.description && (
                  <span
                    style={{
                      fontSize: 12,
                      color: 'var(--fg-mute)',
                      marginLeft: 8,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {p.description}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
                <button type="button" onClick={() => void setEditing(p.name)} style={{ fontSize: 11, padding: '3px 10px' }}>
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => (confirmDelete === p.name ? void onDelete(p.name) : setConfirmDelete(p.name))}
                  onBlur={() => setConfirmDelete((c) => (c === p.name ? null : c))}
                  style={{
                    fontSize: 11,
                    padding: '3px 10px',
                    color: confirmDelete === p.name ? 'var(--bad)' : 'var(--fg-mute)',
                    fontWeight: confirmDelete === p.name ? 600 : 400,
                  }}
                >
                  {confirmDelete === p.name ? 'Confirm?' : 'Delete'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing == null ? (
        <button type="button" onClick={() => void setEditing('new')} style={{ fontSize: 12, padding: '5px 12px' }}>
          + New prompt
        </button>
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            padding: 12,
            background: 'var(--bg-2)',
            border: '1px solid var(--border-strong)',
            borderRadius: 10,
            maxWidth: 620,
          }}
        >
          <div>
            <label style={labelStyle} htmlFor="sp-name">
              Name (the slash command)
            </label>
            <input
              id="sp-name"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              disabled={isEditingExisting}
              placeholder="ship-it"
              style={{ ...inputStyle, opacity: isEditingExisting ? 0.6 : 1 }}
            />
            {draftName.length > 0 && !nameValid && (
              <span style={{ fontSize: 11, color: 'var(--bad)' }}>
                Lowercase letters, digits and dashes only (e.g. <code>ship-it</code>).
              </span>
            )}
          </div>
          <div>
            <label style={labelStyle} htmlFor="sp-desc">
              Description <span style={{ fontWeight: 400, color: 'var(--fg-mute)' }}>(optional)</span>
            </label>
            <input
              id="sp-desc"
              value={draftDesc}
              onChange={(e) => setDraftDesc(e.target.value)}
              placeholder="Review the diff and ship if green"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle} htmlFor="sp-arg">
              Argument hint <span style={{ fontWeight: 400, color: 'var(--fg-mute)' }}>(optional)</span>
            </label>
            <input
              id="sp-arg"
              value={draftArgHint}
              onChange={(e) => setDraftArgHint(e.target.value)}
              placeholder="<area>"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle} htmlFor="sp-body">
              Prompt body
            </label>
            <textarea
              id="sp-body"
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              rows={6}
              placeholder="Review the diff for $ARGUMENTS and ship it if the tests are green."
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--font-mono, monospace)' }}
            />
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={!canSave}
              style={{
                fontSize: 12,
                padding: '6px 14px',
                background: 'var(--accent)',
                color: 'var(--accent-ink)',
                border: 'none',
                borderRadius: 6,
                opacity: canSave ? 1 : 0.5,
                cursor: canSave ? 'pointer' : 'not-allowed',
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={() => void setEditing(null)} style={{ fontSize: 12, padding: '6px 14px' }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
