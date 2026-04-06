'use client';

import { Suspense } from 'react';
import { useState, useEffect } from 'react';
import { createClient } from '@/utils/supabase/client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';

function VerifyContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Pre-fill email from query params
  useEffect(() => {
    const emailParam = searchParams.get('email');
    if (emailParam) {
      setEmail(emailParam);
    }
  }, [searchParams]);

  const verificationType = searchParams.get('type');
  const isRecovery = verificationType === 'recovery';

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    const supabase = createClient();

    // Verify OTP code - use 'recovery' type for password reset
    const otpType = isRecovery ? 'recovery' : 'email';
    const { error: verifyError } = await supabase.auth.verifyOtp({
      email,
      token: code,
      type: otpType as any
    });

    if (verifyError) {
      setError(verifyError.message);
      setIsSubmitting(false);
      return;
    }

    // Success! Redirect based on context
    setSuccess(true);

    // Redirect based on verification type
    if (isRecovery) {
      router.push('/signin/update_password');
    } else {
      router.push('/dashboard');
    }

    setIsSubmitting(false);
  };

  const emailFromUrl = searchParams.get('email');
  const isEmailReadonly = !!emailFromUrl;

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md p-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold mb-2">
            {isRecovery ? 'Reset Password' : 'Verify Your Email'}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isRecovery
              ? 'Enter the 6-digit code sent to your email to reset your password.'
              : 'Check your email and enter the 6-digit verification code below.'}
          </p>
        </div>

        <form onSubmit={handleVerify} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="your.email@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={isSubmitting}
              readOnly={isEmailReadonly}
              className={isEmailReadonly ? 'bg-muted' : ''}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="code">Verification Code</Label>
            <Input
              id="code"
              type="text"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              maxLength={6}
              disabled={isSubmitting}
              className="text-center text-2xl tracking-widest"
            />
          </div>

          {error && (
            <div className="bg-destructive/10 text-destructive text-sm p-3 rounded-md">
              {error}
            </div>
          )}

          {success && (
            <div className="bg-green-500/10 text-green-500 text-sm p-3 rounded-md">
              Code verified! Redirecting...
            </div>
          )}

          <Button
            type="submit"
            className="w-full"
            disabled={isSubmitting || !email || !code}
          >
            {isSubmitting ? 'Verifying...' : 'Verify Code'}
          </Button>
        </form>

        <div className="mt-6 text-center text-sm text-muted-foreground">
          <a href="/signin" className="underline hover:text-foreground">
            Back to sign in
          </a>
        </div>
      </Card>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      }
    >
      <VerifyContent />
    </Suspense>
  );
}
