// Envoi d'emails transactionnels pour le Hub.
//
// On passe par l'API HTTP Brevo (pas de SMTP) pour éviter les ennuis de
// firewall / timeouts sortants sur le VPS OVH. Clé dans BREVO_API_KEY.
//
// Fallback SMTP Lark si Brevo est indispo / clé absente (rare).

import { createHash } from 'node:crypto';

// nodemailer v9 + @types/nodemailer v7 : plus de default export → import nommé.
import { createTransport } from 'nodemailer';

import { estCompteDeTest } from '@/lib/email/compte-de-test';

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

const DEFAULT_SENDER = {
  name: 'Veridian',
  email: 'robert.brunon@veridian.site',
};

export type SendMailPayload = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  sender?: { name: string; email: string };
};

/**
 * Adresses à qui le Hub n'écrit jamais : MAILS_BLOQUES_SHA256, 16 premiers caractères du SHA-256 de l'adresse en minuscules,
 * séparés par des virgules (le dépôt est public, aucune adresse n'y figure). Une empreinte d'une autre longueur est ignorée.
 */
export function mailBloque(adresse: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const liste = (env.MAILS_BLOQUES_SHA256 ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return liste.includes(createHash('sha256').update(adresse.trim().toLowerCase()).digest('hex').slice(0, 16));
}

export async function sendMail(payload: SendMailPayload): Promise<void> {
  if (mailBloque(payload.to)) {
    console.info('[mail] envoi bloqué par configuration (MAILS_BLOQUES_SHA256)');
    return;
  }
  const brevoKey = process.env.BREVO_API_KEY;

  if (brevoKey) {
    await sendViaBrevo(payload, brevoKey);
    return;
  }

  // Le repli SMTP n'a pas de bac à sable : une adresse d'épreuve n'y part jamais.
  if (estCompteDeTest(payload.to)) {
    console.info('[mail] compte d\'épreuve : pas d\'envoi par le repli SMTP');
    return;
  }

  // Fallback SMTP Lark
  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPassword = process.env.SMTP_PASSWORD;

  if (!smtpHost || !smtpUser || !smtpPassword) {
    throw new Error(
      'Email provider non configuré : définir BREVO_API_KEY ou SMTP_HOST/USER/PASSWORD'
    );
  }

  await sendViaSmtp(payload, { smtpHost, smtpUser, smtpPassword });
}

async function sendViaBrevo(payload: SendMailPayload, apiKey: string): Promise<void> {
  const sender = payload.sender ?? DEFAULT_SENDER;

  const response = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify({
      sender,
      to: [{ email: payload.to }],
      subject: payload.subject,
      htmlContent: payload.html,
      textContent: payload.text ?? stripHtml(payload.html),
      // Compte d'épreuve : bac à sable Brevo (developers.brevo.com/docs/using-sandbox-mode, en-tête DANS le corps). Même chemin, même réponse,
      // aucune remise, aucun rebond.
      ...(estCompteDeTest(payload.to) ? { headers: { 'X-Sib-Sandbox': 'drop' } } : {}),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Brevo API error ${response.status}: ${body}`);
  }
}

async function sendViaSmtp(
  payload: SendMailPayload,
  config: { smtpHost: string; smtpUser: string; smtpPassword: string }
): Promise<void> {
  const sender = payload.sender ?? DEFAULT_SENDER;
  const transporter = createTransport({
    host: config.smtpHost,
    port: Number(process.env.SMTP_PORT ?? 465),
    secure: true,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPassword,
    },
  });

  await transporter.sendMail({
    from: `${sender.name} <${sender.email}>`,
    to: payload.to,
    subject: payload.subject,
    html: payload.html,
    text: payload.text ?? stripHtml(payload.html),
  });
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
