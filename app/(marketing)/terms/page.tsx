import { Metadata } from 'next';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';

export const metadata: Metadata = {
  title: "Conditions d'utilisation | Veridian",
  description:
    "Conditions générales d'utilisation et de vente (CGU/CGV) de la plateforme SaaS Veridian — abonnements, paiement, rétractation, résiliation.",
  openGraph: {
    title: "Conditions d'utilisation | Veridian",
    description:
      "CGU/CGV Veridian — abonnements SaaS, paiement Stripe, droit de rétractation 14 jours, résiliation.",
  },
  alternates: {
    canonical: 'https://app.veridian.site/terms',
  },
};

/**
 * CONDITIONS GÉNÉRALES D'UTILISATION ET DE VENTE — page dédiée.
 *
 * URL : https://app.veridian.site/terms (à utiliser comme "Terms of service
 * URL" dans Google OAuth Consent Screen + Microsoft Entra Publisher
 * Verification + Stripe Compliance).
 *
 * Document scindé de /privacy (politique de confidentialité) et /legal
 * (mentions légales) pour clarté et conformité — URL dédiée exigée par
 * plusieurs plateformes externes.
 */
export default function TermsPage() {
  const currentYear = new Date().getFullYear();
  const lastUpdated = new Date('2026-05-21').toLocaleDateString('fr-FR');

  return (
    <div className="container max-w-4xl py-12 px-4">
      <div className="space-y-8">
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-bold tracking-tight">
            Conditions d'utilisation
          </h1>
          <p className="text-muted-foreground">
            Dernière mise à jour : {lastUpdated}
          </p>
        </div>

        <Card>
          <CardContent className="pt-6 space-y-8 text-sm leading-relaxed">
            {/* ============================================================ */}
            <section id="objet">
              <h2 className="text-2xl font-semibold mb-4">
                1. Objet et acceptation
              </h2>
              <div className="space-y-2 text-muted-foreground">
                <p>
                  Les présentes Conditions Générales d'Utilisation et de Vente
                  (ci-après « CGU/CGV ») régissent les relations contractuelles
                  entre Veridian, entreprise individuelle immatriculée au RCS
                  sous le SIREN 980 837 660, située au 29 Rue Lanterne, 69001
                  Lyon, France (ci-après « Veridian »), et toute personne
                  physique ou morale utilisant la plateforme SaaS accessible à
                  l'adresse{' '}
                  <a
                    href="https://app.veridian.site"
                    className="text-primary underline"
                  >
                    app.veridian.site
                  </a>{' '}
                  (ci-après l'« Utilisateur »).
                </p>
                <p>
                  La création d'un compte ou l'utilisation de la plateforme
                  emporte acceptation pleine et entière des présentes CGU/CGV.
                </p>
              </div>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="services">
              <h2 className="text-2xl font-semibold mb-4">
                2. Description des services
              </h2>
              <div className="space-y-2 text-muted-foreground">
                <p>
                  Veridian propose une plateforme SaaS multi-tenant qui réunit
                  plusieurs applications interopérables :
                </p>
                <ul className="list-disc pl-6 space-y-1">
                  <li>
                    <strong>Veridian Hub</strong> : tableau de bord unifié,
                    gestion du compte, facturation, provisioning des
                    sous-applications, gestion des membres de l'équipe
                  </li>
                  <li>
                    <strong>Notifuse</strong> : envoi d'emails transactionnels
                    et marketing (fork open source self-hosted)
                  </li>
                  <li>
                    <strong>Prospection</strong> : outils de prospection
                    commerciale (gestion des prospects, suivi, séquences)
                  </li>
                  <li>
                    <strong>Analytics</strong> : statistiques web et analyse de
                    conversion
                  </li>
                  <li>
                    <strong>CMS</strong> : gestion de contenu multi-tenant pour
                    les sites clients
                  </li>
                </ul>
                <p>
                  Les services accessibles à un Utilisateur dépendent du plan
                  d'abonnement souscrit. Veridian se réserve le droit de faire
                  évoluer le périmètre des services, en informant les
                  Utilisateurs par email au moins 30 jours avant tout
                  changement substantiel.
                </p>
              </div>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="compte">
              <h2 className="text-2xl font-semibold mb-4">
                3. Création de compte
              </h2>
              <div className="space-y-2 text-muted-foreground">
                <p>
                  La création d'un compte est requise pour accéder aux
                  services. L'Utilisateur peut s'inscrire :
                </p>
                <ul className="list-disc pl-6 space-y-1">
                  <li>
                    Avec un email professionnel et un mot de passe (minimum 8
                    caractères)
                  </li>
                  <li>
                    Avec un compte Google (OAuth) — l'email Google vérifié est
                    utilisé comme identifiant
                  </li>
                  <li>
                    Avec un compte Microsoft (OAuth) — comptes personnels
                    Outlook/Hotmail/Live ou comptes Microsoft 365 Work/School
                  </li>
                </ul>
                <p>
                  L'Utilisateur s'engage à fournir des informations exactes et
                  à les maintenir à jour. Il est seul responsable de la
                  confidentialité de ses identifiants. Toute utilisation
                  effectuée avec ses identifiants est présumée être de son
                  fait.
                </p>
                <p>
                  Veridian se réserve le droit de refuser ou de suspendre un
                  compte en cas de fraude, abus, ou violation des présentes
                  CGU/CGV.
                </p>
              </div>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="tarifs">
              <h2 className="text-2xl font-semibold mb-4">
                4. Tarifs et facturation
              </h2>
              <div className="space-y-4 text-muted-foreground">
                <div>
                  <h3 className="font-semibold mb-2 text-foreground">
                    4.1. Tarifs
                  </h3>
                  <p>
                    Les prix des abonnements sont affichés en euros (€) toutes
                    taxes comprises (TTC). Ils sont disponibles sur la page{' '}
                    <Link href="/pricing" className="text-primary underline">
                      pricing
                    </Link>
                    . Veridian se réserve le droit de modifier ses tarifs ;
                    toute modification ne s'applique qu'aux nouveaux
                    abonnements ou au renouvellement des abonnements existants,
                    avec une notification au moins 30 jours avant prise
                    d'effet.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold mb-2 text-foreground">
                    4.2. Paiement
                  </h3>
                  <p>
                    Les paiements sont traités exclusivement par{' '}
                    <strong>Stripe Payments Europe Ltd</strong>, certifié
                    PCI-DSS Level 1. Veridian ne stocke jamais les données de
                    carte bancaire. Cartes acceptées : Visa, Mastercard,
                    American Express. Le paiement est exigible immédiatement à
                    la souscription.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold mb-2 text-foreground">
                    4.3. Durée et renouvellement
                  </h3>
                  <p>
                    Les abonnements sont souscrits pour une durée d'un mois ou
                    d'un an, selon le plan choisi. Ils se renouvellent
                    automatiquement à l'échéance pour une durée identique,
                    sauf résiliation par l'Utilisateur avant la date
                    d'échéance.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold mb-2 text-foreground">
                    4.4. Facturation et TVA
                  </h3>
                  <p>
                    Une facture est émise automatiquement à chaque paiement et
                    accessible depuis l'onglet « Facturation » du tableau de
                    bord. Le numéro de TVA Veridian est FR47980837660.
                  </p>
                </div>
              </div>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="retractation">
              <h2 className="text-2xl font-semibold mb-4">
                5. Droit de rétractation
              </h2>
              <div className="space-y-2 text-muted-foreground">
                <p>
                  Conformément à l'article L221-18 du Code de la consommation,
                  l'Utilisateur consommateur dispose d'un délai de quatorze
                  (14) jours à compter de la souscription pour exercer son
                  droit de rétractation, sans avoir à justifier de motifs ni à
                  payer de pénalités.
                </p>
                <p>
                  Pour exercer ce droit, l'Utilisateur notifie sa décision par
                  email à{' '}
                  <a
                    href="mailto:robert.brunon@veridian.site"
                    className="text-primary underline"
                  >
                    robert.brunon@veridian.site
                  </a>{' '}
                  en indiquant son intention de se rétracter.
                </p>
                <p>
                  Le remboursement intégral est effectué sous 14 jours maximum
                  à compter de la réception de la demande, sur le moyen de
                  paiement utilisé pour la commande.
                </p>
                <p>
                  <strong>Exception</strong> : conformément à l'article L221-28
                  du Code de la consommation, le droit de rétractation ne peut
                  être exercé après commencement de l'exécution de la
                  prestation avec accord exprès et préalable de l'Utilisateur
                  et renonciation expresse à son droit de rétractation. En
                  pratique, l'usage actif des services pendant les 14 jours
                  vaut commencement d'exécution.
                </p>
              </div>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="resiliation">
              <h2 className="text-2xl font-semibold mb-4">6. Résiliation</h2>
              <div className="space-y-2 text-muted-foreground">
                <p>
                  L'Utilisateur peut résilier son abonnement à tout moment
                  depuis l'onglet « Facturation » de son tableau de bord, ou
                  en contactant le support.
                </p>
                <p>
                  La résiliation prend effet à la fin de la période en cours
                  (mensuelle ou annuelle). L'accès aux services est maintenu
                  jusqu'à cette date. Aucun remboursement au prorata n'est
                  effectué.
                </p>
                <p>
                  Veridian peut résilier le compte d'un Utilisateur en cas de :
                </p>
                <ul className="list-disc pl-6 space-y-1">
                  <li>Non-paiement persistant après deux relances</li>
                  <li>
                    Violation grave des présentes CGU/CGV (fraude, abus, atteinte
                    à la sécurité, contenu illicite)
                  </li>
                  <li>
                    Activité illégale (spam, phishing, contenu illicite,
                    atteinte aux droits de tiers)
                  </li>
                </ul>
              </div>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="obligations-utilisateur">
              <h2 className="text-2xl font-semibold mb-4">
                7. Obligations de l'Utilisateur
              </h2>
              <div className="space-y-2 text-muted-foreground">
                <p>
                  L'Utilisateur s'engage à utiliser la plateforme dans le
                  respect des lois et règlements en vigueur, et notamment à ne
                  pas :
                </p>
                <ul className="list-disc pl-6 space-y-1">
                  <li>
                    Envoyer de spam, de phishing ou tout email non sollicité en
                    violation du RGPD et de la directive ePrivacy
                  </li>
                  <li>
                    Diffuser des contenus illicites, diffamatoires, ou
                    portant atteinte aux droits de tiers
                  </li>
                  <li>
                    Tenter de contourner les limites techniques de la
                    plateforme (rate-limiting, quotas plan)
                  </li>
                  <li>
                    Utiliser la plateforme pour des activités frauduleuses ou
                    illégales
                  </li>
                  <li>
                    Partager ses identifiants de connexion avec un tiers non
                    autorisé
                  </li>
                  <li>
                    Procéder à du scraping, reverse engineering, ou décompilation
                    de la plateforme
                  </li>
                </ul>
                <p>
                  L'Utilisateur est responsable de la sauvegarde de ses
                  données. Veridian effectue des sauvegardes régulières mais
                  ne garantit pas la restauration intégrale en cas de perte
                  accidentelle.
                </p>
              </div>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="disponibilite">
              <h2 className="text-2xl font-semibold mb-4">
                8. Disponibilité et maintenance
              </h2>
              <div className="space-y-2 text-muted-foreground">
                <p>
                  Veridian s'efforce d'assurer la disponibilité de la
                  plateforme 24h/24 et 7j/7. Toutefois, il ne peut être tenu
                  responsable des interruptions dues à :
                </p>
                <ul className="list-disc pl-6 space-y-1">
                  <li>
                    Maintenance planifiée (annoncée au moins 48h à l'avance par
                    email)
                  </li>
                  <li>
                    Maintenance d'urgence (correctif de sécurité)
                  </li>
                  <li>
                    Indisponibilité des sous-traitants (Stripe, Google,
                    Microsoft, Cloudflare, OVH)
                  </li>
                  <li>
                    Cas de force majeure (attaque DDoS massive, catastrophe
                    naturelle, conflit armé, panne FAI)
                  </li>
                </ul>
                <p>
                  Veridian s'engage à informer les Utilisateurs en cas
                  d'incident majeur. Aucun SLA contractuel de disponibilité
                  n'est garanti sur les plans Free/Starter ; les plans
                  Business et Enterprise peuvent inclure un SLA dédié à
                  préciser dans un addendum.
                </p>
              </div>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="propriete-intellectuelle">
              <h2 className="text-2xl font-semibold mb-4">
                9. Propriété intellectuelle
              </h2>
              <div className="space-y-2 text-muted-foreground">
                <p>
                  L'ensemble des contenus de la plateforme (textes, images,
                  logos, code propriétaire, design) sont la propriété exclusive
                  de Veridian ou de ses partenaires, et sont protégés par les
                  lois françaises et internationales sur la propriété
                  intellectuelle. Toute reproduction, représentation ou
                  utilisation, même partielle, sans autorisation préalable est
                  interdite.
                </p>
                <p>
                  L'Utilisateur conserve la propriété de ses propres données et
                  contenus (prospects, emails envoyés, articles publiés,
                  segments, etc.). Il accorde à Veridian une licence
                  non-exclusive pour traiter ces données dans le cadre exclusif
                  de la fourniture des services souscrits.
                </p>
              </div>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="responsabilite">
              <h2 className="text-2xl font-semibold mb-4">
                10. Limitation de responsabilité
              </h2>
              <div className="space-y-2 text-muted-foreground">
                <p>
                  Veridian fournit ses services « en l'état » (best-effort) et
                  ne garantit pas qu'ils répondront à tous les besoins
                  spécifiques de l'Utilisateur ni qu'ils seront exempts
                  d'erreurs.
                </p>
                <p>
                  Dans toute la mesure permise par la loi, la responsabilité
                  totale cumulée de Veridian envers un Utilisateur est limitée
                  au montant des sommes effectivement versées par cet
                  Utilisateur au cours des 12 derniers mois.
                </p>
                <p>
                  Veridian ne saurait être tenu responsable des dommages
                  indirects (perte de chiffre d'affaires, perte de données,
                  préjudice d'image) sauf en cas de faute lourde ou
                  intentionnelle.
                </p>
              </div>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="donnees">
              <h2 className="text-2xl font-semibold mb-4">
                11. Protection des données personnelles
              </h2>
              <div className="space-y-2 text-muted-foreground">
                <p>
                  Le traitement des données personnelles est régi par la{' '}
                  <Link href="/privacy" className="text-primary underline">
                    Politique de Confidentialité Veridian
                  </Link>
                  , qui fait partie intégrante des présentes CGU/CGV.
                </p>
                <p>
                  L'Utilisateur s'engage à respecter le RGPD vis-à-vis des
                  données personnelles qu'il traite via la plateforme
                  (prospects, contacts emails, etc.) — il en est responsable
                  de traitement au sens RGPD ; Veridian agit comme
                  sous-traitant dans ce cadre.
                </p>
              </div>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="modification-cgu">
              <h2 className="text-2xl font-semibold mb-4">
                12. Modification des CGU/CGV
              </h2>
              <div className="space-y-2 text-muted-foreground">
                <p>
                  Veridian se réserve le droit de modifier les présentes
                  CGU/CGV pour refléter des évolutions légales, techniques ou
                  commerciales. Les modifications substantielles seront
                  notifiées par email au moins 30 jours avant prise d'effet ;
                  l'Utilisateur pourra alors résilier son compte sans frais
                  s'il n'accepte pas les nouvelles conditions.
                </p>
              </div>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="juridiction">
              <h2 className="text-2xl font-semibold mb-4">
                13. Loi applicable et juridiction
              </h2>
              <div className="space-y-2 text-muted-foreground">
                <p>
                  Les présentes CGU/CGV sont régies par le droit français. En
                  cas de litige, l'Utilisateur peut recourir à la plateforme
                  européenne de règlement en ligne des litiges (
                  <a
                    href="https://ec.europa.eu/consumers/odr"
                    className="text-primary underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    ec.europa.eu/consumers/odr
                  </a>
                  ). À défaut de résolution amiable, les tribunaux français
                  seront seuls compétents. Pour les Utilisateurs professionnels,
                  les tribunaux de Lyon sont compétents.
                </p>
              </div>
            </section>

            {/* Footer */}
            <div className="pt-6 text-center text-muted-foreground text-xs space-y-2">
              <p>
                Pages associées :{' '}
                <Link href="/privacy" className="text-primary underline">
                  Politique de confidentialité
                </Link>
                {' · '}
                <Link href="/legal" className="text-primary underline">
                  Mentions légales
                </Link>
              </p>
              <p>© {currentYear} Veridian — Tous droits réservés</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
