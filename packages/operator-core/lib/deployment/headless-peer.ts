/**
 * Headless-peer device identity + admission for an auto-provisioned frame
 * (`cloud-deployment-layer-2026-06-06` P-014/P-015).
 *
 * A cloud frame federates like any peer (D-004) — it needs a device identity
 * (Ed25519 keypair) and to be ADMITTED so the local peer aggregates its log. A
 * frame has no human at a keyboard, so:
 *   - we mint it a fresh device keypair here (the raw-32-byte-base64 pubkey the
 *     substrate's announce/admission uses), and
 *   - the OWNER vouches for it: `admit()` records the frame's device pubkey as an
 *     admitted headless peer; `revoke()` adds it to the substrate's
 *     `revoked_pubkeys` blocklist on teardown (the real revocation lever — every
 *     peer's admission union honors it).
 *
 * The substrate wiring is an injected `HeadlessPeerAdmission` seam so the
 * operator-side flow (identity → admit on join → revoke on teardown) is fully
 * unit-testable, and the deep substrate adapter (which the federation plan +
 * real multi-machine verify) plugs in behind it.
 */
import { generateKeyPairSync } from 'node:crypto';
import type { DeploymentConfig, DeploymentContext, Frame } from '@papercusp/deployment-driver';

export interface FrameDeviceIdentity {
  /** Raw 32-byte Ed25519 device pubkey, base64 (matches the substrate announce format). */
  devicePubkeyBase64: string;
  /** PKCS#8 PEM private key — staged on the frame so IT signs its own announces. */
  privateKeyPem: string;
}

/** Mint a fresh Ed25519 device identity for an auto-provisioned frame. */
export function generateFrameDeviceIdentity(): FrameDeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  // The raw 32-byte Ed25519 pubkey is the tail of the 44-byte SPKI-DER (12-byte prefix).
  const raw = spki.subarray(spki.length - 32);
  return {
    devicePubkeyBase64: raw.toString('base64'),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export interface HeadlessPeerAdmission {
  /** Admit a frame's device pubkey as a headless peer (owner-vouched). */
  admit(input: { frameId: string; devicePubkeyBase64: string; harnessSlug: string; workspaceId: string }): Promise<void>;
  /** Revoke a frame's device pubkey (teardown) — adds it to the substrate blocklist. */
  revoke(input: { frameId: string; devicePubkeyBase64?: string; harnessSlug: string; workspaceId: string }): Promise<void>;
}

/**
 * A no-op admission that just logs — the safe default until the substrate adapter
 * is wired. A frame still federates via its boot announce; this is the explicit
 * owner-vouch layer on top. Tests inject a recording mock; production injects the
 * real substrate adapter.
 */
export function loggingHeadlessPeerAdmission(
  log?: (level: 'info' | 'warn', msg: string) => void,
): HeadlessPeerAdmission {
  return {
    async admit({ frameId, devicePubkeyBase64 }) {
      log?.('info', `[headless-peer] admit frame ${frameId} (pubkey ${devicePubkeyBase64.slice(0, 12)}…) — substrate adapter pending`);
    },
    async revoke({ frameId }) {
      log?.('info', `[headless-peer] revoke frame ${frameId} — substrate adapter pending`);
    },
  };
}

/**
 * Build a driver `onJoin` hook (P-015): mint the frame a device identity (once,
 * recorded on `frame.meta.devicePubkey`), then admit it as a headless peer.
 * Idempotent: a frame that already carries a device pubkey is re-admitted, not
 * re-keyed.
 */
export function makeHeadlessJoinHook(
  admission: HeadlessPeerAdmission,
): (frame: Frame, config: DeploymentConfig, ctx: DeploymentContext) => Promise<void> {
  return async (frame, _config, ctx) => {
    const existing = (frame.meta?.devicePubkey as string | undefined) ?? undefined;
    const devicePubkeyBase64 = existing ?? generateFrameDeviceIdentity().devicePubkeyBase64;
    if (!existing) {
      frame.meta = { ...(frame.meta ?? {}), devicePubkey: devicePubkeyBase64 };
    }
    await admission.admit({
      frameId: frame.id,
      devicePubkeyBase64,
      harnessSlug: ctx.harnessSlug,
      workspaceId: ctx.workspaceId,
    });
    ctx.log?.('info', `[headless-peer] frame ${frame.id} admitted as a headless peer`);
  };
}

/** Revoke a frame's device pubkey on teardown (P-015 — closes the federation door). */
export async function revokeFrameOnTeardown(
  frame: Frame,
  harnessSlug: string,
  workspaceId: string,
  admission: HeadlessPeerAdmission,
): Promise<void> {
  await admission.revoke({
    frameId: frame.id,
    devicePubkeyBase64: frame.meta?.devicePubkey as string | undefined,
    harnessSlug,
    workspaceId,
  });
}
