# Dashboard - Analyse du Système de Provisioning des Tenants

**Date** : 23 décembre 2025
**Scope** : Analyse complète du système de création automatique des tenants Twenty CRM et Notifuse

---

## 📋 Sommaire

1. [Architecture du système](#architecture-du-système)
2. [Problèmes identifiés](#problèmes-identifiés)
3. [Solutions proposées](#solutions-proposées)
4. [Fichiers à modifier](#fichiers-à-modifier)

---

## 🏗️ Architecture du système

### Flux actuel du signup

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  User Signup    │────▶│  Supabase Auth   │────▶│  Dashboard      │
│  (LoginForm)    │     │  (server.ts)     │     │  /dashboard     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                              │                          │
                              ▼                          ▼
                       ┌──────────────────┐      ┌─────────────────┐
                       │ provisionTenants │      │  Redirect User  │
                       │  (async/bg)      │      │  (immédiat)     │
                       └──────────────────┘      └─────────────────┘
                              │
                              ▼
                       ┌──────────────────┐
                       │  Twenty CRM      │
                       │  Notifuse        │
                       │  (parallèle)     │
                       └──────────────────┘
```

### Fichiers clés

| Fichier | Lignes | Fonction |
|---------|--------|----------|
| `utils/tenants/provision.ts` | 637 | Logique provisioning principale |
| `utils/auth-helpers/server.ts` | 204-207, 223-226 | Intégration signup → provisioning |
| `components/auth/LoginForm.tsx` | 31-35 | Formulaire login |
| `components/auth/SignupForm.tsx` | 31-35 | Formulaire signup |

---

## 🐛 Problèmes identifiés

### 🔴 CRITIQUE #1 : Provisioning avant confirmation email

**Emplacement** : `utils/auth-helpers/server.ts:200-231`

**Problème** :
```typescript
// Ligne 200-207 : Session active (auto-confirm)
if (data.session) {
  if (data.user) {
    provisionTenants(email, password, data.user.id).catch((error) => {
      console.error('[SignUp] Failed to provision tenants:', error);
    });
  }
  redirectPath = getStatusRedirect('/dashboard', 'Success!', 'You are now signed in.');
}

// Ligne 220-231 : Email confirmation requis
else if (data.user) {
  provisionTenants(email, password, data.user.id).catch((error) => {
    console.error('[SignUp] Failed to provision tenants:', error);
  });
  redirectPath = getStatusRedirect('/', 'Success!', 'Please check your email...');
}
```

**Risque** :
- Les tenants sont créés **avant** que l'utilisateur confirme son email
- N'importe qui peut créer des tenants avec des emails jetables
- Gaspillage de ressources (workspaces Twenty, workspaces Notifuse)

**Solution attendue** :
- Créer les tenants **seulement après** la confirmation d'email
- Utiliser le webhook `/auth/callback` pour déclencher le provisioning

---

### 🔴 CRITIQUE #2 : Erreur Twenty - Type GraphQL incorrect

**Emplacement** : `utils/tenants/provision.ts:263`

**Erreur actuelle** :
```
[TWENTY] ❌ ERROR: Unknown type "CreateApiKeyDTO". Did you mean "CreateApiKeyInput"?
```

**Code actuel** :
```typescript
// Ligne 260-277
const apiKeyResult = await graphqlRequest(
  TWENTY_METADATA_URL,
  `
    mutation CreateApiKey($input: CreateApiKeyDTO!) {  // ❌ MAUVAIS TYPE
      createApiKey(input: $input) {
        id
      }
    }
  `,
  // ...
);
```

**Documentation incohérente** :
- `TWENTY_TOOLKIT_USAGE.md:191` dit : `CreateApiKeyInput` → `CreateApiKeyDTO` (obsolete)
- `TWENTY_API_REFERENCE.md:505` utilise : `CreateApiKeyInput!`
- L'erreur GraphQL suggère : `CreateApiKeyInput`

**Solution** : Changer `CreateApiKeyDTO` → `CreateApiKeyInput`

---

### 🔴 CRITIQUE #3 : Erreur Notifuse - URL mal configurée

**Emplacement** : `utils/tenants/provision.ts:12, 75`

**Erreur actuelle** :
```
[Notifuse Provision] Error: Error: Method not allowed
```

**Code actuel** :
```typescript
// Ligne 12
const NOTIFUSE_API_URL = process.env.NOTIFUSE_API_URL!;
// Valeur : http://notifuse.51.210.7.44.nip.io/api/v1

// Ligne 51-77
async function notifuseRequest(endpoint: string, method: string = 'GET', body: any = null, token: string | null = null) {
  // ...
  const response = await fetch(
    `${NOTIFUSE_API_URL.replace('/api', '')}${endpoint}`,  // ❌ PROBLÈME ICI
    options
  );
}

// Ligne 401-404
await notifuseRequest(
  '/api/user.signin',  // endpoint
  'POST',
  { email: NOTIFUSE_ROOT_EMAIL }
);
```

**Calcul de l'URL** :
```
NOTIFUSE_API_URL        = http://notifuse.51.210.7.44.nip.io/api/v1
.replace('/api', '')    = http://notifuse.51.210.7.44.nip.io/v1
+ endpoint              = http://notifuse.51.210.7.44.nip.io/v1/api/user.signin
                                                      ↑↑↑
                                            WRONG! Should be /api/user.signin
```

**URL attendue** : `http://notifuse.51.210.7.44.nip.io/api/user.signin`

**Incohérence de configuration** :
| Fichier | Valeur |
|---------|--------|
| `.env.local.exemple` | `http://notifuse.${SITE_URL}/api/v1` |
| `scripts/dev/README.md` | `http://notifuse.51.210.7.44.nip.io/api` |
| `_pocs/archive/poc/CLAUDE.md` | `http://notifuse.51.210.7.44.nip.io/api` |

**Solutions possibles** :
1. **Option A** : Changer `NOTIFUSE_API_URL` → `http://notifuse.../api` (sans `/v1`)
2. **Option B** : Retirer le `.replace('/api', '')` et ajuster les endpoints

---

### 🟡 MAJEUR #4 : UX - Pas de feedback pendant le provisioning

**Emplacements** :
- `components/auth/LoginForm.tsx` : Aucune barre de progression
- `components/auth/SignupForm.tsx` : Aucune barre de progression
- `utils/auth-helpers/server.ts` : Provisioning en background, non visible

**Problème** :
- L'utilisateur est redirigé vers `/dashboard` immédiatement
- Le provisioning se passe en arrière-plan
- Aucun indicateur visuel de l'état du provisioning
- Les erreurs ne sont visibles que dans la console serveur

**Comportement actuel** :
```
1. User submit signup form
2. Button disabled → "Creating account..."
3. Immediate redirect to /dashboard
4. Provisioning happens invisibly in background
5. User sees dashboard, but tenants might not be ready
```

**Comportement attendu** :
```
1. User submit signup form
2. Show loading state with progress steps
3. "Creating your account..."
4. "Setting up your Twenty CRM workspace..."
5. "Configuring your Notifuse workspace..."
6. Show success/error message
7. Redirect to dashboard when ready
```

---

### 🟡 MAJEUR #5 : Login avec compte inexistant → Page d'erreur

**Emplacement** : `utils/auth-helpers/server.ts:135-165`

**Code actuel** :
```typescript
export async function signInWithPassword(formData: FormData) {
  // ...
  const { error, data } = await supabase.auth.signInWithPassword({
    email,
    password
  });

  if (error) {
    redirectPath = getErrorRedirect(
      '/signin/password_signin',
      'Sign in failed.',
      error.message  // ❌ Generic error page
    );
  } else if (data.user) {
    redirectPath = getStatusRedirect('/dashboard', 'Success!', 'You are now signed in.');
  }
  return redirectPath;
}
```

**Problème** :
- Si l'utilisateur n'existe pas, erreur générique
- Pas de détection "user not found" pour proposer signup
- Mauvaise UX : l'utilisateur doit manuellement aller sur /signup

**Solution attendue** :
- Détecter si l'utilisateur n'existe pas (`AuthApiError` avec code spécifique)
- Proposer automatiquement de créer un compte
- Rediriger vers /signup avec pré-remplissage email

---

### 🟡 MAJEUR #6 : Logs incomplets en mode dev

**Emplacement** : `utils/tenants/debug.ts`

**Code actuel** :
```typescript
export function logProvisionStart(email: string, userId: string) {
  if (isDevMode()) {
    console.log(`[Provisioning] Starting for user: ${email} (${userId})`);
  }
}

function isDevMode() {
  return process.env.NODE_ENV === 'development';
}
```

**Problème** :
- Les URLs et variables d'environnement ne sont pas loggées
- Difficile de debugger les problèmes d'API
- Pas de log des valeurs importantes (workspaceId, tokens, etc.)

**Logs actuels** :
```
[Notifuse Provision] Starting for: azer@azer.com
[Notifuse Provision] Error: Error: Method not allowed
```

**Logs attendus** :
```
[Provisioning] Starting for user: azer@azer.com
[Provisioning] NOTIFUSE_API_URL: http://notifuse.51.210.7.44.nip.io/api/v1
[Provisioning] Full URL: http://notifuse.51.210.7.44.nip.io/v1/api/user.signin
[Notifuse] Step 1: POST /api/user.signin
[Notifuse] Request body: {"email":"admin@notifuse.local"}
[Notifuse] Response: {"code":"123456"}
```

---

## 🔧 Solutions proposées

### Fix #1 : Provisioning après confirmation email

**Fichier** : `utils/auth-helpers/server.ts`

**Action** : Retirer l'appel à `provisionTenants()` du signup

```typescript
// ❌ RETIRER ces lignes (200-207, 223-226)
// provisionTenants(email, password, data.user.id).catch((error) => {
//   console.error('[SignUp] Failed to provision tenants:', error);
// });
```

**Nouveau fichier** : `app/api/webhooks/supabase/auth-event/route.ts`

```typescript
export async function POST(request: Request) {
  const event = await request.json();

  // Seulement provisioning après confirmation email
  if (event.type === 'user.confirmed' || event.type === 'user.created') {
    const { email, id } = event.data.user;
    // Générer un mot de passe temporaire ou demander à l'utilisateur
    await provisionTenants(email, tempPassword, id);
  }

  return Response.json({ received: true });
}
```

---

### Fix #2 : Type GraphQL Twenty

**Fichier** : `utils/tenants/provision.ts:263`

**Changement** :
```typescript
// ❌ AVANT
mutation CreateApiKey($input: CreateApiKeyDTO!) {

// ✅ APRÈS
mutation CreateApiKey($input: CreateApiKeyInput!) {
```

---

### Fix #3 : URL Notifuse

**Option A recommandée** : Corriger l'URL de base

**Fichier** : `.env.local`
```bash
# ❌ AVANT
NOTIFUSE_API_URL=http://notifuse.51.210.7.44.nip.io/api/v1

# ✅ APRÈS
NOTIFUSE_API_URL=http://notifuse.51.210.7.44.nip.io
```

**Fichier** : `utils/tenants/provision.ts:401-402`
```typescript
// ❌ AVANT
await notifuseRequest('/api/user.signin', ...)

// ✅ APRÈS
await notifuseRequest('/api/v1/user.signin', ...)
```

**Option B** : Retirer le replace (moins clean)

```typescript
// ❌ AVANT
const response = await fetch(`${NOTIFUSE_API_URL.replace('/api', '')}${endpoint}`, ...);

// ✅ APRÈS
const response = await fetch(`${NOTIFUSE_API_URL}${endpoint}`, ...);
```

---

### Fix #4 : Feedback UX pendant provisioning

**Nouveau composant** : `components/auth/ProvisioningProgress.tsx`

```typescript
interface ProvisioningStep {
  id: string;
  label: string;
  status: 'pending' | 'in_progress' | 'completed' | 'error';
}

const steps: ProvisioningStep[] = [
  { id: 'account', label: 'Creating your account', status: 'completed' },
  { id: 'twenty', label: 'Setting up Twenty CRM workspace', status: 'in_progress' },
  { id: 'notifuse', label: 'Configuring Notifuse workspace', status: 'pending' },
];
```

**Modification** : `utils/auth-helpers/server.ts`

Changer le flow pour rendre le provisioning **synchrone** et observable :
- Créer un endpoint `/api/provision/start` qui renvoie un Server-Sent Events stream
- Le frontend écoute les événements et met à jour la UI

---

### Fix #5 : Smart redirect login → signup

**Fichier** : `utils/auth-helpers/server.ts:135-165`

```typescript
export async function signInWithPassword(formData: FormData) {
  // ...
  const { error, data } = await supabase.auth.signInWithPassword({
    email,
    password
  });

  if (error) {
    // ✅ Détecter "user not found"
    if (error.message?.includes('Invalid login credentials')) {
      // Vérifier si l'email existe
      const { data: { user } } = await supabase.auth.admin.getUserById(email);

      if (!user) {
        // ✅ Rediriger vers signup avec email pré-rempli
        redirectPath = getStatusRedirect(
          '/signup?email=' + encodeURIComponent(email),
          'Account not found',
          'No account found with this email. Would you like to create one?'
        );
      }
    }
  }
  // ...
}
```

---

### Fix #6 : Logs détaillés en dev

**Fichier** : `utils/tenants/provision.ts`

Ajouter des logs détaillés :
```typescript
async function notifuseRequest(endpoint: string, method: string = 'GET', body: any = null, token: string | null = null) {
  const fullUrl = `${NOTIFUSE_API_URL.replace('/api', '')}${endpoint}`;

  if (process.env.NODE_ENV === 'development') {
    console.log('[Notifuse] Request:', {
      method,
      url: fullUrl,
      body,
      hasToken: !!token
    });
  }

  const response = await fetch(fullUrl, options);
  const data = await response.json();

  if (process.env.NODE_ENV === 'development') {
    console.log('[Notifuse] Response:', {
      status: response.status,
      data
    });
  }

  // ...
}
```

---

## 📁 Fichiers à modifier

### Priorité CRITIQUE

1. **`utils/tenants/provision.ts`**
   - Ligne 263 : `CreateApiKeyDTO` → `CreateApiKeyInput`
   - Ligne 75 : Corriger l'URL Notifuse (voir options)

2. **`utils/auth-helpers/server.ts`**
   - Ligne 204-207 : Retirer `provisionTenants()` du signup direct
   - Ligne 223-226 : Retirer `provisionTenants()` du signup avec email confirm
   - Ligne 135-165 : Ajouter smart redirect login → signup

3. **`.env.local`** (à créer depuis exemple)
   - `NOTIFUSE_API_URL` : Corriger la valeur

### Priorité MAJEURE

4. **`components/auth/SignupForm.tsx`**
   - Ajouter état de chargement détaillé
   - Afficher les étapes du provisioning

5. **`components/auth/LoginForm.tsx`**
   - Détecter "user not found"
   - Proposer signup automatique

6. **`utils/tenants/debug.ts`**
   - Ajouter logs détaillés avec URLs et variables d'environnement

### Nouveaux fichiers à créer

7. **`app/api/webhooks/supabase/auth-event/route.ts`**
   - Nouveau webhook pour déclencher le provisioning après confirmation email

8. **`components/auth/ProvisioningProgress.tsx`**
   - Nouveau composant pour afficher la progression du provisioning

---

## 📊 Résumé des problèmes

| # | Problème | Sévérité | Complexité | Impact |
|---|----------|----------|------------|--------|
| 1 | Provisioning avant email confirm | 🔴 CRITIQUE | Moyenne | Sécurité, ressources |
| 2 | API graphql twenty non bloqué sur le provisionning| 🔴 CRITIQUE | Triviale | Blocking |
| 3 | URL Notifuse mal configurée | 🔴 CRITIQUE | Triviale | Blocking |
| 4 | Pas de feedback UX provisioning | 🟡 MAJEUR | Élevée | Expérience utilisateur |
| 5 | Login compte inexistant | 🟡 MAJEUR | Moyenne | Expérience utilisateur |
| 6 | Logs incomplets | 🟡 MAJEUR | Faible | Debugging |

---

**Document généré le** : 23 décembre 2025
**Pour plus d'informations** : Voir `CLAUDE.md` à la racine du projet
