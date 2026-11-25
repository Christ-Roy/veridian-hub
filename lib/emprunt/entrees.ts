/**
 * Où un administrateur peut entrer chez un client, app par app (VER-263) : relu chez l'app au moment où on regarde, jamais déduit de ce que le Hub a noté.
 * L'écran et `hub open` lisent la même fonction. Une app où l'entrée échouerait le dit, avec sa raison.
 */
import type { PrismaClient } from '@prisma/client';

import { lienApp } from '@/lib/apps/lien-app';
import { espaceMailVivant, espaceNote } from '@/lib/apps/presence';
import { tousEspaces } from '@/lib/mcp/catalogue';
import { discoverAppForEmail, readAppSecret, readAppUrl } from '@/lib/sync/discovery';
import type { SyncApp, TenantSnapshot } from '@/lib/sync/types';
import { getEnabledGatedApps } from '@/lib/tenant-apps';

export const APPS_ECRAN = ['hub', 'notifuse', 'prospection', 'crm', 'analytics', 'academy'] as const;
export type AppEcran = (typeof APPS_ECRAN)[number];
export const LIBELLES: Record<AppEcran, string> = { hub: 'Hub', notifuse: 'Mail', prospection: 'Prospection', crm: 'CRM', analytics: 'Analytics', academy: 'Academy' };

/** Le chemin à ouvrir une fois la session empruntée posée. `null` : l'app n'est pas branchée dans cet environnement. */
export function entreeDe(app: AppEcran, env: NodeJS.ProcessEnv = process.env): string | null {
  if (app === 'hub') return '/dashboard';
  if (app === 'analytics') return env.ANALYTICS_API_URL ? `/login?next=${encodeURIComponent(`${env.ANALYTICS_API_URL.replace(/\/+$/, '')}/`)}` : null;
  return lienApp(app, env);
}

export type EtatApp = 'ouverte' | 'suspendue' | 'compte_sans_espace' | 'inconnu' | 'non_activee' | 'illisible' | 'non_branchee';
export type Entree = { app: AppEcran; libelle: string; etat: EtatApp; entrable: boolean; detail: string; espaces: { nom: string; organisation: string | null }[] };
export type Org = { id: string; nom: string; role: string; suspendue: boolean };
export type FicheClient = { hubUserId: string; email: string; nom: string | null; adresseProuvee: boolean; organisations: Org[]; apps: Entree[] };

type Deps = { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv };
type TenantLu = { id: string; name: string; notifuseWorkspaceSlug: string | null; prospectionProvisionedAt: Date | null; metadata: unknown };

async function etatDe(db: PrismaClient, app: SyncApp, qui: { hubUserId: string; email: string; prouvee: boolean }, tenants: TenantLu[], noms: Map<string, string>, deps: Deps): Promise<Entree> {
  const base = { app, libelle: LIBELLES[app], espaces: [] as Entree['espaces'] };
  const non = (etat: EtatApp, detail: string): Entree => ({ ...base, etat, entrable: false, detail });
  if (!entreeDe(app, deps.env) || !readAppUrl(app) || !readAppSecret(app)) return non('non_branchee', 'Cette app n\'est pas branchée ici.');
  if (app === 'academy' && !(await getEnabledGatedApps(db, qui.hubUserId)).has('academy')) return non('non_activee', 'Academy n\'est pas activée pour ce compte.');
  const r = await discoverAppForEmail(app, qui.email, { hubUserId: qui.hubUserId, fetchImpl: deps.fetchImpl, timeoutMs: 8_000 });
  if ('error' in r) return non('illisible', 'L\'app n\'a pas répondu : son état est inconnu.');
  if (!r.found) return non('inconnu', 'L\'app ne connaît pas ce compte.');
  let vivants: TenantSnapshot[] = r.snapshots.filter((s) => s.status !== 'deleted');
  // Mail liste encore un espace supprimé : son état se lit sur l'espace lui-même.
  if (app === 'notifuse') {
    const etats = await Promise.all(vivants.map((s) => espaceMailVivant(s.workspaceId, deps)));
    if (vivants.length > 0 && etats.every((e) => e === null)) return non('illisible', 'Mail ne rend pas l\'état de ses espaces.');
    vivants = vivants.filter((_, i) => etats[i] !== false);
  }
  if (vivants.length === 0) return non('compte_sans_espace', 'Le compte existe dans l\'app, sans espace vivant.');
  const espaces = vivants.map((s) => {
    const t = tenants.find((x) => x.id === s.hubTenantLink || espaceNote(x, app) === s.workspaceId);
    return { nom: s.workspaceName ?? s.workspaceId, organisation: t ? (noms.get(t.id) ?? t.name) : null };
  });
  if (vivants.every((s) => s.status === 'suspended')) return { ...base, espaces, etat: 'suspendue', entrable: false, detail: 'Espace suspendu : l\'app refuse l\'entrée.' };
  // Sans adresse prouvée, le Hub ne dit pas `email_proven` : l'app n'ouvre que si elle est déjà reliée à ce compte.
  return { ...base, espaces, etat: 'ouverte', entrable: true, detail: qui.prouvee ? '' : 'Adresse jamais prouvée : l\'app peut refuser si elle n\'est pas déjà reliée.' };
}

export async function ficheClient(db: PrismaClient, hubUserId: string, deps: Deps = {}): Promise<FicheClient | null> {
  const u = await db.user.findFirst({ where: { supabaseUserId: hubUserId }, select: { email: true, name: true, emailVerified: true } });
  if (!u) return null;
  const { vivants, suspendus } = await tousEspaces(db, hubUserId, { par: 'operateur' });
  const ids = [...vivants, ...suspendus].map((e) => e.id);
  const [tenants, orgs] = await Promise.all([
    db.tenant.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, notifuseWorkspaceSlug: true, prospectionProvisionedAt: true, metadata: true } }),
    db.organisation.findMany({ where: { tenantId: { in: ids } }, select: { tenantId: true, nomAffiche: true } }),
  ]);
  const noms = new Map(tenants.map((t) => [t.id, orgs.find((o) => o.tenantId === t.id)?.nomAffiche ?? t.name] as const));
  const org = (suspendue: boolean) => (e: { id: string; nom: string; role: string }): Org => ({ id: e.id, nom: noms.get(e.id) ?? e.nom, role: e.role, suspendue });
  const qui = { hubUserId, email: u.email, prouvee: Boolean(u.emailVerified) };
  const apps = await Promise.all(APPS_ECRAN.filter((a): a is SyncApp & AppEcran => a !== 'hub').map((a) => etatDe(db, a, qui, tenants, noms, deps)));
  const hub: Entree = { app: 'hub', libelle: LIBELLES.hub, etat: 'ouverte', entrable: true, detail: '', espaces: [] };
  return { hubUserId, email: u.email, nom: u.name, adresseProuvee: qui.prouvee, organisations: [...vivants.map(org(false)), ...suspendus.map(org(true))], apps: [hub, ...apps] };
}

export type Trouve = { hubUserId: string; email: string; nom: string | null; organisations: string[] };
export const MAX_TROUVES = 20;

/** Par adresse, nom de personne ou nom d'organisation (ses membres compris). Deux caractères au moins. */
export async function chercherClients(db: Pick<PrismaClient, 'user' | 'tenant' | 'tenantMember' | 'organisation'>, q: string): Promise<{ trouves: Trouve[]; tronque: boolean }> {
  const texte = q.trim().slice(0, 120);
  if (texte.length < 2) return { trouves: [], tronque: false };
  const contient = { contains: texte, mode: 'insensitive' as const };
  const [parPersonne, parTenant, parOrg] = await Promise.all([
    db.user.findMany({ where: { supabaseUserId: { not: null }, OR: [{ email: contient }, { name: contient }] }, select: { supabaseUserId: true }, take: MAX_TROUVES + 1, orderBy: { email: 'asc' } }),
    db.tenant.findMany({ where: { deletedAt: null, OR: [{ name: contient }, { slug: contient }] }, select: { id: true, userId: true }, take: MAX_TROUVES + 1 }),
    db.organisation.findMany({ where: { nomAffiche: contient }, select: { tenantId: true }, take: MAX_TROUVES + 1 }),
  ]);
  const tenantIds = Array.from(new Set([...parTenant.map((t) => t.id), ...parOrg.map((o) => o.tenantId)]));
  const [proprietaires, membres] = await Promise.all([
    db.tenant.findMany({ where: { id: { in: tenantIds }, deletedAt: null }, select: { userId: true } }),
    db.tenantMember.findMany({ where: { tenantId: { in: tenantIds }, deletedAt: null }, select: { userId: true } }),
  ]);
  const tous = Array.from(new Set([...parPersonne.flatMap((u) => (u.supabaseUserId ? [u.supabaseUserId] : [])), ...proprietaires.map((t) => t.userId), ...membres.map((m) => m.userId)]));
  const ids = tous.slice(0, MAX_TROUVES);
  const [users, siens, appart] = await Promise.all([
    db.user.findMany({ where: { supabaseUserId: { in: ids } }, select: { supabaseUserId: true, email: true, name: true }, orderBy: { email: 'asc' } }),
    db.tenant.findMany({ where: { userId: { in: ids }, deletedAt: null }, select: { id: true, userId: true, name: true } }),
    db.tenantMember.findMany({ where: { userId: { in: ids }, deletedAt: null }, select: { tenantId: true, userId: true } }),
  ]);
  const autres = await db.tenant.findMany({ where: { id: { in: appart.map((m) => m.tenantId) }, deletedAt: null }, select: { id: true, name: true } });
  const affiches = await db.organisation.findMany({ where: { tenantId: { in: [...siens, ...autres].map((t) => t.id) } }, select: { tenantId: true, nomAffiche: true } });
  const nom = (t: { id: string; name: string }) => affiches.find((o) => o.tenantId === t.id)?.nomAffiche ?? t.name;
  return {
    tronque: tous.length > ids.length,
    trouves: users.map((u) => ({
      hubUserId: u.supabaseUserId!,
      email: u.email,
      nom: u.name,
      organisations: Array.from(new Set([...siens.filter((t) => t.userId === u.supabaseUserId).map(nom), ...appart.filter((m) => m.userId === u.supabaseUserId).flatMap((m) => autres.filter((t) => t.id === m.tenantId).map(nom))])),
    })),
  };
}
