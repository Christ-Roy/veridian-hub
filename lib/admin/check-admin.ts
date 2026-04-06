/**
 * Admin authorization helper for Hub admin pages.
 * Whitelist-based: only users in ADMIN_EMAILS can access /dashboard/admin/*.
 *
 * À terme: lire depuis public.platform_admins table ou env var ADMIN_EMAILS=…
 */
import type { User } from "@supabase/supabase-js";

const ADMIN_EMAILS_ENV = process.env.ADMIN_EMAILS || "";
const DEFAULT_ADMINS = ["brunon5robert@gmail.com"];

export const ADMIN_EMAILS: string[] =
  ADMIN_EMAILS_ENV
    ? ADMIN_EMAILS_ENV.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_ADMINS.map((s) => s.toLowerCase());

export function isPlatformAdmin(user: User | null): boolean {
  if (!user?.email) return false;
  return ADMIN_EMAILS.includes(user.email.toLowerCase());
}
