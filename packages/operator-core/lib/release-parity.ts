/** Exact tested-SHA / deployed-SHA / green-pin parity verdict. */

export type ReleaseParityState =
  | 'matched'
  | 'unresolved'
  | 'claimed-deploy-stale'
  | 'tested-deploy-mismatch'
  | 'deployed-not-green';

export interface ReleaseParityInput {
  testedSha: string | null;
  claimedDeployedSha: string | null;
  actualDeployedSha: string | null;
  greenPinSha: string | null;
}

export interface ReleaseParityVerdict extends ReleaseParityInput {
  ok: boolean;
  state: ReleaseParityState;
  summary: string;
  nextVerb: { name: string; args?: Record<string, unknown>; reason: string } | null;
}

function canonicalSha(value: string | null): string | null {
  return value && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}

function exactSha(a: string | null, b: string | null): boolean {
  const left = canonicalSha(a);
  const right = canonicalSha(b);
  return Boolean(left && right && left === right);
}

/**
 * Fail closed. A live-proof marker is trustworthy only when all three
 * independently sourced identities agree exactly:
 *
 *   tested candidate = caller's claimed deploy = actual live deploy = green pin.
 */
export function classifyReleaseParity(input: ReleaseParityInput): ReleaseParityVerdict {
  const nextTrace = input.testedSha
    ? {
        name: 'release:trace',
        args: { sha: input.testedSha },
        reason:
          'Re-read the exact tested SHA against the current green/deploy authorities before recording live proof.',
      }
    : {
        name: 'release:trace',
        reason: 'Resolve the tested candidate and current release authorities before recording live proof.',
      };
  if (
    !canonicalSha(input.testedSha) ||
    !canonicalSha(input.claimedDeployedSha) ||
    !canonicalSha(input.actualDeployedSha) ||
    !canonicalSha(input.greenPinSha)
  ) {
    return {
      ...input,
      ok: false,
      state: 'unresolved',
      summary: 'Exact parity is unresolved because one or more SHA authorities are missing.',
      nextVerb: nextTrace,
    };
  }
  if (!exactSha(input.claimedDeployedSha, input.actualDeployedSha)) {
    return {
      ...input,
      ok: false,
      state: 'claimed-deploy-stale',
      summary: `The caller claimed deployed SHA ${input.claimedDeployedSha}, but live :3070 currently reports ${input.actualDeployedSha}.`,
      nextVerb: nextTrace,
    };
  }
  if (!exactSha(input.testedSha, input.actualDeployedSha)) {
    return {
      ...input,
      ok: false,
      state: 'tested-deploy-mismatch',
      summary: `Tests ran against ${input.testedSha}, but live :3070 is ${input.actualDeployedSha}.`,
      nextVerb: nextTrace,
    };
  }
  if (!exactSha(input.testedSha, input.greenPinSha)) {
    return {
      ...input,
      ok: false,
      state: 'deployed-not-green',
      summary: `The tested/live SHA ${input.testedSha} is not the current green pin ${input.greenPinSha}; deployed does not imply gate-tested.`,
      nextVerb: nextTrace,
    };
  }
  return {
    ...input,
    ok: true,
    state: 'matched',
    summary: `${input.testedSha} is the exact tested, green-pinned, and live-deployed SHA.`,
    nextVerb: null,
  };
}
