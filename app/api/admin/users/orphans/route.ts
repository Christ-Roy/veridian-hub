/**
 * GET /api/admin/users/orphans
 *
 * Endpoint admin de consultation des users Hub orphelins (read-only).
 * Identique en logique au cron `cleanup-orphan-users` mais protégé par
 * `requireAdmin` (session ou x-admin-secret) plutôt que CRON_SECRET, pour
 * que l'opérateur puisse exécuter une revue manuelle depuis le navigateur
 * ou un curl admin.
 *
 * Query params :
 *  - minAgeDays (default 7)  : âge minimum d'un orphelin
 *  - limit      (default 100): cap sur le nombre de rows retournées
 *
 * Aucune action destructive — voir aussi `lib/admin/find-orphan-users.ts`.
 */

import { NextRequest, NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import { authenticateAdmin } from '@/lib/admin/authenticate';
import { findOrphanUsers } from '@/lib/admin/find-orphan-users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authResult = await authenticateAdmin(request);
  if (!authResult.ok) return authResult.response;

  const url = new URL(request.url);
  const minAgeDays = Number(url.searchParams.get('minAgeDays') ?? '7');
  const limit = Number(url.searchParams.get('limit') ?? '100');

  const result = await findOrphanUsers(prisma, { minAgeDays, limit });
  return NextResponse.json(result);
}
