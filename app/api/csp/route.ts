/**
 * POST /api/csp : les rapports de violation de la CSP (VER-265). Public (le navigateur les envoie sans session), 64 Ko au plus,
 * rien d'autre que la directive, l'origine bloquée et la page sans query n'est gardé : journal `[csp_violation]`. Répond 204.
 */
import { NextRequest, NextResponse } from 'next/server';

import { resumerRapport } from '@/lib/security/csp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_OCTETS = 64_000;

export async function POST(request: NextRequest) {
  const brut = await request.text().catch(() => '');
  if (brut.length > MAX_OCTETS) return new NextResponse(null, { status: 413 });
  let json: unknown = null;
  try {
    json = JSON.parse(brut);
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  for (const v of resumerRapport(json)) console.warn(JSON.stringify({ tag: '[csp_violation]', ...v }));
  return new NextResponse(null, { status: 204 });
}
