/**
 * Le dispatcher Stripe ne parle plus à Telegram (Robert, 23/11 puis 27/11 : Grafana seule source d'alertes). Une désynchronisation de
 * facturation sort en UNE ligne JSON sur stdout (`flux=alerte`), reprise par Loki puis la règle Grafana. Épreuves, sans mock de l'émetteur :
 *   - aucun `fetch` vers api.telegram.org, même avec les anciennes variables posées ;
 *   - ligne de la forme de la fiche 37 (nomad-veridian/docs/claude/37) ;
 *   - `critique` pour un vrai compte seulement : compte d'épreuve, organisation marquée de test et Stripe test ne le sont jamais ;
 *   - aucune adresse dans la ligne (dépôt et journaux CI publics).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';

const manage = vi.fn();
vi.mock('@/utils/stripe/prisma-sync', () => ({ manageSubscriptionStatusChange: (...a: unknown[]) => manage(...a) }));

const tenantFind = vi.fn();
const userFind = vi.fn();
vi.mock('@/lib/prisma', () => ({
  prisma: {
    subscription: { findFirst: vi.fn() },
    user: { findFirst: (...a: unknown[]) => userFind(...a) },
    tenant: { updateMany: vi.fn(), findFirst: (...a: unknown[]) => tenantFind(...a) },
  },
}));

const evt = (over: Record<string, unknown> = {}) =>
  ({ id: 'evt_1', type: 'customer.subscription.updated', livemode: true, data: { object: { id: 'sub_1', customer: 'cus_1' } }, ...over }) as unknown as Stripe.Event;
const echec = { tenantId: 'ten_1', applied: [], failures: [{ app: 'notifuse', targetPlan: 'pro', error: 'HTTP 500 pour jeanne.client@exemple.fr' }] };

let fetchSpy: ReturnType<typeof vi.fn>;
let sortie: string[];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
  process.env.ALERT_CHAT_ID = '42';
  fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
  sortie = [];
  for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void sortie.push(a.map(String).join(' ')));
  manage.mockResolvedValue(echec);
  tenantFind.mockResolvedValue({ userId: 'u-1', metadata: null });
  userFind.mockResolvedValue({ email: 'jeanne.client@exemple.fr' });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.ALERT_CHAT_ID;
});

const lignes = () => sortie.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).filter((j) => j.flux === 'alerte');

describe('dispatcher Stripe : alerte sans Telegram', () => {
  it('aucun appel à api.telegram.org, une ligne flux=alerte critique pour un vrai compte, sans adresse', async () => {
    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    await dispatchStripeEvent(evt());
    expect(fetchSpy.mock.calls.filter((c) => String(c[0]).includes('telegram'))).toEqual([]);
    const a = lignes();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ flux: 'alerte', gravite: 'critique', service: 'hub', impact: 'client', evenement: 'stripe.propagation_ko' });
    expect(a[0].detail).toMatchObject({ event_id: 'evt_1', event_type: 'customer.subscription.updated', tenant_id: 'ten_1', stripe_customer: 'cus_1' });
    expect(typeof a[0].dedup).toBe('string');
    expect(typeof a[0].ts).toBe('string');
    expect(sortie.join('\n')).not.toMatch(/@/);
  });

  it("jamais critique pour un compte d'épreuve", async () => {
    userFind.mockResolvedValue({ email: 'e2e-sso-ab12@veridian.site' });
    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    await dispatchStripeEvent(evt());
    expect(lignes().map((l) => l.gravite)).toEqual(['erreur']);
    expect(lignes()[0].impact).toBe('interne');
  });

  it('jamais critique pour une organisation marquée de test', async () => {
    tenantFind.mockResolvedValue({ userId: 'u-1', metadata: { organisation_de_test: { expire_le: new Date(Date.now() + 3_600_000).toISOString() } } });
    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    await dispatchStripeEvent(evt());
    expect(lignes().map((l) => l.gravite)).toEqual(['erreur']);
  });

  it('jamais critique pour un événement Stripe en mode test', async () => {
    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    await dispatchStripeEvent(evt({ livemode: false }));
    expect(lignes().map((l) => l.gravite)).toEqual(['erreur']);
  });

  it('dispatcher en échec : ligne critique (vrai compte), message sans adresse, aucun fetch', async () => {
    manage.mockRejectedValue(new Error('boom pour jeanne.client@exemple.fr'));
    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const r = await dispatchStripeEvent(evt());
    expect(r.status).toBe('failed');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lignes()).toHaveLength(1);
    expect(lignes()[0]).toMatchObject({ gravite: 'critique', evenement: 'stripe.dispatcher_ko' });
    expect(sortie.join('\n')).not.toMatch(/jeanne|@exemple/);
  });
});
