import { LoginForm } from '@/components/auth/LoginForm';
import { GoogleOneTap } from '@/components/auth/GoogleOneTap';
import { VeridianHubLogo } from '@/components/icons/VeridianHubLogo';
import { AppTree } from '@/components/auth/AppTree';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getAuthTypes } from '@/utils/auth-helpers/settings';
import { Card } from '@/components/ui/card';
import { getCurrentUser } from '@/lib/auth/get-user';
import {
  parseNext,
  verifyNextCookie,
  NEXT_COOKIE_NAME_SECURE,
  NEXT_COOKIE_NAME_INSECURE,
} from '@/lib/auth/bounce-next';
import { issueMagicLinkForApp, BounceError } from '@/lib/auth/bounce-apps';

interface LoginPageProps {
  searchParams: Promise<{
    next?: string;
    mode?: string;
    app?: string;
  }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { next: nextRaw, mode, app: appQuery } = await searchParams;
  const deployEnv = process.env.DEPLOY_ENV;

  // 1. Cas "appel direct depuis une app downstream" : `?next=...` sans mode bounce
  //    encore posé. On délègue à /api/auth/bounce/prepare qui pose le cookie
  //    signé et redirige ici en `?mode=bounce&app=<app>`.
  if (nextRaw && mode !== 'bounce') {
    return redirect(`/api/auth/bounce/prepare?next=${encodeURIComponent(nextRaw)}`);
  }

  // 2. Détermine si on est en mode bounce (cookie signé doit exister).
  let bounceApp: string | null = null;
  if (mode === 'bounce') {
    const secret = process.env.AUTH_SECRET;
    const cookieStore = await cookies();
    const cookieValue =
      cookieStore.get(NEXT_COOKIE_NAME_SECURE)?.value ??
      cookieStore.get(NEXT_COOKIE_NAME_INSECURE)?.value ??
      null;
    if (secret && cookieValue) {
      const next = verifyNextCookie(cookieValue, secret);
      if (next) {
        const parsed = parseNext(next, deployEnv);
        if (parsed) {
          bounceApp = parsed.app;
        }
      }
    }
    // Si le cookie est expiré / absent / invalide en mode bounce, on
    // ignore silencieusement et on rend le login normal (le user retombera
    // sur /dashboard après login, pas de bounce — mais pas de crash non plus).
  }

  // 3. Auth.js v5 : si déjà loggué…
  const user = await getCurrentUser();
  if (user) {
    // Cas A — user loggué + mode bounce + cookie valide : court-circuiter
    // l'OAuth complet (§6bis.8.4 "user déjà loggué"). On délègue à la page
    // /auth/bounce qui contient déjà la logique downstream.
    if (bounceApp) {
      return redirect('/api/auth/bounce/complete');
    }
    // Cas B — user loggué pas de bounce : flow normal.
    return redirect('/dashboard');
  }

  const { allowOauth, allowEmail } = getAuthTypes();
  // Garde-fou copy : si on est en mode `?mode=bounce&app=X` mais sans cookie
  // valide (cookie expiré), on n'affiche pas le copy "revenir sur X" mensonger.
  // En revanche on garde la valeur de `appQuery` pour info de debug (jamais
  // injectée dans le DOM sans sanitization).
  const safeAppHint = bounceApp ?? (mode === 'bounce' && appQuery ? sanitizeAppName(appQuery) : null);

  return (
    <div className="auth-screen min-h-screen w-full flex flex-col lg:flex-row">
      {/* Google One Tap : popup auto-login en complément du bouton OAuth
          classique. Aucun markup rendu, se gate lui-même.
          NB : on désactive One Tap en mode bounce — l'utilisateur a
          EXPLICITEMENT cliqué sur "Continuer avec Google" depuis l'app
          downstream, on ne veut pas court-circuiter avec un autre compte
          via One Tap. */}
      {!bounceApp && <GoogleOneTap callbackUrl="/dashboard" />}

      {/* Left side - Form */}
      <div className="flex-1 flex items-center justify-center p-6 lg:p-12">
        <div className="w-full max-w-sm">
          {/* Logo en haut sur mobile, caché sur desktop */}
          <div className="flex justify-center lg:hidden mb-6">
            <VeridianHubLogo size="md" href="/" />
          </div>

          {/* Formulaire dans une Card avec bordure */}
          <Card className="border shadow-sm p-6">
            <LoginForm
              allowEmail={allowEmail}
              allowOauth={allowOauth}
              bounceApp={safeAppHint}
            />
          </Card>
        </div>
      </div>

      {/* Right side - Brand - 50% sur lg screens */}
      <div className="hidden lg:flex lg:w-1/2 bg-card backdrop-blur-md border-l border-border items-center justify-center p-12">
        <div className="flex flex-col items-center justify-center text-center space-y-8">
          <VeridianHubLogo size="lg" />
          <p className="text-lg text-muted-foreground max-w-md">
            Votre écosystème business, simplifié et unifié
          </p>
          <AppTree className="mt-2" />
        </div>
      </div>
    </div>
  );
}

/**
 * Sanitization du nom d'app pour affichage UI : caractères safe seulement,
 * longueur bornée. Évite tout XSS si un attaquant arrive à injecter un
 * `?app=` arbitraire dans l'URL (impossible normalement car notre route
 * `prepare` valide via regex avant de poser ce param, mais défense en
 * profondeur).
 */
function sanitizeAppName(raw: string): string | null {
  const clean = raw.replace(/[^a-z0-9-]/gi, '').slice(0, 32).toLowerCase();
  return clean || null;
}
