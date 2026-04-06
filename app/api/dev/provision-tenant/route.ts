import { provisionTenants } from '@/utils/tenants/provision';
import { NextResponse } from 'next/server';

// Force dynamic rendering - prevent static generation at build time
export const dynamic = 'force-dynamic';

/**
 * DEV ONLY - Route API pour déclencher le provisioning
 *
 * ⚠️ SÉCURITÉ: Cette route est BLOQUÉE en production
 * Utilisée uniquement pour les tests et scripts de développement
 */
export async function POST(request: Request) {
  // ⚠️ PROTECTION: Bloquer en production
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { error: 'This endpoint is only available in development mode' },
      { status: 403 }
    );
  }

  try {
    const { email, password, userId } = await request.json();

    if (!email || !userId) {
      return NextResponse.json(
        { error: 'Missing required fields: email and userId' },
        { status: 400 }
      );
    }

    console.log(`[DEV API] Provisioning triggered for user ${userId}`);

    // Start provisioning (don't await to return quickly)
    provisionTenants(email, password || '', userId)
      .then((result) => {
        console.log('[DEV API] Provisioning completed:', {
          success: result.success,
          twentySuccess: result.twenty?.success,
          notifuseSuccess: result.notifuse?.success,
          errors: result.errors,
        });
      })
      .catch((error) => {
        console.error('[DEV API] Provisioning failed:', error);
      });

    return NextResponse.json({
      success: true,
      message: 'Provisioning started in background'
    });
  } catch (error: any) {
    console.error('[DEV API] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}

// Aussi bloquer GET en production
export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { error: 'This endpoint is only available in development mode' },
      { status: 403 }
    );
  }

  return NextResponse.json({
    message: 'DEV API - Provision Tenant endpoint',
    usage: 'POST with { email, password, userId }'
  });
}
