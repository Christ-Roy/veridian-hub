/**
 * Admin authorization helper for Hub admin pages.
 * Whitelist-based: only users in ADMIN_EMAILS can access /dashboard/admin/*.
 *
 * Post-migration : on ne dépend plus du type User Supabase. On accepte tout
 * objet ayant un champ `email` (User Auth.js, AuthUser, etc.).
 */

const ADMIN_EMAILS_ENV = process.env.ADMIN_EMAILS || "";
const DEFAULT_ADMINS = ["brunon5robert@gmail.com"];

export const ADMIN_EMAILS: string[] =
  ADMIN_EMAILS_ENV
    ? ADMIN_EMAILS_ENV.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_ADMINS.map((s) => s.toLowerCase());

type EmailHolder = { email?: string | null; federe?: boolean } | null | undefined;

export function isPlatformAdmin(user: EmailHolder): boolean {
  // Une session ouverte par le fournisseur d'une organisation n'administre jamais la plateforme : son administrateur peut en ouvrir une.
  if (!user?.email || user.federe === true) return false;
  return ADMIN_EMAILS.includes(user.email.toLowerCase());
}
