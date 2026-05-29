import { cn } from '@/lib/utils';

/**
 * Logo d'une app Veridian — exactement le style du favicon .hub / .site :
 * badge carré arrondi au gradient de marque + un "V" blanc centré + fin
 * liseré clair (ring) pour le relief. L'identité de l'app passe par la
 * COULEUR du gradient (le glyphe est toujours le "V" Veridian).
 *
 * Gradients multi-stops (comme le favicon) pour un rendu riche.
 */

export type AppKey = 'mail' | 'prospection' | 'analytics' | 'crm' | 'cms';

const REGISTRY: Record<AppKey, { name: string; gradient: string }> = {
  // Mail → violet Notifuse
  mail: {
    name: 'Veridian Mail',
    gradient: 'linear-gradient(135deg, #8b78ff 0%, #7763f1 45%, #5b48d6 100%)',
  },
  // Prospection → noir profond (Vercel / Next.js)
  prospection: {
    name: 'Veridian Prospection',
    gradient: 'linear-gradient(135deg, #4a4a4a 0%, #262626 50%, #0a0a0a 100%)',
  },
  // Analytics → violet foncé
  analytics: {
    name: 'Veridian Analytics',
    gradient:
      'linear-gradient(135deg, oklch(0.50 0.18 300) 0%, oklch(0.36 0.16 298) 55%, oklch(0.26 0.13 295) 100%)',
  },
  // CRM → corail / rouge chaud
  crm: {
    name: 'Veridian CRM',
    gradient:
      'linear-gradient(135deg, oklch(0.68 0.17 30) 0%, oklch(0.55 0.17 25) 55%, oklch(0.44 0.15 18) 100%)',
  },
  // CMS → bleu
  cms: {
    name: 'Veridian CMS',
    gradient:
      'linear-gradient(135deg, oklch(0.66 0.15 225) 0%, oklch(0.52 0.14 228) 55%, oklch(0.40 0.13 232) 100%)',
  },
};

export function appName(key: AppKey): string {
  return REGISTRY[key].name;
}

const BOX = {
  sm: 'h-9 w-9 rounded-lg text-base',
  md: 'h-11 w-11 rounded-xl text-xl',
  lg: 'h-14 w-14 rounded-2xl text-2xl',
} as const;

/** Logo de l'app : badge gradient (style favicon .hub) + "V" blanc. */
export function AppIdentity({
  app,
  size = 'md',
  className,
}: {
  app: AppKey;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const { gradient } = REGISTRY[app];

  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center font-extrabold leading-none text-white shadow-md shadow-foreground/10 ring-1 ring-white/25 drop-shadow-sm',
        BOX[size],
        className,
      )}
      style={{ backgroundImage: gradient }}
      aria-hidden
    >
      V
    </div>
  );
}

export default AppIdentity;
