'use client';

import { Button } from '@/components/ui/button';
import CardWrapper from '@/components/ui/card-wrapper';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

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

    setIsSubmitting(true);
    try {
      const res = await fetch('/api/account/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || 'Failed to update email');
        return;
      }
      toast.success('Email updated. Please check your inbox to verify.');
      router.refresh();
    } catch (err: any) {
      toast.error(err?.message || 'Network error');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <CardWrapper
      title="Your Email"
      description="Please enter the email address you want to use to login."
      footer={
        <div className="flex flex-col items-start justify-between sm:flex-row sm:items-center">
          <p className="pb-4 sm:pb-0">
            We will email you to verify the change.
          </p>
          <Button
            variant="slim"
            type="submit"
            form="emailForm"
            loading={isSubmitting}
          >
            Update Email
          </Button>
        </div>
      }
    >
      <div className="mt-8 mb-4 text-xl font-semibold">
        <form id="emailForm" onSubmit={handleSubmit}>
          <input
            type="email"
            name="newEmail"
            className="input-base w-1/2"
            defaultValue={userEmail ?? ''}
            placeholder="Your email"
            maxLength={64}
          />
        </form>
      </div>
    </CardWrapper>
  );
}
