import { createClient } from '@/utils/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle, XCircle, Clock, LogIn } from 'lucide-react';
import Logo from '@/components/icons/Logo';
import { WORKSPACE_ROLE_LABELS } from '@/types/workspace';
import type { WorkspaceRole } from '@/types/workspace';

// TODO(P1.5): Quand Prisma est dispo, remplacer validateToken() par la vraie requête

const PRISMA_READY = false;

type TokenStatus = 'valid' | 'expired' | 'consumed' | 'not_found';

interface TokenInfo {
  status: TokenStatus;
  email?: string;
  role?: WorkspaceRole;
  workspaceName?: string;
  invitationId?: string;
  workspaceId?: string;
}

async function validateToken(token: string): Promise<TokenInfo> {
  if (!PRISMA_READY) {
    // Stub démo — simule un token valide pour les tests
    if (token === 'demo') {
      return {
        status: 'valid',
        email: 'invite@example.com',
        role: 'MEMBER',
        workspaceName: 'Mon Workspace',
        invitationId: 'inv_demo',
        workspaceId: 'ws_demo',
      };
    }
    return { status: 'not_found' };
  }

  // ==== IMPLÉMENTATION PRISMA ====
  // const prisma = getPrismaClient();
  // const invitation = await prisma.invitation.findUnique({
  //   where: { token },
  //   include: { workspace: { select: { name: true, id: true } } },
  // });
  // if (!invitation) return { status: 'not_found' };
  // if (invitation.acceptedAt) return { status: 'consumed' };
  // if (invitation.expiresAt < new Date()) return { status: 'expired' };
  // return {
  //   status: 'valid',
  //   email: invitation.email,
  //   role: invitation.role as WorkspaceRole,
  //   workspaceName: invitation.workspace.name,
  //   invitationId: invitation.id,
  //   workspaceId: invitation.workspace.id,
  // };
  // ================================
  return { status: 'not_found' };
}

async function acceptInvitation(invitationId: string, userId: string, workspaceId: string, role: WorkspaceRole): Promise<void> {
  if (!PRISMA_READY) return;

  // ==== IMPLÉMENTATION PRISMA ====
  // const prisma = getPrismaClient();
  // await prisma.$transaction([
  //   prisma.workspaceMember.create({
  //     data: { workspaceId, userId, role, joinedAt: new Date() },
  //   }),
  //   prisma.invitation.update({
  //     where: { id: invitationId },
  //     data: { acceptedAt: new Date() },
  //   }),
  // ]);
  // ================================
}

interface Props {
  params: { token: string };
  searchParams: { accepted?: string };
}

export default async function InvitePage({ params, searchParams }: Props) {
  const { token } = params;
  const tokenInfo = await validateToken(token);

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Token invalide ou expiré
  if (tokenInfo.status !== 'valid') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-background">
        <div className="w-full max-w-sm">
          <div className="flex justify-center mb-8">
            <Link href="/" className="flex items-center gap-2">
              <Logo className="h-7 w-7" />
              <span className="font-semibold text-lg">Veridian</span>
            </Link>
          </div>
          <Card>
            <CardHeader className="text-center">
              {tokenInfo.status === 'expired' ? (
                <Clock className="h-12 w-12 mx-auto text-amber-500 mb-2" />
              ) : tokenInfo.status === 'consumed' ? (
                <CheckCircle className="h-12 w-12 mx-auto text-muted-foreground mb-2" />
              ) : (
                <XCircle className="h-12 w-12 mx-auto text-destructive mb-2" />
              )}
              <CardTitle>
                {tokenInfo.status === 'expired' && 'Invitation expirée'}
                {tokenInfo.status === 'consumed' && 'Invitation déjà utilisée'}
                {tokenInfo.status === 'not_found' && 'Invitation introuvable'}
              </CardTitle>
              <CardDescription>
                {tokenInfo.status === 'expired' &&
                  'Ce lien d\'invitation a expiré. Demandez à l\'administrateur de vous renvoyer une invitation.'}
                {tokenInfo.status === 'consumed' &&
                  'Cette invitation a déjà été acceptée. Si vous avez un compte, connectez-vous.'}
                {tokenInfo.status === 'not_found' &&
                  'Ce lien d\'invitation est invalide ou a déjà été utilisé.'}
              </CardDescription>
            </CardHeader>
            <CardFooter className="flex justify-center">
              <Button asChild variant="outline">
                <Link href={user ? '/dashboard' : '/login'}>
                  {user ? 'Retour au dashboard' : 'Se connecter'}
                </Link>
              </Button>
            </CardFooter>
          </Card>
        </div>
      </div>
    );
  }

  // Token valide mais utilisateur non connecté — rediriger vers login avec retour
  if (!user) {
    const loginUrl = `/login?redirect=${encodeURIComponent(`/invite/${token}`)}`;
    redirect(loginUrl);
  }

  // Token valide + utilisateur connecté — vérifier que l'email correspond
  if (tokenInfo.email && user.email !== tokenInfo.email) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-background">
        <div className="w-full max-w-sm">
          <div className="flex justify-center mb-8">
            <Link href="/" className="flex items-center gap-2">
              <Logo className="h-7 w-7" />
              <span className="font-semibold text-lg">Veridian</span>
            </Link>
          </div>
          <Card>
            <CardHeader className="text-center">
              <XCircle className="h-12 w-12 mx-auto text-destructive mb-2" />
              <CardTitle>Mauvais compte</CardTitle>
              <CardDescription>
                Cette invitation est destinée à <strong>{tokenInfo.email}</strong>.
                Vous êtes connecté avec <strong>{user.email}</strong>.
                Déconnectez-vous et reconnectez-vous avec le bon compte.
              </CardDescription>
            </CardHeader>
            <CardFooter className="flex justify-center gap-2">
              <Button asChild variant="outline">
                <Link href="/dashboard">Rester connecté</Link>
              </Button>
            </CardFooter>
          </Card>
        </div>
      </div>
    );
  }

  // Acceptation en cours (POST-redirect)
  if (searchParams.accepted === '1') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-background">
        <div className="w-full max-w-sm">
          <div className="flex justify-center mb-8">
            <Link href="/" className="flex items-center gap-2">
              <Logo className="h-7 w-7" />
              <span className="font-semibold text-lg">Veridian</span>
            </Link>
          </div>
          <Card>
            <CardHeader className="text-center">
              <CheckCircle className="h-12 w-12 mx-auto text-green-500 mb-2" />
              <CardTitle>Invitation acceptée</CardTitle>
              <CardDescription>
                Vous avez rejoint <strong>{tokenInfo.workspaceName}</strong> en tant que{' '}
                <strong>{WORKSPACE_ROLE_LABELS[tokenInfo.role!]}</strong>.
              </CardDescription>
            </CardHeader>
            <CardFooter className="flex justify-center">
              <Button asChild>
                <Link href="/dashboard/workspace/members">Accéder au workspace</Link>
              </Button>
            </CardFooter>
          </Card>
        </div>
      </div>
    );
  }

  // Afficher la page de confirmation d'acceptation
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-8">
          <Link href="/" className="flex items-center gap-2">
            <Logo className="h-7 w-7" />
            <span className="font-semibold text-lg">Veridian</span>
          </Link>
        </div>
        <Card>
          <CardHeader className="text-center">
            <LogIn className="h-12 w-12 mx-auto text-primary mb-2" />
            <CardTitle>Rejoindre {tokenInfo.workspaceName}</CardTitle>
            <CardDescription>
              Vous avez été invité à rejoindre{' '}
              <strong>{tokenInfo.workspaceName}</strong> en tant que{' '}
              <strong>{WORKSPACE_ROLE_LABELS[tokenInfo.role!]}</strong>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground text-center">
              Connecté en tant que <strong>{user.email}</strong>
            </p>
          </CardContent>
          <CardFooter className="flex flex-col gap-2">
            <AcceptButton
              token={token}
              invitationId={tokenInfo.invitationId!}
              workspaceId={tokenInfo.workspaceId!}
              role={tokenInfo.role!}
              userId={user.id}
            />
            <Button asChild variant="ghost" size="sm">
              <Link href="/dashboard">Refuser</Link>
            </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}

// Composant client pour l'action d'acceptation
import { AcceptInviteButton as AcceptButton } from './AcceptInviteButton';
