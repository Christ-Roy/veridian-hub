/**
 * Tests pour `buildCrossAppInvitationEmail` — template HTML inline pour
 * les invitations cross-app envoyées par le Hub (livrable 4 sprint v1.4).
 *
 * Couvre :
 *   - structure HTML minimale (logo, CTA, footer)
 *   - subject correctement composé (inviteur + app)
 *   - text version (fallback non-HTML)
 *   - HTML escaping anti-XSS (inviter name, message)
 *   - apps supportées (notifuse, prospection, analytics, cms)
 *   - rôle traduit (owner→Propriétaire, etc.) + fallback
 *   - bloc message optionnel (omis si absent)
 *   - date d'expiration formatée FR
 */

import { describe, it, expect } from 'vitest';
import {
  buildCrossAppInvitationEmail,
  escapeHtml,
  __crossAppInvitationConstants,
} from '@/lib/email/templates/cross-app-invitation';

const BASE_PARAMS = {
  inviterName: 'Alice',
  inviterEmail: 'alice@example.com',
  inviteeEmail: 'bob@example.com',
  targetApp: 'notifuse' as const,
  targetRole: 'member',
  inviteUrl: 'https://app.veridian.site/invite/abc123',
  expiresAt: new Date('2026-06-21T12:00:00.000Z'),
};

describe('buildCrossAppInvitationEmail', () => {
  it('génère subject + html + text', () => {
    const out = buildCrossAppInvitationEmail(BASE_PARAMS);
    expect(out.subject).toBeTruthy();
    expect(out.html).toBeTruthy();
    expect(out.text).toBeTruthy();
  });

  it('subject contient inviteur + app cible', () => {
    const out = buildCrossAppInvitationEmail(BASE_PARAMS);
    expect(out.subject).toContain('Alice');
    expect(out.subject).toContain('Notifuse');
  });

  it('html contient le logo Veridian, le CTA Accepter et le footer', () => {
    const out = buildCrossAppInvitationEmail(BASE_PARAMS);
    expect(out.html).toContain('https://veridian.site/icon.svg');
    expect(out.html).toContain('VERIDIAN');
    expect(out.html).toContain(BASE_PARAMS.inviteUrl);
    expect(out.html).toContain("Accepter l'invitation");
    expect(out.html).toContain('2026 Veridian');
  });

  it('html utilise les couleurs Veridian (#6DD5B0 + #1A4D3A)', () => {
    const out = buildCrossAppInvitationEmail(BASE_PARAMS);
    expect(out.html).toContain('#6DD5B0');
    expect(out.html).toContain('#1A4D3A');
  });

  it('text version contient URL d\'invite et infos clés', () => {
    const out = buildCrossAppInvitationEmail(BASE_PARAMS);
    expect(out.text).toContain(BASE_PARAMS.inviteUrl);
    expect(out.text).toContain('Notifuse');
    expect(out.text).toContain('Alice');
  });

  it('traduit le rôle owner → Propriétaire', () => {
    const out = buildCrossAppInvitationEmail({
      ...BASE_PARAMS,
      targetRole: 'owner',
    });
    expect(out.html).toContain('Propriétaire');
  });

  it('traduit le rôle admin → Administrateur', () => {
    const out = buildCrossAppInvitationEmail({
      ...BASE_PARAMS,
      targetRole: 'admin',
    });
    expect(out.html).toContain('Administrateur');
  });

  it('fallback sur le rôle brut si inconnu', () => {
    const out = buildCrossAppInvitationEmail({
      ...BASE_PARAMS,
      targetRole: 'editor',
    });
    expect(out.html).toContain('editor');
  });

  it('supporte les 4 apps (notifuse/prospection/analytics/cms)', () => {
    for (const app of ['notifuse', 'prospection', 'analytics', 'cms'] as const) {
      const out = buildCrossAppInvitationEmail({
        ...BASE_PARAMS,
        targetApp: app,
      });
      const expected =
        __crossAppInvitationConstants.APP_DISPLAY_NAME[app];
      expect(out.html).toContain(expected);
      expect(out.subject).toContain(expected);
    }
  });

  it('affiche le bloc message si fourni', () => {
    const out = buildCrossAppInvitationEmail({
      ...BASE_PARAMS,
      message: 'Bienvenue Bob, ravi de t\'avoir',
    });
    expect(out.html).toContain('Message de Alice');
    expect(out.html).toContain('Bienvenue Bob');
  });

  it('omet le bloc message si absent', () => {
    const out = buildCrossAppInvitationEmail(BASE_PARAMS);
    expect(out.html).not.toContain('Message de');
  });

  it('échappe les caractères HTML dans inviterName (anti-XSS)', () => {
    const out = buildCrossAppInvitationEmail({
      ...BASE_PARAMS,
      inviterName: 'Alice <script>alert(1)</script>',
    });
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
  });

  it('échappe les caractères HTML dans le message libre', () => {
    const out = buildCrossAppInvitationEmail({
      ...BASE_PARAMS,
      message: '"><img src=x onerror=alert(1)>',
    });
    expect(out.html).not.toContain('<img src=x');
    expect(out.html).toContain('&lt;img');
  });

  it('formate la date d\'expiration en français', () => {
    const out = buildCrossAppInvitationEmail({
      ...BASE_PARAMS,
      expiresAt: new Date('2026-06-21T12:00:00.000Z'),
    });
    // "21 juin 2026" en fr-FR
    expect(out.html).toMatch(/21 juin 2026/);
  });

  it('utilise un unsubscribeUrl par défaut (mailto support)', () => {
    const out = buildCrossAppInvitationEmail(BASE_PARAMS);
    expect(out.html).toContain('mailto:support@veridian.site');
  });

  it('respecte un unsubscribeUrl custom si fourni', () => {
    const out = buildCrossAppInvitationEmail({
      ...BASE_PARAMS,
      unsubscribeUrl: 'https://app.veridian.site/unsubscribe?token=xyz',
    });
    expect(out.html).toContain('https://app.veridian.site/unsubscribe?token=xyz');
    expect(out.html).not.toContain('mailto:support@veridian.site');
  });
});

describe('escapeHtml', () => {
  it('échappe & < > " \'', () => {
    expect(escapeHtml(`Tom & Jerry "look" at <bad> 'tag'`)).toBe(
      'Tom &amp; Jerry &quot;look&quot; at &lt;bad&gt; &#39;tag&#39;',
    );
  });

  it('idempotent sur string sans caractère spécial', () => {
    expect(escapeHtml('Hello world 123')).toBe('Hello world 123');
  });
});
