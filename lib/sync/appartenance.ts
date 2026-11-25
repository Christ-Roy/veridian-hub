/**
 * Appartenance par app et par espace, comparée au Hub (VER-245 a ; nomad-veridian plan/INTEGRATIONS-NATIVES.md §2.7).
 * LECTURE SEULE : rien n'est écrit ici, nulle part. La liste revient à la parente avant toute reprise.
 *
 * Source : les routes que les apps servent déjà. `GET /api/hub/users` donne les humains de l'app, `GET /api/users/by-email` les
 * espaces et le rôle de chacun. Ce que l'app ne sait pas dire est NON ABOUTI, jamais « aucun écart ».
 */
import type { PrismaClient } from '@prisma/client';

import { isPlatformAdmin } from '@/lib/admin/check-admin';
import { discoverAppForEmail, HUB_USER_ID_APPS, readAppSecret, readAppUrl, signGet } from '@/lib/sync/discovery';
import { horsPerimetre } from '@/lib/sync/identity-audit';
import { isTestAccount } from '@/lib/sync/test-residue';
import type { SyncApp, TenantSnapshot } from '@/lib/sync/types';

const DELAI_MS = 8_000;
const DE_FRONT = 6;

/**
 * - `dans_les_deux` : propriétaire du tenant, ou ligne vivante de tenant_members ;
 * - `jonction` : connu du Hub et prouvé, pas encore membre : ce que la reprise ajouterait, rôle plafonné à member ;
 * - `operateur` : compte de Veridian : rôle posé explicitement, dans une liste relue par la parente ;
 * - `adresse_non_prouvee` : connu du Hub, rien de prouvé : attend sa connexion ;
 * - `retire_au_hub` : retiré au Hub, encore dans l'app : à retirer de l'app (rejouer remove-member), JAMAIS à joindre ;
 * - `inconnu` : connu de l'app seulement : pré-inscription sans mail, jamais créé sur la parole de l'app ;
 * - `espace_non_relie` : l'espace n'est relié à aucun tenant vivant du Hub : rien à comparer.
 */
export type Cas = 'dans_les_deux' | 'jonction' | 'operateur' | 'adresse_non_prouvee' | 'retire_au_hub' | 'inconnu' | 'espace_non_relie';

export type Humain = { email: string; hub_user_id?: string | null };
export type HubUser = { supabaseUserId: string | null; email: string; emailVerified: Date | null };
export type HubTenant = { id: string; userId: string; status: string; notifuseWorkspaceSlug: string | null; metadata: unknown };
export type Membre = { tenantId: string; userId: string; deletedAt?: Date | null };

export type Ligne = { email: string; hubUserId: string | null; role: string | null; cas: Cas; raison?: string };
export type EspaceApp = {
  espace: string;
  nom: string | null;
  hubTenantId: string | null;
  /** D'où vient le lien : de l'app, de la fiche du tenant au Hub, des deux, ou deux tenants différents. */
  lien: 'app' | 'hub' | 'les_deux' | 'divergent' | 'aucun';
  tenantSuspendu: boolean;
  membres: Ligne[];
  /** Au Hub (propriétaire ou membre) mais pas dans l'app. */
  absents: string[];
  /** Vrai s'il reste un humain inconnu ou non prouvé : l'appartenance de cet espace est partielle. */
  partielle: boolean;
};
export type RapportApp = {
  app: SyncApp;
  etat: 'ok' | 'non_abouti';
  raison?: string;
  /** Ce que l'app a rendu : toujours `humains` + `exclus`, sinon le relevé n'est pas abouti. */
  rendus: number;
  humains: number;
  /** Écartés du relevé, chacun avec son motif : rien ne l'est en silence (24/11, un compte manquait au CRM sans être dit). */
  exclus: { email: string; motif: string }[];
  /** Humains dont l'app n'a pas rendu les espaces : tout compte de cette app est alors un minimum. */
  nonLus: string[];
  sansEspace: number;
  espaces: EspaceApp[];
  comptes: Record<Cas, number>;
  absents: number;
};

/** Le workspace de cette app tel que le Hub l'a noté sur le tenant. */
function espaceNote(t: HubTenant, app: SyncApp): string | null {
  if (app === 'notifuse') return t.notifuseWorkspaceSlug;
  const m = (t.metadata ?? {}) as Record<string, { workspace_id?: unknown } | undefined>;
  const id = m[app]?.workspace_id;
  return typeof id === 'string' ? id : null;
}

type Lu = { humain: Humain; snapshots: TenantSnapshot[] };

/** Pure : classe ce que l'app a dit par rapport au Hub. */
export function classer(app: SyncApp, lus: Lu[], hub: { users: HubUser[]; tenants: HubTenant[]; membres: Membre[] }): Pick<RapportApp, 'espaces' | 'comptes' | 'absents' | 'sansEspace'> {
  const parId = new Map(hub.users.flatMap((u) => (u.supabaseUserId ? [[u.supabaseUserId, u] as const] : [])));
  const parEmail = new Map(hub.users.map((u) => [u.email.toLowerCase(), u] as const));
  const parTenant = new Map(hub.tenants.map((t) => [t.id, t] as const));
  const notes = new Map(hub.tenants.flatMap((t) => { const e = espaceNote(t, app); return e ? [[e, t] as const] : []; }));
  const appartient = (tenantId: string, userId: string) => parTenant.get(tenantId)?.userId === userId || hub.membres.some((m) => m.tenantId === tenantId && m.userId === userId && !m.deletedAt);
  const retire = (tenantId: string, userId: string) => hub.membres.some((m) => m.tenantId === tenantId && m.userId === userId && m.deletedAt);

  const espaces = new Map<string, EspaceApp & { vus: Set<string> }>();
  const comptes: Record<Cas, number> = { dans_les_deux: 0, jonction: 0, operateur: 0, adresse_non_prouvee: 0, retire_au_hub: 0, inconnu: 0, espace_non_relie: 0 };
  let sansEspace = 0;
  for (const { humain, snapshots } of lus) {
    const vivants = snapshots.filter((s) => s.status !== 'deleted');
    if (vivants.length === 0) sansEspace += 1;
    for (const s of vivants) {
      let e = espaces.get(s.workspaceId);
      if (!e) {
        const deLApp = s.hubTenantLink && parTenant.has(s.hubTenantLink) ? s.hubTenantLink : null;
        const duHub = notes.get(s.workspaceId)?.id ?? null;
        const lien = deLApp && duHub ? (deLApp === duHub ? 'les_deux' : 'divergent') : deLApp ? 'app' : duHub ? 'hub' : 'aucun';
        // Deux liens qui se contredisent ne se tranchent pas ici : l'espace n'est relié à rien.
        const hubTenantId = lien === 'divergent' ? null : (deLApp ?? duHub);
        e = { espace: s.workspaceId, nom: s.workspaceName ?? null, hubTenantId, lien, tenantSuspendu: hubTenantId ? parTenant.get(hubTenantId)!.status !== 'active' : false, membres: [], absents: [], partielle: false, vus: new Set() };
        espaces.set(s.workspaceId, e);
      }
      const email = humain.email.toLowerCase();
      // Le lien posé par le rebond prouve l'identité ; sinon une même adresse, si le Hub l'a prouvée.
      const relie = humain.hub_user_id ? parId.get(humain.hub_user_id) : undefined;
      const homonyme = parEmail.get(email);
      const u = relie ?? (homonyme?.emailVerified ? homonyme : undefined);
      const hubUserId = u?.supabaseUserId ?? null;
      const raison = horsPerimetre(app, email) ?? (isPlatformAdmin({ email: u?.email ?? email }) ? 'opérateur de Veridian' : null);
      let cas: Cas;
      if (!e.hubTenantId) cas = 'espace_non_relie';
      else if (hubUserId && appartient(e.hubTenantId, hubUserId)) cas = 'dans_les_deux';
      else if ((hubUserId ?? homonyme?.supabaseUserId) && retire(e.hubTenantId, (hubUserId ?? homonyme?.supabaseUserId)!)) cas = 'retire_au_hub';
      else if (raison) cas = 'operateur';
      else if (hubUserId) cas = 'jonction';
      else if (homonyme || relie) cas = 'adresse_non_prouvee';
      else cas = 'inconnu';
      comptes[cas] += 1;
      // Vu dans l'app : même non prouvé, il n'est pas « absent » (24/11, deux propriétaires non prouvés comptés deux fois).
      const vu = hubUserId ?? homonyme?.supabaseUserId;
      if (vu) e.vus.add(vu);
      e.membres.push({ email, hubUserId, role: s.role ?? null, cas, ...(raison ? { raison } : {}) });
    }
  }
  let absents = 0;
  const liste = Array.from(espaces.values()).map(({ vus, ...e }) => {
    if (e.hubTenantId) {
      const attendus = [parTenant.get(e.hubTenantId)!.userId, ...hub.membres.filter((m) => m.tenantId === e.hubTenantId && !m.deletedAt).map((m) => m.userId)];
      e.absents = Array.from(new Set(attendus)).filter((id) => !vus.has(id));
      absents += e.absents.length;
    }
    e.partielle = e.membres.some((m) => m.cas === 'inconnu' || m.cas === 'adresse_non_prouvee');
    return e;
  });
  return { espaces: liste.sort((a, b) => b.membres.length - a.membres.length || a.espace.localeCompare(b.espace)), comptes, absents, sansEspace };
}

/** Tous les humains de l'app, reliés ou non, même sans espace. Une raison : pas lu, jamais « aucun ». */
export async function humainsDe(app: SyncApp, fetchImpl: typeof fetch = fetch): Promise<{ humains: Partial<Humain>[] } | { raison: string }> {
  const url = readAppUrl(app);
  const secret = readAppSecret(app);
  if (!url || !secret) return { raison: 'app non configurée au Hub' };
  const { timestamp, signature } = signGet(secret);
  try {
    const res = await fetchImpl(`${url}/api/hub/users`, {
      headers: { 'X-Veridian-Timestamp': timestamp, 'X-Veridian-Hub-Signature': signature },
      signal: AbortSignal.timeout(DELAI_MS),
    });
    if (!res.ok) return { raison: `GET /api/hub/users : HTTP ${res.status}` };
    const corps = (await res.json().catch(() => null)) as { users?: Partial<Humain>[] } | null;
    if (!Array.isArray(corps?.users)) return { raison: 'GET /api/hub/users : liste illisible' };
    return { humains: corps.users };
  } catch {
    return { raison: 'GET /api/hub/users : injoignable' };
  }
}

export type DbAppartenance = Pick<PrismaClient, 'user' | 'tenant' | 'tenantMember'>;

/** Le relevé d'une app. Les comptes de test en sont écartés, et nommés. */
export async function releverAppartenance(db: DbAppartenance, app: SyncApp, fetchImpl: typeof fetch = fetch): Promise<RapportApp> {
  const vide: RapportApp = { app, etat: 'non_abouti', rendus: 0, humains: 0, exclus: [], nonLus: [], sansEspace: 0, espaces: [], comptes: { dans_les_deux: 0, jonction: 0, operateur: 0, adresse_non_prouvee: 0, retire_au_hub: 0, inconnu: 0, espace_non_relie: 0 }, absents: 0 };
  const h = await humainsDe(app, fetchImpl);
  if ('raison' in h) return { ...vide, raison: h.raison };
  const humains: Humain[] = [];
  const exclus: RapportApp['exclus'] = [];
  for (const x of h.humains) {
    if (typeof x?.email !== 'string' || !x.email) exclus.push({ email: '', motif: 'sans adresse' });
    else if (isTestAccount(x.email)) exclus.push({ email: x.email.toLowerCase(), motif: 'compte de test' });
    else humains.push({ email: x.email, hub_user_id: x.hub_user_id });
  }
  const [users, tenants, membres] = await Promise.all([
    db.user.findMany({ select: { supabaseUserId: true, email: true, emailVerified: true } }),
    db.tenant.findMany({ where: { deletedAt: null }, select: { id: true, userId: true, status: true, notifuseWorkspaceSlug: true, metadata: true } }),
    db.tenantMember.findMany({ select: { tenantId: true, userId: true, deletedAt: true } }),
  ]);
  const lus: Lu[] = [];
  const nonLus: string[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: DE_FRONT }, async () => {
      for (let x = humains[i++]; x; x = humains[i++]) {
        const r = await discoverAppForEmail(app, x.email, { timeoutMs: DELAI_MS, fetchImpl, hubUserId: HUB_USER_ID_APPS.includes(app) ? x.hub_user_id : undefined });
        if ('error' in r) nonLus.push(x.email.toLowerCase());
        else lus.push({ humain: x, snapshots: r.found ? r.snapshots : [] });
      }
    }),
  );
  const raisons = [
    ...(nonLus.length ? [`${nonLus.length} humain(s) dont l'app n'a pas rendu les espaces`] : []),
    // Autocontrôle : tout ce que l'app a rendu est relevé, écarté avec un motif, ou dit non lu.
    ...(h.humains.length !== humains.length + exclus.length || humains.length !== lus.length + nonLus.length ? [`compte incohérent : ${h.humains.length} rendus, ${lus.length} relevés, ${nonLus.length} non lus, ${exclus.length} écartés`] : []),
  ];
  return { ...vide, ...classer(app, lus, { users, tenants, membres }), rendus: h.humains.length, humains: humains.length, exclus, nonLus, etat: raisons.length ? 'non_abouti' : 'ok', ...(raisons.length ? { raison: raisons.join(' ; ') } : {}) };
}
