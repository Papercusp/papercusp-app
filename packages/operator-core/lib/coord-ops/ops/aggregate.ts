/**
 * `vote:aggregate` (NEW — D-004) — a pluggable reducer over the collected posts.
 * Thin wrapper around the pure `aggregateVotes` (`@papercusp/step-program`): parses
 * each post's structured vote / advocate block and produces the confidence-weighted
 * tally the gate reads (`winner`, `margin`, `mean_conf`, `advocate_veto`). The
 * reducer is generic (a `majority` method is also offered); `confidence-weighted`
 * is the vote blueprint's default.
 */
import { z } from 'zod';
import type { CoordOp } from '../types.js';
import { registerCoordOp } from '../registry.js';
import { aggregateVotes } from '@papercusp/step-program';

const postIn = z.object({
  author_id: z.string().nullable().optional(),
  body: z.string(),
});

const args = z.object({
  posts: z.array(postIn).default([]),
  options: z.array(z.string()).optional(),
  method: z.enum(['confidence-weighted', 'majority']).default('confidence-weighted'),
});

const parsedVote = z.object({
  option: z.string(),
  confidence: z.number(),
  author_id: z.string().nullable(),
});

const result = z.object({
  winner: z.string().nullable(),
  margin: z.number(),
  mean_conf: z.number(),
  advocate_veto: z.boolean(),
  tally: z.record(z.string(), z.number()),
  votes: z.array(parsedVote),
  objection: z.string().nullable(),
});

export const aggregateOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'vote:aggregate',
  description: 'Tally collected votes (confidence-weighted) → winner, margin, mean confidence, advocate veto.',
  argsSchema: args,
  resultSchema: result,
  async run(a) {
    const r = aggregateVotes({
      posts: a.posts.map((p) => ({ author_id: p.author_id ?? null, body: p.body })),
      options: a.options,
      method: a.method,
    });
    return {
      winner: r.winner,
      margin: r.margin,
      mean_conf: r.mean_conf,
      advocate_veto: r.advocate_veto,
      tally: r.tally,
      votes: r.votes,
      objection: r.objection,
    };
  },
};

registerCoordOp(aggregateOp);
