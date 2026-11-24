/** Qui est entré dans l'espace du propriétaire, quand, et par où (VER-245) : une arrivée ne passe pas inaperçue. Lecture seule. */
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export type MembreDuTenant = { espace: string; email: string; role: string; origine: string | null; depuis: Date };

const PAR: Record<string, string> = { invitation: 'sur invitation', operateur: 'ajouté par Veridian', reprise: 'déjà membre dans une app' };

export function MembresDuTenant({ membres }: { membres: MembreDuTenant[] }) {
  if (membres.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Entrés dans votre espace</CardTitle>
        <CardDescription>Ces personnes agissent dans vos apps Veridian. Une arrivée que vous ne reconnaissez pas : écrivez à contact@veridian.site.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {membres.map((m) => (
            <li key={`${m.espace}:${m.email}`} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span className="font-medium">{m.email}</span>
              <span className="text-muted-foreground">
                {m.espace}, {m.role}, {PAR[m.origine ?? ''] ?? 'origine inconnue'}, depuis le {m.depuis.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' })}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
