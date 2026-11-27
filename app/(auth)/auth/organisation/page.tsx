// Une organisation de cette personne demande son fournisseur, et sa session n'y est pas passée (VER-261). Jamais un refus muet : le bouton qui ouvre est là.
import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { ChangerDeCompte } from '@/components/auth/ChangerDeCompte';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { auth } from '@/auth';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { fermees, preuveDeSession } from '@/lib/federation/obligation';
import { COOKIE_SILENCE } from '@/lib/federation/porte';
import { dejaReliee } from '@/lib/federation/prouver';
import { espacesDe } from '@/lib/mcp/catalogue';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Votre organisation', robots: { index: false } };

export default async function OrganisationExigee({ searchParams }: { searchParams: Promise<{ org?: string; silence?: string }> }) {
  const session = await auth();
  const user = session ? await getCurrentUser() : null;
  if (!user?.supabaseUserId) redirect('/login?callbackUrl=/auth/organisation');
  const preuve = preuveDeSession(session);
  const toutes = await fermees(prisma, userUuid(user), preuve);
  if (toutes.length === 0) redirect('/dashboard');
  const { org } = await searchParams;
  const closes = toutes.some((f) => f.tenantId === org) ? toutes.filter((f) => f.tenantId === org) : toutes;
  // Déjà reliée, une organisation à la fois, une fois par navigateur : d'abord sans écran chez le fournisseur. Un refus revient ici (`silence=echec`) avec le bouton.
  const sp = await searchParams;
  if (!sp.silence && closes.length === 1 && session?.user?.impersonated !== true && !(await cookies()).has(COOKIE_SILENCE)) {
    const l = await prisma.tenantIdp.findUnique({ where: { tenantId: closes[0].tenantId }, select: { id: true, protocole: true, actif: true } });
    if (l?.actif && l.protocole !== 'saml' && (await dejaReliee(prisma, l, user.id))) redirect(`/api/auth/federation/prouver?tenant=${closes[0].tenantId}&silence=1`);
  }
  const ailleurs = !toutes.some((f) => f.proprietaire) && (await espacesDe(prisma, userUuid(user), preuve)).length > 0;
  const emprunt = session?.user?.impersonated === true;
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md space-y-6 p-8">
        {closes.map((f) => (
          <section key={f.tenantId} className="space-y-4">
            <h1 className="text-xl font-semibold">Votre organisation demande {f.fournisseur}</h1>
            <p className="text-sm text-muted-foreground">
              <strong className="text-foreground">{f.nom}</strong> s&apos;ouvre avec le compte que vous y avez déjà. Vous restez connecté ici : il suffit d&apos;y passer une fois.
            </p>
            {emprunt ? (
              <p role="status" className="text-sm">Session d&apos;assistance : cette organisation ne s&apos;ouvre que par sa personne.</p>
            ) : (
              <form method="post" action="/api/auth/federation/prouver">
                <input type="hidden" name="tenant" value={f.tenantId} />
                <Button type="submit" className="w-full">Continuer avec {f.fournisseur}</Button>
              </form>
            )}
          </section>
        ))}
        <div className="flex flex-wrap justify-between gap-x-4 text-sm">
          {ailleurs ? <Link href="/dashboard" className="inline-flex min-h-11 items-center underline">Mes autres espaces</Link> : null}
          <ChangerDeCompte />
        </div>
      </Card>
    </div>
  );
}
