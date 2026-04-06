# Scripts de Développement

⚠️ **ATTENTION : Ces scripts sont UNIQUEMENT pour le développement local !**

## 🔐 Sécurité

- Ces scripts utilisent `SUPABASE_SERVICE_ROLE_KEY` (accès administrateur complet)
- Ils ne fonctionnent **QUE** si `NODE_ENV=development`
- **NE JAMAIS** utiliser en production
- **NE JAMAIS** committer avec des credentials hardcodés

## 📋 Scripts Disponibles

### `test-provisioning.mjs`

Teste le provisioning complet d'un utilisateur (Twenty + Notifuse).

**Usage:**
```bash
node scripts/dev/test-provisioning.mjs <email> <password>
```

**Exemple:**
```bash
node scripts/dev/test-provisioning.mjs test@example.com MyPassword123
```

**Ce qu'il fait:**
1. Crée un utilisateur de test dans Supabase Auth
2. Appelle la fonction `provisionTenants()` directement
3. Affiche les résultats détaillés (workspace IDs, API keys, etc.)
4. Vérifie que tout est bien stocké dans Supabase

**Quand l'utiliser:**
- Tester le provisioning sans passer par le signup web
- Débugger des erreurs de provisioning
- Vérifier que les API keys sont bien stockées
- Tester avec différents emails/passwords

## 🚫 Scripts à NE PAS utiliser en Production

**Tous les scripts de ce dossier sont marqués comme dev-only.**

Si vous essayez de les lancer en production:
```bash
❌ ERROR: This script is for development only!
   Set NODE_ENV=development to run this script.
```

## 📝 Variables d'Environnement Requises

Les scripts utilisent les variables du fichier `.env.local`:

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=http://api.51.210.7.44.nip.io
SUPABASE_SERVICE_ROLE_KEY=eyJhbG...  # ⚠️ Service role (admin)

# Services
TWENTY_GRAPHQL_URL=http://twenty.51.210.7.44.nip.io/graphql
TWENTY_METADATA_URL=http://twenty.51.210.7.44.nip.io/metadata
NOTIFUSE_API_URL=http://notifuse.51.210.7.44.nip.io/api
NOTIFUSE_ROOT_EMAIL=brunon5robert@gmail.com

# Dev
NODE_ENV=development  # ⚠️ Obligatoire
```

## 💡 Tips

### Nettoyer les utilisateurs de test

```bash
# Via Supabase Studio
http://studio.51.210.7.44.nip.io/project/default/auth/users

# Ou via SQL
psql -U postgres -d postgres
DELETE FROM auth.users WHERE email LIKE 'test%';
DELETE FROM public.tenants WHERE user_id NOT IN (SELECT id FROM auth.users);
```

### Tester avec un email jetable

```bash
# Générer un email unique
node scripts/dev/test-provisioning.mjs "test-$(date +%s)@example.com" TestPassword123
```

### Débugger les logs de provisioning

Les logs détaillés sont affichés dans la console avec des émojis:
- 🚀 Début d'étape
- ✅ Succès
- ⚠️  Avertissement
- ❌ Erreur

## 🔄 Workflow de Développement Recommandé

1. **Tester le provisioning isolément**
   ```bash
   node scripts/dev/test-provisioning.mjs test@example.com MyPassword123
   ```

2. **Vérifier dans Supabase Studio**
   - Aller sur http://studio.51.210.7.44.nip.io
   - Table `tenants` → Vérifier que les données sont là

3. **Tester via le dashboard web**
   - http://localhost:3000/signup
   - S'inscrire avec le même email
   - Aller sur /dashboard
   - Vérifier que les tenants sont visibles

4. **Nettoyer après les tests**
   ```sql
   DELETE FROM public.tenants WHERE user_id IN (
     SELECT id FROM auth.users WHERE email LIKE 'test%'
   );
   DELETE FROM auth.users WHERE email LIKE 'test%';
   ```

## ⚠️ Troubleshooting

### "This script is for development only"

**Solution:**
```bash
export NODE_ENV=development
node scripts/dev/test-provisioning.mjs ...
```

### "SUPABASE_SERVICE_ROLE_KEY not set"

**Solution:**
```bash
# Vérifier le fichier .env.local
cat .env.local | grep SERVICE_ROLE_KEY

# Ou export manuel
export SUPABASE_SERVICE_ROLE_KEY=eyJhbG...
```

### "User already exists"

C'est normal ! Le script récupère l'utilisateur existant et continue le test.

### "Provisioning failed"

Regarder les logs détaillés au-dessus de l'erreur. Ils indiquent:
- Quelle étape a échoué (Twenty SignUp, Notifuse Workspace, etc.)
- Le message d'erreur exact
- La stack trace

## 📖 Documentation de Référence

- [Twenty API](../app/dashboard/poc/TWENTY_TOOLKIT_USAGE.md)
- [Notifuse API](../../app/Notifuse/custom-doc/03-tenant-provisioning.md)
- [POC Dashboard](../app/dashboard/poc/CLAUDE.md)
