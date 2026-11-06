/**
 * Les conditions mesurées, isolées en fonctions pures : la même fonction sert au cas
 * réel ET au contrôle d'échec (00-controle-echec), qui lui présente une condition
 * fausse et exige qu'elle lève. Une assertion qui ne sait pas lever ne prouve rien.
 */
import { APP_URL, masquer, type AppKey } from './cibles';
import type { Atterrissage } from './parcours';

const verdict = (ok: boolean, msg: string) => {
  if (!ok) throw new Error(masquer(msg));
};

const ECHEC_REBOND = /Impossible de revenir|bounce\/error|Connectez-vous pour revenir/i;

/** L'utilisateur est dans l'app, sans formulaire de connexion. */
export function devraitEtreArrive(a: Atterrissage, app: AppKey) {
  const hoteApp = new URL(APP_URL[app]).host;
  verdict(
    a.hote === hoteApp,
    `${app} : l'utilisateur n'est pas arrivé (fin sur ${a.hote}${a.chemin}). Texte : « ${a.texte.slice(0, 160).replace(/\s+/g, ' ')} »`,
  );
  verdict(!ECHEC_REBOND.test(a.texte + a.url), `${app} : page d'échec du rebond (${a.url})`);
  verdict(!a.formulaireMotDePasse, `${app} : un mot de passe est redemandé alors que la session Hub est ouverte`);
}

/** L'utilisateur n'est PAS entré dans l'app. */
export function devraitNePasEtreArrive(a: Atterrissage, app: AppKey) {
  const hoteApp = new URL(APP_URL[app]).host;
  verdict(a.hote !== hoteApp, `${app} : un compte sans adresse prouvée est ENTRÉ dans l'app (${a.hote}${a.chemin})`);
  verdict(!a.lienUnique, `${app} : un lien de connexion a été émis pour un compte sans adresse prouvée`);
}

/** Après ouverture d'un lien mort : ni session, ni page de l'app connectée. */
export function devraitEtreSansSession(
  vue: { session: { email?: string } | null; texte: string; url: string },
  email: string,
) {
  verdict(!vue.session?.email, `une session est ouverte (${vue.session?.email}) alors que le lien ne devait rien ouvrir`);
  verdict(
    !vue.texte.toLowerCase().includes(email.toLowerCase()),
    `la page montre l'adresse du compte (${vue.url}) : le lien a ouvert l'app`,
  );
  verdict(!/signed in via Veridian|Select workspace/i.test(vue.texte), `la console est ouverte (${vue.url})`);
}

export function devraitAvoirPlan(lu: unknown, attendu: string, ou: string) {
  verdict(lu === attendu, `${ou} : plan lu « ${String(lu)} », attendu « ${attendu} »`);
}

export type RapportReconcile = {
  drifts?: Array<{ hubTenantId: string; app: string; kind: string }>;
  identity?: Record<string, Record<string, unknown>>;
  [k: string]: unknown;
};

export const cleDerive = (d: { hubTenantId: string; app: string; kind: string }) =>
  `${d.hubTenantId}|${d.app}|${d.kind}`;

/** Dérives présentes après et absentes de la référence (le stock existant n'est pas notre affaire). */
export function nouvellesDerives(base: RapportReconcile, apres: RapportReconcile) {
  const connues = new Set((base.drifts ?? []).map(cleDerive));
  const neuves = (apres.drifts ?? []).filter((d) => !connues.has(cleDerive(d)));
  const listes = ['withoutHub', 'unlinked', 'emailMismatch', 'nameMismatch'] as const;
  const identite: string[] = [];
  for (const [app, bloc] of Object.entries(apres.identity ?? {})) {
    for (const l of listes) {
      const av = new Set(((base.identity?.[app]?.[l] as unknown[]) ?? []).map((x) => JSON.stringify(x)));
      for (const x of (bloc[l] as unknown[]) ?? []) {
        if (!av.has(JSON.stringify(x))) identite.push(`${app}.${l}`);
      }
    }
  }
  return { derives: neuves, identite };
}

export function devraitNeVoirAucuneDeriveNouvelle(base: RapportReconcile, apres: RapportReconcile) {
  const n = nouvellesDerives(base, apres);
  verdict(
    n.derives.length === 0 && n.identite.length === 0,
    `reconcile : ${n.derives.length} dérive(s) nouvelle(s) ${JSON.stringify(
      n.derives.map((d) => `${d.app}:${d.kind}`),
    )}, identité ${JSON.stringify(Array.from(new Set(n.identite)))}`,
  );
}

/** Le texte vu par un compte ne contient aucune des marques d'un autre tenant. */
export function devraitIgnorerLesAutres(texte: string, interdits: string[], ou: string) {
  const t = texte.toLowerCase();
  const vus = interdits.filter((x) => x && t.includes(x.toLowerCase()));
  // On ne nomme jamais la donnée d'un autre client : seulement combien.
  verdict(vus.length === 0, `${ou} : ${vus.length} marque(s) d'un autre tenant visible(s)`);
}
