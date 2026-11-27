# Dérogation : le job `hub` reste à UNE instance (VER-270, 27/11/2026)

Décision : **pas de `count = 2` pour le groupe `stack`** pour l'instant. Le jobspec n'est pas modifié.
Pourquoi : des états tenus en mémoire de processus cassent à deux instances, et deux d'entre eux
(plafonds de débit, un programme par compte) ne se corrigent pas sans migration ou sans refonte du
programme. Les corriger d'ici serait un changement de schéma et de comportement à valider, pas un correctif.

## Audit (sûr ou cassé à deux)

| Point | Verdict | Preuve | Correction |
|---|---|---|---|
| Rejeu du jeton d'identité IA (jti) | **cassé, corrigé** | `lib/ia/fournisseur.ts` : la `Map` `vus` devient `consommerJtiIa` (table `delegation_nonces`, clé `ia-jti:`) | fait dans ce lot, test `__tests__/lib/ia/fournisseur.test.ts` « jti rejoué sur une AUTRE instance » (vu échouer avant le correctif) |
| Limites de débit par IP (dont `deborde` et le compte des échecs admin) | **corrigé (VER-270)** | table `hub_app.compteurs_fenetre` (migration `20261127120000_compteurs_fenetre`), fenêtre glissante à deux compartiments, une écriture atomique par appel (`lib/auth/compteurs.ts`) ; panne = refus fermé. Preuve : `__tests__/integration/compteurs-deux-instances.test.ts` sur PostgreSQL 16 : vert ; sabotage atomicité rouge (12 acceptés pour 5) ; ancien code en mémoire rouge (10 pour 5). | levée par la parente après preuve en prod |
| Un programme à la fois par compte, budget d'appels par minute | **corrigé (VER-270)** | verrou `pg_try_advisory_lock` sur connexion dédiée, hors pool Prisma (`lib/mcp/verrou-programme.ts`), libéré par `liberer` ou par la fermeture de la connexion ; budget dans le compteur partagé (`lib/mcp/programme.ts`). Preuve : même test à deux instances : vert ; sabotage libération rouge (second programme accepté après rendu) ; ancien code rouge (deux programmes acceptés). | levée par la parente après preuve en prod |
| Caches des outils et des échecs (5 min, 30 s) | sûr, obsolescence bornée | `lib/mcp/cache.ts:10-11`, `oublierUtilisateur` ne vide que l'instance locale | accepté : au pire 30 s « injoignable » après création d'un compte |
| Cache de l'état de facturation | sûr, obsolescence bornée | `lib/billing/billing-state.ts:71` | accepté, TTL |
| Dédoublonnage des inscriptions OAuth (`inscriptions`) | sûr | `lib/connecteurs/oauth.ts:117` : la `Map` n'est qu'un dédoublonnage ; l'unicité en base (`connecteur_retour`) et la compensation `effacerChez` tiennent | aucune |
| Renouvellement des jetons de connexion (`enCours`) | sûr | `lib/connecteurs/coffre.ts:152` : bail en base (`updateMany` CAS) | aucune |
| Jeton à usage unique de la délégation, rebond | sûr | `lib/delegation/jeton.ts` (`delegationNonce.create`, empreinte unique), `app/api/auth/bounce/complete` (consommation atomique en base) | aucune |
| Migrations au démarrage | sûr entre instances | `Dockerfile` CMD : `prisma migrate deploy`, verrou advisory de Prisma | **à traiter autrement** : une bascule bleu-vert fait tourner une nouvelle migration pendant que l'ancienne instance sert. Il faut des migrations « élargir puis resserrer » |
| `init-stripe.mjs` au démarrage | sûr | `scripts/init-stripe.mjs` : lecture Stripe puis upserts idempotents ; seul le changement de mode efface | aucune |
| Minuteries serveur | sûr | seul `setInterval` = le guet d'un appel dans `lib/mcp/programme.ts:269`. Pas d'`instrumentation.ts`. Le tick d'essai est un appel HTTP déclenché de l'extérieur (`app/api/cron/trial-tick/route.ts`), sans état mémoire | aucune. Deux ticks qui se chevauchent : pas de verrou dans `runTrialTick`, à surveiller |
| Flux en direct (SSE) | sûr | par requête (`app/api/ia/v1/chat/completions/route.ts`, `lib/mcp/client-app.ts`) | aucune |
| Jeton d'ouverture de programme (jti) | sûr **tant que** le groupe `programme` reste à `count = 1` | `programme/passerelle.mjs:49` : `vus` en mémoire, dans son propre groupe | contrainte à inscrire : ne jamais mettre ce groupe à plus d'une instance sans le corriger |

## Ce que le jobspec devra porter le jour où on passe à deux

Rien de ce qui suit n'est appliqué. Ce sont les pièces prêtes pour ce jour-là.

- Placement : `constraint` sur `${meta.role}` `set_contains` `app`. Il ne retient que `ovh-prod` (`role = "edge,app"`) et `veridian-app-01` (`role = "app"`). Les deux portent le pont pg-saas : `jobs/saas-prod/pg-saas-entree.nomad.hcl` (contrainte `^(ovh-prod|contabo-02|app-01|rise)$`). L'ancienne contrainte `ovh-prod` disparaît seulement après la correction ci-dessus.
- `spread { attribute = "${meta.zone}" }` : `ovh` pour `ovh-prod`, `app01` pour `veridian-app-01`.
- `count = 2`.
- Déjà présent et conservé : `update` (canary = 1, auto_promote, auto_revert, min_healthy_time 15 s), check HTTP sur `/api/health`, port dynamique `http` relayé par Traefik.
- **Non repris** : `shutdown_delay` de 5 à 10 s. Le jobspec mesure à 30 s : Traefik relit son catalogue toutes les 15 s et une allocation sortante doit servir pendant ce temps (commentaire de `deploy/hub.nomad.hcl`, groupe `stack`). Une valeur de 10 s recréerait les 404 de 07/11. On garde 30 s.
- Ressources à vérifier au moment du passage : un canari plus deux allocations en place, soit trois exemplaires de 320 Mio réservés (plafond 768 Mio) sur deux nœuds. Mesure non faite ici.

## Porte de sortie

Lever cette dérogation exige : les quatre points « cassé à deux » ci-dessus corrigés (ou acceptés par Robert
par écrit, plafond ×2 compris), puis `nomad-v run` par la CI, puis la mesure terrain du parcours IA et d'une bascule.
