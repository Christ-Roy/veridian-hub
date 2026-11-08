# Allumer le flow d'essai réel ? (08/11/2026)

État : coupé (`TRIAL_MACHINE_ENABLED` absent). Le signal de Notifuse (5e mail) est reçu et journalisé ;
aucun essai ne démarre pour un client. Mécanique prouvée sur un compte de test (batterie, cas 12).

## À savoir avant de décider

La fin d'essai ne bloque rien (lecture seule coupée dans toutes les apps, aucune limite), MAIS les mails
et le bandeau annoncent au client l'inverse : « mode lecture seule », « l'envoi est en pause », et un
bonus de « 30 jours supplémentaires si vous ajoutez une carte » qui n'est codé nulle part. Ils contiennent
aussi des tirets cadratins entourés d'espaces, et le bandeau du Hub tutoie.

## Ce qui se passe, jour par jour

| Quand | Ce que fait le Hub | Ce que voit le client |
|---|---|---|
| 5e mail envoyé (Notifuse) | ligne `eligible`, rien de visible | rien |
| J+2 | essai Pro 15 j : plan `pro` poussé à Notifuse, Analytics, CRM ; Telegram à Robert | mail 1 ; bandeau Hub « Tu es en essai gratuit Pro » ; dans les apps, rien (pas de limite) |
| J+14 (3 j avant la fin) | rien d'autre | mail 2 ; bandeau « Ton essai gratuit touche à sa fin… 30 jours offerts en plus » |
| J+17 sans abonnement Stripe | plan `free` poussé (`downgrade_auto`) ; Telegram à Robert ; aucun débit (pas de carte) | mail 3 ; bandeau « Ton essai gratuit est terminé. » ; dans les apps, rien ne change |
| J+17 avec abonnement Stripe | `converted`, rien ne change | rien |
| J+47 | rien : le bonus de 30 jours n'existe pas dans le code | rien |

Prospection et le CMS ne sont pas touchés par la machine.

## Texte exact des mails (lib/email/templates/trial.ts)

**Mail 1, objet « Votre essai Pro Veridian vient de démarrer (15 jours) »**
> Votre essai Pro vient de démarrer
> Bonne nouvelle : vous êtes activement en train de tirer parti de **Notifuse**, on vous offre donc les
> **15 prochains jours en plan Pro** — illimité partout, sans rien à faire de plus.
> Le trial expire le **<date>**. Si vous ajoutez une carte avant cette date, on vous offre **30 jours
> supplémentaires inconditionnels** en bonus (même si vous retirez la carte ensuite).
> [Ajouter ma carte]
> Pas envie ? Aucun souci. Pendant ces 15 jours profitez sans pression, on ne facture rien sans carte.

**Mail 2, objet « Plus que 3 jours sur votre essai Pro Veridian »**
> Plus que 3 jours sur votre essai Pro
> Votre essai sur **Notifuse** expire le **<date>**.
> Pour continuer sans interruption, ajoutez votre carte. En bonus, on vous offre **30 jours
> inconditionnels supplémentaires** à partir du moment où la carte est ajoutée — même si vous la retirez ensuite.
> [Ajouter ma carte]
> Si vous ne faites rien, votre workspace bascule en mode lecture seule. Vos données restent, vous pouvez
> réactiver à tout moment.

**Mail 3, objet « Votre essai Pro Veridian est terminé »**
> Votre essai Pro est terminé
> Votre essai **Notifuse** est arrivé à son terme. Votre workspace bascule en **mode lecture seule** : vos
> données restent intactes, mais l'envoi / la création de nouveau contenu est en pause.
> Vous pouvez réactiver le plan Pro à tout moment, on remet votre workspace d'aplomb instantanément.
> [Réactiver mon workspace]
> Merci d'avoir testé Veridian — et n'hésitez pas à nous écrire si vous avez besoin d'un coup de main.

## Reco

Ne pas allumer en l'état. D'abord réécrire les 3 mails et le bandeau : vouvoiement, sans tiret cadratin,
sans promettre la lecture seule ni le bonus de 30 jours tant qu'ils ne sont pas codés. Ensuite allumer :
`TRIAL_MACHINE_ENABLED=1` dans la variable Nomad `nomad/jobs/hub`, puis `nomad-v run hub`.
