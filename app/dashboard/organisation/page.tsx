// /dashboard/organisation : un seul endroit pour régler son organisation, les apps la reçoivent (VER-252). Adresse stable : les apps y renvoient.
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { Building2Icon } from 'lucide-react';

import { auth } from '@/auth';
import { DashboardPageHeader } from '@/components/dashboard/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { roleAuHub } from '@/lib/delegation/interrupteur';
import { vueIdp } from '@/lib/federation/idp';
import { CHEMIN_RETOUR } from '@/lib/federation/oidc';
import { CHEMIN_ACS, entiteSp } from '@/lib/federation/saml';
import { espacesDe } from '@/lib/mcp/catalogue';
import { hubPublicUrl } from '@/lib/organisations/base';
import { urlLogo } from '@/lib/organisations/document';
import { prisma } from '@/lib/prisma';
import { COOKIE_ACTIF, organisationActive } from '@/lib/tenants/actif';
import { listerPreinscriptions } from '@/lib/tenants/preinscription';

import { Fournisseur } from './Fournisseur';

export const dynamic = 'force-dynamic';

const AVIS: Record<string, string> = {
  active: 'Organisation active changée : vos apps ouvriront dans celle-ci.',
  enregistre: 'Enregistré, vos apps ont reçu le changement.',
  partiel: 'Enregistré ici. Une app n\'a pas encore suivi : elle le recevra au prochain changement.',
  role_insuffisant: 'Seul le propriétaire ou un administrateur règle cette organisation.',
  trop_gros: 'Logo trop lourd : 2 Mo au plus.',
  format_refuse: 'Logo refusé : PNG, JPEG ou WebP.',
  fournisseur_pose: 'Fournisseur enregistré. Essayez-le avec votre propre compte, puis activez-le.',
  essai_reussi: 'Essai réussi. Vous pouvez l\'activer.',
  essai_manquant: 'Essayez-le d\'abord : il ne s\'active qu\'après un essai réussi.',
  fournisseur_actif: 'Actif. Vos membres relient leur compte dans leurs Paramètres, puis entrent par votre porte.',
  fournisseur_coupe: 'Coupé. Chacun garde sa connexion habituelle.',
  fournisseur_retire: 'Retiré, et les comptes déliés. Chacun garde sa connexion habituelle.',
  fournisseur_incomplet: 'Réglage incomplet : vérifiez l\'émetteur (https), l\'identifiant et le secret, ou le certificat.',
  fournisseur_injoignable: 'Ce fournisseur ne répond pas à cette adresse.',
  issuer_refuse: 'Adresse refusée : une adresse publique en https.',
  certificat_refuse: 'Certificat illisible ou périmé.',
  proprietaire_seul: 'Seul le propriétaire règle la connexion de l\'organisation.',
  pose_par_veridian: 'Réglé par Veridian : écrivez-nous pour le changer.',
  absent: 'Aucun fournisseur n\'est enregistré.',
  trop_de_gestes: 'Trop de gestes en peu de temps. Réessayez dans une heure.',
  refus: 'Réglage refusé : vérifiez les couleurs (#RRGGBB) et le nom.',
};
function adressesDe(tenantId: string, porte: string | null) {
  const base = new URL(hubPublicUrl());
  return { retour: new URL(CHEMIN_RETOUR, base).href, acs: new URL(CHEMIN_ACS, base).href, entite: entiteSp({ tenantId }, base), connexion: porte ? new URL(`/connexion/${porte}`, base).href : null };
}
const ATTENTE: Record<string, string> = { en_attente: 'attendue', joint: 'a rejoint', expiree: 'délai passé', annulee: 'annulée' };
const APPS: Record<string, string> = { academy: 'Academy', notifuse: 'Mail', prospection: 'Prospection', crm: 'CRM' };

export default async function Organisation({ searchParams }: { searchParams: Promise<{ avis?: string }> }) {
  const session = await auth();
  const user = session ? await getCurrentUser() : null;
  if (!user) redirect('/login?callbackUrl=/dashboard/organisation');
  const avis = AVIS[(await searchParams).avis ?? ''];
  const espaces = await Promise.all((await espacesDe(prisma, userUuid(user))).map(async (e) => ({
    ...e,
    au: await roleAuHub(prisma, e.id, userUuid(user)),
    org: await prisma.organisation.findUnique({ where: { tenantId: e.id }, omit: { logo: true } }),
    emissions: await prisma.organisationEmission.findMany({ where: { tenantId: e.id } }),
    idp: await prisma.tenantIdp.findUnique({ where: { tenantId: e.id } }),
    preinscrits: (await listerPreinscriptions(prisma, e.id)).filter((p) => p.etat !== 'annulee'),
  })));
  const active = await organisationActive(prisma, userUuid(user), (await cookies()).get(COOKIE_ACTIF)?.value);
  const miens = espaces.filter((e) => e.au === 'owner' || e.au === 'admin');
  return (
    <div className="flex flex-col gap-6 p-4 md:p-8">
      <DashboardPageHeader title="Organisation" icon={Building2Icon} description="Réglée ici une fois, reprise par vos apps." />
      {avis ? <p role="status" className="text-sm">{avis}</p> : null}
      {espaces.length > 1 ? (
        <Card>
          <CardHeader>
            <CardTitle>Où ouvrir vos apps</CardTitle>
          </CardHeader>
          <CardContent>
            <form method="post" action="/api/organisations/active" className="flex flex-wrap items-center gap-3">
              <select name="tenant" aria-label="Organisation active" defaultValue={active ?? espaces[0].id} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
                {espaces.map((e) => <option key={e.id} value={e.id}>{e.org?.nomAffiche ?? e.nom}</option>)}
              </select>
              <Button type="submit" variant="outline">Choisir</Button>
            </form>
          </CardContent>
        </Card>
      ) : null}
      {miens.length === 0 ? <p className="text-muted-foreground">Seul le propriétaire ou un administrateur règle une organisation.</p> : null}
      {miens.map((e) => {
        const logo = e.org ? urlLogo(hubPublicUrl(), e.org) : null;
        return (
          <Card key={e.id}>
            <CardHeader>
              <CardTitle>{e.org?.nomAffiche ?? e.nom}</CardTitle>
            </CardHeader>
            <CardContent>
              <form method="post" action="/api/organisations/regler" encType="multipart/form-data" className="flex flex-col gap-4">
                <input type="hidden" name="tenant" value={e.id} />
                <div className="flex flex-col gap-2">
                  <Label htmlFor={`nom-${e.id}`}>Nom affiché</Label>
                  <Input id={`nom-${e.id}`} name="nom_affiche" maxLength={80} defaultValue={e.org?.nomAffiche ?? ''} placeholder={e.nom} />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor={`type-${e.id}`}>Type</Label>
                  <select id={`type-${e.id}`} name="type" defaultValue={e.org?.type ?? 'individuel'} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
                    <option value="individuel">Individuel</option>
                    <option value="organisation">Organisation (plusieurs personnes)</option>
                  </select>
                </div>
                <div className="flex flex-wrap gap-4">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={`c1-${e.id}`}>Couleur principale</Label>
                    <Input id={`c1-${e.id}`} name="couleur_primaire" placeholder="#0B5FFF" pattern="#[0-9a-fA-F]{6}" defaultValue={e.org?.couleurPrimaire ?? ''} />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={`c2-${e.id}`}>Couleur d&apos;accent</Label>
                    <Input id={`c2-${e.id}`} name="couleur_accent" placeholder="#FFB000" pattern="#[0-9a-fA-F]{6}" defaultValue={e.org?.couleurAccent ?? ''} />
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor={`logo-${e.id}`}>Logo (PNG, JPEG ou WebP, 2 Mo au plus)</Label>
                  {/* eslint-disable-next-line @next/next/no-img-element -- servi par le Hub, déjà réencodé à 512 px */}
                  {logo ? <img src={logo} alt={`Logo de ${e.nom}`} className="h-16 w-auto self-start rounded border p-1" /> : null}
                  <Input id={`logo-${e.id}`} name="logo" type="file" accept="image/png,image/jpeg,image/webp" />
                  {logo ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="retirer_logo" value="1" /> Retirer le logo</label> : null}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-muted-foreground">
                    {e.org?.modules.length ? `Apps : ${e.org.modules.map((m) => { const x = e.emissions.find((y) => y.app === m); return `${APPS[m] ?? m} ${x ? (x.etat === 'applique' ? 'à jour' : 'en retard') : 'pas encore'}`; }).join(', ')}` : 'Aucune app ne reprend encore ce réglage.'}
                  </p>
                  <Button type="submit">Enregistrer</Button>
                </div>
              </form>
              {e.au === 'owner' ? <Fournisseur tenant={e.id} idp={e.idp ? vueIdp(e.idp) : null} adresses={adressesDe(e.id, e.idp?.alias ?? e.slug)} /> : null}
              {e.preinscrits.length > 0 ? (
                <div className="mt-6">
                  <p className="font-medium">Personnes attendues</p>
                  <p className="text-sm text-muted-foreground">Elles rejoignent l&apos;organisation à leur première connexion avec cette adresse. Aucun mail n&apos;est envoyé.</p>
                  <ul className="mt-2 text-sm">
                    {e.preinscrits.map((p) => <li key={p.email}>{p.email} : {ATTENTE[p.etat]}</li>)}
                  </ul>
                </div>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
