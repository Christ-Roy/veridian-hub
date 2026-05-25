/**
 * /dashboard/settings/mail — Mail Sender Gmail connection UI.
 *
 * 3 états visuels selon l'Account de l'user :
 *   1. Aucun Account avec scope gmail.send → bouton "Connecter mon Gmail"
 *      (redirect /api/gmail/connect)
 *   2. Account présent + needsReauth=true → warning rouge "Reconnexion requise"
 *      + bouton "Reconnecter"
 *   3. Account présent + needsReauth=false → status vert "Gmail connecté"
 *      + bouton "Tester l'envoi" + bouton "Déconnecter"
 *
 * Affiche également le dernier mail envoyé (MailEvent le plus récent pour cet
 * user) à des fins de feedback rapide après le test.
 */

import { redirect } from 'next/navigation';
import { Mail, AlertTriangle, CheckCircle2 } from 'lucide-react';

import { getCurrentUser } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';
import { scopeIncludesGmailSend } from '@/lib/mail/gmail-oauth';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DashboardPageHeader } from '@/components/dashboard/PageHeader';
import { MailSenderActions } from './MailSenderActions';

export const dynamic = 'force-dynamic';

export default async function MailSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const params = await searchParams;
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  const accounts = await prisma.account.findMany({
    where: { userId: user.id, provider: 'google' },
    select: {
      id: true,
      providerAccountId: true,
      mailSendScope: true,
      mailSendNeedsReauth: true,
      expires_at: true,
    },
  });

  const linkedAccount = accounts.find((a) =>
    scopeIncludesGmailSend(a.mailSendScope),
  );

  const lastMailEvent = await prisma.mailEvent.findFirst({
    where: { userId: user.id },
    orderBy: { sentAt: 'desc' },
    select: {
      id: true,
      recipient: true,
      subject: true,
      status: true,
      appSource: true,
      sentAt: true,
      errorMessage: true,
    },
  });

  const status = params.status;
  const needsReauth = Boolean(linkedAccount?.mailSendNeedsReauth);
  const isConnected = Boolean(linkedAccount) && !needsReauth;

  return (
    <div className="flex flex-col gap-8 p-4 md:p-8 max-w-4xl mx-auto w-full">
      <DashboardPageHeader
        title="Compte d'envoi mail"
        description="Connectez votre Gmail pour envoyer des emails depuis vos apps Veridian au nom de votre adresse."
        icon={Mail}
      />

      {status === 'connected' && (
        <div
          className="rounded-lg border border-success/40 bg-success/5 p-4 text-sm text-success"
          role="status"
        >
          <strong>Gmail connecté.</strong> Vous pouvez maintenant tester un envoi.
        </div>
      )}
      {status === 'denied' && (
        <div
          className="rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm text-warning"
          role="status"
        >
          Vous avez refusé l&apos;autorisation Google. Aucune connexion n&apos;a été enregistrée.
        </div>
      )}
      {status === 'invalid_state' && (
        <div
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"
          role="status"
        >
          Tentative invalide (CSRF). Veuillez réessayer.
        </div>
      )}
      {status === 'oauth_failed' && (
        <div
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"
          role="status"
        >
          L&apos;échange OAuth a échoué. Veuillez réessayer dans quelques instants.
        </div>
      )}
      {status === 'email_mismatch' && (
        <div
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"
          role="status"
        >
          Le compte Google connecté ({user.email}) ne correspond pas à votre adresse Veridian.
          Connectez-vous avec le bon compte Google.
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle>Gmail</CardTitle>
              <CardDescription>
                Envoyez depuis votre adresse Gmail personnelle ou pro.
              </CardDescription>
            </div>
            {isConnected && (
              <Badge variant="success" className="gap-1">
                <CheckCircle2 className="h-3 w-3" />
                Connecté
              </Badge>
            )}
            {needsReauth && (
              <Badge variant="destructive" className="gap-1">
                <AlertTriangle className="h-3 w-3" />
                Reconnexion requise
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {needsReauth && (
            <div
              className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"
              role="alert"
            >
              <p className="font-semibold mb-1">Votre autorisation Gmail a été révoquée.</p>
              <p>
                Cliquez sur « Reconnecter » pour donner à nouveau accès à votre compte Gmail.
                Sans cela, aucun mail ne pourra être envoyé en votre nom.
              </p>
            </div>
          )}

          {isConnected ? (
            <div className="text-sm text-muted-foreground">
              Votre compte Google est connecté avec le scope <code>gmail.send</code>.
              Les apps Veridian peuvent envoyer des mails en votre nom via le broker Hub.
            </div>
          ) : !needsReauth ? (
            <div className="text-sm text-muted-foreground">
              Aucun compte Gmail connecté pour l&apos;envoi.
              Cliquez sur « Connecter mon Gmail » pour démarrer.
            </div>
          ) : null}

          <MailSenderActions
            isConnected={isConnected}
            needsReauth={needsReauth}
          />
        </CardContent>
      </Card>

      {lastMailEvent && (
        <Card>
          <CardHeader>
            <CardTitle>Dernier envoi</CardTitle>
            <CardDescription>
              Trace du dernier email envoyé via le broker Hub.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="text-sm space-y-2">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Destinataire</dt>
                <dd className="font-mono text-xs truncate">{lastMailEvent.recipient}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Sujet</dt>
                <dd className="truncate">{lastMailEvent.subject}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">App source</dt>
                <dd>
                  <Badge variant="outline">{lastMailEvent.appSource}</Badge>
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Statut</dt>
                <dd>
                  <Badge
                    variant={
                      lastMailEvent.status === 'sent'
                        ? 'success'
                        : lastMailEvent.status === 'needs_reauth'
                          ? 'destructive'
                          : 'destructive'
                    }
                  >
                    {lastMailEvent.status}
                  </Badge>
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Envoyé</dt>
                <dd>
                  {new Date(lastMailEvent.sentAt).toLocaleString('fr-FR')}
                </dd>
              </div>
              {lastMailEvent.errorMessage && (
                <div className="pt-2 border-t">
                  <dt className="text-muted-foreground mb-1">Erreur</dt>
                  <dd className="text-destructive font-mono text-xs break-all">
                    {lastMailEvent.errorMessage}
                  </dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
