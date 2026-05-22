'use client';

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import Link from "next/link";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { LoginErrorBanner } from "@/components/auth/LoginErrorBanner";
import { OAuthButtons, SignupLink } from "@/components/auth/OAuthButtons";

export function LoginForm({
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
    setIsSubmitting(true);

    const formData = new FormData(e.currentTarget);
    const email = String(formData.get('email') ?? '');
    const password = String(formData.get('password') ?? '');

    const res = await signIn('credentials', {
      email,
      password,
      redirect: false,
    });

    if (res?.error) {
      setError('Email ou mot de passe invalide.');
      setIsSubmitting(false);
      return;
    }

    router.push(callbackUrl);
    router.refresh();
  };

  return (
    <form className={cn("flex flex-col gap-6", className)} onSubmit={handleSubmit} {...props}>
      <FieldGroup>
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-2xl font-bold">Connexion</h1>
          <p className="text-muted-foreground text-sm text-balance">
            Accédez à votre espace Veridian
          </p>
        </div>
        <LoginErrorBanner />
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
              <div className="flex items-center">
                <FieldLabel htmlFor="password">Mot de passe</FieldLabel>
                <Link
                  href="/signin/forgot_password"
                  className="ml-auto text-sm underline-offset-4 hover:underline"
                >
                  Mot de passe oublié ?
                </Link>
              </div>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </Field>
            {error && (
              <p className="text-sm text-destructive text-center">{error}</p>
            )}
            <Field>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Connexion…' : 'Se connecter'}
              </Button>
            </Field>
          </>
        )}

        {allowOauth && (
          <>
            <FieldSeparator>Ou continuer avec</FieldSeparator>
            <OAuthButtons callbackUrl={callbackUrl} footer={<SignupLink />} />
          </>
        )}
      </FieldGroup>
    </form>
  );
}
