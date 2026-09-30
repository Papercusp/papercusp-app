/**
 * Install a rule FROM the Cupboard into the local rule store
 * (portable-identity-packages-2026-09-26 P-011, D-023 §6 — the D-055 gap).
 *
 * A `kind='rule'` listing is mirror-repo-backed like a rubric: `<listing_ref>/`
 * holds `rule.json` + `listing.json`. Installing = clone, validate with the SAME
 * reader the store enumerates with (`readRuleDir` → `parseRulePackage`, so a
 * manifest mixing sync and async shapes, a guard off the pre-tool sink, or an
 * unbounded condition is refused before anything lands), and place the dir under
 * the writable user layer, where it shadows the bundled floor.
 *
 * Landing the dir IS the install. A rule does nothing until a blueprint bundle
 * pins it and a wearer applies that artifact; compile then binds a sync context
 * rule's provider and refuses an operation or asynchronous one.
 *
 * An ASYNC rule also has to agree with the installing workspace's catalogs
 * (P-018, D-027 §1): its `on` must be an active catalogued event key and its
 * class verb must declare a capability. The caller supplies that check, and it
 * is a required argument so no install path can land an async rule unchecked.
 */
import {
  readRuleDir, RULE_MANIFEST, userRulesDir, type LocalAsyncRule, type LocalRule,
} from './rule-store';
import {
  installSelfDescribingFromCupboard,
  type InstallSelfDescribingDeps,
  type InstallSelfDescribingInput,
  type SelfDescribingKindSpec,
  type VerifiedContentPin,
} from './install-self-describing-core';

export {
  InstallSelfDescribingError as InstallRuleError,
} from './install-self-describing-core';

export interface InstallRuleCoreResult {
  ok: true;
  ref: string;
  ruleId: string;
  title: string;
  version: string;
  delivery: LocalRule['delivery'];
  /** The hook sink a sync rule runs at; absent for an async reaction rule. */
  sink?: string;
  source: string;
  installedTo: string;
  pin: VerifiedContentPin | null;
}

/** Returns a refusal message for an async rule the workspace cannot run, or null. */
export type AsyncRuleInstallChecker = (rule: LocalAsyncRule) => Promise<string | null>;

export async function installRuleFromCupboardCore(
  input: InstallSelfDescribingInput,
  deps: InstallSelfDescribingDeps,
  checkAsyncRule: AsyncRuleInstallChecker,
): Promise<InstallRuleCoreResult> {
  const spec: SelfDescribingKindSpec<LocalRule> = {
    label: 'rule',
    manifestFile: RULE_MANIFEST,
    readDir: (dir, ref) => readRuleDir(dir, ref, 'user'),
    validate: async (rule) => rule.delivery === 'async' ? checkAsyncRule(rule) : null,
    userDir: userRulesDir,
  };
  const r = await installSelfDescribingFromCupboard(input, spec, deps);
  return {
    ok: true,
    ref: r.ref,
    ruleId: r.meta.id,
    title: r.meta.title,
    version: r.meta.version,
    delivery: r.meta.delivery,
    ...(r.meta.delivery === 'sync' ? { sink: r.meta.sink } : {}),
    source: r.source,
    installedTo: r.installedTo,
    pin: r.pin,
  };
}
