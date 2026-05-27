"use client";

import { BrainCircuit } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export interface CrmUsageView {
  used: number;
  limit: number;
  /**
   * Indique que les chiffres affichés sont un MOCK visuel (pas la vraie
   * conso). On en profite pour afficher une bannière "preview" pour ne
   * pas induire le user en erreur. Sera retiré quand le tracker tokens
   * IA sera livré + les limites par plan figées côté business.
   */
  mock?: boolean;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function CrmUsageCard({ usage }: { usage: CrmUsageView }) {
  const pct = usage.limit > 0
    ? Math.min(100, Math.round((usage.used / usage.limit) * 100))
    : 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <BrainCircuit className="h-5 w-5 text-primary" />
          <CardTitle>Quota IA ce mois</CardTitle>
          {usage.mock && (
            <Badge variant="secondary" className="ml-auto">
              Aperçu
            </Badge>
          )}
        </div>
        <CardDescription>
          {usage.mock
            ? 'Aperçu visuel — les chiffres réels arrivent quand le tracker tokens IA sera branché.'
            : 'Tokens consommés par les agents IA du CRM (rédaction emails, scoring leads, résumés…).'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">
              {formatTokens(usage.used)} / {formatTokens(usage.limit)} tokens
            </span>
            <span className="text-muted-foreground">{pct}%</span>
          </div>
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
