/**
 * Static reference check for the CloudFormation templates Papercusp renders for customers
 * (the desktop AWS setup template and the hosted customer-role stack).
 *
 * CloudFormation refuses a whole stack when any `Ref`, `Fn::GetAtt` or `Fn::Sub` names a logical
 * id the template does not declare, and it only says so when the customer tries to create it.
 * WI-10005783: the desktop setup template shipped a KMS key policy pointing at the hosted stack's
 * role id, and the existing test only checked references inside Outputs, so nothing caught it
 * before a live canary did. This walks the WHOLE document instead.
 */

/** Pseudo-parameters are always resolvable; `AWS::` prefixes them. */
function isPseudoParameter(name: string): boolean {
  return name.startsWith('AWS::');
}

/** `${Name}` / `${Name.Attr}` placeholders in an Fn::Sub string; `${!Literal}` is an escape. */
function subPlaceholders(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/\$\{([^}]+)\}/g)) {
    const body = match[1]!.trim();
    if (body.startsWith('!')) continue;
    names.push(body.split('.')[0]!);
  }
  return names;
}

/** Every logical id (or parameter name) a CloudFormation intrinsic anywhere in `value` references. */
export function cloudFormationReferencedNames(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) cloudFormationReferencedNames(entry, into);
    return into;
  }
  if (!value || typeof value !== 'object') return into;
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'Ref' && typeof entry === 'string') {
      if (!isPseudoParameter(entry)) into.add(entry);
    } else if (key === 'Fn::GetAtt') {
      const target = Array.isArray(entry) ? entry[0] : typeof entry === 'string' ? entry.split('.')[0] : undefined;
      if (typeof target === 'string') into.add(target);
      else cloudFormationReferencedNames(entry, into);
    } else if (key === 'Fn::Sub') {
      const [text, variables] = Array.isArray(entry) ? entry : [entry, undefined];
      const local = variables && typeof variables === 'object' ? Object.keys(variables) : [];
      if (typeof text === 'string') {
        for (const name of subPlaceholders(text)) {
          if (!isPseudoParameter(name) && !local.includes(name)) into.add(name);
        }
      }
      if (variables !== undefined) cloudFormationReferencedNames(variables, into);
    } else {
      cloudFormationReferencedNames(entry, into);
    }
  }
  return into;
}

/**
 * Names referenced anywhere in `document` that it does not declare as a Resource or Parameter,
 * sorted. Empty means every reference resolves.
 */
export function cloudFormationDanglingReferences(document: Record<string, unknown>): string[] {
  const declared = new Set<string>([
    ...Object.keys((document.Resources as Record<string, unknown> | undefined) ?? {}),
    ...Object.keys((document.Parameters as Record<string, unknown> | undefined) ?? {}),
  ]);
  return [...cloudFormationReferencedNames(document)].filter((name) => !declared.has(name)).sort();
}
