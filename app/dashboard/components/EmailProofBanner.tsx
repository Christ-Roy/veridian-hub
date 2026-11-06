'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';

/** Bandeau du tableau de bord tant que l'adresse du compte n'est pas prouvée. */
export function EmailProofBanner({ email }: { email: string }) {
  const [sending, setSending] = useState(false);

  async function resend() {
    setSending(true);
    try {
      const res = await fetch('/api/auth/email-proof/send', { method: 'POST' });
      if (!res.ok) throw new Error('send_failed');
      toast.success('Lien envoyé', { description: `Regardez votre boîte ${email}.` });
    } catch {
      toast.error("L'envoi a échoué", { description: 'Réessayez dans un instant.' });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mb-6 flex flex-col gap-3 rounded-lg border border-warning bg-warning/10 p-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm">
        Confirmez votre adresse {email} pour ouvrir vos outils. Le lien vous attend dans votre boîte
        mail.
      </p>
      <Button variant="outline" size="sm" onClick={resend} disabled={sending}>
        Renvoyer le lien
      </Button>
    </div>
  );
}
