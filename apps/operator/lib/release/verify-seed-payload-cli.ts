/**
 * verify-seed-payload-cli — does a COMMITTED seed's manifest actually describe its bytes?
 *
 * WHY THIS EXISTS (WI-39447). `ensure-release-seed.sh`'s repair-net decides whether the
 * committed `src-tauri/seed` is "usable" and, when it is, skips the cut entirely. That
 * predicate used to be pure FILE PRESENCE — manifest.json exists, epoch-keys.json exists —
 * so the shipped seed that this work-item is about (corestore 50,165,685 bytes short of its
 * declared sizeBytes, hash 13b280d77c08… vs actual fa4fddc22e97…) read as perfectly usable.
 * A build shipped it silently, and on a fresh install `restoreSeed` skipped the failing store
 * and reported SUCCESS with an EMPTY hive.
 *
 * That is the same defect as the one inside the cutter, one level up: A GUARD THAT JUDGES
 * METADATA CANNOT SEE METADATA THAT DESCRIBES ABSENT BYTES. So this CLI runs the check the
 * INSTALLER itself runs — `defaultSeedRegistry()` → `provider.verify()`, via the shared
 * {@link judgeSeedPayloadIntegrity} judge — rather than re-implementing a size or hash
 * comparison here. Re-implementing is how this file's sibling got burned once already: a
 * local `measure()` that omitted the LOG exclusion produced a false size red. If the cut side
 * and the install side ever disagree, that disagreement is the bug we want surfaced, and it
 * cannot surface while each side runs its own private notion of "intact".
 *
 * Measured cost on the real ~475MB seed: ~1.1s. That is why this runs unconditionally instead
 * of hiding behind an opt-in flag — a Tauri build takes minutes, and a correctness check
 * nobody enables is not a check.
 *
 * IT NOW CARRIES THREE LEGS, all of the same class: each was a guard whose ONLY production
 * caller was `cut-seed-cli`, so each ran only when a cut ran — on a build path that skips the
 * cut by design. Putting them here puts them on the path that actually ships.
 *   1. payload integrity  — does the manifest describe the bytes? (judgeSeedPayloadIntegrity)
 *   2. degradation        — is a sparse label honest?            (assertSeedNotDegraded)
 *   3. release identity — do the bytes carry the machine identity or any owner name,
 *                         email, organization, or cross-box alias resolved by the
 *                         canonical release audit?                (judgeSeedIdentity)
 * Measured on the real ~475MB seed: ~1.1s + ~1.8s. Cheap enough that all three run
 * unconditionally — a correctness check nobody enables is not a check.
 *
 * EXIT CODES — three-way ON PURPOSE, and the third is the point:
 *   0  every leg passed — safe to treat the committed seed as usable.
 *   1  BROKEN — a leg returned a verdict of NOT SHIPPABLE (payload does not match the
 *      manifest, a dishonest sparse label, or the bytes carry the build box's identity).
 *   2  COULD NOT DETERMINE — no manifest, unreadable manifest, the verifier itself failed to
 *      run (missing deps, not a full checkout, a VM leg), or the identity leg cannot prove
 *      cleanliness because it is inside the neutralized UTS namespace with no real hostname.
 *
 * Exit 2 exists so a caller can never read "I could not check" as "it is fine" — the exact
 * false-absence trap that lets a broken artifact through. A caller that collapses 2 into 0
 * has re-created the bug this file was written to close; `ensure-release-seed.sh` instead
 * falls back to the old presence-only predicate AND says out loud that it did.
 */

import { readFile } from 'node:fs/promises';

import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

import { judgeSeedPayloadIntegrity, type SeedStoreVerifier } from './seed-payload-integrity-guard.js';
import { assertSeedNotDegraded } from './seed-degradation-guard.js';
import {
  judgeSeedIdentity,
  mergeSeedIdentityLiterals,
  releaseSeedRedactionValues,
  resolveIdentityLiterals,
  SEED_REAL_HOSTNAME_ENV,
  type ResolveIdentityInput,
} from './seed-identity-guard.js';
import { DEFAULT_NEUTRAL_BUILD_HOSTNAME } from './seed-hostname-neutralization.js';
import { OWNER_NAME_ENV } from './release-content-scrub.js';

export const EXIT_OK = 0;
export const EXIT_MISMATCH = 1;
export const EXIT_UNDETERMINED = 2;

export interface VerifySeedPayloadArgs {
  readonly seedDir: string;
  readonly origin: 'fresh' | 'reuse';
}

/**
 * Seams the tests drive. All three are production-default in the CLI entry: the real installer
 * registry, the real process env, and the real machine probes.
 */
export interface VerifySeedPayloadDeps {
  /** Injected in tests; production uses the guard's default (the real installer registry). */
  readonly verify?: SeedStoreVerifier;
  /** Defaults to `process.env`. Supplies the neutral-hostname override and the UTS marker. */
  readonly env?: Record<string, string | undefined>;
  /** Machine-identity probes. Never passed from the release path — see seed-identity-guard.ts. */
  readonly probe?: ResolveIdentityInput['probe'];
  /** Test seam; production resolves the canonical audit's full runtime literal set. */
  readonly releaseLiterals?: () => readonly string[];
}

/** Parse argv. Throws on a malformed invocation so a typo cannot silently verify nothing. */
export function parseVerifySeedPayloadArgs(argv: readonly string[]): VerifySeedPayloadArgs {
  let seedDir: string | null = null;
  let origin: 'fresh' | 'reuse' = 'reuse';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--seed') {
      const next = argv[i + 1];
      if (!next) throw new Error('--seed requires a directory path');
      seedDir = next;
      i += 1;
    } else if (arg === '--origin') {
      const next = argv[i + 1];
      if (next !== 'fresh' && next !== 'reuse') {
        throw new Error(`--origin must be 'fresh' or 'reuse' (got ${JSON.stringify(next)})`);
      }
      origin = next;
      i += 1;
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
  }

  if (!seedDir) throw new Error('--seed <dir> is required');
  return { seedDir, origin };
}

/**
 * Run the verdict. Returns an exit code rather than calling process.exit so the whole thing is
 * testable without spawning; see the three-way contract in the file header.
 *
 * ⚠ `origin` is NO LONGER COSMETIC (WI-10001612). It still selects the remedy wording, but it
 * now also decides whether a PRE-MARKER corestore — one carrying no `coreProjectedFrom` — may be
 * admitted by the legacy block-count fallback in seed-degradation-guard: 'reuse' allows it (the
 * grafted artifact is frozen and predates the marker), 'fresh' does not (every fresh filtered cut
 * records the fact, so an unmarked fresh payload is a sparse or full cut the size floor should
 * judge). Passing 'fresh' for a grafted seed can therefore turn a pass into a refusal.
 *
 * It defaults to 'reuse'
 * because `--reuse-corestore` is the DEFAULT shipping path (ensure-release-seed.sh:135,
 * PAPERCUSP_SEED_REUSE_CORESTORE=auto), so a graft that inherited an unverified entry is the
 * likeliest cause of a red here — and its remedy (re-cut FRESH; never recompute the entry
 * from the short bytes, which would only make the lie self-consistent) is the one a reader
 * needs to see.
 */
export async function runVerifySeedPayload(
  args: VerifySeedPayloadArgs,
  log: (msg: string) => void = console.error,
  deps: VerifySeedPayloadDeps = {},
): Promise<number> {
  const { verify } = deps;
  const env = deps.env ?? process.env;

  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(`${args.seedDir}/manifest.json`, 'utf8'));
  } catch (err) {
    // UNDETERMINED, not a mismatch: an absent/unreadable manifest is "no seed to judge",
    // which is the pre-existing seed_present() question and not this guard's to answer.
    log(`[seed-verify] cannot read ${args.seedDir}/manifest.json — ${(err as Error).message}`);
    return EXIT_UNDETERMINED;
  }

  try {
    const result = await judgeSeedPayloadIntegrity({
      // The judge reads only `stores`; a manifest missing it fails closed below.
      manifest: manifest as Parameters<typeof judgeSeedPayloadIntegrity>[0]['manifest'],
      dir: args.seedDir,
      origin: args.origin,
      ...(verify ? { verify } : {}),
    });
    log(result.message);
    if (!result.ok) return EXIT_MISMATCH;

    // The SIBLING gap, same shape and same seam (D-023). `assertSeedNotDegraded` already judges
    // the FINAL manifest, so it covers both the fresh and the grafted cut — but its only
    // production caller is cut-seed-cli, so it runs ONLY WHEN A CUT RUNS. The default build
    // path skips the cut entirely, which means a committed seed that is labelled sparse while
    // carrying full history ships without this guard ever firing. Running it here puts it on
    // the path that actually ships. It respects PAPERCUSP_SEED_ACK_FULL_HISTORY, so a
    // deliberate acknowledged ship still passes rather than being blocked twice.
    //
    // ⚠ ITS OWN try/catch, NOT the outer one. This guard signals refusal by THROWING, so
    // letting the outer handler see it would report a degraded seed as EXIT_UNDETERMINED —
    // "could not check" instead of "it is broken", which is the exact collapse the three-way
    // contract exists to prevent. (It did precisely that until a test caught it.) A throw here
    // fails CLOSED: on the ship path a guard that errors must not wave the seed through.
    try {
      assertSeedNotDegraded(manifest as Parameters<typeof assertSeedNotDegraded>[0], {
        origin: args.origin,
        env,
      });
    } catch (err) {
      log(`[seed-verify] ${(err as Error).message}`);
      return EXIT_MISMATCH;
    }

    // The THIRD and last member of the same class (MEASURED: `assertStagedSeedCarriesNoIdentity`'s
    // only production caller is cut-seed-cli.ts:1350, so like the two legs above it runs ONLY WHEN
    // A CUT RUNS — and the default build path skips the cut). A committed seed carrying the build
    // box's username, home path or hostname therefore ships inside every installer with no guard
    // ever firing. Costs 1,835ms on the real ~475MB seed, the same
    // order as the payload leg's ~1.1s, so like it this runs unconditionally rather than behind a
    // flag nobody sets. Runs LAST because it is the expensive leg: a seed already failing above
    // gets its verdict without paying for the scan.
    //
    // ⛔ DELIBERATELY NOT `assertStagedSeedCarriesNoIdentity` — the throwing form is WRONG HERE.
    // It throws for two unrelated reasons and this file's whole contract is that those two must
    // not collapse: an identity HIT is a broken seed (1), while "cannot prove clean" — running
    // inside the UTS namespace with no PAPERCUSP_SEED_REAL_HOSTNAME handed down — is the
    // undetermined verdict (2). In the guard's own words, reporting clean there "would be a
    // statement about the sandbox, not about the seed". Collapsing that into 1 would red every
    // sandboxed build. So we take the same judgement as DATA, via the judge form, and map each
    // reason to its own exit code.
    const neutralHostname = env.PAPERCUSP_SEED_BUILD_HOSTNAME || DEFAULT_NEUTRAL_BUILD_HOSTNAME;
    const { literals: machine, unknownHostname } = resolveIdentityLiterals({
      env,
      neutralHostname,
      ...(deps.probe ? { probe: deps.probe } : {}),
    });
    let identity;
    try {
      const extra = (deps.releaseLiterals ?? (() => releaseSeedRedactionValues(undefined, env)))();
      const literals = mergeSeedIdentityLiterals(machine, extra, neutralHostname);
      identity = await judgeSeedIdentity({ dir: args.seedDir, literals });
    } catch (err) {
      // The SCAN could not run (unreadable file, vanished dir). Unlike the degradation guard
      // above — where a throw IS the refusal signal and so means "broken" — throwing is never
      // how this judge reports a finding; it reports one as `ok:false`. So a throw here really
      // is "could not check", and must not be dressed up as either verdict.
      log(`[seed-verify] could not scan the committed seed for release identity — ${(err as Error).message}`);
      return EXIT_UNDETERMINED;
    }
    log(identity.message);
    // A HIT OUTRANKS "CANNOT PROVE", so this is judged BEFORE unknownHostname — the one place
    // this leg deliberately departs from `assertStagedSeedCarriesNoIdentity`'s order. That form
    // refuses on the unknown hostname first, which costs nothing there because both outcomes are
    // the same exception. Here they are different exit codes, and the literals we CAN resolve
    // inside the namespace (username and home path) are conclusive on their own: finding
    // one is a definite breakage whether or not the hostname question is answerable. Reporting
    // that as "undetermined" would understate evidence we actually have.
    if (!identity.ok) return EXIT_MISMATCH;

    if (unknownHostname) {
      log(
        `[seed-verify] the resolvable identity literals are absent, but this seed cannot be called ` +
          `clean: gethostname() reports the neutral label '${neutralHostname}' and ` +
          `${SEED_REAL_HOSTNAME_ENV} was not handed down, so the REAL build hostname is unknowable ` +
          `from here and was never scanned for. Reporting clean would describe the sandbox, not the ` +
          `seed. Fix the re-exec to export ${SEED_REAL_HOSTNAME_ENV} (seed-hostname-neutralization.ts).`,
      );
      return EXIT_UNDETERMINED;
    }

    return EXIT_OK;
  } catch (err) {
    // The verifier could not RUN (missing provider deps, not a full checkout, a VM leg).
    // Never report that as either verdict.
    log(`[seed-verify] could not verify the seed payload — ${(err as Error).message}`);
    return EXIT_UNDETERMINED;
  }
}

// Run as the CLI only — `isCliEntry` is the repo's bundle-safe `require.main === module`
// (EI-650), and importing this module (the test, a future caller) stays side-effect-free.
// NOTE: no top-level await here on purpose — tsx transforms this file through its CJS
// preflight, where top-level await is a hard TransformError, and a crash-on-load would make
// EVERY exit code 1: the mismatch verdict and the "could not check" verdict would become
// indistinguishable, which is precisely the collapse the three-way contract above exists to
// prevent. It failed exactly that way once before this comment was written.
if (isCliEntry(import.meta.url)) {
  (async () => {
    try {
      return await runVerifySeedPayload(parseVerifySeedPayloadArgs(process.argv.slice(2)));
    } catch (err) {
      console.error(`[seed-verify] ${(err as Error).message}`);
      return EXIT_UNDETERMINED;
    }
  })()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('[seed-verify] FATAL:', e instanceof Error ? e.stack : e);
      process.exit(EXIT_UNDETERMINED);
    });
}
