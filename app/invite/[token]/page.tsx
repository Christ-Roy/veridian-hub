import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle, XCircle, Clock, LogIn } from 'lucide-react';
import Logo from '@/components/icons/Logo';
import { WORKSPACE_ROLE_LABELS } from '@/types/workspace';
import type { WorkspaceRole } from '@/types/workspace';
import { getCurrentUser } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';
import { getAuthTypes } from '@/utils/auth-helpers/settings';
import { AcceptInviteButton } from './AcceptInviteButton';
import { AcceptCrossAppInviteButton } from './AcceptCrossAppInviteButton';
import { InviteSignInOptions } from './InviteSignInOptions';

type TokenStatus = 'valid' | 'expired' | 'consumed' | 'not_found';
type InvitationKind = 'workspace' | 'cross_app';

interface BaseTokenInfo {
  status: TokenStatus;
  kind?: InvitationKind;
  email?: string;
}

interface WorkspaceTokenInfo extends BaseTokenInfo {
  kind: 'workspace';
  role?: WorkspaceRole;
  workspaceName?: string;
  invitationId?: string;
  workspaceId?: string;
}

interface CrossAppTokenInfo extends BaseTokenInfo {
  kind: 'cross_app';
  targetApp?: 'notifuse' | 'prospection' | 'analytics' | 'cms';
  targetWorkspaceId?: string;
  targetRole?: string;
  inviterName?: string | null;
  inviterEmail?: string;
  message?: string | null;
  invitationId?: string;
}

type TokenInfo = WorkspaceTokenInfo | CrossAppTokenInfo | { status: Exclude<TokenStatus, 'valid'> };

// Le token cross-app est généré côté Hub en 32 bytes hex (64 chars).
// Les invitations workspace internes utilisent le même format (randomBytes(32)),
// donc on essaie les 2 modèles sans pouvoir distinguer par le shape seul.
const TOKEN_FORMAT = /^[0-9a-f]{64}$/;

const APP_LABEL: Record<'notifuse' | 'prospection' | 'analytics' | 'cms', string> = {
  notifuse: 'Notifuse',
  prospection: 'Prospection',
  analytics: 'Analytics',
  cms: 'CMS',
};

async function validateToken(token: string): Promise<TokenInfo> {
  if (!TOKEN_FORMAT.test(token)) {
    return { status: 'not_found' };
  }

  // Cross-app invitations prennent la priorité car c'est le flow nouveau
  // et le plus visible (Notifuse / Prospection). En cas de collision improbable
  // de token, on retombe sur la workspace invite si la cross_app est absente.
  const crossApp = await prisma.crossAppInvitation.findUnique({
    where: { token },
    include: {
      inviter: { select: { id: true, name: true, email: true } },
    },
  });

  if (crossApp) {
    if (crossApp.acceptedAt) return { status: 'consumed' };
    if (crossApp.expiresAt < new Date()) return { status: 'expired' };
    return {
      status: 'valid',
      kind: 'cross_app',
      email: crossApp.inviteeEmail,
      targetApp: crossApp.targetApp as 'notifuse' | 'prospection' | 'analytics' | 'cms',
      targetWorkspaceId: crossApp.targetWorkspaceId,
      targetRole: crossApp.targetRole,
      inviterName: crossApp.inviter.name,
      inviterEmail: crossApp.inviter.email,
      message: crossApp.message,
      invitationId: crossApp.id,
    };
  }

  const workspace = await prisma.invitation.findUnique({
    where: { token },
    include: { workspace: { select: { name: true, id: true } } },
  });

  if (!workspace) return { status: 'not_found' };
  if (workspace.acceptedAt) return { status: 'consumed' };
  if (workspace.expiresAt < new Date()) return { status: 'expired' };

  return {
    status: 'valid',
    kind: 'workspace',
    email: workspace.email,
    role: workspace.role as WorkspaceRole,
    workspaceName: workspace.workspace.name,
    invitationId: workspace.id,
    workspaceId: workspace.workspace.id,
  };
}

function LogoHeader() {
  return (
    <div className="flex justify-center mb-8">
      <Link href="/" className="flex items-center gap-2">
        <Logo className="h-7 w-7" />
        <span className="font-semibold text-lg">Veridian</span>
      </Link>
    </div>
  );
}

interface Props {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ accepted?: string }>;
}

export default async function InvitePage({ params, searchParams }: Props) {
  const { token } = await params;
  const _searchParams = await searchParams;
  const tokenInfo = await validateToken(token);

  const user = await getCurrentUser();
  const { allowOauth } = getAuthTypes();

  // Token invalide ou expiré
  if (tokenInfo.status !== 'valid') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-background">
        <div className="w-full max-w-sm">
          <LogoHeader />
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

  // Token valide mais utilisateur non connecté — afficher options de connexion
  // (OAuth + email/password + signup) inline. Mémorise le token comme returnTo
  // pour que l'user retombe sur cette page après auth.
  if (!user) {
    const returnTo = `/invite/${token}`;
    const subjectLabel =
      tokenInfo.kind === 'cross_app'
        ? APP_LABEL[tokenInfo.targetApp!]
        : tokenInfo.workspaceName ?? 'votre workspace';
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-background">
        <div className="w-full max-w-sm">
          <LogoHeader />
          <Card>
            <CardHeader className="text-center">
              <LogIn className="h-12 w-12 mx-auto text-primary mb-2" />
              <CardTitle>Connectez-vous pour accepter</CardTitle>
              <CardDescription>
                Vous avez été invité{' '}
                {tokenInfo.kind === 'cross_app' ? 'sur' : 'à rejoindre'}{' '}
                <strong>{subjectLabel}</strong>
                {tokenInfo.email ? (
                  <>
                    {' '}— invité&middot;e en tant que{' '}
                    <strong>{tokenInfo.email}</strong>
                  </>
                ) : null}
                .
              </CardDescription>
            </CardHeader>
            <CardContent>
              <InviteSignInOptions
                token={token}
                returnTo={returnTo}
                inviteeEmail={tokenInfo.email}
                allowOauth={allowOauth}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // Token valide + utilisateur connecté — vérifier que l'email correspond
  // (workspace : strict ; cross_app : warning et continue possible — l'API
  //  accepte le mismatch si on lui passe allow_email_mismatch=true).
  if (tokenInfo.email && user.email !== tokenInfo.email) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-background">
        <div className="w-full max-w-sm">
          <LogoHeader />
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

  // Acceptation workspace en cours (POST-redirect, ancien flow Invitation)
  if (_searchParams.accepted === '1' && tokenInfo.kind === 'workspace') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-background">
        <div className="w-full max-w-sm">
          <LogoHeader />
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

  // Cross-app invite : page de confirmation avec gestion 3 cas downstream.
  if (tokenInfo.kind === 'cross_app') {
    const appLabel = APP_LABEL[tokenInfo.targetApp!];
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-background">
        <div className="w-full max-w-md">
          <LogoHeader />
          <Card>
            <CardHeader className="text-center">
              <LogIn className="h-12 w-12 mx-auto text-primary mb-2" />
              <CardTitle>Rejoindre {appLabel}</CardTitle>
              <CardDescription>
                <strong>{tokenInfo.inviterName ?? tokenInfo.inviterEmail}</strong>{' '}
                vous invite à rejoindre <strong>{appLabel}</strong> en tant que{' '}
                <strong>{tokenInfo.targetRole}</strong>.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {tokenInfo.message ? (
                <blockquote className="border-l-2 border-muted pl-3 text-sm text-muted-foreground italic mb-4">
                  «&nbsp;{tokenInfo.message}&nbsp;»
                </blockquote>
              ) : null}
              <p className="text-sm text-muted-foreground text-center">
                Connecté en tant que <strong>{user.email}</strong>
              </p>
            </CardContent>
            <CardFooter className="flex flex-col gap-2">
              <AcceptCrossAppInviteButton
                token={token}
                appLabel={appLabel}
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

  // Workspace invite (flow existant — inchangé)
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="w-full max-w-sm">
        <LogoHeader />
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
            <AcceptInviteButton
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

// Avoid Next 15 "unused redirect" warning if we ever short-circuit; keep import.
void redirect;
