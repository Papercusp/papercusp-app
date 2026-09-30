/**
 * install-rule-io — the real (git + network + resolver) wiring for installing a
 * Cupboard rule into the local rule store (portable-identity-packages P-011, D-023 §6).
 *
 * The rule sibling of install-rubric-io: the DI-testable core stays in
 * install-rule-core.ts; this file wires the real deps and returns a structured
 * result. Never throws for an expected failure. There is no seed step — a rule is
 * resolved from the store by the blueprint bundle that pins it.
 */
import { installRuleFromCupboardCore, InstallRuleError, type InstallRuleCoreResult } from './install-rule-core';
import { cupboardGitDeps } from './install-io';
import type { ContentPinRef } from './install-self-describing-core';
import { resolveListingByKind } from './resolve-listing-by-kind';

export interface InstallRuleFromCupboardInput {
  listingId?: string;
  githubUrl?: string;
  listingRef?: string;
}

export type InstallRuleFromCupboardResult =
  | { ok: true; result: InstallRuleCoreResult }
  | { ok: false; status: number; error: string; detail?: string };

export async function installRuleFromCupboard(
  input: InstallRuleFromCupboardInput,
): Promise<InstallRuleFromCupboardResult> {
  let githubUrl = typeof input.githubUrl === 'string' ? input.githubUrl.trim() : '';
  let listingRef = typeof input.listingRef === 'string' ? input.listingRef.trim() : '';
  // Only a listing carries the Worker's publish-time content pin (P-002); a direct
  // githubUrl install is an unverified tip clone by construction.
  let pin: ContentPinRef | undefined;
  if (!githubUrl && input.listingId) {
    const resolved = await resolveListingByKind(String(input.listingId), 'rule');
    if ('error' in resolved) return { ok: false, status: resolved.status, error: resolved.error };
    githubUrl = resolved.githubUrl;
    if (!listingRef) listingRef = resolved.ref;
    pin = resolved.pin;
  }
  if (!githubUrl) return { ok: false, status: 400, error: 'githubUrl or listingId required' };
  if (!listingRef) return { ok: false, status: 400, error: 'listingRef required (the rule subdir)' };
  try {
    return { ok: true, result: await installRuleFromCupboardCore({ githubUrl, listingRef, pin }, cupboardGitDeps()) };
  } catch (e) {
    if (e instanceof InstallRuleError) return { ok: false, status: e.status, error: e.message };
    return {
      ok: false,
      status: 500,
      error: 'install failed',
      detail: e instanceof Error ? e.message.slice(0, 300) : String(e),
    };
  }
}
