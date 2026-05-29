import { cn } from '@/lib/utils';
import { Mail, Search, BarChart3, Users, FileText } from 'lucide-react';

/**
 * Écosystème Veridian affiché sous le logo `veridian.hub` dans le panneau
 * brand des pages auth. Liste verticale d'apps en pills de marque, reliée au
 * hub par un connecteur vertical simple (robuste : aucun alignement SVG
 * fragile, le rendu ne casse jamais quelle que soit la largeur).
 *
 * Couleurs de marque (gradients) :
 *   - Mail        → violet Notifuse (#7763f1 → #6553d9)
 *   - Prospection → noir (Vercel / Next.js)
 *   - Analytics   → violet foncé
 *   - CRM / CMS   → grisés (« Bientôt »)
 */

type App = {
  label: string;
  icon: typeof Mail;
  pillClass: string;
  soon?: boolean;
};

const APPS: App[] = [
  {
    label: 'mail',
    icon: Mail,
    pillClass: 'text-white bg-[linear-gradient(135deg,#7763f1,#6553d9)] border-transparent',
  },
  {
    label: 'prospection',
    icon: Search,
    pillClass: 'text-white bg-[linear-gradient(135deg,#3a3a3a,#0a0a0a)] border-neutral-700',
  },
  {
    label: 'analytics',
    icon: BarChart3,
    pillClass:
      'text-white bg-[linear-gradient(135deg,oklch(0.42_0.17_300),oklch(0.26_0.13_295))] border-transparent',
  },
  { label: 'crm', icon: Users, pillClass: '', soon: true },
  { label: 'cms', icon: FileText, pillClass: '', soon: true },
];

export function AppTree({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-col items-center gap-2.5', className)}>
      {/* Connecteur vertical du hub (au-dessus) vers la liste */}
      <span aria-hidden className="h-5 w-px bg-gradient-to-b from-transparent to-foreground/25" />

      <ul className="flex w-60 flex-col gap-2">
        {APPS.map((app) => {
          const Icon = app.icon;
          return (
            <li key={app.label}>
              <span
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold leading-none shadow-sm transition-transform hover:translate-x-0.5',
                  app.soon
                    ? 'border-border bg-card/70 text-muted-foreground backdrop-blur-sm'
                    : app.pillClass,
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="flex-1 text-left">
                  veridian<span className="opacity-75">.{app.label}</span>
                </span>
                {app.soon && (
                  <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide">
                    Bientôt
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default AppTree;
