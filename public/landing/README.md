# Images de la Landing Page

Ce dossier contient les images utilisées par la landing page.

## Images requises

### 1. `hero-dashboard.png`
**Emplacement**: `/public/landing/hero-dashboard.png`
**Utilisé dans**: `hero-section.tsx` (image principale en haut de page)
**Dimensions**: 1920x1080px minimum
**Format**: PNG (avec fond transparent) ou JPG
**Contenu suggéré**:
- Screenshot du dashboard principal de la plateforme
- Graphiques, tableaux de bord, métriques visibles
- Données fictives réalistes
- Interface claire et professionnelle

**Ligne de code**:
```tsx
<Image src="/landing/hero-dashboard.png" alt="Dashboard de la plateforme - Interface CRM et Mail Automation" width={1920} height={1080} />
```

---

### 2. `crm-interface.png`
**Emplacement**: `/public/landing/crm-interface.png`
**Utilisé dans**: `features-section.tsx` (section CRM)
**Dimensions**: 1600x900px minimum
**Format**: PNG ou JPG
**Contenu suggéré**:
- **Option A**: Tableau de contacts (nom, email, statut, tags, actions)
- **Option B**: Vue Kanban du pipeline de ventes avec deals/opportunités
- **Option C**: Page de détail d'un contact avec historique complet
- Interface moderne avec données fictives

**Ligne de code**:
```tsx
<Image src="/landing/crm-interface.png" alt="Interface CRM - Gestion des contacts et pipeline de ventes" width={1600} height={900} />
```

---

### 3. `mail-automation-interface.png`
**Emplacement**: `/public/landing/mail-automation-interface.png`
**Utilisé dans**: `features-section.tsx` (section Mail Automation)
**Dimensions**: 1600x900px minimum
**Format**: PNG ou JPG
**Contenu suggéré**:
- **Option A**: Éditeur drag & drop d'emails avec preview en temps réel
- **Option B**: Dashboard des campagnes email (stats, taux d'ouverture, clics)
- **Option C**: Builder de workflow automation (trigger → actions → conditions)
- Templates d'emails visibles ou analytics détaillés

**Ligne de code**:
```tsx
<Image src="/landing/mail-automation-interface.png" alt="Interface Mail Automation - Éditeur de campagnes et analytics" width={1600} height={900} />
```

---

## Instructions pour ajouter les images

1. **Créer/trouver les screenshots**:
   - Prendre des screenshots de ton dashboard actuel avec données fictives
   - OU utiliser des mockups/prototypes Figma
   - OU générer avec des outils de design (Canva, etc.)

2. **Optimiser les images** (recommandé):
   ```bash
   # Installer imagemagick si besoin
   sudo apt install imagemagick

   # Compresser une image PNG
   convert input.png -quality 85 -resize 1920x1080 output.png

   # OU utiliser des outils en ligne comme TinyPNG
   ```

3. **Placer les fichiers**:
   ```bash
   # Copier tes images dans ce dossier
   cp ~/mes-screenshots/dashboard.png /home/ubuntu/twenty-saas/00-Global-saas/app/Web-Dashboard/public/landing/hero-dashboard.png
   cp ~/mes-screenshots/crm.png /home/ubuntu/twenty-saas/00-Global-saas/app/Web-Dashboard/public/landing/crm-interface.png
   cp ~/mes-screenshots/mail.png /home/ubuntu/twenty-saas/00-Global-saas/app/Web-Dashboard/public/landing/mail-automation-interface.png
   ```

4. **Vérifier** que Next.js les affiche:
   - Redémarrer le serveur dev si nécessaire: `npm run dev`
   - Visiter `http://localhost:3000/`
   - Les images doivent s'afficher dans la landing page

---

## Placeholders actuels

Pour l'instant, les images ont un **placeholder avec gradient** (div avec `bg-gradient-to-br from-primary/10...`).

Quand tu ajouteras les vraies images, elles remplaceront automatiquement ces placeholders.

---

## Notes techniques

- Next.js `<Image>` optimise automatiquement les images (lazy loading, responsive, WebP)
- Les dimensions `width` et `height` sont importantes pour éviter le layout shift
- Le paramètre `priority` est utilisé pour `hero-dashboard.png` car c'est l'image principale above-the-fold
- Les chemins commencent par `/` car ils sont relatifs au dossier `/public`

---

## Besoin d'aide ?

Si tu n'as pas encore de screenshots, tu peux:
1. **Temporairement** laisser les placeholders gradient (ils sont stylisés)
2. Utiliser des images de stock gratuites (Unsplash, Pexels)
3. Générer des mockups avec Figma/Adobe XD
4. Me demander de créer des composants React qui simulent les interfaces (au lieu d'images statiques)
