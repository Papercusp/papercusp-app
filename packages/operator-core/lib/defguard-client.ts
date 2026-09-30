/**
 * Defguard admin API client. Used by the mobile pair endpoint to mint an
 * enrollment URL+token bound to a per-device Defguard user. The phone uses
 * the URL+token via the Defguard enrollment flow (Rust-side `mesh_enroll`
 * Tauri command) to generate a WireGuard keypair, register the pubkey,
 * and receive its WG config.
 *
 * Env vars (set in `.env.local`):
 *   - DEFGUARD_URL          — e.g. https://mesh.papercuspai.com (control plane)
 *   - DEFGUARD_API_TOKEN    — admin bearer minted from /admin/users/admin/api-tokens
 *
 * Without these the pair endpoint returns enrollmentUrl/Token = null and
 * the phone falls back to LAN-only routing.
 *
 * Defguard flow (verified against defguard-core 2.0.1):
 *   1. POST /api/v1/user        — create one user per phone device
 *   2. POST /api/v1/user/{u}/start_enrollment — mint URL+token
 *
 * Ownership/cleanup: caller is responsible for deleting the per-device
 * user when the device is revoked (DELETE /api/v1/user/{u}).
 */

import { createHash } from 'node:crypto';
import { withWorkspace } from '@papercusp/db-org';

const DEFGUARD_URL = process.env.DEFGUARD_URL ?? process.env.DEFGUARD_CONTROL_URL ?? 'https://mesh.papercuspai.com';
const DEFGUARD_TOKEN = process.env.DEFGUARD_API_TOKEN ?? '';

export interface DefguardEnrollment {
  controlUrl: string;
  enrollmentUrl: string;
  enrollmentToken: string;
  defguardUsername: string;
}

export interface DefguardAuditBinding {
  deviceId: string;
  workspaceId: string;
  userEmail: string;
  defguardUsername: string;
}

export interface DefguardAuditStore {
  recordEnrollment(binding: DefguardAuditBinding): Promise<void>;
  assertRevocationBinding(binding: DefguardAuditBinding): Promise<void>;
  recordRevocation(binding: DefguardAuditBinding, outcome: 'deleted' | 'already_absent'): Promise<void>;
}

function workspaceScope(workspaceId: string): string {
  return createHash('sha256').update(workspaceId).digest('hex').slice(0, 8);
}

function deviceUsername(deviceId: string, workspaceId: string): string {
  const device = deviceId.slice(0, 12).replace(/[^a-zA-Z0-9-]/g, '');
  return `pcusp-${workspaceScope(workspaceId)}-${device}`;
}

function bindingFor(opts: { deviceId: string; userEmail: string; workspaceId: string }): DefguardAuditBinding {
  const workspaceId = opts.workspaceId.trim();
  const userEmail = opts.userEmail.trim().toLowerCase();
  const deviceId = opts.deviceId.trim();
  if (!workspaceId) throw new Error('defguard enrollment requires workspaceId');
  if (!userEmail) throw new Error('defguard enrollment requires authenticated userEmail');
  if (!deviceId) throw new Error('defguard enrollment requires deviceId');
  return { deviceId, workspaceId, userEmail, defguardUsername: deviceUsername(deviceId, workspaceId) };
}

function auditId(kind: string): string {
  return `defguard-${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function writeBindingAudit(
  action: string,
  binding: DefguardAuditBinding,
  details: Record<string, unknown>,
): Promise<void> {
  await withWorkspace(binding.workspaceId, async (tx) => {
    await tx`
      INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
      VALUES (
        ${auditId(action)}, ${Date.now()}, ${binding.userEmail}, ${action},
        ${binding.defguardUsername},
        ${JSON.stringify({
          deviceId: binding.deviceId,
          workspaceId: binding.workspaceId,
          operatorEmail: binding.userEmail,
          defguardUsername: binding.defguardUsername,
          ...details,
        })}::text::jsonb,
        ${binding.workspaceId}
      )
    `;
  });
}

const defaultAuditStore: DefguardAuditStore = {
  async recordEnrollment(binding) {
    await writeBindingAudit('defguard.enrollment.minted', binding, {});
  },
  async assertRevocationBinding(binding) {
    const rows = await withWorkspace(binding.workspaceId, async (tx) => tx<{ id: string }[]>`
      SELECT id
      FROM harness_shared.audit_log
      WHERE workspace_id = ${binding.workspaceId}
        AND actor = ${binding.userEmail}
        AND action = 'defguard.enrollment.minted'
        AND subject = ${binding.defguardUsername}
        AND details ->> 'deviceId' = ${binding.deviceId}
      ORDER BY ts DESC
      LIMIT 1
    `);
    if (rows.length === 0) {
      throw new Error('defguard revocation binding mismatch: no enrollment for this workspace/operator/device');
    }
  },
  async recordRevocation(binding, outcome) {
    await writeBindingAudit('defguard.user.revoked', binding, { outcome });
  },
};

async function dg<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${DEFGUARD_URL}${path}`, {
    method,
    headers: {
      'authorization': `Bearer ${DEFGUARD_TOKEN}`,
      'content-type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`defguard ${method} ${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  return text ? (JSON.parse(text) as T) : (null as T);
}

export async function mintDefguardEnrollment(opts: {
  deviceId: string;
  userEmail: string;
  workspaceId: string;
}, deps: { audit?: DefguardAuditStore } = {}): Promise<DefguardEnrollment | null> {
  if (!DEFGUARD_TOKEN) return null;

  const binding = bindingFor(opts);
  const username = binding.defguardUsername;

  // Create user-per-device. 409 means it already exists (re-pair); ignore.
  try {
    await dg('POST', '/api/v1/user', {
      username,
      first_name: 'Papercusp',
      last_name: `Device ${opts.deviceId.slice(0, 8)}`,
      email: `${username}@papercusp.local`,
      phone: null,
      password: null,
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (!msg.includes('409')) throw e;
  }

  // Mint enrollment.
  const enrol = await dg<{ enrollment_token: string; enrollment_url: string }>(
    'POST',
    `/api/v1/user/${username}/start_enrollment`,
    { send_enrollment_notification: false, email: null },
  );

  // Enrollment is not complete until its authenticated tenant/operator binding
  // is durable. A retry is safe: user creation tolerates 409 and mints a fresh token.
  await (deps.audit ?? defaultAuditStore).recordEnrollment(binding);

  return {
    controlUrl: DEFGUARD_URL,
    enrollmentUrl: enrol.enrollment_url,
    enrollmentToken: enrol.enrollment_token,
    defguardUsername: username,
  };
}

export async function revokeDefguardUser(
  opts: { deviceId: string; userEmail: string; workspaceId: string },
  deps: { audit?: DefguardAuditStore } = {},
): Promise<void> {
  if (!DEFGUARD_TOKEN) return;
  const binding = bindingFor(opts);
  const audit = deps.audit ?? defaultAuditStore;
  await audit.assertRevocationBinding(binding);
  const username = binding.defguardUsername;
  let outcome: 'deleted' | 'already_absent' = 'deleted';
  try {
    await dg('DELETE', `/api/v1/user/${username}`);
  } catch (e) {
    if (!(e as Error).message.includes('404')) throw e;
    outcome = 'already_absent';
  }
  await audit.recordRevocation(binding, outcome);
}
