// Auth.js v5 catch-all route handler.
// Gère tous les endpoints /api/auth/* : signin, signout, callback, session, csrf...
//
// Note : coexiste avec les routes Supabase Auth legacy qui vivent ailleurs
// (app/(auth)/auth/callback, etc.). Auth.js ne touche qu'à /api/auth/*.

import { handlers } from '@/auth';

export const { GET, POST } = handlers;
