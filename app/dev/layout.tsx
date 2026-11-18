import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { PropsWithChildren } from 'react';

import { isDevHarnessEnabled } from '@/lib/dev/harness-guard';

/**
 * ATELIER UI — garde-fou de TOUT `/dev/**`.
 *
 * 🔴 Ce fichier porte volontairement l'extension `.tsx` standard, et non
 * `.dev.tsx`. C'est le point entier de sa correction : `pageExtensions`
 * (next.config.js) filtre les layouts exactement comme les pages, donc un
 * `layout.dev.tsx` n'est pas compilé en build prod. Le verrou runtime qu'il
 * portait n'était actif que dans les builds où le verrou build agissait déjà
 * — il ne couvrait donc jamais le seul scénario qui compte : un `page.tsx`
 * (extension normale) créé ou renommé par mégarde sous `app/dev/`.
 *
 * Avec ce layout-ci, une telle page hérite du 404 en production.
 *
 * NE PAS renommer en `layout.dev.tsx`. NE PAS créer de `page.tsx` sous
 * `app/dev/` (un gate CI le refuse, cf. `.github/workflows/hub-ci.yml`).
 */
export const metadata: Metadata = {
  title: 'Atelier UI',
  robots: { index: false, follow: false, nocache: true },
};

// Le garde-fou lit `process.env` : la page ne doit jamais être figée au build.
export const dynamic = 'force-dynamic';

export default function DevLayout({ children }: PropsWithChildren) {
  if (!isDevHarnessEnabled()) {
    notFound();
  }

  return <>{children}</>;
}
