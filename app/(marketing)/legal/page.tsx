import { Metadata } from 'next';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';

export const metadata: Metadata = {
  title: 'Mentions Légales | Veridian',
  description:
    "Mentions légales de la plateforme Veridian — éditeur, hébergeur, coordonnées, conformément à l'article 6 de la LCEN.",
  openGraph: {
    title: 'Mentions Légales | Veridian',
    description:
      "Mentions légales Veridian — éditeur, hébergeur, contact, conformément à la LCEN.",
  },
  alternates: {
    canonical: 'https://app.veridian.site/legal',
  },
};

/**
 * MENTIONS LÉGALES — page dédiée, courte et conforme LCEN art. 6.
 *
 * La politique de confidentialité a été déplacée sur /privacy.
 * Les CGU/CGV ont été déplacées sur /terms.
 *
 * Cette page conserve les ancres d'origine (#confidentialite, #cgv,
 * #remboursement, #propriete-intellectuelle, #juridiction) avec
 * redirection conceptuelle vers les pages dédiées, pour éviter de
 * casser les liens externes éventuels (Stripe, footers archivés).
 */
export default function LegalPage() {
  const currentYear = new Date().getFullYear();
  const lastUpdated = new Date('2026-05-21').toLocaleDateString('fr-FR');

  return (
    <div className="container max-w-4xl py-12 px-4">
      <div className="space-y-8">
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-bold tracking-tight">
            Mentions Légales
          </h1>
          <p className="text-muted-foreground">
            Dernière mise à jour : {lastUpdated}
          </p>
        </div>

        <Card>
          <CardContent className="pt-6 space-y-8 text-sm leading-relaxed">
            {/* ============================================================ */}
            <section id="editeur">
              <h2 className="text-2xl font-semibold mb-4">
                1. Éditeur du site
              </h2>
              <div className="space-y-2 text-muted-foreground">
                <p>Le site Veridian est édité par :</p>
                <ul className="list-none pl-4 space-y-1">
                  <li>
                    <strong>Veridian</strong> — entrepreneur individuel
                  </li>
                  <li>SIREN : 980 837 660</li>
                  <li>SIRET : 980 837 660 00011</li>
                  <li>Numéro de TVA : FR47980837660</li>
                  <li>Date de création : 1<sup>er</sup> novembre 2023</li>
                  <li>
                    Adresse :
                    <br />
                    29 Rue Lanterne
                    <br />
                    69001 Lyon
                    <br />
                    France
                  </li>
                  <li>
                    Email :{' '}
                    <a
                      href="mailto:robert.brunon@veridian.site"
                      className="text-primary underline"
                    >
                      robert.brunon@veridian.site
                    </a>
                  </li>
                </ul>
              </div>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="directeur-publication">
              <h2 className="text-2xl font-semibold mb-4">
                2. Directeur de la publication
              </h2>
              <p className="text-muted-foreground">
                Robert Brunon, en sa qualité d'entrepreneur individuel.
              </p>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="hebergement">
              <h2 className="text-2xl font-semibold mb-4">3. Hébergement</h2>
              <div className="space-y-2 text-muted-foreground">
                <p>Les serveurs de la plateforme Veridian sont hébergés par :</p>
                <ul className="list-none pl-4 space-y-1">
                  <li>
                    <strong>OVH SAS</strong>
                  </li>
                  <li>2 rue Kellermann</li>
                  <li>59100 Roubaix</li>
                  <li>France</li>
                  <li>
                    Téléphone : +33 9 72 10 10 07 —{' '}
                    <a
                      href="https://www.ovh.com"
                      className="text-primary underline"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      ovh.com
                    </a>
                  </li>
                </ul>
                <p className="mt-3">
                  Les services de protection DDoS, DNS et CDN sont fournis par{' '}
                  <strong>Cloudflare, Inc.</strong> dans le respect des Clauses
                  Contractuelles Types UE.
                </p>
              </div>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="documents-associes">
              <h2 className="text-2xl font-semibold mb-4">
                4. Documents associés
              </h2>
              <div className="space-y-3 text-muted-foreground">
                <p>
                  Veridian publie deux documents complémentaires aux présentes
                  mentions légales :
                </p>
                <ul className="list-disc pl-6 space-y-2">
                  <li>
                    <Link href="/privacy" className="text-primary underline">
                      Politique de Confidentialité
                    </Link>{' '}
                    : règles de traitement des données personnelles (RGPD),
                    cookies, droits utilisateurs, sous-traitants.
                  </li>
                  <li>
                    <Link href="/terms" className="text-primary underline">
                      Conditions générales d'utilisation et de vente (CGU/CGV)
                    </Link>{' '}
                    : règles de souscription aux abonnements, paiement,
                    rétractation, résiliation.
                  </li>
                </ul>
              </div>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="propriete-intellectuelle">
              <h2 className="text-2xl font-semibold mb-4">
                5. Propriété intellectuelle
              </h2>
              <div className="space-y-2 text-muted-foreground">
                <p>
                  L'ensemble du contenu du site Veridian (textes, images,
                  logos, code) est protégé par le Code de la propriété
                  intellectuelle. Toute reproduction ou représentation, totale
                  ou partielle, sans autorisation préalable écrite est
                  interdite et constituerait une contrefaçon sanctionnée par
                  les articles L335-2 et suivants du Code de la propriété
                  intellectuelle.
                </p>
                <p>
                  La plateforme Veridian intègre des logiciels libres et open
                  source, notamment Notifuse. Les licences applicables sont
                  disponibles sur demande à l'éditeur.
                </p>
              </div>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="signalement">
              <h2 className="text-2xl font-semibold mb-4">
                6. Signalement de contenu illicite
              </h2>
              <div className="space-y-2 text-muted-foreground">
                <p>
                  Conformément à l'article 6 de la LCEN, tout signalement de
                  contenu illicite hébergé sur la plateforme peut être adressé
                  à :{' '}
                  <a
                    href="mailto:robert.brunon@veridian.site"
                    className="text-primary underline"
                  >
                    robert.brunon@veridian.site
                  </a>
                  .
                </p>
                <p>
                  Le signalement doit comporter : la date de la notification ;
                  l'identité du notifiant ; la description précise des faits ;
                  les raisons légales du caractère illicite ; copie de la
                  correspondance adressée à l'auteur des faits litigieux le cas
                  échéant.
                </p>
              </div>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="juridiction">
              <h2 className="text-2xl font-semibold mb-4">
                7. Loi applicable et juridiction
              </h2>
              <p className="text-muted-foreground">
                Les présentes mentions légales sont régies par le droit
                français. En cas de litige, les tribunaux français seront seuls
                compétents.
              </p>
            </section>

            {/* Anciennes ancres conservées en redirections internes pour
                ne pas casser les liens externes éventuels (Stripe, etc.) */}
            <section
              id="confidentialite"
              className="text-muted-foreground text-xs"
            >
              <p>
                ↗ La politique de confidentialité a été déplacée sur{' '}
                <Link href="/privacy" className="text-primary underline">
                  /privacy
                </Link>
                .
              </p>
            </section>
            <section id="cgv" className="text-muted-foreground text-xs">
              <p>
                ↗ Les CGV ont été déplacées sur{' '}
                <Link href="/terms" className="text-primary underline">
                  /terms
                </Link>
                .
              </p>
            </section>
            <section
              id="remboursement"
              className="text-muted-foreground text-xs"
            >
              <p>
                ↗ La politique de remboursement (rétractation 14 jours) est
                consultable sur{' '}
                <Link href="/terms#retractation" className="text-primary underline">
                  /terms#retractation
                </Link>
                .
              </p>
            </section>

            {/* Footer */}
            <div className="pt-6 text-center text-muted-foreground text-xs space-y-2">
              <p>
                Pages associées :{' '}
                <Link href="/privacy" className="text-primary underline">
                  Politique de confidentialité
                </Link>
                {' · '}
                <Link href="/terms" className="text-primary underline">
                  Conditions d'utilisation
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
