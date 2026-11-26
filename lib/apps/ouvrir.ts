/**
 * Ouvrir une organisation dans ses apps d'un seul geste d'opérateur, et RELIRE chaque app avant de dire quoi que ce soit (Robert, 25/11). Rejouable : un espace
 * qui existe n'est pas recréé. `attente` : il manque un geste de la personne, nommé ; jamais un espace inventé pour elle.
 */
import type { PrismaClient } from '@prisma/client';

import { ensureAcademyWorkspace } from '@/lib/academy/provision';
import { provisionnerAnalytics } from '@/lib/analytics/provision';
import { ensureCrmWorkspace } from '@/lib/crm/provision';
import type { SyncApp } from '@/lib/sync/types';
import { PAR_CLE } from '@/lib/auth/emprunt-bornes';
import { abonnerParDefaut } from '@/lib/evenements/naissance';
import { designerAdminsPlateforme, type Designation } from './admins-plateforme';
import { provisionNotifuseTenant, provisionProspectionTenant } from '@/utils/tenants/provision';

import { espaceMailVivant, espaceNote, presenteDans } from './presence';

export type Ouverture = { app: SyncApp; etat: 'ouverte' | 'attente' | 'echec'; detail?: string };
export type Verdict = 'complet' | 'en_partie' | 'non_abouti';
type Deps = { fetchImpl?: typeof fetch; acteur?: string; auteur?: string };

/** Un échec l'emporte ; puis l'attente ; puis le complet. Rien d'ouvert du tout n'est jamais « complet ». */
export function verdict(l: readonly Ouverture[]): Verdict {
  if (l.length === 0 || l.some((x) => x.etat === 'echec')) return 'non_abouti';
  return l.some((x) => x.etat === 'attente') ? 'en_partie' : 'complet';
}

export async function ouvrirApps(db: PrismaClient, tenantId: string, apps: readonly SyncApp[], deps: Deps = {}): Promise<{ apps: Ouverture[]; verdict: Verdict; admins: Designation[] } | null> {
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
    // Dès le provisionnement (parente 26/11) : Analytics crée la personne et son organisation, reliée ; route absente = attente nommée.
    analytics: async () => {
      if (!u.emailVerified) return { ok: false, attente: 'adresse à prouver : sa première connexion' };
      const r = await provisionnerAnalytics(db, qui, tenantId);
      return r.ok ? { ok: true } : { ok: false, attente: r.attente, error: r.error };
    },
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
      // Personne à voir encore dans l'espace ? L'espace, lui, doit vivre : un espace supprimé n'est pas « en attente de sa première connexion ».
      const vivant = p === false && app === 'notifuse' && t?.notifuseWorkspaceSlug ? await espaceMailVivant(t.notifuseWorkspaceSlug, deps) : true;
      if (p) res.push({ app, etat: 'ouverte' });
      else if (vivant !== true) res.push({ app, etat: 'echec', detail: vivant === false ? 'espace supprimé ou suspendu chez Mail' : 'relecture impossible' });
      // Une app peut ne relier le propriétaire qu'à sa première entrée prouvée : l'espace est là, pas encore lui.
      else if (p === false && !u.emailVerified) res.push({ app, etat: 'attente', detail: 'espace créé ; il y sera relié à sa première connexion' });
      else res.push({ app, etat: 'echec', detail: p === null ? 'relecture impossible' : 'créé d\'après nous, mais l\'app ne l\'y voit pas' });
    } catch (err) {
      res.push({ app, etat: 'echec', detail: err instanceof Error ? err.message.slice(0, 160) : 'erreur' });
    }
  }
  // Mail ouvert : les administrateurs de plateforme y sont posés ADMIN, jamais propriétaires (§5.23). Un échec se dit, il ne défait pas l'ouverture.
  const admins = res.some((x) => x.app === 'notifuse' && x.etat !== 'echec')
    ? ((await designerAdminsPlateforme(db, tenantId, { fetchImpl: deps.fetchImpl, acteur: deps.auteur ?? PAR_CLE, raison: 'ouverture du client' }).catch(() => null)) ?? [])
    : [];
  // Mail et CRM ouverts : l'événement « Mail vers CRM » actif par défaut a besoin de son abonnement chez Mail. Rejouable (une organisation déjà
  // abonnée ou réglée n'est pas touchée) ; ré-ouvrir rattrape une organisation née avant l'ouverture de l'événement (26/11 : ff6eaeff, réponses
  // de Mail refusées 401 faute d'abonnement au Hub). Ne fait jamais échouer l'ouverture.
  if (res.some((x) => x.app === 'notifuse' && x.etat !== 'echec')) await abonnerParDefaut(db, tenantId).catch(() => undefined);
  return { apps: res, verdict: verdict(res), admins };
}
