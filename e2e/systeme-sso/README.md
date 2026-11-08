# Batterie système SSO : le Hub est-il la source unique des utilisateurs ?

Playwright dans un vrai Chromium, contre la **prod** (Prospection, Notifuse, Rybbit/Analytics ; Twenty sur son
staging s'il est servi). Une commande :

```bash
pnpm test:systeme          # ou : bash scripts/test-systeme-sso.sh [filtre, ex. 05-]
```

Sortie : `0` tout passe · `1` au moins un ÉCHOUE · `2` au moins un NON ABOUTI.
Résultat lisible dans `e2e/systeme-sso/.run/resultat.txt` et `.json`.

## Où elle se place

Trois niveaux, du plus rapide au plus réel : la **garde** (`__tests__/contrat/`, à chaque push, sans réseau), la
**sonde** de prod (étape « Sonde identité » de `hub-ci.yml`, lectures seules, après chaque déploiement), et cette
**batterie** (vrai navigateur, comptes créés puis retirés, à la main depuis le bastion). Chaque parcours, avec son niveau
de preuve : `docs/PARCOURS-IDENTITE.md`. Si une correction touche la session, la révocation ou le rebond, rejouer la
batterie et chaque `SSO_SABOTAGE=<scénario>` concerné (il doit échouer).

## Les états

| État | Sens |
|---|---|
| ✅ PASSE | la condition est vraie, mesurée dans le navigateur |
| ❌ ÉCHOUE | une assertion est fausse sur une app dont le correctif EST servi |
| ⚪ NON ABOUTI | on n'a pas pu mesurer (compte non créé, API muette, Twenty non servi, témoin positif absent) |
| 🟡 ATTENDU ROUGE | échoue sur une image listée dans `avant` : **version servie** (relue par `nomad job inspect`) sans encore le correctif ; n'interrompt rien, affiche la version |

Le classement est dans `lib/cibles.ts` (`SERVI`) : seule une image listée dans `avant` rend un échec « attendu rouge », et toute autre version est stricte. Forcer : `SSO_APPS_CORRIGEES=notifuse,analytics`.

## Les cas

| Fichier | Ce qu'il prouve |
|---|---|
| `00-controle-echec` | chaque assertion, présentée fausse, **tombe** (et tient quand elle est vraie) |
| `00-reference` | dérives `hub reconcile` héritées, relevées avant tout compte |
| `01-arrivee` | compte à adresse prouvée : session à son e-mail et identifiant Hub, ses données |
| `02-sans-preuve` | inscription publique non confirmée : n'entre pas, aucun lien émis (témoin positif exigé) |
| `02-preuve-mail` | page du lien de preuve rendue dans un navigateur, bouton cliqué, jeton faux refusé |
| `03-liens-morts` | lien consommé / inconnu / expiré (`SSO_EXPIRY=0` ignore l expiration (TTL 10 min)) |
| `04-rebond` | session Hub ouverte : rebond sans saisie, deux fois de suite |
| `05-plan` | plan posé au Hub relu dans l'app, dans les deux sens : Prospection, Notifuse, Analytics et Twenty (découverte signée de l'app). Épreuve : `SSO_SABOTAGE=plan-analytics\|plan-twenty` |
| `05-synchro-identite` | nom et email changés au Hub, relus dans chaque app par `GET /api/hub/users` (§3.8) |
| `06-reconcile` | aucune dérive nouvelle, et aucun de nos comptes cité par l'audit d'identité |
| `07-isolation` | A ne voit rien de B ni d'un autre tenant (B = présence qui rend l'absence probante) |
| `08-session-longue` | par app : session Hub ouverte, absente, expirée (témoin non expiré à côté) ; cookie d'un an ; iframe ; anti-boucle et rebonds rapprochés ; clic sur Se déconnecter avec session Hub ouverte ; déconnexion partout et compte supprimé, cookie rejoué compris. Twenty : `HUB_URL=https://hub.staging.veridian.site`. Épreuve : `SSO_SABOTAGE=ouverte\|absente\|expiree\|logout\|partout\|supprime` doit faire échouer le scénario |
| `09-adresses` | adresse au Hub différente de celle de l'app (le cas de Robert, 08/11) : compte relié → arrivée dans son compte de l'app ; une personne à deux comptes Hub → le second lit « rattaché à un autre compte », le premier entre toujours ; compte inconnu de l'app → « pas encore d'accès » avec son adresse. Jamais un refus muet. Épreuve : `SSO_SABOTAGE=adresse-liee\|conflit\|inconnu` |
| `10-creation` | OAuth Google et Microsoft : le Hub envoie chez le fournisseur avec son adresse de retour, acceptée (`SSO_SABOTAGE=oauth-retour` doit échouer) ; création au retour NON ABOUTIE (consentement humain), prouvée au niveau contrat. Inscription pendant un déploiement : `SSO_PENDANT_DEPLOIEMENT=1 bash scripts/test-systeme-sso.sh 10-` juste après un push, sinon NON ABOUTI |
| `11-preuve-analytics` | adresse non prouvée avec un compte Analytics non relié (le cas de trois clients au 08/11) : refusé, lit le VRAI mail de preuve (groupe Lark `e2e-sso-preuve@veridian.site`, boîte de Robert), confirme, arrive connecté et relié. Épreuve : `SSO_SABOTAGE=preuve` |
| `99-nettoyage` | retrait app par app, puis `testResidue` de `hub reconcile` à zéro ; le teardown refait ce contrôle après un échec et la commande échoue s'il reste quelque chose |

## Comptes de test

Adresses `e2e-sso-<run>-<a|b|np>@veridian.site`, nom « TEST SYSTEME SSO … », créés par le chemin réel
(invitation → mot de passe → session Hub). **Aucun mail ne part** (`sendEmail: false`), jamais de compte client.
Chaque compte est noté dans `.run/comptes.jsonl` *avant* usage ; `99-nettoyage` et le `global-teardown` ne
suppriment **que** ceux-là, par `delete-tenant` (qui propage aux apps) + suppression du workspace Notifuse.

## Limites connues

- Rybbit : chemin positif vu **vert** le 08/11 (`09-adresses`, compte relié par `hub_user_id` à une autre adresse,
  session Rybbit lue à l'adresse de l'app, image `prod-96c2e60`), et vu échouer par `SSO_SABOTAGE=adresse-liee`.
- Twenty : tant que le staging n'est pas servi, NON ABOUTI ; le parcours Twenty reste à écrire.
- Le secret admin vient de `ADMIN_SECRET` ou du fichier de credentials de la machine ; il n'est jamais écrit ni affiché.
