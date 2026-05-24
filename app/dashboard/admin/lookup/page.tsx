import { Search } from 'lucide-react';
import { DashboardPageHeader } from '@/components/dashboard/PageHeader';
import { UserLookupForm } from './UserLookupForm';

/**
 * ADMIN LOOKUP — recherche cross-app d'un user par email.
 *
 * Pas de data fetch côté serveur (lookup est déclenché user-driven dans
 * le Client Component). Permet aussi d'éviter de rendre une page lente
 * sur un éventuel `?email=` futur — on garde tout client-side.
 *
 * Routes API consommées :
 *  - POST /api/admin/users-lookup       (user + tenants)
 *  - POST /api/admin/tenant-billing-state  (état billing live par tenant)
 *
 * Toutes 2 protégées par `authenticateAdmin()` (session admin + rate-limit).
 */
export default function AdminLookupPage() {
  return (
    <div>
      <DashboardPageHeader
        title="Lookup cross-app"
        description="Recherche un user par email pour voir ses workspaces, tenants et état billing."
        icon={Search}
        className="mb-6"
      />

      <UserLookupForm />
    </div>
  );
}
