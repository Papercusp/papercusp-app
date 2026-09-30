/**
 * Session + profile helpers — Stage 7 scaffold.
 *
 * Profile preferences (model defaults, default project location, theme)
 * persist in `harness_shared.operator_user_profile` (PG, migration 021).
 * Was previously `~/.papercusp/profile.json` mode 0600. The PG migration
 * was the explicit pre-NextAuth TODO in this module's prior comment —
 * once NextAuth lands we'll switch the lookup key from workspace_id to
 * user_id, but the PG-resident shape is correct now.
 *
 * API credentials remain in `harness_shared.operator_credentials`
 * (PG-only, no Zero) — see `lib/credentials.ts`.
 */

import { readOperatorState, writeOperatorState } from './operator-state-pg';

export interface Profile {
  email?: string;
  display_name?: string;
  default_project_dir?: string;
  // `preferred_models` removed (settings-audit 2026-07-09): the /settings/profile
  // form wrote it but nothing ever read it. Per-role model selection is
  // /settings/agent → agent-config (models / roleBackends).
  /** Auto-scan toggle. Was previously localStorage 'papercusp.autoScan'. */
  auto_scan?: boolean;
  auto_accept?: 'off' | 'low' | 'medium' | 'high';
  /** Last-seen timestamp (ms epoch) for the toast/notification log.
   *  Was previously localStorage 'papercusp.toastLog.lastSeen'. */
  toast_last_seen_ms?: number;

  // ── Browser-presentation preferences ────────────────────────────────────
  // PG is the source of truth; localStorage is a per-device write-through
  // cache, and the host injects the pre-paint ones into index.html. Migrated
  // off localStorage-only storage because the desktop WebKitGTK webview's
  // localStorage is unreliable across reloads/restarts (origin churn +
  // unflushed writes). See lib/profile-pref.ts.
  /** Active color-theme id: 'frost' | 'black' | 'custom:<slug>'. Replaces the
   *  old `theme: 'dark'|'light'|'auto'` field, which never matched the real
   *  theme system (lib/theme-tokens.ts). Read pre-paint via host injection. */
  theme_id?: string;
  /** Visual-effects mode. Read pre-paint via host injection. */
  visual_effects_mode?: 'system' | 'full' | 'minimal';
  /** Keyboard-shortcut overrides (shortcut id → combo). */
  shortcut_overrides?: Record<string, string>;
  /** Operator-chat sidebar width, in px. */
  op_chat_width?: number;
  /** Pi/terminals dock layouts keyed by harness slug (dockview JSON blobs). */
  pi_dock_layouts?: Record<string, unknown>;

  updated_at?: string;
}

export async function readProfile(wsOverride?: string): Promise<Profile> {
  return (await readOperatorState<Profile>('operator_user_profile', wsOverride)) ?? {};
}

export async function writeProfile(profile: Profile): Promise<Profile> {
  const next: Profile = { ...profile, updated_at: new Date().toISOString() };
  await writeOperatorState('operator_user_profile', next);
  return next;
}

/** @deprecated kept for legacy callers — returns the table name now. */
export function PROFILE_PATH_CONST() { return 'harness_shared.operator_user_profile'; }
