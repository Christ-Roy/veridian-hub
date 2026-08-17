'use client';

import { useState } from 'react';

import { QualificationFlow } from '@/components/onboarding/qualification/QualificationFlow';
import {
  MOCK_ETAT_REPRIS,
  MOCK_ETAT_VIERGE,
  MOCK_USER,
} from '@/components/onboarding/qualification/mocks';
import type { UserOnboardingRecord } from '@/components/onboarding/qualification/types';

/**
 * Rendu isolé du parcours de qualification, sans le mobilier de l'atelier.
 *
 * C'est CETTE page qu'il faut ouvrir pour juger du plein écran : elle occupe
 * exactement le viewport, donc `100dvh` y vaut ce qu'il vaudra en vrai. Dans
 * l'atelier, elle est chargée en cadre (`<iframe>`), ce qui donne une
 * prévisualisation honnête de n'importe quelle largeur.
 *
 * `?repris=1` démarre avec des réponses déjà données (vérification de la
 * reprise de parcours et du récapitulatif).
 */
export function QualificationPreview({ repris }: { repris: boolean }) {
  const [termine, setTermine] = useState<UserOnboardingRecord | null>(null);
  const [rejeu, setRejeu] = useState(0);

  return (
    <>
      <QualificationFlow
        key={`${repris}-${rejeu}`}
        user={MOCK_USER}
        etat={repris ? MOCK_ETAT_REPRIS : MOCK_ETAT_VIERGE}
        onTerminer={setTermine}
        // En vrai : redirection vers /dashboard. Dans l'atelier, on relance le
        // parcours plutôt que de quitter vers une page qui n'a rien à voir.
        onQuitter={() => {
          setTermine(null);
          setRejeu((n) => n + 1);
        }}
      />

      {/* Ce que la base recevrait au bout du parcours — visible seulement dans
          l'atelier, jamais dans le vrai flow. */}
      {termine && (
        <pre className="fixed bottom-2 left-2 right-2 z-50 max-h-32 overflow-auto rounded-lg border border-border bg-card/95 p-2 text-[10px] leading-tight text-muted-foreground backdrop-blur">
          {JSON.stringify(termine, null, 2)}
        </pre>
      )}
    </>
  );
}
