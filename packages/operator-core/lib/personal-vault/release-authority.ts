/**
 * Owner authority for LOOSENING a reader-set label — releasing a disclosure or
 * lowering a privacy rule. Plan personal-data-reader-set-labels-2026-10-01
 * P-005, D-002 as amended by D-005.
 *
 * The threat is prompt injection: the agent asking for the release is the one
 * that read the content, and that content may be telling it to ask. So the
 * authority has to be something the agent cannot produce:
 *
 *   - an owner_directives row the UserPromptSubmit hook captured
 *     (captured_by_hook; orders:capture refuses any caller but the hook),
 *   - recorded in THIS agent's session (recorded_by = the caller's ownerId;
 *     owner_id is always the human, so it cannot address a session),
 *   - not declined,
 *   - whose text contains the release code for THIS exact request — every
 *     owner turn is captured, so without the code an unrelated "continue"
 *     would authorize anything,
 *   - and captured AFTER whatever it releases was delivered or last changed.
 *
 * The code is derived, not stored: the same (agent, request) always yields the
 * same code, so a refused call can be retried once the owner has typed it.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  findCapturedDirectiveContaining,
  getOwnerDirective,
  type OwnerDirectiveRow,
} from '../owner-directives';

export type ReleaseAuthorityRefusalCode =
  | 'release_authority_required'
  | 'release_authority_not_found'
  | 'release_authority_not_owner_typed'
  | 'release_authority_foreign'
  | 'release_authority_declined'
  | 'release_authority_code_missing'
  | 'release_authority_stale';

export type ReleaseAuthority =
  | { ok: true; directiveId: number; releaseRef: string; capturedAt: Date }
  | {
      ok: false;
      code: ReleaseAuthorityRefusalCode;
      detail: string;
      /** What the owner must type, in this session, to authorize the request. */
      releaseCode: string | null;
      ownerPrompt: string | null;
    };

/** No 0/O/1/I, so a code read aloud or retyped survives. 32 symbols ⇒ 5 bits each. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

export function releaseCode(agentOwnerId: string, request: string): string {
  const digest = createHash('sha256').update(`${agentOwnerId}\n${request}`).digest();
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[digest[i] % CODE_ALPHABET.length];
  return code;
}

export function releaseRefFor(directiveId: number): string {
  return `owner_directive:${directiveId}`;
}

function containsCode(text: string, code: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9])${code}([^A-Za-z0-9]|$)`, 'i').test(text);
}

export async function verifyReleaseAuthority(params: {
  workspaceId: string;
  agentOwnerId: string | null;
  /** Canonical form of the exact change; the release code is derived from it. */
  request: string;
  /** Owner-readable description of the change, for the prompt the agent relays. */
  describe: string;
  /** The directive the caller cites; omitted ⇒ the newest owner turn in this session carrying the code. */
  directiveId?: number;
  /** Newest delivery / rule change the release covers; the directive must postdate it. */
  notBefore: Date | null;
}, sql?: Sql): Promise<ReleaseAuthority> {
  const agentOwnerId = params.agentOwnerId?.trim();
  if (!agentOwnerId) {
    return {
      ok: false,
      code: 'release_authority_required',
      detail: 'this caller has no attributable agent identity, so no owner turn can be addressed to it',
      releaseCode: null,
      ownerPrompt: null,
    };
  }
  const code = releaseCode(agentOwnerId, params.request);
  const ownerPrompt = `Ask the owner to type, in this session: release ${code}  — this will ${params.describe}.`;
  const refuse = (refusal: ReleaseAuthorityRefusalCode, detail: string): ReleaseAuthority => ({
    ok: false,
    code: refusal,
    detail,
    releaseCode: code,
    ownerPrompt,
  });

  let directive: OwnerDirectiveRow | null;
  if (params.directiveId === undefined) {
    directive = await findCapturedDirectiveContaining({
      workspaceId: params.workspaceId,
      recordedBy: agentOwnerId,
      token: code,
    }, sql);
    if (!directive) {
      return refuse('release_authority_required', `no owner-typed turn in this session carries release code ${code}`);
    }
  } else {
    directive = await getOwnerDirective(params.directiveId, sql);
    if (!directive || directive.workspaceId !== params.workspaceId) {
      return refuse('release_authority_not_found', `owner directive #${params.directiveId} does not exist in this workspace`);
    }
  }

  if (!directive.capturedByHook) {
    return refuse('release_authority_not_owner_typed', `owner directive #${directive.id} was recorded by an agent, not captured from an owner-typed turn`);
  }
  if (directive.recordedBy !== agentOwnerId) {
    return refuse('release_authority_foreign', `owner directive #${directive.id} was typed into another session (${directive.recordedBy}), not this one`);
  }
  if (directive.dispositionStatus === 'declined') {
    return refuse('release_authority_declined', `owner directive #${directive.id} was declined`);
  }
  if (!containsCode(directive.verbatimText, code)) {
    return refuse('release_authority_code_missing', `owner directive #${directive.id} does not contain release code ${code}, which is bound to this exact request`);
  }
  if (params.notBefore && directive.createdAtMs <= params.notBefore.getTime()) {
    return refuse('release_authority_stale', `owner directive #${directive.id} predates what it would release (${params.notBefore.toISOString()})`);
  }
  return {
    ok: true,
    directiveId: directive.id,
    releaseRef: releaseRefFor(directive.id),
    capturedAt: new Date(directive.createdAtMs),
  };
}
