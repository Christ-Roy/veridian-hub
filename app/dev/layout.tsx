import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { PropsWithChildren } from 'react';

import { isDevHarnessEnabled } from '@/lib/dev/harness-guard';

/**
 * Garde-fou runtime de tout `/dev/**`.
 *
 * L'extension standard est volontaire : ce layout reste compilé dans les
 * builds de production et couvre ainsi une route standard ajoutée par erreur
 * sous `app/dev`, même si les pages `.dev.tsx` sont exclues du bundle.
 */
export const metadata: Metadata = {
  title: 'Atelier UI',
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = 'force-dynamic';

export default function DevLayout({ children }: PropsWithChildren) {
  if (!isDevHarnessEnabled()) {
    notFound();
  }

  return <>{children}</>;
}
