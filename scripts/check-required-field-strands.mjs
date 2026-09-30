#!/usr/bin/env node
/**
 * check-required-field-strands.mjs — the required-field trap, mechanised (WI-6814).
 *
 * THE TRAP (CLAUDE.md § "Tests after editing" documents it; documentation has not
 * stopped it recurring 5×): adding a REQUIRED field to an exported interface instantly
 * stales every construction site of that type — in files your change never touched.
 * `test:affected` is type-blind AND would not select those files anyway; a stale fixture
 * in a file whose tsc baseline already tolerates errors is invisible to the ratchet too.
 * So the first detector that fires is the green-checkpoint full suite: fleet-wide, hours
 * later, and (because `pushed` is commit-only:bridged) a red gate stops origin egress for
 * everyone. A correct one-line interface change becomes a multi-hour fleet outage.
 *
 * SIBLING CLASSES, same shape, same trigger (all three share one findings list):
 *   - an exported CALLABLE's signature changes           → diffSignatureBreaks
 *   - an exported UNION gains or loses a member          → diffUnionWidenings (EI-20417688643232882:
 *     `GitSyncFailingLeg` gained `'config-lock'`; a consumer had RE-LISTED the literals, so the
 *     strand surfaced as a TS2322 in a THIRD file and red-pinned the fleet-wide gate)
 *
 * WHY THIS GUARD IS A TRIGGER, NOT A SECOND ANALYSER:
 * finding the stranded sites is not the hard part — `tsc` already does it perfectly and
 * precisely. The hard part is KNOWING TO RUN IT. So this guard does the one thing nothing
 * else does: it notices, from the diff alone, that you just made the specific kind of edit
 * that strands siblings, and then points at (or runs) the detector that already exists.
 * Re-implementing construction-site resolution here would be a second, worse tsc.
 *
 * That is also why the mere ADDITION is never itself a failure: adding a required field is
 * usually correct and usually accompanied by updated call sites. This guard only fails when
 * --typecheck confirms real errors. Advisory by default; it cannot false-block the fleet.
 *
 *   node scripts/check-required-field-strands.mjs              # advisory: name the trigger + the command
 *   node scripts/check-required-field-strands.mjs --typecheck  # run the typecheck, exit 1 on real errors
 *   node scripts/check-required-field-strands.mjs --base origin/main
 *   node scripts/check-required-field-strands.mjs --json
 *
 * The --typecheck confirmation can queue behind pc-heavy for several minutes (and may
 * exceed five minutes under fleet load). From an agent, run it with
 * `capability:bash { run_in_background: true }`, then read `capability:bash_output` and
 * trust its `exit_code`; a foreground timeout is not a clean result.
 *
 * Exit codes:
 *   0 — no required-field additions, or advisory mode, or --typecheck found nothing
 *       ATTRIBUTED TO THE CALLER (peer live-edits and standing committed reds are
 *       labelled by lint:tsc's --files attribution and never trip this exit)
 *   1 — --typecheck confirmed type errors attributed to the caller's files or to files whose
 *       source or compiler diagnostic references their exported types (the stranded-site population)
 *   2 — --typecheck was requested, but findings came only from an inferred shared-tree
 *       file set, so they cannot be attributed to this caller; re-run with --files
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
// WI-37806: shared with the two guards ported from this one, which inherited this file's
// NOT-CHECKED prose but not its exit status. Re-exported below so this module's public
// surface is unchanged.
import { EXIT_NOT_CHECKED, exitForNoFindings, provedNothing } from './lib/not-checked.mjs';
import { parseExplicitFiles } from './lib/tsc-baseline-gate.mjs';

export { EXIT_NOT_CHECKED, exitForNoFindings, provedNothing };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Workspaces that own their own typecheck, longest-prefix-first. */
const WORKSPACE_TYPECHECKS = [
  { prefix: 'packages/operator-core', cmd: 'npm run lint:tsc -- --files=<the files you edited>' },
  { prefix: 'apps/operator', cmd: 'build:typecheck { project: "apps/operator" }' },
  { prefix: 'apps/operator-vite', cmd: 'build:typecheck { project: "apps/operator-vite" }' },
  { prefix: 'libs/generic', cmd: 'build:typecheck { project: "<the libs/generic/* workspace>" }' },
  { prefix: 'libs/papercusp', cmd: 'build:typecheck { project: "<the libs/papercusp/* workspace>" }' },
  { prefix: 'packages/', cmd: 'build:typecheck { project: "<the packages/* workspace>" }' },
];

function git(args, { allowFail = false, cwd = ROOT, suppressStderr = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      ...(suppressStderr ? { stdio: ['ignore', 'pipe', 'ignore'] } : {}),
    });
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

/**
 * `git diff <revision> -- <paths>` can silently reinterpret an unknown revision as a
 * pathspec and return a working-tree diff with status 0. That is especially dangerous
 * here: the subsequent `git show <revision>:<file>` calls can then yield empty text, so
 * the guard counts files as examined and reports a false clean bill. Validate the base as
 * a revision before asking `git diff` to compare it. Keep the expression intact because
 * callers commonly pass ancestry selectors such as `C^`.
 */
function resolvesRevision(revision) {
  if (typeof revision !== 'string' || revision.length === 0) return false;
  try {
    execFileSync('git', ['rev-parse', '--verify', '--end-of-options', revision], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * EI-20020054576584970: the guard was structurally blind to every file inside a submodule,
 * and that blindness is what let the 2026-08-12 incident through — `ActiveLockRow.lock_id`
 * in libs/papercusp/packages/locks/src/su-lock-store.ts stranded a mock fixture and froze
 * `main` for ~14h.
 *
 * The mechanism, which is worth stating because it produces no error you would notice: to
 * the SUPERPROJECT a submodule is a GITLINK, not a tree. So `git show HEAD:libs/papercusp/
 * .../su-lock-store.ts` does not return an old version of that file — it fails outright
 * ("exists on disk, but not in 'HEAD'"), and `git diff --name-only HEAD -- libs/papercusp`
 * can only ever name the gitlink, never a file within it. Both of this guard's entry points
 * — the DECLARED --files= set and the INFERRED diff set — therefore saw nothing to examine,
 * and the run degraded to NOT CHECKED while blaming the (real, familiar, benign) git-sync
 * race. A message that should have stopped the author instead reassured them.
 *
 * The fix is to ask the right repository. Each path is resolved to its owning submodule and
 * the show/diff is re-run with that submodule as cwd, against its OWN history — which is
 * what `HEAD` should have meant for that file all along.
 */
let submodulePrefixesCache = null;
export function submodulePrefixes() {
  if (submodulePrefixesCache) return submodulePrefixesCache;
  const out = git(['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'], {
    allowFail: true,
  });
  const prefixes = (out ?? '')
    .split('\n')
    .filter(Boolean)
    // `submodule.<name>.path <value>` — the value is everything past the first space, so a
    // path containing spaces survives (splitting on whitespace would truncate it).
    .map((line) => line.slice(line.indexOf(' ') + 1).trim())
    .filter(Boolean);
  // Longest-first so a nested submodule wins over its parent; otherwise the outer prefix
  // matches first and we re-run the query against the wrong repository.
  submodulePrefixesCache = prefixes.sort((a, b) => b.length - a.length);
  return submodulePrefixesCache;
}

/** The submodule prefix owning `file`, or null when it lives in the superproject. */
export function submoduleFor(file, prefixes) {
  for (const prefix of prefixes) {
    if (file === prefix || file.startsWith(`${prefix}/`)) return prefix;
  }
  return null;
}

/**
 * Resolve the gitlink recorded by the superproject at `base` to the commit that
 * the owning submodule should use as its own base. A superproject revision is
 * not normally present in a submodule's object database, so passing `base`
 * directly to `git show`/`git diff` there either skips the file or emits the
 * misleading `bad revision` failure this guard is meant to make actionable.
 */
export function submoduleRevisionAt(base, prefix) {
  const revision = git(
    ['rev-parse', '--verify', '--end-of-options', `${base}:${prefix}`],
    { allowFail: true },
  );
  const normalized = revision?.trim();
  return normalized || null;
}

/**
 * `file`'s contents at `base`, asked of whichever repository actually tracks it.
 * Returns null when the file has no version there (new file, or a base that repo lacks) —
 * the same contract the caller already handles by skipping the candidate.
 */
export function showAtBase(file, base) {
  const prefix = submoduleFor(file, submodulePrefixes());
  const repositoryBase = prefix ? submoduleRevisionAt(base, prefix) : base;
  if (!repositoryBase) return null;
  if (!prefix) {
    return git(['show', `${repositoryBase}:${file}`], {
      allowFail: true,
      suppressStderr: true,
    });
  }
  return git(['show', `${repositoryBase}:${file.slice(prefix.length + 1)}`], {
    allowFail: true,
    cwd: resolve(ROOT, prefix),
    suppressStderr: true,
  });
}

function parseNameStatus(text, prefix = '') {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split('\t');
      const file = rest[rest.length - 1];
      return { status, file: prefix ? `${prefix}/${file}` : file };
    });
}

/**
 * Resolve the TypeScript candidates a strand guard must compare against a SUPERPROJECT
 * revision. Both strand guards consume this helper so a submodule root forwarded by
 * affected-tests cannot mean "directory" to one guard and "changed files" to the other.
 *
 * A declared submodule root is the real gate shape: the superproject diff can name only the
 * gitlink, while the files that changed live in the submodule repository. Expand that root
 * against the gitlink recorded at `base`. Declared ordinary files retain their exact scope.
 * In inferred mode, combine the superproject TypeScript diff with each submodule's own diff.
 *
 * Returns null only when the superproject diff itself could not be resolved. An unavailable
 * individual submodule contributes no candidates, so the caller's existing NOT_CHECKED
 * verdict remains the fail-closed outcome.
 */
export function typeScriptCandidatesAtBase(base, declaredFiles = null) {
  const candidates = [];
  const prefixes = submodulePrefixes();

  const addSubmoduleDiff = (prefix) => {
    const submoduleBase = submoduleRevisionAt(base, prefix);
    if (!submoduleBase) return;
    const subStatus = git(['diff', '--name-status', submoduleBase, '--', '*.ts', '*.tsx'], {
      allowFail: true,
      cwd: resolve(ROOT, prefix),
    });
    if (subStatus !== null) candidates.push(...parseNameStatus(subStatus, prefix));
  };

  if (declaredFiles !== null) {
    for (const file of declaredFiles) {
      const prefix = submoduleFor(file, prefixes);
      if (prefix && file === prefix) addSubmoduleDiff(prefix);
      else candidates.push({ status: 'M', file });
    }
  } else {
    const nameStatus = git(['diff', '--name-status', base, '--', '*.ts', '*.tsx'], {
      allowFail: true,
    });
    if (nameStatus === null) return null;
    candidates.push(...parseNameStatus(nameStatus));
    for (const prefix of prefixes) addSubmoduleDiff(prefix);
  }

  // A caller can explicitly name both a submodule root and one of its files. Preserve the
  // first status while preventing duplicate parsing/findings for the same effective path.
  return [...new Map(candidates.map((candidate) => [candidate.file, candidate])).values()];
}

const isExported = (node) =>
  Boolean(node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword));

/**
 * The names of every EXPORTED interface / type alias declared in `sourceText`.
 *
 * Deliberately SEPARATE from the property scan rather than derived from its dotted keys:
 * an `export interface Foo {}` with no members contributes zero property paths, so a
 * name-set inferred from those keys would not contain `Foo` — and adding the first
 * required field to it would then be suppressed as "new type" when it is exactly the
 * stranding case this guard exists to catch. Collecting declarations directly cannot
 * make that mistake.
 */
export function collectExportedTypeNames(sourceText, fileName = 'f.ts') {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const names = new Set();
  for (const stmt of sf.statements) {
    if ((ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) && isExported(stmt)) {
      names.add(stmt.name.text);
    }
  }
  return names;
}

/**
 * Collect every property of every EXPORTED interface / object-type alias, keyed by a
 * dotted path so nested object literals are covered too. The trap that motivated this
 * guard lived one level down (`IssueClaimExclusionBreakdown.excluded.remoteOrigin`), so a
 * top-level-only scan would have missed all 5 of its stranded sites.
 */
export function collectExportedRequiredProps(sourceText, fileName = 'f.ts') {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const props = new Map(); // dotted path -> { optional }

  const walkMembers = (members, path) => {
    for (const m of members) {
      if (!ts.isPropertySignature(m) || !m.name) continue;
      const name = ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) ? m.name.text : null;
      if (!name) continue;
      const dotted = `${path}.${name}`;
      props.set(dotted, { optional: Boolean(m.questionToken) });
      // Recurse into nested object literal types — and through an optional wrapper, since a
      // required field inside an optional object still strands every site that DOES supply
      // the wrapper.
      const t = m.type;
      if (t && ts.isTypeLiteralNode(t)) walkMembers(t.members, dotted);
    }
  };

  for (const stmt of sf.statements) {
    if (ts.isInterfaceDeclaration(stmt) && isExported(stmt)) {
      walkMembers(stmt.members, stmt.name.text);
    } else if (ts.isTypeAliasDeclaration(stmt) && isExported(stmt) && ts.isTypeLiteralNode(stmt.type)) {
      walkMembers(stmt.type.members, stmt.name.text);
    }
  }
  return props;
}

/** Required props present in `after` that were absent (or optional) in `before`. */
export function diffRequiredAdditions(beforeText, afterText, fileName = 'f.ts') {
  const before = collectExportedRequiredProps(beforeText, fileName);
  const after = collectExportedRequiredProps(afterText, fileName);
  // Types that did not EXIST at `before`. main() already skips a brand-new FILE for exactly
  // this reason ("a brand-new exported interface has no pre-existing construction sites, so
  // it cannot strand anything") — but that reasoning was only applied at file granularity,
  // so a new type added to an EXISTING file reported every one of its fields as newly
  // required. Stranded sites are impossible there by construction, not merely unlikely: no
  // file at `before` can construct a type that does not exist at `before`, and any site
  // introduced alongside it is part of the same diff and is typechecked with it.
  //
  // This matters beyond noise (EI-19422135158287319): the guard re-fires on every later edit
  // to the same file, so one new type yields a run of identical warnings in a session, and a
  // warning that is provably impossible is how a genuinely valuable advisory gets tuned out.
  const beforeTypes = collectExportedTypeNames(beforeText, fileName);
  const added = [];
  for (const [path, info] of after) {
    if (info.optional) continue;
    // The declaring type is the dotted path's root (`Type.field`, `Type.nested.field`).
    if (!beforeTypes.has(path.split('.')[0])) continue;
    const prev = before.get(path);
    // Newly required: either it did not exist, or it existed as optional and became required.
    if (!prev) added.push({ path, reason: 'added-required' });
    else if (prev.optional) added.push({ path, reason: 'optional-to-required' });
  }
  return added;
}

/**
 * Collect every EXPORTED union — as a type alias (`export type Leg = 'a' | 'b'`) and as a
 * property of an exported interface / object-type alias — keyed by the same dotted path the
 * required-field scan uses, so both detectors speak one vocabulary.
 *
 * THE TRAP (EI-20417688643232882, which red-pinned the shared gate on 2026-08-14 and cost
 * three agents real diagnostic time): `GitSyncFailingLeg` gained a `'config-lock'` member.
 * A consumer — `DeployHealth.gitSyncFailingLeg` — had RE-LISTED the literals instead of
 * referencing the type, so widening the source stranded it with NO error at the edit site.
 * It surfaced later and elsewhere as a TS2322 in a third file (system-health/compute.ts).
 * That distance is the whole difficulty: the edit is one line and provably correct, the
 * error is in a file the diff never touched, and `test:affected` cannot select it.
 *
 * Members are stored as NORMALISED source text so a reformat or a reordering is not
 * mistaken for a change — the same reason `typeText` exists for the signature scan.
 */
export function collectExportedUnionMembers(sourceText, fileName = 'f.ts') {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const unions = new Map(); // dotted path -> Set<member text>

  const memberSet = (typeNode) => {
    if (!typeNode) return null;
    const parts = ts.isUnionTypeNode(typeNode) ? typeNode.types : [typeNode];
    const set = new Set();
    for (const p of parts) set.add(p.getText(sf).replace(/\s+/g, ' ').trim());
    return set;
  };

  const walkMembers = (members, path) => {
    for (const m of members) {
      if (!ts.isPropertySignature(m) || !m.name) continue;
      const name = ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) ? m.name.text : null;
      if (!name || !m.type) continue;
      const dotted = `${path}.${name}`;
      const set = memberSet(m.type);
      if (set) unions.set(dotted, set);
      // Same recursion as the required-field scan: a union one level down strands just as
      // hard as a top-level one, and the motivating case lived on a nested property.
      if (ts.isTypeLiteralNode(m.type)) walkMembers(m.type.members, dotted);
    }
  };

  for (const stmt of sf.statements) {
    if (ts.isInterfaceDeclaration(stmt) && isExported(stmt)) {
      walkMembers(stmt.members, stmt.name.text);
    } else if (ts.isTypeAliasDeclaration(stmt) && isExported(stmt)) {
      if (ts.isTypeLiteralNode(stmt.type)) walkMembers(stmt.type.members, stmt.name.text);
      else {
        const set = memberSet(stmt.type);
        if (set) unions.set(stmt.name.text, set);
      }
    }
  }
  return unions;
}

/** At most `max` members, rendered for a one-line report. */
const renderMembers = (members, max = 3) => {
  const shown = members.slice(0, max).join(' | ');
  return members.length > max ? `${shown} | …(+${members.length - max})` : shown;
};

/**
 * Unions whose member SET changed at a path that existed at `before`.
 *
 * Deliberately reports only a STRICT SUPERSET (widened) or STRICT SUBSET (narrowed) — never
 * a mixed add-and-remove. That is the precision decision that keeps this advisory worth
 * reading: a superset/subset relation is unambiguous evidence that consumers which re-list
 * the members went stale, whereas `foo: string` → `foo: number` is an ordinary type change
 * with no union involved, and a rename (one added, one removed) would fire twice while
 * saying nothing a reader can act on. Both reported directions strand real sites — widening
 * strands every CONSUMER that re-lists the members, narrowing strands every PRODUCER that
 * still passes the dropped one.
 *
 * A single non-union type counts as a one-member set, so the classic nullable widening
 * (`string` → `string | null`) is caught by the same superset test with no special case.
 */
export function diffUnionWidenings(beforeText, afterText, fileName = 'f.ts') {
  const before = collectExportedUnionMembers(beforeText, fileName);
  const after = collectExportedUnionMembers(afterText, fileName);
  // Same suppression as diffRequiredAdditions: no file at `before` can reference a type that
  // did not exist at `before`, so a type introduced by this very diff cannot have stranded
  // anything — and a warning that is provably impossible is how a real advisory gets tuned out.
  const beforeTypes = collectExportedTypeNames(beforeText, fileName);
  const changes = [];
  for (const [path, now] of after) {
    if (!beforeTypes.has(path.split('.')[0])) continue;
    const prev = before.get(path);
    if (!prev) continue;
    const gained = [...now].filter((m) => !prev.has(m));
    const lost = [...prev].filter((m) => !now.has(m));
    // Neither side is a union in any meaningful sense, or the change is a mixed rewrite:
    // out of scope by the precision rule above.
    if (gained.length && lost.length) continue;
    if (gained.length) changes.push({ path: `${path} + ${renderMembers(gained)}`, reason: 'union-member-added' });
    else if (lost.length) changes.push({ path: `${path} - ${renderMembers(lost)}`, reason: 'union-member-removed' });
  }
  return changes;
}

/**
 * Normalise a type's source text so REFORMATTING is not mistaken for a type change.
 * `foo(a: {x: string})` and a prettier-wrapped `foo(a: {\n  x: string;\n})` are the same
 * type; reporting the second as a breach is how an advisory gets tuned out.
 */
/**
 * Render a type's source text while alpha-normalising references to the callable's
 * type parameters. Type parameters are positional, so `<T>(a: T): T` and
 * `<U>(a: U): U` publish the same callable surface even though their source text
 * differs. Walking TypeReferenceNodes instead of replacing identifier text blindly
 * keeps property names and qualified names intact.
 */
const typeText = (node, sf, typeParamNames = new Map()) => {
  if (!node) return null;
  let text = node.getText(sf);
  if (typeParamNames.size > 0) {
    const nodeStart = node.getStart(sf);
    const replacements = [];
    const visit = (current) => {
      if (ts.isTypeReferenceNode(current) && ts.isIdentifier(current.typeName)) {
        const replacement = typeParamNames.get(current.typeName.text);
        if (replacement) {
          replacements.push({
            start: current.typeName.getStart(sf) - nodeStart,
            end: current.typeName.getEnd() - nodeStart,
            replacement,
          });
        }
      }
      ts.forEachChild(current, visit);
    };
    visit(node);
    for (const { start, end, replacement } of replacements.sort((a, b) => b.start - a.start)) {
      text = `${text.slice(0, start)}${replacement}${text.slice(end)}`;
    }
  }
  return text.replace(/\s+/g, ' ').trim();
};

/**
 * Collect every EXPORTED callable's signature, keyed by name (`foo`) for function
 * declarations and exported arrow consts, and by dotted path (`Iface.method`) for method
 * signatures on exported interfaces.
 *
 * WHY THIS BELONGS IN THIS GUARD rather than a fifth sibling script: the three ported
 * siblings (optional-seam, di-seam-arity, vimock-export) each analyse a DIFFERENT shape in
 * a different place. This is the SAME analysis as the required-field scan — diff exported
 * declarations of one file between two revisions, report the deltas that strand callers,
 * escalate to the precise detector — so it shares the whole trigger/attribution/typecheck
 * spine and differs only in the predicate. WI-37806 records what porting that spine costs:
 * the siblings inherited this file's NOT-CHECKED prose but not its exit status, and the
 * divergence had to be fixed after the fact.
 */
/**
 * A class member no other file can reach, and whose signature therefore strands nobody.
 *
 * `private` / `protected` / `#name` members are the reason exported CLASSES could not simply
 * be walked like interfaces: an interface has no inaccessible members, so the interface walk
 * needed no such filter, while a class typically has several. Recording them would report a
 * "break" on every refactor of a class's own internals — noise on edits that cannot strand a
 * caller, which is the failure mode that gets a guard switched off.
 */
const isInaccessible = (member) =>
  Boolean(
    member.modifiers?.some(
      (mod) => mod.kind === ts.SyntaxKind.PrivateKeyword || mod.kind === ts.SyntaxKind.ProtectedKeyword,
    ),
  ) || Boolean(member.name && ts.isPrivateIdentifier(member.name));

export function collectExportedSignatures(sourceText, fileName = 'f.ts') {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const sigs = new Map(); // key -> { typeParams, params: [{ name, optional, rest, type }], ret }

  const record = (key, node, enclosingTypeParameters = []) => {
    // A member's annotations can refer to the generic parameters of its enclosing
    // interface/class as well as its own. Give each positional slot a stable name
    // before rendering the annotations so a rename at either scope stays silent.
    const allTypeParameters = [...enclosingTypeParameters, ...(node.typeParameters ?? [])];
    const typeParamNames = new Map();
    for (const [index, tp] of allTypeParameters.entries()) {
      if (ts.isIdentifier(tp.name)) typeParamNames.set(tp.name.text, `__papercusp_type_param_${index}__`);
    }
    sigs.set(key, {
      // Carried so a generic's ARITY, CONSTRAINTS and DEFAULTS are visible to the diff: adding
      // a type parameter strands every explicit `foo<A>()` site, and tightening a constraint
      // strands the inference sites — neither of which touches a value parameter or the return
      // type, so both were invisible here. The `name` is for the report path ONLY and must
      // never be diffed: type parameters are positional, so `<T>` → `<U>` is a pure rename.
      typeParams: (node.typeParameters ?? []).map((tp) => ({
        name: ts.isIdentifier(tp.name) ? tp.name.text : '?',
        constraint: typeText(tp.constraint, sf, typeParamNames),
        hasDefault: Boolean(tp.default),
      })),
      params: node.parameters.map((p) => ({
        name: ts.isIdentifier(p.name) ? p.name.text : '?',
        optional: Boolean(p.questionToken || p.initializer),
        rest: Boolean(p.dotDotDotToken),
        type: typeText(p.type, sf, typeParamNames),
      })),
      ret: typeText(node.type, sf, typeParamNames),
    });
  };

  // An OVERLOAD SET publishes its body-less declarations and HIDES the implementation:
  // TypeScript does not let a caller call the implementation signature at all. Keying every
  // declaration by bare name left the implementation as the last writer, so this collector
  // recorded a signature no caller can see — and that fails BOTH ways. Deleting or narrowing
  // an overload reported nothing (the implementation was unchanged), while widening the
  // implementation reported a break that stranded nobody. The second direction is the
  // dangerous one: a false report is what gets a guard switched off.
  //
  // Keyed by name+ARITY (`f/1`, `f/2`), never positionally (`f#0`) — reordering overloads is a
  // no-op refactor that a positional key would report as two changed signatures.
  //
  // A name counts as overloaded only with MORE THAN ONE declaration, so a lone ambient
  // `export declare function f()` keeps its bare-name key and its existing behaviour; only a
  // genuine overload set changes shape here.
  //
  // KNOWN LIMIT: same-arity overloads still collide on one key and the last declaration wins.
  // That is strictly narrower than the collision it replaces — which lost the entire set to the
  // implementation — and it is stated rather than hidden because it bounds what a clean run
  // proves.
  const declCounts = new Map();
  const bodyless = new Set();
  for (const stmt of sf.statements) {
    if (!ts.isFunctionDeclaration(stmt) || !isExported(stmt) || !stmt.name) continue;
    declCounts.set(stmt.name.text, (declCounts.get(stmt.name.text) ?? 0) + 1);
    if (!stmt.body) bodyless.add(stmt.name.text);
  }
  const overloaded = new Set([...bodyless].filter((n) => (declCounts.get(n) ?? 0) > 1));

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && isExported(stmt) && stmt.name) {
      const fnName = stmt.name.text;
      if (!overloaded.has(fnName)) record(fnName, stmt);
      else if (!stmt.body) record(`${fnName}/${stmt.parameters.length}`, stmt);
    } else if (ts.isVariableStatement(stmt) && isExported(stmt)) {
      // `export const foo = (a: string) => …` is as much a public callable as a function
      // declaration, and a large share of this repo's exported API takes that form.
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        if (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) {
          record(d.name.text, d.initializer);
        }
      }
    } else if (ts.isInterfaceDeclaration(stmt) && isExported(stmt)) {
      for (const m of stmt.members) {
        if (!ts.isMethodSignature(m) || !m.name) continue;
        const name = ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) ? m.name.text : null;
        if (name) record(`${stmt.name.text}.${name}`, m, stmt.typeParameters ?? []);
      }
    } else if (ts.isClassDeclaration(stmt) && isExported(stmt) && stmt.name) {
      // An exported class is a public callable surface too, and its CONSTRUCTOR is the one
      // every `new Foo(...)` site depends on — the highest-fanout signature a class has.
      for (const m of stmt.members) {
        if (isInaccessible(m)) continue;
        if (ts.isConstructorDeclaration(m)) {
          record(`${stmt.name.text}.constructor`, m, stmt.typeParameters ?? []);
          continue;
        }
        if (!ts.isMethodDeclaration(m) || !m.name) continue;
        const name = ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) ? m.name.text : null;
        if (name) record(`${stmt.name.text}.${name}`, m, stmt.typeParameters ?? []);
      }
    }
  }
  return sigs;
}

/**
 * Every name this file still exports as a VALUE, in any form.
 *
 * Deliberately BROADER than collectExportedSignatures, and that width is the entire point:
 * that map records only callables whose parameter list this collector can read, so several
 * ordinary refactors drop a name out of it while the export itself survives untouched —
 * `export function foo(){}` becoming `export const foo = memoize(fn)` (a call-expression
 * initializer, not an arrow), the same name de-inlined to `function foo(){}` +
 * `export { foo }`, or re-exported under an alias. Gating removal on THIS set rather than on
 * the signature map is what stops all of those reading as a deleted callable, which is the
 * false positive that would get the removal check switched back off within a week.
 */
export function collectExportedValueNames(sourceText, fileName = 'f.ts') {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const names = new Set();

  for (const stmt of sf.statements) {
    // `export { foo }` / `export { foo as bar }` — callers import the ALIAS, so the alias is
    // the name whose disappearance would actually strand them.
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const spec of stmt.exportClause.elements) names.add(spec.name.text);
      continue;
    }
    if (!isExported(stmt)) continue;
    if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name) {
      names.add(stmt.name.text);
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) names.add(d.name.text);
      }
    }
  }
  return names;
}

/**
 * Signature changes in `after` that strand EXISTING call sites.
 *
 * Same suppression as diffRequiredAdditions: a callable that did not EXIST at `before` is
 * skipped, because no file at `before` can call it and any site introduced alongside it is
 * part of the same diff and is typechecked with it.
 *
 * A type CHANGE is reported without deciding whether it narrows or widens. That is
 * deliberate and it is why this guard is advisory: distinguishing `string` → `string | null`
 * (safe for callers) from `string | null` → `string` (strands them) needs the checker, not
 * the syntax tree, and the whole design of this guard is a cheap trigger that hands the
 * verdict to `--typecheck`. Guessing here would either miss real breaks or manufacture
 * false ones, and a false block is the failure mode that gets a guard deleted.
 */
export function diffSignatureBreaks(beforeText, afterText, fileName = 'f.ts') {
  const before = collectExportedSignatures(beforeText, fileName);
  const after = collectExportedSignatures(afterText, fileName);
  const breaks = [];

  for (const [name, now] of after) {
    const was = before.get(name);
    if (!was) continue; // new callable — no pre-existing call sites to strand

    // Type parameters, compared POSITIONALLY and never by name — TS resolves type arguments by
    // position, so `<T>` → `<U>` is a rename that strands nobody and must stay silent.
    //
    const wasTp = was.typeParams ?? [];
    const nowTp = now.typeParams ?? [];
    for (let i = wasTp.length; i < nowTp.length; i++) {
      // A new type parameter carrying a DEFAULT is additive: `foo<A>()` still resolves.
      if (nowTp[i].hasDefault) continue;
      breaks.push({ path: `${name}<${nowTp[i].name}>`, reason: 'type-param-added-required' });
    }
    if (nowTp.length < wasTp.length) {
      // TS rejects extra type arguments exactly as it rejects extra arguments.
      breaks.push({ path: `${name}<>`, reason: 'type-param-removed' });
    }
    const commonTp = Math.min(wasTp.length, nowTp.length);
    for (let i = 0; i < commonTp; i++) {
      // Reported without deciding whether the constraint narrowed or widened, for the same
      // reason param-type-changed is: telling `<T>` → `<T extends Serializable>` (strands
      // inference sites) from its inverse (safe) needs the checker, and this guard's whole
      // design is a cheap trigger that hands the verdict to --typecheck.
      if (wasTp[i].constraint !== nowTp[i].constraint) {
        breaks.push({ path: `${name}<${nowTp[i].name}>`, reason: 'type-param-constraint-changed' });
      } else if (wasTp[i].hasDefault && !nowTp[i].hasDefault) {
        // Losing a default strands every site that omitted the type argument and relied on it.
        breaks.push({ path: `${name}<${nowTp[i].name}>`, reason: 'type-param-default-removed' });
      }
    }

    for (let i = was.params.length; i < now.params.length; i++) {
      const p = now.params[i];
      // A rest or optional parameter is additive: every existing call still typechecks.
      if (p.optional || p.rest) continue;
      breaks.push({ path: `${name}(${p.name})`, reason: 'param-added-required' });
    }
    if (now.params.length < was.params.length) {
      // TS rejects extra arguments, so dropping a parameter strands callers that pass it.
      breaks.push({ path: `${name}()`, reason: 'param-removed' });
    }
    const common = Math.min(was.params.length, now.params.length);
    for (let i = 0; i < common; i++) {
      const a = was.params[i];
      const b = now.params[i];
      if (a.optional && !b.optional && !b.rest) {
        breaks.push({ path: `${name}(${b.name})`, reason: 'param-optional-to-required' });
      } else if (a.type && b.type && a.type !== b.type) {
        breaks.push({ path: `${name}(${b.name})`, reason: 'param-type-changed' });
      }
    }
    if (was.ret && now.ret && was.ret !== now.ret) {
      breaks.push({ path: `${name} → ${now.ret}`, reason: 'return-type-changed' });
    }
  }

  // The loop above walks the AFTER map, so a callable present at `before` and absent at
  // `after` is structurally invisible to it. That left the LOUDEST break in this class
  // uncovered: removing an exported callable strands every caller at once, not merely the
  // ones passing a particular argument.
  //
  // Suppressed against the file's whole export SURFACE rather than against `after`, because
  // a name can leave the signature map while remaining perfectly importable — see
  // collectExportedValueNames for the refactors that do it. An interface member (a dotted
  // key) has no value export to test against, so the suppression correctly never applies to
  // one: dropping a method from an exported interface is always reported.
  const stillExported = collectExportedValueNames(afterText, fileName);
  for (const name of before.keys()) {
    if (after.has(name)) continue;

    // An arity-keyed OVERLOAD needs the opposite suppression to a plain name. The base name
    // surviving does NOT make its disappearance safe: callers calling that arity no longer have
    // a matching overload, which is precisely the break the arity key was introduced to expose.
    // Suppressing it against the export surface would reinstate the original bug. So the export
    // surface decides only the REASON — whether the whole callable left, or one of its overloads.
    const overload = /^(.+)\/(\d+)$/.exec(name);
    if (overload) {
      breaks.push({
        path: `${name}()`,
        reason: stillExported.has(overload[1]) ? 'overload-removed' : 'callable-removed',
      });
      continue;
    }

    if (!name.includes('.') && stillExported.has(name)) continue;
    breaks.push({ path: `${name}()`, reason: 'callable-removed' });
  }

  return breaks;
}

function workspaceFor(file) {
  return WORKSPACE_TYPECHECKS.find((w) => file.startsWith(w.prefix)) ?? null;
}

/**
 * The no-findings verdict, as text.
 *
 * Exported as a seam because the DISTINCTION it draws is the entire value of the
 * check: "examined N files, found nothing" is a clean bill, while "examined ZERO
 * files" is not a result at all. Rendering the two identically is the same failure
 * class as `tsc -p .` typechecking zero files and reading as a pass — and on THIS
 * tree it is the common case rather than an edge one, because git-sync commits the
 * whole tree on a schedule, so a few minutes after you edit, working-tree == HEAD
 * and the default `--base HEAD` diff is empty.
 *
 * Measured 2026-08-02: this printed a green for a change that HAD added required
 * field `ServeProgress.bytesIn`, purely because git-sync had already swept it.
 */
export function formatNoFindings(examinedFiles, base, { declared = false, identicalFiles = [] } = {}) {
  const files = Array.isArray(examinedFiles) ? examinedFiles : [];
  if (files.length > 0) {
    // Naming the COUNT was not enough. A count is unfalsifiable by the one person who
    // could catch the mistake — the author, who knows which file carries their change.
    // Listing the files lets them see in one glance that theirs is not among them.
    //
    // EI-20097325488507587: when EVERY named file turned out identical to `base`, this
    // run compared nothing — and leading with ✓ makes the invalidation below read as a
    // caveat on a pass rather than as the verdict. The exit code already said
    // EXIT_NOT_CHECKED; the HEADLINE has to agree with it, because the headline is what
    // a reader acts on. Same reasoning as the zero-files branch below, which was already
    // fixed this way — this is the per-file form that survived it.
    const nothingProved = provedNothing({ examinedFiles: files, identicalFiles, declared });
    const lines = [
      nothingProved
        ? `⚠ NOT CHECKED — ${files.length} named file(s) are byte-identical to ${base}, so nothing was compared.`
        : `✓ no required fields added to exported types (${files.length} file(s) examined vs ${base})`,
      ...files.map((f) => `    ${f}`),
    ];
    // EI-21361656341155733 — POSITIVE CONTROL for the clean line. "0 additions
    // found" and "the base I was given already contains them" are the same
    // sentence here, and the second is not a pass. That is not hypothetical: on
    // this tree git-sync splits one logical change across commits, so the base an
    // agent derives from the advice above can already carry the field, and the
    // reassuring ✓ arrives exactly when they are trying to discharge the hook's
    // warning. Cheap line, converts a false clean into a prompt.
    if (!nothingProved) {
      lines.push(
        `    (0 additions vs '${base}'. If you EXPECTED additions here, suspect the base:`,
        '     a base that already contains your field yields this same ✓. Re-derive it with',
        "     git log --format=%H -S'<your new field name>' -- <file> | tail -1  — the OLDEST match.)",
      );
    }
    if (!declared) {
      // The failure this exists to prevent (EI-19377892307939503): the set is INFERRED
      // from `git diff`, which on this shared tree is every agent's uncommitted edits.
      // git-sync commits YOUR file within minutes — dropping it out of the diff — while
      // peers' churn keeps the count non-zero, so the zero-files guard below never fires
      // and the green is a true statement about three files you have never opened.
      lines.push(
        '  ⚠ That set is INFERRED from `git diff` — on this shared tree it is EVERY agent’s',
        '    uncommitted edits, not necessarily yours. If the file carrying your change is',
        '    not listed above, this green says NOTHING about it (git-sync commits your edit',
        '    within minutes, which drops it out of this diff).',
        '    Scope it to what you actually changed:',
        '      node scripts/check-required-field-strands.mjs --files=<your,files>',
      );
    }
    // EI-19396116936287206: `--files=` DECLARES the set (trustworthy for WHICH files were
    // examined), but "examined" only ever meant "a before/after text pair was diffed" — it
    // said nothing about whether that diff was NON-EMPTY. On this tree git-sync commits an
    // edit within minutes, so a named file is frequently byte-identical to `base` (HEAD) by
    // the time you check it: the comparison runs, finds nothing to compare, and reports a
    // clean bill that is vacuously true of a file you never actually diffed against its
    // pre-edit state. This is the SAME root cause as the zero-files case below, one level
    // more specific (per-file instead of whole-run) — and it is silent under `declared`
    // because the warning above only fires for the INFERRED-set failure mode, not this one.
    if (identicalFiles.length > 0) {
      lines.push(
        `  ⚠ NOT CHECKED — ${identicalFiles.length} of ${files.length} named file(s) are BYTE-IDENTICAL`,
        `    to ${base}, so this run proves NOTHING about them (git-sync likely already`,
        '    committed your edit — on this tree that happens within minutes):',
        ...identicalFiles.map((f) => `      ${f}`),
        '    Re-run against the commit that actually carried your change:',
        // EI-21361656341155733: `| tail -1` picks the OLDEST matching commit, NOT
        // `git log -1` (the newest). git-sync splits ONE logical change across
        // several commits here, so the newest match's parent routinely ALREADY
        // contains the field — and the run then prints "no required fields added",
        // a clean line that proves nothing. Measured: newest match f172703bb7 said
        // "no required fields added"; the true introducer 5a199c7a09 found both.
        "      C=$(git log --format=%H -S'<a string your change introduced>' -- <file> | tail -1)",
        '      node scripts/check-required-field-strands.mjs --base "$C^" --files=<your,files>',
      );
    }
    return lines.join('\n');
  }
  return [
    `⚠ NOT CHECKED — nothing differs from '${base}', so ZERO files were examined.`,
    '  This is NOT a clean bill. On this shared tree it usually means git-sync',
    '  already committed your edit, not that you changed nothing.',
    '',
    '  Re-run against the commit that actually carried your change:',
    "    C=$(git log --format=%H -S'<a string your change introduced>' -- <file> | tail -1)",
    '    node scripts/check-required-field-strands.mjs --base "$C^"',
    '',
    '  (Use -G instead of -S when searching by a name you did not introduce.)',
  ].join('\n');
}

/**
 * An inferred candidate set is useful context, but it is not a caller-owned change set
 * on the shared checkout. It can contain a peer's dirty edit while omitting the caller's
 * change after git-sync commits it. A finding from that set must therefore never be
 * presented as evidence about this caller or forwarded into the caller's typecheck.
 */
export function formatUnattributedFindings(findings, base, examinedFiles = []) {
  const files = Array.isArray(examinedFiles) ? examinedFiles : [];
  const rows = Array.isArray(findings) ? findings : [];
  const lines = [
    '⚠ NOT CHECKED — no required-field addition is attributable to this caller.',
    `  This run inferred ${files.length} file(s) from git diff ${base}; on this shared checkout`,
    '  that set can contain peer edits and can omit your change after git-sync commits it.',
    `  ${rows.length} required-field addition(s) below are untrusted shared-tree context only.`,
    '  Do not fix or typecheck these findings as yours without a caller-scoped file set.',
    '',
  ];
  for (const finding of rows) {
    if (!finding?.file) continue;
    lines.push(`  ${finding.file}`);
    for (const added of finding.added ?? []) {
      const how = added.reason === 'optional-to-required' ? 'optional → required' : 'new required field';
      lines.push(`    • ${added.path}  (${how})`);
    }
  }
  lines.push(
    '',
    '  Re-run against the pre-edit base and the files you actually changed:',
    '    node scripts/check-required-field-strands.mjs --typecheck --base <pre-edit-commit> --files=<your,files>',
  );
  return lines.join('\n');
}

// EXIT_NOT_CHECKED / exitForNoFindings / provedNothing now live in ./lib/not-checked.mjs
// (imported + re-exported at the top of this file). They were extracted in WI-37806 after
// the two guards ported from this one inherited this file's NOT-CHECKED prose but not its
// exit status — see that module's header for the full argument.

/**
 * EI-20097325488507587: `--typecheck` asked for, then never run.
 *
 * A caller passes `--typecheck` to have the precise detector RUN. When no required-field
 * additions are found we return before reaching it — correctly, since there is nothing to
 * check — but silently, so the exit status is the caller's only signal and it is
 * indistinguishable from "the typecheck ran and passed". That is the same
 * absent-evidence-reads-as-evidence-of-absence failure the EXIT_NOT_CHECKED work fixed
 * one level up, and it survives that fix: `exitForNoFindings` legitimately returns 0 for
 * a genuine diff with no additions, and that 0 then carries an implication it never earned.
 *
 * The two reasons differ in what the reader should DO, so they are not collapsed:
 *   'no-findings' — the run did compare, and found nothing to typecheck. Believe it.
 *   'not-checked' — the run compared nothing at all; the absent typecheck is the
 *                   second-order symptom, and the NOT CHECKED text above is the fix.
 * Returns null when a typecheck was not requested, so callers can print unconditionally.
 */
export function formatTypecheckNotRun({ requested = false, reason = null } = {}) {
  if (!requested || !reason) return null;
  if (reason === 'not-checked') {
    return '\n--typecheck: NOT RUN — this run examined nothing to find additions in (see above).';
  }
  return [
    '\n--typecheck: NOT RUN — no required-field additions were found, so there was nothing',
    '  to typecheck. This exit status means "nothing to check", NOT "the typecheck passed".',
  ].join('\n');
}

/**
 * EI-18717671811306780: the confirm step is slow, and the fast substitute is BLIND.
 *
 * The commands above are project-wide on purpose. Under fleet load the operator-core
 * one queues behind pc-heavy — measured 2026-08-13 at load 93: still queued at 90s,
 * never started. An author who reads that as a hang reaches for the fastest green
 * thing available, and the fastest green thing available is a SCOPED typecheck
 * (`build:typecheck { scopeToFiles: true }`, or any scoped tsc).
 *
 * That substitution is not merely weaker — it is blind to this exact class, by
 * construction. A scoped run compiles the named file plus its import graph: what the
 * file imports. The sites a required-field addition strands are its DEPENDENTS — they
 * import the changed file, so they are never in that graph. The scoped run therefore
 * reports GREEN precisely when this guard has just told you something is stale, which
 * is worse than not running it: it manufactures evidence for the wrong conclusion.
 * (build:typecheck states the same limitation in its own `scopeToFiles` contract.)
 *
 * So the warning is attached to the remediation, not to a doc a hurried author will
 * not open — and it names the queue as expected behaviour so a wait is not misread
 * as a failure that justifies the shortcut.
 */
export function formatScopedTypecheckWarning() {
  return [
    '\n  ⚠ Do NOT substitute a SCOPED typecheck to dodge the queue.',
    '    A scoped run — build:typecheck { scopeToFiles: true }, or any scoped tsc —',
    '    compiles your file plus what IT imports. The stranded sites are DEPENDENTS:',
    '    they import you, so they are never in that graph. A scoped run goes GREEN on',
    '    exactly the class this guard exists to catch. Under fleet load the full check',
    '    can sit in the pc-heavy queue for several minutes (and may exceed five minutes)',
    '    — that is the queue working, not a hang. Run the command above with',
    '    `capability:bash { run_in_background: true }`, then read `capability:bash_output`',
    '    and trust its `exit_code`; a foreground timeout or launch response is not a',
    '    clean result. Never swap in a narrower check.',
  ].join('\n');
}

const REASON_LABELS = {
  'added-required': 'new required field',
  'optional-to-required': 'optional → required',
  'param-added-required': 'new required parameter',
  'param-optional-to-required': 'parameter optional → required',
  'param-removed': 'parameter removed',
  'param-type-changed': 'parameter type changed',
  'return-type-changed': 'return type changed',
  'callable-removed': 'exported callable removed',
  'overload-removed': 'overload removed from an exported set',
  'type-param-added-required': 'type parameter added without a default',
  'type-param-removed': 'type parameter removed',
  'type-param-constraint-changed': 'type-parameter constraint changed',
  'type-param-default-removed': 'type-parameter default removed',
  'union-member-added': 'union widened (a consumer that re-lists the members is now stale)',
  'union-member-removed': 'union narrowed (a producer still passing the dropped member is now stale)',
};
// Every signature reason MUST be listed here, not merely labelled above: the FIELD class is
// computed as the COMPLEMENT of these two sets, so a reason missing from both is silently
// classified as a required-FIELD finding and the run is announced as a "REQUIRED-FIELD
// ADDITION" — the wrong-headline failure this set was introduced to fix, which sends a
// reader hunting for a field that does not exist.
const SIGNATURE_REASONS = new Set([
  'param-added-required',
  'param-optional-to-required',
  'param-removed',
  'param-type-changed',
  'return-type-changed',
  'callable-removed',
  'overload-removed',
  'type-param-added-required',
  'type-param-removed',
  'type-param-constraint-changed',
  'type-param-default-removed',
]);
/** Same complement contract as SIGNATURE_REASONS — see the comment above it. */
const UNION_REASONS = new Set(['union-member-added', 'union-member-removed']);

/**
 * The headline names what was ACTUALLY found. A run that only changed a signature used to be
 * announced as a "REQUIRED-FIELD ADDITION", which sends the reader looking for a field that
 * does not exist and teaches them the guard is unreliable.
 *
 * Exported so the classification is directly testable: it is derived by COMPLEMENT, which is
 * precisely the arrangement where a newly-added reason misclassifies silently rather than
 * failing, so a unit test is the only thing that can catch the next omission.
 */
export function strandHeadline(reasons) {
  const kinds = new Set(reasons);
  const hasSig = [...kinds].some((k) => SIGNATURE_REASONS.has(k));
  const hasUnion = [...kinds].some((k) => UNION_REASONS.has(k));
  const hasField = [...kinds].some((k) => !SIGNATURE_REASONS.has(k) && !UNION_REASONS.has(k));
  const parts = [
    hasField ? 'REQUIRED-FIELD ADDITION' : null,
    hasSig ? 'EXPORTED-SIGNATURE CHANGE' : null,
    hasUnion ? 'EXPORTED-UNION CHANGE' : null,
  ].filter(Boolean);
  const headline = parts.length > 1
    ? `${parts.join(' and ')} detected.`
    : hasSig
      ? 'EXPORTED-SIGNATURE CHANGE detected on a public callable.'
      : hasUnion
        ? 'EXPORTED-UNION CHANGE detected on an exported type.'
        : 'REQUIRED-FIELD ADDITION detected on an exported type.';
  return { headline, hasField, hasSig, hasUnion };
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const runTypecheck = argv.includes('--typecheck');
  const baseIdx = argv.indexOf('--base');
  const base = baseIdx >= 0 ? argv[baseIdx + 1] : 'HEAD';

  // Do not let an invalid revision fall through to `git diff`, which accepts some
  // unknown tokens as pathspecs and exits 0. A false-green detector is worse than an
  // explicit NOT CHECKED result, so fail closed before collecting any candidates.
  if (!resolvesRevision(base)) {
    console.error(`check-required-field-strands: cannot resolve base revision '${base ?? ''}'`);
    process.exit(EXIT_NOT_CHECKED);
  }

  // `--files=a,b,c` DECLARES the set instead of inferring it. Large callers use the
  // existing lint:tsc response-file contract (`--files-from=/path/to/files.json`, whose
  // body is a JSON string array) so a tree-wide gate cannot put thousands of paths into
  // one Linux argv entry and die with E2BIG before this detector starts. Reuse the shared
  // parser so the inline/response-file semantics cannot drift between the two guards.
  const explicitFiles = parseExplicitFiles(argv);
  const declaredFiles = explicitFiles == null ? null : [...explicitFiles];

  // Changed .ts/.tsx files vs the base. A file with no base version is an addition. It still
  // counts as examined (with an empty before-image) so a caller gets a real clean verdict
  // instead of NOT_CHECKED; diffRequiredAdditions suppresses types that did not exist at the
  // base, because a brand-new exported interface has no pre-existing construction sites.
  // `typeScriptCandidatesAtBase` also expands a DECLARED submodule root — the exact path shape
  // affected-tests forwards from a superproject diff — into that submodule's internal diff.
  const candidates = typeScriptCandidatesAtBase(base, declaredFiles);
  if (candidates === null) {
    console.error(`check-required-field-strands: cannot diff against '${base}'`);
    // A base we cannot diff against means we examined nothing — the one thing
    // this must never report as a clean bill (EI-20095543794921181).
    process.exit(EXIT_NOT_CHECKED);
  }

  const findings = [];
  // The files genuinely COMPARED — not merely listed as candidates. A candidate can be
  // skipped (added/deleted, .d.ts, no base version, gone from the tree), and counting
  // those as "examined" is the same overstatement this check exists to stop.
  const examinedFiles = [];
  // Of the examined files, the ones byte-identical to `base` — a diff against yourself,
  // which proves nothing (EI-19396116936287206). Only meaningful in --files= (declared)
  // mode: the auto-diff mode derives its candidate set FROM `git diff --name-status`, so
  // a listed file is, by construction, never identical to base.
  const identicalFiles = [];
  for (const { status, file } of candidates) {
    if (!file || status.startsWith('D')) continue;
    if (file.endsWith('.d.ts')) continue;

    const beforeText = showAtBase(file, base);
    const abs = resolve(ROOT, file);
    if (!existsSync(abs)) continue;
    const afterText = readFileSync(abs, 'utf8');
    const before = beforeText ?? '';

    examinedFiles.push(file);
    if (declaredFiles && beforeText !== null && beforeText === afterText) identicalFiles.push(file);
    // All three predicates answer the same question — "did this edit strand sites in files
    // the diff never touched?" — so they share one findings list and one escalation. Keeping
    // the shape ({ file, added: [{ path, reason }] }) identical is what lets the whole
    // attribution / JSON / --typecheck spine below stay untouched.
    const added = [
      ...diffRequiredAdditions(before, afterText, file),
      ...diffSignatureBreaks(before, afterText, file),
      ...diffUnionWidenings(before, afterText, file),
    ];
    if (added.length) findings.push({ file, added });
  }

  const noFindingsExit = exitForNoFindings({
    examinedFiles,
    identicalFiles,
    declared: Boolean(declaredFiles),
  });
  const inferredSharedTree = declaredFiles === null;
  const unattributedFindings = inferredSharedTree && findings.length > 0;
  // Reported in JSON too: a machine reader has even less to go on than a human, and
  // `findings: []` alongside a requested-but-unrun typecheck reads as a pass.
  const typecheck = findings.length
    ? unattributedFindings
      ? { requested: runTypecheck, ran: false, reason: 'unattributed' }
      : { requested: runTypecheck, ran: runTypecheck, reason: null }
    : {
        requested: runTypecheck,
        ran: false,
        reason: noFindingsExit === EXIT_NOT_CHECKED ? 'not-checked' : 'no-findings',
      };
  const attribution = inferredSharedTree
    ? {
        mode: 'inferred-shared-tree',
        callerFiles: [],
        attributedFindings: [],
        untrustedFindings: findings,
      }
    : {
        mode: 'declared-files',
        callerFiles: declaredFiles,
        attributedFindings: findings,
        untrustedFindings: [],
      };

  if (json) {
    console.log(
      JSON.stringify(
        { base, examined: examinedFiles, identical: identicalFiles, findings, attribution, typecheck },
        null,
        2,
      ),
    );
  }

  if (unattributedFindings) {
    if (!json) {
      console.log(formatUnattributedFindings(findings, base, examinedFiles));
      if (runTypecheck) {
        console.log('\n--typecheck: NOT RUN — inferred shared-tree findings are not attributable to this caller.');
      }
    }
    // Advisory mode still reports the context without turning a peer's finding into a
    // failure. A requested typecheck is different: returning success or running it would
    // make an unscoped peer result look like the caller's verification, so fail closed.
    process.exit(runTypecheck ? EXIT_NOT_CHECKED : 0);
  }

  if (!findings.length) {
    if (!json) {
      console.log(
        formatNoFindings(examinedFiles, base, { declared: Boolean(declaredFiles), identicalFiles }),
      );
      const note = formatTypecheckNotRun({ requested: runTypecheck, reason: typecheck.reason });
      if (note) console.log(note);
    }
    // EI-20095543794921181: "no findings" is only a clean bill if something was
    // actually diffed. Two ways it is not: nothing differed from `base` at all
    // (zero files), or every DECLARED file turned out byte-identical to it — the
    // per-file form of the same root cause, already described at formatNoFindings.
    // A partial run (some named files identical, others genuinely diffed) still
    // exits 0: it verified what it could, and the warning above names the rest.
    process.exit(noFindingsExit);
  }

  if (!json) {
    // The headline names what was ACTUALLY found. A run that only changed a signature used
    // to be announced as a "REQUIRED-FIELD ADDITION", which sends the reader looking for a
    // field that does not exist and teaches them the guard is unreliable.
    const { headline, hasUnion } = strandHeadline(findings.flatMap((f) => f.added.map((a) => a.reason)));
    console.log(`⚠ ${headline}`);
    console.log('  Every call/construction site of this symbol in OTHER files may have gone stale —');
    console.log('  including files test:affected will not select and vitest cannot see.\n');
    for (const f of findings) {
      console.log(`  ${f.file}`);
      for (const a of f.added) {
        const how = REASON_LABELS[a.reason] ?? a.reason;
        console.log(`    • ${a.path}  (${how})`);
      }
    }
    const cmds = [...new Set(findings.map((f) => workspaceFor(f.file)?.cmd).filter(Boolean))];
    console.log('\n  Confirm nothing was stranded:');
    for (const c of cmds) console.log(`    ${c}`);
    console.log(formatScopedTypecheckWarning());
    console.log('\n  (Adding a required field is often correct — this is a prompt to verify,');
    console.log('   not a verdict. Do NOT make the field optional just to silence errors.)');
    if (hasUnion) {
      console.log('  (A stranded union consumer RE-LISTED the members instead of referencing the');
      console.log('   type. Fix it by referencing the type — never by re-listing the new member too.)');
    }
  }

  if (!runTypecheck) process.exit(0);

  // --typecheck: run the detector that is already precise, and fail only on real errors.
  const touchesOperatorCore = findings.some((f) => f.file.startsWith('packages/operator-core'));
  if (!touchesOperatorCore) {
    if (!json) console.log('\n--typecheck: automated run covers packages/operator-core only; run the commands above.');
    process.exit(0);
  }
  // EI-21186968326903578 / EI-21288330711276964: a BARE lint-tsc run here is the whole-tree
  // CI gate (scope=all), so on this shared checkout its exit 1 was routinely a PEER's
  // in-flight edit or a standing committed red — reported under a "✗ … after a
  // required-field addition" headline that invited the causal reading and sent authors off
  // to debug (or un-require) a clean change. lint-tsc's `--files=` mode already solves the
  // exact attribution this leg needs: it fails ONLY on the named files PLUS files
  // whose source or compiler diagnostic references the named files' exported type names
  // (`filesReferencingTypeNames` / `diagnosticFilesReferencingTypeNames` — i.e. the
  // stranded-dependent population this guard exists for), and labels every other red
  // as a peer live-edit or an already-recorded standing red that stays green. So forward
  // the caller's operator-core set instead of re-deriving a worse partition here.
  //
  // Which set: in --files= (declared) mode, the caller's WHOLE declared operator-core set —
  // their change, including construction-site fixes in files beyond the finding ones. In
  // inferred mode, ONLY the finding files: the inferred candidate set is every agent's
  // uncommitted edits (see the warning printed above), and forwarding all of it would
  // re-import the very peer-misattribution this fix removes.
  //
  // Only paths that EXIST in the tree: a declared set is a changed-path list, so it carries
  // DELETIONS too, and lint:tsc refuses a whole selection that names a missing file
  // (status=preflight-failed, exit 2 here) — one deleted file then blinds this guard to every
  // real strand in the rest of the change (WI-10003758). A deleted file adds no required field.
  const ocFiles = [
    ...new Set(
      (declaredFiles ?? findings.map((f) => f.file)).filter(
        (f) => f.startsWith('packages/operator-core') && existsSync(resolve(ROOT, f)),
      ),
    ),
  ];
  if (!json) {
    console.log(
      `\n--typecheck: running lint:tsc --files=<${ocFiles.length} file(s)> — verdict scoped to YOUR files`,
    );
    console.log(
      '  plus files whose source or compiler diagnostic references their exported type names',
    );
    console.log('  (the stranded-site population);');
    console.log('  peer live-edits and standing committed reds are labelled and stay green.');
  }
  let out = '';
  try {
    out = execFileSync('node', ['scripts/lint-tsc.mjs', `--files=${ocFiles.join(',')}`], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    if (!json) console.log(out);
    // EI-21823157797410616 — this catch used to render ANY non-zero lint-tsc exit as the
    // attribution verdict below, without checking that anything had actually been
    // attributed. lint-tsc's own documented exit 1 means "a file regressed above its
    // baseline, a TS1xxx hard-fail, OR A SCRIPT/TOOLCHAIN ERROR" (scripts/lint-tsc.mjs:49),
    // so the three were indistinguishable here and the third was reported as the first.
    //
    // MEASURED (2026-08-29, canonical run 4 of test-suite-recovery-2026-08-27), all four
    // read off that run's own log: the runner forwarded `--base origin/main` while
    // origin/main sat 5,664 commits / 6 days stale (it only fast-forwards on a GREEN
    // checkpoint, and the gate had been red since); the whole-tree diff made `ocFiles`
    // 3,238 files; the captured output held 1,289 `fatal: path … exists on disk, but not
    // in 'origin/main'` lines and ZERO `error TS` lines; and no LINT_TSC_RESULT marker was
    // emitted anywhere, so lint-tsc exited before reaching its own verdict line. This
    // branch nevertheless announced that the caller's change had stranded construction
    // sites. Exit 1 is GATING, so that false verdict red-pinned a full-suite run for the
    // whole fleet.
    //
    // NOT established: WHICH of runTscBaselineGate's 15+ exit(1) sites was taken. The
    // absent marker plus the zero diagnostics prove only that it fell over before judging
    // anything. That is deliberately left open here, because this fix does not depend on
    // it — the predicate below keys on whether a diagnostic was PRODUCED, which is correct
    // for every upstream failure mode rather than for one diagnosed instance.
    //
    // The runner already models this correctly and has since WI-37826: a strand guard
    // answers THREE things — 0 "checked, found nothing", 1 "checked, found something",
    // EXIT_NOT_CHECKED "I could not look" — and this guard is registered
    // `notCheckedIsNonGating: true`, so classifyTaskExit() reads the third as
    // `undetermined` rather than a violation. The only thing missing was for this leg to
    // tell the truth about which of the three had happened.
    //
    // Deliberately NOT weakened: a real stranded site always carries tsc diagnostics, so
    // genuine findings still take the attribution branch below and still gate.
    if (!attributedTypeErrors(out)) {
      console.error(
        '\n⚠ NOT CHECKED — lint:tsc exited non-zero but reported NO TypeScript diagnostics,',
      );
      console.error(
        '  so nothing was attributed to your change and this run proved NOTHING about it.',
      );
      console.error(
        '  That is an INSTRUMENT fault, not a finding: typically the forwarded --base is',
      );
      console.error(
        '  stale enough that the diff covers files outside the typecheck project, and the',
      );
      console.error('  gate exits before it can even emit its LINT_TSC_RESULT marker.');
      console.error('  This is NOT a clean bill either — re-run against a base that resolves:');
      console.error(
        '    node scripts/check-required-field-strands.mjs --typecheck --base <pre-edit-commit> --files=<your,files>',
      );
      process.exitCode = EXIT_NOT_CHECKED;
      return;
    }
    console.error(
      '\n✗ typecheck reported errors ATTRIBUTED TO YOUR CHANGE — in the file(s) you named,',
    );
    console.error(
      '  or in files whose source or compiler diagnostic references their exported type names',
    );
    console.error(
      '  (likely stranded construction',
    );
    console.error(
      '  sites of the new required field). Peer/standing reds do NOT trip this verdict;',
    );
    console.error('  see the lint:tsc attribution output above for exactly which files are yours.');
    console.error('  Do NOT make the new field optional just to silence these.');
    // NOT process.exit(): `out` holds up to 64MB of captured tsc output and exit() does
    // not drain an async pipe write, so piping this would cut the error list — which
    // reads as FEWER type errors. See scripts/check-undrained-stdout-exit.mjs.
    process.exitCode = 1;
    return;
  }
  if (!json) console.log(out);
  process.exitCode = 0;
}

/**
 * Did lint:tsc actually ATTRIBUTE a TypeScript diagnostic to the caller's files?
 *
 * The predicate that separates "the typechecker found stranded construction sites" from
 * "the typechecker fell over". It keys on the presence of a tsc diagnostic rather than on
 * the exit status, because lint-tsc's exit 1 deliberately conflates a real regression with
 * a script/toolchain error (scripts/lint-tsc.mjs:49) — so the exit code cannot answer this
 * and the OUTPUT can.
 *
 * Safe direction: a genuine regression always prints its diagnostics
 * (`formatRegressedFileDiagnostics`), and every tsc diagnostic carries an `error TS####`
 * code, so a real finding can never read as unattributed. The converse — output with no
 * diagnostic at all — cannot be a finding, whatever the exit status claims.
 *
 * Pure, so the distinction is unit-testable rather than reachable only through an
 * end-to-end run that needs a stale base ref to reproduce.
 *
 * @param {string} [out] combined stdout+stderr captured from lint-tsc
 * @returns {boolean}
 */
export function attributedTypeErrors(out = '') {
  return /\berror TS\d+/.test(out);
}

// Only run main() when invoked as a script, so the pure fns above stay unit-testable.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
