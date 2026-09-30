'use client';

/**
 * Auto-binds every ShortcutDef with a `command` field to the Action
 * Registry. Mounted once at app shell. Per-component
 * `useShortcutAction(id, ...)` calls still win — they register later
 * and run first via the action stack — so this is a fallback handler
 * for shortcuts whose components aren't mounted on the current route.
 */
import { useEffect } from 'react';
import { SHORTCUTS } from '@papercusp/operator-core/lib/shortcut-registry';
import { useShortcutAction } from '../../hotkeys';
import { runCommand } from '@papercusp/operator-core/lib/commands/registry';

const REGISTRY_BOUND = SHORTCUTS.filter((s) => !!s.command);

function getBrowserCtx() {
  const workspace = typeof window !== 'undefined'
    ? (new URL(window.location.href).searchParams.get('ws') ?? 'default')
    : 'default';
  const sessionId = typeof window !== 'undefined'
    ? (window.sessionStorage.getItem('pc-voice-tab-id') ?? undefined)
    : undefined;
  return {
    agent: 'shortcut' as const,
    workspace,
    sessionId,
    requestId: `sc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

function ShortcutBinding({ id, commandId }: { id: string; commandId: string }) {
  useShortcutAction(id, () => {
    void runCommand(commandId, {}, getBrowserCtx());
  });
  return null;
}

export function RegistryShortcuts() {
  // Side-effect: load all command defs so runCommand can resolve them.
  // '/index' is load-bearing — see voice-mode.ts: the exports map's
  // `./lib/*` → `./lib/*.ts` wildcard can't resolve a bare directory.
  useEffect(() => {
    void import('@papercusp/operator-core/lib/commands/defs/index');
  }, []);
  return (
    <>
      {REGISTRY_BOUND.map((s) => (
        <ShortcutBinding key={s.id} id={s.id} commandId={s.command!} />
      ))}
    </>
  );
}
