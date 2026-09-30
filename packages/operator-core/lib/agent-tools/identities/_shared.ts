import { z } from 'zod';

export const identityId = z.string().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'blueprint id, not a filesystem path');
export const repoDir = z.string().min(1).optional().describe('Member repository; its .papercusp/blueprints tier precedes installed and built-in sources.');
export const identityText = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
