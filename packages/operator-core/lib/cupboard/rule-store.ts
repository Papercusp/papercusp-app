/** Local rule packages use the same layered directory store as other Cupboard
 * content. Reading pins inert data; registration and wearer authorization stay
 * in the existing standalone reaction/activation path. */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { dataConditionSchema } from '@papercusp/rules';
import { parseClassFireTarget } from '../events/class-fire-target';
import type { StandaloneRuleInput } from '../events/standalone-rules';
import {
  enumerateSelfDescribingDirs, inRepoFallbackDir, selfDescribingRoots,
  type SelfDescribingRoot,
} from './self-describing-store';

export const RULE_MANIFEST = 'rule.json';
export const RULE_PACKAGE_SCHEMA_VERSION = 1 as const;

// The executable fields are the existing StandaloneRuleInput contract. In
// particular, a publisher cannot supply local grants, principals or capabilities.
const RulePackageSchema = z.object({
  schemaVersion: z.literal(RULE_PACKAGE_SCHEMA_VERSION),
  id: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000),
  version: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/),
  on: z.string().trim().min(1).max(200),
  when: dataConditionSchema.optional(),
  fire: z.string().refine((value) => parseClassFireTarget(value) !== null,
    'standalone rules require a capability class fire target'),
  args: z.record(z.string(), z.unknown()).optional(),
  onlyOnSuccess: z.boolean().optional(),
}).strict();

export interface LocalRule extends StandaloneRuleInput {
  ref: string;
  title: string;
  description: string;
  version: string;
  dir: string;
  layer: SelfDescribingRoot['layer'];
}

const inRepoRulesDir = inRepoFallbackDir('rules', import.meta.url);

export function ruleRoots(): SelfDescribingRoot[] {
  return selfDescribingRoots({
    envVar: 'PAPERCUSP_RULES_DIR', devFallbackDir: inRepoRulesDir,
    userSubdir: 'rules/installed',
  });
}

export function readRuleDir(
  dir: string, ref: string, layer: SelfDescribingRoot['layer'] = 'user',
): LocalRule | null {
  try {
    const manifestPath = join(dir, RULE_MANIFEST);
    const listingPath = join(dir, 'listing.json');
    if (statSync(manifestPath).size > 64 * 1024 || statSync(listingPath).size > 32 * 1024) return null;
    const listing = JSON.parse(readFileSync(listingPath, 'utf8')) as Record<string, unknown> | null;
    if (!listing || typeof listing !== 'object' || Array.isArray(listing) ||
        (listing.kind !== 'rule' && listing.listing_kind !== 'rule' && listing.scope !== 'rule')) return null;
    const parsed = RulePackageSchema.safeParse(JSON.parse(readFileSync(manifestPath, 'utf8')));
    if (!parsed.success) return null;
    const { schemaVersion: _schemaVersion, ...rule } = parsed.data;
    // A listed version and its manifest cannot disagree about the selected pin.
    if (listing.version !== undefined && listing.version !== rule.version) return null;
    return { ...rule, ref, dir, layer };
  } catch {
    return null;
  }
}

export function resolveLocalRule(
  idOrRef: string, roots: SelfDescribingRoot[] = ruleRoots(),
): LocalRule | null {
  const key = idOrRef.trim();
  if (!key) return null;
  return enumerateSelfDescribingDirs(roots, readRuleDir)
    .find((rule) => rule.ref === key || rule.id === key) ?? null;
}
