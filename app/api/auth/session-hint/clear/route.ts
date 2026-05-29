/**
 * POST /api/auth/session-hint/clear
 *
 * Supprime le cookie hint `veridian-session-hint`. Appelé par le client
 * AVANT le signOut Auth.js (le signOut Auth.js standard ne sait pas
 * effacer ce cookie supplémentaire — sa logique se concentre sur le
 * sessionToken).
 *
 * Public (pas d'auth required) : un user déjà non-loggué (ou avec un
 * cookie hint orphelin après expiration de la session principale) doit
 * pouvoir le clear sans erreur. Le pire cas est un effacement inutile —
 * pas une fuite.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { clearSessionHintCookie } from '@/lib/auth/session-hint-cookie';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(_request: NextRequest) {
  const response = NextResponse.json({ ok: true });
  clearSessionHintCookie(response);
  return response;
}
