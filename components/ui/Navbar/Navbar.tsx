import Navlinks from './Navlinks';
import { auth } from '@/auth';

/**
 * Navbar — Server Component qui résout la session via Auth.js v5,
 * puis passe `user` au Client Component `Navlinks` pour le menu.
 */
export default async function Navbar() {
  let user: { id?: string; email?: string | null; name?: string | null; image?: string | null } | null = null;
  try {
    const session = await auth();
    if (session?.user) {
      user = {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        image: session.user.image,
      };
    }
  } catch (error) {
    // Session invalide ou erreur de fetch -> mode déconnecté
    console.warn('Auth error in Navbar:', error);
  }

  return (
    <nav className="navbar">
      <div className="navbar-container">
        <Navlinks user={user} />
      </div>
    </nav>
  );
}
