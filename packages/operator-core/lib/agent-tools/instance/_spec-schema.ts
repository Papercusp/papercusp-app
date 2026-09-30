/**
 * Shared zod schema for an `InstanceSpec` as it crosses the tool boundary
 * (instance:boot / instance:clone). Permissive on the deployment + genome-config
 * blocks (validated downstream by harness:create's deployment schema + the genome
 * helpers); strict on the spec shape.
 */
import { z } from 'zod';

export const InstanceSpecArgSchema = z.object({
  specVersion: z.number().optional(),
  blueprintRef: z.object({
    id: z.string().min(1),
    extends: z.string().optional(),
    version: z.string().optional(),
    blueprint: z.record(z.string(), z.unknown()).optional(),
  }),
  repoSha: z.string().nullable(),
  deploymentConfig: z.record(z.string(), z.unknown()),
  genome: z.object({
    prompts: z.record(z.string(), z.string()),
    config: z.record(z.string(), z.record(z.string(), z.unknown())),
  }),
});

export const GenomeDeltaArgSchema = z.object({
  prompts: z.record(z.string(), z.string().nullable()).optional(),
  config: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});
