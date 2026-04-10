# Hub — UI Review queue (solo polish)

> File d'attente de polish UI pour Robert en session standalone, hors sprint.
> Chaque nouvelle page ou composant livre par un agent team = une entree ici.
>
> **Workflow** :
> 1. Lire les entrees non cochees en ordre
> 2. `cd hub && npm run dev` (localhost:3000)
> 3. Naviguer vers l'URL, tester, polish avec Next dev
> 4. Commit direct sur `staging` (ou PR si gros changement)
> 5. Cocher l'entree, la deplacer en bas dans "Reviewed"
>
> **Conventions** :
> - Badge Veridian : couleurs du design system (voir `hub/app/globals.css`)
> - Typo : Inter pour le corps, taille consistante (text-sm par defaut)
> - Spacing : p-4/p-6 pour les cards, gap-4 pour les flex
> - Responsive : tester mobile (375px) et desktop (1440px)

---

## A reviewer

_(vide — pas de livraison UI en attente)_

**Format d'une entree** (copier-coller par les agents) :

```markdown
### [YYYY-MM-DD] Nom de la page ou du composant
- **Contexte** : livre par team lead dans sprint P1.X
- **URL dev** : http://localhost:3000/path
- **URL staging** : https://saas-hub.staging.veridian.site/path
- **Fichiers** : `hub/app/path/page.tsx`, `hub/components/X.tsx`
- **A polish** :
  - [ ] Alignement padding/spacing
  - [ ] Couleurs boutons (primary Veridian)
  - [ ] Responsive mobile
  - [ ] Loading states
  - [ ] Empty states
  - [ ] Error states
- **Screenshot** : (a prendre en solo)
- **Notes agent** : "j'ai utilise shadcn par defaut, probablement a harmoniser avec le reste du Hub"
```

---

## Reviewed (archive)

_(rien encore reviewe)_
