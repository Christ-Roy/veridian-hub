import { Button } from '@/components/ui/button';
import type { ConnexionIa } from '@/lib/mcp/connexions';

import { couperConnexionIa } from './connexions-ia-actions';

const date = (d: Date) => d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

/** Assistants IA reliés au compte par la porte MCP, chacun coupable seul. */
export function ConnexionsIa({ connexions }: { connexions: ConnexionIa[] }) {
  if (connexions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Aucun assistant IA n&apos;est relié pour l&apos;instant.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border">
      {connexions.map((c) => (
        <li key={c.id} className="flex items-center justify-between gap-4 py-3">
          <div className="text-sm">
            <p className="font-medium">{c.client}</p>
            <p className="text-muted-foreground">
              Relié le {date(c.depuis)}
              {c.derniereUtilisation ? `, utilisé le ${date(c.derniereUtilisation)}` : ''}
            </p>
          </div>
          <form action={couperConnexionIa}>
            <input type="hidden" name="connexion" value={c.id} />
            <Button type="submit" variant="outline" size="sm">
              Couper
            </Button>
          </form>
        </li>
      ))}
    </ul>
  );
}
