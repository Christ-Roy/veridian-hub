'use client';

import { useEffect } from 'react';

/** Une minute avant la fin, l'onglet ouvert rend la session de l'administrateur : après, il faudrait se reconnecter. */
export function SortirAvantLaFin({ finMs }: { finMs: number }) {
  useEffect(() => {
    const id = setTimeout(() => {
      const f = document.createElement('form');
      f.method = 'post';
      f.action = '/api/auth/emprunt/sortir';
      document.body.appendChild(f);
      f.submit();
    }, Math.max(0, finMs - Date.now() - 60_000));
    return () => clearTimeout(id);
  }, [finMs]);
  return null;
}
