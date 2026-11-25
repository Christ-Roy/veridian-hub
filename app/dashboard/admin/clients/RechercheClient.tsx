import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/** Un formulaire GET : l'adresse de la page garde la recherche. */
export function RechercheClient({ q = '', className }: { q?: string; className?: string }) {
  return (
    <form action="/dashboard/admin/clients" method="get" role="search" className={cn('space-y-2', className)}>
      <Label htmlFor="recherche-client">Adresse, nom ou organisation du client</Label>
      <div className="flex gap-2">
        <Input id="recherche-client" name="q" type="search" defaultValue={q} minLength={2} maxLength={120} required autoComplete="off" />
        <Button type="submit">Chercher</Button>
      </div>
    </form>
  );
}
