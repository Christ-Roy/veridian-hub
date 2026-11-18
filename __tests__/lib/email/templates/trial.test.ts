/**
 * Tests des templates HTML inline pour les 3 mails trial.
 *
 * On vérifie :
 *  - Le subject reflète la phase (démarre / 3 jours / terminé)
 *  - Le HTML contient les éléments clés (label app, date d'expiration,
 *    bouton vers /dashboard/billing)
 *  - L'escape HTML est appliqué (pas d'injection via tenant_id ou app)
 *  - Les liens pointent vers HUB_BASE_URL configuré (NEXT_PUBLIC_APP_URL)
 */

import { describe, it, expect } from 'vitest';

import {
  buildTrialEndingSoonEmail,
  buildTrialExpiredEmail,
  buildTrialStartedEmail,
} from '@/lib/email/templates/trial';

const TRIAL_ENDS_AT = new Date('2026-06-30T12:00:00.000Z');

describe('buildTrialStartedEmail', () => {
  it('subject mentions "essai Pro" + "15 jours"', () => {
    const { subject } = buildTrialStartedEmail({
      app: 'notifuse',
      trialEndsAt: TRIAL_ENDS_AT,
    });
    expect(subject).toMatch(/essai Pro/i);
    expect(subject).toMatch(/15 jours/);
  });

  it('html includes app label, expiration date and billing CTA', () => {
    const { html } = buildTrialStartedEmail({
      app: 'notifuse',
      trialEndsAt: TRIAL_ENDS_AT,
    });
    expect(html).toContain('Veridian Mail'); // label notifuse
    expect(html).toMatch(/30 juin 2026/);
    expect(html).toContain('/dashboard/billing');
    expect(html).toMatch(/Voir les formules/);
  });

  it('falls back to "Veridian <app>" label for unknown app', () => {
    const { html } = buildTrialStartedEmail({
      app: 'unknown_app',
      trialEndsAt: TRIAL_ENDS_AT,
    });
    expect(html).toContain('Veridian unknown_app');
  });
});

describe('buildTrialEndingSoonEmail', () => {
  it('subject mentions "3 jours"', () => {
    const { subject } = buildTrialEndingSoonEmail({
      app: 'notifuse',
      trialEndsAt: TRIAL_ENDS_AT,
    });
    expect(subject).toMatch(/3 jours/);
  });

  it('html includes app label + date + billing CTA', () => {
    const { html } = buildTrialEndingSoonEmail({
      app: 'prospection',
      trialEndsAt: TRIAL_ENDS_AT,
    });
    expect(html).toContain('Veridian Prospection');
    expect(html).toMatch(/30 juin 2026/);
    expect(html).toContain('/dashboard/billing');
  });
});

describe('buildTrialExpiredEmail', () => {
  it('subject mentions "terminé"', () => {
    const { subject } = buildTrialExpiredEmail({
      app: 'notifuse',
      trialEndsAt: TRIAL_ENDS_AT,
    });
    expect(subject).toMatch(/terminé/i);
  });

  it('html dit le retour au plan gratuit, sans débit, avec le CTA des formules', () => {
    const { html } = buildTrialExpiredEmail({
      app: 'notifuse',
      trialEndsAt: TRIAL_ENDS_AT,
    });
    expect(html).toMatch(/revenu au plan gratuit/i);
    expect(html).toMatch(/Rien ne vous a été facturé/);
    expect(html).toMatch(/Voir les formules/);
    expect(html).toContain('/dashboard/billing');
  });
});

describe('HTML escape', () => {
  it('escapes potentially dangerous app name (no injection)', () => {
    const { html } = buildTrialStartedEmail({
      app: '<script>alert(1)</script>',
      trialEndsAt: TRIAL_ENDS_AT,
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

/**
 * Garde du 08/11 : les mails et le bandeau annonçaient une lecture seule et un bonus de 30 jours
 * que rien n'applique, avec des tirets cadratins et du tutoiement. Rien de cela ne doit revenir.
 */
import { PHASE_CONTENT } from '@/components/dashboard/FreemiumBanner';

const INTERDITS: Array<[string, RegExp]> = [
  ['lecture seule (non appliquée)', /lecture seule/i],
  ['bonus de 30 jours (non codé)', /30 jours (supplémentaires|offerts|inconditionnels)/i],
  ['tiret cadratin ou demi-cadratin entouré d\'espaces', /\s[—–]\s/],
  ['tutoiement', /(?<!\p{L})(tu|ton|ta|tes|toi|ajoute)(?!\p{L})/iu],
  ['anglicisme (workspace, email, dashboard)', /(?<!\p{L})(workspace|e-?mail|dashboard)(?!\p{L})/iu],
];

describe('mails et bandeau d\'essai : aucune promesse non codée', () => {
  const textes: Array<[string, string]> = [
    ...[buildTrialStartedEmail, buildTrialEndingSoonEmail, buildTrialExpiredEmail].flatMap((f) => {
      const { subject, html } = f({ app: 'notifuse', trialEndsAt: TRIAL_ENDS_AT });
      const texte = html.replace(/<[^>]+>/g, ' ');
      return [[`${f.name} : objet`, subject], [`${f.name} : corps`, texte]] as Array<[string, string]>;
    }),
    ...Object.entries(PHASE_CONTENT).map(([phase, c]) => [`bandeau ${phase}`, `${c.message} ${c.ctaLabel}`] as [string, string]),
  ];
  it.each(textes)('%s', (_nom, texte) => {
    for (const [quoi, re] of INTERDITS) expect(texte, quoi).not.toMatch(re);
  });
  it('chaque mail est signé Robert Brunon', () => {
    for (const f of [buildTrialStartedEmail, buildTrialEndingSoonEmail, buildTrialExpiredEmail]) {
      expect(f({ app: 'notifuse', trialEndsAt: TRIAL_ENDS_AT }).html).toContain('Robert Brunon');
    }
  });
});
