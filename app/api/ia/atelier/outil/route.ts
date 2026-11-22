/** L'atelier joue un des trois outils de la porte pour un tour de conversation (docs/MON-IA.md). */
import { NextResponse, type NextRequest } from 'next/server';

import { vientDeLAtelier } from '@/lib/ia/atelier';
import { appelantPourAtelier } from '@/lib/ia/atelier-appel';
import { traiter } from '@/lib/mcp/porte';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OUTILS = ['chercher_outils', 'decrire_outil', 'executer_outil'];

export async function POST(req: NextRequest) {
  const brut = await req.text();
  if (!vientDeLAtelier(req.headers, brut)) return NextResponse.json({ error: 'signature' }, { status: 401 });
  const d = JSON.parse(brut) as { hubUserId?: string; tenantId?: string; sessionId?: string; nom?: string; arguments?: Record<string, unknown> };
  if (!OUTILS.includes(String(d.nom))) return NextResponse.json({ error: 'outil_inconnu' }, { status: 400 });
  const a = await appelantPourAtelier(d);
  if (!a) return NextResponse.json({ error: 'session_refusee' }, { status: 403 });
  const args = { ...(d.arguments ?? {}) };
  // L'espace est celui de la conversation, quoi que demande le modèle.
  if (d.nom === 'executer_outil') args.espace = a.t.tenantId;
  const r = await traiter(prisma, a.qui, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: d.nom, arguments: args } });
  const res = (r?.result ?? {}) as { content?: { text?: string }[]; isError?: boolean };
  return NextResponse.json({ texte: (res.content ?? []).map((c) => c.text ?? '').join('\n'), erreur: res.isError === true });
}
