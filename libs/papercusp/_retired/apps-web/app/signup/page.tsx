import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

// Sign-up is just sign-in (any email creates an account on first verification).
export default function SignupRedirect() {
  redirect('/login');
}
