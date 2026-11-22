/**
 * Contexte d'une requête « Mon IA » : l'utilisateur de la session Hub, à adresse prouvée, et le tenant
 * demandé, qui doit lui appartenir (espacesDe, la même règle que la porte MCP). Jamais un tenant choisi
 * par le navigateur sans cette vérification (menace « fuite entre tenants », docs/MON-IA.md).
 */
import { NextResponse } from 'next/server';

import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { isEmailProvenForSession } from '@/lib/auth/email-proof';
import { RateLimiter } from '@/lib/auth/rate-limit';
import { espacesDe } from '@/lib/mcp/catalogue';
import { MCP_SCOPE } from '@/lib/mcp/config';
import type { Appelant } from '@/lib/mcp/oauth';
import { prisma } from '@/lib/prisma';

/** Plafonds (docs/MON-IA.md) : messages par minute et par jour, par utilisateur. */
export const parMinute = new RateLimiter({ name: 'ia-chat-minute', capacity: 10, windowMs: 60_000 });
export const parJour = new RateLimiter({ name: 'ia-chat-jour', capacity: 300, windowMs: 86_400_000 });

export type ContexteIa = { hubUserId: string; email: string; qui: Appelant };

export async function contexteUtilisateur(): Promise<ContexteIa | NextResponse> {
  const user = await getCurrentUser();
  if (!user?.email || !user.supabaseUserId) return NextResponse.json({ error: 'non_connecte' }, { status: 401 });
  if (!(await isEmailProvenForSession(user.id))) return NextResponse.json({ error: 'adresse_non_prouvee' }, { status: 403 });
  const hubUserId = userUuid(user);
  return {
    hubUserId,
    email: user.email,
    qui: {
      hubUserId,
      clientId: 'mon-ia',
      clientName: 'Assistant Veridian',
      scope: MCP_SCOPE,
      email: user.email,
      name: user.name ?? null,
      userId: user.id,
    },
  };
}

export type Espace = { id: string; slug: string; workspaceId: string | null };

const WORKSPACE_ID = /^[0-9a-f-]{36}$/i;

/**
 * L'espace demandé, s'il appartient à l'utilisateur ; sinon null. Désigné par le tenant Hub, ou par
 * l'identifiant d'espace de l'app (`metadata.<app>.workspace_id`) quand l'app ne connaît que le sien
 * (Twenty : le plugin ne voit que son workspace). Dans les deux cas, seuls les espaces de l'utilisateur
 * sont cherchés.
 */
export async function espaceDe(
  hubUserId: string,
  tenantId: unknown,
  parApp?: { app: string; workspaceId: unknown },
): Promise<Espace | null> {
  const parTenant = typeof tenantId === 'string' && tenantId.length > 0;
  const ws = parApp && typeof parApp.workspaceId === 'string' && WORKSPACE_ID.test(parApp.workspaceId) ? parApp.workspaceId : null;
  if (!parTenant && !ws) return null;
  const espaces = await espacesDe(prisma, hubUserId);
  const ids = espaces.map((e) => e.id);
  if (!ids.length) return null;
  const lignes = await prisma.tenant.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, slug: true, metadata: true } });
  const wsDe = (meta: unknown, app: string): string | null => {
    const v = (meta as Record<string, { workspace_id?: unknown } | undefined> | null)?.[app]?.workspace_id;
    return typeof v === 'string' ? v : null;
  };
  const app = parApp?.app ?? '';
  const t = parTenant ? lignes.find((l) => l.id === tenantId) : lignes.find((l) => app && wsDe(l.metadata, app) === ws);
  if (!t) return null;
  // Les deux donnés : ils doivent désigner le même espace.
  if (parTenant && ws && wsDe(t.metadata, app) !== ws) return null;
  return { id: t.id, slug: t.slug, workspaceId: app ? wsDe(t.metadata, app) : null };
}
