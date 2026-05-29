import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * Wordmark Veridian — badge "Veridian" en gradient (DA Veridian, même
 * gradient que le fond de page) + suffixe accentué.
 *
 * Sert pour le logo du Hub (`.hub`) ET pour chaque app de l'écosystème
 * (`.mail`, `.analytics`, …) : le badge "Veridian" reste identique partout,
 * seul le suffixe change de libellé et de couleur selon la marque de l'app.
 *
 * 4 tailles : `xs` (arborescence apps), `sm` (sidebar), `md` (header login),
 * `lg` (panneau hero login). `href` optionnel — wrap dans un <Link>.
 */

type Size = 'xs' | 'sm' | 'md' | 'lg';

const SIZES: Record<Size, { badge: string; text: string; suffix: string }> = {
  xs: { badge: 'px-1.5 py-0.5 rounded-md', text: 'text-xs', suffix: 'text-xs ml-0.5' },
  sm: { badge: 'px-2 py-0.5', text: 'text-sm', suffix: 'text-sm ml-0.5' },
  md: { badge: 'px-2.5 py-1', text: 'text-base md:text-lg', suffix: 'text-base md:text-lg ml-0.5' },
  lg: { badge: 'px-4 py-2', text: 'text-4xl md:text-5xl', suffix: 'text-4xl md:text-5xl ml-1' },
};

export function VeridianWordmark({
  size = 'md',
  suffix = '.hub',
  suffixClassName,
  badgeClassName,
  textClassName,
  href,
  className,
  muted = false,
}: {
  size?: Size;
  /** Suffixe affiché après le badge (ex. ".hub", ".mail"). */
  suffix?: string;
  /** Classe couleur du suffixe (ex. "text-[#7763f1]"). Défaut: text-foreground. */
  suffixClassName?: string;
  /** Override du fond du badge (ex. "bg-[#7763f1]"). Défaut: gradient de page. */
  badgeClassName?: string;
  /** Override de la couleur du texte "Veridian" (ex. "text-white" sur badge foncé). */
  textClassName?: string;
  href?: string;
  className?: string;
  /** Rend le wordmark grisé (app "prochainement"). */
  muted?: boolean;
}) {
  const s = SIZES[size];

  const content = (
    <span className={cn('flex items-center gap-1 shrink-0', muted && 'opacity-45 grayscale', className)}>
      <span
        className={cn(
          'flex items-center rounded-xl border-2 border-foreground/15 ring-1 ring-foreground/10 shadow-md shadow-foreground/10 leading-none transition-all duration-300 group-hover:shadow-lg',
          badgeClassName ?? 'bg-[image:var(--page-gradient)]',
          s.badge,
        )}
      >
        <span
          className={cn(
            'font-bold tracking-tight leading-none drop-shadow-sm',
            textClassName ?? 'text-foreground',
            s.text,
          )}
        >
          Veridian
        </span>
      </span>
      <span
        className={cn(
          'font-bold italic leading-none tracking-tight',
          suffixClassName ?? 'text-foreground',
          s.suffix,
        )}
      >
        {suffix}
      </span>
    </span>
  );

  if (href) {
    return (
      <Link href={href} className="group inline-flex">
        {content}
      </Link>
    );
  }
  return <span className="group inline-flex">{content}</span>;
}

/** Logo du Hub (`.hub`). Alias rétro-compatible de VeridianWordmark. */
export function VeridianHubLogo(
  props: Omit<React.ComponentProps<typeof VeridianWordmark>, 'suffix'>,
) {
  return <VeridianWordmark suffix=".hub" suffixClassName="text-foreground" {...props} />;
}

export default VeridianHubLogo;
