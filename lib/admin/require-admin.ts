/**
 * SHIM : `requireAdmin` n'a plus de logique. Le seul gardien est `authenticateAdmin` (`lib/admin/authenticate.ts`).
 * Gardé uniquement pour `app/api/admin/connecteurs/route.ts`, fichier hors de ce chantier : à supprimer quand il migre.
 */
import { NextRequest, NextResponse } from 'next/server';

import { authenticateAdmin } from '@/lib/admin/authenticate';

export { refusAdmin, secretAdminValide } from '@/lib/admin/authenticate';

/** `null` : autorisé. Sinon la réponse à rendre telle quelle. */
export async function requireAdmin(request: NextRequest): Promise<NextResponse | null> {
  const garde = await authenticateAdmin(request);
  return garde.ok ? null : garde.response;
}
