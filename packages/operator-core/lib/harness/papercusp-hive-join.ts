/**
 * papercusp-hive-join — the JOIN-the-canonical-hive path for the dogfood bootstrap
 * (the cross-account pivot: an install JOINS the ONE canonical `papercusp` hive
 * rather than CREATING its own per-owner one — see
 * agent-insights/papercusp-shared-hive-per-owner).
 *
 * When the build bakes the canonical hive's INVITE (pubkey + invite secret — NEVER
 * a private key), `bootstrapPapercuspHive` calls `joinCanonicalPapercuspHive`
 * instead of the clone+create+Solution-C path:
 *   1. subscribe to the invite topic (so the owner's announce is ingested),
 *   2. bounded-wait for the owner's hive to actually announce (owner must be online),
 *   3. `joinHiveAsView` over the announced member-links — which read-only-clones each
 *      member repo (the CODE) AND re-keys the joined harnesses onto the owner's
 *      federation topic (so the owner's plans/work-items federate IN).
 *
 * Best-effort + non-fatal: no gh auth, an offline owner (no announce yet), or a
 * wiring failure all return a `skipped` result and the NEXT boot retries — exactly
 * like the clone path's auth_required handling, so a fresh launch is never broken.
 *
 * Admission: the joiner receives the owner's hive-scoped content only once the OWNER
 * admits it (the owner's allowlist policy / membership) — a one-time owner-side
 * setup, NOT something this path can do.
 */

import { resolveLocalGithubIdentity } from '../identity/resolve-local-github-identity';
import { PAPERCUSP_WORKSPACE_ID } from './papercusp-workspace';
import { PAPERCUSP_HIVE_SLUG } from './ensure-papercusp-hive';
import { AWAITING_GH_SIGNIN_DETAIL } from './bootstrap-papercusp-hive-detail';
import { CANONICAL_PAPERCUSP_HIVE_INVITE } from './canonical-hive-invite';

/** The baked canonical-hive invite — pubkey + secret only (no private key). */
export interface CanonicalHiveInvite {
  /** Raw-32 Ed25519 PUBLIC key, base64 — the hive's federation-topic identity. */
  pubkeyBase64: string;
  /** Directory invite secret (hex) — the discovery topic for the owner's announce. */
  inviteSecret: string;
  /** Verified owner device PUBLIC key for cold first-log admission (D-006). */
  ownerDevicePubkey?: string;
}

/**
 * Resolve the canonical invite. Precedence: `explicit` (tests) → `--define`'d env
 * (PAPERCUP_DOGFOOD_POT_PUBKEY + PAPERCUP_DOGFOOD_POT_INVITE_SECRET — a build-time
 * OVERRIDE, e.g. pointing a staging build at a different canonical hive) → the COMMITTED
 * canonical constant (canonical-hive-invite.ts — the version-tracked default that ships
 * on every platform; the invite is a discovery token, not an access grant, per D-001).
 * Returns null when none are set (dev builds before activation → per-owner create fallback).
 * (Legacy PAPERCUP_DOGFOOD_HIVE_* env names still accepted — dual-accept until callers migrate.)
 */
export function bakedCanonicalHiveInvite(explicit?: CanonicalHiveInvite | null): CanonicalHiveInvite | null {
  if (explicit) return explicit;
  const pubkeyBase64 = (process.env.PAPERCUP_DOGFOOD_POT_PUBKEY ?? process.env.PAPERCUP_DOGFOOD_HIVE_PUBKEY)?.trim();
  const inviteSecret = (
    process.env.PAPERCUP_DOGFOOD_POT_INVITE_SECRET ?? process.env.PAPERCUP_DOGFOOD_HIVE_INVITE_SECRET
  )?.trim();
  const ownerDevicePubkey = (
    process.env.PAPERCUP_DOGFOOD_POT_OWNER_DEVICE_PUBKEY ??
    process.env.PAPERCUP_DOGFOOD_HIVE_OWNER_DEVICE_PUBKEY
  )?.trim();
  if (pubkeyBase64 && inviteSecret) {
    return {
      pubkeyBase64,
      inviteSecret,
      ...(ownerDevicePubkey ? { ownerDevicePubkey } : {}),
    };
  }
  return CANONICAL_PAPERCUSP_HIVE_INVITE;
}

export type JoinProgressStep = 'clone' | 'submodules';
export type JoinProgressStatus = 'running' | 'done' | 'error' | 'skipped';

export interface JoinCanonicalResult {
  state: 'joined' | 'skipped';
  slug: string | null;
  reason?: string;
  /**
   * P-539: the skip happened BEFORE this box joined the canonical invite topic, so the
   * WI-1585 ingest re-trigger can never fire (the canonical pot announces only on that
   * topic) and only an in-process retry recovers it before the next app start.
   */
  retryable?: boolean;
}

/** Injectable seams (lib/ DI-for-tests). Production defaults to the real impls. */
export interface JoinCanonicalDeps {
  resolveGithub?: typeof resolveLocalGithubIdentity;
  /** Wire the hive directory transport + return the invite/announce seam. Default:
   *  hive-directory-boot ensureHiveDirectoryWired. */
  ensureWired?: (workspaceId: string) => Promise<{
    joinInviteTopic: (secret: string) => Promise<unknown>;
    confirmInviteAnnounce?: (secret: string, opts?: { timeoutMs?: number }) => Promise<{
      found?: boolean;
      peersOnTopic?: number;
      hive?: {
        potId?: string;
        memberLinks?: string[];
        hivePubkey?: string;
        ownerDevicePubkey?: string;
      } | null;
    } | null>;
  } | null>;
  /** List discovered hives (fallback memberLinks source if the confirm omits them).
   *  Default: hive-directory listDiscoveredHives. */
  listDiscovered?: () => Promise<
    Array<{ potId: string; hivePubkey?: string; ownerDevicePubkey?: string; memberLinks?: string[] }>
  >;
  /** The hive join. Default: harness/join-hive joinHiveAsView. */
  joinHive?: (opts: {
    potId: string;
    title?: string;
    /** The hive's Ed25519 pubkey (base64) — keys the joiner's hives-row identity (P-005). */
    hivePubkey?: string;
    /** Verified owner device pubkey from the directory announce — stamps the remote view. */
    ownerDevicePubkey?: string;
    memberLinks: string[];
    workspaceId: string;
  }) => Promise<{
    ok: boolean;
    potSlug?: string;
    error?: string;
  }>;
  setHomeWorkspace?: (ws: string) => void;
  record?: (step: JoinProgressStep, status: JoinProgressStatus, extra?: { percent?: number; detail?: string }) => void;
  /** confirmInviteAnnounce bounded-wait budget (ms). Default 25s. */
  confirmTimeoutMs?: number;
  /** Bound the directory-wiring step (ensureWired + joinInviteTopic) so a hung
   *  connect degrades to a retry instead of freezing the bar at 5%. Default 30s
   *  (> the Octokit 20s request timeout, so the inner timeout wins on the normal
   *  hung-GitHub path and this stays the last-resort backstop). */
  wireTimeoutMs?: number;
}

async function defaultEnsureWired(workspaceId: string) {
  const { ensureHiveDirectoryWired } = await import('../hive-directory-boot');
  return ensureHiveDirectoryWired(workspaceId) as ReturnType<NonNullable<JoinCanonicalDeps['ensureWired']>>;
}

async function defaultListDiscovered(): Promise<
  Array<{ potId: string; hivePubkey?: string; ownerDevicePubkey?: string; memberLinks?: string[] }>
> {
  const { getHiveDirectory } = await import('../hive-directory-deps');
  return getHiveDirectory().listDiscoveredHives({ includeExpired: true });
}

async function defaultJoinHive(opts: {
  potId: string;
  title?: string;
  hivePubkey?: string;
  ownerDevicePubkey?: string;
  memberLinks: string[];
  workspaceId: string;
}) {
  const { joinHiveAsView } = await import('./join-hive');
  return joinHiveAsView(opts);
}

function defaultSetHome(ws: string): void {
  // Mirror bootstrap's defaultSetHomeWorkspace so the joined hive is the visible home.
  void (async () => {
    try {
      const { ensureWorkspaceEntry, writeRegistry } = await import('../workspace-registry');
      // REGISTER the workspace first (idempotent + provisions the dir), THEN make
      // it current. Setting `current` to an unlisted id left the registry in a
      // `current`-points-at-unknown state → unknown_workspace on git-identity save
      // + a greyed-out GitHub sign-in button on a fresh clean install. ensureWorkspaceEntry
      // re-reads + persists the entry; we mutate the returned registry to set current.
      const reg = ensureWorkspaceEntry(ws, 'Papercusp');
      if (reg.current !== ws) {
        reg.current = ws;
        writeRegistry(reg);
      }
    } catch {
      /* best-effort */
    }
  })();
}

/**
 * Race a promise against a timeout; rejects with a labeled Error on expiry so the
 * caller can degrade to a retry instead of awaiting forever. Defense-in-depth atop
 * the Octokit request timeout: bounds the join's wiring step against ANY hang, so a
 * stalled connect never pins the dogfood progress bar at 5%.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * JOIN the canonical `papercusp` hive from its baked invite. Best-effort; the NEXT
 * boot retries on any skip (gh unauth / owner offline / no member-links yet).
 */
export async function joinCanonicalPapercuspHive(
  invite: CanonicalHiveInvite,
  deps: JoinCanonicalDeps = {},
): Promise<JoinCanonicalResult> {
  const resolveGithub = deps.resolveGithub ?? resolveLocalGithubIdentity;
  const ensureWired = deps.ensureWired ?? defaultEnsureWired;
  const listDiscovered = deps.listDiscovered ?? defaultListDiscovered;
  const joinHive = deps.joinHive ?? defaultJoinHive;
  const setHome = deps.setHomeWorkspace ?? defaultSetHome;
  const record = deps.record ?? (() => {});
  const confirmTimeoutMs = deps.confirmTimeoutMs ?? 25_000;
  const wireTimeoutMs = deps.wireTimeoutMs ?? 30_000;

  try {
    // 1. gh identity — the directory needs an announce identity to wire.
    const id = await resolveGithub();
    if (id.kind !== 'ok') {
      // A transient failure (gh timed out on a starved first boot, /user got no answer)
      // is not a sign-out: retry in-process like a wiring stall (P-539), or the first
      // join waits for the next app start (P-007 run #13).
      if (id.transient) {
        record('clone', 'running', { percent: 0, detail: 'waiting for GitHub to respond' });
        return {
          state: 'skipped',
          slug: null,
          reason: `GitHub identity unavailable: ${id.reason ?? 'unknown'}`.slice(0, 200),
          retryable: true,
        };
      }
      // No gh yet → park at 0% with the sign-in prompt (banner stays visible); the
      // setup wizard re-triggers the join after sign-in.
      record('clone', 'running', { percent: 0, detail: AWAITING_GH_SIGNIN_DETAIL });
      return { state: 'skipped', slug: null, reason: `join awaiting GitHub sign-in${id.reason ? ` (${id.reason})` : ''}` };
    }

    // 2. Wire the directory + subscribe to the canonical invite topic.
    record('clone', 'running', { percent: 5, detail: 'connecting to the Papercusp hive' });
    let wiring: Awaited<ReturnType<typeof ensureWired>>;
    try {
      wiring = await withTimeout(ensureWired(PAPERCUSP_WORKSPACE_ID), wireTimeoutMs, 'hive directory wiring');
    } catch (e) {
      // A stalled wire (e.g. a hung GitHub call that never responds) must NOT pin
      // the bar at 5% forever — degrade to a retry like every other non-fatal step
      // here. P-539: retryable, because the invite topic is not joined yet (a slow
      // DHT bootstrap alone exceeds the bound on the Mac VM rig).
      record('clone', 'running', { percent: 10, detail: 'waiting for the Papercusp hive to come online' });
      return {
        state: 'skipped',
        slug: null,
        reason: `hive directory wiring stalled: ${(e as Error)?.message ?? e}`.slice(0, 200),
        retryable: true,
      };
    }
    if (!wiring) {
      record('clone', 'running', { percent: 0, detail: AWAITING_GH_SIGNIN_DETAIL });
      return { state: 'skipped', slug: null, reason: 'hive directory not wired (gh auth?)', retryable: true };
    }
    // joinInviteTopic voids discovery.flushed() so it should return promptly, but
    // bound it defensively too — a hang here would also strand the bar at 5%.
    await withTimeout(wiring.joinInviteTopic(invite.inviteSecret), wireTimeoutMs, 'join invite topic').catch(() => {});

    // 3. Bounded-wait for the owner's hive to actually announce on the topic.
    //    NOT a hard gate (WI-1585 VM-half defect A): confirmInviteAnnounce only
    //    reports a hive that NEWLY appears during its poll window — its `seen`
    //    snapshot is taken from the live discovered set, which the boot wiring
    //    HYDRATES from the PG offline cache. So an announce already ingested on a
    //    PRIOR boot (or earlier this process) can NEVER be "found", and a joiner
    //    that ever cached the canonical announce without completing the join
    //    (owner offline / announce late at boot — the Avis-iMac LIVE-1 strand)
    //    was PERMANENTLY unjoinable: every boot skipped "owner offline" while a
    //    valid pubkey-pinned announce sat in its own cache. The trust anchor is
    //    the baked-pubkey PIN below — appearance freshness is only a liveness
    //    hint — so a missed confirm now FALLS THROUGH to the pubkey-pinned
    //    discovered-cache match instead of returning.
    const confirm = wiring.confirmInviteAnnounce
      ? await wiring.confirmInviteAnnounce(invite.inviteSecret, { timeoutMs: confirmTimeoutMs }).catch(() => null)
      : null;

    // 4. PIN to the committed pubkey (P-003 trust anchor). The invite topic is a
    //    DISCOVERY channel — ANYONE with the (committed) invite secret can announce
    //    on it, including a DIFFERENT / divergent / stale hive that happens to share
    //    the `papercusp` potId. So the baked canonical pubkey is the authority: only
    //    an announce whose `hivePubkey` matches it may be joined. Matching by potId
    //    (the previous `find(h => h.potId === potId)` fallback) is exactly the
    //    hijack vector — the owner's own divergent ef77075a key was announced under
    //    the same `papercusp` potId and a fresh install joined that EMPTY hive
    //    instead of canonical 76dee8ea (the slug-rename key-divergence bug,
    //    2026-07-01). Never match on potId; never trust the announced pubkey over
    //    the baked one.
    let memberLinks: string[] = [];
    let ownerDevicePubkey: string | undefined = invite.ownerDevicePubkey;
    let potId: string = PAPERCUSP_HIVE_SLUG;
    if (confirm?.found && confirm.hive?.hivePubkey === invite.pubkeyBase64) {
      memberLinks = confirm.hive.memberLinks ?? [];
      potId = confirm.hive.potId ?? PAPERCUSP_HIVE_SLUG;
      ownerDevicePubkey = confirm.hive.ownerDevicePubkey ?? ownerDevicePubkey;
    }
    if (memberLinks.length === 0) {
      const hives = await listDiscovered().catch(() => []);
      const match = hives.find((h) => h.hivePubkey === invite.pubkeyBase64);
      if (match) {
        potId = match.potId;
        memberLinks = match.memberLinks ?? [];
        ownerDevicePubkey = match.ownerDevicePubkey ?? ownerDevicePubkey;
      } else if (!confirm?.found) {
        // Neither a live announce NOR a cached pubkey-pinned one — the honest
        // "owner offline / dead secret" skip (G-002 stays honest: an invite
        // secret nobody announces on still never reports success).
        record('clone', 'running', { percent: 10, detail: 'waiting for the Papercusp hive to come online' });
        return { state: 'skipped', slug: null, reason: 'canonical hive not announcing yet (owner offline)' };
      } else if (confirm.hive && confirm.hive.hivePubkey !== invite.pubkeyBase64) {
        // A NON-canonical hive is announcing on our invite topic (pubkey mismatch).
        // Do NOT join it — wait for the canonical owner's announce (retry next boot).
        record('clone', 'running', {
          percent: 10,
          detail: 'waiting for the Papercusp hive to come online',
        });
        return {
          state: 'skipped',
          slug: null,
          reason: `ignoring non-canonical invite-topic announce (pubkey ${String(
            confirm.hive.hivePubkey ?? '?',
          ).slice(0, 12)}… != committed ${invite.pubkeyBase64.slice(0, 12)}…)`,
        };
      }
    }
    if (memberLinks.length === 0) {
      record('clone', 'running', { percent: 15, detail: 'Papercusp hive announced — waiting for member links' });
      return { state: 'skipped', slug: null, reason: 'announce has no member-links yet' };
    }

    // 5. JOIN — read-only-clones each member repo + re-keys onto the owner's topic.
    record('clone', 'running', { percent: 40, detail: 'joining + cloning the Papercusp hive' });
    const res = await joinHive({
      potId,
      title: 'Papercusp',
      // P-003 invariant: the joiner's hives-row identity is ALWAYS the committed
      // canonical pubkey (never a possibly-divergent announced one) — this is what
      // memberLinks above were pinned to, and it keys the P-005 fire-once latch
      // (getHiveByPubkey on the baked pubkey) so the next boot finds the join.
      hivePubkey: invite.pubkeyBase64,
      ...(ownerDevicePubkey ? { ownerDevicePubkey } : {}),
      memberLinks,
      workspaceId: PAPERCUSP_WORKSPACE_ID,
    });
    if (!res.ok) {
      record('clone', 'error', { detail: res.error ?? 'join failed' });
      return { state: 'skipped', slug: null, reason: `join failed: ${res.error ?? 'unknown'}` };
    }

    setHome(PAPERCUSP_WORKSPACE_ID);
    record('clone', 'done');
    // Member clones happen inside the join; mark the second phase terminal so the
    // setup-finish gate is satisfied (federation of the data is then ongoing).
    record('submodules', 'done');
    return { state: 'joined', slug: res.potSlug ?? potId };
  } catch (e) {
    record('clone', 'error', { detail: (e as Error)?.message?.slice(0, 120) ?? 'join error' });
    return { state: 'skipped', slug: null, reason: `join error: ${(e as Error)?.message ?? e}`.slice(0, 200) };
  }
}
