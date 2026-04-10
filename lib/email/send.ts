// Envoi d'emails transactionnels pour le Hub.
//
// On passe par l'API HTTP Brevo (pas de SMTP) pour éviter les ennuis de
// firewall / timeouts sortants sur le VPS OVH. Clé dans BREVO_API_KEY.
//
// Fallback SMTP Lark si Brevo est indispo / clé absente (rare).

import nodemailer from 'nodemailer';

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

export async function sendMail(payload: SendMailPayload): Promise<void> {
  const brevoKey = process.env.BREVO_API_KEY;

  if (brevoKey) {
    await sendViaBrevo(payload, brevoKey);
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
  const transporter = nodemailer.createTransport({
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
