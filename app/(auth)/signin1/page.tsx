import { redirect } from 'next/navigation';

/**
 * ROUTE DÉPRÉCIÉE - Redirige vers /login
 *
 * Cette route était un template shadcn login-02.
 * Elle redirige maintenant vers /login pour unifier les routes auth.
 */
export default function SignIn1Redirect() {
  redirect('/login');
}
