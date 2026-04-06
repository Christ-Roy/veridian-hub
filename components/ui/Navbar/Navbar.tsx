import Navlinks from './Navlinks';
import { createClient } from '@/utils/supabase/server';

export default async function Navbar() {
  const supabase = createClient();

  let user = null;
  try {
    const {
      data: { user: fetchedUser }
    } = await supabase.auth.getUser();
    user = fetchedUser;
  } catch (error) {
    // Si le token est invalide, on affiche la navbar sans user (mode déconnecté)
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
