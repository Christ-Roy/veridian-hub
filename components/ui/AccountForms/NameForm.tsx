'use client';

import { Button } from '@/components/ui/button';
import CardWrapper from '@/components/ui/card-wrapper';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

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

    setIsSubmitting(true);
    try {
      const res = await fetch('/api/account/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || 'Failed to update name');
        return;
      }
      toast.success('Name updated.');
      router.refresh();
    } catch (err: any) {
      toast.error(err?.message || 'Network error');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <CardWrapper
      title="Your Name"
      description="Please enter your full name, or a display name you are comfortable with."
      footer={
        <div className="flex flex-col items-start justify-between sm:flex-row sm:items-center">
          <p className="pb-4 sm:pb-0">64 characters maximum</p>
          <Button
            variant="slim"
            type="submit"
            form="nameForm"
            loading={isSubmitting}
          >
            Update Name
          </Button>
        </div>
      }
    >
      <div className="mt-8 mb-4 text-xl font-semibold">
        <form id="nameForm" onSubmit={handleSubmit}>
          <input
            type="text"
            name="fullName"
            className="input-base w-1/2"
            defaultValue={userName}
            placeholder="Your name"
            maxLength={64}
          />
        </form>
      </div>
    </CardWrapper>
  );
}
