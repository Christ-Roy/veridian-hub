'use client';

/**
 * Bouton d'acceptation pour une invitation cross-app (Notifuse / Prospection /
 * Analytics / CMS). Distinct de `AcceptInviteButton.tsx` qui gère le flow
 * d'invitation workspace interne au Hub.
 *
 * Appelle `POST /api/invitations/[token]/accept` et gère les 3 cas de
 * réponse documentés dans `app/api/invitations/[token]/accept/route.ts` :
 *
 *   - 200 OK    `downstream_call=completed` → redirect immédiat vers
 *               `redirect_url` (auto-login dans l'app downstream).
 *   - 202 Acc.  `downstream_call=pending`   → on affiche un message
 *               "accès en cours d'attribution" avec bouton "Réessayer"
 *               qui relance le POST. L'invitation est consommée côté Hub
 *               mais le user doit retry tant que l'app downstream n'a pas
 *               attaché le membre (typiquement endpoint pas encore livré).
 *   - 502 Gtwy  `downstream_call=error`     → erreur business du downstream
 *               (workspace_suspended, role_conflict, etc.). On affiche un
 *               message clair + lien vers le dashboard. L'invitation est
 *               consommée côté Hub (audit) mais inopérante côté app cible.
 *
 * Autres status :
 *   - 401  user pas loggué (ne devrait pas arriver, la page wrap déjà)
 *   - 404  not_found
 *   - 410  expired
 *   - 409  already_accepted / user_not_provisioned
 *   - 429  rate_limited (l'API retourne Retry-After, on relit l'en-tête)
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Loader2, CheckCircle, Clock, AlertTriangle } from 'lucide-react';

type Outcome =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'completed'; redirectUrl: string }
  | { kind: 'pending'; redirectUrl: string }
  | { kind: 'error'; message: string; code?: string };

const ERROR_MESSAGES: Record<string, string> = {
  workspace_suspended:
    'Le workspace est actuellement suspendu. Contactez l\'administrateur de l\'app cible.',
  tenant_suspended:
    'Le compte tenant cible est suspendu. Contactez l\'administrateur.',
  user_role_conflict:
    'Vous avez déjà un rôle différent sur ce workspace. Demandez à l\'administrateur de régulariser.',
  role_conflict:
    'Vous avez déjà un rôle différent sur ce workspace. Demandez à l\'administrateur de régulariser.',
  user_not_provisioned:
    'Votre compte n\'est pas encore provisionné côté apps. Contactez le support.',
  expired:
    'Ce lien d\'invitation a expiré. Demandez-en un nouveau à l\'administrateur.',
  already_accepted:
    'Cette invitation a déjà été acceptée.',
  not_found: 'Invitation introuvable.',
  email_mismatch:
    'L\'email du compte connecté ne correspond pas à celui de l\'invitation.',
  rate_limited:
    'Trop de tentatives, réessayez dans quelques instants.',
  downstream_error:
    'L\'application cible n\'a pas pu finaliser l\'attribution. Réessayez plus tard.',
};

function describeError(code?: string, fallback?: string): string {
  if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  return fallback ?? 'Erreur inattendue lors de l\'acceptation.';
}

interface Props {
  token: string;
  appLabel: string;
}

export function AcceptCrossAppInviteButton({ token, appLabel }: Props) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });

  async function accept() {
    setOutcome({ kind: 'loading' });
    try {
      const res = await fetch(`/api/invitations/${token}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const data = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            downstream_call?: 'completed' | 'pending' | 'error';
            redirect_url?: string;
            error?: string;
            downstream_http_status?: number | null;
          }
        | null;

      if (res.status === 200 && data?.downstream_call === 'completed') {
        const url = data.redirect_url ?? '/dashboard';
        setOutcome({ kind: 'completed', redirectUrl: url });
        // Redirect réseau hors-app via window.location pour permettre
        // au cookie cross-domain de poser. router.push reste in-Next.
        if (/^https?:\/\//.test(url)) {
          window.location.href = url;
        } else {
          router.push(url);
        }
        return;
      }

      if (res.status === 202 && data?.downstream_call === 'pending') {
        setOutcome({
          kind: 'pending',
          redirectUrl: data.redirect_url ?? '/dashboard',
        });
        return;
      }

      if (res.status === 502 || data?.downstream_call === 'error') {
        setOutcome({
          kind: 'error',
          code: data?.error,
          message: describeError(data?.error),
        });
        return;
      }

      // Cas erreurs standard (4xx)
      const code = data?.error;
      setOutcome({
        kind: 'error',
        code,
        message: describeError(code, `Erreur HTTP ${res.status}.`),
      });
    } catch {
      setOutcome({
        kind: 'error',
        message: 'Erreur réseau, vérifiez votre connexion.',
      });
    }
  }

  if (outcome.kind === 'completed') {
    return (
      <Alert className="w-full">
        <CheckCircle className="h-4 w-4" />
        <AlertTitle>Invitation acceptée</AlertTitle>
        <AlertDescription>
          Redirection vers {appLabel} en cours…
        </AlertDescription>
      </Alert>
    );
  }

  if (outcome.kind === 'pending') {
    return (
      <div className="w-full space-y-3" data-testid="invite-pending">
        <Alert>
          <Clock className="h-4 w-4" />
          <AlertTitle>Accès en cours d&apos;attribution</AlertTitle>
          <AlertDescription>
            Votre invitation a bien été enregistrée. L&apos;attribution de
            l&apos;accès côté {appLabel} prend quelques secondes — réessayez
            dans un instant, ou ouvrez directement l&apos;application.
          </AlertDescription>
        </Alert>
        <div className="flex flex-col gap-2">
          <Button onClick={accept} className="w-full" variant="default">
            Réessayer
          </Button>
          <Button asChild variant="outline" className="w-full">
            <a href={outcome.redirectUrl}>Ouvrir {appLabel}</a>
          </Button>
        </div>
      </div>
    );
  }

  if (outcome.kind === 'error') {
    return (
      <div className="w-full space-y-3" data-testid="invite-error">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Acceptation impossible</AlertTitle>
          <AlertDescription>
            {outcome.message}
            {outcome.code ? (
              <span className="block text-xs opacity-70 mt-1">
                Code : {outcome.code}
              </span>
            ) : null}
          </AlertDescription>
        </Alert>
        <Button onClick={accept} variant="outline" className="w-full">
          Réessayer
        </Button>
      </div>
    );
  }

  return (
    <Button
      onClick={accept}
      disabled={outcome.kind === 'loading'}
      className="w-full"
      data-testid="invite-accept-button"
    >
      {outcome.kind === 'loading' && (
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
      )}
      Accepter l&apos;invitation
    </Button>
  );
}
