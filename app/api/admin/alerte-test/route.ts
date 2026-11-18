/**
 * POST /api/admin/alerte-test : envoie une alerte Telegram libellée « test » et dit si elle est livrée.
 *
 * Le contrôle du canal d'alerte du Hub (08/11 : il lisait une variable de salon qui n'existe pas, ses
 * alertes ne partaient jamais). Livrée = l'API Telegram confirme (`ok` et `message_id`). Admin seulement.
 */
import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/admin/require-admin';
import { sendTelegramAlert } from '@/lib/notifications/telegram';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const denial = await requireAdmin(request);
  if (denial) return denial;
  const delivered = await sendTelegramAlert(
    `🧪 <b>Test</b> : alerte de contrôle du Hub (${new Date().toISOString()}). Aucune action à faire.`,
  );
  return NextResponse.json({ delivered }, { status: delivered ? 200 : 502 });
}
