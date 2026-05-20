import { Metadata } from 'next';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';

export const metadata: Metadata = {
  title: 'Politique de Confidentialité | Veridian',
  description:
    'Politique de confidentialité de la plateforme Veridian — données collectées, finalités, base légale RGPD, droits utilisateurs, sous-traitants.',
  openGraph: {
    title: 'Politique de Confidentialité | Veridian',
    description:
      'Politique de confidentialité de la plateforme Veridian — RGPD, OAuth Google/Microsoft, sous-traitants.',
  },
  alternates: {
    canonical: 'https://app.veridian.site/privacy',
  },
};

/**
 * POLITIQUE DE CONFIDENTIALITÉ — page dédiée.
 *
 * Conforme RGPD (UE 2016/679) + LIL (Loi Informatique et Libertés FR).
 * URL : https://app.veridian.site/privacy (à utiliser comme "Privacy policy
 * URL" dans Google OAuth Consent Screen + Microsoft Entra Publisher
 * Verification + Stripe Compliance + brand verification).
 *
 * Document scindé de /terms (CGV/CGU) et /legal (mentions légales) à la
 * demande de Robert pour clarté et conformité — l'URL dédiée est exigée
 * par plusieurs plateformes (Google, Stripe, Apple, etc.) qui n'acceptent
 * pas une URL combinée et la jugent comme un signal de sérieux RGPD.
 */
export default function PrivacyPage() {
  const currentYear = new Date().getFullYear();
  const lastUpdated = new Date('2026-05-21').toLocaleDateString('fr-FR');

  return (
    <div className="container max-w-4xl py-12 px-4">
      <div className="space-y-8">
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-bold tracking-tight">
            Politique de Confidentialité
          </h1>
          <p className="text-muted-foreground">
            Dernière mise à jour : {lastUpdated}
          </p>
        </div>

        <Card>
          <CardContent className="pt-6 space-y-8 text-sm leading-relaxed">
            {/* ============================================================ */}
            <section id="responsable">
              <h2 className="text-2xl font-semibold mb-4">
                1. Responsable du traitement
              </h2>
              <div className="space-y-2 text-muted-foreground">
                <p>
                  Le responsable du traitement des données collectées sur la
                  plateforme Veridian est :
                </p>
                <ul className="list-none pl-4 space-y-1">
                  <li>
                    <strong>Veridian</strong> (Entreprise individuelle)
                  </li>
                  <li>SIREN : 980 837 660</li>
                  <li>SIRET : 980 837 660 00011</li>
                  <li>Adresse : 29 Rue Lanterne, 69001 Lyon, France</li>
                  <li>
                    Contact :{' '}
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
            <section id="donnees-collectees">
              <h2 className="text-2xl font-semibold mb-4">
                2. Données collectées
              </h2>
              <div className="space-y-4 text-muted-foreground">
                <div>
                  <h3 className="font-semibold mb-2 text-foreground">
                    2.1. Données fournies par l'utilisateur
                  </h3>
                  <ul className="list-disc pl-6 space-y-1">
                    <li>
                      Email professionnel (création de compte, communications
                      transactionnelles)
                    </li>
                    <li>
                      Nom et prénom (affichage dans le tableau de bord et les
                      emails)
                    </li>
                    <li>
                      Mot de passe (hashé via bcrypt, jamais stocké en clair —
                      uniquement si signup par email/mot de passe)
                    </li>
                    <li>
                      Informations de paiement (traitées exclusivement par
                      Stripe, jamais stockées sur nos serveurs)
                    </li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold mb-2 text-foreground">
                    2.2. Données collectées via OAuth Google
                  </h3>
                  <p>
                    Lorsque vous vous connectez avec votre compte Google,
                    Veridian collecte uniquement :
                  </p>
                  <ul className="list-disc pl-6 space-y-1 mt-2">
                    <li>
                      Votre <strong>email vérifié</strong> Google (scope{' '}
                      <code>email</code>)
                    </li>
                    <li>
                      Votre <strong>nom et prénom</strong> (scope{' '}
                      <code>profile</code>)
                    </li>
                    <li>
                      Votre <strong>photo de profil publique</strong> (scope{' '}
                      <code>profile</code>)
                    </li>
                    <li>
                      Votre <strong>identifiant Google unique</strong> (scope{' '}
                      <code>openid</code>) pour reconnecter votre compte aux
                      futures sessions
                    </li>
                  </ul>
                  <p className="mt-2">
                    Veridian <strong>n'accède PAS</strong> à votre Gmail, Drive,
                    Calendar, Contacts ou tout autre service Google. Les scopes
                    demandés sont strictement limités aux informations
                    d'identification publiques (
                    <code>openid email profile</code>).
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold mb-2 text-foreground">
                    2.3. Données collectées via OAuth Microsoft
                  </h3>
                  <p>
                    Lorsque vous vous connectez avec votre compte Microsoft
                    (Outlook, Hotmail, Live, ou Microsoft 365 Work/School),
                    Veridian collecte :
                  </p>
                  <ul className="list-disc pl-6 space-y-1 mt-2">
                    <li>
                      Votre <strong>email vérifié</strong> Microsoft
                    </li>
                    <li>
                      Votre <strong>nom complet</strong>
                    </li>
                    <li>
                      Votre <strong>identifiant Microsoft Entra</strong> (Object
                      ID) pour reconnecter votre compte
                    </li>
                  </ul>
                  <p className="mt-2">
                    Veridian <strong>n'accède PAS</strong> à votre Outlook,
                    OneDrive, Teams, SharePoint ou tout autre service
                    Microsoft. Aucun scope étendu n'est demandé.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold mb-2 text-foreground">
                    2.4. Données collectées automatiquement
                  </h3>
                  <ul className="list-disc pl-6 space-y-1">
                    <li>
                      Adresse IP (logs sécurité, anti-abuse, audit)
                    </li>
                    <li>
                      Horodatage des connexions et actions sensibles (audit
                      forensics)
                    </li>
                    <li>
                      User-Agent du navigateur (compatibilité et stats
                      anonymisées)
                    </li>
                    <li>
                      Cookies de session strictement nécessaires (Auth.js JWT,
                      durée 90 jours)
                    </li>
                  </ul>
                </div>
              </div>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="finalites">
              <h2 className="text-2xl font-semibold mb-4">
                3. Finalités du traitement
              </h2>
              <div className="space-y-2 text-muted-foreground">
                <p>Vos données sont traitées exclusivement pour :</p>
                <ul className="list-disc pl-6 space-y-1">
                  <li>
                    Créer et gérer votre compte Veridian (identification,
                    authentification, récupération de mot de passe)
                  </li>
                  <li>
                    Fournir les services SaaS souscrits (Notifuse, Prospection,
                    Analytics, CMS, et leurs intégrations)
                  </li>
                  <li>
                    Traiter les paiements et facturations (via Stripe
                    uniquement)
                  </li>
                  <li>
                    Envoyer les emails transactionnels (vérification, magic
                    link, notifications produit) — JAMAIS de marketing sans
                    consentement explicite séparé
                  </li>
                  <li>
                    Sécuriser la plateforme (détection d'abus, audit forensics,
                    rate-limiting)
                  </li>
                  <li>
                    Respecter nos obligations légales (comptabilité,
                    réquisitions judiciaires)
                  </li>
                </ul>
                <p className="mt-2">
                  <strong>
                    Vos données ne sont JAMAIS revendues, JAMAIS partagées avec
                    des tiers à des fins publicitaires.
                  </strong>
                </p>
              </div>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="base-legale">
              <h2 className="text-2xl font-semibold mb-4">
                4. Base légale (RGPD article 6)
              </h2>
              <div className="space-y-2 text-muted-foreground">
                <ul className="list-disc pl-6 space-y-2">
                  <li>
                    <strong>Exécution du contrat</strong> (art. 6.1.b) :
                    fourniture des services SaaS souscrits, gestion de votre
                    compte, traitement des paiements
                  </li>
                  <li>
                    <strong>Consentement</strong> (art. 6.1.a) : signup OAuth
                    Google/Microsoft (vous autorisez explicitement le partage
                    de votre profil), envoi d'emails marketing optionnels
                  </li>
                  <li>
                    <strong>Intérêt légitime</strong> (art. 6.1.f) : sécurité de
                    la plateforme (logs, audit, anti-abuse), amélioration des
                    services
                  </li>
                  <li>
                    <strong>Obligation légale</strong> (art. 6.1.c) :
                    conservation des données de facturation (10 ans, Code de
                    commerce art. L123-22), réponse aux réquisitions judiciaires
                  </li>
                </ul>
              </div>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="duree-conservation">
              <h2 className="text-2xl font-semibold mb-4">
                5. Durée de conservation
              </h2>
              <div className="space-y-2 text-muted-foreground">
                <ul className="list-disc pl-6 space-y-1">
                  <li>
                    <strong>Compte utilisateur actif</strong> : tant que le
                    compte existe
                  </li>
                  <li>
                    <strong>Compte supprimé</strong> : suppression effective
                    sous 30 jours (sauf données conservées pour obligations
                    légales)
                  </li>
                  <li>
                    <strong>Données de facturation</strong> : 10 ans (Code de
                    commerce)
                  </li>
                  <li>
                    <strong>Logs de connexion</strong> : 12 mois (LCEN art.
                    L34-1 du Code des postes et communications électroniques)
                  </li>
                  <li>
                    <strong>Logs d'audit (actions admin)</strong> : 36 mois
                  </li>
                  <li>
                    <strong>Cookies session</strong> : 90 jours maximum
                  </li>
                </ul>
              </div>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="droits">
              <h2 className="text-2xl font-semibold mb-4">
                6. Vos droits (RGPD)
              </h2>
              <div className="space-y-2 text-muted-foreground">
                <p>Conformément au RGPD, vous disposez des droits suivants :</p>
                <ul className="list-disc pl-6 space-y-1">
                  <li>
                    <strong>Droit d'accès</strong> (art. 15) : obtenir copie de
                    toutes les données vous concernant
                  </li>
                  <li>
                    <strong>Droit de rectification</strong> (art. 16) : corriger
                    une donnée inexacte
                  </li>
                  <li>
                    <strong>Droit à l'effacement</strong> (art. 17, "droit à
                    l'oubli") : supprimer votre compte et vos données
                  </li>
                  <li>
                    <strong>Droit à la portabilité</strong> (art. 20) : récupérer
                    vos données dans un format machine-readable (JSON)
                  </li>
                  <li>
                    <strong>Droit d'opposition</strong> (art. 21) : refuser un
                    traitement basé sur l'intérêt légitime
                  </li>
                  <li>
                    <strong>Droit à la limitation</strong> (art. 18)
                  </li>
                  <li>
                    <strong>Droit de retirer votre consentement</strong> à tout
                    moment (sans effet rétroactif)
                  </li>
                  <li>
                    <strong>Droit d'introduire une réclamation auprès de la
                    CNIL</strong>{' '}
                    (
                    <a
                      href="https://www.cnil.fr/fr/plaintes"
                      className="text-primary underline"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      cnil.fr/fr/plaintes
                    </a>
                    )
                  </li>
                </ul>
                <p className="mt-3">
                  Pour exercer ces droits, contactez-nous à :{' '}
                  <a
                    href="mailto:robert.brunon@veridian.site"
                    className="text-primary underline"
                  >
                    robert.brunon@veridian.site
                  </a>
                  . Réponse sous 30 jours maximum.
                </p>
              </div>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="sous-traitants">
              <h2 className="text-2xl font-semibold mb-4">
                7. Sous-traitants
              </h2>
              <div className="space-y-2 text-muted-foreground">
                <p>
                  Veridian fait appel aux sous-traitants suivants pour fournir
                  ses services. Chaque sous-traitant est lié par un accord de
                  traitement de données (DPA) conforme RGPD.
                </p>
                <ul className="list-disc pl-6 space-y-2 mt-2">
                  <li>
                    <strong>Stripe Payments Europe Ltd</strong> (Irlande) —
                    traitement des paiements. Certifié PCI-DSS Level 1. DPA :
                    stripe.com/legal/dpa
                  </li>
                  <li>
                    <strong>Google LLC</strong> (USA) — authentification OAuth
                    Google. Clauses Contractuelles Types UE + EU-US Data
                    Privacy Framework
                  </li>
                  <li>
                    <strong>Microsoft Corporation</strong> (USA) —
                    authentification OAuth Microsoft Entra. Clauses
                    Contractuelles Types UE + EU-US Data Privacy Framework
                  </li>
                  <li>
                    <strong>Cloudflare, Inc.</strong> (USA) — protection DDoS,
                    DNS, CDN. Clauses Contractuelles Types UE
                  </li>
                  <li>
                    <strong>OVH SAS</strong> (France) — hébergement des serveurs
                    de production (datacenter UE)
                  </li>
                  <li>
                    <strong>Notifuse</strong> (auto-hébergé chez OVH) — envoi
                    d'emails transactionnels (fork open source)
                  </li>
                </ul>
                <p className="mt-3">
                  Tous les sous-traitants sont soit situés dans l'Union
                  Européenne, soit liés par des Clauses Contractuelles Types
                  approuvées par la Commission Européenne pour garantir un
                  niveau de protection adéquat.
                </p>
              </div>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="transferts">
              <h2 className="text-2xl font-semibold mb-4">
                8. Transferts hors UE
              </h2>
              <div className="space-y-2 text-muted-foreground">
                <p>
                  Certaines données peuvent être transférées vers les
                  États-Unis dans le cadre de l'authentification OAuth (Google,
                  Microsoft) ou de la protection DDoS (Cloudflare). Ces
                  transferts sont encadrés par :
                </p>
                <ul className="list-disc pl-6 space-y-1 mt-2">
                  <li>
                    Les <strong>Clauses Contractuelles Types</strong> (CCT)
                    approuvées par la Commission Européenne (décision
                    2021/914/UE)
                  </li>
                  <li>
                    Le <strong>EU-US Data Privacy Framework</strong> (adéquation
                    Commission Européenne du 10 juillet 2023) pour les
                    sous-traitants américains certifiés (Google, Microsoft,
                    Cloudflare)
                  </li>
                </ul>
              </div>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="securite">
              <h2 className="text-2xl font-semibold mb-4">9. Sécurité</h2>
              <div className="space-y-2 text-muted-foreground">
                <p>
                  Veridian met en œuvre des mesures de sécurité techniques et
                  organisationnelles appropriées pour protéger vos données :
                </p>
                <ul className="list-disc pl-6 space-y-1">
                  <li>
                    Chiffrement TLS 1.3 de toutes les communications
                    (HSTS forcé 6 mois)
                  </li>
                  <li>
                    Chiffrement des mots de passe (bcrypt cost 12, jamais en
                    clair)
                  </li>
                  <li>
                    Authentification à 2 facteurs optionnelle (code email,
                    durée 10 min)
                  </li>
                  <li>
                    Headers HTTP de sécurité (CSP, X-Frame-Options, Referrer
                    Policy strict-origin)
                  </li>
                  <li>
                    Audit de sécurité automatisé en CI (CVE, secrets, OWASP
                    Top 10)
                  </li>
                  <li>
                    Rate-limiting sur les routes d'authentification et
                    d'inscription (anti brute-force)
                  </li>
                  <li>
                    Backup quotidien chiffré des bases de données
                  </li>
                  <li>
                    Logs d'audit immutables des actions sensibles (création de
                    compte, modification de permissions, paiements)
                  </li>
                </ul>
              </div>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="cookies">
              <h2 className="text-2xl font-semibold mb-4">10. Cookies</h2>
              <div className="space-y-2 text-muted-foreground">
                <p>
                  Veridian utilise uniquement des cookies <strong>strictement
                  nécessaires</strong> au fonctionnement du service. Aucun
                  cookie de tracking publicitaire, aucun cookie tiers à des
                  fins marketing.
                </p>
                <ul className="list-disc pl-6 space-y-1 mt-2">
                  <li>
                    <code>authjs.session-token</code> : cookie de session
                    (HTTPOnly, Secure, SameSite=Lax, 90 jours)
                  </li>
                  <li>
                    <code>authjs.csrf-token</code> : protection CSRF (HTTPOnly,
                    Secure)
                  </li>
                  <li>
                    <code>authjs.callback-url</code> : URL de redirection
                    post-login (HTTPOnly)
                  </li>
                </ul>
                <p className="mt-2">
                  Aucun bandeau cookies n'est requis car nous n'utilisons aucun
                  cookie soumis au consentement (RGPD art. 7 + Délibération CNIL
                  2020-091).
                </p>
              </div>
            </section>

            <hr />

            {/* ============================================================ */}
            <section id="modifications">
              <h2 className="text-2xl font-semibold mb-4">
                11. Modifications de la politique
              </h2>
              <div className="space-y-2 text-muted-foreground">
                <p>
                  Cette politique peut être mise à jour pour refléter des
                  évolutions légales ou des changements dans nos services. La
                  date de "Dernière mise à jour" en haut de page indique la
                  version courante. Les modifications substantielles vous
                  seront notifiées par email avant prise d'effet.
                </p>
              </div>
            </section>

            {/* Footer */}
            <div className="pt-6 text-center text-muted-foreground text-xs space-y-2">
              <p>
                Pages associées :{' '}
                <Link href="/terms" className="text-primary underline">
                  Conditions d'utilisation
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
