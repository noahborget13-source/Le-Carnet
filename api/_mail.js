// Utilitaires partagés pour l'envoi d'emails (le préfixe _ empêche Vercel d'en faire une fonction).
import nodemailer from 'nodemailer';

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function mailConfigured() {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

export function siteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `https://${host}`;
}

let transporter;
function getTransporter() {
  if (!transporter) {
    const user = process.env.GMAIL_USER;
    const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
    transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  }
  return transporter;
}

export function layout(innerHtml) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1f2430">
    <h2 style="margin:0 0 14px">Le Carnet</h2>${innerHtml}
    <p style="font-size:12px;color:#889;margin-top:28px">Tu reçois cet email parce que tu as un compte sur Le Carnet.</p>
  </div>`;
}

export function button(link, label) {
  return `<p style="margin:22px 0"><a href="${esc(link)}" style="background:#5B9EF5;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">${esc(label)}</a></p>`;
}

export async function sendMail({ to, subject, text, html }) {
  if (!mailConfigured()) throw new Error("L'envoi d'emails n'est pas configuré (GMAIL_USER / GMAIL_APP_PASSWORD manquants).");
  await getTransporter().sendMail({ from: `"Le Carnet" <${process.env.GMAIL_USER}>`, to, subject, text, html });
}
