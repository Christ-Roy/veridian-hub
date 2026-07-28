import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { PropsWithChildren } from 'react';

import { isDevHarnessEnabled } from '@/lib/dev/harness-guard';

/**
 * ATELIER UI — `/dev/onboarding`
 *
 * Zone de travail visuelle du flow « première connexion client »
 * (`todo/2026-07-06-onboarding-premiere-connexion-client.md`). Rend les
 * écrans avec des données fictives : ni session Auth.js, ni Prisma, ni appel
 * réseau. On itère sur l'UI sans dépendre du backend.
 *
 * Garde-fou : cf. `lib/dev/harness-guard.ts` (verrou build + verrou runtime).
 */
export const metadata: Metadata = {
  title: 'Atelier onboarding',
  robots: { index: false, follow: false, nocache: true },
};

// Le garde-fou lit `process.env` : la page ne doit jamais être figée au build.
export const dynamic = 'force-dynamic';

export default function DevOnboardingLayout({ children }: PropsWithChildren) {
  if (!isDevHarnessEnabled()) {
    notFound();
  }

  return <>{children}</>;
}
