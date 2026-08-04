'use client';

import { useMemo, useState } from 'react';
import { Check, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { PasswordInput } from '@/components/ui/password-input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

import type { OnboardingInvite } from './types';

/** Règles de robustesse affichées en direct sous le champ. */
const RULES: { id: string; label: string; test: (v: string) => boolean }[] = [
  { id: 'longueur', label: 'Au moins 10 caractères', test: (v) => v.length >= 10 },
  { id: 'majuscule', label: 'Une majuscule', test: (v) => /[A-ZÀ-ÖØ-Þ]/.test(v) },
  { id: 'chiffre', label: 'Un chiffre', test: (v) => /\d/.test(v) },
];

/**
 * Écran 2 — le client choisit son mot de passe. C'est l'étape qui remplace
 * le contournement actuel (mot de passe provisoire envoyé en clair par mail,
 * cf. ticket onboarding première connexion).
 *
 * Le composant ne connaît ni Auth.js ni l'API : il remonte la valeur validée
 * via `onSubmit`. L'atelier lui passe un `onSubmit` qui ne fait rien, la page
 * réelle lui passera l'appel serveur.
 */
export function PasswordScreen({
  invite,
  onSubmit,
  submitting = false,
  error,
}: {
  invite: OnboardingInvite;
  onSubmit?: (password: string) => void;
  submitting?: boolean;
  error?: string | null;
}) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [touched, setTouched] = useState(false);

  const rulesState = useMemo(
    () => RULES.map((rule) => ({ ...rule, ok: rule.test(password) })),
    [password],
  );
  const allRulesOk = rulesState.every((r) => r.ok);
  const sameConfirmation = password.length > 0 && password === confirmation;
  const canSubmit = allRulesOk && sameConfirmation && !submitting;

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (!canSubmit) return;
        onSubmit?.(password);
      }}
    >
      <div className="flex flex-col items-center gap-1 text-center">
        <h1 className="text-2xl font-bold">Choisissez votre mot de passe</h1>
        <p className="text-balance text-sm text-muted-foreground">
          Il vous servira à vous connecter à {invite.workspaceName}.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="onboarding-password">Mot de passe</FieldLabel>
          <PasswordInput
            id="onboarding-password"
            name="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </Field>

        <ul className="flex flex-col gap-1.5" aria-live="polite">
          {rulesState.map((rule) => (
            <li
              key={rule.id}
              className={cn(
                'flex items-center gap-2 text-xs',
                rule.ok ? 'text-success' : 'text-muted-foreground',
              )}
            >
              {rule.ok ? (
                <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
              ) : (
                <X className="h-3.5 w-3.5 shrink-0" aria-hidden />
              )}
              {rule.label}
            </li>
          ))}
        </ul>

        <Field>
          <FieldLabel htmlFor="onboarding-password-confirm">
            Confirmation
          </FieldLabel>
          <PasswordInput
            id="onboarding-password-confirm"
            name="confirmPassword"
            autoComplete="new-password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            onBlur={() => setTouched(true)}
            required
          />
          {touched && confirmation.length > 0 && !sameConfirmation && (
            <p className="text-xs text-destructive">
              Les deux mots de passe ne sont pas identiques.
            </p>
          )}
        </Field>
      </FieldGroup>

      <Button type="submit" className="w-full" disabled={!canSubmit} loading={submitting}>
        Créer mon accès
      </Button>

      <p className="text-center text-xs text-muted-foreground">
        Votre identifiant restera {invite.email}.
      </p>
    </form>
  );
}
