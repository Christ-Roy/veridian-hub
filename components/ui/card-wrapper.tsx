import React from 'react';
import {
  Card as ShadcnCard,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter
} from '@/components/ui/card';

interface CardWrapperProps {
  title?: string;
  description?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

/**
 * Wrapper du composant shadcn Card pour compatibilité avec l'ancien code auth.
 * Permet d'utiliser <CardWrapper title="..." description="..." footer={...}>
 * au lieu de la syntaxe complète shadcn.
 */
export default function CardWrapper({ title, description, footer, children, className }: CardWrapperProps) {
  return (
    <ShadcnCard className={className}>
      {(title || description) && (
        <CardHeader>
          {title && <CardTitle>{title}</CardTitle>}
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
      )}
      <CardContent className={title || description ? '' : 'pt-6'}>
        {children}
      </CardContent>
      {footer && (
        <CardFooter>
          {footer}
        </CardFooter>
      )}
    </ShadcnCard>
  );
}
