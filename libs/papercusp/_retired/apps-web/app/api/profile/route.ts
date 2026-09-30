import { NextResponse } from 'next/server';
import { readProfile, writeProfile } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  const profile = await readProfile();
  return NextResponse.json(profile);
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const existing = await readProfile();
  const next = { ...existing, ...body };
  // Sanity: never accept arbitrary keys.
  const allowed = ['email', 'display_name', 'default_project_dir', 'preferred_models', 'theme'];
  for (const k of Object.keys(next)) {
    if (!allowed.includes(k) && k !== 'updated_at') delete (next as any)[k];
  }
  const written = await writeProfile(next);
  return NextResponse.json(written);
}
