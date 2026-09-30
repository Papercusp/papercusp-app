import { NextResponse } from 'next/server';
import { readCredentials, writeCredentials, maskCredentials } from '@/lib/credentials';

export const dynamic = 'force-dynamic';

export async function GET() {
  const creds = await readCredentials();
  return NextResponse.json(maskCredentials(creds));
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const existing = await readCredentials();
  // Only overwrite a field if the caller provided a non-empty string.
  // Empty string clears the field; undefined leaves it alone.
  const next = { ...existing };
  for (const k of ['anthropic_api_key', 'openai_api_key', 'github_pat'] as const) {
    if (k in body) {
      const v = (body as Record<string, unknown>)[k];
      if (typeof v === 'string') next[k] = v.trim() || undefined;
    }
  }
  const written = await writeCredentials(next);
  return NextResponse.json(maskCredentials(written));
}
