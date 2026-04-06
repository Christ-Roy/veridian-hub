import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/**
 * Force clear all Supabase auth cookies
 * Useful when cookies become stale/invalid (e.g., after container restart with new JWT_SECRET)
 *
 * Usage: GET /api/auth/clear-cookies
 */
export async function GET() {
  try {
    const cookieStore = cookies();
    const allCookies = cookieStore.getAll();

    // Find and delete all Supabase cookies
    const supabaseCookies = allCookies.filter(c => c.name.startsWith('sb-'));

    supabaseCookies.forEach(cookie => {
      cookieStore.delete(cookie.name);
    });

    console.log(`[ClearCookies] 🧹 Cleared ${supabaseCookies.length} Supabase cookies`);

    return NextResponse.json({
      success: true,
      message: `Cleared ${supabaseCookies.length} Supabase cookies`,
      clearedCookies: supabaseCookies.map(c => c.name)
    });
  } catch (error) {
    console.error('[ClearCookies] ❌ Error clearing cookies:', error);
    return NextResponse.json({
      success: false,
      error: 'Failed to clear cookies'
    }, { status: 500 });
  }
}
