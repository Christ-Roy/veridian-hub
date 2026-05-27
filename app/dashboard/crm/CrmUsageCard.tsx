"use client";

import Link from 'next/link';
import { BrainCircuit, Plus } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export interface CrmUsageView {
  used: number;
  limit: number;
  /** Label du pack à acheter quand on dépasse — null si pas de pack offert. */
  packCta: { label: string; href: string } | null;
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
  const overQuota = usage.used >= usage.limit;
  const color = overQuota
    ? 'bg-destructive'
    : pct > 80
    ? 'bg-yellow-500'
    : 'bg-primary';

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <BrainCircuit className="h-5 w-5 text-primary" />
          <CardTitle>Quota IA ce mois</CardTitle>
        </div>
        <CardDescription>
          Tokens consommés par les agents IA du CRM (rédaction emails, scoring
          leads, résumés…).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">
              {formatTokens(usage.used)} / {formatTokens(usage.limit)} tokens
            </span>
            <span
              className={overQuota ? 'font-medium text-destructive' : 'text-muted-foreground'}
            >
              {pct}%
            </span>
          </div>
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={`h-full transition-all ${color}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
        {overQuota && usage.packCta && (
          <Button asChild variant="default">
            <Link href={usage.packCta.href}>
              <Plus className="mr-2 h-4 w-4" />
              {usage.packCta.label}
            </Link>
          </Button>
        )}
        {!overQuota && pct > 80 && usage.packCta && (
          <Button asChild variant="outline">
            <Link href={usage.packCta.href}>
              <Plus className="mr-2 h-4 w-4" />
              {usage.packCta.label}
            </Link>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
