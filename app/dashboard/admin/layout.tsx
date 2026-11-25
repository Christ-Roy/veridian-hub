/**
 * Hub admin layout — réservé aux administrateurs de plateforme (`lib/admin/session-admin.ts`).
 * Redirects to /dashboard if non-admin.
 */
import { redirect } from 'next/navigation';
import Link from 'next/link';

import { sessionAdmin } from '@/lib/admin/session-admin';

const LIENS = [
  ['/dashboard/admin', 'Vue d\'ensemble'],
  ['/dashboard/admin/clients', 'Clients'],
  ['/dashboard/admin/tenants', 'Organisations'],
  ['/dashboard/admin/lookup', 'Fiche technique'],
] as const;

export default async function AdminHubLayout({ children }: { children: React.ReactNode }) {
  const s = await sessionAdmin();
  if (!s.ok) {
    if (s.raison === 'non_connecte') redirect('/login?redirect=/dashboard/admin');
    // Les routes admin exigent une connexion réelle récente : le dire ici, pas page par page.
    if (s.raison === 'preuve_ancienne') redirect(`/login?reauth=1&callbackUrl=${encodeURIComponent('/dashboard/admin')}`);
    // Emprunt ou compte ordinaire : rien ne dit qu'il y a ici une administration.
    redirect('/dashboard');
  }

  return (
    <div className="min-h-screen">
      <header className="bg-card border-b border-border sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-4 md:px-6 md:gap-6">
          <Link href="/dashboard" className="whitespace-nowrap text-sm font-semibold text-primary">
            ← Tableau de bord
          </Link>
          <span className="text-xs uppercase tracking-wide text-destructive font-bold">
            Administration
          </span>
          <nav className="flex items-center gap-4 overflow-x-auto whitespace-nowrap text-sm text-foreground">
            {LIENS.map(([href, nom]) => (
              <Link key={href} href={href} className="hover:text-primary">
                {nom}
              </Link>
            ))}
          </nav>
          <div className="ml-auto hidden text-xs text-muted-foreground md:block">{s.email}</div>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-4 py-6 md:px-6 md:py-8">{children}</main>
    </div>
  );
}
