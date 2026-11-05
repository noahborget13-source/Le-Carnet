// Actions du Supra Admin (réservées au propriétaire de la plateforme, table platform_admins).
// Appelées par /api/admin-tools : Vercel gratuit = 12 fonctions maximum, donc pas de nouveau fichier de fonction.
import { esc, siteUrl, layout, sendMail, mailConfigured } from './_mail.js';
import { realEmail, isShadowEmail, logPlatform, ownerEmails } from './_platform.js';

const clip = (s, n) => String(s || '').replace(/[\r\n]+/g, ' ').trim().slice(0, n);

async function allProfiles(sb) {
  const { data } = await sb.from('profiles').select('id, username, display_name, email, role, status, server_id, banned_at, ban_reason');
  return data || [];
}
async function linkedIds(sb, userId) {
  const { data: mine } = await sb.from('account_links').select('group_id').eq('user_id', userId).maybeSingle();
  if (!mine) return [userId];
  const { data: all } = await sb.from('account_links').select('user_id').eq('group_id', mine.group_id);
  return [...new Set([userId, ...(all || []).map(a => a.user_id)])];
}

export async function handleSupra({ req, res, sb, user, action }) {
  const body = req.body || {};
  const me = user.id;

  if (action === 'supra-check') return res.status(200).json({ ok: true });

  if (action === 'supra-overview') {
    const [{ data: servers }, profiles] = await Promise.all([sb.from('servers').select('id, name, created_at, join_code'), allProfiles(sb)]);
    const tasks = (await sb.from('tasks').select('id', { count: 'exact', head: true })).count || 0;
    const out = (servers || []).map(s => {
      const m = profiles.filter(p => p.server_id === s.id);
      return { id: s.id, name: s.name, created_at: s.created_at, members: m.filter(p => p.status === 'approved' && !p.banned_at).length, pending: m.filter(p => p.status === 'pending').length, banned: m.filter(p => p.banned_at).length, admins: m.filter(p => p.role === 'admin').map(p => p.display_name) };
    }).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return res.status(200).json({
      ok: true, servers: out,
      totals: { servers: out.length, accounts: profiles.length, pending: profiles.filter(p => p.status === 'pending').length, banned: profiles.filter(p => p.banned_at).length, tasks },
      mailConfigured: mailConfigured(),
    });
  }

  if (action === 'supra-users') {
    const q = clip(body.q, 80).toLowerCase();
    const [profiles, { data: servers }] = await Promise.all([allProfiles(sb), sb.from('servers').select('id, name')]);
    const sname = new Map((servers || []).map(s => [s.id, s.name]));
    let list = profiles;
    if (q) list = list.filter(p => [p.display_name, p.username, realEmail(p.email), sname.get(p.server_id)].some(v => String(v || '').toLowerCase().includes(q)));
    list = list.sort((a, b) => (b.banned_at ? 1 : 0) - (a.banned_at ? 1 : 0) || String(a.display_name).localeCompare(String(b.display_name), 'fr')).slice(0, 60);
    return res.status(200).json({ ok: true, total: profiles.length, users: list.map(p => ({ id: p.id, display_name: p.display_name, username: p.username, email: realEmail(p.email), role: p.role, status: p.status, server: sname.get(p.server_id) || '?', banned_at: p.banned_at || null, ban_reason: p.ban_reason || '' })) });
  }

  if (action === 'supra-ban') {
    const userId = String(body.userId || '');
    const ban = body.banned !== false;
    const reason = clip(body.reason, 300);
    if (!userId) return res.status(400).json({ error: 'Compte manquant.' });
    if (userId === me) return res.status(400).json({ error: 'Vous ne pouvez pas vous bannir vous-même.' });
    const { data: target } = await sb.from('profiles').select('id, display_name, email, server_id, banned_at').eq('id', userId).maybeSingle();
    if (!target) return res.status(404).json({ error: 'Compte introuvable.' });
    const ids = body.alsoLinked === true ? await linkedIds(sb, userId) : [userId];
    const { data: owners } = await sb.from('platform_admins').select('user_id');
    if (ids.some(i => (owners || []).some(o => o.user_id === i))) return res.status(400).json({ error: "Le propriétaire de la plateforme ne peut pas être banni." });
    let done = 0;
    for (const id of ids) {
      const patch = ban ? { banned_at: new Date().toISOString(), ban_reason: reason, banned_by: me } : { banned_at: null, ban_reason: '', banned_by: null };
      const { error } = await sb.from('profiles').update(patch).eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      // Coupe aussi la connexion : plus de nouvelle session ni de renouvellement (les accès aux données sont déjà fermés par la base)
      try { await sb.auth.admin.updateUserById(id, { ban_duration: ban ? '876000h' : 'none' }); } catch (_) { /* le profil est déjà bloqué */ }
      done++;
    }
    await logPlatform(sb, me, ban ? 'ban' : 'unban', userId, target.display_name, (ids.length > 1 ? `${ids.length} comptes liés. ` : '') + reason);
    let mailed = false;
    if (ban && body.notifyUser !== false && mailConfigured() && target.email) {
      try {
        await sendMail({ to: realEmail(target.email), subject: 'Votre accès à Le Carnet a été suspendu',
          text: `Bonjour ${target.display_name},\n\nVotre accès à Le Carnet a été suspendu.${reason ? '\nMotif : ' + reason : ''}\n\nSi vous pensez qu'il s'agit d'une erreur, vous pouvez répondre à cet email.`,
          html: layout(`<p>Bonjour ${esc(target.display_name)},</p><p>Votre accès à Le Carnet a été <strong>suspendu</strong>.</p>${reason ? `<p>Motif : ${esc(reason)}</p>` : ''}<p>Si vous pensez qu'il s'agit d'une erreur, vous pouvez répondre à cet email.</p>`) });
        mailed = true;
      } catch (_) { /* l'email est facultatif */ }
    }
    return res.status(200).json({ ok: true, count: done, mailed });
  }

  if (action === 'supra-mail-log') {
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const cnt = async (ok) => (await sb.from('mail_log').select('id', { count: 'exact', head: true }).eq('ok', ok).gte('at', since)).count || 0;
    const { data: rows, error } = await sb.from('mail_log').select('at, subject, ok, error').order('at', { ascending: false }).limit(40);
    if (error) return res.status(200).json({ ok: true, available: false, mailConfigured: mailConfigured(), rows: [] });
    return res.status(200).json({ ok: true, available: true, mailConfigured: mailConfigured(), sent7d: await cnt(true), failed7d: await cnt(false), rows: rows || [], owners: (await ownerEmails(sb)).map(e => e.replace(/^(.).*(@.*)$/, '$1•••$2')) });
  }

  if (action === 'supra-test-mail') {
    if (!mailConfigured()) return res.status(400).json({ error: "Les emails ne sont pas configurés : GMAIL_USER et GMAIL_APP_PASSWORD manquent sur Vercel." });
    const to = await ownerEmails(sb);
    if (!to.length) return res.status(400).json({ error: "Aucune adresse trouvée pour le propriétaire." });
    try { await Promise.all(to.map(t => sendMail({ to: t, subject: 'Test Supra Admin : les emails fonctionnent ✓', text: `Cet email confirme que le Supra Admin peut vous écrire.\n${siteUrl(req)}/supra/`, html: layout('<p>Cet email confirme que le <strong>Supra Admin</strong> peut vous écrire.</p>') }))); }
    catch (e) { return res.status(502).json({ error: "L'envoi a échoué : " + (e.message || 'erreur inconnue') }); }
    return res.status(200).json({ ok: true, to: to.length });
  }

  if (action === 'supra-broadcast') {
    if (!mailConfigured()) return res.status(400).json({ error: "Les emails ne sont pas configurés : GMAIL_USER et GMAIL_APP_PASSWORD manquent sur Vercel." });
    const subject = clip(body.subject, 120), message = String(body.message || '').replace(/\r\n/g, '\n').trim();
    if (!subject) return res.status(400).json({ error: "L'objet est obligatoire (120 caractères maximum)." });
    if (!message || message.length > 5000) return res.status(400).json({ error: 'Le message est obligatoire (5 000 caractères maximum).' });
    const hourAgo = new Date(Date.now() - 3600000).toISOString();
    const { count: recent } = await sb.from('platform_log').select('id', { count: 'exact', head: true }).eq('action', 'broadcast').gte('created_at', hourAgo);
    if ((recent || 0) >= 3) return res.status(429).json({ error: "Trop d'envois groupés en peu de temps : réessayez dans une heure." });
    const audience = body.audience === 'all' ? 'all' : 'admins';
    const profiles = (await allProfiles(sb)).filter(p => p.status === 'approved' && !p.banned_at && p.email && !(body.serverId && p.server_id !== body.serverId) && (audience === 'all' || p.role === 'admin'));
    const to = [...new Set(profiles.map(p => realEmail(p.email)))];
    if (!to.length) return res.status(400).json({ error: 'Aucun destinataire.' });
    if (to.length > 100) return res.status(400).json({ error: `Maximum 100 destinataires par envoi (${to.length} trouvés).` });
    const html = layout(esc(message).split(/\n{2,}/).map(par => `<p style="margin:0 0 14px;line-height:1.55">${par.replace(/\n/g, '<br>')}</p>`).join(''));
    let sent = 0, failed = 0;
    for (let i = 0; i < to.length; i += 5) {
      const results = await Promise.allSettled(to.slice(i, i + 5).map(t => sendMail({ to: t, subject, text: `${message}\n\n${siteUrl(req)}/app/`, html })));
      results.forEach(r => (r.status === 'fulfilled' ? sent++ : failed++));
    }
    if (sent) await logPlatform(sb, me, 'broadcast', null, subject, `${sent} destinataire(s), ${audience === 'all' ? 'tous les membres' : 'administrateurs'}${body.serverId ? ' d\'un serveur' : ''}`);
    if (!sent) return res.status(502).json({ error: "Aucun email n'a pu partir. Vérifiez la configuration Gmail." });
    return res.status(200).json({ ok: true, sent, failed, recipients: to.length });
  }

  if (action === 'supra-log') {
    const { data } = await sb.from('platform_log').select('id, action, target_label, detail, created_at').order('created_at', { ascending: false }).limit(60);
    return res.status(200).json({ ok: true, rows: data || [] });
  }

  return res.status(400).json({ error: 'Action inconnue' });
}
