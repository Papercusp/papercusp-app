/**
 * hive-descriptor-enrich — fresh per-announce enrichment of an owned hive's
 * descriptor (hive-from-repo-hardening-2026-06-11 P-004 / D-004).
 *
 * Before this, hivePubkey / memberRepos / memberLinks were derived only at
 * PUBLISH time (set_hive, boot, from-repo create) and frozen into the
 * registered descriptor — a member added through any other producer
 * (pot:add-member, harness:create { hive }) stayed invisible to the 5-min
 * reannounce until the next boot. This module is the announce-BUILD-time
 * enricher the directory calls via its injected `enrichDescriptor` seam, so
 * EVERY announce (timer, fresh-pair snapshot, explicit) reflects the registry
 * as of NOW.
 *
 * Best-effort by contract: any failure returns the descriptor unchanged (the
 * pre-P-004 behavior). Requires `desc.workspaceId` (stamped by the publish
 * call-sites) — without it there is nothing to derive against.
 */

import type { LocalHiveDescriptor } from './hive-directory';
import type { HarnessRegistry } from './harness-registry';
import type { HiveStatusBeacon } from './hive-beacon';

export interface EnrichDescriptorDeps {
  loadPubkey?: (workspaceId: string, potId: string) => Promise<string | null>;
  deriveMemberRepos?: (workspaceId: string, potId: string) => Promise<string[]>;
  loadRegistry?: (workspaceId?: string) => Promise<HarnessRegistry>;
  /**
   * Build the consent-gated status beacon for this hive (P-005 / brief B-06).
   * Returns undefined when the owner has not consented (no beacon on the wire).
   * Default: hive-beacon-publish.maybeBuildHiveBeacon (consent-gated + memoized).
   */
  buildBeacon?: (workspaceId: string, potId: string) => Promise<HiveStatusBeacon | undefined>;
}

export async function enrichLocalHiveDescriptor(
  desc: LocalHiveDescriptor,
  deps: EnrichDescriptorDeps = {},
): Promise<LocalHiveDescriptor> {
  if (!desc.workspaceId) return desc;
  const ws = desc.workspaceId;
  try {
    const deriveMemberRepos =
      deps.deriveMemberRepos ??
      (async (w: string, id: string) =>
        (await import('./hive-member-repos')).deriveHiveMemberRepoRefs(w, id));
    const loadRegistry =
      deps.loadRegistry ??
      (async (w?: string) => (await import('./harness-registry')).loadHarnessRegistry(w));
    const buildBeacon =
      deps.buildBeacon ??
      (async (w: string, id: string) =>
        (await import('./hive-beacon-publish')).maybeBuildHiveBeacon(w, id));

    // WI-3496 / D-032 R-3b, WIDENED past R-3's original `hive-directory-boot.ts:488`
    // scope: this is the P-004 announce-build enricher's pubkey read. Unlike the boot
    // wire at hive-directory-boot.ts:501 — which sits behind `if (!_wiring)` and so runs
    // ONCE PER PROCESS — this runs on EVERY announce, and the `desc.hivePubkey ??` guard
    // puts the two in SERIES: when the boot wire left the pubkey undefined, THIS read is
    // what decides every subsequent announce. It is therefore the retry/repair path, and
    // it used to be the quietest code on the critical path — swallowing TWICE for one
    // read (`.catch(() => null)` inside the old `loadPubkey` helper, plus a second
    // `.catch(() => null)` here), flattening not_found, io_error, decryption_failed and a
    // throw into a single silent `undefined`, which :118 below then omits from the frame
    // with no warning at all. Reporting merely "absent" reproduces the exact conflation
    // that kept this defect invisible, so report WHICH outcome fired, per hive, with the
    // keychainId actually used.
    let pk: string | undefined = desc.hivePubkey;
    if (!pk) {
      let pkOutcome: string;
      try {
        if (deps.loadPubkey) {
          // Injected test double: it has no status channel, so keep the prior
          // semantics exactly and do not invent an outcome we cannot observe.
          pk = (await deps.loadPubkey(ws, desc.potId).catch(() => null)) || undefined;
          pkOutcome = pk ? 'ok' : 'injected_dep_returned_null';
        } else {
          const { loadHiveKeyStatus } = await import('./identity/hive-keypair');
          const st = await loadHiveKeyStatus(ws, desc.potId);
          if (st.kind === 'ok') {
            pk = st.pubkeyBase64;
            pkOutcome = 'ok';
          } else if (st.kind === 'not_found') {
            pkOutcome = 'not_found';
          } else {
            pkOutcome = `error:${st.reason}`;
          }
        }
      } catch (e) {
        pkOutcome = `threw:${e instanceof Error ? e.message : String(e)}`;
      }
      if (pkOutcome !== 'ok') {
        const { hiveKeychainId } = await import('./identity/hive-keypair');
        console.warn(
          `[hive-descriptor-enrich] hivePubkey OMITTED from announce for hive ${desc.potId} ` +
            `(workspace ${ws}): ${pkOutcome} — keychainId=${hiveKeychainId(ws, desc.potId)}. ` +
            `This announce carries NO cross-Hive dial address. Unlike the boot-wire read, ` +
            `this path retries on EVERY announce, so a PERSISTENT cause repeats this line ` +
            `while a one-off transient appears exactly once.`,
        );
      }
    }
    const memberRepos = await deriveMemberRepos(ws, desc.potId).catch(() => [] as string[]);
    // P-005 (brief B-06): the consent-gated status beacon — undefined when the
    // owner has not opted in, so no beacon rides the announce. Best-effort.
    const beacon = await buildBeacon(ws, desc.potId).catch(() => undefined);

    // Fresh one-click member links over the HIVE federation topic — only when
    // the identity exists (a topic-less link is not joinable).
    let memberLinks = desc.memberLinks;
    if (pk) {
      const { parseGithubUrl } = await import('./harness/clone-github');
      const { formatHarnessLink } = await import('./harness/url-scheme');
      // A3 (EI-18788176839043286): publish the repoKey each member's store is
      // ACTUALLY named on this device, so a joiner adopts it instead of deriving
      // its own and silently landing on a different one.
      const { canonicalRepoKey } = await import('./sync/pot-git/repo-identity');
      const { deriveHiveFederationTopic, topicAsHex } = await import(
        './sync/hyperbee/derive-swarm-topic'
      );
      const reg = await loadRegistry(ws).catch(() => ({ projects: [] }) as HarnessRegistry);
      const topicHex = topicAsHex(deriveHiveFederationTopic(pk));
      const links: string[] = [];
      for (const m of reg.projects) {
        if (m.slug !== desc.potId && m.hive_slug !== desc.potId) continue;
        if (!m.github_remote || typeof m.github_repository_id !== 'number') continue;
        const parsed = parseGithubUrl(m.github_remote);
        if (!parsed) continue;
        links.push(
          formatHarnessLink({
            topic: topicHex,
            github: `${parsed.owner}/${parsed.repo}`,
            repoOwner: parsed.owner,
            repoName: parsed.repo,
            repoId: m.github_repository_id,
            repoKey: canonicalRepoKey(m),
          }),
        );
      }
      if (links.length) memberLinks = links;
    }

    // A3 (EI-18788176839043286): announce the repoKey the POT HOME's own bare
    // store is named here. The member links above can only be adopted by a peer
    // that already shares the upstream coords they are keyed on — and the home
    // entry is precisely the one that often has none (ensure-papercusp-hive
    // mints it upstream-less), so without this it can correlate against nothing
    // and derives its own key forever. Needs no correlator: a peer whose local
    // pot home matches this announce's potId adopts it directly.
    let homeRepoKey = desc.homeRepoKey;
    try {
      const { canonicalRepoKey } = await import('./sync/pot-git/repo-identity');
      const reg = await loadRegistry(ws);
      const home = reg.projects.find((p) => p.slug === desc.potId);
      if (home) homeRepoKey = canonicalRepoKey(home);
    } catch {
      /* registry unreadable — announce as registered, never fail the build */
    }

    return {
      ...desc,
      ...(pk ? { hivePubkey: pk } : {}),
      ...(memberRepos.length ? { memberRepos } : {}),
      ...(memberLinks?.length ? { memberLinks } : {}),
      ...(homeRepoKey ? { homeRepoKey } : {}),
      ...(beacon ? { beacon } : {}),
    };
  } catch (e) {
    // WI-3496 / D-032 R-3b: this outer catch is swallow point #5 on the announce
    // path — it discards the ENTIRE enrichment (pubkey, memberRepos, memberLinks,
    // homeRepoKey, beacon) and announces the bare descriptor. Failing soft here is
    // deliberate and stays: a broken enricher must not stop the hive announcing.
    // Failing SILENTLY is not — an announce silently stripped of its cross-Hive
    // dial address is indistinguishable from one that never had a key.
    console.warn(
      `[hive-descriptor-enrich] enrichment FAILED for hive ${desc.potId} ` +
        `(workspace ${desc.workspaceId ?? 'unknown'}): ` +
        `${e instanceof Error ? (e.stack ?? e.message) : String(e)}. ` +
        `Announcing the UNENRICHED descriptor — no hivePubkey, memberRepos, memberLinks, ` +
        `homeRepoKey or beacon rides this frame.`,
    );
    return desc;
  }
}
