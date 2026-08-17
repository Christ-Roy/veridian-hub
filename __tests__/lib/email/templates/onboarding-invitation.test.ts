import { describe, it, expect } from 'vitest';

import { buildOnboardingInvitationEmail } from '@/lib/email/templates/onboarding-invitation';

describe('buildOnboardingInvitationEmail', () => {
  const base = {
    email: 'client@example.com',
    invitedBy: 'Robert',
    workspaceName: 'Atelier Robert',
    apps: ['hub', 'notifuse'],
    inviteUrl: 'https://app.veridian.site/onboard/raw-token',
    expiresAt: new Date('2026-09-01T12:00:00.000Z'),
  };

  it('produit un sujet transactionnel clair et une version texte avec le lien', () => {
    const email = buildOnboardingInvitationEmail(base);

    expect(email.subject).toBe('Votre accès Veridian est prêt');
    expect(email.text).toContain('Activer mon accès : https://app.veridian.site/onboard/raw-token');
    expect(email.text).toContain('Outils : Hub Veridian, Veridian Mail');
    expect(email.text).toContain('1 septembre 2026');
  });

  it('échappe les champs injectés dans le HTML pour éviter une invitation XSS', () => {
    const email = buildOnboardingInvitationEmail({
      ...base,
      email: 'client+<script>@example.com',
      invitedBy: '<img src=x onerror=alert(1)>',
      workspaceName: 'ACME & fils',
      inviteUrl: 'https://app.veridian.site/onboard/raw-token?x=<bad>',
    });

    expect(email.html).toContain('ACME &amp; fils');
    expect(email.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(email.html).toContain('client+&lt;script&gt;@example.com');
    expect(email.html).toContain('x=&lt;bad&gt;');
    expect(email.html).not.toContain('<script>');
  });

  it('retombe sur Hub Veridian quand aucune app n’est passée', () => {
    const email = buildOnboardingInvitationEmail({ ...base, apps: [] });

    expect(email.html).toContain('Hub Veridian');
    expect(email.text).toContain('Outils : Hub Veridian');
  });

  it('nomme proprement les apps inconnues sans casser le rendu', () => {
    const email = buildOnboardingInvitationEmail({ ...base, apps: ['custom'] });

    expect(email.html).toContain('Veridian custom');
    expect(email.text).toContain('Outils : Veridian custom');
  });
});
