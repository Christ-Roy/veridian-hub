import { SupabaseClient } from '@supabase/supabase-js';
import { cache } from 'react';

export const getUser = cache(async (supabase: SupabaseClient) => {
  try {
    const {
      data: { user }
    } = await supabase.auth.getUser();
    return user;
  } catch (error) {
    // Si le token est invalide (après changement de JWT_SECRET), retourner null
    console.warn('Auth error in getUser:', error);
    return null;
  }
});

export const getSubscription = cache(async (supabase: SupabaseClient) => {
  try {
    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .select('*, prices(*, products(*))')
      .in('status', ['trialing', 'active'])
      .maybeSingle();

    return subscription;
  } catch (error) {
    console.warn('Error in getSubscription:', error);
    return null;
  }
});

export const getProducts = cache(async (supabase: SupabaseClient) => {
  try {
    const { data: products, error } = await supabase
      .from('products')
      .select('*, prices(*)')
      .eq('active', true)
      .eq('prices.active', true)
      // Exclude Twenty workflow metered products (keep only BASE_PRODUCT or NULL productKey)
      .or('metadata->>productKey.eq.BASE_PRODUCT,metadata->>productKey.is.null')
      .order('metadata->index')
      .order('unit_amount', { referencedTable: 'prices' });

    return products;
  } catch (error) {
    console.warn('Error in getProducts:', error);
    return [];
  }
});

export const getUserDetails = cache(async (supabase: SupabaseClient) => {
  try {
    const { data: userDetails } = await supabase
      .from('users')
      .select('*')
      .single();
    return userDetails;
  } catch (error) {
    console.warn('Error in getUserDetails:', error);
    return null;
  }
});
