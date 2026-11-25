// Connexion de l'organisation : libre, ou obligatoire par son fournisseur, et qui entre comment (VER-261). Le propriétaire règle, un administrateur regarde.
import { Button } from '@/components/ui/button';
import type { EtatConnexion, EtatPersonne } from '@/lib/federation/connexion';

const ACCES: Record<EtatPersonne['acces'], string> = {
  secours: 'accès de secours',
  actuel: 'accès actuel jusqu\'au rattachement',
  fournisseur: '',
  ferme: 'pas encore rattaché',
};
const ROLES: Record<string, string> = { owner: 'propriétaire', admin: 'administrateur', member: 'membre' };
const jour = (d: string) => new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', timeZone: 'Europe/Paris' });

function Geste({ tenant, geste, qui, children, variante = 'outline' }: { tenant: string; geste: string; qui?: string; children: React.ReactNode; variante?: 'outline' | 'default' | 'ghost' }) {
  return (
    <form method="post" action="/api/organisations/connexion">
      <input type="hidden" name="tenant" value={tenant} />
      <input type="hidden" name="geste" value={geste} />
      {qui ? <input type="hidden" name="hub_user_id" value={qui} /> : null}
      <Button type="submit" size="sm" variant={variante}>{children}</Button>
    </form>
  );
}

export function Connexion({ tenant, etat, fournisseur, reglable }: { tenant: string; etat: EtatConnexion; fournisseur: string | null; reglable: boolean }) {
  const nom = fournisseur ?? 'votre fournisseur';
  const sans = etat.personnes.filter((p) => p.acces === 'ferme').length;
  const secours = etat.personnes.filter((p) => p.exemption === 'secours').length;
  return (
    <section className="mt-6 flex flex-col gap-4 rounded-lg border border-border p-4" aria-label="Connexion">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">Connexion : {etat.obligatoire ? `obligatoire par ${nom}` : 'libre'}</p>
          <p className="text-sm text-muted-foreground">
            {etat.obligatoire
              ? `Seule une connexion par ${nom} ouvre cette organisation. Les autres espaces de chacun restent ouverts.`
              : etat.fournisseur_actif ? `Chacun entre comme il veut : mot de passe, Google ou ${nom}.` : 'Branchez d\'abord le fournisseur de votre organisation, ci-dessous.'}
          </p>
        </div>
        {reglable && (etat.obligatoire || etat.fournisseur_actif) ? (
          etat.obligatoire ? <Geste tenant={tenant} geste="libre">Rendre libre</Geste> : <Geste tenant={tenant} geste="obligatoire" variante="default">Rendre obligatoire</Geste>
        ) : null}
      </div>
      {!etat.obligatoire && etat.fournisseur_actif && sans > 0 ? <p role="status" className="text-sm">{sans === 1 ? 'Une personne n\'est pas encore rattachée : elle devrait' : `${sans} personnes ne sont pas encore rattachées : elles devraient`} passer par {nom} pour entrer.</p> : null}
      <ul className="flex flex-col divide-y divide-border">
        {etat.personnes.map((p) => (
          <li key={p.hub_user_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <p className="break-all text-sm">{p.email}</p>
              <p className="text-xs text-muted-foreground">
                {ROLES[p.role] ?? p.role} · {p.acces === 'fournisseur' ? `rattaché à ${nom}` : ACCES[p.acces]}
                {p.exemption_depuis ? `, depuis le ${jour(p.exemption_depuis)}` : ''}
              </p>
            </div>
            {reglable && p.exemption && !(p.exemption === 'secours' && secours === 1 && etat.obligatoire) ? <Geste tenant={tenant} geste="retirer_acces" qui={p.hub_user_id} variante="ghost">Retirer cet accès</Geste> : null}
          </li>
        ))}
      </ul>
      {etat.obligatoire ? <p className="text-xs text-muted-foreground">« Accès actuel » tombe tout seul dès que la personne se rattache. L&apos;accès de secours reste, et le dernier ne s&apos;enlève pas.</p> : null}
    </section>
  );
}
