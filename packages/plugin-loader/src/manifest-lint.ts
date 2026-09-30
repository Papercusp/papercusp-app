/**
 * Static-lint helpers for plugin manifests (Batch G6 + H6 + the
 * already-shipped bare-`*` warning). Pure functions consumable by the
 * CLI's `papercusp plugin lint` subcommand and operator-side install
 * gates. Distinct from manifest-validate.ts which does load-time Ajv
 * validation; these run as a *secondary* pass after the schema accepts
 * the manifest, and surface non-fatal warnings + plan-rev3 invariants.
 *
 * - lintBareWildcardCaps:  warns on `<prefix>:*` capability strings
 *   (the cap-matcher does NOT expand bare-* — enumerate explicit
 *   resources instead).
 * - lintWasmActionsAgainstWit:  G6 — when manifest.runtime.kind is
 *   'wasm' and a wit-bindgen `.d.ts` is colocated, declared manifest
 *   actions must appear in the typed surface.
 * - lintIframeSameOrigin:  H6 — for ui[].type === 'iframe', the
 *   referenced HTML must only `<script src=>` and `<link href=>` to
 *   same-origin paths (relative or starting with `/`), unless the
 *   external host is in declared `http:fetch:*` caps.
 */

export interface LintFinding {
  level: 'error' | 'warning';
  rule: string;
  message: string;
  where?: string;
}

export interface ManifestForLint {
  name: string;
  capabilities?: string[];
  actions?: Array<{ name: string; capabilities?: string[] }>;
  runtime?: { kind?: 'js' | 'wasm' | 'daemon'; wasmPath?: string };
  ui?: Array<{ type?: 'react' | 'iframe'; iframeEntry?: string; slug: string }>;
}

export function lintBareWildcardCaps(m: ManifestForLint): LintFinding[] {
  const out: LintFinding[] = [];
  const isAcceptablePattern = (c: string): boolean => {
    // Subdomain wildcard `<prefix>:*.foo.com` and prefix wildcard
    // `<prefix>:foo*` are honored by the cap matcher; bare `<prefix>:*`
    // is not.
    if (/^[\w-]+:[\w-]+:\*\.[\w.-]+$/.test(c)) return true;
    if (/^[\w-]+:[\w-]+:[\w-]+\*$/.test(c)) return true;
    return false;
  };
  const check = (caps: string[] | undefined, where: string): void => {
    for (const c of caps ?? []) {
      if (/:\*$/.test(c) && !isAcceptablePattern(c)) {
        out.push({
          level: 'warning',
          rule: 'bare-wildcard-cap',
          message: `capability '${c}' uses a bare-* wildcard at the leaf segment. The cap matcher does NOT expand bare-* — enumerate the specific resources instead.`,
          where,
        });
      }
    }
  };
  check(m.capabilities, `${m.name}.capabilities`);
  for (const a of m.actions ?? []) {
    check(a.capabilities, `${m.name}.actions[${a.name}].capabilities`);
  }
  return out;
}

export async function lintWasmActionsAgainstWit(
  m: ManifestForLint,
  resolveWasmDts: (wasmPath: string) => Promise<string | null>,
): Promise<LintFinding[]> {
  if (m.runtime?.kind !== 'wasm' || !m.runtime.wasmPath) return [];
  const dts = await resolveWasmDts(m.runtime.wasmPath);
  if (!dts) {
    return [{
      level: 'warning',
      rule: 'wasm-no-dts',
      message: `runtime.kind='wasm' but no .d.ts found alongside ${m.runtime.wasmPath}; cannot cross-check action exports`,
    }];
  }
  const out: LintFinding[] = [];
  for (const a of m.actions ?? []) {
    if (!dts.includes(a.name)) {
      out.push({
        level: 'warning',
        rule: 'wasm-action-not-in-wit',
        message: `manifest declares action '${a.name}' but the colocated wit-bindgen .d.ts doesn't reference it`,
        where: `${m.name}.actions[${a.name}]`,
      });
    }
  }
  return out;
}

export function lintIframeSameOrigin(
  m: ManifestForLint,
  readIframeHtml: (entry: string) => string | null,
): LintFinding[] {
  const out: LintFinding[] = [];
  for (const ui of m.ui ?? []) {
    if (ui.type !== 'iframe' || !ui.iframeEntry) continue;
    const html = readIframeHtml(ui.iframeEntry);
    if (html == null) {
      out.push({
        level: 'error',
        rule: 'iframe-entry-missing',
        message: `ui[${ui.slug}].iframeEntry='${ui.iframeEntry}' could not be read`,
      });
      continue;
    }
    const hostsAllowed = (m.capabilities ?? [])
      .filter((c) => c.startsWith('http:fetch:'))
      .map((c) => c.slice('http:fetch:'.length));
    const externals: string[] = [];
    const re = /<(?:script|link)[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(html))) {
      const url = mm[1]!;
      // Same-origin shapes: starts with /, ./, or a relative path
      // without a scheme. Schemed URLs need a cap.
      if (/^https?:\/\//i.test(url)) {
        try {
          const u = new URL(url);
          const ok = hostsAllowed.some((h) => h === u.hostname || (h.startsWith('*.') && u.hostname.endsWith(h.slice(1))));
          if (!ok) {
            externals.push(`${url} (host=${u.hostname} not in declared http:fetch:* caps)`);
          }
        } catch {
          externals.push(`${url} (unparseable URL)`);
        }
      }
    }
    for (const e of externals) {
      out.push({
        level: 'warning',
        rule: 'iframe-external-asset',
        message: `iframe loads external asset: ${e}`,
        where: `${m.name}.ui[${ui.slug}].iframeEntry`,
      });
    }
  }
  return out;
}

export async function lintManifest(
  m: ManifestForLint,
  resolvers: {
    wasmDts?: (wasmPath: string) => Promise<string | null>;
    iframeHtml?: (entry: string) => string | null;
  } = {},
): Promise<LintFinding[]> {
  const out: LintFinding[] = [];
  out.push(...lintBareWildcardCaps(m));
  if (resolvers.wasmDts) {
    out.push(...(await lintWasmActionsAgainstWit(m, resolvers.wasmDts)));
  }
  if (resolvers.iframeHtml) {
    out.push(...lintIframeSameOrigin(m, resolvers.iframeHtml));
  }
  return out;
}
