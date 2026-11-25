# Brancher le Google ou le Microsoft d'un client : les gestes exacts

Ouvert depuis le 25/11/2026 (VER-227 S2). Rien à payer. Une fois par client. Tout le reste est fait par la commande `hub org idp`.

À garder sous la main, donnés par `hub org idp <tenant>` :
- l'adresse de retour : `https://app.veridian.site/api/auth/federation/callback`
- le lien de connexion du client : `https://app.veridian.site/connexion/<organisation>`

## Google Workspace (5 minutes, par l'administrateur Google du CLIENT)

1. Ouvrir https://console.cloud.google.com/projectcreate, nom « Veridian », Créer.
2. https://console.cloud.google.com/auth/overview : Commencer, nom « Veridian », audience **Interne** (seuls les comptes de ce Workspace), Créer.
3. https://console.cloud.google.com/auth/clients : Créer un client, type **Application Web**, nom « Veridian ».
4. « URI de redirection autorisés », Ajouter : `https://app.veridian.site/api/auth/federation/callback`, Créer.
5. Nous donner l'**ID client** et le **code secret** (fenêtre affichée une seule fois).

Nous : `hub org idp <tenant> poser --issuer https://accounts.google.com --client-id <ID> --domaines client.fr` (le secret sur l'entrée standard).
Un compte Google personnel qui porte une adresse du client est refusé : seul un compte GÉRÉ par le domaine entre (`hd`).

## Microsoft Entra (5 minutes, par l'administrateur Microsoft du CLIENT)

1. Ouvrir https://entra.microsoft.com, Identité, Applications, **Inscriptions d'applications**, Nouvelle inscription.
2. Nom « Veridian », « Comptes dans cet annuaire **uniquement** », URI de redirection **Web** :
   `https://app.veridian.site/api/auth/federation/callback`, S'inscrire.
3. Page Vue d'ensemble : nous donner l'**ID d'application** et l'**ID de l'annuaire**.
4. Certificats et secrets, Nouveau secret client, 24 mois : nous donner la **Valeur** (affichée une seule fois).
5. Configuration du jeton, Ajouter une revendication facultative, **ID**, cocher **email**, Ajouter, accepter la permission proposée.

Nous : `hub org idp <tenant> poser --issuer https://login.microsoftonline.com/<ID annuaire>/v2.0 --client-id <ID> --domaines client.fr`.
Le secret expire dans 24 mois : le rejouer avant.

## Autre fournisseur (Okta, Keycloak, Authentik, Zitadel…)

Une application « OIDC, Web », code avec PKCE, la même adresse de retour. Nous donner l'adresse de l'émetteur, l'ID et le secret.

## Ensuite

- `hub org importer <tenant> membres.csv` : les personnes attendues, sans aucun mail. Ou `--creation-auto` : tout le domaine entre.
- Donner au client son lien de connexion. Une personne qui a déjà un compte se connecte une fois comme d'habitude, puis par ce lien : il est relié.
- Couper : `hub org idp <tenant> retirer` (la porte se ferme, les comptes restent) ; une personne : `hub membre retirer`.

Pas encore prouvé avec un vrai Google ni un vrai Microsoft : l'épreuve (cas 30) joue un fournisseur OIDC réel mais jetable. SAML : pas écrit.
