/**
 * Appartenance à un tenant : le SEUL écrivain de `tenant_members` et de la suspension (VER-245 a, CONTRAT-HUB §5.18 à §5.20).
 * Le Hub dit qui appartient à quoi ; chaque app en garde une copie, que l'on relit après l'avoir changée.
 *
 * Un retrait coupe d'abord au Hub (la porte MCP et tout jeton suivant refusent aussitôt), puis chez chaque app, et RELIT l'app :
 * « retiré » veut dire relu absent. Une app qui ne sait pas retirer, ou qui échoue, est dite ; rejouer le retrait est sans effet de bord.
 */
import { createHmac } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { resolveAppConfig } from '@/lib/auth/bounce-apps';
import { humainsDe } from '@/lib/sync/appartenance';
import { configuredSyncApps, discoverAppForEmail } from '@/lib/sync/discovery';
import { suivreOrganisation } from '@/lib/organisations/emission';
import { couperIntegrations } from '@/lib/delegation/interrupteur';
import { revoquerPoignees } from '@/lib/delegation/poignee';
import type { SyncApp, TenantSnapshot } from '@/lib/sync/types';

const DELAI_MS = 15_000;
export const ROLES = ['member', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];
export type Origine = 'invitation' | 'reprise' | 'operateur' | 'preinscription' | 'federation';

export type DbMembres = Pick<PrismaClient, 'organisationAcces' | 'tenant' | 'tenantMember' | 'user' | 'auditLog' | 'crossAppInvitation' | 'delegationGrant' | 'integrationPaire' | 'tenantPreinscription' | 'userEmail'>;
type Deps = { fetchImpl?: typeof fetch; apps?: readonly SyncApp[]; env?: NodeJS.ProcessEnv };

/** Ce que l'auteur du geste doit lire : les apps où l'accès n'est PAS coupé, et pourquoi (Analytics ne sait pas retirer). */
export function nonCoupees(apps: IssueApp[]): string | null {
  const l = apps.filter((a) => a.etat === 'non_gere' || a.etat === 'echec');
  return l.length ? `PAS coupé : ${l.map((a) => `${a.app} (${a.detail ?? a.etat})`).join(', ')}. Rejouer est sans effet de bord.` : null;
}

/**
 * Les clés API qui survivent au retrait (la parente, 24/11) : on ne les coupe pas, des automatisations en vivent, mais l'auteur du geste
 * lit combien restent actives, app par app, et où les renouveler. Une app qui ne compte pas est dite « non comptées », jamais tue.
 */
export function avisCles(apps: IssueApp[]): string | null {
  const l = apps.filter((a) => a.etat === 'retire' || a.etat === 'non_gere').filter((a) => a.cles?.actives !== 0);
  if (l.length === 0) return null;
  const dire = (a: IssueApp) => `${a.app} ${a.cles ? `${a.cles.actives}${a.cles.par === 'personne' ? ' créée(s) par cette personne' : ''}` : 'non comptées'}${a.cles?.url ? ` (${a.cles.url})` : ''}`;
  return `Clés API encore actives après le retrait, à renouveler dans l'app si la personne les connaît : ${l.map(dire).join(', ')}.`;
}

/** Ce qu'une app dit de ses clés en réponse à remove-member. `active_api_keys` : tout l'espace. Un lien n'est gardé que chez nous. */
function lireCles(j: unknown): IssueApp['cles'] {
  const r = (j ?? {}) as { active_api_keys?: unknown; active_api_keys_created_by_member?: unknown; api_keys_url?: unknown };
  const nombre = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
  const espace = nombre(r.active_api_keys);
  const actives = espace ?? nombre(r.active_api_keys_created_by_member);
  if (actives === null) return undefined;
  const url = typeof r.api_keys_url === 'string' && /^https:\/\/[a-z0-9.-]+\.veridian\.site\/[\w./?=&%#-]*$/.test(r.api_keys_url) ? r.api_keys_url : undefined;
  return { actives, par: espace !== null ? 'espace' : 'personne', ...(url ? { url } : {}) };
}

export class RefusMembre extends Error {
  constructor(readonly code: 'tenant_introuvable' | 'tenant_suspendu' | 'compte_introuvable' | 'adresse_non_prouvee' | 'role_refuse' | 'proprietaire' | 'pas_membre' | 'retire') {
    super(code);
  }
}

/** Routes par app (lues dans leur code le 24/11). Absent : l'app ne sait pas le faire, et c'est dit. */
const RETRAIT: Partial<Record<SyncApp, true>> = { notifuse: true, prospection: true, crm: true, academy: true };
const SUSPENSION: Partial<Record<SyncApp, true>> = { notifuse: true, prospection: true, academy: true, crm: true };
/** Ce qu'un refus veut dire, en clair ; un code inconnu est rendu tel quel, jamais avalé. */
const DIT: Record<string, string> = {
  not_suspended_by_hub: 'fermé par un autre chemin que le Hub : pas repris, à rouvrir dans l\'app',
  workspace_not_active: 'espace en cours de création : pas suspendu, rejouer',
};

async function tenantVivant(db: DbMembres, id: string) {
  const t = await db.tenant.findFirst({ where: { id, deletedAt: null }, select: { id: true, userId: true, status: true, notifuseWorkspaceSlug: true, metadata: true } });
  if (!t) throw new RefusMembre('tenant_introuvable');
  return t;
}
type Tenant = Awaited<ReturnType<typeof tenantVivant>>;

/**
 * Ajoute (ou rétablit) un membre. Une invitation ou une reprise donne `member`, jamais plus : seul un opérateur pose un autre
 * rôle. Un membre déjà là garde le sien. L'adresse est prouvée, ou rien n'est écrit.
 */
export async function rejoindre(db: DbMembres, d: { tenantId: string; hubUserId: string; role?: Role; origine: Origine; acteur: string; emiseLe?: Date }): Promise<{ cree: boolean; role: string }> {
  const t = await tenantVivant(db, d.tenantId);
  if (t.status === 'suspended') throw new RefusMembre('tenant_suspendu');
  const u = await db.user.findFirst({ where: { supabaseUserId: d.hubUserId }, select: { emailVerified: true } });
  if (!u) throw new RefusMembre('compte_introuvable');
  if (!u.emailVerified) throw new RefusMembre('adresse_non_prouvee');
  if (t.userId === d.hubUserId) return { cree: false, role: 'owner' };
  const role = d.role ?? 'member';
  if (!ROLES.includes(role) || (role !== 'member' && d.origine !== 'operateur')) throw new RefusMembre('role_refuse');
  const cle = { tenantId_userId: { tenantId: d.tenantId, userId: d.hubUserId } };
  const avant = await db.tenantMember.findUnique({ where: cle });
  if (avant && !avant.deletedAt && (d.origine !== 'operateur' || avant.role === role)) return { cree: false, role: avant.role };
  // Un membre retiré ne revient ni par une reprise, ni par une invitation d'avant son retrait : seulement par un geste neuf.
  if (avant?.deletedAt && (d.origine === 'reprise' || d.origine === 'federation' || ((d.origine === 'invitation' || d.origine === 'preinscription') && !(d.emiseLe && d.emiseLe > avant.deletedAt)))) throw new RefusMembre('retire');
  await db.tenantMember.upsert({
    where: cle,
    create: { tenantId: d.tenantId, userId: d.hubUserId, role, origine: d.origine, ajoutePar: d.acteur, roleLe: new Date() },
    update: { role, deletedAt: null, origine: d.origine, ajoutePar: d.acteur, roleLe: new Date() },
  });
  await writeAuditLog(db as PrismaClient, { action: 'membre.ajoute', actor: d.acteur, targetType: 'tenant', targetId: d.tenantId, payload: { hub_user_id: d.hubUserId, role, origine: d.origine } });
  return { cree: true, role };
}

export type IssueApp = { app: SyncApp; etat: 'retire' | 'suspendu' | 'repris' | 'absent' | 'non_gere' | 'echec'; detail?: string; /** Clés API restées actives, quand l'app les compte. */ cles?: { actives: number; par: 'espace' | 'personne'; url?: string } };

async function signer(app: SyncApp, methode: string, chemin: string, corps: Record<string, unknown>, deps: Deps): Promise<Response> {
  const config = resolveAppConfig(app, deps.env ?? process.env);
  if (!config) throw new Error(`${app}_not_configured`);
  const body = JSON.stringify(corps);
  const ts = String(Date.now());
  return (deps.fetchImpl ?? fetch)(`${config.apiUrl}${chemin}`, {
    method: methode,
    headers: { 'Content-Type': 'application/json', 'X-Veridian-Timestamp': ts, 'X-Veridian-Hub-Signature': createHmac('sha256', config.hubSecret).update(`${ts}.${body}`).digest('hex') },
    body,
    signal: AbortSignal.timeout(DELAI_MS),
  });
}

function espaceNote(t: Tenant, app: SyncApp): string | null {
  if (app === 'notifuse') return t.notifuseWorkspaceSlug;
  const id = ((t.metadata ?? {}) as Record<string, { workspace_id?: unknown } | undefined>)[app]?.workspace_id;
  return typeof id === 'string' ? id : null;
}

/** Les espaces de ce tenant où l'app voit cette adresse. `null` : l'app ne l'a pas dit. */
/** `hubUserId` null : par l'adresse seule, pour voir un compte sans lien. Jamais pour choisir une PERSONNE à toucher. */
async function espacesChez(app: SyncApp, t: Tenant, email: string, hubUserId: string | null, deps: Deps): Promise<TenantSnapshot[] | null> {
  const r = await discoverAppForEmail(app, email, { timeoutMs: DELAI_MS, fetchImpl: deps.fetchImpl, ...(hubUserId ? { hubUserId } : {}) });
  if ('error' in r) return null;
  if (!r.found) return [];
  const note = espaceNote(t, app);
  return r.snapshots.filter((s) => s.status !== 'deleted' && (s.hubTenantLink === t.id || (note !== null && s.workspaceId === note)));
}

/** L'identifiant que l'app attend dans son chemin : son espace, son tenant, ou le tenant Hub. */
const cible = (app: SyncApp, t: Tenant, s: TenantSnapshot): string => (app === 'crm' || app === 'academy' ? t.id : app === 'prospection' ? (s.tenantId ?? s.workspaceId) : s.workspaceId);

/** Décocher une app réservée (lib/organisations/decocher.ts) : le même retrait, d'une seule app ; l'appartenance au Hub ne bouge pas. */
export const retirerDeLApp = (app: SyncApp, t: Tenant, email: string, hubUserId: string, deps: Deps = {}): Promise<IssueApp> => retirerChez(app, t, email, hubUserId, 'admin_action', deps);

/**
 * Une app sans route (Analytics) : « absent » ne se dit que si AUCUNE de ces personnes n'y a de compte. Ses espaces ne sont reliés à aucun tenant, donc
 * chercher celui-ci répondait « absent » à quelqu'un qui y entrait encore (25/11). Par l'identifiant ou l'adresse : on ne touche à rien, on avertit.
 */
async function sansRoute(app: SyncApp, gens: { email: string; hubUserId: string }[], quoi: string, deps: Deps): Promise<IssueApp> {
  const h = await humainsDe(app, deps.fetchImpl);
  if ('raison' in h) return { app, etat: 'echec', detail: `non vérifié : ${h.raison}` };
  const ids = new Set(gens.map((g) => g.hubUserId));
  const adresses = new Set(gens.map((g) => g.email.trim().toLowerCase()));
  const n = h.humains.filter((x) => (x?.hub_user_id && ids.has(x.hub_user_id)) || (typeof x?.email === 'string' && adresses.has(x.email.trim().toLowerCase()))).length;
  return n === 0 ? { app, etat: 'absent' } : { app, etat: 'non_gere', detail: `NON FERMÉ, aucune route de ${quoi} dans cette app ; ${n} compte${n > 1 ? 's' : ''} y ${n > 1 ? 'restent' : 'reste'}, à fermer dans l'app` };
}

async function retirerChez(app: SyncApp, t: Tenant, email: string, hubUserId: string, motif: string, deps: Deps): Promise<IssueApp> {
  if (!RETRAIT[app]) return sansRoute(app, [{ email, hubUserId }], 'retrait', deps);
  try {
    const espaces = await espacesChez(app, t, email, hubUserId, deps);
    if (espaces === null) return { app, etat: 'echec', detail: 'l\'app ne dit pas où est ce compte' };
    const notees = t.status === 'suspended' ? (ciblesNotees(t)[app] ?? []) : [];
    if (espaces.length === 0 && notees.length) {
      // Espace suspendu, que l'app cache : on retire quand même, et on dit que rien n'a pu être relu.
      for (const c of notees) {
        const res = await signer(app, 'POST', `/api/tenants/${encodeURIComponent(c)}/remove-member`, { user_email: email, email, hub_user_id: hubUserId, reason: motif }, deps);
        if (!res.ok && res.status !== 404) return { app, etat: 'echec', detail: `http_${res.status}` };
      }
      return { app, etat: 'echec', detail: 'retrait envoyé, pas relu : espace suspendu, rejouer après la reprise' };
    }
    // Une app qui lit `hub_user_id` ne voit pas un compte sans lien : « absent » serait faux tant qu'il y entre encore.
    if (espaces.length === 0) {
      const sansLien = await espacesChez(app, t, email, null, deps);
      if (sansLien === null) return { app, etat: 'echec', detail: 'l\'app ne dit pas où est ce compte' };
      return sansLien.length === 0 ? { app, etat: 'absent' } : { app, etat: 'echec', detail: 'un compte de cette adresse, sans lien avec le Hub, y est encore : à retirer dans l\'app' };
    }
    let cles: IssueApp['cles'];
    for (const s of espaces) {
      const res = await signer(app, 'POST', `/api/tenants/${encodeURIComponent(cible(app, t, s))}/remove-member`, { user_email: email, email, hub_user_id: hubUserId, reason: motif }, deps);
      if (!res.ok && res.status !== 404) return { app, etat: 'echec', detail: `http_${res.status}` };
      const lues = lireCles(await res.json().catch(() => null));
      if (lues) cles = cles ? { ...lues, actives: cles.actives + lues.actives } : lues;
    }
    const apres = await espacesChez(app, t, email, hubUserId, deps);
    if (apres === null) return { app, etat: 'echec', detail: 'retiré, mais pas relu' };
    return apres.length === 0 ? { app, etat: 'retire', ...(cles ? { cles } : {}) } : { app, etat: 'echec', detail: 'l\'app le voit encore après le retrait' };
  } catch (err) {
    return { app, etat: 'echec', detail: err instanceof Error ? err.message.slice(0, 160) : 'erreur' };
  }
}

/** Fait expirer les invitations en attente de cette adresse vers les espaces de ce tenant. Rend combien. */
async function fermerInvitations(db: DbMembres, t: Tenant, email: string, deps: Deps): Promise<number> {
  const attente = await db.crossAppInvitation.findMany({ where: { inviteeEmail: { equals: email, mode: 'insensitive' }, acceptedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, targetApp: true, targetWorkspaceId: true } });
  if (attente.length === 0) return 0;
  const proprietaire = await db.user.findFirst({ where: { supabaseUserId: t.userId }, select: { email: true } });
  const ids: string[] = [];
  for (const i of attente) {
    const app = i.targetApp as SyncApp;
    const espaces = espaceNote(t, app) === i.targetWorkspaceId ? null : proprietaire ? await espacesChez(app, t, proprietaire.email, t.userId, deps).catch(() => null) : [];
    // Dans le doute (espace noté, ou app muette), l'invitation se ferme : une nouvelle coûte un clic.
    if (espaces === null || espaces.some((s) => s.workspaceId === i.targetWorkspaceId)) ids.push(i.id);
  }
  if (ids.length) await db.crossAppInvitation.updateMany({ where: { id: { in: ids }, acceptedAt: null }, data: { expiresAt: new Date() } });
  return ids.length;
}

/** Retire un membre. Rejouable : déjà retiré au Hub, il est quand même retiré des apps où il resterait. Jamais le propriétaire. */
export async function retirer(db: DbMembres, d: { tenantId: string; hubUserId: string; acteur: string; motif?: 'admin_action' | 'user_request' }, deps: Deps = {}): Promise<{ deja: boolean; apps: IssueApp[]; complet: boolean; avis: string | null }> {
  const t = await tenantVivant(db, d.tenantId);
  if (t.userId === d.hubUserId) throw new RefusMembre('proprietaire');
  const cle = { tenantId_userId: { tenantId: d.tenantId, userId: d.hubUserId } };
  const ligne = await db.tenantMember.findUnique({ where: cle });
  const u = await db.user.findFirst({ where: { supabaseUserId: d.hubUserId }, select: { email: true } });
  if (!u) throw new RefusMembre('compte_introuvable');
  const deja = !ligne || ligne.deletedAt !== null;
  if (!deja) await db.tenantMember.update({ where: cle, data: { deletedAt: new Date() } });
  // Ses poignées dans ce tenant meurent : tout échange suivant est refusé, un jeton déjà émis dure 120 s au plus.
  await revoquerPoignees(db, { hubUserId: d.hubUserId, tenantId: d.tenantId });
  // Une invitation encore ouverte le ferait revenir chez l'app : elle expire avant tout le reste.
  const invitations = await fermerInvitations(db, t, u.email, deps);
  // Une pré-inscription encore ouverte le ferait revenir au prochain passage.
  const secondaires = await db.userEmail.findMany({ where: { user: { supabaseUserId: d.hubUserId }, detacheeLe: null }, select: { email: true } });
  await db.tenantPreinscription.updateMany({ where: { tenantId: d.tenantId, email: { in: [u.email.trim().toLowerCase(), ...secondaires.map((x) => x.email)] }, consommeeLe: null, annuleeLe: null }, data: { annuleeLe: new Date() } });
  const apps = await Promise.all((deps.apps ?? configuredSyncApps()).map((app) => retirerChez(app, t, u.email, d.hubUserId, d.motif ?? 'admin_action', deps)));
  // Un compte dans une app sans route ne fait pas un membre.
  if (!ligne && apps.every((a) => a.etat === 'absent' || a.etat === 'non_gere')) throw new RefusMembre('pas_membre');
  const complet = apps.every((a) => a.etat === 'retire' || a.etat === 'absent');
  await writeAuditLog(db as PrismaClient, { action: 'membre.retire', actor: d.acteur, targetType: 'tenant', targetId: d.tenantId, payload: { hub_user_id: d.hubUserId, deja, complet, apps, invitations } });
  return { deja, apps, complet, avis: [nonCoupees(apps), avisCles(apps)].filter(Boolean).join(' ') || null };
}

/** Les cibles suspendues, notées sur le tenant : une app peut cacher l'espace qu'on vient de suspendre (Prospection, 24/11). */
function ciblesNotees(t: Tenant): Partial<Record<SyncApp, string[]>> {
  const n = ((t.metadata ?? {}) as { hub_suspension?: { cibles?: Partial<Record<SyncApp, string[]>> } }).hub_suspension?.cibles;
  return n && typeof n === 'object' ? n : {};
}

async function basculerChez(app: SyncApp, t: Tenant, proprietaire: { email: string }, gens: { email: string; hubUserId: string }[], suspendre: boolean, deps: Deps): Promise<{ issue: IssueApp; cibles: string[] }> {
  // Rien n'y a été fermé : rien à y rouvrir.
  if (!SUSPENSION[app]) return { issue: suspendre ? await sansRoute(app, gens, 'suspension', deps) : { app, etat: 'absent' }, cibles: [] };
  const notees = ciblesNotees(t)[app] ?? [];
  try {
    // La suspension vise un ESPACE de ce tenant : un propriétaire sans lien dans l'app n'empêche pas de le fermer.
    const parLien = await espacesChez(app, t, proprietaire.email, t.userId, deps);
    const espaces = parLien?.length === 0 ? await espacesChez(app, t, proprietaire.email, null, deps) : parLien;
    if (espaces === null && notees.length === 0) return { issue: { app, etat: 'echec', detail: 'l\'app ne dit pas quel espace est relié' }, cibles: notees };
    const cibles = Array.from(new Set([...notees, ...(espaces ?? []).map((s) => cible(app, t, s))]));
    if (cibles.length === 0) return { issue: { app, etat: 'absent' }, cibles: [] };
    const rate: string[] = [];
    const restent: string[] = [];
    for (const c of cibles) {
      const res = await signer(app, 'POST', `/api/tenants/${suspendre ? 'suspend' : 'resume'}`, { tenant_id: c, ...(suspendre ? { reason: 'admin_action' } : {}) }, deps);
      if (res.ok) {
        if (suspendre) restent.push(c);
        continue;
      }
      const brut = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error;
      const code = typeof brut === 'string' && /^[a-z_]{3,40}$/.test(brut) ? brut : null;
      // L'espace n'existe plus : rien à fermer, rien à rouvrir.
      if (res.status === 410) continue;
      rate.push(code ? `${DIT[code] ?? code} (${code}, http_${res.status})` : `http_${res.status}`);
      // Ce que le Hub n'a pas suspendu, il n'a pas à le reprendre au prochain rejeu.
      if (code !== 'not_suspended_by_hub') restent.push(c);
    }
    if (rate.length) return { issue: { app, etat: 'echec', detail: rate.join(', ') }, cibles: restent };
    return { issue: { app, etat: suspendre ? 'suspendu' : 'repris' }, cibles: restent };
  } catch (err) {
    return { issue: { app, etat: 'echec', detail: err instanceof Error ? err.message.slice(0, 160) : 'erreur' }, cibles: notees };
  }
}

/**
 * Suspend ou reprend une organisation : au Hub d'abord (la porte MCP refuse aussitôt), puis chez les apps qui savent le faire.
 * La reprise vise ce que la suspension a noté, jamais seulement ce que l'app veut bien montrer.
 */
export async function basculerSuspension(db: DbMembres, d: { tenantId: string; suspendre: boolean; acteur: string; motif?: string }, deps: Deps = {}): Promise<{ deja: boolean; apps: IssueApp[]; complet: boolean; avis: string | null }> {
  const t = await tenantVivant(db, d.tenantId);
  const proprietaire = await db.user.findFirst({ where: { supabaseUserId: t.userId }, select: { email: true } });
  if (!proprietaire) throw new RefusMembre('compte_introuvable');
  const voulu = d.suspendre ? 'suspended' : 'active';
  const deja = t.status === voulu;
  if (!deja) await db.tenant.update({ where: { id: t.id }, data: { status: voulu } });
  // Suspendue : poignées mortes et consentements retirés. La reprise ne rallume aucune liaison toute seule.
  if (d.suspendre) {
    await revoquerPoignees(db, { tenantId: t.id });
    await couperIntegrations(db, t.id);
  }
  const liste = deps.apps ?? configuredSyncApps();
  const lignes = d.suspendre ? await db.tenantMember.findMany({ where: { tenantId: t.id, deletedAt: null }, select: { userId: true } }) : [];
  const membres = lignes.length ? await db.user.findMany({ where: { supabaseUserId: { in: lignes.map((l) => l.userId) } }, select: { email: true, supabaseUserId: true } }) : [];
  const gens = [{ email: proprietaire.email, hubUserId: t.userId }, ...membres.flatMap((m) => (m.supabaseUserId ? [{ email: m.email, hubUserId: m.supabaseUserId }] : []))];
  const res = await Promise.all(liste.map((app) => basculerChez(app, t, proprietaire, gens, d.suspendre, deps)));
  const cibles = { ...ciblesNotees(t) };
  res.forEach((r, i) => { if (r.cibles.length) cibles[liste[i]] = r.cibles; else delete cibles[liste[i]]; });
  const { hub_suspension: _avant, ...reste } = (t.metadata ?? {}) as Record<string, unknown>;
  const metadata = Object.keys(cibles).length ? { ...reste, hub_suspension: { cibles } } : reste;
  await db.tenant.update({ where: { id: t.id }, data: { metadata: metadata as never } });
  const apps = res.map((r) => r.issue);
  // Ce qu'une app suspendue a refusé d'appliquer (423, la version n'avance pas chez elle) repart à la reprise.
  if (!d.suspendre) await suivreOrganisation(db as unknown as PrismaClient, t.id, deps);
  const complet = apps.every((a) => a.etat === 'suspendu' || a.etat === 'repris' || a.etat === 'absent');
  await writeAuditLog(db as PrismaClient, { action: d.suspendre ? 'tenant.suspendu' : 'tenant.repris', actor: d.acteur, targetType: 'tenant', targetId: t.id, payload: { deja, complet, apps, motif: d.motif ?? null } });
  return { deja, apps, complet, avis: nonCoupees(apps) };
}

/**
 * À la suppression d'un compte : ses appartenances, et ses invitations. Celles qu'il a envoyées bloquaient la suppression (clé
 * étrangère, 24/11), celles qu'il a reçues gardaient son adresse.
 */
export async function oublierCompte(db: Pick<PrismaClient, 'tenantMember' | 'crossAppInvitation' | 'tenantPreinscription' | 'tenantIdp'> & Partial<Pick<PrismaClient, 'organisationAcces'>>, u: { id: string; email: string; hubUserId: string | null; tenants?: string[] }): Promise<{ membres: number; invitations: number }> {
  const m = u.hubUserId ? await db.tenantMember.deleteMany({ where: { userId: u.hubUserId } }) : { count: 0 };
  // Son adresse pré-inscrite ailleurs, et les adresses que ses organisations avaient pré-inscrites.
  await db.organisationAcces?.deleteMany({ where: { OR: [...(u.hubUserId ? [{ hubUserId: u.hubUserId }] : []), { tenantId: { in: u.tenants ?? [] } }] } });
  await db.tenantPreinscription.deleteMany({ where: { OR: [{ email: u.email.trim().toLowerCase() }, { tenantId: { in: u.tenants ?? [] } }] } });
  await db.tenantIdp.deleteMany({ where: { tenantId: { in: u.tenants ?? [] } } });
  await db.crossAppInvitation.updateMany({ where: { acceptedByUserId: u.id }, data: { acceptedByUserId: null } });
  const i = await db.crossAppInvitation.deleteMany({ where: { OR: [{ inviterUserId: u.id }, { inviteeEmail: { equals: u.email, mode: 'insensitive' } }] } });
  return { membres: m.count, invitations: i.count };
}
