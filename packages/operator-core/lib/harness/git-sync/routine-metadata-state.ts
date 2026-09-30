import type { AgentActionableRemedy } from '../../sync/pot-git/github-divergence';
import type { BridgeTickOutcome } from '../../sync/pot-git/github-bridge-tick';
import type { OwnHeadPublishTickOutcome } from '../../sync/pot-git/own-head-publish';
import type { AnnounceBudgetState } from '../../sync/pot-git/ref-announce';
import type { ParkedRefAnnouncements } from '../../sync/pot-git/ref-announce-tick';
import type { SignedSnapshotFloor } from '../../sync/pot-git/signed-context';

/**
 * WI-7063 — complete persisted shapes for the remaining multi-writer nested
 * values under `routines.metadata`.
 *
 * `patchRoutineMetadata` uses Postgres' top-level JSONB `||` operator. Writing
 * one of these keys therefore replaces its entire nested object, and
 * `JSON.stringify` silently drops any property whose value is `undefined`.
 * Every writer must pass through the matching function below: the required
 * TypeScript shape catches ordinary omissions, while the runtime assertion
 * catches loose JSON/`any` values before an omission can erase stored state.
 *
 * This deliberately does not deep-merge. Some writers replace a complete
 * observation while others explicitly carry selected prior state; preserving
 * arbitrary stale fields would blur that distinction and make intended
 * deletion impossible.
 */

export interface GithubBridgeRoutineState {
  at: number;
  ran: BridgeTickOutcome['ran'];
  skipped: NonNullable<BridgeTickOutcome['skipped']> | null;
  egress_target: BridgeTickOutcome['egressTarget'];
  ingressed: BridgeTickOutcome['ingressed'];
  egress: BridgeTickOutcome['egress'];
  last_admitted: BridgeTickOutcome['lastAdmitted'];
  divergence: BridgeTickOutcome['verdict']['action'];
  needs_owner: boolean;
  agent_actionable: boolean;
  agent_remedies: AgentActionableRemedy[];
  egress_head: string | null;
  errors: string[];
}

export interface OwnHeadPublishRoutineState {
  at: number;
  changed: OwnHeadPublishTickOutcome['changed'];
  branch: OwnHeadPublishTickOutcome['branch'];
  sha: OwnHeadPublishTickOutcome['headSha'];
  publishedSha: string | null;
  backlogRemains: boolean;
  blockedAtCommit: string | null;
  oversizedCommit: string | null;
  refused: string | null;
  exemptedFindingsCount: number;
}

export interface RefAnnounceRoutineState {
  lastEventId: number;
  budgetStates: Record<string, AnnounceBudgetState | null>;
  publishVersion: number;
  publishGeneration: string | null;
  replayFloors: Record<string, SignedSnapshotFloor>;
  parked: ParkedRefAnnouncements;
  at: number;
}

declare const COMPLETE_ROUTINE_METADATA_STATE: unique symbol;

type CompleteRoutineMetadataState<T, K extends string> = T & {
  readonly [COMPLETE_ROUTINE_METADATA_STATE]: K;
};

export type CompleteGithubBridgeRoutineState = CompleteRoutineMetadataState<GithubBridgeRoutineState, 'github_bridge'>;
export type CompleteOwnHeadPublishRoutineState = CompleteRoutineMetadataState<
  OwnHeadPublishRoutineState,
  'own_head_publish'
>;
export type CompleteRefAnnounceRoutineState = CompleteRoutineMetadataState<RefAnnounceRoutineState, 'ref_announce'>;

/**
 * The patch type closes the bypass: these three keys cannot be handed an inline
 * object even if a future writer forgets the module-level convention. Only the
 * completeness functions can produce the type-only brand accepted here.
 */
export type GitSyncRoutineMetadataPatch = Record<string, unknown> & {
  github_bridge?: CompleteGithubBridgeRoutineState;
  own_head_publish?: CompleteOwnHeadPublishRoutineState;
  ref_announce?: CompleteRefAnnounceRoutineState;
};

const GITHUB_BRIDGE_FIELDS = [
  'at',
  'ran',
  'skipped',
  'egress_target',
  'ingressed',
  'egress',
  'last_admitted',
  'divergence',
  'needs_owner',
  'agent_actionable',
  'agent_remedies',
  'egress_head',
  'errors',
] as const satisfies readonly (keyof GithubBridgeRoutineState)[];

const OWN_HEAD_PUBLISH_FIELDS = [
  'at',
  'changed',
  'branch',
  'sha',
  'publishedSha',
  'backlogRemains',
  'blockedAtCommit',
  'oversizedCommit',
  'refused',
  'exemptedFindingsCount',
] as const satisfies readonly (keyof OwnHeadPublishRoutineState)[];

const REF_ANNOUNCE_FIELDS = [
  'lastEventId',
  'budgetStates',
  'publishVersion',
  'publishGeneration',
  'replayFloors',
  'parked',
  'at',
] as const satisfies readonly (keyof RefAnnounceRoutineState)[];

function assertCompleteState<T extends object>(metadataKey: string, fields: readonly (keyof T)[], state: T): T {
  const missing = fields.filter(
    (field) => !Object.prototype.hasOwnProperty.call(state, field) || state[field] === undefined,
  );
  if (missing.length > 0) {
    throw new TypeError(
      `git-sync routine metadata.${metadataKey} is incomplete; missing/undefined: ${missing.join(', ')}`,
    );
  }
  return state;
}

export function completeGithubBridgeState(state: GithubBridgeRoutineState): CompleteGithubBridgeRoutineState {
  return assertCompleteState('github_bridge', GITHUB_BRIDGE_FIELDS, state) as CompleteGithubBridgeRoutineState;
}

export function completeOwnHeadPublishState(state: OwnHeadPublishRoutineState): CompleteOwnHeadPublishRoutineState {
  return assertCompleteState('own_head_publish', OWN_HEAD_PUBLISH_FIELDS, state) as CompleteOwnHeadPublishRoutineState;
}

export function completeRefAnnounceState(state: RefAnnounceRoutineState): CompleteRefAnnounceRoutineState {
  return assertCompleteState('ref_announce', REF_ANNOUNCE_FIELDS, state) as CompleteRefAnnounceRoutineState;
}
