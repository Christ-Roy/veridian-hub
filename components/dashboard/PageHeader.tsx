import type { LucideIcon } from 'lucide-react';

/**
 * En-tête de page standardisé pour le dashboard. Avant ce composant, les pages
 * dashboard divergeaient entre `text-4xl` + icône `h-10 w-10` et `text-2xl`
 * sans icône. On normalise sur `text-3xl font-bold` avec icône optionnelle.
 *
 * `action` permet de placer un bouton/contrôle à droite du titre (ex: bouton
 * de rafraîchissement sur /dashboard). `className` laisse chaque page gérer son
 * espacement (un parent en `flex gap-*` ne veut pas de marge, un parent simple si).
 */
export interface DashboardPageHeaderProps {
  title: string;
  description?: React.ReactNode;
  icon?: LucideIcon;
  action?: React.ReactNode;
  className?: string;
}

export function DashboardPageHeader({
  title,
  description,
  icon: Icon,
  action,
  className,
}: DashboardPageHeaderProps) {
  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          {Icon && <Icon className="h-8 w-8 text-primary" />}
          <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        </div>
        {action}
      </div>
      {description && (
        <p className="text-muted-foreground">{description}</p>
      )}
    </div>
  );
}
