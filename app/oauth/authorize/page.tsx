// Consentement OAuth d'un client IA à la porte MCP Veridian (docs/CONTRAT-MCP.md).
// Une demande dont le client ou l'adresse de retour est inconnu ne redirige jamais : elle s'affiche.
import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { VeridianHubLogo } from '@/components/icons/VeridianHubLogo';
import { isEmailProvenForSession } from '@/lib/auth/email-proof';
import { getCurrentUser } from '@/lib/auth/get-user';
import { validerDemande } from '@/lib/mcp/oauth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const CHAMPS = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'] as const;

function Ecran({ titre, children }: { titre: string; children: React.ReactNode }) {
  return (
    <div className="auth-screen min-h-screen w-full flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-6">
          <VeridianHubLogo size="md" href="/" />
        </div>
        <Card className="relief-card border p-6 space-y-4">
          <h1 className="text-xl font-semibold">{titre}</h1>
          {children}
        </Card>
      </div>
    </div>
  );
}

export default async function AutoriserPage({ searchParams }: Props) {
  const brut = await searchParams;
  const p: Record<string, string | undefined> = {};
  for (const k of CHAMPS) {
    const v = brut[k];
    if (typeof v === 'string') p[k] = v;
  }

  const user = await getCurrentUser();
  if (!user) {
    const ici = `/oauth/authorize?${new URLSearchParams(p as Record<string, string>).toString()}`;
    redirect(`/login?callbackUrl=${encodeURIComponent(ici)}`);
  }

  const v = await validerDemande(prisma, p);
  if (!v.ok && v.fatale) {
    return (
      <Ecran titre="Demande de connexion refusée">
        <p className="text-sm text-muted-foreground">{v.erreur.description}. Relancez la connexion depuis votre assistant IA.</p>
      </Ecran>
    );
  }
  if (!v.ok) {
    const u = new URL(v.redirectUri!);
    u.searchParams.set('error', v.erreur.code);
    u.searchParams.set('error_description', v.erreur.description);
    if (v.state) u.searchParams.set('state', v.state);
    redirect(u.toString());
  }

  const session = await auth();
  if (session?.user?.impersonated === true) {
    return (
      <Ecran titre="Impossible en impersonation">
        <p className="text-sm text-muted-foreground">Une connexion IA ne s&apos;autorise que par le titulaire du compte.</p>
      </Ecran>
    );
  }
  if (!(await isEmailProvenForSession(user.id))) {
    return (
      <Ecran titre="Confirmez d'abord votre adresse">
        <p className="text-sm text-muted-foreground">
          Votre adresse {user.email} n&apos;est pas encore confirmée. Ouvrez votre espace Veridian pour recevoir le lien, puis relancez la connexion.
        </p>
      </Ecran>
    );
  }

  const d = v.demande;
  const retour = (() => {
    try {
      const u = new URL(d.redirectUri);
      return u.host || u.protocol;
    } catch {
      return d.redirectUri;
    }
  })();

  return (
    <Ecran titre="Connecter un assistant IA">
      <p className="text-sm">
        <strong>{d.clientName}</strong> demande à accéder à votre compte Veridian <strong>{user.email}</strong>.
      </p>
      <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">
        <li>Il pourra utiliser, en votre nom, les outils de vos apps Veridian (lire et agir).</li>
        <li>Vous pourrez couper cet accès à tout moment depuis Réglages, Sécurité.</li>
        <li>Retour vers : {retour}</li>
      </ul>
      <form method="post" action="/api/oauth/authorize" className="flex gap-3 pt-2">
        {CHAMPS.map((k) => (p[k] !== undefined ? <input key={k} type="hidden" name={k} value={p[k]} /> : null))}
        <Button type="submit" name="decision" value="autoriser" className="flex-1">
          Autoriser
        </Button>
        <Button type="submit" name="decision" value="refuser" variant="outline" className="flex-1">
          Refuser
        </Button>
      </form>
    </Ecran>
  );
}
