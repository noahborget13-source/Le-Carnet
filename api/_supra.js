// Actions du Supra Admin (réservées au propriétaire de la plateforme, table platform_admins).
// Appelées par /api/admin-tools : Vercel gratuit = 12 fonctions maximum, donc pas de nouveau fichier de fonction.
import crypto from 'node:crypto';
import { esc, siteUrl, layout, button, sendMail, mailConfigured } from './_mail.js';
import { realEmail, isShadowEmail, logPlatform, ownerEmails } from './_platform.js';

const clip = (s, n) => String(s || '').replace(/[\r\n]+/g, ' ').trim().slice(0, n);

async function allProfiles(sb) {
  const { data } = await sb.from('profiles').select('id, username, display_name, email, role, status, server_id, banned_at, ban_reason');
  return data || [];
}
/** Dates de création et de dernière connexion (table auth, jamais lisible côté navigateur). */
async function authInfo(sb) {
  const map = new Map();
  try {
    for (let page = 1; page <= 10; page++) {
      const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
      if (error || !data || !data.users) break;
      for (const u of data.users) map.set(u.id, { created_at: u.created_at || null, last_sign_in_at: u.last_sign_in_at || null });
      if (data.users.length < 200) break;
    }
  } catch (_) { /* informations facultatives */ }
  return map;
}
const DAY = 86400000;
const FEATURE_TABLES = [['tasks', 'Tâches'], ['meetings', 'Réunions'], ['notes', 'Notes'], ['habits', 'Habitudes'], ['lists', 'Listes'], ['expenses', 'Dépenses'], ['ideas', 'Idées'], ['links', 'Liens'], ['objectives', 'Objectifs'], ['bookings', 'Réservations'], ['appointments', 'Rendez-vous'], ['time_entries', 'Suivi du temps'], ['projects', 'Projets']];
async function setBanned(sb, id, ban, reason, by) {
  const patch = ban ? { banned_at: new Date().toISOString(), ban_reason: reason, banned_by: by } : { banned_at: null, ban_reason: '', banned_by: null };
  const { error } = await sb.from('profiles').update(patch).eq('id', id);
  if (error) throw new Error(error.message);
  try { await sb.auth.admin.updateUserById(id, { ban_duration: ban ? '876000h' : 'none' }); } catch (_) { /* le profil est déjà bloqué */ }
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
    const feedbackNew = (await sb.from('feedback').select('id', { count: 'exact', head: true }).eq('status', 'new')).count || 0;
    const out = (servers || []).map(s => {
      const m = profiles.filter(p => p.server_id === s.id);
      return { id: s.id, name: s.name, created_at: s.created_at, members: m.filter(p => p.status === 'approved' && !p.banned_at).length, pending: m.filter(p => p.status === 'pending').length, banned: m.filter(p => p.banned_at).length, admins: m.filter(p => p.role === 'admin').map(p => p.display_name), suspended: m.length > 0 && m.every(p => p.banned_at) };
    }).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return res.status(200).json({
      ok: true, servers: out,
      totals: { servers: out.length, accounts: profiles.length, pending: profiles.filter(p => p.status === 'pending').length, banned: profiles.filter(p => p.banned_at).length, tasks, feedbackNew },
      mailConfigured: mailConfigured(),
    });
  }

  if (action === 'supra-users') {
    const q = clip(body.q, 80).toLowerCase();
    const filter = ['banned', 'pending', 'inactive', 'admins'].includes(body.filter) ? body.filter : 'all';
    const exportAll = body.all === true;
    const [profiles, { data: servers }, auth] = await Promise.all([allProfiles(sb), sb.from('servers').select('id, name'), authInfo(sb)]);
    const sname = new Map((servers || []).map(s => [s.id, s.name]));
    let list = profiles;
    if (q) list = list.filter(p => [p.display_name, p.username, realEmail(p.email), sname.get(p.server_id)].some(v => String(v || '').toLowerCase().includes(q)));
    const lastSeen = (p) => (auth.get(p.id) || {}).last_sign_in_at || null;
    if (filter === 'banned') list = list.filter(p => p.banned_at);
    else if (filter === 'pending') list = list.filter(p => p.status === 'pending');
    else if (filter === 'admins') list = list.filter(p => p.role === 'admin');
    else if (filter === 'inactive') list = list.filter(p => { const t = lastSeen(p); return !t || Date.now() - Date.parse(t) > 30 * DAY; });
    const matched = list.length;
    list = list.sort((a, b) => (b.banned_at ? 1 : 0) - (a.banned_at ? 1 : 0) || String(a.display_name).localeCompare(String(b.display_name), 'fr')).slice(0, exportAll ? 2000 : 60);
    return res.status(200).json({ ok: true, total: profiles.length, matched, users: list.map(p => ({ id: p.id, display_name: p.display_name, username: p.username, email: realEmail(p.email), role: p.role, status: p.status, server: sname.get(p.server_id) || '?', server_id: p.server_id, banned_at: p.banned_at || null, ban_reason: p.ban_reason || '', last_sign_in_at: lastSeen(p), created_at: (auth.get(p.id) || {}).created_at || null })) });
  }

  if (action === 'supra-reset-password') {
    if (!mailConfigured()) return res.status(400).json({ error: "Les emails ne sont pas configurés : GMAIL_USER et GMAIL_APP_PASSWORD manquent sur Vercel." });
    const userId = String(body.userId || '');
    const { data: target } = await sb.from('profiles').select('id, display_name, email, banned_at').eq('id', userId).maybeSingle();
    if (!target) return res.status(404).json({ error: 'Compte introuvable.' });
    if (target.banned_at) return res.status(400).json({ error: 'Ce compte est banni : débannissez-le d\'abord.' });
    const { data, error } = await sb.auth.admin.generateLink({ type: 'recovery', email: target.email, options: { redirectTo: `${siteUrl(req)}/app/` } });
    const link = data && data.properties && data.properties.action_link;
    if (error || !link) return res.status(500).json({ error: (error && error.message) || 'Impossible de créer le lien.' });
    try {
      await sendMail({ to: realEmail(target.email), subject: 'Nouveau mot de passe — Le Carnet',
        text: `Bonjour ${target.display_name}, voici le lien pour choisir un nouveau mot de passe (valable peu de temps) : ${link}\nSi vous n'avez rien demandé, ignorez ce message.`,
        html: layout(`<p>Bonjour ${esc(target.display_name)},</p><p>Un lien pour choisir un nouveau mot de passe vous a été envoyé. Il est valable peu de temps.</p>${button(link, 'Choisir un nouveau mot de passe')}<p style="font-size:13px;color:#556">Si vous n'avez rien demandé, ignorez ce message : votre mot de passe actuel reste valable.</p>`) });
    } catch (e) { return res.status(502).json({ error: "L'envoi a échoué : " + (e.message || 'erreur inconnue') }); }
    await logPlatform(sb, me, 'reset_link', userId, target.display_name, 'Lien de réinitialisation envoyé');
    return res.status(200).json({ ok: true, to: realEmail(target.email).replace(/^(.).*(@.*)$/, '$1•••$2') });
  }

  if (action === 'supra-server-ban') {
    const serverId = String(body.serverId || '');
    const ban = body.banned !== false;
    const reason = clip(body.reason, 300);
    const { data: server } = await sb.from('servers').select('id, name').eq('id', serverId).maybeSingle();
    if (!server) return res.status(404).json({ error: 'Serveur introuvable.' });
    const { data: owners } = await sb.from('platform_admins').select('user_id');
    const ownerIds = new Set((owners || []).map(o => o.user_id));
    const members = (await allProfiles(sb)).filter(p => p.server_id === serverId && !ownerIds.has(p.id) && (ban ? !p.banned_at : p.banned_at));
    let done = 0;
    for (const m of members) { try { await setBanned(sb, m.id, ban, reason, me); done++; } catch (e) { return res.status(500).json({ error: e.message, count: done }); } }
    await logPlatform(sb, me, ban ? 'server_ban' : 'server_unban', serverId, server.name, `${done} compte(s)${reason ? '. ' + reason : ''}`);
    return res.status(200).json({ ok: true, count: done });
  }

  if (action === 'supra-stats') {
    const auth = await authInfo(sb);
    const weeks = 12, now = Date.now();
    const monday = (t) => { const d = new Date(t); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.getTime(); };
    const start = monday(now) - (weeks - 1) * 7 * DAY;
    const bucket = (iso) => { const t = Date.parse(iso); return t >= start ? Math.floor((monday(t) - start) / (7 * DAY)) : -1; };
    const signups = new Array(weeks).fill(0), tasks = new Array(weeks).fill(0);
    let active7 = 0, active30 = 0;
    for (const u of auth.values()) {
      if (u.created_at) { const b = bucket(u.created_at); if (b >= 0 && b < weeks) signups[b]++; }
      if (u.last_sign_in_at) { const age = now - Date.parse(u.last_sign_in_at); if (age <= 7 * DAY) active7++; if (age <= 30 * DAY) active30++; }
    }
    const { data: trows } = await sb.from('tasks').select('created_at').gte('created_at', new Date(start).toISOString()).limit(20000);
    for (const t of trows || []) { const b = bucket(t.created_at); if (b >= 0 && b < weeks) tasks[b]++; }
    const labels = Array.from({ length: weeks }, (_, i) => new Date(start + i * 7 * DAY).toISOString().slice(0, 10));
    return res.status(200).json({ ok: true, labels, signups, tasks, active7, active30, known: auth.size });
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
      try { await setBanned(sb, id, ban, reason, me); } catch (e) { return res.status(500).json({ error: e.message }); }
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

  // ---- Santé et adoption des fonctionnalités ----
  if (action === 'supra-health') {
    const since7 = new Date(Date.now() - 7 * DAY).toISOString();
    const feats = [];
    for (const [table, label] of FEATURE_TABLES) {
      const tot = await sb.from(table).select('id', { count: 'exact', head: true });
      if (tot.error) { feats.push({ table, label, available: false }); continue; }
      const rec = await sb.from(table).select('id', { count: 'exact', head: true }).gte('created_at', since7);
      const sv = await sb.from(table).select('server_id').limit(5000);
      const servers = sv.error ? null : new Set((sv.data || []).map(r => r.server_id).filter(Boolean)).size;
      feats.push({ table, label, available: true, total: tot.count || 0, last7d: rec.error ? null : (rec.count || 0), servers });
    }
    const [{ data: srv }, profiles] = await Promise.all([sb.from('servers').select('id, created_at'), allProfiles(sb)]);
    const cnt = async (q) => { const r = await q; return r.error ? null : (r.count || 0); };
    const mailFailed = await cnt(sb.from('mail_log').select('id', { count: 'exact', head: true }).eq('ok', false).gte('at', since7));
    const mailSent = await cnt(sb.from('mail_log').select('id', { count: 'exact', head: true }).eq('ok', true).gte('at', since7));
    const feedbackNew = await cnt(sb.from('feedback').select('id', { count: 'exact', head: true }).eq('status', 'new'));
    const { data: lastRun } = await sb.from('cron_runs').select('ran_at, mode, sent').order('ran_at', { ascending: false }).limit(1);
    const cron24h = await cnt(sb.from('cron_runs').select('id', { count: 'exact', head: true }).gte('ran_at', new Date(Date.now() - DAY).toISOString()));
    const auth = await authInfo(sb);
    const active7 = profiles.filter(p => { const t = (auth.get(p.id) || {}).last_sign_in_at; return t && Date.now() - Date.parse(t) < 7 * DAY; }).length;
    const alerts = [];
    if (!mailConfigured()) alerts.push({ level: 'warn', text: "Les emails ne sont pas configurés sur Vercel (GMAIL_USER et GMAIL_APP_PASSWORD)." });
    if (mailFailed) alerts.push({ level: 'warn', text: `${mailFailed} email${mailFailed > 1 ? 's' : ''} en échec ces 7 derniers jours.` });
    if (!process.env.CRON_SECRET) alerts.push({ level: 'warn', text: "CRON_SECRET n'est pas défini : les rappels automatiques sont désactivés." });
    else if (!lastRun || !lastRun[0] || Date.now() - Date.parse(lastRun[0].ran_at) > 3 * 3600000) alerts.push({ level: 'warn', text: "Les rappels automatiques n'ont pas tourné depuis plus de 3 heures." });
    if (feedbackNew) alerts.push({ level: 'info', text: `${feedbackNew} retour${feedbackNew > 1 ? 's' : ''} d'utilisateur à lire.` });
    const pending = profiles.filter(p => p.status === 'pending').length;
    if (pending) alerts.push({ level: 'info', text: `${pending} demande${pending > 1 ? 's' : ''} d'adhésion en attente.` });
    return res.status(200).json({ ok: true, features: feats, servers: (srv || []).length, newServers7d: (srv || []).filter(x => x.created_at >= since7).length,
      accounts: profiles.length, newAccounts7d: [...auth.values()].filter(a => a.created_at && a.created_at >= since7).length, active7,
      mail: { configured: mailConfigured(), sent7d: mailSent, failed7d: mailFailed }, cron: { secretSet: Boolean(process.env.CRON_SECRET), lastRun: lastRun && lastRun[0] ? lastRun[0] : null, runs24h: cron24h },
      alerts });
  }

  // ---- Fiche détaillée d'un serveur ----
  if (action === 'supra-server-detail') {
    const serverId = String(body.serverId || '');
    const { data: server } = await sb.from('servers').select('id, name, created_at, join_code').eq('id', serverId).maybeSingle();
    if (!server) return res.status(404).json({ error: 'Serveur introuvable.' });
    const [profiles, auth] = await Promise.all([allProfiles(sb), authInfo(sb)]);
    const members = profiles.filter(p => p.server_id === serverId).map(p => ({ id: p.id, display_name: p.display_name, username: p.username, role: p.role, status: p.status, banned: Boolean(p.banned_at), last_seen: (auth.get(p.id) || {}).last_sign_in_at || null }))
      .sort((a, b) => (a.role === 'admin' ? 0 : 1) - (b.role === 'admin' ? 0 : 1) || String(a.display_name).localeCompare(String(b.display_name), 'fr'));
    const counts = [];
    for (const [table, label] of FEATURE_TABLES) {
      const r = await sb.from(table).select('id', { count: 'exact', head: true }).eq('server_id', serverId);
      if (!r.error) counts.push({ table, label, total: r.count || 0 });
    }
    return res.status(200).json({ ok: true, server: { id: server.id, name: server.name, created_at: server.created_at, join_code: server.join_code }, members, counts });
  }

  // ---- Renommer un serveur ou régénérer son code d'invitation ----
  if (action === 'supra-server-edit') {
    const serverId = String(body.serverId || '');
    const { data: server } = await sb.from('servers').select('id, name').eq('id', serverId).maybeSingle();
    if (!server) return res.status(404).json({ error: 'Serveur introuvable.' });
    const patch = {}; const notes = [];
    if (body.name !== undefined) {
      const name = clip(String(body.name || '').replace(/\s+/g, ' '), 60);
      if (name.length < 2) return res.status(400).json({ error: 'Le nom doit compter au moins 2 caractères (60 au maximum).' });
      if (name !== server.name) { patch.name = name; notes.push(`« ${server.name} » → « ${name} »`); }
    }
    if (body.regenerateCode) { patch.join_code = crypto.randomBytes(4).toString('hex'); notes.push("nouveau code d'invitation"); }
    if (!Object.keys(patch).length) return res.status(400).json({ error: "Rien à modifier." });
    const { error } = await sb.from('servers').update(patch).eq('id', serverId);
    if (error) return res.status(400).json({ error: error.message });
    await logPlatform(sb, me, patch.name ? 'server_rename' : 'server_code', serverId, patch.name || server.name, notes.join(', '));
    return res.status(200).json({ ok: true, name: patch.name || server.name, join_code: patch.join_code || null });
  }

  // ---- Exports de données de la plateforme (CSV construit côté navigateur) ----
  if (action === 'supra-export') {
    const kind = String(body.kind || '');
    if (kind === 'servers') {
      const [{ data: servers }, profiles] = await Promise.all([sb.from('servers').select('id, name, created_at'), allProfiles(sb)]);
      return res.status(200).json({ ok: true, columns: ['Serveur', 'Créé le', 'Membres', 'En attente', 'Bannis'], rows: (servers || []).map(sv => { const m = profiles.filter(p => p.server_id === sv.id); return [sv.name, sv.created_at, m.filter(p => p.status === 'approved' && !p.banned_at).length, m.filter(p => p.status === 'pending').length, m.filter(p => p.banned_at).length]; }) });
    }
    if (kind === 'feedback') {
      const { data, error } = await sb.from('feedback').select('created_at, kind, status, name, page, message').order('created_at', { ascending: false }).limit(5000);
      if (error) return res.status(400).json({ error: "Retours indisponibles (migration 30 à lancer)." });
      return res.status(200).json({ ok: true, columns: ['Date', 'Type', 'Statut', 'Nom', 'Page', 'Message'], rows: (data || []).map(r => [r.created_at, r.kind, r.status, r.name, r.page, r.message]) });
    }
    if (kind === 'log') {
      const { data, error } = await sb.from('platform_log').select('created_at, action, target_label, detail').order('created_at', { ascending: false }).limit(5000);
      if (error) return res.status(400).json({ error: 'Journal indisponible.' });
      return res.status(200).json({ ok: true, columns: ['Date', 'Action', 'Cible', 'Détail'], rows: (data || []).map(r => [r.created_at, r.action, r.target_label, r.detail]) });
    }
    if (kind === 'mail') {
      const { data, error } = await sb.from('mail_log').select('at, subject, ok, error').order('at', { ascending: false }).limit(5000);
      if (error) return res.status(400).json({ error: "Journal des emails indisponible." });
      return res.status(200).json({ ok: true, columns: ['Date', 'Objet', 'Envoyé', 'Erreur'], rows: (data || []).map(r => [r.at, r.subject, r.ok ? 'oui' : 'non', r.error || '']) });
    }
    return res.status(400).json({ error: 'Export inconnu.' });
  }

  if (action === 'supra-feedback') {
    const filter = ['new', 'read', 'done'].includes(body.status) ? body.status : null;
    let q = sb.from('feedback').select('id, user_id, server_id, kind, message, page, status, created_at').order('created_at', { ascending: false }).limit(200);
    if (filter) q = q.eq('status', filter);
    const { data, error } = await q;
    if (error) return res.status(200).json({ ok: true, available: false, rows: [], counts: {} });
    const [profiles, { data: servers }] = await Promise.all([allProfiles(sb), sb.from('servers').select('id, name')]);
    const pname = new Map(profiles.map(p => [p.id, p])), sname = new Map((servers || []).map(s => [s.id, s.name]));
    const { data: all } = await sb.from('feedback').select('status');
    const counts = { new: 0, read: 0, done: 0 }; for (const f of all || []) counts[f.status] = (counts[f.status] || 0) + 1;
    return res.status(200).json({ ok: true, available: true, counts, rows: (data || []).map(f => { const p = pname.get(f.user_id); return { id: f.id, kind: f.kind, message: f.message, page: f.page, status: f.status, created_at: f.created_at, name: p ? p.display_name : 'Ancien membre', email: p ? realEmail(p.email) : '', server: sname.get(f.server_id) || '' }; }) });
  }

  if (action === 'supra-feedback-set') {
    const status = String(body.status || '');
    if (!['new', 'read', 'done'].includes(status)) return res.status(400).json({ error: 'Statut invalide.' });
    const ids = Array.isArray(body.ids) ? body.ids.slice(0, 200).map(String) : [String(body.id || '')];
    const { error } = await sb.from('feedback').update({ status }).in('id', ids);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, count: ids.length });
  }

  if (action === 'supra-log') {
    const { data } = await sb.from('platform_log').select('id, action, target_label, detail, created_at').order('created_at', { ascending: false }).limit(60);
    return res.status(200).json({ ok: true, rows: data || [] });
  }

  return res.status(400).json({ error: 'Action inconnue' });
}
