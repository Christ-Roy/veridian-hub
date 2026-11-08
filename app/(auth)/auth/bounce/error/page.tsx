/**
 * /auth/bounce/error — le rebond Hub→app a échoué (cf. CONTRAT-HUB §6bis.8.2).
 *
 * Un refus d'identité s'explique avec l'adresse de la session : `user_not_in_app` (l'app ne
 * connaît pas ce compte, souvent une autre adresse que celle de l'app) et `hub_user_conflict`
 * (l'accès est rattaché à un autre compte Veridian de la même personne). Le reste est un incident
 * d'infrastructure : message neutre, code affiché. Toujours un CTA hors boucle.
 */

import Link from 'next/link';
import Logo from '@/components/icons/Logo';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { getCurrentUser } from '@/lib/auth/get-user';
import { APPS } from '@/lib/pricing/plans';

import { ChangerDeCompte } from './ChangerDeCompte';

interface BounceErrorPageProps {
  searchParams: Promise<{ app?: string; code?: string }>;
}

const NOM_APP: Record<string, string> = {
  analytics: APPS.analytics.display_name,
  'analytics-rybbit': APPS.analytics.display_name,
  notifuse: APPS.notifuse.display_name,
  prospection: APPS.prospection.display_name,
  cms: APPS.cms.display_name,
  crm: 'Veridian CRM',
};

const SUPPORT = 'contact@veridian.site';

export default async function BounceErrorPage({ searchParams }: BounceErrorPageProps) {
  const { app, code } = await searchParams;
  const safeApp = (app ?? '').replace(/[^a-z0-9-]/gi, '').slice(0, 32);
  const safeCode = (code ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
  const displayApp = NOM_APP[safeApp] ?? (safeApp || 'l\'application');
  const user = await getCurrentUser().catch(() => null);
  const email = user?.email ?? null;
  const identite = safeCode === 'user_not_in_app' || safeCode === 'hub_user_conflict';
  const sujet = encodeURIComponent(`Accès à ${displayApp}`);

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md border shadow-sm p-8 space-y-6" data-bounce-code={safeCode || 'inconnu'}>
        <div className="flex flex-col items-center gap-3 text-center">
          <Logo width="48px" height="48px" />
          {safeCode === 'user_not_in_app' ? (
            <>
              <h1 className="text-2xl font-bold">Pas encore d&apos;accès à {displayApp}</h1>
              <p className="text-muted-foreground text-sm">
                Vous êtes connecté à Veridian avec <strong>{email ?? 'ce compte'}</strong>, et {displayApp} ne
                connaît pas ce compte. Si votre accès à {displayApp} est à une autre adresse, connectez-vous à
                Veridian avec cette adresse-là. Sinon, écrivez-nous et nous ouvrons votre accès.
              </p>
            </>
          ) : safeCode === 'hub_user_conflict' ? (
            <>
              <h1 className="text-2xl font-bold">Accès rattaché à un autre compte</h1>
              <p className="text-muted-foreground text-sm">
                Vous êtes connecté à Veridian avec <strong>{email ?? 'ce compte'}</strong>, mais votre accès à{' '}
                {displayApp} est rattaché à un autre de vos comptes Veridian. Connectez-vous avec ce compte-là,
                ou écrivez-nous pour regrouper vos comptes.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-bold">Impossible de revenir sur {displayApp}</h1>
              <p className="text-muted-foreground text-sm">
                Votre connexion Veridian a bien fonctionné, mais nous n&apos;arrivons pas à vous rediriger vers{' '}
                {displayApp} pour le moment. Réessayez dans quelques instants.
              </p>
            </>
          )}
          {safeCode && <p className="text-xs text-muted-foreground/70 font-mono">code: {safeCode}</p>}
        </div>

        <div className="flex flex-col gap-3">
          <Button asChild>
            <Link href="/dashboard">Retour à mon tableau de bord</Link>
          </Button>
          {identite && <ChangerDeCompte retour="/login" />}
          {identite ? (
            <Button variant="ghost" asChild>
              <a href={`mailto:${SUPPORT}?subject=${sujet}`}>Écrire à {SUPPORT}</a>
            </Button>
          ) : (
            <Button variant="outline" asChild>
              <a href="https://veridian.site">Aller sur veridian.site</a>
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
