/**
 * templates:new-app — materialize an app-template into a fresh coding harness AND
 * (by default) kick off a building agent seeded with the template's GUIDE.md (WI-3198).
 *
 * v1 (local-first-party-template-bundling-2026-07-07): the first-party templates ship
 * BUNDLED, so the common path COPIES the template's `<ref>/` dir straight from the local
 * store (no clone, works offline). The Cupboard MARKETPLACE path (clone the public
 * mirror) is a wired-but-dormant v2 seam behind FLAGS.TEMPLATES_MARKETPLACE. Both feed
 * the SAME materialize (overlay onto a new harness) — the source-acquire is the only
 * thing that differs, which is what lets a v2 user-installed template reuse this path.
 *
 * Composes existing tools through the in-process dispatcher (harness:create,
 * agent_chats:create/send_message), so each sub-step re-runs the caller's OWN
 * role/capability gates — a compound tool (see _compound-dispatch.ts).
 */
import { z } from 'zod';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { COORD_ROLES } from '../coordination/roles';
import { inProcessCall, type InnerCall } from '../_compound-dispatch';
import { gitCloneShallow } from '../../cupboard/install-io';
import { papercuspRoot } from '../../papercusp-root';
import { resolveTemplateListing, fetchTemplateGuide } from '../../cupboard/templates';
import {
  resolveLocalTemplate,
  readLocalGuide,
  resolveCheckoutProvenance,
  type CheckoutProvenance,
} from '../../cupboard/template-store';
import {
  resolveGenericLibsRoot,
  describeSupplyChain,
  type GenericLibsRootVerdict,
} from '../../cupboard/generic-libs-root';
import {
  materializeTemplateCore,
  compensateCreatedHarness,
  cloneSourceAcquire,
  localSourceAcquire,
  MaterializeTemplateError,
  type TemplateSourceDir,
  type MaterializeTemplateResult,
} from '../../cupboard/materialize-template-core';

const ok = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...payload }) }],
});
const fail = (status: number, error: string) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, status, error }) }],
});

/**
 * Where to build from — what a source resolver hands composeNewApp. `acquireSourceDir`
 * produces the `<ref>/` dir to overlay (a local dir passthrough, or a fresh clone).
 */
export interface ResolvedTemplateSource {
  listing: { id: string; ref: string; title: string };
  guide: string | null;
  guideTruncated: boolean;
  guideBranch: string | null;
  /**
   * Identity of the checkout this template's files were read FROM (git root +
   * HEAD sha + branch), or null when unresolved — e.g. the local store dir is
   * not itself a git repo, or the source is a fresh marketplace clone whose
   * provenance is not yet known at resolve time (EI-21909845207308404).
   */
  sourceCheckout: CheckoutProvenance | null;
  acquireSourceDir: () => Promise<TemplateSourceDir>;
}

/**
 * Compose the GUIDE.md into a builder kickoff message.
 *
 * The supply-chain block is appended AFTER the guide on purpose (P-005/WI-37791).
 * The GUIDE is authored once and shipped to every platform, so it can only ever
 * cite the dev-checkout example `file:../papercusp/libs/generic/<pkg>` — a path
 * that does not exist on a real install. The resolved root is per-install, known
 * only here, and it must reach the builder as an INSTRUCTION rather than sit in a
 * tool result the builder may never read: this message is the one surface every
 * kicked-off builder is guaranteed to see. Placing it last also means it is read
 * as the correction to the guide's example, which is exactly its job.
 */
function kickoffMessage(
  listing: { title: string; ref: string },
  guide: string | null,
  guideTruncated: boolean,
  supplyChain?: string,
): string {
  const head =
    `Build a new app from the "${listing.title}" template (ref: ${listing.ref}). ` +
    `Its files have been materialized into this harness — read PROTOCOL.md first, ` +
    `then GUIDE.md, and start from the materialized files.`;
  const tail = supplyChain ? `\n\n---\n${supplyChain}` : '';
  if (!guide) {
    return `${head}\n\n(The template GUIDE.md could not be pre-fetched — read GUIDE.md in the repo root, then compose the app per its MUST/SHOULD/FREE tiers.)${tail}`;
  }
  const trunc = guideTruncated
    ? '\n\n[GUIDE.md truncated here — read the full GUIDE.md in the repo for the rest.]'
    : '';
  return `${head}\n\nFollow the template's build guide below (honor its MUST/SHOULD/FREE tiers):\n\n---\n${guide}${trunc}${tail}`;
}

/**
 * The materializer's root-level operating contract. Templates own GUIDE.md and
 * may provide a richer protocol, but every successful `templates:new-app` result
 * must give its builder a stable first-read artifact. Keeping this fallback here
 * means marketplace/user templates get the same contract as bundled templates.
 */
export function buildDefaultProtocol(listing: { title: string; ref: string }): string {
  return `# Build protocol — ${listing.title}

Generated by \`templates:new-app\` for root template \`${listing.ref}\`.
This file is the operational companion to the root GUIDE.md: read it first, then
follow the GUIDE's MUST/SHOULD/FREE tiers.

1. Read \`GUIDE.md\` and \`template.yaml\` from this materialized root before
   making implementation decisions. The manifest's decision points, composed
   closure, checks, and MUSTs are the acceptance contract for this app.
2. Record each decision point, including its rationale, in the app's durable
   plan or work-item as it is answered. Do not leave decisions only in chat.
3. Run the checks named by the manifest and its composed closure incrementally;
   a passing typecheck alone is not completion evidence.
4. Preserve the template's composition boundaries and use the documented
   dependency/source paths for this install. If the GUIDE is insufficient,
   consult the listed Papercusp docs before inventing a convention.
5. Checkpoint after each meaningful milestone so another builder can resume
   without reconstructing decisions from a transcript.
6. Done means the required checks are green, the manifest's MUSTs are met, and
   every decision point is answered with verification evidence.
`;
}

/**
 * Ensure the app root has the launch-context protocol required by the Papercusp
 * app-template contract. A template-provided protocol is preserved; a missing
 * one gets the common fallback. Existing but unreadable/empty protocols fail
 * loudly so a successful materialization can never advertise an unusable root.
 */
export async function ensureBuildProtocol(
  rootPath: string,
  listing: { title: string; ref: string },
): Promise<{ path: string; created: boolean }> {
  const protocolPath = join(rootPath, 'PROTOCOL.md');
  try {
    const existing = await readFile(protocolPath, 'utf8');
    if (!existing.trim()) {
      throw new MaterializeTemplateError(
        `materialized template protocol at ${protocolPath} is empty`,
        422,
      );
    }
    return { path: protocolPath, created: false };
  } catch (error) {
    if (error instanceof MaterializeTemplateError) throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      throw new MaterializeTemplateError(
        `materialized template protocol at ${protocolPath} could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
        422,
      );
    }
  }

  try {
    await writeFile(protocolPath, buildDefaultProtocol(listing), 'utf8');
  } catch (error) {
    throw new MaterializeTemplateError(
      `materialized template protocol at ${protocolPath} could not be created: ${
        error instanceof Error ? error.message : String(error)
      }`,
      500,
    );
  }
  return { path: protocolPath, created: true };
}

/**
 * EI-21854247573857420: `overlayTemplateFiles` copies a template's ENTIRE root
 * onto the new app dir, but no template root ships a `.gitignore` — so a
 * materialized app's own git (created by `pot:create`, distinct from this
 * monorepo's) has nothing stopping it from tracking `node_modules/`/`.next/`
 * build output. That is what blew a real materialization past git-sync's
 * 250MB cumulative dirty-set peel limit (portal, 2026-08-30). Mirrors
 * `ensureBuildProtocol`: a template-provided `.gitignore` is preserved
 * untouched; a missing one gets this common fallback. Unlike PROTOCOL.md, an
 * EXISTING-but-empty `.gitignore` is not an error — an empty file is a
 * legitimate (if unusual) choice, not a broken artifact.
 */
const DEFAULT_APP_GITIGNORE = `node_modules/
.next/
dist/
out/
build/
*.tsbuildinfo
coverage/
.env
.env.*
*.log
logs/
.DS_Store
`;

export async function ensureGitignore(rootPath: string): Promise<{ path: string; created: boolean }> {
  const gitignorePath = join(rootPath, '.gitignore');
  try {
    await readFile(gitignorePath, 'utf8');
    return { path: gitignorePath, created: false };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      throw new MaterializeTemplateError(
        `materialized template .gitignore at ${gitignorePath} could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
        422,
      );
    }
  }
  try {
    await writeFile(gitignorePath, DEFAULT_APP_GITIGNORE, 'utf8');
  } catch (error) {
    throw new MaterializeTemplateError(
      `materialized template .gitignore at ${gitignorePath} could not be created: ${
        error instanceof Error ? error.message : String(error)
      }`,
      500,
    );
  }
  return { path: gitignorePath, created: true };
}

const RELEASE_GATE_SCRIPT_PRIORITY = [
  'check:gate',
  'check:union',
  'test:affected',
  'test',
  'build',
] as const;

/**
 * A newly materialized app is also a gated coding pot. `pot:create` writes that
 * pot's blueprint before the template overlay lands, so it cannot see the
 * package scripts the template provides. Without an additive `testCommand`,
 * subject-hive release routing falls through to `npm run build`; mobile
 * template roots intentionally expose `check:union` instead and therefore red
 * forever without running a single template assertion.
 *
 * Patch only the missing command and preserve every explicit blueprint choice.
 * The package's existing verification surface is reused in deterministic
 * priority order; templates without one keep the established build fallback.
 */
export async function ensureReleaseGateTestCommand(
  rootPath: string,
): Promise<{ command: string | null; updated: boolean }> {
  const packagePath = join(rootPath, 'package.json');
  let packageJson: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readFile(packagePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('root value is not an object');
    }
    packageJson = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { command: null, updated: false };
    }
    throw new MaterializeTemplateError(
      `materialized template package at ${packagePath} could not be parsed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      422,
    );
  }

  const scripts =
    packageJson.scripts && typeof packageJson.scripts === 'object' && !Array.isArray(packageJson.scripts)
      ? (packageJson.scripts as Record<string, unknown>)
      : null;
  const script = RELEASE_GATE_SCRIPT_PRIORITY.find(
    (name) => typeof scripts?.[name] === 'string' && (scripts[name] as string).trim().length > 0,
  );
  if (!script) return { command: null, updated: false };
  const command = script === 'test' ? 'npm test' : `npm run ${script}`;

  const blueprintPath = join(rootPath, '.papercusp', 'blueprint.yaml');
  let blueprint: Record<string, unknown>;
  try {
    const parsed = parseYaml(await readFile(blueprintPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('root value is not an object');
    }
    blueprint = parsed as Record<string, unknown>;
  } catch (error) {
    throw new MaterializeTemplateError(
      `materialized app blueprint at ${blueprintPath} could not be updated: ${
        error instanceof Error ? error.message : String(error)
      }`,
      422,
    );
  }

  const knobs =
    blueprint.knobs && typeof blueprint.knobs === 'object' && !Array.isArray(blueprint.knobs)
      ? (blueprint.knobs as Record<string, unknown>)
      : {};
  if (typeof knobs.testCommand === 'string' && knobs.testCommand.trim()) {
    return { command: knobs.testCommand, updated: false };
  }

  await writeFile(
    blueprintPath,
    stringifyYaml({ ...blueprint, knobs: { ...knobs, testCommand: command } }),
    'utf8',
  );
  return { command, updated: true };
}

/**
 * Is this failure "the slug is already taken"? (WI-37768)
 *
 * Load-bearing: it is the ONE pot:create failure we must never compensate, because the
 * pot under that slug belongs to an earlier call and rolling it back would destroy a
 * project this call never created. Matched on the message because pot:create reports it
 * as a `slug_exists:` code inside a string envelope, not as a typed error.
 */
function isSlugExists(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /slug_exists|already exists/i.test(msg);
}

/**
 * The slug is taken — say what that MEANS and how to get out of it (WI-37768).
 *
 * The bare passthrough ("pot:create failed: slug_exists: A harness 'x' already exists")
 * is true but useless at the moment it matters most: right after a failed run, when the
 * caller's instinct is to retry with the same args. That retry is the one move that
 * provably cannot work, and nothing in the old message said so.
 */
function slugExistsError(slug: string, cause: unknown): MaterializeTemplateError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new MaterializeTemplateError(
    `pot:create failed: ${detail}\n\n` +
      `The slug "${slug}" is already taken, so RETRYING THIS CALL UNCHANGED CANNOT SUCCEED. ` +
      `If a previous templates:new-app run failed partway and left this pot behind, it is now ` +
      `inspectable — check it before assuming it is empty: an existing pot may hold real work. ` +
      `To discard a known-stranded one: pot:obliterate { slug: "${slug}", confirm: true } ` +
      `(irreversible). Otherwise re-run under a different slug.`,
    422,
  );
}

export interface NewAppArgs {
  template: string;
  slug: string;
  parentDir?: string;
  kickoffBuilder: boolean;
  builderRole: string;
}

export interface NewAppDeps {
  /** Resolve a template ref to a build source (local-first; remote is the v2 seam). */
  resolveSource: (
    template: string,
  ) => Promise<ResolvedTemplateSource | { error: string; status: number }>;
  /** The parent dir when the caller passes none (creates it if absent). */
  defaultParentDir: () => string;
  /**
   * Resolve THIS install's libs/generic root for the builder's `file:` deps
   * (default: resolveGenericLibsRoot). Injected so a test can exercise both the
   * has-a-tree and the no-tree install without a real filesystem.
   */
  resolveSupplyChain?: () => GenericLibsRootVerdict;
}

/**
 * Local-first source resolver: the bundled first-party store, then — only when
 * FLAGS.TEMPLATES_MARKETPLACE is ON (v2) — the Cupboard mirror. Exported so the tool
 * wires it; composeNewApp itself stays source-agnostic (a test injects its own resolver).
 */
export async function resolveTemplateSource(
  template: string,
): Promise<ResolvedTemplateSource | { error: string; status: number }> {
  const local = resolveLocalTemplate(template);
  if (local) {
    const g = readLocalGuide(local);
    return {
      listing: { id: local.id, ref: local.ref, title: local.title },
      guide: 'error' in g ? null : g.guide,
      guideTruncated: 'error' in g ? false : g.guideTruncated,
      guideBranch: 'local',
      sourceCheckout: resolveCheckoutProvenance(local.dir),
      acquireSourceDir: localSourceAcquire(local.dir),
    };
  }
  // Not a bundled template — the Cupboard MARKETPLACE is a dormant v2 seam.
  if (!(await getFlag(FLAGS.TEMPLATES_MARKETPLACE, 'system'))) {
    return { error: `template not found in the local store: ${template}`, status: 404 };
  }
  const listing = await resolveTemplateListing(template);
  if ('error' in listing) return listing;
  if (!listing.githubUrl) return { error: `template "${listing.ref}" has no github_url`, status: 422 };
  const g = await fetchTemplateGuide({ githubUrl: listing.githubUrl, ref: listing.ref });
  return {
    listing: { id: listing.id, ref: listing.ref, title: listing.title },
    guide: 'error' in g ? null : g.guide,
    guideTruncated: 'error' in g ? false : g.guideTruncated,
    guideBranch: 'error' in g ? null : g.branch,
    // The clone happens lazily inside acquireSourceDir — there is no checkout
    // yet at resolve time, so its provenance is genuinely unknown here.
    sourceCheckout: null,
    acquireSourceDir: cloneSourceAcquire({
      githubUrl: listing.githubUrl,
      ref: listing.ref,
      cloneRepo: gitCloneShallow,
      tmpDir: tmpdir,
    }),
  };
}

/**
 * Pure composition (unit-testable with a mock `inner` + mock `deps`). Returns a ToolResult.
 */
export async function composeNewApp(args: NewAppArgs, inner: InnerCall, deps: NewAppDeps) {
  const src = await deps.resolveSource(args.template);
  if ('error' in src) return fail(src.status, src.error);

  const parentDir = args.parentDir?.trim() || deps.defaultParentDir();
  // `pot:create` expects its parent directory to exist. The default resolver
  // creates it, but an explicit custom parentDir bypasses that resolver; make
  // both input forms obey the same precondition before the durable create.
  mkdirSync(parentDir, { recursive: true });
  // Resolved BEFORE any durable step so the answer is reported even when the
  // builder kickoff is skipped or fails — the caller still needs to know where
  // (or whether) this install's component packages can be linked from.
  const supplyChain = (deps.resolveSupplyChain ?? resolveGenericLibsRoot)();

  // WI-37768: pot:create is the first DURABLE step, so anything that throws after it
  // strands the slug and blocks the retry. Roll the pot back — it was created by THIS
  // call, seconds ago, and nothing else has touched it, which is what makes
  // obliterating it a compensating transaction rather than destruction.
  const rollbackHarness = async ({ slug }: { slug: string }) => {
    const raw = await inner('pot:obliterate', { slug, confirm: true });
    const r = raw as { ok?: boolean; error?: string };
    // pot:obliterate is itself atomic (it rolls back rather than half-clear), so an
    // ok:false means the slug is still taken — surface that, do not assume.
    if (!r?.ok) {
      throw new Error(
        typeof raw === 'string' ? raw : (r?.error ?? 'pot:obliterate did not report ok'),
      );
    }
    // pot:obliterate historically removed only <papercuspRoot>/apps/<slug>.
    // This compound accepts a custom parentDir, so a failed materialization
    // could clear registry/schema state while stranding that committed checkout.
    // This call created exactly parentDir/slug moments ago; remove that exact child
    // only after the platform teardown reports success.
    const parent = resolve(parentDir);
    const createdPath = resolve(parent, slug);
    if (dirname(createdPath) !== parent) {
      throw new Error(`refusing unsafe rollback path outside parentDir: ${createdPath}`);
    }
    await rm(createdPath, { recursive: true, force: true });
  };

  let materialized: MaterializeTemplateResult;
  try {
    materialized = await materializeTemplateCore({
      ref: src.listing.ref,
      acquireSourceDir: src.acquireSourceDir,
      rollbackHarness,
      createHarness: async () => {
        // Create the app AS ITS OWN pot (hive home), NOT a standalone coding
        // harness — so it is PLAN-CAPABLE from birth. Plans are Hive-scoped
        // (resolvePlanScope), and a standalone harness can host none: the owner
        // hit this on 2026-07-08 and an agent had to hand-run the "make a pot +
        // add-member" workaround before it could plan the build. A pot IS the
        // plan-capable project unit ("every created Pot is a hive"; the
        // standalone/plain-harness path is being retired — _create.ts). We
        // create it IDLE (wakeInSeconds omitted ⇒ no Mug/Queen wake; the builder
        // chat below drives the build) and LOCAL-ONLY (no surprise GitHub remote
        // per materialized app — the owner publishes later). The template
        // overlays on top; overlayTemplateFiles protects .papercusp/blueprint.yaml
        // so the pot's own hive blueprint survives.
        let raw: unknown;
        try {
          raw = await inner('pot:create', {
            slug: args.slug,
            parentDir,
            repoRemote: 'local-only',
            // A template materialization already carries its complete build
            // knowledge in GUIDE.md/PROTOCOL.md. Seeding the generic coding
            // pack here blocks the actual overlay on embedding calls (measured
            // beyond pot:create's 900s timeout) and can strand a registered,
            // empty pot before a single template file lands. Keep normal
            // pot:create defaults unchanged; only this composition door skips
            // the unrelated creation-time seed.
            knowledgePack: 'none',
          });
        } catch (e) {
          // pot:create THREW rather than returning a result — so we cannot know how far
          // it got, and it commits its registry row before it finishes (this is the
          // failure actually observed: a PgBouncer `write CONNECTION_CLOSED` mid-call,
          // 2026-08-10, WI-37768).
          //
          // A slug_exists throw is the ONE case we must never compensate: the pot under
          // that slug belongs to some EARLIER call, and obliterating it would destroy
          // someone else's project. Every other error means the slug was free when this
          // call started, so anything now sitting under it was created by US.
          if (isSlugExists(e)) throw slugExistsError(args.slug, e);
          throw await compensateCreatedHarness(e, { slug: args.slug, path: '' }, rollbackHarness);
        }
        const r = raw as { ok?: boolean; slug?: string; path?: string; error?: string; message?: string };
        if (!r?.ok || !r.path || !r.slug) {
          // A THROWN sub-handler arrives as the framework's `handler_error: …`
          // PLAIN-TEXT envelope (unwrap() falls back to the raw string when the
          // payload isn't JSON). Dropping it reported an opaque "unknown error"
          // to the agent while the real cause was in the string (owner-hit
          // 2026-07-07, WI-3291 follow-up) — surface whatever we got, incl.
          // pot:create's {error,message} shape.
          const detail =
            typeof raw === 'string'
              ? raw
              : r?.error
                ? `${r.error}${r.message ? `: ${r.message}` : ''}`
                : raw
                  ? JSON.stringify(raw).slice(0, 300)
                  : 'unknown error';
          if (isSlugExists(detail)) throw slugExistsError(args.slug, detail);
          // EI-21107910194803524: pot:create can fail this way WITHOUT throwing —
          // createPotHarness's own outer catch already ran its BEST-EFFORT internal
          // `rollback()` (each undo step wrapped in try/catch, so a connection-level
          // fault mid-provisioning can leave one silently unreverted) and returned
          // { ok:false } as ordinary business data, not a thrown error. Reaching this
          // branch used to throw a bare MaterializeTemplateError with NO compensation
          // attempt at all — the asymmetry this item is about: the THROW path above
          // rolled back, this data-return path did not, so only ONE of the two ways
          // pot:create can fail was ever covered. Run the identical compensation here.
          // pot:obliterate tolerates a slug that was never actually registered
          // (hive_not_found), so this is safe even when nothing durable happened yet.
          throw await compensateCreatedHarness(
            new MaterializeTemplateError(`pot:create failed: ${detail}`, 422),
            { slug: args.slug, path: '' },
            rollbackHarness,
          );
        }
        return { slug: r.slug, path: r.path };
      },
    });
  } catch (e) {
    if (e instanceof MaterializeTemplateError) return fail(e.status, e.message);
    throw e;
  }

  // PROTOCOL.md is a required launch-context artifact, not an optional builder
  // convenience. Generate the common fallback when the template does not ship
  // one, preserve a valid template-owned protocol, and compensate the durable
  // pot if the verification/generation step fails.
  let releaseGateTestCommand: { command: string | null; updated: boolean } = {
    command: null,
    updated: false,
  };
  try {
    const protocol = await ensureBuildProtocol(materialized.path, src.listing);
    if (protocol.created && !materialized.filesCopied.includes('PROTOCOL.md')) {
      materialized.filesCopied.push('PROTOCOL.md');
    }
    const gitignore = await ensureGitignore(materialized.path);
    if (gitignore.created && !materialized.filesCopied.includes('.gitignore')) {
      materialized.filesCopied.push('.gitignore');
    }
    releaseGateTestCommand = await ensureReleaseGateTestCommand(materialized.path);
  } catch (e) {
    const compensated = await compensateCreatedHarness(
      e,
      { slug: materialized.slug, path: materialized.path },
      rollbackHarness,
    );
    return fail(
      compensated instanceof MaterializeTemplateError ? compensated.status : 500,
      compensated.message,
    );
  }

  // Kick off the builder (best-effort): open a role chat in the new harness + send
  // the GUIDE as its brief. A dispatch/gate failure here does NOT undo the
  // materialization — the app is created; report the builder outcome either way.
  let builder: { spawned: boolean; chatId?: string; role?: string; error?: string } = {
    spawned: false,
  };
  if (args.kickoffBuilder) {
    try {
      const chat = (await inner('agent_chats:create', {
        slug: materialized.slug,
        role: args.builderRole,
        title: `Build from template: ${src.listing.ref}`,
      })) as { id?: string; error?: string };
      if (!chat?.id) throw new Error(chat?.error ?? 'agent_chats:create returned no chat id');
      await inner('agent_chats:send_message', {
        slug: materialized.slug,
        chatId: chat.id,
        content: kickoffMessage(
          src.listing,
          src.guide,
          src.guideTruncated,
          describeSupplyChain(supplyChain),
        ),
      });
      builder = { spawned: true, chatId: chat.id, role: args.builderRole };
    } catch (e) {
      builder = {
        spawned: false,
        role: args.builderRole,
        error: e instanceof Error ? e.message.slice(0, 300) : String(e),
      };
    }
  }

  return ok({
    harnessSlug: materialized.slug,
    path: materialized.path,
    filesCopied: materialized.filesCopied,
    template: { id: src.listing.id, ref: src.listing.ref, title: src.listing.title },
    guideBranch: src.guideBranch,
    sourceCheckout: src.sourceCheckout,
    supplyChain,
    releaseGateTestCommand,
    builder,
  });
}

export default defineTool({
  name: 'templates:new-app',
  description:
    'Materialize an app-template into a NEW pot (its own Hive home — a plan-capable project, created IDLE + local-only) and (by default) kick off a building agent seeded with the template GUIDE. V1: first-party templates ship BUNDLED, so this copies them from the local store (works offline). Composes pot:create + agent_chats. Args: `template` (ref e.g. "papercusp-app" or listing id), `slug` (new harness + folder name), `parentDir?` (default <~/.papercusp>/apps), `kickoffBuilder?` (default true), `builderRole?` (default "architect"). Returns { ok, harnessSlug, path, filesCopied, template, guideBranch, supplyChain, builder:{spawned,chatId?} } — `supplyChain` is the resolved libs/generic root for THIS install (the real path for `file:` deps, or an explicit statement that this install has none), and the builder kickoff carries it. This is the "build from a template NOW" verb — the write complement of templates:get-guide.',
  guidance: {
    when: 'The user picked a template (from templates:list, or named one) and wants to START building the app — this scaffolds the harness AND hands the GUIDE to a builder in one call.',
    notWhen:
      'Just browsing what exists → templates:list. Only reading how a template builds (no new harness) → templates:get-guide. Creating a harness from a blueprint (not a template) → harness:create.',
    chaining: 'templates:list → templates:get-guide { template } → templates:new-app { template, slug }.',
    seeAlso: ['templates:list', 'templates:get-guide', 'harness:create'],
    returns:
      '{ ok, harnessSlug, path, filesCopied, template, guideBranch, sourceCheckout, supplyChain, releaseGateTestCommand, builder }. ' +
      '`sourceCheckout` (EI-21909845207308404) is { root, sha, branch } | null — the git identity of the checkout the operator actually read the template FROM ' +
      '(this can lag the canonical templates repo, e.g. a release checkout behind a green-checkpoint window). null on a marketplace clone (v2, provenance not yet known at resolve time) or a non-git dir. ' +
      'A materialized app failing its own template checks on first run is diagnosable from this field instead of a filesystem-wide grep across checkouts.',
  },
  capability: 'harness:write',
  // Fresh pot creation includes repo initialization, registry/schema setup and
  // routine seeding. Measured under load: the inner pot:create alone took 111s.
  // Match ptool's long-call budget so the compound can report its real outcome.
  // EI-21107910194803524: raised 300 -> 900. 300 was set against a 111s pot:create
  // baseline, but a real materialization on 2026-08-21 spent ~290s inside pot:create
  // ALONE under fleet load, before this compound's own overlay/manifest work. The
  // outer budget must exceed the inner one (pot:create is now 900s) plus that work,
  // and ptool's PTOOL_TEMPLATES_NEW_APP_TIMEOUT_MS is raised to match — otherwise the
  // client aborts a call the server would have completed.
  timeoutSec: 900,
  // EI-21107910194803524 / EI-18803497769946984: the INDIRECT half of the idle-tx
  // class. This handler blocks for minutes inside `pot:create` (repo init, schema
  // setup, routine seeding — measured 111s on its own) but never reads `ctx.tx`,
  // so the dispatcher's ambient workspace transaction sits IDLE the whole time.
  // Postgres kills it at idle_in_transaction_session_timeout (60s) and the caller
  // gets a bare `write CONNECTION_CLOSED 127.0.0.1:6432` that names neither this
  // tool nor the cause — which reads as a PgBouncer outage. Note the timeoutSec
  // above CANNOT rescue this: no dispatch budget outruns a 60s server-side tx
  // kill, which is why raising it to 300s did not stop the failures (2/2 repro
  // 2026-08-21, each stranding a half-born pot).
  //
  // Safe because neither this handler nor any tool it reaches via inProcessCall
  // (pot:create, pot:obliterate, agent_chats:create, agent_chats:send_message)
  // reads `ctx.tx` — all verified 0 occurrences. `ctx.principal` is still
  // synthesized in its own short-lived transaction, so gating is unaffected.
  skipWorkspaceTx: true,
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    template: z
      .string()
      .min(1)
      .max(200)
      .describe('Template listing ref (e.g. "papercusp-app") or listing id (uuid).'),
    slug: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase alphanumeric + dashes')
      .describe('Slug for the new harness (also the new folder name under parentDir).'),
    parentDir: z
      .string()
      .min(1)
      .optional()
      .describe('Parent dir for the new app folder. Default: <~/.papercusp>/apps.'),
    kickoffBuilder: z
      .boolean()
      .optional()
      .default(true)
      .describe('Open a building-agent chat seeded with the GUIDE (default true). false ⇒ just materialize the files.'),
    builderRole: z
      .string()
      .min(1)
      .optional()
      .default('architect')
      .describe('Role for the builder chat (default "architect").'),
  }),
  // The materialization result is deliberately extensible (source-acquisition
  // and builder diagnostics add fields over time). These are the documented
  // top-level fields; passthrough keeps the compound operation lossless.
  result: z
    .object({
      ok: z.boolean().optional(),
      harnessSlug: z.string().optional(),
      path: z.string().optional(),
      filesCopied: z.number().int().nonnegative().optional(),
      template: z.unknown().optional(),
      guideBranch: z.string().nullable().optional(),
      sourceCheckout: z.unknown().nullable().optional(),
      supplyChain: z.unknown().optional(),
      releaseGateTestCommand: z.unknown().optional(),
      builder: z.unknown().optional(),
      status: z.number().int().optional(),
      error: z.string().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    return composeNewApp(
      {
        template: args.template,
        slug: args.slug,
        parentDir: args.parentDir,
        kickoffBuilder: args.kickoffBuilder,
        builderRole: args.builderRole,
      },
      inProcessCall(ctx),
      {
        resolveSource: resolveTemplateSource,
        defaultParentDir: () => {
          const d = join(papercuspRoot(), 'apps');
          mkdirSync(d, { recursive: true });
          return d;
        },
      },
    );
  },
});
