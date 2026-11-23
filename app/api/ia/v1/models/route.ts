/** GET /api/ia/v1/models : le seul modèle du fournisseur « Veridian » (docs/MON-IA.md). Clé d'instance exigée. */
import { createHash, timingSafeEqual } from 'node:crypto';

import { MODELE_VERIDIAN, erreurOpenAI } from '@/lib/ia/fournisseur';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const cle = process.env.IA_FOURNISSEUR_CLE ?? '';
  const porteur = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  const h = (s: string) => createHash('sha256').update(s).digest();
  if (cle.length < 32 || !timingSafeEqual(h(porteur), h(cle))) return erreurOpenAI(401, 'cle_instance', 'Authentification refusée.');
  return Response.json({ object: 'list', data: [{ id: MODELE_VERIDIAN, object: 'model', created: 1795392000, owned_by: 'veridian' }] });
}
