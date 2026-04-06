import { Metadata } from 'next';
import { Card, CardContent } from '@/components/ui/card';

export const metadata: Metadata = {
  title: 'Mentions Légales et CGU',
  description: 'Consultez les mentions légales, les conditions générales d\'utilisation et la politique de confidentialité de la plateforme Veridian.',
  openGraph: {
    title: 'Mentions Légales et CGU | Veridian',
    description: 'Consultez les mentions légales, les conditions générales d\'utilisation et la politique de confidentialité de la plateforme Veridian.'
  }
};

/**
 * PAGE LÉGALE UNIQUE
 *
 * Conforme aux exigences Stripe pour la validation du compte :
 * - Mentions légales complètes
 * - CGV/CGU claires
 * - Politique de remboursement (14 jours)
 * - Politique de confidentialité
 * - Coordonnées de contact
 */
export default function LegalPage() {
  const currentYear = new Date().getFullYear();

  return (
    <div className="container max-w-4xl py-12 px-4">
      <div className="space-y-8">
        {/* Header */}
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-bold tracking-tight">Mentions Légales</h1>
          <p className="text-muted-foreground">
            Dernière mise à jour : {new Date().toLocaleDateString('fr-FR')}
          </p>
        </div>

        {/* Éditeur */}
        <Card>
          <CardContent className="pt-6 space-y-8 text-sm leading-relaxed">

            {/* ======================================================================= */}
            {/* 1. MENTIONS LÉGALES */}
            {/* ======================================================================= */}
            <section id="mentions-legales">
              <h2 className="text-2xl font-semibold mb-4">1. Mentions Légales</h2>

              <div className="space-y-4">
                <div>
                  <h3 className="font-semibold mb-2">Éditeur du site</h3>
                  <p className="text-muted-foreground">
                    Le présent site est édité par :
                  </p>
                  <ul className="list-none pl-4 mt-2 space-y-1 text-muted-foreground">
                    <li><strong>Veridian</strong></li>
                    <li>Entrepreneur individuel</li>
                    <li>SIREN : 980 837 660</li>
                    <li>SIRET : 980 837 660 00011</li>
                    <li>Numéro de TVA : FR47980837660</li>
                    <li>Date de création : 1er novembre 2023</li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold mb-2">Adresse postale</h3>
                  <p className="text-muted-foreground">
                    29 Rue Lanterne<br />
                    69001 Lyon<br />
                    France
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold mb-2">Contact</h3>
                  <p className="text-muted-foreground">
                    Email : <a href="mailto:brunon5robert@gmail.com" className="text-primary underline">brunon5robert@gmail.com</a>
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold mb-2">Hébergement</h3>
                  <p className="text-muted-foreground">
                    Ce site est hébergé par les services cloud de Google Cloud Platform et/ou Scaleway,
                    dont les serveurs sont situés dans l'Union Européenne.
                  </p>
                </div>
              </div>
            </section>

            <hr />

            {/* ======================================================================= */}
            {/* 2. CONDITIONS GÉNÉRALES DE VENTE (CGV) */}
            {/* ======================================================================= */}
            <section id="cgv">
              <h2 className="text-2xl font-semibold mb-4">2. Conditions Générales de Vente (CGV)</h2>

              <div className="space-y-4">
                <div>
                  <h3 className="font-semibold mb-2">2.1. Objet</h3>
                  <p className="text-muted-foreground">
                    Les présentes Conditions Générales de Vente (CGV) régissent la vente des abonnements logiciels
                    proposés par Veridian sur le site Veridian. Elles s'appliquent à toute commande
                    effectuée sur le site.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold mb-2">2.2. Services proposés</h3>
                  <p className="text-muted-foreground">
                    Veridian propose une plateforme SaaS multi-tenant incluant :
                  </p>
                  <ul className="list-disc pl-6 mt-2 space-y-1 text-muted-foreground">
                    <li>Un CRM Twenty (gestion de la relation client)</li>
                    <li>Une plateforme d'email marketing Notifuse</li>
                    <li>Un tableau de bord unifié de gestion</li>
                    <li>Des services d'authentification et de base de données</li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold mb-2">2.3. Tarifs</h3>
                  <p className="text-muted-foreground">
                    Les prix des abonnements sont affichés en euros (€) TTC et incluent toutes les taxes
                    applicables. Veridian se réserve le droit de modifier ses prix à tout moment,
                    mais le produit sera facturé sur la base du tarif en vigueur au moment de la validation
                    de la commande.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold mb-2">2.4. Paiement</h3>
                  <p className="text-muted-foreground">
                    Le paiement est exigible immédiatement à la commande. Les règlements s'effectuent
                    par carte bancaire via la plateforme de paiement sécurisée Stripe. Les cartes bancaires
                    acceptées sont : Visa, Mastercard, American Express.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold mb-2">2.5. Durée et renouvellement</h3>
                  <p className="text-muted-foreground">
                    Les abonnements sont souscrits pour une durée d'un mois ou d'un an, selon le plan choisi.
                    Ils se renouvellent automatiquement à l'échéance, sauf résiliation par le client.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold mb-2">2.6. Résiliation</h3>
                  <p className="text-muted-foreground">
                    Vous pouvez résilier votre abonnement à tout moment depuis votre tableau de bord
                    ou via le lien de résiliation envoyé par email. La résiliation prend effet à la fin
                    de la période en cours et vous conservez l'accès au service jusqu'à cette date.
                    Aucun remboursement n'est effectué pour la période en cours.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold mb-2">2.7. Disponibilité des services</h3>
                  <p className="text-muted-foreground">
                    Veridian s'efforce d'assurer la disponibilité des services 24h/24 et 7j/7.
                    Cependant, il ne peut être tenu responsable des interruptions dues à la maintenance,
                    aux opérations de mise à jour, ou à des cas de force majeure.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold mb-2">2.8. Données et sauvegarde</h3>
                  <p className="text-muted-foreground">
                    Vous êtes responsable de la sauvegarde de vos données. Veridian met en œuvre
                    des mesures de sécurité appropriées mais ne garantit pas la restauration intégrale
                    des données en cas de perte accidentelle.
                  </p>
                </div>
              </div>
            </section>

            <hr />

            {/* ======================================================================= */}
            {/* 3. POLITIQUE DE REMBOURSEMENT */}
            {/* ======================================================================= */}
            <section id="remboursement">
              <h2 className="text-2xl font-semibold mb-4">3. Politique de Remboursement</h2>

              <div className="space-y-4">
                <div>
                  <h3 className="font-semibold mb-2">3.1. Délai de rétractation (14 jours)</h3>
                  <p className="text-muted-foreground">
                    Conformément à l'article L221-18 du Code de la consommation, vous disposez d'un délai
                    de quatorze (14) jours à compter de la souscription pour vous rétracter sans
                    avoir à justifier de motifs ni à payer de pénalités.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold mb-2">3.2. Exercice du droit de rétractation</h3>
                  <p className="text-muted-foreground">
                    Pour exercer votre droit de rétractation, vous devez notifier votre décision
                    par email à <a href="mailto:brunon5robert@gmail.com" className="text-primary underline">brunon5robert@gmail.com</a>
                    {' '}en indiquant votre volonté de vous rétracter.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold mb-2">3.3. Remboursement</h3>
                  <p className="text-muted-foreground">
                    En cas de rétractation dans le délai de 14 jours, vous serez remboursé
                    intégralement des sommes versées. Le remboursement sera effectué sur le moyen
                    de paiement utilisé pour la commande, dans un délai maximum de 14 jours
                    à compter de la réception de votre demande de rétractation.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold mb-2">3.4. Exceptions</h3>
                  <p className="text-muted-foreground">
                    Le droit de rétractation ne s'applique pas une fois le service pleinement
                    utilisé et la période d'essai terminée. Après 14 jours d'utilisation active,
                    aucun remboursement ne sera possible pour la période en cours.
                  </p>
                </div>
              </div>
            </section>

            <hr />

            {/* ======================================================================= */}
            {/* 4. POLITIQUE DE CONFIDENTIALITÉ */}
            {/* ======================================================================= */}
            <section id="confidentialite">
              <h2 className="text-2xl font-semibold mb-4">4. Politique de Confidentialité</h2>

              <div className="space-y-4">
                <div>
                  <h3 className="font-semibold mb-2">4.1. Collecte des données</h3>
                  <p className="text-muted-foreground">
                    Veridian collecte les données suivantes :
                  </p>
                  <ul className="list-disc pl-6 mt-2 space-y-1 text-muted-foreground">
                    <li>Données d'identification (email, nom, prénom)</li>
                    <li>Données de connexion (adresse IP, horodatage)</li>
                    <li>Données de paiement (traitées exclusivement par Stripe)</li>
                    <li>Données d'utilisation du service</li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold mb-2">4.2. Finalités</h3>
                  <p className="text-muted-foreground">
                    Les données collectées sont utilisées pour :
                  </p>
                  <ul className="list-disc pl-6 mt-2 space-y-1 text-muted-foreground">
                    <li>La gestion de votre compte et l'accès aux services</li>
                    <li>Le traitement des paiements et la facturation</li>
                    <li>L'amélioration des services</li>
                    <li>L'envoi de communications transactionnelles</li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold mb-2">4.3. Base légale</h3>
                  <p className="text-muted-foreground">
                    Le traitement des données est fondé sur :
                  </p>
                  <ul className="list-disc pl-6 mt-2 space-y-1 text-muted-foreground">
                    <li>L'exécution du contrat (article 6.1.b du RGPD)</li>
                    <li>Le consentement (article 6.1.a du RGPD)</li>
                    <li>Les obligations légales (article 6.1.c du RGPD)</li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold mb-2">4.4. Durée de conservation</h3>
                  <p className="text-muted-foreground">
                    Les données sont conservées pendant la durée de la relation contractuelle
                    et, conformément aux obligations légales, pendant une durée de 5 ans
                    après la fin de cette relation.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold mb-2">4.5. Droits des utilisateurs</h3>
                  <p className="text-muted-foreground">
                    Conformément au RGPD, vous disposez des droits suivants :
                  </p>
                  <ul className="list-disc pl-6 mt-2 space-y-1 text-muted-foreground">
                    <li>Droit d'accès (article 15 du RGPD)</li>
                    <li>Droit de rectification (article 16 du RGPD)</li>
                    <li>Droit à l'effacement (article 17 du RGPD)</li>
                    <li>Droit à la portabilité (article 20 du RGPD)</li>
                    <li>Droit d'opposition (article 21 du RGPD)</li>
                  </ul>
                  <p className="text-muted-foreground mt-2">
                    Pour exercer ces droits, contactez-nous à :{' '}
                    <a href="mailto:brunon5robert@gmail.com" className="text-primary underline">brunon5robert@gmail.com</a>
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold mb-2">4.6. Sous-traitants</h3>
                  <p className="text-muted-foreground">
                    Les données sont hébergées et traitées par les sous-traitants suivants :
                  </p>
                  <ul className="list-disc pl-6 mt-2 space-y-1 text-muted-foreground">
                    <li><strong>Stripe</strong> : Traitement des paiements</li>
                    <li><strong>Supabase</strong> : Hébergement de base de données et authentification</li>
                    <li><strong>Google Cloud / Scaleway</strong> : Infrastructure cloud</li>
                  </ul>
                  <p className="text-muted-foreground mt-2">
                    Tous les sous-traitants sont situés dans l'Union Européenne ou respectent
                    les clauses contractuelles standard de l'UE.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold mb-2">4.7. Transfert hors UE</h3>
                  <p className="text-muted-foreground">
                    Certains transferts de données vers les États-Unis peuvent avoir lieu dans le cadre
                    de l'utilisation de services cloud (Google Cloud). Ces transferts sont protégés
                    par les clauses contractuelles standard de l'UE et le Privacy Shield.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold mb-2">4.8. Sécurité</h3>
                  <p className="text-muted-foreground">
                    Veridian met en œuvre des mesures de sécurité techniques et organisationnelles
                    appropriées pour protéger les données contre la destruction, la perte, l'altération,
                    le partage non autorisé ou l'accès illicite.
                  </p>
                </div>
              </div>
            </section>

            <hr />

            {/* ======================================================================= */}
            {/* 5. PROPRIÉTÉ INTELLECTUELLE */}
            {/* ======================================================================= */}
            <section id="propriete-intellectuelle">
              <h2 className="text-2xl font-semibold mb-4">5. Propriété Intellectuelle</h2>

              <div className="space-y-4">
                <p className="text-muted-foreground">
                  L'ensemble du contenu de ce site (textes, images, vidéos, logos, etc.) est protégé
                  par le droit d'auteur. Toute reproduction, même partielle, est interdite sans
                  autorisation préalable de Veridian.
                </p>
                <p className="text-muted-foreground">
                  Les logiciels Twenty et Notifuse sont des logiciels open source distribués
                  sous licence libre. Veridian est une plateforme d'intégration et de gestion
                  de ces logiciels.
                </p>
              </div>
            </section>

            <hr />

            {/* ======================================================================= */}
            {/* 6. LOI APPLICABLE ET JURIDICTION */}
            {/* ======================================================================= */}
            <section id="juridiction">
              <h2 className="text-2xl font-semibold mb-4">6. Loi Applicable et Juridiction Compétente</h2>

              <div className="space-y-4">
                <p className="text-muted-foreground">
                  Les présentes CGV sont régies par la loi française. En cas de litige, les tribunaux
                  français seront seuls compétents.
                </p>
              </div>
            </section>

            {/* Footer */}
            <div className="pt-6 text-center text-muted-foreground text-xs">
              <p>© {currentYear} Veridian - Tous droits réservés</p>
              <p className="mt-2">
                Veridian - Plateforme SaaS multi-tenant
              </p>
            </div>

          </CardContent>
        </Card>
      </div>
    </div>
  );
}
