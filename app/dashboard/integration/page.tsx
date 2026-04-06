import { createClient } from '@/utils/supabase/server';
import { redirect } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Zap, Clock } from 'lucide-react';

/**
 * INTEGRATION PAGE - Prochainement
 *
 * Cette fonctionnalité sera disponible prochainement
 */

export default async function IntegrationPage() {
  const supabase = createClient();

  // Vérifier auth
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect('/login');
  }

  return (
    <div className="container mx-auto p-8 max-w-4xl">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <Zap className="h-8 w-8 text-muted-foreground/50" />
          <h1 className="text-4xl font-bold tracking-tight text-muted-foreground/50">
            Integrations
          </h1>
        </div>
        <p className="text-muted-foreground/70">
          Synchronisez vos contacts entre Twenty CRM et Notifuse
        </p>
      </div>

      {/* Coming Soon Card */}
      <Card className="shadow-lg opacity-60">
        <CardContent className="p-12">
          <div className="flex flex-col items-center justify-center text-center space-y-6">
            {/* Icon */}
            <div className="h-24 w-24 rounded-full bg-muted flex items-center justify-center">
              <Clock className="h-12 w-12 text-muted-foreground" />
            </div>

            {/* Title */}
            <h2 className="text-3xl font-bold text-muted-foreground">
              Prochainement
            </h2>

            {/* Description */}
            <p className="text-muted-foreground max-w-md">
              La synchronisation entre Twenty CRM et Notifuse sera bientôt disponible.
              Cette fonctionnalité est actuellement en développement.
            </p>

            {/* Features preview */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full max-w-2xl mt-8">
              <div className="p-4 rounded-lg border bg-muted/30 text-left">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-muted-foreground">📊</span>
                  <span className="font-medium text-muted-foreground">Twenty CRM</span>
                </div>
                <p className="text-sm text-muted-foreground/70">
                  Synchronisation automatique des contacts
                </p>
              </div>

              <div className="p-4 rounded-lg border bg-muted/30 text-left">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-muted-foreground">📧</span>
                  <span className="font-medium text-muted-foreground">Notifuse</span>
                </div>
                <p className="text-sm text-muted-foreground/70">
                  Intégration email marketing
                </p>
              </div>

              <div className="p-4 rounded-lg border bg-muted/30 text-left">
                <div className="flex items-center gap-2 mb-2">
                  <Zap className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium text-muted-foreground">Sync automatique</span>
                </div>
                <p className="text-sm text-muted-foreground/70">
                  Mise à jour en temps réel
                </p>
              </div>

              <div className="p-4 rounded-lg border bg-muted/30 text-left">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-muted-foreground">🔄</span>
                  <span className="font-medium text-muted-foreground">Bi-directionnelle</span>
                </div>
                <p className="text-sm text-muted-foreground/70">
                  Synchronisation dans les deux sens
                </p>
              </div>
            </div>

            {/* Info */}
            <div className="mt-8 p-4 bg-muted/50 rounded-lg border max-w-md">
              <p className="text-sm text-muted-foreground">
                💡 Vous serez notifié lorsque cette fonctionnalité sera disponible.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
