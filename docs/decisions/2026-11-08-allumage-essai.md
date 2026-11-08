# Allumer le flow d'essai réel ? (08/11/2026)

État : coupé (`TRIAL_MACHINE_ENABLED` absent). Le signal de Notifuse (5e mail) est reçu et journalisé ;
aucun essai ne démarre pour un client. Mécanique prouvée sur un compte de test (batterie, cas 12).

## Ce qui se passe, jour par jour (textes réécrits le 08/11, `c7add21`)

La fin d'essai ne bloque rien : lecture seule coupée dans toutes les apps, aucune limite, aucun débit.
Les mails et le bandeau le disent désormais (avant : « lecture seule » et « 30 jours offerts », faux).

| Quand | Ce que fait le Hub | Ce que voit le client |
|---|---|---|
| 5e mail envoyé (Notifuse) | ligne `eligible`, rien de visible | rien |
| J+2 | essai Pro 15 j : plan `pro` poussé à Notifuse, Analytics, CRM ; Telegram à Robert | mail 1 ; bandeau « Vous êtes en essai gratuit du plan Pro. » ; dans les apps, rien |
| J+14 | rien d'autre | mail 2 ; bandeau « Votre essai Pro se termine bientôt… » |
| J+17 sans abonnement | plan `free` poussé ; Telegram à Robert ; aucun débit | mail 3 ; bandeau « Votre essai Pro est terminé : votre espace est revenu au plan gratuit. » ; dans les apps, rien ne change |
| J+17 avec abonnement Stripe | `converted`, rien ne change | rien |
| J+47 | rien | rien |

Prospection et le CMS ne sont pas touchés par la machine.

## Texte exact (lib/email/templates/trial.ts, components/dashboard/FreemiumBanner.tsx)

**Mail 1, objet « Votre essai Pro Veridian démarre aujourd'hui (15 jours) »**
> Votre essai Pro démarre aujourd'hui
> Vous utilisez activement **Veridian Mail** : nous vous offrons les **15 prochains jours en plan Pro**, sans rien à faire de votre côté.
> Votre essai se termine le **<date>**. Ensuite, votre espace revient au plan gratuit : vos données restent en place, rien n'est bloqué et rien ne vous est facturé.
> Si vous souhaitez garder le plan Pro après cette date, vous pourrez ajouter une carte depuis votre espace.
> [Voir les formules]
> Robert Brunon, Veridian

**Mail 2, objet « Votre essai Pro Veridian se termine dans 3 jours »**
> Plus que 3 jours d'essai Pro
> Votre essai Pro sur **Veridian Mail** se termine le **<date>**.
> À cette date, votre espace revient au plan gratuit. Vos données restent en place, rien n'est bloqué et aucun débit n'a lieu.
> Pour garder le plan Pro, vous pouvez ajouter une carte depuis votre espace.
> [Garder le plan Pro]
> Robert Brunon, Veridian

**Mail 3, objet « Votre essai Pro Veridian est terminé »**
> Votre essai Pro est terminé
> Votre essai Pro sur **Veridian Mail** est arrivé à son terme : votre espace est revenu au plan gratuit.
> Vos données sont intactes et vous continuez à utiliser Veridian Mail comme avant. Rien ne vous a été facturé.
> Si vous souhaitez repasser au plan Pro, c'est possible à tout moment depuis votre espace.
> [Voir les formules]
> Une question ? Écrivez-nous à contact@veridian.site.
> Robert Brunon, Veridian

**Bandeau du Hub**
- en cours : « Vous êtes en essai gratuit du plan Pro. » [Voir les formules]
- fin proche : « Votre essai Pro se termine bientôt. Votre espace reviendra ensuite au plan gratuit, sans rien bloquer. » [Garder le plan Pro]
- terminé : « Votre essai Pro est terminé : votre espace est revenu au plan gratuit. » [Voir les formules]

Pied de chaque mail : « Vous recevez cet email parce que vous avez un workspace actif sur Veridian. Gérer la facturation depuis votre dashboard. »

## Décision

Allumer : `TRIAL_MACHINE_ENABLED=1` dans la variable Nomad `nomad/jobs/hub`, puis `nomad-v run hub`.
Sans rejeu pour les espaces déjà au-delà du seuil (tranché le 08/11).
