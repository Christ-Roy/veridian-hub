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
import { Badge } from '@/components/ui/badge';
import { ExternalLink, type LucideIcon } from 'lucide-react';

export interface ServiceCardProps {
  name: string;
  description: string;
  url: string;
  icon: LucideIcon;
  badge?: 'BETA' | 'NEW' | 'COMING_SOON';
  features?: string[];
}

const BADGE_VARIANTS: Record<NonNullable<ServiceCardProps['badge']>, string> = {
  BETA: 'bg-orange-100 text-orange-700 hover:bg-orange-100',
  NEW: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100',
  COMING_SOON: 'bg-slate-200 text-slate-700 hover:bg-slate-200',
};

export function ServiceCard({
  name,
  description,
  url,
  icon: Icon,
  badge,
  features,
}: ServiceCardProps) {
  const isComingSoon = badge === 'COMING_SOON';

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-primary/10 p-2">
              <Icon className="h-6 w-6 text-primary" />
            </div>
            <CardTitle>{name}</CardTitle>
          </div>
          {badge && (
            <Badge className={BADGE_VARIANTS[badge]} variant="secondary">
              {badge.replace('_', ' ')}
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
            <span>Coming soon</span>
          ) : (
            <a href={url} target="_blank" rel="noopener noreferrer">
              Open
              <ExternalLink className="ml-2 h-4 w-4" />
            </a>
          )}
        </Button>
      </CardFooter>
    </Card>
  );
}
