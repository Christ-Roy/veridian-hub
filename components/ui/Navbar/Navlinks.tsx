'use client';

import Link from 'next/link';
import Logo from '@/components/icons/Logo';
import AuthMenu from './AuthMenu';
import { AnimatedThemeToggler } from '@/components/ui/animated-theme-toggler';

interface NavlinksProps {
  user?: any;
}

export default function Navlinks({ user }: NavlinksProps) {
  return (
    <div className="relative flex flex-row justify-between py-4 align-center md:py-6">
      <div className="flex items-center flex-1">
        <Link href="/" className="flex items-center transition-opacity hover:opacity-80" aria-label="Logo">
          <Logo />
        </Link>
        <nav className="ml-6 space-x-2 lg:block">
          <Link href="/pricing" className="text-sm text-foreground transition-opacity hover:opacity-80">
            Pricing
          </Link>
          <Link href="/docs" className="text-sm text-foreground transition-opacity hover:opacity-80">
            Docs
          </Link>
        </nav>
      </div>
      <div className="flex items-center justify-end gap-2">
        <AnimatedThemeToggler />
        <AuthMenu user={user} />
      </div>
    </div>
  );
}
