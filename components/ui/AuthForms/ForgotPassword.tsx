'use client';

import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { requestPasswordUpdate } from '@/utils/auth-helpers/server';
import { handleRequest } from '@/utils/auth-helpers/client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

// Define prop type with allowEmail boolean
interface ForgotPasswordProps {
  allowEmail: boolean;
  redirectMethod: string;
  disableButton?: boolean;
}

export default function ForgotPassword({
  allowEmail,
  redirectMethod,
  disableButton
}: ForgotPasswordProps) {
  const router = redirectMethod === 'client' ? useRouter() : null;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [emailSent, setEmailSent] = useState('');

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    setIsSubmitting(true);
    const formData = new FormData(e.currentTarget);
    const email = formData.get('email') as string;
    await handleRequest(e, requestPasswordUpdate, router);
    setEmailSent(email); // Store email to show verify link
    setIsSubmitting(false);
  };

  return (
    <div className="my-8">
      {emailSent && (
        <div className="mb-4 p-4 rounded-md bg-green-500/10 border border-green-500/20">
          <p className="text-sm text-green-500 mb-2">
            ✓ Email sent! Check your inbox for the reset link.
          </p>
          <p className="text-sm text-muted-foreground">
            Or{' '}
            <Link
              href={`/auth/verify?email=${encodeURIComponent(emailSent)}&type=recovery`}
              className="underline text-foreground hover:text-primary"
            >
              enter the verification code manually
            </Link>
          </p>
        </div>
      )}
      <form
        noValidate={true}
        className="mb-4"
        onSubmit={(e) => handleSubmit(e)}
      >
        <div className="grid gap-2">
          <div className="grid gap-1">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              placeholder="name@example.com"
              type="email"
              name="email"
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect="off"
              className="input-base"
            />
          </div>
          <Button
            variant="slim"
            type="submit"
            className="mt-1"
            loading={isSubmitting}
            disabled={disableButton}
          >
            Send Email
          </Button>
        </div>
      </form>
      <p>
        <Link href="/signin/password_signin" className="font-light text-sm">
          Sign in with email and password
        </Link>
      </p>
      {allowEmail && (
        <p>
          <Link href="/signin/email_signin" className="font-light text-sm">
            Sign in via magic link
          </Link>
        </p>
      )}
      <p>
        <Link href="/signin/signup" className="font-light text-sm">
          Don't have an account? Sign up
        </Link>
      </p>
    </div>
  );
}
