'use client';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useSearchParams } from 'next/navigation';

type ErrorEntry = {
  title: string;
  message: string;
  variant: 'default' | 'destructive';
};

const ERROR_MAP: Record<string, ErrorEntry> = {
  OAuthAccountNotLinked: {
    title: 'Ce compte est déjà lié à une autre méthode',
    message:
      "Un compte Veridian avec cet email existe déjà mais n'est pas connecté à ce provider. Connectez-vous avec votre méthode habituelle, puis liez ce provider depuis vos paramètres.",
    variant: 'destructive',
  },
  OAuthCallbackError: {
    title: 'Échec de connexion OAuth',
    message:
      "La connexion via le provider a échoué après la redirection. Réessayez ou utilisez votre email et mot de passe.",
    variant: 'destructive',
  },
  OAuthSigninError: {
    title: 'Impossible de démarrer la connexion OAuth',
    message:
      "Nous n'avons pas pu initier la connexion via le provider. Vérifiez votre connexion Internet et réessayez.",
    variant: 'destructive',
  },
  Configuration: {
    title: 'Erreur de configuration',
    message:
      "Le provider de connexion n'est pas correctement configuré. L'équipe Veridian a été notifiée. Réessayez plus tard ou utilisez email/mot de passe.",
    variant: 'destructive',
  },
  AccessDenied: {
    title: 'Connexion annulée',
    message:
      "Vous avez annulé la connexion ou refusé les permissions demandées. Vous pouvez réessayer ci-dessous.",
    variant: 'default',
  },
  Verification: {
    title: 'Lien expiré',
    message:
      "Le lien de connexion a expiré ou a déjà été utilisé. Demandez-en un nouveau ou connectez-vous via une autre méthode.",
    variant: 'destructive',
  },
  CredentialsSignin: {
    title: 'Identifiants invalides',
    message:
      "Email ou mot de passe incorrect. Vérifiez vos identifiants ou utilisez 'Mot de passe oublié'.",
    variant: 'destructive',
  },
  SessionRequired: {
    title: 'Connexion requise',
    message: 'Vous devez être connecté pour accéder à cette page.',
    variant: 'default',
  },
  Default: {
    title: 'Une erreur est survenue',
    message:
      "Une erreur inattendue est survenue lors de la connexion. Réessayez ou contactez le support si le problème persiste.",
    variant: 'destructive',
  },
};

export function resolveError(code: string | null | undefined): ErrorEntry | null {
  if (!code) return null;
  return ERROR_MAP[code] ?? ERROR_MAP.Default;
}

/** Messages sans code d'erreur : rebond raté (`bounce_failed=1`) et reconnexion demandée (`reauth=1`). */
export function resolveNotice(params: { get(name: string): string | null }): (ErrorEntry & { code: string }) | null {
  if (params.get('bounce_failed') === '1') {
    return {
      code: 'bounce_failed',
      title: 'Reconnexion à l’outil impossible',
      message: 'Nous n’avons pas pu vous reconnecter à l’outil. Connectez-vous à nouveau ci-dessous.',
      variant: 'destructive',
    };
  }
  if (params.get('reauth') === '1') {
    return {
      code: 'reauth',
      title: 'Confirmation demandée',
      message: 'Pour votre sécurité, reconnectez-vous pour effectuer cette action.',
      variant: 'default',
    };
  }
  return null;
}

export function LoginErrorBanner() {
  const searchParams = useSearchParams();
  const code = searchParams.get('error');
  const entry = resolveError(code) ?? resolveNotice(searchParams);
  const shownCode = code ?? (entry && 'code' in entry ? entry.code : null);

  if (!entry) return null;

  return (
    <Alert variant={entry.variant} role="alert" data-error-code={shownCode}>
      <AlertTitle>{entry.title}</AlertTitle>
      <AlertDescription>{entry.message}</AlertDescription>
    </Alert>
  );
}
