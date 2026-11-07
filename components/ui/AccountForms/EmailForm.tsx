'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import CardWrapper from '@/components/ui/card-wrapper';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { redirectIfReauthRequired } from '@/lib/auth/reauth-redirect';
import { toast } from 'sonner';
import { MESSAGE_RESEAU } from '@/lib/ui/messages';

/**
 * EmailForm — Auth.js v5
 *
 * PATCH /api/account/profile { email }. Le serveur reset `emailVerified=null`
 * et l'utilisateur recevra (post LOT A) un email de re-vérification.
 */
export default function EmailForm({
  userEmail,
}: {
  userEmail: string | undefined;
}) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const newEmail = String(formData.get('newEmail') ?? '').trim();

    if (!newEmail || newEmail === userEmail) return;

    toast.dismiss(); // un seul message à la fois
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/account/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (redirectIfReauthRequired(data)) return;
        toast.error(data.error || "Échec de la mise à jour de l'email");
        return;
      }
      toast.success('Email mis à jour. Vérifiez votre boîte de réception pour confirmer.');
      router.refresh();
    } catch {
      toast.error(MESSAGE_RESEAU);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <CardWrapper
      title="Votre email"
      description="Saisissez l'adresse email que vous souhaitez utiliser pour vous connecter."
      footer={
        <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
          <p className="pb-4 sm:pb-0">
            Nous vous enverrons un email pour confirmer le changement.
          </p>
          <Button
            variant="slim"
            type="submit"
            form="emailForm"
            loading={isSubmitting}
          >
            Mettre à jour l'email
          </Button>
        </div>
      }
    >
      <div className="mt-8 mb-4">
        <form id="emailForm" onSubmit={handleSubmit}>
          <Input
            type="email"
            name="newEmail"
            className="max-w-md border-muted-foreground/40"
            defaultValue={userEmail ?? ''}
            placeholder="Votre email"
            maxLength={64}
          />
        </form>
      </div>
    </CardWrapper>
  );
}
