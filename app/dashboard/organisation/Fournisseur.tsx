// La connexion d'une organisation par son propre fournisseur, posée par son propriétaire (VER-227). Le secret entre et ne ressort jamais.
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { vueIdp } from '@/lib/federation/idp';

type Vue = ReturnType<typeof vueIdp>;

function Geste({ tenant, geste, children, variante = 'outline' }: { tenant: string; geste: string; children: React.ReactNode; variante?: 'outline' | 'default' }) {
  return (
    <form method="post" action="/api/organisations/fournisseur">
      <input type="hidden" name="tenant" value={tenant} />
      <input type="hidden" name="geste" value={geste} />
      <Button type="submit" size="sm" variant={variante}>{children}</Button>
    </form>
  );
}

function Champ({ id, nom, libelle, aide, type = 'text' }: { id: string; nom: string; libelle: string; aide?: string; type?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{libelle}</Label>
      <Input id={id} name={nom} type={type} required autoComplete="off" placeholder={aide} />
    </div>
  );
}

const A_DONNER = 'break-all rounded bg-muted px-2 py-1 text-xs';

export function Fournisseur({ tenant, idp, adresses }: { tenant: string; idp: Vue | null; adresses: { retour: string; acs: string; entite: string; connexion: string | null } }) {
  const posable = !idp || idp.libre_service;
  return (
    <details className="mt-6 rounded-lg border border-border p-4">
      <summary className="cursor-pointer font-medium">
        Se connecter avec le compte de votre organisation
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          {!idp ? 'Google, Microsoft, Infomaniak, SAML…' : idp.actif ? 'actif' : idp.essai_le ? 'essayé, pas encore actif' : 'à essayer'}
        </span>
      </summary>
      <div className="flex flex-col gap-4 pt-4">
        <p className="text-sm text-muted-foreground">
          Vos membres entrent avec le compte qu&apos;ils ont déjà. Chacun relie le sien une fois, dans ses Paramètres ; leurs accès habituels restent.
        </p>
        {idp ? (
          <div className="flex flex-col gap-3 rounded-md border border-border p-3">
            <p className="break-all text-sm">
              {idp.protocole === 'saml' ? 'SAML' : 'OpenID Connect'} · {idp.issuer}
            </p>
            {idp.actif && adresses.connexion ? (
              <p className="text-sm">
                Votre porte : <code className={A_DONNER}>{adresses.connexion}</code>
              </p>
            ) : null}
            {idp.libre_service ? (
              <div className="flex flex-wrap gap-2">
                <Geste tenant={tenant} geste="essayer" variante={idp.essai_le ? 'outline' : 'default'}>Essayer</Geste>
                {idp.actif ? <Geste tenant={tenant} geste="couper">Couper</Geste> : idp.essai_le ? <Geste tenant={tenant} geste="activer" variante="default">Activer</Geste> : null}
                <Geste tenant={tenant} geste="retirer">Retirer</Geste>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Réglé par Veridian : écrivez-nous pour le changer.</p>
            )}
            {idp.libre_service && !idp.essai_le ? <p className="text-sm text-muted-foreground">Essayez d&apos;abord avec votre propre compte : rien ne s&apos;ouvre avant.</p> : null}
          </div>
        ) : null}
        {posable ? (
          <>
            <details>
              <summary className="cursor-pointer text-sm font-medium">{idp ? 'Remplacer par OpenID Connect' : 'OpenID Connect (Google, Microsoft, Infomaniak)'}</summary>
              <form method="post" action="/api/organisations/fournisseur" className="flex flex-col gap-3 pt-3" autoComplete="off">
                <input type="hidden" name="tenant" value={tenant} />
                <input type="hidden" name="geste" value="poser" />
                <input type="hidden" name="protocole" value="oidc" />
                <p className="text-sm">
                  Chez votre fournisseur, adresse de retour : <code className={A_DONNER}>{adresses.retour}</code>
                </p>
                <Champ id={`oi-${tenant}`} nom="issuer" libelle="Émetteur" aide="https://login.infomaniak.com" type="url" />
                <Champ id={`oc-${tenant}`} nom="client_id" libelle="Identifiant client" />
                <Champ id={`os-${tenant}`} nom="client_secret" libelle="Secret client" type="password" />
                <p className="text-xs text-muted-foreground">Le secret est chiffré chez Veridian et ne s&apos;affiche plus jamais.</p>
                <Button type="submit" className="self-start">Enregistrer</Button>
              </form>
            </details>
            <details>
              <summary className="cursor-pointer text-sm font-medium">{idp ? 'Remplacer par SAML' : 'SAML 2.0'}</summary>
              <form method="post" action="/api/organisations/fournisseur" className="flex flex-col gap-3 pt-3" autoComplete="off">
                <input type="hidden" name="tenant" value={tenant} />
                <input type="hidden" name="geste" value="poser" />
                <input type="hidden" name="protocole" value="saml" />
                <p className="text-sm">
                  Chez votre fournisseur, adresse de réponse (ACS) : <code className={A_DONNER}>{adresses.acs}</code>
                </p>
                <p className="text-sm">
                  Identifiant d&apos;entité (audience) : <code className={A_DONNER}>{adresses.entite}</code>
                </p>
                <p className="text-xs text-muted-foreground">Identifiant de la personne : format « persistent », jamais son adresse. Assertion signée, SHA-256.</p>
                <Champ id={`si-${tenant}`} nom="issuer" libelle="Identifiant d'entité du fournisseur" />
                <Champ id={`su-${tenant}`} nom="sso_url" libelle="Adresse de connexion (SSO)" type="url" />
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`sc-${tenant}`}>Certificat de signature (X.509)</Label>
                  <textarea id={`sc-${tenant}`} name="certificat" required rows={5} className="rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" placeholder="-----BEGIN CERTIFICATE-----" />
                </div>
                <Button type="submit" className="self-start">Enregistrer</Button>
              </form>
            </details>
          </>
        ) : null}
      </div>
    </details>
  );
}
