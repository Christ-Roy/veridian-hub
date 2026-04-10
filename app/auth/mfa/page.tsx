// Page /auth/mfa — saisie du code 2FA envoyé par mail.
// Arrivée ici via redirect depuis le signIn callback Auth.js quand mfaEnabled.

'use client';

import { useState, useEffect, FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Logo from '@/components/icons/Logo';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function MfaPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get('uid') ?? '';

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
        body: JSON.stringify({ userId, code }),
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        setStatus('error');
        setErrorMsg(
          payload?.error === 'invalid_code'
            ? 'Code incorrect ou expiré. Réessaye ou demande un nouveau code.'
            : 'Une erreur est survenue. Réessaye.'
        );
        return;
      }

      setStatus('success');
      // Petit délai pour feedback visuel
      setTimeout(() => router.push('/dashboard'), 500);
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
        body: JSON.stringify({ userId }),
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

  if (!userId) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-background">
        <Card className="w-full max-w-sm p-6 text-center space-y-3">
          <h1 className="text-lg font-semibold">Session expirée</h1>
          <p className="text-sm text-muted-foreground">
            Impossible de valider ton code. Retourne à la page de connexion.
          </p>
          <Button onClick={() => router.push('/login')}>Retour connexion</Button>
        </Card>
      </div>
    );
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
