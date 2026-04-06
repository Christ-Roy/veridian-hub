import { createClient } from '@/utils/supabase/server';
import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import { getErrorRedirect, getStatusRedirect, getURL } from '@/utils/helpers';

export async function GET(request: NextRequest) {
  // The `/auth/callback` route is required for the server-side auth flow implemented
  // by the `@supabase/ssr` package. It exchanges an auth code for the user's session.
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');

  // Use configured site URL instead of request origin to avoid localhost issues
  const siteUrl = getURL();

  if (code) {
    const supabase = createClient();

    console.log('[AUTH CALLBACK] Exchanging code for session...');
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      console.error('[AUTH CALLBACK] Error exchanging code:', error);
      return NextResponse.redirect(
        getErrorRedirect(
          `${siteUrl}/login`,
          error.name,
          "Sorry, we weren't able to log you in. Please try again."
        )
      );
    }

    if (data?.session) {
      console.log('[AUTH CALLBACK] Session created successfully for user:', data.user?.email);
      // URL to redirect to after sign in process completes
      return NextResponse.redirect(
        getStatusRedirect(
          `${siteUrl}/dashboard`,
          'Success!',
          'You are now signed in.'
        )
      );
    }
  }

  // No code provided, check if user is already authenticated
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();

  if (session) {
    console.log('[AUTH CALLBACK] Existing session found, redirecting to dashboard');
    return NextResponse.redirect(`${siteUrl}/dashboard`);
  }

  // No code and no session - redirect to login
  console.log('[AUTH CALLBACK] No code and no session, redirecting to login');
  return NextResponse.redirect(
    getErrorRedirect(
      `${siteUrl}/login`,
      'Authentication required',
      'Please sign in to continue.'
    )
  );
}
