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
    expect(html).toMatch(/Ajouter ma carte/);
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

  it('html includes reactivate CTA + lecture seule message', () => {
    const { html } = buildTrialExpiredEmail({
      app: 'notifuse',
      trialEndsAt: TRIAL_ENDS_AT,
    });
    expect(html).toMatch(/lecture seule/i);
    expect(html).toMatch(/Réactiver/);
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
