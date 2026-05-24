import { Skeleton } from '@/components/ui/skeleton';

/**
 * Squelette qui mime la structure de `DashboardPageHeader` (icône h-8 + titre
 * text-3xl + ligne description text-muted-foreground). Utilisé par les
 * `loading.tsx` de route segment pour éviter le flash blanc pendant les
 * Server Components fetches.
 */
export function PageHeaderSkeleton({
  withIcon = true,
  className,
}: {
  withIcon?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          {withIcon && <Skeleton className="h-8 w-8 rounded" />}
          <Skeleton className="h-9 w-64" />
        </div>
      </div>
      <Skeleton className="h-5 w-96 max-w-full" />
    </div>
  );
}
