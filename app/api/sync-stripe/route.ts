import { NextResponse } from 'next/server';
import { stripe } from '@/utils/stripe/config';
import { upsertProductRecord, upsertPriceRecord } from '@/utils/supabase/admin';

/**
 * Synchronise tous les produits et prix Stripe existants vers Supabase
 * Cette route est sécurisée et ne devrait être appelée qu'une seule fois pour la sync initiale
 */
export async function POST(req: Request) {
  try {
    console.log('🔄 Starting Stripe sync...');

    // Vérifier qu'un secret est fourni (protection basique)
    const { secret } = await req.json();
    const expectedSecret = process.env.STRIPE_SECRET_KEY?.substring(0, 20); // Utiliser une partie de la clé comme secret

    if (secret !== expectedSecret) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // 1. Récupérer tous les produits Stripe
    console.log('📦 Fetching products from Stripe...');
    const products = await stripe.products.list({ limit: 100 });
    console.log(`Found ${products.data.length} products`);

    // 2. Synchroniser les produits
    for (const product of products.data) {
      console.log(`Syncing product: ${product.name} (${product.id})`);
      await upsertProductRecord(product);
    }

    // 3. Récupérer tous les prix Stripe
    console.log('💰 Fetching prices from Stripe...');
    const prices = await stripe.prices.list({ limit: 100 });
    console.log(`Found ${prices.data.length} prices`);

    // 4. Synchroniser les prix
    for (const price of prices.data) {
      console.log(`Syncing price: ${price.id} (${price.unit_amount} ${price.currency})`);
      await upsertPriceRecord(price);
    }

    console.log('✅ Stripe sync completed successfully!');

    return NextResponse.json({
      success: true,
      synced: {
        products: products.data.length,
        prices: prices.data.length
      }
    });

  } catch (error: any) {
    console.error('❌ Stripe sync failed:', error);
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
