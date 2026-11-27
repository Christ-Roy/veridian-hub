'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, LayoutGrid } from 'lucide-react';

import { cn } from '@/lib/utils';
import { AppIdentity, type AppKey } from './AppIdentity';

export type AppDuSelecteur = { cle: string; nom: string; href: string };

const IDENTITE: Record<string, AppKey> = { notifuse: 'mail', crm: 'crm', prospection: 'prospection', analytics: 'analytics', cms: 'cms', academy: 'academy' };

const LIEN =
  'flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring';

/**
 * Passer d'une app à l'autre sans repasser par le tableau de bord. Ne reçoit que les apps OUVERTES, chacune avec son lien de rebond signé
 * (`lienApp`) : jamais un jeton. Un bouton qui déplie une navigation (clavier : Entrée, flèches, Échap ; focus visible ; cibles de 44 px).
 */
export function SelecteurApps({ apps }: { apps: AppDuSelecteur[] }) {
  const [ouvert, setOuvert] = useState(false);
  const racine = useRef<HTMLDivElement>(null);
  const bouton = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!ouvert) return;
    const dehors = (e: MouseEvent | TouchEvent) => {
      if (racine.current && !racine.current.contains(e.target as Node)) setOuvert(false);
    };
    document.addEventListener('mousedown', dehors);
    document.addEventListener('touchstart', dehors);
    return () => {
      document.removeEventListener('mousedown', dehors);
      document.removeEventListener('touchstart', dehors);
    };
  }, [ouvert]);

  const liens = () => Array.from(racine.current?.querySelectorAll<HTMLElement>('nav a') ?? []);

  const touche = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && ouvert) {
      setOuvert(false);
      bouton.current?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    if (!ouvert) {
      setOuvert(true);
      // Le panneau n'est pas encore rendu : le focus va au premier lien après le rendu.
      setTimeout(() => liens()[0]?.focus(), 0);
      return;
    }
    const l = liens();
    if (l.length === 0) return;
    const i = l.indexOf(document.activeElement as HTMLElement);
    l[e.key === 'ArrowDown' ? (i + 1) % l.length : i <= 0 ? l.length - 1 : i - 1]?.focus();
  };

  return (
    <div ref={racine} className="relative" onKeyDown={touche}>
      <button
        ref={bouton}
        type="button"
        aria-label="Changer d'application Veridian"
        aria-expanded={ouvert}
        aria-controls={id}
        onClick={() => setOuvert((o) => !o)}
        className="inline-flex min-h-11 items-center gap-2 rounded-md border bg-card px-3 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        <LayoutGrid className="h-4 w-4" aria-hidden />
        <span>Mes applications</span>
        <ChevronDown className={cn('h-4 w-4 transition-transform', ouvert && 'rotate-180')} aria-hidden />
      </button>
      {ouvert && (
        <nav
          id={id}
          aria-label="Applications Veridian"
          className="absolute right-0 z-50 mt-2 w-[min(18rem,calc(100vw-2rem))] rounded-md border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          <ul className="space-y-0.5">
            <li>
              <a href="/dashboard" className={LIEN}>
                <LayoutGrid className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                <span>Hub Veridian</span>
              </a>
            </li>
            {apps.map((a) => (
              <li key={a.cle}>
                <a href={a.href} target="_blank" rel="noopener noreferrer" className={LIEN}>
                  <AppIdentity app={IDENTITE[a.cle] ?? 'crm'} size="sm" className="h-7 w-7 rounded-md text-sm" />
                  <span>{`Veridian ${a.nom}`}</span>
                  <span className="sr-only"> (s&apos;ouvre dans un nouvel onglet)</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}

export default SelecteurApps;
