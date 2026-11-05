// Outils du Supra Admin (propriétaire de la plateforme). Le préfixe _ empêche Vercel d'en faire une fonction.
import { esc, siteUrl, layout, sendMail, mailConfigured } from './_mail.js';

const isShadowEmail = (e) => /\+carnet-[0-9a-f]{12}@/i.test(String(e || ''));
/** Adresse réelle d'une personne : les comptes liés (autres serveurs) utilisent une adresse technique « prenom+carnet-xxxx@… ». */
export const realEmail = (e) => String(e || '').replace(/\+carnet-[0-9a-f]{12}@/i, '@').toLowerCase();
export { isShadowEmail };

export async function isPlatformAdmin(sb, userId) {
  if (!userId) return false;
  const { data } = await sb.from('platform_admins').select('user_id').eq('user_id', userId).maybeSingle();
  return Boolean(data);
}

export async function getSetting(sb, key, fallback = true) {
  try {
    const { data } = await sb.from('platform_settings').select('value').eq('key', key).maybeSingle();
    return data && data.value !== undefined && data.value !== null ? data.value : fallback;
  } catch (_) { return fallback; }
}

export async function logPlatform(sb, actorId, action, targetId, targetLabel, detail) {
  try { await sb.from('platform_log').insert({ actor_id: actorId || null, action, target_id: targetId || null, target_label: String(targetLabel || '').slice(0, 200), detail: String(detail || '').slice(0, 400) }); } catch (_) { /* le journal ne doit jamais bloquer */ }
}

/** Adresses des propriétaires de la plateforme (adresse réelle, sans doublon). */
export async function ownerEmails(sb) {
  const { data: pa } = await sb.from('platform_admins').select('user_id');
  const ids = (pa || []).map(p => p.user_id);
  if (!ids.length) return [];
  const { data: ps } = await sb.from('profiles').select('id, email').in('id', ids);
  return [...new Set((ps || []).map(p => realEmail(p.email)).filter(Boolean))];
}

/** Prévient le propriétaire par email d'un événement (inscription, nouveau serveur). Ne lève jamais d'erreur. */
export async function notifyOwner(sb, req, setting, subject, lines) {
  try {
    if (!mailConfigured()) return;
    if ((await getSetting(sb, setting, true)) !== true) return;
    const to = await ownerEmails(sb);
    if (!to.length) return;
    const text = lines.join('\n');
    const html = layout(`<p style="margin:0 0 12px"><strong>${esc(subject)}</strong></p>` + lines.map(l => `<p style="margin:0 0 8px;line-height:1.5">${esc(l)}</p>`).join('') + `<p style="margin:16px 0 0"><a href="${esc(siteUrl(req))}/supra/">Ouvrir le Supra Admin</a></p>`);
    await Promise.allSettled(to.map(t => sendMail({ to: t, subject: `Le Carnet · ${subject}`.slice(0, 120), text: `${text}\n\n${siteUrl(req)}/supra/`, html })));
  } catch (_) { /* jamais bloquant */ }
}
