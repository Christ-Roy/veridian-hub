'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';

function ForgotPasswordContent() {
  const searchParams = useSearchParams();
  const expired = searchParams.get('info') === 'link_expired';
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const res = await fetch('/auth/reset_password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });

    if (!res.ok) {
      setError('Erreur. Réessayez.');
      setIsSubmitting(false);
      return;
    }
    setDone(true);
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md p-8">
        <h1 className="text-2xl font-bold mb-2">Mot de passe oublié</h1>
        <p className="text-sm text-muted-foreground mb-6">
          Entrez votre email pour recevoir un lien de réinitialisation.
        </p>

        {expired && (
          <div className="bg-destructive/10 text-destructive text-sm p-3 rounded-md mb-4">
            Le lien a expiré. Demandez-en un nouveau ci-dessous.
          </div>
        )}

        {done ? (
          <div className="bg-green-500/10 text-green-700 text-sm p-3 rounded-md">
            Si un compte existe pour cet email, un lien de réinitialisation a été envoyé.
            Vérifiez votre boîte mail.
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                disabled={isSubmitting}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? 'Envoi…' : 'Envoyer le lien'}
            </Button>
          </form>
        )}

        <div className="mt-6 text-center text-sm text-muted-foreground">
          <Link href="/login" className="underline hover:text-foreground">
            Retour à la connexion
          </Link>
        </div>
      </Card>
    </div>
  );
}

export default function ForgotPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      }
    >
      <ForgotPasswordContent />
    </Suspense>
  );
}
