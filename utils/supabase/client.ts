import { createBrowserClient } from '@supabase/ssr';
import { Database } from '@/types_db';

/**
 * Create a Supabase client for client-side operations.
 *
 * Uses window.__ENV__ (runtime injection from Docker) with fallback to process.env (local dev).
 * This allows the same Docker image to work in any environment without rebuild.
 */
export const createClient = () => {
  // 1. Try Window Injection (Docker Runtime - injected by layout.tsx)
  // 2. Fallback to process.env (Local Dev/Build time)
  const supabaseUrl =
    (typeof window !== 'undefined' && window.__ENV__?.NEXT_PUBLIC_SUPABASE_URL) ||
    process.env.NEXT_PUBLIC_SUPABASE_URL;

  const supabaseKey =
    (typeof window !== 'undefined' && window.__ENV__?.NEXT_PUBLIC_SUPABASE_ANON_KEY) ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('[Supabase Client] Missing URL or Anon Key. Check environment variables.');
    console.error('[Supabase Client] window.__ENV__:', typeof window !== 'undefined' ? window.__ENV__ : 'N/A (server-side)');
    console.error('[Supabase Client] process.env.NEXT_PUBLIC_SUPABASE_URL:', process.env.NEXT_PUBLIC_SUPABASE_URL);
  }

  return createBrowserClient<Database>(supabaseUrl!, supabaseKey!);
};
