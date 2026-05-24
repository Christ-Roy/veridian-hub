/**
 * Tests RTL pour `<RecentInvoicesCard />`.
 *
 * Couvre :
 *  - rend null si invoices=[] (pas de "Aucune facture" anxiogène)
 *  - rend N lignes de table avec date formatée FR + montant formaté EUR
 *  - badge statut FR ("Payée", "En attente", "Annulée")
 *  - icône Download (link target=_blank) si hostedInvoiceUrl, "—" sinon
 *  - description plurielle/singulière correcte
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RecentInvoicesCard } from '@/app/dashboard/billing/RecentInvoicesCard';
import type { InvoiceView } from '@/lib/stripe/invoices';

const sample: InvoiceView = {
  id: 'in_1',
  number: 'INV-001',
  createdAt: '2026-05-20T10:00:00.000Z',
  amountPaid: 2900, // 29,00€
  currency: 'eur',
  status: 'paid',
  hostedInvoiceUrl: 'https://stripe.invoice/1',
};

describe('<RecentInvoicesCard>', () => {
  it('rend null si invoices=[]', () => {
    const { container } = render(<RecentInvoicesCard invoices={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('rend une ligne avec date FR, montant EUR, badge "Payée"', () => {
    render(<RecentInvoicesCard invoices={[sample]} />);
    // Date formatée FR (mai 2026)
    expect(screen.getByText(/mai\.?\s+2026/i)).toBeInTheDocument();
    expect(screen.getByText('INV-001')).toBeInTheDocument();
    // Montant : 2900 cents → 29,00 €
    expect(screen.getByText(/29,00\s*€/)).toBeInTheDocument();
    expect(screen.getByText('Payée')).toBeInTheDocument();
  });

  it('rend icône Download (link target=_blank) si hostedInvoiceUrl', () => {
    render(<RecentInvoicesCard invoices={[sample]} />);
    const link = screen.getByRole('link', { name: /télécharger la facture/i }) as HTMLAnchorElement;
    expect(link).toBeInTheDocument();
    expect(link.target).toBe('_blank');
    expect(link.href).toContain('https://stripe.invoice/1');
  });

  it('rend "—" si hostedInvoiceUrl null', () => {
    const noUrl: InvoiceView = { ...sample, hostedInvoiceUrl: null };
    const { container } = render(<RecentInvoicesCard invoices={[noUrl]} />);
    // Pas de link Download
    expect(screen.queryByRole('link', { name: /télécharger/i })).toBeNull();
    expect(container.textContent).toContain('—');
  });

  it('badge statut mappe correctement open → "En attente"', () => {
    render(<RecentInvoicesCard invoices={[{ ...sample, status: 'open' }]} />);
    expect(screen.getByText('En attente')).toBeInTheDocument();
  });

  it('badge statut mappe void → "Annulée"', () => {
    render(<RecentInvoicesCard invoices={[{ ...sample, status: 'void' }]} />);
    expect(screen.getByText('Annulée')).toBeInTheDocument();
  });

  it('description singulier si 1 facture, pluriel si >1', () => {
    const { rerender } = render(<RecentInvoicesCard invoices={[sample]} />);
    expect(screen.getByText(/1 dernière facture/)).toBeInTheDocument();

    rerender(
      <RecentInvoicesCard
        invoices={[sample, { ...sample, id: 'in_2', number: 'INV-002' }]}
      />,
    );
    expect(screen.getByText(/2 dernières factures/)).toBeInTheDocument();
  });

  it('numéro null affiche "—"', () => {
    const noNumber: InvoiceView = { ...sample, number: null };
    render(<RecentInvoicesCard invoices={[noNumber]} />);
    const rows = screen.getAllByRole('row');
    // Première row data (skip header)
    const dataRow = rows[1];
    expect(dataRow.textContent).toContain('—');
  });
});
