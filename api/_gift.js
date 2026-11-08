// Cadeau d'anniversaire : remise symbolique du Carnet à Camélia Borget (15 novembre 2026).
// Sécurité : les confirmations d'email sont désactivées sur le site, donc créer un compte avec son adresse ne prouve rien.
// Le Supra Admin n'est donc accordé qu'après un clic sur un lien personnel envoyé à cette adresse (jeton signé).
import crypto from 'node:crypto';
import { esc, siteUrl, layout, button, sendMail, mailConfigured } from './_mail.js';
import { realEmail, logPlatform, getSetting, ownerEmails } from './_platform.js';

export const GIFT_EMAIL = 'cameliaborget@gmail.com';
export const GIFT_NAME = 'Camélia Borget';
export const GIFT_FROM = Date.parse('2026-11-15T00:00:00+01:00'); // minuit, heure de Paris
const secretKey = () => String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');

export const giftToken = (userId, email) => `${userId}.${crypto.createHmac('sha256', secretKey()).update(`gift:${userId}:${realEmail(email)}`).digest('hex').slice(0, 40)}`;
export function checkGiftToken(token, profile) {
  const t = String(token || ''); if (!profile || realEmail(profile.email) !== GIFT_EMAIL || !secretKey()) return false;
  const [id] = t.split('.'); if (id !== profile.id) return false;
  const want = Buffer.from(giftToken(profile.id, profile.email)), got = Buffer.from(t);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
async function giftProfile(sb) {
  const { data } = await sb.from('profiles').select('id, email, display_name, status, banned_at').ilike('email', 'cameliaborget%');
  return (data || []).find(p => realEmail(p.email) === GIFT_EMAIL && !p.banned_at) || null;
}

/** Appelée régulièrement : une fois le 15 novembre passé et le compte créé, envoie une seule fois le lien d'activation. */
export async function maybeSendGiftMail(sb, req, now = Date.now()) {
  if (now < GIFT_FROM || !mailConfigured() || !secretKey()) return false;
  if ((await getSetting(sb, 'ownership', null))?.active) return false;
  if (await getSetting(sb, 'gift_mail_sent', false)) return false;
  const p = await giftProfile(sb); if (!p) return false;
  await sb.from('platform_settings').upsert({ key: 'gift_mail_sent', value: true, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  const link = `${siteUrl(req)}/app/?gift=${giftToken(p.id, p.email)}`;
  await sendMail({ to: GIFT_EMAIL, subject: '🎂 Joyeux anniversaire Camélia — un cadeau vous attend',
    text: `Joyeux anniversaire ! Noah vous offre Le Carnet. Pour le recevoir, ouvrez ce lien depuis votre compte : ${link}`,
    html: layout(`<p style="font-size:20px;margin:0 0 12px">🎂 Joyeux anniversaire, ${esc(p.display_name || 'Camélia')} !</p><p>Noah a créé Le Carnet, et il vous l'offre aujourd'hui.</p><p>Pour recevoir votre cadeau et en prendre la direction, cliquez ci-dessous : ce lien est personnel, il n'est valable que pour votre compte.</p>${button(link, 'Recevoir mon cadeau')}<p style="font-size:13px;color:#666">Si vous n'êtes pas Camélia, ignorez ce message.</p>`) });
  await logPlatform(sb, null, 'gift_mail', p.id, p.display_name, 'Lien d\'activation envoyé');
  return true;
}

/** Active le cadeau : Supra Admin pour Camélia (Noah le garde), annonce publique, email à tous les membres (une seule fois). */
export async function claimGift(sb, req, profile, token) {
  if (Date.now() < GIFT_FROM) return { error: 'Ce cadeau ne peut pas encore être ouvert.', code: 403 };
  if (!checkGiftToken(token, profile)) return { error: 'Lien invalide ou expiré.', code: 403 };
  const existing = await getSetting(sb, 'ownership', null);
  if (!existing || !existing.active) {
    const { error: e1 } = await sb.from('platform_admins').upsert({ user_id: profile.id }, { onConflict: 'user_id' });
    if (e1) return { error: e1.message, code: 500 };
    await sb.from('platform_settings').upsert({ key: 'ownership', value: { active: true, owner_id: profile.id, name: GIFT_NAME, since: new Date().toISOString() }, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    await logPlatform(sb, profile.id, 'ownership', profile.id, GIFT_NAME, 'Le Carnet offert à Camélia Borget : Supra Admin accordé');
  }
  let mailed = 0;
  if (!(await getSetting(sb, 'ownership_mail_sent', false)) && mailConfigured()) {
    await sb.from('platform_settings').upsert({ key: 'ownership_mail_sent', value: true, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    const { data: ps } = await sb.from('profiles').select('email, status, banned_at');
    const to = [...new Set((ps || []).filter(p => p.status === 'approved' && !p.banned_at && p.email).map(p => realEmail(p.email)))].filter(e => e !== GIFT_EMAIL).slice(0, 400);
    const html = layout(`<p style="font-size:18px;margin:0 0 12px">Camélia Borget prend la direction du Carnet</p><p>Bonjour,</p><p>Noah Borget, qui a créé Le Carnet, vient de l'offrir à sa mère, <strong>Camélia Borget</strong>, qui en prend la direction (une remise symbolique, à l'occasion de son anniversaire). Noah reste à ses côtés comme administrateur.</p><p>Pour vous, rien ne change : votre compte, vos tâches et vos données restent exactement comme avant.</p>${button(siteUrl(req) + '/app/', 'Ouvrir Le Carnet')}`);
    const text = `Noah Borget, créateur du Carnet, vient de l'offrir à sa mère, Camélia Borget, qui en prend la direction (remise symbolique, à l'occasion de son anniversaire). Noah reste administrateur. Pour vous, rien ne change : votre compte et vos données restent comme avant. ${siteUrl(req)}/app/`;
    for (let i = 0; i < to.length; i += 5) {
      const rs = await Promise.allSettled(to.slice(i, i + 5).map(t => sendMail({ to: t, subject: 'Le Carnet est offert à Camélia Borget, qui en prend la direction', text, html })));
      mailed += rs.filter(r => r.status === 'fulfilled').length;
    }
    await logPlatform(sb, profile.id, 'broadcast', null, 'Remise du Carnet à Camélia Borget', `${mailed} destinataire(s)`);
  }
  return { ok: true, mailed };
}
