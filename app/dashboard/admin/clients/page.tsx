/** Entrer chez un client (VER-263) : le chercher, voir l'état réel de ses apps, y entrer. Le layout garde l'administration. */
import Link from 'next/link';
import { UserSearch } from 'lucide-react';

import { DashboardPageHeader } from '@/components/dashboard/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PAR_CLE } from '@/lib/auth/emprunt-bornes';
import { sessionAdmin } from '@/lib/admin/session-admin';
import { APPS_ECRAN, chercherClients, entreeDe, ficheClient, LIBELLES, MAX_TROUVES, type AppEcran } from '@/lib/emprunt/entrees';
import { prisma } from '@/lib/prisma';

import { Entrer } from './Entrer';
import { RechercheClient } from './RechercheClient';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f-]{36}$/i;
const ROLES: Record<string, string> = { proprietaire: 'propriétaire', owner: 'propriétaire', admin: 'administrateur', member: 'membre', membre: 'membre' };
const quand = (d: Date) => d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' });

type Params = { q?: string; u?: string; sortie?: string };

/** Les apps entrées pendant l'emprunt qu'on quitte : leur session est encore celle du client dans ce navigateur. */
async function appsOuvertes(empruntId: string): Promise<AppEcran[]> {
  const l = await prisma.auditLog.findMany({ where: { action: 'admin.impersonate.app', payload: { path: ['emprunt'], equals: empruntId } }, select: { payload: true }, take: 50 });
  const entrees = l.flatMap((x) => { const p = x.payload as { app?: string; resultat?: string } | null; return p?.resultat === 'entre' && p.app ? [p.app === 'analytics-rybbit' ? 'analytics' : p.app] : []; });
  return APPS_ECRAN.filter((a) => entrees.includes(a));
}

export default async function ClientsPage({ searchParams }: { searchParams: Promise<Params> }) {
  // Le layout ne suffit pas : une page se garde elle-même avant de lire un client.
  if (!(await sessionAdmin()).ok) return null;
  const { q = '', u, sortie } = await searchParams;
  const fiche = u && UUID.test(u) ? await ficheClient(prisma, u) : null;
  const recherche = !fiche && q ? await chercherClients(prisma, q) : null;
  const ouvertes = sortie && /^[a-z0-9-]{10,40}$/i.test(sortie) ? await appsOuvertes(sortie) : null;
  const cible = fiche ? await prisma.user.findFirst({ where: { supabaseUserId: fiche.hubUserId }, select: { id: true } }) : null;
  const entrees = cible ? await prisma.auditLog.findMany({ where: { targetId: cible.id, action: 'admin.impersonate.start' }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, actor: true, payload: true, createdAt: true } }) : [];

  return (
    <div className="space-y-6">
      <DashboardPageHeader title="Clients" icon={UserSearch} />
      {ouvertes && (
        <Card role="status" data-testid="sortie-emprunt">
          <CardHeader>
            <CardTitle className="text-base">Vous êtes revenu à votre compte</CardTitle>
            {ouvertes.length > 0 && <CardDescription>Dans ces apps, ce navigateur est encore chez le client. Rouvrez-les pour y revenir vous-même.</CardDescription>}
          </CardHeader>
          {ouvertes.length > 0 && (
            <CardContent className="flex flex-wrap gap-2">
              {ouvertes.map((a) => (
                <Button key={a} asChild variant="outline">
                  <a href={entreeDe(a) ?? '/dashboard'} target="_blank" rel="noreferrer">
                    {LIBELLES[a]}, avec mon compte
                  </a>
                </Button>
              ))}
            </CardContent>
          )}
        </Card>
      )}

      <RechercheClient q={fiche ? fiche.email : q} />

      {recherche && (
        <Card>
          <CardContent className="p-0">
            {recherche.trouves.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground">Personne ne correspond à « {q} ».</p>
            ) : (
              <ul className="divide-y divide-border">
                {recherche.trouves.map((t) => (
                  <li key={t.hubUserId}>
                    <Link href={`/dashboard/admin/clients?u=${t.hubUserId}`} className="block p-4 hover:bg-muted">
                      <span className="block break-all font-medium">{t.email}</span>
                      <span className="block break-words text-sm text-muted-foreground">{[t.nom, t.organisations.join(', ') || 'aucune organisation'].filter(Boolean).join(' · ')}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {recherche.tronque && <p className="border-t border-border p-4 text-sm text-muted-foreground">Les {MAX_TROUVES} premiers seulement : précisez la recherche.</p>}
          </CardContent>
        </Card>
      )}
      {u && !fiche && <p className="text-sm text-muted-foreground">Ce compte n&apos;existe pas au Hub.</p>}

      {fiche && (
        <Card data-testid="fiche-client">
          <CardHeader>
            <CardTitle className="break-all">{fiche.nom ?? fiche.email}</CardTitle>
            <CardDescription className="break-all">{fiche.nom ? fiche.email : null}</CardDescription>
            <div className="flex flex-wrap gap-2 pt-1">
              {!fiche.adresseProuvee && <Badge variant="destructive">Adresse jamais prouvée</Badge>}
              {fiche.organisations.map((o) => (
                <Badge key={o.id} variant={o.suspendue ? 'destructive' : 'outline'}>
                  {o.nom} · {o.suspendue ? 'suspendue' : (ROLES[o.role] ?? o.role)}
                </Badge>
              ))}
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <Entrer key={fiche.hubUserId} hubUserId={fiche.hubUserId} apps={fiche.apps} organisations={fiche.organisations} />
            {entrees.length > 0 && (
              <section className="space-y-2">
                <h2 className="text-sm font-semibold">Dernières entrées chez ce client</h2>
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {entrees.map((e) => {
                    const p = (e.payload ?? {}) as { app?: string | null; raison?: string | null; par?: string };
                    return (
                      <li key={e.id} className="break-words">
                        {quand(e.createdAt)} · {p.par === PAR_CLE || e.actor === 'token:ADMIN_SECRET' ? 'outil hub' : e.actor.replace(/^admin:/, '')}
                        {p.app && p.app in LIBELLES ? ` · ${LIBELLES[p.app as AppEcran]}` : ''}
                        {p.raison ? ` · ${p.raison}` : ''}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
