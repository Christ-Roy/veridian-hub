# [HUB] Dashboard : le workspace d'un client sans site web est affiché comme une "agence web"

> **Sévérité** : 🟡 P2 (image/positionnement — perçu comme pas sérieux en démo)
> **Owner** : agent veridian-hub
> **Créé** : 2026-07-06 par agent (demande Robert, démo Céline Gaetan)

## Symptôme (mots de Robert)
« Il aurait fallu que le workspace de Céline ne soit pas affiché comme une agence web. »

Le dashboard Hub (`app/dashboard/page.tsx`) affiche pour TOUS les tenants une section
**« Inclus avec votre site web »** avec les cartes **Veridian Analytics** et **Veridian CMS**
(« Cet outil est inclus avec votre site web Veridian », « Modifiez votre site vous-même... »).

Pour un client comme Céline (conseillère immobilière, cliente emailing + prospection, **sans site
web Veridian hébergé chez nous**), ces cartes n'ont aucun sens et donnent l'impression d'un
template générique d'agence web mal configuré.

## Cause
Les cartes Analytics/CMS sont montées inconditionnellement (`showActiveAnalytics` /
`showActiveCms` sont true par défaut ou via `hasLifetimeSiteVitrine`), sans tenir compte du fait
que le client n'a pas souscrit à un site web Veridian. La section « Inclus avec votre site web »
s'affiche même quand le tenant n'a aucun service site-web.

## Fix proposé
Conditionner la section « Inclus avec votre site web » à la présence réelle d'un service site-web
lié au tenant (ex : un flag `hasSiteVitrine` / un service CMS ou Analytics réellement provisionné),
pas l'afficher par défaut. Pour un tenant emailing+prospection pur, n'afficher que ses outils
actifs (Prospection, Mail) sans la section site-web.

Idéalement : rendre le dashboard **modulaire par profil de client** (le workspace ne doit pas
présumer que tout le monde est une agence web / a un site Veridian).

## Repro
Se connecter au dashboard d'un tenant sans site web (ex Céline
`fde9285d-70a8-4634-9ea9-f8fc495aebdf`) → la section « Inclus avec votre site web » s'affiche à tort.
