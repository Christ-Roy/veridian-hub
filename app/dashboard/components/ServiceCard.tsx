'use client';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import {
  ExternalLink,
  BarChart3,
  LayoutDashboard,
  Mail,
  Users,
  CreditCard,
  Settings,
  Database,
  Globe,
  Activity,
  type LucideIcon,
} from 'lucide-react';
import { AppIdentity, type AppKey } from './AppIdentity';

// Map noms d'icônes → composants. Passer un composant React en prop depuis
// un Server Component vers un Client Component crashe en Next.js 15 (RSC ne
// sérialise pas les fonctions/forwardRef). On passe une string, on résout ici.
const ICON_MAP: Record<string, LucideIcon> = {
  BarChart3,
  LayoutDashboard,
  Mail,
  Users,
  CreditCard,
  Settings,
  Database,
  Globe,
  Activity,
};

export type ServiceCardIcon = keyof typeof ICON_MAP;

export interface ServiceCardProps {
  name: string;
  description: string;
  url: string;
  icon: ServiceCardIcon;
  badge?: 'BETA' | 'NEW' | 'COMING_SOON';
  features?: string[];
  /** Si fourni, affiche le logo de marque de l'app au lieu de l'icône générique. */
  appKey?: AppKey;
}

const BADGE_VARIANTS: Record<
  NonNullable<ServiceCardProps['badge']>,
  NonNullable<BadgeProps['variant']>
> = {
  BETA: 'warning',
  NEW: 'success',
  COMING_SOON: 'secondary',
};

const BADGE_LABELS: Record<NonNullable<ServiceCardProps['badge']>, string> = {
  BETA: 'BETA',
  NEW: 'NOUVEAU',
  COMING_SOON: 'Bientôt',
};

export function ServiceCard({
  name,
  description,
  url,
  icon,
  badge,
  features,
  appKey,
}: ServiceCardProps) {
  const Icon = ICON_MAP[icon] ?? BarChart3;
  const isComingSoon = badge === 'COMING_SOON';

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3">
            {appKey ? (
              <AppIdentity app={appKey} />
            ) : (
              <div className="rounded-md bg-primary/10 p-2">
                <Icon className="h-6 w-6 text-primary" />
              </div>
            )}
            <CardTitle>{name}</CardTitle>
          </div>
          {badge && (
            <Badge variant={BADGE_VARIANTS[badge]}>
              {BADGE_LABELS[badge]}
            </Badge>
          )}
        </div>
        <CardDescription className="mt-2">{description}</CardDescription>
      </CardHeader>

      {features && features.length > 0 && (
        <CardContent className="flex-1">
          <ul className="space-y-1 text-sm text-muted-foreground">
            {features.map((feature) => (
              <li key={feature} className="flex items-start gap-2">
                <span className="text-primary">•</span>
                <span>{feature}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      )}

      <CardFooter>
        <Button
          asChild={!isComingSoon}
          disabled={isComingSoon}
          className="w-full"
          variant={isComingSoon ? 'secondary' : 'default'}
        >
          {isComingSoon ? (
            <span>Bientôt disponible</span>
          ) : (
            <a href={url} target="_blank" rel="noopener noreferrer">
              Ouvrir
              <ExternalLink className="ml-2 h-4 w-4" />
            </a>
          )}
        </Button>
      </CardFooter>
    </Card>
  );
}
