/**
 * GET /api/admin/prospect-scores
 *
 * Expose en LECTURE l'agrégat `hub_app.prospect_scores` écrit par le
 * réconciliateur (Lot 1). Sans cette route, vérifier qu'un event Notifuse a
 * bien bougé le score d'un prospect imposait du SQL brut en prod — aucune
 * observabilité applicative sur la sortie du scoring.
 *
 * Auth : `requireAdmin` (x-admin-secret OU session admin whitelistée). Pas de
 * route admin sans check serveur (CVE-2025-29927 — le middleware Edge ne
 * suffit pas).
 *
 * Querystring (tous optionnels, clampés) :
 *   - `workspace` / `workspaceSlug` : filtre sur un tenant (slug Notifuse).
 *   - `minScore` : score d'engagement minimum (défaut 0, clamp ≥ 0).
 *   - `limit` : nombre de lignes (1..200, défaut 50).
 *   - `offset` : pagination simple (≥ 0, défaut 0).
 *
 * Tri `engagementScore DESC` → exploite l'index existant
 * `(workspace_slug, engagement_score DESC)`.
 *
 * Réponse 200 :
 * ```
 * {
 *   items: [{ contactEmail, workspaceSlug, engagementScore, signals,
 *             lastEventAt, vid, tenantUuid }],
 *   total,           // nombre de prospects matchant le filtre (hors pagination)
 *   limit, offset
 * }
 * ```
 *
 * Ne renvoie JAMAIS le payload brut des events (PII) — uniquement l'agrégat
 * `prospect_scores`. Pour le détail forensique d'un prospect, voir le
 * réconciliateur / la table `prospect_events` directement.
 *
 * No cache : donnée admin sensible, lecture temps-réel.
 */

import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/admin/require-admin';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Parse un entier de querystring avec borne et fallback. Tout input non
 * numérique retombe sur `fallback` (dégradation tolérante, pas de 400).
 */
function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw === null ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export async function GET(request: NextRequest) {
  const denial = await requireAdmin(request);
  if (denial) return denial;

  const { searchParams } = new URL(request.url);

  // `workspace` est l'alias court ; `workspaceSlug` accepté aussi.
  const workspaceSlug =
    searchParams.get('workspace')?.trim() || searchParams.get('workspaceSlug')?.trim() || null;

  const minScore = clampInt(searchParams.get('minScore'), 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = clampInt(searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);

  const where: { workspaceSlug?: string; engagementScore?: { gte: number } } = {};
  if (workspaceSlug) where.workspaceSlug = workspaceSlug;
  if (minScore > 0) where.engagementScore = { gte: minScore };

  // total (hors pagination) + page, en parallèle.
  const [total, rows] = await Promise.all([
    prisma.prospectScore.count({ where }),
    prisma.prospectScore.findMany({
      where,
      // Tri qui exploite l'index (workspace_slug, engagement_score DESC).
      // `contactEmail` en tie-breaker pour une pagination déterministe.
      orderBy: [{ engagementScore: 'desc' }, { contactEmail: 'asc' }],
      take: limit,
      skip: offset,
      select: {
        contactEmail: true,
        workspaceSlug: true,
        engagementScore: true,
        signals: true,
        lastEventAt: true,
        vid: true,
        tenantUuid: true,
      },
    }),
  ]);

  return NextResponse.json(
    {
      items: rows.map((r) => ({
        contactEmail: r.contactEmail,
        workspaceSlug: r.workspaceSlug,
        engagementScore: r.engagementScore,
        signals: r.signals,
        lastEventAt: r.lastEventAt,
        vid: r.vid,
        tenantUuid: r.tenantUuid,
      })),
      total,
      limit,
      offset,
    },
    { status: 200, headers: NO_STORE_HEADERS },
  );
}
