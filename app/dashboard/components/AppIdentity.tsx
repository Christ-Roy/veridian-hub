import { cn } from '@/lib/utils';
import { Mail, Search, BarChart3, Users, FileText, type LucideIcon } from 'lucide-react';

/**
 * Identité visuelle d'une app Veridian (logo = pastille au gradient de
 * marque + icône) pour les cards du tableau de bord. Couleurs alignées sur
 * l'arborescence des pages auth (composant AppTree) pour une DA cohérente.
 */

export type AppKey = 'mail' | 'prospection' | 'analytics' | 'crm' | 'cms';

const REGISTRY: Record<AppKey, { name: string; icon: LucideIcon; badge: string }> = {
  mail: {
    name: 'Veridian Mail',
    icon: Mail,
    badge: 'bg-[linear-gradient(135deg,#7763f1,#6553d9)]',
  },
  prospection: {
    name: 'Veridian Prospection',
    icon: Search,
    badge: 'bg-[linear-gradient(135deg,#3a3a3a,#0a0a0a)]',
  },
  analytics: {
    name: 'Veridian Analytics',
    icon: BarChart3,
    badge: 'bg-[linear-gradient(135deg,oklch(0.42_0.17_300),oklch(0.26_0.13_295))]',
  },
  crm: {
    name: 'Veridian CRM',
    icon: Users,
    badge: 'bg-[linear-gradient(135deg,oklch(0.55_0.16_25),oklch(0.42_0.15_20))]',
  },
  cms: {
    name: 'Veridian CMS',
    icon: FileText,
    badge: 'bg-[linear-gradient(135deg,oklch(0.55_0.14_220),oklch(0.40_0.13_230))]',
  },
};

export function appName(key: AppKey): string {
  return REGISTRY[key].name;
}

/** Pastille logo de l'app (icône blanche sur gradient de marque). */
export function AppIdentity({
  app,
  size = 'md',
  className,
}: {
  app: AppKey;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const { icon: Icon, badge } = REGISTRY[app];
  const box = size === 'sm' ? 'h-9 w-9 rounded-lg' : 'h-11 w-11 rounded-xl';
  const ic = size === 'sm' ? 'h-4.5 w-4.5' : 'h-5.5 w-5.5';

  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center text-white shadow-sm ring-1 ring-foreground/10',
        box,
        badge,
        className,
      )}
    >
      <Icon className={cn('h-5 w-5', ic)} />
    </div>
  );
}

export default AppIdentity;
