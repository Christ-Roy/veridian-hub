/**
 * L'abonnement d'une source d'événements suit l'interrupteur (F3) : allumer le demande à Notifuse et range son secret, couper le retire. Un
 * échec se dit et n'empêche jamais de COUPER au Hub : éteinte au Hub, un événement reçu est acquitté sans effet.
 */
import type { PrismaClient } from '@prisma/client';
import { createHmac } from 'node:crypto';
import { z } from 'zod';

import { resolveAppConfig } from '@/lib/auth/bounce-apps';

import { poserAbonnement } from './abonnement';

const Reponse = z.object({ workspace_id: z.string().min(1).max(512), secret: z.string().regex(/^whsec_[A-Za-z0-9+/=]{24,128}$/).optional() });
type Db = Pick<PrismaClient, 'evenementAbonnement'>;

export async function suivreAbonnement(db: Db, d: { tenantId: string; paire: string; actif: boolean }, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<'sans_objet' | 'fait' | 'echec'> {
  if (d.paire !== 'notifuse>crm') return 'sans_objet';
  try {
    const c = resolveAppConfig('notifuse', env);
    if (!c) return 'echec';
    const body = JSON.stringify({ hub_tenant_id: d.tenantId, actif: d.actif });
    const ts = String(Date.now());
    const res = await fetchImpl(`${c.apiUrl}/api/hub/evenements/abonnement`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Veridian-Timestamp': ts, 'X-Veridian-Hub-Signature': createHmac('sha256', c.hubSecret).update(`${ts}.${body}`).digest('hex') },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return 'echec';
    if (!d.actif) return 'fait';
    const r = Reponse.safeParse(await res.json().catch(() => null));
    if (!r.success || !r.data.secret) return 'echec';
    await poserAbonnement(db, { tenantId: d.tenantId, source: 'notifuse', cleExterne: r.data.workspace_id, secret: r.data.secret }, env);
    return 'fait';
  } catch {
    return 'echec';
  }
}
