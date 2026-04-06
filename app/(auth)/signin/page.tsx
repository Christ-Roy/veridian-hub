import { redirect } from 'next/navigation';

/**
 * ROUTE DÉPRÉCIÉE - Redirige vers /login
 *
 * Cette route est conservée pour compatibilité mais redirige
 * automatiquement vers la nouvelle route /login
 */
export default function SignInRedirect() {
  redirect('/login');
}
