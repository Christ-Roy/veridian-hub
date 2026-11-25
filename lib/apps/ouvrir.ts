/**
 * Ouvrir une organisation dans ses apps d'un seul geste d'opérateur, et RELIRE chaque app avant de dire quoi que ce soit (Robert, 25/11). Rejouable : un espace
 * qui existe n'est pas recréé. `attente` : il manque un geste de la personne, nommé ; jamais un espace inventé pour elle.
 */
import type { PrismaClient } from '@prisma/client';

import { ensureAcademyWorkspace } from '@/lib/academy/provision';
import { ensureCrmWorkspace } from '@/lib/crm/provision';
import type { SyncApp } from '@/lib/sync/types';
import { provisionNotifuseTenant, provisionProspectionTenant } from '@/utils/tenants/provision';

import { espaceNote, presenteDans } from './presence';

export type Ouverture = { app: SyncApp; etat: 'ouverte' | 'attente' | 'echec'; detail?: string };
export type Verdict = 'complet' | 'en_partie' | 'non_abouti';
type Deps = { fetchImpl?: typeof fetch; acteur?: string };

/** Un échec l'emporte ; puis l'attente ; puis le complet. Rien d'ouvert du tout n'est jamais « complet ». */
export function verdict(l: readonly Ouverture[]): Verdict {
  if (l.length === 0 || l.some((x) => x.etat === 'echec')) return 'non_abouti';
  return l.some((x) => x.etat === 'attente') ? 'en_partie' : 'complet';
}

export async function ouvrirApps(db: PrismaClient, tenantId: string, apps: readonly SyncApp[], deps: Deps = {}): Promise<{ apps: Ouverture[]; verdict: Verdict } | null> {
  const champs = { id: true, userId: true, notifuseWorkspaceSlug: true, prospectionProvisionedAt: true, metadata: true } as const;
  const lire = () => db.tenant.findFirst({ where: { id: tenantId, deletedAt: null, status: 'active' }, select: champs });
  const avant = await lire();
  const u = avant ? await db.user.findFirst({ where: { supabaseUserId: avant.userId }, select: { email: true, name: true, emailVerified: true, supabaseUserId: true } }) : null;
  if (!avant || !u?.supabaseUserId) return null;
  const hubUserId = u.supabaseUserId;
  const qui = { hubUserId, email: u.email, name: u.name };
  const creer: Record<SyncApp, () => Promise<{ ok: boolean; attente?: string; error?: string }>> = {
    notifuse: async () => { const r = await provisionNotifuseTenant(u.email, hubUserId); return { ok: r.success, error: r.error }; },
    prospection: async () => { const r = await provisionProspectionTenant(u.email, hubUserId); return { ok: r.success, error: r.error }; },
    crm: async () => (u.emailVerified ? await ensureCrmWorkspace(db, qui, { actorEmail: deps.acteur }) : { ok: false, attente: 'adresse à prouver : sa première connexion' }) as never,
    academy: async () => (u.emailVerified ? await ensureAcademyWorkspace(db, qui, { actorEmail: deps.acteur }) : { ok: false, attente: 'adresse à prouver : sa première connexion' }) as never,
    analytics: async () => ({ ok: false, attente: 'site à créer dans Analytics (skill rybbit)' }),
  };
  const res: Ouverture[] = [];
  // Une app après l'autre : deux créations en même temps se disputent le même tenant.
  for (const app of apps) {
    try {
      if (!espaceNote(avant, app)) {
        const r = await creer[app]();
        if (!r.ok) { res.push({ app, etat: r.attente ? 'attente' : 'echec', detail: r.attente ?? r.error ?? 'refus sans raison' }); continue; }
      }
      const t = await lire();
      const p = t && espaceNote(t, app) ? await presenteDans(app, t, { email: u.email, hubUserId }, deps) : false;
      if (p) res.push({ app, etat: 'ouverte' });
      // Une app peut ne relier le propriétaire qu'à sa première entrée prouvée : l'espace est là, pas encore lui.
      else if (p === false && !u.emailVerified) res.push({ app, etat: 'attente', detail: 'espace créé ; il y sera relié à sa première connexion' });
      else res.push({ app, etat: 'echec', detail: p === null ? 'relecture impossible' : 'créé d\'après nous, mais l\'app ne l\'y voit pas' });
    } catch (err) {
      res.push({ app, etat: 'echec', detail: err instanceof Error ? err.message.slice(0, 160) : 'erreur' });
    }
  }
  return { apps: res, verdict: verdict(res) };
}
