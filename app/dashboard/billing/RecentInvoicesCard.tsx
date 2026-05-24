import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Download, Receipt } from 'lucide-react';
import type { InvoiceView } from '@/lib/stripe/invoices';

/**
 * Card "Dernières factures" — N lignes max (3 par défaut), avec icône
 * Download cliquable qui ouvre l'URL Stripe-hosted (PDF + ouverture/paiement
 * facture côté Stripe). Pas de Customer Portal en + d'une icône PDF inline
 * pour rester accessible/léger.
 *
 * Server Component pure : reçoit des InvoiceView déjà sérialisés (pas de
 * BigInt, pas de Date). Pas de fetch Stripe à l'intérieur — c'est la
 * responsabilité du parent (`billing/page.tsx`).
 *
 * Si la liste est vide → ne rend rien (return null). Comme ça pas de
 * "Aucune facture" qui fait peur sur un trial juste démarré ; les users
 * sans facture verront juste l'EmptyBillingState global de la page.
 */
export function RecentInvoicesCard({ invoices }: { invoices: InvoiceView[] }) {
  if (invoices.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <Receipt className="h-5 w-5 text-primary" />
          <div>
            <CardTitle>Dernières factures</CardTitle>
            <CardDescription>
              Aperçu des {invoices.length} dernière{invoices.length > 1 ? 's' : ''} facture
              {invoices.length > 1 ? 's' : ''}. Détails complets via le portail Stripe.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Numéro</TableHead>
              <TableHead className="text-right">Montant</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead className="text-right">PDF</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invoices.map((inv) => (
              <TableRow key={inv.id}>
                <TableCell className="text-sm">{formatDate(inv.createdAt)}</TableCell>
                <TableCell className="font-mono text-xs">{inv.number ?? '—'}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatAmount(inv.amountPaid, inv.currency)}
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(inv.status)}>{statusLabel(inv.status)}</Badge>
                </TableCell>
                <TableCell className="text-right">
                  {inv.hostedInvoiceUrl ? (
                    <Link
                      href={inv.hostedInvoiceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-end text-muted-foreground hover:text-primary"
                      aria-label={`Télécharger la facture ${inv.number ?? inv.id}`}
                    >
                      <Download className="h-4 w-4" />
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatAmount(cents: number, currency: string): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

function statusLabel(status: string): string {
  switch (status) {
    case 'paid':
      return 'Payée';
    case 'open':
      return 'En attente';
    case 'void':
      return 'Annulée';
    case 'uncollectible':
      return 'Impayée';
    case 'draft':
      return 'Brouillon';
    default:
      return status;
  }
}

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' | 'success' {
  switch (status) {
    case 'paid':
      return 'success';
    case 'open':
      return 'secondary';
    case 'uncollectible':
      return 'destructive';
    case 'void':
    case 'draft':
    default:
      return 'outline';
  }
}
