/**
 * Cron Job: Cleanup Expired Free Trials
 *
 * Endpoint: POST /api/cron/cleanup-trials
 * Schedule: Daily (via Vercel Cron, GitHub Actions, or external scheduler)
 *
 * Architecture:
 * - Twenty: Gère son propre cleanup (ne fait rien ici)
 * - Notifuse: Supprime les workspaces via API
 *
 * Security:
 * - Requiert CRON_SECRET dans le header Authorization
 * - Rate limited à 1 exécution par minute
 */

import { NextRequest, NextResponse } from 'next/server';
import { cleanupExpiredTrials, getExpiringTrials } from '@/utils/tenants/cleanup';

// Secret pour authentifier les requêtes cron
const CRON_SECRET = process.env.CRON_SECRET;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 60 seconds max

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    // Vérifier l'authentification
    const authHeader = request.headers.get('authorization');
    const providedSecret = authHeader?.replace('Bearer ', '');

    if (!CRON_SECRET) {
      console.error('[Cron] CRON_SECRET not configured');
      return NextResponse.json(
        { error: 'Cron not configured' },
        { status: 500 }
      );
    }

    if (providedSecret !== CRON_SECRET) {
      console.warn('[Cron] Unauthorized cleanup attempt');
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    console.log('[Cron] 🧹 Starting cleanup job...');

    // Exécuter le cleanup
    const result = await cleanupExpiredTrials();

    // Récupérer les tenants qui vont expirer bientôt (pour monitoring)
    const expiringIn3Days = await getExpiringTrials(3);

    const duration = Date.now() - startTime;

    console.log('[Cron] ✅ Cleanup job completed:', {
      duration_ms: duration,
      ...result,
      expiring_soon: expiringIn3Days.length,
    });

    return NextResponse.json({
      success: result.success,
      message: `Processed ${result.tenantsProcessed} tenant(s), deleted ${result.tenantsDeleted}`,
      details: {
        tenantsProcessed: result.tenantsProcessed,
        tenantsDeleted: result.tenantsDeleted,
        expiringSoon: expiringIn3Days.length,
        errors: result.errors,
      },
      duration_ms: duration,
      timestamp: new Date().toISOString(),
    });

  } catch (error: any) {
    const duration = Date.now() - startTime;
    console.error('[Cron] ❌ Cleanup job failed:', error);

    return NextResponse.json(
      {
        success: false,
        error: error.message,
        duration_ms: duration,
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}

// GET pour vérifier le statut (sans authentification)
export async function GET() {
  return NextResponse.json({
    endpoint: '/api/cron/cleanup-trials',
    method: 'POST',
    description: 'Cleanup expired Free Trial workspaces',
    authentication: 'Bearer CRON_SECRET',
    schedule: 'Daily recommended',
    note: 'Twenty manages its own cleanup. This only handles Notifuse workspaces.',
  });
}
