'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import Logo from '@/components/icons/Logo';

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background">
      <div className="max-w-md w-full mx-auto p-8">
        {/* Logo */}
        <div className="flex justify-center mb-8">
          <Link href="/" className="flex items-center gap-2">
            <Logo width="40px" height="40px" />
            <span className="text-2xl font-bold text-foreground">Veridian</span>
          </Link>
        </div>

        {/* 404 Content */}
        <div className="text-center space-y-6">
          {/* 404 Number */}
          <div className="relative">
            <h1 className="text-[120px] font-bold text-primary leading-none">
              404
            </h1>
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-32 h-32 rounded-full bg-primary/10 blur-3xl" />
            </div>
          </div>

          {/* Message */}
          <div className="space-y-2">
            <h2 className="text-2xl font-semibold text-foreground">
              Page introuvable
            </h2>
            <p className="text-muted-foreground">
              La page que vous recherchez n&apos;existe pas ou a été déplacée.
            </p>
          </div>

          {/* Actions */}
          <div className="flex flex-col sm:flex-row gap-3 justify-center pt-4">
            <Button asChild size="lg" trackLabel="404 - Back to Home">
              <Link href="/">
                Retour à l&apos;accueil
              </Link>
            </Button>
            <Button asChild variant="outline" size="lg" trackLabel="404 - Go to Dashboard">
              <Link href="/dashboard">
                Tableau de bord
              </Link>
            </Button>
          </div>

          {/* Help text */}
          <p className="text-sm text-muted-foreground pt-4">
            Besoin d&apos;aide ?{' '}
            <Link href="/pricing" className="text-primary hover:underline">
              Voir nos tarifs
            </Link>
            {' '} ou{' '}
            <Link href="/login" className="text-primary hover:underline">
              Se connecter
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
