// Arrivée d'une connexion par le fournisseur d'une organisation qui n'a pas abouti : jamais muette, jamais un détail technique.
import Link from 'next/link';

import { Card } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

const RAISONS: Record<string, string> = {
  demande_expiree: 'Cette demande de connexion a expiré, ou vient d\'un autre navigateur. Repartez du lien de votre organisation.',
  organisation_indisponible: 'La connexion de cette organisation est fermée pour le moment. Contactez son administrateur.',
  fournisseur_injoignable: 'Le service de connexion de votre organisation ne répond pas. Réessayez dans un instant.',
  reponse_refusee: 'La réponse du service de connexion de votre organisation n\'a pas pu être vérifiée. Repartez du lien de votre organisation.',
  identifiant_non_durable: 'Le service de connexion de votre organisation vous désigne par une adresse, ou par un identifiant qui change à chaque fois. Demandez à son administrateur un identifiant stable (format « persistent »).',
  adresse_absente: 'Le service de connexion de votre organisation n\'a pas donné votre adresse. Prévenez son administrateur.',
  adresse_non_verifiee: 'Le service de connexion de votre organisation dit que votre adresse n\'est pas vérifiée. Prévenez son administrateur.',
  domaine_refuse: 'Votre adresse n\'appartient pas aux domaines de cette organisation.',
  compte_existant: 'Un compte Veridian existe déjà avec cette adresse. Connectez-vous une fois comme d\'habitude, puis revenez par le lien de votre organisation : il sera relié.',
  autre_identite: 'Ce compte est déjà relié à une autre identité de votre organisation. Prévenez son administrateur.',
  non_attendu: 'Votre organisation ne vous attend pas encore. Demandez à son administrateur de vous ajouter.',
  non_relie: 'Ce compte n\'est pas encore relié à votre accès Veridian. Connectez-vous une fois comme d\'habitude, ouvrez Paramètres, puis « Relier mon compte ».',
  autre_organisation: 'Vous appartenez aussi à une autre organisation : cette connexion n\'ouvre que celle-ci. Connectez-vous avec votre mot de passe ou Google pour les retrouver toutes.',
  retire: 'Vous avez été retiré de cette organisation. Demandez à son administrateur de vous ajouter à nouveau.',
  autre_adresse: 'Votre organisation a confirmé une autre adresse que celle que vous avez demandée. Rien n\'a été ajouté.',
  trop_d_adresses: 'Vous avez déjà le nombre maximal d\'adresses. Détachez-en une avant d\'en ajouter.',
  email_not_verified: 'Confirmez d\'abord votre adresse principale.',
  session_refusee: 'La connexion n\'a pas abouti. Repartez du lien de votre organisation.',
};

export default async function FederationPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const raison = RAISONS[(await searchParams).code ?? ''] ?? RAISONS.session_refusee;
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md p-8 space-y-4">
        <h1 className="text-xl font-semibold">Connexion par votre organisation</h1>
        <p className="text-sm text-muted-foreground" role="status">{raison}</p>
        <Link href="/login" className="inline-flex min-h-11 items-center text-sm font-medium underline">
          Connexion habituelle
        </Link>
      </Card>
    </div>
  );
}
