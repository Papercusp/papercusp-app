/**
 * Channel-2 publisher attestation (relocated from the retired per-harness
 * publish route — comb-retire-per-harness-sharing-2026-06-11 P-006; originally
 * Phase 9 item 1). Resolves the local GitHub identity + device keypair +
 * idempotent device-binding gist so a Cupboard publish can be attributed to a
 * verifiable, bannable device identity.
 *
 * Deps are injectable for testing; defaults lazily import the real identity
 * modules (only the deps actually used are imported). Returns `null` on ANY
 * failure (no gh auth, keychain miss, gist API down) — attestation is
 * best-effort and must NEVER block a publish.
 */

export interface AttestationDeps {
  resolveIdentity: () => Promise<{
    kind: string;
    githubUserId?: number;
    githubLogin?: string;
    token?: string;
  }>;
  keychainIdFor: (githubUserId: number) => string | Promise<string>;
  loadKeypair: (keychainId: string) => Promise<{ pubkeyBase64: string }>;
  ensureGist: (input: {
    keychainId: string;
    pubkeyBase64: string;
    deviceLabel: string;
    githubUserId: number;
    githubLogin: string;
    token: string;
  }) => Promise<string>;
}

export async function resolvePublisherAttestation(
  deps?: Partial<AttestationDeps>,
): Promise<{ attestation_gist_id: string; publisher_device_pubkey: string } | null> {
  try {
    const resolveIdentity =
      deps?.resolveIdentity ??
      (async () =>
        (await import('../identity/resolve-local-github-identity')).resolveLocalGithubIdentity());
    const keychainIdFor =
      deps?.keychainIdFor ??
      (async (id: number) =>
        (await import('../identity/device-keychain-id')).resolveDeviceKeychainId(id));
    const loadKeypair =
      deps?.loadKeypair ??
      (async (k: string) => (await import('../identity/attest')).loadOrGenerateDeviceKeypair(k));
    const ensureGist =
      deps?.ensureGist ??
      (async (i: Parameters<AttestationDeps['ensureGist']>[0]) =>
        (await import('../identity/attest')).ensureAttestationGist(i));

    const identity = await resolveIdentity();
    // The identity union is `{kind:'ok', githubUserId, githubLogin, token}` |
    // `{kind:'gh_auth_required'}` — only the 'ok' variant carries the fields. A
    // positive `kind !== 'ok'` narrow (rather than the negative `=== 'gh_auth_required'`
    // disjunction) lets TS narrow before we read githubUserId/githubLogin/token.
    if (identity.kind !== 'ok') return null;
    const { githubUserId, githubLogin, token } = identity as {
      githubUserId?: number;
      githubLogin?: string;
      token?: string;
    };
    if (githubUserId == null || !githubLogin || !token) return null;
    const keychainId = await keychainIdFor(githubUserId);
    const keypair = await loadKeypair(keychainId);
    const gistId = await ensureGist({
      keychainId,
      pubkeyBase64: keypair.pubkeyBase64,
      deviceLabel: 'unnamed-device',
      githubUserId,
      githubLogin,
      token,
    });
    if (!gistId) return null;
    return { attestation_gist_id: gistId, publisher_device_pubkey: keypair.pubkeyBase64 };
  } catch {
    return null; // best-effort — publish proceeds without attestation
  }
}
