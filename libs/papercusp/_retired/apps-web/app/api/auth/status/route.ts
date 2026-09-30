import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Auth status — checks the session cookie and returns the signed-in user
 * (if any). API keys remain LOCAL-ONLY at ~/.papercusp/credentials.json
 * regardless of auth state.
 */
export async function GET() {
  const user = await getSessionUser();
  return NextResponse.json({
    signedIn: !!user,
    user,
    note: 'API keys at ~/.papercusp/credentials.json work without sign-in. Sign-in only enables cross-device profile sync.',
  });
}
