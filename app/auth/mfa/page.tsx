// Page /auth/mfa — saisie du code 2FA envoyé par mail (D3).
// Arrivée ici depuis le formulaire de connexion, après le mot de passe (`/api/auth/mfa/start`).
// L'état tient dans le cookie signé d'étape 1 : pas d'identifiant dans l'URL. `next` rend la
// page d'arrivée prévue, validée côté serveur comme côté ici.

'use client';

import { Suspense, useState, useEffect, FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Logo from '@/components/icons/Logo';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { safeCallback } from '@/lib/auth/safe-callback';
import { Input } from '@/components/ui/input';

function MfaContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const suite = safeCallback(searchParams.get('next'));

  const [code, setCode] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'error' | 'success'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [resendStatus, setResendStatus] = useState<'idle' | 'sent' | 'rate_limited'>('idle');

  // Timer resend : 30s après arrivée on permet un nouveau renvoi
  const [resendAvailableIn, setResendAvailableIn] = useState(30);
  useEffect(() => {
    if (resendAvailableIn <= 0) return;
    const timer = setTimeout(() => setResendAvailableIn((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendAvailableIn]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (status === 'submitting') return;
    setStatus('submitting');
    setErrorMsg(null);

    try {
      const res = await fetch('/api/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, next: suite }),
      });
      const payload = await res.json().catch(() => ({}));

      if (!res.ok) {
        setStatus('error');
        setErrorMsg(
          payload?.error === 'invalid_code'
            ? 'Code incorrect ou expiré. Réessaye ou demande un nouveau code.'
            : payload?.error === 'too_many_attempts'
              ? 'Trop d’essais. Reconnecte-toi dans quelques minutes.'
              : payload?.error === 'mfa_step1_required'
                ? 'Ta connexion a expiré. Reconnecte-toi.'
                : 'Une erreur est survenue. Réessaye.'
        );
        return;
      }

      setStatus('success');
      // La session est posée par la réponse : on rejoint la page demandée.
      setTimeout(() => router.push(typeof payload?.redirect === 'string' ? payload.redirect : '/dashboard'), 500);
    } catch (err) {
      console.error(err);
      setStatus('error');
      setErrorMsg('Erreur réseau. Réessaye.');
    }
  }

  async function onResend() {
    if (resendAvailableIn > 0) return;
    setResendStatus('idle');
    try {
      const res = await fetch('/api/auth/mfa/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.status === 429) {
        setResendStatus('rate_limited');
        return;
      }
      setResendStatus('sent');
      setResendAvailableIn(30);
    } catch {
      setResendStatus('rate_limited');
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <Card className="w-full max-w-sm p-6 space-y-6">
        <div className="flex justify-center">
          <Logo width="40px" height="40px" />
        </div>
        <div className="text-center space-y-1">
          <h1 className="text-lg font-semibold">Validation par email</h1>
          <p className="text-sm text-muted-foreground">
            Nous t&apos;avons envoyé un code à 6 chiffres. Il expire dans 10 minutes.
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <Input
            type="text"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            className="text-center text-2xl tracking-[0.5em] font-mono"
            autoFocus
            disabled={status === 'submitting' || status === 'success'}
          />

          {errorMsg && (
            <p className="text-sm text-destructive text-center" role="alert">
              {errorMsg}
            </p>
          )}

          <Button
            type="submit"
            className="w-full"
            disabled={code.length !== 6 || status === 'submitting' || status === 'success'}
          >
            {status === 'submitting' ? 'Vérification...' : 'Valider'}
          </Button>
        </form>

        <div className="text-center text-sm text-muted-foreground">
          <button
            type="button"
            onClick={onResend}
            disabled={resendAvailableIn > 0}
            className="underline disabled:no-underline disabled:opacity-50"
          >
            {resendAvailableIn > 0
              ? `Renvoyer un code dans ${resendAvailableIn}s`
              : 'Renvoyer un code'}
          </button>
          {resendStatus === 'sent' && (
            <p className="mt-1 text-green-600">Nouveau code envoyé.</p>
          )}
          {resendStatus === 'rate_limited' && (
            <p className="mt-1 text-destructive">
              Trop de demandes. Réessaye dans une heure.
            </p>
          )}
        </div>

        <div className="text-center">
          <button
            type="button"
            onClick={() => router.push('/login')}
            className="text-xs text-muted-foreground underline"
          >
            Retour à la connexion
          </button>
        </div>
      </Card>
    </div>
  );
}

export default function MfaPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      }
    >
      <MfaContent />
    </Suspense>
  );
}
