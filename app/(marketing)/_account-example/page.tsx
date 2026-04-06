'use client';

import { useEffect, useState } from 'react';
import { redirect, useSearchParams } from 'next/navigation';
import { createClient } from '@/utils/supabase/client';
import styles from './account.module.css';

// 🔒 COMPOSANTS BACKEND - NE PAS MODIFIER LA LOGIQUE
import CustomerPortalForm from '@/components/ui/AccountForms/CustomerPortalForm';
import EmailForm from '@/components/ui/AccountForms/EmailForm';
import NameForm from '@/components/ui/AccountForms/NameForm';

// Composants Tenant Management
import TwentyTenantManager from '@/components/account/TwentyTenantManager';
import NotifuseTenantManager from '@/components/account/NotifuseTenantManager';

type Tab = 'profile' | 'billing' | 'twenty' | 'notifuse';

/**
 * ACCOUNT PAGE - Version Dark avec Tenant Management
 *
 * Organisation en tabs :
 * 1. Profile : Nom + Email (NameForm + EmailForm)
 * 2. Billing : Stripe Portal (CustomerPortalForm)
 * 3. Twenty : Création workspace TwentyCRM
 * 4. Notifuse : Création workspace Notifuse
 *
 * 🔒 IMPORTANT : Conserve TOUTE la logique backend existante
 * - Récupération user via Supabase
 * - Récupération subscription Stripe
 * - Les formulaires sont des composants existants non modifiés
 *
 * Style : CSS modifiable dans account.module.css
 * Support query params : ?tab=twenty ou ?tab=notifuse pour ouvrir directement le bon tab
 */
export default function AccountPage() {
  const searchParams = useSearchParams();
  const tabParam = searchParams?.get('tab') as Tab | null;

  const [activeTab, setActiveTab] = useState<Tab>(tabParam || 'profile');
  const [user, setUser] = useState<any>(null);
  const [userDetails, setUserDetails] = useState<any>(null);
  const [subscription, setSubscription] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Mettre à jour le tab si le query param change
    if (tabParam && ['profile', 'billing', 'twenty', 'notifuse'].includes(tabParam)) {
      setActiveTab(tabParam);
    }
  }, [tabParam]);

  useEffect(() => {
    async function loadData() {
      const supabase = createClient();

      // 🔒 LOGIQUE BACKEND - Récupération données utilisateur
      const { data: { user: authUser } } = await supabase.auth.getUser();

      if (!authUser) {
        redirect('/signin');
      }

      setUser(authUser);

      // Récupérer les détails du profil
      const { data: profile } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', authUser.id)
        .single();

      setUserDetails(profile);

      // Récupérer l'abonnement Stripe
      const { data: sub } = await supabase
        .from('subscriptions')
        .select(`
          *,
          prices(
            *,
            products(*)
          )
        `)
        .eq('user_id', authUser.id)
        .in('status', ['trialing', 'active'])
        .maybeSingle();

      setSubscription(sub);
      setIsLoading(false);
    }

    loadData();
  }, []);

  if (isLoading) {
    return (
      <div className={styles.pageContainer}>
        <div className={styles.innerContainer}>
          <div className="text-center py-12">
            <p className="text-gray-400">Chargement...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.pageContainer}>
      <div className={styles.innerContainer}>
        {/* Header */}
        <div className={styles.pageHeader}>
          <h1 className={styles.pageTitle}>Account Dashboard</h1>
          <p className={styles.pageSubtitle}>
            Gérez votre profil, abonnement et vos workspaces CRM & Email
          </p>
        </div>

        {/* Tabs Navigation */}
        <div className={styles.tabsContainer}>
          <div className={styles.tabsList}>
            <button
              onClick={() => setActiveTab('profile')}
              className={`${styles.tab} ${activeTab === 'profile' ? styles.tabActive : ''}`}
            >
              <span className={styles.tabIcon}>👤</span>
              Profile
            </button>

            <button
              onClick={() => setActiveTab('billing')}
              className={`${styles.tab} ${activeTab === 'billing' ? styles.tabActive : ''}`}
            >
              <span className={styles.tabIcon}>💳</span>
              Billing
            </button>

            <button
              onClick={() => setActiveTab('twenty')}
              className={`${styles.tab} ${activeTab === 'twenty' ? styles.tabActive : ''}`}
            >
              <span className={styles.tabIcon}>📇</span>
              Twenty CRM
            </button>

            <button
              onClick={() => setActiveTab('notifuse')}
              className={`${styles.tab} ${activeTab === 'notifuse' ? styles.tabActive : ''}`}
            >
              <span className={styles.tabIcon}>📧</span>
              Notifuse
            </button>
          </div>
        </div>

        {/* Tab Content */}
        <div>
          {/* Profile Tab */}
          {activeTab === 'profile' && (
            <div>
              <div className={styles.section}>
                <div className={styles.sectionHeader}>
                  <h2 className={styles.sectionTitle}>Personal Information</h2>
                  <p className={styles.sectionDescription}>
                    Update your name and email address
                  </p>
                </div>
                <div className={styles.sectionContent}>
                  {/* 🔒 COMPOSANT BACKEND - Ne pas modifier */}
                  <div className="space-y-6">
                    <NameForm userName={userDetails?.full_name ?? ''} />
                    <EmailForm userEmail={user?.email ?? ''} />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Billing Tab */}
          {activeTab === 'billing' && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle}>Subscription & Billing</h2>
                <p className={styles.sectionDescription}>
                  Manage your subscription via Stripe Customer Portal
                </p>
              </div>
              <div className={styles.sectionContent}>
                {/* 🔒 COMPOSANT BACKEND - Ne pas modifier */}
                <CustomerPortalForm subscription={subscription} />
              </div>
            </div>
          )}

          {/* Twenty CRM Tab */}
          {activeTab === 'twenty' && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle}>Twenty CRM Workspace</h2>
                <p className={styles.sectionDescription}>
                  Create and manage your TwentyCRM workspace for customer relationship management
                </p>
              </div>
              <div className={styles.sectionContent}>
                <TwentyTenantManager />
              </div>
            </div>
          )}

          {/* Notifuse Tab */}
          {activeTab === 'notifuse' && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle}>Notifuse Workspace</h2>
                <p className={styles.sectionDescription}>
                  Create and manage your Notifuse workspace for email marketing automation
                </p>
              </div>
              <div className={styles.sectionContent}>
                <NotifuseTenantManager />
              </div>
            </div>
          )}
        </div>

        {/* Footer Info */}
        <div className="mt-8 p-4 rounded-lg border border-gray-800 bg-gray-900/50">
          <p className="text-sm text-gray-400 text-center">
            💡 Your workspaces are fully isolated. Each tenant has its own database and configuration.
          </p>
        </div>
      </div>
    </div>
  );
}
