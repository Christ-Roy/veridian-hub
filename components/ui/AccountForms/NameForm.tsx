'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import CardWrapper from '@/components/ui/card-wrapper';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { MESSAGE_RESEAU } from '@/lib/ui/messages';

/**
 * NameForm — Auth.js v5
 *
 * PATCH /api/account/profile { name }
 */
export default function NameForm({ userName }: { userName: string }) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const newName = String(formData.get('fullName') ?? '').trim();

    if (!newName || newName === userName) return;

    toast.dismiss(); // un seul message à la fois
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/account/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || 'Échec de la mise à jour du nom');
        return;
      }
      toast.success('Nom mis à jour.');
      router.refresh();
    } catch {
      toast.error(MESSAGE_RESEAU);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <CardWrapper
      title="Votre nom"
      description="Saisissez votre nom complet, ou un nom d'affichage qui vous convient."
      footer={
        <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
          <p className="pb-4 sm:pb-0">64 caractères maximum</p>
          <Button
            variant="slim"
            type="submit"
            form="nameForm"
            loading={isSubmitting}
          >
            Mettre à jour le nom
          </Button>
        </div>
      }
    >
      <div className="mt-8 mb-4">
        <form id="nameForm" onSubmit={handleSubmit}>
          <Input
            type="text"
            name="fullName"
            className="w-full border-muted-foreground/40"
            defaultValue={userName}
            placeholder="Votre nom"
            maxLength={64}
          />
        </form>
      </div>
    </CardWrapper>
  );
}
