/**
 * Hub admin layout — restricted to ADMIN_EMAILS whitelist.
 * Redirects to /dashboard if non-admin.
 */
import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/utils/supabase/server";
import { isPlatformAdmin } from "@/lib/admin/check-admin";

export default async function AdminHubLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?redirect=/dashboard/admin");
  }
  if (!isPlatformAdmin(user)) {
    // Use notFound semantics so non-admins don't discover the admin area
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center gap-6">
          <Link href="/dashboard" className="text-sm font-semibold text-indigo-600">
            ← Dashboard
          </Link>
          <span className="text-xs uppercase tracking-wide text-red-600 font-bold">
            PLATFORM ADMIN
          </span>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/dashboard/admin" className="hover:text-indigo-600">
              Overview
            </Link>
            <Link href="/dashboard/admin/tenants" className="hover:text-indigo-600">
              Tenants
            </Link>
            <Link href="/dashboard/admin/analytics" className="hover:text-indigo-600">
              Analytics
            </Link>
          </nav>
          <div className="ml-auto text-xs text-muted-foreground">{user.email}</div>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-6 py-8">{children}</main>
    </div>
  );
}
