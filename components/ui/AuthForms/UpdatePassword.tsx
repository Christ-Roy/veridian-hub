'use client';

import { Button } from '@/components/ui/button';
import { updatePassword } from '@/utils/auth-helpers/server';
import { handleRequest } from '@/utils/auth-helpers/client';
import { useRouter } from 'next/navigation';
import React, { useState } from 'react';

interface UpdatePasswordProps {
  redirectMethod: string;
  error?: string;
  errorDescription?: string;
}

export default function UpdatePassword({
  redirectMethod,
  error,
  errorDescription
}: UpdatePasswordProps) {
  const router = redirectMethod === 'client' ? useRouter() : null;
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    setIsSubmitting(true); // Disable the button while the request is being handled
    await handleRequest(e, updatePassword, router);
    setIsSubmitting(false);
  };

  return (
    <div className="my-8">
      {(error || errorDescription) && (
        <div className="mb-4 p-4 rounded-md bg-destructive/10 border border-destructive/20">
          <p className="text-sm text-destructive font-medium">
            {error || 'Error'}
          </p>
          {errorDescription && (
            <p className="text-sm text-destructive/80 mt-1">
              {errorDescription}
            </p>
          )}
        </div>
      )}
      <form
        noValidate={true}
        className="mb-4"
        onSubmit={(e) => handleSubmit(e)}
      >
        <div className="grid gap-2">
          <div className="grid gap-1">
            <label htmlFor="password">New Password</label>
            <input
              id="password"
              placeholder="Password"
              type="password"
              name="password"
              autoComplete="current-password"
              className="input-base"
            />
            <label htmlFor="passwordConfirm">Confirm New Password</label>
            <input
              id="passwordConfirm"
              placeholder="Password"
              type="password"
              name="passwordConfirm"
              autoComplete="current-password"
              className="input-base"
            />
          </div>
          <Button
            variant="slim"
            type="submit"
            className="mt-1"
            loading={isSubmitting}
          >
            Update Password
          </Button>
        </div>
      </form>
    </div>
  );
}
