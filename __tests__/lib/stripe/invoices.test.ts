/**
 * Tests pour `lib/stripe/invoices.ts`.
 *
 * Couvre :
 *  - renvoie [] si stripeCustomerId null (no-op safe pour users sans Customer)
 *  - clamp limit dans [1..100]
 *  - mapping shape Stripe → InvoiceView (Unix timestamp → ISO, fallbacks
 *    `number` et `hosted_invoice_url`)
 *  - swallow error Stripe → [] (best-effort, ne bloque pas la page)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const stripeInvoicesListMock = vi.fn();

vi.mock('@/utils/stripe/config', () => ({
  stripe: {
    invoices: {
      list: (...args: unknown[]) => stripeInvoicesListMock(...args),
    },
  },
}));

beforeEach(() => {
  stripeInvoicesListMock.mockReset();
});

describe('getRecentInvoices', () => {
  it('renvoie [] si stripeCustomerId null sans appeler Stripe', async () => {
    const { getRecentInvoices } = await import('@/lib/stripe/invoices');
    const result = await getRecentInvoices(null);
    expect(result).toEqual([]);
    expect(stripeInvoicesListMock).not.toHaveBeenCalled();
  });

  it('clamp limit < 1 à 1', async () => {
    stripeInvoicesListMock.mockResolvedValueOnce({ data: [] });
    const { getRecentInvoices } = await import('@/lib/stripe/invoices');
    await getRecentInvoices('cus_x', 0);
    expect(stripeInvoicesListMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1 }),
    );
  });

  it('clamp limit > 100 à 100 (cap Stripe API)', async () => {
    stripeInvoicesListMock.mockResolvedValueOnce({ data: [] });
    const { getRecentInvoices } = await import('@/lib/stripe/invoices');
    await getRecentInvoices('cus_x', 500);
    expect(stripeInvoicesListMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
  });

  it('mappe shape Stripe → InvoiceView (Unix → ISO, defaults)', async () => {
    stripeInvoicesListMock.mockResolvedValueOnce({
      data: [
        {
          id: 'in_1',
          number: 'INV-001',
          created: 1700000000,
          amount_paid: 2900,
          currency: 'eur',
          status: 'paid',
          hosted_invoice_url: 'https://stripe.invoice/1',
        },
        {
          id: 'in_2',
          number: null,
          created: 1710000000,
          amount_paid: 0,
          currency: 'eur',
          status: null,
          hosted_invoice_url: null,
        },
      ],
    });

    const { getRecentInvoices } = await import('@/lib/stripe/invoices');
    const result = await getRecentInvoices('cus_x', 2);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: 'in_1',
      number: 'INV-001',
      createdAt: new Date(1700000000 * 1000).toISOString(),
      amountPaid: 2900,
      currency: 'eur',
      status: 'paid',
      hostedInvoiceUrl: 'https://stripe.invoice/1',
    });
    expect(result[1].number).toBeNull();
    expect(result[1].status).toBe('draft'); // fallback
    expect(result[1].hostedInvoiceUrl).toBeNull();
  });

  it('swallow error Stripe → [] (best-effort, log console)', async () => {
    stripeInvoicesListMock.mockRejectedValueOnce(new Error('Stripe API down'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getRecentInvoices } = await import('@/lib/stripe/invoices');
    const result = await getRecentInvoices('cus_x', 3);
    expect(result).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
