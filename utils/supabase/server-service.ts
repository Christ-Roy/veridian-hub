/**
 * Supabase Service Client - Admin Access
 *
 * WHY THIS FILE EXISTS:
 * =====================
 *
 * The default createClient() in ./server.ts uses the ANONYME KEY, which is subject to
 * Row Level Security (RLS) policies. This prevents admin operations like inserting
 * tenant records during provisioning.
 *
 * This client uses the SERVICE ROLE KEY which:
 * - Bypasses RLS restrictions
 * - Has full admin access to all tables
 * - Should ONLY be used for server-side admin operations
 *
 * USAGE PATTERN:
 * =============
 *
 * ✅ USE createServiceClient() for:
 *   - Admin operations (tenant provisioning, system tasks)
 *   - Background jobs
 *   - Database migrations via code
 *
 * ❌ USE createClient() for:
 *   - User data operations (respects RLS)
 *   - Frontend components
 *   - User authentication
 *
 * SECURITY NOTE:
 * ===============
 *
 * NEVER expose the SERVICE ROLE KEY to the frontend. This file is server-side only
 * and should be imported carefully.
 */

/**
 * Supabase Service Client - Admin Access
 *
 * WHY THIS FILE EXISTS:
 * =====================
 *
 * The default createClient() in ./server.ts uses the ANONYME KEY, which is subject to
 * Row Level Security (RLS) policies. This prevents admin operations like inserting
 * tenant records during provisioning.
 *
 * This client uses the SERVICE ROLE KEY which:
 * - Bypasses RLS restrictions
 * - Has full admin access to all tables
 * - Should ONLY be used for server-side admin operations
 *
 * USAGE PATTERN:
 * =============
 *
 * ✅ USE createServiceClient() for:
 *   - Admin operations (tenant provisioning, system tasks)
 *   - Background jobs
 *   - Database migrations via code
 *
 * ❌ USE createClient() for:
 *   - User data operations (respects RLS)
 *   - Frontend components
 *   - User authentication
 *
 * SECURITY NOTE:
 * ===============
 *
 * NEVER expose the SERVICE ROLE KEY to the frontend. This file is server-side only
 * and should be imported carefully.
 */

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { Database } from '@/types_db';

/**
 * Create a Supabase client with SERVICE ROLE KEY for server-side operations
 * This bypasses RLS and allows full admin access to the database
 */
export const createServiceClient = () => {
  const cookieStore = cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,  // ← SERVICE ROLE KEY (admin access)
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set(name: string, value: string, options: any) {
          cookieStore.set({
            name,
            value,
            ...options,
          });
        },
        remove(name: string, options: any) {
          cookieStore.set({
            name,
            value: '',
            ...options,
          });
        }
      }
    }
  );
};