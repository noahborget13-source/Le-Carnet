// Fonction serveur Vercel — gestion des comptes.
//  • Actions de l'admin : delete, update, transfer-admin (même serveur uniquement).
//  • Actions de chacun sur son propre compte : update-self, delete-self.
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { validateWorkHours } from './_availability.js';

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const ALL_PERMS = { createTasks: true, editAnyTask: true, editOwnTask: true, deleteAnyTask: true, deleteOwnTask: true, sendMessages: true };
const USERNAME_RE = /^[A-Za-z0-9._-]{3,30}$/;
const LEAD_CHOICES = [15, 30, 60, 120, 240, 720, 1440]; // délais de rappel proposés (minutes)
const COLORS = ['#5B9EF5', '#5FBF8B', '#FFB648', '#F56BA8', '#9B7EF5', '#FF6B5E'];
// Adresse technique d'un compte lié : « prenom+carnet-xxxxxxxxxxxx@domaine » (même boîte mail que la personne ; jamais utilisée pour écrire)
const isShadowEmail = (e) => /\+carnet-[0-9a-f]{12}@/i.test(String(e || ''));
const shadowEmailFor = (real) => { const [local, domain] = String(real).split('@'); return `${local}+carnet-${crypto.randomBytes(6).toString('hex')}@${domain}`; };

// ------------------------------------------------------------------
// Un même compte dans plusieurs serveurs.
// Chaque serveur garde son propre profil (donc ses propres données, droits et règles de sécurité) ;
// les profils d'une même personne sont reliés par « account_links » et on passe de l'un à l'autre
// par un jeton de connexion émis ici, après vérification de la session en cours.
// ------------------------------------------------------------------
async function groupOf(userId) {
  const { data: mine } = await supabaseAdmin.from('account_links').select('group_id').eq('user_id', userId).maybeSingle();
  if (!mine) return { groupId: null, members: [userId] };
  const { data: rows } = await supabaseAdmin.from('account_links').select('user_id').eq('group_id', mine.group_id);
  return { groupId: mine.group_id, members: (rows || []).map(r => r.user_id) };
}
async function ensureLinked(meId, otherId) {
  const g = await groupOf(meId);
  const groupId = g.groupId || meId;
  if (!g.groupId) { const { error } = await supabaseAdmin.from('account_links').insert({ user_id: meId, group_id: groupId }); if (error) throw new Error(error.message); }
  const { error } = await supabaseAdmin.from('account_links').insert({ user_id: otherId, group_id: groupId });
  if (error) throw new Error(error.message);
}
async function createShadowUser(realEmail) {
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: shadowEmailFor(realEmail), password: crypto.randomBytes(24).toString('hex'), email_confirm: true, user_metadata: { linked: true },
  });
  if (error) throw new Error(error.message);
  return data.user;
}
async function usernameTaken(username) {
  const { data } = await supabaseAdmin.from('profiles').select('id').ilike('username', username).limit(1);
  return Boolean(data && data.length);
}
/** Avant de supprimer un compte qui porte l'adresse email réelle : un autre compte lié en hérite (la personne refera un mot de passe). */
async function planHandoff(userId) {
  const g = await groupOf(userId);
  if (g.members.length < 2) return null;
  const { data: u } = await supabaseAdmin.auth.admin.getUserById(userId);
  const email = u?.user?.email;
  if (!email || isShadowEmail(email)) return null;
  return { email, heir: g.members.find(id => id !== userId) };
}
async function runHandoff(plan) {
  if (!plan) return;
  await supabaseAdmin.auth.admin.updateUserById(plan.heir, { email: plan.email, email_confirm: true, password: crypto.randomBytes(24).toString('hex') });
}

async function handleServers(req, res, body) {
  const bearer = (req.headers.authorization || '').replace('Bearer ', '');
  if (!bearer) return res.status(401).json({ error: 'Non authentifié' });
  const { data: ud, error: ue } = await supabaseAdmin.auth.getUser(bearer);
  if (ue || !ud?.user) return res.status(401).json({ error: 'Session invalide' });
  const meId = ud.user.id;
  const { data: myProfile } = await supabaseAdmin.from('profiles').select('id, email, status, display_name, server_id').eq('id', meId).maybeSingle();
  if (!myProfile) return res.status(403).json({ error: 'Accès refusé.' });
  const { action } = body;

  if (action === 'servers-list') {
    const g = await groupOf(meId);
    const { data: profs } = await supabaseAdmin.from('profiles').select('id, server_id, display_name, role, status').in('id', g.members);
    const { data: srvs } = await supabaseAdmin.from('servers').select('id, name').in('id', (profs || []).map(p => p.server_id));
    const name = new Map((srvs || []).map(s => [s.id, s.name]));
    const list = (profs || []).map(p => ({ userId: p.id, serverName: name.get(p.server_id) || 'Serveur', displayName: p.display_name, role: p.role, status: p.status, current: p.id === meId }))
      .sort((a, b) => (b.current - a.current) || a.serverName.localeCompare(b.serverName, 'fr'));
    return res.status(200).json({ ok: true, servers: list });
  }

  if (action === 'servers-switch') {
    const target = String(body.userId || '');
    const g = await groupOf(meId);
    if (!g.members.includes(target) || target === meId) return res.status(403).json({ error: "Ce serveur n'est pas relié à votre compte." });
    const { data: tu } = await supabaseAdmin.auth.admin.getUserById(target);
    if (!tu?.user?.email) return res.status(404).json({ error: 'Compte introuvable.' });
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({ type: 'magiclink', email: tu.user.email });
    const tokenHash = data?.properties?.hashed_token;
    if (error || !tokenHash) return res.status(500).json({ error: error?.message || 'Impossible de changer de serveur.' });
    return res.status(200).json({ ok: true, tokenHash });
  }

  if (action === 'set-password') {
    const pw = String(body.password || '');
    if (pw.length < 8) return res.status(400).json({ error: 'Le mot de passe doit faire au moins 8 caractères.' });
    // Le mot de passe se règle sur le compte qui porte l'adresse email réelle (celui de la page de connexion)
    const g = await groupOf(meId);
    let primary = meId;
    for (const id of g.members) { const { data: u } = await supabaseAdmin.auth.admin.getUserById(id); if (u?.user?.email && !isShadowEmail(u.user.email)) { primary = id; break; } }
    const { error } = await supabaseAdmin.auth.admin.updateUserById(primary, { password: pw });
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  // Les actions suivantes ajoutent un serveur : compte approuvé obligatoire
  if (myProfile.status !== 'approved') return res.status(403).json({ error: 'Votre compte doit d\'abord être approuvé.' });
  const g0 = await groupOf(meId);
  if (g0.members.length >= 10) return res.status(400).json({ error: 'Vous avez atteint le maximum de 10 serveurs.' });
  const username = String(body.username || '').trim();
  const displayName = String(body.displayName || '').trim();
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Identifiant : 3 à 30 caractères (lettres, chiffres, . _ -).' });
  if (!displayName || displayName.length > 60) return res.status(400).json({ error: 'Nom affiché : 1 à 60 caractères.' });
  if (await usernameTaken(username)) return res.status(400).json({ error: 'Cet identifiant est déjà pris, choisis-en un autre (il doit être différent dans chaque serveur).' });
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];

  if (action === 'servers-create') {
    const serverName = String(body.serverName || '').trim();
    if (!serverName || serverName.length > 60) return res.status(400).json({ error: 'Nom du serveur : 1 à 60 caractères.' });
    const shadow = await createShadowUser(myProfile.email);
    let serverId = null;
    try {
      const { data: server, error: se } = await supabaseAdmin.from('servers').insert({ name: serverName, owner_id: shadow.id }).select().single();
      if (se) throw new Error(se.message);
      serverId = server.id;
      const { error: pe } = await supabaseAdmin.from('profiles').insert({ id: shadow.id, server_id: serverId, username, email: myProfile.email, display_name: displayName, color, role: 'admin', permissions: ALL_PERMS, status: 'approved' });
      if (pe) throw new Error(pe.message);
      await ensureLinked(meId, shadow.id);
    } catch (e) {
      if (serverId) await supabaseAdmin.from('servers').delete().eq('id', serverId);
      await supabaseAdmin.auth.admin.deleteUser(shadow.id);
      return res.status(400).json({ error: e.message });
    }
    return res.status(200).json({ ok: true, userId: shadow.id, status: 'approved' });
  }

  if (action === 'servers-join') {
    // Soit un code de serveur, soit un lien / jeton d'invitation reçu par email
    let raw = String(body.code || '').trim();
    const m = /invite=([A-Za-z0-9]+)/.exec(raw); if (m) raw = m[1];
    if (!raw) return res.status(400).json({ error: "Collez un code de serveur ou un lien d'invitation." });
    let serverId = null, role = 'member', status = 'pending', perms = {}, inviteId = null;
    if (raw.length >= 20) {
      const { data: inv } = await supabaseAdmin.from('invites').select('*').eq('token', raw).maybeSingle();
      if (!inv || inv.used_at || new Date(inv.expires_at) < new Date()) return res.status(400).json({ error: "Invitation invalide, expirée ou déjà utilisée." });
      if (String(inv.email).toLowerCase() !== String(myProfile.email).toLowerCase()) return res.status(403).json({ error: "Cette invitation a été envoyée à une autre adresse email." });
      serverId = inv.server_id; role = inv.role; status = 'approved'; inviteId = inv.id;
      perms = ({ moderator: ALL_PERMS, member: { createTasks: true, editOwnTask: true, deleteOwnTask: true, sendMessages: true }, guest: { sendMessages: true } })[role] || {};
    } else {
      const { data: srv } = await supabaseAdmin.from('servers').select('id').eq('join_code', raw.toLowerCase()).maybeSingle();
      if (!srv) return res.status(400).json({ error: "Code de serveur introuvable." });
      serverId = srv.id;
    }
    const g = await groupOf(meId);
    const { data: already } = await supabaseAdmin.from('profiles').select('id').eq('server_id', serverId).in('id', g.members).limit(1);
    if (already && already.length) return res.status(400).json({ error: 'Vous faites déjà partie de ce serveur.' });
    const shadow = await createShadowUser(myProfile.email);
    const { error: pe } = await supabaseAdmin.from('profiles').insert({ id: shadow.id, server_id: serverId, username, email: myProfile.email, display_name: displayName, color, role, permissions: perms, status });
    if (pe) { await supabaseAdmin.auth.admin.deleteUser(shadow.id); return res.status(400).json({ error: pe.message }); }
    try { await ensureLinked(meId, shadow.id); }
    catch (e) { await supabaseAdmin.from('profiles').delete().eq('id', shadow.id); await supabaseAdmin.auth.admin.deleteUser(shadow.id); return res.status(400).json({ error: e.message }); }
    if (inviteId) await supabaseAdmin.from('invites').update({ used_at: new Date().toISOString() }).eq('id', inviteId);
    return res.status(200).json({ ok: true, userId: shadow.id, status });
  }
  return res.status(400).json({ error: 'Action inconnue' });
}

/** Création d'un compte par l'administrateur (ancien fichier create-account.js, regroupé ici : Vercel gratuit = 12 fonctions maximum). */
async function createAccountByAdmin(me, body, res) {
  const { username, email, password, displayName, color, role, permissions } = body;
  if (!username || !email || !password || !displayName) return res.status(400).json({ error: 'Champs manquants.' });
  const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createErr) {
    const msg = /already|registered|exists/i.test(createErr.message)
      ? "Cette adresse a déjà un compte Le Carnet. Utilisez plutôt « Inviter par email » : la personne rejoindra votre serveur avec son compte existant." : createErr.message;
    return res.status(400).json({ error: msg });
  }
  const { error: profileErr } = await supabaseAdmin.from('profiles').insert({
    id: created.user.id, server_id: me.server_id, username, email, display_name: displayName,
    color: color || '#5B9EF5', role: role || 'member', permissions: permissions || {}, status: 'approved',
  });
  if (profileErr) { await supabaseAdmin.auth.admin.deleteUser(created.user.id); return res.status(400).json({ error: profileErr.message }); }
  return res.status(200).json({ ok: true, id: created.user.id });
}

async function requireUser(req, res) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) { res.status(401).json({ error: 'Non authentifié' }); return null; }
  const { data: userData, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !userData?.user) { res.status(401).json({ error: 'Session invalide' }); return null; }
  const { data: profile } = await supabaseAdmin.from('profiles')
    .select('id, role, server_id, status, username').eq('id', userData.user.id).single();
  if (!profile || profile.status !== 'approved') { res.status(403).json({ error: 'Accès refusé.' }); return null; }
  return profile;
}

async function updateSelf(me, body, res) {
  const patch = body.patch || {};
  const update = {};
  if (patch.display_name !== undefined) {
    const v = String(patch.display_name).trim();
    if (!v || v.length > 60) return res.status(400).json({ error: 'Nom affiché : 1 à 60 caractères.' });
    update.display_name = v;
  }
  if (patch.color !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(patch.color)) return res.status(400).json({ error: 'Couleur invalide.' });
    update.color = patch.color;
  }
  if (patch.username !== undefined) {
    const v = String(patch.username).trim();
    if (!USERNAME_RE.test(v)) return res.status(400).json({ error: 'Identifiant : 3 à 30 caractères (lettres, chiffres, . _ -).' });
    if (v.toLowerCase() !== (me.username || '').toLowerCase()) {
      const { data: taken } = await supabaseAdmin.from('profiles').select('id').ilike('username', v).neq('id', me.id).limit(1);
      if (taken && taken.length) return res.status(400).json({ error: 'Cet identifiant est déjà pris, choisis-en un autre.' });
    }
    update.username = v;
  }
  // Préférences d'emails
  for (const key of ['notify_assigned', 'notify_soon', 'notify_overdue', 'notify_digest', 'notify_meetings', 'notify_conflicts', 'notify_weekly', 'notify_dm']) {
    if (patch[key] !== undefined) {
      if (typeof patch[key] !== 'boolean') return res.status(400).json({ error: 'Préférence invalide.' });
      update[key] = patch[key];
    }
  }
  if (patch.remind_lead_minutes !== undefined) {
    const v = Number(patch.remind_lead_minutes);
    if (!LEAD_CHOICES.includes(v)) return res.status(400).json({ error: 'Délai de rappel invalide.' });
    update.remind_lead_minutes = v;
  }
  // Horaires de disponibilité (null = aucune limite)
  if (patch.work_hours !== undefined) {
    const v = validateWorkHours(patch.work_hours);
    if (v.error) return res.status(400).json({ error: v.error });
    update.work_hours = v.value;
  }
  // Anniversaire facultatif : « MM-JJ » (ou vide pour l'effacer)
  if (patch.birthday !== undefined) {
    const v = patch.birthday === null ? '' : String(patch.birthday).trim();
    if (v === '') update.birthday = null;
    else {
      const m = /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.exec(v);
      const days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (!m || Number(m[2]) > days[Number(m[1]) - 1]) return res.status(400).json({ error: 'Date d\'anniversaire invalide.' });
      update.birthday = v;
    }
  }
  if (!Object.keys(update).length) return res.status(400).json({ error: 'Rien à modifier.' });
  const { error } = await supabaseAdmin.from('profiles').update(update).eq('id', me.id);
  if (error) {
    const msg = /duplicate|unique/i.test(error.message) ? 'Cet identifiant est déjà pris, choisis-en un autre.' : error.message;
    return res.status(400).json({ error: msg });
  }
  return res.status(200).json({ ok: true });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  const body = req.body || {};
  const { action, id, patch, newPassword } = body;

  try {
    if (['servers-list', 'servers-switch', 'servers-create', 'servers-join', 'set-password'].includes(action)) return await handleServers(req, res, body);
    const me = await requireUser(req, res);
    if (!me) return;

    // ---- Actions sur son propre compte ----
    if (action === 'update-self') return await updateSelf(me, body, res);
    if (action === 'delete-self') {
      if (me.role === 'admin') {
        return res.status(400).json({ error: "Vous êtes l'administrateur de ce serveur : transférez d'abord l'administration à quelqu'un d'autre." });
      }
      const plan = await planHandoff(me.id);
      await supabaseAdmin.from('profiles').delete().eq('id', me.id);
      await supabaseAdmin.auth.admin.deleteUser(me.id);
      await runHandoff(plan);
      return res.status(200).json({ ok: true, relink: Boolean(plan) });
    }

    // ---- Actions réservées à l'admin ----
    if (me.role !== 'admin') return res.status(403).json({ error: "Seul l'administrateur peut faire ça." });
    if (action === 'create') return await createAccountByAdmin(me, body, res);
    const { data: target } = await supabaseAdmin.from('profiles').select('role, server_id, status').eq('id', id).single();
    if (!target || target.server_id !== me.server_id) {
      return res.status(403).json({ error: 'Ce compte ne fait pas partie de votre serveur.' });
    }

    if (action === 'delete') {
      if (target.role === 'admin') return res.status(400).json({ error: "Impossible de supprimer l'administrateur." });
      const plan = await planHandoff(id);
      await supabaseAdmin.from('profiles').delete().eq('id', id);
      await supabaseAdmin.auth.admin.deleteUser(id);
      await runHandoff(plan);
      return res.status(200).json({ ok: true });
    }

    if (action === 'update') {
      if (newPassword) {
        // Un compte relié à d'autres serveurs n'est pas modifiable par un administrateur : sinon il pourrait entrer dans les autres serveurs de la personne.
        const gl = await groupOf(id);
        if (gl.members.length > 1) return res.status(400).json({ error: "Ce compte est utilisé dans plusieurs serveurs : la personne doit changer son mot de passe elle-même (« Mot de passe oublié »)." });
        const { error } = await supabaseAdmin.auth.admin.updateUserById(id, { password: newPassword });
        if (error) return res.status(400).json({ error: error.message });
      }
      if (patch) {
        const { error } = await supabaseAdmin.from('profiles').update(patch).eq('id', id);
        if (error) return res.status(400).json({ error: error.message });
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'transfer-admin') {
      if (id === me.id) return res.status(400).json({ error: 'Vous êtes déjà administrateur.' });
      if (target.status !== 'approved') return res.status(400).json({ error: "Cette personne n'a pas encore été approuvée." });
      const up = await supabaseAdmin.from('profiles').update({ role: 'admin', permissions: ALL_PERMS }).eq('id', id);
      if (up.error) return res.status(400).json({ error: up.error.message });
      const down = await supabaseAdmin.from('profiles').update({ role: 'moderator', permissions: ALL_PERMS }).eq('id', me.id);
      if (down.error) {
        await supabaseAdmin.from('profiles').update({ role: target.role }).eq('id', id); // on annule
        return res.status(400).json({ error: down.error.message });
      }
      await supabaseAdmin.from('servers').update({ owner_id: id }).eq('id', me.server_id);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Action inconnue' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
}
