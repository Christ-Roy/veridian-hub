'use client';

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { LoginErrorBanner } from "@/components/auth/LoginErrorBanner";
import { OAuthButtons, LoginLink } from "@/components/auth/OAuthButtons";

export function SignupForm({
  className,
  allowEmail = true,
  allowOauth = true,
  ...props
}: React.ComponentProps<"form"> & {
  allowEmail?: boolean;
  allowOauth?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get('callbackUrl') ?? '/dashboard';
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    const form = e.currentTarget;
    const email = (form.elements.namedItem('email') as HTMLInputElement).value;
    const password = (form.elements.namedItem('password') as HTMLInputElement).value;
    const confirmPassword = (form.elements.namedItem('confirmPassword') as HTMLInputElement).value;

    if (password !== confirmPassword) {
      setError('Les mots de passe ne correspondent pas.');
      return;
    }
    if (password.length < 8) {
      setError('Le mot de passe doit contenir au moins 8 caractères.');
      return;
    }

    setIsSubmitting(true);

    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data?.error || 'Erreur lors de la création du compte.');
      setIsSubmitting(false);
      return;
    }

    const signInRes = await signIn('credentials', {
      email,
      password,
      redirect: false,
    });

    if (signInRes?.error) {
      setError('Compte créé, mais erreur de connexion. Connectez-vous manuellement.');
      router.push('/login');
      return;
    }

    // Marque la redirection post-signup avec `?event=signup` pour que
    // AuthTracker (components/analytics/auth-tracker.tsx) compte un SignUp GA4
    // et non un Login (sans ce param, tout signup Credentials était tracké
    // `login`). On préserve les éventuels query params du callbackUrl.
    const separator = callbackUrl.includes('?') ? '&' : '?';
    router.push(`${callbackUrl}${separator}event=signup`);
    router.refresh();
  };

  return (
    <form className={cn("flex flex-col gap-6", className)} onSubmit={handleSubmit} {...props}>
      <FieldGroup>
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-2xl font-bold">Créer votre compte</h1>
          <p className="text-muted-foreground text-sm text-balance">
            Bienvenue sur Veridian
          </p>
        </div>

        <LoginErrorBanner />

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {allowEmail && (
          <>
            <Field>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input
                id="email"
                name="email"
                type="email"
                placeholder="vous@exemple.com"
                autoCapitalize="none"
                autoComplete="email"
                autoCorrect="off"
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="password">Mot de passe</FieldLabel>
              <PasswordInput
                id="password"
                name="password"
                autoComplete="new-password"
                minLength={8}
                required
              />
              <FieldDescription>Au moins 8 caractères.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="confirmPassword">Confirmer le mot de passe</FieldLabel>
              <PasswordInput
                id="confirmPassword"
                name="confirmPassword"
                autoComplete="new-password"
                minLength={8}
                required
              />
            </Field>
            <Field>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Création…' : 'Créer mon compte'}
              </Button>
            </Field>
          </>
        )}

        {allowOauth && (
          <>
            <FieldSeparator>Ou continuer avec</FieldSeparator>
            <OAuthButtons callbackUrl={callbackUrl} footer={<LoginLink />} />
          </>
        )}
      </FieldGroup>
    </form>
  );
}
