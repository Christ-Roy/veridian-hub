'use client';

// L'organisation que ce navigateur connaît : un bouton, et un départ seul qu'on peut arrêter (VER-261). Jamais deux départs de suite (cookie de pause).
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';

const ATTENTE_S = 3;

export function PorteOrganisation({ porte, organisation, fournisseur, auto }: { porte: string; organisation: string; fournisseur: string; auto: boolean }) {
  const [part, setPart] = useState(auto);
  const [reste, setReste] = useState(ATTENTE_S);
  const lien = `/connexion/${porte}`;
  useEffect(() => {
    if (!part) return;
    // Le départ automatique essaie d'abord sans écran chez le fournisseur ; un refus revient ici avec le bouton.
    if (reste <= 0) { window.location.assign(`${lien}?silence=1`); return; }
    const t = setTimeout(() => setReste((n) => n - 1), 1_000);
    return () => clearTimeout(t);
  }, [part, reste, lien]);
  return (
    <div className="mb-6 space-y-3 rounded-lg border border-border p-4 text-center">
      <p className="text-sm font-medium">{organisation}</p>
      <Button asChild className="w-full">
        <a href={lien}>Continuer avec {fournisseur}</a>
      </Button>
      {part ? (
        <p role="status" className="text-sm text-muted-foreground">
          Départ dans {reste} s.{' '}
          <button type="button" className="underline" onClick={() => setPart(false)}>Me connecter autrement</button>
        </p>
      ) : null}
    </div>
  );
}
